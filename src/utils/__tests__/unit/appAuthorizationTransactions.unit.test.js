let mockJob;
const mockState = {authentication: {activeAccount: {accountHash: 'alice'}}};
const mockScope = {sessionScope: {accountHash: 'alice'}};
const mockCreateUpdate = jest.fn();
const mockCreateBatch = jest.fn();
const mockGiftFunding = jest.fn();
const mockSpendable = jest.fn();
const mockSign = jest.fn();
const mockOpenKeys = jest.fn();
const mockRequestPrivateKey = jest.fn();
const mockWalletKeys = jest.fn();
const mockConfirmFees = jest.fn();
const mockVerifiedFees = jest.fn();
const mockIdentity = {clearContentMultiMap: jest.fn()};

jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../appAuthorization/jobs', () => ({
  captureAuthorizationContext: options => options || mockScope,
  assertAuthorizationContext: jest.fn(),
  getAuthorizationJob: async () => mockJob,
  updateAuthorizationJob: async (_id, update) => {
    mockJob =
      typeof update === 'function' ? update(mockJob) : {...mockJob, ...update};
    return mockJob;
  },
}));
jest.mock('../../api/channels/verusid/requests/getIdentity', () => ({
  getIdentity: async () => ({result: {blockheight: 10}}),
}));
jest.mock('../../api/channels/verusid/requests/updateIdentity', () => ({
  getUpdatableIdentity: async () => ({tx: 'old-id-tx', identity: mockIdentity}),
  createUpdateIdentityTxWithUtxos: (...args) => mockCreateUpdate(...args),
}));
jest.mock('../../api/channels/vrpc/requests/getAddressUtxos', () => ({
  getSpendableUtxos: (...args) => mockSpendable(...args),
}));
jest.mock('../../api/channels/vrpc/callCreators', () => ({
  getTransaction: jest.fn(),
  getBlock: jest.fn(),
}));
jest.mock('../../identityManagement/identityDefinition', () => ({
  buildModifiedIdentity: () => mockIdentity,
}));
jest.mock('../../identityUpdate/verifiedSubmission', () => ({
  captureIdentityUpdateContext: options => options,
  submitReviewedIdentityUpdate: (...args) => mockSign(...args),
}));
jest.mock('../../spendableKey/durableBroadcast', () => ({
  broadcastPendingTransactions: jest.fn(),
  createPendingBroadcast: options => options,
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    getBasicCoinObj: () => ({
      id: 'VRSC',
      system_id: 'chain',
      vrpc_endpoints: ['rpc'],
      bitgojs_network_key: 'verus',
    }),
  },
}));
jest.mock('../../vrpc/vrpcInterface', () => ({
  initEndpoint: jest.fn(),
  getVerusIdInterface: () => ({
    createUpdateIdentitiesTransaction: (...args) => mockCreateBatch(...args),
  }),
}));
jest.mock('../../auth/authBox', () => ({
  requestPrivKey: (...args) => mockRequestPrivateKey(...args),
}));
jest.mock('../../spendableKey/reviewFees', () => ({
  confirmVerifiedClaimFees: (...args) => mockConfirmFees(...args),
  verifiedClaimFees: (...args) => mockVerifiedFees(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  walletAuthorizationKeys: (...args) => mockWalletKeys(...args),
  withIndependentIdentitySigningKeys: (...args) => mockOpenKeys(...args),
}));
jest.mock('../../appAuthorization/funding', () => ({
  prepareAuthorizationGiftFunding: (...args) => mockGiftFunding(...args),
}));

const {ECPair, TransactionBuilder, networks} = require('@bitgo/utxo-lib');
const {normalizeIdentityKeyID} = require('verusid-ts-client');
const {
  confirmAuthorizationFees,
  submitAuthorizationIdentityUpdate,
} = require('../../appAuthorization/transactions');
const userKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 1),
  networks.verus,
);
const storageKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 2),
  networks.verus,
);
const authorityKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 3),
  networks.verus,
);
const storageKeyID = normalizeIdentityKeyID(storageKey.getPublicKeyBuffer());
const tx = new TransactionBuilder(networks.verus);
tx.setVersion(4);
tx.setVersionGroupId(0x892f2085);
tx.setExpiryHeight(100);
tx.addInput(Buffer.alloc(32, 9), 0);
tx.addOutput(userKey.getAddress(), 10000);
const rawTx = tx.buildIncomplete().toHex();
const txid = tx.buildIncomplete().getId();
const user = {identityID: 'user', systemID: 'chain'};

