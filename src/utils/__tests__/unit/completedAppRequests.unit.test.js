import {AUTHORIZATION_STATUS} from '../../appAuthorization/constants';
import {
  compactCompletedAuthorizationJob,
  compactCompletedDelegatedOperation,
} from '../../appAuthorization/completedRequests';

const receipt = () => ({
  systemId: 'test-system',
  txid: '11'.repeat(32),
  type: 'identity',
  status: 'submitted',
  broadcastAttempted: true,
  admittedAt: 100,
  submittedAt: 200,
  rawTx: '0102',
  inputs: [{rawTransaction: '0304'}],
  fundingApproval: {txHex: '0506', unfundedTxHex: '0708'},
});

const completedJob = (overrides = {}) => {
  const transaction = receipt();
  return {
    id: 'authorization',
    accountHash: 'profile',
    network: 'testnet',
    revision: 4,
    updatedAt: 300,
    status: AUTHORIZATION_STATUS.COMPLETE,
    requestHex: 'original-request-with-gift',
    responseHex: 'exact-signed-response',
    systemId: 'test-system',
    appId: 'app',
    delegateId: 'delegate',
    grantID: 'grant',
    selectedIdentity: {identityID: 'user', systemID: 'test-system'},
    storageBindings: [{storageID: 'storage', storageSystemID: 'test-system'}],
    hasGift: true,
    giftConfirmed: true,
    grantConfirmed: true,
    userIdentityLinked: true,
    storageIdentitiesManaged: true,
    transactions: {grant: transaction},
    authorizationPlan: {reviewedIdentities: [{identity: {contentmultimap: {}}}]},
    giftDiscovery: {systems: [{claimWif: 'synthetic-gift-key'}]},
    expectedGrant: {g: 'grant'},
    approvedDelegator: {identity: {contentmultimap: {}}},
    appEncryptionResponse: {descriptor: {objectdata: 'encrypted-result'}},
    approvedDelegate: {
      txid: '22'.repeat(32),
      vout: 1,
      blockheight: 50,
      fullyqualifiedname: 'delegate.VRSCTEST@',
      status: 'active',
      identity: {
        primaryaddresses: ['delegate-key'],
        minimumsignatures: 1,
        recoveryauthority: 'delegate',
        contentmultimap: {content: ['large-existing-content']},
      },
    },
    ...overrides,
  };
};

const completedOperation = () => ({
  id: 'delegated-operation',
  user: {identityID: 'user', systemID: 'test-system'},
  createdAt: 100,
  responseHex: 'frozen-response',
  steps: {
    payment: {startedAt: 110, receipt: receipt()},
    'app-encryption:1': {startedAt: 120, resultHex: 'encrypted-result'},
    response: {startedAt: 130},
  },
});

it('releases completed handshake payloads while retaining exact retries and app relationships', () => {
  const job = completedJob();
  const original = JSON.stringify(job);
  const compacted = compactCompletedAuthorizationJob(job);

  for (const field of [
    'authorizationPlan',
    'giftDiscovery',
    'expectedGrant',
    'approvedDelegator',
    'appEncryptionResponse',
  ]) {
    expect(compacted).not.toHaveProperty(field);
  }
  expect(compacted).toMatchObject({
    id: job.id,
    accountHash: job.accountHash,
    network: job.network,
    revision: job.revision,
    updatedAt: job.updatedAt,
    requestHex: job.requestHex,
    responseHex: job.responseHex,
    systemId: job.systemId,
    appId: job.appId,
    delegateId: job.delegateId,
    grantID: job.grantID,
  });
  expect(compacted.selectedIdentity).toBe(job.selectedIdentity);
  expect(compacted.storageBindings).toBe(job.storageBindings);
  expect(compacted.transactions.grant).toEqual({
    systemId: 'test-system',
    txid: '11'.repeat(32),
    type: 'identity',
    status: 'submitted',
    broadcastAttempted: true,
    admittedAt: 100,
    submittedAt: 200,
  });
  expect(compacted.approvedDelegate).toEqual({
    txid: '22'.repeat(32),
    vout: 1,
    blockheight: 50,
    fullyqualifiedname: 'delegate.VRSCTEST@',
    identity: {
      primaryaddresses: ['delegate-key'],
      minimumsignatures: 1,
    },
  });
  expect(JSON.stringify(job)).toBe(original);
  expect(compactCompletedAuthorizationJob(compacted)).toBe(compacted);
});

it('discards completed removal ciphertext but preserves its exact targets and relationships', () => {
  const targets = {
    kind: 'storage-keys',
    appID: 'app',
    grantIDs: ['grant'],
    users: [{identityID: 'user', systemID: 'test-system'}],
    storage: [{storageID: 'storage', storageSystemID: 'test-system'}],
    values: [{outerKey: 'bucket', value: 'large-credential-ciphertext'}],
  };
  const job = completedJob({
    kind: 'removal',
    targets,
    responseHex: undefined,
  });
  const original = JSON.stringify(job);
  const compacted = compactCompletedAuthorizationJob(job);

  expect(compacted.targets).toEqual({
    kind: targets.kind,
    appID: targets.appID,
    grantIDs: targets.grantIDs,
    users: targets.users,
    storage: targets.storage,
  });
  expect(compacted.transactions.grant).not.toHaveProperty('rawTx');
  expect(JSON.stringify(job)).toBe(original);
  expect(compactCompletedAuthorizationJob(compacted)).toBe(compacted);
});

