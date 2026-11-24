import {SpendableKeyDetailsOrdinalVDXFObject} from 'verus-typescript-primitives';
import {
  loadIdentityRevision,
  validateAppAuthorizationRequest,
} from 'verusid-ts-client';
import store from '../../store';
import {DLIGHT_PRIVATE, VRPC} from '../constants/intervalConstants';
import {
  discoverSpendableKeyClaims,
  spendableKeyDetailsOrdinalToMnemonic,
  spendableKeyDetailsRequiresPassword,
} from '../spendableKey/spendableKey';
import {assertSignedRequestAuthorization} from '../deeplink/validator/appEncryptionAuthorization';
import {
  AUTHORIZATION_STATUS,
  assertAuthorizationContext,
  captureAuthorizationContext,
  getAuthorizationJob,
  requestFromAuthorizationJob,
  updateAuthorizationJob,
} from './jobs';
import {
  assertIndependentIdentityControl,
  authorizationSource,
} from './controls';

const assertCanSubmit = (job, context) => {
  assertAuthorizationContext(context);
  if (job.outcome != null || job.responseHex || job.transactions?.grant) {
    throw new Error(
      'This authorization has already reached its outcome. Its saved transaction can still be reconciled.',
    );
  }
  validateAppAuthorizationRequest(requestFromAuthorizationJob(job));
};

// The discovery plan contains donor keys. Only this explicit summary is allowed
// to leave encrypted job storage for a screen, notification or navigation route.
const summarizeGift = (plan, requiresPassword = false) => ({
  requiresPassword,
  hasClaims: plan?.hasClaims === true,
  identities: (plan?.systems || []).flatMap(system =>
    system.identities.map(identity => ({
      identityAddress: identity.identityAddress,
      fullyQualifiedName: identity.fullyQualifiedName,
      systemId: system.systemId,
      unsupportedReason: identity.unsupportedReason,
    })),
  ),
  currencies: (plan?.systems || []).flatMap(system =>
    system.currencies.map(currency => ({
      currencyId: currency.currencyId,
      name: currency.display?.name || currency.currencyId,
      amount: currency.amount,
      systemId: system.systemId,
    })),
  ),
});

/** Discover the entire gift, including ordinary assets not listed as offers. */
export const loadAuthorizationGift = async (
  jobId,
  {password} = {},
  options,
) => {
  const context = captureAuthorizationContext(options);
  const job = await getAuthorizationJob(jobId, context);
  if (!job.hasGift) return summarizeGift(null);
  if (job.giftDiscovery) return summarizeGift(job.giftDiscovery);

  assertCanSubmit(job, context);
  const request = requestFromAuthorizationJob(job);
  await assertSignedRequestAuthorization(request, context);
  assertAuthorizationContext(context);
  const {authorization} = validateAppAuthorizationRequest(request);
  const ordinal = new SpendableKeyDetailsOrdinalVDXFObject({
    data: authorization.gift,
  });
  const requiresPassword = spendableKeyDetailsRequiresPassword(ordinal);
  if (requiresPassword && !password) return summarizeGift(null, true);

  const mnemonic = spendableKeyDetailsOrdinalToMnemonic({
    spendableKeyOrdinal: ordinal,
    password,
  });
  const plan = await discoverSpendableKeyClaims({
    mnemonic,
    requestIsTestnet: request.isTestnet(),
    activeCoinsForUser: store.getState().coins.activeCoinsForUser,
    includeKnownSystems: true,
  });
  assertAuthorizationContext(context);

  if (!plan.scanUniverseComplete) {
    throw new Error(
      'The complete gift could not be checked. Retry when all supported identity networks are available.',
    );
  }
  if (
    plan.systems.some(
      system => system.systemId !== job.systemId && system.identities.length,
    )
  ) {
    throw new Error(
      'Every gifted identity must be on the authorization request’s signing network.',
    );
  }
  if (
    plan.systems.some(system =>
      system.identities.some(identity => identity.unsupportedReason),
    )
  ) {
    throw new Error(
      'One or more gifted identities cannot be transferred safely. No claim has been submitted.',
    );
  }

  // Empty scanned systems are evidence of discovery, not wallets the user must
  // fund or configure. Retain unavailable balances too, so authorization
  // can refuse a partial gift rather than silently leave donor assets behind.
  plan.systems = plan.systems.filter(
    system =>
      system.identities.length ||
      system.utxos.length ||
      (system.observedUtxos || []).some(
        utxo =>
          Number(utxo.satoshis || 0) !== 0 ||
          Object.values(utxo.currencyvalues || {}).some(
            amount => Number(amount) !== 0,
          ),
      ),
  );

  await updateAuthorizationJob(
    jobId,
    previous => ({
      ...previous,
      giftDiscovery: plan,
      status: AUTHORIZATION_STATUS.GIFT_REVIEW,
    }),
    context,
  );
  return summarizeGift(plan);
};

