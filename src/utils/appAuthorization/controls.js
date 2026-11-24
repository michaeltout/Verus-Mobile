import {Buffer} from 'buffer';
import {ECPair, networks} from '@bitgo/utxo-lib';
import {
  createAuthorizationReadScope,
  getIdentityPrimaryKeyIDs,
  loadIdentityRevision,
  normalizeIdentityKeyID,
  verifyAppAuthorizationStorageState,
} from 'verusid-ts-client';
import {
  DEFAULT_VERUS_CHAINID,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
  TESTNET_VERUS_CHAINID,
} from 'verus-typescript-primitives';
import store from '../../store';
import {
  captureSessionScope,
  sessionScopeIsCurrent,
} from '../../actions/actions/updates/sessionRequests';
import {requestPrivKey} from '../auth/authBox';
import {CoinDirectory} from '../CoinData/CoinDirectory';
import {ELECTRUM, VRPC} from '../constants/intervalConstants';
import VrpcProvider from '../vrpc/vrpcInterface';

// A local admission bound, not a protocol limit. A cyclic authority graph is
// supported, but an arbitrarily large graph must not monopolize the wallet.
const MAX_AUTHORITY_IDENTITIES = 32;

/** Public records identify candidates; only opening the matching key proves control. */
export const walletAuthorizationKeys = (account, testnet) => {
  const keys = [];

  for (const [coinID, channels] of Object.entries(account?.keys || {})) {
    let coin;

    try {
      coin = CoinDirectory.getBasicCoinObj(coinID);
    } catch (_) {
      continue;
    }

    if (
      !coin ||
      !!coin.testnet !== testnet ||
      !networks[coin.bitgojs_network_key]
    )
      continue;

    for (const channel of [VRPC, ELECTRUM]) {
      const record = channels?.[channel];
      if (!record?.encryptedPrivKey || typeof record.pubKey !== 'string')
        continue;

      try {
        const publicKey = Buffer.from(record.pubKey, 'hex');
        const address = ECPair.fromPublicKeyBuffer(
          publicKey,
          networks.verus,
        ).getAddress();
        keys.push({
          coin,
          channel,
          address,
          keyID: normalizeIdentityKeyID(record.pubKey),
        });
      } catch (_) {
        // Watch-only and malformed records never contribute signing authority.
      }
    }
  }

  return keys;
};

/** Keep each operation on its original profile, network and selected identity. */
export const authorizationContext = (context = {}, user) => {
  const initial = store.getState();
  const sessionScope = context.sessionScope || captureSessionScope(initial);
  const network = JSON.stringify(
    initial.authentication.activeAccount?.testnetOverrides || {},
  );
  const walletKeys = JSON.stringify(
    initial.authentication.activeAccount?.keys || {},
  );
  const selected = user && `${user.systemID}:${user.identityID}`;

  const assertActive = () => {
    context.assertActive?.();
    const state = store.getState();
    const account = state.authentication.activeAccount;

    if (
      !account ||
      state.authentication.signedIn === false ||
      !sessionScopeIsCurrent(state, sessionScope) ||
      context.signal?.aborted ||
      JSON.stringify(account.testnetOverrides || {}) !== network ||
      JSON.stringify(account.keys || {}) !== walletKeys ||
      (user && selected !== `${user.systemID}:${user.identityID}`)
    ) {
      throw Object.assign(
        new Error(
          'The active profile or identity changed. Review app authorization again.',
        ),
        {
          code: 'SESSION_CHANGED',
        },
      );
    }
  };

  assertActive();
  return {...context, sessionScope, assertActive};
};

/**
 * Share observations only within this operation. The final fresh batch detects
 * any identity/chain change during unlock, decryption, or other asynchronous work.
 * Nothing sensitive may be published until this wrapper has returned.
 */
export const withAuthorizationReadScope = async (
  requestContext = {},
  operation,
) => {
  if (requestContext.authorizationSources) return operation(requestContext);

  const initial = store.getState();
  const sessionScope =
    requestContext.sessionScope || captureSessionScope(initial);
  const walletBinding = JSON.stringify([
    initial.authentication.activeAccount?.testnetOverrides,
    initial.authentication.activeAccount?.keys,
  ]);
  const context = {
    ...requestContext,
    sessionScope,
    authorizationSources: new Map(),
    usableAuthorizationKeys: new Set(),
    authorizationChecks: new Set(),
  };
  const assertActive = () => {
    requestContext.assertActive?.();
    const state = store.getState();
    if (
      !sessionScopeIsCurrent(state, sessionScope) ||
      context.signal?.aborted ||
      JSON.stringify([
        state.authentication.activeAccount?.testnetOverrides,
        state.authentication.activeAccount?.keys,
      ]) !== walletBinding
    ) {
      throw Object.assign(
        new Error('The wallet changed during authorization.'),
        {code: 'SESSION_CHANGED'},
      );
    }
  };
  context.assertActive = assertActive;

  try {
    assertActive();
    const result = await operation(context);
    assertActive();
    await Promise.all(
      [...context.authorizationSources.values()].map(source =>
        source.readScope.assertCurrent(),
      ),
    );
    assertActive();
    for (const check of context.authorizationChecks) check();
    return result;
  } finally {
    for (const source of context.authorizationSources.values())
      source.readScope.close();
    context.usableAuthorizationKeys.clear();
    context.authorizationChecks.clear();
  }
};

