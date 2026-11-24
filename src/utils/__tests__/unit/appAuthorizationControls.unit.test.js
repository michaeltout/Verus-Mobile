import {Buffer} from 'buffer';
import {ECPair, networks} from '@bitgo/utxo-lib';
import {
  toIAddress,
  IDENTITY_FLAG_TOKENIZED_CONTROL,
  BigNumber,
  AuthorizationStorageBindingCredential,
  DEFAULT_VERUS_CHAINID,
  TESTNET_VERUS_CHAINID,
} from 'verus-typescript-primitives';
import {normalizeIdentityKeyID} from 'verusid-ts-client';
import {
  assertIndependentIdentityControl,
  inspectIndependentIdentityControl,
  assertAuthorizationStorageControl,
  authorizationSource,
  withAuthorizationReadScope,
  withIndependentIdentitySigningKeys,
} from '../../appAuthorization/controls';

let mockState;
let mockIdentities;
let mockRpc;
let mockCoin;
const mockGetIdentity = jest.fn();
const mockGetPrivateKey = jest.fn();
const mockGetInfo = jest.fn();
const mockGetBlock = jest.fn();
const mockReadMany = jest.fn();
jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../auth/authBox', () => ({
  requestPrivKey: (...args) => mockGetPrivateKey(...args),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    getBasicCoinObj: () => mockCoin,
  },
}));
jest.mock('../../vrpc/vrpcInterface', () => ({
  initEndpoint: jest.fn(),
  getVerusIdInterface: () => ({interface: mockRpc}),
}));