beforeEach(() => {
  jest.clearAllMocks();
  mockJob = {
    id: 'job',
    selectedIdentity: user,
  };
  mockWalletKeys.mockReturnValue([
    {
      keyID: storageKeyID,
      coin: {id: 'VRSC', bitgojs_network_key: 'verus'},
      channel: 'vrpc',
    },
  ]);
  mockRequestPrivateKey.mockResolvedValue(storageKey.toWIF());
  mockOpenKeys.mockImplementation(async (identity, _context, callback) =>
    callback(identity.identityID === 'authority' ? authorityKey : userKey),
  );
  mockSpendable.mockResolvedValue([{txid: 'funds', outputIndex: 0}]);
  mockCreateUpdate.mockResolvedValue({
    hex: rawTx,
    utxos: [{txid: 'funds', outputIndex: 0}],
    fundingApproval: {nativeFee: '10000'},
  });
  mockCreateBatch.mockImplementation(async () => ({
    hex: rawTx,
    utxos: [
      {txid: 'user-id', outputIndex: 0},
      {txid: 'storage-id', outputIndex: 0},
      {txid: 'donor-funding', outputIndex: 0},
    ],
    fundingApproval: {
      nativeFee: '10000',
      identities: [{identityAddress: 'user'}, {identityAddress: 'storage'}],
    },
  }));
  mockConfirmFees.mockResolvedValue(true);
  mockGiftFunding.mockReturnValue({
    changeAddress: 'storage',
    nativeFee: '10000',
    allocatedAtomic: '10000',
    currencyTransferOutputs: [{address: 'user-reserve'}, {address: 'storage-funds'}],
    allocation: {
      currency: 'chain',
      reserve: {identityID: 'user', atomic: '2500', coins: '0.000025'},
      storage: [{identityID: 'storage', atomic: '7500', coins: '0.000075'}],
    },
  });
  mockVerifiedFees.mockReturnValue([
    {currency: 'chain', atomic: '10000', coins: '0.0001'},
  ]);
  require('../../appAuthorization/jobs')
    .assertAuthorizationContext.mockReset()
    .mockImplementation(context => context.assertActive?.());
  mockSign.mockImplementation(async options => {
    await options.getKeys();
    await options.persistSignedTransaction({
      rawTx,
      txid,
      systemId: 'chain',
      inputs: options.built.utxos,
      fundingApproval: options.built.fundingApproval,
    });
    await options.beforeSend();
    return {txid};
  });
});

test('funds access removal from current wallet and selected identity addresses with distinct authority keys', async () => {
  const beforeSend = jest.fn(async () => {
    expect(mockJob.transactions.storage.broadcastAttempted).toBe(true);
  });
  const receipt = await submitAuthorizationIdentityUpdate('job', {
    identityID: 'storage',
    systemID: 'chain',
    receiptKey: 'storage',
    signingIdentity: user,
    signingIdentities: [{identityID: 'authority', systemID: 'chain'}],
    signingKeyIDs: [storageKeyID],
    beforeSend,
  });
  expect(mockSpendable).toHaveBeenCalledWith(
    'chain',
    'chain',
    expect.arrayContaining([
      'user',
      'storage',
      userKey.getAddress(),
      storageKey.getAddress(),
      authorityKey.getAddress(),
    ]),
  );
  expect(mockCreateUpdate).toHaveBeenCalledWith(
    expect.objectContaining({utxos: [{txid: 'funds', outputIndex: 0}]}),
  );
  expect(mockRequestPrivateKey).toHaveBeenCalledWith('VRSC', 'vrpc', mockScope);
  expect(mockConfirmFees).toHaveBeenCalled();
  expect(receipt).toMatchObject({
    txid,
    rawTx,
    status: 'submitted',
    broadcastAttempted: true,
  });
  expect(beforeSend).toHaveBeenCalledTimes(1);
});

