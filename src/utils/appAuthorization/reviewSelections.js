import {
  AppAuthorizationOfferRole,
  AuthorizationCredential,
  verifyAppAuthorizationStorageManifest,
} from 'verus-typescript-primitives';

/** Reuse an app's complete portable storage arrangement for this user identity. */
export const getExistingAuthorizationStorageBindings = (
  view,
  appID,
  systemID,
) => {
  let existing = [];
  let selectedIDs;
  const checked = new Set();

  for (const {record: grant, identities} of view.grants) {
    const data = grant.data;
    const signingSystemID = grant.getSystemID(view.rootSystemID);
    if (signingSystemID !== systemID) continue;
    if (!identities) {
      throw new Error(
        'An existing app approval could not be identified. Refresh to load its identity history before selecting storage.',
      );
    }
    if (identities.appID !== appID || checked.has(data.grantID)) continue;
    checked.add(data.grantID);

    const sameGrant = view.grants.filter(
      ({record}) => record.data.grantID === data.grantID,
    );
    const payload = JSON.stringify(
      new AuthorizationCredential({...data, signingSystemID}).toPayload(),
    );
    const records = view.storageBindings
      .map(({record}) => record)
      .filter(record => record.data.grantID === data.grantID);
    if (
      sameGrant.some(
        ({record}) =>
          JSON.stringify(
            new AuthorizationCredential({
              ...record.data,
              signingSystemID: record.getSystemID(view.rootSystemID),
            }).toPayload(),
          ) !== payload,
      ) ||
      !verifyAppAuthorizationStorageManifest(grant, records, view.rootSystemID)
    ) {
      throw new Error(
        'This app’s saved storage records are incomplete or conflicting. Review its access in Connected apps before adding an instance.',
      );
    }

    const bindings = [
      ...new Map(
        view.storageBindings
          .filter(({record}) => record.data.grantID === data.grantID)
          .map(({record}) => [
            record.data.storageID,
            {
              ...record.data,
              storageSystemID: record.getSystemID(signingSystemID),
            },
          ]),
      ).values(),
    ].sort((a, b) => a.relationshipIndex - b.relationshipIndex);
    // An approval made without shared storage leaves the first selection open.
    if (!bindings.length) continue;
    if (bindings.some(binding => binding.storageSystemID !== systemID)) {
      throw new Error(
        'The app’s saved storage is on another network. Review its access in Connected apps.',
      );
    }
    const ids = JSON.stringify(
      bindings.map(binding => binding.storageID).sort(),
    );
    if (selectedIDs && selectedIDs !== ids) {
      throw new Error(
        'This identity has different storage selections for the same app. Review its instances in Connected apps before adding another.',
      );
    }
    selectedIDs = ids;
    existing = bindings;
  }

  return existing;
};

// These are review defaults, not ownership evidence. The authorization planner
// still verifies every selected identity and the signed recipient constraints.
export const getAuthorizationSelectionDefaults = (review, gift, identities) => {
  const offers = review.offers || [];
  const roleIDs = role => [
    ...new Set(
      offers
        .filter(offer => offer.role === role)
        .map(offer => offer.identityID),
    ),
  ];
  const storageIDs = roleIDs(AppAuthorizationOfferRole.STORAGE);
  const excludedAuthorities = new Set([
    review.appId,
    review.delegateId,
    ...storageIDs,
    ...identities
      .filter(
        identity => identity.systemID === review.systemId && identity.isStorage,
      )
      .map(identity => identity.identityID),
    ...(gift?.identities || [])
      .filter(
        identity =>
          identity.systemId !== review.systemId || identity.unsupportedReason,
      )
      .map(identity => identity.identityAddress),
  ]);
  const authorities = roleIDs(AppAuthorizationOfferRole.AUTHORITY);
  let userID = review.requestedUserID;

  if (!userID && authorities.length === 1) userID = authorities[0];

  if (!userID && !authorities.length) {
    // A gift can contain independent identities not listed as role offers.
    // Never infer a storage role for one of those ordinary gifted assets.
    const gifted = (gift?.identities || []).filter(
      identity =>
        identity.systemId === review.systemId &&
        !identity.unsupportedReason &&
        !excludedAuthorities.has(identity.identityAddress),
    );
    const giftedIDs = [...new Set(gifted.map(item => item.identityAddress))];

    if (giftedIDs.length === 1) userID = giftedIDs[0];
    else if (
      !giftedIDs.length &&
      (!review.hasGift ||
        review.giftConfirmed ||
        (gift && !gift.requiresPassword))
    ) {
      // Wait for discovery before considering a linked identity, so an empty
      // wallet's intended gifted U cannot lose a race to the inventory hook.
      const linked = identities.filter(
        identity =>
          identity.systemID === review.systemId &&
          !identity.isStorage &&
          !excludedAuthorities.has(identity.identityID),
      );
      const linkedIDs = [...new Set(linked.map(item => item.identityID))];
      if (linkedIDs.length === 1) userID = linkedIDs[0];
    }
  }

  return {
    user:
      userID && !excludedAuthorities.has(userID)
        ? {identityID: userID, systemID: review.systemId}
        : null,
    storageID: storageIDs.length === 1 ? storageIDs[0] : null,
    // Keep invalid/ambiguous explicit offers from silently becoming a fallback
    // to U. The role remains unset until a valid independent choice is made.
    revocationIDs: roleIDs(AppAuthorizationOfferRole.REVOCATION).map(
      identityID => (excludedAuthorities.has(identityID) ? null : identityID),
    ),
    recoveryIDs: roleIDs(AppAuthorizationOfferRole.RECOVERY).map(identityID =>
      excludedAuthorities.has(identityID) ? null : identityID,
    ),
  };
};
