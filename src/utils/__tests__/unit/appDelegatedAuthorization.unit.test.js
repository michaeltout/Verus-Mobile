import {Buffer} from 'buffer';
import {authorizationIdentityTransaction} from '../../../../debug/fixtures/appAuthorizationIdentity';
import * as delegatedOperations from '../../appAuthorization/delegatedOperations';
import {ECPair, IdentitySignature, networks} from '@bitgo/utxo-lib';
import {
  VerusIdInterface,
  createAppAuthorizationRequest,
} from 'verusid-ts-client';
import {
  AppEncryptionRequestDetails,
  AppEncryptionRequestOrdinalVDXFObject,
  AuthenticationRequestDetails,
  AuthenticationRequestOrdinalVDXFObject,
  AuthorizationCredential,
  BigNumber,
  CompactIAddressObject,
  DELEGATOR_PROFILE_VDXF_KEY,
  EHashTypes,
  GenericRequest,
  RecipientConstraint,
  SaplingPaymentAddress,
  VerifiableSignatureData,
  toIAddress,
} from 'verus-typescript-primitives';
import {
  assertAppEncryptionAuthorization,
  assertSignedRequestAuthorization,
  withAppEncryptionSigningKeys,
} from '../../deeplink/validator/appEncryptionAuthorization';

let mockState;
let mockClient;
let mockOriginal;
let mockCurrent;
let mockApp;
let mockRecords;
let mockServiceData;
let mockCoins;
let mockRawTransactions;
const mockLoadCredentials = jest.fn();
const mockIndependent = jest.fn();
const mockFreshView = jest.fn();
const mockReadServiceData = jest.fn();
jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../auth/authBox', () => ({
  requestPrivKey: jest.fn(),
  requestServiceStoredData: (...args) => mockReadServiceData(...args),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    getBasicCoinObj: id =>
      mockCoins[id] ||
      Object.values(mockCoins).find(coin => coin.system_id === id),
    findCoinObj: id =>
      mockCoins[id] ||
      Object.values(mockCoins).find(coin => coin.system_id === id),
  },
}));
jest.mock('../../vrpc/vrpcInterface', () => ({
  initEndpoint: jest.fn(),
  getVerusIdInterface: () => {
    const {VerusIdInterface} = jest.requireActual('verusid-ts-client');
    const client = new VerusIdInterface(
      mockClient.interface.chain,
      'https://example.invalid',
    );
    client.interface = mockClient.interface;
    return client;
  },
}));
jest.mock('../../api/channels/verusid/callCreators', () => ({
  getIdentity: (_, id, height) => mockClient.interface.getIdentity(id, height),
}));
jest.mock('../../api/channels/vrpc/requests/getSignatureInfo', () => ({
  getSignatureInfo: (system, id, signature) =>
    mockClient.getSignatureInfo(id, signature, system),
}));
jest.mock('../../api/channels/vrpc/requests/verifyGenericRequest', () => ({
  verifyGenericRequest: (coin, request, identity) =>
    mockClient.verifyGenericRequest(request, identity, coin.system_id),
}));
jest.mock('../../appAuthorization/credentials', () => ({
  loadAuthorizationCredentials: (...args) => mockLoadCredentials(...args),
  assertAuthorizationCredentialsCurrent: (...args) => mockFreshView(...args),
}));
jest.mock('../../appAuthorization/controls', () => ({
  ...jest.requireActual('../../appAuthorization/controls'),
  assertIndependentIdentityControl: (...args) => mockIndependent(...args),
}));

const systemID = toIAddress('VRSC', 'VRSC');
const delegateID = toIAddress('delegate', 'VRSC');
const appID = toIAddress('app', 'VRSC');
const user = {systemID, identityID: toIAddress('user', 'VRSC')};
const userKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 1),
  networks.verus,
);
const originalKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 2),
  networks.verus,
);
const retainedKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 3),
  networks.verus,
);
const addedKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 4),
  networks.verus,
);
const SIGNED_HEIGHT = 100;
const READ_HEIGHT = 200;
const now = () => Math.floor(Date.now() / 1000);
const revision = (id, keys, txid = '11'.repeat(32), blockheight = 90) => ({
  status: 'active',
  blockheight,
  txid,
  vout: 0,
  identity: {
    version: 3,
    flags: 0,
    identityaddress: id,
    primaryaddresses: keys.map(key => key.getAddress()),
    minimumsignatures: 1,
    recoveryauthority: id,
    revocationauthority: id,
    contentmultimap: {},
    parent: systemID,
  },
});