test('persists the complete approval with its signed receipt after fee consent and before handoff', async () => {
  const plan = {updates: [{identityID: user.identityID}]};
  mockConfirmFees.mockImplementationOnce(async () => {
    expect(mockJob.authorizationPlan).toBeUndefined();
    expect(mockJob.transactions).toBeUndefined();
    return true;
  });
  const beforeSend = jest.fn(async () => {
    expect(mockJob).toMatchObject({
      approved: true,
      authorizationPlan: plan,
      transactions: {
        grant: {txid, status: 'prepared', broadcastAttempted: true},
      },
    });
  });

  await submitAuthorizationIdentityUpdate('job', {
    ...user,
    receiptKey: 'grant',
    jobChanges: {approved: true, authorizationPlan: plan},
    beforeSend,
  });

  expect(beforeSend).toHaveBeenCalledTimes(1);
  expect(mockJob.status).toBe('waiting_for_grant_confirmation');
  expect(mockJob.grantTransaction).toEqual(mockJob.transactions.grant);
  expect(mockJob.grantTransaction.status).toBe('submitted');
});

test('rejects a mismatched storage private key before preparing or signing', async () => {
  mockRequestPrivateKey.mockResolvedValue(authorityKey.toWIF());
  await expect(
    submitAuthorizationIdentityUpdate('job', {
      identityID: 'storage',
      systemID: 'chain',
      receiptKey: 'storage',
      signingIdentity: user,
      signingKeyIDs: [storageKeyID],
    }),
  ).rejects.toThrow('does not match');
  expect(mockCreateUpdate).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
});

test('does not sign or persist a transaction when verified fees are declined', async () => {
  mockConfirmFees.mockResolvedValue(false);
  await expect(
    submitAuthorizationIdentityUpdate('job', {...user, receiptKey: 'grant'}),
  ).rejects.toThrow('cancelled before signing');
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockJob.transactions).toBeUndefined();
});

test('shows only verified fees before signing through the screen callback', async () => {
  const confirmFees = jest.fn(async summary => {
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockJob.transactions).toBeUndefined();
    expect(summary).toEqual({
      type: 'removal',
      identityID: 'user',
      systemID: 'chain',
      transactionCount: 1,
      fees: [
        {currency: 'chain', atomic: '10000', coins: '0.0001', ticker: 'VRSC'},
      ],
    });
    return true;
  });

  await submitAuthorizationIdentityUpdate(
    'job',
    {...user, receiptKey: 'grant'},
    {...mockScope, confirmFees},
  );
  expect(confirmFees).toHaveBeenCalledTimes(1);
  expect(mockVerifiedFees).toHaveBeenCalledTimes(1);
  expect(mockConfirmFees).not.toHaveBeenCalled();
  expect(mockSign).toHaveBeenCalledTimes(1);
});

test('gift splits funds between user and storage in one reviewed batch', async () => {
  const fundingUtxos = [{txid: 'donor-funding', outputIndex: 0}];
  const confirmFees = jest.fn(async summary => {
    expect(summary).toMatchObject({
      type: 'authorization',
      transactionCount: 1,
      paidFromGift: true,
      giftAllocation: mockGiftFunding().allocation,
    });
    expect(mockSign).not.toHaveBeenCalled();
    return true;
  });
  await submitAuthorizationIdentityUpdate(
    'job',
    {
      ...user,
      receiptKey: 'grant',
      updates: [{identityID: 'user'}, {identityID: 'storage'}],
      signingIdentities: [],
      donorKeys: [authorityKey.toWIF()],
      fundingUtxos,
      giftFunding: {userIdentityID: 'user', storageIdentities: []},
      sweepFunding: true,
    },
    {...mockScope, confirmFees},
  );
  expect(mockCreateBatch).toHaveBeenCalledWith(
    [
      {
        identity: mockIdentity,
        rawIdentityTransaction: 'old-id-tx',
        identityTransactionHeight: 10,
      },
      {
        identity: mockIdentity,
        rawIdentityTransaction: 'old-id-tx',
        identityTransactionHeight: 10,
      },
    ],
    'storage',
    fundingUtxos,
    expect.objectContaining({
      useAllFundingInputs: true,
      nativeFee: '10000',
      currencyTransferOutputs: mockGiftFunding().currencyTransferOutputs,
    }),
  );
  expect(mockCreateUpdate).not.toHaveBeenCalled();
  expect(mockSpendable).not.toHaveBeenCalled();
  expect(mockOpenKeys).not.toHaveBeenCalled();
  expect(mockSign).toHaveBeenCalledTimes(1);
  expect(mockJob.transactions.grant).toMatchObject({
    rawTx,
    txid,
    status: 'submitted',
    broadcastAttempted: true,
  });
});

