const mockGetIdentityContent = jest.fn();
const mockDecryptData = jest.fn();
const mockZGetEncryptionAddress = jest.fn();
const mockGetKeyMaterial = jest.fn();

jest.mock('../../CoinData/CoinDirectory', () => ({
  CoinDirectory: {
    getBasicCoinObj: () => ({
      id: 'VRSC',
      system_id: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
    }),
  },
}));

jest.mock('../../api/channels/verusid/requests/getIdentityContent', () => ({
  getIdentityContent: mockGetIdentityContent,
}));

jest.mock('../../api/channels/dlight/requests/decrypt', () => ({
  decryptData: mockDecryptData,
}));

jest.mock('../../api/channels/dlight/requests/zGetEncryptionAddress', () => ({
  zGetEncryptionAddress: mockZGetEncryptionAddress,
}));

jest.mock('../../crypto/getKeyMaterial', () => ({
  getKeyMaterial: mockGetKeyMaterial,
}));

jest.mock('../../crypto/encryptCredentials', () => ({
  getConditionID: () => Buffer.alloc(20, 1),
}));

const {
  Credential,
  CredentialKey,
  DataDescriptor,
  DataDescriptorKey,
  FqnVdxfUniValue,
  VdxfUniValue,
  toBase58Check,
} = require('verus-typescript-primitives');
const {
  I_ADDR_VERSION,
} = require('verus-typescript-primitives/dist/constants/vdxf');
const {
  getMissingCredentialKeys,
  getScopedCredentials,
  decryptAuthorizationCredentialValue,
} = require('../../deeplink/credentials/scopedCredentials');

const SYSTEM_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const IDENTITY_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const CREDENTIAL_KEY = 'iHh1FFVvcNb2mcBudD11umfKJXHbBbH6Sj';
const HASHED_KEY = toBase58Check(Buffer.alloc(20, 1), I_ADDR_VERSION);

const buildStoredCredentialEntry = (credential, descriptorOverrides = {}) => {
  const plaintextDescriptor = new DataDescriptor({
    objectdata: new VdxfUniValue({
      values: [{[CredentialKey.vdxfid]: credential}],
    }).toBuffer(),
  });

  const plaintext = new VdxfUniValue({
    values: [{[DataDescriptorKey.vdxfid]: plaintextDescriptor}],
  }).toBuffer();
  const directPlaintext = new VdxfUniValue({
    values: [{[CredentialKey.vdxfid]: credential}],
  }).toBuffer();

  const encryptedDescriptor = new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata: Buffer.alloc(32, 0xaa),
    epk: Buffer.alloc(32, 0xdd),
    ...descriptorOverrides,
  });

  const stored = FqnVdxfUniValue.fromVdxfUniValue(
    new VdxfUniValue({
      values: [{[DataDescriptorKey.vdxfid]: encryptedDescriptor}],
    }),
  )
    .toBuffer()
    .toString('hex');
  const storedJson = {
    [DataDescriptorKey.vdxfid]: encryptedDescriptor.toJson(),
  };

  return {plaintext, directPlaintext, stored, storedJson};
};

