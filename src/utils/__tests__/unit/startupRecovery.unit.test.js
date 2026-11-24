jest.mock('../../../containers/RootStack/RootStackScreens', () => () => null)
jest.mock('../../../components/Modal', () => () => null)
jest.mock('../../../components/Alert', () => () => null)
jest.mock('../../../components/SendModal/SendModal', () => () => null)
jest.mock('../../../components/LoadingModal/LoadingModal', () => () => null)
jest.mock('../../../actions/actionCreators', () => ({
  fetchUsers: jest.fn(),
  loadServerVersions: jest.fn(),
  loadCachedHeaders: jest.fn(),
  loadEthTxReceipts: jest.fn(),
  initSettings: jest.fn(),
  fetchActiveCoins: jest.fn(),
  requestSeedData: jest.fn(),
  initNotifications: jest.fn(),
  initInstanceKey: jest.fn(),
}))
jest.mock('../../../actions/actionDispatchers', () => ({
  activateKeyboardListener: jest.fn(),
  updateDeeplinkUrl: jest.fn(),
}))
jest.mock('../../CoinData/CoinData', () => ({
  CoinLogos: {VRSC: {light: () => null}},
}))
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    setVrpcOverrides: jest.fn(),
    populateEthereumContractDefinitionsFromStorage: jest.fn(),
    populatePbaasCurrencyDefinitionsFromStorage: jest.fn(),
  },
}))
jest.mock('../../asyncStore/asyncStore', () => ({
  initCache: jest.fn(),
  clearCachedVersions: jest.fn(),
  updateActiveCoinList: jest.fn(),
  checkAndSetVersion: jest.fn(),
  purgeUnusedCoins: jest.fn(),
  clearCachedVrpcResponses: jest.fn(),
}))
jest.mock('../../asyncStore/currencyDefinitionStorage', () => ({
  removeInactiveCurrencyDefinitions: jest.fn(),
}))
jest.mock('../../asyncStore/contractDefinitionStorage', () => ({
  removeInactiveContractDefinitions: jest.fn(),
}))
jest.mock('../../auth/authBox', () => ({initInstance: jest.fn()}))
jest.mock('../../keychain/secureStore', () => ({
  SecureStorage: {initializeWithKeychain: jest.fn()},
}))
jest.mock('../../asyncStore/authDataStorage', () => ({
  recoverPasswordMigration: jest.fn(),
}))
jest.mock('@react-navigation/native', () => ({
  NavigationContainer: ({children}) => children,
}))
jest.mock('react-native-paper', () => ({
  Portal: {Host: ({children}) => children},
}))

import { Alert, AppState, Linking, LogBox } from 'react-native'
import { VerusMobile } from '../../../VerusMobile'
import {
  initSettings,
  loadCachedHeaders,
} from '../../../actions/actionCreators'
import { updateDeeplinkUrl } from '../../../actions/actionDispatchers'
import { SecureStorage } from '../../keychain/secureStore'
import { settings } from '../../../reducers/settings'
import { SET_ALL_SETTINGS } from '../../constants/storeType'
import { APP_AUTHORIZATION_REQUEST_VDXF_KEY } from 'verus-typescript-primitives'
import {
  assertExperimentalGenericRequestAllowed,
  EXPERIMENTAL_DEEPLINK_DISABLED_MESSAGE,
  isExperimentalGenericRequestsEnabled,
} from '../../deeplink/experimentalDeeplinks'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const storedSettings = enabled => ({
  type: SET_ALL_SETTINGS,
  settings: {
    generalWalletSettings: {
      enableExperimentalGenericRequests: enabled,
      vrpcOverrides: {},
    },
  },
})
const authorizationRequest = {
  details: [{ getIAddressKey: () => APP_AUTHORIZATION_REQUEST_VDXF_KEY.vdxfid }],
}
let state, urlListener, accepted, rejected
const start = () => {
  const component = new VerusMobile({
    dispatch: jest.fn(action => {
      if (action?.type) state.settings = settings(state.settings, action)
    }),
  })
  component.setLoading = jest.fn()
  component.componentDidMount()
  return component
}

beforeEach(() => {
  jest.clearAllMocks()
  state = { settings: settings(undefined, { type: 'INIT' }) }
  accepted = []
  rejected = []
  urlListener = undefined
  SecureStorage.initializeWithKeychain.mockResolvedValue()
  initSettings.mockReset().mockResolvedValue(storedSettings(true))
  loadCachedHeaders.mockReset().mockResolvedValue()
  jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(LogBox, 'ignoreLogs').mockImplementation(() => {})
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  jest.spyOn(Linking, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'url') urlListener = listener
    return { remove: jest.fn() }
  })
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null)

  // Observe admission using the real experimental gate and settings reducer.
  // Startup must hydrate the persisted preference before this boundary runs.
  updateDeeplinkUrl.mockImplementation(url => {
    if (!url) return
    try {
      assertExperimentalGenericRequestAllowed(authorizationRequest, state)
      accepted.push(url)
    } catch (error) {
      rejected.push({ url, message: error.message })
    }
  })
})

