let mockState;
const mockValidate = jest.fn();
const mockAlert = jest.fn();
const mockOpenAuth = jest.fn();
const mockDispatch = jest.fn();
const mockRenderGeneric = jest.fn();
const mockFindAuthorization = jest.fn();
const mockCreateAuthorization = jest.fn();
const mockLoadPending = jest.fn();
const mockFindPreparedResponse = jest.fn();
const mockExperimentalGate = jest.fn();

jest.mock('react-native', () => ({View: 'View'}));
jest.mock('react-native-paper', () => ({Text: 'Text'}));
jest.mock('../../../components/Button', () => 'Button');
jest.mock('../../deeplink/pendingDeeplinkStorage', () => ({
  getPendingDeeplinkRequest: (...args) => mockLoadPending(...args), savePendingDeeplinkRequest: jest.fn(),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  createAuthorizationJob: (...args) => mockCreateAuthorization(...args),
  findAuthorizationJob: (...args) => mockFindAuthorization(...args),
}));
jest.mock('../../appAuthorization/delegatedOperations', () => ({
  findPreparedDelegatedResponse: (...args) => mockFindPreparedResponse(...args),
}));
jest.mock('@react-navigation/native', () => ({CommonActions: {reset: value => ({type: 'RESET', ...value})}}));
jest.mock('react-redux', () => ({useSelector: selector => selector(mockState), useDispatch: () => mockDispatch}));
jest.mock('../../../hooks/useObjectSelector', () => ({useObjectSelector: selector => selector(mockState)}));
jest.mock('../../../selectors/authentication', () => ({selectHasAuthenticatedSession: state => state.authentication.signedIn}));
jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../../styles', () => ({flexBackground: {}}));
jest.mock('../../../components/AnimatedActivityIndicatorBox', () => 'Loading');
jest.mock('../../../containers/DeepLink/LoginRequestInfo/LoginRequestInfo', () => 'LoginRequestInfo');
jest.mock('../../../containers/DeepLink/InvoiceInfo/InvoiceInfo', () => 'InvoiceInfo');
jest.mock('../../../containers/DeepLink/GenericRequestHome/GenericRequestHome', () => props => {
  mockRenderGeneric(props);
  return require('react').createElement('GenericRequestHome', props);
});
jest.mock('verusid-ts-client', () => ({hasAppAuthorizationRequest: request => request.marker === 'authorization', primitives: {
  IDENTITY_VIEW: {vdxfid: 'identity-view'},
  VERUSPAY_INVOICE_VDXF_KEY: {vdxfid: 'invoice'},
  GENERIC_REQUEST_DEEPLINK_VDXF_KEY: {vdxfid: 'generic'},
  LOGIN_CONSENT_REQUEST_VDXF_KEY: {vdxfid: 'login'},
  IDENTITY_UPDATE_REQUEST_VDXF_KEY: {vdxfid: 'identity'},
  GenericRequest: class {
    fromBuffer(bytes) {
      this.marker = bytes.toString();
      this.details = this.marker === 'upload'
        ? [{getIAddressKey: () => 'identity', data: {signDataMap: new Map([['content-key', {}]])}}]
        : this.marker === 'authorization'
          ? [{getIAddressKey: () => require('verus-typescript-primitives').APP_AUTHORIZATION_REQUEST_VDXF_KEY.vdxfid}]
          : [];
    }
    isTestnet() { return false; }
    isSigned() { return ['delegated', 'self-scoped', 'upload', 'authorization'].includes(this.marker); }
    hasAppOrDelegatorID() { return ['delegated', 'self-scoped', 'unsigned-scoped', 'authorization'].includes(this.marker); }
    appOrDelegatorID = {toIAddress: () => this.marker === 'self-scoped' ? 'signing-app' : 'delegated-user'};
    signature = {identityID: {toIAddress: () => 'signing-app'}};
  },
}}));
jest.mock('../../../actions/actions/alert/dispatchers/alert', () => ({createAlert: (...args) => mockAlert(...args)}));
jest.mock('../../../actions/actions/sendModal/dispatchers/sendModal', () => ({openAuthenticateUserModal: (...args) => mockOpenAuth(...args)}));
jest.mock('../../../actions/actionCreators', () => ({
  resetDeeplinkData: requestId => ({type: 'RESET_DEEPLINK', ...(requestId == null ? {} : {expectedRequestId: requestId})}),
  setDeeplinkData: (id, data, fromService, passthrough) => ({type: 'SET_DEEPLINK_DATA', payload: {id, data, fromService, passthrough}}),
}));
jest.mock('../../vrpc/vrpcInterface', () => ({initEndpoint: jest.fn()}));
jest.mock('../../api/channels/vrpc/callCreators', () => ({getInfo: async () => ({result: {blocks: 100, chainid: 'system-id'}})}));
jest.mock('../../api/channels/verusid/callCreators', () => ({}));
jest.mock('../../CoinData/CoinDirectory', () => ({CoinDirectory: {
  getBasicCoinObj: () => ({id: 'VRSC', system_id: 'system-id', vrpc_endpoints: ['http://unused.invalid']}),
}}));
jest.mock('../../fullyqualifiedname', () => ({convertFqnToDisplayFormat: value => value}));
jest.mock('../../math', () => ({}));
jest.mock('../../deeplink/validator/envelopeValidator', () => ({validateGenericRequest: (...args) => mockValidate(...args)}));
jest.mock('../../deeplink/experimentalDeeplinks', () => ({assertExperimentalGenericRequestAllowed: (...args) => mockExperimentalGate(...args)}));
jest.mock('../../deeplink/verusPayBurnChangePrice', () => ({}));
jest.mock('../../deeplink/requestAccounts', () => ({assertRequestNetworkMatchesAccount: jest.fn()}));

