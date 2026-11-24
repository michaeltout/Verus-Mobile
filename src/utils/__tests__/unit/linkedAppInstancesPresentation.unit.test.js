let mockState;
let mockInventory;
let mockInnerNavigation;
const mockLoadConnectedApps = jest.fn();
const mockRevoke = jest.fn();
const mockRemoveStorageAccess = jest.fn();
const mockAddToWallet = jest.fn();
const mockGetIdentity = jest.fn();
const mockFriendlyNames = jest.fn();
const mockScrollTo = jest.fn();
const mockRefreshJobs = jest.fn();
const mockParentBack = jest.fn();
const mockParentNavigate = jest.fn();

jest.mock('react-native', () => ({
  SafeAreaView: 'SafeAreaView',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  RefreshControl: 'RefreshControl',
  Keyboard: {dismiss: jest.fn()},
  Platform: {OS: 'ios'},
  StyleSheet: {create: value => value, hairlineWidth: 1},
  Alert: {alert: jest.fn()},
}));
jest.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  List: {
    Item: props => require('react').createElement('ListItem', props,
      require('react').createElement('Text', null, props.title),
      require('react').createElement('Text', null, props.description)),
    Icon: 'ListIcon',
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({bottom: 20}),
}));
jest.mock('@react-navigation/elements', () => ({
  useHeaderHeight: () => 96,
  HeaderBackButton: 'HeaderBackButton',
}));
jest.mock('@react-navigation/stack', () => ({
  createStackNavigator: () => {
    const React = require('react');
    const Navigator = ({children, initialRouteName, screenOptions}) => {
      const screens = React.Children.toArray(children);
      const [routes, setRoutes] = React.useState([
        {name: initialRouteName || screens[0].props.name, params: {}},
      ]);
      const route = routes[routes.length - 1];
      const navigation = {
        navigate: (name, params) => setRoutes(current => [...current, {name, params}]),
        push: (name, params) => setRoutes(current => [...current, {name, params}]),
        goBack: () => setRoutes(current => current.slice(0, -1)),
        canGoBack: () => routes.length > 1,
        getState: () => ({routes, index: routes.length - 1}),
        setOptions: jest.fn(),
      };
      mockInnerNavigation = navigation;
      const selected = screens.find(screen => screen.props.name === route.name);
      const options = {
        ...(typeof screenOptions === 'function'
          ? screenOptions({route, navigation}) : screenOptions),
        ...(typeof selected.props.options === 'function'
          ? selected.props.options({route, navigation}) : selected.props.options),
      };
      const body = selected.props.component
        ? React.createElement(selected.props.component, {route, navigation})
        : selected.props.children({route, navigation});
      return React.createElement('Navigator', {route, options},
        options.headerLeft?.({canGoBack: navigation.canGoBack()}), body);
    };
    return {Navigator, Screen: () => null};
  },
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('react-redux', () => ({
  useSelector: selector => selector(mockState),
}));
jest.mock('../../../components/Button', () => 'Button');
jest.mock('../../../components/VerusIdDetailsModal/VerusIdDetailsModal', () => 'VerusIdDetailsModal');
jest.mock('../../../hooks/useAuthorizationIdentities', () => ({
  useAuthorizationIdentities: () => mockInventory,
}));
jest.mock('../../navigation/header', () => ({defaultHeaderOptions: () => ({})}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {getBasicCoinObj: () => ({id: 'VRSCTEST'})},
}));
jest.mock('../../deeplink/appEncryptionSession', () => ({
  getAppEncryptionSessionKey: state => state.authentication.sessionEpoch,
}));
jest.mock('../../appAuthorization/jobs', () => ({
  AUTHORIZATION_STATUS: require('../../appAuthorization/constants').AUTHORIZATION_STATUS,
  refreshAuthorizationJobs: (...args) => mockRefreshJobs(...args),
  captureAuthorizationContext: options => ({
    ...options,
    epoch: mockState.authentication.sessionEpoch,
  }),
  assertAuthorizationContext: context => {
    if (context.epoch !== mockState.authentication.sessionEpoch) {
      throw Object.assign(new Error('Session changed'), {code: 'SESSION_CHANGED'});
    }
    context.assertActive?.();
  },
}));
jest.mock('../../appAuthorization/connectedApps', () => ({
  loadConnectedApps: (...args) => mockLoadConnectedApps(...args),
}));
jest.mock('../../appAuthorization/workflow', () => ({
  revokeAuthorization: (...args) => mockRevoke(...args),
}));
jest.mock('../../appAuthorization/storageManagement', () => ({
  addAuthorizationStorageToWallet: (...args) => mockAddToWallet(...args),
  removeAuthorizationStorageAccess: (...args) => mockRemoveStorageAccess(...args),
}));
jest.mock('../../api/channels/verusid/requests/getIdentity', () => ({
  getIdentity: (...args) => mockGetIdentity(...args),
}));
jest.mock('../../api/channels/verusid/requests/getFriendlyNameMap', () => ({
  getFriendlyNameMap: (...args) => mockFriendlyNames(...args),
}));

const React = require('react');
const {act, create} = require('react-test-renderer');
const {Alert, Keyboard} = require('react-native');
const {STORAGE_ACCESS_STATE} = require('../../appAuthorization/constants');
const LinkedAppInstances =
  require('../../../containers/DeepLink/LinkedAppInstances/LinkedAppInstances').default;
const {
  registrationStyles,
} = require('../../../containers/Services/ServiceComponents/VerusIdService/IdentityRegistration/RegistrationComponents');

const users = [
  {identityID: 'user-one', systemID: 'system', title: 'My first ID@'},
  {identityID: 'user-two', systemID: 'system', title: 'My other ID@'},
];
const appID = 'notes-app';
const delegateIDs = ['notes-desktop', 'notes-laptop'];
const storageIDs = ['storage-one', 'storage-two'];
const storageDefinition = {
  fullyqualifiedname: 'Notes storage 1.VRSCTEST@',
  status: 'revoked',
  cansignfor: false,
  canspendfor: false,
  identity: {
    identityaddress: storageIDs[0],
    primaryaddresses: ['external-signing-key'],
    recoveryauthority: 'external-recovery-id',
    revocationauthority: 'external-revocation-id',
  },
};
const app = {
  key: `system:${appID}`,
  appID,
  systemID: 'system',
  title: 'Shared Notes@',
  approvalUnknown: false,
  instances: delegateIDs.map((delegateID, index) => ({
    key: `system:${delegateID}`,
    delegateID,
    title: `Notes instance ${index + 1}@`,
    users: index === 0 ? users : [users[1]],
  })),
  storage: storageIDs.map((storageID, index) => ({
    key: `system:${storageID}`,
    storageID,
    storageSystemID: 'system',
    status: STORAGE_ACCESS_STATE.SHARED,
    hasCredentials: true,
    title: `Notes storage ${index + 1}@`,
    users: index === 0 ? users : [users[1]],
  })),
};
let view;
const textContent = node => typeof node === 'string'
  ? node : (node.children || []).map(textContent).join('');
const button = label => view.root.findAllByType('Button')
  .find(node => node.props.children === label);
const row = title => view.root.findAllByType('ListItem')
  .find(node => node.props.title === title);
const screen = () => (
  <LinkedAppInstances
    route={{params: {user: users[0]}}}
    navigation={{
      goBack: mockParentBack,
      navigate: mockParentNavigate,
      canGoBack: () => true,
      getState: () => ({routeNames: ['IdentityManagement']}),
    }}
  />
);
const mount = async () => {
  await act(async () => {
    view = create(screen(), {
      createNodeMock: element => element.type === 'ScrollView'
        ? {scrollTo: mockScrollTo} : null,
    });
  });
};
const open = async title => {
  expect(row(title)).toBeDefined();
  await act(async () => row(title).props.onPress());
};
const openCategory = async title => {
  await open(app.title);
  await open(title);
};
const confirm = async label => {
  act(() => button(label).props.onPress());
  const options = Alert.alert.mock.calls.at(-1)[2];
  await act(async () => options.find(option => option.style === 'destructive').onPress());
};
const refresh = async () => {
  await act(async () => view.root.findByType('ScrollView')
    .props.refreshControl.props.onRefresh());
};
const showRetainedStorage = async changes => {
  mockLoadConnectedApps.mockResolvedValue({
    apps: [{...app, instances: [], storage: [{...app.storage[0], ...changes}]}],
    errors: [],
    unassignedStorage: [],
  });
  await mount();
  await openCategory('Storage identities');
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    authentication: {sessionEpoch: 1},
    channelStore_verusid: {authorizationJobs: {}},
  };
  mockInventory = users.map(user => ({
    ...user, key: `${user.systemID}:${user.identityID}`, isStorage: false,
  }));
  mockLoadConnectedApps.mockReset().mockResolvedValue({apps: [app], errors: [], unassignedStorage: []});
  mockRefreshJobs.mockReset().mockResolvedValue({});
  mockRevoke.mockReset().mockResolvedValue({pending: true, jobId: 'revoke-job'});
  mockRemoveStorageAccess.mockReset().mockResolvedValue({pending: true, jobId: 'storage-job'});
  mockAddToWallet.mockReset().mockResolvedValue({pending: false});
  mockGetIdentity.mockReset().mockResolvedValue({result: storageDefinition, error: null});
  mockFriendlyNames.mockReset().mockResolvedValue({[storageIDs[0]]: 'Notes storage 1@'});
});
afterEach(() => {
  if (view) act(() => view.unmount());
  view = null;
  jest.restoreAllMocks();
});

