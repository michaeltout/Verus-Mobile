jest.mock('../../keychain/secureStore', () => ({
  SecureStorage: {getItem: jest.fn(), setItem: jest.fn(async () => {})},
}));

import {SecureStorage} from '../../keychain/secureStore';
import {SERVICE_STORAGE_INTERNAL_KEY} from '../../../../env/index';
import {storeServiceStoredDataForUser} from '../../asyncStore/serviceStoredDataStorage';

describe('service storage snapshots', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reuses a queued snapshot without another read and preserves other profiles', async () => {
    const snapshot = {
      account: {verusid: 'previous-ciphertext'},
      other: {verusid: 'other-profile-ciphertext'},
    };
    const updated = {verusid: 'new-ciphertext'};

    await expect(storeServiceStoredDataForUser(updated, 'account', snapshot))
      .resolves.toEqual(updated);

    expect(SecureStorage.getItem).not.toHaveBeenCalled();
    expect(SecureStorage.setItem).toHaveBeenCalledWith(
      SERVICE_STORAGE_INTERNAL_KEY,
      JSON.stringify({...snapshot, account: updated}),
    );
    expect(snapshot.account.verusid).toBe('previous-ciphertext');
  });

  it('loads the current root when no queued snapshot is supplied', async () => {
    const existing = {other: {verusid: 'other-profile-ciphertext'}};
    SecureStorage.getItem.mockResolvedValue(JSON.stringify(existing));

    await storeServiceStoredDataForUser({verusid: 'new-ciphertext'}, 'account');

    expect(SecureStorage.getItem).toHaveBeenCalledTimes(1);
    expect(SecureStorage.setItem).toHaveBeenCalledWith(
      SERVICE_STORAGE_INTERNAL_KEY,
      JSON.stringify({...existing, account: {verusid: 'new-ciphertext'}}),
    );
  });
});
