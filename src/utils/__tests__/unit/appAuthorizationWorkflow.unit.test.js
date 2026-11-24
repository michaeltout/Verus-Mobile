let mockData;
let mockState;
let mockView;
let mockGrant;
let mockDelegate;
let mockDelegator;
let mockResponseSigner;
let mockReviewedRevisions;
const mockVerify = jest.fn();
const mockProfile = jest.fn();
const mockConfirm = jest.fn();
const mockDeliver = jest.fn();
const mockEncrypt = jest.fn();
const mockSubmit = jest.fn();
const mockIndependent = jest.fn();
const mockFreshView = jest.fn();
const mockSignerEvidence = jest.fn();
const mockSigningKeys = jest.fn();
const mockLoadIdentity = jest.fn();
const mockLoadRevision = jest.fn();
const mockLoadCredentials = jest.fn();
const mockDeriveChannel = jest.fn();
const mockPreparePlan = jest.fn();
const mockPlanCurrent = jest.fn();
const mockRecoverGift = jest.fn();
const mockProjectedEncrypt = jest.fn();
const mockRecordStorage = jest.fn(async job => job);
const mockLink = jest.fn();
const mockReadScope = jest.fn();
const mockStorageWrite = jest.fn();
jest.mock(
  '../../../actions/actions/services/dispatchers/verusid/verusid',
  () => ({
    linkVerusId: (...args) => mockLink(...args),
  }),
);

jest.mock('../../appAuthorization/plan', () => ({
  prepareAuthorizationPlan: (...args) => mockPreparePlan(...args),
  assertAuthorizationPlanCurrent: (...args) => mockPlanCurrent(...args),
  reconcileAuthorizationGift: (...args) => mockRecoverGift(...args),
  recordAuthorizationStorageIdentities: (...args) => mockRecordStorage(...args),
}));
jest.mock('../../identityManagement/unlinkAfterUpdate', () => ({
  refreshLinkedIdentityWallet: jest.fn(),
}));

jest.mock('../../deeplink/handlers/appEncryptionRequestHandler', () => ({
  deriveEncryptedAppEncryptionResponse: (...args) => mockDeriveChannel(...args),
  buildEncryptedAppEncryptionResponseDetail: (request, descriptor) => {
    const {
      DataResponseOrdinalVDXFObject,
      DataResponseDetails,
    } = require('verus-typescript-primitives');
    return new DataResponseOrdinalVDXFObject({
      data: new DataResponseDetails({
        requestID: request.requestID,
        data: descriptor,
      }),
    });
  },
}));

jest.mock('../../../store', () => ({
  getState: () => mockState,
  dispatch: jest.fn(),
}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: async () => JSON.parse(JSON.stringify(mockData)),
}));
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: async update => {
    const next = update(mockData);
    if (next !== mockData) mockStorageWrite(next);
    mockData = JSON.parse(JSON.stringify(next));
    return mockData;
  },
}));
jest.mock('verusid-ts-client', () => ({
  ...jest.requireActual('verusid-ts-client'),
  loadIdentityRevision: (...args) => mockLoadIdentity(...args),
  loadIdentityRevisionAtOutpoint: (...args) => mockLoadRevision(...args),
  assertAppDelegatorProfileSupportedV1: (...args) => mockProfile(...args),
  inspectAuthorizationSigners: (...args) => mockSignerEvidence(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  withAuthorizationReadScope: (...args) => mockReadScope(...args),
  authorizationSource: systemID => ({
    systemID,
    rootSystemID: require('verus-typescript-primitives').DEFAULT_VERUS_CHAINID,
    coin: {id: 'VRSC'},
    client: {
      verifyGenericRequest: (...args) => mockVerify(...args),
      getCurrentHeight: async () => 100,
      getSignatureInfo: async () => ({height: 50}),
    },
  }),
  assertIndependentIdentityControl: (...args) => mockIndependent(...args),
  assertAuthorizationStorageControl: jest.fn(),
  withIndependentIdentitySigningKeys: async (_user, _context, sign) => {
    mockSigningKeys(_user, _context);
    sign(
      require('@bitgo/utxo-lib').ECPair.fromPrivateKeyBuffer(
        Buffer.alloc(32, 1),
        require('@bitgo/utxo-lib').networks.verus,
      ),
    );
    return mockResponseSigner;
  },
}));
jest.mock('../../appAuthorization/credentials', () => ({
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
  encryptAuthorizationCredentials: (...args) => mockEncrypt(...args),
  encryptProjectedAuthorizationCredentials: (...args) =>
    mockProjectedEncrypt(...args),
  invalidateAuthorizationCredentials: jest.fn(),
  assertAuthorizationCredentialsCurrent: (...args) => mockFreshView(...args),
  buildAuthorizationRemovals: jest.fn(() => []),
}));
jest.mock('../../appAuthorization/transactions', () => ({
  confirmAuthorizationTransaction: (...args) => mockConfirm(...args),
  submitAuthorizationIdentityUpdate: (...args) => mockSubmit(...args),
}));
jest.mock(
  '../../deeplink/genericResponse/encryptGenericResponseDetails',
  () => ({encryptGenericResponseDetails: async ({response}) => response}),
);
jest.mock('../../deeplink/genericResponse/deliverGenericResponse', () => ({
  deliverGenericResponse: (...args) => mockDeliver(...args),
  getGenericResponseUri: uris => uris?.[0] || null,
  isRedirectResponseUri: uri =>
    uri?.type?.eq?.(
      require('verus-typescript-primitives').ResponseURI.TYPE_REDIRECT,
    ) === true,
}));

const {
  createAppAuthorizationRequest,
  validateAppAuthorizationResponse,
} = require('verusid-ts-client');
const {
  I_ADDR_VERSION,
  toBase58Check,
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  DEFAULT_VERUS_CHAINID,
  deriveAppAuthorizationGrantID,
  deriveAppAuthorizationStorageManifest,
  GenericResponse,
  ResponseURI,
  AppAuthorizationOutcome,
  SaplingPaymentAddress,
} = require('verus-typescript-primitives');
const {
  createAuthorizationJob,
  createAuthorizationMaintenanceJob,
  getAuthorizationJob,
  updateAuthorizationJob,
  captureAuthorizationContext,
  requestFromAuthorizationJob,
} = require('../../appAuthorization/jobs');
const {
  loadAuthorizationReview,
  approveAuthorization: approveReviewedAuthorization,
  reconcileAuthorizationJob,
  prepareAuthorizationResponse,
  loadPreparedAuthorizationResponse,
  deliverAuthorizationResponse,
  cancelAuthorization,
  revokeAuthorization,
} = require('../../appAuthorization/workflow');
// Simulate the screen passing the revision captured by its last displayed
// review, rather than silently adopting whichever delegate is current later.
const approveAuthorization = (id, selection, options) =>
  approveReviewedAuthorization(
    id,
    {delegateRevision: mockReviewedRevisions.get(id), ...selection},
    options,
  );
const address = marker =>
  toBase58Check(Buffer.alloc(20, marker), I_ADDR_VERSION);
const user = {identityID: address(5), systemID: address(3)};
const recordEntry = record => ({
  record,
  ...(record instanceof AuthorizationCredential
    ? {
        identities: {
          appID: address(1),
          delegateID: address(2),
          delegate: mockDelegate,
          delegator: mockDelegator,
        },
      }
    : {}),
});
const receipt = () => ({
  txid: 'ab'.repeat(32),
  rawTx: 'aabb',
  systemId: user.systemID,
  broadcastAttempted: true,
  admittedAt: Date.now(),
  submittedAt: Date.now(),
  status: 'submitted',
});
const begin = async (options = {}) => {
  const request = createAppAuthorizationRequest({
    appID: address(1),
    delegate: {identityID: address(2), systemID: address(3)},
    requestID: address(4),
    encryptResponseToAddress: new SaplingPaymentAddress({
      d: Buffer.alloc(11, 1),
      pkD: Buffer.alloc(32, 2),
    }),
    expiryTime: new (require('bn.js'))(Math.floor(Date.now() / 1000) + 3600),
    ...options,
  });
  request.signature.signatureAsVch = Buffer.from('structural test fixture');
  const job = await createAuthorizationJob(request);
  const review = await loadAuthorizationReview(job.id);
  mockReviewedRevisions.set(job.id, review.delegateRevision);
  return job;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReviewedRevisions = new Map();
  mockReadScope
    .mockReset()
    .mockImplementation((context, operation) => operation(context));
  mockData = {};
  mockState = {
    authentication: {
      signedIn: true,
      activeAccount: {accountHash: 'alice'},
      sessionEpoch: 1,
    },
    settings: {
      generalWalletSettings: {enableExperimentalGenericRequests: true},
    },
  };
  mockDelegate = {
    txid: '11'.repeat(32),
    vout: 0,
    blockheight: 50,
    status: 'active',
    systemID: address(3),
    fullyqualifiedname: 'instance@',
    identity: {
      identityaddress: address(2),
      parent: address(3),
      minimumsignatures: 1,
      primaryaddresses: [
        require('@bitgo/utxo-lib')
          .ECPair.fromPrivateKeyBuffer(
            Buffer.alloc(32, 2),
            require('@bitgo/utxo-lib').networks.verus,
          )
          .getAddress(),
      ],
    },
  };
  mockDelegator = {
    ...mockDelegate,
    txid: '22'.repeat(32),
    fullyqualifiedname: 'app@',
    identity: {
      identityaddress: address(1),
      parent: address(3),
      version: 3,
      flags: 0,
      minimumsignatures: 1,
      primaryaddresses: [
        require('@bitgo/utxo-lib')
          .ECPair.fromPrivateKeyBuffer(
            Buffer.alloc(32, 2),
            require('@bitgo/utxo-lib').networks.verus,
          )
          .getAddress(),
      ],
    },
  };
  mockVerify.mockResolvedValue(true);
  const originalDelegator = mockDelegator;
  mockLoadRevision.mockReset().mockResolvedValue(originalDelegator);
  mockLoadIdentity.mockReset().mockImplementation(async (_source, binding) =>
    binding.identityID === mockDelegate.identity.identityaddress
      ? mockDelegate
      : {
          ...mockDelegate,
          identity: {
            ...mockDelegate.identity,
            identityaddress: binding.identityID,
          },
        },
  );
  mockSignerEvidence.mockReturnValue({valid: true});
  mockProfile.mockReset().mockImplementation(async () => mockDelegator);
  mockConfirm.mockResolvedValue(false);
  mockResponseSigner = {
    fullyqualifiedname: 'user@',
    txid: '44'.repeat(32),
    vout: 0,
    identity: {parent: address(3)},
  };
  mockIndependent.mockResolvedValue(mockResponseSigner);
  mockDeliver.mockReset().mockResolvedValue(undefined);
  mockSigningKeys.mockReset();
  mockRecordStorage.mockReset().mockImplementation(async job => job);
  mockView = {records: [], grants: []};
  mockLoadCredentials.mockImplementation(async () => mockView);
  mockEncrypt.mockImplementation(async (_user, records) => {
    mockGrant = records[0];
    mockView = {
      records: records.map(recordEntry),
      grants: [recordEntry(records[0])],
    };
    return {[address(9)]: ['aa']};
  });
  mockPreparePlan.mockReset().mockImplementation(async (_job, selection) => {
    await mockIndependent(selection.selectedIdentity);
    return {
      updates: [
        {
          identityID: selection.selectedIdentity.identityID,
          reviewedRevision: mockResponseSigner,
        },
      ],
      projectedUser: {
        identityaddress: selection.selectedIdentity.identityID,
        parent: address(3),
      },
      storageBindings: [],
      signingIdentities: [selection.selectedIdentity],
      signingKeyIDs: [],
      reviewedIdentities: [],
      giftIdentityIDs: [],
    };
  });
  mockPlanCurrent.mockReset().mockImplementation(async job => {
    await mockIndependent(job.selectedIdentity);
  });
  mockRecoverGift.mockReset().mockResolvedValue(undefined);
  mockDeriveChannel.mockReset().mockResolvedValue({
    encryptedDescriptorJson: {
      version: 1,
      flags: 5,
      epk: '22'.repeat(32),
      objectdata: '33'.repeat(64),
    },
  });
  mockSubmit.mockImplementation(async (id, options, context) => {
    const saved = receipt();
    await updateAuthorizationJob(
      id,
      {
        ...options.jobChanges,
        transactions: {[options.receiptKey]: {...saved, status: 'prepared'}},
      },
      context,
    );
    await options.beforeSend();
    await updateAuthorizationJob(
      id,
      {
        transactions: {[options.receiptKey]: saved},
        grantTransaction: saved,
        grantConfirmed: false,
        status: 'waiting_for_grant_confirmation',
      },
      context,
    );
    return saved;
  });
});

