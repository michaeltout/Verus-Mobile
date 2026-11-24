// Integrated Mobile/SDK request accounting. Only RPC I/O, protected storage,
// and native cryptography are replaced; grant decoding, identity controls,
// storage policy, signature verification, and encryption processing are real.
import {Buffer} from 'buffer';
import {authorizationIdentityTransaction} from '../../../../debug/fixtures/appAuthorizationIdentity';
import {ECPair, IdentitySignature, networks} from '@bitgo/utxo-lib';
import {VerusIdInterface} from 'verusid-ts-client';
import {
  AppEncryptionRequestDetails,
  AppEncryptionRequestOrdinalVDXFObject,
  AuthenticationRequestDetails,
  AuthenticationRequestOrdinalVDXFObject,
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  BigNumber,
  CompactIAddressObject,
  DataDescriptor,
  DataDescriptorKey,
  DataResponseOrdinalVDXFObject,
  EHashTypes,
  GenericRequest,
  SaplingPaymentAddress,
  VdxfUniValue,
  VerifiableSignatureData,
  deriveAppAuthorizationStorageManifest,
  toIAddress,
} from 'verus-typescript-primitives';
import {SaplingExtendedViewingKey} from 'verus-typescript-primitives/dist/pbaas/SaplingExtendedViewingKey';
import {
  assertAppEncryptionAuthorization,
  withAppEncryptionSigningKeys,
} from '../../deeplink/validator/appEncryptionAuthorization';
import {processAppEncryptionRequest} from '../../deeplink/handlers/appEncryptionRequestHandler';
import {
  buildAuthorizationRemovals,
  invalidateAuthorizationCredentials,
  loadAuthorizationCredentials,
} from '../../appAuthorization/credentials';
import {withAuthorizationReadScope} from '../../appAuthorization/controls';

let mockState;
let mockClient;
let mockServiceData;
let mockIdentities;
let mockOriginalDelegate;
let mockCredentials;
let mockTransportGroups;
let mockRawTransactions;
let fixtureNumber = 0;
const mockOpenKey = jest.fn();
const mockDeriveSelf = jest.fn();
const mockDecrypt = jest.fn();
const mockDeriveApp = jest.fn();
const mockEncrypt = jest.fn();
const mockWriteStorage = jest.fn();

jest.mock('../../../store', () => ({getState: () => mockState}));
jest.mock('../../auth/authBox', () => ({
  requestPrivKey: (...args) => mockOpenKey(...args),
  requestServiceStoredData: async () =>
    JSON.parse(JSON.stringify(mockServiceData)),
}));
jest.mock('../../../actions/actions/services/dispatchers/services', () => ({
  modifyServiceStoredDataForUser: (...args) => mockWriteStorage(...args),
}));
jest.mock('../../asyncStore/passwordProtectedStorageQueue', () => ({
  queueServiceStorageWrite: operation => operation(),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    getBasicCoinObj: () => ({
      id: 'VRSC',
      system_id: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
      testnet: false,
      bitgojs_network_key: 'verus',
      vrpc_endpoints: ['https://example.invalid'],
    }),
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
jest.mock('../../crypto/encryptCredentials', () => ({
  deriveCredentialSelfChannel: (...args) => mockDeriveSelf(...args),
}));
jest.mock('../../deeplink/credentials/scopedCredentials', () => ({
  decryptAuthorizationCredentialValue: (...args) => mockDecrypt(...args),
}));
jest.mock('../../crypto/encryptDataDescriptor', () => ({
  encryptDataBufferToDescriptor: (...args) => mockEncrypt(...args),
  encryptCredentialToDescriptor: jest.fn(),
}));
jest.mock('../../crypto/getKeyMaterial', () => ({
  getKeyMaterial: async () => ({extsk: '03'.repeat(169)}),
}));
jest.mock('../../api/channels/dlight/requests/zGetEncryptionAddress', () => ({
  zGetEncryptionAddress: (...args) => mockDeriveApp(...args),
}));
jest.mock('../../api/channels/verusid/callCreators', () => ({
  getIdentity: jest.fn(),
}));
jest.mock('../../deeplink/handlers/requestDisplayUtils', () => ({
  getRequestScope: jest.fn(),
  getSignedRequestDisplayProps: jest.fn(),
}));

const SYSTEM = toIAddress('VRSC', 'VRSC');
const APP = toIAddress('app', 'VRSC');
const DELEGATE = toIAddress('delegate', 'VRSC');
const STORAGE = toIAddress('storage', 'VRSC');
const USER = {identityID: toIAddress('user', 'VRSC'), systemID: SYSTEM};
const OUTER_KEY = toIAddress('self-bucket', 'VRSC');
const GRANT_ID = '55'.repeat(32);
const ORIGINAL_HEIGHT = 90;
const SIGNED_HEIGHT = 100;
const READ_HEIGHT = 200;
const userKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 1),
  networks.verus,
);
const delegateKey = ECPair.fromPrivateKeyBuffer(
  Buffer.alloc(32, 2),
  networks.verus,
);
const appKey = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 3), networks.verus);
const now = () => Math.floor(Date.now() / 1000);
const recipient = new SaplingPaymentAddress({
  d: Buffer.alloc(11, 1),
  pkD: Buffer.alloc(32, 2),
});
const descriptor = () =>
  new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    epk: Buffer.alloc(32, 3),
    objectdata: Buffer.alloc(48, 4),
  });
