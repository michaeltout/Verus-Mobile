import {Buffer} from 'buffer';
import {ECPair, Transaction, networks} from '@bitgo/utxo-lib';
import {verifyIdentityUpdateFunding} from 'verusid-ts-client';
import {
  Identity,
  IdentityScript,
  SmartTransactionScript,
  BigNumber as BN,
  fromBase58Check,
  toBase58Check,
  I_ADDR_VERSION,
  R_ADDR_VERSION,
  GetInfoRequest,
  GetIdentityRequest,
  GetTxOutRequest,
} from 'verus-typescript-primitives';
import store from '../../store';
import {
  captureSessionScope,
  sessionScopeIsCurrent,
} from '../../actions/actions/updates/sessionRequests';
import VrpcProvider from '../vrpc/vrpcInterface';
import {signUpdateIdentityTx} from '../api/channels/verusid/requests/updateIdentity';

const fail = (code, message) => Object.assign(new Error(message), {code});

// Guards last only as long as an open review. No request or signed bytes are saved.
const inFlight = new Set();
const submissionAttempts = new WeakMap();

const ROOT_CHAIN_IDS = new Set([
  'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
  'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
]);

const walletBinding = state =>
  JSON.stringify(
    Object.entries(state.authentication.activeAccount?.keys || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([coin, channels]) => [coin, channels.vrpc?.addresses || []]),
  );

const result = response => {
  if (response?.error)
    throw new Error(response.error.message || 'The network request failed.');

  if (!response || !Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new Error('The network returned an invalid response.');
  }

  return response.result;
};

