const mockState = {
  authentication: {
    activeAccount: {accountHash: 'alice', keys: {}},
    sessionEpoch: 1,
  },
  coins: {activeCoinsForUser: []},
};
let mockJob;
let mockExpired;
const mockContext = {sessionScope: {accountHash: 'alice', sessionEpoch: 1}};
const mockVerifyRequest = jest.fn();
const mockDiscover = jest.fn();
const mockDecode = jest.fn();
const mockPasswordRequired = jest.fn();
const mockIndependent = jest.fn();
const mockLoadIdentity = jest.fn();
const mockLink = jest.fn();
const mockMarkStorage = jest.fn();
const mockServiceData = jest.fn();
const mockWalletKeys = jest.fn();
const mockUpdatable = jest.fn();
const mockLoadCredentials = jest.fn();
const mockReadScope = jest.fn((context, operation) => operation(context));
let mockStoredServices;
const mockServiceWrite = jest.fn(async update => {
  mockStoredServices = update(mockStoredServices);
  return mockStoredServices;
});
const mockUpdateJob = jest.fn(async (_id, update) => {
  mockJob =
    typeof update === 'function' ? update(mockJob) : {...mockJob, ...update};
  return mockJob;
});

jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../vrpc/vrpcInterface', () => ({
  initEndpoint: jest.fn(),
}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: (...args) => mockServiceData(...args),
}));
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: (...args) => mockServiceWrite(...args),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  AUTHORIZATION_STATUS: {
    GIFT_REVIEW: 'gift_review',
    READY: 'ready_for_authorization',
    COMPLETE: 'complete',
    EXPIRED: 'expired',
  },
  captureAuthorizationContext: options => options || mockContext,
  assertAuthorizationContext: jest.fn(),
  getAuthorizationJob: jest.fn(async () => mockJob),
  requestFromAuthorizationJob: () => ({isTestnet: () => false}),
  updateAuthorizationJob: (...args) => mockUpdateJob(...args),
  withAuthorizationJob: (_id, _context, operation) => operation(),
}));
jest.mock('verusid-ts-client', () => ({
  ...jest.requireActual('verusid-ts-client'),
  validateAppAuthorizationRequest: () => {
    if (mockExpired) throw new Error('Authorization expired');
    return {
      authorization: {
        gift: {},
        flags: new (require('bn.js'))(0),
      },
    };
  },
  loadIdentityRevision: (...args) => mockLoadIdentity(...args),
}));
jest.mock('../../spendableKey/spendableKey', () => ({
  discoverSpendableKeyClaims: (...args) => mockDiscover(...args),
  spendableKeyDetailsOrdinalToMnemonic: (...args) => mockDecode(...args),
  spendableKeyDetailsRequiresPassword: (...args) =>
    mockPasswordRequired(...args),
}));
jest.mock('../../spendableKey/durableBroadcast', () => ({
  BROADCAST_STATUS_SUBMITTED: 'submitted',
}));
jest.mock('../../deeplink/validator/appEncryptionAuthorization', () => ({
  assertSignedRequestAuthorization: (...args) => mockVerifyRequest(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  assertIndependentIdentityControl: (...args) => mockIndependent(...args),
  authorizationSource: systemID => ({
    systemID,
    coin: {id: 'VRSC', testnet: false},
  }),
  walletAuthorizationKeys: (...args) => mockWalletKeys(...args),
  withAuthorizationReadScope: (...args) => mockReadScope(...args),
}));
jest.mock('../../crypto/encryptCredentials', () => ({}));
jest.mock('../../crypto/encryptDataDescriptor', () => ({}));
jest.mock('../../deeplink/credentials/scopedCredentials', () => ({}));
jest.mock('../../appAuthorization/credentials', () => ({
  ...jest.requireActual('../../appAuthorization/credentials'),
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
}));
jest.mock('../../appAuthorization/transactions', () => ({}));
jest.mock('../../api/channels/verusid/requests/updateIdentity', () => ({
  getUpdatableIdentity: (...args) => mockUpdatable(...args),
}));
jest.mock(
  '../../../actions/actions/services/dispatchers/verusid/verusid',
  () => ({
    linkVerusId: (...args) => mockLink(...args),
    markVerusIdAsStorage: (...args) => mockMarkStorage(...args),
    withLinkedVerusId: (current, ...args) => {
      mockLink(...args);
      return jest
        .requireActual(
          '../../../actions/actions/services/dispatchers/verusid/verusid',
        )
        .withLinkedVerusId(current, ...args);
    },
    withStorageVerusId: (current, ...args) => {
      mockMarkStorage(...args);
      return jest
        .requireActual(
          '../../../actions/actions/services/dispatchers/verusid/verusid',
        )
        .withStorageVerusId(current, ...args);
    },
  }),
);
jest.mock('../../identityManagement/unlinkAfterUpdate', () => ({
  refreshLinkedIdentityWallet: jest.fn(),
}));

const {
  ContentMultiMapRemove,
  R_ADDR_VERSION,
  toBase58Check,
} = require('verus-typescript-primitives');
const {loadAuthorizationGift} = require('../../appAuthorization/gift');
const {
  prepareAuthorizationPlan,
  assertAuthorizationPlanCurrent,
  reconcileAuthorizationGift,
  loadAuthorizationStorageSelection,
} = require('../../appAuthorization/plan');
const userKeyID = '11'.repeat(20);
const appKeyID = '22'.repeat(20);
const otherKeyID = '33'.repeat(20);
const address = keyID =>
  toBase58Check(Buffer.from(keyID, 'hex'), R_ADDR_VERSION);
const userAddress = address(userKeyID);
const revision = (identityID, primaries = [userAddress], extra = {}) => ({
  systemID: 'system',
  txid: `tx-${identityID}`,
  vout: 0,
  blockheight: 10,
  status: 'active',
  fullyqualifiedname: `${identityID}@`,
  identity: {
    identityaddress: identityID,
    primaryaddresses: primaries,
    minimumsignatures: 1,
    revocationauthority: identityID,
    recoveryauthority: identityID,
    privateaddress: 'zs-wallet',
    ...extra,
  },
});
const giftPlan = () => ({
  hasClaims: true,
  scanUniverseComplete: true,
  systems: [
    {
      systemId: 'system',
      coinObj: {id: 'VRSC'},
      claimWif: 'SECRET-WIF',
      utxos: [{}],
      identities: [
        {
          identityAddress: 'gift',
          fullyQualifiedName: 'Gift@',
          result: revision('gift'),
        },
      ],
      currencies: [
        {currencyId: 'system', amount: '1', display: {name: 'VRSC'}},
      ],
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStoredServices = {};
  mockExpired = false;
  mockJob = {
    id: 'job',
    systemId: 'system',
    delegateId: 'delegate',
    hasGift: true,
  };
  mockState.authentication.activeAccount.keys = {
    VRSC: {
      vrpc: {addresses: [userAddress]},
      dlight_private: {addresses: ['zs-wallet']},
    },
  };
  mockVerifyRequest.mockResolvedValue(undefined);
  mockDecode.mockReturnValue('SECRET-MNEMONIC');
  mockPasswordRequired.mockReturnValue(false);
  mockDiscover.mockResolvedValue(giftPlan());
  mockIndependent.mockImplementation(async user => revision(user.identityID));
  mockLoadIdentity.mockImplementation(async (_source, user) =>
    user.identityID === 'delegate'
      ? revision('delegate', [address(appKeyID)])
      : revision(user.identityID),
  );
  mockWalletKeys.mockReturnValue([{keyID: userKeyID, address: userAddress}]);
  mockServiceData.mockReset().mockResolvedValue({});
  mockLoadCredentials.mockReset().mockImplementation(async user => ({
    identity: revision(user.identityID),
    grants: [],
    storageBindings: [],
  }));
});

test('verifies the signed envelope before opening gift material', async () => {
  mockVerifyRequest.mockRejectedValueOnce(new Error('Invalid signature'));
  await expect(loadAuthorizationGift('job')).rejects.toThrow(
    'Invalid signature',
  );
  expect(mockDecode).not.toHaveBeenCalled();
  expect(mockDiscover).not.toHaveBeenCalled();
});

test('requests an encrypted gift password without persisting password or decoding', async () => {
  mockPasswordRequired.mockReturnValue(true);
  expect(await loadAuthorizationGift('job')).toMatchObject({
    requiresPassword: true,
  });
  expect(mockDecode).not.toHaveBeenCalled();
  expect(mockUpdateJob).not.toHaveBeenCalled();
});

test('keeps donor material in encrypted jobs and only returns an allowlisted review', async () => {
  const review = await loadAuthorizationGift('job');
  expect(JSON.stringify(review)).not.toContain('SECRET');
  expect(mockJob.giftDiscovery.systems[0].claimWif).toBe('SECRET-WIF');
  expect(review.identities[0]).toMatchObject({
    identityAddress: 'gift',
    systemId: 'system',
  });
  expect(mockDiscover).toHaveBeenCalledWith(
    expect.objectContaining({includeKnownSystems: true}),
  );
});

test('rejects an unlisted gift identity on another signing system', async () => {
  const plan = giftPlan();
  plan.systems.push({...plan.systems[0], systemId: 'another-system'});
  mockDiscover.mockResolvedValue(plan);
  await expect(loadAuthorizationGift('job')).rejects.toThrow(
    'Every gifted identity',
  );
  expect(mockUpdateJob).not.toHaveBeenCalled();
});

test('does not claim when discovery is incomplete', async () => {
  mockDiscover.mockResolvedValue({...giftPlan(), scanUniverseComplete: false});
  await expect(loadAuthorizationGift('job')).rejects.toThrow('complete gift');
});

const authorizationFixture = () => {
  const {
    Identity,
    nameAndParentAddrToIAddr,
  } = require('verus-typescript-primitives');
  const systemID = nameAndParentAddrToIAddr('VRSC');
  const ids = ['atomic-user', 'atomic-storage', 'atomic-authority'].map(name =>
    nameAndParentAddrToIAddr(name, systemID),
  );
  const privateaddress =
    'zs1wczplx4kegw32h8g0f7xwl57p5tvnprwdmnzmdnsw50chcl26f7tws92wk2ap03ykaq6jyyztfa';
  const original = new Map(
    ids.map((identityID, index) => [
      identityID,
      {
        ...revision(identityID, [address(otherKeyID)]),
        systemID,
        identity: Identity.fromJson({
          version: 3,
          flags: 0,
          name: ['atomic-user', 'atomic-storage', 'atomic-authority'][index],
          parent: systemID,
          systemid: systemID,
          minimumsignatures: 1,
          primaryaddresses: [address(otherKeyID)],
          recoveryauthority: ids[2],
          revocationauthority: ids[2],
          privateaddress,
          contentmap: {},
          contentmultimap: {},
          timelock: 0,
        }).toJson(),
      },
    ]),
  );
  mockJob.systemId = systemID;
  mockJob.giftDiscovery = {
    hasClaims: true,
    scanUniverseComplete: true,
    systems: [
      {
        systemId: systemID,
        coinObj: {id: 'VRSC'},
        claimAddress: address(otherKeyID),
        claimWif: 'SECRET-WIF',
        utxos: [{txid: 'funding', outputIndex: 0, satoshis: 200000000}],
        currencies: [{currencyId: systemID, amount: '2'}],
        identities: ids.map(identityAddress => ({
          identityAddress,
          result: original.get(identityAddress),
          utxos: [],
        })),
      },
    ],
  };
  mockState.authentication.activeAccount.keys.VRSC.dlight_private.addresses = [
    privateaddress,
  ];
  mockLoadIdentity.mockImplementation(async (_source, user) =>
    original.get(user.identityID),
  );
  mockIndependent.mockImplementation(async user =>
    original.get(user.identityID),
  );
  mockUpdatable.mockImplementation(async (_system, current) => ({
    identity: Identity.fromJson(current.identity),
  }));
  const selectedIdentity = {identityID: ids[0], systemID};
  mockJob.selectedIdentity = selectedIdentity;
  const selection = {
    selectedIdentity,
    storageBindings: [
      {storageID: ids[1], revocationID: ids[0], recoveryID: ids[0]},
    ],
  };
  const delegate = revision('delegate', [address(appKeyID)]);
  return {ids, original, selection, delegate, privateaddress};
};

test('a known storage identity cannot become U before preparation or final submission', async () => {
  const f = authorizationFixture();
  const registry = {
    storage_ids: {VRSC: {[f.ids[0]]: {name: 'storage@', userIdentityIDs: []}}},
  };
  mockServiceData.mockResolvedValue(registry);
  await expect(
    prepareAuthorizationPlan(mockJob, f.selection, f.delegate, mockContext),
  ).rejects.toThrow('managed as app storage');
  expect(mockIndependent).not.toHaveBeenCalled();
  expect(mockUpdatable).not.toHaveBeenCalled();

  mockServiceData.mockResolvedValue({});
  mockJob.authorizationPlan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockServiceData.mockResolvedValue(registry);
  await expect(
    assertAuthorizationPlanCurrent(mockJob, mockContext),
  ).rejects.toThrow('managed as app storage');
});

test('gift preparation requires independent local private addresses and every external recovery authority', async () => {
  const f = authorizationFixture();
  delete mockState.authentication.activeAccount.keys.VRSC.dlight_private;
  await expect(
    prepareAuthorizationPlan(mockJob, f.selection, f.delegate, mockContext),
  ).rejects.toThrow('private wallet');
  mockState.authentication.activeAccount.keys.VRSC.dlight_private = {
    addresses: [f.privateaddress],
  };
  const current = f.original.get(f.ids[0]);
  current.identity.recoveryauthority = 'external-donor-authority';
  mockIndependent.mockRejectedValue(
    new Error('External recovery is not controlled'),
  );
  await expect(
    prepareAuthorizationPlan(mockJob, f.selection, f.delegate, mockContext),
  ).rejects.toThrow('External recovery is not controlled');
  expect(mockLink).not.toHaveBeenCalled();
});

test('storage cannot serve as another shared identity’s independent recovery authority', async () => {
  const f = authorizationFixture();
  const storageBindings = [
    {storageID: f.ids[1], revocationID: f.ids[2], recoveryID: f.ids[0]},
    {storageID: f.ids[2], revocationID: f.ids[0], recoveryID: f.ids[0]},
  ];
  await expect(
    prepareAuthorizationPlan(
      mockJob,
      {...f.selection, storageBindings},
      f.delegate,
      mockContext,
    ),
  ).rejects.toThrow('cannot be an independent authority');
});

test('authorization plan transfers every gift and writes final U/S authority definitions without intermediate claims', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  expect(plan.updates).toHaveLength(3);
  expect(plan.giftIdentityIDs).toEqual(f.ids);
  expect(plan.fundingUtxos).toHaveLength(1);
  expect(JSON.stringify(plan)).not.toContain('SECRET-WIF');
  const {
    buildModifiedIdentity,
  } = require('../../identityManagement/identityDefinition');
  const {Identity} = require('verus-typescript-primitives');
  // Exercise actual identity serialization, not just the plan's display fields.
  const decoded = plan.updates.map(update => {
    const identity = buildModifiedIdentity(
      Identity.fromJson(f.original.get(update.identityID).identity),
      update.changes,
    );
    const copy = new Identity();
    expect(copy.fromBuffer(identity.toBuffer())).toBe(
      identity.toBuffer().length,
    );
    return copy.toJson();
  });
  expect(
    decoded.find(identity => identity.identityaddress === f.ids[0]),
  ).toMatchObject({
    primaryaddresses: [userAddress],
    minimumsignatures: 1,
    revocationauthority: f.ids[0],
    recoveryauthority: f.ids[0],
    privateaddress: f.privateaddress,
  });
  expect(
    decoded.find(identity => identity.identityaddress === f.ids[1]),
  ).toMatchObject({
    primaryaddresses: [userAddress, address(appKeyID)],
    minimumsignatures: 1,
    revocationauthority: f.ids[0],
    recoveryauthority: f.ids[0],
  });
  expect(plan.storageBindings[0]).toMatchObject({
    appKeyIDs: [appKeyID],
    reused: false,
  });
});

test('authorization native funding can sweep several donor outputs without preparing fee splits', async () => {
  const f = authorizationFixture();
  mockJob.giftDiscovery.systems[0].utxos.push({
    txid: 'other-funding',
    outputIndex: 1,
    satoshis: 100000,
  });
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  expect(plan.fundingUtxos).toHaveLength(2);
  expect(plan.giftFunding.existingRemovals).toEqual([]);
  expect(mockLoadCredentials).not.toHaveBeenCalled();
});

test.each([false, true])(
  'reserves for existing storage and instance approvals at the reviewed U revision (changed: %s)',
  async changed => {
    const {
      AuthorizationCredential,
      AuthorizationStorageBindingCredential,
      deriveAppAuthorizationStorageManifest,
    } = require('verus-typescript-primitives');
    const f = authorizationFixture();
    mockJob.appId = 'current-app';
    mockJob.giftDiscovery.systems[0].identities = [];
    for (const [identityID, current] of f.original) {
      f.original.set(identityID, {
        ...current,
        identity: {
          ...current.identity,
          primaryaddresses: [userAddress],
          revocationauthority: f.ids[0],
          recoveryauthority: f.ids[0],
        },
      });
    }
    const current = f.original.get(f.ids[0]);
    const entry = (name, record, appID, delegateID) => ({
      record,
      identities: appID ? {appID, delegateID} : undefined,
      source: {outerKey: f.ids[2], storedValue: Buffer.from(name)},
    });
    const binding = entry('binding', new AuthorizationStorageBindingCredential({
      version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
      grantID: '11'.repeat(32),
      relationshipIndex: 0,
      storageID: f.ids[1],
    }));
    const otherBinding = entry('other-binding', new AuthorizationStorageBindingCredential({
      version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
      grantID: '33'.repeat(32),
      relationshipIndex: 0,
      storageID: f.ids[2],
    }));
    const grant = (grantID, bindings = []) => new AuthorizationCredential({
      version: AuthorizationCredential.VERSION_CURRENT,
      flags: bindings.length
        ? AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS
        : AuthorizationCredential.FLAGS_NONE,
      grantID,
      delegateRevision: {txid: '44'.repeat(32), vout: 0},
      delegatorRevision: {txid: '55'.repeat(32), vout: 0},
      ...(bindings.length ? {
        storageManifestHash: deriveAppAuthorizationStorageManifest(bindings, mockJob.systemId),
      } : {}),
    });
    const oldGrant = entry('old-grant', grant(binding.record.data.grantID, [binding.record]),
      'another-app', 'another-instance');
    const sameInstance = entry('same-instance', grant('22'.repeat(32)),
      mockJob.appId, mockJob.delegateId);
    const unrelated = entry('unrelated', grant(otherBinding.record.data.grantID, [otherBinding.record]),
      'unrelated-app', 'other-instance');
    mockLoadCredentials.mockResolvedValue({
      identity: changed ? {...current, txid: 'changed'} : current,
      rootSystemID: mockJob.systemId,
      // Duplicate effective copies must be charged only once.
      grants: [oldGrant, oldGrant, sameInstance, unrelated],
      storageBindings: [binding, otherBinding],
    });

    const preparation = prepareAuthorizationPlan(
      mockJob,
      f.selection,
      f.delegate,
      mockContext,
    );
    if (changed) {
      await expect(preparation).rejects.toThrow('user identity changed');
      return;
    }
    const plan = await preparation;
    expect(mockLoadCredentials).toHaveBeenCalledWith(
      f.selection.selectedIdentity,
      mockContext,
    );
    expect(plan.giftFunding.existingRemovals).toEqual(
      [oldGrant, sameInstance, binding].map(({source}) =>
        ContentMultiMapRemove.removeStoredValue(
          source.outerKey,
          source.storedValue,
        ).toJson(),
      ),
    );
  },
);

test('an existing shared S with the correct app keys needs only the U grant update', async () => {
  const f = authorizationFixture();
  mockJob.hasGift = false;
  for (const [identityID, current] of f.original) {
    f.original.set(identityID, {
      ...current,
      identity: {
        ...current.identity,
        primaryaddresses:
          identityID === f.ids[1]
            ? [userAddress, address(appKeyID)]
            : [userAddress],
        revocationauthority: f.ids[0],
        recoveryauthority: f.ids[0],
      },
    });
  }
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  expect(plan.updates.map(update => update.identityID)).toEqual([f.ids[0]]);
  expect(plan.storageBindings[0]).toMatchObject({
    storageID: f.ids[1],
    reused: true,
  });
  expect(plan.fundingUtxos).toBeUndefined();
  expect(plan.giftIdentityIDs).toEqual([]);
});

test('enforces a saved app storage selection in the transaction planner and uses current authority defaults', async () => {
  const f = authorizationFixture();
  const {
    AuthorizationCredential,
    AuthorizationStorageBindingCredential,
    deriveAppAuthorizationStorageManifest,
  } = require('verus-typescript-primitives');
  mockJob.hasGift = false;
  mockJob.appId = f.ids[2];
  for (const [identityID, current] of f.original) {
    f.original.set(identityID, {
      ...current,
      identity: {
        ...current.identity,
        primaryaddresses: [userAddress],
        revocationauthority: f.ids[0],
        recoveryauthority: f.ids[0],
      },
    });
  }
  const grantID = '12'.repeat(32);
  const binding = new AuthorizationStorageBindingCredential({
    version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
    grantID,
    relationshipIndex: 0,
    storageSystemID: mockJob.systemId,
    storageID: f.ids[1],
  });
  const delegateRevision = {txid: '34'.repeat(32), vout: 0};
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS,
    grantID,
    signingSystemID: mockJob.systemId,
    delegateRevision,
    delegatorRevision: delegateRevision,
    storageManifestHash: deriveAppAuthorizationStorageManifest([binding]),
  });
  mockLoadCredentials.mockResolvedValue({
    identity: f.original.get(f.ids[0]),
    grants: [
      {record: grant, identities: {appID: mockJob.appId, delegateID: f.ids[2]}},
    ],
    storageBindings: [{record: binding}],
  });

  await expect(
    loadAuthorizationStorageSelection(
      f.selection.selectedIdentity,
      mockJob.appId,
      mockContext,
    ),
  ).resolves.toEqual([
    {
      storageIdentity: f.ids[1],
      revocationIdentity: f.ids[0],
      recoveryIdentity: f.ids[0],
    },
  ]);
  const changed = {
    ...f.selection,
    storageBindings: [{...f.selection.storageBindings[0], storageID: f.ids[2]}],
  };
  await expect(
    prepareAuthorizationPlan(mockJob, changed, f.delegate, mockContext),
  ).rejects.toThrow('Keep the existing storage selection');

  mockLoadCredentials.mockClear();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  expect(plan.storageBindings.map(item => item.storageID)).toEqual([f.ids[1]]);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  f.original.set(f.ids[0], {
    ...f.original.get(f.ids[0]),
    txid: 'changed-user-approval',
  });
  await expect(
    assertAuthorizationPlanCurrent(mockJob, mockContext),
  ).rejects.toThrow('identity or authority changed');
});