/**
 * Acquire all donated controllers together. Repointing only a primary address
 * is unsafe if the donor still owns an external revocation/recovery identity.
 * A dependency already owned by this profile can remain in place.
 */
export const assertGiftAuthorityClosure = async (job, context) => {
  const identities = job.giftDiscovery.systems.flatMap(
    system => system.identities,
  );
  const donated = new Set(identities.map(identity => identity.identityAddress));
  const checked = new Set();
  const source = authorizationSource(job.systemId, context);

  for (const offered of identities) {
    const current = await loadIdentityRevision(source, {
      identityID: offered.identityAddress,
      systemID: job.systemId,
    });
    assertAuthorizationContext(context);
    if (
      current.status !== 'active' ||
      current.blockheight < 1 ||
      current.txid !== offered.result.txid ||
      current.vout !== offered.result.vout
    ) {
      throw new Error(
        'A gifted identity changed. Review the gift again before claiming.',
      );
    }
    for (const authority of [
      current.identity.revocationauthority,
      current.identity.recoveryauthority,
    ]) {
      if (donated.has(authority) || checked.has(authority)) continue;
      await assertIndependentIdentityControl(
        {identityID: authority, systemID: job.systemId},
        {...context, requireAuthorityControl: true},
      );
      assertAuthorizationContext(context);
      checked.add(authority);
    }
  }
};

export const giftWalletBinding = (plan, account) => {
  const destinationBySystem = {};
  const privateAddressBySystem = {};
  const ownerWalletBinding = {};

  for (const system of plan.systems) {
    const keys = account.keys?.[system.coinObj.id];
    const destinationAddress = keys?.[VRPC]?.addresses?.[0];
    const privateAddress = keys?.[DLIGHT_PRIVATE]?.addresses?.[0];
    if (!destinationAddress) {
      throw new Error(
        `Set up this profile’s ${
          system.coinObj.display_ticker || system.coinObj.id
        } wallet before claiming the gift.`,
      );
    }
    if (system.identities.length && !privateAddress) {
      throw new Error(
        'Set up this profile’s private wallet before claiming identities. The donor’s seed cannot become your permanent wallet.',
      );
    }
    destinationBySystem[system.systemId] = destinationAddress;
    if (privateAddress)
      privateAddressBySystem[system.systemId] = privateAddress;
    ownerWalletBinding[system.systemId] = {
      coinId: system.coinObj.id,
      destinationAddress,
      ...(privateAddress ? {privateAddress} : {}),
    };
  }
  return {destinationBySystem, privateAddressBySystem, ownerWalletBinding};
};

export const assertStorageRoles = (storageBindings, selectedIdentity) => {
  const seen = new Set();
  for (const binding of storageBindings) {
    if (
      seen.has(binding.storageID) ||
      binding.storageID === selectedIdentity.identityID ||
      binding.storageID === binding.revocationID ||
      binding.storageID === binding.recoveryID
    ) {
      throw new Error(
        'Each storage identity must be distinct from the independent user and recovery authorities.',
      );
    }
    seen.add(binding.storageID);
  }
  for (const binding of storageBindings) {
    if (seen.has(binding.revocationID) || seen.has(binding.recoveryID)) {
      throw new Error(
        'A shared storage identity cannot be an independent authority for another storage identity.',
      );
    }
  }
};