it('writes typed self-encrypted grants and waits for confirmation before reporting success', async () => {
  const job = await begin();
  const result = await approveAuthorization(job.id, {
    selectedIdentity: user,
    storageBindings: [],
  });
  expect(
    requestFromAuthorizationJob(await getAuthorizationJob(job.id)).details,
  ).toHaveLength(3);
  expect(mockSubmit.mock.calls[0][1].updates).toHaveLength(1);
  expect(mockGrant).toBeInstanceOf(AuthorizationCredential);
  expect(mockGrant.data.delegateRevision).toEqual({
    txid: mockDelegate.txid,
    vout: 0,
  });
  expect(mockGrant.data.delegatorRevision).toEqual({
    txid: mockDelegator.txid,
    vout: 0,
  });
  expect(mockGrant.toCredential().scopes).toEqual({});
  expect(result.status).toBe('waiting_for_grant_confirmation');
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'Wait for',
  );
  expect(mockDeliver).not.toHaveBeenCalled();
});

it('checks a no-storage user at selection and again at handoff without a duplicate setup read', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  expect(mockIndependent).toHaveBeenCalledTimes(2);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});

it.each([DEFAULT_VERUS_CHAINID, address(3)])(
  'writes compact systems while committing the effective chain %s',
  async systemID => {
    const selectedIdentity = {...user, systemID};
    mockDelegate.systemID = systemID;
    mockDelegator.systemID = systemID;
    const prepare = mockPreparePlan.getMockImplementation();
    mockPreparePlan.mockImplementation(async (...args) => ({
      ...(await prepare(...args)),
      storageBindings: [{
        storageID: address(8),
        revocationID: user.identityID,
        recoveryID: user.identityID,
      }],
    }));
    const job = await begin({
      delegate: {identityID: address(2), systemID},
      requiresSharedStorage: true,
    });

    await approveAuthorization(job.id, {
      selectedIdentity,
      storageBindings: [{
        storageIdentity: address(8),
        revocationIdentity: user.identityID,
        recoveryIdentity: user.identityID,
      }],
    });

    const [grant, binding] = mockEncrypt.mock.calls[0][1];
    expect(grant.getSystemID(DEFAULT_VERUS_CHAINID)).toBe(systemID);
    expect(grant.toPayload().s).toBe(
      systemID === DEFAULT_VERUS_CHAINID ? undefined : systemID,
    );
    expect(binding.toPayload()).not.toHaveProperty('s');
    expect(grant.data.storageManifestHash).toBe(
      deriveAppAuthorizationStorageManifest([binding], systemID),
    );
  },
);

it('rejects app key replacement during fee review without broadcasting the prepared grant', async () => {
  const job = await begin();
  mockPlanCurrent.mockImplementationOnce(async () => {
    mockDelegator = {
      ...mockDelegator,
      txid: '33'.repeat(32),
      identity: {
        ...mockDelegator.identity,
        primaryaddresses: [
          require('@bitgo/utxo-lib')
            .ECPair.fromPrivateKeyBuffer(
              Buffer.alloc(32, 3),
              require('@bitgo/utxo-lib').networks.verus,
            )
            .getAddress(),
        ],
      },
    };
  });

  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('app signing authority changed');
  const saved = await getAuthorizationJob(job.id);
  expect(saved.transactions.grant.status).toBe('prepared');
  expect(saved.approvedDelegator.txid).not.toBe(mockDelegator.txid);
});

