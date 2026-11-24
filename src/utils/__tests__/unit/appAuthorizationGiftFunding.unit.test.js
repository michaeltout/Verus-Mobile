jest.mock('../../api/channels/verusid/callCreators', () => ({
  getCurrency: jest.fn(),
}));
jest.mock('../../api/channels/dlight/requests/encrypt', () => ({
  encryptData: jest.fn(),
}));

const BigNumber = require('bignumber.js');
const {
  ECPair,
  Transaction,
  TransactionBuilder,
  networks,
  smarttxs,
} = require('@bitgo/utxo-lib');
const {
  AuthorizationStorageBindingCredential,
  ContentMultiMap,
  ContentMultiMapRemove,
  ContentMultiMapRemoveKey,
  DataDescriptor,
  DataDescriptorKey,
  HASH_TYPE_BLAKE2B,
  Identity,
  IdentityScript,
  VdxfUniValue,
  nameAndParentAddrToIAddr,
} = require('verus-typescript-primitives');
const {hashData} = require('verus-typescript-primitives/dist/utils/hash');
const {VerusIdInterface, verifyIdentityUpdateFunding} = require('verusid-ts-client');
const feePolicy = require('verusid-ts-client/lib/identity/updateFundingVerification');
const {prepareAuthorizationGiftFunding} = require('../../appAuthorization/funding');
const {encryptData} = require('../../api/channels/dlight/requests/encrypt');
const {encryptCredentialToDescriptor} = require('../../crypto/encryptDataDescriptor');

const SYSTEM = nameAndParentAddrToIAddr('VRSCTEST');
const USER = nameAndParentAddrToIAddr('gift-recipient', SYSTEM);
const CREDENTIALS = nameAndParentAddrToIAddr('gift-credentials', SYSTEM);
const HEIGHT = 100;
const BALANCE = 200000000;
const donor = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 1), networks.verus);
const wallet = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 2), networks.verus);
const delegate = ECPair.fromPrivateKeyBuffer(Buffer.alloc(32, 3), networks.verus);
const AUTHENTICATION_TAG_BYTES = 16;
const EPHEMERAL_PUBLIC_KEY_BYTES = 32;

const replacementPayload = relationshipIndex =>
  new AuthorizationStorageBindingCredential({
    version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
    grantID: 'aa'.repeat(32),
    relationshipIndex,
    storageSystemID: nameAndParentAddrToIAddr('app-chain', SYSTEM),
    storageID: nameAndParentAddrToIAddr(`retained-storage-${relationshipIndex}`, SYSTEM),
  }).toPayload();

