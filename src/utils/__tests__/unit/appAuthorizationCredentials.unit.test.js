import {Buffer} from 'buffer';
import {
  AuthorizationCredential,
  BigNumber,
  ContentMultiMapRemove,
  CredentialKey,
  DataDescriptor,
  DataDescriptorKey,
  IdentityUpdateRequestDetails,
  IDENTITY_CREDENTIAL,
  VdxfUniValue,
  toIAddress,
} from 'verus-typescript-primitives';
import {
  loadAuthorizationCredentials,
  invalidateAuthorizationCredentials,
  buildAuthorizationRemovals,
  encryptProjectedAuthorizationCredentials,
} from '../../appAuthorization/credentials';
import {
  assertNoAppAuthorizationCredentials,
  assertNoDirectAuthorizationBucketUpdates,
} from '../../appAuthorization/requestPolicy';

let mockState;
let mockRevision;
let mockSnapshot;
let mockCredentials;
let mockListener;
const mockLoadContent = jest.fn();
const mockDecrypt = jest.fn();
const mockControl = jest.fn();
const mockBlock = jest.fn();
const mockDerive = jest.fn();
const mockWalletKeys = jest.fn();
const mockResolveIdentities = jest.fn();

jest.mock('../../../store', () => ({
  getState: () => mockState,
  subscribe: callback => {
    mockListener = callback;
    return () => {};
  },
}));
jest.mock('verusid-ts-client', () => ({
  ...jest.requireActual('verusid-ts-client'),
  loadCurrentIdentityContent: (...args) => mockLoadContent(...args),
  loadIdentityRevision: async () => mockRevision,
  resolveAppAuthorizationIdentities: (...args) =>
    mockResolveIdentities(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  authorizationContext: (context = {}) => ({
    ...context,
    assertActive: context.assertActive || (() => {}),
  }),
  authorizationSource: systemID => ({
    systemID,
    rootSystemID: require('verus-typescript-primitives').DEFAULT_VERUS_CHAINID,
    coin: {system_id: systemID, id: 'VRSC'},
    rpc: {
      instance: {defaults: {baseURL: 'https://example.invalid'}},
      getBlock: (...args) => mockBlock(...args),
    },
  }),
  assertIndependentIdentityControl: (...args) => mockControl(...args),
  walletAuthorizationKeys: (...args) => mockWalletKeys(...args),
}));
jest.mock('../../crypto/encryptCredentials', () => ({
  deriveCredentialSelfChannel: (...args) => mockDerive(...args),
}));
jest.mock('../../crypto/encryptDataDescriptor', () => ({
  encryptCredentialToDescriptor: jest.fn(),
}));
jest.mock('../../deeplink/credentials/scopedCredentials', () => ({
  decryptAuthorizationCredentialValue: (...args) => mockDecrypt(...args),
}));

const systemID = toIAddress('VRSC', 'VRSC');
const identityID = toIAddress('user', 'VRSC');
const outerKey = toIAddress('self-bucket', 'VRSC');
const user = {identityID, systemID};
const grant = new AuthorizationCredential({
  version: new BigNumber(1),
  flags: new BigNumber(0),
  grantID: '11'.repeat(32),
  signingSystemID: systemID,
  delegateRevision: {txid: '33'.repeat(32), vout: 0},
  delegatorRevision: {txid: '44'.repeat(32), vout: 0},
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateAuthorizationCredentials();
  mockState = {
    authentication: {
      sessionEpoch: 1,
      signedIn: true,
      activeAccount: {accountHash: 'profile'},
    },
  };
  mockRevision = {
    systemID,
    txid: '22'.repeat(32),
    vout: 0,
    blockheight: 10,
    identity: {
      identityaddress: identityID,
      privateaddress: 'shielded-address',
      contentmultimap: {[outerKey]: ['0102']},
    },
  };
  mockSnapshot = {
    revision: mockRevision,
    readHeight: 15,
    blockHash: '44'.repeat(32),
  };
  mockCredentials = [grant.toCredential()];
  mockResolveIdentities.mockReset().mockResolvedValue({
    appID: toIAddress('app', 'VRSC'),
    delegateID: toIAddress('delegate', 'VRSC'),
    delegate: {txid: grant.data.delegateRevision.txid},
    delegator: {txid: grant.data.delegatorRevision.txid},
  });
  mockLoadContent.mockImplementation(async () => mockSnapshot);
  mockControl.mockImplementation(async () => mockRevision);
  mockBlock.mockImplementation(async () => ({
    result: {height: 15, hash: '44'.repeat(32), confirmations: 1},
  }));
  mockDerive.mockResolvedValue({
    address: 'shielded-address',
    ivk: '55'.repeat(32),
    outerKey,
  });
  mockDecrypt.mockImplementation(async () => mockCredentials);
});

it('filters by the derived outer key, excludes sibling CMM and retains exact source bytes', async () => {
  mockSnapshot.revision.identity.contentmultimap[
    toIAddress('unrelated', 'VRSC')
  ] = ['ffff'];
  const view = await loadAuthorizationCredentials(user);
  expect(mockLoadContent).toHaveBeenCalledWith(
    expect.objectContaining({systemID}),
    user,
    outerKey,
  );
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
  expect(view.grants[0].source).toEqual({
    ...user,
    outerKey,
    storedValue: Buffer.from('0102', 'hex'),
  });
  expect(view.grants[0].record.toPayload()).toEqual(grant.toPayload());
  expect(view.grants[0].identities).toMatchObject({
    appID: toIAddress('app', 'VRSC'),
    delegateID: toIAddress('delegate', 'VRSC'),
  });
  expect(view.grants[0].record.toPayload()).not.toHaveProperty('a');
  expect(view.grants[0].record.toPayload()).not.toHaveProperty('d');
  expect(buildAuthorizationRemovals(view.grants)[0].toJson()).toEqual(
    ContentMultiMapRemove.removeStoredValue(
      outerKey,
      Buffer.from('0102', 'hex'),
    ).toJson(),
  );
});

it('resolves an omitted grant system on the network root instead of its containing PBaaS chain', async () => {
  const hostUser = {...user, systemID: toIAddress('host-chain', 'VRSC')};
  mockRevision.systemID = hostUser.systemID;
  const compactGrant = new AuthorizationCredential({
    ...grant.data,
    signingSystemID: undefined,
  });
  mockCredentials = [compactGrant.toCredential()];

  const view = await loadAuthorizationCredentials(hostUser);

  expect(view.rootSystemID).toBe(systemID);
  expect(view.grants[0].source.systemID).toBe(hostUser.systemID);
  expect(mockResolveIdentities).toHaveBeenCalledWith(
    expect.objectContaining({systemID, rootSystemID: systemID}),
    expect.any(AuthorizationCredential),
  );
  expect(view.grants[0].record.toPayload()).not.toHaveProperty('s');
});

it('retains unresolved grants for removal and retries identity resolution without decrypting again', async () => {
  mockResolveIdentities.mockRejectedValueOnce(new Error('History unavailable'));
  const unresolved = await loadAuthorizationCredentials(user);
  expect(unresolved.grants[0].identities).toBeUndefined();
  expect(unresolved.grants[0].identityError).toBe('History unavailable');
  expect(buildAuthorizationRemovals(unresolved.grants)).toHaveLength(1);

  const resolved = await loadAuthorizationCredentials(user);
  expect(resolved.grants[0].identities.appID).toBe(toIAddress('app', 'VRSC'));
  expect(resolved.grants[0].identityError).toBeUndefined();
  expect(mockResolveIdentities).toHaveBeenCalledTimes(2);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
});

it('reuses decoding at an unchanged revision while checking current control on every load', async () => {
  await loadAuthorizationCredentials(user);
  await loadAuthorizationCredentials(user);
  expect(mockLoadContent).toHaveBeenCalledTimes(1);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
  expect(mockControl).toHaveBeenCalledTimes(2);
  expect(mockDerive).toHaveBeenCalledTimes(1);
  expect(mockBlock).toHaveBeenCalledTimes(2);
});

it('reuses unchanged ciphertext across revisions and forgets deleted ciphertext', async () => {
  await loadAuthorizationCredentials(user);
  mockRevision = {
    ...mockRevision,
    txid: '66'.repeat(32),
    identity: {
      ...mockRevision.identity,
      contentmultimap: {[outerKey]: ['0102', '0304']},
    },
  };
  mockSnapshot = {...mockSnapshot, revision: mockRevision};
  await loadAuthorizationCredentials(user);
  expect(
    mockDecrypt.mock.calls.map(([bytes]) => bytes.toString('hex')),
  ).toEqual(['0102', '0304']);

  mockRevision = {
    ...mockRevision,
    txid: '77'.repeat(32),
    identity: {
      ...mockRevision.identity,
      contentmultimap: {[outerKey]: ['0304']},
    },
  };
  mockSnapshot = {...mockSnapshot, revision: mockRevision};
  const removed = await loadAuthorizationCredentials(user);
  expect(
    removed.entries.map(entry => entry.source.storedValue.toString('hex')),
  ).toEqual(['0304']);
  expect(mockDecrypt).toHaveBeenCalledTimes(2);

  mockRevision = {
    ...mockRevision,
    txid: '88'.repeat(32),
    identity: {
      ...mockRevision.identity,
      contentmultimap: {[outerKey]: ['0102', '0304']},
    },
  };
  mockSnapshot = {...mockSnapshot, revision: mockRevision};
  await loadAuthorizationCredentials(user);
  expect(
    mockDecrypt.mock.calls.map(([bytes]) => bytes.toString('hex')),
  ).toEqual(['0102', '0304', '0102']);
});

it.each(['profile', 'key record', 'network'])(
  'does not reuse decoded credentials after a %s change even before a store notification',
  async change => {
    await loadAuthorizationCredentials(user);
    if (change === 'profile')
      mockState.authentication.activeAccount.accountHash = 'other-profile';
    if (change === 'key record')
      mockState.authentication.activeAccount.keys = {
        VRSC: {vrpc: {encryptedPrivKey: 'changed'}},
      };
    if (change === 'network')
      mockState.authentication.activeAccount.testnetOverrides = {VRSC: true};
    await loadAuthorizationCredentials(user);
    expect(mockDerive).toHaveBeenCalledTimes(2);
    expect(mockDecrypt).toHaveBeenCalledTimes(2);
  },
);

it('retains exact native removal bytes when Core renders typed descriptor JSON', async () => {
  const descriptor = new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    epk: Buffer.alloc(32, 3),
    objectdata: Buffer.alloc(48, 4),
  });
  const expected = new VdxfUniValue({
    values: [{[DataDescriptorKey.vdxfid]: descriptor}],
  }).toBuffer();
  mockRevision.identity.contentmultimap[outerKey] = [
    {[DataDescriptorKey.vdxfid]: descriptor.toJson()},
  ];
  const view = await loadAuthorizationCredentials(user);
  expect(mockDecrypt.mock.calls[0][0]).toEqual(expected);
  expect(view.grants[0].source.storedValue).toEqual(expected);
  expect(buildAuthorizationRemovals(view.grants)[0].toJson()).toEqual(
    ContentMultiMapRemove.removeStoredValue(outerKey, expected).toJson(),
  );
});