it('allows unrelated app updates without replacing the approved baseline', async () => {
  const job = await begin();
  const approved = mockDelegator;
  mockPlanCurrent.mockImplementationOnce(async () => {
    mockDelegator = {
      ...mockDelegator,
      txid: '33'.repeat(32),
      identity: {...mockDelegator.identity, privateaddress: 'updated'},
    };
  });

  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await prepareAuthorizationResponse(job.id);
  const saved = await getAuthorizationJob(job.id);
  expect(saved.approvedDelegator.txid).toBe(approved.txid);
  expect(saved.expectedGrant.o[0]).toBe(approved.txid);
  expect(saved.responseHex).toBeTruthy();
});

it('accepts the same approved outpoint confirmed at a different block height', async () => {
  const job = await begin();
  const approved = mockDelegator;
  mockPlanCurrent.mockImplementationOnce(async () => {
    mockDelegator = {...mockDelegator, blockheight: approved.blockheight + 1};
  });

  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await prepareAuthorizationResponse(job.id);

  const saved = await getAuthorizationJob(job.id);
  expect(saved.expectedGrant.o).toEqual([approved.txid, approved.vout]);
  expect(saved.responseHex).toBeTruthy();
  expect(mockLoadRevision).not.toHaveBeenCalled();
});

it('withholds the response when app authority changes after confirmation', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockSigningKeys.mockImplementationOnce(() => {
    mockDelegator = {
      ...mockDelegator,
      status: 'revoked',
      identity: {
        ...mockDelegator.identity,
        flags:
          require('verus-typescript-primitives').IDENTITY_FLAG_REVOKED.toNumber(),
      },
    };
  });

  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'app signing authority changed',
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

it('rejects a reorganized app baseline even when its current signing keys still match', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockDelegator = {...mockDelegator, txid: '33'.repeat(32)};
  mockLoadRevision.mockRejectedValue(
    new Error('Approved revision unavailable'),
  );
  mockConfirm.mockResolvedValue(true);

  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'Approved revision unavailable',
  );
  expect(mockLoadRevision).toHaveBeenCalledWith(
    expect.anything(),
    {identityID: address(1), systemID: user.systemID},
    {txid: '22'.repeat(32), vout: 0},
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

it('binds review to current D after the concurrent signature verification finishes', async () => {
  const job = await begin();
  const signedDelegate = mockDelegate;
  mockLoadIdentity.mockImplementation(async (_source, binding, height) =>
    binding.identityID === mockDelegate.identity.identityaddress &&
    height != null
      ? signedDelegate
      : mockDelegate,
  );
  mockVerify.mockImplementationOnce(async () => {
    mockDelegate = {...mockDelegate, txid: '22'.repeat(32)};
    return true;
  });

  const review = await loadAuthorizationReview(job.id);
  expect(review.delegateRevision.txid).toBe(mockDelegate.txid);
  expect(mockSignerEvidence).toHaveBeenLastCalledWith(
    expect.anything(),
    signedDelegate,
    mockDelegate,
  );
});

it('refreshes an already confirmed grant once after opening response signing keys', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockLoadCredentials.mockClear();
  await prepareAuthorizationResponse(job.id);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
  expect(mockLoadCredentials.mock.invocationCallOrder[0]).toBeGreaterThan(
    mockSigningKeys.mock.invocationCallOrder[0],
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeTruthy();
});

it('does not trust saved grant confirmation if the grant disappears during key access', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockSigningKeys.mockImplementationOnce(() => {
    mockView = {records: [], grants: []};
  });
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow('absent');
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

it('does not sign a response if the previously confirmed grant leaves the active chain', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockConfirm.mockResolvedValue(false);
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'Wait for',
  );
  const saved = await getAuthorizationJob(job.id);
  expect(saved.grantConfirmed).toBe(false);
  expect(saved.responseHex).toBeUndefined();
});

it.each([false, true])(
  'reports response destination availability without exposing the signed response: %s',
  async hasResponseDestination => {
    const job = await begin({
      ...(hasResponseDestination
        ? {
            responseURIs: [
              ResponseURI.fromUriString('https://example.com/response'),
            ],
          }
        : {}),
    });
    const review = await loadAuthorizationReview(job.id);
    expect(review.hasResponseDestination).toBe(hasResponseDestination);
    expect(review.responseHex).toBeUndefined();
    expect(
      (await cancelAuthorization(job.id, user)).hasResponseDestination,
    ).toBe(hasResponseDestination);
  },
);

it('exports only the exact frozen response without preparing or signing again', async () => {
  const job = await begin();
  await expect(loadPreparedAuthorizationResponse(job.id)).rejects.toThrow(
    'Prepare the authorization response first',
  );
  await cancelAuthorization(job.id, user);
  const summary = await prepareAuthorizationResponse(job.id);
  const frozen = (await getAuthorizationJob(job.id)).responseHex;
  mockSigningKeys.mockClear();
  const response = await loadPreparedAuthorizationResponse(job.id);
  expect(response).toBeInstanceOf(GenericResponse);
  expect(response.toBuffer().toString('hex')).toBe(frozen);
  expect(summary.responseHex).toBeUndefined();
  expect(mockSigningKeys).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();

  mockData.authorizationJobs.jobs[job.id].responseHex += '00';
  await expect(loadPreparedAuthorizationResponse(job.id)).rejects.toThrow(
    'saved response is invalid',
  );
});

it('rejects response export after a wallet switch or unsafe local cancellation', async () => {
  const job = await begin();
  await cancelAuthorization(job.id, user);
  await prepareAuthorizationResponse(job.id);
  const context = captureAuthorizationContext();
  mockState.authentication.sessionEpoch += 1;
  await expect(
    loadPreparedAuthorizationResponse(job.id, context),
  ).rejects.toMatchObject({code: 'SESSION_CHANGED'});

  mockData.authorizationJobs.jobs[job.id].transactions = {grant: receipt()};
  await expect(loadPreparedAuthorizationResponse(job.id)).rejects.toThrow(
    'stopped locally',
  );
});

it.each([
  ['an existing identity without a gift', undefined, false],
  [
    'an existing identity alongside other gifts',
    {identityID: address(8), systemID: user.systemID},
    false,
  ],
  [
    'an existing identity on a different system from the gift',
    {...user, systemID: address(8)},
    false,
  ],
  ['the gifted response identity', user, true],
])(
  'requires full authority control only for %s when gifted',
  async (_label, gifted, requireAuthorityControl) => {
    const job = await begin();
    if (gifted) {
      await updateAuthorizationJob(job.id, {
        hasGift: true,
        giftConfirmed: true,
        giftDiscovery: {
          systems: [
            {
              systemId: gifted.systemID,
              identities: [{identityAddress: gifted.identityID}],
            },
          ],
        },
      });
    }

    await approveAuthorization(job.id, {selectedIdentity: user});
    mockIndependent.mockClear();
    mockConfirm.mockResolvedValue(true);
    await prepareAuthorizationResponse(job.id);

    expect(mockIndependent).toHaveBeenCalled();
    for (const [selected, context] of mockIndependent.mock.calls) {
      expect(selected).toEqual(user);
      expect(context.requireAuthorityControl).toBe(requireAuthorityControl);
    }
    expect(mockSigningKeys).toHaveBeenCalledWith(
      user,
      expect.objectContaining({requireAuthorityControl}),
    );
  },
);

it('completes after expiry only for a recorded timely submission and never rebuilds it', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  const later = jest
    .spyOn(Date, 'now')
    .mockReturnValue((job.expiryTime + 1) * 1000);
  try {
    const completed = await reconcileAuthorizationJob(job.id);
    expect(completed.status).toBe('response_ready');
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockFreshView).toHaveBeenCalled();
  } finally {
    later.mockRestore();
  }
});

it('links the confirmed nongift U and refreshes wallet cards only after its grant is verified', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  expect(mockRecordStorage).not.toHaveBeenCalled();
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  expect(mockRecordStorage).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Object),
    [],
    [
      expect.objectContaining({
        fullyqualifiedname: 'user@',
        identity: expect.objectContaining({identityaddress: user.identityID}),
      }),
    ],
  );
  expect((await getAuthorizationJob(job.id)).userIdentityLinked).toBe(true);
  expect(
    require('../../identityManagement/unlinkAfterUpdate')
      .refreshLinkedIdentityWallet,
  ).toHaveBeenCalledWith('VRSC', expect.any(Object));
  await reconcileAuthorizationJob(job.id);
  expect(mockRecordStorage).toHaveBeenCalledTimes(1);
});