describe('scoped credential retrieval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetKeyMaterial.mockResolvedValue({extsk: '00'});
    mockZGetEncryptionAddress.mockResolvedValue({ivk: '11'.repeat(32)});
  });

  it('returns credentials matching requested key and scope', async () => {
    const credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['username', 'password'],
      scopes: [IDENTITY_ID],
    });
    const {plaintext, storedJson} = buildStoredCredentialEntry(credential);

    mockDecryptData.mockResolvedValue(plaintext.toString('hex'));
    mockGetIdentityContent.mockImplementation(() => ({
      result: {
        identity: {
          contentmultimap: {
            [HASHED_KEY]: [storedJson],
          },
        },
      },
    }));

    const credentials = await getScopedCredentials({
      systemID: SYSTEM_ID,
      identityAddress: IDENTITY_ID,
      scope: IDENTITY_ID,
      credentialKeys: [CREDENTIAL_KEY],
    });

    expect(mockGetIdentityContent).toHaveBeenCalledWith(SYSTEM_ID, IDENTITY_ID);
    expect(mockDecryptData).toHaveBeenCalledWith({
      ivkHex: '11'.repeat(32),
      ephemeralPublicKeyHex: 'dd'.repeat(32),
      ciphertextHex: 'aa'.repeat(32),
      symmetricKeyHex: null,
    });
    expect(credentials).toHaveLength(1);
    expect(credentials[0].credentialKey).toBe(CREDENTIAL_KEY);
  });

  it('filters credentials that do not match scope', async () => {
    const credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['username', 'password'],
      scopes: ['iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'],
    });
    const {plaintext, stored} = buildStoredCredentialEntry(credential);

    mockDecryptData.mockResolvedValue(plaintext.toString('hex'));
    mockGetIdentityContent.mockImplementation(() => ({
      result: {
        identity: {
          contentmultimap: {
            [HASHED_KEY]: [stored],
          },
        },
      },
    }));

    const credentials = await getScopedCredentials({
      systemID: SYSTEM_ID,
      identityAddress: IDENTITY_ID,
      scope: IDENTITY_ID,
      credentialKeys: [CREDENTIAL_KEY],
    });

    expect(credentials).toHaveLength(0);
    expect(getMissingCredentialKeys([CREDENTIAL_KEY], credentials)).toEqual([
      CREDENTIAL_KEY,
    ]);
  });

  it('returns credentials from direct decrypted credential plaintext', async () => {
    const credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['username', 'password'],
      scopes: [IDENTITY_ID],
    });
    const {directPlaintext, storedJson} =
      buildStoredCredentialEntry(credential);

    mockDecryptData.mockResolvedValue(directPlaintext.toString('hex'));
    mockGetIdentityContent.mockImplementation(() => ({
      result: {
        identity: {
          contentmultimap: {
            [HASHED_KEY]: [storedJson],
          },
        },
      },
    }));

    const credentials = await getScopedCredentials({
      systemID: SYSTEM_ID,
      identityAddress: IDENTITY_ID,
      scope: IDENTITY_ID,
      credentialKeys: [CREDENTIAL_KEY],
    });

    expect(credentials).toHaveLength(1);
    expect(credentials[0].credentialKey).toBe(CREDENTIAL_KEY);
  });

  it('uses descriptor IVK when present', async () => {
    const credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['username', 'password'],
      scopes: [IDENTITY_ID],
    });
    const descriptorIvk = Buffer.from('22'.repeat(32), 'hex');
    const {plaintext, storedJson} = buildStoredCredentialEntry(credential, {
      ivk: descriptorIvk,
    });

    mockDecryptData.mockResolvedValue(plaintext.toString('hex'));
    mockGetIdentityContent.mockImplementation(() => ({
      result: {
        identity: {
          contentmultimap: {
            [HASHED_KEY]: [storedJson],
          },
        },
      },
    }));

    const credentials = await getScopedCredentials({
      systemID: SYSTEM_ID,
      identityAddress: IDENTITY_ID,
      scope: IDENTITY_ID,
      credentialKeys: [CREDENTIAL_KEY],
    });

    expect(mockDecryptData).toHaveBeenCalledWith({
      ivkHex: '22'.repeat(32),
      ephemeralPublicKeyHex: 'dd'.repeat(32),
      ciphertextHex: 'aa'.repeat(32),
      symmetricKeyHex: null,
    });
    expect(credentials).toHaveLength(1);
  });

  it('continues after an undecryptable stored entry', async () => {
    const credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['username', 'password'],
      scopes: [IDENTITY_ID],
    });
    const {plaintext, storedJson} = buildStoredCredentialEntry(credential);

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDecryptData
      .mockRejectedValueOnce(new Error('Failed to decrypt data'))
      .mockResolvedValueOnce(plaintext.toString('hex'));
    mockGetIdentityContent.mockImplementation(() => ({
      result: {
        identity: {
          contentmultimap: {
            [HASHED_KEY]: [storedJson, storedJson],
          },
        },
      },
    }));

    const credentials = await getScopedCredentials({
      systemID: SYSTEM_ID,
      identityAddress: IDENTITY_ID,
      scope: IDENTITY_ID,
      credentialKeys: [CREDENTIAL_KEY],
    });

    expect(credentials).toHaveLength(1);
    console.warn.mockRestore();
  });
});

