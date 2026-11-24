import {Buffer} from 'buffer';
import {IdentitySignature, networks} from '@bitgo/utxo-lib';
import {
  AppAuthorizationOutcome,
  AppAuthorizationRequestDetails,
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  CompactIAddressObject,
  DataDescriptor,
  EHashTypes,
  GenericResponse,
  RecipientConstraint,
  ContentMultiMapRemoveKey,
  deriveAppAuthorizationGrantID,
  deriveAppAuthorizationStorageManifest,
  verifyAppAuthorizationStorageManifest,
} from 'verus-typescript-primitives';
import {
  assertAppDelegatorProfileSupportedV1,
  createAppAuthorizationResponse,
  getIdentityPrimaryKeyIDs,
  inspectAuthorizationSigners,
  loadIdentityRevision,
  loadIdentityRevisionAtOutpoint,
  validateAppAuthorizationRequest,
  validateAuthenticationRecipient,
  verifyAppDelegatorState,
} from 'verusid-ts-client';
import store from '../../store';
import {refreshLinkedIdentityWallet} from '../identityManagement/unlinkAfterUpdate';
import {assertExperimentalGenericRequestAllowed} from '../deeplink/experimentalDeeplinks';
import {encryptGenericResponseDetails} from '../deeplink/genericResponse/encryptGenericResponseDetails';
import {
  deliverGenericResponse,
  getGenericResponseUri,
  isRedirectResponseUri,
} from '../deeplink/genericResponse/deliverGenericResponse';
import {
  loadAuthorizationCredentials,
  encryptAuthorizationCredentials,
  encryptProjectedAuthorizationCredentials,
  invalidateAuthorizationCredentials,
  assertAuthorizationCredentialsCurrent,
  buildAuthorizationRemovals,
} from './credentials';
import {
  assertAuthorizationStorageControl,
  assertIndependentIdentityControl,
  withAuthorizationReadScope,
  authorizationSource,
  withIndependentIdentitySigningKeys,
} from './controls';
import {
  AUTHORIZATION_STATUS as STATUS,
  authorizationMaintenanceUsers,
  assertAuthorizationContext,
  captureAuthorizationContext,
  getAuthorizationJob,
  requestFromAuthorizationJob,
  summarizeAuthorizationJob,
  updateAuthorizationJob,
  withAuthorizationJob,
  createAuthorizationMaintenanceJob,
} from './jobs';
import {
  confirmAuthorizationTransaction,
  submitAuthorizationIdentityUpdate,
} from './transactions';
import {
  IDENTITY_SIGNATURE_VERSION,
  IDENTITY_SIGNATURE_HEADER_BYTES,
  IDENTITY_COMPACT_SIGNATURE_BYTES,
  GRANT_RECEIPT_KEY,
} from './constants';

// A saved signed grant may already have reached the network, even if its last
// receipt is only "prepared". Stopping locally must never claim it was revoked.
const approvalMayRemain = job =>
  !!(
    job.transactions?.[GRANT_RECEIPT_KEY] ||
    job.grantTransaction ||
    job.grantConfirmed ||
    (job.responseHex && job.outcome !== AppAuthorizationOutcome.CANCELLED)
  );

const canNotifyCancellation = job =>
  job.outcome === AppAuthorizationOutcome.CANCELLED &&
  job.status === STATUS.CANCELLED &&
  !approvalMayRemain(job) &&
  !!job.selectedIdentity?.identityID &&
  !!job.selectedIdentity?.systemID &&
  !job.cancellationResponseSent;

const assertCancellationResponseSafe = job => {
  if (
    (job.status === STATUS.CANCELLED ||
      job.outcome === AppAuthorizationOutcome.CANCELLED) &&
    approvalMayRemain(job)
  ) {
    throw new Error(
      'This request was stopped locally. An approval or signed response may already exist; manage app access separately.',
    );
  }
};

// Cancellation must remain reviewable when the request is malformed, identities
// are unavailable, or the network is offline. Inspect saved data only.
const localAuthorizationReview = (job, delegate = job.approvedDelegate) => {
  let hasResponseDestination = false;
  try {
    hasResponseDestination = !!getGenericResponseUri(
      requestFromAuthorizationJob(job).responseURIs,
    );
  } catch (_) {
    // An unreadable request must never prevent stopping the job locally.
  }
  return {
    ...summarizeAuthorizationJob(job),
    hasResponseDestination,
    appName: job.appId,
    delegateName: delegate?.fullyqualifiedname || job.delegateId,
    delegateAuthorities: delegate?.identity.primaryaddresses || [],
    delegateThreshold: delegate?.identity.minimumsignatures,
    delegateRevision: delegate && {
      txid: delegate.txid,
      vout: delegate.vout,
      blockheight: delegate.blockheight,
    },
    selectedIdentity: job.selectedIdentity,
    selectionsLocked:
      job.status === STATUS.CANCELLED ||
      job.outcome === AppAuthorizationOutcome.CANCELLED ||
      (job.approved === true && Object.keys(job.transactions || {}).length > 0),
    storageBindings: (
      job.requestedStorageBindings ||
      job.storageBindings ||
      []
    ).map(binding => ({
      storageIdentity: binding.storageID,
      revocationIdentity: binding.revocationID,
      recoveryIdentity: binding.recoveryID,
    })),
    offers: [],
    requiresSharedStorage: false,
    giftConfirmed: job.giftConfirmed === true,
    grantConfirmed: job.grantConfirmed === true,
    canNotifyCancellation: canNotifyCancellation(job),
    canRetryResponse:
      !!job.responseHex &&
      (job.status === STATUS.COMPLETE || job.cancellationResponseSent === true),
    approvalMayRemain: approvalMayRemain(job),
  };
};

