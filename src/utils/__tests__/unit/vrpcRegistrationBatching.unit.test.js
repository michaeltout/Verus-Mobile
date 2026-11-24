const mockHttpPost = jest.fn();
const mockCachedResponses = new Map();
const mockGetCachedResponse = jest.fn();
const mockSetCachedResponse = jest.fn();
const mockStoreState = {channelStore_vrpc: {vrpcEndpoints: {}}};
const mockCacheKey = (chain, endpoint, req) => JSON.stringify([chain, endpoint, req.prepare()]);

// Keep both installed SDKs and their request serialization real. Only network
// I/O, device services and persistent storage are replaced in these tests.
jest.mock('axios', () => ({create: () => ({post: (...args) => mockHttpPost(...args)})}));
jest.mock('react-native', () => ({
  Alert: {alert: jest.fn()},
  AppState: {currentState: 'active', addEventListener: jest.fn()},
}));
jest.mock('../../../store', () => ({
  __esModule: true,
  default: {dispatch: jest.fn(), getState: () => mockStoreState},
}));
jest.mock('../../asyncStore/asyncStore', () => ({
  getCachedVrpcResponse: (...args) => mockGetCachedResponse(...args),
  getVrpcResponseCacheKey: (...args) => mockCacheKey(...args),
  setCachedVrpcResponse: (...args) => mockSetCachedResponse(...args),
}));
jest.mock('../../CoinData/CoinsList', () => ({coinsList: {VRSC: {}, VRSCTEST: {}}}));
jest.mock('../../CoinData/CoinDirectory', () => ({CoinDirectory: {getVrpcEndpoints: () => []}}));
jest.mock('../../../../env/index', () => ({VRPC_API_APP_ID: undefined, VRPC_API_KEYS: {}}));

const {
  GetBlockRequest,
  GetCurrencyRequest,
  GetIdentityRequest,
  GetIdentityContentRequest,
  GetInfoRequest,
  GetRawTransactionRequest,
  GetTxOutRequest,
  ApiRequest,
} = require('verus-typescript-primitives');

const chain = 'system';
const server = 'https://registration.example.com';
const currency = name => new GetCurrencyRequest(chain, name);
const info = () => new GetInfoRequest(chain);
const block = () => new GetBlockRequest(chain, 123, 1);
const txout = index => new GetTxOutRequest(chain, `transaction-${index}`, index, true);
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return {promise, resolve};
};
const responseFor = body => ({
  result: {method: body.method, params: body.params},
  error: null,
});
const httpResponse = body => ({status: 200, data: Array.isArray(body) ? body.map(responseFor) : responseFor(body)});
const bodies = () => mockHttpPost.mock.calls.map(call => call[1]);
const commands = () => bodies().flat();