const credentialView = (
  candidate = user,
  records = mockRecords,
  parentID = systemID,
) => {
  const current = revision(candidate.identityID, [userKey]);
  current.systemID = candidate.systemID;
  current.identity.parent = parentID;
  return {
    identity: current,
    records,
    grants: records.filter(
      entry => entry.record instanceof AuthorizationCredential,
    ),
    storageBindings: [],
  };
};

const recordsFor = (
  candidate,
  changes = {},
  identities = mockRecords[0].identities,
) => [
  {
    record: new AuthorizationCredential({
      ...mockRecords[0].record.data,
      ...changes,
    }),
    identities,
    source: {...mockRecords[0].source, ...candidate},
  },
];

const signedRequest = (keys, recipientConstraints = []) => {
  const request = new GenericRequest({
    createdAt: new BigNumber(now()),
    salt: Buffer.alloc(32, 1),
    appOrDelegatorID: CompactIAddressObject.fromAddress(appID),
    signature: new VerifiableSignatureData({
      version: VerifiableSignatureData.DEFAULT_VERSION,
      systemID: CompactIAddressObject.fromAddress(systemID),
      identityID: CompactIAddressObject.fromAddress(delegateID),
    }),
    details: [
      new AuthenticationRequestOrdinalVDXFObject({
        data: new AuthenticationRequestDetails({
          expiryTime: new BigNumber(now() + 3600),
          ...(recipientConstraints.length ? {recipientConstraints} : {}),
        }),
      }),
      new AppEncryptionRequestOrdinalVDXFObject({
        data: new AppEncryptionRequestDetails(),
      }),
    ],
  });
  request.setSigned();
  const signatures = new IdentitySignature(
    networks.verus,
    2,
    EHashTypes.HASH_SHA256,
    SIGNED_HEIGHT,
    [],
    systemID,
    delegateID,
  );
  keys.forEach(key =>
    signatures.signHashOffline(
      request.getDetailsIdentitySignatureHash(SIGNED_HEIGHT),
      key,
    ),
  );
  const bytes = Buffer.alloc(7 + 66 * keys.length);
  signatures.toBuffer(bytes);
  request.signature.signatureAsVch = bytes;
  return request;
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockCoins = {
    VRSC: {
      id: 'VRSC',
      system_id: systemID,
      testnet: false,
      bitgojs_network_key: 'verus',
      vrpc_endpoints: ['https://example.invalid'],
    },
  };
  mockServiceData = {linked_ids: {VRSC: {[user.identityID]: 'user@'}}};
  mockReadServiceData.mockImplementation(async () =>
    JSON.parse(JSON.stringify(mockServiceData)),
  );
  mockState = {
    authentication: {
      sessionEpoch: 1,
      signedIn: true,
      activeAccount: {
        accountHash: 'profile',
        keys: {
          VRSC: {
            vrpc: {
              pubKey: userKey.getPublicKeyBuffer().toString('hex'),
              encryptedPrivKey: 'encrypted',
            },
          },
        },
      },
    },
  };
  mockOriginal = revision(delegateID, [originalKey, retainedKey]);
  mockCurrent = revision(
    delegateID,
    [retainedKey, addedKey],
    '22'.repeat(32),
    110,
  );
  const original = authorizationIdentityTransaction(mockOriginal, 'delegate');
  const app = authorizationIdentityTransaction(
    revision(appID, [addedKey]),
    'app',
  );
  mockOriginal = original.revision;
  mockApp = app.revision;
  mockRawTransactions = new Map([
    [mockOriginal.txid, original.transaction],
    [mockApp.txid, app.transaction],
  ]);
  const userRevision = revision(user.identityID, [userKey]);
  mockClient = new VerusIdInterface(systemID, 'https://example.invalid');
  mockClient.interface.getInfo = jest.fn(async () => ({
    result: {chainid: systemID, blocks: READ_HEIGHT, longestchain: READ_HEIGHT},
  }));
  mockClient.interface.getBlock = jest.fn(async height => ({
    result: {
      height: Number(height),
      confirmations: 1,
      hash: '44'.repeat(32),
      time: now(),
    },
  }));
  mockClient.interface.getIdentity = jest.fn(async (id, height) => ({
    result:
      id === delegateID
        ? height == null
          ? mockCurrent
          : mockOriginal
        : id === appID
        ? mockApp
        : revision(id, [userKey]),
  }));
  mockClient.interface.getRawTransaction = jest.fn(async (txid, verbose) => ({
    result: verbose
      ? mockRawTransactions.get(txid)
      : mockRawTransactions.get(txid)?.hex,
    error: mockRawTransactions.has(txid)
      ? null
      : {message: 'Missing transaction'},
  }));
  mockClient.interface.getIdentityContent = jest.fn(async () => ({
    result: {...mockApp, fromheight: 0, toheight: READ_HEIGHT},
  }));
  const grant = new AuthorizationCredential({
    version: new BigNumber(1),
    flags: new BigNumber(0),
    grantID: '55'.repeat(32),
    signingSystemID: systemID,
    delegateRevision: {txid: mockOriginal.txid, vout: 0},
    delegatorRevision: {
      txid: mockApp.txid,
      vout: mockApp.vout,
    },
  });
  mockRecords = [
    {
      record: grant,
      identities: {
        appID,
        delegateID,
        delegate: mockOriginal,
        delegator: mockApp,
      },
      source: {
        ...user,
        outerKey: toIAddress('bucket', 'VRSC'),
        storedValue: Buffer.from('0102', 'hex'),
      },
    },
  ];
  mockLoadCredentials.mockImplementation(async candidate =>
    credentialView(candidate),
  );
  mockFreshView.mockResolvedValue(userRevision);
  mockIndependent.mockImplementation(async (_, __, signKey) => {
    if (signKey) signKey(userKey);
    return userRevision;
  });
});

