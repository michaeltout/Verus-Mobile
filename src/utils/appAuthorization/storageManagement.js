import {
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  ContentMultiMapRemoveKey,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
  verifyAppAuthorizationStorageManifest,
} from 'verus-typescript-primitives';
import {loadIdentityRevision, normalizeIdentityKeyID} from 'verusid-ts-client';
import {
  assertAuthorizationCredentialsCurrent,
  buildAuthorizationRemovals,
  encryptAuthorizationCredentials,
  invalidateAuthorizationCredentials,
  loadAuthorizationCredentials,
} from './credentials';
import {
  assertIndependentIdentityControl,
  authorizationContext,
  authorizationSource,
  inspectIndependentIdentityControl,
  walletAuthorizationKeys,
} from './controls';
import store from '../../store';
import {requestServiceStoredData} from '../auth/authBox';
import {VERUSID_SERVICE_ID} from '../constants/services';
import {VRPC} from '../constants/intervalConstants';
import {
  markVerusIdAsStorage,
  withLinkedVerusId,
} from '../../actions/actions/services/dispatchers/verusid/verusid';
import {modifyServiceStoredDataForUser} from '../../actions/actions/services/dispatchers/services';
import {refreshLinkedIdentityWallet} from '../identityManagement/unlinkAfterUpdate';
import {
  AUTHORIZATION_STATUS,
  authorizationMaintenanceUsers,
  assertAuthorizationContext,
  captureAuthorizationContext,
  createAuthorizationMaintenanceJob,
  getAuthorizationJob,
  summarizeAuthorizationJob,
  updateAuthorizationJob,
  withAuthorizationJob,
} from './jobs';
import {
  confirmAuthorizationTransaction,
  submitAuthorizationIdentityUpdate,
} from './transactions';
import {STORAGE_ACCESS_STATE} from './constants';

const STORAGE_REMOVAL_KIND = 'storage-keys';
const MANAGEMENT_RECEIPT_KEY = 'storage-management';
const SINGLE_SIGNATURE = 1;
const relationshipID = data => `${data.grantID}:${data.relationshipIndex}`;
const storageIdentityID = binding =>
  `${binding.storageSystemID}:${binding.storageID}`;

// A retained binding loses its grant's default after that approval is deleted.
// Resolve inheritance separately from manifest completeness so cleanup remains
// possible even when an approval's complete storage set is unavailable.
export const resolveAuthorizationStorageSystem = (view, record) => {
  if (record.data.storageSystemID !== undefined) return record.getSystemID();
  const systems = new Set(
    view.grants
      .filter(entry => entry.record.data.grantID === record.data.grantID)
      .map(entry => entry.record.getSystemID(view.rootSystemID)),
  );
  if (systems.size > 1) {
    throw new Error(
      'The storage record has conflicting inherited networks. Review the app’s approvals before removing access.',
    );
  }
  return record.getSystemID(
    systems.size ? systems.values().next().value : view.rootSystemID,
  );
};

