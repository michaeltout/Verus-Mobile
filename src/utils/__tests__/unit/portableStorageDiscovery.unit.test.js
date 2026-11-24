let mockView;
let mockData;
let mockState;
const mockReadData = jest.fn();
const mockLoadCredentials = jest.fn();
const mockCurrent = jest.fn();
const mockMarkStorage = jest.fn();
const mockRefreshWallet = jest.fn();
const mockSource = jest.fn();
const mockLoadIdentity = jest.fn();
const mockWalletKeys = jest.fn();

jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: (...args) => mockReadData(...args),
}));
jest.mock(
  '../../../actions/actions/services/dispatchers/verusid/verusid',
  () => ({
    markVerusIdAsStorage: (...args) => mockMarkStorage(...args),
  }),
);
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: jest.fn(),
}));
jest.mock('../../identityManagement/unlinkAfterUpdate', () => ({
  refreshLinkedIdentityWallet: (...args) => mockRefreshWallet(...args),
}));
jest.mock('../../appAuthorization/credentials', () => ({
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
  assertAuthorizationCredentialsCurrent: (...args) => mockCurrent(...args),
  invalidateAuthorizationCredentials: jest.fn(),
  buildAuthorizationRemovals: jest.fn(),
}));
jest.mock('../../appAuthorization/controls', () => ({
  authorizationSource: (...args) => mockSource(...args),
  authorizationContext: context => context,
  assertIndependentIdentityControl: jest.fn(),
  walletAuthorizationKeys: (...args) => mockWalletKeys(...args),
}));
jest.mock('verusid-ts-client', () => ({
  ...jest.requireActual('verusid-ts-client'),
  loadIdentityRevision: (...args) => mockLoadIdentity(...args),
}));
jest.mock('../../appAuthorization/transactions', () => ({
  confirmAuthorizationTransaction: jest.fn(),
  submitAuthorizationIdentityUpdate: jest.fn(),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  captureAuthorizationContext: options => options || {},
  assertAuthorizationContext: context => context.assertActive?.(),
  AUTHORIZATION_STATUS: {},
}));

const {
  AuthorizationStorageBindingCredential,
  I_ADDR_VERSION,
  R_ADDR_VERSION,
  toBase58Check,
  nameAndParentAddrToIAddr,
} = require('verus-typescript-primitives');
const {
  listAuthorizationStorageAccess,
} = require('../../appAuthorization/storageManagement');
const {VERUSID_SERVICE_ID} = require('../../constants/services');
const {VRPC} = require('../../constants/intervalConstants');

const address = byte => toBase58Check(Buffer.alloc(20, byte), I_ADDR_VERSION);
const systemID = address(1);
const otherSystemID = address(2);
const rootSystemID = nameAndParentAddrToIAddr('VRSC');
const user = {identityID: address(3), systemID};
const storageID = address(4);
const otherStorageID = address(5);
const otherUserID = address(6);
const appKeyID = '11'.repeat(20);
const userKeyID = '22'.repeat(20);
const context = {sessionScope: {accountHash: 'alice', sessionEpoch: 1}};

const relationship = (
  identityID = storageID,
  grantByte = '33',
  sourceUser = user,
) => {
  const entry = record => ({
    record,
    source: {
      ...sourceUser,
      outerKey: 'credential-bucket',
      storedValue: record.toCredential().toBuffer(),
    },
  });
  const grantID = grantByte.repeat(32);
  return {
    binding: entry(
      new AuthorizationStorageBindingCredential({
        version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
        grantID,
        relationshipIndex: 0,
        storageSystemID: sourceUser.systemID,
        storageID: identityID,
      }),
    ),
  };
};