it('admits an external app only after finding a verified grant in a linked identity', async () => {
  const result = await assertSignedRequestAuthorization(
    signedRequest([retainedKey]),
  );
  expect(result).toMatchObject({delegated: true, appScopeID: appID});
  expect(result.requiresDelegatedAuthorization).toBeUndefined();
  expect(result.selectedIdentity).toBeUndefined();
  expect(result.user).toBeUndefined();
  expect(mockLoadCredentials).toHaveBeenCalledWith(user, expect.anything());
  expect(mockIndependent).toHaveBeenCalled();
});

it.each(['no linked identity', 'no matching grant'])(
  'rejects profile-level admission with %s',
  async missing => {
    if (missing === 'no linked identity') mockServiceData.linked_ids = {};
    else mockRecords = [];

    await expect(
      assertSignedRequestAuthorization(signedRequest([retainedKey])),
    ).rejects.toThrow(/approv|authoriz|linked/i);
  },
);

it('skips an unrelated first identity and verifies the later matching grant', async () => {
  const first = {...user, identityID: toIAddress('first', 'VRSC')};
  mockServiceData.linked_ids.VRSC = {
    [first.identityID]: 'first@',
    [user.identityID]: 'user@',
  };
  mockLoadCredentials.mockImplementation(async candidate =>
    candidate.identityID === first.identityID
      ? credentialView(
          first,
          recordsFor(
            first,
            {},
            {
              ...mockRecords[0].identities,
              appID: toIAddress('other-app', 'VRSC'),
            },
          ),
        )
      : credentialView(user),
  );
  const verify = jest.spyOn(
    VerusIdInterface.prototype,
    'verifyDelegatedGenericRequest',
  );

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).resolves.toMatchObject({delegated: true});
  expect(
    mockLoadCredentials.mock.calls.map(([candidate]) => candidate),
  ).toEqual([first, user]);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls[0][1].user).toEqual(user);
});

