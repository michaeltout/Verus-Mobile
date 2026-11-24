const mockGetIdentity = jest.fn();

jest.mock('../../api/channels/verusid/requests/getIdentity', () => ({
  getIdentity: (...args) => mockGetIdentity(...args),
}));

const {
  getFriendlyNameMap,
} = require('../../api/channels/verusid/requests/getFriendlyNameMap');
const identityResult = {
  fullyqualifiedname: 'storage.VRSC@',
  identity: {
    identityaddress: 'storage',
    revocationauthority: 'owner',
    recoveryauthority: 'owner',
    systemid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
  },
};

beforeEach(() => mockGetIdentity.mockReset());

it('reuses supplied identity names and leaves caller address lists unchanged', async () => {
  const addresses = ['owner', 'owner'];
  const names = await getFriendlyNameMap('system', identityResult, addresses, {
    names: {owner: 'User@'},
  });

  expect(names).toMatchObject({storage: 'storage@', owner: 'User@'});
  expect(addresses).toEqual(['owner', 'owner']);
  expect(mockGetIdentity).not.toHaveBeenCalled();
});

it('starts independent names together and shares overlapping in-flight lookups', async () => {
  const resolve = {};
  mockGetIdentity.mockImplementation(
    (_system, address) =>
      new Promise(done => {
        resolve[address] = done;
      }),
  );
  const shared = {names: {}, pending: new Map()};
  const first = getFriendlyNameMap(
    'system',
    identityResult,
    ['another-owner'],
    shared,
  );
  const second = getFriendlyNameMap(
    'system',
    identityResult,
    ['owner'],
    shared,
  );

  // Both reads start without waiting for the first, and owner is requested once.
  expect(mockGetIdentity.mock.calls).toEqual([
    ['system', 'another-owner'],
    ['system', 'owner'],
  ]);
  resolve.owner({result: {fullyqualifiedname: 'User.VRSCTEST@'}});
  resolve['another-owner']({result: {fullyqualifiedname: 'Recovery.VRSC@'}});
  const names = await Promise.all([first, second]);
  for (const result of names) {
    expect(result).toMatchObject({
      owner: 'User.VRSCTEST@',
      'another-owner': 'Recovery@',
    });
  }
});

it('keeps resolved names when another display lookup fails and retries in a new operation', async () => {
  mockGetIdentity.mockImplementation(async (_system, address) => {
    if (address === 'owner') throw new Error('Unavailable');
    return {result: {fullyqualifiedname: 'Recovery@'}};
  });
  const names = await getFriendlyNameMap('system', identityResult, [
    'another-owner',
  ]);
  expect(names).toMatchObject({
    storage: 'storage@',
    'another-owner': 'Recovery@',
  });
  expect(names.owner).toBeUndefined();

  mockGetIdentity.mockResolvedValue({result: {fullyqualifiedname: 'User@'}});
  expect(await getFriendlyNameMap('system', identityResult)).toMatchObject({
    owner: 'User@',
  });
  expect(mockGetIdentity).toHaveBeenCalledTimes(3);
});
