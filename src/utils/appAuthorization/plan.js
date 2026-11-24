import {Buffer} from 'buffer';
import {
  IDENTITY_FLAG_TOKENIZED_CONTROL,
  R_ADDR_VERSION,
  toBase58Check,
} from 'verus-typescript-primitives';
import {
  getIdentityPrimaryKeyIDs,
  loadIdentityRevision,
  MAX_IDENTITY_PRIMARY_AUTHORITIES,
  normalizeIdentityKeyID,
} from 'verusid-ts-client';
import store from '../../store';
import {requestServiceStoredData} from '../auth/authBox';
import {VERUSID_SERVICE_ID} from '../constants/services';
import {getUpdatableIdentity} from '../api/channels/verusid/requests/updateIdentity';
import {
  withLinkedVerusId,
  withStorageVerusId,
} from '../../actions/actions/services/dispatchers/verusid/verusid';
import {modifyServiceStoredDataForUser} from '../../actions/actions/services/dispatchers/services';
import {refreshLinkedIdentityWallet} from '../identityManagement/unlinkAfterUpdate';
import {
  assertIndependentIdentityControl,
  authorizationSource,
  walletAuthorizationKeys,
  withAuthorizationReadScope,
} from './controls';
import {assertAuthorizationContext} from './jobs';
import {
  assertGiftAuthorityClosure,
  assertStorageRoles,
  giftWalletBinding,
} from './gift';
import {
  buildAuthorizationRemovals,
  loadAuthorizationCredentials,
} from './credentials';
import {
  removedCredentialEntries,
  preserveInheritedStorageSystems,
  resolveAuthorizationStorageSystem,
} from './storageManagement';
import {getExistingAuthorizationStorageBindings} from './reviewSelections';

const SINGLE_SIGNATURE = 1;
const sameRevision = (left, right) =>
  left.txid === right.txid && left.vout === right.vout;
const asAddress = keyID =>
  toBase58Check(Buffer.from(keyID, 'hex'), R_ADDR_VERSION);

/** Resolve saved storage only for the selected account, within one shared read. */
export const loadAuthorizationStorageSelection = (user, appID, context) =>
  withAuthorizationReadScope(context, async scoped => {
    const source = authorizationSource(user.systemID, scoped);
    const current = await loadIdentityRevision(source, user);
    assertAuthorizationContext(scoped);
    if (!current.identity.privateaddress) return [];

    const view = await loadAuthorizationCredentials(user, scoped);
    const bindings = getExistingAuthorizationStorageBindings(
      view,
      appID,
      user.systemID,
    );
    return Promise.all(
      bindings.map(async binding => {
        const storage = await loadIdentityRevision(source, {
          identityID: binding.storageID,
          systemID: binding.storageSystemID,
        });
        assertAuthorizationContext(scoped);
        return {
          storageIdentity: binding.storageID,
          revocationIdentity: storage.identity.revocationauthority,
          recoveryIdentity: storage.identity.recoveryauthority,
        };
      }),
    );
  });

const assertUserNotStorage = async (user, source, context) => {
  const serviceData = await requestServiceStoredData(VERUSID_SERVICE_ID);
  assertAuthorizationContext(context);
  if (serviceData.storage_ids?.[source.coin.id]?.[user.identityID]) {
    throw new Error(
      'Select a user identity, not an identity managed as app storage.',
    );
  }
};

