let mockView;
let mockJob;
let mockServiceData;
const mockContext = {sessionScope: {accountHash: 'alice'}};
const mockLoadCredentials = jest.fn();
const mockLoadIdentity = jest.fn();
const mockIndependent = jest.fn();
const mockInspectControl = jest.fn();
const mockConfirm = jest.fn();
const mockSubmit = jest.fn();
const mockCurrent = jest.fn();
const mockBuildRemovals = jest.fn();
const mockEncryptCredentials = jest.fn();
const mockWalletKeys = jest.fn();
const mockLink = jest.fn();
const mockWriteService = jest.fn();
const mockRefreshWallet = jest.fn();

jest.mock('../../../store', () => ({
  getState: () => ({authentication: {activeAccount: {}}}),
}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: jest.fn(async () => mockServiceData),
}));
jest.mock(
  '../../../actions/actions/services/dispatchers/verusid/verusid',
  () => ({
    markVerusIdAsStorage: jest.fn(),
    withLinkedVerusId: (...args) => mockLink(...args),
  }),
);
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: (...args) => mockWriteService(...args),
}));
jest.mock('../../identityManagement/unlinkAfterUpdate', () => ({
  refreshLinkedIdentityWallet: (...args) => mockRefreshWallet(...args),
}));

jest.mock('../../appAuthorization/credentials', () => ({
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
  assertAuthorizationCredentialsCurrent: (...args) => mockCurrent(...args),
  invalidateAuthorizationCredentials: jest.fn(),
  buildAuthorizationRemovals: (...args) => mockBuildRemovals(...args),
  encryptAuthorizationCredentials: (...args) => mockEncryptCredentials(...args),
}));
jest.mock('verusid-ts-client', () => ({
  ...jest.requireActual('verusid-ts-client'),
  loadIdentityRevision: (...args) => mockLoadIdentity(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  assertIndependentIdentityControl: (...args) => mockIndependent(...args),
  inspectIndependentIdentityControl: (...args) => mockInspectControl(...args),
  authorizationSource: systemID => ({
    systemID,
    coin: {id: 'VRSC', testnet: false},
  }),
  authorizationContext: options => options || mockContext,
  walletAuthorizationKeys: (...args) => mockWalletKeys(...args),
}));
jest.mock('../../appAuthorization/transactions', () => ({
  confirmAuthorizationTransaction: (...args) => mockConfirm(...args),
  submitAuthorizationIdentityUpdate: (...args) => mockSubmit(...args),
}));
jest.mock('../../appAuthorization/jobs', () => ({
  AUTHORIZATION_STATUS: {
    COMPLETE: 'complete',
    WAITING_FOR_REMOVAL: 'waiting_for_removal_confirmation',
    READY: 'ready_for_authorization',
  },
  assertAuthorizationContext: jest.fn(),
  authorizationMaintenanceUsers: (...args) =>
    jest
      .requireActual('../../appAuthorization/jobs')
      .authorizationMaintenanceUsers(...args),
  captureAuthorizationContext: options => options || mockContext,
  createAuthorizationMaintenanceJob: async (user, targets) => {
    if (!mockJob)
      mockJob = {id: 'maintenance', selectedIdentity: user, targets};
    return mockJob;
  },
  getAuthorizationJob: async () => mockJob,
  summarizeAuthorizationJob: job => ({id: job.id, status: job.status}),
  updateAuthorizationJob: async (_id, update) => {
    mockJob =
      typeof update === 'function' ? update(mockJob) : {...mockJob, ...update};
    return mockJob;
  },
  withAuthorizationJob: (_id, _context, operation) => operation(),
}));

const {
  AuthorizationStorageBindingCredential,
  AuthorizationCredential,
  deriveAppAuthorizationStorageManifest,
  R_ADDR_VERSION,
  toBase58Check,
  I_ADDR_VERSION,
  nameAndParentAddrToIAddr,
} = require('verus-typescript-primitives');
const {
  listAuthorizationStorageAccess,
  inspectAuthorizationStorageAccess,
  addAuthorizationStorageToWallet,
  removeAuthorizationStorageAccess,
  reconcileStorageRemoval,
  preserveInheritedStorageSystems,
  resolveAuthorizationStorageSystem,
} = require('../../appAuthorization/storageManagement');
const systemID = toBase58Check(Buffer.alloc(20, 4), I_ADDR_VERSION);
const rootSystemID = nameAndParentAddrToIAddr('VRSC');
const user = {
  identityID: toBase58Check(Buffer.alloc(20, 5), I_ADDR_VERSION),
  systemID,
};
const storageID = toBase58Check(Buffer.alloc(20, 6), I_ADDR_VERSION);
const firstGrant = '11'.repeat(32);
const secondGrant = '22'.repeat(32);
const userKeyID = '33'.repeat(20);
const firstAppKey = '44'.repeat(20);
const sharedKey = '55'.repeat(20);
const secondAppKey = '66'.repeat(20);
const addr = keyID => toBase58Check(Buffer.from(keyID, 'hex'), R_ADDR_VERSION);
const entry = record => ({
  record,
  source: {
    ...user,
    outerKey: 'bucket',
    storedValue: Buffer.from(record.toCredential().toBuffer()),
  },
});
const records = grantID => ({
  binding: entry(
    new AuthorizationStorageBindingCredential({
      version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
      grantID,
      relationshipIndex: 0,
      storageSystemID: systemID,
      storageID,
    }),
  ),
});
const grantRecord = (grantID, bindings) =>
  entry(
    new AuthorizationCredential({
      version: AuthorizationCredential.VERSION_CURRENT,
      flags: AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS,
      grantID,
      signingSystemID: systemID,
      delegateRevision: {txid: 'aa'.repeat(32), vout: 0},
      delegatorRevision: {txid: 'bb'.repeat(32), vout: 0},
      storageManifestHash: deriveAppAuthorizationStorageManifest(
        bindings,
        systemID,
      ),
    }),
  );

const identity = keyIDs => ({
  status: 'active',
  blockheight: 5,
  txid: 'storage-tx',
  vout: 0,
  identity: {
    identityaddress: storageID,
    name: 'shared-storage',
    minimumsignatures: 1,
    primaryaddresses: keyIDs.map(addr),
    revocationauthority: user.identityID,
    recoveryauthority: user.identityID,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockJob = undefined;
  mockServiceData = {};
  const first = records(firstGrant);
  const second = records(secondGrant);
  mockView = {
    source: user,
    rootSystemID,
    grants: [],
    storageBindings: [first.binding, second.binding],
  };
  mockLoadCredentials.mockImplementation(async () => mockView);
  mockIndependent.mockResolvedValue(undefined);
  mockInspectControl.mockResolvedValue(true);
  mockWalletKeys.mockReturnValue([{keyID: userKeyID}]);
  mockLoadIdentity.mockResolvedValue(
    identity([userKeyID, firstAppKey, sharedKey, secondAppKey]),
  );
  mockConfirm.mockResolvedValue(false);
  mockSubmit.mockImplementation(async (_jobId, options) => {
    const receipt = {txid: 'removal-tx', rawTx: 'raw', systemId: systemID};
    mockJob.transactions = {
      ...mockJob.transactions,
      [options.receiptKey]: receipt,
    };
    return receipt;
  });
  mockBuildRemovals.mockReturnValue([
    {toJson: () => ({remove: 'exact-wrapper'})},
  ]);
  mockEncryptCredentials.mockResolvedValue({bucket: ['replacement-binding']});
  mockLink.mockImplementation(data => data);
  mockWriteService.mockImplementation(async update => update(mockServiceData));
  mockRefreshWallet.mockReset().mockResolvedValue(undefined);
});

test('discovers portable orphan management after grants are deleted', async () => {
  const result = await listAuthorizationStorageAccess(user);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    grantID: firstGrant,
    storageID,
    orphaned: true,
  });
  expect(JSON.stringify(result)).not.toContain('storedValue');
});