/** Real source bytes and identities; only the RPC transport is replaced. */
const fixture = ({storageCount = 1, credentialBytes = 128, parsed = false} = {}) => {
  const identity = name => Identity.fromJson({
    version: 3,
    flags: 0,
    name,
    parent: SYSTEM,
    systemid: SYSTEM,
    primaryaddresses: [donor.getAddress()],
    minimumsignatures: 1,
    recoveryauthority: USER,
    revocationauthority: USER,
    contentmap: {},
    contentmultimap: {},
    timelock: 0,
  });
  const before = [identity('gift-recipient'), ...Array.from(
    {length: storageCount},
    (_, index) => identity(`gift-storage-${index}`),
  )];
  const builder = new TransactionBuilder(networks.verus);
  builder.setVersion(4);
  builder.setVersionGroupId(0x892f2085);
  builder.setExpiryHeight(HEIGHT + 20);
  builder.addInput(Buffer.alloc(32, 9), 0);
  builder.addOutput(donor.getAddress(), BALANCE);
  before.forEach(current => builder.addOutput(
    IdentityScript.fromIdentity(current).toBuffer(),
    0,
  ));
  const source = builder.buildIncomplete();
  const after = before.map((current, index) => Identity.fromJson({
    ...current.toJson(),
    primaryaddresses: index
      ? [wallet.getAddress(), delegate.getAddress()]
      : [wallet.getAddress()],
  }));
  const storedCredential = new VdxfUniValue({values: [{
    [DataDescriptorKey.vdxfid]: new DataDescriptor({
      objectdata: Buffer.alloc(credentialBytes, 17),
    }),
  }]}).toBuffer();
  after[0].contentMultiMap = ContentMultiMap.fromJson({
    [CREDENTIALS]: [storedCredential.toString('hex')],
  });
  if (parsed) {
    const content = new ContentMultiMap();
    content.fromBuffer(after[0].contentMultiMap.toBuffer(), 0, true);
    after[0].contentMultiMap = content;
  }
  const updates = after.map(current => ({
    identity: current,
    rawIdentityTransaction: source.toHex(),
    identityTransactionHeight: HEIGHT - 1,
  }));
  const funding = [{
    address: donor.getAddress(),
    txid: source.getId(),
    outputIndex: 0,
    script: source.outs[0].script.toString('hex'),
    satoshis: BALANCE,
    height: HEIGHT - 1,
  }];
  const selection = {
    userIdentityID: USER,
    storageIdentities: after.slice(1).map(current => current.toJson()),
  };
  const allocate = () => prepareAuthorizationGiftFunding(
    updates,
    selection,
    funding,
    SYSTEM,
  );
  return {updates, funding, selection, source, storedCredential, allocate};
};

const readIdentity = output => {
  const script = new IdentityScript();
  script.fromBuffer(output.script);
  return script.getIdentity();
};

afterEach(() => {
  jest.restoreAllMocks();
  encryptData.mockReset();
});