const giftSystemForAuthorization = job => {
  if (!job.hasGift || job.giftConfirmed) return null;
  if (!job.giftDiscovery?.scanUniverseComplete) {
    throw new Error(
      'Discover the complete gift before reviewing authorization.',
    );
  }
  const systems = job.giftDiscovery.systems;
  const system = systems.find(item => item.systemId === job.systemId);
  const hasReserve = utxo =>
    Object.entries(utxo.currencyvalues || {}).some(
      ([currency, amount]) => currency !== job.systemId && Number(amount) !== 0,
    );
  if (
    !system ||
    systems.some(
      item =>
        item.systemId !== job.systemId &&
        (item.identities.length || item.utxos.length || item.currencies.length),
    ) ||
    system.utxos.some(hasReserve) ||
    system.identities.some(identity => (identity.utxos || []).some(hasReserve))
  ) {
    throw new Error(
      'App authorization supports gifts on one network with native funds only. Request a compatible gift.',
    );
  }
  // Spend the complete donor funding set in the authorization transaction.
  // Extra asset outputs must never be silently left on a donor-controlled key.
  if (
    !system.utxos.length ||
    system.utxos.some(
      utxo => !Number.isSafeInteger(utxo.satoshis) || utxo.satoshis <= 0,
    ) ||
    system.identities.some(identity => (identity.utxos || []).length)
  ) {
    throw new Error(
      'App authorization requires native gift funding outputs and no separate identity balances. Request a compatible gift.',
    );
  }
  const fundingOutpoints = new Set(
    system.utxos.map(utxo => `${utxo.txid}:${utxo.outputIndex}`),
  );
  const omittedAssets = systems.some(item =>
    (item.observedUtxos || []).some(
      utxo =>
        (Number(utxo.satoshis || 0) !== 0 ||
          Object.values(utxo.currencyvalues || {}).some(
            amount => Number(amount) !== 0,
          )) &&
        (item.systemId !== job.systemId ||
          !fundingOutpoints.has(`${utxo.txid}:${utxo.outputIndex}`)),
    ),
  );
  if (omittedAssets) {
    throw new Error(
      'App authorization cannot leave unavailable gift funds behind. Wait until every gift funding output is spendable.',
    );
  }
  return system;
};

