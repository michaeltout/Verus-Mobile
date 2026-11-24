import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {Alert, SafeAreaView, StyleSheet, View} from 'react-native';
import {ActivityIndicator, List, Text} from 'react-native-paper';
import {createStackNavigator} from '@react-navigation/stack';
import {HeaderBackButton} from '@react-navigation/elements';
import {useSelector} from 'react-redux';
import Button from '../../../components/Button';
import VerusIdDetailsModal from '../../../components/VerusIdDetailsModal/VerusIdDetailsModal';
import Colors from '../../../globals/colors';
import reviewStyles from '../../../styles/deeplink/identityContentReview.styles';
import {
  DetailRow,
  Disclosure,
  RegistrationPage as AuthorizationPage,
  registrationStyles,
} from '../../Services/ServiceComponents/VerusIdService/IdentityRegistration/RegistrationComponents';
import {useAuthorizationIdentities} from '../../../hooks/useAuthorizationIdentities';
import {CoinDirectory} from '../../../utils/CoinData/CoinDirectory';
import {getAppEncryptionSessionKey} from '../../../utils/deeplink/appEncryptionSession';
import {defaultHeaderOptions} from '../../../utils/navigation/header';
import {
  captureAuthorizationContext,
  assertAuthorizationContext,
  refreshAuthorizationJobs,
  AUTHORIZATION_STATUS,
} from '../../../utils/appAuthorization/jobs';
import {loadConnectedApps} from '../../../utils/appAuthorization/connectedApps';
import {revokeAuthorization} from '../../../utils/appAuthorization/workflow';
import {
  addAuthorizationStorageToWallet,
  removeAuthorizationStorageAccess,
} from '../../../utils/appAuthorization/storageManagement';
import {STORAGE_ACCESS_STATE} from '../../../utils/appAuthorization/constants';
import {getFriendlyNameMap} from '../../../utils/api/channels/verusid/requests/getFriendlyNameMap';
import {getIdentity} from '../../../utils/api/channels/verusid/requests/getIdentity';

const Stack = createStackNavigator();
const ManagementContext = createContext(null);
const MIN_TOUCH_TARGET_SIZE = 44;
const STORAGE_STATUS_LABELS = {
  [STORAGE_ACCESS_STATE.SHARED]: 'Storage access remains',
  [STORAGE_ACCESS_STATE.WALLET_ONLY]: 'App access removed',
  [STORAGE_ACCESS_STATE.NEEDS_RECOVERY]: 'Wallet cannot manage this identity',
  [STORAGE_ACCESS_STATE.UNAVAILABLE]: 'Unable to check storage access',
};
const ROUTES = {
  APPS: 'ConnectedApps',
  APP: 'ConnectedApp',
  STORAGE: 'ConnectedAppStorage',
  INSTANCES: 'ConnectedAppInstances',
};