const completePendingRequest = async job => {
  if (!job.pendingDeeplinkId) return;
  try {
    const {
      markPendingDeeplinkComplete,
    } = require('../deeplink/pendingDeeplinkStorage');
    await markPendingDeeplinkComplete(job.pendingDeeplinkId);
  } catch (_) {
    // The pending-request list is secondary bookkeeping. The durable
    // authorization job already owns the outcome and all recovery material.
  }
};

const checkAdmission = async (job, context) => {
  assertAuthorizationContext(context);
  const request = requestFromAuthorizationJob(job);
  assertExperimentalGenericRequestAllowed(request, store.getState());
  validateAppAuthorizationRequest(request);
  // The final RPC batch can cross the signed deadline; check it again before
  // this admission is allowed to reach transaction submission.
  context.authorizationChecks?.add(() =>
    validateAppAuthorizationRequest(request),
  );
  const source = authorizationSource(job.systemId, context);
  const signature = await source.client.getSignatureInfo(
    job.delegateId,
    request.signature.signatureAsVch.toString('base64'),
    job.systemId,
  );
  // Historical evidence and SDK verification are independent reads. Keep the
  // final current-D lookup afterward so the displayed baseline is still fresh.
  const [valid, signedDelegate, delegator] = await Promise.all([
    source.client.verifyGenericRequest(request),
    loadIdentityRevision(
      source,
      {systemID: job.systemId, identityID: job.delegateId},
      signature.height,
    ),
    assertAppDelegatorProfileSupportedV1(source, {
      systemID: job.systemId,
      identityID: job.appId,
    }),
  ]);
  assertAuthorizationContext(context);
  if (!valid) throw new Error('The authorization request is no longer valid.');
  const delegate = await loadIdentityRevision(source, {
    systemID: job.systemId,
    identityID: job.delegateId,
  });
  assertAuthorizationContext(context);
  if (delegate.blockheight < 1)
    throw new Error('Wait for the delegate identity to confirm.');
  // Bind the exact revision shown and recorded by this wallet to the same
  // request signatures; D may change during the SDK's asynchronous reads.
  if (!inspectAuthorizationSigners(request, signedDelegate, delegate).valid) {
    throw new Error(
      'The request signatures do not authorize the reviewed delegate revision.',
    );
  }
  return {request, source, delegate, delegator};
};

const sameRevision = (a, b) =>
  typeof a?.txid === 'string' &&
  Number.isSafeInteger(a.vout) &&
  a.txid === b?.txid &&
  a.vout === b?.vout;

// Reuse the current revision when possible. After an app update, resolve the
// saved outpoint again so a reorganization cannot leave an unusable grant.
const assertApprovedDelegatorCurrent = async (job, current, context) => {
  const approved = job.approvedDelegator;
  const original = sameRevision(approved, current)
    ? current
    : await loadIdentityRevisionAtOutpoint(
        authorizationSource(job.systemId, context),
        {systemID: job.systemId, identityID: job.appId},
        {txid: approved.txid, vout: approved.vout},
      );

  if (!verifyAppDelegatorState(original, current)) {
    throw new Error(
      'The app signing authority changed. Request a new authorization.',
    );
  }
};

const normalizedBindings = bindings =>
  (bindings || []).map(binding => ({
    storageID: binding.storageIdentity,
    revocationID: binding.revocationIdentity,
    recoveryID: binding.recoveryIdentity,
  }));

const managementRecords = job =>
  (job.storageBindings || []).map(
    (binding, relationshipIndex) =>
      new AuthorizationStorageBindingCredential({
        version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
        grantID: job.grantID,
        relationshipIndex,
        // Setup is on the grant's system, so each binding inherits it.
        storageID: binding.storageID,
      }),
  );

const authorizationGrant = (job, records, rootSystemID) =>
  new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: records.length
      ? AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS
      : AuthorizationCredential.FLAGS_NONE,
    grantID: job.grantID,
    ...(job.systemId !== rootSystemID ? {signingSystemID: job.systemId} : {}),
    delegateRevision: {
      txid: job.approvedDelegate.txid,
      vout: job.approvedDelegate.vout,
    },
    delegatorRevision: {
      txid: job.approvedDelegator.txid,
      vout: job.approvedDelegator.vout,
    },
    ...(records.length
      ? {
          storageManifestHash: deriveAppAuthorizationStorageManifest(
            records,
            job.systemId,
          ),
        }
      : {}),
  });

// A request may gift other assets while U is an existing identity. Require the
// complete authority graph only when the selected response identity was donated.
const responseIdentityControlContext = (job, user, context) => ({
  ...context,
  requireAuthorityControl:
    job.giftDiscovery?.systems.some(
      system =>
        system.systemId === user.systemID &&
        system.identities.some(
          identity => identity.identityAddress === user.identityID,
        ),
    ) === true,
});