it('does not link U or persist grant confirmation when the final freshness check fails', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  const before = await getAuthorizationJob(job.id);
  mockConfirm.mockResolvedValue(true);
  mockReadScope.mockImplementationOnce(async (context, operation) => {
    await operation(context);
    throw new Error('Final identity evidence changed');
  });

  await expect(reconcileAuthorizationJob(job.id)).rejects.toThrow(
    'Final identity evidence changed',
  );
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockRecordStorage).not.toHaveBeenCalled();
  expect(await getAuthorizationJob(job.id)).toEqual(before);
});

it('does not complete a removal when the final freshness check fails', async () => {
  const job = await createAuthorizationMaintenanceJob(user, {
    appID: address(1),
    delegateID: address(2),
    grantIDs: ['aa'.repeat(32)],
    users: [user],
    values: [],
  });
  await updateAuthorizationJob(job.id, {
    status: 'waiting_for_grant_confirmation',
    transactions: {'remove-grants': receipt()},
  });
  mockConfirm.mockResolvedValue(true);
  mockView = {records: [], grants: []};
  mockReadScope.mockImplementationOnce(async (context, operation) => {
    await operation(context);
    throw new Error('Final identity evidence changed');
  });

  await expect(reconcileAuthorizationJob(job.id)).rejects.toThrow(
    'Final identity evidence changed',
  );
  expect((await getAuthorizationJob(job.id)).status).toBe(
    'waiting_for_grant_confirmation',
  );
});

it('preserves inherited nonroot storage in the same transaction that revokes its instance', async () => {
  const binding = new AuthorizationStorageBindingCredential({
    version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
    grantID: '55'.repeat(32),
    relationshipIndex: 0,
    storageID: address(8),
  });
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS,
    grantID: binding.data.grantID,
    signingSystemID: user.systemID,
    delegateRevision: {txid: mockDelegate.txid, vout: mockDelegate.vout},
    delegatorRevision: {txid: mockDelegator.txid, vout: mockDelegator.vout},
    storageManifestHash: deriveAppAuthorizationStorageManifest([binding], user.systemID),
  });
  const entries = [grant, binding].map((record, index) => ({
    ...recordEntry(record),
    source: {outerKey: address(9), storedValue: Buffer.from([index])},
  }));
  const view = {
    rootSystemID: DEFAULT_VERUS_CHAINID,
    grants: [entries[0]],
    storageBindings: [entries[1]],
  };
  mockLoadCredentials.mockResolvedValue(view);

  await revokeAuthorization(user, address(1), address(2));

  const replacements = mockEncrypt.mock.calls[0][1];
  expect(replacements).toHaveLength(1);
  expect(replacements[0].toPayload()).toEqual({
    ...binding.toPayload(),
    s: user.systemID,
  });
  expect(binding.toPayload()).not.toHaveProperty('s');
  const {buildAuthorizationRemovals} = require('../../appAuthorization/credentials');
  expect(buildAuthorizationRemovals).toHaveBeenCalledWith(entries);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockSubmit.mock.calls[0][1].updates[0].contentmultimap[address(9)])
    .toEqual(['aa']);
});

it('revokes only the selected app instance across user identities in one transaction', async () => {
  const secondUser = {...user, identityID: address(6)};
  const entry = (grantID, appID, delegateID) => ({
    record: {data: {grantID}},
    identities: {appID, delegateID},
    source: {outerKey: address(9), storedValue: Buffer.from(grantID, 'hex')},
  });
  const first = entry('11'.repeat(32), address(1), address(2));
  const second = entry('22'.repeat(32), address(1), address(2));
  const sibling = entry('33'.repeat(32), address(1), address(7));
  const otherApp = entry('44'.repeat(32), address(8), address(2));
  const firstView = {
    grants: [first, sibling, otherApp],
    storageBindings: [],
  };
  const secondView = {grants: [second], storageBindings: []};
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID ? firstView : secondView,
  );

  const result = await revokeAuthorization(user, address(1), address(2), {
    relatedUsers: [secondUser, user, secondUser],
  });

  expect(result.pending).toBe(true);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  const options = mockSubmit.mock.calls[0][1];
  expect(options.updates.map(update => update.identityID).sort()).toEqual(
    [user.identityID, secondUser.identityID].sort(),
  );
  expect(options.signingIdentities).toHaveLength(2);
  expect(options.feeType).toBe('removal');
  const {
    buildAuthorizationRemovals,
  } = require('../../appAuthorization/credentials');
  expect(
    buildAuthorizationRemovals.mock.calls.map(([entries]) => entries),
  ).toEqual(expect.arrayContaining([[first], [second]]));
  expect(firstView.grants).toEqual([first, sibling, otherApp]);
  expect(firstView.storageBindings).toEqual([]);
  expect(secondView.storageBindings).toEqual([]);
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockRecordStorage).not.toHaveBeenCalled();

  const job = await getAuthorizationJob(result.jobId);
  expect(job.targets.users).toHaveLength(2);
  expect(job.targets.grantIDs).toEqual(['11'.repeat(32), '22'.repeat(32)]);
  expect(job.status).toBe('waiting_for_removal_confirmation');
  mockConfirm.mockResolvedValue(true);
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID
      ? {grants: [sibling, otherApp]}
      : secondView,
  );
  await expect(reconcileAuthorizationJob(result.jobId)).rejects.toThrow(
    'approval is still present',
  );
  mockLoadCredentials.mockImplementation(async selected =>
    selected.identityID === user.identityID
      ? {grants: [sibling, otherApp]}
      : {grants: []},
  );
  expect((await reconcileAuthorizationJob(result.jobId)).status).toBe(
    'complete',
  );
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});

it('does not sign or publish a response before the final freshness check succeeds', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockLink.mockClear();
  mockRecordStorage.mockClear();
  const {IdentitySignature} = require('@bitgo/utxo-lib');
  const sign = jest.spyOn(IdentitySignature.prototype, 'signHashOffline');
  mockReadScope.mockImplementationOnce(async (context, operation) => {
    await operation(context);
    throw new Error('Final identity evidence changed');
  });

  try {
    await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
      'Final identity evidence changed',
    );
    expect(mockSigningKeys).toHaveBeenCalledTimes(1);
    expect(sign).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockRecordStorage).not.toHaveBeenCalled();
    expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
  } finally {
    sign.mockRestore();
  }
});

it('exposes only an unambiguous requested user identity for selection defaults', async () => {
  const {
    RecipientConstraint,
    CompactIAddressObject,
  } = require('verus-typescript-primitives');
  const constraint = identityID =>
    new RecipientConstraint({
      type: RecipientConstraint.REQUIRED_ID,
      identity: CompactIAddressObject.fromAddress(identityID),
    });
  const explicit = await begin({
    recipientConstraints: [constraint(user.identityID)],
  });
  expect((await loadAuthorizationReview(explicit.id)).requestedUserID).toBe(
    user.identityID,
  );
  // Use a fresh logical request for the alternative list.
  const ambiguous = await begin({
    requestID: address(9),
    recipientConstraints: [constraint(user.identityID), constraint(address(8))],
  });
  expect(
    (await loadAuthorizationReview(ambiguous.id)).requestedUserID,
  ).toBeNull();
});

it('requires a fresh user review if D changes after the review screen', async () => {
  const job = await begin();
  const saved = await getAuthorizationJob(job.id);
  mockStorageWrite.mockClear();
  mockDelegate = {...mockDelegate, txid: '22'.repeat(32)};
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      approveAuthorization(job.id, {selectedIdentity: user}),
    ).rejects.toMatchObject({code: 'AUTHORIZATION_DELEGATE_CHANGED'});
  }
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockEncrypt).not.toHaveBeenCalled();
  expect(mockStorageWrite).not.toHaveBeenCalled();
  expect(await getAuthorizationJob(job.id)).toEqual(saved);

  const refreshed = await loadAuthorizationReview(job.id);
  mockReviewedRevisions.set(job.id, refreshed.delegateRevision);
  await approveAuthorization(job.id, {selectedIdentity: user});
  expect((await getAuthorizationJob(job.id)).approvedDelegate.txid).toBe(
    mockDelegate.txid,
  );
});