const React = require('react');
const {act, create} = require('react-test-renderer');
const DeepLink = require('../../../containers/DeepLink/DeepLink').default;
const hex = value => Buffer.from(value).toString('hex');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
let props, views;
const mount = async () => {
  let view;
  await act(async () => { view = create(<DeepLink {...props} />); });
  views.add(view);
  return view;
};
const unmount = view => { act(() => view.unmount()); views.delete(view); };
const replace = async (view, marker = 'replacement') => {
  mockState = {...mockState, deeplink: {id: 'generic', data: hex(marker), requestId: mockState.deeplink.requestId + 1}};
  await act(async () => { view.update(<DeepLink {...props} />); });
};
const expectNoOldEffects = (closed = false) => {
  expect(mockAlert).not.toHaveBeenCalled();
  if (closed) expect(mockDispatch).toHaveBeenCalledWith({type: 'RESET_DEEPLINK', expectedRequestId: 1});
  else expect(mockDispatch).not.toHaveBeenCalled();
  expect(props.navigation.dispatch).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockReset().mockResolvedValue(true);
  mockFindAuthorization.mockResolvedValue(null);
  mockCreateAuthorization.mockResolvedValue({id: 'authorization-job'});
  mockLoadPending.mockResolvedValue({requestBufferString: hex('authorization')});
  mockFindPreparedResponse.mockReset().mockResolvedValue(null);
  mockExperimentalGate.mockReset();
  props = {navigation: {dispatch: jest.fn(), navigate: jest.fn(), replace: jest.fn()}};
  views = new Set();
  mockState = {deeplink: {id: 'generic', data: hex('original'), requestId: 1},
    authentication: {signedIn: true, accounts: [{testnetOverrides: {}}], activeAccount: {testnetOverrides: {}}},
    alert: {active: false}, sendModal: {visible: false, type: null}};
});
afterEach(() => {
  views.forEach(view => act(() => view.unmount()));
  jest.useRealTimers();
});

