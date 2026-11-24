const mockLoadCredentials = jest.fn();
const mockListStorage = jest.fn();
const mockInspectStorage = jest.fn();
const mockLoadJobs = jest.fn();
const mockNames = jest.fn();
const mockIdentityRevision = jest.fn();

jest.mock('verusid-ts-client', () => ({
  loadIdentityRevision: (...args) => mockIdentityRevision(...args),
}));

jest.mock('../../appAuthorization/credentials', () => ({
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
}));
jest.mock('../../appAuthorization/storageManagement', () => ({
  listAuthorizationStorageAccess: (...args) => mockListStorage(...args),
  inspectAuthorizationStorageAccess: (...args) => mockInspectStorage(...args),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  assertAuthorizationContext: context => context.assertActive?.(),
  loadAuthorizationJobs: (...args) => mockLoadJobs(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  authorizationSource: systemID => ({systemID}),
  withAuthorizationReadScope: (context, action) => action(context),
}));
jest.mock('../../api/channels/verusid/requests/getFriendlyNameMap', () => ({
  getFriendlyNameMap: (...args) => mockNames(...args),
}));

const {loadConnectedApps} = require('../../appAuthorization/connectedApps');
const {STORAGE_ACCESS_STATE} = require('../../appAuthorization/constants');
const context = {network: 'testnet', assertActive: jest.fn()};
const alice = {identityID: 'alice', systemID: 'chain', title: 'Alice@'};
const bob = {identityID: 'bob', systemID: 'chain', title: 'Bob@'};
const localStorage = {
  identityID: 'storage',
  systemID: 'chain',
  title: 'My storage@',
  isStorage: true,
  userIdentityIDs: [alice.identityID],
};
const grant = (
  appID = 'notes',
  delegateID = 'desktop',
  grantID = 'grant',
  signingSystemID = 'chain',
) => ({
  record: {
    data: {grantID, signingSystemID},
    getSystemID(rootSystemID) {
      return this.data.signingSystemID ?? rootSystemID;
    },
  },
  identities: {appID, delegateID},
});
const storage = (
  appID = 'notes',
  storageID = 'storage',
  grantID = 'grant',
) => ({
  appID,
  appSystemID: 'chain',
  storageID,
  grantID,
  storageSystemID: 'chain',
});
const view = (grants = [], relationships = []) => ({
  rootSystemID: 'chain',
  grants,
  relationships,
});

beforeEach(() => {
  jest.clearAllMocks();
  context.assertActive.mockReset();
  mockIdentityRevision
    .mockReset()
    .mockResolvedValue({identity: {privateaddress: 'user-z-address'}});
  mockLoadCredentials.mockReset().mockResolvedValue(view());
  mockListStorage
    .mockReset()
    .mockImplementation(
      async (_user, _context, loaded) => loaded.relationships,
    );
  mockInspectStorage
    .mockReset()
    .mockResolvedValue({status: STORAGE_ACCESS_STATE.SHARED});
  mockLoadJobs.mockReset().mockResolvedValue({});
  mockNames
    .mockReset()
    .mockImplementation(async (_system, _identity, addresses, {names}) => {
      for (const address of addresses) names[address] = `${address}@`;
      return names;
    });
});

test('groups apps across user identities and deduplicates delegates and shared storage', async () => {
  mockLoadCredentials.mockImplementation(async user =>
    user.identityID === alice.identityID
      ? view(
          [
            grant(),
            grant('notes', 'desktop', 'second'),
            grant('notes', 'phone'),
          ],
          [storage(), storage()],
        )
      : view([grant(), grant('calendar', 'desktop')], [storage()]),
  );

  const result = await loadConnectedApps([alice, bob, alice], context);

  expect(result.errors).toEqual([]);
  expect(result.apps.map(app => app.title)).toEqual(['calendar@', 'notes@']);
  const notes = result.apps[1];
  expect(notes.key).toBe('chain:notes');
  expect(notes.instances.map(instance => instance.delegateID)).toEqual([
    'desktop',
    'phone',
  ]);
  expect(notes.instances[0].users).toEqual([alice, bob]);
  expect(notes.instances[1].users).toEqual([alice]);
  expect(notes.storage).toEqual([
    {
      key: 'chain:storage',
      storageID: 'storage',
      storageSystemID: 'chain',
      title: 'storage@',
      users: [alice, bob],
      status: STORAGE_ACCESS_STATE.SHARED,
      hasCredentials: true,
    },
  ]);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(2);
  expect(mockListStorage).toHaveBeenCalledWith(
    {identityID: alice.identityID, systemID: alice.systemID},
    context,
    expect.objectContaining({grants: expect.any(Array)}),
  );
  expect(mockNames).toHaveBeenCalledTimes(1);
  expect(mockInspectStorage).toHaveBeenCalledTimes(1);
});

test('keeps the same app address on different systems in separate groups', async () => {
  mockLoadCredentials.mockResolvedValue(
    view([
      grant('notes', 'desktop', 'one', 'chain'),
      grant('notes', 'desktop', 'two', 'other-chain'),
    ]),
  );

  const result = await loadConnectedApps([alice], context);

  expect(result.apps.map(app => app.key)).toEqual([
    'chain:notes',
    'other-chain:notes',
  ]);
  expect(mockNames).toHaveBeenCalledTimes(2);
});

test('groups an omitted grant system under the trusted network root', async () => {
  const connection = grant();
  delete connection.record.data.signingSystemID;
  mockLoadCredentials.mockResolvedValue({
    ...view([connection]),
    rootSystemID: 'test-root',
  });

  const result = await loadConnectedApps([alice], context);

  expect(result.apps).toEqual([
    expect.objectContaining({
      key: 'test-root:notes',
      systemID: 'test-root',
      instances: [expect.objectContaining({key: 'test-root:desktop'})],
    }),
  ]);
});

test('keeps foreign-system storage under the app’s signing system', async () => {
  mockLoadCredentials.mockResolvedValue(
    view([grant()], [{...storage(), storageSystemID: 'storage-chain'}]),
  );

  const result = await loadConnectedApps([alice], context);

  expect(result.apps).toEqual([
    expect.objectContaining({
      key: 'chain:notes',
      systemID: 'chain',
      storage: [expect.objectContaining({storageSystemID: 'storage-chain'})],
    }),
  ]);
});

test('storage removal carries every owner across apps while delegates keep their own app scope', async () => {
  mockLoadCredentials.mockImplementation(async user =>
    user.identityID === alice.identityID
      ? view([grant('notes')], [storage('notes')])
      : view([grant('calendar')], [storage('calendar')]),
  );

  const result = await loadConnectedApps([alice, bob], context);

  expect(result.apps).toHaveLength(2);
  for (const app of result.apps)
    expect(app.storage[0].users).toEqual([alice, bob]);
  expect(
    result.apps.find(app => app.appID === 'notes').instances[0].users,
  ).toEqual([alice]);
  expect(
    result.apps.find(app => app.appID === 'calendar').instances[0].users,
  ).toEqual([bob]);
});

test.each([
  {appId: 'notes', systemId: 'chain', grantID: 'old-grant'},
  {targets: {appID: 'notes', delegateID: 'desktop', grantIDs: ['old-grant']}},
])(
  'keeps storage under its app after revocation using display-only journal context',
  async saved => {
    mockListStorage.mockResolvedValue([
      {...storage('notes', 'storage', 'old-grant'), appID: undefined},
    ]);
    mockLoadJobs.mockResolvedValue({
      saved: {network: context.network, selectedIdentity: alice, ...saved},
    });

    const result = await loadConnectedApps([alice], context);

    expect(result.errors).toEqual([]);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].appID).toBe('notes');
    expect(result.apps[0].instances).toEqual([]);
    expect(result.apps[0].storage[0].storageID).toBe('storage');
  },
);