it('replaces effective membership after deletion instead of merging old grants', async () => {
  await loadAuthorizationCredentials(user);
  mockRevision = {
    ...mockRevision,
    txid: '66'.repeat(32),
    identity: {...mockRevision.identity, contentmultimap: {}},
  };
  mockSnapshot = {...mockSnapshot, revision: mockRevision};
  const view = await loadAuthorizationCredentials(user);
  expect(view.grants).toEqual([]);
  expect(mockLoadContent).toHaveBeenCalledTimes(2);
});

it('refuses an incomplete decrypt or malformed supported record rather than authorizing a partial view', async () => {
  mockSnapshot.revision.identity.contentmultimap[outerKey].push('0304');
  mockDecrypt.mockImplementation(async bytes => {
    if (bytes.toString('hex') === '0304')
      throw new Error('Authentication failed');
    return mockCredentials;
  });
  await expect(loadAuthorizationCredentials(user)).rejects.toThrow(
    'Authentication failed',
  );
  mockDecrypt.mockImplementation(async () => [
    {
      ...grant.toCredential(),
      credential: {...grant.toPayload(), permissions: {}},
    },
  ]);
  await expect(loadAuthorizationCredentials(user)).rejects.toThrow();
});

it('rejects a U update after bucket loading and a reorganization during cached lookup', async () => {
  mockLoadContent.mockImplementation(async () => {
    const snapshot = mockSnapshot;
    mockRevision = {...mockRevision, txid: '66'.repeat(32)};
    return snapshot;
  });
  await expect(loadAuthorizationCredentials(user)).rejects.toThrow(
    /content changed/,
  );
  mockRevision = mockSnapshot.revision;
  mockLoadContent.mockImplementation(async () => mockSnapshot);
  await loadAuthorizationCredentials(user);
  mockBlock.mockResolvedValue({
    result: {height: 15, hash: '77'.repeat(32), confirmations: 1},
  });
  await expect(loadAuthorizationCredentials(user)).rejects.toThrow(
    /content changed/,
  );

  // Failed final evidence must evict decoded data before any subsequent retry.
  const decodesBeforeRetry = mockDecrypt.mock.calls.length;
  mockBlock.mockResolvedValue({
    result: {height: 15, hash: '44'.repeat(32), confirmations: 1},
  });
  await loadAuthorizationCredentials(user);
  expect(mockDecrypt).toHaveBeenCalledTimes(decodesBeforeRetry + 1);
});