const checkSetup = async (job, context) => {
  const user = await assertIndependentIdentityControl(
    job.selectedIdentity,
    responseIdentityControlContext(job, job.selectedIdentity, context),
  );
  const request = requestFromAuthorizationJob(job);
  validateAuthenticationRecipient(request.details[0].data, {
    ...job.selectedIdentity,
    parentID: user.identity.parent,
  });
  const records = managementRecords(job);
  if (records.length) {
    const appKeyIDs = [
      ...getIdentityPrimaryKeyIDs(
        job.approvedDelegate.identity.primaryaddresses,
        job.approvedDelegate.identity.minimumsignatures,
      ),
    ];
    for (const record of records) {
      await assertAuthorizationStorageControl(
        record,
        appKeyIDs,
        context,
        job.systemId,
      );
    }
  }
  assertAuthorizationContext(context);
  return user;
};

const assertReviewedGrantCanSubmit = (jobId, context) =>
  withAuthorizationReadScope(context, async context => {
    const job = await getAuthorizationJob(jobId, context);
    if (
      job.outcome != null ||
      job.status === STATUS.CANCELLED ||
      job.responseHex
    ) {
      throw new Error(
        'This authorization has already stopped or reached its outcome.',
      );
    }
    const {assertAuthorizationPlanCurrent} = require('./plan');
    await assertAuthorizationPlanCurrent(job, context);
    const admitted = await checkAdmission(job, context);
    if (!sameRevision(admitted.delegate, job.approvedDelegate)) {
      throw new Error(
        'The delegate authority changed. Review again before submitting.',
      );
    }
    // Content-only app updates need no new consent. The immutable approved
    // signing policy must still be permitted by the app's current identity.
    await assertApprovedDelegatorCurrent(job, admitted.delegator, context);
  });

const resumeGrantSubmission = async (job, context) => {
  const receipt = job.transactions?.[GRANT_RECEIPT_KEY];
  if (!receipt || job.grantConfirmed || receipt.status === 'submitted') return;
  await submitAuthorizationIdentityUpdate(
    job.id,
    {
      ...job.selectedIdentity,
      receiptKey: GRANT_RECEIPT_KEY,
      beforeSend: () => assertReviewedGrantCanSubmit(job.id, context),
    },
    context,
  );
};

/** Public display data only; the retained signed request never reaches navigation. */
export const loadAuthorizationReview = (jobId, options) =>
  withAuthorizationReadScope(
    captureAuthorizationContext(options),
    async context => {
      const job = await getAuthorizationJob(jobId, context);
      let reviewedDelegate = job.approvedDelegate;
      let reviewedDelegator;
      if (job.status === STATUS.CANCELLED) return localAuthorizationReview(job);
      const request = requestFromAuthorizationJob(job);
      const {authentication, authorization, appEncryption} =
        validateAppAuthorizationRequest(request, {
          checkExpiry: false,
        });
      if (
        !job.transactions?.[GRANT_RECEIPT_KEY] &&
        job.status !== STATUS.COMPLETE &&
        job.outcome == null &&
        job.expiryTime > Math.floor(Date.now() / 1000)
      ) {
        const {delegate, delegator} = await checkAdmission(job, context);
        // The screen owns the revision it displays. Persist only the approved
        // delegate with the signed receipt, rather than writing on every view.
        reviewedDelegate = delegate;
        reviewedDelegator = delegator;
      }
      const source = authorizationSource(job.systemId, context);
      const app =
        reviewedDelegator ||
        (await loadIdentityRevision(source, {
          systemID: job.systemId,
          identityID: job.appId,
        }));
      assertAuthorizationContext(context);
      const requestedUsers = [
        ...new Set(
          (authentication.recipientConstraints || [])
            .filter(
              constraint => constraint.type === RecipientConstraint.REQUIRED_ID,
            )
            .map(constraint => constraint.identity.toIAddress()),
        ),
      ];
      return {
        ...localAuthorizationReview(job, reviewedDelegate),
        requestedUserID: requestedUsers.length === 1 ? requestedUsers[0] : null,
        appEncryption: {
          returnESK: appEncryption.returnESK(),
          hasDerivationID: appEncryption.hasDerivationID(),
        },
        appName: app.fullyqualifiedname || job.appId,
        offers: (authorization.offeredIdentities || []).map(offer => ({
          role: offer.role,
          identityID: offer.identity.toIAddress(),
        })),
        requiresSharedStorage: !authorization.flags
          .and(AppAuthorizationRequestDetails.FLAG_REQUIRES_SHARED_STORAGE)
          .isZero(),
      };
    },
  );