const revision = (id, keys, marker, blockheight = ORIGINAL_HEIGHT) => ({
  status: 'active',
  blockheight,
  txid: marker.repeat(32),
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
    parent: SYSTEM,
  },
});

const signedRequest = () => {
  const request = new GenericRequest({
    createdAt: new BigNumber(now()),
    salt: Buffer.alloc(32, 1),
    appOrDelegatorID: CompactIAddressObject.fromAddress(APP),
    signature: new VerifiableSignatureData({
      version: VerifiableSignatureData.DEFAULT_VERSION,
      systemID: CompactIAddressObject.fromAddress(SYSTEM),
      identityID: CompactIAddressObject.fromAddress(DELEGATE),
    }),
    details: [
      new AuthenticationRequestOrdinalVDXFObject({
        data: new AuthenticationRequestDetails({
          expiryTime: new BigNumber(now() + 3600),
        }),
      }),
      new AppEncryptionRequestOrdinalVDXFObject({
        data: new AppEncryptionRequestDetails({
          encryptResponseToAddress: recipient,
        }),
      }),
    ],
  });
  request.setSigned();
  const signature = new IdentitySignature(
    networks.verus,
    2,
    EHashTypes.HASH_SHA256,
    SIGNED_HEIGHT,
    [],
    SYSTEM,
    DELEGATE,
  );
  signature.signHashOffline(
    request.getDetailsIdentitySignatureHash(SIGNED_HEIGHT),
    delegateKey,
  );
  const bytes = Buffer.alloc(7 + 66);
  signature.toBuffer(bytes);
  request.signature.signatureAsVch = bytes;
  return request;
};

const serve = (method, params) => {
  let result;
  const [id, height] = params;
  switch (method) {
    case 'getinfo':
      result = {
        chainid: SYSTEM,
        blocks: READ_HEIGHT,
        longestchain: READ_HEIGHT,
      };
      break;
    case 'getblock':
      result = {
        height: Number(id),
        hash: '44'.repeat(32),
        confirmations: 1,
        time: now(),
      };
      break;
    case 'getidentity':
      result =
        id === DELEGATE && height != null
          ? mockOriginalDelegate
          : mockIdentities[id];
      break;
    case 'getrawtransaction':
      result = mockRawTransactions.get(id);
      if (!result) throw new Error('Missing identity transaction fixture');
      if (!params[1]) result = result.hex;
      break;
    case 'getidentitycontent':
      result = {...mockIdentities[id], fromheight: 0, toheight: READ_HEIGHT};
      break;
    default:
      throw new Error(`Unexpected RPC read: ${method}`);
  }
  return JSON.parse(JSON.stringify({result, error: null}));
};

// Each recorded group represents one transport dispatch on a batch-capable
// endpoint. Its length is the logical RPC-command count, not another HTTP call.
const counts = () => ({
  logical: mockTransportGroups.reduce(
    (total, group) => total + group.length,
    0,
  ),
  transport: mockTransportGroups.length,
  byMethod: mockTransportGroups.flat().reduce(
    (totals, {method}) => ({
      ...totals,
      [method]: (totals[method] || 0) + 1,
    }),
    {},
  ),
});
const processRequest = request =>
  processAppEncryptionRequest({
    request,
    detailIndex: 1,
    responseSignerID: USER.identityID,
    responseSignerSystemID: USER.systemID,
    assertActive: () => {},
  });

