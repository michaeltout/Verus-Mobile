let mockData;
let mockState;
let mockQueue;
const mockReadData = jest.fn();

jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: () => mockReadData(),
}));
jest.mock('../../asyncStore/passwordProtectedStorageQueue', () => ({
  queueServiceStorageWrite: operation => {
    const task = mockQueue.then(operation);
    mockQueue = task.catch(() => {});
    return task;
  },
}));
jest.mock('../../appAuthorization/controls', () => ({
  authorizationContext: (context = {}) => ({
    ...context,
    sessionScope: {
      sessionScoped: true,
      accountHash: 'profile',
      sessionEpoch: mockState.authentication.sessionEpoch,
    },
    assertActive: context.assertActive || (() => {}),
  }),
}));
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: update => {
    const task = mockQueue.then(() => {
      mockData = JSON.parse(JSON.stringify(update(mockData)));
      return mockData;
    });
    mockQueue = task.catch(() => {});
    return task;
  },
}));

const {Buffer} = require('buffer');
const {
  AuthenticationRequestDetails,
  AuthenticationRequestOrdinalVDXFObject,
  AppEncryptionRequestDetails,
  AppEncryptionRequestOrdinalVDXFObject,
  DataPacketRequestOrdinalVDXFObject,
  BigNumber,
  CompactIAddressObject,
  DataDescriptor,
  DataResponseDetails,
  DataResponseOrdinalVDXFObject,
  GenericRequest,
  GenericResponse,
  SaplingPaymentAddress,
  VerifiableSignatureData,
  toIAddress,
} = require('verus-typescript-primitives');
const {
  delegatedOperationID,
  reserveDelegatedExecution,
  releaseDelegatedSigningReservation,
  recordDelegatedTransaction,
  saveDelegatedResponse,
  loadDelegatedResponse,
  findPreparedDelegatedResponse,
  loadDelegatedEncryptionResult,
  saveDelegatedEncryptionResult,
} = require('../../appAuthorization/delegatedOperations');
const systemID = toIAddress('VRSC', 'VRSC');
const user = {identityID: toIAddress('user', 'VRSC'), systemID};
const makeRequest = () => {
  const request = new GenericRequest({
    createdAt: new BigNumber(100),
    salt: Buffer.alloc(32, 1),
    details: [
      new AuthenticationRequestOrdinalVDXFObject({
        data: new AuthenticationRequestDetails(),
      }),
    ],
    appOrDelegatorID: CompactIAddressObject.fromAddress(
      toIAddress('app', 'VRSC'),
    ),
    signature: new VerifiableSignatureData({
      version: VerifiableSignatureData.DEFAULT_VERSION,
      systemID: CompactIAddressObject.fromAddress(systemID),
      identityID: CompactIAddressObject.fromAddress(
        toIAddress('delegate', 'VRSC'),
      ),
      signatureAsVch: Buffer.from([1]),
    }),
  });
  request.setSigned();
  return request;
};
const encryptionRequest = () => {
  const request = makeRequest();
  request.details.push(
    new AppEncryptionRequestOrdinalVDXFObject({
      data: new AppEncryptionRequestDetails({
        encryptResponseToAddress: new SaplingPaymentAddress({
          d: Buffer.alloc(11, 1),
          pkD: Buffer.alloc(32, 2),
        }),
      }),
    }),
  );
  request.setFlags();
  return request;
};
const encryptedResult = (byte = 1) => ({
  responseDetail: new DataResponseOrdinalVDXFObject({
    data: new DataResponseDetails({
      data: new DataDescriptor({
        flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
        objectdata: Buffer.alloc(32, byte),
        epk: Buffer.alloc(32, byte),
      }),
    }),
  }),
});

beforeEach(() => {
  mockData = {};
  mockQueue = Promise.resolve();
  mockReadData.mockImplementation(async () => mockData);
  mockState = {authentication: {sessionEpoch: 1}, deeplink: {requestId: 1}};
});

it('uses signer/system and raw data, ignoring signature encoding while separating fresh salts', () => {
  const request = makeRequest();
  const id = delegatedOperationID(request);
  request.signature.signatureAsVch = Buffer.from([2, 3]);
  expect(delegatedOperationID(request)).toBe(id);
  request.salt = Buffer.alloc(32, 2);
  expect(delegatedOperationID(request)).not.toBe(id);
});