/** Collapse identical ciphertext copies, rejecting contradictory portable maps. */
const readStorageRelationships = view => {
  const bindings = new Map();
  const checkedGrants = new Set();
  const payloadFor = record =>
    new AuthorizationStorageBindingCredential({
      ...record.data,
      storageSystemID: resolveAuthorizationStorageSystem(view, record),
    }).toPayload();
  for (const {record} of view.storageBindings) {
    if (!(record instanceof AuthorizationStorageBindingCredential)) {
      throw new Error('Invalid storage-management binding.');
    }
    const payload = payloadFor(record);
    const id = `${record.data.grantID}:${record.recordID}`;
    const previous = bindings.get(id);
    if (
      previous &&
      JSON.stringify(payloadFor(previous)) !== JSON.stringify(payload)
    ) {
      throw new Error(
        'Conflicting storage-management records require review before removing any signing key.',
      );
    }
    bindings.set(id, record);
  }

  // Each binding is independently sufficient for cleanup. The grant's manifest
  // governs authorization, but removing one storage relationship can leave
  // other bindings behind after that grant has been deleted.
  return [...bindings.values()].map(record => {
    const binding = record.data;
    const grants = view.grants.filter(
      entry => entry.record.data.grantID === binding.grantID,
    );
    const grant = grants[0];
    const signingSystemID = grant?.record.getSystemID(view.rootSystemID);
    const storageSystemID = resolveAuthorizationStorageSystem(view, record);
    if (grant && !checkedGrants.has(binding.grantID)) {
      const payload = JSON.stringify(
        new AuthorizationCredential({
          ...grant.record.data,
          signingSystemID,
        }).toPayload(),
      );
      const relationships = [...bindings.values()].filter(
        item => item.data.grantID === binding.grantID,
      );
      if (
        grants.some(
          entry =>
            JSON.stringify(
              new AuthorizationCredential({
                ...entry.record.data,
                signingSystemID: entry.record.getSystemID(view.rootSystemID),
              }).toPayload(),
            ) !== payload,
        ) ||
        !verifyAppAuthorizationStorageManifest(
          grant.record,
          relationships,
          view.rootSystemID,
        )
      ) {
        throw new Error(
          'Storage-management records are incomplete or conflicting. Restore the complete storage bindings before removing access.',
        );
      }
      checkedGrants.add(binding.grantID);
    }
    return {
      ...binding,
      storageSystemID,
      orphaned: !grant,
      approvalUnknown: !!grant && !grant.identities,
      appID: grant?.identities?.appID,
      appSystemID: signingSystemID,
      delegateID: grant?.identities?.delegateID,
    };
  });
};

