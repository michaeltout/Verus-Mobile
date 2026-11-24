let mockState;
const mockLoadReview = jest.fn();
const mockReconcile = jest.fn();
const mockApprove = jest.fn();
const mockLoadGift = jest.fn();
const mockLoadStorageSelection = jest.fn();
const mockDispatch = jest.fn();
const mockScrollTo = jest.fn();
const mockPrepareResponse = jest.fn();
const mockDeliverResponse = jest.fn();
const mockCancel = jest.fn();
const mockLoadPreparedResponse = jest.fn();
const mockCopy = jest.fn();
let mockIdentities;

jest.mock('react-native', () => ({
  SafeAreaView: 'SafeAreaView',
  ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  RefreshControl: 'RefreshControl',
  Pressable: 'Pressable',
  Keyboard: {dismiss: jest.fn()},
  Platform: {OS: 'ios'},
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
  useWindowDimensions: () => ({width: 390, height: 844, fontScale: 1}),
  View: 'View',
  StyleSheet: {create: value => value, hairlineWidth: 1},
  Alert: {alert: jest.fn()},
}));
jest.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  TextInput: 'TextInput',
  Portal: 'Portal',
  List: {Item: 'ListItem', Icon: 'ListIcon'},
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({bottom: 20}),
}));
jest.mock('@react-navigation/elements', () => ({useHeaderHeight: () => 96}));
jest.mock('@react-navigation/native', () => ({
  CommonActions: jest.requireActual('@react-navigation/routers').CommonActions,
  useIsFocused: () => true,
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('react-redux', () => ({
  useSelector: selector => selector(mockState),
  useDispatch: () => mockDispatch,
}));
jest.mock('../../../components/Button', () => 'Button');
jest.mock(
  '../../../components/ListSelectionModal/ListSelectionModal',
  () => 'IdentityPicker',
);
jest.mock('../../../hooks/useAuthorizationIdentities', () => ({
  useAuthorizationIdentities: () => mockIdentities,
}));
jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../clipboard/clipboard', () => ({
  copyToClipboard: (...args) => mockCopy(...args),
}));
jest.mock('../../../actions/actionCreators', () => ({
  setConfigSection: section => ({type: 'SET_CONFIG', section}),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {getBasicCoinObj: () => ({id: 'VRSC'})},
}));
jest.mock('../../appAuthorization/jobs', () => ({
  AUTHORIZATION_STATUS: require('../../appAuthorization/constants')
    .AUTHORIZATION_STATUS,
  captureAuthorizationContext: options => ({
    ...options,
    epoch: mockState.authentication.sessionEpoch,
  }),
  assertAuthorizationContext: context => {
    if (context.epoch !== mockState.authentication.sessionEpoch) {
      throw Object.assign(new Error('Session changed'), {
        code: 'SESSION_CHANGED',
      });
    }
    context.assertActive?.();
  },
}));
jest.mock('../../appAuthorization/workflow', () => ({
  loadAuthorizationReview: (...args) => mockLoadReview(...args),
  reconcileAuthorizationJob: (...args) => mockReconcile(...args),
  approveAuthorization: (...args) => mockApprove(...args),
  prepareAuthorizationResponse: (...args) => mockPrepareResponse(...args),
  deliverAuthorizationResponse: (...args) => mockDeliverResponse(...args),
  cancelAuthorization: (...args) => mockCancel(...args),
  loadPreparedAuthorizationResponse: (...args) =>
    mockLoadPreparedResponse(...args),
}));
jest.mock('../../appAuthorization/gift', () => ({
  loadAuthorizationGift: (...args) => mockLoadGift(...args),
}));
jest.mock('../../appAuthorization/plan', () => ({
  loadAuthorizationStorageSelection: (...args) =>
    mockLoadStorageSelection(...args),
}));

const React = require('react');
const {act, create} = require('react-test-renderer');
const {Alert, Keyboard} = require('react-native');
const Review =
  require('../../../containers/DeepLink/AppAuthorizationRequestInfo/AppAuthorizationRequestInfo').default;
const {DLIGHT_PRIVATE} = require('../../constants/intervalConstants');
const {AppAuthorizationOfferRole} = require('verus-typescript-primitives');
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return {promise, resolve};
};
const initialReview = {
  id: 'saved-job',
  status: 'ready_for_authorization',
  appId: 'app-id',
  delegateId: 'delegate-id',
  delegateRevision: {txid: 'reviewed-delegate', vout: 0, blockheight: 100},
  systemId: 'system',
  expiryTime: 2000000000,
  selectedIdentity: {identityID: 'user', systemID: 'system'},
  requiresSharedStorage: false,
  appEncryption: {returnESK: false},
  offers: [],
  storageBindings: [],
};
const STORAGE_ROLE_LABELS = [
  'Storage identity',
  'Revocation authority',
  'Recovery authority',
];
const verifiedFeeReview = {
  type: 'authorization',
  identityID: 'user',
  systemID: 'system',
  transactionCount: 1,
  fees: [
    {currency: 'system', atomic: '10000', coins: '0.0001', ticker: 'VRSC'},
  ],
};
let view;
const props = {
  route: {params: {jobId: 'saved-job'}},
  navigation: {navigate: jest.fn(), goBack: jest.fn(), dispatch: jest.fn()},
};
const mount = async () => {
  await act(async () => {
    view = create(<Review {...props} />, {
      createNodeMock: element =>
        element.type === 'ScrollView' ? {scrollTo: mockScrollTo} : null,
    });
  });
};
const button = label =>
  view.root.findAllByType('Button').find(node => node.props.children === label);
const textContent = node =>
  typeof node === 'string'
    ? node
    : (node.children || []).map(textContent).join('');
const openDisclosure = title =>
  act(() =>
    view.root
      .findAllByType('Pressable')
      .find(
        node =>
          node.props.accessibilityLabel === title ||
          node.props.accessibilityLabel?.startsWith(`${title}.`),
      )
      .props.onPress(),
  );