test('adding an app preserves existing storage keys and upgrades U control checks when U is also a recovery authority', async () => {
  const f = authorizationFixture();
  mockJob.hasGift = false;
  for (const [identityID, current] of f.original) {
    f.original.set(identityID, {
      ...current,
      identity: {
        ...current.identity,
        primaryaddresses:
          identityID === f.ids[1]
            ? [userAddress, address(otherKeyID)]
            : [userAddress],
        revocationauthority: f.ids[0],
        recoveryauthority: f.ids[0],
      },
    });
  }
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  expect(
    plan.updates.find(update => update.identityID === f.ids[1]).changes
      .primaryaddresses,
  ).toEqual([userAddress, address(otherKeyID), address(appKeyID)]);
  expect(
    mockIndependent.mock.calls
      .filter(([user]) => user.identityID === f.ids[0])
      .map(([, context]) => context.requireAuthorityControl),
  ).toEqual([false, true]);

  mockIndependent.mockImplementation(async (user, context) => {
    if (user.identityID === f.ids[0] && context.requireAuthorityControl) {
      throw new Error('U recovery depends on an external authority');
    }
    return f.original.get(user.identityID);
  });
  await expect(
    prepareAuthorizationPlan(mockJob, f.selection, f.delegate, mockContext),
  ).rejects.toThrow('U recovery depends on an external authority');
});