it('routes bootstrap to its durable job without selecting an authentication signer first', async () => {
  mockState.deeplink.data = {authorizationPendingId: 'saved-authorization'};
  await mount();
  expect(mockValidate).toHaveBeenCalledTimes(1);
  expect(mockCreateAuthorization).toHaveBeenCalledTimes(1);
  expect(props.navigation.replace).toHaveBeenCalledWith('AppAuthorizationRequestInfo', {jobId: 'authorization-job'});
  expect(mockRenderGeneric).not.toHaveBeenCalled();
});

it('resumes an existing submitted job without applying a fresh approval expiry check', async () => {
  mockFindAuthorization.mockResolvedValue({id: 'submitted-job'});
  mockState.deeplink.data = {authorizationPendingId: 'saved-authorization'};
  await mount();
  expect(mockValidate).not.toHaveBeenCalled();
  expect(mockCreateAuthorization).not.toHaveBeenCalled();
  expect(props.navigation.replace).toHaveBeenCalledWith('AppAuthorizationRequestInfo', {jobId: 'submitted-job'});
});

it('preserves the encrypted request while a new user creates a profile', async () => {
  mockState.authentication = {signedIn: false, accounts: [], activeAccount: null};
  mockState.deeplink.data = {authorizationPendingId: 'saved-authorization'};
  const view = await mount();
  expect(mockCreateAuthorization).not.toHaveBeenCalled();
  await act(async () => view.root.findByType('Button').props.onPress());
  expect(mockDispatch).toHaveBeenCalledWith({type: 'SET_DEEPLINK_DATA', payload: {
    id: 'generic', data: {authorizationPendingId: 'saved-authorization'}, fromService: null,
    passthrough: {resumeAuthorizationAfterSetup: true, authorizationTestnet: false},
  }});
  expect(props.navigation.navigate).toHaveBeenCalledWith('SignedOutNoKeyStack', {screen: 'CreateProfile'});
});

it('routes a completed delegated rescan directly to delivery with the exact prepared bytes', async () => {
  mockState.deeplink.data = hex('delegated');
  mockFindPreparedResponse.mockResolvedValue({
    user: {identityID: 'recorded-user', systemID: 'recorded-system'},
    response: {toBuffer: () => Buffer.from('frozen signed response')},
  });
  await mount();
  expect(props.navigation.navigate).toHaveBeenCalledWith('GenericRequestComplete', {
    requestBufferString: hex('delegated'),
    responseBufferString: hex('frozen signed response'),
    appEncryptionSessionKey: expect.any(String),
  });
  expect(mockValidate).not.toHaveBeenCalled();
  expect(mockRenderGeneric).not.toHaveBeenCalled();
  expect(mockCreateAuthorization).not.toHaveBeenCalled();
});

it('keeps fresh delegated requests on the normal validation and review path', async () => {
  mockState.deeplink.data = hex('delegated');
  await mount();
  expect(mockFindPreparedResponse).toHaveBeenCalledTimes(1);
  expect(mockValidate).toHaveBeenCalledTimes(1);
  expect(mockRenderGeneric).toHaveBeenCalled();
  expect(props.navigation.navigate).not.toHaveBeenCalled();
});

it('rejects an unapproved delegated request after profile selection before showing its review', async () => {
  jest.useFakeTimers();
  mockState.authentication.signedIn = false;
  mockState.deeplink.data = hex('delegated');
  const reason = 'No linked identity has a current app approval for this delegate.';
  mockValidate.mockImplementation(async (request, context) => {
    context.assertActive();
    throw new Error(reason);
  });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const view = await mount();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockOpenAuth).toHaveBeenCalledTimes(1);
    expect(mockValidate).not.toHaveBeenCalled();

    mockState = {
      ...mockState,
      authentication: {...mockState.authentication, signedIn: true},
    };
    await act(async () => view.update(<DeepLink {...props} />));

    expect(mockValidate).toHaveBeenCalledWith(
      expect.objectContaining({marker: 'delegated'}),
      {assertActive: expect.any(Function)},
    );
    expect(mockAlert).toHaveBeenCalledWith('Error', reason);
    expect(mockRenderGeneric).not.toHaveBeenCalled();
    expect(mockCreateAuthorization).not.toHaveBeenCalled();
    expect(props.navigation.navigate).not.toHaveBeenCalled();
    expect(props.navigation.dispatch).toHaveBeenCalledWith({
      type: 'RESET', index: 0, routes: [{name: 'SignedInStack'}],
    });
  } finally {
    error.mockRestore();
  }
});