const systemID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const identityID = toIAddress('user', 'VRSC');
const authorityID = toIAddress('authority', 'VRSC');
const storageID = toIAddress('storage', 'VRSC');
const user = {systemID, identityID};
const authorityContext = {requireAuthorityControl: true};
const userKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 1),
  networks.verus,
);
const donorKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 2),
  networks.verus,
);
const storageBinding = new AuthorizationStorageBindingCredential({
  version: new BigNumber(1),
  grantID: '22'.repeat(32),
  relationshipIndex: 0,
  storageSystemID: systemID,
  storageID,
});
const delegateKeys = [normalizeIdentityKeyID(donorKey.getAddress())];
const keyRecord = pair => ({
  pubKey: pair.getPublicKeyBuffer().toString('hex'),
  encryptedPrivKey: 'encrypted',
});
const revision = (id, addresses = [userKey.getAddress()]) => ({
  status: 'active',
  blockheight: 10,
  txid: '11'.repeat(32),
  vout: 0,
  identity: {
    version: 3,
    flags: 0,
    identityaddress: id,
    primaryaddresses: addresses,
    minimumsignatures: 1,
    revocationauthority: id,
    recoveryauthority: id,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCoin = {
    id: 'VRSC',
    system_id: DEFAULT_VERUS_CHAINID,
    testnet: false,
    bitgojs_network_key: 'verus',
    vrpc_endpoints: ['https://example.invalid'],
  };
  mockState = {
    authentication: {
      signedIn: true,
      sessionEpoch: 1,
      activeAccount: {
        accountHash: 'profile',
        keys: {VRSC: {vrpc: keyRecord(userKey)}},
      },
    },
  };
  mockIdentities = {
    [identityID]: revision(identityID),
    [authorityID]: revision(authorityID),
    [storageID]: revision(storageID, [
      userKey.getAddress(),
      donorKey.getAddress(),
    ]),
  };
  Object.assign(mockIdentities[storageID].identity, {
    revocationauthority: identityID,
    recoveryauthority: identityID,
  });
  mockGetIdentity.mockImplementation(async id => ({
    result: mockIdentities[id],
  }));
  mockGetPrivateKey.mockResolvedValue(userKey.toWIF());
  mockGetInfo.mockResolvedValue({
    result: {chainid: systemID, blocks: 20, longestchain: 20},
  });
  mockGetBlock.mockResolvedValue({
    result: {hash: '22'.repeat(32), height: 20, confirmations: 1},
  });
  mockReadMany.mockImplementation(requests =>
    Promise.all(
      requests.map(request => {
        const params = request.getParams();
        switch (request.cmd) {
          case 'getidentity':
            return mockGetIdentity(...params);
          case 'getinfo':
            return mockGetInfo(...params);
          case 'getblock':
            return mockGetBlock(...params);
          default:
            throw new Error(`Unexpected authorization read: ${request.cmd}`);
        }
      }),
    ),
  );
  mockRpc = {
    chain: systemID,
    instance: {defaults: {baseURL: 'https://example.invalid'}},
    getIdentity: (...args) => mockGetIdentity(...args),
    getInfo: (...args) => mockGetInfo(...args),
    getBlock: (...args) => mockGetBlock(...args),
    requestMany: (...args) => mockReadMany(...args),
  };
});

it('proves mutually referring user-owned authorities without treating the cycle as donor control', async () => {
  mockIdentities[identityID].identity.recoveryauthority = authorityID;
  mockIdentities[authorityID].identity.recoveryauthority = identityID;
  await expect(
    assertIndependentIdentityControl(user, authorityContext),
  ).resolves.toMatchObject({
    identity: {identityaddress: identityID},
  });
  expect(mockGetPrivateKey).toHaveBeenCalledTimes(1);
});

it('inspects cyclic authority control from public keys without requesting a private key', async () => {
  mockIdentities[identityID].identity.recoveryauthority = authorityID;
  mockIdentities[authorityID].identity.recoveryauthority = identityID;

  await expect(
    inspectIndependentIdentityControl(user, authorityContext),
  ).resolves.toBe(true);
  expect(mockGetPrivateKey).not.toHaveBeenCalled();

  mockIdentities[authorityID] = revision(authorityID, [donorKey.getAddress()]);
  await expect(
    inspectIndependentIdentityControl(user, authorityContext),
  ).resolves.toBe(false);
  expect(mockGetPrivateKey).not.toHaveBeenCalled();
});

it('distinguishes unavailable chain reads from identities requiring recovery', async () => {
  mockIdentities[identityID].status = 'revoked';
  mockIdentities[identityID].identity.flags = 0x8000;
  await expect(
    inspectIndependentIdentityControl(user, authorityContext),
  ).resolves.toBe(false);

  mockGetIdentity.mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(
    inspectIndependentIdentityControl(user, authorityContext),
  ).rejects.toThrow('Network unavailable');
  expect(mockGetPrivateKey).not.toHaveBeenCalled();
});

it.each(['recoveryauthority', 'revocationauthority'])(
  'allows an existing response identity with external %s control',
  async authority => {
    mockIdentities[identityID].identity[authority] = authorityID;
    mockIdentities[authorityID] = revision(authorityID, [
      donorKey.getAddress(),
    ]);
    const sign = jest.fn();

    await expect(
      withIndependentIdentitySigningKeys(user, {}, sign),
    ).resolves.toMatchObject({identity: {identityaddress: identityID}});

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0].getAddress()).toBe(userKey.getAddress());
    expect(mockGetIdentity.mock.calls.every(([id]) => id === identityID)).toBe(
      true,
    );
  },
);

it.each(['recoveryauthority', 'revocationauthority'])(
  'rejects primary-only gift takeover when the donor retains %s before key access',
  async authority => {
    mockIdentities[identityID].identity[authority] = authorityID;
    mockIdentities[authorityID] = revision(authorityID, [
      donorKey.getAddress(),
    ]);

    await expect(
      assertIndependentIdentityControl(user, authorityContext),
    ).rejects.toThrow(/every signing authority/);
    expect(mockGetPrivateKey).not.toHaveBeenCalled();
  },
);