const setRelationships = (entries, sourceUser = user) => {
  mockView = {
    source: {...sourceUser},
    rootSystemID,
    grants: [],
    storageBindings: entries.map(entry => entry.binding),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  setRelationships([relationship()]);
  mockData = {
    linked_ids: {
      VRSC: {[user.identityID]: 'user@', [storageID]: 'notes-storage@'},
    },
    registration_jobs: {saved: 'preserved'},
  };
  mockState = {
    authentication: {activeAccount: {}},
    channelStore_verusid: {
      watchedVerusIds: {VRSC: {...mockData.linked_ids.VRSC}},
    },
    coins: {activeCoinsForUser: [{id: 'VRSC', testnet: false}]},
    coinMenus: {allSubWallets: {}},
  };
  mockLoadCredentials.mockImplementation(async () => mockView);
  mockReadData.mockImplementation(async () => mockData);
  mockSource.mockImplementation(id => ({
    coin: {id: id === systemID ? 'VRSC' : 'VRSCTEST', testnet: id !== systemID},
  }));
  mockCurrent.mockResolvedValue(undefined);
  mockWalletKeys.mockReturnValue([{keyID: userKeyID}]);
  mockLoadIdentity.mockResolvedValue({
    status: 'active',
    blockheight: 1,
    identity: {
      primaryaddresses: [userKeyID, appKeyID].map(key =>
        toBase58Check(Buffer.from(key, 'hex'), R_ADDR_VERSION),
      ),
    },
  });
  mockMarkStorage.mockImplementation(
    async (identityID, name, chain, userIdentityID) => {
      const previous = mockData.storage_ids?.[chain]?.[identityID];
      mockData.storage_ids = {
        ...mockData.storage_ids,
        [chain]: {
          ...mockData.storage_ids?.[chain],
          [identityID]: {
            name,
            userIdentityIDs: [
              ...new Set([
                ...(previous?.userIdentityIDs || []),
                userIdentityID,
              ]),
            ],
          },
        },
      };
      delete mockData.linked_ids?.[chain]?.[identityID];
    },
  );
  mockRefreshWallet.mockImplementation(async chain => {
    mockState.channelStore_verusid.watchedVerusIds[chain] = {
      ...mockData.linked_ids?.[chain],
    };
    mockState.coinMenus.allSubWallets = {};
  });
});

test('classifies portable orphan storage and removes its wallet link after restoration', async () => {
  const result = await listAuthorizationStorageAccess(user, context);

  expect(result).toEqual([
    expect.objectContaining({storageID, orphaned: true}),
  ]);
  expect(mockReadData).toHaveBeenCalledWith(VERUSID_SERVICE_ID);
  expect(mockMarkStorage).toHaveBeenCalledWith(
    storageID,
    'notes-storage@',
    'VRSC',
    user.identityID,
    context,
  );
  expect(mockData.linked_ids.VRSC).toEqual({[user.identityID]: 'user@'});
  expect(mockData.registration_jobs).toEqual({saved: 'preserved'});
  expect(mockData.storage_ids.VRSC[storageID].userIdentityIDs).toEqual([
    user.identityID,
  ]);
  expect(mockRefreshWallet).toHaveBeenCalledTimes(1);
  expect(mockRefreshWallet).toHaveBeenCalledWith('VRSC', context);
  expect(JSON.stringify(result)).not.toContain('storedValue');
});

test('deduplicates repeated relationships and refreshes one chain once for several storage identities', async () => {
  const first = relationship();
  setRelationships([
    first,
    first,
    relationship(storageID, '44'),
    relationship(otherStorageID, '55'),
  ]);
  mockData.linked_ids.VRSC[otherStorageID] = 'second-storage@';

  expect(await listAuthorizationStorageAccess(user, context)).toHaveLength(3);
  expect(mockMarkStorage).toHaveBeenCalledTimes(2);
  expect(mockRefreshWallet).toHaveBeenCalledTimes(1);
});

test('reuses an already verified credential view when listing app storage', async () => {
  const result = await listAuthorizationStorageAccess(user, context, mockView);

  expect(result).toEqual([expect.objectContaining({storageID})]);
  expect(mockLoadCredentials).not.toHaveBeenCalled();
  expect(mockCurrent).toHaveBeenCalledWith(mockView, context);
});

