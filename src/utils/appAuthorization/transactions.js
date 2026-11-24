import {ContentMultiMap} from 'verus-typescript-primitives';
import {ECPair, Transaction, networks} from '@bitgo/utxo-lib';
import {normalizeIdentityKeyID} from 'verusid-ts-client';
import store from '../../store';
import {getIdentity} from '../api/channels/verusid/requests/getIdentity';
import {getBlock, getTransaction} from '../api/channels/vrpc/callCreators';
import {
  getUpdatableIdentity,
  createUpdateIdentityTxWithUtxos,
} from '../api/channels/verusid/requests/updateIdentity';
import {getSpendableUtxos} from '../api/channels/vrpc/requests/getAddressUtxos';
import {buildModifiedIdentity} from '../identityManagement/identityDefinition';
import {
  captureIdentityUpdateContext,
  submitReviewedIdentityUpdate,
} from '../identityUpdate/verifiedSubmission';
import {
  broadcastPendingTransactions,
  createPendingBroadcast,
} from '../spendableKey/durableBroadcast';
import {CoinDirectory} from '../CoinData/CoinDirectory';
import VrpcProvider from '../vrpc/vrpcInterface';
import {requestPrivKey} from '../auth/authBox';
import {
  confirmVerifiedClaimFees,
  verifiedClaimFees,
} from '../spendableKey/reviewFees';
import {
  walletAuthorizationKeys,
  withIndependentIdentitySigningKeys,
} from './controls';
import {
  assertAuthorizationContext,
  captureAuthorizationContext,
  getAuthorizationJob,
  updateAuthorizationJob,
} from './jobs';
import {AUTHORIZATION_STATUS, GRANT_RECEIPT_KEY} from './constants';
import {prepareAuthorizationGiftFunding} from './funding';

export const AUTHORIZATION_MIN_CONFIRMATIONS = 1;

/** Share exact, verified fees with the review screen without exposing raw plans. */
export const confirmAuthorizationFees = async (
  transactions,
  details,
  context,
) => {
  assertAuthorizationContext(context);
  const currencyName = currency => {
    try {
      const coin = CoinDirectory.getBasicCoinObj(currency);
      return coin.display_ticker || coin.id;
    } catch (_) {
      return currency;
    }
  };
  const allocation = details.giftAllocation;
  const fundingDescription = allocation
    ? '\n\nGift funds after fees:\n' + [
        `${allocation.reserve.coins} ${currencyName(allocation.currency)} reserved at ${allocation.reserve.identityID} for removing access.`,
        ...allocation.storage.map(item =>
          `${item.coins} ${currencyName(allocation.currency)} to ${item.identityID} for app storage.`,
        ),
      ].join('\n')
    : '';
  const approved = context.confirmFees
    ? await context.confirmFees({
        type: details.type,
        identityID: details.identityID,
        systemID: details.systemID,
        transactionCount: transactions.length,
        ...(details.paidFromGift ? {paidFromGift: true} : {}),
        ...(details.giftAllocation ? {giftAllocation: details.giftAllocation} : {}),
        fees: verifiedClaimFees(transactions).map(fee => ({
          ...fee,
          ticker: currencyName(fee.currency),
        })),
      })
    : await confirmVerifiedClaimFees({transactions}, currencyName, {
        title: 'Confirm network fee',
        actionLabel: 'Continue',
        description: (details.paidFromGift
          ? 'This single transaction transfers the gift, sets up shared storage, and records app access. Its network fee is paid from the gift funds.'
          : 'This verified network fee will be paid from your wallet or selected identity funds.') + fundingDescription,
      });
  // A screen can disappear or switch wallets while its fee review is open.
  assertAuthorizationContext(context);
  return approved === true;
};

const rpcResult = response => {
  if (response?.error || response?.result == null)
    throw new Error(
      response?.error?.message || 'Unable to verify chain state.',
    );
  return response.result;
};