const cancelRequest = async () => {
  act(() => button('Cancel request').props.onPress());
  const actions = Alert.alert.mock.calls[Alert.alert.mock.calls.length - 1][2];
  await act(async () =>
    actions.find(action => action.style === 'destructive').onPress(),
  );
};
const selectIdentity = (title, identityID) => {
  act(() =>
    view.root
      .findAllByType('ListItem')
      .find(item => item.props.title === title)
      .props.onPress(),
  );
  act(() =>
    view.root.findByType('IdentityPicker').props.onSelect({
      identityID,
      systemID: 'system',
    }),
  );
};
const refreshReview = async () => {
  await act(async () =>
    view.root.findByType('ScrollView').props.refreshControl.props.onRefresh(),
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentities = [
    {
      key: 'system:user',
      identityID: 'user',
      systemID: 'system',
      title: 'My identity',
    },
  ];
  mockState = {
    authentication: {
      signedIn: true,
      accounts: [{accountHash: 'profile'}],
      sessionEpoch: 1,
      activeAccount: {
        accountHash: 'profile',
        keys: {VRSC: {[DLIGHT_PRIVATE]: {}}},
      },
    },
    channelStore_verusid: {authorizationJobs: {}},
    settings: {
      generalWalletSettings: {enableExperimentalGenericRequests: true},
    },
  };
  mockReconcile.mockResolvedValue({});
  mockLoadStorageSelection.mockReset().mockResolvedValue([]);
  mockLoadReview.mockReset().mockResolvedValue(initialReview);
  mockApprove.mockReset().mockResolvedValue({});
  mockPrepareResponse.mockReset().mockResolvedValue({});
  mockDeliverResponse.mockReset().mockResolvedValue({});
  mockCancel
    .mockReset()
    .mockImplementation(async (_jobId, selectedIdentity, context) => {
      context.assertActive();
      return {
        ...initialReview,
        selectedIdentity,
        status: 'cancelled',
        canNotifyCancellation: !!selectedIdentity,
      };
    });
  mockLoadPreparedResponse
    .mockReset()
    .mockResolvedValue({toBuffer: () => Buffer.from('frozen-response')});
  mockLoadGift.mockReset().mockResolvedValue({
    identities: [],
    currencies: [],
    requiresPassword: false,
  });
});
afterEach(() => {
  if (view) act(() => view.unmount());
  view = null;
});

it('blocks authorization entry when experimental deeplinks are disabled', async () => {
  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = false;
  await mount();
  expect(mockReconcile).not.toHaveBeenCalled();
  expect(mockLoadReview).not.toHaveBeenCalled();
  expect(mockApprove).not.toHaveBeenCalled();
});

it('does not apply a delayed review from a previous wallet session', async () => {
  const old = deferred();
  mockLoadReview.mockReturnValueOnce(old.promise);
  await mount();
  mockState.authentication.sessionEpoch = 2;
  mockLoadReview.mockResolvedValue({...initialReview, appId: 'current-app'});
  await act(async () => {
    view.update(<Review {...props} />);
  });
  await act(async () => {
    old.resolve({...initialReview, appId: 'old-app'});
  });
  expect(textContent(view.root)).toContain('current-app');
  expect(textContent(view.root)).not.toContain('old-app');
});

it('keeps one saved-job review active when its original deeplink is cleared', async () => {
  const pending = deferred();
  mockState.deeplink = {id: 'request', data: 'original', requestId: 'ingress'};
  mockLoadReview.mockReturnValueOnce(pending.promise);
  await mount();

  mockState.deeplink = {};
  await act(async () => view.update(<Review {...props} />));
  expect(mockLoadReview).toHaveBeenCalledTimes(1);

  await act(async () => pending.resolve(initialReview));
  expect(button('Review fees').props.disabled).toBe(false);
  expect(mockLoadReview).toHaveBeenCalledTimes(1);
});

it('still invalidates a saved-job review when the wallet network changes', async () => {
  const previous = deferred();
  mockLoadReview.mockReturnValueOnce(previous.promise);
  await mount();

  mockState.authentication.activeAccount.testnetOverrides = {VRSC: 'test'};
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    appId: 'current-network',
  });
  await act(async () => view.update(<Review {...props} />));
  await act(async () =>
    previous.resolve({...initialReview, appId: 'old-network'}),
  );

  expect(mockLoadReview).toHaveBeenCalledTimes(2);
  expect(textContent(view.root)).toContain('current-network');
  expect(textContent(view.root)).not.toContain('old-network');
});

it('shows the verified review while gift discovery is pending and keeps approval disabled', async () => {
  const inventory = deferred();
  mockLoadReview.mockResolvedValue({...initialReview, hasGift: true});
  mockLoadGift.mockReturnValue(inventory.promise);
  await mount();

  expect(textContent(view.root)).toContain('app-id');
  expect(button('Review gift').props.disabled).toBe(true);
  expect(button('Review fees')).toBeUndefined();
  expect(mockApprove).not.toHaveBeenCalled();

  await act(async () =>
    inventory.resolve({
      requiresPassword: false,
      identities: [{identityAddress: 'gift-id'}],
      currencies: [],
    }),
  );
  expect(button('Review fees').props.disabled).toBe(false);
});

it('ignores gift inventory that finishes after switching wallet sessions', async () => {
  const old = deferred();
  mockLoadReview.mockResolvedValueOnce({...initialReview, hasGift: true});
  mockLoadGift.mockReturnValueOnce(old.promise);
  await mount();

  mockState.authentication.sessionEpoch = 2;
  mockLoadReview.mockResolvedValue({...initialReview, appId: 'current-app'});
  await act(async () => view.update(<Review {...props} />));
  await act(async () => old.resolve({requiresPassword: true}));

  expect(textContent(view.root)).toContain('current-app');
  expect(button('Unlock gift')).toBeUndefined();
  expect(button('Review fees').props.disabled).toBe(false);
  expect(mockLoadGift).toHaveBeenCalledTimes(1);
});

it('passes the displayed delegate revision and explicit selections to approval', async () => {
  await mount();
  await act(async () => {
    await button('Review fees').props.onPress();
  });
  expect(mockApprove).toHaveBeenCalledWith(
    'saved-job',
    {
      selectedIdentity: {identityID: 'user', systemID: 'system'},
      delegateRevision: initialReview.delegateRevision,
      storageBindings: [],
    },
    expect.objectContaining({assertActive: expect.any(Function)}),
  );
  expect(props.navigation.navigate).not.toHaveBeenCalled();
});

it('refreshes changed delegate authority before another approval and retains the explanation', async () => {
  const changedReview = deferred();
  const nextRevision = {txid: 'new-delegate', vout: 1, blockheight: 101};
  mockApprove.mockRejectedValueOnce(
    Object.assign(new Error('The delegate changed after review.'), {
      code: 'AUTHORIZATION_DELEGATE_CHANGED',
    }),
  );
  await mount();
  mockLoadReview.mockReturnValueOnce(changedReview.promise);
  act(() => button('Review fees').props.onPress());
  await act(async () => {});

  expect(button('Review fees').props.disabled).toBe(true);
  expect(mockLoadReview).toHaveBeenCalledTimes(2);
  await act(async () =>
    changedReview.resolve({
      ...initialReview,
      delegateRevision: nextRevision,
      delegateAuthorities: ['new-signing-key'],
      delegateThreshold: 1,
    }),
  );
  expect(textContent(view.root)).toContain(
    'The delegate changed after review.',
  );
  expect(button('Review fees').props.disabled).toBe(false);
  openDisclosure('Request details');
  expect(textContent(view.root)).toContain('new-signing-key');

  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1].delegateRevision).toEqual(
    initialReview.delegateRevision,
  );
  expect(mockApprove.mock.calls[1][1].delegateRevision).toEqual(nextRevision);
});

