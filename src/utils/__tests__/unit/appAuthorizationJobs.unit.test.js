let mockData;
let mockState;
const mockDispatch = jest.fn();
const mockReconcile = jest.fn();
let mockQueue;

jest.mock('../../../store', () => ({
  getState: () => mockState,
  dispatch: mockDispatch,
}));
jest.mock('../../auth/authBox', () => ({
  requestServiceStoredData: async () => JSON.parse(JSON.stringify(mockData)),
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
jest.mock('../../appAuthorization/workflow', () => ({
  reconcileAuthorizationJob: (...args) => mockReconcile(...args),
}));

const {
  createAuthorizationJob,
  findAuthorizationJob,
  getAuthorizationJob,
  updateAuthorizationJob,
  requestFromAuthorizationJob,
  captureAuthorizationContext,
  withAuthorizationJob,
  refreshAuthorizationJobs,
} = require('../../appAuthorization/jobs');
const {
  authorizationNotifications,
} = require('../../appAuthorization/notifications');
const {createAppAuthorizationRequest} = require('verusid-ts-client');
const {
  BigNumber,
  I_ADDR_VERSION,
  SpendableKeyDetails,
  SaplingPaymentAddress,
  toBase58Check,
} = require('verus-typescript-primitives');
const address = marker =>
  toBase58Check(Buffer.alloc(20, marker), I_ADDR_VERSION);
const request = () => {
  const value = createAppAuthorizationRequest({
    appID: address(1),
    delegate: {identityID: address(2), systemID: address(3)},
    requestID: address(4),
    encryptResponseToAddress: new SaplingPaymentAddress({
      d: Buffer.alloc(11, 1),
      pkD: Buffer.alloc(32, 2),
    }),
    gift: new SpendableKeyDetails({
      data: Buffer.alloc(32, 19),
      seedFormat: SpendableKeyDetails.SEED_FORMAT_BIP39,
      encryptionFormat: SpendableKeyDetails.ENCRYPTION_FORMAT_NONE,
    }),
  });
  value.signature.signatureAsVch = Buffer.from('structural fixture signature');
  return value;
};

beforeEach(() => {
  mockData = {unrelated: {keep: true}};
  mockQueue = Promise.resolve();
  mockState = {
    authentication: {
      signedIn: true,
      activeAccount: {accountHash: 'alice', testnetOverrides: {}},
      sessionEpoch: 1,
    },
  };
  mockDispatch.mockClear();
  mockReconcile.mockReset().mockResolvedValue(undefined);
});

it('retains exact request and nested gift only in protected storage, with safe resumable notifications', async () => {
  const original = request();
  const job = await createAuthorizationJob(original);
  const restored = await getAuthorizationJob(job.id);
  expect(requestFromAuthorizationJob(restored).toBuffer()).toEqual(
    original.toBuffer(),
  );
  const summaries = mockDispatch.mock.calls.at(-1)[0].payload.authorizationJobs;
  expect(JSON.stringify(summaries)).not.toContain(
    original.toBuffer().toString('hex'),
  );
  expect(Object.keys(summaries[job.id])).not.toContain('requestHex');
  const notices = authorizationNotifications(summaries, 'alice');
  expect(notices).toHaveLength(1);
  const navigate = jest.fn();
  notices[0].onAction({navigation: {navigate}});
  expect(navigate).toHaveBeenCalledWith('DeepLink', {
    screen: 'AppAuthorizationRequestInfo',
    params: {jobId: job.id},
  });
  expect(authorizationNotifications(summaries, 'bob')).toEqual([]);
  expect(mockData.unrelated).toEqual({keep: true});
});

it('reserves one operation across concurrent copies and changed signature encodings', async () => {
  const original = request();
  const copy = requestFromAuthorizationJob(
    await createAuthorizationJob(original),
  );
  copy.signature.signatureAsVch = Buffer.from('a different signature encoding');
  const jobs = await Promise.all([
    createAuthorizationJob(copy),
    createAuthorizationJob(original),
  ]);
  expect(jobs[0].id).toBe(jobs[1].id);
  expect(Object.keys(mockData.authorizationJobs.jobs)).toHaveLength(1);
  expect(jobs[0].requestHex).toBe(original.toBuffer().toString('hex'));
});

it('resumes an admitted operation after expiry without admitting a fresh expired one', async () => {
  const original = request();
  const job = await createAuthorizationJob(original);
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValue((job.expiryTime + 1) * 1000);
  try {
    expect((await findAuthorizationJob(original)).id).toBe(job.id);
    expect((await createAuthorizationJob(original)).id).toBe(job.id);
    const fresh = request();
    fresh.details[0].data.expiryTime = new BigNumber(1);
    await expect(createAuthorizationJob(fresh)).rejects.toThrow();
    expect(Object.keys(mockData.authorizationJobs.jobs)).toHaveLength(1);
  } finally {
    now.mockRestore();
  }
});

it('retains prepared responses and rejects request replacement or stale revisions', async () => {
  const job = await createAuthorizationJob(request());
  await updateAuthorizationJob(job.id, {
    responseHex: 'aabb',
    transactions: {grant: {rawTx: 'secret'}},
  });
  await expect(
    updateAuthorizationJob(job.id, {responseHex: 'ccdd'}),
  ).rejects.toThrow('cannot be changed');
  await expect(
    updateAuthorizationJob(job.id, {requestHex: '00'}),
  ).rejects.toThrow('cannot be replaced');
  await expect(
    updateAuthorizationJob(job.id, {revision: job.revision}),
  ).rejects.toThrow('changed');
  expect(JSON.stringify(mockDispatch.mock.calls)).not.toContain('secret');
});

it('preserves the revision and skips publishing an unchanged job', async () => {
  const job = await createAuthorizationJob(request());
  mockDispatch.mockClear();

  const repeated = await updateAuthorizationJob(job.id, {status: job.status});

  expect(repeated).toEqual(job);
  expect(mockDispatch).not.toHaveBeenCalled();
});

it('invalidates outstanding work on profile, session, or network changes', async () => {
  const job = await createAuthorizationJob(request());
  const context = captureAuthorizationContext();
  mockState.authentication.sessionEpoch++;
  await expect(getAuthorizationJob(job.id, context)).rejects.toMatchObject({
    code: 'SESSION_CHANGED',
  });
});

it('shares one operation lock across gift, grant and delivery work', async () => {
  const context = captureAuthorizationContext();
  let finish;
  const first = withAuthorizationJob(
    'job',
    context,
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await expect(withAuthorizationJob('job', context, () => {})).rejects.toThrow(
    'already',
  );
  finish();
  await first;
  await expect(
    withAuthorizationJob('job', context, () => 'ready'),
  ).resolves.toBe('ready');
});

it.each(['cancelled', 'complete'])(
  'reconciles %s jobs until the single transaction gift is recovered',
  async status => {
    mockState.authentication.sessionEpoch = status === 'cancelled' ? 10 : 20;
    const job = await createAuthorizationJob(request());
    await updateAuthorizationJob(job.id, {
      status,
      authorizationPlan: {giftIdentityIDs: ['gifted-user']},
      transactions: {grant: {rawTx: 'protected authorization receipt'}},
    });
    await refreshAuthorizationJobs();
    expect(mockReconcile).toHaveBeenCalledWith(job.id, expect.any(Object));
    const summaries =
      mockDispatch.mock.calls.at(-1)[0].payload.authorizationJobs;
    expect(summaries[job.id].giftRecoveryPending).toBe(true);
    expect(authorizationNotifications(summaries, 'alice')).toHaveLength(1);
    expect(JSON.stringify(mockDispatch.mock.calls)).not.toContain(
      'protected authorization receipt',
    );
    await updateAuthorizationJob(job.id, {giftConfirmed: true});
    mockReconcile.mockClear();
    mockState.authentication.sessionEpoch++;
    await refreshAuthorizationJobs();
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(
      authorizationNotifications(
        mockDispatch.mock.calls.at(-1)[0].payload.authorizationJobs,
        'alice',
      ),
    ).toEqual([]);
  },
);

it('reconciles cancelled nongift storage until its confirmed classification is saved', async () => {
  mockState.authentication.sessionEpoch = 40;
  const job = await createAuthorizationJob(request());
  await updateAuthorizationJob(job.id, {
    status: 'cancelled',
    hasGift: false,
    authorizationPlan: {giftIdentityIDs: []},
    transactions: {grant: {rawTx: 'protected receipt'}},
    storageBindings: [{storageID: 'shared storage'}],
  });
  await refreshAuthorizationJobs();
  expect(mockReconcile).toHaveBeenCalledWith(job.id, expect.any(Object));
  await updateAuthorizationJob(job.id, {storageIdentitiesManaged: true});
  mockReconcile.mockClear();
  mockState.authentication.sessionEpoch++;
  await refreshAuthorizationJobs();
  expect(mockReconcile).not.toHaveBeenCalled();
});

it('freezes the encrypted channel artifact without publishing it in summaries', async () => {
  const job = await createAuthorizationJob(request());
  const artifact = {
    user: 'bound-user',
    requestHash: 'bound-request',
    descriptor: {objectdata: 'protected-channel'},
  };
  await updateAuthorizationJob(job.id, {appEncryptionResponse: artifact});
  await expect(
    updateAuthorizationJob(job.id, {
      appEncryptionResponse: {...artifact, user: 'other-user'},
    }),
  ).rejects.toThrow('encryption result cannot be changed');
  await expect(
    updateAuthorizationJob(job.id, {appEncryptionResponse: null}),
  ).rejects.toThrow('encryption result cannot be changed');
  const summaries = mockDispatch.mock.calls.at(-1)[0].payload.authorizationJobs;
  expect(JSON.stringify(summaries)).not.toContain('protected-channel');
});

it('skips a prepared response during refresh while publishing its pending notification', async () => {
  mockState.authentication.sessionEpoch = 50;
  const job = await createAuthorizationJob(request());
  await updateAuthorizationJob(job.id, {
    status: 'response_ready',
    responseHex: 'aabb',
    giftConfirmed: true,
  });

  await refreshAuthorizationJobs();
  expect(mockReconcile).not.toHaveBeenCalled();
  const summaries = mockDispatch.mock.calls.at(-1)[0].payload.authorizationJobs;
  expect(authorizationNotifications(summaries, 'alice')).toHaveLength(1);
});

it('does not reconcile an actively edited job or throttle its next idle refresh', async () => {
  mockState.authentication.sessionEpoch = 60;
  const context = captureAuthorizationContext();
  const job = await createAuthorizationJob(request(), context);
  await withAuthorizationJob(job.id, context, async () => {
    await refreshAuthorizationJobs(context);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  await refreshAuthorizationJobs(context);
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(mockReconcile).toHaveBeenCalledWith(job.id, expect.any(Object));
});