test('retains an orphaned foreign-system storage association using its user and grant journal', async () => {
  mockListStorage.mockResolvedValue([
    {
      ...storage(),
      appID: undefined,
      appSystemID: undefined,
      storageSystemID: 'storage-chain',
    },
  ]);
  mockLoadJobs.mockResolvedValue({
    saved: {
      network: context.network,
      selectedIdentity: alice,
      appId: 'notes',
      systemId: 'chain',
      grantID: 'grant',
    },
  });

  const result = await loadConnectedApps([alice], context);

  expect(result.apps).toEqual([
    expect.objectContaining({
      key: 'chain:notes',
      instances: [],
      storage: [expect.objectContaining({storageSystemID: 'storage-chain'})],
    }),
  ]);
});

test('historical grants alone never recreate an app or a delegate', async () => {
  mockLoadJobs.mockResolvedValue({
    saved: {
      network: context.network,
      selectedIdentity: alice,
      appId: 'notes',
      delegateId: 'desktop',
      grantID: 'old-grant',
      storageBindings: [{storageID: 'storage'}],
    },
  });

  expect(await loadConnectedApps([alice], context)).toEqual({
    apps: [],
    errors: [],
    unassignedStorage: [],
  });
});

test.each([
  {storageBindings: [{storageID: 'storage'}]},
  {targets: {storage: [{storageID: 'storage', storageSystemID: 'chain'}]}},
])(
  'retains an app for local storage after all portable records were removed',
  async saved => {
    mockLoadJobs.mockResolvedValue({
      saved: {
        network: context.network,
        selectedIdentity: alice,
        appId: 'notes',
        systemId: 'chain',
        delegateId: 'desktop',
        grantID: 'old-grant',
        ...saved,
      },
    });
    mockInspectStorage.mockResolvedValue({
      status: STORAGE_ACCESS_STATE.WALLET_ONLY,
    });

    const result = await loadConnectedApps([alice, localStorage], context);

    expect(result.errors).toEqual([]);
    expect(result.unassignedStorage).toEqual([]);
    expect(result.apps).toEqual([
      expect.objectContaining({
        appID: 'notes',
        instances: [],
        approvalUnknown: false,
        storage: [
          expect.objectContaining({
            storageID: 'storage',
            users: [alice],
            status: STORAGE_ACCESS_STATE.WALLET_ONLY,
            hasCredentials: false,
          }),
        ],
      }),
    ]);
    expect(mockInspectStorage).toHaveBeenCalledTimes(1);
  },
);