it('keeps a pending authorization immutable and checks its single transaction', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
    status: 'waiting_for_grant_confirmation',
    selectionsLocked: true,
    storageBindings: [
      {
        storageIdentity: 'storage',
        revocationIdentity: 'user',
        recoveryIdentity: 'user',
      },
    ],
  });
  await mount();
  expect(button('Choose identity')).toBeUndefined();
  expect(button('Add storage')).toBeUndefined();
  expect(view.root.findAllByType('ListItem')).toHaveLength(0);
  await act(async () => button('Check progress').props.onPress());
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockApprove).not.toHaveBeenCalled();
});

it('rechecks the experimental setting at the asynchronous execution boundary', async () => {
  const submitted = deferred();
  mockApprove.mockReturnValue(submitted.promise);
  await mount();
  let operation;
  act(() => {
    operation = button('Review fees').props.onPress();
  });
  const context = mockApprove.mock.calls[0][2];
  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = false;
  expect(() => context.assertActive()).toThrow('experimental');
  await act(async () => {
    submitted.resolve({});
    await operation;
  });
});

it('reveals registration-style errors at the top after every failed attempt', async () => {
  await mount();
  mockApprove.mockRejectedValue(new Error('Not enough funds to continue.'));

  for (const attempt of [1, 2]) {
    await act(async () => button('Review fees').props.onPress());
    expect(mockScrollTo).toHaveBeenCalledTimes(attempt);
    expect(mockScrollTo).toHaveBeenLastCalledWith({y: 0, animated: true});
    expect(Keyboard.dismiss).toHaveBeenCalledTimes(attempt);
    const scroll = view.root.findByType('ScrollView');
    const alert = scroll.findByProps({accessibilityRole: 'alert'});
    expect(alert.parent).toBe(scroll);
    expect(alert.props.style).toContainEqual({backgroundColor: '#fff0f0'});
    expect(alert.findByType('Text').props.children).toContain(
      'Not enough funds',
    );
  }
});

it('allows retrying an initial load failure without leaving the request', async () => {
  mockLoadReview.mockRejectedValueOnce(
    new Error('The network is unavailable.'),
  );
  await mount();
  expect(mockScrollTo).toHaveBeenCalledWith({y: 0, animated: true});
  expect(button('Retry loading')).toBeDefined();
  await act(async () => button('Retry loading').props.onPress());
  expect(button('Review fees')).toBeDefined();
  expect(view.root.findAllByProps({accessibilityRole: 'alert'})).toHaveLength(
    0,
  );
});

it('cancels after an identity error without revalidating or signing a response', async () => {
  await mount();
  mockApprove.mockRejectedValue(
    new Error('The selected identity cannot sign.'),
  );
  await act(async () => button('Review fees').props.onPress());
  mockLoadReview.mockRejectedValue(
    new Error('The request is no longer valid.'),
  );
  const reviewLoads = mockLoadReview.mock.calls.length;

  await cancelRequest();

  expect(mockCancel).toHaveBeenCalledWith(
    'saved-job',
    initialReview.selectedIdentity,
    expect.any(Object),
  );
  expect(mockLoadReview).toHaveBeenCalledTimes(reviewLoads);
  expect(mockPrepareResponse).not.toHaveBeenCalled();
  expect(mockDeliverResponse).not.toHaveBeenCalled();
  expect(button('Done')).toBeDefined();
  expect(button('Review fees')).toBeUndefined();
  expect(textContent(view.root)).toContain('This request is cancelled.');
});

it('offers cancellation when the request review cannot load at all', async () => {
  mockLoadReview.mockRejectedValue(new Error('Invalid request.'));
  await mount();
  await cancelRequest();
  expect(mockCancel).toHaveBeenCalledWith(
    'saved-job',
    null,
    expect.any(Object),
  );
  expect(button('Done')).toBeDefined();
  expect(button('Notify app')).toBeUndefined();
});

it('allows local cancellation and Done after experimental requests are disabled', async () => {
  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = false;
  await mount();
  await cancelRequest();
  expect(mockCancel).toHaveBeenCalledTimes(1);
  expect(mockPrepareResponse).not.toHaveBeenCalled();
  expect(button('Done')).toBeDefined();
  act(() => button('Done').props.onPress());
  expect(props.navigation.dispatch).toHaveBeenCalledWith({
    type: 'RESET',
    payload: {index: 0, routes: [{name: 'SignedInStack'}]},
  });
});

it.each(['signing', 'delivery'])(
  'keeps cancellation and Done available after response %s fails',
  async phase => {
    await mount();
    await cancelRequest();
    (phase === 'signing'
      ? mockPrepareResponse
      : mockDeliverResponse
    ).mockRejectedValue(new Error('Unable to notify the app.'));
    await act(async () => button('Notify app').props.onPress());
    expect(button('Done')).toBeDefined();
    expect(button('Cancel request')).toBeUndefined();
    expect(button('Review fees')).toBeUndefined();
    expect(textContent(view.root)).toContain('This request is cancelled.');
    expect(textContent(view.root)).toContain('Unable to notify the app.');
  },
);

it('opens an already cancelled request offline without reconciling its pending gift', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'cancelled',
    giftRecoveryPending: true,
  });
  mockReconcile.mockRejectedValue(new Error('Offline.'));
  await mount();
  expect(mockReconcile).not.toHaveBeenCalled();
  expect(button('Done')).toBeDefined();
  expect(button('Check gift progress')).toBeDefined();
  expect(view.root.findAllByProps({accessibilityRole: 'alert'})).toHaveLength(
    0,
  );
});

it('allows stopping a request after grant preparation without claiming to undo approval', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'waiting_for_grant_confirmation',
  });
  mockCancel.mockResolvedValue({
    ...initialReview,
    status: 'cancelled',
    approvalMayRemain: true,
  });
  await mount();
  await cancelRequest();
  expect(button('Done')).toBeDefined();
  expect(button('Notify app')).toBeUndefined();
  expect(textContent(view.root)).toContain('may still take effect');
  expect(button('Linked apps')).toBeDefined();
});

it.each([
  [true, ['profile'], 'SignedInStack'],
  [false, ['profile'], 'SignedOutStack'],
  [false, [], 'SignedOutNoKeyStack'],
])(
  'Done returns to the current wallet root without back history (%s, %j)',
  async (signedIn, accounts, destination) => {
    mockLoadReview.mockResolvedValue({...initialReview, status: 'cancelled'});
    await mount();
    mockState.authentication = {
      ...mockState.authentication,
      signedIn,
      accounts,
    };
    mockState.deeplink = {
      requestId: 99,
      url: 'newer-request',
      parsingUrl: true,
    };
    const reduxActions = mockDispatch.mock.calls.length;
    act(() => button('Done').props.onPress());

    const {StackRouter, CommonActions} = jest.requireActual(
      '@react-navigation/routers',
    );
    const router = StackRouter({initialRouteName: 'DeepLink'});
    const options = {
      routeNames: [destination, 'DeepLink'],
      routeParamList: {},
      routeGetIdList: {},
    };
    const coldStartState = router.getInitialState(options);
    expect(
      router.getStateForAction(coldStartState, CommonActions.goBack(), options),
    ).toBeNull();
    const action = props.navigation.dispatch.mock.calls[0][0];
    const finishedState = router.getStateForAction(
      coldStartState,
      action,
      options,
    );
    expect(finishedState.routes.map(route => route.name)).toEqual([
      destination,
    ]);
    expect(props.navigation.goBack).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledTimes(reduxActions);
    expect(mockState.deeplink.url).toBe('newer-request');
  },
);