test('a gift containing only U still sweeps donor funding in its single update', async () => {
  const f = authorizationFixture();
  const current = f.original.get(f.ids[0]);
  f.original.set(f.ids[0], {
    ...current,
    identity: {
      ...current.identity,
      revocationauthority: f.ids[0],
      recoveryauthority: f.ids[0],
    },
  });
  const system = mockJob.giftDiscovery.systems[0];
  system.identities = [
    {identityAddress: f.ids[0], result: f.original.get(f.ids[0]), utxos: []},
  ];
  system.observedUtxos = [
    ...system.utxos,
    {txid: current.txid, outputIndex: current.vout, satoshis: 0},
  ];
  const plan = await prepareAuthorizationPlan(
    mockJob,
    {...f.selection, storageBindings: []},
    f.delegate,
    mockContext,
  );
  expect(plan.updates.map(update => update.identityID)).toEqual([f.ids[0]]);
  expect(plan.fundingUtxos).toEqual(system.utxos);
  expect(plan.signingKeyIDs).toContain(userKeyID);
});

test.each([
  'reserve',
  'other-network',
  'identity-balance',
  'unavailable-funding',
])(
  'authorization planning refuses unsupported %s assets before any handoff',
  async kind => {
    const f = authorizationFixture();
    const system = mockJob.giftDiscovery.systems[0];
    if (kind === 'reserve') system.utxos[0].currencyvalues = {reserve: '1'};
    if (kind === 'other-network')
      mockJob.giftDiscovery.systems.push({
        systemId: 'other',
        identities: [],
        utxos: [{}],
        currencies: [],
      });
    if (kind === 'identity-balance')
      system.identities[0].utxos = [{satoshis: 1}];
    if (kind === 'unavailable-funding')
      system.observedUtxos = [
        ...system.utxos,
        {
          txid: 'timelocked-funds',
          outputIndex: 1,
          satoshis: 100000,
          isspendable: false,
        },
      ];
    await expect(
      prepareAuthorizationPlan(mockJob, f.selection, f.delegate, mockContext),
    ).rejects.toThrow(/App authorization/);
  },
);