/** Bind a review to its account, network, and open dialog before asynchronous work. */
export const captureIdentityUpdateContext = ({request, ...options} = {}) => {
  const state = store.getState();
  const requestSystemId = request
    ? request.systemID?.toAddress?.() ||
      (options.isTestnet
        ? 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'
        : 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV')
    : options.systemId;
  const expiryHeight =
    request?.expiryHeight == null ? 0 : Number(request.expiryHeight.toString());

  if (
    !Number.isSafeInteger(expiryHeight) ||
    expiryHeight < 0 ||
    (request?.expiryHeight != null && expiryHeight === 0)
  ) {
    throw new Error(
      'The identity update request has an invalid or expired expiry height.',
    );
  }

  const context = {
    ...options,
    sessionScope: options.sessionScope || captureSessionScope(state),
    walletBinding: walletBinding(state),
    requestSystemId,
    requestExpiryHeight: expiryHeight,
    identitySnapshots: (options.identitySnapshots || []).map(snapshot => ({
      ...snapshot,
    })),
  };

  assertIdentityUpdateContext(context);
  return Object.freeze(context);
};

export const assertIdentityUpdateContext = context => {
  // Imported-key revoke/recover can start signed out, but still belong to a session.
  if (
    (!context?.sessionScope?.accountHash && context?.allowSignedOut !== true) ||
    context?.signal?.aborted ||
    !sessionScopeIsCurrent(store.getState(), context?.sessionScope)
  ) {
    throw fail(
      'SESSION_CHANGED',
      'Account changed. Review this identity update again in the intended account.',
    );
  }

  if (
    context.walletBinding != null &&
    context.walletBinding !== walletBinding(store.getState())
  ) {
    throw fail(
      'SESSION_CHANGED',
      'The wallet addresses changed. Review this identity update again.',
    );
  }

  if (
    context.modalRequestId != null &&
    store.getState().sendModal?.requestId !== context.modalRequestId
  ) {
    throw fail(
      'SESSION_CHANGED',
      'The identity update dialog changed. Review this update again.',
    );
  }

  if (context.requestSystemId && context.requestSystemId !== context.systemId) {
    throw new Error(
      'The identity update request belongs to a different network.',
    );
  }

  if (context.systemId && context.isTestnet != null) {
    const coin = store
      .getState()
      .coins?.activeCoinsForUser?.find(
        item => item.currency_id === context.systemId,
      );

    if (!coin || !!coin.testnet !== !!context.isTestnet) {
      throw new Error('The identity update network changed. Review it again.');
    }
  }
};

const guarded = async (context, task) => {
  assertIdentityUpdateContext(context);
  const value = await task();

  assertIdentityUpdateContext(context);
  return value;
};

export const requireIdentityFundingApproval = (built, lockContext) => {
  if (!built?.fundingApproval) {
    throw new Error(
      'Missing verified identity funding approval. Review the transaction again.',
    );
  }

  verifyIdentityUpdateFunding(
    built.fundingApproval,
    built.hex,
    built.utxos,
    lockContext,
  );
  return built.fundingApproval;
};

export const assertIdentityUpdateInputMaturity = (approval, input, unspent) => {
  const source = approval.prevouts.find(
    previous =>
      previous.txid === input.txid &&
      previous.outputIndex === input.outputIndex,
  );

  if (!source)
    throw new Error(
      'The approved input is missing its verified source transaction.',
    );

  const coinbase = Transaction.fromHex(
    source.rawTransaction,
    networks.verus,
  ).isCoinbase();

  // PBaaS maturity varies with block time, up to 149 blocks. Derive coinbase
  // status from verified bytes so a server cannot omit the gettxout flag.
  const maturity = ROOT_CHAIN_IDS.has(approval.systemId) ? 100 : 149;

  if (
    (coinbase || unspent.coinbase) &&
    (!Number.isSafeInteger(unspent.confirmations) ||
      unspent.confirmations < maturity)
  ) {
    throw fail(
      'REVIEW_CHANGED',
      'A mining reward used for this update is not yet spendable.',
    );
  }
};

const identityFromOutput = output => {
  const parsed = new IdentityScript();
  parsed.fromBuffer(Buffer.from(output.script));
  return parsed.getIdentity();
};

const fundingSigningAddress = (source, input) => {
  const bytes = Buffer.from(
    Transaction.fromHex(source.rawTransaction, networks.verus).outs[
      input.outputIndex
    ].script,
  );

  // Transparent outputs encode their controller directly in the script.
  if (
    bytes.length === 25 &&
    bytes[0] === 0x76 &&
    bytes[1] === 0xa9 &&
    bytes[2] === 20 &&
    bytes[23] === 0x88 &&
    bytes[24] === 0xac
  ) {
    return toBase58Check(bytes.subarray(3, 23), R_ADDR_VERSION);
  }

  if (
    ((bytes.length === 35 && bytes[0] === 33) ||
      (bytes.length === 67 && bytes[0] === 65)) &&
    bytes[bytes.length - 1] === 0xac
  ) {
    return ECPair.fromPublicKeyBuffer(
      bytes.subarray(1, -1),
      networks.verus,
    ).getAddress();
  }

  const smart = new SmartTransactionScript();
  smart.fromBuffer(bytes);
  const condition = smart.paramsOptCC;

  if (
    !condition.m.eqn(1) ||
    !condition.n.eqn(1) ||
    condition.destinations.length !== 1
  ) {
    throw new Error(
      'This funding output requires multiple controllers. Select a supported single-controller funding source.',
    );
  }

  return condition.destinations[0].toAddress();
};

// Normalize the existing single-ID approval without changing persisted receipts.
const approvedIdentities = approval => {
  const identities =
    approval.identities || (approval.identity ? [approval.identity] : []);
  if (!identities.length)
    throw new Error('The funding approval contains no identity definitions.');
  return identities;
};

/** Determine which old controllers must authorize one proposed identity state. */
const requiredIdentityAuthorities = (current, updated) => {
  if (
    (current.isRevoked() && current.hasTokenizedIdControl()) ||
    current.hasActiveCurrency() !== updated.hasActiveCurrency() ||
    current.hasTokenizedIdControl() !== updated.hasTokenizedIdControl()
  ) {
    throw new Error(
      'This identity operation requires currency or control-token authorization that this wallet cannot complete.',
    );
  }

  // Changing an authority requires the previous controller's approval too.
  const authorityAddresses = new Set();

  if (current.isRevoked()) {
    authorityAddresses.add(current.recoveryAuthority.toAddress());
  } else {
    authorityAddresses.add(
      updated.isRevoked()
        ? current.revocationAuthority.toAddress()
        : current.getIdentityAddress(),
    );

    if (
      current.revocationAuthority.toAddress() !==
      updated.revocationAuthority.toAddress()
    ) {
      authorityAddresses.add(current.revocationAuthority.toAddress());
    }

    if (
      current.recoveryAuthority.toAddress() !==
      updated.recoveryAuthority.toAddress()
    ) {
      authorityAddresses.add(current.recoveryAuthority.toAddress());
    }

    if (updated.isRevoked()) {
      // Revocation alone is distinct from editing the identity at the same time.
      const primaryFields = identity => {
        const normalized = new Identity();
        normalized.fromBuffer(identity.toBuffer());
        // Prior multimap operations are transaction-local; new ones are checked below.
        normalized.clearContentMultiMap();
        normalized.flags = new BN(0);
        normalized.unlockAfter = new BN(0);
        normalized.setRecovery(current.recoveryAuthority.toAddress());
        normalized.setRevocation(current.revocationAuthority.toAddress());
        return normalized.toBuffer().toString('hex');
      };

      if (
        primaryFields(current) !== primaryFields(updated) ||
        updated.contentMultiMap.kvContent.size > 0 ||
        (updated.isLocked() && current.isLocked() !== updated.isLocked()) ||
        (!updated.unlockAfter.isZero() &&
          !current.unlockAfter.eq(updated.unlockAfter)) ||
        current.hasActiveCurrency() !== updated.hasActiveCurrency() ||
        current.hasTokenizedIdControl() !== updated.hasTokenizedIdControl()
      ) {
        authorityAddresses.add(current.getIdentityAddress());
      }
    }
  }

  return authorityAddresses;
};

/** Check current on-chain controllers; new ownership applies only after the update. */
const checkIdentityUpdateAuthorities = async (
  context,
  built,
  keys,
  lockContext,
  checkKeys,
  observations = {},
) => {
  const approval = requireIdentityFundingApproval(
    built,
    lockContext || (await getIdentityUpdateLockContext(context)),
  );

  if (
    checkKeys &&
    (!Array.isArray(keys) || keys.length !== built.utxos.length)
  ) {
    throw new Error('Every approved input requires its signing keys.');
  }

  const endpoint = VrpcProvider.getEndpoint(context.systemId);
  const transaction = Transaction.fromHex(built.hex, networks.verus);
  const outputs = transaction.outs.map(output => {
    try {
      return identityFromOutput(output);
    } catch (_) {
      return null;
    }
  });
  const definitions = new Map();
  const identities = new Map();

  for (const approved of approvedIdentities(approval)) {
    const definition = approval.prevouts.find(
      input =>
        input.txid === approved.txid &&
        input.outputIndex === approved.outputIndex,
    );
    if (!definition) throw new Error('An approved identity source is missing.');

    const source = Transaction.fromHex(
      definition.rawTransaction,
      networks.verus,
    );
    const current = identityFromOutput(source.outs[definition.outputIndex]);
    const updated = outputs.find(
      identity =>
        identity?.getIdentityAddress() === current.getIdentityAddress(),
    );
    if (!updated) throw new Error('The reviewed identity output is missing.');

    definitions.set(`${approved.txid}:${approved.outputIndex}`, {
      current,
      authorities: requiredIdentityAuthorities(current, updated),
    });
    // Cross-identity authority references must resolve to the spent definitions,
    // never to the new keys being assigned elsewhere in this transaction.
    identities.set(current.getIdentityAddress(), current);
  }

  const identitySnapshots = [];
  const authorityTransactions = observations.authorityTransactions || new Map();
  const requireUnlocked = new Set();

  const readAuthority = async address => {
    if (identities.has(address)) return identities.get(address);

    const lookup =
      observations.currentIdentities?.get(address) ||
      result(await guarded(context, () => endpoint.getIdentity(address)));
    // Transaction bytes are immutable. Reuse them only after looking up the
    // authority's current outpoint; mutable identity state is never cached here.
    const raw =
      authorityTransactions.get(lookup.txid) ||
      result(
        await guarded(context, () =>
          endpoint.getRawTransaction(lookup.txid, 0),
        ),
      );
    const tx = Transaction.fromHex(
      typeof raw === 'string' ? raw : raw?.hex,
      networks.verus,
    );

    if (tx.getId() !== lookup.txid || !tx.outs[lookup.vout]) {
      throw new Error(
        'The signing authority transaction could not be verified.',
      );
    }

    const identity = identityFromOutput(tx.outs[lookup.vout]);

    if (identity.getIdentityAddress() !== address) {
      throw new Error(
        'The signing authority does not match the requested identity.',
      );
    }

    authorityTransactions.set(lookup.txid, tx.toHex());
    identities.set(address, identity);
    identitySnapshots.push({
      identityAddress: address,
      txid: lookup.txid,
      vout: lookup.vout,
    });
    return identity;
  };

  const signingKeys = [];
  for (let index = 0; index < built.utxos.length; index++) {
    const input = built.utxos[index];
    const candidates = checkKeys
      ? (keys[index] || []).map(wif => ({
          wif,
          address: ECPair.fromWIF(wif, networks.verus).getAddress(),
        }))
      : [];
    const supplied = checkKeys
      ? new Set(candidates.map(key => key.address))
      : null;
    const controllers = new Set();
    const definition = definitions.get(`${input.txid}:${input.outputIndex}`);
    const source = approval.prevouts.find(
      previous =>
        previous.txid === input.txid &&
        previous.outputIndex === input.outputIndex,
    );

    // Derive the actual condition from the independently retained source bytes;
    // neither index labels nor membership in a multi-controller output suffices.
    const addresses = definition
      ? definition.authorities
      : [fundingSigningAddress(source, input)];

    for (const address of addresses) {
      if (!address)
        throw new Error(
          'The verified signing address for an approved input is missing.',
        );

      if (fromBase58Check(address).version === I_ADDR_VERSION) {
        const identity = await readAuthority(address);
        const primaries = new Set(
          identity.primaryAddresses.map(primary => primary.toAddress()),
        );
        primaries.forEach(primary => controllers.add(primary));
        const minimum = identity.minSigs.toNumber();
        const count = supplied
          ? [...primaries].filter(primary => supplied.has(primary)).length
          : minimum;

        if (!definition || address !== definition.current.getIdentityAddress())
          requireUnlocked.add(address);

        if (
          identity.isRevoked() ||
          minimum < 1 ||
          minimum > 13 ||
          minimum > primaries.size ||
          primaries.size !== identity.primaryAddresses.length ||
          count < minimum
        ) {
          throw new Error(
            'The available wallet keys cannot satisfy this identity’s required signatures. Use a wallet with all required signing keys.',
          );
        }
      } else {
        controllers.add(address);
        if (supplied && !supplied.has(address)) {
          throw new Error(
            'A signing key does not control its approved funding input.',
          );
        }
      }
    }
    // Gift setup can unlock both donor and future wallet keys. The transaction
    // signer must receive only keys for this input's existing controllers;
    // trying the new wallet key on a donor P2PKH input is a signing error.
    signingKeys.push(
      candidates
        .filter(key => controllers.has(key.address))
        .map(key => key.wif),
    );
  }

  // The daemon exempts the source identity only while spending its own
  // definition. Other authorities, and that same ID used as a funding source,
  // must be unlocked at the candidate height (serverchecker.cpp ExtractIDMap).
  const currentLockContext = await getIdentityUpdateLockContext(context);

  for (const address of requireUnlocked) {
    const identity = identities.get(address);

    if (
      identity.version.gten(2) &&
      (identity.isLocked() ||
        identity.unlockAfter.gten(currentLockContext.nextBlockHeight))
    ) {
      // Fail closed for historical chain-specific unlock overrides; Mobile
      // cannot independently establish the old activation state here.
      throw fail(
        'LOCKED_AUTHORITY',
        'An identity used to authorize or fund this update is locked. Unlock it before sending this update.',
      );
    }
  }

  requireIdentityFundingApproval(built, currentLockContext);
  assertIdentityUpdateContext(context);
  return {
    identitySnapshots,
    signingKeys,
    authorityTransactions,
    lockContext: currentLockContext,
  };
};

export const assertIdentityUpdateSigningAuthority = async (
  context,
  built,
  keys,
  lockContext,
) =>
  (
    await checkIdentityUpdateAuthorities(
      context,
      built,
      keys,
      lockContext,
      true,
    )
  ).identitySnapshots;

export const assertIdentityUpdateAuthorityLocks = async (
  context,
  built,
  lockContext,
) =>
  (
    await checkIdentityUpdateAuthorities(
      context,
      built,
      undefined,
      lockContext,
      false,
    )
  ).lockContext;

const lockContextFromInfo = (context, info) => {
  if (
    info?.chainid !== context.systemId ||
    !Number.isSafeInteger(info.blocks) ||
    info.blocks < 0 ||
    info.blocks >= 0xffffffff
  ) {
    throw new Error('Unable to verify the identity update network and height.');
  }

  return {chainId: context.systemId, nextBlockHeight: info.blocks + 1};
};

/** Read the active tip afresh, including when a wallet refresh has cached getinfo. */
export const getIdentityUpdateLockContext = async context => {
  const responses = await guarded(context, () =>
    VrpcProvider.getEndpoint(context.systemId).requestMany(
      [new GetInfoRequest(context.systemId)],
      {cacheMethods: []},
    ),
  );
  return lockContextFromInfo(context, result(responses[0]));
};

/** One fresh read group supplies transaction, authority, and optional key checks. */
const inspectIdentityUpdateContext = async (context, built, options = {}) => {
  const endpoint = VrpcProvider.getEndpoint(context.systemId);
  const approval = built?.fundingApproval;
  if (built && !approval)
    throw new Error(
      'Missing verified identity funding approval. Review the transaction again.',
    );
  const snapshots = built
    ? [
        ...approvedIdentities(approval).map(identity => ({
          identityAddress: identity.identityAddress,
          txid: identity.txid,
          vout: identity.outputIndex,
        })),
        ...(context.identitySnapshots || []),
      ]
    : [];
  const addresses = [
    ...new Set(snapshots.map(snapshot => snapshot.identityAddress)),
  ];
  const inputs = built?.utxos || [];

  // These reads are independent. Explicit fresh batches bypass both TTL caches
  // and reads started by an earlier phase of this operation.
  const responses = await guarded(context, () =>
    endpoint.requestMany(
      [
        new GetInfoRequest(context.systemId),
        ...addresses.map(
          address => new GetIdentityRequest(context.systemId, address),
        ),
        ...inputs.map(
          input =>
            new GetTxOutRequest(
              context.systemId,
              input.txid,
              input.outputIndex,
              true,
            ),
        ),
      ],
      {cacheMethods: []},
    ),
  );
  const lockContext = lockContextFromInfo(context, result(responses[0]));
  const requestExpired = height =>
    context.requestExpiryHeight > 0 && height >= context.requestExpiryHeight;

  if (requestExpired(lockContext.nextBlockHeight)) {
    throw fail('REVIEW_CHANGED', 'This identity update request has expired.');
  }
  if (!built) return {lockContext};

  requireIdentityFundingApproval(built, lockContext);

  if (
    approval.systemId !== context.systemId ||
    (context.changeAddress &&
      approval.changeAddress !== context.changeAddress) ||
    (context.identityAddress &&
      !approvedIdentities(approval).some(
        identity => identity.identityAddress === context.identityAddress,
      ))
  ) {
    throw new Error(
      'The funding approval does not match the reviewed identity, network, or change address.',
    );
  }

  const transaction = Transaction.fromHex(built.hex, networks.verus);

  if (
    !transaction.expiryHeight ||
    lockContext.nextBlockHeight >= transaction.expiryHeight
  ) {
    throw fail(
      'REVIEW_CHANGED',
      'This transaction review has expired. Review the identity update again.',
    );
  }

  const currentIdentities = new Map(
    addresses.map((address, index) => [address, result(responses[index + 1])]),
  );
  for (const snapshot of snapshots) {
    const current = currentIdentities.get(snapshot.identityAddress);
    if (current?.txid !== snapshot.txid || current?.vout !== snapshot.vout) {
      throw fail(
        'REVIEW_CHANGED',
        'An identity or signing authority changed after review. Review the update again.',
      );
    }
  }

  inputs.forEach((input, index) => {
    const unspent = result(responses[1 + addresses.length + index]);
    if (!unspent)
      throw fail(
        'REVIEW_CHANGED',
        'An approved transaction input is no longer available.',
      );
    assertIdentityUpdateInputMaturity(approval, input, unspent);
  });

  // Reuse these fresh identity observations for authority resolution. The final
  // tip read also catches a reorganization while external authority bytes load.
  const authorities = await checkIdentityUpdateAuthorities(
    context,
    built,
    options.keys,
    lockContext,
    options.keys != null,
    {currentIdentities, authorityTransactions: options.authorityTransactions},
  );
  const finalContext = authorities.lockContext;

  if (
    requestExpired(finalContext.nextBlockHeight) ||
    finalContext.nextBlockHeight >= transaction.expiryHeight
  ) {
    throw fail(
      'REVIEW_CHANGED',
      'This transaction review has expired. Review the identity update again.',
    );
  }

  requireIdentityFundingApproval(built, finalContext);
  return authorities;
};

/** Check live state separately from the SDK's offline conservation checks. */
export const validateIdentityUpdateContext = async (context, built) =>
  (await inspectIdentityUpdateContext(context, built)).lockContext
    .nextBlockHeight - 1;

const unknownBroadcast = txid =>
  Object.assign(
    fail(
      'BROADCAST_UNKNOWN',
      `Delivery of identity update ${txid} is not confirmed. Check its status before reviewing another update.`,
    ),
    {txid, submitted: true},
  );

/** Sign and send one reviewed update. Closing the review discards its state. */
export const submitReviewedIdentityUpdate = async ({
  built,
  context,
  getKeys,
  persistSignedTransaction,
  beforeSend,
}) => {
  assertIdentityUpdateContext(context);

  if (!built?.fundingApproval) {
    throw new Error(
      'Missing verified identity funding approval. Review the transaction again.',
    );
  }

  const previousAttempt = submissionAttempts.get(built);

  if (previousAttempt) {
    if (previousAttempt.acknowledged) return {txid: previousAttempt.txid};
    throw unknownBroadcast(previousAttempt.txid);
  }

  const approval = built.fundingApproval;
  // Lock each source individually so overlapping batches cannot race each other.
  const ids = approvedIdentities(approval).map(identity =>
    JSON.stringify([
      context.sessionScope.accountHash,
      context.systemId,
      identity.txid,
      identity.outputIndex,
    ]),
  );
  if (ids.some(id => inFlight.has(id)))
    throw new Error('This identity update is already being sent.');
  ids.forEach(id => inFlight.add(id));

  let attempt;

  try {
    const endpoint = VrpcProvider.getEndpoint(context.systemId);

    // Reject altered approval bytes before requesting keys. Opening keys can
    // pause for user interaction, so the complete live read happens afterward.
    const reviewedTip = await getIdentityUpdateLockContext(context);
    requireIdentityFundingApproval(built, reviewedTip);
    const keys = await guarded(context, getKeys);
    const observed = await inspectIdentityUpdateContext(context, built, {keys});
    const {
      identitySnapshots: signingAuthorities,
      signingKeys,
      lockContext,
    } = observed;
    const signingContext = {
      ...context,
      identitySnapshots: [
        ...(context.identitySnapshots || []),
        ...signingAuthorities,
      ],
    };
    const signedHex = signUpdateIdentityTx(
      context.systemId,
      built.hex,
      built.utxos,
      signingKeys,
      approval,
      lockContext,
    );
    const signed = Transaction.fromHex(signedHex, networks.verus);

    if (signed.ins.some(input => !input.script.length)) {
      throw new Error(
        'The identity update is missing a required signature. Nothing was sent.',
      );
    }

    const txid = signed.getId();

    // This is a local check of the exact bytes before retaining the receipt.
    verifyIdentityUpdateFunding(approval, signedHex, built.utxos, lockContext);

    // Durable workflows retain the exact signed bytes before RPC handoff. A
    // resumed operation reconciles this txid instead of constructing a new one.
    if (persistSignedTransaction) {
      await guarded(signingContext, () =>
        persistSignedTransaction({
          txid,
          rawTx: signedHex,
          systemId: context.systemId,
          inputs: built.utxos,
          fundingApproval: approval,
          type: 'identity',
        }),
      );
    }
    // Unlock and persistence may require user interaction. Delegation/expiry
    // checks belong after those dialogs, immediately before sensitive execution.
    if (beforeSend) await guarded(signingContext, beforeSend);
    const final = await inspectIdentityUpdateContext(signingContext, built, {
      authorityTransactions: observed.authorityTransactions,
    });
    verifyIdentityUpdateFunding(
      approval,
      signedHex,
      built.utxos,
      final.lockContext,
    );

    const returnedTxid = result(
      await guarded(signingContext, () => {
        // Handoff consumes the review; acknowledgement depends on the reply.
        attempt = {txid, submitted: true, acknowledged: false};
        submissionAttempts.set(built, attempt);
        return endpoint.sendRawTransaction(signedHex);
      }),
    );

    if (returnedTxid !== txid)
      throw new Error('The server returned a different transaction ID.');

    attempt.acknowledged = true;
    return {txid};
  } catch (error) {
    if (!attempt) throw error;
    if (error?.code === 'SESSION_CHANGED') {
      throw Object.assign(error, {
        txid: attempt.txid,
        submitted: attempt.submitted,
      });
    }
    throw unknownBroadcast(attempt.txid);
  } finally {
    ids.forEach(id => inFlight.delete(id));
  }
};