it.each([
  ['unconfirmed grant', {grantConfirmed: false}],
  ['unrecovered gift', {giftConfirmed: false}],
  ['missing frozen response', {responseHex: undefined}],
])('retains every recovery field for a completed marker with %s', (_label, overrides) => {
  const job = completedJob(overrides);
  const original = JSON.stringify(job);
  const compacted = compactCompletedAuthorizationJob(job);
  expect(compacted.transactions).toBe(job.transactions);
  expect(compacted.authorizationPlan).toBe(job.authorizationPlan);
  expect(compacted.giftDiscovery).toBe(job.giftDiscovery);
  expect(compacted.expectedGrant).toBe(job.expectedGrant);
  expect(compacted.approvedDelegator).toBe(job.approvedDelegator);
  expect(compacted.appEncryptionResponse).toBe(job.appEncryptionResponse);
  expect(JSON.stringify(job)).toBe(original);
});

it.each(
  Object.values(AUTHORIZATION_STATUS).filter(
    status =>
      status !== AUTHORIZATION_STATUS.COMPLETE &&
      status !== AUTHORIZATION_STATUS.RESPONSE_READY,
  ),
)('preserves recovery data for %s jobs', status => {
  const job = completedJob({status});
  const compacted = compactCompletedAuthorizationJob(job);
  expect(compacted.status).toBe(status);
  expect(compacted.transactions).toBe(job.transactions);
  expect(compacted.authorizationPlan).toBe(job.authorizationPlan);
  expect(compacted.giftDiscovery).toBe(job.giftDiscovery);
  expect(compacted).toBe(job);
});

it.each([
  [AUTHORIZATION_STATUS.RESPONSE_READY, undefined],
  [AUTHORIZATION_STATUS.COMPLETE, undefined],
  [AUTHORIZATION_STATUS.RESPONSE_READY, false],
])('compacts confirmed %s responses independently of local linking flags (%s)', (status, linked) => {
  const job = completedJob({
    status,
    userIdentityLinked: linked,
    storageIdentitiesManaged: linked,
  });
  const compacted = compactCompletedAuthorizationJob(job);

  expect(compacted.status).toBe(status);
  expect(compacted.userIdentityLinked).toBe(linked);
  expect(compacted.storageIdentitiesManaged).toBe(linked);
  expect(compacted.requestHex).toBe(job.requestHex);
  expect(compacted.responseHex).toBe(job.responseHex);
  expect(compacted.storageBindings).toBe(job.storageBindings);
  expect(compacted.transactions.grant.txid).toBe(job.transactions.grant.txid);
  expect(compacted.transactions.grant).not.toHaveProperty('rawTx');
  expect(compacted.transactions.grant).not.toHaveProperty('fundingApproval');
  expect(compacted).not.toHaveProperty('authorizationPlan');
  expect(compacted).not.toHaveProperty('giftDiscovery');
  expect(compactCompletedAuthorizationJob(compacted)).toBe(compacted);
});

it('does not require gift or storage completion flags when neither was requested', () => {
  const job = completedJob({
    hasGift: false,
    giftConfirmed: undefined,
    storageBindings: [],
    storageIdentitiesManaged: undefined,
  });
  expect(compactCompletedAuthorizationJob(job)).not.toHaveProperty(
    'authorizationPlan',
  );
});

it('keeps delegated replay markers and frozen bytes while removing redundant results', () => {
  const operation = completedOperation();
  const original = JSON.stringify(operation);
  const compacted = compactCompletedDelegatedOperation(operation);

  expect(compacted.id).toBe(operation.id);
  expect(compacted.user).toBe(operation.user);
  expect(compacted.createdAt).toBe(operation.createdAt);
  expect(compacted.responseHex).toBe(operation.responseHex);
  expect(Object.keys(compacted.steps)).toEqual(Object.keys(operation.steps));
  expect(compacted.steps.payment.startedAt).toBe(110);
  expect(compacted.steps.payment.receipt.txid).toBe(receipt().txid);
  expect(compacted.steps.payment.receipt).not.toHaveProperty('rawTx');
  expect(compacted.steps.payment.receipt).not.toHaveProperty('inputs');
  expect(compacted.steps.payment.receipt).not.toHaveProperty('fundingApproval');
  expect(compacted.steps['app-encryption:1']).toEqual({startedAt: 120});
  expect(compacted.steps.response).toBe(operation.steps.response);
  expect(JSON.stringify(operation)).toBe(original);
  expect(compactCompletedDelegatedOperation(compacted)).toBe(compacted);

  const pending = {...operation, responseHex: undefined};
  expect(compactCompletedDelegatedOperation(pending)).toBe(pending);
});