test.each([
  {network: 'mainnet'},
  {selectedIdentity: bob},
  {selectedIdentity: {...alice, systemID: 'other-chain'}},
  {systemId: 'other-chain'},
  {storageBindings: [{storageID: 'another-storage'}]},
  {storageBindings: [{storageID: 'storage', storageSystemID: 'other-chain'}]},
  {storageBindings: []},
])(
  'never assigns retained local storage using history from another relationship',
  async changed => {
    mockLoadJobs.mockResolvedValue({
      saved: {
        network: context.network,
        selectedIdentity: alice,
        appId: 'notes',
        systemId: 'chain',
        grantID: 'old-grant',
        storageBindings: [{storageID: 'storage'}],
        ...changed,
      },
    });

    const result = await loadConnectedApps([alice, bob, localStorage], context);

    expect(result.apps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.unassignedStorage).toEqual([
      expect.objectContaining({storageID: 'storage'}),
    ]);
  },
);

test('retained shared storage preserves each known app and all affected users', async () => {
  mockLoadJobs.mockResolvedValue({
    one: {
      network: context.network,
      selectedIdentity: alice,
      appId: 'notes',
      systemId: 'chain',
      storageBindings: [{storageID: 'storage'}],
    },
    two: {
      network: context.network,
      selectedIdentity: bob,
      appId: 'calendar',
      systemId: 'chain',
      storageBindings: [{storageID: 'storage'}],
    },
  });

  const result = await loadConnectedApps(
    [
      alice,
      bob,
      {...localStorage, userIdentityIDs: [alice.identityID, bob.identityID]},
    ],
    context,
  );

  expect(result.apps.map(app => app.appID)).toEqual(['calendar', 'notes']);
  for (const app of result.apps) {
    expect(app.instances).toEqual([]);
    expect(app.storage[0].users).toEqual([alice, bob]);
    expect(app.storage[0].hasCredentials).toBe(false);
  }
  expect(mockInspectStorage).toHaveBeenCalledTimes(1);
});

test('does not describe retained app approvals as absent when the user records could not be read', async () => {
  mockLoadJobs.mockResolvedValue({
    saved: {
      network: context.network,
      selectedIdentity: alice,
      appId: 'notes',
      systemId: 'chain',
      storageBindings: [{storageID: 'storage'}],
    },
  });
  mockLoadCredentials.mockRejectedValue(new Error('RPC unavailable'));

  const result = await loadConnectedApps([alice, localStorage], context);

  expect(result.apps[0].approvalUnknown).toBe(true);
  expect(result.apps[0].storage).toHaveLength(1);
  expect(result.errors[0].blocksRemoval).toBe(true);
});