it.each(['session', 'network', 'replacement'])('discards a prepared response lookup after %s changes', async change => {
  const lookup = deferred();
  mockState.deeplink.data = hex('delegated');
  mockFindPreparedResponse.mockReturnValueOnce(lookup.promise);
  const view = await mount();
  if (change === 'session') mockState.authentication.sessionEpoch = 2;
  if (change === 'network') mockState.authentication.activeAccount.testnetOverrides = {VRSC: 'VRSCTEST'};
  if (change === 'replacement') await replace(view);
  await act(async () => lookup.resolve({response: {toBuffer: () => Buffer.from('old-response')}}));
  expect(props.navigation.navigate).not.toHaveBeenCalled();
  expect(mockAlert).not.toHaveBeenCalled();
});

it('rechecks the experimental gate before reopening a saved response', async () => {
  const lookup = deferred();
  mockState.deeplink.data = hex('delegated');
  mockFindPreparedResponse.mockReturnValueOnce(lookup.promise);
  await mount();
  mockExperimentalGate.mockImplementation(() => { throw new Error('Experimental requests disabled.'); });
  await act(async () => lookup.resolve({response: {toBuffer: () => Buffer.from('saved-response')}}));
  expect(props.navigation.navigate).not.toHaveBeenCalled();
  expect(mockRenderGeneric).not.toHaveBeenCalled();
  expect(mockAlert).toHaveBeenCalledWith('Error', 'Experimental requests disabled.');
});

it.each(['resolve', 'reject'])('ignores an old generic validation %s after a replacement is displayed', async outcome => {
  const old = deferred();
  mockValidate.mockReturnValueOnce(old.promise);
  const view = await mount();
  const validationContext = mockValidate.mock.calls[0][1];
  expect(() => validationContext.assertActive()).not.toThrow();
  expect(mockRenderGeneric).not.toHaveBeenCalled();
  await replace(view);
  expect(() => validationContext.assertActive()).toThrow('canceled or replaced');
  expect(view.root.findByType('GenericRequestHome').props.deeplinkData).toBe(hex('replacement'));
  await act(async () => old[outcome](outcome === 'reject' ? new Error('Obsolete validation failed') : true));
  expect(mockValidate.mock.calls.map(([request]) => request.marker)).toEqual(['original', 'replacement']);
  expect(mockRenderGeneric.mock.calls.every(([screen]) => screen.deeplinkData === hex('replacement'))).toBe(true);
  expectNoOldEffects();
});

it.each(['resolve', 'reject'])('ignores a pending generic validation %s after unmount', async outcome => {
  const old = deferred();
  mockValidate.mockReturnValueOnce(old.promise);
  const view = await mount();
  unmount(view);
  await act(async () => old[outcome](outcome === 'reject' ? new Error('Unmounted validation failed') : true));
  expect(mockRenderGeneric).not.toHaveBeenCalled();
  expectNoOldEffects(true);
});

it.each(['replace', 'unmount'])('cancels the delegated sign-in timer on %s', async change => {
  jest.useFakeTimers();
  mockState.authentication.signedIn = false;
  mockState.deeplink.data = hex('delegated');
  const view = await mount();
  expect(mockValidate).not.toHaveBeenCalled();
  if (change === 'replace') await replace(view);
  else unmount(view);
  act(() => jest.advanceTimersByTime(1000));
  expect(mockOpenAuth).not.toHaveBeenCalled();
  expectNoOldEffects(change === 'unmount');
  if (change === 'replace') expect(view.root.findByType('GenericRequestHome').props.deeplinkData).toBe(hex('replacement'));
});