it('keeps the primary action outside the scroll area and reveals technical details on demand', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    appName: 'Example app',
    delegateName: 'Example instance',
    delegateAuthorities: ['signer-address'],
    delegateThreshold: 1,
  });
  await mount();
  const scroll = view.root.findByType('ScrollView');
  expect(
    scroll
      .findAllByType('Button')
      .some(node => node.props.children === 'Review fees'),
  ).toBe(false);
  expect(button('Add storage')).toBeUndefined();
  expect(textContent(view.root)).not.toContain('signer-address');
  openDisclosure('Request details');
  expect(textContent(view.root)).toContain('signer-address');
  expect(textContent(view.root)).not.toContain('Shared storage');
  expect(
    view.root
      .findAllByType('ListItem')
      .filter(node => STORAGE_ROLE_LABELS.includes(node.props.title)),
  ).toHaveLength(0);
  expect(button('Add storage')).toBeUndefined();
});

it.each([
  ['incomplete', [{storageIdentity: 'stale-storage'}]],
  [
    'complete',
    [
      {
        storageIdentity: 'stale-storage',
        revocationIdentity: 'stale-revocation',
        recoveryIdentity: 'stale-recovery',
      },
    ],
  ],
])(
  'ignores %s uncommitted storage selections when the request does not require storage',
  async (_description, storageBindings) => {
    mockLoadReview.mockResolvedValue({...initialReview, storageBindings});
    await mount();

    expect(textContent(view.root)).not.toContain('Shared storage');
    expect(textContent(view.root)).not.toContain('stale-storage');
    expect(
      view.root
        .findAllByType('ListItem')
        .filter(node => STORAGE_ROLE_LABELS.includes(node.props.title)),
    ).toHaveLength(0);
    expect(button('Add storage')).toBeUndefined();
    expect(button('Remove selection')).toBeUndefined();
    expect(button('Review fees').props.disabled).toBe(false);

    await act(async () => button('Review fees').props.onPress());

    expect(mockApprove).toHaveBeenCalledWith(
      'saved-job',
      {
        selectedIdentity: initialReview.selectedIdentity,
        delegateRevision: initialReview.delegateRevision,
        storageBindings: [],
      },
      expect.any(Object),
    );
  },
);

it('shows required storage and prevents approval until every role is selected', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
  });
  await mount();
  expect(button('Review fees').props.disabled).toBe(true);
  await act(async () => button('Add storage').props.onPress());
  expect(button('Review fees').props.disabled).toBe(true);
  for (const field of STORAGE_ROLE_LABELS) {
    act(() =>
      view.root
        .findAllByType('ListItem')
        .find(node => node.props.title === field)
        .props.onPress(),
    );
    act(() =>
      view.root
        .findByType('IdentityPicker')
        .props.onSelect({identityID: field, systemID: 'system'}),
    );
  }
  expect(button('Review fees').props.disabled).toBe(false);
  expect(textContent(view.root)).toContain('without asking each time');
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove).toHaveBeenCalledWith(
    'saved-job',
    {
      selectedIdentity: initialReview.selectedIdentity,
      delegateRevision: initialReview.delegateRevision,
      storageBindings: [
        {
          storageIdentity: 'Storage identity',
          revocationIdentity: 'Revocation authority',
          recoveryIdentity: 'Recovery authority',
        },
      ],
    },
    expect.any(Object),
  );
});

it('uses the existing app storage instead of a new offer and locks only the storage IDs', async () => {
  const existing = [
    {
      storageIdentity: 'existing-storage',
      revocationIdentity: 'existing-revocation',
      recoveryIdentity: 'existing-recovery',
    },
  ];
  mockLoadStorageSelection.mockResolvedValue(existing);
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
    offers: [
      {role: AppAuthorizationOfferRole.STORAGE, identityID: 'new-offer'},
    ],
  });
  await mount();
  expect(mockLoadStorageSelection).toHaveBeenCalledWith(
    initialReview.selectedIdentity,
    initialReview.appId,
    expect.any(Object),
  );
  expect(textContent(view.root)).toContain(
    'same shared storage as your existing app connection',
  );
  const storage = view.root
    .findAllByType('ListItem')
    .find(item => item.props.title === 'Storage identity');
  expect(storage.props.description).toBe('existing-storage');
  expect(storage.props.onPress).toBeUndefined();
  expect(storage.props.accessibilityState.disabled).toBe(true);
  expect(button('Add storage')).toBeUndefined();
  expect(button('Remove selection')).toBeUndefined();
  expect(
    view.root
      .findAllByType('ListItem')
      .find(item => item.props.title === 'Recovery authority').props.onPress,
  ).toEqual(expect.any(Function));
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1].storageBindings).toEqual(existing);
});

it('waits for saved storage before reviewing fees even when all requested roles are filled', async () => {
  const pending = deferred();
  mockLoadStorageSelection.mockReturnValueOnce(pending.promise);
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
    storageBindings: [
      {
        storageIdentity: 'offered',
        revocationIdentity: 'user',
        recoveryIdentity: 'user',
      },
    ],
  });
  await mount();
  expect(button('Review fees').props.disabled).toBe(true);
  expect(textContent(view.root)).toContain(
    'Checking this identity’s existing app storage',
  );
  await act(async () => pending.resolve([]));
  expect(button('Review fees').props.disabled).toBe(false);
  expect(button('Add storage')).toBeDefined();
});

it('ignores a previous account’s pending storage lookup', async () => {
  const pending = deferred();
  mockLoadStorageSelection
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue([
      {
        storageIdentity: 'second-storage',
        revocationIdentity: 'second-user',
        recoveryIdentity: 'second-user',
      },
    ]);
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
  });
  await mount();
  selectIdentity('Your identity', 'second-user');
  await act(async () => {});
  await act(async () =>
    pending.resolve([
      {
        storageIdentity: 'first-storage',
        revocationIdentity: 'user',
        recoveryIdentity: 'user',
      },
    ]),
  );
  expect(textContent(view.root)).toContain('second-storage');
  expect(textContent(view.root)).not.toContain('first-storage');
  expect(mockLoadStorageSelection).toHaveBeenCalledTimes(2);
});

it('blocks fee review after a storage lookup error and retries on refresh', async () => {
  mockLoadStorageSelection.mockRejectedValueOnce(
    new Error('Storage records unavailable. Refresh to try again.'),
  );
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
    storageBindings: [
      {
        storageIdentity: 'offered',
        revocationIdentity: 'user',
        recoveryIdentity: 'user',
      },
    ],
  });
  await mount();
  expect(button('Review fees').props.disabled).toBe(true);
  expect(textContent(view.root)).toContain(
    'Storage records unavailable. Refresh to try again.',
  );
  expect(button('Add storage')).toBeUndefined();
  await refreshReview();
  expect(button('Review fees').props.disabled).toBe(false);
  expect(mockLoadStorageSelection).toHaveBeenCalledTimes(2);
});