/** Portable maps remain discoverable even after their app grants were deleted. */
export const listAuthorizationStorageAccess = async (
  user,
  options,
  suppliedView,
) => {
  const context = authorizationContext(
    captureAuthorizationContext(options),
    user,
  );
  const view =
    suppliedView || (await loadAuthorizationCredentials(user, context));
  assertAuthorizationContext(context);
  let relationships = readStorageRelationships(view);

  // A restored wallet can discover storage from U's portable records before it
  // has any local classification. Accept only complete records from this U and
  // this chain, including records whose app approval has already been removed.
  if (
    view.source?.identityID !== user.identityID ||
    view.source?.systemID !== user.systemID ||
    view.storageBindings.some(
      entry =>
        entry.source?.identityID !== user.identityID ||
        entry.source?.systemID !== user.systemID,
    ) ||
    relationships.some(
      binding =>
        binding.storageSystemID === user.systemID &&
        binding.storageID === user.identityID,
    )
  ) {
    throw new Error(
      'Storage-management records must belong to the selected identity and network.',
    );
  }

  // Only same-system storage participates in this wallet's local link map.
  // Explicit foreign-system records remain visible for inspection.
  const localRelationships = relationships.filter(
    binding => binding.storageSystemID === user.systemID,
  );
  if (localRelationships.length) {
    const source = authorizationSource(user.systemID, context);
    const {coin} = source;
    const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
    assertAuthorizationContext(context);
    const storageIDs = new Set(
      localRelationships.map(binding => binding.storageID),
    );
    const linked = data.linked_ids?.[coin.id] || {};
    const knownStorage = data.storage_ids?.[coin.id] || {};
    const walletKeys = new Set(
      walletAuthorizationKeys(
        store.getState().authentication.activeAccount,
        !!coin.testnet,
      ).map(key => key.keyID),
    );

    // A confirmed take-back links S as an ordinary wallet identity. Old maps
    // held by another U cannot classify it as storage again; a later handshake
    // must first add an app key on chain before discovery may unlink it.
    for (const identityID of storageIDs) {
      if (!Object.prototype.hasOwnProperty.call(linked, identityID)) continue;
      const current = await loadIdentityRevision(source, {
        identityID,
        systemID: user.systemID,
      });
      assertAuthorizationContext(context);
      const primary = current.identity.primaryaddresses;
      if (
        current.status === 'active' &&
        current.blockheight > 0 &&
        primary.length &&
        primary.every(address => {
          try {
            return walletKeys.has(normalizeIdentityKeyID(address));
          } catch (_) {
            return false;
          }
        })
      ) {
        storageIDs.delete(identityID);
      }
    }
    relationships = relationships.filter(binding =>
      binding.storageSystemID !== user.systemID ||
      storageIDs.has(binding.storageID),
    );
    const unclassified = [...storageIDs].filter(
      identityID =>
        Object.prototype.hasOwnProperty.call(linked, identityID) ||
        !knownStorage[identityID]?.userIdentityIDs?.includes(user.identityID),
    );

    // Retry a failed presentation refresh even if classification was already
    // saved. Otherwise repeated discovery leaves both storage and wallet alone.
    const state = store.getState();
    const watched =
      state.channelStore_verusid?.watchedVerusIds?.[coin.id] || {};
    const needsRefresh =
      [...storageIDs].some(
        identityID =>
          Object.prototype.hasOwnProperty.call(linked, identityID) ||
          Object.prototype.hasOwnProperty.call(watched, identityID),
      ) ||
      (state.coins?.activeCoinsForUser || []).some(
        activeCoin =>
          !!activeCoin.testnet === !!coin.testnet &&
          (state.coinMenus?.allSubWallets?.[activeCoin.id] || []).some(
            wallet => {
              const [channel, identityID] = (wallet.channel || '').split('.');
              return channel === VRPC && storageIDs.has(identityID);
            },
          ),
      );

    if (unclassified.length || needsRefresh) {
      await assertAuthorizationCredentialsCurrent(view, context);
      assertAuthorizationContext(context);
      for (const identityID of unclassified) {
        await markVerusIdAsStorage(
          identityID,
          knownStorage[identityID]?.name || linked[identityID] || identityID,
          coin.id,
          user.identityID,
          context,
        );
        assertAuthorizationContext(context);
      }
      if (needsRefresh) {
        await refreshLinkedIdentityWallet(coin.id, context);
        assertAuthorizationContext(context);
      }
    }
  }

  return relationships.map(binding => ({
    grantID: binding.grantID,
    relationshipIndex: binding.relationshipIndex,
    storageID: binding.storageID,
    storageSystemID: binding.storageSystemID,
    approvalUnknown: binding.approvalUnknown,
    orphaned: binding.orphaned,
    appID: binding.appID,
    appSystemID: binding.appSystemID,
    delegateID: binding.delegateID,
  }));
};

const loadStorageControl = async (binding, context) => {
  const source = authorizationSource(binding.storageSystemID, context);
  const current = await loadIdentityRevision(source, {
    identityID: binding.storageID,
    systemID: binding.storageSystemID,
  });
  assertAuthorizationContext(context);
  const walletKeys = new Set(
    walletAuthorizationKeys(
      store.getState().authentication.activeAccount,
      !!source.coin.testnet,
    ).map(key => key.keyID),
  );
  const primaryaddresses = current.identity.primaryaddresses.filter(primary => {
    try {
      return walletKeys.has(normalizeIdentityKeyID(primary));
    } catch (_) {
      // Foreign identity authorities are removable too. Retain only direct
      // signing keys actually held by this wallet.
      return false;
    }
  });
  const signingKeyIDs = [
    ...new Set(
      primaryaddresses.map(primary => normalizeIdentityKeyID(primary)),
    ),
  ];
  const threshold = current.identity.minimumsignatures;
  const controlled =
    current.status === 'active' &&
    current.blockheight > 0 &&
    (current.identity.flags & IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber()) ===
      0 &&
    Number.isSafeInteger(threshold) &&
    threshold >= SINGLE_SIGNATURE &&
    signingKeyIDs.length >= threshold;

  return {current, primaryaddresses, signingKeyIDs, controlled};
};

