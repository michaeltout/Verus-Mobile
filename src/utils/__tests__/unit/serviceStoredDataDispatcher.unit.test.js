let mockStoredData = {};
let mockState = {
  authentication: {
    activeAccount: {accountHash: 'account'},
    sessionEpoch: 1,
  },
};

jest.mock('../../../store', () => ({
  __esModule: true,
  default: {
    dispatch: jest.fn(),
    getState: jest.fn(() => mockState),
  },
}));

jest.mock('../../asyncStore/serviceStoredDataStorage', () => ({
  deleteServiceStoredDataForUser: jest.fn(),
  loadServiceStoredData: jest.fn(async () => ({
    account: {...mockStoredData},
    other: {giftcards: 'other-profile-ciphertext'},
  })),
  loadServiceStoredDataForUser: jest.fn(async () => ({
    ...mockStoredData,
  })),
  storeServiceStoredDataForUser: jest.fn(async data => {
    await Promise.resolve();
    mockStoredData = {...data};
    return data;
  }),
}));

jest.mock('../../auth/authBox', () => ({
  requestPassword: jest.fn(async () => 'password'),
  requestServiceStoredData: jest.fn(),
}));

jest.mock('../../seedCrypt', () => ({
  decryptkey: jest.fn((_password, value) => value),
  encryptkey: jest.fn(async (_password, value) => value),
}));

jest.mock('../../services/WyreProvider', () => ({
  __esModule: true,
  default: {
    reset: jest.fn(),
  },
}));

jest.mock('../../../actions/actions/services/creators/services', () => ({
  setServiceStored: jest.fn(data => ({type: 'SET_SERVICE_STORED', data})),
}));

import {modifyServiceStoredDataForUser} from '../../../actions/actions/services/dispatchers/services';
import {
  loadServiceStoredData,
  loadServiceStoredDataForUser,
  storeServiceStoredDataForUser,
} from '../../asyncStore/serviceStoredDataStorage';
import {encryptkey} from '../../seedCrypt';
import store from '../../../store';

describe('service stored data dispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoredData = {
      giftcards: JSON.stringify({
        cards: {},
      }),
    };
    mockState = {
      authentication: {
        activeAccount: {accountHash: 'account'},
        sessionEpoch: 1,
      },
    };
  });

  it('serializes functional updates so concurrent writes are merged', async () => {
    const first = modifyServiceStoredDataForUser(
      current => ({
        ...current,
        first: true,
      }),
      'giftcards',
      'account',
    );
    const second = modifyServiceStoredDataForUser(
      current => ({
        ...current,
        second: true,
      }),
      'giftcards',
      'account',
    );

    await Promise.all([first, second]);

    expect(JSON.parse(mockStoredData.giftcards)).toEqual({
      cards: {},
      first: true,
      second: true,
    });
    expect(loadServiceStoredData).toHaveBeenCalledTimes(2);
    expect(loadServiceStoredDataForUser).not.toHaveBeenCalled();
    expect(storeServiceStoredDataForUser).toHaveBeenCalledTimes(2);
    expect(storeServiceStoredDataForUser.mock.calls[0][2]).toEqual({
      account: {giftcards: JSON.stringify({cards: {}})},
      other: {giftcards: 'other-profile-ciphertext'},
    });
  });

  it('does not encrypt, persist, or publish an unchanged functional update', async () => {
    await expect(modifyServiceStoredDataForUser(
      current => current,
      'giftcards',
      'account',
    )).resolves.toEqual({cards: {}});

    expect(loadServiceStoredData).toHaveBeenCalledTimes(1);
    expect(encryptkey).not.toHaveBeenCalled();
    expect(storeServiceStoredDataForUser).not.toHaveBeenCalled();
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it('does not persist an originating account update after the session changes', async () => {
    let releaseUpdater;
    const updaterStarted = new Promise(resolve => {
      releaseUpdater = resolve;
    });
    let continueUpdater;
    const updaterMayFinish = new Promise(resolve => {
      continueUpdater = resolve;
    });
    const requestContext = {
      sessionScope: {
        sessionScoped: true,
        accountHash: 'account',
        sessionEpoch: 1,
      },
    };
    const update = modifyServiceStoredDataForUser(
      async current => {
        releaseUpdater();
        await updaterMayFinish;
        return {...current, fromAccountA: true};
      },
      'giftcards',
      'account',
      requestContext,
    );

    await updaterStarted;
    mockState = {
      authentication: {
        activeAccount: {accountHash: 'account-b'},
        sessionEpoch: 2,
      },
    };
    continueUpdater();

    await expect(update).rejects.toMatchObject({code: 'SESSION_CHANGED'});
    expect(storeServiceStoredDataForUser).not.toHaveBeenCalled();
  });
});