it.each(['pending', 'revoked', 'token control', 'shared', 'unusable key'])(
  'rejects %s user control',
  async condition => {
    if (condition === 'pending') mockIdentities[identityID].blockheight = 0;
    if (condition === 'revoked') {
      mockIdentities[identityID].status = 'revoked';
      mockIdentities[identityID].identity.flags = 0x8000;
    }
    if (condition === 'token control')
      mockIdentities[identityID].identity.flags =
        IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber();
    if (condition === 'shared')
      mockIdentities[identityID].identity.primaryaddresses.push(
        donorKey.getAddress(),
      );
    if (condition === 'unusable key')
      mockGetPrivateKey.mockResolvedValue(donorKey.toWIF());
    await expect(assertIndependentIdentityControl(user)).rejects.toThrow();
  },
);

it('rechecks every dependency after opening keys and aborts a changed session', async () => {
  mockGetPrivateKey.mockImplementation(async () => {
    mockState.authentication.sessionEpoch++;
    return userKey.toWIF();
  });
  await expect(assertIndependentIdentityControl(user)).rejects.toMatchObject({
    code: 'SESSION_CHANGED',
  });
});

it('passes only U signing keys to the callback, excluding separate recovery keys', async () => {
  mockState.authentication.activeAccount.keys.VRSC.electrum =
    keyRecord(donorKey);
  mockIdentities[identityID].identity.recoveryauthority = authorityID;
  mockIdentities[authorityID] = revision(authorityID, [donorKey.getAddress()]);
  mockGetPrivateKey.mockImplementation(async (_, channel) =>
    (channel === 'vrpc' ? userKey : donorKey).toWIF(),
  );
  const callback = jest.fn();
  await withIndependentIdentitySigningKeys(user, authorityContext, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls[0][0].getAddress()).toBe(userKey.getAddress());
});

it('requires 1-of-N current storage, independent user key and independently controlled R/C', async () => {
  await expect(
    assertAuthorizationStorageControl(storageBinding, delegateKeys),
  ).resolves.toMatchObject({identity: {identityaddress: storageID}});

  mockIdentities[identityID].identity.recoveryauthority = authorityID;
  mockIdentities[authorityID] = revision(authorityID, [donorKey.getAddress()]);
  await expect(
    assertAuthorizationStorageControl(storageBinding, delegateKeys),
  ).rejects.toThrow(/every signing authority/);

  mockIdentities[identityID].identity.recoveryauthority = identityID;
  mockIdentities[storageID].identity.minimumsignatures = 2;
  await expect(
    assertAuthorizationStorageControl(storageBinding, delegateKeys),
  ).rejects.toThrow(/control arrangement/);
});

it('accepts replacement wallet keys and current R/C without rewriting the storage binding', async () => {
  await assertAuthorizationStorageControl(storageBinding, delegateKeys);

  const replacement = ECPair.fromPrivateKeyBuffer(
    Buffer.alloc(32, 3),
    networks.verus,
  );
  const recoveryID = toIAddress('replacement-recovery', 'VRSC');
  mockState.authentication.activeAccount.keys.VRSC.vrpc = keyRecord(replacement);
  mockGetPrivateKey.mockResolvedValue(replacement.toWIF());
  mockIdentities[authorityID] = revision(authorityID, [replacement.getAddress()]);
  mockIdentities[recoveryID] = revision(recoveryID, [replacement.getAddress()]);
  Object.assign(mockIdentities[storageID].identity, {
    primaryaddresses: [replacement.getAddress(), donorKey.getAddress()],
    revocationauthority: authorityID,
    recoveryauthority: recoveryID,
  });

  await expect(
    assertAuthorizationStorageControl(storageBinding, delegateKeys),
  ).resolves.toMatchObject({identity: {identityaddress: storageID}});
  expect(mockGetIdentity).toHaveBeenCalledWith(recoveryID, undefined);
});