/** Inspect current chain state without opening keys or changing wallet links. */
export const inspectAuthorizationStorageAccess = async (binding, options) => {
  const context = captureAuthorizationContext(authorizationContext(options));
  const {current, primaryaddresses, controlled} = await loadStorageControl(
    binding,
    context,
  );
  if (!controlled) return {status: STORAGE_ACCESS_STATE.NEEDS_RECOVERY};

  for (const identityID of new Set([
    current.identity.revocationauthority,
    current.identity.recoveryauthority,
  ])) {
    const authorityControlled = await inspectIndependentIdentityControl(
      {identityID, systemID: binding.storageSystemID},
      {...context, requireAuthorityControl: true},
    );
    if (!authorityControlled)
      return {status: STORAGE_ACCESS_STATE.NEEDS_RECOVERY};
  }
  return {
    status:
      primaryaddresses.length === current.identity.primaryaddresses.length
        ? STORAGE_ACCESS_STATE.WALLET_ONLY
        : STORAGE_ACCESS_STATE.SHARED,
  };
};

const assertStorageRemovable = async (binding, context) => {
  const control = await loadStorageControl(binding, context);
  if (!control.controlled) {
    throw new Error(
      'Wallet signing keys cannot satisfy the current storage threshold. Use the identity’s revoke/recover controls to restore it.',
    );
  }
  for (const identityID of new Set([
    control.current.identity.revocationauthority,
    control.current.identity.recoveryauthority,
  ])) {
    await assertIndependentIdentityControl(
      {identityID, systemID: binding.storageSystemID},
      {...context, requireAuthorityControl: true},
    );
  }
  return control;
};

// Removing access to S invalidates every grant that depends on S. Keep portable
// maps for other storage identities, even when their grant is now orphaned.
export const removedCredentialEntries = (view, targets) => {
  const storage = new Set(targets.storage.map(storageIdentityID));
  const relationships = new Set(
    view.storageBindings
      .filter(({record}) =>
        storage.has(
          storageIdentityID({
            ...record.data,
            storageSystemID: resolveAuthorizationStorageSystem(view, record),
          }),
        ),
      )
      .map(({record}) => relationshipID(record.data)),
  );
  return [
    ...view.grants.filter(({record}) =>
      targets.grantIDs.includes(record.data.grantID),
    ),
    ...view.storageBindings.filter(({record}) =>
      relationships.has(relationshipID(record.data)),
    ),
  ];
};

/** Preserve a surviving binding's network in the same update that deletes its grant. */
export const preserveInheritedStorageSystems = (view, removedEntries) => {
  const entries = new Set(removedEntries);
  const grantIDs = new Set(
    removedEntries
      .filter(({record}) => record instanceof AuthorizationCredential)
      .map(({record}) => record.data.grantID),
  );
  const records = new Map();

  for (const entry of view.storageBindings) {
    const {record} = entry;
    if (
      entries.has(entry) ||
      record.data.storageSystemID !== undefined ||
      !grantIDs.has(record.data.grantID)
    )
      continue;

    const storageSystemID = resolveAuthorizationStorageSystem(view, record);
    if (storageSystemID === view.rootSystemID) continue;

    const replacement = new AuthorizationStorageBindingCredential({
      ...record.data,
      storageSystemID,
    });
    // Every original ciphertext copy is removed; one equivalent replacement is
    // enough to keep the relationship discoverable after the grant disappears.
    entries.add(entry);
    records.set(JSON.stringify(replacement.toPayload()), replacement);
  }

  return {entries: [...entries], records: [...records.values()]};
};

/** Apply verified ownership locally through the existing encrypted write queue. */
const linkReclaimedStorage = async (reclaimed, context, beforeLink) => {
  const chains = new Set();
  await modifyServiceStoredDataForUser(
    async data => {
      assertAuthorizationContext(context);
      await beforeLink?.(data);
      let updated = data;
      for (const {binding, current} of reclaimed) {
        const {coin} = authorizationSource(binding.storageSystemID, context);
        chains.add(coin.id);
        updated = withLinkedVerusId(
          updated,
          binding.storageID,
          current.fullyqualifiedname ||
            current.identity.name ||
            binding.storageID,
          coin.id,
          {reclaimStorage: true},
        );
      }
      return updated;
    },
    VERUSID_SERVICE_ID,
    context.sessionScope.accountHash,
    context,
  );
  assertAuthorizationContext(context);
  for (const chain of chains) {
    await refreshLinkedIdentityWallet(chain, context);
    assertAuthorizationContext(context);
  }
};