it('continues past an invalid matching grant without combining candidates', async () => {
  const first = {...user, identityID: toIAddress('first', 'VRSC')};
  const invalid = recordsFor(first, {
    delegateRevision: {txid: '66'.repeat(32), vout: 0},
  });
  mockServiceData.linked_ids.VRSC = {
    [first.identityID]: 'first@',
    [user.identityID]: 'user@',
  };
  mockLoadCredentials.mockImplementation(async candidate =>
    candidate.identityID === first.identityID
      ? credentialView(first, invalid)
      : credentialView(user),
  );
  const verify = jest.spyOn(
    VerusIdInterface.prototype,
    'verifyDelegatedGenericRequest',
  );

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).resolves.toMatchObject({delegated: true});
  expect(verify).toHaveBeenCalledTimes(2);
  expect(verify.mock.calls.map(([, options]) => options.user)).toEqual([
    first,
    user,
  ]);
  for (const [, options] of verify.mock.calls) {
    expect(options.records).toHaveLength(1);
    expect(options.records[0].source.identityID).toBe(options.user.identityID);
  }
});

it('continues past an unavailable linked identity without accepting its unreadable data', async () => {
  const first = {...user, identityID: toIAddress('first', 'VRSC')};
  mockServiceData.linked_ids.VRSC = {
    [first.identityID]: 'first@',
    [user.identityID]: 'user@',
  };
  mockLoadCredentials.mockImplementation(async candidate => {
    if (candidate.identityID === first.identityID)
      throw new Error('Identity unavailable');
    return credentialView(user);
  });

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).resolves.toMatchObject({delegated: true});
  expect(mockLoadCredentials).toHaveBeenCalledTimes(2);
});

it('does not authorize an explicitly selected U through another linked user’s grant', async () => {
  const selected = {...user, identityID: toIAddress('selected', 'VRSC')};
  mockServiceData.linked_ids.VRSC[selected.identityID] = 'selected@';
  mockLoadCredentials.mockImplementation(async candidate =>
    candidate.identityID === selected.identityID
      ? credentialView(selected, [])
      : credentialView(user),
  );

  await expect(
    assertAppEncryptionAuthorization(signedRequest([retainedKey]), selected),
  ).rejects.toThrow(/approv|authoriz|linked/i);
  expect(
    mockLoadCredentials.mock.calls.map(([candidate]) => candidate),
  ).toEqual([selected]);
});

it('rejects a grant sourced from a different U even when its app and delegate match', async () => {
  const another = {...user, identityID: toIAddress('another', 'VRSC')};
  mockLoadCredentials.mockResolvedValue(
    credentialView(user, recordsFor(another)),
  );

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).rejects.toThrow(/approv|authoriz|linked/i);
});

it('skips testnet identities but permits U on a different supported mainnet system', async () => {
  const other = {
    identityID: toIAddress('other-user', 'VRSC'),
    systemID: toIAddress('other-chain', 'VRSC'),
  };
  mockCoins.TEST = {...mockCoins.VRSC, id: 'TEST', testnet: true};
  mockCoins.OTHER = {...mockCoins.VRSC, id: 'OTHER', system_id: other.systemID};
  mockServiceData.linked_ids = {
    TEST: {[user.identityID]: 'test-user@'},
    OTHER: {[other.identityID]: 'other-user@'},
  };
  mockLoadCredentials.mockResolvedValue(
    credentialView(other, recordsFor(other), other.systemID),
  );

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).resolves.toMatchObject({delegated: true});
  expect(
    mockLoadCredentials.mock.calls.map(([candidate]) => candidate),
  ).toEqual([other]);
});