test('retained storage bindings remain independently manageable after another relationship is removed', async () => {
  const remaining = records(firstGrant).binding;
  remaining.record.data.relationshipIndex = 1;
  mockView = {source: user, grants: [], storageBindings: [remaining]};

  expect(await listAuthorizationStorageAccess(user)).toEqual([
    expect.objectContaining({storageID, relationshipIndex: 1, orphaned: true}),
  ]);
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  expect(mockBuildRemovals).toHaveBeenCalledWith([remaining]);
});

test('materializes an inherited nonroot system before removing its grant, preserving every original ciphertext', () => {
  const binding = mockView.storageBindings[0];
  delete binding.record.data.storageSystemID;
  const duplicate = {
    ...binding,
    source: {...binding.source, storedValue: Buffer.from('second-ciphertext')},
  };
  const grant = grantRecord(firstGrant, [binding.record]);
  mockView.grants = [grant];
  mockView.storageBindings = [binding, duplicate];

  const preserved = preserveInheritedStorageSystems(mockView, [grant]);

  expect(preserved.entries).toEqual([grant, binding, duplicate]);
  expect(preserved.records).toHaveLength(1);
  expect(preserved.records[0].data.storageSystemID).toBe(systemID);
  expect(binding.record.data.storageSystemID).toBeUndefined();
  expect(
    resolveAuthorizationStorageSystem(
      {...mockView, grants: []},
      preserved.records[0],
    ),
  ).toBe(systemID);
});