// Confirm inclusion in the endpoint's active chain, not just an RPC broadcast
// acknowledgement or a transaction that happens to be in its mempool.
export const confirmAuthorizationTransaction = async (receipt, options) => {
  const context = captureAuthorizationContext(options);
  assertAuthorizationContext(context);
  if (!receipt?.systemId || !receipt.txid)
    throw new Error('The saved authorization transaction is incomplete.');
  const coin = CoinDirectory.getBasicCoinObj(receipt.systemId);
  if (coin?.system_id !== receipt.systemId || !coin.vrpc_endpoints?.[0]) {
    throw new Error(
      'The saved authorization transaction belongs to an unsupported network.',
    );
  }
  VrpcProvider.initEndpoint(receipt.systemId, coin.vrpc_endpoints[0]);
  const response = await getTransaction(receipt.systemId, receipt.txid, 1);
  assertAuthorizationContext(context);
  if (response?.error?.code === -5) return false;
  const transaction = rpcResult(response);
  if (
    !Number.isSafeInteger(transaction.confirmations) ||
    transaction.confirmations < AUTHORIZATION_MIN_CONFIRMATIONS
  )
    return false;
  if (
    transaction.txid !== receipt.txid ||
    Transaction.fromHex(transaction.hex, networks.verus).getId() !== receipt.txid ||
    (receipt.rawTx != null && transaction.hex !== receipt.rawTx) ||
    !transaction.blockhash
  ) {
    throw new Error(
      'The confirmed transaction does not match the saved authorization update.',
    );
  }
  const block = rpcResult(
    await getBlock(receipt.systemId, transaction.blockhash, 1),
  );
  assertAuthorizationContext(context);
  if (
    block.hash !== transaction.blockhash ||
    !Number.isSafeInteger(block.height) ||
    block.height < 1 ||
    !Number.isSafeInteger(block.confirmations) ||
    block.confirmations < AUTHORIZATION_MIN_CONFIRMATIONS ||
    !block.tx?.includes(receipt.txid)
  )
    return false;
  const active = rpcResult(
    await getBlock(receipt.systemId, String(block.height), 1),
  );
  assertAuthorizationContext(context);
  return (
    active.hash === transaction.blockhash &&
    active.height === block.height &&
    Number.isSafeInteger(active.confirmations) &&
    active.confirmations >= AUTHORIZATION_MIN_CONFIRMATIONS
  );
};