const submitAuthorizationPlan = async (job, selection, admitted, context) => {
  const {prepareAuthorizationPlan} = require('./plan');
  const {selectedIdentity, storageBindings} = selection;
  const plan = await withAuthorizationReadScope(context, scoped =>
    prepareAuthorizationPlan(job, selection, admitted.delegate, scoped),
  );
  validateAuthenticationRecipient(admitted.request.details[0].data, {
    ...selectedIdentity,
    parentID: plan.projectedUser.parent,
  });
  const grantID = deriveAppAuthorizationGrantID(
    selectedIdentity,
    {systemID: job.systemId, identityID: job.delegateId},
    job.appId,
    admitted.request.getRawDataSha256().toString('hex'),
  );
  const approval = {
    selectedIdentity,
    grantID,
    approved: true,
    approvedDelegate: admitted.delegate,
    approvedDelegator: admitted.delegator,
    requestedStorageBindings: storageBindings,
    storageBindings: plan.storageBindings,
  };
  // Encryption has no external side effect. Keep preparation local until fee
  // approval; the complete plan is saved with the signed transaction receipt.
  const projectedJob = {...job, ...approval};
  const records = managementRecords(projectedJob);
  const grant = authorizationGrant(
    projectedJob,
    records,
    authorizationSource(job.systemId, context).rootSystemID,
  );
  const contentmultimap = plan.giftIdentityIDs.includes(
    selectedIdentity.identityID,
  )
    ? await encryptProjectedAuthorizationCredentials(
        selectedIdentity,
        [grant, ...records],
        plan.projectedUser,
        context,
      )
    : await encryptAuthorizationCredentials(
        selectedIdentity,
        [grant, ...records],
        context,
      );
  const updates = plan.updates.map(update =>
    update.identityID === selectedIdentity.identityID
      ? {...update, contentmultimap}
      : update,
  );
  const giftSystem = job.giftDiscovery?.systems.find(
    system => system.systemId === job.systemId,
  );
  await submitAuthorizationIdentityUpdate(
    job.id,
    {
      ...selectedIdentity,
      updates,
      signingIdentities: plan.signingIdentities,
      signingKeyIDs: plan.signingKeyIDs,
      donorKeys: plan.ownerWalletBinding ? [giftSystem.claimWif] : [],
      fundingUtxos: plan.fundingUtxos,
      giftFunding: plan.giftFunding,
      sweepFunding: !!plan.ownerWalletBinding,
      receiptKey: GRANT_RECEIPT_KEY,
      jobChanges: {
        ...approval,
        authorizationPlan: {...plan, updates},
        expectedGrant: grant.toPayload(),
        unresolvedGiftIdentities: plan.giftIdentityIDs,
      },
      beforeSend: () => assertReviewedGrantCanSubmit(job.id, context),
    },
    context,
  );
  invalidateAuthorizationCredentials();
  return reconcileAuthorizationJob(job.id, context);
};

export const approveAuthorization = async (jobId, selection, options) => {
  const context = captureAuthorizationContext(options);
  return withAuthorizationJob(jobId, context, async () => {
    const job = await getAuthorizationJob(jobId, context);
    if (job.outcome != null || job.status === STATUS.CANCELLED) {
      throw new Error(
        'This authorization was cancelled or completed with another outcome. Request a new authorization before approving again.',
      );
    }
    if (
      job.transactions?.[GRANT_RECEIPT_KEY] ||
      job.status === STATUS.COMPLETE
    ) {
      await resumeGrantSubmission(job, context);
      return reconcileAuthorizationJob(jobId, context);
    }
    const {request, delegate, delegator} = await withAuthorizationReadScope(
      context,
      scoped => checkAdmission(job, scoped),
    );
    if (!sameRevision(selection.delegateRevision, delegate)) {
      throw Object.assign(
        new Error(
          'The delegate changed after review. Review its current authority before approving.',
        ),
        {code: 'AUTHORIZATION_DELEGATE_CHANGED'},
      );
    }
    const selectedIdentity = selection.selectedIdentity;
    if (!selectedIdentity?.identityID || !selectedIdentity.systemID)
      throw new Error('Select an independently controlled user identity.');
    const bindings = normalizedBindings(selection.storageBindings);
    if (
      new Set(bindings.map(binding => binding.storageID)).size !==
        bindings.length ||
      bindings.some(
        binding =>
          binding.storageID === selectedIdentity.identityID ||
          binding.storageID === binding.revocationID ||
          binding.storageID === binding.recoveryID,
      )
    ) {
      throw new Error(
        'Storage must use separate, independently controlled user, revocation and recovery identities.',
      );
    }
    const {authorization} = validateAppAuthorizationRequest(request);
    if (
      !authorization.flags
        .and(AppAuthorizationRequestDetails.FLAG_REQUIRES_SHARED_STORAGE)
        .isZero() &&
      !bindings.length
    ) {
      throw new Error(
        'This app requires at least one shared storage identity.',
      );
    }
    return submitAuthorizationPlan(
      job,
      {selectedIdentity, storageBindings: bindings},
      {request, delegate, delegator},
      context,
    );
  });
};