/** Verify the single saved removal transaction without submitting new work. */
export const reconcileStorageRemoval = async (job, options) => {
  const context = captureAuthorizationContext(options);
  if (job.status === AUTHORIZATION_STATUS.COMPLETE)
    return summarizeAuthorizationJob(job);
  const receipt = job.transactions?.[MANAGEMENT_RECEIPT_KEY];
  if (!receipt || !(await confirmAuthorizationTransaction(receipt, context)))
    return summarizeAuthorizationJob(job);

  const reclaimed = [];
  for (const binding of job.targets.storage) {
    const {current, primaryaddresses} = await assertStorageRemovable(
      binding,
      context,
    );
    if (primaryaddresses.length !== current.identity.primaryaddresses.length) {
      throw new Error(
        'Non-wallet signing keys are still present in the storage identity. Review current app access before finishing.',
      );
    }
    reclaimed.push({binding, current});
  }
  invalidateAuthorizationCredentials();
  for (const user of job.targets.users) {
    const view = await loadAuthorizationCredentials(user, context);
    if (removedCredentialEntries(view, job.targets).length) {
      throw new Error(
        'App approval or storage-management records are still present. Refresh their confirmed state before finishing.',
      );
    }
  }

  // Reclaim only after both halves of the confirmed transaction are verified:
  // S has wallet-only signing keys and U no longer contains its app records.
  // Use the existing queue so all links and classifications change together.
  await linkReclaimedStorage(reclaimed, context);
  // Mark completion after the wallet refresh, so an interrupted local update
  // retries this bookkeeping without signing or broadcasting another removal.
  return summarizeAuthorizationJob(
    await updateAuthorizationJob(
      job.id,
      {status: AUTHORIZATION_STATUS.COMPLETE},
      context,
    ),
  );
};

// Current portable maps and this profile's storage classification establish the
// selection. A journal can explain an old relationship, but never authorize it.
const prepareStorageRemoval = async (
  user,
  storageIDs,
  options,
  context,
  requireLocalAssociation = false,
) => {
  if (!Array.isArray(storageIDs) || !storageIDs.length)
    throw new Error('Select the storage identities to remove app access from.');
  const {coin} = authorizationSource(user.systemID, context);
  const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
  assertAuthorizationContext(context);
  const localStorage = data.storage_ids?.[coin.id] || {};
  const users = authorizationMaintenanceUsers(user, {
    ...options,
    relatedUsers: [
      ...(options?.relatedUsers || []),
      ...storageIDs.flatMap(storageID =>
        (localStorage[storageID]?.userIdentityIDs || []).map(identityID => ({
          identityID,
          systemID: user.systemID,
        })),
      ),
    ],
  });
  const views = [];
  for (const selectedUser of users) {
    views.push({
      user: selectedUser,
      view: await loadAuthorizationCredentials(selectedUser, context),
    });
  }
  const relationships = views.flatMap(({view}) =>
    readStorageRelationships(view),
  );
  const selected = relationships.filter(binding =>
    storageIDs.includes(binding.storageID),
  );
  if (selected.some(binding => binding.storageSystemID !== user.systemID)) {
    throw new Error(
      'Storage access removal requires the user and storage identities on the same network.',
    );
  }
  const storage = [...new Set(storageIDs)]
    .map(storageID => {
      const recorded = selected.some(
        binding => binding.storageID === storageID,
      );
      const locallyAssociated = localStorage[
        storageID
      ]?.userIdentityIDs?.includes(user.identityID);
      if (
        storageID === user.identityID ||
        (!recorded && !locallyAssociated) ||
        (requireLocalAssociation && !locallyAssociated)
      ) {
        throw new Error(
          'This storage identity is not associated with the selected identity in this wallet. Refresh Connected apps before trying again.',
        );
      }
      return {storageSystemID: user.systemID, storageID};
    })
    .sort((a, b) => storageIdentityID(a).localeCompare(storageIdentityID(b)));

  const retainedRevisions = [];
  if (!requireLocalAssociation) {
    for (const binding of storage) {
      if (selected.some(record => record.storageID === binding.storageID))
        continue;

      const current = await loadIdentityRevision(
        authorizationSource(binding.storageSystemID, context),
        {identityID: binding.storageID, systemID: binding.storageSystemID},
      );
      retainedRevisions.push({
        storageID: binding.storageID,
        txid: current.txid,
        vout: current.vout,
      });
    }
  }
  const selectedStorage = new Set(storage.map(storageIdentityID));
  const targets = {
    kind: STORAGE_REMOVAL_KIND,
    users,
    grantIDs: [
      ...new Set(
        relationships
          .filter(binding => selectedStorage.has(storageIdentityID(binding)))
          .map(binding => binding.grantID),
      ),
    ].sort(),
    storage,
    // With no grant IDs, the current S revision distinguishes this operation
    // from a completed removal before another app key was added to S.
    ...(retainedRevisions.length ? {retainedRevisions} : {}),
  };
  return {targets, views};
};