it('allows one concurrent execution of a step and later distinct steps in the same flow', async () => {
  const request = makeRequest();
  const outcomes = await Promise.allSettled([
    reserveDelegatedExecution(request, user, 'payment'),
    reserveDelegatedExecution(request, user, 'payment'),
  ]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  await expect(
    reserveDelegatedExecution(request, user, 'response'),
  ).resolves.toBeDefined();
});

it('rejects a newly scanned copy and a changed selected user even for another step', async () => {
  const request = makeRequest();
  await reserveDelegatedExecution(request, user, 'payment');
  await expect(
    reserveDelegatedExecution(
      request,
      {...user, identityID: toIAddress('another', 'VRSC')},
      'response',
    ),
  ).rejects.toThrow(/already started/);
  mockState.deeplink.requestId++;
  await expect(
    reserveDelegatedExecution(request, user, 'response'),
  ).rejects.toThrow(/already being processed/);
});

it('does not treat a saved operation as new approval after process restart', async () => {
  const request = makeRequest();
  await reserveDelegatedExecution(request, user, 'payment');
  let restarted;
  jest.isolateModules(() => {
    restarted = require('../../appAuthorization/delegatedOperations');
  });
  await expect(
    restarted.reserveDelegatedExecution(request, user, 'response'),
  ).rejects.toThrow(/already started/);
});

it('retains a transaction receipt before broadcast and reuses exact final response bytes', async () => {
  const request = makeRequest();
  const operation = await reserveDelegatedExecution(request, user, 'payment');
  const receipt = {txid: '22'.repeat(32), rawTx: '0102', systemId: systemID};
  await recordDelegatedTransaction(operation, 'payment', receipt);
  expect(
    mockData.delegatedOperations.operations[operation.id].steps.payment.receipt,
  ).toEqual(receipt);
  await reserveDelegatedExecution(request, user, 'response');
  const response = new GenericResponse({
    details: [
      new DataResponseOrdinalVDXFObject({
        data: new DataResponseDetails({
          data: new DataDescriptor({
            objectdata: Buffer.from('prepared response'),
          }),
        }),
      }),
    ],
    requestHash: request.getRawDataSha256(),
    appOrDelegatorID: request.appOrDelegatorID,
    createdAt: new BigNumber(101),
    signature: new VerifiableSignatureData({
      version: VerifiableSignatureData.DEFAULT_VERSION,
      systemID: CompactIAddressObject.fromAddress(systemID),
      identityID: CompactIAddressObject.fromAddress(user.identityID),
      signatureAsVch: Buffer.from([3]),
    }),
  });
  response.setSigned();
  await saveDelegatedResponse(request, user, response);
  const preparedBytes = response.toBuffer();
  const restored = await loadDelegatedResponse(request, user);
  expect(restored.toBuffer()).toEqual(preparedBytes);
  let restarted;
  jest.isolateModules(() => {
    restarted = require('../../appAuthorization/delegatedOperations');
  });
  const resumed = await restarted.findPreparedDelegatedResponse(request);
  expect(resumed.user).toEqual(user);
  expect(resumed.response.toBuffer()).toEqual(preparedBytes);
  await expect(
    reserveDelegatedExecution(request, user, 'payment-again'),
  ).rejects.toThrow(/already been executed/);
  response.createdAt = new BigNumber(102);
  await expect(saveDelegatedResponse(request, user, response)).rejects.toThrow(
    /cannot be replaced/,
  );
  mockData.delegatedOperations.operations[operation.id].user = {
    ...user,
    systemID: toIAddress('another-chain', 'VRSC'),
  };
  await expect(findPreparedDelegatedResponse(request)).rejects.toThrow(
    /does not match/,
  );
  mockData.delegatedOperations.accountHash = 'different-profile';
  await expect(findPreparedDelegatedResponse(request)).rejects.toThrow(
    /history/,
  );
});

it('does not load prepared responses through a different active wallet network', async () => {
  mockState.authentication.activeAccount = {
    testnetOverrides: {VRSC: 'VRSCTEST'},
  };
  await expect(findPreparedDelegatedResponse(makeRequest())).rejects.toThrow(
    /different wallet network/,
  );
});

it('freezes an encrypted local result atomically and resumes those exact bytes after restart', async () => {
  const request = encryptionRequest();
  const first = encryptedResult(1);
  const [saved, repeated] = await Promise.all([
    saveDelegatedEncryptionResult(request, user, 1, first),
    saveDelegatedEncryptionResult(request, user, 1, encryptedResult(2)),
  ]);
  expect(saved.responseDetail.toBuffer()).toEqual(
    first.responseDetail.toBuffer(),
  );
  expect(repeated.responseDetail.toBuffer()).toEqual(
    first.responseDetail.toBuffer(),
  );
  let restarted;
  let restartedRequest;
  jest.isolateModules(() => {
    restarted = require('../../appAuthorization/delegatedOperations');
    const {
      GenericRequest: RestartedRequest,
    } = require('verus-typescript-primitives');
    restartedRequest = new RestartedRequest();
    restartedRequest.fromBuffer(request.toBuffer());
  });
  mockState.deeplink.requestId++;
  const restored = await restarted.loadDelegatedEncryptionResult(
    restartedRequest,
    user,
    1,
  );
  expect(restored.responseDetail.toBuffer()).toEqual(
    saved.responseDetail.toBuffer(),
  );
  await expect(
    restarted.reserveDelegatedExecution(restartedRequest, user, 'response'),
  ).resolves.toBeDefined();
});

it('rejects an encryption step without its atomically saved result', async () => {
  const request = encryptionRequest();
  await reserveDelegatedExecution(request, user, 'app-encryption:1');
  const recorded = JSON.stringify(mockData);
  await expect(loadDelegatedEncryptionResult(request, user, 1)).rejects.toThrow(
    'Invalid saved encryption response',
  );
  await expect(
    saveDelegatedEncryptionResult(request, user, 1, encryptedResult()),
  ).rejects.toThrow('Invalid saved encryption response');
  expect(JSON.stringify(mockData)).toBe(recorded);
});

it('serializes a saved-result lookup with response reservation and blocks later reuse', async () => {
  const request = encryptionRequest();
  await saveDelegatedEncryptionResult(request, user, 1, encryptedResult());
  let releaseRead;
  mockReadData.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseRead = () => resolve(mockData);
      }),
  );
  const reading = loadDelegatedEncryptionResult(request, user, 1);
  await Promise.resolve();
  const reserving = reserveDelegatedExecution(request, user, 'response');
  expect(
    Object.values(mockData.delegatedOperations.operations)[0].steps.response,
  ).toBeUndefined();
  releaseRead();
  await reading;
  await reserving;
  await expect(loadDelegatedEncryptionResult(request, user, 1)).rejects.toThrow(
    'other recorded effects',
  );
  await expect(
    reserveDelegatedExecution(request, user, 'response'),
  ).rejects.toThrow('already been executed');
});