test('does not reclassify or display reclaimed wallet storage because another user retains old records', async () => {
  mockLoadIdentity.mockResolvedValue({
    status: 'active',
    blockheight: 1,
    identity: {
      primaryaddresses: [
        toBase58Check(Buffer.from(userKeyID, 'hex'), R_ADDR_VERSION),
      ],
    },
  });

  expect(await listAuthorizationStorageAccess(user, context)).toEqual([]);
  expect(mockData.linked_ids.VRSC[storageID]).toBe('notes-storage@');
  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('leaves known nonlinked storage untouched on repeated discovery', async () => {
  await listAuthorizationStorageAccess(user, context);
  jest.clearAllMocks();

  await listAuthorizationStorageAccess(user, context);

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
  expect(mockCurrent).not.toHaveBeenCalled();
});

test('preserves previous user associations and names without refreshing an unlinked identity', async () => {
  mockData.linked_ids.VRSC = {[user.identityID]: 'user@'};
  mockState.channelStore_verusid.watchedVerusIds = {};
  mockData.storage_ids = {
    VRSC: {
      [storageID]: {name: 'saved-storage@', userIdentityIDs: [otherUserID]},
    },
  };

  await listAuthorizationStorageAccess(user, context);

  expect(mockData.storage_ids.VRSC[storageID]).toEqual({
    name: 'saved-storage@',
    userIdentityIDs: [otherUserID, user.identityID],
  });
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('retries a failed wallet rebuild after classification was already saved', async () => {
  mockRefreshWallet.mockRejectedValueOnce(new Error('Wallet refresh failed'));
  await expect(listAuthorizationStorageAccess(user, context)).rejects.toThrow(
    'Wallet refresh failed',
  );
  expect(mockData.linked_ids.VRSC[storageID]).toBeUndefined();
  mockMarkStorage.mockClear();

  await listAuthorizationStorageAccess(user, context);

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).toHaveBeenCalledTimes(2);
});

test('rebuilds stale storage cards even when watched IDs have already been refreshed', async () => {
  await listAuthorizationStorageAccess(user, context);
  mockState.coinMenus.allSubWallets.VRSC = [
    {channel: `${VRPC}.${storageID}.${systemID}`},
  ];
  jest.clearAllMocks();

  await listAuthorizationStorageAccess(user, context);

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).toHaveBeenCalledTimes(1);
});

test('classifies only the source network when the same address is linked on both networks', async () => {
  const testnetUser = {...user, systemID: otherSystemID};
  setRelationships([relationship(storageID, '33', testnetUser)], testnetUser);
  mockData.linked_ids.VRSCTEST = {[storageID]: 'test-storage@'};

  await listAuthorizationStorageAccess(testnetUser, context);

  expect(mockData.linked_ids.VRSC[storageID]).toBe('notes-storage@');
  expect(mockData.linked_ids.VRSCTEST[storageID]).toBeUndefined();
  expect(mockData.storage_ids.VRSCTEST[storageID]).toBeDefined();
  expect(mockData.storage_ids.VRSC).toBeUndefined();
  expect(mockRefreshWallet).toHaveBeenCalledWith('VRSCTEST', context);
});

test('does not refresh a known mainnet storage identity because its address has a testnet card', async () => {
  await listAuthorizationStorageAccess(user, context);
  mockState.coins.activeCoinsForUser.push({id: 'VRSCTEST', testnet: true});
  mockState.coinMenus.allSubWallets.VRSCTEST = [
    {
      channel: `${VRPC}.${storageID}.${otherSystemID}`,
    },
  ];
  jest.clearAllMocks();

  await listAuthorizationStorageAccess(user, context);

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test.each([
  'view-source',
  'record-source',
  'user-as-storage',
])('rejects %s before changing wallet classification', async mismatch => {
  if (mismatch === 'view-source') mockView.source.identityID = otherUserID;
  if (mismatch === 'record-source')
    mockView.storageBindings[0].source.identityID = otherUserID;
  if (mismatch === 'user-as-storage')
    mockView.storageBindings[0].record.data.storageID = user.identityID;

  await expect(listAuthorizationStorageAccess(user, context)).rejects.toThrow(
    'selected identity and network',
  );

  expect(mockReadData).not.toHaveBeenCalled();
  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('displays explicit storage on another system without changing local wallet classification', async () => {
  mockView.storageBindings[0].record.data.storageSystemID = otherSystemID;

  expect(await listAuthorizationStorageAccess(user, context)).toEqual([
    expect.objectContaining({storageID, storageSystemID: otherSystemID}),
  ]);
  expect(mockReadData).not.toHaveBeenCalled();
  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('an orphaned binding without a system resolves to the network root', async () => {
  delete mockView.storageBindings[0].record.data.storageSystemID;

  expect(await listAuthorizationStorageAccess(user, context)).toEqual([
    expect.objectContaining({storageID, storageSystemID: rootSystemID}),
  ]);
  expect(mockMarkStorage).not.toHaveBeenCalled();
});

test.each(['malformed', 'conflicting'])(
  'rejects %s bindings without partial classification',
  async kind => {
    if (kind === 'malformed') {
      delete mockView.storageBindings[0].record.data.storageID;
    } else {
      const conflict = relationship();
      conflict.binding.record.data.storageID = otherStorageID;
      mockView.storageBindings.push(conflict.binding);
    }

    await expect(
      listAuthorizationStorageAccess(user, context),
    ).rejects.toThrow();
    expect(mockMarkStorage).not.toHaveBeenCalled();
    expect(mockRefreshWallet).not.toHaveBeenCalled();
  },
);

test('rechecks the current credential view before making local changes', async () => {
  mockCurrent.mockRejectedValueOnce(new Error('Authorization content changed'));

  await expect(listAuthorizationStorageAccess(user, context)).rejects.toThrow(
    'Authorization content changed',
  );

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('stops classification when the originating screen or session changes during the read', async () => {
  let cancelled = false;
  const requestContext = {
    ...context,
    assertActive: () => {
      if (cancelled) throw new Error('Session changed');
    },
  };
  mockReadData.mockImplementationOnce(async () => {
    cancelled = true;
    return mockData;
  });

  await expect(
    listAuthorizationStorageAccess(user, requestContext),
  ).rejects.toThrow('Session changed');

  expect(mockMarkStorage).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});