test('starts with apps, then separates storage and instances without choosing a user ID', async () => {
  await mount();
  expect(view.root.findAllByType('ListItem')).toHaveLength(1);
  expect(row(app.title)).toBeDefined();
  expect(textContent(view.root)).not.toContain('Choose identity');
  expect(textContent(view.root)).not.toContain('My first ID@');
  expect(button('Revoke instance')).toBeUndefined();
  expect(button('Remove app access')).toBeUndefined();
  expect(button('Refresh')).toBeUndefined();
  expect(view.root.findByType('ScrollView').props.accessibilityActions)
    .toContainEqual({name: 'refresh', label: 'Refresh app access'});

  await open(app.title);
  expect(row('Storage identities')).toBeDefined();
  expect(row('App instances')).toBeDefined();
  expect(button('Refresh')).toBeUndefined();
  await open('App instances');
  expect(textContent(view.root)).toContain('Notes instance 1@');
  expect(textContent(view.root)).toContain('Notes instance 2@');
  expect(button('Remove app access')).toBeUndefined();
  act(() => mockInnerNavigation.goBack());
  expect(row('Storage identities')).toBeDefined();
  await open('Storage identities');
  expect(textContent(view.root)).toContain('Notes storage 1@');
  expect(textContent(view.root)).toContain('Notes storage 2@');
  expect(button('Revoke instance')).toBeUndefined();
  expect(mockLoadConnectedApps).toHaveBeenCalledTimes(1);
});

