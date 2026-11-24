/*
  GenericRequestComplete
  - 2026-02-05: Redesigned UI to match stepper visual language. SafeAreaView layout
  with mainTitle header, centered checkmark, context-aware response notice card,
  single gradient "Complete" button in footer bar. Removed Cancel button (action
  is already done, skipping response delivery is bad UX). Updated notice copy:
  redirect shows "You'll be redirected to {host} to finish", POST shows
  "Your response will be sent to the requester".
  - 2026-03-11: Clarified that the surfaced txid belongs to the identity update transaction .
  - 2026-04-08: Reintroduced a guarded cancel escape hatch after a POST response URI
  fails so users can leave the screen after at least one delivery attempt.
*/
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Platform, SafeAreaView, View, TouchableOpacity, Clipboard } from 'react-native';
import { Text } from 'react-native-paper';
import Button from '../../../components/Button';
import { CommonActions } from '@react-navigation/native';
import { useDispatch, useSelector } from 'react-redux';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { URL } from 'react-native-url-polyfill';
import AnimatedSuccessCheckmark from '../../../components/AnimatedSuccessCheckmark';
import AnimatedActivityIndicatorBox from '../../../components/AnimatedActivityIndicatorBox';
import GradientButton from '../../../components/GradientButton';
import Colors from '../../../globals/colors';
import { resetDeeplinkData } from '../../../actions/actionCreators';
import store from '../../../store';
import {captureSessionScope, sessionScopeIsCurrent} from '../../../actions/actions/updates/sessionRequests';
import { getAppEncryptionSessionKey } from '../../../utils/deeplink/appEncryptionSession';
import { CoinDirectory } from '../../../utils/CoinData/CoinDirectory';
import { signGenericResponse } from '../../../utils/api/channels/vrpc/callCreators';
import {
  GenericRequest,
  GenericResponse,
  IDENTITY_UPDATE_RESPONSE_VDXF_KEY,
  VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
} from 'verus-typescript-primitives';
import { verifyGenericResponse } from '../../../utils/api/channels/vrpc/requests/verifyGenericResponse';
import { createAlert, resolveAlert } from '../../../actions/actions/alert/dispatchers/alert';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { genericRequestCompleteStyles as styles } from '../../../styles';
import { markPendingDeeplinkComplete } from '../../../utils/deeplink/pendingDeeplinkStorage';
import { prepareGenericResponseForSigning } from '../../../utils/deeplink/genericResponse/prepareGenericResponseForSigning';
import { encryptGenericResponseDetails } from '../../../utils/deeplink/genericResponse/encryptGenericResponseDetails';
import {deliverGenericResponse, getGenericResponseUri, isPostResponseUri, isRedirectResponseUri} from '../../../utils/deeplink/genericResponse/deliverGenericResponse';
import {loadDelegatedResponse} from '../../../utils/appAuthorization/delegatedOperations';
import {getGenericResponseSigner} from '../../../utils/deeplink/genericResponse/ensureGenericResponseSigner';
import {assertExperimentalGenericRequestAllowed} from '../../../utils/deeplink/experimentalDeeplinks';
import {assertNoPlaintextAppEncryptionResponse} from '../../../utils/deeplink/genericResponse/responseDeliverySecurity';
import {
  performAfterAuthenticationExpiryCheck,
  signAfterAuthenticationExpiryCheck,
} from '../../../utils/deeplink/validator/authenticationRequestValidator';