test('does not rewrite root defaults, explicit systems, or bindings already being removed', () => {
  const binding = mockView.storageBindings[0];
  const grant = grantRecord(firstGrant, [binding.record]);
  mockView.grants = [grant];
  mockView.storageBindings = [binding];
  expect(preserveInheritedStorageSystems(mockView, [grant]).records).toEqual([]);

  delete binding.record.data.storageSystemID;
  delete grant.record.data.signingSystemID;
  expect(preserveInheritedStorageSystems(mockView, [grant])).toEqual({
    entries: [grant],
    records: [],
  });

  grant.record.data.signingSystemID = systemID;
  expect(preserveInheritedStorageSystems(mockView, [grant, binding])).toEqual({
    entries: [grant, binding],
    records: [],
  });
});

test('preserves inherited storage while revoking incomplete grants but rejects ambiguous networks', () => {
  const binding = mockView.storageBindings[0];
  const missing = records(firstGrant).binding;
  missing.record.data.relationshipIndex = 1;
  missing.record.data.storageID = toBase58Check(
    Buffer.alloc(20, 9),
    I_ADDR_VERSION,
  );
  delete binding.record.data.storageSystemID;
  const grant = grantRecord(firstGrant, [binding.record, missing.record]);
  mockView.grants = [grant];
  mockView.storageBindings = [binding];
  expect(
    preserveInheritedStorageSystems(mockView, [grant]).records,
  ).toHaveLength(1);

  const conflicting = grantRecord(firstGrant, [binding.record, missing.record]);
  conflicting.record.data.signingSystemID = rootSystemID;
  mockView.grants.push(conflicting);
  expect(() =>
    preserveInheritedStorageSystems(mockView, [grant, conflicting]),
  ).toThrow('conflicting inherited networks');
});

test('treats explicit and inherited copies of the same storage system as equivalent', async () => {
  const binding = mockView.storageBindings[0];
  const inherited = records(firstGrant).binding;
  delete inherited.record.data.storageSystemID;
  mockView.grants = [grantRecord(firstGrant, [binding.record])];
  mockView.storageBindings = [binding, inherited];

  expect(await listAuthorizationStorageAccess(user)).toEqual([
    expect.objectContaining({storageID, storageSystemID: systemID}),
  ]);
});