describe('authorization credential descriptor decoding', () => {
  let credential;
  let plaintext;
  let descriptor;
  const assertActive = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    credential = new Credential({
      version: Credential.VERSION_CURRENT,
      credentialKey: CREDENTIAL_KEY,
      credential: ['private authorization record'],
      scopes: [IDENTITY_ID],
    });
    ({plaintext} = buildStoredCredentialEntry(credential));
    descriptor = new DataDescriptor({
      flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
      epk: Buffer.alloc(32, 3),
      objectdata: Buffer.alloc(plaintext.length + 16, 4),
    });
    mockDecryptData.mockResolvedValue(plaintext.toString('hex'));
  });

  it('authenticates a native descriptor using the wallet self-channel', async () => {
    const bytes = new VdxfUniValue({
      values: [{[DataDescriptorKey.vdxfid]: descriptor}],
    }).toBuffer();
    const records = await decryptAuthorizationCredentialValue(
      bytes,
      '11'.repeat(32),
      assertActive,
    );
    expect(records[0].toBuffer()).toEqual(credential.toBuffer());
    expect(mockDecryptData).toHaveBeenCalledWith({
      ivkHex: '11'.repeat(32),
      ephemeralPublicKeyHex: descriptor.epk.toString('hex'),
      ciphertextHex: descriptor.objectdata.toString('hex'),
    });
    expect(assertActive).toHaveBeenCalledTimes(2);
  });

  it('reads ordinary compact credentials sharing the self bucket', async () => {
    const native = new VdxfUniValue({
      values: [{[DataDescriptorKey.vdxfid]: descriptor}],
    });
    const bytes = FqnVdxfUniValue.fromVdxfUniValue(native).toBuffer();
    const records = await decryptAuthorizationCredentialValue(
      bytes,
      '11'.repeat(32),
      assertActive,
    );
    expect(records[0].toBuffer()).toEqual(credential.toBuffer());
  });

  it.each(['AuthorizationCredential', 'AuthorizationStorageBindingCredential'])(
    'requires the current native and inner descriptor wrappers for %s',
    async type => {
      const {CREDENTIAL_KEY} = require('verus-typescript-primitives')[type];
      const record = new Credential({
        version: Credential.VERSION_CURRENT,
        credentialKey: CREDENTIAL_KEY,
        credential: {},
        scopes: {},
      });
      const plaintext = buildStoredCredentialEntry(record).plaintext;
      const encrypted = new DataDescriptor({
        flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
        epk: Buffer.alloc(32, 3),
        objectdata: Buffer.alloc(plaintext.length + 16, 4),
      });
      const native = new VdxfUniValue({
        values: [{[DataDescriptorKey.vdxfid]: encrypted}],
      });
      mockDecryptData.mockResolvedValue(plaintext.toString('hex'));
      await expect(
        decryptAuthorizationCredentialValue(
          FqnVdxfUniValue.fromVdxfUniValue(native).toBuffer(),
          '11'.repeat(32),
          assertActive,
        ),
      ).rejects.toThrow('dedicated app authorization');
      const accepted = await decryptAuthorizationCredentialValue(
        native.toBuffer(),
        '11'.repeat(32),
        assertActive,
      );
      expect(accepted[0].credentialKey).toBe(CREDENTIAL_KEY);

      const direct = buildStoredCredentialEntry(record).directPlaintext;
      mockDecryptData.mockResolvedValue(direct.toString('hex'));
      encrypted.objectdata = Buffer.alloc(direct.length + 16, 4);
      await expect(
        decryptAuthorizationCredentialValue(
          native.toBuffer(),
          '11'.repeat(32),
          assertActive,
        ),
      ).rejects.toThrow('dedicated app authorization');
    },
  );

  it.each(['ivk', 'ssk'])(
    'rejects a public %s in either wrapper before decrypting',
    async key => {
      descriptor[key] = Buffer.alloc(32, 5);
      const native = new VdxfUniValue({
        values: [{[DataDescriptorKey.vdxfid]: descriptor}],
      });
      for (const wrapper of [
        native,
        FqnVdxfUniValue.fromVdxfUniValue(native),
      ]) {
        await expect(
          decryptAuthorizationCredentialValue(
            wrapper.toBuffer(),
            '11'.repeat(32),
            assertActive,
          ),
        ).rejects.toThrow(/Invalid self-encrypted/);
      }
      expect(mockDecryptData).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple native descriptors and trailing bytes without a partial decrypt', async () => {
    const entry = {[DataDescriptorKey.vdxfid]: descriptor};
    const single = new VdxfUniValue({values: [entry]}).toBuffer();
    const multiple = new VdxfUniValue({values: [entry, entry]}).toBuffer();
    for (const bytes of [multiple, Buffer.concat([single, Buffer.from([0])])]) {
      await expect(
        decryptAuthorizationCredentialValue(
          bytes,
          '11'.repeat(32),
          assertActive,
        ),
      ).rejects.toThrow();
    }
    expect(mockDecryptData).not.toHaveBeenCalled();
  });
});