/** Project the complete final arrangement without treating future control as current control. */
export const prepareAuthorizationPlan = async (
  job,
  selection,
  delegate,
  context,
) => {
  const {selectedIdentity, storageBindings = []} = selection;
  if (selectedIdentity.systemID !== job.systemId) {
    throw new Error('Authorization identities must be on the signing network.');
  }
  assertStorageRoles(storageBindings, selectedIdentity);
  const source = authorizationSource(job.systemId, context);
  await assertUserNotStorage(selectedIdentity, source, context);
  const giftSystem = giftSystemForAuthorization(job);
  const donated = new Set(
    (giftSystem?.identities || []).map(item => item.identityAddress),
  );
  const account = store.getState().authentication.activeAccount;
  const walletKeys = walletAuthorizationKeys(account, !!source.coin.testnet);
  const walletBinding = giftSystem
    ? giftWalletBinding(job.giftDiscovery, account)
    : null;
  const giftAddress = walletBinding?.destinationBySystem[job.systemId];
  const giftPrivateAddress =
    walletBinding?.privateAddressBySystem[job.systemId];
  const giftKey =
    giftAddress &&
    walletKeys.find(key => key.keyID === normalizeIdentityKeyID(giftAddress));
  if (giftSystem && !giftKey) {
    throw new Error(
      'The gift destination does not have a usable wallet signing key.',
    );
  }
  if (
    giftSystem &&
    normalizeIdentityKeyID(giftSystem.claimAddress) === giftKey.keyID
  ) {
    throw new Error(
      'Gift ownership must move to a wallet key unknown to the donor.',
    );
  }
  if (giftSystem) await assertGiftAuthorityClosure(job, context);

  const revisions = new Map();
  const signingIdentities = new Map();
  const checkedAuthorities = new Set();
  const signingKeyIDs = new Set();
  if (giftKey) signingKeyIDs.add(giftKey.keyID);
  const read = async identityID => {
    if (!revisions.has(identityID)) {
      const current = await loadIdentityRevision(source, {
        identityID,
        systemID: job.systemId,
      });
      assertAuthorizationContext(context);
      if (
        current.status !== 'active' ||
        current.blockheight < 1 ||
        (current.identity.flags &
          IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber()) !==
          0
      ) {
        throw new Error(
          'Authorization requires confirmed, active identities without tokenized control.',
        );
      }
      revisions.set(identityID, current);
    }
    return revisions.get(identityID);
  };
  const requireWalletIdentity = async (
    identityID,
    requireAuthorityControl = true,
  ) => {
    if (donated.has(identityID)) return;
    if (
      signingIdentities.has(identityID) &&
      (!requireAuthorityControl || checkedAuthorities.has(identityID))
    )
      return;
    const user = {identityID, systemID: job.systemId};
    const current = await assertIndependentIdentityControl(user, {
      ...context,
      requireAuthorityControl,
    });
    assertAuthorizationContext(context);
    revisions.set(identityID, current);
    signingIdentities.set(identityID, user);
    if (requireAuthorityControl) checkedAuthorities.add(identityID);
  };

  await requireWalletIdentity(selectedIdentity.identityID, false);
  const currentUser = await read(selectedIdentity.identityID);
  // Read the same current bucket used by management. A donated U cannot have
  // wallet-encrypted approvals yet; local job history is never authority here.
  const existingView =
    !donated.has(selectedIdentity.identityID) &&
    (storageBindings.length || giftSystem) &&
    currentUser.identity.privateaddress
      ? await loadAuthorizationCredentials(selectedIdentity, context)
      : null;
  if (existingView && !sameRevision(existingView.identity, currentUser)) {
    throw new Error(
      'The user identity changed while reviewing its app approvals. Review authorization again.',
    );
  }
  if (existingView && storageBindings.length) {
    const existing = getExistingAuthorizationStorageBindings(
      existingView,
      job.appId,
      job.systemId,
    );
    const expected = new Set(existing.map(binding => binding.storageID));
    if (
      expected.size &&
      (expected.size !== storageBindings.length ||
        storageBindings.some(binding => !expected.has(binding.storageID)))
    ) {
      throw new Error(
        'This app already uses shared storage with this identity. Keep the existing storage selection when adding an instance.',
      );
    }
  }
  const appKeyIDs = [
    ...getIdentityPrimaryKeyIDs(
      delegate.identity.primaryaddresses,
      delegate.identity.minimumsignatures,
    ),
  ];
  const updates = new Map();
  for (const offered of giftSystem?.identities || []) {
    const current = await read(offered.identityAddress);
    if (!sameRevision(current, offered.result)) {
      throw new Error(
        'A gifted identity changed. Discover and review the gift again.',
      );
    }
    // Old authority keys authorize this transfer. The final independent gift
    // identities use self authorities, so no retained donor dependency survives.
    for (const identityID of [
      current.identity.revocationauthority,
      current.identity.recoveryauthority,
    ]) {
      await requireWalletIdentity(identityID);
    }
    updates.set(offered.identityAddress, {
      identityID: offered.identityAddress,
      reviewedRevision: current,
      replacePrivateAddresses: true,
      changes: {
        primaryaddresses: [giftAddress],
        minimumsignatures: SINGLE_SIGNATURE,
        privateaddress: giftPrivateAddress,
        revocationauthority: offered.identityAddress,
        recoveryauthority: offered.identityAddress,
      },
    });
  }

  const preparedBindings = [];
  for (const selected of storageBindings) {
    const current = await read(selected.storageID);
    const existingKeys = [
      ...getIdentityPrimaryKeyIDs(
        current.identity.primaryaddresses,
        current.identity.minimumsignatures,
      ),
    ];
    const gifted = donated.has(selected.storageID);
    const userKey = gifted
      ? giftKey
      : walletKeys.find(
          key =>
            existingKeys.includes(key.keyID) &&
            !appKeyIDs.includes(key.keyID),
        );
    if (
      !userKey ||
      appKeyIDs.includes(userKey.keyID) ||
      (!gifted && current.identity.minimumsignatures !== SINGLE_SIGNATURE)
    ) {
      throw new Error(
        'Shared storage needs an independent wallet key and single-signature control.',
      );
    }
    for (const identityID of new Set([
      selected.revocationID,
      selected.recoveryID,
      current.identity.revocationauthority,
      current.identity.recoveryauthority,
    ]))
      await requireWalletIdentity(identityID);
    const primaryKeyIDs = [
      ...new Set([
        ...(gifted ? [] : existingKeys),
        userKey.keyID,
        ...appKeyIDs,
      ]),
    ];
    if (primaryKeyIDs.length > MAX_IDENTITY_PRIMARY_AUTHORITIES) {
      throw new Error(
        'The shared storage arrangement has too many primary authorities.',
      );
    }
    signingKeyIDs.add(userKey.keyID);
    preparedBindings.push({
      ...selected,
      appKeyIDs,
      reused: !gifted,
    });
    if (
      gifted ||
      appKeyIDs.some(key => !existingKeys.includes(key)) ||
      current.identity.revocationauthority !== selected.revocationID ||
      current.identity.recoveryauthority !== selected.recoveryID
    ) {
      updates.set(selected.storageID, {
        ...updates.get(selected.storageID),
        identityID: selected.storageID,
        reviewedRevision: current,
        changes: {
          ...updates.get(selected.storageID)?.changes,
          primaryaddresses: primaryKeyIDs.map(asAddress),
          minimumsignatures: SINGLE_SIGNATURE,
          revocationauthority: selected.revocationID,
          recoveryauthority: selected.recoveryID,
        },
      });
    }
  }
  if (!updates.has(selectedIdentity.identityID)) {
    updates.set(selectedIdentity.identityID, {
      identityID: selectedIdentity.identityID,
      reviewedRevision: currentUser,
    });
  }
  const userUpdate = updates.get(selectedIdentity.identityID);
  const projectedUser = {...currentUser.identity, ...userUpdate.changes};
  const userKeys = getIdentityPrimaryKeyIDs(
    projectedUser.primaryaddresses,
    projectedUser.minimumsignatures,
  );
  if ([...userKeys].some(key => appKeyIDs.includes(key))) {
    throw new Error(
      'The user identity must remain independent of the app signing keys.',
    );
  }

  // Existing storage can have approvals from several instances. Removing its
  // app keys also removes those records, so reserve funds for the full cleanup.
  // A newly gifted U has no wallet-encrypted approvals to read.
  let existingRemovals = [];
  let storageSystemReplacements;
  if (giftSystem && !donated.has(selectedIdentity.identityID)) {
    const view =
      existingView ||
      (await loadAuthorizationCredentials(selectedIdentity, context));
    if (!sameRevision(view.identity, currentUser)) {
      throw new Error(
        'The user identity changed while reviewing its app approvals. Review authorization again.',
      );
    }
    const storageIDs = new Set(
      preparedBindings.map(binding => binding.storageID),
    );
    const grantIDs = new Set([
      ...view.grants
        .filter(
          ({identities}) =>
            identities?.appID === job.appId &&
            identities?.delegateID === job.delegateId,
        )
        .map(({record}) => record.data.grantID),
      ...view.storageBindings
        .filter(
          ({record}) =>
            resolveAuthorizationStorageSystem(view, record) === job.systemId &&
            storageIDs.has(record.data.storageID),
        )
        .map(({record}) => record.data.grantID),
    ]);
    const removal = preserveInheritedStorageSystems(
      view,
      removedCredentialEntries(view, {
        grantIDs: [...grantIDs],
        storage: preparedBindings.map(binding => ({
          storageSystemID: job.systemId,
          storageID: binding.storageID,
        })),
      }),
    );
    existingRemovals = buildAuthorizationRemovals(removal.entries)
      .map(entry => entry.toJson());
    if (removal.records.length) {
      // Removing this approval can leave other storage behind. Reserve space
      // for qualifying those retained bindings without encrypting them now.
      storageSystemReplacements = {
        outerKey: view.outerKey,
        payloads: removal.records.map(record => record.toPayload()),
      };
    }
  }
  assertAuthorizationContext(context);
  return {
    updates: [...updates.values()],
    projectedUser,
    storageBindings: preparedBindings,
    signingIdentities: [...signingIdentities.values()],
    signingKeyIDs: [...signingKeyIDs],
    reviewedIdentities: [...revisions.values()],
    giftIdentityIDs: [...donated],
    ...(walletBinding
      ? {
          ownerWalletBinding: walletBinding.ownerWalletBinding,
          fundingUtxos: giftSystem.utxos,
          giftFunding: {
            userIdentityID: selectedIdentity.identityID,
            existingRemovals,
            ...(storageSystemReplacements ? {storageSystemReplacements} : {}),
            // Include reused storage too: removing access will still update S
            // even when this handshake does not need to change its keys.
            storageIdentities: preparedBindings.map(binding => ({
              ...revisions.get(binding.storageID).identity,
              ...updates.get(binding.storageID)?.changes,
            })),
          },
        }
      : {}),
  };
};