test.each([true, false])(
  'reads app associations from resolved revisions while preserving storage access when resolution fails: %s',
  async resolved => {
    const first = mockView.storageBindings[0];
    const grant = grantRecord(firstGrant, [first.record]);
    if (resolved) grant.identities = {appID: 'app', delegateID: 'instance'};
    else grant.identityError = 'Historical transaction unavailable';
    mockView.grants = [grant];

    const listed = await listAuthorizationStorageAccess(user);
    expect(listed[0]).toMatchObject({
      storageID,
      orphaned: false,
      approvalUnknown: !resolved,
      appID: resolved ? 'app' : undefined,
      delegateID: resolved ? 'instance' : undefined,
    });
    await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  },
);

test('removes all non-wallet keys and affected records in one transaction', async () => {
  const otherWalletKey = '77'.repeat(20);
  const unknownAppKey = '88'.repeat(20);
  mockWalletKeys.mockReturnValue([{keyID: userKeyID}, {keyID: otherWalletKey}]);
  mockLoadIdentity.mockResolvedValue(
    identity([
      userKeyID,
      firstAppKey,
      sharedKey,
      secondAppKey,
      otherWalletKey,
      unknownAppKey,
    ]),
  );
  mockView.grants = [firstGrant, secondGrant].map(grantID =>
    grantRecord(
      grantID,
      mockView.storageBindings
        .map(({record}) => record)
        .filter(record => record.data.grantID === grantID),
    ),
  );
  const result = await removeAuthorizationStorageAccess(user, {
    storageIDs: [storageID],
  });
  expect(result).toMatchObject({pending: true, txid: 'removal-tx'});
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledWith(
    'maintenance',
    expect.objectContaining({
      identityID: user.identityID,
      updates: [
        expect.objectContaining({
          identityID: storageID,
          changes: {primaryaddresses: [userKeyID, otherWalletKey].map(addr)},
        }),
        expect.objectContaining({
          identityID: user.identityID,
          contentmultimap: expect.any(Object),
        }),
      ],
      signingIdentities: [user],
      signingKeyIDs: [userKeyID, otherWalletKey],
      feeType: 'removal',
    }),
    mockContext,
  );
  expect(mockBuildRemovals).toHaveBeenCalledWith([
    ...mockView.grants,
    ...mockView.storageBindings,
  ]);
  expect(mockJob.targets.grantIDs).toEqual([firstGrant, secondGrant]);
  await mockSubmit.mock.calls[0][1].beforeSend();
  expect(mockIndependent).toHaveBeenCalledWith(user, mockContext);
  expect(mockIndependent).toHaveBeenCalledWith(user, {
    ...mockContext,
    requireAuthorityControl: true,
  });
});

test('removing one S preserves portable records for another S in the same grant', async () => {
  const otherStorage = toBase58Check(Buffer.alloc(20, 9), I_ADDR_VERSION);
  const other = records(firstGrant);
  other.binding.record.data.storageID = otherStorage;
  other.binding.record.data.relationshipIndex = 1;
  mockView.storageBindings.push(other.binding);
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  expect(mockJob.targets.storage).toEqual([
    {storageID, storageSystemID: systemID},
  ]);
  expect(mockBuildRemovals.mock.calls[0][0]).not.toContain(other.binding);
  expect(
    mockSubmit.mock.calls[0][1].updates.map(update => update.identityID),
  ).toEqual([storageID, user.identityID]);
});