it('fills the request user and storage without a gift or unrelated linked-user selection', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    requiresSharedStorage: true,
    offers: [
      {role: AppAuthorizationOfferRole.AUTHORITY, identityID: 'offered-user'},
      {role: AppAuthorizationOfferRole.STORAGE, identityID: 'offered-storage'},
    ],
  });
  await mount();
  expect(button('Review fees').props.disabled).toBe(false);
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1]).toEqual({
    selectedIdentity: {identityID: 'offered-user', systemID: 'system'},
    delegateRevision: initialReview.delegateRevision,
    storageBindings: [
      {
        storageIdentity: 'offered-storage',
        revocationIdentity: 'offered-user',
        recoveryIdentity: 'offered-user',
      },
    ],
  });
  expect(mockLoadGift).not.toHaveBeenCalled();
});

it('prefers the required response user and dedicated authority offers', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    requestedUserID: 'required-user',
    requiresSharedStorage: true,
    offers: [
      {
        role: AppAuthorizationOfferRole.AUTHORITY,
        identityID: 'other-authority',
      },
      {role: AppAuthorizationOfferRole.STORAGE, identityID: 'storage'},
      {role: AppAuthorizationOfferRole.REVOCATION, identityID: 'revocation'},
      {role: AppAuthorizationOfferRole.RECOVERY, identityID: 'recovery'},
    ],
  });
  await mount();
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1]).toEqual({
    selectedIdentity: {identityID: 'required-user', systemID: 'system'},
    delegateRevision: initialReview.delegateRevision,
    storageBindings: [
      {
        storageIdentity: 'storage',
        revocationIdentity: 'revocation',
        recoveryIdentity: 'recovery',
      },
    ],
  });
});

it('fills missing storage authorities when gift discovery reveals the user later', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    hasGift: true,
    requiresSharedStorage: true,
    storageBindings: [{storageIdentity: 'storage'}],
    offers: [{role: AppAuthorizationOfferRole.STORAGE, identityID: 'storage'}],
  });
  mockLoadGift
    .mockResolvedValueOnce({requiresPassword: true})
    .mockResolvedValue({
      requiresPassword: false,
      identities: [
        {identityAddress: 'storage', systemId: 'system'},
        {identityAddress: 'gift-user', systemId: 'system'},
        {identityAddress: 'different-chain', systemId: 'elsewhere'},
        {
          identityAddress: 'unsupported',
          systemId: 'system',
          unsupportedReason: 'Unavailable',
        },
      ],
    });
  await mount();
  expect(textContent(view.root)).not.toContain('My identity');
  act(() => view.root.findByType('TextInput').props.onChangeText('password'));
  await act(async () => button('Unlock gift').props.onPress());
  expect(button('Review fees').props.disabled).toBe(false);
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1]).toEqual({
    selectedIdentity: {identityID: 'gift-user', systemID: 'system'},
    delegateRevision: initialReview.delegateRevision,
    storageBindings: [
      {
        storageIdentity: 'storage',
        revocationIdentity: 'gift-user',
        recoveryIdentity: 'gift-user',
      },
    ],
  });
});

it('does not turn unlisted gifted identities into shared storage', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    hasGift: true,
    requiresSharedStorage: true,
  });
  mockLoadGift.mockResolvedValue({
    requiresPassword: false,
    identities: [{identityAddress: 'gift-user', systemId: 'system'}],
  });
  await mount();
  expect(button('Review fees').props.disabled).toBe(true);
  expect(
    view.root.findAllByType('ListItem').map(item => item.props.title),
  ).toEqual(['Your identity']);
  act(() => view.root.findAllByType('ListItem')[0].props.onPress());
  expect(view.root.findByType('IdentityPicker').props.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({identityID: 'gift-user'}),
    ]),
  );
  expect(mockApprove).not.toHaveBeenCalled();
});

it('leaves ambiguous users, storage and dedicated authorities for an explicit choice', async () => {
  const offers = [
    {role: AppAuthorizationOfferRole.AUTHORITY, identityID: 'user-one'},
    {role: AppAuthorizationOfferRole.AUTHORITY, identityID: 'user-two'},
    {role: AppAuthorizationOfferRole.STORAGE, identityID: 'storage-one'},
    {role: AppAuthorizationOfferRole.STORAGE, identityID: 'storage-two'},
    {role: AppAuthorizationOfferRole.REVOCATION, identityID: 'revocation-one'},
    {role: AppAuthorizationOfferRole.REVOCATION, identityID: 'revocation-two'},
  ];
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    requiresSharedStorage: true,
    offers,
  });
  await mount();
  expect(button('Choose identity')).toBeDefined();
  selectIdentity('Your identity', 'user-two');
  expect(button('Review fees').props.disabled).toBe(true);
  expect(view.root.findAllByType('ListItem')).toHaveLength(1);
  await act(async () => {});
  act(() => button('Add storage').props.onPress());
  selectIdentity('Storage identity', 'storage-two');
  expect(button('Review fees').props.disabled).toBe(true);
  expect(
    view.root
      .findAllByType('ListItem')
      .find(item => item.props.title === 'Revocation authority').props
      .description,
  ).toBe('Choose identity');
  selectIdentity('Revocation authority', 'revocation-two');
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1].storageBindings).toEqual([
    {
      storageIdentity: 'storage-two',
      revocationIdentity: 'revocation-two',
      recoveryIdentity: 'user-two',
    },
  ]);
});

it('follows a changed user only for untouched defaults and keeps edits through refresh', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    requiresSharedStorage: true,
    offers: [
      {role: AppAuthorizationOfferRole.AUTHORITY, identityID: 'offered-user'},
      {role: AppAuthorizationOfferRole.STORAGE, identityID: 'offered-storage'},
    ],
  });
  await mount();
  selectIdentity('Revocation authority', 'chosen-revocation');
  selectIdentity('Storage identity', 'chosen-storage');
  selectIdentity('Your identity', 'chosen-user');
  await refreshReview();
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove.mock.calls[0][1]).toEqual({
    selectedIdentity: {identityID: 'chosen-user', systemID: 'system'},
    delegateRevision: initialReview.delegateRevision,
    storageBindings: [
      {
        storageIdentity: 'chosen-storage',
        revocationIdentity: 'chosen-revocation',
        recoveryIdentity: 'chosen-user',
      },
    ],
  });
  act(() => button('Remove selection').props.onPress());
  await refreshReview();
  expect(button('Review fees').props.disabled).toBe(true);
  expect(button('Remove selection')).toBeUndefined();
});