/** Reuse one client per system inside a phase; ordinary callers get fresh reads. */
export const authorizationSource = (systemID, context = {}) => {
  const saved = context.authorizationSources?.get(systemID);
  if (saved) return saved;
  const coin = CoinDirectory.getBasicCoinObj(systemID);
  if (coin?.system_id !== systemID || !coin.vrpc_endpoints?.length) {
    throw new Error('Unsupported app authorization network.');
  }

  VrpcProvider.initEndpoint(systemID, coin.vrpc_endpoints[0]);
  const client = VrpcProvider.getVerusIdInterface(systemID);
  let readScope;
  if (context.authorizationSources) {
    readScope = createAuthorizationReadScope(client.interface);
    client.interface = readScope.rpc;
  }
  // An omitted grant system always means the network root, even when its
  // containing identity lives on a different PBaaS chain.
  const rootSystemID = coin.testnet
    ? TESTNET_VERUS_CHAINID
    : DEFAULT_VERUS_CHAINID;
  const source = {
    rpc: client.interface,
    client,
    coin,
    systemID,
    rootSystemID,
    readScope,
  };
  context.authorizationSources?.set(systemID, source);
  return source;
};

const sameRevision = (left, right) =>
  left.txid === right.txid &&
  left.vout === right.vout &&
  left.blockheight === right.blockheight;

/** Prove each requested authority once, without retaining any opened private key. */
const assertUsableKeys = async (
  required,
  coin,
  context,
  signKey,
  signingIDs,
) => {
  const candidates = walletAuthorizationKeys(
    store.getState().authentication.activeAccount,
    !!coin.testnet,
  );
  const missing = new Set(required);

  if (
    [...missing].some(keyID => !candidates.some(key => key.keyID === keyID))
  ) {
    throw new Error(
      'This profile must independently control every signing authority of the selected identity.',
    );
  }

  for (const key of candidates) {
    if (!missing.has(key.keyID)) continue;
    context.assertActive();
    // Proof of possession can be reused inside a phase without keeping a WIF.
    // A signature still opens its key in the signing call itself.
    if (
      context.usableAuthorizationKeys?.has(key.keyID) &&
      (!signKey || !signingIDs.has(key.keyID))
    ) {
      missing.delete(key.keyID);
      continue;
    }
    const privateKey = await requestPrivKey(key.coin.id, key.channel, context);
    context.assertActive();
    const pair = ECPair.fromWIF(
      privateKey,
      networks[key.coin.bitgojs_network_key],
    );

    if (normalizeIdentityKeyID(pair.getPublicKeyBuffer()) !== key.keyID) {
      throw new Error(
        'The available private key does not match the selected identity authority.',
      );
    }

    context.usableAuthorizationKeys?.add(key.keyID);
    if (signKey && signingIDs.has(key.keyID)) {
      pair.network = networks.verus;
      signKey(pair);
    }

    missing.delete(key.keyID);
  }

  if (missing.size)
    throw new Error('The required identity signing keys are unavailable.');
};

const identityControlError = message =>
  Object.assign(new Error(message), {code: 'IDENTITY_CONTROL_UNAVAILABLE'});

/**
 * Existing response identities need independent primary control. Gift takeover
 * and storage authorities additionally require every recovery/revocation
 * dependency, so a donor cannot reclaim a gift or take over shared storage.
 */
const readIndependentIdentityControl = async (user, requestContext) => {
  const context = authorizationContext(requestContext, user);
  const source =
    requestContext.source || authorizationSource(user.systemID, context);
  const requireAuthorityControl =
    requestContext.requireAuthorityControl === true;
  const accountTestnet =
    Object.keys(
      store.getState().authentication.activeAccount.testnetOverrides || {},
    ).length > 0;

  if (
    source.systemID !== user.systemID ||
    !!source.coin.testnet !== accountTestnet
  ) {
    throw new Error('The selected identity belongs to a different network.');
  }

  const identities = new Map();
  const pending = [user.identityID];
  const requiredKeys = new Set();

  while (pending.length) {
    const identityID = pending.shift();
    if (identities.has(identityID)) continue;
    if (identities.size >= MAX_AUTHORITY_IDENTITIES) {
      throw identityControlError(
        'The identity authority graph exceeds this wallet’s supported size.',
      );
    }

    context.assertActive();
    const revision = await loadIdentityRevision(source, {
      identityID,
      systemID: user.systemID,
    });
    context.assertActive();

    if (
      revision.status !== 'active' ||
      revision.blockheight < 1 ||
      (revision.identity.flags & IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber()) !==
        0
    ) {
      throw identityControlError(
        'App authorization requires confirmed, active identities without tokenized control.',
      );
    }

    try {
      for (const keyID of getIdentityPrimaryKeyIDs(
        revision.identity.primaryaddresses,
        revision.identity.minimumsignatures,
      ))
        requiredKeys.add(keyID);
    } catch (error) {
      throw identityControlError(error.message);
    }

    identities.set(identityID, revision);
    if (requireAuthorityControl) {
      pending.push(
        revision.identity.revocationauthority,
        revision.identity.recoveryauthority,
      );
    }
  }

  return {context, source, identities, requiredKeys};
};

