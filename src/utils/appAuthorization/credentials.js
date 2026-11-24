import {Buffer} from 'buffer';
import {
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  ContentMultiMapRemove,
  DataDescriptorKey,
  VdxfUniValue,
} from 'verus-typescript-primitives';
import {
  decodeAppAuthorizationRecords,
  getIdentityPrimaryKeyIDs,
  loadCurrentIdentityContent,
  loadIdentityRevision,
  resolveAppAuthorizationIdentities,
} from 'verusid-ts-client';
import store from '../../store';
import {deriveCredentialSelfChannel} from '../crypto/encryptCredentials';
import {encryptCredentialToDescriptor} from '../crypto/encryptDataDescriptor';
import {decryptAuthorizationCredentialValue} from '../deeplink/credentials/scopedCredentials';
import {
  authorizationContext,
  authorizationSource,
  assertIndependentIdentityControl,
  walletAuthorizationKeys,
} from './controls';

// Wallet admission limits bound work on a cold credential bucket. These do not
// change the protocol's credential size or supported number of relationships.
export const MAX_AUTHORIZATION_BUCKET_ENTRIES = 2048;
export const MAX_AUTHORIZATION_BUCKET_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_AUTHORIZATION_IDENTITIES = 8;
const cache = new Map();
const views = new WeakMap();

export const invalidateAuthorizationCredentials = () => cache.clear();

const sessionFingerprint = () => {
  const {authentication} = store.getState();
  return JSON.stringify([
    authentication.activeAccount?.accountHash,
    authentication.sessionEpoch,
    authentication.signedIn,
    authentication.activeAccount?.testnetOverrides,
    authentication.activeAccount?.keys,
  ]);
};

let cachedSession;
let subscribed = false;
const ensureSessionSubscription = () => {
  // This module is also reached while Redux initializes its sagas. Subscribe
  // only when a real authorization read begins, after store construction.
  if (subscribed || !store.subscribe) return;
  cachedSession = sessionFingerprint();
  store.subscribe(() => {
    const session = sessionFingerprint();
    if (cachedSession !== session) invalidateAuthorizationCredentials();
    cachedSession = session;
  });
  subscribed = true;
};

const sameRevision = (left, right) =>
  left.txid === right.txid &&
  left.vout === right.vout &&
  left.blockheight === right.blockheight;

const storedBytes = entry => {
  const hex = typeof entry === 'string' ? entry : entry?.serializedhex;
  if (
    typeof hex === 'string' &&
    hex.length <= MAX_AUTHORIZATION_BUCKET_BYTES * 2 &&
    /^(?:[0-9a-f]{2})+$/i.test(hex)
  ) {
    return Buffer.from(hex, 'hex');
  }
  if (
    Buffer.isBuffer(entry) &&
    entry.length &&
    entry.length <= MAX_AUTHORIZATION_BUCKET_BYTES
  )
    return Buffer.from(entry);
  if (
    typeof entry === 'string' ||
    Buffer.isBuffer(entry) ||
    JSON.stringify(entry)?.length > MAX_AUTHORIZATION_BUCKET_BYTES * 2
  ) {
    throw new Error(
      'The encrypted credential value exceeds this wallet’s supported size or has invalid encoding.',
    );
  }

  // Core renders a known native descriptor as typed VDXF JSON. Reconstruct its
  // native HASH160 wrapper, not the compact-address wrapper: removal hashes must
  // refer to the exact bytes stored on chain. Raw values retain their exact bytes.
  const value = VdxfUniValue.fromJson(entry);
  const bytes = value.toBuffer();
  const parsed = new VdxfUniValue();
  if (
    !bytes.length ||
    parsed.fromBuffer(bytes) !== bytes.length ||
    !parsed.toBuffer().equals(bytes)
  ) {
    throw new Error('Unable to retain the complete stored credential value.');
  }
  return bytes;
};

const assertSnapshotCurrent = async (source, user, snapshot, context) => {
  context.assertActive();
  const [revision, response] = await Promise.all([
    loadIdentityRevision(source, user),
    source.rpc.getBlock(String(snapshot.readHeight), 1),
  ]);
  context.assertActive();
  const block = response.result;

  if (
    !sameRevision(revision, snapshot.revision) ||
    response.error ||
    !block ||
    block.height !== snapshot.readHeight ||
    block.hash !== snapshot.blockHash ||
    !Number.isSafeInteger(block.confirmations) ||
    block.confirmations < 1
  ) {
    throw new Error(
      'Authorization content changed while being read. Review the request again.',
    );
  }

  return revision;
};