test('authorization handoff rejects changed original authorities and changed wallet destinations', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  f.original.set(f.ids[2], {...f.original.get(f.ids[2]), txid: 'different'});
  await expect(
    assertAuthorizationPlanCurrent(mockJob, mockContext),
  ).rejects.toThrow(/changed after/);
  mockState.authentication.activeAccount.keys.VRSC.vrpc.addresses = [
    address(appKeyID),
  ];
  await expect(
    assertAuthorizationPlanCurrent(mockJob, mockContext),
  ).rejects.toThrow(/destination changed/);
});

test('gift reconciliation keeps storage out of linked IDs and links other gifts after final ownership is checked', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  mockJob.status = 'cancelled';
  mockJob.outcome = 'cancelled';
  for (const update of plan.updates) {
    const current = f.original.get(update.identityID);
    f.original.set(update.identityID, {
      ...current,
      identity: {...current.identity, ...update.changes},
    });
  }
  const recovered = await reconcileAuthorizationGift(mockJob, mockContext);
  expect(recovered).toMatchObject({
    giftConfirmed: true,
    status: 'cancelled',
    outcome: 'cancelled',
  });
  expect(mockLink).toHaveBeenCalledTimes(2);
  expect(mockLink.mock.calls.map(call => call[0])).toEqual([
    f.ids[0],
    f.ids[2],
  ]);
  expect(mockMarkStorage).toHaveBeenCalledWith(
    f.ids[1],
    expect.anything(),
    'VRSC',
    f.ids[0],
  );
  expect(recovered.storageIdentitiesManaged).toBe(true);
  expect(mockServiceWrite).toHaveBeenCalledTimes(1);
  expect(Object.keys(mockStoredServices.linked_ids.VRSC)).toEqual([
    f.ids[0],
    f.ids[2],
  ]);
  expect(mockStoredServices.storage_ids.VRSC[f.ids[1]].userIdentityIDs).toEqual(
    [f.ids[0]],
  );
});