/** One inventory stays mounted as people move from an app to its access settings. */
export default function LinkedAppInstances({navigation}) {
  const sessionKey = useSelector(state =>
    getAppEncryptionSessionKey(state, null),
  );
  const jobs = useSelector(
    state => state.channelStore_verusid?.authorizationJobs,
  );
  const mounted = useRef(true);
  const viewSession = useRef(sessionKey);
  viewSession.current = sessionKey;
  const busy = useRef(null);
  const queuedRefresh = useRef(null);
  const [apps, setApps] = useState([]);
  const [unassignedStorage, setUnassignedStorage] = useState([]);
  const [storageDetails, setStorageDetails] = useState(null);
  const [activity, setActivity] = useState('Loading connected apps…');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState({});
  const context = useMemo(
    () =>
      captureAuthorizationContext({
        assertActive: () => {
          if (!mounted.current || viewSession.current !== sessionKey) {
            throw Object.assign(
              new Error('The profile or management screen changed.'),
              {
                code: 'SESSION_CHANGED',
              },
            );
          }
        },
      }),
    [sessionKey],
  );
  const inventory = useAuthorizationIdentities(context, 0, true);
  const currentInventory = useRef(inventory);
  currentInventory.current = inventory;
  // Service job writes replace the encrypted document too. Only inventory
  // changes should reload this list; navigating within an app never does.
  const inventoryKey = JSON.stringify(inventory);
  const currentInventoryKey = useRef(inventoryKey);
  currentInventoryKey.current = inventoryKey;

  const load = useCallback(
    async function loadInventory(reconcile = false) {
      if (busy.current === context) {
        queuedRefresh.current = {
          context,
          reconcile: reconcile || queuedRefresh.current?.reconcile === true,
        };
        return;
      }
      if (queuedRefresh.current?.context === context) {
        reconcile = reconcile || queuedRefresh.current.reconcile;
        queuedRefresh.current = null;
      }
      const loadedInventoryKey = currentInventoryKey.current;
      const selectedInventory = currentInventory.current;
      busy.current = context;
      setActivity('Loading connected apps…');
      setError(null);
      try {
        if (reconcile) await refreshAuthorizationJobs(context);
        const result = await loadConnectedApps(selectedInventory, context);
        assertAuthorizationContext(context);
        if (loadedInventoryKey !== currentInventoryKey.current) return;
        setApps(result.apps);
        setUnassignedStorage(result.unassignedStorage || []);
        setError(
          result.errors.length
            ? {
                message: result.errors
                  .map(failure => failure.message)
                  .join('\n\n'),
                blocksRemoval: result.errors.some(
                  failure => failure.blocksRemoval,
                ),
              }
            : null,
        );
      } catch (failure) {
        if (
          mounted.current &&
          viewSession.current === sessionKey &&
          loadedInventoryKey === currentInventoryKey.current &&
          failure.code !== 'SESSION_CHANGED'
        ) {
          setError({
            message: failure.message || 'Unable to load connected apps.',
            blocksRemoval: true,
          });
        }
      } finally {
        if (busy.current === context) {
          busy.current = null;
          if (mounted.current && viewSession.current === sessionKey) {
            setActivity(null);
            if (
              queuedRefresh.current?.context === context ||
              loadedInventoryKey !== currentInventoryKey.current
            ) {
              // An inventory refresh that arrived during the read must not be
              // lost, and results for that earlier inventory stay off screen.
              void loadInventory();
            }
          }
        }
      }
    },
    [context, sessionKey],
  );

  useEffect(() => {
    mounted.current = true;
    setApps([]);
    setUnassignedStorage([]);
    setStorageDetails(null);
    setMessage(null);
    setError(null);
    setPending({});
    return () => {
      mounted.current = false;
    };
  }, [context]);

  useEffect(() => {
    load();
  }, [load, inventoryKey]);

  useEffect(() => {
    const completed = Object.keys(pending).filter(
      key => jobs?.[pending[key]]?.status === AUTHORIZATION_STATUS.COMPLETE,
    );
    if (!completed.length) return;
    setPending(previous =>
      Object.fromEntries(
        Object.entries(previous).filter(([key]) => !completed.includes(key)),
      ),
    );
    setMessage(null);
    // A later handshake may reuse the same D or S. Its row must not inherit
    // an earlier completed removal's waiting state.
    load();
  }, [jobs, pending, load]);

  const performAction = async (key, label, action, completedMessage) => {
    if (busy.current === context || pending[key] || error?.blocksRemoval)
      return;
    let submitted = false;
    try {
      assertAuthorizationContext(context);
      busy.current = context;
      setActivity(label);
      setMessage(null);
      setError(null);
      const result = await action();
      assertAuthorizationContext(context);
      if (result.pending) {
        setPending(previous => ({...previous, [key]: result.jobId}));
        setMessage(
          'Removal submitted. You can leave this screen while it confirms. Refresh to check its status.',
        );
      } else {
        setMessage(completedMessage);
      }
      submitted = true;
    } catch (failure) {
      if (
        mounted.current &&
        viewSession.current === sessionKey &&
        failure.code !== 'SESSION_CHANGED'
      ) {
        setError({
          message:
            failure.message ||
            'Unable to update app access. Please refresh and try again.',
        });
      }
    } finally {
      if (busy.current === context) {
        busy.current = null;
        if (mounted.current && viewSession.current === sessionKey) {
          setActivity(null);
          // Begin the refresh after releasing this operation, so its cleanup
          // cannot clear the busy state of an inventory read already in flight.
          if (submitted) void load();
        }
      }
    }
  };

  const removeInstance = (app, instance) => {
    const key = `${app.key}:${instance.key}`;
    if (busy.current === context || pending[key] || error?.blocksRemoval)
      return;
    Alert.alert(
      'Revoke this app instance?',
      `${instance.title} will no longer be approved to represent ${app.title} in wallet requests. Other instances stay approved. Shared storage access is managed separately.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Revoke instance',
          style: 'destructive',
          onPress: () =>
            performAction(
              key,
              'Revoking app instance…',
              () =>
                revokeAuthorization(
                  instance.users[0],
                  app.appID,
                  instance.delegateID,
                  {
                    ...context,
                    relatedUsers: instance.users,
                  },
                ),
              'This app instance is no longer approved.',
            ),
        },
      ],
    );
  };

  const removeStorage = storage => {
    // Taking back S removes every app's access, including rows under other apps.
    const key = `storage:${storage.key}`;
    if (
      busy.current === context ||
      pending[key] ||
      error?.blocksRemoval ||
      !storage.users.length
    )
      return;
    Alert.alert(
      'Remove app access?',
      `${storage.title} will become fully controlled by your wallet and appear in your linked identities after confirmation. All apps using this storage will lose signing access, and approvals that depend on it will be removed. Previously shared data cannot be taken back.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove app access',
          style: 'destructive',
          onPress: () =>
            performAction(
              key,
              'Removing storage access…',
              () =>
                removeAuthorizationStorageAccess(
                  storage.users[0],
                  {
                    storageIDs: [storage.storageID],
                  },
                  {...context, relatedUsers: storage.users},
                ),
              'App access is removed. The identity is now linked to your wallet.',
            ),
        },
      ],
    );
  };

  const addStorageToWallet = storage => {
    if (!storage.users.length) return;
    // This action only links an identity after a fresh ownership check. It
    // never falls back to submitting a removal transaction if access changed.
    return performAction(
      `storage:${storage.key}`,
      'Adding identity to wallet…',
      () =>
        addAuthorizationStorageToWallet(
          storage.users[0],
          {storageIDs: [storage.storageID]},
          {...context, relatedUsers: storage.users},
        ),
      'The identity is now linked to your wallet. No transaction was needed.',
    );
  };

  const manageStorage = storage => {
    try {
      assertAuthorizationContext(context);
      const chain = CoinDirectory.getBasicCoinObj(storage.storageSystemID).id;
      const params = {
        screen: 'IdentityModify',
        params: {
          chain,
          identityAddress: storage.storageID,
          displayName: storage.title,
        },
      };
      if (navigation.getState()?.routeNames.includes('IdentityManagement')) {
        navigation.navigate('IdentityManagement', params);
      } else {
        navigation.navigate('SignedInStack', {
          screen: 'MainStack',
          params: {
            screen: 'Home',
            params: {
              screen: 'ServicesHome',
              params: {screen: 'IdentityManagement', params},
            },
          },
        });
      }
    } catch (failure) {
      if (failure.code !== 'SESSION_CHANGED') {
        setError({
          message: failure.message || 'Unable to open storage identity.',
        });
      }
    }
  };

  const viewStorage = storage => {
    assertAuthorizationContext(context);
    let identity;
    setStorageDetails({
      visible: true,
      animationType: 'slide',
      cancel: () => setStorageDetails(null),
      loadVerusId: async () => {
        assertAuthorizationContext(context);
        const response = await getIdentity(
          storage.storageSystemID,
          storage.storageID,
        );
        assertAuthorizationContext(context);
        if (response.error) throw new Error(response.error.message);
        identity = response.result;
        return identity;
      },
      // The existing modal loads names after the definition. Reuse that read;
      // viewing ownership must work even when this wallet cannot update it.
      loadFriendlyNames: async () => {
        assertAuthorizationContext(context);
        const names = await getFriendlyNameMap(
          storage.storageSystemID,
          identity,
        );
        assertAuthorizationContext(context);
        return names;
      },
    });
  };

  const management = {
    apps,
    unassignedStorage,
    activity,
    error,
    message,
    pending,
    actionsDisabled: !!activity || !!error?.blocksRemoval,
    refresh: () => load(true),
    removeInstance,
    removeStorage,
    addStorageToWallet,
    manageStorage,
    viewStorage,
  };

  return (
    <ManagementContext.Provider value={management}>
      <Stack.Navigator
        key={sessionKey}
        screenOptions={props => ({
          ...defaultHeaderOptions(props),
          headerBackTitleVisible: false,
          headerRight: () => null,
        })}>
        <Stack.Screen
          name={ROUTES.APPS}
          component={ConnectedAppsList}
          options={{
            title: 'Connected Apps',
            headerLeft: navigation.canGoBack?.()
              ? props => (
                  <HeaderBackButton
                    {...props}
                    onPress={() => navigation.goBack()}
                  />
                )
              : undefined,
          }}
        />
        <Stack.Screen
          name={ROUTES.APP}
          component={ConnectedAppMenu}
          options={{title: 'App access'}}
        />
        <Stack.Screen
          name={ROUTES.STORAGE}
          component={ConnectedAppStorage}
          options={{title: 'Storage identities'}}
        />
        <Stack.Screen
          name={ROUTES.INSTANCES}
          component={ConnectedAppInstances}
          options={{title: 'App instances'}}
        />
      </Stack.Navigator>
      {storageDetails && <VerusIdDetailsModal {...storageDetails} />}
    </ManagementContext.Provider>
  );
}