it('clears decoded material on session change', async () => {
  await loadAuthorizationCredentials(user);
  mockState.authentication.sessionEpoch++;
  mockListener();
  await loadAuthorizationCredentials(user);
  expect(mockDecrypt).toHaveBeenCalledTimes(2);
});

it('rejects authorization credentials hidden in serialized plaintext import data', () => {
  const bytes = new VdxfUniValue({
    values: [{[CredentialKey.vdxfid]: grant.toCredential()}],
  }).toBuffer();
  expect(() => assertNoAppAuthorizationCredentials({data: bytes})).toThrow(
    /dedicated app authorization/,
  );
});

it('rejects reinsertion of opaque historical ciphertext into the self bucket but permits the plaintext credential route', async () => {
  const details = IdentityUpdateRequestDetails.fromCLIJson({
    name: 'user',
    parent: systemID,
    contentmultimap: {[outerKey]: ['0102']},
  });
  await expect(
    assertNoDirectAuthorizationBucketUpdates(details, mockRevision, {
      system_id: systemID,
      id: 'VRSC',
    }),
  ).rejects.toThrow(/Direct writes/);
  const ordinary = IdentityUpdateRequestDetails.fromCLIJson({
    name: 'user',
    parent: systemID,
    contentmultimap: {[IDENTITY_CREDENTIAL.vdxfid]: ['0102']},
  });
  await expect(
    assertNoDirectAuthorizationBucketUpdates(ordinary, mockRevision, {
      system_id: systemID,
      id: 'VRSC',
    }),
  ).resolves.toBeUndefined();
});