/** Recheck the original inputs and future authority closure after every prompt. */
export const assertAuthorizationPlanCurrent = async (job, context) => {
  const plan = job.authorizationPlan;
  const source = authorizationSource(job.systemId, context);
  if (!plan) throw new Error('The reviewed authorization plan is missing.');
  await assertUserNotStorage(job.selectedIdentity, source, context);
  if (
    plan.ownerWalletBinding &&
    JSON.stringify(plan.ownerWalletBinding) !==
      JSON.stringify(
        giftWalletBinding(
          job.giftDiscovery,
          store.getState().authentication.activeAccount,
        ).ownerWalletBinding,
      )
  )
    throw new Error(
      'The gift destination changed. Review authorization again.',
    );
  for (const reviewed of plan.reviewedIdentities) {
    const current = await loadIdentityRevision(source, {
      identityID: reviewed.identity.identityaddress,
      systemID: job.systemId,
    });
    assertAuthorizationContext(context);
    if (!sameRevision(current, reviewed)) {
      throw new Error(
        'An identity or authority changed after authorization review.',
      );
    }
  }
  if (plan.giftIdentityIDs.length)
    await assertGiftAuthorityClosure(job, context);
  for (const identityID of new Set(
    job.storageBindings.flatMap(binding => [
      binding.revocationID,
      binding.recoveryID,
    ]),
  )) {
    if (!plan.giftIdentityIDs.includes(identityID)) {
      await assertIndependentIdentityControl(
        {identityID, systemID: job.systemId},
        {...context, requireAuthorityControl: true},
      );
    }
  }
  assertAuthorizationContext(context);
};

