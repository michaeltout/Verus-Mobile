let mockState;
let mockData;
let renders;
const mockReadStored = jest.fn();

jest.mock('react-redux', () => ({
  useSelector: selector => selector(mockState),
}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: (...args) => mockReadStored(...args),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  assertAuthorizationContext: context => context.assertActive(),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    findCoinObj: chain => {
      const coins = {
        VRSC: {id: 'VRSC', system_id: 'main', display_ticker: 'VRSC'},
        AUX: {id: 'AUX', system_id: 'auxiliary', display_ticker: 'AUX'},
        VRSCTEST: {id: 'VRSCTEST', system_id: 'test', testnet: true},
      };
      if (!coins[chain]) throw new Error('Unknown chain');
      return coins[chain];
    },
  },
}));

const React = require('react');
const {act, create} = require('react-test-renderer');
const {
  useAuthorizationIdentities,
} = require('../../../hooks/useAuthorizationIdentities');
const {VERUSID_SERVICE_ID} = require('../../constants/services');
const context = {assertActive: jest.fn()};
const Inventory = ({includeStorage, requestContext = context}) => {
  const identities = useAuthorizationIdentities(
    requestContext,
    0,
    includeStorage,
  );
  return <InventoryRows identities={identities} />;
};
const InventoryRows = ({identities}) => {
  renders.push(identities);
  return null;
};
let view;
const rows = () => view.root.findByType(InventoryRows).props.identities;
const mount = async (props = {}) => {
  await act(async () => {
    view = create(<Inventory {...props} />);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  renders = [];
  mockState = {
    services: {stored: {[VERUSID_SERVICE_ID]: {revision: 1}}},
    authentication: {activeAccount: {testnetOverrides: {}}},
  };
  mockData = {
    linked_ids: {
      VRSC: {user: 'User.VRSC@', storage: 'Stale linked name@'},
      VRSCTEST: {testUser: 'Test user.VRSCTEST@'},
    },
    storage_ids: {
      VRSC: {
        storage: {
          name: 'Shared.VRSC@',
          userIdentityIDs: ['user', 'another-user'],
        },
      },
      AUX: {auxStorage: {name: 'Auxiliary@', userIdentityIDs: ['aux-user']}},
      VRSCTEST: {
        testStorage: {
          name: 'Test storage.VRSCTEST@',
          userIdentityIDs: ['testUser'],
        },
      },
      UNKNOWN: {unavailable: {name: 'Unavailable@', userIdentityIDs: ['user']}},
    },
  };
  mockReadStored.mockReset().mockImplementation(async () => mockData);
});

afterEach(() => {
  if (view) act(() => view.unmount());
  view = null;
});

it('defaults to independent linked identities and excludes stale storage links on the active network', async () => {
  await mount();

  expect(rows()).toEqual([
    expect.objectContaining({
      identityID: 'user',
      systemID: 'main',
      title: 'User@',
      isStorage: false,
    }),
  ]);
  expect(mockReadStored).toHaveBeenCalledWith(VERUSID_SERVICE_ID);
  expect(context.assertActive).toHaveBeenCalledTimes(1);
});

it('includes classified storage once with its user references only when requested', async () => {
  await mount({includeStorage: true});

  expect(rows()).toEqual([
    expect.objectContaining({
      identityID: 'auxStorage',
      systemID: 'auxiliary',
      isStorage: true,
      userIdentityIDs: ['aux-user'],
    }),
    expect.objectContaining({
      identityID: 'storage',
      systemID: 'main',
      title: 'Shared@',
      isStorage: true,
      userIdentityIDs: ['user', 'another-user'],
    }),
    expect.objectContaining({
      identityID: 'user',
      systemID: 'main',
      isStorage: false,
    }),
  ]);

  await act(async () => {
    view.update(<Inventory includeStorage={false} />);
  });
  expect(rows().map(row => row.identityID)).toEqual(['user']);

  mockState.authentication.activeAccount.testnetOverrides = {enabled: true};
  await act(async () => {
    view.update(<Inventory includeStorage />);
  });
  expect(
    rows().map(row => [row.identityID, row.systemID, row.isStorage]),
  ).toEqual([
    ['testStorage', 'test', true],
    ['testUser', 'test', false],
  ]);
});

it('does not restore a previous wallet inventory after its delayed encrypted read finishes', async () => {
  let resolveOld;
  const oldData = mockData;
  mockReadStored.mockReturnValueOnce(
    new Promise(resolve => {
      resolveOld = resolve;
    }),
  );
  await mount({includeStorage: true});
  expect(rows()).toEqual([]);

  mockData = {linked_ids: {VRSC: {newUser: 'New wallet@'}}, storage_ids: {}};
  const nextContext = {assertActive: jest.fn()};
  await act(async () => {
    view.update(<Inventory includeStorage requestContext={nextContext} />);
  });
  expect(rows().map(row => row.identityID)).toEqual(['newUser']);

  await act(async () => {
    resolveOld(oldData);
  });
  expect(rows().map(row => row.identityID)).toEqual(['newUser']);
});

it('keeps display choices while an unrelated service update is being read', async () => {
  await mount();
  let resolveRead;
  mockReadStored.mockReturnValueOnce(
    new Promise(resolve => {
      resolveRead = resolve;
    }),
  );
  mockState.services.stored[VERUSID_SERVICE_ID] = {revision: 2};
  await act(async () => view.update(<Inventory />));

  expect(rows().map(row => row.identityID)).toEqual(['user']);
  await act(async () => resolveRead(mockData));
  expect(rows().map(row => row.identityID)).toEqual(['user']);
});

it('never renders a loaded old-profile inventory while the new profile read is pending', async () => {
  await mount({includeStorage: true});
  const oldData = mockData;
  let resolveOld;
  let resolveNew;
  mockReadStored.mockReturnValueOnce(new Promise(resolve => {resolveOld = resolve;}));
  mockState.services.stored[VERUSID_SERVICE_ID] = {revision: 2};
  await act(async () => view.update(<Inventory includeStorage />));
  expect(rows().some(row => row.identityID === 'user')).toBe(true);

  mockReadStored.mockReturnValueOnce(new Promise(resolve => {resolveNew = resolve;}));
  const nextContext = {assertActive: jest.fn()};
  renders = [];
  await act(async () => {
    view.update(<Inventory includeStorage requestContext={nextContext} />);
  });
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.every(items => items.length === 0)).toBe(true);

  await act(async () => resolveOld(oldData));
  expect(rows()).toEqual([]);
  await act(async () => resolveNew({linked_ids: {VRSC: {newUser: 'New wallet@'}}}));
  expect(rows().map(row => row.identityID)).toEqual(['newUser']);
  expect(renders.flat().some(row => row.identityID === 'user')).toBe(false);
});

it.each(['network', 'storage visibility'])(
  'clears mismatched %s rows on the first render, before effects run',
  async changed => {
    await mount({includeStorage: true});
    let resolveRead;
    mockReadStored.mockReturnValueOnce(new Promise(resolve => {resolveRead = resolve;}));
    if (changed === 'network')
      mockState.authentication.activeAccount.testnetOverrides = {enabled: true};

    renders = [];
    await act(async () => {
      view.update(<Inventory includeStorage={changed !== 'storage visibility'} />);
    });
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every(items => items.length === 0)).toBe(true);
    await act(async () => resolveRead(mockData));
    expect(rows().map(row => row.identityID)).toEqual(
      changed === 'network' ? ['testStorage', 'testUser'] : ['user'],
    );
  },
);