/** Reuse registration's errors, scroll-to-error behavior and pull-to-refresh. */
function ManagementPage({children}) {
  const {activity, error, message, refresh} = useContext(ManagementContext);
  return (
    <SafeAreaView style={styles.root}>
      <AuthorizationPage
        error={error}
        refreshing={!!activity}
        onRefresh={refresh}
        refreshLabel="Refresh app access">
        {activity && (
          <View
            style={registrationStyles.row}
            accessibilityState={{busy: true}}>
            <ActivityIndicator color={Colors.primaryColor} accessible={false} />
            <Text
              accessibilityLiveRegion="polite"
              style={registrationStyles.muted}>
              {activity}
            </Text>
          </View>
        )}
        {message && (
          <View style={registrationStyles.notice}>
            <Text
              accessibilityLiveRegion="polite"
              style={registrationStyles.body}>
              {message}
            </Text>
          </View>
        )}
        {children}
        {(error || message) && (
          <Button
            mode="outlined"
            contentStyle={styles.buttonContent}
            disabled={!!activity}
            onPress={refresh}>
            Refresh
          </Button>
        )}
      </AuthorizationPage>
    </SafeAreaView>
  );
}

function appApprovalLabel(app) {
  if (!app.instances.length) {
    return app.approvalUnknown
      ? 'Approval status unavailable'
      : 'No active approval';
  }
  return `${app.instances.length} app ${
    app.instances.length === 1 ? 'instance' : 'instances'
  }`;
}