/** Shared durable writer for combined authorization and access removals. */
export const submitAuthorizationIdentityUpdate = async (
  jobId,
  options,
  requestContext,
) => {
  const context = captureAuthorizationContext(requestContext);
  const {
    identityID,
    systemID,
    contentmultimap,
    changes,
    receiptKey,
    beforeSend,
  } = options;
  if (!receiptKey)
    throw new Error('An authorization update needs a stable receipt key.');
  let job = await getAuthorizationJob(jobId, context);
  const coin = CoinDirectory.getBasicCoinObj(systemID);
  if (!coin?.vrpc_endpoints?.[0])
    throw new Error('Unsupported authorization identity chain.');
  VrpcProvider.initEndpoint(systemID, coin.vrpc_endpoints[0]);
  const identityContext = captureIdentityUpdateContext({
    sessionScope: context.sessionScope,
    systemId: systemID,
    assertActive: () => assertAuthorizationContext(context),
  });

  const persist = async receipt => {
    // The first attempted handoff is the admission deadline evidence. A later
    // retry/acknowledgement must not replace it with a post-expiry timestamp.
    const admittedAt =
      job.transactions?.[receiptKey]?.admittedAt ||
      receipt.admittedAt ||
      (receipt.broadcastAttempted ? Date.now() : undefined);
    const savedReceipt = {...receipt, ...(admittedAt ? {admittedAt} : {})};
    job = await updateAuthorizationJob(
      jobId,
      current => ({
        ...current,
        // Save reviewed authorization data with the first signed receipt. Fee
        // review stays read-only, and a crash can never leave a signed receipt
        // without the plan needed to validate its eventual handoff.
        ...(!current.transactions?.[receiptKey] ? options.jobChanges : {}),
        transactions: {
          ...current.transactions,
          [receiptKey]: savedReceipt,
        },
        ...(receiptKey === GRANT_RECEIPT_KEY && receipt.status === 'submitted'
          ? {
              grantConfirmed: false,
              status:
                current.status === AUTHORIZATION_STATUS.CANCELLED ||
                current.status === AUTHORIZATION_STATUS.COMPLETE
                  ? current.status
                  : AUTHORIZATION_STATUS.WAITING_FOR_GRANT,
            }
          : {}),
      }),
      context,
    );
  };
  const saved = job.transactions?.[receiptKey];
  if (saved) {
    if (await confirmAuthorizationTransaction(saved, context)) return saved;
    if (!saved.rawTx) {
      throw new Error(
        'The completed authorization transaction is no longer confirmed. Review current app access before submitting another update.',
      );
    }
    // Existing receipt reconciliation occurs even after the request expires;
    // beforeSend still prohibits a fresh handoff after its signed deadline.
    await broadcastPendingTransactions({
      pendingBroadcast: createPendingBroadcast({
        kind: 'app-authorization',
        transactions: [saved],
      }),
      persistPendingBroadcast: batch => persist(batch.transactions[0]),
      beforeSend,
      assertCurrent: () => assertAuthorizationContext(context),
      identityContext,
      resumeSavedTransactions: true,
    });
    return job.transactions[receiptKey];
  }

  const definitions = options.updates || [
    {identityID, changes, contentmultimap},
  ];
  const updates = [];
  for (const definition of definitions) {
    const current = rpcResult(
      await getIdentity(systemID, definition.identityID),
    );
    assertAuthorizationContext(context);
    if (
      definition.reviewedRevision &&
      (current.txid !== definition.reviewedRevision.txid ||
        current.vout !== definition.reviewedRevision.vout)
    ) {
      throw new Error(
        'An identity changed after authorization review. Review it again.',
      );
    }
    const {tx, identity} = await getUpdatableIdentity(systemID, current);
    assertAuthorizationContext(context);
    const updated = definition.changes
      ? buildModifiedIdentity(identity, definition.changes)
      : identity;
    // A gift transfers every private receiving address; retaining hidden
    // additional donor addresses would leave part of the gift under donor control.
    if (definition.replacePrivateAddresses) {
      updated.privateAddresses = updated.privateAddresses.slice(0, 1);
    }
    // CMM entries are transaction-local operations, never aggregate history.
    updated.clearContentMultiMap();
    if (definition.contentmultimap) {
      updated.contentMultiMap = ContentMultiMap.fromJson(
        definition.contentmultimap,
      );
    }
    updates.push({
      identity: updated,
      rawIdentityTransaction: tx,
      identityTransactionHeight: current.blockheight,
    });
  }
  const keyMap = new Map();
  const keys = [];
  try {
    const signingIdentities = options.updates
      ? options.signingIdentities || []
      : [
          options.signingIdentity || {identityID, systemID},
          ...(options.signingIdentities || []),
        ];
    const seen = new Set();
    for (const signingIdentity of signingIdentities) {
      const binding = `${signingIdentity.systemID}:${signingIdentity.identityID}`;
      if (seen.has(binding)) continue;
      seen.add(binding);
      await withIndependentIdentitySigningKeys(
        signingIdentity,
        context,
        key => {
          keyMap.set(
            normalizeIdentityKeyID(key.getPublicKeyBuffer()),
            key.toWIF(),
          );
        },
      );
      assertAuthorizationContext(context);
    }

    // Shared S can use a wallet key different from U's primary key. Prove the
    // specifically selected key rather than assuming linkage means ownership.
    const candidates = walletAuthorizationKeys(
      store.getState().authentication.activeAccount,
      !!coin.testnet,
    );
    for (const keyID of options.signingKeyIDs || []) {
      if (keyMap.has(keyID)) continue;
      const candidate = candidates.find(key => key.keyID === keyID);
      if (!candidate)
        throw new Error(
          'The selected storage signing key is unavailable in this profile.',
        );
      const wif = await requestPrivKey(
        candidate.coin.id,
        candidate.channel,
        context,
      );
      assertAuthorizationContext(context);
      const pair = ECPair.fromWIF(
        wif,
        networks[candidate.coin.bitgojs_network_key],
      );
      if (normalizeIdentityKeyID(pair.getPublicKeyBuffer()) !== keyID) {
        throw new Error(
          'The storage private key does not match the approved wallet key.',
        );
      }
      keyMap.set(keyID, pair.toWIF());
    }
    for (const wif of options.donorKeys || []) {
      const pair = ECPair.fromWIF(wif, networks.verus);
      keyMap.set(
        normalizeIdentityKeyID(pair.getPublicKeyBuffer()),
        pair.toWIF(),
      );
    }
    keys.push(...keyMap.values());
    if (!keys.length)
      throw new Error('No usable signing keys for this identity.');
    // Keep unused removal funds on U so later management can use the reserve.
    let changeAddress = options.changeAddress || identityID;

    // Existing identities may hold native funds alongside the wallet's keys.
    // Gift plans supply their complete donor funding set explicitly below.
    const fundingAddresses = new Set(
      keys.map(wif => ECPair.fromWIF(wif, networks.verus).getAddress()),
    );
    fundingAddresses.add(identityID);
    if (job.selectedIdentity?.systemID === systemID)
      fundingAddresses.add(job.selectedIdentity.identityID);
    const utxos =
      options.fundingUtxos ||
      (await getSpendableUtxos(systemID, systemID, [...fundingAddresses]));
    assertAuthorizationContext(context);
    const giftFunding = options.sweepFunding
      ? prepareAuthorizationGiftFunding(updates, options.giftFunding, utxos, systemID)
      : null;
    if (giftFunding) changeAddress = giftFunding.changeAddress;
    const built = options.updates
      ? await VrpcProvider.getVerusIdInterface(
          systemID,
        ).createUpdateIdentitiesTransaction(updates, changeAddress, utxos, {
          chainIAddr: systemID,
          parseVdxfObjects: true,
          isTestnet: !!coin.testnet,
          useAllFundingInputs: options.sweepFunding === true,
          ...(giftFunding ? {
            currencyTransferOutputs: giftFunding.currencyTransferOutputs,
            nativeFee: giftFunding.nativeFee,
          } : {}),
        })
      : await createUpdateIdentityTxWithUtxos({
          systemId: systemID,
          identity: updates[0].identity,
          changeAaddr: changeAddress,
          rawIdTx: updates[0].rawIdentityTransaction,
          idHeight: updates[0].identityTransactionHeight,
          utxos,
          isTestnet: !!coin.testnet,
        });
    assertAuthorizationContext(context);
    if (giftFunding) {
      // The SDK verifies real prevouts. A reported gift amount must also match
      // the reviewed split exactly; unexpected change requires a fresh review.
      const paid = Transaction.fromHex(built.hex, networks.verus).outs.reduce(
        (sum, output) => sum + output.value,
        0,
      );
      if (
        !Number.isSafeInteger(paid) ||
        String(paid) !== giftFunding.allocatedAtomic ||
        built.fundingApproval.nativeFee !== giftFunding.nativeFee
      ) {
        throw new Error('The verified gift balance changed. Review the gift funding again.');
      }
    }
    const approved = await confirmAuthorizationFees(
      [
        {
          type: 'identity',
          systemId: systemID,
          txHex: built.hex,
          inputs: built.utxos,
          fundingApproval: built.fundingApproval,
        },
      ],
      {
        type:
          options.feeType || (options.updates ? 'authorization' : 'removal'),
        identityID,
        systemID,
        paidFromGift: options.sweepFunding === true,
        giftAllocation: giftFunding?.allocation,
      },
      context,
    );
    assertAuthorizationContext(context);
    if (!approved)
      throw Object.assign(
        new Error('Authorization update cancelled before signing.'),
        {code: 'AUTHORIZATION_FEES_DECLINED'},
      );
    const result = await submitReviewedIdentityUpdate({
      built,
      context: identityContext,
      getKeys: () => Promise.resolve(built.utxos.map(() => keys)),
      persistSignedTransaction: async receipt => {
        const transaction = Transaction.fromHex(receipt.rawTx, networks.verus);
        if (transaction.getId() !== receipt.txid)
          throw new Error('Invalid authorization transaction receipt.');
        await persist({...receipt, identityID, status: 'prepared'});
      },
      beforeSend: async () => {
        assertAuthorizationContext(context);
        // Record intent before the network call: a crash here is reconciled by
        // txid, including a grant mined after the request's expiry.
        await persist({
          ...job.transactions[receiptKey],
          broadcastAttempted: true,
        });
        await beforeSend?.();
      },
    });
    await persist({
      ...job.transactions[receiptKey],
      status: 'submitted',
      txid: result.txid,
    });
    return job.transactions[receiptKey];
  } finally {
    keys.length = 0;
    keyMap.clear();
  }
};
