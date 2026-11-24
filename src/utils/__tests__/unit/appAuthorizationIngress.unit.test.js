const mockStorage = new Map();
jest.mock('../../keychain/secureStore', () => ({
  SecureStorage: {
    getItem: jest.fn(async key => mockStorage.get(key)),
    setItem: jest.fn(async (key, value) => {
      mockStorage.set(key, value);
    }),
  },
}));

const BN = require('bn.js');
const {createAppAuthorizationRequest} = require('verusid-ts-client');
const {
  AppAuthorizationRequestDetails,
  CompactIAddressObject,
  SaplingPaymentAddress,
  GenericRequest,
  GENERIC_REQUEST_DEEPLINK_VDXF_KEY,
  I_ADDR_VERSION,
  SpendableKeyDetails,
  toBase58Check,
} = require('verus-typescript-primitives');
const {
  setDeeplinkData,
  setDeeplinkUrl,
} = require('../../../actions/actions/deeplink/creators/deeplink');
const {
  readAuthorizationTransport,
} = require('../../deeplink/privateRequestTransport');
const {
  getPendingDeeplinkRequest,
  savePendingDeeplinkRequest,
  PENDING_REQUEST_KIND_APP_AUTHORIZATION,
} = require('../../deeplink/pendingDeeplinkStorage');
const {
  validateAppAuthorizationRequestVDXFObject,
} = require('../../deeplink/validator/appAuthorizationRequestValidator');

const address = marker =>
  toBase58Check(Buffer.alloc(20, marker), I_ADDR_VERSION);
const EXPIRY_SECONDS = 3600;
const gift = () =>
  new SpendableKeyDetails({
    data: Buffer.alloc(32, 19),
    seedFormat: SpendableKeyDetails.SEED_FORMAT_BIP39,
    encryptionFormat: SpendableKeyDetails.ENCRYPTION_FORMAT_NONE,
  });
const request = (overrides = {}) => {
  const createdAt = Math.floor(Date.now() / 1000);
  const result = createAppAuthorizationRequest({
    appID: address(1),
    delegate: {identityID: address(2), systemID: address(3)},
    requestID: address(4),
    createdAt: new BN(createdAt),
    expiryTime: new BN(createdAt + EXPIRY_SECONDS),
    gift: gift(),
    encryptResponseToAddress: new SaplingPaymentAddress({
      d: Buffer.alloc(11, 1),
      pkD: Buffer.alloc(32, 2),
    }),
    ...overrides,
  });
  // Structural tests deliberately do not pretend to verify cryptography.
  result.signature.signatureAsVch = Buffer.from('fixture signature');
  return result;
};

beforeEach(() => {
  mockStorage.clear();
});

it('keeps authorization URLs and binary requests out of Redux action payloads', () => {
  const authorization = request();
  const uri = authorization.toWalletDeeplinkUri();
  const requestHex = authorization.toBuffer().toString('hex');
  const urlAction = setDeeplinkUrl(uri);
  const dataAction = setDeeplinkData('generic', requestHex);

  expect(urlAction.payload.url).toEqual({privateAuthorizationRequest: true});
  expect(dataAction.payload.data).toEqual({privateAuthorizationRequest: true});
  expect(JSON.stringify(urlAction)).not.toContain(uri);
  expect(JSON.stringify(dataAction)).not.toContain(requestHex);
  expect(readAuthorizationTransport(urlAction.payload.url)).toBe(uri);
  expect(readAuthorizationTransport(dataAction.payload.data)).toBe(requestHex);
});

it('preserves nested gift material in encrypted pending storage under authorization', async () => {
  const original = request();
  const saved = await savePendingDeeplinkRequest({
    requestBufferString: original.toBuffer().toString('hex'),
  });
  expect(saved.requestKind).toBe(PENDING_REQUEST_KIND_APP_AUTHORIZATION);
  const restored = new GenericRequest();
  restored.fromBuffer(
    Buffer.from(
      (await getPendingDeeplinkRequest(saved.id)).requestBufferString,
      'hex',
    ),
  );
  expect(restored.details[1].data.gift.data).toEqual(
    original.details[1].data.gift.data,
  );
  expect(restored.toBuffer()).toEqual(original.toBuffer());
});