test.each([false, true])(
  'history labels storage without supplying an actionable owner (unread user: %s)',
  async unread => {
    mockLoadJobs.mockResolvedValue({
      saved: {
        network: context.network,
        selectedIdentity: alice,
        appId: 'notes',
        systemId: 'chain',
        storageBindings: [{storageID: 'storage'}],
      },
    });
    mockInspectStorage.mockResolvedValue({
      status: STORAGE_ACCESS_STATE.WALLET_ONLY,
    });
    if (unread)
      mockLoadCredentials.mockRejectedValue(new Error('RPC unavailable'));

    const result = await loadConnectedApps(
      [alice, {...localStorage, userIdentityIDs: undefined}],
      context,
    );

    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].appID).toBe('notes');
    expect(result.apps[0].instances).toEqual([]);
    expect(result.apps[0].approvalUnknown).toBe(unread);
    expect(result.apps[0].storage).toEqual([
      expect.objectContaining({
        storageID: 'storage',
        users: [],
        hasCredentials: false,
        status: STORAGE_ACCESS_STATE.WALLET_ONLY,
      }),
    ]);
    expect(result.unassignedStorage).toEqual([]);
  },
);

test('keeps storage read failures on their row without blocking other storage identities', async () => {
  mockLoadCredentials.mockResolvedValue(
    view([grant()], [storage(), storage('notes', 'second-storage')]),
  );
  mockInspectStorage.mockImplementation(async binding => {
    if (binding.storageID === 'storage') throw new Error('RPC unavailable');
    return {status: STORAGE_ACCESS_STATE.SHARED};
  });

  const result = await loadConnectedApps([alice], context);

  expect(result.errors).toEqual([]);
  expect(result.apps[0].storage).toEqual([
    expect.objectContaining({
      storageID: 'second-storage',
      status: STORAGE_ACCESS_STATE.SHARED,
    }),
    expect.objectContaining({
      storageID: 'storage',
      status: STORAGE_ACCESS_STATE.UNAVAILABLE,
    }),
  ]);
});

test('propagates profile changes while inspecting retained storage', async () => {
  const changed = Object.assign(new Error('Profile changed'), {
    code: 'SESSION_CHANGED',
  });
  mockInspectStorage.mockRejectedValue(changed);

  await expect(loadConnectedApps([alice, localStorage], context)).rejects.toBe(
    changed,
  );
});

test('retains the app association for each user in a grouped instance revocation', async () => {
  mockListStorage.mockResolvedValue([{...storage(), appID: undefined}]);
  mockLoadJobs.mockResolvedValue({
    saved: {
      network: context.network,
      selectedIdentity: alice,
      targets: {
        appID: 'notes',
        delegateID: 'desktop',
        grantIDs: ['grant'],
        users: [alice, bob],
      },
    },
  });

  const result = await loadConnectedApps([bob], context);

  expect(result.errors).toEqual([]);
  expect(result.apps[0].instances).toEqual([]);
  expect(result.apps[0].storage[0].users).toEqual([bob]);
});

test.each([
  {network: 'mainnet'},
  {selectedIdentity: bob},
  {selectedIdentity: {...alice, systemID: 'other-chain'}},
  {systemId: 'other-chain'},
  {grantID: 'different-grant'},
])(
  'never assigns orphan storage using a journal from another binding',
  async changed => {
    mockListStorage.mockResolvedValue([{...storage(), appID: undefined}]);
    mockLoadJobs.mockResolvedValue({
      saved: {
        network: context.network,
        selectedIdentity: alice,
        appId: 'notes',
        systemId: 'chain',
        grantID: 'grant',
        ...changed,
      },
    });

    const result = await loadConnectedApps([alice], context);

    expect(result.apps).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.unassignedStorage).toEqual([
      expect.objectContaining({storageID: 'storage'}),
    ]);
  },
);

test('keeps contradictory orphan storage associations available for review without choosing an app', async () => {
  mockListStorage.mockResolvedValue([{...storage(), appID: undefined}]);
  const saved = {
    network: context.network,
    selectedIdentity: alice,
    systemId: 'chain',
    grantID: 'grant',
  };
  mockLoadJobs.mockResolvedValue({
    one: {...saved, appId: 'notes'},
    two: {...saved, appId: 'calendar'},
  });

  const result = await loadConnectedApps([alice], context);

  expect(result.apps).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.unassignedStorage).toEqual([
    expect.objectContaining({storageID: 'storage'}),
  ]);
});

test('keeps unrelated app rows when one linked identity cannot be read', async () => {
  mockLoadCredentials.mockImplementation(async user => {
    if (user.identityID === alice.identityID)
      throw new Error('RPC unavailable');
    return view([grant()]);
  });

  const result = await loadConnectedApps([alice, bob], context);

  expect(result.apps[0].instances[0].users).toEqual([bob]);
  expect(result.errors).toEqual([
    {user: alice, message: 'Alice@: RPC unavailable', blocksRemoval: true},
  ]);
});