/** Add already reclaimed storage without creating or broadcasting a transaction. */
export const addAuthorizationStorageToWallet = async (
  user,
  {storageIDs},
  options,
) => {
  const context = captureAuthorizationContext(
    authorizationContext(options, user),
  );
  const {targets, views} = await prepareStorageRemoval(
    user,
    storageIDs,
    options,
    context,
    true,
  );
  for (const {view} of views) {
    if (removedCredentialEntries(view, targets).length) {
      throw new Error(
        'Storage-management records are still present. Remove app access to finish cleanup before adding this identity to your wallet.',
      );
    }
    await assertAuthorizationCredentialsCurrent(view, context);
  }

  const reclaimed = [];
  for (const binding of targets.storage) {
    const control = await loadStorageControl(binding, context);
    if (
      !control.controlled ||
      control.primaryaddresses.length !==
        control.current.identity.primaryaddresses.length
    ) {
      throw new Error(
        'Storage access changed. Refresh Connected apps and review its current access before adding it to your wallet.',
      );
    }
    // Prove usable keys, including the storage identity's own keys. Display
    // inspection and a saved job are insufficient to reclaim an identity.
    const current = await assertIndependentIdentityControl(
      {identityID: binding.storageID, systemID: binding.storageSystemID},
      {...context, requireAuthorityControl: true},
    );
    if (
      current.txid !== control.current.txid ||
      current.vout !== control.current.vout
    ) {
      throw new Error(
        'Storage access changed. Refresh Connected apps and review its current access before adding it to your wallet.',
      );
    }
    reclaimed.push({binding, current: control.current});
  }
  await linkReclaimedStorage(reclaimed, context, async data => {
    // The queued writer may have waited for an unlock. Recheck both the local
    // selection and the reviewed on-chain state immediately before linking.
    for (const {binding, current: reviewed} of reclaimed) {
      const source = authorizationSource(binding.storageSystemID, context);
      if (
        !data.storage_ids?.[source.coin.id]?.[
          binding.storageID
        ]?.userIdentityIDs?.includes(user.identityID)
      ) {
        throw new Error(
          'This storage identity changed in this wallet. Refresh Connected apps before trying again.',
        );
      }
      const current = await loadIdentityRevision(source, {
        identityID: binding.storageID,
        systemID: binding.storageSystemID,
      });
      if (current.txid !== reviewed.txid || current.vout !== reviewed.vout) {
        throw new Error(
          'Storage access changed. Refresh Connected apps and review its current access before adding it to your wallet.',
        );
      }
      const {status} = await inspectAuthorizationStorageAccess(
        binding,
        context,
      );
      if (status !== STORAGE_ACCESS_STATE.WALLET_ONLY) {
        throw new Error(
          'Storage ownership or recovery control changed. Refresh Connected apps and review the identity before adding it to your wallet.',
        );
      }
    }
    for (const {view} of views)
      await assertAuthorizationCredentialsCurrent(view, context);
  });
  return {pending: false};
};

