import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import {ActivityIndicator, IconButton, Text} from 'react-native-paper';
import {useDispatch} from 'react-redux';
import {GENERIC_REQUEST_DEEPLINK_VDXF_KEY} from 'verus-typescript-primitives';
import {setDeeplinkData} from '../../actions/actionCreators';
import Colors from '../../globals/colors';
import {
  getPendingDeeplinkPassthrough,
  loadPendingDeeplinkRequests,
  PENDING_REQUEST_KIND_SPENDABLE_KEY,
  PENDING_REQUEST_KIND_APP_AUTHORIZATION,
  removePendingDeeplinkRequest,
} from '../../utils/deeplink/pendingDeeplinkStorage';

const MINIMUM_TOUCH_TARGET = 44;

const formatDate = timestamp => {
  if (!timestamp) return null;

  try {
    return new Date(timestamp).toLocaleString();
  } catch (_) {
    return null;
  }
};

const getRequestTitle = request => {
  if (request.title) return request.title;

  if (request.requestKind === PENDING_REQUEST_KIND_SPENDABLE_KEY) {
    return 'Spendable key claim';
  }
  if (request.requestKind === PENDING_REQUEST_KIND_APP_AUTHORIZATION) {
    return 'App authorization';
  }

  return 'Pending request';
};

const ProvisioningDeeplinkList = props => {
  const dispatch = useDispatch();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadRequests = useCallback(async () => {
    setLoading(true);

    try {
      setRequests(await loadPendingDeeplinkRequests());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();

    const unsubscribe = props.navigation.addListener('focus', loadRequests);
    return unsubscribe;
  }, [loadRequests, props.navigation]);

  const openRequest = request => {
    const pendingPassthrough = getPendingDeeplinkPassthrough(request) || {};

    dispatch(
      setDeeplinkData(
        GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid,
        request.requestKind === PENDING_REQUEST_KIND_APP_AUTHORIZATION
          ? {authorizationPendingId: request.id}
          : request.requestBufferString,
        request.fromService || null,
        {
          fqnToAutoLink: request.fqnToAutoLink || null,
          ...pendingPassthrough,
          replayedPendingDeeplink: true,
          skipWalletBackupRequests: true,
        },
      ),
    );

    const parentNavigation =
      props.navigation.getParent?.() ||
      props.navigation.dangerouslyGetParent?.();

    if (parentNavigation) {
      parentNavigation.navigate('DeepLink', {screen: 'VerifyDeepLink'});
    } else {
      props.navigation.navigate('DeepLink', {screen: 'VerifyDeepLink'});
    }
  };

  const confirmRemoveRequest = request => {
    Alert.alert(
      'Remove pending request?',
      request.requestKind === PENDING_REQUEST_KIND_APP_AUTHORIZATION
        ? 'You may no longer be able to continue this saved request. Authorization work already started remains in Activity.'
        : 'You may lose the ability to resume this request if you remove it.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removePendingDeeplinkRequest(request.id);
            await loadRequests();
          },
        },
      ],
      {cancelable: true},
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {loading ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={Colors.primaryColor}
            accessibilityLabel="Loading saved requests" />
        </View>
      ) : requests.length === 0 ? (
        <View style={styles.centerContent}>
          <Text style={styles.emptyTitle}>No pending requests</Text>
          <Text style={styles.emptySubtitle}>
            Saved app authorizations and spendable key claims appear here.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}>
          {requests.map(request => {
            const savedDate = formatDate(request.createdAt);
            const completedDate = formatDate(request.completedAt);
            const title = getRequestTitle(request);
            const status = request.completed ? 'Completed' : 'Pending';
            const savedDescription = request.completed && completedDate
              ? `Completed ${completedDate}`
              : savedDate
              ? `Saved ${savedDate}`
              : 'Saved pending request';

            return (
              <View key={request.id} style={styles.itemRow}>
                <TouchableOpacity
                  style={styles.itemContent}
                  onPress={() => openRequest(request)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`${title}. ${status}. ${savedDescription}`}
                  accessibilityHint="Opens this saved request">
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemTitle}>
                      {title}
                    </Text>
                    <View
                      style={[
                        styles.statusBadge,
                        request.completed && styles.completedBadge,
                      ]}>
                      <Text
                        style={[
                          styles.statusText,
                          request.completed && styles.completedText,
                        ]}>
                        {status}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.itemSubtitle}>{savedDescription}</Text>
                </TouchableOpacity>
                <IconButton
                  icon="close"
                  size={22}
                  iconColor={Colors.verusDarkGray}
                  style={styles.removeButton}
                  accessibilityLabel={`Remove saved ${title}`}
                  accessibilityHint="Asks before removing this saved request"
                  onPress={() => confirmRemoveRequest(request)}
                />
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.secondaryColor,
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyTitle: {
    color: Colors.primaryColor,
    fontSize: 19,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtitle: {
    color: Colors.quaternaryColor,
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.secondaryColor,
    borderColor: '#DCE3EC',
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    minHeight: 78,
  },
  itemContent: {
    flex: 1,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingLeft: 14,
    paddingVertical: 12,
  },
  itemHeader: {
    alignItems: 'flex-start',
  },
  itemTitle: {
    color: Colors.primaryColor,
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  itemSubtitle: {
    color: Colors.quaternaryColor,
    fontSize: 13,
    marginTop: 6,
  },
  statusBadge: {
    backgroundColor: '#FFF5DD',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
  },
  completedBadge: {
    backgroundColor: '#E7F6EF',
  },
  statusText: {
    color: '#8A5B00',
    fontSize: 12,
    fontWeight: '600',
  },
  completedText: {
    color: Colors.quaternaryColor,
  },
  removeButton: {
    width: MINIMUM_TOUCH_TARGET,
    height: MINIMUM_TOUCH_TARGET,
    margin: 6,
  },
});

export default ProvisioningDeeplinkList;