afterEach(() => jest.restoreAllMocks())

describe('startup recovery', () => {
  it('dismisses the splash after a storage initialization failure', async () => {
    const startupError = new Error('storage unavailable')
    const component = new VerusMobile({dispatch: jest.fn()})
    component.setLoading = jest.fn()
    await expect(component.initializeStorage(Promise.reject(startupError))).resolves.toBe(false)

    expect(Alert.alert).toHaveBeenCalledWith('Error', startupError.message)
    expect(component.setLoading).toHaveBeenCalledWith(false)
  })

  it('hydrates enabled settings before admitting the initial experimental deeplink', async () => {
    const pendingSettings = deferred()
    initSettings.mockReturnValue(pendingSettings.promise)
    Linking.getInitialURL.mockResolvedValue('verus://initial-authorization')
    const component = start()
    await flush()

    expect(initSettings).toHaveBeenCalledTimes(1)
    expect(isExperimentalGenericRequestsEnabled(state)).toBe(false)
    expect(updateDeeplinkUrl).not.toHaveBeenCalled()

    pendingSettings.resolve(storedSettings(true))
    await flush()

    expect(component.setLoading).toHaveBeenCalledWith(false)
    expect(accepted).toEqual(['verus://initial-authorization'])
    expect(rejected).toEqual([])
  })

  it('withholds incoming URLs until startup finishes and keeps only the latest event', async () => {
    const pendingSettings = deferred()
    initSettings.mockReturnValue(pendingSettings.promise)
    Linking.getInitialURL.mockResolvedValue('verus://initial-authorization')
    start()
    urlListener({ url: 'verus://older-event' })
    urlListener({ url: 'verus://latest-event' })
    await flush()
    expect(updateDeeplinkUrl).not.toHaveBeenCalled()

    pendingSettings.resolve(storedSettings(true))
    await flush()

    expect(updateDeeplinkUrl).toHaveBeenCalledTimes(1)
    expect(accepted).toEqual(['verus://latest-event'])
    expect(rejected).toEqual([])
  })

  it('preserves an explicitly disabled experimental setting after startup', async () => {
    initSettings.mockResolvedValue(storedSettings(false))
    Linking.getInitialURL.mockResolvedValue('verus://disabled-authorization')
    start()
    await flush()

    expect(isExperimentalGenericRequestsEnabled(state)).toBe(false)
    expect(updateDeeplinkUrl).toHaveBeenCalledWith('verus://disabled-authorization')
    expect(accepted).toEqual([])
    expect(rejected).toEqual([{
      url: 'verus://disabled-authorization',
      message: EXPERIMENTAL_DEEPLINK_DISABLED_MESSAGE,
    }])
  })

  it('dispatches no initial or incoming URL if startup fails after settings have loaded', async () => {
    const pendingHeaders = deferred()
    const startupError = new Error('cached headers unavailable')
    loadCachedHeaders.mockReturnValue(pendingHeaders.promise)
    Linking.getInitialURL.mockResolvedValue('verus://initial-authorization')
    const component = start()
    await flush()

    expect(isExperimentalGenericRequestsEnabled(state)).toBe(true)
    urlListener({ url: 'verus://incoming-authorization' })
    await flush()
    expect(updateDeeplinkUrl).not.toHaveBeenCalled()

    pendingHeaders.reject(startupError)
    await flush()

    expect(Alert.alert).toHaveBeenCalledWith('Error', startupError.message)
    expect(component.setLoading).toHaveBeenCalledWith(false)
    expect(updateDeeplinkUrl).not.toHaveBeenCalled()
  })

  it('does not replace a newer event with a slow initial URL after startup', async () => {
    const initialURL = deferred()
    Linking.getInitialURL.mockReturnValue(initialURL.promise)
    start()
    await flush()
    expect(isExperimentalGenericRequestsEnabled(state)).toBe(true)
    expect(updateDeeplinkUrl).not.toHaveBeenCalled()

    await urlListener({ url: 'verus://newer-event' })
    expect(accepted).toEqual(['verus://newer-event'])

    initialURL.resolve('verus://older-initial-url')
    await flush()

    expect(updateDeeplinkUrl).toHaveBeenCalledTimes(1)
    expect(accepted).toEqual(['verus://newer-event'])
  })
})