beforeEach(() => {
  jest.clearAllMocks();
  invalidateAuthorizationCredentials();
  mockTransportGroups = [];
  mockServiceData = {};
  mockState = {
    authentication: {
      sessionEpoch: 1,
      signedIn: true,
      activeAccount: {
        accountHash: 'performance-profile',
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
  mockOriginalDelegate = revision(DELEGATE, [delegateKey], '11');
  mockIdentities = {
    [DELEGATE]: revision(DELEGATE, [delegateKey], '22', 110),
    [APP]: revision(APP, [appKey], '33'),
    [USER.identityID]: revision(USER.identityID, [userKey], '66'),
    [STORAGE]: revision(STORAGE, [userKey, delegateKey], '77'),
  };
  const marker = Buffer.alloc(32, ++fixtureNumber).toString('hex');
  mockOriginalDelegate.txid = marker;
  mockIdentities[APP].txid = marker;
  const original = authorizationIdentityTransaction(
    mockOriginalDelegate,
    'delegate',
  );
  const app = authorizationIdentityTransaction(mockIdentities[APP], 'app');
  mockOriginalDelegate = original.revision;
  mockIdentities[APP] = app.revision;
  mockRawTransactions = new Map([
    [original.revision.txid, original.transaction],
    [app.revision.txid, app.transaction],
  ]);
  Object.assign(mockIdentities[STORAGE].identity, {
    recoveryauthority: USER.identityID,
    revocationauthority: USER.identityID,
  });
  const binding = new AuthorizationStorageBindingCredential({
    version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
    grantID: GRANT_ID,
    relationshipIndex: 0,
    storageSystemID: SYSTEM,
    storageID: STORAGE,
  });
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS,
    grantID: GRANT_ID,
    signingSystemID: SYSTEM,
    delegateRevision: {
      txid: mockOriginalDelegate.txid,
      vout: 0,
    },
    delegatorRevision: {
      txid: mockIdentities[APP].txid,
      vout: mockIdentities[APP].vout,
    },
    storageManifestHash: deriveAppAuthorizationStorageManifest([binding]),
  });
  mockCredentials = [grant, binding].map(record => record.toCredential());
  mockIdentities[USER.identityID].identity.contentmultimap[OUTER_KEY] = [
    new VdxfUniValue({values: [{[DataDescriptorKey.vdxfid]: descriptor()}]})
      .toBuffer()
      .toString('hex'),
  ];

  mockClient = new VerusIdInterface(
    SYSTEM,
    'https://example.invalid',
    undefined,
    async request => {
      mockTransportGroups.push([
        {method: request.method, params: request.params || []},
      ]);
      return serve(request.method, request.params || []);
    },
  );
  // Custom transports omit Axios; retain its endpoint identity for cache binding.
  mockClient.interface.instance = {
    defaults: {baseURL: 'https://example.invalid'},
  };
  mockClient.interface.requestMany = async requests => {
    const group = requests.map(request => ({
      method: request.cmd,
      params: request.getParams(),
    }));
    mockTransportGroups.push(group);
    return group.map(({method, params}) => serve(method, params));
  };
  mockOpenKey.mockResolvedValue(userKey.toWIF());
  mockDeriveSelf.mockResolvedValue({
    outerKey: OUTER_KEY,
    ivk: '55'.repeat(32),
    address: recipient.toAddressString(),
  });
  mockDecrypt.mockImplementation(async () => mockCredentials);
  mockDeriveApp.mockResolvedValue({
    ivk: '66'.repeat(32),
    extfvk: new SaplingExtendedViewingKey({
      ak: Buffer.alloc(32, 7),
    }).toKeyString(),
    address: recipient.toAddressString(),
  });
  mockEncrypt.mockResolvedValue({
    encryptedDescriptor: descriptor(),
    encryptedDescriptorJson: descriptor().toJson(),
  });
  mockWriteStorage.mockImplementation(async update => {
    mockServiceData = JSON.parse(JSON.stringify(update(mockServiceData)));
    return mockServiceData;
  });
});

it('measures cold and warm complete delegated admission including U and shared-storage control', async () => {
  const request = signedRequest();
  await expect(
    assertAppEncryptionAuthorization(request, USER),
  ).resolves.toMatchObject({delegated: true});
  const cold = counts();
  mockTransportGroups = [];
  await expect(
    assertAppEncryptionAuthorization(request, USER),
  ).resolves.toMatchObject({delegated: true});
  const warm = counts();
  expect(mockDeriveSelf).toHaveBeenCalledTimes(1);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
  expect(mockOpenKey).toHaveBeenCalledTimes(2);
  expect(cold).toEqual({
    logical: 25,
    transport: 12,
    byMethod: {
      getblock: 4,
      getidentity: 13,
      getidentitycontent: 2,
      getinfo: 2,
      getrawtransaction: 4,
    },
  });
  expect(warm).toEqual({
    logical: 24,
    transport: 11,
    byMethod: {
      getblock: 4,
      getidentity: 13,
      getidentitycontent: 1,
      getinfo: 2,
      getrawtransaction: 4,
    },
  });
});

it('shares pre/post processing reads and starts a fresh signing phase', async () => {
  const request = signedRequest();
  const response = await processRequest(request);
  const processing = counts();
  expect(response.responseDetail).toBeInstanceOf(DataResponseOrdinalVDXFObject);
  expect(mockDeriveApp).toHaveBeenCalledTimes(1);
  expect(mockWriteStorage).toHaveBeenCalledTimes(1);
  expect(mockOpenKey).toHaveBeenCalledTimes(1);

  mockTransportGroups = [];
  const sign = jest.fn();
  await withAppEncryptionSigningKeys(request, USER, {}, sign);
  const signing = counts();
  expect(sign).toHaveBeenCalledTimes(1);
  expect(mockOpenKey).toHaveBeenCalledTimes(3);
  expect(mockDeriveSelf).toHaveBeenCalledTimes(1);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
  expect(processing).toEqual({
    logical: 25,
    transport: 12,
    byMethod: {
      getblock: 4,
      getidentity: 13,
      getidentitycontent: 2,
      getinfo: 2,
      getrawtransaction: 4,
    },
  });
  expect(signing).toEqual({
    logical: 24,
    transport: 11,
    byMethod: {
      getblock: 4,
      getidentity: 13,
      getidentitycontent: 1,
      getinfo: 2,
      getrawtransaction: 4,
    },
  });

  mockTransportGroups = [];
  const resumed = await processRequest(request);
  expect(resumed.responseDetail.toBuffer()).toEqual(
    response.responseDetail.toBuffer(),
  );
  expect(mockDeriveApp).toHaveBeenCalledTimes(1);
  expect(mockWriteStorage).toHaveBeenCalledTimes(1);
  expect(counts()).toEqual(signing);
});

it('rejects storage drift during native derivation before returning its encrypted result', async () => {
  const keys = mockDeriveApp.getMockImplementation();
  mockDeriveApp.mockImplementation(async (...args) => {
    mockIdentities[STORAGE].txid = '88'.repeat(32);
    mockIdentities[STORAGE].identity.primaryaddresses = [appKey.getAddress()];
    return keys(...args);
  });

  await expect(processRequest(signedRequest())).rejects.toThrow(
    /state changed/,
  );
  expect(mockDeriveApp).toHaveBeenCalledTimes(1);
});

it('uses fresh grant membership when signing after a successful processing phase', async () => {
  const request = signedRequest();
  await processRequest(request);
  mockIdentities[USER.identityID].txid = '88'.repeat(32);
  mockIdentities[USER.identityID].identity.contentmultimap = {};
  const sign = jest.fn();

  await expect(
    withAppEncryptionSigningKeys(request, USER, {}, sign),
  ).rejects.toThrow(/No current app approval/);
  expect(sign).not.toHaveBeenCalled();
});

it('rejects an orphaned approval transaction even when its credential and identity bytes are cached', async () => {
  const request = signedRequest();
  await assertAppEncryptionAuthorization(request, USER);

  // U and the current delegate are unchanged, but the approved historical
  // delegate transaction no longer belongs to the active chain.
  Object.assign(mockRawTransactions.get(mockOriginalDelegate.txid), {
    height: -1,
    confirmations: 0,
  });

  await expect(
    assertAppEncryptionAuthorization(request, USER),
  ).rejects.toThrow(/No current app approval/);
  expect(mockDecrypt).toHaveBeenCalledTimes(1);
});

it('keeps an orphaned grant and its storage binding available for removal', async () => {
  Object.assign(mockRawTransactions.get(mockOriginalDelegate.txid), {
    height: -1,
    confirmations: 0,
  });

  const view = await withAuthorizationReadScope({}, context =>
    loadAuthorizationCredentials(USER, context),
  );

  expect(view.grants).toHaveLength(1);
  expect(view.grants[0].identities).toBeUndefined();
  expect(view.grants[0].identityError).toMatch(/not confirmed/);
  expect(view.storageBindings).toHaveLength(1);
  expect(buildAuthorizationRemovals(view.grants)).toHaveLength(1);
});