it('filters explicit recipient ID and system constraints before reading credential buckets', async () => {
  const otherSystem = toIAddress('other-chain', 'VRSC');
  const deniedIdentity = toIAddress('denied', 'VRSC');
  mockCoins.OTHER = {...mockCoins.VRSC, id: 'OTHER', system_id: otherSystem};
  mockServiceData.linked_ids = {
    OTHER: {[user.identityID]: 'other-chain-user@'},
    VRSC: {[deniedIdentity]: 'denied@', [user.identityID]: 'user@'},
  };
  const request = signedRequest(
    [retainedKey],
    [
      RecipientConstraint.requiredIDFromAddress(user.identityID),
      RecipientConstraint.requiredSystemFromAddress(systemID),
    ],
  );

  await expect(
    assertSignedRequestAuthorization(request),
  ).resolves.toMatchObject({
    delegated: true,
  });
  expect(
    mockLoadCredentials.mock.calls.map(([candidate]) => candidate),
  ).toEqual([user]);
});

it('checks parent constraints against each current credential identity before grant verification', async () => {
  const first = {...user, identityID: toIAddress('first', 'VRSC')};
  const requiredParent = toIAddress('required-parent', 'VRSC');
  mockServiceData.linked_ids.VRSC = {
    [first.identityID]: 'first@',
    [user.identityID]: 'user@',
  };
  mockLoadCredentials.mockImplementation(async candidate =>
    candidate.identityID === first.identityID
      ? credentialView(first, recordsFor(first))
      : credentialView(user, mockRecords, requiredParent),
  );
  mockIndependent.mockResolvedValue(
    credentialView(user, mockRecords, requiredParent).identity,
  );
  const verify = jest.spyOn(
    VerusIdInterface.prototype,
    'verifyDelegatedGenericRequest',
  );
  const request = signedRequest(
    [retainedKey],
    [RecipientConstraint.requiredParentFromAddress(requiredParent)],
  );

  await expect(
    assertSignedRequestAuthorization(request),
  ).resolves.toMatchObject({
    delegated: true,
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify.mock.calls[0][1].user).toEqual(user);
});

it('rejects a parent constraint that stops matching during the final control check', async () => {
  const requiredParent = toIAddress('required-parent', 'VRSC');
  mockLoadCredentials.mockResolvedValue(
    credentialView(user, mockRecords, requiredParent),
  );
  const request = signedRequest(
    [retainedKey],
    [RecipientConstraint.requiredParentFromAddress(requiredParent)],
  );

  await expect(assertSignedRequestAuthorization(request)).rejects.toThrow(
    /No linked identity/,
  );
});

it('deduplicates the same linked U stored under a coin name and system address', async () => {
  mockServiceData.linked_ids[systemID] = {[user.identityID]: 'user@'};
  mockRecords = [];

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).rejects.toThrow(/No linked identity/);
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
});

it('does not admit a grant after its candidate U is unlinked during discovery', async () => {
  mockLoadCredentials.mockImplementation(async () => {
    mockServiceData.linked_ids = {};
    return credentialView(user);
  });

  await expect(
    assertSignedRequestAuthorization(signedRequest([retainedKey])),
  ).rejects.toThrow(/approv|authoriz|linked|changed/i);
});

it.each(['profile', 'network', 'request'])(
  'aborts discovery when the %s changes during credential loading',
  async changed => {
    const request = signedRequest([retainedKey]);
    mockLoadCredentials.mockImplementation(async () => {
      if (changed === 'profile') mockState.authentication.sessionEpoch += 1;
      else if (changed === 'network')
        mockState.authentication.activeAccount.testnetOverrides = {
          VRSC: 'VRSCTEST',
        };
      else request.salt = Buffer.alloc(32, 9);
      return credentialView(user);
    });

    await expect(
      assertSignedRequestAuthorization(request),
    ).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
  },
);

it('retains self-controlled scope admission without needing any linked grant', async () => {
  mockOriginal = revision(delegateID, [userKey]);
  mockCurrent = revision(delegateID, [userKey], '22'.repeat(32), 110);
  mockServiceData.linked_ids = {};
  require('../../auth/authBox').requestPrivKey.mockResolvedValue(
    userKey.toWIF(),
  );

  await expect(
    assertSignedRequestAuthorization(signedRequest([userKey])),
  ).resolves.toMatchObject({appScopeID: appID});
  expect(mockLoadCredentials).not.toHaveBeenCalled();
  expect(mockReadServiceData).not.toHaveBeenCalled();
});