// Keep confirmation reads separate from wallet/job writes: the enclosing read
// phase must finish its final freshness check before any outcome is persisted.
const checkConfirmedGrant = async (job, context) => {
  const receipt = job.transactions?.[GRANT_RECEIPT_KEY];
  // Expiry constrains submission, not confirmation. A prepared receipt alone
  // does not establish a timely handoff, so also require its durable timestamp.
  if (
    !receipt?.broadcastAttempted ||
    !Number.isSafeInteger(receipt.admittedAt) ||
    receipt.admittedAt >= job.expiryTime * 1000
  ) {
    throw new Error(
      'The grant has no recorded submission before the signed deadline.',
    );
  }
  const controlledUser = await checkSetup(job, context);
  const source = authorizationSource(job.systemId, context);
  const delegator = await assertAppDelegatorProfileSupportedV1(source, {
    systemID: job.systemId,
    identityID: job.appId,
  });
  await assertApprovedDelegatorCurrent(job, delegator, context);
  const view = await loadAuthorizationCredentials(
    job.selectedIdentity,
    context,
  );
  const matchingGrants = view.records.filter(
    entry =>
      entry.record instanceof AuthorizationCredential &&
      entry.record.data.grantID === job.grantID,
  );
  if (!matchingGrants.length)
    throw new Error(
      'The confirmed authorization is absent from the effective credential view.',
    );
  const grant = matchingGrants[0];
  if (
    grant.identities?.appID !== job.appId ||
    grant.identities?.delegateID !== job.delegateId
  ) {
    throw new Error(
      'The approved identity revisions could not be verified. Refresh the authorization before notifying the app.',
    );
  }
  const original = grant.record.data.delegateRevision;
  if (!sameRevision(original, job.approvedDelegate))
    throw new Error(
      'The confirmed grant does not match the approved delegate revision.',
    );
  if (!sameRevision(grant.record.data.delegatorRevision, job.approvedDelegator))
    throw new Error(
      'The confirmed grant does not match the approved app revision.',
    );
  const management = view.records
    .filter(
      entry =>
        !(entry.record instanceof AuthorizationCredential) &&
        entry.record.data.grantID === job.grantID,
    )
    .map(entry => entry.record);
  if (
    matchingGrants.some(
      entry =>
        JSON.stringify(entry.record.toPayload()) !==
        JSON.stringify(job.expectedGrant),
    ) ||
    !verifyAppAuthorizationStorageManifest(
      grant.record,
      management,
      source.rootSystemID,
    )
  ) {
    throw new Error(
      'The confirmed authorization or storage records differ from the approved arrangement.',
    );
  }
  await assertAuthorizationCredentialsCurrent(view, context);
  return controlledUser;
};

export const reconcileAuthorizationJob = async (jobId, options) => {
  const context = captureAuthorizationContext(options);
  let job = await getAuthorizationJob(jobId, context);
  if (job.kind === 'removal') {
    if (job.targets.kind === 'storage-keys') {
      const {reconcileStorageRemoval} = require('./storageManagement');
      return reconcileStorageRemoval(job, context);
    }
    return reconcileAuthorizationRemoval(job, context);
  }
  const receipt = job.transactions?.[GRANT_RECEIPT_KEY];
  let receiptConfirmed;
  let recoveredGift = false;
  if (job.authorizationPlan && job.hasGift && !job.giftConfirmed && receipt) {
    receiptConfirmed = await confirmAuthorizationTransaction(receipt, context);
    if (receiptConfirmed) {
      // Local cancellation cannot strand donated assets already transferred in
      // the saved batch. Recovery verifies final ownership without re-submitting.
      const {reconcileAuthorizationGift} = require('./plan');
      job = await reconcileAuthorizationGift(job, context);
      recoveredGift = job.giftConfirmed === true;
    }
  }
  if (
    job.status === STATUS.CANCELLED &&
    job.authorizationPlan &&
    job.storageBindings?.length &&
    !job.storageIdentitiesManaged &&
    receipt &&
    (receiptConfirmed ??
      (await confirmAuthorizationTransaction(receipt, context)))
  ) {
    // A local stop cannot undo an accepted transaction. Classify confirmed S
    // without reactivating the request or preparing an approval response.
    await withAuthorizationReadScope(context, scoped =>
      checkSetup(job, scoped),
    );
    const {recordAuthorizationStorageIdentities} = require('./plan');
    job = await recordAuthorizationStorageIdentities(job, context);
    await refreshLinkedIdentityWallet(
      authorizationSource(job.systemId, context).coin.id,
      context,
    );
    assertAuthorizationContext(context);
    job = await updateAuthorizationJob(
      jobId,
      {storageIdentitiesManaged: true},
      context,
    );
  }
  if (
    job.status === STATUS.COMPLETE ||
    job.status === STATUS.CANCELLED ||
    job.responseHex ||
    (job.outcome != null && job.outcome !== AppAuthorizationOutcome.SUCCESS)
  ) {
    if (recoveredGift) {
      job = await updateAuthorizationJob(
        jobId,
        {
          giftConfirmed: true,
          unresolvedGiftIdentities: [],
          storageIdentitiesManaged: job.storageIdentitiesManaged === true,
          userIdentityLinked: job.userIdentityLinked === true,
        },
        context,
      );
    }
    return summarizeAuthorizationJob(job);
  }
  if (receipt) {
    if (
      !(
        receiptConfirmed ??
        (await confirmAuthorizationTransaction(receipt, context))
      )
    ) {
      if (
        job.status === STATUS.WAITING_FOR_GRANT &&
        job.grantConfirmed !== true
      )
        return summarizeAuthorizationJob(job);
      job = await updateAuthorizationJob(
        jobId,
        current => ({
          ...current,
          grantConfirmed: false,
          status:
            current.status === STATUS.CANCELLED
              ? STATUS.CANCELLED
              : STATUS.WAITING_FOR_GRANT,
        }),
        context,
      );
      return summarizeAuthorizationJob(job);
    }
    // Final response signing verifies the complete grant again. A confirmed,
    // already classified job needs no repeat linking or progress write here.
    if (
      job.grantConfirmed &&
      job.userIdentityLinked &&
      (!job.storageBindings?.length || job.storageIdentitiesManaged) &&
      job.status === STATUS.RESPONSE_READY
    )
      return summarizeAuthorizationJob(job);
    const controlledUser = await withAuthorizationReadScope(context, scoped =>
      checkConfirmedGrant(job, scoped),
    );
    const source = authorizationSource(job.systemId, context);
    const userWasLinked = job.userIdentityLinked;
    const {recordAuthorizationStorageIdentities} = require('./plan');
    const alreadyManaged = job.storageIdentitiesManaged;
    job = await recordAuthorizationStorageIdentities(
      job,
      context,
      [],
      userWasLinked
        ? []
        : [
            {
              ...controlledUser,
              identity: {
                ...controlledUser.identity,
                identityaddress: job.selectedIdentity.identityID,
              },
            },
          ],
    );
    if (!userWasLinked || (!alreadyManaged && job.storageIdentitiesManaged)) {
      await refreshLinkedIdentityWallet(source.coin.id, context);
      assertAuthorizationContext(context);
    }
    job = await updateAuthorizationJob(
      jobId,
      current => ({
        ...current,
        grantConfirmed: true,
        grantTransaction: receipt,
        ...(recoveredGift
          ? {giftConfirmed: true, unresolvedGiftIdentities: []}
          : {}),
        userIdentityLinked: true,
        storageIdentitiesManaged: job.storageIdentitiesManaged === true,
        status:
          current.status === STATUS.CANCELLED ||
          current.status === STATUS.COMPLETE
            ? current.status
            : STATUS.RESPONSE_READY,
      }),
      context,
    );
  } else if (
    job.status !== STATUS.EXPIRED &&
    job.expiryTime <= Math.floor(Date.now() / 1000)
  ) {
    job = await updateAuthorizationJob(
      jobId,
      {status: STATUS.EXPIRED},
      context,
    );
  }
  return summarizeAuthorizationJob(job);
};