function ConnectedAppsList({navigation}) {
  const {apps, unassignedStorage, activity, error} =
    useContext(ManagementContext);
  return (
    <ManagementPage>
      <Text accessibilityRole="header" style={registrationStyles.title}>
        Connected Apps
      </Text>
      <Text style={registrationStyles.body}>
        Manage the apps you have connected to this wallet.
      </Text>
      {apps.length > 0 ? (
        <View style={styles.list}>
          {apps.map(app => (
            <List.Item
              key={app.key}
              title={app.title}
              titleStyle={registrationStyles.subtitle}
              titleNumberOfLines={2}
              description={`${appApprovalLabel(app)}${
                app.storage.length
                  ? ` · ${app.storage.length} storage ${
                      app.storage.length === 1 ? 'identity' : 'identities'
                    }`
                  : ''
              }`}
              descriptionStyle={registrationStyles.muted}
              descriptionNumberOfLines={2}
              accessibilityRole="button"
              accessibilityLabel={`Manage ${app.title}`}
              accessibilityHint="Shows this app’s storage identities and authorized instances."
              disabled={!!activity}
              right={props => <List.Icon {...props} icon="chevron-right" />}
              onPress={() => navigation.navigate(ROUTES.APP, {appKey: app.key})}
            />
          ))}
        </View>
      ) : !activity && !error && !unassignedStorage.length ? (
        <Text style={registrationStyles.muted}>
          No connected apps. Apps appear here after you approve an authorization
          request.
        </Text>
      ) : null}
      {unassignedStorage.length > 0 && (
        <>
          <Text accessibilityRole="header" style={registrationStyles.subtitle}>
            Storage to review
          </Text>
          <Text style={registrationStyles.body}>
            These storage identities are saved in this wallet, but their app
            information is unavailable. Open one to review its access.
          </Text>
          <View style={styles.list}>
            {unassignedStorage.map(storage => (
              <List.Item
                key={storage.key}
                title={storage.title}
                titleStyle={registrationStyles.subtitle}
                titleNumberOfLines={2}
                description={STORAGE_STATUS_LABELS[storage.status]}
                descriptionStyle={registrationStyles.muted}
                descriptionNumberOfLines={2}
                accessibilityRole="button"
                disabled={!!activity}
                right={props => <List.Icon {...props} icon="chevron-right" />}
                onPress={() =>
                  navigation.navigate(ROUTES.STORAGE, {storageKey: storage.key})
                }
              />
            ))}
          </View>
        </>
      )}
    </ManagementPage>
  );
}

