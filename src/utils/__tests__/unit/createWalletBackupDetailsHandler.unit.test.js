const mockGetState = jest.fn();
const mockGetWalletBackupCompletionKey = jest.fn();
const mockHasCompletedWalletBackupRequest = jest.fn();
const mockSignerDisplay = jest.fn();

jest.mock('../../deeplink/handlers/requestDisplayUtils', () => ({
  getSignedRequestDisplayProps: (...args) => mockSignerDisplay(...args),
}));

jest.mock('../../../store', () => ({
  __esModule: true,
  default: {
    getState: mockGetState,
  },
}));

jest.mock('../../walletBackup/walletBackupCompletionStorage', () => ({
  getWalletBackupCompletionKey: mockGetWalletBackupCompletionKey,
  hasCompletedWalletBackupRequest: mockHasCompletedWalletBackupRequest,
}));

const {
  CreateWalletBackupDetails,
  CreateWalletBackupDetailsOrdinalVDXFObject,
  CompactIAddressObject,
  GenericRequest,
  GenericResponse,
  SpendableKeyDetails,
  SpendableKeyDetailsOrdinalVDXFObject,
  VerifiableSignatureData,
} = require('verus-typescript-primitives');
const {
  handleCreateWalletBackupDetailsVDXFObject,
} = require('../../deeplink/handlers/createWalletBackupDetailsHandler');
const {
  handleSpendableKeyDetailsVDXFObject,
} = require('../../deeplink/handlers/spendableKeyDetailsHandler');

const buildBackupDetail = () =>
  new CreateWalletBackupDetailsOrdinalVDXFObject({
    data: new CreateWalletBackupDetails({
      backupType: CreateWalletBackupDetails.NFC_NDEF_BACKUP,
    }),
  });

const buildSpendableKeyDetail = () =>
  new SpendableKeyDetailsOrdinalVDXFObject({
    data: new SpendableKeyDetails(),
  });

const buildRequest = ({details, testnet = true}) =>
  new GenericRequest({
    details,
    flags: testnet ? GenericRequest.FLAG_IS_TESTNET : GenericRequest.BASE_FLAGS,
  });

describe('create wallet backup details handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignerDisplay.mockResolvedValue({
      signerIdentityID: 'delegate-id',
      signerFqn: 'delegate@',
      appOrDelegatorID: 'app-id',
      appOrDelegatorFqn: 'app@',
    });
    mockGetWalletBackupCompletionKey.mockReturnValue('completion-key');
    mockHasCompletedWalletBackupRequest.mockResolvedValue(false);
    mockGetState.mockReturnValue({
      authentication: {
        activeAccount: {
          accountHash: 'active-account-hash',
        },
        accounts: [
          {
            id: 'test-profile',
            testnetOverrides: {
              VRSC: true,
            },
          },
        ],
      },
      deeplink: {
        passthrough: {
          fromNfc: true,
        },
      },
    });
  });

  it('preempts combined NFC backup and spendable key requests when a matching profile exists', async () => {
    const backupDetail = buildBackupDetail();
    const request = buildRequest({
      details: [backupDetail, buildSpendableKeyDetail()],
      testnet: true,
    });

    const result = await handleCreateWalletBackupDetailsVDXFObject(
      request,
      new GenericResponse(),
      0,
    );

    expect(result.displayProps.showSpendableKeyBackupChoice).toBe(true);
    expect(mockSignerDisplay).not.toHaveBeenCalled();
  });

  it.each([
    ['backup', buildBackupDetail, handleCreateWalletBackupDetailsVDXFObject],
    ['gift', buildSpendableKeyDetail, handleSpendableKeyDetailsVDXFObject],
  ])('retains signer and delegator attribution for a scoped %s request', async (_, buildDetail, handle) => {
    const request = new GenericRequest({
      appOrDelegatorID: CompactIAddressObject.fromFQN('app@', 'VRSC'),
      signature: new VerifiableSignatureData({
        identityID: CompactIAddressObject.fromFQN('delegate@', 'VRSC'),
        systemID: CompactIAddressObject.fromFQN('VRSC@', 'VRSC'),
        signatureAsVch: Buffer.from('signed'),
      }),
      details: [buildDetail()],
    });
    request.setSigned();

    const result = await handle(request, new GenericResponse(), 0);
    expect(mockSignerDisplay).toHaveBeenCalledWith(request);
    expect(result.displayProps).toMatchObject({
      signerIdentityID: 'delegate-id',
      signerFqn: 'delegate@',
      appOrDelegatorID: 'app-id',
      appOrDelegatorFqn: 'app@',
    });
  });

  it('does not preempt non-NFC requests', async () => {
    mockGetState.mockReturnValue({
      authentication: {
        activeAccount: {
          accountHash: 'active-account-hash',
        },
        accounts: [
          {
            id: 'test-profile',
            testnetOverrides: {
              VRSC: true,
            },
          },
        ],
      },
      deeplink: {
        passthrough: null,
      },
    });

    const backupDetail = buildBackupDetail();
    const request = buildRequest({
      details: [backupDetail, buildSpendableKeyDetail()],
      testnet: true,
    });

    const result = await handleCreateWalletBackupDetailsVDXFObject(
      request,
      new GenericResponse(),
      0,
    );

    expect(result.displayProps.showSpendableKeyBackupChoice).toBe(false);
  });

  it('does not preempt combined NFC requests without a matching profile', async () => {
    mockGetState.mockReturnValue({
      authentication: {
        activeAccount: {
          accountHash: 'active-account-hash',
        },
        accounts: [
          {
            id: 'mainnet-profile',
            testnetOverrides: {},
          },
        ],
      },
      deeplink: {
        passthrough: {
          fromNfc: true,
        },
      },
    });

    const backupDetail = buildBackupDetail();
    const request = buildRequest({
      details: [backupDetail, buildSpendableKeyDetail()],
      testnet: true,
    });

    const result = await handleCreateWalletBackupDetailsVDXFObject(
      request,
      new GenericResponse(),
      0,
    );

    expect(result.displayProps.showSpendableKeyBackupChoice).toBe(false);
  });
});
