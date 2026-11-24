let mockState;
const mockGetSessionCredential = jest.fn();
const mockDecryptKey = jest.fn();

jest.mock('../../../store', () => ({
  __esModule: true,
  default: {getState: jest.fn(() => mockState)},
}));

jest.mock('../../keychain/keychain', () => ({
  getSessionCredential: mockGetSessionCredential,
  setSessionCredential: jest.fn(),
}));

jest.mock('../../seedCrypt', () => ({
  decryptkey: mockDecryptKey,
  encryptkey: jest.fn(),
}));

jest.mock('../../crypto/randomBytes', () => ({randomBytes: jest.fn()}));

const {
  requestPrivKey,
  requestSeeds,
  requestServiceStoredData,
} = require('../../auth/authBox');
const {VERUSID_SERVICE_ID} = require('../../constants/services');

const stateFor = (accountHash, sessionEpoch, suffix) => ({
  authentication: {
    // AUTHENTICATE_USER installs the account and session key before channel
    // initialization completes and SIGN_IN_USER flips this flag.
    signedIn: false,
    activeAccount: {
      accountHash,
      seeds: {dlight_private: `encrypted-seed-${suffix}`},
      keys: {
        VRSC: {vrpc: {encryptedPrivKey: `encrypted-${suffix}`}},
      },
    },
    sessionEpoch,
    sessionKey: `session-${suffix}`,
  },
});

describe('service-data session binding and current reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState = {
      ...stateFor('account-a', 1, 'a'),
      services: {stored: {[VERUSID_SERVICE_ID]: 'old-ciphertext'}},
    };
    mockGetSessionCredential.mockResolvedValue('credential-a');
    mockDecryptKey.mockImplementation((key, value) => {
      if (key === 'session-a' && value === 'credential-a') return 'password-a';
      if (key !== 'password-a') return false;
      if (value === 'old-ciphertext') {
        return JSON.stringify({linked_ids: {VRSC: {storage: 'storage@'}}});
      }
      if (value === 'new-ciphertext') {
        return JSON.stringify({
          linked_ids: {VRSC: {}},
          storage_ids: {VRSC: {storage: {name: 'storage@'}}},
        });
      }
      return false;
    });
  });

  it('reads a saved storage classification that changed while password access was pending', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const request = requestServiceStoredData(VERUSID_SERVICE_ID);

    mockState = {
      ...mockState,
      services: {stored: {[VERUSID_SERVICE_ID]: 'new-ciphertext'}},
    };
    credential.resolve('credential-a');

    await expect(request).resolves.toEqual({
      linked_ids: {VRSC: {}},
      storage_ids: {VRSC: {storage: {name: 'storage@'}}},
    });
    expect(mockDecryptKey.mock.calls).toEqual([
      ['session-a', 'credential-a'],
      ['password-a', 'new-ciphertext'],
    ]);
  });

  it.each(['other-account', 'new-session'])(
    'rejects a delayed read after switching to %s before decrypting data',
    async changed => {
      const credential = deferred();
      mockGetSessionCredential.mockReturnValueOnce(credential.promise);
      const request = requestServiceStoredData(VERUSID_SERVICE_ID);

      mockState = {
        ...stateFor(changed === 'other-account' ? 'account-b' : 'account-a', 2, 'b'),
        services: {stored: {[VERUSID_SERVICE_ID]: 'another-account-ciphertext'}},
      };
      credential.resolve('credential-a');

      await expect(request).rejects.toMatchObject({code: 'SESSION_CHANGED'});
      expect(mockDecryptKey).not.toHaveBeenCalled();
    },
  );

  it('returns empty data if the service was removed during password access', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const request = requestServiceStoredData(VERUSID_SERVICE_ID);

    mockState = {...mockState, services: {stored: {}}};
    credential.resolve('credential-a');

    await expect(request).resolves.toEqual({});
    expect(mockDecryptKey).toHaveBeenCalledTimes(1);
  });

  it('does not request a password for absent data or when one was already supplied', async () => {
    await expect(requestServiceStoredData('absent-service')).resolves.toEqual({});
    await expect(requestServiceStoredData(VERUSID_SERVICE_ID, 'password-a'))
      .resolves.toEqual({linked_ids: {VRSC: {storage: 'storage@'}}});

    expect(mockGetSessionCredential).not.toHaveBeenCalled();
    expect(mockDecryptKey).toHaveBeenCalledWith('password-a', 'old-ciphertext');
  });

  it('shares concurrent service reads without sharing mutable results or keeping plaintext cached', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const first = requestServiceStoredData(VERUSID_SERVICE_ID);
    const second = requestServiceStoredData(VERUSID_SERVICE_ID);
    const third = requestServiceStoredData(VERUSID_SERVICE_ID);
    credential.resolve('credential-a');

    const results = await Promise.all([first, second, third]);
    expect(mockGetSessionCredential).toHaveBeenCalledTimes(1);
    expect(mockDecryptKey.mock.calls).toEqual([
      ['session-a', 'credential-a'],
      ['password-a', 'old-ciphertext'],
    ]);
    results[0].linked_ids.VRSC.storage = 'changed@';
    expect(results[1].linked_ids.VRSC.storage).toBe('storage@');
    expect(results[2].linked_ids.VRSC.storage).toBe('storage@');

    await requestServiceStoredData(VERUSID_SERVICE_ID);
    expect(mockGetSessionCredential).toHaveBeenCalledTimes(2);
  });

  it('checks an explicitly supplied password independently of a shared pending read', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const pending = requestServiceStoredData(VERUSID_SERVICE_ID);

    await expect(requestServiceStoredData(VERUSID_SERVICE_ID, 'wrong-password'))
      .rejects.toThrow('Unable to decrypt service stored data');
    credential.resolve('credential-a');
    await expect(pending).resolves.toEqual({
      linked_ids: {VRSC: {storage: 'storage@'}},
    });
  });

  it('releases a failed shared read so a later read can retry', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const first = requestServiceStoredData(VERUSID_SERVICE_ID);
    const second = requestServiceStoredData(VERUSID_SERVICE_ID);
    const results = Promise.allSettled([first, second]);
    credential.resolve('invalid-credential');

    expect((await results).map(result => result.status)).toEqual([
      'rejected', 'rejected',
    ]);
    await expect(requestServiceStoredData(VERUSID_SERVICE_ID)).resolves.toEqual({
      linked_ids: {VRSC: {storage: 'storage@'}},
    });
    expect(mockGetSessionCredential).toHaveBeenCalledTimes(2);
  });
});