function ConnectedAppMenu({route, navigation}) {
  const {apps, activity} = useContext(ManagementContext);
  const app = apps.find(item => item.key === route.params.appKey);
  return (
    <ManagementPage>
      {app ? (
        <>
          <Text accessibilityRole="header" style={registrationStyles.title}>
            {app.title}
          </Text>
          {!app.instances.length && (
            <View style={registrationStyles.notice}>
              <Text style={registrationStyles.subtitle}>
                {appApprovalLabel(app)}
              </Text>
              <Text style={registrationStyles.body}>
                {app.approvalUnknown
                  ? 'Refresh to check this app’s approvals. You can still review its saved storage identities.'
                  : 'No app instances are approved to represent this app. Storage access is managed separately and may still remain.'}
              </Text>
            </View>
          )}
          <View style={styles.list}>
            {app.storage.length > 0 && (
              <List.Item
                title="Storage identities"
                titleStyle={registrationStyles.subtitle}
                description={`${app.storage.length} storage ${
                  app.storage.length === 1 ? 'identity' : 'identities'
                }`}
                descriptionStyle={registrationStyles.muted}
                accessibilityRole="button"
                disabled={!!activity}
                right={props => <List.Icon {...props} icon="chevron-right" />}
                onPress={() =>
                  navigation.navigate(ROUTES.STORAGE, {appKey: app.key})
                }
              />
            )}
            <List.Item
              title="App instances"
              titleStyle={registrationStyles.subtitle}
              description={
                app.approvalUnknown && !app.instances.length
                  ? 'Approval status unavailable'
                  : `${app.instances.length} authorized`
              }
              descriptionStyle={registrationStyles.muted}
              accessibilityRole="button"
              disabled={!!activity}
              right={props => <List.Icon {...props} icon="chevron-right" />}
              onPress={() =>
                navigation.navigate(ROUTES.INSTANCES, {appKey: app.key})
              }
            />
          </View>
          <Disclosure title="App details">
            <DetailRow label="App identity">{app.appID}</DetailRow>
          </Disclosure>
        </>
      ) : (
        <Text style={registrationStyles.body}>
          This app no longer has connected access.
        </Text>
      )}
    </ManagementPage>
  );
}