test('storage removal preserves a sibling binding’s inherited network in the same transaction', async () => {
  const binding = mockView.storageBindings[0];
  delete binding.record.data.storageSystemID;
  const sibling = records(firstGrant).binding;
  sibling.record.data.relationshipIndex = 1;
  sibling.record.data.storageID = toBase58Check(
    Buffer.alloc(20, 9),
    I_ADDR_VERSION,
  );
  delete sibling.record.data.storageSystemID;
  const grant = grantRecord(firstGrant, [binding.record, sibling.record]);
  mockView.grants = [grant];
  mockView.storageBindings = [binding, sibling];

  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});

  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockBuildRemovals).toHaveBeenCalledWith([grant, binding, sibling]);
  expect(mockEncryptCredentials).toHaveBeenCalledWith(
    user,
    [
      expect.objectContaining({
        data: expect.objectContaining({
          storageSystemID: systemID,
          storageID: sibling.record.data.storageID,
        }),
      }),
    ],
    mockContext,
  );
  const update = mockSubmit.mock.calls[0][1].updates.find(
    item => item.identityID === user.identityID,
  );
  expect(update.contentmultimap.bucket).toEqual(['replacement-binding']);
});

test('removes one storage identity and every selected user’s affected records in one transaction', async () => {
  const secondUser = {
    ...user,
    identityID: toBase58Check(Buffer.alloc(20, 7), I_ADDR_VERSION),
  };
  const first = records(firstGrant);
  const second = records(secondGrant);
  const firstView = {grants: [], storageBindings: [first.binding]};
  const secondView = {grants: [], storageBindings: [second.binding]};
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID ? firstView : secondView,
  );

  await removeAuthorizationStorageAccess(
    user,
    {storageIDs: [storageID]},
    {
      ...mockContext,
      relatedUsers: [secondUser, user, secondUser],
    },
  );

  expect(mockJob.targets.users).toHaveLength(2);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(
    mockSubmit.mock.calls[0][1].updates.map(update => update.identityID).sort(),
  ).toEqual([storageID, user.identityID, secondUser.identityID].sort());
  expect(mockSubmit.mock.calls[0][1].signingIdentities).toEqual(
    expect.arrayContaining([user, secondUser]),
  );

  mockConfirm.mockResolvedValue(true);
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID
      ? {grants: [], storageBindings: []}
      : secondView,
  );
  await expect(reconcileStorageRemoval(mockJob)).rejects.toThrow(
    'records are still present',
  );
  expect(mockWriteService).not.toHaveBeenCalled();
});

test('rejects cross-chain source identities before reading or submitting a removal', async () => {
  await expect(
    removeAuthorizationStorageAccess(
      user,
      {storageIDs: [storageID]},
      {
        ...mockContext,
        relatedUsers: [
          {
            ...user,
            systemID: toBase58Check(Buffer.alloc(20, 8), I_ADDR_VERSION),
          },
        ],
      },
    ),
  ).rejects.toThrow('same network');
  expect(mockLoadCredentials).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('storage cleanup keeps full recovery control checks before any update', async () => {
  mockIndependent.mockImplementation(async (_user, context) => {
    if (context.requireAuthorityControl)
      throw new Error('Storage recovery is not independently controlled');
  });
  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Storage recovery is not independently controlled');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('storage management follows current wallet keys and recovery authorities', async () => {
  const currentWalletKey = '77'.repeat(20);
  const current = identity([currentWalletKey, firstAppKey]);
  const authorities = [8, 9].map(value =>
    toBase58Check(Buffer.alloc(20, value), I_ADDR_VERSION),
  );
  current.identity.revocationauthority = authorities[0];
  current.identity.recoveryauthority = authorities[1];
  mockLoadIdentity.mockResolvedValue(current);
  mockWalletKeys.mockReturnValue([{keyID: currentWalletKey}]);

  await expect(
    inspectAuthorizationStorageAccess({storageID, storageSystemID: systemID}),
  ).resolves.toEqual({status: 'shared'});
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});

  for (const identityID of authorities) {
    const authority = {identityID, systemID};
    const context = {...mockContext, requireAuthorityControl: true};
    expect(mockInspectControl).toHaveBeenCalledWith(authority, context);
    expect(mockIndependent).toHaveBeenCalledWith(authority, context);
  }
  expect(mockSubmit.mock.calls[0][1].signingKeyIDs).toEqual([
    currentWalletKey,
  ]);
  expect(mockSubmit.mock.calls[0][1].updates[0].changes).toEqual({
    primaryaddresses: [addr(currentWalletKey)],
  });
});