/** Remove every non-wallet primary key from selected S, plus affected approvals. */
export const removeAuthorizationStorageAccess = async (
  user,
  {storageIDs},
  options,
) => {
  const context = captureAuthorizationContext(
    authorizationContext(options, user),
  );
  const {targets, views} = await prepareStorageRemoval(
    user,
    storageIDs,
    options,
    context,
  );
  const {storage} = targets;
  const created = await createAuthorizationMaintenanceJob(
    user,
    targets,
    context,
  );
  return withAuthorizationJob(created.id, context, async () => {
    let job = await getAuthorizationJob(created.id, context);
    if (job.status === AUTHORIZATION_STATUS.COMPLETE)
      return {jobId: job.id, pending: false};

    const reviewed = [];
    const updates = [];
    const signingKeyIDs = new Set();
    for (const binding of storage) {
      const control = await assertStorageRemovable(binding, context);
      reviewed.push({binding, current: control.current});
      control.signingKeyIDs.forEach(keyID => signingKeyIDs.add(keyID));
      if (
        control.primaryaddresses.length !==
        control.current.identity.primaryaddresses.length
      ) {
        updates.push({
          identityID: binding.storageID,
          reviewedRevision: control.current,
          changes: {primaryaddresses: control.primaryaddresses},
        });
      }
    }
    const signingIdentities = [];
    for (const {user: selectedUser, view} of views) {
      const {entries, records} = preserveInheritedStorageSystems(
        view,
        removedCredentialEntries(view, targets),
      );
      if (!entries.length) continue;
      const removals = buildAuthorizationRemovals(entries);
      const additions = records.length
        ? await encryptAuthorizationCredentials(selectedUser, records, context)
        : {};
      signingIdentities.push(selectedUser);
      updates.push({
        identityID: selectedUser.identityID,
        reviewedRevision: view.identity,
        contentmultimap: {
          ...additions,
          [ContentMultiMapRemoveKey.vdxfid]: removals.map(removal => ({
            [ContentMultiMapRemoveKey.vdxfid]: removal.toJson(),
          })),
        },
      });
    }
    if (!updates.length) {
      throw new Error(
        'App access has already been removed. Refresh Connected apps and choose Add to wallet.',
      );
    }
    const receipt = await submitAuthorizationIdentityUpdate(
      job.id,
      {
        ...user,
        updates,
        signingIdentities,
        signingKeyIDs: [...signingKeyIDs],
        receiptKey: MANAGEMENT_RECEIPT_KEY,
        feeType: 'removal',
        beforeSend: async () => {
          for (const {user: selectedUser, view} of views) {
            await assertIndependentIdentityControl(selectedUser, context);
            await assertAuthorizationCredentialsCurrent(view, context);
          }
          for (const {binding, current: original} of reviewed) {
            const {current} = await assertStorageRemovable(binding, context);
            if (
              current.txid !== original.txid ||
              current.vout !== original.vout
            ) {
              throw new Error(
                'Storage changed during review. Review its current signing keys before removing access.',
              );
            }
          }
        },
      },
      context,
    );
    job = await updateAuthorizationJob(
      job.id,
      {
        status: AUTHORIZATION_STATUS.WAITING_FOR_REMOVAL,
      },
      context,
    );
    const result = await reconcileStorageRemoval(job, context);
    return {
      jobId: job.id,
      txid: receipt.txid,
      pending: result.status !== AUTHORIZATION_STATUS.COMPLETE,
    };
  });
};