test.each([false, true])('prices exact credential removal bytes (parsed: %s)', parsed => {
  const f = fixture({parsed});
  const originals = f.updates.map(update => update.identity.toBuffer());
  const selected = JSON.stringify(f.selection);
  const estimate = jest.spyOn(feePolicy, 'defaultIdentityUpdateFeeCap');
  const result = f.allocate();
  const removalTemplate = Transaction.fromHex(estimate.mock.calls[0][0], networks.verus);
  const user = readIdentity(removalTemplate.outs[0]);
  const content = new ContentMultiMap();
  content.fromBuffer(user.contentMultiMap.toBuffer(), 0, true);
  const removals = content.toJson()[ContentMultiMapRemoveKey.vdxfid];

  expect(removals).toEqual([{[ContentMultiMapRemoveKey.vdxfid]: {
    version: 1,
    action: ContentMultiMapRemove.ACTION_REMOVE_ALL_KEYVALUE.toNumber(),
    entrykey: CREDENTIALS,
    valuehash: hashData(f.storedCredential, HASH_TYPE_BLAKE2B.toNumber())
      .reverse().toString('hex'),
  }}]);
  expect(result.allocation.reserve.atomic).toBe(new BigNumber(
    feePolicy.identityUpdateFeeCap(estimate.mock.results[0].value),
  ).times('1.25').integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  expect(f.updates.map(update => update.identity.toBuffer())).toEqual(originals);
  expect(JSON.stringify(f.selection)).toBe(selected);
});

test('conserves every satoshi and assigns a split remainder to the last storage ID', () => {
  const f = fixture({storageCount: 2});
  f.funding[0].satoshis = BALANCE - 1;
  const result = f.allocate();
  const {reserve, storage} = result.allocation;
  const allocated = [reserve, ...storage].reduce(
    (total, entry) => total.plus(entry.atomic),
    new BigNumber(0),
  );

  expect(allocated.plus(result.nativeFee).toFixed(0)).toBe(String(BALANCE - 1));
  expect(result.allocatedAtomic).toBe(allocated.toFixed(0));
  expect(new BigNumber(storage[1].atomic).minus(storage[0].atomic).toFixed()).toBe('1');
  expect(result.changeAddress).toBe(storage[1].identityID);
  expect(result.currencyTransferOutputs.map(output => ({
    identityID: output.address.getAddressString(),
    atomic: output.currencies[SYSTEM],
  }))).toEqual([reserve, ...storage].map(({identityID, atomic}) => ({identityID, atomic})));
  [reserve, ...storage].forEach(entry => {
    expect(new BigNumber(entry.coins).times(100000000).toFixed(0)).toBe(entry.atomic);
  });
});

test('sends all remaining funds to the authorizing identity when there is no storage', () => {
  const f = fixture({storageCount: 0});
  const result = f.allocate();
  expect(result.allocation.storage).toEqual([]);
  expect(result.allocation.reserve.identityID).toBe(USER);
  expect(result.allocation.reserve.atomic).toBe(
    new BigNumber(BALANCE).minus(result.nativeFee).toFixed(0),
  );
  expect(result.currencyTransferOutputs).toHaveLength(1);
  expect(result.changeAddress).toBe(USER);
});

test('funds selected existing storage even when it needs no identity update', () => {
  const f = fixture({storageCount: 12});
  f.updates.splice(2);
  const estimate = jest.spyOn(feePolicy, 'defaultIdentityUpdateFeeCap');
  const result = f.allocate();
  const removalTemplate = Transaction.fromHex(estimate.mock.calls[0][0], networks.verus);

  expect(removalTemplate.outs.map(output => readIdentity(output).getIdentityAddress()))
    .toEqual([USER, ...f.selection.storageIdentities.map(json =>
      Identity.fromJson(json).getIdentityAddress(),
    )]);
  expect(result.allocation.storage).toHaveLength(12);
  expect(new BigNumber(result.allocation.reserve.atomic).gt('125000')).toBe(true);
  expect(result.allocation.storage.every(entry => new BigNumber(entry.atomic).gt(0))).toBe(true);
});

test('large credentials increase setup fees but retain fixed-size removal hashes', () => {
  const small = fixture({credentialBytes: 128}).allocate();
  const large = fixture({credentialBytes: 2200}).allocate();
  expect(new BigNumber(large.nativeFee).gt(small.nativeFee)).toBe(true);
  expect(large.allocation.reserve.atomic).toBe(small.allocation.reserve.atomic);
  expect(new BigNumber(large.allocation.storage[0].atomic)
    .lt(small.allocation.storage[0].atomic)).toBe(true);
});

test('existing storage approvals increase the removal reserve without increasing the setup fee', () => {
  const f = fixture();
  const fresh = f.allocate();
  const existingRemovals = Array.from({length: 40}, (_, index) =>
    ContentMultiMapRemove.removeStoredValue(
      CREDENTIALS,
      Buffer.from(`existing-storage-record-${index}`),
    ).toJson(),
  );
  f.selection.existingRemovals = existingRemovals;
  const estimate = jest.spyOn(feePolicy, 'defaultIdentityUpdateFeeCap');
  const result = f.allocate();
  const removalTemplate = Transaction.fromHex(estimate.mock.calls[0][0], networks.verus);
  const user = readIdentity(removalTemplate.outs[0]);
  const content = new ContentMultiMap();
  content.fromBuffer(user.contentMultiMap.toBuffer(), 0, true);
  const removals = content.toJson()[ContentMultiMapRemoveKey.vdxfid]
    .map(value => value[ContentMultiMapRemoveKey.vdxfid]);

  expect(removals.slice(0, existingRemovals.length)).toEqual(existingRemovals);
  expect(removals).toHaveLength(existingRemovals.length + 1);
  expect(result.nativeFee).toBe(fresh.nativeFee);
  expect(new BigNumber(result.allocation.reserve.atomic)
    .gt(fresh.allocation.reserve.atomic)).toBe(true);
  expect(result.allocation.reserve.atomic).toBe(new BigNumber(
    feePolicy.identityUpdateFeeCap(estimate.mock.results[0].value),
  ).times('1.25').integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  expect(new BigNumber(result.allocation.reserve.atomic)
    .plus(result.allocation.storage[0].atomic)
    .plus(result.nativeFee).toFixed(0)).toBe(String(BALANCE));
});

test.each([[0, 317], [0xffffffff, 326]])(
  'prices replacement descriptors using the encryption serialization at index %s',
  async (relationshipIndex, expectedBytes) => {
    const f = fixture();
    const payload = replacementPayload(relationshipIndex);
    const existingRemoval = ContentMultiMapRemove.removeStoredValue(
      CREDENTIALS,
      Buffer.from('inherited-storage-ciphertext'),
    ).toJson();
    f.selection.existingRemovals = [existingRemoval];
    f.selection.storageSystemReplacements = {outerKey: CREDENTIALS, payloads: [payload]};
    const selection = JSON.stringify(f.selection);
    const originals = f.updates.map(update => update.identity.toBuffer());
    const estimate = jest.spyOn(feePolicy, 'defaultIdentityUpdateFeeCap');

    f.allocate();
    expect(encryptData).not.toHaveBeenCalled();

    const template = Transaction.fromHex(estimate.mock.calls[0][0], networks.verus);
    const user = readIdentity(template.outs[0]);
    const content = new ContentMultiMap();
    content.fromBuffer(user.contentMultiMap.toBuffer(), 0, true);
    const placeholder = content.kvContent.getByAddress(CREDENTIALS)[0].toBuffer();
    const removals = content.toJson()[ContentMultiMapRemoveKey.vdxfid]
      .map(value => value[ContentMultiMapRemoveKey.vdxfid]);
    expect(removals).toHaveLength(2);
    expect(removals[0]).toEqual(existingRemoval);

    // Exercise the real encryption wrapper while replacing only the native cipher.
    encryptData.mockImplementation(async (_address, plaintext) => ({
      encryptedData: Buffer.alloc(
        Buffer.from(plaintext, 'hex').length + AUTHENTICATION_TAG_BYTES,
        1,
      ).toString('hex'),
      ephemeralPublicKey: Buffer.alloc(EPHEMERAL_PUBLIC_KEY_BYTES, 1).toString('hex'),
    }));
    const {encryptedDescriptor} = await encryptCredentialToDescriptor(
      'unused-native-test-address',
      AuthorizationStorageBindingCredential.fromPayload(payload).toCredential(),
    );
    const actual = new VdxfUniValue({
      values: [{[DataDescriptorKey.vdxfid]: encryptedDescriptor}],
    }).toBuffer();
    expect(placeholder.length).toBe(expectedBytes);
    expect(placeholder.length).toBe(actual.length);
    expect(JSON.stringify(f.selection)).toBe(selection);
    expect(f.updates.map(update => update.identity.toBuffer())).toEqual(originals);
  },
);

test('surviving non-root storage bindings increase only the removal reserve', () => {
  const f = fixture();
  const payloads = Array.from({length: 12}, (_, index) => replacementPayload(index));
  f.selection.existingRemovals = payloads.map((_, index) =>
    ContentMultiMapRemove.removeStoredValue(
      CREDENTIALS,
      Buffer.from(`inherited-storage-${index}`),
    ).toJson(),
  );
  const withoutReplacements = f.allocate();
  f.selection.storageSystemReplacements = {outerKey: CREDENTIALS, payloads};
  const estimate = jest.spyOn(feePolicy, 'defaultIdentityUpdateFeeCap');
  const result = f.allocate();

  expect(result.nativeFee).toBe(withoutReplacements.nativeFee);
  expect(new BigNumber(result.allocation.reserve.atomic)
    .gt(withoutReplacements.allocation.reserve.atomic)).toBe(true);
  expect(result.allocation.reserve.atomic).toBe(new BigNumber(
    feePolicy.identityUpdateFeeCap(estimate.mock.results[0].value),
  ).times('1.25').integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  expect(new BigNumber(result.allocation.reserve.atomic)
    .plus(result.allocation.storage[0].atomic)
    .plus(result.nativeFee).toFixed(0)).toBe(String(BALANCE));
  expect(encryptData).not.toHaveBeenCalled();

  f.selection.storageSystemReplacements.payloads = [];
  expect(f.allocate()).toEqual(withoutReplacements);
});

test.each([-1, 0.5, NaN, Infinity, '200000000', Number.MAX_SAFE_INTEGER, 2100000000000001])(
  'rejects unsupported reported native amounts: %s',
  satoshis => {
    const f = fixture();
    f.funding[0].satoshis = satoshis;
    expect(f.allocate).toThrow(/native amount/i);
  },
);

test('rejects an unsupported aggregate even when each input amount is supported', () => {
  const f = fixture();
  f.funding[0].satoshis = 2100000000000000;
  f.funding.push({...f.funding[0], satoshis: 1});
  expect(f.allocate).toThrow(/native amount/i);
});

test.each([false, true])('requires removal and storage funds (empty: %s)', empty => {
  const f = fixture({storageCount: 2});
  const priced = f.allocate();
  if (empty) f.funding.length = 0;
  else f.funding[0].satoshis = Number(priced.nativeFee)
    + Number(priced.allocation.reserve.atomic) + 1;
  expect(f.allocate).toThrow(/more native funds/i);
});

test.each(['missing user', 'duplicate storage', 'user as storage'])('rejects %s', kind => {
  const f = fixture();
  if (kind === 'missing user') f.updates.shift();
  if (kind === 'duplicate storage')
    f.selection.storageIdentities.push(f.selection.storageIdentities[0]);
  if (kind === 'user as storage')
    f.selection.storageIdentities = [f.updates[0].identity.toJson()];
  expect(f.allocate).toThrow(/identity|identities/i);
});

test('the real SDK signs the allocation and identity transfer in one transaction', async () => {
  const f = fixture({storageCount: 2});
  const allocation = f.allocate();
  const calls = [];
  const client = new VerusIdInterface(SYSTEM, 'https://offline.invalid', undefined, async request => {
    calls.push(request.method);
    if (request.method === 'getrawtransaction' && request.params[0] === f.source.getId()) {
      return {result: f.source.toHex(), error: null};
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const built = await client.createUpdateIdentitiesTransaction(
    f.updates,
    allocation.changeAddress,
    f.funding,
    {
      chainIAddr: SYSTEM,
      currentHeight: HEIGHT,
      parseVdxfObjects: false,
      useAllFundingInputs: true,
      nativeFee: allocation.nativeFee,
      currencyTransferOutputs: allocation.currencyTransferOutputs,
    },
  );
  const transaction = Transaction.fromHex(built.hex, networks.verus);
  const payments = transaction.outs.slice(f.updates.length).map(output => ({
    identityID: smarttxs.unpackOutput(output, SYSTEM).destinations[0],
    atomic: String(output.value),
  }));
  const reviewed = [allocation.allocation.reserve, ...allocation.allocation.storage];
  expect(payments).toEqual(reviewed.map(({identityID, atomic}) => ({identityID, atomic})));
  expect(built.fundingApproval.nativeFee).toBe(allocation.nativeFee);
  expect(transaction.outs).toHaveLength(f.updates.length + reviewed.length);
  expect(calls).toEqual(['getrawtransaction']);

  const lockContext = {chainId: SYSTEM, nextBlockHeight: HEIGHT + 1};
  const signed = client.signUpdateIdentityTransaction(
    built.hex,
    built.utxos,
    built.utxos.map(() => [donor.toWIF()]),
    built.fundingApproval,
    lockContext,
  );
  expect(verifyIdentityUpdateFunding(
    built.fundingApproval,
    signed,
    built.utxos,
    lockContext,
  )).toBe(true);
});