test('duplicate encrypted copies do not inflate the storage relationship count', async () => {
  mockView.storageBindings.push(mockView.storageBindings[0]);
  expect(await listAuthorizationStorageAccess(user)).toHaveLength(2);
});

test('contradictory management copies fail before any update', async () => {
  const conflict = records(firstGrant);
  conflict.binding.record.data.storageID = toBase58Check(
    Buffer.alloc(20, 9),
    I_ADDR_VERSION,
  );
  mockView.storageBindings.push(conflict.binding);
  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Conflicting');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('incomplete bindings cannot discard another relationship of an active grant', async () => {
  const first = mockView.storageBindings[0].record;
  const other = records(firstGrant).binding.record;
  other.data.relationshipIndex = 1;
  other.data.storageID = toBase58Check(Buffer.alloc(20, 9), I_ADDR_VERSION);
  mockView.grants = [grantRecord(firstGrant, [first, other])];

  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('incomplete');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('lost independent primary control directs the user to revoke/recover', async () => {
  mockLoadIdentity.mockResolvedValue(
    identity([firstAppKey, sharedKey, secondAppKey]),
  );
  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('revoke/recover');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('already private storage needs only the U credential-removal update', async () => {
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  expect(
    mockSubmit.mock.calls[0][1].updates.map(update => update.identityID),
  ).toEqual([user.identityID]);
  expect(mockBuildRemovals).toHaveBeenCalled();
  expect(mockJob.status).not.toBe('complete');
});

test('reconciliation links storage only after the exact transaction, wallet-only S and record removal are confirmed', async () => {
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  mockSubmit.mockClear();
  expect((await reconcileStorageRemoval(mockJob)).status).toBe(
    'waiting_for_removal_confirmation',
  );
  expect(mockWriteService).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
  mockConfirm.mockResolvedValue(true);
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  await expect(reconcileStorageRemoval(mockJob)).rejects.toThrow(
    'records are still present',
  );
  expect(mockWriteService).not.toHaveBeenCalled();
  mockView = {grants: [], storageBindings: []};
  expect((await reconcileStorageRemoval(mockJob)).status).toBe('complete');
  expect(mockLink).toHaveBeenCalledWith(
    {},
    storageID,
    'shared-storage',
    'VRSC',
    {reclaimStorage: true},
  );
  expect(mockWriteService).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(String),
    'alice',
    mockContext,
  );
  expect(mockRefreshWallet).toHaveBeenCalledWith('VRSC', mockContext);
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('failed wallet refresh leaves confirmed reclamation retryable without another transaction', async () => {
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  mockSubmit.mockClear();
  mockConfirm.mockResolvedValue(true);
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  mockView = {grants: [], storageBindings: []};
  mockRefreshWallet.mockRejectedValueOnce(new Error('Wallet refresh failed'));

  await expect(reconcileStorageRemoval(mockJob)).rejects.toThrow(
    'Wallet refresh failed',
  );
  expect(mockJob.status).toBe('waiting_for_removal_confirmation');
  expect((await reconcileStorageRemoval(mockJob)).status).toBe('complete');
  expect(mockRefreshWallet).toHaveBeenCalledTimes(2);
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('a completed reclamation cannot relink storage reused by a later app handshake', async () => {
  mockJob = {id: 'finished', status: 'complete'};
  expect((await reconcileStorageRemoval(mockJob)).status).toBe('complete');
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockLoadIdentity).not.toHaveBeenCalled();
  expect(mockWriteService).not.toHaveBeenCalled();
  expect(mockRefreshWallet).not.toHaveBeenCalled();
});

test('a new app key after confirmation prevents reporting storage access removed', async () => {
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  mockConfirm.mockResolvedValue(true);
  mockLoadIdentity.mockResolvedValue(identity([userKeyID, '99'.repeat(20)]));
  await expect(reconcileStorageRemoval(mockJob)).rejects.toThrow(
    'Non-wallet signing keys',
  );
  expect(mockWriteService).not.toHaveBeenCalled();
  expect(mockJob.status).not.toBe('complete');
});

test('an identity change during fee review preserves the unsent cleanup records', async () => {
  mockSubmit.mockImplementationOnce(async (_jobId, options) => {
    mockLoadIdentity.mockResolvedValue({
      ...identity([userKeyID, firstAppKey]),
      txid: 'changed-storage',
    });
    await options.beforeSend();
    throw new Error('Must not submit');
  });
  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Storage changed during review');
  expect(mockJob.transactions).toBeUndefined();
});

test('removes a foreign identity authority while preserving usable direct wallet keys', async () => {
  const foreignIdentity = toBase58Check(Buffer.alloc(20, 10), I_ADDR_VERSION);
  const current = identity([userKeyID, firstAppKey]);
  current.identity.primaryaddresses.push(foreignIdentity);
  mockLoadIdentity.mockResolvedValue(current);
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  expect(mockSubmit.mock.calls[0][1].updates[0].changes).toEqual({
    primaryaddresses: [addr(userKeyID)],
  });
});

test('retains enough independent wallet keys for the existing storage threshold', async () => {
  const secondWalletKey = '77'.repeat(20);
  const current = identity([userKeyID, secondWalletKey, firstAppKey]);
  current.identity.minimumsignatures = 2;
  mockLoadIdentity.mockResolvedValue(current);
  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('current storage threshold');
  expect(mockSubmit).not.toHaveBeenCalled();
  mockWalletKeys.mockReturnValue([
    {keyID: userKeyID},
    {keyID: secondWalletKey},
  ]);
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});
  expect(mockSubmit.mock.calls[0][1].updates[0].changes).toEqual({
    primaryaddresses: [userKeyID, secondWalletKey].map(addr),
  });
  expect(mockSubmit.mock.calls[0][1].signingKeyIDs).toEqual([
    userKeyID,
    secondWalletKey,
  ]);
});

const retainLocalStorage = () => {
  mockServiceData = {
    storage_ids: {
      VRSC: {[storageID]: {userIdentityIDs: [user.identityID]}},
    },
  };
  mockView = {grants: [], storageBindings: []};
};

test.each([
  [[userKeyID, firstAppKey], true, 'shared'],
  [[userKeyID], true, 'wallet-only'],
  [[firstAppKey], true, 'needs-recovery'],
  [[userKeyID], false, 'needs-recovery'],
])(
  'inspects storage keys %p and authority control %p without opening keys',
  async (keys, controlled, status) => {
    mockLoadIdentity.mockResolvedValue(identity(keys));
    mockInspectControl.mockResolvedValue(controlled);

    await expect(
      inspectAuthorizationStorageAccess({storageID, storageSystemID: systemID}),
    ).resolves.toEqual({status});
    expect(mockIndependent).not.toHaveBeenCalled();
    expect(mockWriteService).not.toHaveBeenCalled();
  },
);

test('propagates failed chain inspection so the UI can offer a retry', async () => {
  mockLoadIdentity.mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(
    inspectAuthorizationStorageAccess({storageID, storageSystemID: systemID}),
  ).rejects.toThrow('Network unavailable');
});

test('retained local storage can remove foreign keys after portable records are gone', async () => {
  retainLocalStorage();

  const result = await removeAuthorizationStorageAccess(user, {
    storageIDs: [storageID],
  });

  expect(result).toMatchObject({pending: true, txid: 'removal-tx'});
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockSubmit.mock.calls[0][1].updates).toEqual([
    expect.objectContaining({
      identityID: storageID,
      changes: {primaryaddresses: [addr(userKeyID)]},
    }),
  ]);
  expect(mockIndependent).toHaveBeenCalledWith(user, {
    ...mockContext,
    requireAuthorityControl: true,
  });
});

test('local-only removal refuses an unrelated identity even if a job claims it', async () => {
  mockView = {grants: [], storageBindings: []};
  mockJob = {
    id: 'history',
    targets: {storage: [{storageID, storageSystemID: systemID}]},
  };

  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('not associated');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('includes all locally associated user identities when removing retained storage', async () => {
  retainLocalStorage();
  const secondUser = {
    ...user,
    identityID: toBase58Check(Buffer.alloc(20, 7), I_ADDR_VERSION),
  };
  mockServiceData.storage_ids.VRSC[storageID].userIdentityIDs.push(
    secondUser.identityID,
  );
  const second = records(secondGrant);
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID
      ? mockView
      : {grants: [], storageBindings: [second.binding]},
  );

  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});

  expect(mockJob.targets.users).toEqual(
    expect.arrayContaining([user, secondUser]),
  );
  expect(
    mockSubmit.mock.calls[0][1].updates.map(update => update.identityID),
  ).toEqual([storageID, secondUser.identityID]);
});

test('adds retained wallet-only storage with fresh control checks and no transaction', async () => {
  retainLocalStorage();
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  mockIndependent.mockResolvedValue(identity([userKeyID]));

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).resolves.toEqual({pending: false});

  expect(mockIndependent).toHaveBeenCalledWith(
    {identityID: storageID, systemID},
    {...mockContext, requireAuthorityControl: true},
  );
  expect(mockLink).toHaveBeenCalledWith(
    mockServiceData,
    storageID,
    'shared-storage',
    'VRSC',
    {reclaimStorage: true},
  );
  expect(mockRefreshWallet).toHaveBeenCalledWith('VRSC', mockContext);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockJob).toBeUndefined();
});