test('keeps unassociated local storage available for review without treating it as an app', async () => {
  const result = await loadConnectedApps([alice, localStorage], context);

  expect(result.apps).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(result.unassignedStorage).toEqual([
    expect.objectContaining({
      storageID: 'storage',
      users: [alice],
      status: STORAGE_ACCESS_STATE.SHARED,
    }),
  ]);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
});

test('does not duplicate local storage with an unassociated current binding', async () => {
  mockListStorage.mockResolvedValue([{...storage(), appID: undefined}]);
  const result = await loadConnectedApps(
    [alice, {identityID: 'storage', systemID: 'chain', isStorage: true}],
    context,
  );

  expect(result.errors).toEqual([]);
  expect(result.unassignedStorage).toHaveLength(1);
  expect(mockInspectStorage).toHaveBeenCalledTimes(1);
});

test('continues using live approvals if saved display history cannot be read', async () => {
  mockLoadJobs.mockRejectedValue(new Error('Journal unavailable'));
  mockLoadCredentials.mockResolvedValue(view([grant()]));

  const result = await loadConnectedApps([alice], context);

  expect(result.apps[0].appID).toBe('notes');
  expect(result.errors[0].message).toContain('Journal unavailable');
  expect(result.errors[0].blocksRemoval).toBe(true);
});

test('never suppresses a session change while reading another user', async () => {
  const changed = Object.assign(new Error('Profile changed'), {
    code: 'SESSION_CHANGED',
  });
  mockLoadCredentials.mockRejectedValue(changed);

  await expect(loadConnectedApps([alice, bob], context)).rejects.toBe(changed);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
});

test('rechecks the active profile after asynchronous name resolution', async () => {
  mockLoadCredentials.mockResolvedValue(view([grant()]));
  mockNames.mockImplementation(async () => {
    context.assertActive.mockImplementation(() => {
      throw Object.assign(new Error('Profile changed'), {
        code: 'SESSION_CHANGED',
      });
    });
  });

  await expect(loadConnectedApps([alice], context)).rejects.toMatchObject({
    code: 'SESSION_CHANGED',
  });
});

test('keeps discovered access available when display name lookup fails', async () => {
  mockLoadCredentials.mockResolvedValue(view([grant()]));
  mockNames.mockRejectedValue(new Error('Names unavailable'));

  const result = await loadConnectedApps([alice], context);

  expect(result.apps[0].appID).toBe('notes');
  expect(result.apps[0].instances[0].delegateID).toBe('desktop');
  expect(result.errors[0].message).toContain(
    'identity names could not be loaded',
  );
  expect(result.errors[0].blocksRemoval).not.toBe(true);
});

test('ordinary linked identities without a credential channel do not block app management', async () => {
  mockIdentityRevision.mockImplementation(async (_source, user) => ({
    identity: {
      privateaddress:
        user.identityID === alice.identityID ? '' : 'user-z-address',
    },
  }));
  mockLoadCredentials.mockResolvedValue(view([grant()]));

  const result = await loadConnectedApps([alice, bob], context);

  expect(result.errors).toEqual([]);
  expect(result.apps[0].instances[0].users).toEqual([bob]);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
});

test('does not open encrypted service data for an empty inventory', async () => {
  expect(await loadConnectedApps([], context)).toEqual({
    apps: [],
    errors: [],
    unassignedStorage: [],
  });
  expect(mockLoadJobs).not.toHaveBeenCalled();
});

test('keeps storage manageable when a grant’s identity history cannot be resolved', async () => {
  const unresolved = grant();
  delete unresolved.identities;
  unresolved.identityError = 'Historical transaction unavailable';
  mockLoadCredentials.mockResolvedValue(
    view(
      [unresolved],
      [{...storage(), appID: undefined, approvalUnknown: true}],
    ),
  );
  mockLoadJobs.mockResolvedValue({
    saved: {
      network: context.network,
      selectedIdentity: alice,
      appId: 'notes',
      systemId: 'chain',
      grantID: 'grant',
    },
  });

  const result = await loadConnectedApps([alice], context);

  expect(result.apps[0]).toMatchObject({
    appID: 'notes',
    instances: [],
    approvalUnknown: true,
    storage: [expect.objectContaining({storageID: 'storage', users: [alice]})],
  });
  expect(result.errors[0]).toMatchObject({
    blocksRemoval: false,
    message: expect.stringContaining('Refresh to identify'),
  });
});
