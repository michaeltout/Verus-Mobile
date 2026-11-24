import {getSignedRequestDisplayProps} from '../../deeplink/handlers/requestDisplayUtils';
import {CoinDirectory} from '../../CoinData/CoinDirectory';
import {getIdentity} from '../../api/channels/verusid/callCreators';
import {getSignatureInfo} from '../../api/channels/vrpc/requests/getSignatureInfo';
import {getBlock} from '../../api/channels/vrpc/requests/getBlock';
import VrpcProvider from '../../vrpc/vrpcInterface';
import {AuthenticationRequestDetails, AuthenticationRequestOrdinalVDXFObject} from 'verus-typescript-primitives';
import {handleAuthenticationRequestDetailsVDXFObject} from '../../deeplink/handlers/authenticationRequestDetailsHandler';

jest.mock('../../CoinData/CoinDirectory', () => ({CoinDirectory: {getBasicCoinObj: jest.fn()}}));
jest.mock('../../api/channels/verusid/callCreators', () => ({getIdentity: jest.fn()}));
jest.mock('../../api/channels/vrpc/requests/getSignatureInfo', () => ({getSignatureInfo: jest.fn()}));
jest.mock('../../api/channels/vrpc/requests/getBlock', () => ({getBlock: jest.fn()}));
jest.mock('../../vrpc/vrpcInterface', () => ({__esModule: true, default: {initEndpoint: jest.fn()}}));

beforeEach(() => {
  jest.clearAllMocks();
  getIdentity.mockResolvedValue({result: {fullyqualifiedname: 'requester@'}});
  getSignatureInfo.mockResolvedValue({height: 100});
  getBlock.mockResolvedValue({result: {time: 12345}});
});

const scopedRequest = (appID = 'iApp', systemID = 'iPBaaSChain') => ({
  hasAppOrDelegatorID: () => true,
  appOrDelegatorID: {toIAddress: () => appID},
  signature: {
    systemID: {toIAddress: () => systemID},
    identityID: {toIAddress: () => 'iDelegate'},
    signatureAsVch: Buffer.from('signature'),
  },
});

it('resolves the app on the signer chain without replacing the actual signer', async () => {
  CoinDirectory.getBasicCoinObj.mockReturnValue({
    system_id: 'iPBaaSChain', display_ticker: 'CHAIN', vrpc_endpoints: ['https://chain.invalid'],
  });
  getIdentity.mockImplementation(async (_, id) => ({result: {
    fullyqualifiedname: id === 'iDelegate' ? 'delegate.Parent.VRSC@' : 'app.Parent.VRSC@',
  }}));

  await expect(getSignedRequestDisplayProps(scopedRequest())).resolves.toMatchObject({
    signerIdentityID: 'iDelegate', signerFqn: 'delegate.Parent@',
    signerSystemID: 'iPBaaSChain', signerSystemName: 'CHAIN',
    appOrDelegatorID: 'iApp', appOrDelegatorFqn: 'app.Parent@',
    sigtime: 12345,
  });
  expect(getIdentity.mock.calls).toEqual([
    ['iPBaaSChain', 'iDelegate'], ['iPBaaSChain', 'iApp'],
  ]);
  expect(getSignatureInfo).toHaveBeenCalledWith('iPBaaSChain', 'iDelegate', Buffer.from('signature').toString('base64'));
});

it.each(['signer', 'app', 'both'])('keeps independent raw-ID fallbacks when %s metadata is unavailable', async failure => {
  CoinDirectory.getBasicCoinObj.mockReturnValue({
    system_id: 'iPBaaSChain', vrpc_endpoints: ['https://chain.invalid'],
  });
  getIdentity.mockImplementation(async (_, id) => {
    if (failure === 'both' || (failure === 'signer' && id === 'iDelegate')) {
      throw new Error('Offline');
    }
    if (failure === 'app' && id === 'iApp') return {error: {message: 'Not found'}};
    return {result: {fullyqualifiedname: `${id}.VRSC@`}};
  });
  getSignatureInfo.mockRejectedValueOnce(new Error('No signature metadata'));

  await expect(getSignedRequestDisplayProps(scopedRequest())).resolves.toMatchObject({
    signerIdentityID: 'iDelegate',
    signerFqn: failure === 'app' ? 'iDelegate@' : 'iDelegate',
    appOrDelegatorID: 'iApp',
    appOrDelegatorFqn: failure === 'signer' ? 'iApp@' : 'iApp',
    sigtime: null,
  });
});

it('reuses the signer lookup when the explicit app and signer are the same identity', async () => {
  CoinDirectory.getBasicCoinObj.mockReturnValue({
    system_id: 'iPBaaSChain', vrpc_endpoints: ['https://chain.invalid'],
  });
  getIdentity.mockResolvedValue({result: {fullyqualifiedname: 'same-app.VRSC@'}});

  await expect(getSignedRequestDisplayProps(scopedRequest('iDelegate'))).resolves.toMatchObject({
    signerIdentityID: 'iDelegate', signerFqn: 'same-app@',
    appOrDelegatorID: 'iDelegate', appOrDelegatorFqn: 'same-app@',
  });
  expect(getIdentity).toHaveBeenCalledTimes(1);
});

it('forwards both app and delegate metadata to the authentication review', async () => {
  CoinDirectory.getBasicCoinObj.mockReturnValue({
    system_id: 'iPBaaSChain', vrpc_endpoints: ['https://chain.invalid'],
  });
  getIdentity.mockImplementation(async (_, id) => ({result: {fullyqualifiedname: `${id}.VRSC@`}}));
  const request = scopedRequest();
  request.details = [new AuthenticationRequestOrdinalVDXFObject({data: new AuthenticationRequestDetails()})];
  request.getDetails = index => request.details[index];

  const {displayProps} = await handleAuthenticationRequestDetailsVDXFObject(request, null, 0);
  expect(displayProps).toMatchObject({
    signerIdentityID: 'iDelegate', signerFqn: 'iDelegate@',
    appOrDelegatorID: 'iApp', appOrDelegatorFqn: 'iApp@',
  });
});

it.each([
  ['i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', 'VRSC', 'VRSC'],
  ['iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', 'VRSCTEST', 'VRSCTEST'],
  ['iPBaaSChain', 'Other Chain', 'Other Chain'],
  ['iPBaaSChain', undefined, 'iPBaaSChain'],
])('loads signer metadata using system %s and displays %s', async (systemID, ticker, name) => {
  const request = {signature: {
    systemID: {toIAddress: () => systemID},
    identityID: {toIAddress: () => 'iRequester'},
    signatureAsVch: Buffer.from('signature'),
  }};
  CoinDirectory.getBasicCoinObj.mockReturnValue({
    system_id: systemID, display_ticker: ticker, vrpc_endpoints: ['https://example.com'],
  });

  await expect(getSignedRequestDisplayProps(request)).resolves.toEqual({
    signerSystemID: systemID, signerSystemName: name, signerIdentityID: 'iRequester',
    signerFqn: 'requester@', sigtime: 12345,
  });
  expect(CoinDirectory.getBasicCoinObj).toHaveBeenCalledWith(systemID);
  expect(VrpcProvider.initEndpoint).toHaveBeenCalledWith(systemID, 'https://example.com');
  expect(getIdentity).toHaveBeenCalledWith(systemID, 'iRequester');
  expect(getSignatureInfo).toHaveBeenCalledWith(systemID, 'iRequester', Buffer.from('signature').toString('base64'));
  expect(getBlock).toHaveBeenCalledWith(systemID, 100);
});