test('omits storage navigation when an app has no storage identities', async () => {
  mockLoadConnectedApps.mockResolvedValue({apps: [{...app, storage: []}], errors: [], unassignedStorage: []});
  await mount();
  await open(app.title);
  expect(row('Storage identities')).toBeUndefined();
  expect(row('App instances')).toBeDefined();
});

test('load failures use the registration error and scroll it into view', async () => {
  mockLoadConnectedApps.mockRejectedValue(new Error('Unable to read encrypted app approvals.'));
  await mount();
  const scroll = view.root.findByType('ScrollView');
  const alert = scroll.findByProps({accessibilityRole: 'alert'});
  expect(alert).toBe(scroll.children[0]);
  expect(alert.props.style).toEqual([registrationStyles.notice, registrationStyles.error]);
  expect(textContent(alert)).toBe('Unable to read encrypted app approvals.');
  expect(textContent(view.root)).not.toContain('No connected apps');
  expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
  expect(mockScrollTo).toHaveBeenCalledWith({y: 0, animated: true});
  expect(button('Refresh')).toBeDefined();

  mockLoadConnectedApps.mockResolvedValue({apps: [app], errors: [], unassignedStorage: []});
  await act(async () => button('Refresh').props.onPress());
  expect(row(app.title)).toBeDefined();
  expect(button('Refresh')).toBeUndefined();
  expect(view.root.findAllByProps({accessibilityRole: 'alert'})).toHaveLength(0);
});

test('partial discovery failures remain visible alongside successfully loaded apps', async () => {
  mockLoadConnectedApps.mockResolvedValue({
    apps: [app], errors: [{message: 'Could not read another linked identity.'}], unassignedStorage: [],
  });
  await mount();
  expect(row(app.title)).toBeDefined();
  expect(textContent(view.root.findByProps({accessibilityRole: 'alert'})))
    .toContain('Could not read another linked identity.');
});

test.each([
  [true, 'Could not read another linked identity.'],
  [false, 'An app identity name could not be resolved.'],
])('partial discovery with blocksRemoval=%s preserves browsing and applies action restrictions', async (blocksRemoval, message) => {
  mockLoadConnectedApps.mockResolvedValue({
    apps: [app], errors: [{message, blocksRemoval}], unassignedStorage: [],
  });
  await mount();
  await openCategory('App instances');
  expect(button('Revoke instance').props.disabled).toBe(blocksRemoval);
  act(() => button('Revoke instance').props.onPress());
  expect(Alert.alert).toHaveBeenCalledTimes(blocksRemoval ? 0 : 1);

  act(() => mockInnerNavigation.goBack());
  await open('Storage identities');
  expect(button('Remove app access').props.disabled).toBe(blocksRemoval);
  act(() => button('Remove app access').props.onPress());
  expect(Alert.alert).toHaveBeenCalledTimes(blocksRemoval ? 0 : 2);
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
});