it.each(['mixed request', 'payment receipt', 'unfinished signing'])(
  'does not reopen a consumed encryption step alongside %s',
  async reason => {
    const request = encryptionRequest();
    if (reason === 'mixed request')
      request.details.push(new DataPacketRequestOrdinalVDXFObject());
    await reserveDelegatedExecution(request, user, 'app-encryption:1');
    if (reason === 'payment receipt') {
      const operation = await reserveDelegatedExecution(
        request,
        user,
        'payment',
      );
      await recordDelegatedTransaction(operation, 'payment', {txid: 'unknown'});
    }
    if (reason === 'unfinished signing')
      await reserveDelegatedExecution(request, user, 'response');
    await expect(
      loadDelegatedEncryptionResult(request, user, 1),
    ).rejects.toThrow('other recorded effects');
    await expect(
      saveDelegatedEncryptionResult(request, user, 1, encryptedResult()),
    ).rejects.toThrow('other recorded effects');
  },
);

it('binds saved encryption to the selected U, derivation and spending-key permission', async () => {
  const request = encryptionRequest();
  await saveDelegatedEncryptionResult(request, user, 1, encryptedResult());
  await expect(
    loadDelegatedEncryptionResult(
      request,
      {...user, identityID: toIAddress('other', 'VRSC')},
      1,
    ),
  ).rejects.toThrow('another operation or user');
  request.details[1].data.derivationNumber = new BigNumber(1);
  await expect(
    loadDelegatedEncryptionResult(request, user, 1),
  ).resolves.toBeNull();
  request.details[1].data.derivationNumber = new BigNumber(0);
  request.details[1].data.flags = AppEncryptionRequestDetails.FLAG_RETURN_ESK;
  await expect(
    loadDelegatedEncryptionResult(request, user, 1),
  ).resolves.toBeNull();
});

it('releases an unexecuted signing reservation after a failed final check and permits retry', async () => {
  const request = makeRequest();
  const operation = await reserveDelegatedExecution(request, user, 'response');
  await releaseDelegatedSigningReservation(operation, 'response');
  await expect(
    reserveDelegatedExecution(request, user, 'response'),
  ).resolves.toBeDefined();
});

it.each(['receipt', 'resultHex', 'responseHex'])(
  'never releases a reservation with recorded %s',
  async field => {
    const request = makeRequest();
    const operation = await reserveDelegatedExecution(
      request,
      user,
      'response',
    );
    const saved = mockData.delegatedOperations.operations[operation.id];
    if (field === 'responseHex') saved.responseHex = '0102';
    else
      saved.steps.response[field] =
        field === 'receipt' ? {txid: '22'.repeat(32)} : '0102';
    await expect(
      releaseDelegatedSigningReservation(operation, 'response'),
    ).rejects.toThrow(/cannot be released/);
    expect(saved.steps.response).toBeDefined();
  },
);