it('displays the verified delegate without persisting a review baseline', async () => {
  const job = await begin();
  const saved = await getAuthorizationJob(job.id);
  expect(mockStorageWrite).toHaveBeenCalledTimes(1);
  expect(saved.reviewedDelegate).toBeUndefined();
  mockStorageWrite.mockClear();

  const review = await loadAuthorizationReview(job.id);
  await loadAuthorizationReview(job.id);

  expect(review).toMatchObject({
    delegateName: 'instance@',
    delegateRevision: {txid: mockDelegate.txid, vout: 0, blockheight: 50},
  });
  expect(mockStorageWrite).not.toHaveBeenCalled();
  expect(await getAuthorizationJob(job.id)).toEqual(saved);
});

it.each([undefined, {}, {txid: '11'.repeat(32), vout: '0'}])(
  'requires a valid displayed revision for a fresh approval: %p',
  async delegateRevision => {
    const job = await begin();
    mockStorageWrite.mockClear();

    await expect(
      approveAuthorization(job.id, {selectedIdentity: user, delegateRevision}),
    ).rejects.toMatchObject({code: 'AUTHORIZATION_DELEGATE_CHANGED'});

    expect(mockStorageWrite).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  },
);

it('rechecks expiry and current delegate policy after encryption and before submission', async () => {
  const job = await begin();
  mockEncrypt.mockImplementation(async () => {
    mockVerify.mockResolvedValue(false);
    return {[address(9)]: ['aa']};
  });
  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('no longer valid');
  expect((await getAuthorizationJob(job.id)).transactions.grant.status).toBe(
    'prepared',
  );
});

it('rejects substituted confirmed credentials and absent management before signing', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  mockGrant.data.flags = AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS;
  mockGrant.data.storageManifestHash = '77'.repeat(32);
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'differ from',
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

it.each(['appID', 'delegateID', 'unavailable'])(
  'withholds the response when resolved approval identities are %s',
  async problem => {
    const job = await begin();
    await approveAuthorization(job.id, {selectedIdentity: user});
    mockConfirm.mockResolvedValue(true);
    if (problem === 'unavailable') delete mockView.records[0].identities;
    else mockView.records[0].identities[problem] = address(8);

    await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
      'approved identity revisions could not be verified',
    );
    expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
  },
);

it('retains exactly the same signed response for a failed delivery retry', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  mockDeliver
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(undefined);
  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow('Offline');
  const prepared = (await getAuthorizationJob(job.id)).responseHex;
  expect(prepared).toBeTruthy();
  await deliverAuthorizationResponse(job.id);
  const delivered = mockDeliver.mock.calls.map(([, response]) =>
    response.toBuffer().toString('hex'),
  );
  expect(delivered).toEqual([prepared, prepared]);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  const response = new GenericResponse();
  response.fromBuffer(Buffer.from(prepared, 'hex'));
  expect(response.signature.identityID.toIAddress()).toBe(user.identityID);
  expect((await getAuthorizationJob(job.id)).status).toBe('complete');
});

it('does not persist a plan when the user declines its prepared fee review', async () => {
  const job = await begin();
  const reviewed = await getAuthorizationJob(job.id);
  mockStorageWrite.mockClear();
  mockSubmit.mockImplementationOnce(async (_id, options) => {
    expect(options.jobChanges.authorizationPlan.updates).toHaveLength(1);
    expect(options.jobChanges.expectedGrant).toBeTruthy();
    expect(await getAuthorizationJob(job.id)).toEqual(reviewed);
    throw new Error('Authorization update cancelled before signing.');
  });

  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('cancelled before signing');

  expect(mockStorageWrite).not.toHaveBeenCalled();
  expect(await getAuthorizationJob(job.id)).toEqual(reviewed);
});

it('does not rewrite an unchanged pending or confirmed authorization', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockStorageWrite.mockClear();
  const pending = await getAuthorizationJob(job.id);

  await reconcileAuthorizationJob(job.id);
  await reconcileAuthorizationJob(job.id);
  expect(mockStorageWrite).not.toHaveBeenCalled();
  expect((await getAuthorizationJob(job.id)).revision).toBe(pending.revision);

  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockStorageWrite.mockClear();
  const confirmed = await getAuthorizationJob(job.id);
  await reconcileAuthorizationJob(job.id);
  expect(mockStorageWrite).not.toHaveBeenCalled();
  expect((await getAuthorizationJob(job.id)).revision).toBe(confirmed.revision);
});

it('saves the channel and signed response together after final grant verification', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await reconcileAuthorizationJob(job.id);
  mockStorageWrite.mockClear();

  await prepareAuthorizationResponse(job.id);

  expect(mockStorageWrite).toHaveBeenCalledTimes(1);
  const saved = await getAuthorizationJob(job.id);
  expect(saved.appEncryptionResponse).toBeTruthy();
  expect(saved.responseHex).toBeTruthy();
});

it('finishes redirect bookkeeping before launch and retries the frozen response after launch failure', async () => {
  const job = await begin({
    responseURIs: [ResponseURI.fromUriString('https://example.com/response')],
  });
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await prepareAuthorizationResponse(job.id);
  const prepared = await getAuthorizationJob(job.id);
  mockDeliver.mockImplementationOnce(async () => {
    expect((await getAuthorizationJob(job.id)).status).toBe('complete');
    throw new Error('Could not open requester');
  });

  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow(
    'Could not open requester',
  );
  expect(await getAuthorizationJob(job.id)).toMatchObject({
    status: 'response_ready',
    responseHex: prepared.responseHex,
  });
  await deliverAuthorizationResponse(job.id);
  expect(await loadAuthorizationReview(job.id)).toMatchObject({
    status: 'complete',
    canRetryResponse: true,
  });
  expect(mockDeriveChannel).toHaveBeenCalledTimes(1);
});

it('notifies with real SDK shared-storage response codecs and retries the exact confirmed grant response', async () => {
  const job = await begin({
    requiresSharedStorage: true,
    responseURIs: [ResponseURI.fromUriString('https://example.com/response')],
  });
  const request = requestFromAuthorizationJob(
    await getAuthorizationJob(job.id),
  );
  const grantID = deriveAppAuthorizationGrantID(
    user,
    {identityID: job.delegateId, systemID: job.systemId},
    job.appId,
    request.getRawDataSha256().toString('hex'),
  );
  const storage = {
    storageID: address(8),
    revocationID: address(6),
    recoveryID: address(7),
    userKeyID: '33'.repeat(20),
    appKeyIDs: ['44'.repeat(20)],
  };
  const management = [
    new AuthorizationStorageBindingCredential({
      version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
      grantID,
      relationshipIndex: 0,
      storageSystemID: user.systemID,
      storageID: storage.storageID,
    }),
  ];
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS,
    grantID,
    signingSystemID: job.systemId,
    delegateRevision: {
      txid: mockDelegate.txid,
      vout: mockDelegate.vout,
    },
    delegatorRevision: {
      txid: mockDelegator.txid,
      vout: mockDelegator.vout,
    },
    storageManifestHash: deriveAppAuthorizationStorageManifest(management),
  });
  mockView = {
    records: [grant, ...management].map(recordEntry),
    grants: [recordEntry(grant)],
  };
  // Model the real Notify app entry point: storage and the grant already exist
  // on-chain, and durable job data stores ordinary address strings.
  await updateAuthorizationJob(job.id, {
    approved: true,
    selectedIdentity: user,
    approvedDelegate: mockDelegate,
    approvedDelegator: mockDelegator,
    grantID,
    storageBindings: [storage],
    expectedGrant: grant.toPayload(),
    transactions: {grant: receipt()},
  });
  mockConfirm.mockResolvedValue(true);
  expect((await reconcileAuthorizationJob(job.id)).status).toBe(
    'response_ready',
  );

  await prepareAuthorizationResponse(job.id);
  const frozen = (await getAuthorizationJob(job.id)).responseHex;
  const bytes = Buffer.from(frozen, 'hex');
  const response = new GenericResponse();
  expect(response.fromBuffer(bytes)).toBe(bytes.length);
  expect(response.toBuffer()).toEqual(bytes);
  const details = validateAppAuthorizationResponse(response, request, {
    ...user,
    parentID: mockResponseSigner.identity.parent,
  });
  expect(details.outcome).toBe(AppAuthorizationOutcome.SUCCESS);
  expect(details.grantID).toBe(grantID);
  expect(
    details.storageBindings.map(binding => ({
      storageID: binding.storageIdentity.toIAddress(),
      revocationID: binding.revocationIdentity.toIAddress(),
      recoveryID: binding.recoveryIdentity.toIAddress(),
    })),
  ).toEqual([
    {
      storageID: storage.storageID,
      revocationID: storage.revocationID,
      recoveryID: storage.recoveryID,
    },
  ]);
  expect(response.signature.signatureAsVch.length).toBeGreaterThan(0);

  mockDeliver
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(undefined);
  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow('Offline');
  await deliverAuthorizationResponse(job.id);
  expect(
    mockDeliver.mock.calls.map(([, sent]) => sent.toBuffer().toString('hex')),
  ).toEqual([frozen, frozen]);
  expect(mockSigningKeys).toHaveBeenCalledTimes(1);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect((await getAuthorizationJob(job.id)).responseHex).toBe(frozen);
  expect((await getAuthorizationJob(job.id)).status).toBe('complete');
});