it('accepts a retained original key and signs only after the final complete-grant verifier', async () => {
  const events = [];
  const verify = VerusIdInterface.prototype.verifyDelegatedGenericRequest;
  jest
    .spyOn(VerusIdInterface.prototype, 'verifyDelegatedGenericRequest')
    .mockImplementation(async function (...args) {
      const valid = await verify.apply(this, args);
      events.push('verified');
      return valid;
    });
  await expect(
    withAppEncryptionSigningKeys(signedRequest([retainedKey]), user, {}, () =>
      events.push('signed'),
    ),
  ).resolves.toMatchObject({delegated: true, appScopeID: appID});
  expect(events).toEqual(['verified', 'signed']);
  expect(mockIndependent).toHaveBeenCalledTimes(2);
});

it('reuses credential loading control before the final current-user check when no signature is needed', async () => {
  await expect(
    assertAppEncryptionAuthorization(signedRequest([retainedKey]), user),
  ).resolves.toMatchObject({delegated: true});
  expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
  expect(mockIndependent).toHaveBeenCalledTimes(1);
  expect(mockFreshView).toHaveBeenCalled();
});

it('accepts a response identity with wallet primary control and external recovery and revocation', async () => {
  const recoveryID = toIAddress('external-recovery', 'VRSC');
  const revocationID = toIAddress('external-revocation', 'VRSC');
  const getIdentity = mockClient.interface.getIdentity.getMockImplementation();
  mockClient.interface.getIdentity.mockImplementation(async (id, height) => {
    if (id === recoveryID || id === revocationID) {
      return {result: revision(id, [addedKey])};
    }

    const response = await getIdentity(id, height);
    if (id === user.identityID) {
      return {
        result: {
          ...response.result,
          identity: {
            ...response.result.identity,
            recoveryauthority: recoveryID,
            revocationauthority: revocationID,
          },
        },
      };
    }
    return response;
  });

  // Exercise the real wallet-control check, not the normal fixture stub. U can
  // store approval and sign a response without owning its external R/C keys.
  mockIndependent.mockImplementation(
    jest.requireActual('../../appAuthorization/controls')
      .assertIndependentIdentityControl,
  );
  const {requestPrivKey} = require('../../auth/authBox');
  requestPrivKey.mockResolvedValue(userKey.toWIF());
  const sign = jest.fn();

  await expect(
    withAppEncryptionSigningKeys(signedRequest([retainedKey]), user, {}, sign),
  ).resolves.toMatchObject({delegated: true, appScopeID: appID});
  expect(sign).toHaveBeenCalledTimes(1);
  expect(sign.mock.calls[0][0].getPublicKeyBuffer()).toEqual(
    userKey.getPublicKeyBuffer(),
  );
  expect(
    mockClient.interface.getIdentity.mock.calls.some(
      ([id]) => id === recoveryID || id === revocationID,
    ),
  ).toBe(false);
});

it('rejects the disjoint original/current signer-subset attack without releasing a signature', async () => {
  const callback = jest.fn();
  await expect(
    withAppEncryptionSigningKeys(
      signedRequest([originalKey, addedKey]),
      user,
      {},
      callback,
    ),
  ).rejects.toThrow(/No current app approval/);
  expect(callback).not.toHaveBeenCalled();
});

it('rejects a deleted grant without falling back to self-controlled or unscoped processing', async () => {
  const request = signedRequest([retainedKey]);
  await expect(
    assertAppEncryptionAuthorization(request, user),
  ).resolves.toMatchObject({delegated: true});
  mockRecords = [];
  await expect(assertAppEncryptionAuthorization(request, user)).rejects.toThrow(
    /No current app approval/,
  );
});