test('combined storage and approval removal presents one removal fee review', async () => {
  const confirmFees = jest.fn(async summary => {
    expect(summary).toMatchObject({
      type: 'removal',
      transactionCount: 1,
    });
    expect(summary.paidFromGift).not.toBe(true);
    return true;
  });
  await submitAuthorizationIdentityUpdate(
    'job',
    {
      ...user,
      updates: [{identityID: 'storage'}, {identityID: 'user'}],
      signingIdentities: [user],
      signingKeyIDs: [normalizeIdentityKeyID(storageKey.getPublicKeyBuffer())],
      feeType: 'removal',
      receiptKey: 'storage-management',
    },
    {...mockScope, confirmFees},
  );
  expect(confirmFees).toHaveBeenCalledTimes(1);
  expect(mockCreateBatch).toHaveBeenCalledTimes(1);
  expect(mockSign).toHaveBeenCalledTimes(1);
  expect(mockJob.transactions['storage-management']).toMatchObject({
    rawTx,
    txid,
    status: 'submitted',
  });
});

test('authorization retry reuses its saved bytes and never reconstructs or reopens donor keys', async () => {
  mockJob.transactions = {
    grant: {
      rawTx,
      txid,
      systemId: 'chain',
      status: 'prepared',
      fundingApproval: {
        identities: [{identityAddress: 'user'}, {identityAddress: 'storage'}],
      },
    },
  };
  require('../../api/channels/vrpc/callCreators').getTransaction.mockResolvedValue(
    {result: {confirmations: 0}},
  );
  const {
    broadcastPendingTransactions,
  } = require('../../spendableKey/durableBroadcast');
  broadcastPendingTransactions.mockImplementationOnce(async options => {
    expect(options.pendingBroadcast.transactions[0].rawTx).toBe(rawTx);
    await options.beforeSend();
  });
  const beforeSend = jest.fn();
  await submitAuthorizationIdentityUpdate('job', {
    ...user,
    receiptKey: 'grant',
    beforeSend,
  });
  expect(beforeSend).toHaveBeenCalledTimes(1);
  expect(mockCreateBatch).not.toHaveBeenCalled();
  expect(mockCreateUpdate).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockOpenKeys).not.toHaveBeenCalled();
});

test('declining the screen fee review leaves the unsigned job resumable', async () => {
  await expect(
    submitAuthorizationIdentityUpdate(
      'job',
      {...user, receiptKey: 'grant'},
      {...mockScope, confirmFees: async () => false},
    ),
  ).rejects.toMatchObject({code: 'AUTHORIZATION_FEES_DECLINED'});
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockJob.transactions).toBeUndefined();
});

test('unverified fees never reach the screen or the signer', async () => {
  const confirmFees = jest.fn();
  mockVerifiedFees.mockImplementationOnce(() => {
    throw new Error('The claim fee has not been verified.');
  });
  await expect(
    submitAuthorizationIdentityUpdate(
      'job',
      {...user, receiptKey: 'grant'},
      {...mockScope, confirmFees},
    ),
  ).rejects.toThrow('not been verified');
  expect(confirmFees).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
});

test('leaving the screen during fee review prevents signing', async () => {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error('Authorization screen closed');
  };
  await expect(
    submitAuthorizationIdentityUpdate(
      'job',
      {...user, receiptKey: 'grant'},
      {
        ...mockScope,
        assertActive,
        confirmFees: async () => {
          active = false;
          return true;
        },
      },
    ),
  ).rejects.toThrow('Authorization screen closed');
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockJob.transactions).toBeUndefined();
});