function ConnectedAppInstances({route}) {
  const {apps, actionsDisabled, pending, removeInstance} =
    useContext(ManagementContext);
  const app = apps.find(item => item.key === route.params.appKey);
  return (
    <ManagementPage>
      <Text accessibilityRole="header" style={registrationStyles.title}>
        App instances
      </Text>
      {app?.instances.length ? (
        <>
          <Text style={registrationStyles.body}>
            These instances represent {app.title} when they send requests to
            your wallet.
          </Text>
          {app.instances.map(instance => {
            const waiting = pending[`${app.key}:${instance.key}`];
            return (
              <View key={instance.key} style={registrationStyles.card}>
                <Text selectable style={registrationStyles.subtitle}>
                  {instance.title}
                </Text>
                <Disclosure title="Instance details">
                  <DetailRow label="Delegate identity">
                    {instance.delegateID}
                  </DetailRow>
                  <DetailRow label="Approved by">
                    {instance.users
                      .map(user => user.title || user.identityID)
                      .join('\n')}
                  </DetailRow>
                </Disclosure>
                {waiting && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={registrationStyles.muted}>
                    Waiting for confirmation
                  </Text>
                )}
                <Button
                  mode="outlined"
                  contentStyle={styles.buttonContent}
                  labelStyle={reviewStyles.removalText}
                  accessibilityLabel={`Revoke ${instance.title}`}
                  disabled={actionsDisabled || !!waiting}
                  onPress={() => removeInstance(app, instance)}>
                  Revoke instance
                </Button>
              </View>
            );
          })}
        </>
      ) : (
        <Text style={registrationStyles.body}>
          {app?.approvalUnknown
            ? 'Unable to check app approvals. Refresh to try again.'
            : 'No authorized app instances.'}
        </Text>
      )}
    </ManagementPage>
  );
}