it('rejects a lost private handle instead of treating it as a request', () => {
  expect(() =>
    readAuthorizationTransport({privateAuthorizationRequest: true}),
  ).toThrow('reopened');
});

it('keeps malformed and oversized wallet URLs private before the parser rejects them', () => {
  const uri = `verus://1/${'sensitive-gift'.repeat(300)}`;
  const action = setDeeplinkUrl(uri);
  expect(action.payload.url).toEqual({privateAuthorizationRequest: true});
  expect(readAuthorizationTransport(action.payload.url)).toBe(uri);
  expect(JSON.stringify(action)).not.toContain('sensitive-gift');
});

it('does not decode direct binary generic requests before protecting their payload', () => {
  const malformed = 'aabbccddeeff';
  const action = setDeeplinkData(
    GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid,
    malformed,
  );
  expect(action.payload.data).toEqual({privateAuthorizationRequest: true});
  expect(readAuthorizationTransport(action.payload.data)).toBe(malformed);
  expect(JSON.stringify(action)).not.toContain(malformed);
});

it('admits a supported nested gift and rejects reordered bootstrap details', () => {
  const valid = request();
  expect(() =>
    validateAppAuthorizationRequestVDXFObject(valid, 1),
  ).not.toThrow();
  valid.details.reverse();
  expect(() => validateAppAuthorizationRequestVDXFObject(valid, 1)).toThrow(
    'exactly authentication',
  );
});

it.each([
  'permissions flag',
  'permissions property',
  'missing expiry',
  'expired',
])('rejects %s before gift execution', mutation => {
  const invalid = request();
  if (mutation === 'permissions flag')
    invalid.details[1].data.flags =
      AppAuthorizationRequestDetails.FLAG_CONTAINS_PERMISSIONS;
  if (mutation === 'permissions property')
    invalid.details[1].data.permissions = {};
  if (mutation === 'missing expiry')
    invalid.details[0].data.expiryTime = undefined;
  if (mutation === 'expired') invalid.details[0].data.expiryTime = new BN(1);
  expect(() => validateAppAuthorizationRequestVDXFObject(invalid, 1)).toThrow();
});

it('includes encryption by default while keeping the complete request private', async () => {
  const original = request();
  expect(original.details).toHaveLength(3);
  expect(
    original.details[1].data.version.eq(
      AppAuthorizationRequestDetails.VERSION_CURRENT,
    ),
  ).toBe(true);
  expect(() =>
    validateAppAuthorizationRequestVDXFObject(original, 1),
  ).not.toThrow();
  const bytes = original.toBuffer().toString('hex');
  const action = setDeeplinkData(
    GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid,
    bytes,
  );
  expect(action.payload.data).toEqual({privateAuthorizationRequest: true});
  expect(JSON.stringify(action)).not.toContain(bytes);
  const saved = await savePendingDeeplinkRequest({requestBufferString: bytes});
  expect(saved.requestKind).toBe(PENDING_REQUEST_KIND_APP_AUTHORIZATION);
  expect((await getPendingDeeplinkRequest(saved.id)).requestBufferString).toBe(
    bytes,
  );
});

it.each([
  'unsupported version',
  'missing channel',
  'duplicate channel',
  'wrong ID',
  'wrong recipient',
  'unknown flags',
])(
  'rejects a malformed combined request (%s) before gift execution',
  mutation => {
    const invalid = request();
    const encryption = invalid.details[2].data;
    if (mutation === 'unsupported version')
      invalid.details[1].data.version =
        AppAuthorizationRequestDetails.VERSION_CURRENT.addn(1);
    if (mutation === 'missing channel') invalid.details.pop();
    if (mutation === 'duplicate channel')
      invalid.details.push(invalid.details[2]);
    if (mutation === 'wrong ID')
      encryption.requestID = CompactIAddressObject.fromAddress(address(5));
    if (mutation === 'wrong recipient')
      encryption.encryptResponseToAddress = new SaplingPaymentAddress({
        d: Buffer.alloc(11, 2),
        pkD: Buffer.alloc(32, 3),
      });
    if (mutation === 'unknown flags')
      encryption.flags = encryption.flags.or(new BN(16));
    expect(() =>
      validateAppAuthorizationRequestVDXFObject(invalid, 1),
    ).toThrow();
  },
);