const GenericRequestComplete = props => {
  const { requestBufferString, responseBufferString, appEncryptionSessionKey } = props.route.params;
  const insets = useSafeAreaInsets();
  const bottomNavigationInset = Math.max(
    insets.bottom,
    Platform.OS === 'android' ? 24 : 0,
  );
  const footerBottomPadding = 16 + bottomNavigationInset;
  const signedIn = useSelector(state => state.authentication.signedIn);
  const passthrough = useSelector(state => state.deeplink.passthrough);
  const dispatch = useDispatch();
  const [loading, setLoading] = useState(false);
  const [postFailed, setPostFailed] = useState(false);
  const [txidCopied, setTxidCopied] = useState(false);
  const [exportResponseHex, setExportResponseHex] = useState(null);
  const [responseCopied, setResponseCopied] = useState(false);
  const txidCopyTimeoutRef = useRef(null);
  const mounted = useRef(true);
  const pending = useRef(null);
  // Capture ownership with the route; an old response cannot adopt a new request.
  const source = useMemo(() => ({
    requestId: store.getState().deeplink.requestId,
    sessionScope: captureSessionScope(store.getState()),
    appEncryptionSessionKey,
  }), [requestBufferString, responseBufferString, appEncryptionSessionKey]);
  const currentSource = useRef(source);
  currentSource.current = source;
  const isCurrent = () => mounted.current && currentSource.current === source &&
    store.getState().deeplink.requestId === source.requestId &&
    sessionScopeIsCurrent(store.getState(), source.sessionScope) &&
    (source.appEncryptionSessionKey == null ||
      source.appEncryptionSessionKey === getAppEncryptionSessionKey(store.getState()));

  useEffect(() => {
    mounted.current = true;
    pending.current = null;
    setLoading(false);
    setPostFailed(false);
    setExportResponseHex(null);
    setResponseCopied(false);
    return () => { mounted.current = false; };
  }, [source]);

  const completeRequest = () => {
    if (!isCurrent()) return;
    const resetAction = CommonActions.reset({
      index: 0,
      routes: [{name: signedIn ? 'SignedInStack' : 'SignedOutStack'}],
    });

    dispatch(resetDeeplinkData(source.requestId));
    props.navigation.dispatch(resetAction);
  };

  const markSavedPendingRequestComplete = async () => {
    const pendingRequestId =
      passthrough?.pendingDeeplinkId;

    if (pendingRequestId) {
      try {
        await markPendingDeeplinkComplete(pendingRequestId);
      } catch (e) {
        console.warn('Unable to mark pending deeplink complete', e);
      }
    }
  };

  const responseNotice = useMemo(() => {
    if (!requestBufferString || !responseBufferString) return null;

    try {
      const request = new GenericRequest();
      request.fromBuffer(Buffer.from(requestBufferString, 'hex'), 0);
      const responseUri = getGenericResponseUri(request.responseURIs || []);
      if (!responseUri) return null;

      if (isPostResponseUri(responseUri)) {
        const url = new URL(responseUri.getUriString());
        const responseLabel = request.hasEncryptResponseToAddress()
          ? "Your encrypted response"
          : "Your response";
        return `${responseLabel} will be sent to ${url.protocol}//${url.host}`;
      }

      if (isRedirectResponseUri(responseUri)) {
        const url = new URL(responseUri.getUriString());
        return `You'll be redirected to ${url.protocol}//${url.host} to finish`;
      }
    } catch (e) {
      return null;
    }

    return null;
  }, [requestBufferString, responseBufferString]);

  const identityUpdateTxid = useMemo(() => {
    if (!responseBufferString) return null;

    try {
      const response = new GenericResponse();
      response.fromBuffer(Buffer.from(responseBufferString, 'hex'), 0);

      if (!response.details || response.details.length === 0) return null;

      for (const detail of response.details) {
        if (!detail || !detail.getIAddressKey || detail.getIAddressKey() !== IDENTITY_UPDATE_RESPONSE_VDXF_KEY.vdxfid) {
          continue;
        }

        if (
          detail.data &&
          typeof detail.data.containsTxid === 'function' &&
          typeof detail.data.getTxidString === 'function' &&
          detail.data.containsTxid()
        ) {
          return detail.data.getTxidString();
        }
      }
    } catch (e) {
      return null;
    }

    return null;
  }, [responseBufferString]);

  const copyTxid = () => {
    if (!identityUpdateTxid) return;

    if (txidCopyTimeoutRef.current) clearTimeout(txidCopyTimeoutRef.current);
    setTxidCopied(true);
    txidCopyTimeoutRef.current = setTimeout(() => {
      setTxidCopied(false);
      txidCopyTimeoutRef.current = null;
    }, 2000);

    Clipboard.setString(identityUpdateTxid);
  };

  const onCancel = async () => {
    const shouldCancel = await createAlert(
      'Cancel response?',
      'If you cancel now, the response will not be sent back to the requester.',
      [
        {
          text: 'Keep trying',
          style: 'cancel',
          onPress: () => resolveAlert(false),
        },
        {
          text: 'Cancel response',
          style: 'destructive',
          onPress: () => resolveAlert(true),
        },
      ],
      { cancelable: true }
    );

    if (shouldCancel) {
      completeRequest();
    }
  };

  useEffect(() => {
    return () => {
      if (txidCopyTimeoutRef.current) clearTimeout(txidCopyTimeoutRef.current);
    };
  }, []);

  const truncate = (value, start = 8, end = 6) => {
    if (!value) return '';
    if (value.length <= start + end + 3) return value;
    return `${value.slice(0, start)}...${value.slice(-end)}`;
  };

  // Recheck ownership after each async step before signing, delivery, or cleanup.
  const onComplete = async () => {
    if (!isCurrent() || pending.current) return;
    pending.current = source;
    const assertActive = () => {
      if (!isCurrent() || pending.current !== source) {
        throw Object.assign(new Error('This request was closed or replaced.'), {code: 'SESSION_CHANGED'});
      }
    };
    try {
      setLoading(true);

      if (exportResponseHex) {
        await markSavedPendingRequestComplete();
        assertActive();
        completeRequest();
        return;
      }

      if (!requestBufferString || !responseBufferString) {
        await markSavedPendingRequestComplete();
        assertActive();
        setLoading(false);
        completeRequest();
        return;
      }

      const request = new GenericRequest();
      request.fromBuffer(Buffer.from(requestBufferString, 'hex'), 0);

      const response = new GenericResponse();
      response.fromBuffer(Buffer.from(responseBufferString, 'hex'), 0);
      const requestContext = {request, sessionScope: source.sessionScope, assertActive};
      assertExperimentalGenericRequestAllowed(request, store.getState());
      const user = getGenericResponseSigner(response);
      const savedResponse = request.hasAppOrDelegatorID() && user
        ? await loadDelegatedResponse(request, user, requestContext)
        : null;
      assertActive();

      if (!savedResponse) {
        await encryptGenericResponseDetails({ request, response });
        assertActive();
        prepareGenericResponseForSigning({
          request,
          response,
          handledBy: VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
        });
      }
      if (response.signature == null) {
        await markSavedPendingRequestComplete();
        assertActive();
        setLoading(false);
        completeRequest();
        return;
      }

      const signerSystemID = response.signature.systemID.toIAddress();
      // Canonical system IDs also resolve registered PBaaS signing chains.
      const coinObj = CoinDirectory.getBasicCoinObj(signerSystemID);

      const signedResponse = savedResponse || await signAfterAuthenticationExpiryCheck(
        request,
        () => {
          assertActive();
          return signGenericResponse(coinObj, response, requestContext);
        },
      );
      assertActive();
      const verification = await verifyGenericResponse(coinObj, signedResponse);
      assertActive();

      if (!verification) {
        throw new Error('Response failed verification, ensure the identity you selected is still under your control.');
      }

      if (!getGenericResponseUri(request.responseURIs)) {
        // Some requests intentionally use manual transfer. Keep the final signed
        // ciphertext available until Done; do not silently discard the result.
        assertExperimentalGenericRequestAllowed(request, store.getState());
        assertNoPlaintextAppEncryptionResponse(signedResponse);
        setExportResponseHex(signedResponse.toBuffer().toString('hex'));
        setLoading(false);
        return;
      }

      if (savedResponse) {
        // Only delivery is retried. A response prepared while authorized keeps
        // its original signed ciphertext even after the request has expired.
        assertExperimentalGenericRequestAllowed(request, store.getState());
        await deliverGenericResponse(request, savedResponse);
      } else {
        await performAfterAuthenticationExpiryCheck(request, () => {
          assertActive();
          assertExperimentalGenericRequestAllowed(request, store.getState());
          return deliverGenericResponse(request, signedResponse);
        });
      }
      assertActive();
      await markSavedPendingRequestComplete();
      assertActive();
    } catch (e) {
      if (!isCurrent() || e.code === 'SESSION_CHANGED') return;
      if (e?.isResponsePostError) {
        setPostFailed(true);
      }

      createAlert('Error', e?.message || 'Failed to complete the request.');
      console.warn(e);
      setLoading(false);
      return;
    } finally {
      if (pending.current === source) pending.current = null;
    }

    completeRequest();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <AnimatedActivityIndicatorBox />
          <Text style={styles.loadingText}>Completing request...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Centered success content */}
      <View style={styles.centerContent}>
        <Text style={styles.mainTitle}>Success</Text>

        <View style={styles.checkmarkContainer}>
          <AnimatedSuccessCheckmark
            style={{ width: 128 }}
          />
        </View>

        {identityUpdateTxid && (
          <View style={styles.txidCard}>
            <TouchableOpacity
              style={styles.txidRow}
              onPress={copyTxid}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Copy transaction ID"
            >
              <Text style={styles.txidLabel}>Identity update txid</Text>
              <View style={styles.txidValueRow}>
                <Text style={styles.txidValue} numberOfLines={1}>
                  {truncate(identityUpdateTxid)}
                </Text>
                {txidCopied ? (
                  <Text style={styles.copiedLabel}>Copied</Text>
                ) : (
                  <MaterialCommunityIcons name="content-copy" size={16} color={Colors.primaryColor} style={{ marginLeft: 6 }} />
                )}
              </View>
            </TouchableOpacity>
          </View>
        )}

        {(responseNotice || exportResponseHex) && (
          <View style={styles.noticeCard}>
            <MaterialCommunityIcons
              name="information-outline"
              size={18}
              color="#666"
              style={{ marginRight: 8, marginTop: 1 }}
            />
            <Text style={styles.noticeText}>
              {exportResponseHex
                ? 'The app did not provide a response destination. Copy the signed response and return it to the app.'
                : responseNotice}
            </Text>
          </View>
        )}
      </View>

      {/* Footer actions */}
      <View style={[styles.footer, {paddingBottom: footerBottomPadding}]}>
        {exportResponseHex && (
          <View style={styles.ctaCol}>
            <Button
              mode="outlined"
              accessibilityLabel="Copy signed response"
              onPress={() => {
                if (!isCurrent()) return;
                try {
                  const request = new GenericRequest();
                  request.fromBuffer(Buffer.from(requestBufferString, 'hex'));
                  assertExperimentalGenericRequestAllowed(request, store.getState());
                  Clipboard.setString(exportResponseHex);
                  setResponseCopied(true);
                } catch (error) {
                  createAlert('Error', error.message || 'Unable to copy response.');
                }
              }}
            >
              {responseCopied ? 'Copied' : 'Copy response'}
            </Button>
          </View>
        )}
        {postFailed && (
          <View style={styles.ctaCol}>
            <Button
              mode="outlined"
              onPress={onCancel}
              style={styles.secondaryCta}
              contentStyle={styles.secondaryCtaContent}
              labelStyle={styles.secondaryCtaLabel}
            >
              Cancel
            </Button>
          </View>
        )}
        <View style={styles.ctaCol}>
          <GradientButton
            onPress={onComplete}
            style={styles.completeButton}
          >
            {exportResponseHex ? 'Done' : 'Complete'}
          </GradientButton>
        </View>
      </View>
    </SafeAreaView>
  );
};

export default GenericRequestComplete;