/** Display capability from public keys; this never proves usable private keys. */
export const inspectIndependentIdentityControl = async (
  user,
  requestContext = {},
) => {
  try {
    const {source, requiredKeys} = await readIndependentIdentityControl(
      user,
      requestContext,
    );
    const available = new Set(
      walletAuthorizationKeys(
        store.getState().authentication.activeAccount,
        !!source.coin.testnet,
      ).map(key => key.keyID),
    );
    return [...requiredKeys].every(keyID => available.has(keyID));
  } catch (error) {
    if (error.code === 'IDENTITY_CONTROL_UNAVAILABLE') return false;
    throw error;
  }
};

/** Prove usable keys and recheck every reviewed authority after unlocking. */
export const assertIndependentIdentityControl = async (
  user,
  requestContext = {},
  signKey,
) => {
  const {context, source, identities, requiredKeys} =
    await readIndependentIdentityControl(user, requestContext);
  const subject = identities.get(user.identityID);
  const signingIDs = getIdentityPrimaryKeyIDs(
    subject.identity.primaryaddresses,
    subject.identity.minimumsignatures,
  );
  await assertUsableKeys(
    requiredKeys,
    source.coin,
    context,
    signKey,
    signingIDs,
  );

  // Unlock prompts can take time. None of the reviewed dependencies may change
  // while keys are opened; a fresh review is required instead of accepting drift.
  for (const [identityID, reviewed] of identities) {
    const current = await loadIdentityRevision(source, {
      identityID,
      systemID: user.systemID,
    });
    context.assertActive();
    if (!sameRevision(reviewed, current)) {
      throw new Error(
        'Identity control changed during authorization. Review it again.',
      );
    }
  }

  return identities.get(user.identityID);
};

// The caller must await the complete check before using any collected keys; the
// callback never changes the subject identity or includes its R/C-only keys.
export const withIndependentIdentitySigningKeys = (user, context, signKey) =>
  assertIndependentIdentityControl(user, context, signKey);

/** Prove current wallet control of shared storage without pinning its authorities. */
export const assertAuthorizationStorageControl = async (
  binding,
  appKeyIDs,
  requestContext = {},
  defaultSystemID,
) => {
  const context = authorizationContext(requestContext);
  const systemID = binding.getSystemID(defaultSystemID);
  const {storageID: identityID} = binding.data;
  const source = authorizationSource(systemID, context);
  const current = await loadIdentityRevision(source, {identityID, systemID});
  context.assertActive();

  if (
    current.blockheight < 1 ||
    (current.identity.flags & IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber()) !==
      0 ||
    !verifyAppAuthorizationStorageState(binding, appKeyIDs, current, systemID)
  ) {
    throw new Error(
      'The shared storage identity no longer has the approved control arrangement.',
    );
  }

  // The wallet identifies its own current signing key. A delegate key cannot
  // also serve as the user's independent route to remove app access.
  const primaryKeys = getIdentityPrimaryKeyIDs(
    current.identity.primaryaddresses,
    current.identity.minimumsignatures,
  );
  const delegateKeys = new Set(appKeyIDs.map(keyID => keyID.toLowerCase()));
  const userKey = walletAuthorizationKeys(
    store.getState().authentication.activeAccount,
    !!source.coin.testnet,
  ).find(key => primaryKeys.has(key.keyID) && !delegateKeys.has(key.keyID));

  if (!userKey) {
    throw new Error(
      'This wallet needs an independent signing key for the storage identity.',
    );
  }

  await assertUsableKeys(new Set([userKey.keyID]), source.coin, context);

  // Follow the live authority pointers, so replacing them with other identities
  // controlled by this wallet does not require a new authorization credential.
  for (const authorityID of new Set([
    current.identity.revocationauthority,
    current.identity.recoveryauthority,
  ])) {
    if (authorityID === identityID) {
      throw new Error(
        'Shared storage needs independently controlled recovery and revocation identities.',
      );
    }
    await assertIndependentIdentityControl(
      {identityID: authorityID, systemID},
      {...context, source, requireAuthorityControl: true},
    );
  }

  const final = await loadIdentityRevision(source, {identityID, systemID});
  context.assertActive();
  if (!sameRevision(current, final)) {
    throw new Error(
      'Shared storage changed during authorization. Review it again.',
    );
  }

  return final;
};