it.each([
  'missing wallet key',
  'delegate key only',
  'unusable key',
  'self recovery',
  'token control',
])(
  'rejects current storage with %s',
  async condition => {
    if (condition === 'missing wallet key')
      mockIdentities[storageID].identity.primaryaddresses = [donorKey.getAddress()];
    if (condition === 'delegate key only') {
      mockState.authentication.activeAccount.keys.VRSC.vrpc = keyRecord(donorKey);
      mockGetPrivateKey.mockResolvedValue(donorKey.toWIF());
    }
    if (condition === 'unusable key')
      mockGetPrivateKey.mockResolvedValue(donorKey.toWIF());
    if (condition === 'self recovery')
      mockIdentities[storageID].identity.recoveryauthority = storageID;
    if (condition === 'token control') {
      mockIdentities[storageID].identity.flags =
        IDENTITY_FLAG_TOKENIZED_CONTROL.toNumber();
    }

    await expect(
      assertAuthorizationStorageControl(storageBinding, delegateKeys),
    ).rejects.toThrow();
  },
);

it.each([
  [false, DEFAULT_VERUS_CHAINID],
  [true, TESTNET_VERUS_CHAINID],
])('resolves the trusted root independently of a PBaaS host (testnet=%s)', (testnet, rootSystemID) => {
  const hostSystemID = toIAddress('pbaas-host', 'VRSC');
  mockCoin = {...mockCoin, system_id: hostSystemID, testnet};

  expect(authorizationSource(hostSystemID)).toMatchObject({
    systemID: hostSystemID,
    rootSystemID,
  });
});

it('checks an inherited storage system against the supplied grant system', async () => {
  const binding = new AuthorizationStorageBindingCredential({
    ...storageBinding.data,
    storageSystemID: undefined,
  });

  await expect(
    assertAuthorizationStorageControl(binding, delegateKeys, {}, systemID),
  ).resolves.toMatchObject({identity: {identityaddress: storageID}});
  expect(binding.toPayload()).not.toHaveProperty('s');
  await expect(
    assertAuthorizationStorageControl(binding, delegateKeys),
  ).rejects.toThrow();
});

it('rejects storage that changes while its current wallet key is opened', async () => {
  mockGetPrivateKey.mockImplementation(async () => {
    mockIdentities[storageID] = {
      ...mockIdentities[storageID],
      txid: '33'.repeat(32),
    };
    return userKey.toWIF();
  });

  await expect(
    assertAuthorizationStorageControl(storageBinding, delegateKeys),
  ).rejects.toThrow(/Shared storage changed/);
});

it('shares identity reads and key possession only within one phase, including nested checks', async () => {
  let retainedContext;
  let retainedSource;

  await withAuthorizationReadScope({}, async context => {
    retainedContext = context;
    retainedSource = authorizationSource(systemID, context);
    await assertIndependentIdentityControl(user, context);
    await withAuthorizationReadScope(context, async nested => {
      expect(authorizationSource(systemID, nested)).toBe(retainedSource);
      await assertIndependentIdentityControl(user, nested);
    });
    expect(mockGetIdentity).toHaveBeenCalledTimes(1);
    expect(mockGetPrivateKey).toHaveBeenCalledTimes(1);
    expect(context.usableAuthorizationKeys.size).toBe(1);
  });

  // One initial identity read and one fresh final recheck cover both helpers.
  expect(mockGetIdentity).toHaveBeenCalledTimes(2);
  expect(
    mockReadMany.mock.calls.map(([requests]) =>
      requests.map(request => request.cmd),
    ),
  ).toEqual([['getidentity'], ['getidentity', 'getinfo']]);
  expect(retainedContext.usableAuthorizationKeys.size).toBe(0);
  expect(() => retainedSource.rpc.getIdentity(identityID)).toThrow(/closed/);

  await withAuthorizationReadScope({}, context =>
    assertIndependentIdentityControl(user, context),
  );
  expect(mockGetIdentity).toHaveBeenCalledTimes(4);
  expect(mockGetPrivateKey).toHaveBeenCalledTimes(2);
});