test('adding storage never silently becomes a transaction when app keys remain', async () => {
  retainLocalStorage();

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Storage access changed');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockWriteService).not.toHaveBeenCalled();
});

test('adding storage refuses current management records requiring a cleanup transaction', async () => {
  mockServiceData = {
    storage_ids: {
      VRSC: {[storageID]: {userIdentityIDs: [user.identityID]}},
    },
  };
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Remove app access');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockWriteService).not.toHaveBeenCalled();
});

test('adding storage refuses a stale local association after waiting for the write queue', async () => {
  retainLocalStorage();
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  mockIndependent.mockResolvedValue(identity([userKeyID]));
  mockWriteService.mockImplementationOnce(async update => update({}));

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('changed in this wallet');
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('adding storage refuses a new on-chain app key before the local write', async () => {
  retainLocalStorage();
  mockLoadIdentity
    .mockResolvedValueOnce(identity([userKeyID]))
    .mockResolvedValue({
      ...identity([userKeyID, firstAppKey]),
      txid: 'changed-storage',
    });
  mockIndependent.mockResolvedValue(identity([userKeyID]));

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('Storage access changed');
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('adding storage rechecks recovery control after waiting for the local write', async () => {
  retainLocalStorage();
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));
  mockIndependent.mockResolvedValue(identity([userKeyID]));
  mockWriteService.mockImplementationOnce(async update => {
    mockInspectControl.mockResolvedValue(false);
    return update(mockServiceData);
  });

  await expect(
    addAuthorizationStorageToWallet(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('recovery control changed');
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('an already reclaimed identity does not submit an empty removal transaction', async () => {
  retainLocalStorage();
  mockLoadIdentity.mockResolvedValue(identity([userKeyID]));

  await expect(
    removeAuthorizationStorageAccess(user, {storageIDs: [storageID]}),
  ).rejects.toThrow('choose Add to wallet');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('retained removal targets identify the current storage revision for safe retries', async () => {
  retainLocalStorage();
  await removeAuthorizationStorageAccess(user, {storageIDs: [storageID]});

  expect(mockJob.targets.retainedRevisions).toEqual([
    {storageID, txid: 'storage-tx', vout: 0},
  ]);
});