/** Keep confirmed shared storage in app management, outside wallet identity lists. */
export const recordAuthorizationStorageIdentities = async (
  job,
  context,
  confirmedIdentities = [],
  linkedIdentities = [],
) => {
  const bindings = job.storageIdentitiesManaged
    ? []
    : job.storageBindings || [];
  if (!bindings.length && !linkedIdentities.length) return job;
  const source = authorizationSource(job.systemId, context);
  const storageIdentities = [];
  for (const binding of bindings) {
    const current =
      confirmedIdentities.find(
        identity => identity.identity.identityaddress === binding.storageID,
      ) ||
      (await loadIdentityRevision(source, {
        identityID: binding.storageID,
        systemID: job.systemId,
      }));
    assertAuthorizationContext(context);
    storageIdentities.push(current);
  }
  // Classification and linking affect the same encrypted service document.
  // Apply them together to its latest value inside the existing write queue.
  await modifyServiceStoredDataForUser(
    current => {
      assertAuthorizationContext(context);
      let updated = current;
      for (const identity of storageIdentities) {
        updated = withStorageVerusId(
          updated,
          identity.identity.identityaddress,
          identity.fullyqualifiedname,
          source.coin.id,
          job.selectedIdentity.identityID,
        );
      }
      for (const identity of linkedIdentities) {
        const identityID = identity.identity.identityaddress;
        if (
          identityID === job.selectedIdentity.identityID &&
          updated.storage_ids?.[source.coin.id]?.[identityID]
        ) {
          throw new Error(
            'The response identity is managed as app storage and cannot be linked as your user identity.',
          );
        }
        updated = withLinkedVerusId(
          updated,
          identityID,
          identity.fullyqualifiedname,
          source.coin.id,
        );
      }
      return updated;
    },
    VERUSID_SERVICE_ID,
    context.sessionScope.accountHash,
    context,
  );
  assertAuthorizationContext(context);
  // The caller persists this marker after rebuilding wallet cards. A failed
  // refresh remains retryable even though the registry writes succeeded.
  return {
    ...job,
    ...(bindings.length ? {storageIdentitiesManaged: true} : {}),
  };
};