test('a failed refresh keeps known apps browsable but blocks removal from stale inventory', async () => {
  await mount();
  await openCategory('App instances');
  mockLoadConnectedApps.mockRejectedValueOnce(new Error('Connection interrupted.'));
  await refresh();
  expect(textContent(view.root)).toContain('Notes instance 1@');
  expect(button('Revoke instance').props.disabled).toBe(true);
  act(() => button('Revoke instance').props.onPress());
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test.each([
  ['App instances', 'Revoke instance', mockRevoke],
  ['Storage identities', 'Remove app access', mockRemoveStorageAccess],
])('requires confirmation before %s changes, and cancelling does nothing', async (category, label) => {
  await mount();
  await openCategory(category);
  act(() => button(label).props.onPress());
  const actions = Alert.alert.mock.calls.at(-1)[2];
  const cancel = actions.find(action => action.style === 'cancel');
  expect(cancel).toBeDefined();
  await act(async () => cancel.onPress?.());
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
});

test('revokes one delegate across its approving identities without touching storage or sibling delegates', async () => {
  await mount();
  await openCategory('App instances');
  await confirm('Revoke instance');
  expect(mockRevoke).toHaveBeenCalledTimes(1);
  expect(mockRevoke).toHaveBeenCalledWith(
    users[0], appID, delegateIDs[0],
    expect.objectContaining({assertActive: expect.any(Function), relatedUsers: users}),
  );
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
});

test('removes access from one storage identity and explains its return to the wallet', async () => {
  await mount();
  await openCategory('Storage identities');
  await confirm('Remove app access');
  expect(Alert.alert.mock.calls.at(-1)[1]).toMatch(/all apps/i);
  expect(Alert.alert.mock.calls.at(-1)[1]).toMatch(/wallet/i);
  expect(mockRemoveStorageAccess).toHaveBeenCalledTimes(1);
  expect(mockRemoveStorageAccess).toHaveBeenCalledWith(
    users[0], {storageIDs: [storageIDs[0]]},
    expect.objectContaining({assertActive: expect.any(Function), relatedUsers: users}),
  );
  expect(mockRevoke).not.toHaveBeenCalled();
});

test.each([
  ['App instances', 'Revoke instance', mockRevoke],
  ['Storage identities', 'Remove app access', mockRemoveStorageAccess],
])('repeated %s failures reveal each error at the top', async (category, label, action) => {
  action.mockRejectedValue(new Error('Please retry after reconnecting.'));
  await mount();
  await openCategory(category);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await confirm(label);
    expect(action).toHaveBeenCalledTimes(attempt);
    expect(textContent(view.root.findByProps({accessibilityRole: 'alert'})))
      .toBe('Please retry after reconnecting.');
    expect(mockScrollTo).toHaveBeenCalledTimes(attempt);
  }
});

test('a confirmation from a previous profile cannot revoke the new profile’s connection', async () => {
  await mount();
  await openCategory('App instances');
  act(() => button('Revoke instance').props.onPress());
  const oldConfirmation = Alert.alert.mock.calls.at(-1)[2]
    .find(option => option.style === 'destructive');
  mockState.authentication.sessionEpoch = 2;
  await act(async () => view.update(screen()));
  await act(async () => oldConfirmation.onPress());
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
});

test('late results from a previous profile cannot replace the current app list', async () => {
  let rejectOldLoad;
  mockLoadConnectedApps.mockImplementationOnce(() => new Promise((resolve, reject) => {
    rejectOldLoad = reject;
  }));
  await mount();
  mockState.authentication.sessionEpoch = 2;
  await act(async () => view.update(screen()));
  await act(async () => rejectOldLoad(new Error('Old profile read failed.')));
  expect(textContent(view.root)).not.toContain('Old profile read failed.');
  expect(row(app.title)).toBeDefined();
});

test('an in-flight removal cannot publish completion into another profile', async () => {
  let finishRemoval;
  mockRevoke.mockImplementationOnce(() => new Promise(resolve => {
    finishRemoval = resolve;
  }));
  await mount();
  await openCategory('App instances');
  act(() => button('Revoke instance').props.onPress());
  const confirmation = Alert.alert.mock.calls.at(-1)[2]
    .find(option => option.style === 'destructive');
  let removal;
  act(() => { removal = confirmation.onPress(); });
  expect(mockRevoke).toHaveBeenCalledTimes(1);

  mockState.authentication.sessionEpoch = 2;
  await act(async () => view.update(screen()));
  expect(() => mockRevoke.mock.calls[0][3].assertActive()).toThrow();
  await act(async () => {
    finishRemoval({pending: true, jobId: 'old-profile-job'});
    await removal;
  });
  expect(row(app.title)).toBeDefined();
  expect(textContent(view.root)).not.toContain('Removal submitted');
  expect(textContent(view.root)).not.toContain('Waiting for confirmation');
  expect(mockLoadConnectedApps).toHaveBeenCalledTimes(2);
});

test('refreshes connections on demand without losing the current category', async () => {
  await mount();
  await openCategory('App instances');
  await refresh();
  expect(mockLoadConnectedApps).toHaveBeenCalledTimes(2);
  expect(button('Revoke instance')).toBeDefined();
});

test('an inventory change during loading discards old rows and reads the latest identities', async () => {
  let finishOldRead;
  let finishCurrentRead;
  mockLoadConnectedApps
    .mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishCurrentRead = resolve; }));
  await mount();
  mockInventory = [...mockInventory, {
    key: 'system:new-user', identityID: 'new-user', systemID: 'system',
    title: 'Newly linked ID@', isStorage: false,
  }];
  await act(async () => view.update(screen()));
  expect(mockLoadConnectedApps).toHaveBeenCalledTimes(1);

  await act(async () => finishOldRead({apps: [app], errors: [], unassignedStorage: []}));
  expect(mockLoadConnectedApps).toHaveBeenCalledTimes(2);
  expect(mockLoadConnectedApps).toHaveBeenLastCalledWith(mockInventory, expect.any(Object));
  expect(row(app.title)).toBeUndefined();
  expect(textContent(view.root)).toContain('Loading connected apps');

  const currentApp = {...app, title: 'Current app@'};
  await act(async () => finishCurrentRead({apps: [currentApp], errors: [], unassignedStorage: []}));
  expect(row(currentApp.title)).toBeDefined();
  expect(row(app.title)).toBeUndefined();
});