/** Recheck membership after user interaction, asynchronous decryption and control checks. */
export const assertAuthorizationCredentialsCurrent = async (
  view,
  requestContext = {},
) => {
  const saved = views.get(view);
  if (!saved)
    throw new Error(
      'Authorization content must be loaded from the selected identity.',
    );
  const context = authorizationContext(requestContext, saved.user);
  const source = authorizationSource(saved.user.systemID, context);
  if (
    source.rpc.instance?.defaults?.baseURL !==
    saved.source.rpc.instance?.defaults?.baseURL
  ) {
    throw new Error(
      'The authorization RPC changed. Load the credentials again.',
    );
  }
  return assertSnapshotCurrent(source, saved.user, saved.snapshot, context);
};

/**
 * Load one complete, removal-aware self-encrypted bucket. Cache only decoded
 * values at the exact U revision and active block; never merge height windows.
 */
export const loadAuthorizationCredentials = async (
  user,
  requestContext = {},
) => {
  ensureSessionSubscription();
  const context = authorizationContext(requestContext, user);
  const source = authorizationSource(user.systemID, context);
  const current = await assertIndependentIdentityControl(user, {
    ...context,
    source,
  });
  const endpoint = source.rpc.instance?.defaults?.baseURL;
  // The session fingerprint includes every encrypted transparent/shielded key.
  // An unchanged confirmed identity can reuse decoded credentials without
  // reopening the self channel. No derived viewing/spending key is cached.
  const cacheKey =
    endpoint && JSON.stringify([sessionFingerprint(), endpoint, user]);
  const previous = cacheKey && cache.get(cacheKey);
  const unchanged =
    previous && sameRevision(current, previous.snapshot.revision);
  let snapshot = unchanged ? previous.snapshot : null;
  let members = unchanged ? previous.members : null;
  let outerKey = unchanged ? previous.outerKey : null;
  let keys;
  let decrypted = new Map(previous?.decrypted || []);

  if (!snapshot) {
    keys = await deriveCredentialSelfChannel(
      user.systemID,
      current,
      source.coin,
      context,
    );
    context.assertActive();
    outerKey = keys.outerKey;
    snapshot = await loadCurrentIdentityContent(source, user, outerKey);
    context.assertActive();
    const raw = snapshot.revision.identity.contentmultimap[outerKey];
    const entries = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    if (entries.length > MAX_AUTHORIZATION_BUCKET_ENTRIES) {
      throw new Error(
        'The encrypted credential bucket exceeds this wallet’s supported entry count.',
      );
    }

    let size = 0;
    members = entries.map(entry => {
      const bytes = storedBytes(entry);
      size += bytes.length;
      if (size > MAX_AUTHORIZATION_BUCKET_BYTES) {
        throw new Error(
          'The encrypted credential bucket exceeds this wallet’s supported size.',
        );
      }
      return bytes.toString('hex');
    });
  }

  for (let index = 0; index < members.length; index++) {
    context.assertActive();
    const hex = members[index];
    if (!decrypted.has(hex)) {
      const credentials = await decryptAuthorizationCredentialValue(
        Buffer.from(hex, 'hex'),
        keys.ivk,
        context.assertActive,
      );
      decrypted.set(
        hex,
        credentials.map(credential => credential.toBuffer().toString('hex')),
      );
    }
    context.onProgress?.({completed: index + 1, total: members.length});
  }

  // Drop deleted ciphertext from both membership and the decryption cache.
  decrypted = new Map(members.map(hex => [hex, decrypted.get(hex)]));
  const entries = members.flatMap(hex =>
    decrypted.get(hex).map(credential => ({
      credential: Buffer.from(credential, 'hex'),
      source: {
        ...user,
        outerKey,
        storedValue: Buffer.from(hex, 'hex'),
      },
    })),
  );
  const records = decodeAppAuthorizationRecords(entries);
  // Identity labels and lookup indexes are derived metadata, not extra fields
  // in the persisted grant. Keep unreadable grants removable and let other
  // complete authorizations remain usable if one historical lookup fails.
  await Promise.all(
    records.map(async entry => {
      if (!(entry.record instanceof AuthorizationCredential)) return;
      try {
        const signingSystemID = entry.record.getSystemID(source.rootSystemID);
        const signingSource = signingSystemID === source.systemID
          ? source
          : authorizationSource(signingSystemID, context);
        entry.identities = await resolveAppAuthorizationIdentities(
          signingSource,
          entry.record,
        );
        context.assertActive();
      } catch (error) {
        context.assertActive();
        if (error.code === 'SESSION_CHANGED') throw error;
        entry.identityError =
          error.message || 'The approved identity revisions are unavailable.';
      }
    }),
  );
  let identity;
  try {
    // One final check covers both cached membership and any native decryption.
    identity = await assertSnapshotCurrent(source, user, snapshot, context);
  } catch (error) {
    if (cacheKey) cache.delete(cacheKey);
    throw error;
  }

  if (cacheKey) {
    if (
      cache.size >= MAX_CACHED_AUTHORIZATION_IDENTITIES &&
      !cache.has(cacheKey)
    ) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(cacheKey, {snapshot, members, decrypted, outerKey});
  }

  const view = {
    source: {...user},
    rootSystemID: source.rootSystemID,
    identity,
    outerKey,
    entries,
    records,
    grants: records.filter(
      ({record}) => record instanceof AuthorizationCredential,
    ),
    storageBindings: records.filter(
      ({record}) => record instanceof AuthorizationStorageBindingCredential,
    ),
  };
  views.set(view, {source, user: {...user}, snapshot});
  return view;
};

