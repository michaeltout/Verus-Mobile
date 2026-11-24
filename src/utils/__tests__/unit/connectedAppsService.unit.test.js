let mockState;
const mockDispatch = jest.fn();

jest.mock('react-redux', () => ({
  useSelector: selector => selector(mockState),
  connect: mapState => Component => props => require('react').createElement(Component, {
    ...mapState(mockState), ...props, dispatch: mockDispatch,
  }),
}));
jest.mock('react-native', () => ({SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView'}));
jest.mock('react-native-paper', () => ({
  Text: 'Text', Divider: 'Divider', List: {Item: 'List.Item', Icon: 'List.Icon', Subheader: 'List.Subheader'},
}));
jest.mock('../../../styles', () => ({defaultRoot: {}, root: {}, fullWidth: {}}));
jest.mock('../../../actions/actionCreators', () => ({clearSecureLoadingData: () => ({type: 'CLEAR_SECURE_LOADING'})}));
jest.mock('../../../containers/DeepLink/LinkedAppInstances/LinkedAppInstances', () => 'ConnectedAppsManagement');
jest.mock('../../../containers/Services/ServiceComponents/VerusIdService/VerusIdService', () => 'VerusIdService');
jest.mock('../../../containers/Services/ServiceComponents/WyreService/WyreService', () => 'WyreService');
jest.mock('../../../containers/Services/ServiceComponents/PbaasPreconvertService/PbaasPreconvertService', () => 'PbaasPreconvertService');
jest.mock('../../../containers/Services/ServiceComponents/GiftCardService/GiftCardService', () => 'GiftCardService');

const React = require('react');
const {act, create} = require('react-test-renderer');
const Service = require('../../../containers/Services/Service/Service').default;
const ServicesOverview = require('../../../containers/Services/ServicesOverview/ServicesOverview').default;
const {CONNECTED_APPS_SERVICE_ID, GIFT_CARD_SERVICE_ID} = require('../../constants/services');
const {authorizationNotifications} = require('../../appAuthorization/notifications');
const {AUTHORIZATION_STATUS} = require('../../appAuthorization/constants');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    authentication: {activeAccount: {accountHash: 'profile', disabledServices: {}}},
    settings: {generalWalletSettings: {enableExperimentalGenericRequests: false}},
    secureLoading: {successData: null},
  };
});

it('lists Connected Apps with the other services only when experimental requests are enabled', () => {
  const navigation = {navigate: jest.fn()};
  let view;
  act(() => {view = create(<ServicesOverview navigation={navigation} />);});
  expect(view.root.findAllByProps({title: 'Connected Apps'})).toHaveLength(0);
  expect(view.root.findAllByProps({title: 'VerusID'})).toHaveLength(1);

  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = true;
  act(() => view.update(<ServicesOverview navigation={navigation} />));
  const row = view.root.findByProps({title: 'Connected Apps'});
  expect(row.props.description).toContain('shared storage identities');
  act(() => row.props.onPress());
  expect(navigation.navigate).toHaveBeenCalledWith('Service', {service: CONNECTED_APPS_SERVICE_ID});

  mockState.authentication.activeAccount.disabledServices[CONNECTED_APPS_SERVICE_ID] = true;
  act(() => view.update(<ServicesOverview navigation={navigation} />));
  expect(view.root.findAllByProps({title: 'Connected Apps'})).toHaveLength(0);
});

it('reuses the management screen with its selected user and gates direct or restored service navigation', () => {
  const navigation = {navigate: jest.fn()};
  const user = {identityID: 'user', systemID: 'system'};
  const route = {params: {service: CONNECTED_APPS_SERVICE_ID, user}};
  let view;
  act(() => {view = create(<Service navigation={navigation} route={route} />);});
  expect(view.root.findAllByType('ConnectedAppsManagement')).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain('Enable experimental deeplinks');

  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = true;
  act(() => view.update(<Service navigation={navigation} route={route} />));
  expect(view.root.findByType('ConnectedAppsManagement').props.route.params.user).toBe(user);
  expect(view.root.findByType('ConnectedAppsManagement').props.navigation).toBe(navigation);

  // Navigation may reuse the Service route when the user chooses another tile.
  act(() => view.update(<Service navigation={navigation} route={{params: {service: GIFT_CARD_SERVICE_ID}}} />));
  expect(view.root.findAllByType('ConnectedAppsManagement')).toHaveLength(0);
  expect(view.root.findAllByType('GiftCardService')).toHaveLength(1);
});

it('does not open the experimental service from a saved passthrough while disabled', () => {
  mockState.secureLoading.successData = {service: CONNECTED_APPS_SERVICE_ID};
  const navigation = {navigate: jest.fn()};
  act(() => {create(<ServicesOverview navigation={navigation} />);});
  expect(navigation.navigate).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledWith({type: 'CLEAR_SECURE_LOADING'});
});

it('resumes app-access removals in Services and keeps authorization approvals in their request flow', () => {
  const user = {identityID: 'user', systemID: 'system'};
  const jobs = {
    removal: {id: 'removal', kind: 'removal', accountHash: 'profile', selectedIdentity: user,
      status: AUTHORIZATION_STATUS.WAITING_FOR_REMOVAL, createdAt: 1},
    approval: {id: 'approval', accountHash: 'profile',
      status: AUTHORIZATION_STATUS.WAITING_FOR_GRANT, createdAt: 2},
  };
  const notices = authorizationNotifications(jobs, 'profile');
  const navigation = {navigate: jest.fn()};
  notices[0].onAction({navigation});
  expect(navigation.navigate).toHaveBeenLastCalledWith('ServicesHome', {
    screen: 'Service', params: {service: CONNECTED_APPS_SERVICE_ID, user},
  });
  notices[1].onAction({navigation});
  expect(navigation.navigate).toHaveBeenLastCalledWith('DeepLink', {
    screen: 'AppAuthorizationRequestInfo', params: {jobId: 'approval'},
  });
});