test('submission cleanup keeps actions disabled until its follow-up inventory read finishes', async () => {
  let finishRefresh;
  await mount();
  await openCategory('App instances');
  mockLoadConnectedApps.mockImplementationOnce(() => new Promise(resolve => {
    finishRefresh = resolve;
  }));
  await confirm('Revoke instance');
  const siblingButton = () => view.root.findAllByType('Button')
    .filter(node => node.props.children === 'Revoke instance')[1];
  expect(siblingButton().props.disabled).toBe(true);
  expect(textContent(view.root)).toContain('Loading connected apps');
  act(() => siblingButton().props.onPress());
  expect(Alert.alert).toHaveBeenCalledTimes(1);

  await act(async () => finishRefresh({apps: [app], errors: [], unassignedStorage: []}));
  expect(siblingButton().props.disabled).toBe(false);
  expect(button('Revoke instance').props.disabled).toBe(true);
});

test.each([
  ['App instances', 'Revoke instance', 'revoke-job', mockRevoke],
  ['Storage identities', 'Remove app access', 'storage-job', mockRemoveStorageAccess],
])('completed %s removal allows a later authorization to reuse the same identity', async (category, label, jobId, action) => {
  await mount();
  await openCategory(category);
  await confirm(label);
  expect(button(label).props.disabled).toBe(true);

  mockState.channelStore_verusid.authorizationJobs = {[jobId]: {status: 'complete'}};
  await act(async () => view.update(screen()));
  expect(button(label).props.disabled).toBe(false);
  expect(textContent(view.root)).not.toContain('Waiting for confirmation');
  expect(button('Refresh')).toBeUndefined();

  action.mockResolvedValueOnce({pending: true, jobId: `${jobId}-again`});
  await confirm(label);
  expect(action).toHaveBeenCalledTimes(2);
  expect(button(label).props.disabled).toBe(true);
  expect(textContent(view.root)).toContain('Waiting for confirmation');
});

test('identity addresses and approving users stay behind the instance details disclosure', async () => {
  await mount();
  await openCategory('App instances');
  expect(textContent(view.root)).not.toContain(delegateIDs[0]);
  expect(textContent(view.root)).not.toContain(users[0].title);
  const details = view.root.findAllByType('Pressable')
    .find(node => node.props.accessibilityLabel === 'Instance details');
  expect(details.props.accessibilityState.expanded).toBe(false);
  act(() => details.props.onPress());
  expect(textContent(view.root)).toContain(delegateIDs[0]);
  expect(textContent(view.root)).toContain(users[0].title);
  expect(textContent(view.root)).toContain(users[1].title);
});