it('encrypts atomic gift credentials only to the projected wallet-owned U and native descriptor wrapper', async () => {
  const {
    DataDescriptor,
    DataDescriptorKey,
    R_ADDR_VERSION,
    toBase58Check,
  } = require('verus-typescript-primitives');
  const keyID = '66'.repeat(20);
  const projected = {
    identityaddress: identityID,
    privateaddress: 'future-wallet-z',
    primaryaddresses: [
      toBase58Check(Buffer.from(keyID, 'hex'), R_ADDR_VERSION),
    ],
    minimumsignatures: 1,
  };
  mockWalletKeys.mockReturnValue([{keyID}]);
  const descriptor = new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    epk: Buffer.alloc(32, 7),
    objectdata: Buffer.alloc(32, 8),
  });
  const {
    encryptCredentialToDescriptor,
  } = require('../../crypto/encryptDataDescriptor');
  encryptCredentialToDescriptor.mockResolvedValue({
    encryptedDescriptor: descriptor,
  });
  const result = await encryptProjectedAuthorizationCredentials(
    user,
    [grant],
    projected,
  );
  expect(mockControl).not.toHaveBeenCalled();
  expect(mockDerive).toHaveBeenCalledWith(
    systemID,
    projected,
    expect.objectContaining({system_id: systemID}),
    expect.any(Object),
  );
  const parsed = new VdxfUniValue();
  const bytes = Buffer.from(result[outerKey][0], 'hex');
  expect(parsed.fromBuffer(bytes)).toBe(bytes.length);
  expect(parsed.values[0][DataDescriptorKey.vdxfid].toBuffer()).toEqual(
    descriptor.toBuffer(),
  );
  expect(encryptCredentialToDescriptor).toHaveBeenCalledWith(
    'shielded-address',
    grant.toCredential(),
  );
});

it('rejects projected credentials for an app key, a different U, or a private address outside this wallet', async () => {
  const {
    R_ADDR_VERSION,
    toBase58Check,
  } = require('verus-typescript-primitives');
  const keyID = '66'.repeat(20);
  const projected = {
    identityaddress: identityID,
    privateaddress: 'future-wallet-z',
    primaryaddresses: [
      toBase58Check(Buffer.from(keyID, 'hex'), R_ADDR_VERSION),
    ],
    minimumsignatures: 1,
  };
  mockWalletKeys.mockReturnValue([]);
  await expect(
    encryptProjectedAuthorizationCredentials(user, [grant], projected),
  ).rejects.toThrow(/exclusively/);
  mockWalletKeys.mockReturnValue([{keyID}]);
  await expect(
    encryptProjectedAuthorizationCredentials(user, [grant], {
      ...projected,
      identityaddress: toIAddress('other', 'VRSC'),
    }),
  ).rejects.toThrow(/exclusively/);
  mockDerive.mockRejectedValueOnce(
    new Error('The private address does not match this wallet seed.'),
  );
  await expect(
    encryptProjectedAuthorizationCredentials(user, [grant], projected),
  ).rejects.toThrow(/wallet seed/);
});