/** A confirmed shared S is intentionally co-owned; every other gift is exclusive. */
export const reconcileAuthorizationGift = async (job, context) => {
  const plan = job.authorizationPlan;
  if (!plan?.ownerWalletBinding || job.giftConfirmed) return job;
  const confirmed = await withAuthorizationReadScope(context, async context => {
    const source = authorizationSource(job.systemId, context);
    const confirmed = [];
    for (const identityID of plan.giftIdentityIDs) {
      const expected = plan.updates.find(
        update => update.identityID === identityID,
      ).changes;
      const current = await loadIdentityRevision(source, {
        identityID,
        systemID: job.systemId,
      });
      assertAuthorizationContext(context);
      const {identity} = await getUpdatableIdentity(job.systemId, current);
      assertAuthorizationContext(context);
      const actual = identity.toJson();
      if (
        current.status !== 'active' ||
        current.blockheight < 1 ||
        actual.minimumsignatures !== expected.minimumsignatures ||
        JSON.stringify(
          [
            ...getIdentityPrimaryKeyIDs(
              actual.primaryaddresses,
              actual.minimumsignatures,
            ),
          ].sort(),
        ) !==
          JSON.stringify(
            expected.primaryaddresses
              .map(address => normalizeIdentityKeyID(address))
              .sort(),
          ) ||
        actual.revocationauthority !== expected.revocationauthority ||
        actual.recoveryauthority !== expected.recoveryauthority ||
        identity.privateAddresses.length !== SINGLE_SIGNATURE ||
        actual.privateaddress !== expected.privateaddress
      ) {
        throw new Error(
          'The confirmed gift differs from the reviewed final ownership.',
        );
      }
      const storage = job.storageBindings.find(
        binding => binding.storageID === identityID,
      );
      if (!storage) {
        await assertIndependentIdentityControl(
          {identityID, systemID: job.systemId},
          {...context, requireAuthorityControl: true},
        );
      } else {
        for (const authorityID of new Set([
          storage.revocationID,
          storage.recoveryID,
        ])) {
          await assertIndependentIdentityControl(
            {identityID: authorityID, systemID: job.systemId},
            {...context, requireAuthorityControl: true},
          );
        }
      }
      confirmed.push(current);
    }
    return confirmed;
  });
  const source = authorizationSource(job.systemId, context);
  // Do not publish any gift as acquired until the whole final arrangement is
  // verified, including hidden private addresses on every gifted identity.
  const linked = confirmed.filter(
    current =>
      !job.storageBindings.some(
        binding => binding.storageID === current.identity.identityaddress,
      ),
  );
  job = await recordAuthorizationStorageIdentities(
    job,
    context,
    confirmed,
    linked,
  );
  await refreshLinkedIdentityWallet(source.coin.id, context);
  assertAuthorizationContext(context);
  // The caller persists these markers with grant confirmation. If subsequent
  // verification fails, repeating the registry update is safe and unchanged.
  return {
    ...job,
    giftConfirmed: true,
    unresolvedGiftIdentities: [],
    ...(plan.giftIdentityIDs.includes(job.selectedIdentity.identityID)
      ? {userIdentityLinked: true}
      : {}),
  };
};