export const prepareAuthorizationResponse = async (jobId, options) => {
  const context = captureAuthorizationContext(options);
  return withAuthorizationJob(jobId, context, async () => {
    let job = await getAuthorizationJob(jobId, context);
    assertCancellationResponseSafe(job);
    if (job.responseHex) return summarizeAuthorizationJob(job);
    if (job.status === STATUS.CANCELLED && !canNotifyCancellation(job)) {
      throw new Error(
        'This cancelled request has no response-signing identity.',
      );
    }
    const outcome = job.outcome ?? AppAuthorizationOutcome.SUCCESS;
    const success = outcome === AppAuthorizationOutcome.SUCCESS;
    if (success) {
      await resumeGrantSubmission(job, context);
      // A persisted confirmation is enough to enter response preparation. The
      // complete grant/storage view is refreshed again after encryption/unlock,
      // before signing; avoid loading that same view twice in one attempt.
      if (!job.grantConfirmed) await reconcileAuthorizationJob(jobId, context);
      job = await getAuthorizationJob(jobId, context);
      if (!job.grantConfirmed)
        throw new Error('Wait for the authorization transaction to confirm.');
    }
    const request = requestFromAuthorizationJob(job);
    const userContext = responseIdentityControlContext(
      job,
      job.selectedIdentity,
      context,
    );
    const user = await assertIndependentIdentityControl(
      job.selectedIdentity,
      userContext,
    );
    let appEncryptionResponse;
    if (success) {
      // A timely submitted grant may confirm after request expiry. The saved
      // receipt and final reconciliation govern completion; this structural
      // check must not start a new, independently authorized operation.
      const {appEncryption} = validateAppAuthorizationRequest(request, {
        checkExpiry: false,
      });
      const {
        deriveEncryptedAppEncryptionResponse,
        buildEncryptedAppEncryptionResponseDetail,
      } = require('../deeplink/handlers/appEncryptionRequestHandler');
      const requestHash = request.getRawDataSha256().toString('hex');
      const binding = JSON.stringify(job.selectedIdentity);
      let saved = job.appEncryptionResponse;
      if (
        saved &&
        (saved.requestHash !== requestHash || saved.user !== binding)
      ) {
        throw new Error(
          'The saved encryption channel belongs to a different authorization.',
        );
      }
      if (!saved) {
        const source = authorizationSource(job.systemId, context);
        const result = await deriveEncryptedAppEncryptionResponse({
          encryptionRequest: appEncryption,
          responseSignerID: job.selectedIdentity.identityID,
          coinObj: source.coin,
          appScopeID: job.appId,
          context: {
            ...context,
            assertActive: () => assertAuthorizationContext(context),
          },
        });
        saved = {
          requestHash,
          user: binding,
          descriptor: result.encryptedDescriptorJson,
        };
        // Nothing has left the wallet yet. Persist the encrypted channel and
        // signed response together after the final authorization checks.
        job = {...job, appEncryptionResponse: saved};
      }
      appEncryptionResponse = buildEncryptedAppEncryptionResponseDetail(
        appEncryption,
        DataDescriptor.fromJson(saved.descriptor),
      );
    }
    let response = createAppAuthorizationResponse(request, {
      user: {...job.selectedIdentity, parentID: user.identity.parent},
      outcome,
      ...(success ? {appEncryptionResponse} : {}),
      ...(success && job.storageBindings?.length
        ? {
            // Jobs retain address strings; the response codec requires compact
            // identity objects for every storage and authority binding.
            storageBindings: job.storageBindings.map(binding => ({
              storageIdentity: CompactIAddressObject.fromAddress(
                binding.storageID,
              ),
              revocationIdentity: CompactIAddressObject.fromAddress(
                binding.revocationID,
              ),
              recoveryIdentity: CompactIAddressObject.fromAddress(
                binding.recoveryID,
              ),
            })),
          }
        : {}),
    });
    response = await encryptGenericResponseDetails({request, response});
    // Collect keys only within this call, then verify all current prerequisites
    // once more after the last possible unlock dialog before signing.
    const keys = [];
    let grantUnconfirmed = false;
    try {
      const {height} = await withAuthorizationReadScope(
        context,
        async context => {
          const finalUserContext = responseIdentityControlContext(
            job,
            job.selectedIdentity,
            context,
          );
          const signingUser = await withIndependentIdentitySigningKeys(
            job.selectedIdentity,
            finalUserContext,
            key => keys.push(key),
          );
          if (success) {
            const currentJob = await getAuthorizationJob(jobId, context);
            if (
              currentJob.status === STATUS.CANCELLED ||
              (currentJob.outcome != null &&
                currentJob.outcome !== AppAuthorizationOutcome.SUCCESS)
            ) {
              throw new Error('This authorization was cancelled.');
            }
            grantUnconfirmed = !(await confirmAuthorizationTransaction(
              currentJob.transactions?.[GRANT_RECEIPT_KEY],
              context,
            ));
            if (grantUnconfirmed) {
              throw new Error(
                'Wait for the authorization transaction to confirm.',
              );
            }
            await checkConfirmedGrant(currentJob, context);
          }
          const source = authorizationSource(
            job.selectedIdentity.systemID,
            context,
          );
          const height = await source.client.getCurrentHeight();
          assertAuthorizationContext(context);
          const currentUser = await assertIndependentIdentityControl(
            job.selectedIdentity,
            finalUserContext,
          );
          if (!sameRevision(signingUser, currentUser)) {
            throw new Error(
              'Your response-signing identity changed. Review its current authority before preparing the response.',
            );
          }
          return {height};
        },
      );
      response.setSigned();
      const hash = response.getDetailsIdentitySignatureHash(height);
      const signature = new IdentitySignature(
        networks.verus,
        IDENTITY_SIGNATURE_VERSION,
        EHashTypes.HASH_SHA256,
        height,
        [],
        job.selectedIdentity.systemID,
        job.selectedIdentity.identityID,
      );
      keys.forEach(key => signature.signHashOffline(hash, key));
      const bytes = Buffer.alloc(
        IDENTITY_SIGNATURE_HEADER_BYTES +
          IDENTITY_COMPACT_SIGNATURE_BYTES * signature.signatures.length,
      );
      signature.toBuffer(bytes);
      response.signature.signatureAsVch = bytes;
      job = await updateAuthorizationJob(
        jobId,
        {
          ...(success
            ? {appEncryptionResponse: job.appEncryptionResponse}
            : {}),
          responseHex: response.toBuffer().toString('hex'),
          status:
            outcome === AppAuthorizationOutcome.CANCELLED
              ? STATUS.CANCELLED
              : STATUS.RESPONSE_READY,
        },
        context,
      );
      return summarizeAuthorizationJob(job);
    } catch (error) {
      if (grantUnconfirmed) {
        // Persist a lost confirmation only after leaving the read phase. A
        // failed final check must never publish a successful authorization.
        await updateAuthorizationJob(
          jobId,
          current => ({
            ...current,
            grantConfirmed: false,
            status:
              current.status === STATUS.CANCELLED ||
              current.status === STATUS.COMPLETE
                ? current.status
                : STATUS.WAITING_FOR_GRANT,
          }),
          context,
        );
      }
      throw error;
    } finally {
      keys.length = 0;
    }
  });
};