it.each(['delegated', 'self-scoped', 'upload'])('opens the current %s sign-in prompt once and validates after sign-in', async marker => {
  jest.useFakeTimers();
  mockState.authentication.signedIn = false;
  mockState.deeplink.data = hex(marker);
  const view = await mount();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockOpenAuth).toHaveBeenCalledTimes(1);
  expect(mockValidate).not.toHaveBeenCalled();
  mockState = {...mockState, authentication: {...mockState.authentication, signedIn: true}};
  await act(async () => view.update(<DeepLink {...props} />));
  expect(mockValidate).toHaveBeenCalledTimes(1);
  expect(view.root.findByType('GenericRequestHome').props.deeplinkData).toBe(hex(marker));
  expectNoOldEffects();
});

it('rejects an unsigned explicit scope without requesting sign-in', async () => {
  jest.useFakeTimers();
  mockState.authentication.signedIn = false;
  mockState.deeplink.data = hex('unsigned-scoped');
  mockValidate.mockRejectedValueOnce(new Error('This type of request requires a signature'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await mount();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockOpenAuth).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Error', 'This type of request requires a signature');
  } finally {
    error.mockRestore();
  }
});

it('does not resume an old delegated request when sign-in and replacement arrive together', async () => {
  jest.useFakeTimers();
  mockState.authentication.signedIn = false;
  mockState.deeplink.data = hex('delegated');
  const view = await mount();
  mockState = {...mockState, authentication: {...mockState.authentication, signedIn: true},
    deeplink: {id: 'generic', data: hex('replacement'), requestId: mockState.deeplink.requestId + 1}};
  await act(async () => view.update(<DeepLink {...props} />));
  act(() => jest.advanceTimersByTime(1000));
  expect(mockValidate.mock.calls.map(([request]) => request.marker)).toEqual(['replacement']);
  expect(mockOpenAuth).not.toHaveBeenCalled();
  expect(view.root.findByType('GenericRequestHome').props.deeplinkData).toBe(hex('replacement'));
  expectNoOldEffects();
});

it('rejects an unsupported standalone identity-update protocol without processing it', async () => {
  mockState.deeplink = {id: 'identity', data: {details: {identity: {}}}};
  const view = await mount();
  expect(mockAlert).toHaveBeenCalledWith('Unsupported', 'Unsupported request');
  expect(mockDispatch).toHaveBeenCalledWith({type: 'RESET_DEEPLINK'});
  expect(mockValidate).not.toHaveBeenCalled();
  expect(view.root.findAllByType('GenericRequestHome')).toHaveLength(0);
});

it('a signed-out upload without a matching profile does not reach the local preview handler', async () => {
  mockState.authentication.signedIn = false;
  mockState.authentication.activeAccount = null;
  mockState.authentication.accounts = [];
  mockState.deeplink.data = hex('upload');
  await mount();
  expect(mockValidate).not.toHaveBeenCalled();
  expect(mockRenderGeneric).not.toHaveBeenCalled();
  expect(mockAlert).toHaveBeenCalledWith('Cannot continue', expect.stringContaining('No mainnet profiles'));
  expect(mockDispatch).toHaveBeenCalledWith({type: 'RESET_DEEPLINK'});
});

it('clears the current request on flow removal while preserving an identical replacement', async () => {
  const view = await mount();
  const oldRequestId = mockState.deeplink.requestId;
  mockState = {...mockState, deeplink: {...mockState.deeplink, requestId: oldRequestId + 1}};
  unmount(view);
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('leaves a cleared flow quietly after sign-out instead of showing unsupported-request errors', async () => {
  const view = await mount();
  mockState = {...mockState, authentication: {...mockState.authentication, signedIn: false},
    deeplink: {id: null, data: {}, requestId: 2}};
  await act(async () => view.update(<DeepLink {...props} />));
  expect(mockAlert).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(props.navigation.dispatch).toHaveBeenCalledWith(expect.objectContaining({routes: [{name: 'SignedOutStack'}]}));
});
