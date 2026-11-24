import {
  getDisplayDataFromVerusPayInvoiceDetails,
  getVerusPayInvoiceSignerContext,
  handleVerusPayInvoiceDetailsVDXFObject,
} from '../../deeplink/handlers/verusPayInvoiceDetailsHandler';
import {getSignedRequestDisplayProps} from '../../deeplink/handlers/requestDisplayUtils';
import {getCurrency, getIdentity} from '../../api/channels/verusid/callCreators';
import {extractVerusPayInvoiceFromSigAndSigner, getBlock, getInfo} from '../../api/channels/vrpc/callCreators';
import {toIAddress, VerusPayInvoiceDetails, VerusPayInvoiceDetailsOrdinalVDXFObject} from 'verus-typescript-primitives';

jest.mock('../../deeplink/handlers/requestDisplayUtils', () => ({getSignedRequestDisplayProps: jest.fn()}));
jest.mock('../../api/channels/verusid/callCreators', () => ({getCurrency: jest.fn(), getIdentity: jest.fn()}));
jest.mock('../../api/channels/vrpc/callCreators', () => ({
  extractVerusPayInvoiceFromSigAndSigner: jest.fn(), getBlock: jest.fn(), getInfo: jest.fn(),
}));
jest.mock('../../CoinData/CoinDirectory', () => ({CoinDirectory: {
  getBasicCoinObj: () => ({system_id: 'root-system', currency_id: 'root-currency', vrpc_endpoints: ['https://root.invalid']}),
}}));
jest.mock('../../vrpc/vrpcInterface', () => ({__esModule: true, default: {initEndpoint: jest.fn()}}));

const invoiceDetails = () => {
  const details = new VerusPayInvoiceDetails({requestedcurrencyid: toIAddress('VRSC', 'VRSC')});
  details.setFlags({acceptsAnyAmount: true, acceptsAnyDestination: true});
  return details;
};

beforeEach(() => {
  jest.clearAllMocks();
  getCurrency.mockResolvedValue({result: {currencyid: 'root-currency'}});
  getInfo.mockResolvedValue({result: {blocks: 100}});
  getIdentity.mockResolvedValue({result: {fullyqualifiedname: 'standalone.VRSC@'}});
  extractVerusPayInvoiceFromSigAndSigner.mockResolvedValue({height: 99});
  getBlock.mockResolvedValue({result: {time: 123}});
  getSignedRequestDisplayProps.mockResolvedValue({
    signerIdentityID: 'delegate', signerFqn: 'delegate@', signerSystemID: 'pbaas-system',
    appOrDelegatorID: 'app', appOrDelegatorFqn: 'app@', sigtime: 456,
  });
});

describe('VerusPay invoice signer context', () => {
  it('keeps signer system and signature in their correct fields', () => {
    const signature = Buffer.from('signed invoice');
    const request = {
      signature: {
        identityID: {toIAddress: () => 'identity-id'},
        systemID: {toIAddress: () => 'system-id'},
        signatureAsVch: signature,
      },
    };

    expect(getVerusPayInvoiceSignerContext(request)).toEqual({
      signingID: 'identity-id',
      signerSystemID: 'system-id',
      signatureAsVch: signature.toString('base64'),
    });
  });
});

it.each([false, true])('preserves generic invoice display and resolves envelope attribution only when signed (%s)', async signed => {
  const details = invoiceDetails();
  const request = {
    isSigned: () => signed,
    getDetails: () => new VerusPayInvoiceDetailsOrdinalVDXFObject({data: details}),
  };
  const {displayProps} = await handleVerusPayInvoiceDetailsVDXFObject(request, null, 0);

  expect(displayProps.detailsBufferString).toBe(details.toBuffer().toString('hex'));
  expect(displayProps.destinationDisplay).toBe('any destination');
  expect(extractVerusPayInvoiceFromSigAndSigner).not.toHaveBeenCalled();
  expect(getIdentity).not.toHaveBeenCalled();
  if (signed) {
    expect(getSignedRequestDisplayProps).toHaveBeenCalledTimes(1);
    expect(getSignedRequestDisplayProps).toHaveBeenCalledWith(request);
    expect(displayProps).toMatchObject({
      isSigned: true, signerIdentityID: 'delegate', signerSystemID: 'pbaas-system',
      appOrDelegatorID: 'app', appOrDelegatorFqn: 'app@', sigtime: 456,
    });
  } else {
    expect(getSignedRequestDisplayProps).not.toHaveBeenCalled();
    expect(displayProps.isSigned).toBeFalsy();
    expect(displayProps.appOrDelegatorID).toBeUndefined();
  }
});

it('keeps the standalone invoice signature context independent of generic app attribution', async () => {
  const context = {signingID: 'standalone', signerSystemID: 'root-system', signatureAsVch: 'signature'};
  const display = await getDisplayDataFromVerusPayInvoiceDetails(invoiceDetails(), context);

  expect(display).toMatchObject({isSigned: true, signerFqn: 'standalone@', signerSystemID: 'root-system', sigtime: 123});
  expect(display.appOrDelegatorID).toBeUndefined();
  expect(getSignedRequestDisplayProps).not.toHaveBeenCalled();
  expect(extractVerusPayInvoiceFromSigAndSigner).toHaveBeenCalledWith(expect.any(Object), 'standalone', 'signature');
});