/** Stop locally first; notifying the app is a separate, optional operation. */
export const cancelAuthorization = async (jobId, selectedIdentity, options) => {
  const context = captureAuthorizationContext(options);
  return withAuthorizationJob(jobId, context, async () => {
    const job = await getAuthorizationJob(jobId, context);
    const committed = approvalMayRemain(job);
    const saved = await updateAuthorizationJob(
      jobId,
      {
        // Frozen bytes and receipts remain associated with their original user.
        selectedIdentity:
          committed || job.responseHex
            ? job.selectedIdentity
            : selectedIdentity || job.selectedIdentity,
        outcome: committed
          ? job.outcome ?? AppAuthorizationOutcome.SUCCESS
          : AppAuthorizationOutcome.CANCELLED,
        status: STATUS.CANCELLED,
        cancellationResponseSent: job.cancellationResponseSent === true,
      },
      context,
    );
    await completePendingRequest(saved);
    return localAuthorizationReview(saved);
  });
};

const preparedResponseFromJob = job => {
  assertCancellationResponseSafe(job);
  if (!job.responseHex)
    throw new Error('Prepare the authorization response first.');
  if (!/^(?:[0-9a-f]{2})+$/i.test(job.responseHex))
    throw new Error('The saved response is invalid.');
  const response = new GenericResponse();
  const bytes = Buffer.from(job.responseHex, 'hex');
  if (
    response.fromBuffer(bytes) !== bytes.length ||
    !response.toBuffer().equals(bytes)
  ) {
    throw new Error('The saved response is invalid.');
  }
  return response;
};

/** Explicit local export; frozen response bytes never enter job summaries or Redux. */
export const loadPreparedAuthorizationResponse = async (jobId, options) => {
  const context = captureAuthorizationContext(options);
  const job = await getAuthorizationJob(jobId, context);
  const response = preparedResponseFromJob(job);
  assertAuthorizationContext(context);
  return response;
};