test('a submitted removal stays disabled while confirmation is pending', async () => {
  await mount();
  await openCategory('Storage identities');
  await confirm('Remove app access');
  expect(button('Remove app access').props.disabled).toBe(true);
  expect(textContent(view.root)).toContain('Waiting for confirmation');
  expect(textContent(view.root)).toContain('You can leave this screen');
  expect(button('Refresh')).toBeDefined();
  act(() => button('Remove app access').props.onPress());
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(mockRemoveStorageAccess).toHaveBeenCalledTimes(1);
});

test('a storage removal is pending under every app that shares that identity', async () => {
  const otherApp = {
    ...app,
    key: 'system:another-app',
    appID: 'another-app',
    title: 'Another app@',
    instances: [],
    storage: [app.storage[0]],
  };
  mockLoadConnectedApps.mockResolvedValue({apps: [app, otherApp], errors: [], unassignedStorage: []});
  await mount();
  await openCategory('Storage identities');
  await confirm('Remove app access');
  act(() => mockInnerNavigation.goBack());
  act(() => mockInnerNavigation.goBack());
  await open(otherApp.title);
  await open('Storage identities');
  expect(button('Remove app access').props.disabled).toBe(true);
  expect(textContent(view.root)).toContain('Waiting for confirmation');
  act(() => button('Remove app access').props.onPress());
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(mockRemoveStorageAccess).toHaveBeenCalledTimes(1);
});

test('back navigation returns through the app hierarchy before leaving Connected Apps', async () => {
  await mount();
  await openCategory('App instances');
  act(() => mockInnerNavigation.goBack());
  expect(row('App instances')).toBeDefined();
  expect(mockParentBack).not.toHaveBeenCalled();
  act(() => mockInnerNavigation.goBack());
  expect(row(app.title)).toBeDefined();
  act(() => view.root.findByType('HeaderBackButton').props.onPress());
  expect(mockParentBack).toHaveBeenCalledTimes(1);
});