/** Produce transaction-local additions; never replay an aggregated CMM as an update. */
export const encryptAuthorizationCredentials = async (
  user,
  records,
  requestContext = {},
) => {
  const context = authorizationContext(requestContext, user);
  const source = authorizationSource(user.systemID, context);
  const identity = await assertIndependentIdentityControl(user, {
    ...context,
    source,
  });
  return encryptCredentialsForIdentity(
    user,
    records,
    identity,
    source,
    context,
  );
};

/** Only an reviewed gift plan may encrypt to U's reviewed future wallet address. */
export const encryptProjectedAuthorizationCredentials = async (
  user,
  records,
  projectedIdentity,
  requestContext = {},
) => {
  const context = authorizationContext(requestContext, user);
  const source = authorizationSource(user.systemID, context);
  const walletKeys = new Set(
    walletAuthorizationKeys(
      store.getState().authentication.activeAccount,
      !!source.coin.testnet,
    ).map(key => key.keyID),
  );
  const primary = getIdentityPrimaryKeyIDs(
    projectedIdentity.primaryaddresses,
    projectedIdentity.minimumsignatures,
  );
  if (
    projectedIdentity.identityaddress !== user.identityID ||
    [...primary].some(key => !walletKeys.has(key))
  ) {
    throw new Error(
      'The projected credential identity must belong exclusively to this wallet.',
    );
  }
  // The existing derivation proves that the projected private address belongs
  // to this profile's seed. It never falls back to the donor's address or key.
  return encryptCredentialsForIdentity(
    user,
    records,
    projectedIdentity,
    source,
    context,
  );
};

const encryptCredentialsForIdentity = async (
  user,
  records,
  identity,
  source,
  context,
) => {
  const keys = await deriveCredentialSelfChannel(
    user.systemID,
    identity,
    source.coin,
    context,
  );
  const entries = [];

  for (const record of records) {
    if (
      !(record instanceof AuthorizationCredential) &&
      !(record instanceof AuthorizationStorageBindingCredential)
    ) {
      throw new Error('Unsupported app authorization record.');
    }

    context.assertActive();
    const {encryptedDescriptor} = await encryptCredentialToDescriptor(
      keys.address,
      record.toCredential(),
    );
    context.assertActive();
    entries.push(
      new VdxfUniValue({
        values: [{[DataDescriptorKey.vdxfid]: encryptedDescriptor}],
      })
        .toBuffer()
        .toString('hex'),
    );
  }

  return {[keys.outerKey]: entries};
};

/** Remove exact effective copies while retaining unrelated and management records. */
export const buildAuthorizationRemovals = entries => {
  const seen = new Set();
  const removals = [];
  for (const entry of entries) {
    const source = entry.source;
    const key = `${source.outerKey}:${source.storedValue.toString('hex')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    removals.push(
      ContentMultiMapRemove.removeStoredValue(
        source.outerKey,
        source.storedValue,
      ),
    );
  }
  return removals;
};
