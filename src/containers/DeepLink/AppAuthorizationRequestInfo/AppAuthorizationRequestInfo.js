import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CommonActions, useIsFocused} from '@react-navigation/native';
import {Alert, AppState, StyleSheet, View} from 'react-native';
import {
  ActivityIndicator,
  List,
  Portal,
  Text,
  TextInput,
} from 'react-native-paper';
import {useDispatch, useSelector} from 'react-redux';
import {AppAuthorizationOfferRole} from 'verus-typescript-primitives';
import Button from '../../../components/Button';
import RequestSigner from '../../../components/RequestSigner';
import ListSelectionModal from '../../../components/ListSelectionModal/ListSelectionModal';
import Colors from '../../../globals/colors';
import reviewStyles from '../../../styles/deeplink/identityContentReview.styles';
import {
  RegistrationPage as AuthorizationPage,
  Disclosure,
  DetailRow,
  AmountRows,
} from '../../Services/ServiceComponents/VerusIdService/IdentityRegistration/RegistrationComponents';
import store from '../../../store';
import {useAuthorizationIdentities} from '../../../hooks/useAuthorizationIdentities';
import {convertFqnToDisplayFormat} from '../../../utils/fullyqualifiedname';
import {getAppEncryptionSessionKey} from '../../../utils/deeplink/appEncryptionSession';
import {setConfigSection} from '../../../actions/actionCreators';
import {CoinDirectory} from '../../../utils/CoinData/CoinDirectory';
import {DLIGHT_PRIVATE} from '../../../utils/constants/intervalConstants';
import {copyToClipboard} from '../../../utils/clipboard/clipboard';
import {
  isExperimentalGenericRequestsEnabled,
  EXPERIMENTAL_DEEPLINK_DISABLED_MESSAGE,
} from '../../../utils/deeplink/experimentalDeeplinks';
import {
  AUTHORIZATION_STATUS,
  assertAuthorizationContext,
  captureAuthorizationContext,
} from '../../../utils/appAuthorization/jobs';
import {
  approveAuthorization,
  cancelAuthorization,
  deliverAuthorizationResponse,
  loadAuthorizationReview,
  loadPreparedAuthorizationResponse,
  prepareAuthorizationResponse,
  reconcileAuthorizationJob,
} from '../../../utils/appAuthorization/workflow';
import {loadAuthorizationGift} from '../../../utils/appAuthorization/gift';
import {getAuthorizationSelectionDefaults} from '../../../utils/appAuthorization/reviewSelections';
import {loadAuthorizationStorageSelection} from '../../../utils/appAuthorization/plan';

const ROLE_NAMES = {
  [AppAuthorizationOfferRole.STORAGE]: 'Shared storage',
  [AppAuthorizationOfferRole.AUTHORITY]: 'Independent authority',
  [AppAuthorizationOfferRole.REVOCATION]: 'Revocation authority',
  [AppAuthorizationOfferRole.RECOVERY]: 'Recovery authority',
};

const MINIMUM_TOUCH_TARGET_SIZE = 44;
const AUTHORIZATION_STEP_COUNT = 3;
const PROGRESS_REFRESH_INTERVAL_MS = 20000;
const STORAGE_IDENTITY_FIELDS = [
  ['storageIdentity', 'Storage identity'],
  ['revocationIdentity', 'Revocation authority'],
  ['recoveryIdentity', 'Recovery authority'],
];

const STATUS_LABELS = {
  [AUTHORIZATION_STATUS.RECEIVED]: 'Review authorization',
  [AUTHORIZATION_STATUS.GIFT_REVIEW]: 'Review the app gift',
  [AUTHORIZATION_STATUS.READY]: 'Ready to authorize',
  [AUTHORIZATION_STATUS.WAITING_FOR_GRANT]:
    'Waiting for authorization confirmation',
  [AUTHORIZATION_STATUS.RESPONSE_READY]: 'Ready to notify the app',
  [AUTHORIZATION_STATUS.COMPLETE]: 'Request completed',
  [AUTHORIZATION_STATUS.CANCELLED]: 'Authorization cancelled',
  [AUTHORIZATION_STATUS.EXPIRED]: 'Authorization expired',
};

const FINAL_STAGES = new Set([
  AUTHORIZATION_STATUS.WAITING_FOR_GRANT,
  AUTHORIZATION_STATUS.RESPONSE_READY,
  AUTHORIZATION_STATUS.COMPLETE,
]);

const CONFIRMATION_STAGES = new Set([AUTHORIZATION_STATUS.WAITING_FOR_GRANT]);