it('offers retained storage for reuse without presenting it as an independent authority', async () => {
  mockIdentities.push({
    key: 'system:retained-storage',
    identityID: 'retained-storage',
    systemID: 'system',
    title: 'Saved storage',
    isStorage: true,
    userIdentityIDs: ['user'],
  });
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
  });
  await mount();
  act(() => view.root.findAllByType('ListItem')[0].props.onPress());
  expect(
    view.root
      .findByType('IdentityPicker')
      .props.data.map(item => item.identityID),
  ).toEqual(['user']);
  act(() => view.root.findByType('IdentityPicker').props.cancel());
  act(() => button('Add storage').props.onPress());
  act(() =>
    view.root
      .findAllByType('ListItem')
      .find(item => item.props.title === 'Storage identity')
      .props.onPress(),
  );
  expect(
    view.root
      .findByType('IdentityPicker')
      .props.data.map(item => item.identityID),
  ).toEqual(['retained-storage']);
  act(() => view.root.findByType('IdentityPicker').props.cancel());
  act(() =>
    view.root
      .findAllByType('ListItem')
      .find(item => item.props.title === 'Revocation authority')
      .props.onPress(),
  );
  expect(
    view.root
      .findByType('IdentityPicker')
      .props.data.map(item => item.identityID),
  ).toEqual(['user']);
});

it('rejects a retained storage identity as the requested default user even when discovered later', async () => {
  const selectedStorage = {
    key: 'system:retained-storage',
    identityID: 'retained-storage',
    systemID: 'system',
    title: 'Saved storage',
    isStorage: true,
  };
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    requestedUserID: 'retained-storage',
    offers: [
      {
        role: AppAuthorizationOfferRole.AUTHORITY,
        identityID: 'retained-storage',
      },
    ],
  });
  await mount();
  mockIdentities = [...mockIdentities, selectedStorage];
  await act(async () => view.update(<Review {...props} />));
  expect(button('Choose identity')).toBeDefined();
  act(() => button('Choose identity').props.onPress());
  expect(
    view.root
      .findByType('IdentityPicker')
      .props.data.map(item => item.identityID),
  ).toEqual(['user']);
  expect(mockApprove).not.toHaveBeenCalled();
});

it('asks which unlisted gift identity to use when more than one is eligible', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    selectedIdentity: null,
    hasGift: true,
  });
  mockLoadGift.mockResolvedValue({
    requiresPassword: false,
    identities: [
      {identityAddress: 'gift-one', systemId: 'system'},
      {identityAddress: 'gift-two', systemId: 'system'},
    ],
  });
  await mount();
  expect(button('Choose identity')).toBeDefined();
  act(() => button('Choose identity').props.onPress());
  expect(
    view.root
      .findByType('IdentityPicker')
      .props.data.map(item => item.identityID),
  ).toEqual(['user', 'gift-one', 'gift-two']);
  expect(mockApprove).not.toHaveBeenCalled();
});

it('authorizes an existing identity and storage with one fee and encryption included', async () => {
  const sign = jest.fn();
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    requiresSharedStorage: true,
    storageBindings: [
      {
        storageIdentity: 'storage',
        revocationIdentity: 'user',
        recoveryIdentity: 'user',
      },
    ],
  });
  mockApprove.mockImplementation(async (_jobId, _selection, context) => {
    if (await context.confirmFees(verifiedFeeReview)) sign();
  });
  await mount();
  expect(textContent(view.root)).toContain('Private app messages');
  expect(textContent(view.root)).toContain('STEP 1 OF 3');
  let operation;
  await act(async () => {
    operation = button('Review fees').props.onPress();
  });
  expect(sign).not.toHaveBeenCalled();
  expect(button('Approve connection').props.disabled).toBe(false);
  expect(textContent(view.root)).toContain('Pay now · Complete setup');
  expect(textContent(view.root)).toContain('0.0001 VRSC');
  expect(textContent(view.root)).toContain('1 transaction');
  expect(textContent(view.root)).toContain(
    'Paid from your available wallet funds',
  );
  expect(textContent(view.root)).not.toContain('Gift funds after fees');
  expect(textContent(view.root)).not.toContain('this step only');
  expect(view.root.findAllByType('ListItem')).toHaveLength(0);
  await act(async () => {
    button('Approve connection').props.onPress();
    await operation;
  });
  expect(sign).toHaveBeenCalledTimes(1);
  expect(mockApprove).toHaveBeenCalledTimes(1);
});

it.each(['Back to review', 'Done for now', 'Cancel request'])(
  '%s declines outstanding fees without signing or trapping the operation',
  async action => {
    const sign = jest.fn();
    mockApprove.mockImplementation(async (_jobId, _selection, context) => {
      if (await context.confirmFees(verifiedFeeReview)) sign();
    });
    await mount();
    let operation;
    await act(async () => {
      operation = button('Review fees').props.onPress();
    });
    expect(button(action).props.disabled).not.toBe(true);
    if (action === 'Cancel request') {
      await cancelRequest();
    } else {
      act(() => button(action).props.onPress());
    }
    await act(async () => {
      await operation;
    });
    expect(sign).not.toHaveBeenCalled();
    if (action !== 'Done for now') {
      expect(button('Approve connection')).toBeUndefined();
    }
    expect(view.root.findAllByProps({accessibilityRole: 'alert'})).toHaveLength(
      0,
    );
    if (action === 'Cancel request') {
      expect(mockCancel).toHaveBeenCalledTimes(1);
      expect(button('Done')).toBeDefined();
    } else if (action === 'Done for now') {
      expect(props.navigation.dispatch).toHaveBeenCalledWith({
        type: 'RESET',
        payload: {index: 0, routes: [{name: 'SignedInStack'}]},
      });
    } else {
      expect(button('Review fees')).toBeDefined();
    }
  },
);

it('declines old fee consent when a different job replaces the screen in the same session', async () => {
  let oldContext;
  const sign = jest.fn();
  mockApprove.mockImplementation(async (_jobId, _selection, context) => {
    oldContext = context;
    if (await context.confirmFees(verifiedFeeReview)) sign();
  });
  await mount();
  let operation;
  await act(async () => {
    operation = button('Review fees').props.onPress();
  });
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    id: 'other-job',
    appId: 'current-app',
  });
  await act(async () => {
    view.update(<Review {...props} route={{params: {jobId: 'other-job'}}} />);
    await operation;
  });
  expect(() => oldContext.assertActive()).toThrow('closed');
  expect(sign).not.toHaveBeenCalled();
  expect(button('Approve connection')).toBeUndefined();
  expect(textContent(view.root)).toContain('current-app');
  expect(textContent(view.root)).not.toContain('app-id');
});