function ConnectedAppStorage({route}) {
  const {
    apps,
    unassignedStorage,
    activity,
    actionsDisabled,
    pending,
    removeStorage,
    addStorageToWallet,
    manageStorage,
    viewStorage,
    refresh,
  } = useContext(ManagementContext);
  const app = apps.find(item =>
    route.params.storageKey
      ? item.storage.some(storage => storage.key === route.params.storageKey)
      : item.key === route.params.appKey,
  );
  // A refresh may resolve an unknown app association. Keep the open review
  // attached to the same storage identity when it moves into an app's group.
  const selectedStorage =
    route.params.storageKey &&
    [...(app?.storage || []), ...unassignedStorage].find(
      item => item.key === route.params.storageKey,
    );
  const storageIdentities = route.params.storageKey
    ? selectedStorage
      ? [selectedStorage]
      : []
    : app?.storage || [];
  return (
    <ManagementPage>
      <Text accessibilityRole="header" style={registrationStyles.title}>
        Storage identities
      </Text>
      {storageIdentities.length ? (
        <>
          <Text style={registrationStyles.body}>
            {app
              ? `Storage used with ${app.title}. App approvals and storage access are managed separately.`
              : 'Review this identity’s access before adding it to your wallet.'}
          </Text>
          {storageIdentities.map(storage => {
            const waiting = pending[`storage:${storage.key}`];
            const walletOnly =
              storage.status === STORAGE_ACCESS_STATE.WALLET_ONLY;
            const shared = storage.status === STORAGE_ACCESS_STATE.SHARED;
            const unavailable =
              storage.status === STORAGE_ACCESS_STATE.UNAVAILABLE;
            const hasOwner = storage.users.length > 0;
            const canAdd =
              hasOwner && walletOnly && storage.hasCredentials === false;
            const canRemove =
              hasOwner && (shared || (walletOnly && storage.hasCredentials));
            const needsManagement = !canAdd && !canRemove;
            return (
              <View key={storage.key} style={registrationStyles.card}>
                <Text selectable style={registrationStyles.subtitle}>
                  {storage.title}
                </Text>
                <Text style={registrationStyles.subtitle}>
                  {STORAGE_STATUS_LABELS[storage.status]}
                </Text>
                <Text style={registrationStyles.body}>
                  {unavailable
                    ? 'Refresh to check storage access, or view the identity to inspect its current ownership.'
                    : storage.status === STORAGE_ACCESS_STATE.NEEDS_RECOVERY
                    ? 'This wallet cannot currently take full control of this identity. View its signing keys and recovery identity to find which wallet can manage it.'
                    : !hasOwner
                    ? 'The managing user identity could not be found in this wallet. View the identity’s signing keys to find the wallet that manages it.'
                    : canAdd
                    ? 'Only your wallet can sign for this identity. Add it to your wallet without a transaction or fee.'
                    : walletOnly
                    ? 'Only your wallet can sign for this identity. Remove the remaining app records to add it to your wallet.'
                    : 'Other keys can still sign for this identity, even if its app approval was revoked. Remove app access to take full ownership and add it to your wallet.'}
                </Text>
                <Disclosure title="Storage details">
                  <DetailRow label="Storage identity">
                    {storage.storageID}
                  </DetailRow>
                  {hasOwner && (
                    <DetailRow label="Managed by">
                      {storage.users
                        .map(user => user.title || user.identityID)
                        .join('\n')}
                    </DetailRow>
                  )}
                  {!needsManagement && (
                    <Button
                      mode="outlined"
                      contentStyle={styles.buttonContent}
                      disabled={!!activity}
                      onPress={() => manageStorage(storage)}>
                      Manage identity
                    </Button>
                  )}
                </Disclosure>
                {waiting && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={registrationStyles.muted}>
                    Waiting for confirmation
                  </Text>
                )}
                {canRemove && (
                  <Button
                    mode="outlined"
                    contentStyle={styles.buttonContent}
                    labelStyle={reviewStyles.removalText}
                    accessibilityLabel={`Remove app access to ${storage.title}`}
                    disabled={actionsDisabled || !!waiting}
                    onPress={() => removeStorage(storage)}>
                    Remove app access
                  </Button>
                )}
                {canAdd && (
                  <Button
                    mode="contained"
                    contentStyle={styles.buttonContent}
                    disabled={actionsDisabled || !!waiting}
                    onPress={() => addStorageToWallet(storage)}>
                    Add to wallet
                  </Button>
                )}
                {unavailable && (
                  <Button
                    mode="outlined"
                    contentStyle={styles.buttonContent}
                    disabled={!!activity}
                    onPress={refresh}>
                    Refresh
                  </Button>
                )}
                {needsManagement && (
                  <Button
                    mode="outlined"
                    contentStyle={styles.buttonContent}
                    disabled={!!activity}
                    onPress={() => viewStorage(storage)}>
                    View identity
                  </Button>
                )}
              </View>
            );
          })}
        </>
      ) : (
        <Text style={registrationStyles.body}>
          No shared storage. Identities you take back appear in your wallet.
        </Text>
      )}
    </ManagementPage>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  list: {
    borderWidth: 1,
    borderColor: '#e3e7ed',
    borderRadius: 18,
    overflow: 'hidden',
  },
  buttonContent: {minHeight: MIN_TOUCH_TARGET_SIZE},
});