export default function AppAuthorizationRequestInfo({route, navigation}) {
  const {jobId} = route.params;
  const sessionKey = useSelector(state =>
    getAppEncryptionSessionKey(state, null),
  );
  const publishedStatus = useSelector(state => {
    const job = state.channelStore_verusid?.authorizationJobs?.[jobId];
    return job?.accountHash === state.authentication.activeAccount?.accountHash
      ? job?.status
      : undefined;
  });
  const focused = useIsFocused();
  const enabled = useSelector(isExperimentalGenericRequestsEnabled);
  const account = useSelector(state => state.authentication.activeAccount);
  const dispatch = useDispatch();
  const mounted = useRef(true);
  const running = useRef(null);
  const viewContext = useRef(null);
  const feeConsent = useRef(null);
  const selectionContext = useRef(null);
  const userEdited = useRef(false);
  const storageEdits = useRef({structure: false, fields: []});
  const observedStatus = useRef(null);
  const [feeReview, setFeeReview] = useState(null);
  const [submittingFee, setSubmittingFee] = useState(null);
  const [activity, setActivity] = useState(null);
  const [responseCopied, setResponseCopied] = useState(false);
  // Local cancellation still belongs to the same profile/session, but must not
  // depend on request policy or the experimental setting remaining enabled.
  const localContext = useMemo(
    () =>
      captureAuthorizationContext({
        assertActive: () => {
          if (!mounted.current || viewContext.current !== localContext)
            throw Object.assign(new Error('Authorization screen closed.'), {
              code: 'SESSION_CHANGED',
            });
        },
      }),
    [jobId, sessionKey],
  );
  viewContext.current = localContext;
  const context = useMemo(
    () => ({
      ...localContext,
      assertActive: () => {
        localContext.assertActive();
        if (!isExperimentalGenericRequestsEnabled(store.getState())) {
          throw new Error(EXPERIMENTAL_DEEPLINK_DISABLED_MESSAGE);
        }
      },
      // The workflow supplies only verified public fee amounts. It keeps the
      // prepared transaction and keys local until this explicit review finishes.
      confirmFees: details => {
        assertAuthorizationContext(context);
        return new Promise(resolve => {
          feeConsent.current = {context, details, resolve};
          setSubmittingFee(null);
          setFeeReview(details);
        });
      },
    }),
    [localContext],
  );
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIdentity, setSelectedIdentity] = useState(null);
  const [storageBindings, setStorageBindings] = useState([]);
  const [existingStorage, setExistingStorage] = useState(null);
  const [picker, setPicker] = useState(null);
  const [gift, setGift] = useState(null);
  const [password, setPassword] = useState('');
  const [refresh, setRefresh] = useState(0);
  const identities = useAuthorizationIdentities(context, refresh, true);

  const reload = async (operationContext = context) => {
    const next = await loadAuthorizationReview(jobId, operationContext);
    assertAuthorizationContext(operationContext);
    setExistingStorage(null);
    setSelectedIdentity(previous => {
      if (next.selectionsLocked || (!previous && next.selectedIdentity)) {
        userEdited.current = true;
        return next.selectedIdentity;
      }
      return previous;
    });
    setStorageBindings(previous => {
      if (!next.requiresSharedStorage && !next.selectionsLocked) return [];
      if (
        next.selectionsLocked ||
        (!previous.length && !storageEdits.current.structure)
      ) {
        const saved = next.storageBindings || [];
        // Persisted choices are already deliberate; defaults only fill any
        // missing roles before submission and never replace a saved role.
        storageEdits.current.fields = saved.map(
          binding =>
            new Set(
              STORAGE_IDENTITY_FIELDS.filter(([field]) => binding[field]).map(
                ([field]) => field,
              ),
            ),
        );
        return saved;
      }
      return previous;
    });
    selectionContext.current = context;
    setReview(next);
    setRefresh(value => value + 1);
    if (
      next.hasGift &&
      !next.giftConfirmed &&
      !next.selectionsLocked &&
      next.status !== AUTHORIZATION_STATUS.CANCELLED &&
      next.status !== AUTHORIZATION_STATUS.EXPIRED
    ) {
      // Publish the verified review before the slower inventory scan. The
      // operation remains busy, so approval waits for complete gift discovery.
      const inventory = await loadAuthorizationGift(
        jobId,
        {},
        operationContext,
      );
      assertAuthorizationContext(operationContext);
      setGift(inventory);
    }
    return next;
  };

  // Lock synchronously so two queued taps cannot create competing submissions.
  const perform = async (
    operation,
    {
      cancelling = false,
      refreshReview = true,
      background = false,
      activity: nextActivity = 'refresh',
    } = {},
  ) => {
    if (running.current?.context === context) return;
    let finishOperation;
    const operationState = {
      context,
      finished: new Promise(resolve => {
        finishOperation = resolve;
      }),
    };
    running.current = operationState;
    setLoading(true);
    setActivity(nextActivity);
    if (!background) setError(null);
    const operationContext = cancelling ? localContext : context;

    try {
      if (!cancelling && !enabled)
        throw new Error(EXPERIMENTAL_DEEPLINK_DISABLED_MESSAGE);
      assertAuthorizationContext(operationContext);
      const result = await operation();
      assertAuthorizationContext(operationContext);
      if (operationState.feeDeclined) return;
      if (cancelling) {
        // Cancellation returns the saved local review. Do not let a subsequent
        // network refresh or invalid request hide the successful cancellation.
        setReview(result);
        setSelectedIdentity(result.selectedIdentity || selectedIdentity);
        setStorageBindings(result.storageBindings || []);
        setPassword('');
        setPicker(null);
      } else if (
        background &&
        result?.id === jobId &&
        result.status === review?.status
      ) {
        // A pending poll already reconciled the chain. Keep the reviewed names
        // and choices instead of reloading them while its stage is unchanged.
        setReview(previous => ({...previous, ...result}));
      } else if (refreshReview) {
        await reload(operationContext);
      }
      if (
        background &&
        result?.id === jobId &&
        result.status !== review?.status
      ) {
        setError(null);
      }
    } catch (failure) {
      if (
        failure.code === 'AUTHORIZATION_DELEGATE_CHANGED' &&
        mounted.current &&
        running.current === operationState &&
        !background
      ) {
        // Show the new authority before another approval attempt. Updating only
        // a saved baseline would let the next tap approve keys never reviewed.
        try {
          await reload(operationContext);
        } catch (refreshFailure) {
          failure = refreshFailure;
        }
      }
      if (
        mounted.current &&
        running.current === operationState &&
        !background &&
        failure.code !== 'SESSION_CHANGED' &&
        failure.code !== 'AUTHORIZATION_FEES_DECLINED'
      ) {
        // A fresh object also reveals repeated failures with the same message.
        setError({
          message: failure.message || 'Unable to continue authorization.',
        });
      }
    } finally {
      if (running.current === operationState) {
        running.current = null;
        if (mounted.current) {
          setLoading(false);
          setActivity(null);
          setSubmittingFee(null);
        }
      }
      finishOperation();
    }
  };

  const respondToFees = approved => {
    const pending = feeConsent.current;
    if (!pending) return;
    feeConsent.current = null;
    if (!approved && running.current?.context === pending.context) {
      running.current.feeDeclined = true;
    }
    if (mounted.current) {
      setFeeReview(null);
      if (approved) setSubmittingFee(pending.details.type);
    }
    pending.resolve(approved);
  };

  useEffect(() => {
    mounted.current = true;
    selectionContext.current = null;
    userEdited.current = false;
    storageEdits.current = {structure: false, fields: []};
    observedStatus.current = null;
    setReview(null);
    setSelectedIdentity(null);
    setStorageBindings([]);
    setExistingStorage(null);
    setGift(null);
    setPassword('');
    setFeeReview(null);
    setSubmittingFee(null);
    setResponseCopied(false);
    // Show the saved stage after one review read. Pending confirmation checks
    // happen separately, so opening a request never waits through a long poll.
    perform(() => reload(), {refreshReview: false, activity: 'loading'});
    return () => {
      mounted.current = false;
      if (feeConsent.current?.context === context) respondToFees(false);
    };
  }, [context]);

  useEffect(() => {
    if (
      !focused ||
      !enabled ||
      loading ||
      !review ||
      !mounted.current ||
      selectionContext.current !== context
    )
      return;

    // Service reconciliation publishes stages independently of this screen.
    // Reload only a new stage, after any fee review or foreground work finishes.
    if (!publishedStatus || publishedStatus === review.status) {
      observedStatus.current = publishedStatus;
      return;
    }
    if (observedStatus.current === publishedStatus) return;
    observedStatus.current = publishedStatus;
    perform(() => reload(), {background: true, refreshReview: false});
  }, [context, focused, enabled, loading, publishedStatus, review?.status]);

  const frozen = FINAL_STAGES.has(review?.status);
  const cancelled = review?.status === AUTHORIZATION_STATUS.CANCELLED;
  const complete = review?.status === AUTHORIZATION_STATUS.COMPLETE;
  const canRetryResponse = complete || review?.canRetryResponse === true;
  const expired = review?.status === AUTHORIZATION_STATUS.EXPIRED;
  const closed = complete || cancelled || expired;
  const selectionsLocked =
    frozen || closed || review?.selectionsLocked === true;
  const needsShieldedSetup = useMemo(() => {
    if (!review) return false;
    try {
      const coin = CoinDirectory.getBasicCoinObj(review.systemId);
      return !account?.keys?.[coin.id]?.[DLIGHT_PRIVATE];
    } catch (_) {
      return false;
    }
  }, [account, review]);
  const requiresSharedStorage = review?.requiresSharedStorage === true;
  const giftedUser =
    !review?.giftConfirmed &&
    gift?.identities?.some(
      identity =>
        identity.identityAddress === selectedIdentity?.identityID &&
        identity.systemId === selectedIdentity?.systemID,
    );
  const storageLookupRequired =
    requiresSharedStorage &&
    !!selectedIdentity &&
    !selectionsLocked &&
    !needsShieldedSetup &&
    !giftedUser;
  const existingStorageCurrent =
    existingStorage?.context === context &&
    existingStorage?.identityID === selectedIdentity?.identityID &&
    existingStorage?.systemID === selectedIdentity?.systemID;
  const storageLookupPending = storageLookupRequired && !existingStorageCurrent;
  const storageLookupFailed =
    storageLookupRequired && existingStorageCurrent && existingStorage.error;
  const storageIDsLocked =
    storageLookupRequired &&
    existingStorageCurrent &&
    existingStorage.bindings.length > 0;
  const storageSelectionLocked =
    selectionsLocked || storageLookupPending || storageLookupFailed;

  useEffect(() => {
    if (
      !storageLookupPending ||
      loading ||
      selectionContext.current !== context
    )
      return;
    let active = true;
    // A different account can have a different connection to the same app.
    // Do not carry its locked storage into the next account's initial defaults.
    if (existingStorage?.bindings.length) {
      setStorageBindings([]);
      storageEdits.current = {structure: false, fields: []};
    }
    loadAuthorizationStorageSelection(selectedIdentity, review.appId, context)
      .then(bindings => {
        assertAuthorizationContext(context);
        if (!active) return;
        setExistingStorage({context, ...selectedIdentity, bindings});
        if (bindings.length) {
          storageEdits.current = {
            structure: true,
            fields: bindings.map(
              () => new Set(STORAGE_IDENTITY_FIELDS.map(([field]) => field)),
            ),
          };
          setStorageBindings(bindings);
          setPicker(null);
        }
      })
      .catch(failure => {
        if (!active || failure.code === 'SESSION_CHANGED') return;
        setExistingStorage({
          context,
          ...selectedIdentity,
          bindings: [],
          error: true,
        });
        setError({
          message:
            failure.message ||
            'Unable to read this app’s existing storage. Refresh to try again.',
        });
      });
    return () => {
      active = false;
    };
  }, [context, selectedIdentity, review?.appId, storageLookupPending, loading]);
  const defaults = useMemo(
    () => review && getAuthorizationSelectionDefaults(review, gift, identities),
    [review, gift, identities],
  );

  useEffect(() => {
    if (!defaults || selectionsLocked || selectionContext.current !== context)
      return;

    const selectedIsStorage = identities.some(
      identity =>
        identity.isStorage &&
        identity.identityID === selectedIdentity?.identityID &&
        identity.systemID === selectedIdentity?.systemID,
    );
    const user = userEdited.current
      ? selectedIdentity
      : defaults.user || (selectedIsStorage ? null : selectedIdentity);
    setSelectedIdentity(user);
    setStorageBindings(previous => {
      if (!requiresSharedStorage) return previous.length ? [] : previous;

      const bindings =
        !previous.length &&
        defaults.storageID &&
        !storageEdits.current.structure
          ? [{storageIdentity: defaults.storageID}]
          : previous;
      let changed = bindings !== previous;
      const next = bindings.map((binding, index) => {
        const updated = {...binding};
        const edited = storageEdits.current.fields[index];

        if (
          bindings.length === 1 &&
          !binding.storageIdentity &&
          !storageEdits.current.structure &&
          defaults.storageID
        ) {
          updated.storageIdentity = defaults.storageID;
          changed = true;
        }

        for (const [field, candidates] of [
          ['revocationIdentity', defaults.revocationIDs],
          ['recoveryIdentity', defaults.recoveryIDs],
        ]) {
          if (edited?.has(field)) continue;
          // Multiple explicit offers remain a choice. With no dedicated
          // offer, the known independent user controls both storage roles.
          const identityID =
            candidates.length === 1
              ? candidates[0]
              : candidates.length === 0
              ? user?.identityID
              : undefined;
          const value =
            identityID && identityID !== updated.storageIdentity
              ? identityID
              : undefined;
          if (binding[field] !== value) {
            updated[field] = value;
            changed = true;
          }
        }
        return updated;
      });
      return changed ? next : previous;
    });
  }, [
    context,
    defaults,
    identities,
    requiresSharedStorage,
    selectedIdentity,
    selectionsLocked,
    storageBindings,
  ]);
  const delegatorName =
    review?.appName && review.appName !== review.appId
      ? convertFqnToDisplayFormat(review.appName)
      : review?.appId;
  const delegateeName =
    review?.delegateName && review.delegateName !== review.delegateId
      ? convertFqnToDisplayFormat(review.delegateName)
      : review?.delegateId;
  const offers = review?.offers || [];
  const identityName = (identityID, systemID = review?.systemId) => {
    const linked = identities.find(
      item => item.identityID === identityID && item.systemID === systemID,
    );
    const gifted = gift?.identities?.find(
      item => item.identityAddress === identityID && item.systemId === systemID,
    );
    return (
      linked?.title ||
      offers.find(item => item.identityID === identityID)?.name ||
      (gifted?.fullyQualifiedName
        ? convertFqnToDisplayFormat(gifted.fullyQualifiedName)
        : identityID)
    );
  };
  const chosenName =
    selectedIdentity &&
    identityName(selectedIdentity.identityID, selectedIdentity.systemID);
  const pickerChoices = useMemo(() => {
    if (!picker) return [];
    const choosingStorage = picker.field === 'storageIdentity';
    const storageIDs = new Set([
      ...identities
        .filter(item => item.isStorage && item.systemID === review?.systemId)
        .map(item => item.identityID),
      ...offers
        .filter(offer => offer.role === AppAuthorizationOfferRole.STORAGE)
        .map(offer => offer.identityID),
      ...storageBindings.map(binding => binding.storageIdentity),
    ]);
    const choices = identities.filter(
      item =>
        item.systemID === review?.systemId &&
        (choosingStorage
          ? item.identityID !== selectedIdentity?.identityID
          : !item.isStorage && !storageIDs.has(item.identityID)),
    );
    const roles =
      picker.field === 'user'
        ? [AppAuthorizationOfferRole.AUTHORITY]
        : picker.field === 'storageIdentity'
        ? [AppAuthorizationOfferRole.STORAGE]
        : picker.field === 'revocationIdentity'
        ? [
            AppAuthorizationOfferRole.AUTHORITY,
            AppAuthorizationOfferRole.REVOCATION,
          ]
        : [
            AppAuthorizationOfferRole.AUTHORITY,
            AppAuthorizationOfferRole.RECOVERY,
          ];

    for (const offer of offers) {
      if (
        !roles.includes(offer.role) ||
        (!choosingStorage && storageIDs.has(offer.identityID)) ||
        choices.some(item => item.identityID === offer.identityID)
      )
        continue;
      choices.push({
        key: offer.identityID,
        identityID: offer.identityID,
        systemID: review.systemId,
        title: offer.name || offer.identityID,
        description: ROLE_NAMES[offer.role],
      });
    }

    if (!choosingStorage) {
      for (const identity of gift?.identities || []) {
        if (
          identity.systemId !== review.systemId ||
          identity.unsupportedReason ||
          storageIDs.has(identity.identityAddress) ||
          choices.some(item => item.identityID === identity.identityAddress)
        )
          continue;
        choices.push({
          key: `${identity.systemId}:${identity.identityAddress}`,
          identityID: identity.identityAddress,
          systemID: identity.systemId,
          title: identity.fullyQualifiedName
            ? convertFqnToDisplayFormat(identity.fullyQualifiedName)
            : identity.identityAddress,
          description: 'Gifted identity',
        });
      }

      if (
        selectedIdentity &&
        !storageIDs.has(selectedIdentity.identityID) &&
        !choices.some(item => item.identityID === selectedIdentity.identityID)
      )
        choices.push({
          ...selectedIdentity,
          key: `${selectedIdentity.systemID}:${selectedIdentity.identityID}`,
          title: identityName(selectedIdentity.identityID),
        });
    }

    return choices;
  }, [picker, identities, review, gift, selectedIdentity, storageBindings]);
  const selectedPickerKey = pickerChoices.find(
    item =>
      item.identityID ===
        (picker?.field === 'user'
          ? selectedIdentity?.identityID
          : storageBindings[picker?.index]?.[picker?.field]) &&
      (picker?.field !== 'user' ||
        item.systemID === selectedIdentity?.systemID),
  )?.key;

  const giftPending = review?.hasGift && !review.giftConfirmed;
  const giftReady = gift && !gift.requiresPassword;
  const preparingPayment =
    loading && (submittingFee || activity === 'authorization') && !feeReview;
  const pendingConfirmation = CONFIRMATION_STAGES.has(review?.status);
  const resumingSetup = review?.selectionsLocked === true && !closed && !frozen;
  const choosingIdentity =
    review &&
    !closed &&
    !frozen &&
    (!giftPending || giftReady) &&
    !needsShieldedSetup &&
    !resumingSetup &&
    !feeReview &&
    !preparingPayment;
  const storageIncomplete =
    requiresSharedStorage &&
    (storageLookupPending ||
      storageLookupFailed ||
      !storageBindings.length ||
      storageBindings.some(binding =>
        STORAGE_IDENTITY_FIELDS.some(([field]) => !binding[field]),
      ));
  const refreshProgress = (background = false) =>
    perform(() => reconcileAuthorizationJob(jobId, context), {
      background: background === true,
    });

  useEffect(() => {
    if (!focused || !enabled || !CONFIRMATION_STAGES.has(review?.status))
      return;
    const poll = () => {
      if (AppState.currentState === 'active' && !running.current) {
        refreshProgress(true);
      }
    };
    const timer = setInterval(poll, PROGRESS_REFRESH_INTERVAL_MS);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') poll();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [context, focused, enabled, review?.status]);

  const approve = () =>
    perform(
      () =>
        approveAuthorization(
          jobId,
          {
            selectedIdentity,
            delegateRevision: review?.delegateRevision,
            // Resume an already prepared arrangement, but never add storage to a
            // new approval unless the app's signed request requires it.
            storageBindings:
              requiresSharedStorage || review?.selectionsLocked
                ? storageBindings
                : [],
          },
          context,
        ),
      {activity: selectionsLocked ? 'progress' : 'authorization'},
    );
  const notifyApp = () =>
    perform(async () => {
      // A finished job already holds the signed response. Retrying delivery
      // never derives another channel, signs again, or submits a transaction.
      if (!canRetryResponse) await prepareAuthorizationResponse(jobId, context);
      if (review?.hasResponseDestination === false) {
        const response = await loadPreparedAuthorizationResponse(
          jobId,
          context,
        );
        assertAuthorizationContext(context);
        copyToClipboard(response.toBuffer().toString('hex'));
        setResponseCopied(true);
      }
      await deliverAuthorizationResponse(jobId, context);
    });
  const finish = () => {
    // Leaving never approves an outstanding quote. Subsequent service checks
    // also stop new signing, while already saved transactions remain resumable.
    mounted.current = false;
    respondToFees(false);
    const {authentication} = store.getState();
    const destination = authentication.signedIn
      ? 'SignedInStack'
      : authentication.accounts?.length
      ? 'SignedOutStack'
      : 'SignedOutNoKeyStack';

    // Cold-start sign-in can remove the previous root route, and verification
    // is replaced by this screen. Completion cannot depend on back history.
    // The verifier already cleared its ingress; leave any newer deeplink alone.
    navigation.dispatch(
      CommonActions.reset({index: 0, routes: [{name: destination}]}),
    );
  };

  // Choose one next action from the durable stage. Confirmation and retry paths
  // keep using the existing workflow, which resumes prepared transactions.
  let primaryAction = {label: 'Retry loading', onPress: refreshProgress};
  if (feeReview) {
    primaryAction = {
      label: 'Approve connection',
      disabled: !enabled,
      onPress: () => respondToFees(true),
    };
  } else if (closed) {
    primaryAction = review.giftRecoveryPending
      ? {label: 'Check gift progress', onPress: refreshProgress}
      : {label: 'Done', onPress: finish};
  } else if (review?.status === AUTHORIZATION_STATUS.RESPONSE_READY) {
    primaryAction = {
      label:
        review.hasResponseDestination === false
          ? 'Copy response'
          : 'Notify app',
      onPress: notifyApp,
    };
  } else if (pendingConfirmation) {
    primaryAction = {label: 'Done for now', onPress: finish, exit: true};
  } else if (frozen) {
    primaryAction = {
      label: 'Check progress',
      onPress: approve,
    };
  } else if (needsShieldedSetup) {
    primaryAction = {
      label: 'Set up keys',
      onPress: () => {
        dispatch(setConfigSection('settings-profile'));
        navigation.navigate('SignedInStack', {
          screen: 'MainStack',
          params: {
            screen: 'SettingsMenus',
            params: {authorizationJobId: jobId},
          },
        });
      },
    };
  } else if (giftPending && !giftReady) {
    primaryAction = {
      label: gift?.requiresPassword ? 'Unlock gift' : 'Review gift',
      disabled: gift?.requiresPassword && !password,
      onPress: () =>
        perform(
          async () => {
            const inventory = await loadAuthorizationGift(
              jobId,
              {password},
              context,
            );
            assertAuthorizationContext(context);
            setGift(inventory);
            setPassword('');
          },
          {refreshReview: false},
        ),
    };
  } else if (review && !selectedIdentity) {
    primaryAction = {
      label: 'Choose identity',
      onPress: () => setPicker({field: 'user'}),
    };
  } else if (review) {
    primaryAction = {
      label: 'Review fees',
      disabled: storageIncomplete,
      onPress: approve,
    };
  }

  const cancel = () =>
    Alert.alert(
      'Cancel authorization?',
      'Claimed assets and pending transactions remain saved. Any shared storage already set up can be managed in Linked apps.',
      [
        {text: 'Keep working', style: 'cancel'},
        {
          text: 'Cancel authorization',
          style: 'destructive',
          onPress: async () => {
            const active = running.current;
            if (feeConsent.current) {
              respondToFees(false);
              await active?.finished;
            }
            if (!mounted.current) return;
            return perform(
              () => cancelAuthorization(jobId, selectedIdentity, localContext),
              {cancelling: true},
            );
          },
        },
      ],
    );
  const stepNumber =
    frozen || closed
      ? AUTHORIZATION_STEP_COUNT
      : feeReview || preparingPayment
      ? 2
      : 1;
  const statusLabel = STATUS_LABELS[review?.status];
  const feeAmounts = Object.fromEntries(
    (feeReview?.fees || []).map(fee => [fee.currency, fee.atomic]),
  );
  const feeCurrencyNames = Object.fromEntries(
    (feeReview?.fees || []).map(fee => [fee.currency, fee.ticker]),
  );
  const giftAllocation = feeReview?.giftAllocation;
  const stepTitle = feeReview
    ? 'Approve connection'
    : frozen || closed
    ? 'Confirm and finish'
    : 'Review connection';
  const showProgress =
    !feeReview && (closed || frozen || resumingSetup || preparingPayment);
  const canLeavePending =
    !closed && (loading || feeReview || frozen || resumingSetup);

  return (
    <>
      <AuthorizationPage
        error={error}
        refreshing={loading}
        onRefresh={() => refreshProgress()}
        refreshLabel="Refresh authorization"
        footer={
          <>
            <Button
              mode="contained"
              contentStyle={styles.buttonContent}
              loading={loading && !feeReview && !primaryAction.exit}
              disabled={
                !primaryAction.exit &&
                ((loading && !feeReview) || primaryAction.disabled)
              }
              onPress={primaryAction.onPress}>
              {primaryAction.label}
            </Button>
            {!cancelled && !complete && (
              <Button
                contentStyle={styles.buttonContent}
                disabled={loading && !feeReview}
                onPress={cancel}>
                Cancel request
              </Button>
            )}
            {canLeavePending && !primaryAction.exit && (
              <Button contentStyle={styles.buttonContent} onPress={finish}>
                Done for now
              </Button>
            )}
            {closed && review.giftRecoveryPending && (
              <Button contentStyle={styles.buttonContent} onPress={finish}>
                Done
              </Button>
            )}
          </>
        }>
        {!review ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.title}>
              App authorization
            </Text>
            {!error && <Text style={styles.body}>Loading request…</Text>}
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.eyebrow}>
                STEP {stepNumber} OF {AUTHORIZATION_STEP_COUNT} · {stepTitle}
              </Text>
              <Text style={styles.eyebrow}>REQUEST FROM</Text>
              <RequestSigner
                signerFqn={delegateeName}
                signerIdentityID={review.delegateId}
                appOrDelegatorID={review.appId}
                appOrDelegatorFqn={delegatorName}
                selectable
                accessibilityRole="header"
                style={styles.title}
              />
              {!closed && !frozen && (
                <>
                  <Text selectable style={styles.body}>
                    If you approve, this representative can act on behalf of{' '}
                    <Text style={styles.emphasis}>{delegatorName}</Text> in
                    future wallet requests.
                  </Text>
                  <Text style={styles.secondary}>
                    Each operation still requires its usual review.
                  </Text>
                </>
              )}
            </View>

            {!closed && !frozen && !feeReview && !preparingPayment && (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.subtitle}>
                  Private app messages
                </Text>
                <Text style={styles.body}>
                  {review.appEncryption?.returnESK
                    ? 'Share this app’s encryption channel keys, including its spending key, so it can encrypt and read data in this channel.'
                    : 'Share a private encryption address and viewing keys so the app can encrypt and read your messages.'}
                </Text>
                <Text style={styles.secondary}>
                  Your wallet seed stays in your wallet. Channel keys are sent
                  only after your approval confirms.
                </Text>
              </View>
            )}

            {feeReview && (
              <>
                <View style={styles.card}>
                  <Text accessibilityRole="header" style={styles.subtitle}>
                    Pay now · Complete setup
                  </Text>
                  {feeReview.fees.length ? (
                    <AmountRows
                      label="Network fee"
                      amounts={feeAmounts}
                      currencyNames={feeCurrencyNames}
                      total
                    />
                  ) : (
                    <Text style={styles.body}>
                      No network fee for this transaction.
                    </Text>
                  )}
                  <Text style={styles.secondary}>
                    {feeReview.transactionCount}{' '}
                    {feeReview.transactionCount === 1
                      ? 'transaction'
                      : 'transactions'}
                    . This fee covers the identity changes and app approval
                    together.
                  </Text>
                  <Text style={styles.body}>
                    {review.hasGift
                      ? 'Paid from the gift funds. You do not need an existing balance.'
                      : 'Paid from your available wallet funds.'}
                  </Text>
                  {giftAllocation && (
                    <View style={styles.section}>
                      <Text accessibilityRole="header" style={styles.subtitle}>
                        Gift funds after fees
                      </Text>
                      <AmountRows
                        label="Your reserve"
                        amounts={{
                          [giftAllocation.currency]:
                            giftAllocation.reserve.atomic,
                        }}
                        currencyNames={feeCurrencyNames}
                      />
                      <DetailRow label="To your identity">
                        {identityName(
                          giftAllocation.reserve.identityID,
                          feeReview.systemID,
                        )}
                      </DetailRow>
                      <Text style={styles.secondary}>
                        Only you control this reserve. Use it to pay fees when
                        removing app access.
                      </Text>
                      {giftAllocation.storage.map(allocation => (
                        <View
                          key={allocation.identityID}
                          style={styles.section}>
                          <AmountRows
                            label="App storage"
                            amounts={{
                              [giftAllocation.currency]: allocation.atomic,
                            }}
                            currencyNames={feeCurrencyNames}
                          />
                          <DetailRow label="To shared storage">
                            {identityName(
                              allocation.identityID,
                              feeReview.systemID,
                            )}
                          </DetailRow>
                        </View>
                      ))}
                      {giftAllocation.storage.length > 0 && (
                        <Text style={styles.secondary}>
                          Shared storage funds pay for app writes.
                        </Text>
                      )}
                    </View>
                  )}
                  {feeReview.identityID && (
                    <DetailRow label="Identity being updated">
                      {identityName(feeReview.identityID)}
                    </DetailRow>
                  )}
                </View>
                <Button
                  contentStyle={styles.buttonContent}
                  onPress={() => respondToFees(false)}>
                  Back to review
                </Button>
              </>
            )}

            {showProgress && (
              <View style={styles.card}>
                <Text
                  accessibilityRole="header"
                  accessibilityLiveRegion="polite"
                  style={styles.subtitle}>
                  {preparingPayment
                    ? submittingFee
                      ? 'Submitting your reviewed transaction'
                      : 'Preparing your fee review'
                    : statusLabel}
                </Text>
                {loading && (
                  <ActivityIndicator
                    color={Colors.primaryColor}
                    accessibilityLabel={
                      preparingPayment
                        ? 'Preparing authorization transaction'
                        : 'Checking confirmation'
                    }
                  />
                )}
                <Text style={styles.body}>
                  {preparingPayment
                    ? submittingFee
                      ? 'Your fee approval applies only to the transaction you reviewed. You can leave while its saved progress is checked.'
                      : 'Checking the selected identities and preparing the exact transaction fees. No payment is made until you approve the fee review.'
                    : complete
                    ? review.hasResponseDestination === false
                      ? responseCopied
                        ? 'Response copied. Return it to the app to finish.'
                        : 'The signed response is ready. Copy it and return it to the app.'
                      : review.grantConfirmed
                      ? 'This app instance is linked. You can remove its approval in Linked apps.'
                      : 'The app has been notified. No approval was activated.'
                    : expired
                    ? 'Ask the app for a new request to continue. Your claimed assets and pending transactions remain saved.'
                    : cancelled
                    ? review.approvalMayRemain
                      ? 'This request is cancelled. Updates already signed or submitted may still take effect. Check Linked apps to remove any approval or storage access.'
                      : 'This request is cancelled. Your claimed assets and pending transactions remain saved.'
                    : review.status === AUTHORIZATION_STATUS.RESPONSE_READY
                    ? review.hasResponseDestination === false
                      ? 'This request has no return address. Copy the signed response and return it to the app.'
                      : 'Send the result back to the app to finish this request.'
                    : pendingConfirmation
                    ? 'One transaction completes your identity setup and app approval. Waiting for one block confirmation.'
                    : 'Your approval is saved. Check progress to confirm it or resume an interrupted submission.'}
                </Text>
                {selectedIdentity && (
                  <Text selectable style={styles.secondary}>
                    Your identity: {chosenName || selectedIdentity.identityID}
                  </Text>
                )}
                {review.giftRecoveryPending && closed && (
                  <Text style={styles.body}>
                    The submitted connection still needs confirmation. You can
                    check its progress here.
                  </Text>
                )}
                {pendingConfirmation && !closed && (
                  <Button
                    mode="outlined"
                    contentStyle={styles.buttonContent}
                    disabled={loading}
                    onPress={refreshProgress}>
                    Check progress
                  </Button>
                )}
                {cancelled && review.canNotifyCancellation && (
                  <>
                    <Text style={styles.secondary}>
                      {review.hasResponseDestination === false
                        ? 'You can copy a signed cancellation response to return to the app. The request stays cancelled if signing fails.'
                        : 'You can notify the app if this identity can sign a response. The request stays cancelled if notification fails.'}
                    </Text>
                    <Button
                      mode="outlined"
                      contentStyle={styles.buttonContent}
                      disabled={loading || !enabled}
                      onPress={notifyApp}>
                      {review.hasResponseDestination === false
                        ? 'Copy response'
                        : 'Notify app'}
                    </Button>
                  </>
                )}
                {canRetryResponse && (
                  <Button
                    mode="outlined"
                    contentStyle={styles.buttonContent}
                    disabled={loading || !enabled}
                    onPress={notifyApp}>
                    {review.hasResponseDestination === false
                      ? 'Copy response'
                      : 'Notify app again'}
                  </Button>
                )}
                {!closed &&
                  review.status !== AUTHORIZATION_STATUS.RESPONSE_READY && (
                    <Text style={styles.secondary}>
                      Choose Done for now to return to your wallet. Continue
                      from the saved authorization notification. This screen
                      checks pending confirmations automatically while open.
                    </Text>
                  )}
              </View>
            )}

            {!closed &&
              !frozen &&
              needsShieldedSetup &&
              !feeReview &&
              !preparingPayment && (
                <View style={styles.card}>
                  <Text accessibilityRole="header" style={styles.subtitle}>
                    Set up your private wallet
                  </Text>
                  <Text style={styles.body}>
                    Your wallet needs a Z seed to encrypt this approval. Set it
                    up in your profile, then return to this saved request.
                  </Text>
                </View>
              )}

            {giftPending &&
              !closed &&
              !frozen &&
              !feeReview &&
              !preparingPayment &&
              !needsShieldedSetup && (
                <View style={styles.card}>
                  <Text accessibilityRole="header" style={styles.subtitle}>
                    Gift funds
                  </Text>
                  <Text style={styles.body}>
                    These identities and funds will set up your connection in
                    one transaction.
                  </Text>
                  {gift?.requiresPassword && (
                    <TextInput
                      mode="outlined"
                      label="Gift password"
                      secureTextEntry
                      value={password}
                      onChangeText={setPassword}
                      disabled={loading}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      style={styles.password}
                    />
                  )}
                  {gift && !gift.requiresPassword && (
                    <>
                      {gift.currencies?.map(currency => (
                        <Text
                          key={`${currency.systemId}:${currency.currencyId}`}
                          style={styles.body}>
                          {currency.amount} {currency.name}
                        </Text>
                      ))}
                      {!gift.identities?.length && !gift.currencies?.length && (
                        <Text style={styles.secondary}>
                          No assets remain to claim. Continue to confirm the
                          gift review.
                        </Text>
                      )}
                      <Text style={styles.secondary}>
                        Gifted identities become available after signing,
                        recovery, and revocation control have transferred to you
                        and confirmed.
                      </Text>
                    </>
                  )}
                </View>
              )}

            {choosingIdentity && (
              <View style={styles.card}>
                <List.Item
                  title="Your identity"
                  description={
                    chosenName ||
                    selectedIdentity?.identityID ||
                    'Choose an identity'
                  }
                  titleStyle={styles.eyebrow}
                  descriptionStyle={styles.body}
                  titleNumberOfLines={0}
                  descriptionNumberOfLines={0}
                  style={styles.selection}
                  accessibilityRole="button"
                  accessibilityLabel={`Your identity: ${
                    chosenName ||
                    selectedIdentity?.identityID ||
                    'Choose an identity'
                  }`}
                  accessibilityHint="Choose the identity that stores your approval and signs the response"
                  accessibilityState={{disabled: loading || selectionsLocked}}
                  right={props =>
                    !selectionsLocked && (
                      <List.Icon {...props} icon="chevron-right" />
                    )
                  }
                  onPress={
                    loading || selectionsLocked
                      ? undefined
                      : () => setPicker({field: 'user'})
                  }
                />
                <Text style={styles.secondary}>
                  This identity stores your encrypted approval and signs the
                  response.
                </Text>
              </View>
            )}

            {choosingIdentity && selectedIdentity && requiresSharedStorage && (
              <View style={styles.card}>
                <Text style={styles.body}>
                  The app can write to shared storage without asking each time.
                  You keep independent signing, recovery, and revocation
                  control.
                </Text>
                {storageLookupPending && (
                  <Text style={styles.secondary}>
                    Checking this identity’s existing app storage…
                  </Text>
                )}
                {storageIDsLocked && (
                  <Text style={styles.secondary}>
                    This instance will use the same shared storage as your
                    existing app connection.
                  </Text>
                )}
                {storageBindings.map((binding, index) => (
                  <DetailRow
                    key={binding.storageIdentity || index}
                    label="Shared storage">
                    {identityName(binding.storageIdentity) ||
                      'Choose storage below'}
                  </DetailRow>
                ))}
                <Disclosure
                  key={`${jobId}:${
                    context.sessionScope?.accountHash || sessionKey
                  }:storage`}
                  title="Shared storage"
                  summary={
                    storageBindings.length
                      ? `${storageBindings.length} selected`
                      : 'Required by this app'
                  }
                  initiallyOpen>
                  {storageBindings.map((binding, index) => (
                    <View key={index} style={styles.storageSelection}>
                      <Text accessibilityRole="header" style={styles.subtitle}>
                        Storage {index + 1}
                      </Text>
                      {STORAGE_IDENTITY_FIELDS.map(([field, label]) => {
                        const disabled =
                          loading ||
                          storageSelectionLocked ||
                          (storageIDsLocked && field === 'storageIdentity');
                        return (
                          <List.Item
                            key={field}
                            title={label}
                            description={
                              identityName(binding[field]) || 'Choose identity'
                            }
                            titleStyle={styles.eyebrow}
                            descriptionStyle={styles.body}
                            titleNumberOfLines={0}
                            descriptionNumberOfLines={0}
                            style={styles.selection}
                            accessibilityRole="button"
                            accessibilityLabel={`${label}: ${
                              identityName(binding[field]) || 'Choose identity'
                            }`}
                            accessibilityState={{disabled}}
                            right={props =>
                              !disabled && (
                                <List.Icon {...props} icon="chevron-right" />
                              )
                            }
                            onPress={
                              disabled
                                ? undefined
                                : () => setPicker({field, index})
                            }
                          />
                        );
                      })}
                      {!storageSelectionLocked && !storageIDsLocked && (
                        <Button
                          contentStyle={styles.buttonContent}
                          accessibilityLabel={`Remove storage selection ${
                            index + 1
                          }`}
                          disabled={loading}
                          onPress={() => {
                            storageEdits.current.structure = true;
                            storageEdits.current.fields.splice(index, 1);
                            setStorageBindings(current =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            );
                          }}>
                          Remove selection
                        </Button>
                      )}
                    </View>
                  ))}
                  {!storageSelectionLocked && !storageIDsLocked && (
                    <Button
                      mode="outlined"
                      contentStyle={styles.buttonContent}
                      disabled={loading}
                      onPress={() => {
                        storageEdits.current.structure = true;
                        storageEdits.current.fields[storageBindings.length] =
                          new Set();
                        setStorageBindings(current => [...current, {}]);
                      }}>
                      Add storage
                    </Button>
                  )}
                  {storageIncomplete &&
                    !storageLookupPending &&
                    !storageLookupFailed && (
                      <Text style={styles.secondary}>
                        Choose an identity for each storage role to continue.
                      </Text>
                    )}
                </Disclosure>
              </View>
            )}

            <View style={styles.card}>
              <Disclosure
                key={`${jobId}:${sessionKey}:details`}
                title="Request details"
                summary="Addresses, signing keys and deadline">
                <DetailRow label="Delegator identity (app)">
                  {review.appId}
                </DetailRow>
                <DetailRow label="Delegatee identity (representative)">
                  {review.delegateId}
                </DetailRow>
                {selectedIdentity && (
                  <DetailRow label="Your identity">
                    {selectedIdentity.identityID}
                  </DetailRow>
                )}
                {review.delegateAuthorities?.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.eyebrow}>Signing requirements</Text>
                    <Text style={styles.body}>
                      {review.delegateThreshold} of{' '}
                      {review.delegateAuthorities.length} signatures required.
                      Approval includes all eligible keys below.
                    </Text>
                    {review.delegateAuthorities.map(authority => (
                      <Text selectable key={authority} style={styles.secondary}>
                        {authority}
                      </Text>
                    ))}
                  </View>
                )}
                <DetailRow label="Approval deadline">
                  {new Date(review.expiryTime * 1000).toLocaleString()}
                </DetailRow>
                {storageBindings.map((binding, index) => (
                  <View key={index} style={styles.section}>
                    <Text style={styles.subtitle}>Storage {index + 1}</Text>
                    {STORAGE_IDENTITY_FIELDS.map(
                      ([field, label]) =>
                        binding[field] && (
                          <DetailRow key={field} label={label}>
                            {binding[field]}
                          </DetailRow>
                        ),
                    )}
                  </View>
                ))}
                {offers.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.subtitle}>Offered identities</Text>
                    <Text style={styles.secondary}>
                      Suggestions from the app. You choose which identities to
                      use.
                    </Text>
                    {offers.map(offer => (
                      <DetailRow
                        key={`${offer.role}:${offer.identityID}`}
                        label={ROLE_NAMES[offer.role]}>
                        {offer.name || offer.identityID}
                      </DetailRow>
                    ))}
                  </View>
                )}
              </Disclosure>
            </View>
            {(closed || selectionsLocked) && selectedIdentity && (
              <Button
                contentStyle={styles.buttonContent}
                disabled={loading}
                onPress={() =>
                  navigation.navigate('LinkedAppInstances', {
                    user: selectedIdentity,
                  })
                }>
                Linked apps
              </Button>
            )}
          </>
        )}
      </AuthorizationPage>
      <Portal>
        <ListSelectionModal
          visible={picker != null}
          cancel={() => setPicker(null)}
          title={picker?.field === 'user' ? 'Your identity' : 'Select identity'}
          data={pickerChoices}
          selectedKey={selectedPickerKey}
          showSearch
          onSelect={item => {
            if (picker.field === 'user') {
              userEdited.current = true;
              setSelectedIdentity({
                identityID: item.identityID,
                systemID: item.systemID,
              });
            } else {
              if (
                storageLookupPending ||
                storageLookupFailed ||
                (storageIDsLocked && picker.field === 'storageIdentity')
              )
                return;
              if (!storageEdits.current.fields[picker.index]) {
                storageEdits.current.fields[picker.index] = new Set();
              }
              storageEdits.current.fields[picker.index].add(picker.field);
              setStorageBindings(current =>
                current.map((binding, index) =>
                  index === picker.index
                    ? {...binding, [picker.field]: item.identityID}
                    : binding,
                ),
              );
            }
            setPicker(null);
          }}
        />
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  section: {gap: 8, minWidth: 0},
  card: {...reviewStyles.card, marginBottom: 0, gap: 12},
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: Colors.quaternaryColor,
    flexShrink: 1,
  },
  subtitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.quaternaryColor,
    flexShrink: 1,
  },
  eyebrow: {fontSize: 14, lineHeight: 20, color: '#596579', flexShrink: 1},
  body: {
    fontSize: 16,
    lineHeight: 23,
    color: Colors.quaternaryColor,
    flexShrink: 1,
  },
  secondary: {fontSize: 14, lineHeight: 21, color: '#596579', flexShrink: 1},
  // Emphasize the delegator without changing the surrounding text's size.
  emphasis: {fontWeight: '600'},
  password: {backgroundColor: Colors.secondaryColor},
  selection: {paddingHorizontal: 0, minHeight: MINIMUM_TOUCH_TARGET_SIZE},
  storageSelection: {
    gap: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E8E8E8',
  },
  // Keep the shared app button appearance, with room for larger system text.
  buttonContent: {minHeight: MINIMUM_TOUCH_TARGET_SIZE, paddingVertical: 4},
});
