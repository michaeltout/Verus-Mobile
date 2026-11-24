const mockEvents = [];
const mockBroadcast = jest.fn();
const mockBridge = jest.fn();
jest.mock('@bitgo/utxo-lib', () => ({
  networks: {verus: {}},
  ECPair: {fromWIF: () => ({})},
  Transaction: {
    SIGHASH_ALL: 1,
    fromHex: () => ({getId: () => '11'.repeat(32)}),
  },
  smarttxs: {
    getFundedTxBuilder: () => ({
      inputs: [{}],
      sign: () => mockEvents.push('sign'),
      build: () => ({toHex: () => 'signed-transaction'}),
    }),
  },
}));
jest.mock('../../auth/authBox', () => ({
  requestPrivKey: async () => {
    mockEvents.push('unlock');
    return 'private-key';
  },
}));
jest.mock('../../api/channels/vrpc/requests/sendRawTransaction', () => ({
  sendRawTransaction: (...args) => mockBroadcast(...args),
}));
jest.mock('../../api/channels/vrpc/callCreators', () => ({
  sendCurrencyTransfer: (...args) =>
    require('../../api/channels/vrpc/requests/send').sendCurrencyTransfer(
      ...args,
    ),
}));
jest.mock('../../api/channels/erc20/callCreator', () => ({
  sendBridgeTransfer: (...args) => mockBridge(...args),
}));

const {
  sendConvertOrCrossChain,
} = require('../../api/routers/sendConvertOrCrossChain');
const coin = {id: 'VRSC'};
const channel = 'vrpc.address.system';
const params = {
  hex: 'reviewed-transaction',
  inputs: [{script: '01', satoshis: 10000}],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockBroadcast.mockImplementation(async () => {
    mockEvents.push('broadcast');
    return {result: '11'.repeat(32)};
  });
});

it('checks delegation after opening the payment key and before any broadcast', async () => {
  const beforeSend = jest.fn(async () => {
    mockEvents.push('authorize');
  });
  await expect(
    sendConvertOrCrossChain(coin, {}, channel, {...params, beforeSend}),
  ).resolves.toMatchObject({err: false});
  expect(mockEvents).toEqual(['unlock', 'sign', 'authorize', 'broadcast']);
  expect(beforeSend).toHaveBeenCalledWith({
    step: 'transfer',
    receipt: {
      systemId: 'system',
      txid: '11'.repeat(32),
      rawTx: 'signed-transaction',
    },
  });
});

it('does not broadcast a payment when the last grant check fails', async () => {
  const result = await sendConvertOrCrossChain(coin, {}, channel, {
    ...params,
    beforeSend: async () => {
      throw new Error('Grant deleted');
    },
  });
  expect(result).toEqual({err: true, result: 'Grant deleted'});
  expect(mockBroadcast).not.toHaveBeenCalled();
});

it('forwards the same final guard to bridge approvals and transfers', async () => {
  const beforeSend = jest.fn();
  await sendConvertOrCrossChain(coin, {}, 'erc20.address', {
    transferparams: ['transfer'],
    approvalparams: ['approval'],
    gasprice: 1,
    beforeSend,
  });
  expect(mockBridge).toHaveBeenCalledWith(
    coin,
    ['transfer'],
    ['approval'],
    1,
    beforeSend,
  );
});