export const deliverAuthorizationResponse = async (jobId, options) => {
  const context = captureAuthorizationContext(options);
  await prepareAuthorizationResponse(jobId, context);
  return withAuthorizationJob(jobId, context, async () => {
    const job = await getAuthorizationJob(jobId, context);
    // Cancellation can occur after preparation releases its lock. Check again
    // before delivering frozen bytes or changing the durable completion state.
    const response = preparedResponseFromJob(job);
    const request = requestFromAuthorizationJob(job);
    const redirects = isRedirectResponseUri(
      getGenericResponseUri(request.responseURIs),
    );
    const complete = async () => {
      const completed = await updateAuthorizationJob(
        jobId,
        job.outcome === AppAuthorizationOutcome.CANCELLED
          ? {status: STATUS.CANCELLED, cancellationResponseSent: true}
          : {status: STATUS.COMPLETE},
        context,
      );
      await completePendingRequest(completed);
      return completed;
    };
    // Opening another app can suspend JavaScript immediately. Finish local
    // bookkeeping first for redirects; the frozen response remains available
    // for an explicit retry if the process stops before the handoff.
    let completed = redirects ? await complete() : null;
    try {
      await deliverGenericResponse(request, response);
    } catch (error) {
      if (redirects) {
        await updateAuthorizationJob(
          jobId,
          {
            status: job.status,
            cancellationResponseSent: job.cancellationResponseSent === true,
          },
          context,
        );
      }
      throw error;
    }
    assertAuthorizationContext(context);
    // A POST completes only after acknowledgement. Without a destination, the
    // caller has explicitly copied/exported the frozen response before here.
    if (!completed) completed = await complete();
    return summarizeAuthorizationJob(completed);
  });
};

const REMOVAL_RECEIPT_KEY = 'remove-grants';

const reconcileAuthorizationRemoval = async (job, context) => {
  const receipt = job.transactions?.[REMOVAL_RECEIPT_KEY];
  if (!receipt || !(await confirmAuthorizationTransaction(receipt, context)))
    return summarizeAuthorizationJob(job);
  invalidateAuthorizationCredentials();
  await withAuthorizationReadScope(context, async scoped => {
    for (const user of job.targets.users) {
      const view = await loadAuthorizationCredentials(user, scoped);
      if (
        view.grants.some(entry =>
          job.targets.grantIDs.includes(entry.record.data.grantID),
        )
      ) {
        throw new Error(
          'App approval is still present. Refresh its effective records before continuing.',
        );
      }
    }
  });
  return summarizeAuthorizationJob(
    await updateAuthorizationJob(job.id, {status: STATUS.COMPLETE}, context),
  );
};

/** Remove every effective copy for an instance, retaining portable cleanup records. */
export const revokeAuthorization = async (user, appID, delegateID, options) => {
  const {preserveInheritedStorageSystems} = require('./storageManagement');
  const context = captureAuthorizationContext(options);
  const views = [];
  for (const selectedUser of authorizationMaintenanceUsers(user, options)) {
    const view = await loadAuthorizationCredentials(selectedUser, context);
    const grants = view.grants.filter(
      entry =>
        entry.identities?.appID === appID &&
        entry.identities?.delegateID === delegateID,
    );
    if (grants.length) views.push({user: selectedUser, view, grants});
  }
  const grants = views.flatMap(view => view.grants);
  if (!grants.length) return {pending: false};
  const grantIDs = [
    ...new Set(grants.map(entry => entry.record.data.grantID)),
  ].sort();
  const targets = {
    appID,
    delegateID,
    users: views.map(view => view.user),
    grantIDs,
    values: grants
      .map(
        entry =>
          `${entry.source.outerKey}:${entry.source.storedValue.toString(
            'hex',
          )}`,
      )
      .sort(),
  };
  const job = await createAuthorizationMaintenanceJob(user, targets, context);
  return withAuthorizationJob(job.id, context, async () => {
    const updates = [];
    for (const {user: selectedUser, view, grants} of views) {
      // Retained storage must still resolve to the same chain after its grant
      // is removed. Qualify inherited nonroot systems in this same update.
      const {entries, records} = preserveInheritedStorageSystems(view, grants);
      const additions = records.length
        ? await encryptAuthorizationCredentials(selectedUser, records, context)
        : {};
      updates.push({
        identityID: selectedUser.identityID,
        reviewedRevision: view.identity,
        contentmultimap: {
          ...additions,
          [ContentMultiMapRemoveKey.vdxfid]: buildAuthorizationRemovals(
            entries,
          ).map(removal => ({
            [ContentMultiMapRemoveKey.vdxfid]: removal.toJson(),
          })),
        },
      });
    }
    const receipt = await submitAuthorizationIdentityUpdate(
      job.id,
      {
        ...user,
        updates,
        signingIdentities: views.map(view => view.user),
        receiptKey: REMOVAL_RECEIPT_KEY,
        feeType: 'removal',
        beforeSend: async () => {
          for (const {user: selectedUser, view} of views) {
            await assertIndependentIdentityControl(selectedUser, context);
            await assertAuthorizationCredentialsCurrent(view, context);
          }
        },
      },
      context,
    );
    invalidateAuthorizationCredentials();
    const saved = await updateAuthorizationJob(
      job.id,
      {status: STATUS.WAITING_FOR_REMOVAL},
      context,
    );
    const result = await reconcileAuthorizationRemoval(saved, context);
    return {
      txid: receipt.txid,
      jobId: job.id,
      pending: result.status !== STATUS.COMPLETE,
    };
  });
};