describe('registration SDK transport integration', () => {
  let vrpc;
  let rpc;
  let registrationRpc;

  const seedCache = (request, response) => {
    const key = mockCacheKey(chain, server, request);
    mockCachedResponses.set(key, response);
    vrpc.setLastNetworkResponseTime(key, Date.now());
  };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    jest.clearAllMocks();
    mockCachedResponses.clear();
    mockStoreState.channelStore_vrpc.vrpcEndpoints = {};
    mockGetCachedResponse.mockReset().mockImplementation((...args) =>
      Promise.resolve(mockCachedResponses.get(mockCacheKey(...args))),
    );
    mockSetCachedResponse.mockReset().mockImplementation((system, endpoint, req, response) => {
      mockCachedResponses.set(mockCacheKey(system, endpoint, req), response);
      return Promise.resolve();
    });
    mockHttpPost.mockReset().mockImplementation((url, body) => Promise.resolve(httpResponse(body)));

    vrpc = require('../../vrpc/vrpcInterface').default;
    vrpc.saveChainEndpoint(chain, server);
    const [endpointId] = vrpc.systemEndpointIds[chain];
    mockStoreState.channelStore_vrpc.vrpcEndpoints[endpointId] = [chain, server];
    rpc = vrpc.cacheInterfaces[endpointId];
    registrationRpc = vrpc.getVerusIdInterface(chain).interface;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('omits cached currency reads while batching fresh snapshot checks through the SDK hook', async () => {
    const cachedCurrency = {result: {currencyid: chain}, error: null};
    seedCache(currency(chain), cachedCurrency);
    seedCache(info(), {result: {blocks: 122}, error: null});

    const results = await registrationRpc.requestMany([currency(chain), info(), block()]);

    expect(results[0]).toBe(cachedCurrency);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0].map(item => [item.method, item.params])).toEqual([
      ['getinfo', []], ['getblock', [123, 1]],
    ]);
    expect(results.slice(1).map(result => result.result.method)).toEqual(['getinfo', 'getblock']);
    expect(mockGetCachedResponse.mock.calls.map(call => call[2].cmd)).toEqual(['getcurrency']);
    expect(mockSetCachedResponse).not.toHaveBeenCalled();
  });

  it.each([true, false])('shares simultaneous currency reads between single and batched callers (single first: %s)', async singleFirst => {
    const network = deferred();
    mockHttpPost.mockReturnValueOnce(network.promise);
    const single = () => registrationRpc.getCurrency(chain);
    const many = () => registrationRpc.requestMany([currency(chain), currency(chain)]);
    const first = singleFirst ? single() : many();
    const second = singleFirst ? many() : single();
    await jest.advanceTimersByTimeAsync(0);

    expect(commands()).toHaveLength(1);
    expect(commands()[0].method).toBe('getcurrency');
    network.resolve(httpResponse(bodies()[0]));
    const results = await Promise.all([first, second]);
    const singleResult = results[singleFirst ? 0 : 1];
    const batchResults = results[singleFirst ? 1 : 0];

    expect(batchResults).toEqual([singleResult, singleResult]);
    expect(await registrationRpc.getCurrency(chain)).toBe(singleResult);
    expect(commands()).toHaveLength(1);
    expect(mockSetCachedResponse).toHaveBeenCalledTimes(1);
  });

  it('never joins an older wallet refresh when validating the registration snapshot', async () => {
    const olderRefresh = deferred();
    mockHttpPost.mockReturnValueOnce(olderRefresh.promise);
    const refresh = rpc.requestMany([info()]);
    await jest.advanceTimersByTimeAsync(0);

    const registration = registrationRpc.requestMany([info(), block()]);
    await jest.advanceTimersByTimeAsync(0);
    olderRefresh.resolve({status: 200, data: {result: {blocks: 122}, error: null}});

    expect((await refresh)[0].result.blocks).toBe(122);
    await jest.advanceTimersByTimeAsync(13);
    const results = await registration;
    expect(results[0].result.method).toBe('getinfo');
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1].map(item => item.method)).toEqual(['getinfo', 'getblock']);

    // The ordinary refresh may cache its result; registration must still make
    // a fresh request on the next verification, even within the one-second TTL.
    const nextVerification = registrationRpc.requestMany([info(), block()]);
    await jest.advanceTimersByTimeAsync(25);
    await nextVerification;
    expect(commands().filter(item => item.method === 'getinfo')).toHaveLength(3);
    expect(mockSetCachedResponse.mock.calls.map(call => call[2].cmd)).toEqual(['getinfo']);
  });

  it('preserves read order, per-item errors and a spent output without dropping successful siblings', async () => {
    const missingTransaction = {code: -5, message: 'Transaction not found'};
    mockHttpPost.mockImplementationOnce((url, body) => Promise.resolve({
      status: 200,
      data: body.map(item => {
        if (item.method === 'getrawtransaction') return {result: null, error: missingTransaction};
        if (item.method === 'gettxout') return {result: null, error: null};
        return responseFor(item);
      }),
    }));

    const results = await registrationRpc.requestMany([
      new GetRawTransactionRequest(chain, 'missing-tx', 0),
      txout(0),
      new GetIdentityRequest(chain, 'authority@'),
      block(),
    ]);

    expect(bodies()).toHaveLength(1);
    expect(commands().map(item => item.method)).toEqual([
      'getrawtransaction', 'gettxout', 'getidentity', 'getblock',
    ]);
    expect(commands()[1].params).toEqual(['transaction-0', 0, true]);
    expect(results).toEqual([
      {result: null, error: missingTransaction},
      {result: null, error: null},
      {result: {method: 'getidentity', params: ['authority@']}, error: null},
      {result: {method: 'getblock', params: [123, 1]}, error: null},
    ]);
    expect(mockSetCachedResponse).not.toHaveBeenCalled();

    const nextVerification = registrationRpc.requestMany([txout(0), new GetIdentityRequest(chain, 'authority@')]);
    await jest.advanceTimersByTimeAsync(50);
    await nextVerification;
    expect(commands().filter(item => item.method === 'gettxout')).toHaveLength(2);
    expect(commands().filter(item => item.method === 'getidentity')).toHaveLength(2);
  });

  it('keeps registration funding batches within the server limit', async () => {
    const requests = Array.from({length: 45}, (_, index) => txout(index));
    const pending = registrationRpc.requestMany(requests);
    await jest.advanceTimersByTimeAsync(500);
    const results = await pending;

    expect(bodies().map(body => body.length)).toEqual([20, 20, 5]);
    expect(results.map(response => response.result.params)).toEqual(requests.map(request => request.getParams()));
    expect(mockSetCachedResponse).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'missing result'])('falls back to sequential registration reads after a %s batch response', async failure => {
    let activeSingles = 0;
    let maximumActiveSingles = 0;
    mockHttpPost.mockImplementation((url, body) => {
      if (Array.isArray(body)) return Promise.resolve({
        status: 200,
        data: failure === 'disabled'
          ? {error: {code: -32600, message: 'Batch disabled'}}
          : body.slice(0, -1).map(responseFor),
      });

      activeSingles++;
      maximumActiveSingles = Math.max(maximumActiveSingles, activeSingles);
      return new Promise(resolve => setTimeout(() => {
        activeSingles--;
        resolve(httpResponse(body));
      }, 10));
    });

    const pending = registrationRpc.requestMany([txout(0), txout(1), info(), block()]);
    await jest.advanceTimersByTimeAsync(100);
    const results = await pending;

    expect(results.every(result => result.error == null)).toBe(true);
    expect(maximumActiveSingles).toBe(1);
    expect(bodies().slice(1).map(body => body.method)).toEqual([
      'gettxout', 'gettxout', 'getinfo', 'getblock',
    ]);

    const retry = registrationRpc.requestMany([txout(0), txout(1)]);
    await jest.advanceTimersByTimeAsync(100);
    await retry;
    expect(bodies().filter(Array.isArray)).toHaveLength(1);
    expect(maximumActiveSingles).toBe(1);
  });

  it('retries failed currency lookups instead of reusing their errors', async () => {
    const error = {code: -5, message: 'Currency unavailable'};
    mockHttpPost.mockResolvedValueOnce({status: 200, data: {result: null, error}});

    expect((await registrationRpc.requestMany([currency(chain)]))[0].error).toEqual(error);
    expect((await registrationRpc.getCurrency(chain)).error).toBeNull();
    expect(commands()).toHaveLength(2);
    expect(mockSetCachedResponse).toHaveBeenCalledTimes(1);
  });

  it('rejects write methods in the read hook without submitting a transaction', async () => {
    const write = new ApiRequest(chain, 'sendrawtransaction');
    write.getParams = () => ['deadbeef'];
    const results = await registrationRpc.requestMany([txout(0), write]);

    expect(results[0].result.method).toBe('gettxout');
    expect(results[1].error.code).toBe(-32601);
    expect(commands().map(item => item.method)).toEqual(['gettxout']);
  });

  it('shares authorization content reads through the real SDK hook and bypasses all mutable TTL entries', async () => {
    const {createAuthorizationReadScope} = require('verusid-ts-client');
    const identityName = 'user@';
    const contentArgs = [identityName, 0, 123, false, 0, 'credential-key'];
    const identityRequest = new GetIdentityRequest(chain, identityName);
    const contentRequest = new GetIdentityContentRequest(chain, ...contentArgs);
    const blockRequest = new GetBlockRequest(chain, '123', 1);
    const revision = {
      txid: 'aa'.repeat(32), vout: 0, blockheight: 120, status: 'active',
      identity: {identityaddress: identityName, primaryaddresses: ['user-key']},
    };
    let encryptedCredential = 'current credential';
    const envelopeFor = body => ({
      error: null,
      result: body.method === 'getinfo'
        ? {chainid: chain, blocks: 123, longestchain: 123}
        : body.method === 'getblock'
          ? {hash: 'bb'.repeat(32), height: 123, confirmations: 1}
          : body.method === 'getidentitycontent'
            ? {...revision, fromheight: 0, toheight: 123,
              identity: {...revision.identity, contentmultimap: {'credential-key': [encryptedCredential]}}}
            : {...revision, identity: {...revision.identity}},
    });
    mockHttpPost.mockImplementation((url, body) => Promise.resolve({
      status: 200,
      data: Array.isArray(body) ? body.map(envelopeFor) : envelopeFor(body),
    }));
    [info(), identityRequest, contentRequest, blockRequest].forEach(request =>
      seedCache(request, {result: {stale: true}, error: null}),
    );

    const readPhase = async expectedCredential => {
      const scope = createAuthorizationReadScope(registrationRpc);
      const reads = Promise.all([
        scope.rpc.getIdentityContent(...contentArgs),
        scope.rpc.getIdentityContent(...contentArgs),
        scope.rpc.getIdentity(identityName),
        scope.rpc.getInfo(),
        scope.rpc.getBlock('123', 1),
      ]);
      await jest.advanceTimersByTimeAsync(100);
      const [content, sharedContent] = await reads;
      expect(content.error).toBeNull();
      expect(content.result.identity.contentmultimap['credential-key']).toEqual([expectedCredential]);
      expect(sharedContent).toEqual(content);

      const validation = scope.assertCurrent();
      await jest.advanceTimersByTimeAsync(100);
      await validation;
    };

    await readPhase(encryptedCredential);
    expect(bodies()).toHaveLength(2);
    expect(bodies()[0].map(item => [item.method, item.params])).toEqual([
      ['getidentitycontent', contentRequest.getParams()],
      ['getidentity', identityRequest.getParams()],
      ['getinfo', []],
      ['getblock', blockRequest.getParams()],
    ]);
    expect(bodies()[1].map(item => item.method)).toEqual(['getidentity', 'getinfo', 'getblock']);

    // A second operation starts within the ordinary cache TTL. Its new CMM and
    // identity revision must come from the server rather than the previous scope.
    encryptedCredential = 'replacement credential';
    revision.txid = 'cc'.repeat(32);
    await readPhase(encryptedCredential);
    expect(bodies()).toHaveLength(4);
    expect(commands()).toHaveLength(14);
    expect(commands().filter(item => item.method === 'getidentitycontent')).toHaveLength(2);
    expect(mockGetCachedResponse).not.toHaveBeenCalled();
    expect(mockSetCachedResponse).not.toHaveBeenCalled();
  });

  it('rejects an authorization identity update observed by the real transport final check', async () => {
    const {createAuthorizationReadScope} = require('verusid-ts-client');
    const identityRequest = new GetIdentityRequest(chain, 'user@');
    let txid = 'aa'.repeat(32);
    const envelopeFor = body => ({
      error: null,
      result: body.method === 'getinfo'
        ? {chainid: chain, blocks: 123, longestchain: 123}
        : {txid, vout: 0, blockheight: 120, status: 'active', identity: {primaryaddresses: ['user-key']}},
    });
    mockHttpPost.mockImplementation((url, body) => Promise.resolve({
      status: 200,
      data: Array.isArray(body) ? body.map(envelopeFor) : envelopeFor(body),
    }));
    seedCache(identityRequest, {result: {stale: true}, error: null});
    const scope = createAuthorizationReadScope(registrationRpc);
    const identity = scope.rpc.getIdentity('user@');
    await jest.advanceTimersByTimeAsync(100);
    expect((await identity).result.txid).toBe(txid);

    txid = 'cc'.repeat(32);
    const validation = expect(scope.assertCurrent()).rejects.toThrow(/Authorization state changed/);
    await jest.advanceTimersByTimeAsync(100);
    await validation;
    expect(commands().map(item => item.method)).toEqual(['getidentity', 'getidentity', 'getinfo']);
    expect(mockGetCachedResponse).not.toHaveBeenCalled();
    expect(mockSetCachedResponse).not.toHaveBeenCalled();
  });

});