it('loads saved progress once and allows leaving during a slow confirmation check', async () => {
  const confirmation = deferred();
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'waiting_for_grant_confirmation',
  });
  mockApprove.mockReturnValue(confirmation.promise);
  await mount();
  expect(mockLoadReview).toHaveBeenCalledTimes(1);
  expect(mockReconcile).not.toHaveBeenCalled();
  let operation;
  act(() => {
    operation = button('Check progress').props.onPress();
  });
  expect(button('Done for now').props.disabled).toBe(false);
  expect(textContent(view.root)).not.toContain('Preparing your fee review');
  act(() => button('Done for now').props.onPress());
  await act(async () => {
    confirmation.resolve({});
    await operation;
  });
  expect(mockLoadReview).toHaveBeenCalledTimes(1);
  expect(props.navigation.dispatch).toHaveBeenCalledTimes(1);
});

it('polls pending confirmations without overlaps and stops after leaving', async () => {
  jest.useFakeTimers();
  try {
    const confirmation = deferred();
    mockLoadReview.mockResolvedValue({
      ...initialReview,
      status: 'waiting_for_grant_confirmation',
    });
    mockReconcile.mockReturnValue(confirmation.promise);
    await mount();
    act(() => jest.advanceTimersByTime(20000));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(40000));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(button('Done for now').props.disabled).toBe(false);
    act(() => view.unmount());
    view = null;
    await act(async () => {
      confirmation.resolve({});
    });
    act(() => jest.advanceTimersByTime(40000));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it('reuses review metadata during unchanged polls and refreshes when confirmation advances', async () => {
  jest.useFakeTimers();
  try {
    const pending = {
      ...initialReview,
      status: 'waiting_for_grant_confirmation',
    };
    mockLoadReview.mockResolvedValue(pending);
    mockReconcile.mockResolvedValue(pending);
    await mount();
    await act(async () => jest.advanceTimersByTime(20000));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockLoadReview).toHaveBeenCalledTimes(1);

    const confirmed = {
      ...initialReview,
      appId: 'confirmed-app',
      status: 'response_ready',
      grantConfirmed: true,
    };
    mockReconcile.mockResolvedValue(confirmed);
    mockLoadReview.mockResolvedValue(confirmed);
    await act(async () => jest.advanceTimersByTime(20000));
    expect(mockReconcile).toHaveBeenCalledTimes(2);
    expect(mockLoadReview).toHaveBeenCalledTimes(2);
    expect(textContent(view.root)).toContain('confirmed-app');
  } finally {
    jest.useRealTimers();
  }
});

it('shows background completion and clears the preceding foreground error', async () => {
  mockApprove.mockRejectedValue(new Error('Connection interrupted'));
  await mount();
  await act(async () => button('Review fees').props.onPress());
  expect(textContent(view.root)).toContain('Connection interrupted');

  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'response_ready',
  });
  mockState.channelStore_verusid.authorizationJobs['saved-job'] = {
    id: 'saved-job',
    accountHash: 'profile',
    status: 'response_ready',
  };
  await act(async () => view.update(<Review {...props} />));

  expect(button('Notify app')).toBeDefined();
  expect(textContent(view.root)).not.toContain('Connection interrupted');
  expect(mockLoadReview).toHaveBeenCalledTimes(2);
  expect(mockReconcile).not.toHaveBeenCalled();
});

it('does not reload for repeated publications of the same job stage', async () => {
  mockState.channelStore_verusid.authorizationJobs['saved-job'] = {
    id: 'saved-job',
    accountHash: 'profile',
    status: initialReview.status,
  };
  await mount();
  mockState.channelStore_verusid.authorizationJobs['saved-job'] = {
    ...mockState.channelStore_verusid.authorizationJobs['saved-job'],
    updatedAt: Date.now(),
  };
  await act(async () => view.update(<Review {...props} />));

  expect(mockLoadReview).toHaveBeenCalledTimes(1);
});

it('waits for foreground work before applying a published background stage', async () => {
  const approval = deferred();
  mockApprove.mockReturnValue(approval.promise);
  await mount();
  act(() => button('Review fees').props.onPress());
  mockState.channelStore_verusid.authorizationJobs['saved-job'] = {
    id: 'saved-job',
    accountHash: 'profile',
    status: 'response_ready',
  };
  await act(async () => view.update(<Review {...props} />));
  expect(mockLoadReview).toHaveBeenCalledTimes(1);

  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'response_ready',
  });
  await act(async () => approval.resolve({}));
  expect(button('Notify app')).toBeDefined();
  expect(mockLoadReview).toHaveBeenCalledTimes(2);
});

it('ignores a job publication belonging to a different profile', async () => {
  await mount();
  mockState.channelStore_verusid.authorizationJobs['saved-job'] = {
    id: 'saved-job',
    accountHash: 'different-profile',
    status: 'complete',
  };
  await act(async () => view.update(<Review {...props} />));

  expect(mockLoadReview).toHaveBeenCalledTimes(1);
  expect(button('Review fees')).toBeDefined();
});

it.each(['complete', 'cancelled'])(
  'can resend a %s response without preparing or approving it again',
  async status => {
    mockLoadReview.mockResolvedValue({
      ...initialReview,
      status,
      grantConfirmed: status === 'complete',
      hasResponseDestination: true,
      canRetryResponse: true,
      canNotifyCancellation: false,
    });
    await mount();
    expect(button('Done')).toBeDefined();
    await act(async () => button('Notify app again').props.onPress());

    expect(mockDeliverResponse).toHaveBeenCalledTimes(1);
    expect(mockPrepareResponse).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  },
);

it('copies the frozen signed response explicitly when the app provides no response destination', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'response_ready',
    hasResponseDestination: false,
  });
  await mount();
  expect(button('Notify app')).toBeUndefined();
  expect(mockCopy).not.toHaveBeenCalled();
  expect(mockLoadPreparedResponse).not.toHaveBeenCalled();
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'complete',
    grantConfirmed: true,
    hasResponseDestination: false,
  });
  await act(async () => button('Copy response').props.onPress());
  expect(mockCopy).toHaveBeenCalledWith(
    Buffer.from('frozen-response').toString('hex'),
  );
  expect(mockDeliverResponse).toHaveBeenCalledTimes(1);
  expect(textContent(view.root)).toContain('Response copied');
  expect(textContent(view.root)).not.toContain('app has been notified');
  expect(button('Done')).toBeDefined();
});

it('discovers a gift on entry and unlocks it before reviewing the single connection fee', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    hasGift: true,
    status: 'gift_review',
  });
  mockLoadGift
    .mockResolvedValueOnce({requiresPassword: true})
    .mockResolvedValue({
      requiresPassword: false,
      identities: [{identityAddress: 'gift-id'}],
      currencies: [
        {
          systemId: 'system',
          currencyId: 'system',
          amount: '2',
          name: 'VRSCTEST',
        },
      ],
    });
  await mount();
  expect(mockLoadGift).toHaveBeenCalledTimes(1);
  expect(button('Review fees')).toBeUndefined();
  expect(button('Unlock gift').props.disabled).toBe(true);
  act(() =>
    view.root.findByType('TextInput').props.onChangeText('gift-password'),
  );
  await act(async () => button('Unlock gift').props.onPress());
  expect(mockLoadGift).toHaveBeenCalledWith(
    'saved-job',
    {password: 'gift-password'},
    expect.any(Object),
  );
  expect(textContent(view.root)).toContain('2 VRSCTEST');
  expect(mockApprove).not.toHaveBeenCalled();
  // Unlocking already returns the inventory; it needs no second review or scan.
  expect(mockLoadReview).toHaveBeenCalledTimes(1);
  expect(mockLoadGift).toHaveBeenCalledTimes(2);
  await act(async () => button('Review fees').props.onPress());
  expect(mockApprove).toHaveBeenCalledTimes(1);
  expect(button('Continue claim')).toBeUndefined();
  expect(button('Pay & prepare')).toBeUndefined();
});