test.each([
  [false, 'No active approval'],
  [true, 'Approval status unavailable'],
])('retained storage remains accessible when approvalUnknown=%s without inventing an approval', async (approvalUnknown, label) => {
  mockLoadConnectedApps.mockResolvedValue({
    apps: [{...app, instances: [], approvalUnknown}],
    errors: [],
    unassignedStorage: [],
  });
  await mount();
  expect(row(app.title).props.description).toContain(label);
  await open(app.title);
  expect(textContent(view.root)).toContain(label);
  expect(row('Storage identities')).toBeDefined();
  await open('App instances');
  expect(button('Revoke instance')).toBeUndefined();
  expect(textContent(view.root)).toContain(approvalUnknown
    ? 'Unable to check app approvals' : 'No authorized app instances');
  act(() => mockInnerNavigation.goBack());
  await open('Storage identities');
  expect(textContent(view.root)).toContain(app.storage[0].title);
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('retained shared storage can remove its signing access after the app approval is gone', async () => {
  await showRetainedStorage({hasCredentials: false});
  expect(textContent(view.root)).toContain('Storage access remains');
  expect(button('Remove app access')).toBeDefined();
  expect(button('Add to wallet')).toBeUndefined();
  await confirm('Remove app access');
  expect(mockRemoveStorageAccess).toHaveBeenCalledWith(
    users[0], {storageIDs: [storageIDs[0]]},
    expect.objectContaining({relatedUsers: users}),
  );
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockAddToWallet).not.toHaveBeenCalled();
});

test('wallet-only retained storage is added with a fresh check and no destructive transaction prompt', async () => {
  await showRetainedStorage({
    status: STORAGE_ACCESS_STATE.WALLET_ONLY, hasCredentials: false,
  });
  expect(textContent(view.root)).toContain('App access removed');
  expect(textContent(view.root)).toContain('without a transaction or fee');
  expect(button('Remove app access')).toBeUndefined();
  await act(async () => button('Add to wallet').props.onPress());
  expect(mockAddToWallet).toHaveBeenCalledWith(
    users[0], {storageIDs: [storageIDs[0]]},
    expect.objectContaining({assertActive: expect.any(Function), relatedUsers: users}),
  );
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
  expect(textContent(view.root)).toContain('No transaction was needed');
});

test('wallet-only storage with live credentials requires record cleanup before linking', async () => {
  await showRetainedStorage({status: STORAGE_ACCESS_STATE.WALLET_ONLY});
  expect(textContent(view.root)).toContain('App access removed');
  expect(textContent(view.root)).toContain('Remove the remaining app records');
  expect(button('Add to wallet')).toBeUndefined();
  await confirm('Remove app access');
  expect(mockRemoveStorageAccess).toHaveBeenCalledTimes(1);
  expect(mockAddToWallet).not.toHaveBeenCalled();
});

test('manageable storage keeps the existing modify action inside its details', async () => {
  await showRetainedStorage({});
  expect(button('Manage identity')).toBeUndefined();
  expect(button('View identity')).toBeUndefined();
  const details = view.root.findAllByType('Pressable')
    .find(node => node.props.accessibilityLabel === 'Storage details');
  act(() => details.props.onPress());
  act(() => button('Manage identity').props.onPress());
  expect(mockParentNavigate).toHaveBeenCalledWith('IdentityManagement', {
    screen: 'IdentityModify', params: {
      chain: 'VRSCTEST', identityAddress: storageIDs[0], displayName: app.storage[0].title,
    },
  });
  expect(view.root.findAllByType('VerusIdDetailsModal')).toHaveLength(0);
});

test.each([
  [STORAGE_ACCESS_STATE.NEEDS_RECOVERY, 'Wallet cannot manage this identity'],
  [STORAGE_ACCESS_STATE.UNAVAILABLE, 'Unable to check storage access'],
])('%s storage provides read-only identity inspection without needing ownership', async (status, label) => {
  await showRetainedStorage({status, hasCredentials: false});
  expect(textContent(view.root)).toContain(label);
  expect(button('Remove app access')).toBeUndefined();
  expect(button('Add to wallet')).toBeUndefined();
  const details = view.root.findAllByType('Pressable')
    .find(node => node.props.accessibilityLabel === 'Storage details');
  expect(details.props.accessibilityState.expanded).toBe(false);
  expect(button('Manage identity')).toBeUndefined();
  expect(button('View identity')).toBeDefined();
  act(() => button('View identity').props.onPress());
  const modal = view.root.findByType('VerusIdDetailsModal');
  expect(modal.props.visible).toBe(true);
  let definition;
  let names;
  await act(async () => {
    definition = await modal.props.loadVerusId();
    names = await modal.props.loadFriendlyNames();
  });
  expect(definition).toBe(storageDefinition);
  expect(names).toEqual({[storageIDs[0]]: 'Notes storage 1@'});
  expect(mockGetIdentity).toHaveBeenCalledTimes(1);
  expect(mockGetIdentity).toHaveBeenCalledWith('system', storageIDs[0]);
  expect(mockFriendlyNames).toHaveBeenCalledWith('system', storageDefinition);
  expect(mockFriendlyNames.mock.calls[0][1]).toBe(definition);
  expect(mockParentNavigate).not.toHaveBeenCalled();
  act(() => modal.props.cancel());
  expect(view.root.findAllByType('VerusIdDetailsModal')).toHaveLength(0);
  if (status === STORAGE_ACCESS_STATE.UNAVAILABLE) {
    expect(button('Refresh')).toBeDefined();
    await act(async () => button('Refresh').props.onPress());
    expect(mockLoadConnectedApps).toHaveBeenCalledTimes(2);
  }
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
  expect(mockAddToWallet).not.toHaveBeenCalled();
});

test('a pending identity inspection cannot expose results after the profile changes', async () => {
  let finishRead;
  mockGetIdentity.mockImplementationOnce(() => new Promise(resolve => {
    finishRead = resolve;
  }));
  await showRetainedStorage({status: STORAGE_ACCESS_STATE.NEEDS_RECOVERY});
  act(() => button('View identity').props.onPress());
  const modal = view.root.findByType('VerusIdDetailsModal');
  let reading;
  act(() => { reading = modal.props.loadVerusId(); });
  const rejected = expect(reading).rejects.toMatchObject({code: 'SESSION_CHANGED'});

  mockState.authentication.sessionEpoch = 2;
  await act(async () => view.update(screen()));
  await act(async () => {
    finishRead({result: storageDefinition, error: null});
    await rejected;
  });
  expect(view.root.findAllByType('VerusIdDetailsModal')).toHaveLength(0);
  expect(mockFriendlyNames).not.toHaveBeenCalled();
  expect(mockParentNavigate).not.toHaveBeenCalled();
  expect(row(app.title)).toBeDefined();
});

test.each([STORAGE_ACCESS_STATE.SHARED, STORAGE_ACCESS_STATE.WALLET_ONLY])(
  '%s storage without a managing user remains inspectable without allowing mutation',
  async status => {
    await showRetainedStorage({status, users: [], hasCredentials: false});
    expect(textContent(view.root)).toContain('managing user identity could not be found');
    expect(button('Remove app access')).toBeUndefined();
    expect(button('Add to wallet')).toBeUndefined();
    expect(button('Manage identity')).toBeUndefined();
    expect(button('View identity')).toBeDefined();
    act(() => button('View identity').props.onPress());
    expect(view.root.findByType('VerusIdDetailsModal').props.visible).toBe(true);
    expect(mockParentNavigate).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
    expect(mockAddToWallet).not.toHaveBeenCalled();
  },
);

test('storage with missing app information has a review route without a fabricated app', async () => {
  const storage = {
    ...app.storage[0], status: STORAGE_ACCESS_STATE.UNAVAILABLE,
    users: [], hasCredentials: false,
  };
  mockLoadConnectedApps.mockResolvedValue({apps: [], errors: [], unassignedStorage: [storage]});
  await mount();
  expect(textContent(view.root)).toContain('Storage to review');
  expect(textContent(view.root)).not.toContain('No connected apps');
  expect(row(app.title)).toBeUndefined();
  expect(view.root.findAllByType('ListItem')).toHaveLength(1);
  await open(storage.title);
  expect(mockInnerNavigation.getState().routes.at(-1).params)
    .toEqual({storageKey: storage.key});
  expect(textContent(view.root)).toContain('Unable to check storage access');
  expect(button('View identity')).toBeDefined();
  expect(button('Refresh')).toBeDefined();
  expect(button('Revoke instance')).toBeUndefined();
  expect(button('Remove app access')).toBeUndefined();
  expect(button('Add to wallet')).toBeUndefined();
});

test('an open storage review remains actionable when refresh resolves its app association', async () => {
  const consoleErrors = jest.spyOn(console, 'error');
  const storage = {
    ...app.storage[0], status: STORAGE_ACCESS_STATE.UNAVAILABLE,
    hasCredentials: false,
  };
  mockLoadConnectedApps.mockResolvedValueOnce({
    apps: [], errors: [], unassignedStorage: [storage],
  });
  await mount();
  await open(storage.title);
  expect(button('Add to wallet')).toBeUndefined();

  mockLoadConnectedApps.mockResolvedValue({
    apps: [{
      ...app, instances: [],
      storage: [{...storage, status: STORAGE_ACCESS_STATE.WALLET_ONLY}],
    }],
    errors: [],
    unassignedStorage: [],
  });
  await refresh();
  expect(mockInnerNavigation.getState().routes.at(-1).params)
    .toEqual({storageKey: storage.key});
  expect(textContent(view.root)).toContain(storage.title);
  expect(textContent(view.root)).toContain(`Storage used with ${app.title}`);
  expect(textContent(view.root)).toContain('App access removed');
  expect(textContent(view.root)).not.toContain('No shared storage');
  expect(button('Add to wallet').props.disabled).toBe(false);
  expect(consoleErrors.mock.calls.some(([message]) =>
    typeof message === 'string' && message.includes('same key'))).toBe(false);
  await act(async () => button('Add to wallet').props.onPress());
  expect(mockAddToWallet).toHaveBeenCalledWith(
    users[0], {storageIDs: [storage.storageID]},
    expect.objectContaining({relatedUsers: users}),
  );
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
});

test('Add to wallet cannot use a callback retained from a previous profile', async () => {
  await showRetainedStorage({
    status: STORAGE_ACCESS_STATE.WALLET_ONLY, hasCredentials: false,
  });
  const oldAdd = button('Add to wallet').props.onPress;
  mockState.authentication.sessionEpoch = 2;
  await act(async () => view.update(screen()));
  await act(async () => oldAdd());
  expect(mockAddToWallet).not.toHaveBeenCalled();
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
  expect(row(app.title)).toBeDefined();
});

test('failed fresh ownership checks show a top error and never fall back to a transaction', async () => {
  mockAddToWallet.mockRejectedValue(new Error('Storage signing keys changed. Refresh its access.'));
  await showRetainedStorage({
    status: STORAGE_ACCESS_STATE.WALLET_ONLY, hasCredentials: false,
  });
  await act(async () => button('Add to wallet').props.onPress());
  const scroll = view.root.findByType('ScrollView');
  const alert = scroll.findByProps({accessibilityRole: 'alert'});
  expect(alert).toBe(scroll.children[0]);
  expect(textContent(alert)).toBe('Storage signing keys changed. Refresh its access.');
  expect(mockScrollTo).toHaveBeenCalledWith({y: 0, animated: true});
  expect(mockRemoveStorageAccess).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});