const deferred = () => {
  let resolve;
  const promise = new Promise(promiseResolve => {
    resolve = promiseResolve;
  });
  return {promise, resolve};
};

describe('private-key session binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState = stateFor('account-a', 1, 'a');
    mockDecryptKey.mockImplementation((key, value) => {
      if (key === 'session-a' && value === 'credential-a') return 'password-a';
      if (key === 'password-a' && value === 'encrypted-a') return 'private-a';
      if (key === 'password-a' && value === 'encrypted-seed-a') return 'seed-a';
      return false;
    });
  });

  it('does not return account-A key material after switching to account B', async () => {
    const credential = deferred();
    mockGetSessionCredential.mockReturnValueOnce(credential.promise);
    const request = requestPrivKey('VRSC', 'vrpc', {
      sessionScope: {
        sessionScoped: true,
        accountHash: 'account-a',
        sessionEpoch: 1,
      },
    });

    mockState = stateFor('account-b', 2, 'b');
    credential.resolve('credential-a');

    await expect(request).rejects.toMatchObject({code: 'SESSION_CHANGED'});
    expect(mockDecryptKey).not.toHaveBeenCalled();
  });

  it('decrypts the key while an authenticated account is initializing', async () => {
    mockGetSessionCredential.mockResolvedValue('credential-a');

    await expect(
      requestPrivKey('VRSC', 'vrpc', {
        sessionScope: {
          sessionScoped: true,
          accountHash: 'account-a',
          sessionEpoch: 1,
        },
      }),
    ).resolves.toBe('private-a');

    expect(mockDecryptKey.mock.calls).toEqual([
      ['session-a', 'credential-a'],
      ['password-a', 'encrypted-a'],
    ]);
  });

  it('retrieves the DLight seed while an authenticated account is initializing', async () => {
    mockGetSessionCredential.mockResolvedValue('credential-a');

    await expect(requestSeeds()).resolves.toEqual(
      expect.objectContaining({dlight_private: 'seed-a'}),
    );
  });

  it('rejects key access after sign-out starts', async () => {
    mockState = {
      ...mockState,
      authentication: {
        ...mockState.authentication,
        signedIn: false,
        sessionKey: null,
      },
    };

    await expect(
      requestPrivKey('VRSC', 'vrpc'),
    ).rejects.toThrow('You must be signed in to retrieve sensitive info');
    expect(mockGetSessionCredential).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
  });
});