it('blocks approval when the experimental gate is disabled', async () => {
  const job = await begin();
  mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = false;
  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('experimental');
  expect(mockSubmit).not.toHaveBeenCalled();
});

it('binds approval to the exact delegate revision whose signatures were checked', async () => {
  const job = await begin();
  mockSignerEvidence.mockReturnValue({valid: false});
  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('reviewed delegate revision');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockEncrypt).not.toHaveBeenCalled();
});

it('does not reactivate a cancelled request when it is replayed', async () => {
  const job = await begin();
  await cancelAuthorization(job.id, user);
  await expect(
    approveAuthorization(job.id, {selectedIdentity: user}),
  ).rejects.toThrow('cancelled');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockEncrypt).not.toHaveBeenCalled();
});

it.each([
  [
    'unusable response identity',
    job => {
      mockIndependent.mockRejectedValue(new Error('Identity signing failed'));
    },
  ],
  [
    'invalid request signature',
    job => {
      mockVerify.mockResolvedValue(false);
    },
  ],
  [
    'offline identities',
    job => {
      mockLoadIdentity.mockRejectedValue(new Error('Offline'));
    },
  ],
  [
    'malformed saved request',
    job => {
      mockData.authorizationJobs.jobs[job.id].requestHex = '00';
    },
  ],
  [
    'disabled experimental setting',
    job => {
      mockState.settings.generalWalletSettings.enableExperimentalGenericRequests = false;
    },
  ],
])(
  'cancels locally despite %s and reloads without request or identity checks',
  async (_label, fail) => {
    const job = await begin();
    jest.clearAllMocks();
    fail(job);

    await expect(cancelAuthorization(job.id, user)).resolves.toMatchObject({
      status: 'cancelled',
      selectedIdentity: user,
      canNotifyCancellation: true,
      approvalMayRemain: false,
    });
    await expect(loadAuthorizationReview(job.id)).resolves.toMatchObject({
      status: 'cancelled',
      selectionsLocked: true,
    });
    expect((await getAuthorizationJob(job.id)).status).toBe('cancelled');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockLoadIdentity).not.toHaveBeenCalled();
    expect(mockIndependent).not.toHaveBeenCalled();
    expect(mockSigningKeys).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  },
);

it('retains cancellation when the optional response identity cannot sign', async () => {
  const job = await begin();
  await cancelAuthorization(job.id, user);
  mockIndependent.mockImplementation(async () => {
    expect(mockData.authorizationJobs.jobs[job.id].status).toBe('cancelled');
    throw new Error('Signing identity is unavailable');
  });

  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'unavailable',
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
  await expect(loadAuthorizationReview(job.id)).resolves.toMatchObject({
    status: 'cancelled',
    canNotifyCancellation: true,
  });
});

it('retains cancellation and reuses its signed response when notification fails', async () => {
  const job = await begin();
  await cancelAuthorization(job.id, user);
  mockDeliver.mockRejectedValueOnce(new Error('Callback offline'));

  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow(
    'Callback offline',
  );
  const prepared = await getAuthorizationJob(job.id);
  expect(prepared.status).toBe('cancelled');
  expect(prepared.responseHex).toBeTruthy();
  await expect(loadAuthorizationReview(job.id)).resolves.toMatchObject({
    status: 'cancelled',
    canNotifyCancellation: true,
  });

  await deliverAuthorizationResponse(job.id);
  expect(
    mockDeliver.mock.calls.map(([, response]) =>
      response.toBuffer().toString('hex'),
    ),
  ).toEqual([prepared.responseHex, prepared.responseHex]);
  expect(mockSigningKeys).toHaveBeenCalledTimes(1);
  await expect(loadAuthorizationReview(job.id)).resolves.toMatchObject({
    status: 'cancelled',
    canNotifyCancellation: false,
  });
  expect((await getAuthorizationJob(job.id)).status).toBe('cancelled');
});

it('preserves gift discovery and the submitted authorization transaction without exposing recovery material', async () => {
  const job = await begin();
  const retained = {
    hasGift: true,
    giftDiscovery: {systems: [], seed: 'SECRET-SEED'},
    authorizationPlan: {giftIdentityIDs: [user.identityID]},
    transactions: {grant: receipt()},
    storageBindings: [
      {
        storageID: address(7),
        revocationID: user.identityID,
        recoveryID: user.identityID,
      },
    ],
  };
  await updateAuthorizationJob(job.id, retained);
  const result = await cancelAuthorization(job.id);

  expect(result).toMatchObject({
    status: 'cancelled',
    giftRecoveryPending: true,
    canNotifyCancellation: false,
  });
  expect(JSON.stringify(result)).not.toContain('SECRET-SEED');
  expect(result.requestHex).toBeUndefined();
  expect(result.transactions).toBeUndefined();
  expect(await getAuthorizationJob(job.id)).toMatchObject(retained);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockConfirm).not.toHaveBeenCalled();
});

it.each(['prepared', 'broadcast_unknown', 'submitted'])(
  'stops locally after a %s grant without claiming cancellation or replaying it',
  async status => {
    const job = await begin();
    const grant = {
      ...receipt(),
      status,
      broadcastAttempted: status !== 'prepared',
    };
    await updateAuthorizationJob(job.id, {
      selectedIdentity: user,
      transactions: {grant},
      status: 'waiting_for_grant_confirmation',
    });
    jest.clearAllMocks();

    const result = await cancelAuthorization(job.id, {
      ...user,
      identityID: address(9),
    });
    expect(result).toMatchObject({
      status: 'cancelled',
      selectedIdentity: user,
      canNotifyCancellation: false,
      approvalMayRemain: true,
    });
    const saved = await getAuthorizationJob(job.id);
    expect(saved.transactions.grant).toEqual(grant);
    expect(saved.outcome).not.toBe(AppAuthorizationOutcome.CANCELLED);
    await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
      'stopped locally',
    );
    await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow(
      'stopped locally',
    );
    await expect(
      approveAuthorization(job.id, {selectedIdentity: user}),
    ).rejects.toThrow('cancelled');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockIndependent).not.toHaveBeenCalled();
    expect((await getAuthorizationJob(job.id)).status).toBe('cancelled');
  },
);

it('preserves a frozen success response when stopped locally and never delivers it afterward', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  await prepareAuthorizationResponse(job.id);
  const before = await getAuthorizationJob(job.id);
  jest.clearAllMocks();

  await expect(cancelAuthorization(job.id)).resolves.toMatchObject({
    status: 'cancelled',
    canNotifyCancellation: false,
    approvalMayRemain: true,
  });
  expect((await getAuthorizationJob(job.id)).responseHex).toBe(
    before.responseHex,
  );
  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow(
    'stopped locally',
  );
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
});