test('gift reconciliation refuses a hidden donor private address before linking any gift', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  for (const update of plan.updates) {
    const current = f.original.get(update.identityID);
    f.original.set(update.identityID, {
      ...current,
      identity: {...current.identity, ...update.changes},
    });
  }
  const {Identity} = require('verus-typescript-primitives');
  mockUpdatable.mockImplementation(async (_system, current) => {
    const identity = Identity.fromJson(current.identity);
    if (current.identity.identityaddress === f.ids[1])
      identity.privateAddresses.push(identity.privateAddresses[0]);
    return {identity};
  });
  await expect(
    reconcileAuthorizationGift(mockJob, mockContext),
  ).rejects.toThrow(/final ownership/);
  expect(mockJob.giftConfirmed).not.toBe(true);
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockMarkStorage).not.toHaveBeenCalled();
});

test('gift reconciliation does not publish ownership when the final fresh check fails', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  for (const update of plan.updates) {
    const current = f.original.get(update.identityID);
    f.original.set(update.identityID, {
      ...current,
      identity: {...current.identity, ...update.changes},
    });
  }
  mockReadScope.mockImplementationOnce(async (context, operation) => {
    await operation(context);
    throw new Error('Authorization state changed during this operation.');
  });

  await expect(
    reconcileAuthorizationGift(mockJob, mockContext),
  ).rejects.toThrow('Authorization state changed');
  expect(mockJob.giftConfirmed).not.toBe(true);
  expect(mockJob.storageIdentitiesManaged).not.toBe(true);
  expect(mockUpdateJob).not.toHaveBeenCalled();
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockMarkStorage).not.toHaveBeenCalled();
});