it('opens a signing key even when the same phase already proved key possession', async () => {
  const sign = jest.fn();
  await withAuthorizationReadScope({}, async context => {
    await assertIndependentIdentityControl(user, context);
    await withIndependentIdentitySigningKeys(user, context, sign);
  });
  expect(mockGetPrivateKey).toHaveBeenCalledTimes(2);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(mockGetIdentity).toHaveBeenCalledTimes(2);
});

it.each(['outpoint', 'blockheight', 'signing policy', 'revocation'])(
  'rejects a changed identity %s at the final phase boundary',
  async change => {
    let retainedContext;
    let retainedSource;
    mockGetPrivateKey.mockImplementation(async () => {
      if (change === 'outpoint')
        mockIdentities[identityID].txid = '33'.repeat(32);
      if (change === 'blockheight') mockIdentities[identityID].blockheight = 11;
      if (change === 'signing policy')
        mockIdentities[identityID].identity.primaryaddresses = [
          donorKey.getAddress(),
        ];
      if (change === 'revocation')
        mockIdentities[identityID].status = 'revoked';
      return userKey.toWIF();
    });

    await expect(
      withAuthorizationReadScope({}, async context => {
        retainedContext = context;
        retainedSource = authorizationSource(systemID, context);
        await assertIndependentIdentityControl(user, context);
      }),
    ).rejects.toThrow(/state changed/);
    expect(mockGetIdentity).toHaveBeenCalledTimes(2);
    expect(retainedContext.usableAuthorizationKeys.size).toBe(0);
    expect(() => retainedSource.rpc.getIdentity(identityID)).toThrow(/closed/);
  },
);

it('batches concurrent chain evidence and rejects a same-height reorganization on final recheck', async () => {
  await expect(
    withAuthorizationReadScope({}, async context => {
      const source = authorizationSource(systemID, context);
      await Promise.all([source.rpc.getInfo(), source.rpc.getBlock('20', 1)]);
      mockGetBlock.mockResolvedValue({
        result: {hash: '33'.repeat(32), height: 20, confirmations: 1},
      });
    }),
  ).rejects.toThrow(/state changed/);
  expect(
    mockReadMany.mock.calls.map(([requests]) =>
      requests.map(request => request.cmd),
    ),
  ).toEqual([
    ['getinfo', 'getblock'],
    ['getinfo', 'getblock'],
  ]);
});

it.each(['session', 'network', 'key record', 'endpoint', 'cancelled'])(
  'rejects a changed %s and closes its read scope',
  async change => {
    const signal = {aborted: false};
    let source;
    await expect(
      withAuthorizationReadScope({signal}, async context => {
        source = authorizationSource(systemID, context);
        await source.rpc.getIdentity(identityID);
        if (change === 'session') mockState.authentication.sessionEpoch++;
        if (change === 'network')
          mockState.authentication.activeAccount.testnetOverrides = {
            VRSC: true,
          };
        if (change === 'key record')
          mockState.authentication.activeAccount.keys.VRSC.vrpc.encryptedPrivKey =
            'changed';
        if (change === 'endpoint')
          mockRpc.instance.defaults.baseURL = 'https://other.invalid';
        if (change === 'cancelled') signal.aborted = true;
      }),
    ).rejects.toThrow(
      change === 'endpoint' ? /source changed/ : /wallet changed/,
    );
    // Restoring the endpoint cannot restore a scope that has already failed.
    mockRpc.instance.defaults.baseURL = 'https://example.invalid';
    expect(() => source.rpc.getIdentity(identityID)).toThrow(/closed/);
  },
);

it('clears key possession and closes reads when an operation itself rejects', async () => {
  let retainedContext;
  let source;
  await expect(
    withAuthorizationReadScope({}, async context => {
      retainedContext = context;
      source = authorizationSource(systemID, context);
      await assertIndependentIdentityControl(user, context);
      throw new Error('Decryption failed');
    }),
  ).rejects.toThrow('Decryption failed');
  expect(retainedContext.usableAuthorizationKeys.size).toBe(0);
  expect(() => source.rpc.getIdentity(identityID)).toThrow(/closed/);
});