it('retains profile and storage guards for local cancellation', async () => {
  const job = await begin();
  const context = captureAuthorizationContext();
  mockState.authentication.sessionEpoch += 1;
  await expect(
    cancelAuthorization(job.id, user, context),
  ).rejects.toMatchObject({
    code: 'SESSION_CHANGED',
  });
  expect(mockData.authorizationJobs.jobs[job.id].status).not.toBe('cancelled');

  mockData.authorizationJobs.version += 1;
  await expect(cancelAuthorization(job.id, user)).rejects.toThrow(
    'Unsupported',
  );
  expect(mockData.authorizationJobs.jobs[job.id].status).not.toBe('cancelled');
});

it('a signed cancellation response never includes a grant or storage-completion claim', async () => {
  const job = await begin();
  await updateAuthorizationJob(job.id, {
    storageBindings: [
      {
        storageID: address(7),
        revocationID: user.identityID,
        recoveryID: user.identityID,
      },
    ],
  });
  await cancelAuthorization(job.id, user);
  await prepareAuthorizationResponse(job.id);
  const saved = await getAuthorizationJob(job.id);
  const response = new GenericResponse();
  response.fromBuffer(Buffer.from(saved.responseHex, 'hex'));
  const detail = response.details[0].data;
  expect(detail.outcome).toBe(AppAuthorizationOutcome.CANCELLED);
  expect(detail.grantID).toBeUndefined();
  expect(detail.storageBindings).toBeUndefined();
  expect(response.signature.signatureAsVch.length).toBeGreaterThan(0);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockConfirm).not.toHaveBeenCalled();
});

it('rejects conflicting effective copies even when the first grant copy matches', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  const conflict = new AuthorizationCredential({
    ...mockGrant.data,
    delegatorRevision: {
      ...mockGrant.data.delegatorRevision,
      txid: '99'.repeat(32),
    },
  });
  mockView.records.push({record: conflict});
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'differ from',
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

it('does not freeze a response signed with keys from an outdated user revision', async () => {
  const job = await begin();
  await cancelAuthorization(job.id, user);
  mockIndependent.mockResolvedValue({
    ...mockResponseSigner,
    txid: '55'.repeat(32),
  });
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'response-signing identity changed',
  );
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
});

const beginCombinedCompletion = async () => {
  const {
    AppEncryptionRequestDetails,
    SaplingPaymentAddress,
    CompactIAddressObject,
  } = require('verus-typescript-primitives');
  const recipient = new SaplingPaymentAddress({
    d: Buffer.alloc(11, 1),
    pkD: Buffer.alloc(32, 2),
  });
  const job = await begin({
    encryptResponseToAddress: recipient,
    appEncryption: new AppEncryptionRequestDetails({
      requestID: CompactIAddressObject.fromAddress(address(4)),
      encryptResponseToAddress: recipient,
    }),
  });
  const request = requestFromAuthorizationJob(
    await getAuthorizationJob(job.id),
  );
  const grantID = deriveAppAuthorizationGrantID(
    user,
    {identityID: job.delegateId, systemID: job.systemId},
    job.appId,
    request.getRawDataSha256().toString('hex'),
  );
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: AuthorizationCredential.FLAGS_NONE,
    grantID,
    signingSystemID: job.systemId,
    delegateRevision: {
      txid: mockDelegate.txid,
      vout: mockDelegate.vout,
    },
    delegatorRevision: {
      txid: mockDelegator.txid,
      vout: mockDelegator.vout,
    },
  });
  mockView = {records: [recordEntry(grant)], grants: [recordEntry(grant)]};
  await updateAuthorizationJob(job.id, {
    approved: true,
    selectedIdentity: user,
    approvedDelegate: mockDelegate,
    approvedDelegator: mockDelegator,
    grantID,
    storageBindings: [],
    expectedGrant: grant.toPayload(),
    transactions: {grant: receipt()},
  });
  mockDeriveChannel.mockReset().mockResolvedValue({
    encryptedDescriptorJson: {
      version: 1,
      flags: 5,
      epk: '22'.repeat(32),
      objectdata: '33'.repeat(64),
    },
  });
  return {job, request};
};

it('withholds the bundled channel until the authorization transaction confirms', async () => {
  const {job} = await beginCombinedCompletion();
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow(
    'Wait for',
  );
  expect(mockDeriveChannel).not.toHaveBeenCalled();
  expect(
    (await getAuthorizationJob(job.id)).appEncryptionResponse,
  ).toBeUndefined();
});

it('returns both results and reuses the exact signed combined response after a failed callback', async () => {
  const {job, request} = await beginCombinedCompletion();
  mockConfirm.mockResolvedValue(true);
  await prepareAuthorizationResponse(job.id);
  const saved = await getAuthorizationJob(job.id);
  const response = new GenericResponse();
  response.fromBuffer(Buffer.from(saved.responseHex, 'hex'));
  expect(response.details).toHaveLength(2);
  expect(
    validateAppAuthorizationResponse(response, request, {
      ...user,
      parentID: address(3),
    }).outcome,
  ).toBe(AppAuthorizationOutcome.SUCCESS);
  expect(response.details[1].data.data.hasEncryptedData()).toBe(true);
  expect(saved.appEncryptionResponse.requestHash).toBe(
    request.getRawDataSha256().toString('hex'),
  );
  mockDeliver
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(undefined);
  await expect(deliverAuthorizationResponse(job.id)).rejects.toThrow('Offline');
  await deliverAuthorizationResponse(job.id);
  expect(mockDeriveChannel).toHaveBeenCalledTimes(1);
  expect(
    mockDeliver.mock.calls.map(([, reply]) => reply.toBuffer().toString('hex')),
  ).toEqual([saved.responseHex, saved.responseHex]);
});

it('does not release a bundled response if the grant disappears during channel derivation', async () => {
  const {job} = await beginCombinedCompletion();
  mockConfirm.mockResolvedValue(true);
  mockDeriveChannel.mockImplementationOnce(async () => {
    mockView = {records: [], grants: []};
    return {
      encryptedDescriptorJson: {
        version: 1,
        flags: 5,
        epk: '22'.repeat(32),
        objectdata: '33'.repeat(64),
      },
    };
  });
  await expect(prepareAuthorizationResponse(job.id)).rejects.toThrow('absent');
  expect((await getAuthorizationJob(job.id)).responseHex).toBeUndefined();
  expect(mockDeliver).not.toHaveBeenCalled();
});

const beginApprovalWithStorage = async (gift = false) => {
  const {
    AppEncryptionRequestDetails,
    SaplingPaymentAddress,
    CompactIAddressObject,
  } = require('verus-typescript-primitives');
  const recipient = new SaplingPaymentAddress({
    d: Buffer.alloc(11, 1),
    pkD: Buffer.alloc(32, 2),
  });
  const job = await begin({
    encryptResponseToAddress: recipient,
    appEncryption: new AppEncryptionRequestDetails({
      requestID: CompactIAddressObject.fromAddress(address(4)),
      encryptResponseToAddress: recipient,
    }),
  });
  const storage = {
    storageID: address(7),
    revocationID: user.identityID,
    recoveryID: user.identityID,
  };
  const plan = {
    updates: [
      {identityID: user.identityID, reviewedRevision: mockResponseSigner},
      {identityID: storage.storageID, changes: {minimumsignatures: 1}},
    ],
    projectedUser: {
      identityaddress: user.identityID,
      parent: address(3),
      privateaddress: 'future-wallet-private',
    },
    storageBindings: [
      {...storage, userKeyID: '11'.repeat(20), appKeyIDs: ['22'.repeat(20)]},
    ],
    signingIdentities: gift ? [] : [user],
    signingKeyIDs: ['11'.repeat(20)],
    reviewedIdentities: [],
    giftIdentityIDs: gift ? [user.identityID, storage.storageID] : [],
    ...(gift
      ? {
          ownerWalletBinding: {},
          fundingUtxos: [{txid: 'donor-funds', outputIndex: 0}],
          changeAddress: 'wallet-change',
        }
      : {}),
  };
  if (gift)
    await updateAuthorizationJob(job.id, {
      hasGift: true,
      giftDiscovery: {
        systems: [
          {
            systemId: user.systemID,
            claimWif: 'DONOR-TEST-KEY',
            identities: [
              {identityAddress: user.identityID},
              {identityAddress: storage.storageID},
            ],
          },
        ],
      },
    });
  mockPreparePlan.mockReset().mockResolvedValue(plan);
  mockPlanCurrent.mockReset().mockResolvedValue(undefined);
  mockProjectedEncrypt
    .mockReset()
    .mockImplementation((selected, records) => mockEncrypt(selected, records));
  mockRecoverGift
    .mockReset()
    .mockImplementation((saved, context) =>
      updateAuthorizationJob(
        saved.id,
        {giftConfirmed: true, unresolvedGiftIdentities: []},
        context,
      ),
    );
  return {
    job,
    plan,
    selection: {
      selectedIdentity: user,
      storageBindings: [
        {
          storageIdentity: storage.storageID,
          revocationIdentity: storage.revocationID,
          recoveryIdentity: storage.recoveryID,
        },
      ],
    },
  };
};