test('gift confirmation retries a failed wallet-card rebuild without marking recovery complete', async () => {
  const f = authorizationFixture();
  const plan = await prepareAuthorizationPlan(
    mockJob,
    f.selection,
    f.delegate,
    mockContext,
  );
  mockJob.authorizationPlan = plan;
  mockJob.storageBindings = plan.storageBindings;
  for (const update of plan.updates) {
    const current = f.original.get(update.identityID);
    f.original.set(update.identityID, {
      ...current,
      identity: {...current.identity, ...update.changes},
    });
  }
  const {
    refreshLinkedIdentityWallet,
  } = require('../../identityManagement/unlinkAfterUpdate');
  refreshLinkedIdentityWallet.mockRejectedValueOnce(
    new Error('Card refresh failed'),
  );
  await expect(
    reconcileAuthorizationGift(mockJob, mockContext),
  ).rejects.toThrow('Card refresh failed');
  expect(mockJob.giftConfirmed).not.toBe(true);
  expect(mockJob.storageIdentitiesManaged).not.toBe(true);
  expect(mockJob.userIdentityLinked).not.toBe(true);
  const recovered = await reconcileAuthorizationGift(mockJob, mockContext);
  expect(recovered).toMatchObject({
    giftConfirmed: true,
    storageIdentitiesManaged: true,
    userIdentityLinked: true,
  });
  expect(refreshLinkedIdentityWallet).toHaveBeenCalledTimes(2);
});