it.each(['discovery', 'selected user'])(
  'rejects a future delegator profile during %s despite an existing grant',
  async path => {
    mockApp.identity.contentmultimap[DELEGATOR_PROFILE_VDXF_KEY.vdxfid] = null;
    await expect(
      path === 'discovery'
        ? assertSignedRequestAuthorization(signedRequest([retainedKey]))
        : assertAppEncryptionAuthorization(signedRequest([retainedKey]), user),
    ).rejects.toMatchObject({code: 'UNSUPPORTED_DELEGATOR_PROFILE'});
    expect(mockLoadCredentials).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'verifies supported bootstrap without a prior grant, with selected profile: %s',
  async profileSelected => {
    const request = createAppAuthorizationRequest({
      appID,
      delegate: {systemID, identityID: delegateID},
      requestID: toIAddress('request', 'VRSC'),
      createdAt: new BigNumber(now()),
      expiryTime: new BigNumber(now() + 3600),
      salt: Buffer.alloc(32, 2),
      encryptResponseToAddress: new SaplingPaymentAddress({
        d: Buffer.alloc(11, 3),
        pkD: Buffer.alloc(32, 4),
      }),
    });
    await mockClient.signGenericRequest(
      request,
      retainedKey.toWIF(),
      mockOriginal,
      SIGNED_HEIGHT,
    );
    mockServiceData.linked_ids = {};
    mockRecords = [];
    if (!profileSelected) mockState.authentication.activeAccount = null;
    await expect(
      assertSignedRequestAuthorization(request),
    ).resolves.toMatchObject({bootstrap: true});
    expect(mockLoadCredentials).not.toHaveBeenCalled();
    expect(mockIndependent).not.toHaveBeenCalled();
    expect(mockReadServiceData).not.toHaveBeenCalled();
  },
);

it.each(['request', 'expiry'])(
  'does not sign when %s changes during the final RPC batch',
  async change => {
    const request = signedRequest([retainedKey]);
    const initialTime = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(initialTime);
    const read = mockClient.interface.getInfo.getMockImplementation();
    let reads = 0;
    mockClient.interface.getInfo.mockImplementation(async () => {
      if (++reads === 2) {
        if (change === 'request') request.salt = Buffer.alloc(32, 9);
        else clock.mockReturnValue(initialTime + 24 * 60 * 60 * 1000);
      }
      return read();
    });
    const sign = jest.fn();
    await expect(
      withAppEncryptionSigningKeys(request, user, {}, sign),
    ).rejects.toThrow();
    expect(reads).toBe(2);
    expect(sign).not.toHaveBeenCalled();
  },
);

it('releases the unsigned reservation when the final fresh RPC fails', async () => {
  const request = signedRequest([retainedKey]);
  const reservation = {id: 'reserved-response'};
  jest
    .spyOn(delegatedOperations, 'reserveDelegatedExecution')
    .mockResolvedValue(reservation);
  const release = jest
    .spyOn(delegatedOperations, 'releaseDelegatedSigningReservation')
    .mockResolvedValue();
  const read = mockClient.interface.getInfo.getMockImplementation();
  let reads = 0;
  mockClient.interface.getInfo.mockImplementation(async () => {
    if (++reads === 2) throw new Error('Temporary final RPC failure');
    return read();
  });
  const sign = jest.fn();
  await expect(
    withAppEncryptionSigningKeys(
      request,
      user,
      {executionStep: 'response'},
      sign,
    ),
  ).rejects.toThrow('Temporary final RPC failure');
  expect(sign).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledWith(reservation, 'response');
  await expect(
    withAppEncryptionSigningKeys(
      request,
      user,
      {executionStep: 'response'},
      sign,
    ),
  ).resolves.toMatchObject({delegated: true});
  expect(sign).toHaveBeenCalledTimes(1);
});

it('keeps replay protection once a signing callback has been entered', async () => {
  jest
    .spyOn(delegatedOperations, 'reserveDelegatedExecution')
    .mockResolvedValue({id: 'reserved-response'});
  const release = jest
    .spyOn(delegatedOperations, 'releaseDelegatedSigningReservation')
    .mockResolvedValue();
  await expect(
    withAppEncryptionSigningKeys(
      signedRequest([retainedKey]),
      user,
      {executionStep: 'response'},
      () => {
        throw new Error('Signing interrupted');
      },
    ),
  ).rejects.toThrow('Signing interrupted');
  expect(release).not.toHaveBeenCalled();
});