it('classifies a nongift S confirmed after local cancellation without reactivating or resubmitting', async () => {
  const {job, selection} = await beginApprovalWithStorage();
  await approveAuthorization(job.id, selection);
  await cancelAuthorization(job.id);
  mockConfirm.mockResolvedValue(true);
  mockRecordStorage.mockImplementation(async saved => ({
    ...saved,
    storageIdentitiesManaged: true,
  }));
  const result = await reconcileAuthorizationJob(job.id);
  expect(result.status).toBe('cancelled');
  expect((await getAuthorizationJob(job.id)).storageIdentitiesManaged).toBe(
    true,
  );
  expect(mockRecordStorage).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockSigningKeys).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
  mockIndependent.mockRejectedValue(new Error('Offline'));
  expect((await loadAuthorizationReview(job.id)).status).toBe('cancelled');
});

it.each([false, true])(
  'retries wallet-card refresh before committing identity completion markers (cancelled=%s)',
  async cancelled => {
    const {job, selection} = await beginApprovalWithStorage();
    await approveAuthorization(job.id, selection);
    if (cancelled) await cancelAuthorization(job.id);
    mockConfirm.mockResolvedValue(true);
    mockRecordStorage.mockImplementation(async saved => ({
      ...saved,
      storageIdentitiesManaged: true,
    }));
    const {
      refreshLinkedIdentityWallet,
    } = require('../../identityManagement/unlinkAfterUpdate');
    refreshLinkedIdentityWallet.mockRejectedValueOnce(
      new Error('Card refresh failed'),
    );
    await expect(reconcileAuthorizationJob(job.id)).rejects.toThrow(
      'Card refresh failed',
    );
    const interrupted = await getAuthorizationJob(job.id);
    expect(interrupted.storageIdentitiesManaged).not.toBe(true);
    expect(interrupted.userIdentityLinked).not.toBe(true);
    const result = await reconcileAuthorizationJob(job.id);
    expect(result.status).toBe(cancelled ? 'cancelled' : 'response_ready');
    expect((await getAuthorizationJob(job.id)).storageIdentitiesManaged).toBe(
      true,
    );
    expect(refreshLinkedIdentityWallet).toHaveBeenCalledTimes(2);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  },
);

it('preserves cancellation that arrives during a confirmed wallet-card refresh', async () => {
  const job = await begin();
  await approveAuthorization(job.id, {selectedIdentity: user});
  mockConfirm.mockResolvedValue(true);
  require('../../identityManagement/unlinkAfterUpdate').refreshLinkedIdentityWallet.mockImplementationOnce(
    () => cancelAuthorization(job.id),
  );
  expect((await reconcileAuthorizationJob(job.id)).status).toBe('cancelled');
  expect((await getAuthorizationJob(job.id)).status).toBe('cancelled');
  expect(mockSigningKeys).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
});

it('approves gifted U/S and the encrypted grant as one batch without a separate claim', async () => {
  const {job, plan, selection} = await beginApprovalWithStorage(true);
  const result = await approveAuthorization(job.id, selection);
  expect(result.status).toBe('waiting_for_grant_confirmation');
  expect(mockProjectedEncrypt).toHaveBeenCalledWith(
    user,
    expect.arrayContaining([expect.any(AuthorizationCredential)]),
    plan.projectedUser,
    expect.any(Object),
  );
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  const options = mockSubmit.mock.calls[0][1];
  expect(options).toMatchObject({
    updates: [
      {identityID: user.identityID, contentmultimap: {[address(9)]: ['aa']}},
      {identityID: address(7)},
    ],
    donorKeys: ['DONOR-TEST-KEY'],
    sweepFunding: true,
    receiptKey: 'grant',
  });
  expect(mockIndependent).not.toHaveBeenCalled();
  expect(mockPlanCurrent).toHaveBeenCalledTimes(1);
  expect(mockRecoverGift).not.toHaveBeenCalled();
  const saved = await getAuthorizationJob(job.id);
  expect(saved.giftConfirmed).not.toBe(true);
  expect(mockGrant.data.storageManifestHash).toBeDefined();
  expect(saved.expectedGrant).toEqual(mockGrant.toPayload());
});

it('batches existing U grant and S changes using ordinary wallet credentials', async () => {
  const {job, selection} = await beginApprovalWithStorage();
  await approveAuthorization(job.id, selection);
  expect(mockProjectedEncrypt).not.toHaveBeenCalled();
  expect(mockEncrypt).toHaveBeenCalledTimes(1);
  expect(mockSubmit.mock.calls[0][1]).toMatchObject({
    signingIdentities: [user],
    donorKeys: [],
    sweepFunding: false,
  });
});

it('retries a prepared authorization receipt without rebuilding the gift or its encrypted grant', async () => {
  const {job, selection} = await beginApprovalWithStorage(true);
  await approveAuthorization(job.id, selection);
  const saved = await getAuthorizationJob(job.id);
  await updateAuthorizationJob(job.id, {
    transactions: {grant: {...saved.transactions.grant, status: 'prepared'}},
  });
  await approveAuthorization(job.id, {
    selectedIdentity: {identityID: address(8), systemID: user.systemID},
  });
  expect(mockPreparePlan).toHaveBeenCalledTimes(1);
  expect(mockProjectedEncrypt).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledTimes(2);
  expect(mockSubmit.mock.calls[1][1].updates).toBeUndefined();
  expect((await getAuthorizationJob(job.id)).selectedIdentity).toEqual(user);
});

it.each(['cancelled', 'expired'])(
  'refuses fresh handoff after %s while retaining the unsigned review',
  async reason => {
    const {job, selection} = await beginApprovalWithStorage(true);
    let clock;
    mockSubmit.mockImplementationOnce(async (id, options, context) => {
      if (reason === 'cancelled')
        await updateAuthorizationJob(
          id,
          {status: 'cancelled', outcome: AppAuthorizationOutcome.CANCELLED},
          context,
        );
      else
        clock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(job.expiryTime * 1000 + 1000);
      await options.beforeSend();
    });
    try {
      await expect(approveAuthorization(job.id, selection)).rejects.toThrow();
      expect((await getAuthorizationJob(job.id)).transactions).toBeUndefined();
      expect(mockRecoverGift).not.toHaveBeenCalled();
    } finally {
      clock?.mockRestore();
    }
  },
);

it('recovers confirmed gifts after cancellation without sending an approval response', async () => {
  const {job, selection} = await beginApprovalWithStorage(true);
  await approveAuthorization(job.id, selection);
  await cancelAuthorization(job.id, user);
  mockConfirm.mockResolvedValue(true);
  const result = await reconcileAuthorizationJob(job.id);
  expect(result.status).toBe('cancelled');
  expect(mockRecoverGift).toHaveBeenCalledTimes(1);
  expect((await getAuthorizationJob(job.id)).giftConfirmed).toBe(true);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockDeriveChannel).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
});