test('retry acknowledgement preserves the original admitted handoff time', async () => {
  const {getTransaction} = require('../../api/channels/vrpc/callCreators');
  const {
    broadcastPendingTransactions,
  } = require('../../spendableKey/durableBroadcast');
  const admittedAt = 100;
  mockJob.transactions = {
    grant: {
      rawTx,
      txid,
      systemId: 'chain',
      broadcastAttempted: true,
      admittedAt,
      status: 'prepared',
    },
  };
  getTransaction.mockResolvedValue({result: {confirmations: 0}});
  broadcastPendingTransactions.mockImplementationOnce(async options => {
    await options.persistPendingBroadcast({
      transactions: [
        {
          ...mockJob.transactions.grant,
          status: 'submitted',
          submittedAt: Date.now(),
        },
      ],
    });
  });
  const receipt = await submitAuthorizationIdentityUpdate('job', {
    ...user,
    receiptKey: 'grant',
  });
  expect(receipt.admittedAt).toBe(admittedAt);
  expect(receipt.submittedAt).toBeGreaterThan(admittedAt);
  expect(mockOpenKeys).not.toHaveBeenCalled();
  expect(mockCreateUpdate).not.toHaveBeenCalled();
});

test.each([1.5, '1', undefined])(
  'does not accept non-integer confirmation evidence: %s',
  async confirmations => {
    const {
      getTransaction,
      getBlock,
    } = require('../../api/channels/vrpc/callCreators');
    const {
      confirmAuthorizationTransaction,
    } = require('../../appAuthorization/transactions');
    getTransaction.mockResolvedValue({
      result: {confirmations, txid, hex: rawTx, blockhash: 'block'},
    });
    expect(
      await confirmAuthorizationTransaction({rawTx, txid, systemId: 'chain'}),
    ).toBe(false);
    expect(getBlock).not.toHaveBeenCalled();
  },
);

test('the fallback fee prompt includes both gift destinations and amounts', async () => {
  await confirmAuthorizationFees([], {
    paidFromGift: true,
    giftAllocation: mockGiftFunding().allocation,
  }, mockScope);

  expect(mockConfirmFees).toHaveBeenCalledWith(
    {transactions: []},
    expect.any(Function),
    expect.objectContaining({
      description: expect.stringContaining('0.000025 VRSC reserved at user'),
    }),
  );
  expect(mockConfirmFees.mock.calls[0][2].description)
    .toContain('0.000075 VRSC to storage');
});

test.each([
  {allocatedAtomic: '9999'},
  {allocatedAtomic: '10001'},
  {nativeFee: '10001'},
])('rejects a changed verified gift balance or fee before consent: %j', async changed => {
  mockGiftFunding.mockReturnValue({...mockGiftFunding(), ...changed});
  const confirmFees = jest.fn(async () => true);

  await expect(submitAuthorizationIdentityUpdate(
    'job',
    {
      ...user,
      updates: [{identityID: 'user'}, {identityID: 'storage'}],
      signingIdentities: [],
      donorKeys: [authorityKey.toWIF()],
      fundingUtxos: [{txid: 'donor-funding', outputIndex: 0}],
      giftFunding: {userIdentityID: 'user', storageIdentities: []},
      sweepFunding: true,
      receiptKey: 'grant',
    },
    {...mockScope, confirmFees},
  )).rejects.toThrow('verified gift balance changed');

  expect(confirmFees).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockJob.transactions).toBeUndefined();
});

test('access-removal change returns to the user identity', async () => {
  await submitAuthorizationIdentityUpdate('job', {...user, receiptKey: 'remove-grants'});

  expect(mockCreateUpdate).toHaveBeenCalledWith(expect.objectContaining({
    changeAaddr: user.identityID,
  }));
  expect(mockSpendable).toHaveBeenCalledWith(
    'chain', 'chain', expect.arrayContaining([user.identityID]),
  );
});

test('does not accept a mined transaction in a replaced active-chain block', async () => {
  const {
    getTransaction,
    getBlock,
  } = require('../../api/channels/vrpc/callCreators');
  const {
    confirmAuthorizationTransaction,
  } = require('../../appAuthorization/transactions');
  getTransaction.mockResolvedValue({
    result: {confirmations: 1, txid, hex: rawTx, blockhash: 'old-block'},
  });
  getBlock
    .mockResolvedValueOnce({
      result: {hash: 'old-block', height: 10, confirmations: 1, tx: [txid]},
    })
    .mockResolvedValueOnce({
      result: {hash: 'replacement-block', height: 10, confirmations: 1},
    });
  expect(
    await confirmAuthorizationTransaction({rawTx, txid, systemId: 'chain'}),
  ).toBe(false);
});