it('checks a pending transaction without starting another approval', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'waiting_for_grant_confirmation',
  });
  await mount();
  await act(async () => button('Check progress').props.onPress());
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(mockPrepareResponse).not.toHaveBeenCalled();
});

it('can send a cancellation response without presenting another approval action', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'response_ready',
    grantConfirmed: false,
  });
  await mount();
  expect(button('Review fees')).toBeUndefined();
  await act(async () => button('Notify app').props.onPress());
  expect(mockPrepareResponse).toHaveBeenCalledTimes(1);
  expect(mockDeliverResponse).toHaveBeenCalledTimes(1);
  expect(mockApprove).not.toHaveBeenCalled();
});

it('keeps expired gift recovery available without allowing new approval or claims', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    status: 'expired',
    hasGift: true,
    giftRecoveryPending: true,
  });
  await mount();
  expect(button('Review fees')).toBeUndefined();
  expect(button('Review fees')).toBeUndefined();
  expect(button('Continue claim')).toBeUndefined();
  await act(async () => button('Check gift progress').props.onPress());
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockApprove).not.toHaveBeenCalled();
  await cancelRequest();
  expect(mockCancel).toHaveBeenCalledTimes(1);
  expect(button('Done')).toBeDefined();
});

it('reviews a combined gift and channel together, then approves exactly one fee', async () => {
  const {AppAuthorizationOfferRole} = require('verus-typescript-primitives');
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    appEncryption: {returnESK: false},
    hasGift: true,
    giftConfirmed: false,
    selectedIdentity: null,
    requiresSharedStorage: true,
    status: 'gift_review',
    offers: [
      {role: AppAuthorizationOfferRole.AUTHORITY, identityID: 'gift-user'},
      {role: AppAuthorizationOfferRole.STORAGE, identityID: 'gift-storage'},
    ],
  });
  mockLoadGift.mockResolvedValue({
    requiresPassword: false,
    identities: [
      {
        identityAddress: 'gift-user',
        systemId: 'system',
        fullyQualifiedName: 'New user.VRSCTEST@',
      },
      {
        identityAddress: 'gift-storage',
        systemId: 'system',
        fullyQualifiedName: 'Shared notes.VRSCTEST@',
      },
    ],
    currencies: [
      {systemId: 'system', currencyId: 'system', amount: '2', name: 'VRSCTEST'},
    ],
  });
  const sign = jest.fn();
  mockApprove.mockImplementation(async (_id, _selection, context) => {
    if (
      await context.confirmFees({
        ...verifiedFeeReview,
        giftAllocation: {
          currency: 'system',
          reserve: {identityID: 'gift-user', atomic: '200000', coins: '0.002'},
          storage: [
            {identityID: 'gift-storage', atomic: '199790000', coins: '1.9979'},
          ],
        },
      })
    )
      sign();
  });
  await mount();
  expect(mockLoadGift).toHaveBeenCalledTimes(1);
  expect(
    view.root
      .findAllByType('ListItem')
      .some(
        item =>
          item.props.title === 'Your identity' &&
          item.props.description === 'New user.VRSCTEST@',
      ),
  ).toBe(true);
  expect(textContent(view.root)).toContain('Shared notes.VRSCTEST@');
  expect(textContent(view.root)).toContain('viewing keys');
  expect(textContent(view.root)).toContain('STEP 1 OF 3');
  let operation;
  await act(async () => {
    operation = button('Review fees').props.onPress();
  });
  expect(mockApprove.mock.calls[0][1]).toEqual({
    selectedIdentity: {identityID: 'gift-user', systemID: 'system'},
    delegateRevision: initialReview.delegateRevision,
    storageBindings: [
      {
        storageIdentity: 'gift-storage',
        revocationIdentity: 'gift-user',
        recoveryIdentity: 'gift-user',
      },
    ],
  });
  expect(textContent(view.root)).toContain('Paid from the gift funds');
  expect(textContent(view.root)).toContain('0.0001 VRSC');
  expect(textContent(view.root)).toContain('Gift funds after fees');
  expect(textContent(view.root)).toContain('Your reserve0.002 VRSC');
  expect(textContent(view.root)).toContain(
    'To your identityNew user.VRSCTEST@',
  );
  expect(textContent(view.root)).toContain('App storage1.9979 VRSC');
  expect(textContent(view.root)).toContain(
    'To shared storageShared notes.VRSCTEST@',
  );
  expect(textContent(view.root)).toContain('removing app access');
  expect(textContent(view.root)).toContain(
    'Shared storage funds pay for app writes.',
  );
  expect(textContent(view.root)).not.toContain('this step only');
  expect(sign).not.toHaveBeenCalled();
  await act(async () => {
    button('Approve connection').props.onPress();
    await operation;
  });
  expect(sign).toHaveBeenCalledTimes(1);
});

it('shows the whole net gift at the user identity when no storage is requested', async () => {
  mockLoadReview.mockResolvedValue({...initialReview, hasGift: true});
  mockApprove.mockImplementation(async (_id, _selection, context) =>
    context.confirmFees({
      ...verifiedFeeReview,
      giftAllocation: {
        currency: 'system',
        reserve: {identityID: 'user', atomic: '199990000', coins: '1.9999'},
        storage: [],
      },
    }),
  );
  await mount();
  let operation;
  await act(async () => {
    operation = button('Review fees').props.onPress();
  });

  expect(textContent(view.root)).toContain('Your reserve1.9999 VRSC');
  expect(textContent(view.root)).toContain('To your identityMy identity');
  expect(textContent(view.root)).not.toContain('To shared storage');
  expect(textContent(view.root)).not.toContain('Shared storage funds pay');
  await act(async () => {
    button('Back to review').props.onPress();
    await operation;
  });
});

it('keeps the combined transaction waiting screen dismissible without claiming gifts separately', async () => {
  mockLoadReview.mockResolvedValue({
    ...initialReview,
    hasGift: true,
    giftConfirmed: false,
    selectionsLocked: true,
    status: 'waiting_for_grant_confirmation',
  });
  await mount();
  expect(mockLoadGift).not.toHaveBeenCalled();
  expect(textContent(view.root)).toContain(
    'Waiting for one block confirmation',
  );
  expect(button('Done for now').props.disabled).not.toBe(true);
  act(() => button('Done for now').props.onPress());
  expect(props.navigation.dispatch).toHaveBeenCalled();
});
