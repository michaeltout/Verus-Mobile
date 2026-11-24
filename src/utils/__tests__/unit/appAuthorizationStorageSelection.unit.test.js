const {
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  deriveAppAuthorizationStorageManifest,
  nameAndParentAddrToIAddr,
} = require('verus-typescript-primitives');
const {
  getExistingAuthorizationStorageBindings,
} = require('../../appAuthorization/reviewSelections');

const systemID = nameAndParentAddrToIAddr('VRSC');
const id = name => nameAndParentAddrToIAddr(name, systemID);
const appID = id('app');
const revision = {txid: '11'.repeat(32), vout: 0};

const connection = (marker, storage = ['storage'], app = appID) => {
  const grantID = marker.repeat(64);
  const storageBindings = storage.map((name, relationshipIndex) => ({
    record: new AuthorizationStorageBindingCredential({
      version: AuthorizationStorageBindingCredential.VERSION_CURRENT,
      grantID,
      relationshipIndex,
      storageSystemID: systemID,
      storageID: id(name),
    }),
  }));
  const records = storageBindings.map(({record}) => record);
  const grant = new AuthorizationCredential({
    version: AuthorizationCredential.VERSION_CURRENT,
    flags: storage.length
      ? AuthorizationCredential.FLAG_CONTAINS_STORAGE_BINDINGS
      : AuthorizationCredential.FLAGS_NONE,
    grantID,
    signingSystemID: systemID,
    delegateRevision: revision,
    delegatorRevision: revision,
    ...(records.length
      ? {storageManifestHash: deriveAppAuthorizationStorageManifest(records)}
      : {}),
  });
  return {
    rootSystemID: systemID,
    grants: [
      {
        record: grant,
        identities: {appID: app, delegateID: id(`instance-${marker}`)},
      },
    ],
    storageBindings,
  };
};
const merge = (...views) => ({
  rootSystemID: views[0].rootSystemID,
  ...Object.fromEntries(
    ['grants', 'storageBindings'].map(key => [
      key,
      views.flatMap(view => view[key]),
    ]),
  ),
});
const selected = view =>
  getExistingAuthorizationStorageBindings(view, appID, systemID);

test('requires the same complete storage set across instances regardless of relationship ordering', () => {
  const view = merge(
    connection('1', ['one', 'two']),
    connection('2', ['two', 'one']),
  );
  expect(
    selected(view)
      .map(binding => binding.storageID)
      .sort(),
  ).toEqual([id('one'), id('two')].sort());
});

test('deduplicates identical encrypted copies without losing a relationship', () => {
  const view = connection('1', ['one', 'two']);
  expect(selected(merge(view, view))).toHaveLength(2);
});

test('accepts explicit and omitted root systems in equivalent copies of a grant and its storage', () => {
  const explicit = connection('1');
  const implicit = connection('1');
  delete implicit.grants[0].record.data.signingSystemID;
  delete implicit.storageBindings[0].record.data.storageSystemID;

  expect(selected(merge(explicit, implicit))).toEqual([
    expect.objectContaining({storageID: id('storage'), storageSystemID: systemID}),
  ]);
});

test.each(['VRSC', 'VRSCTEST'])(
  'resolves omitted grant and storage systems against the %s network root',
  network => {
    const rootSystemID = nameAndParentAddrToIAddr(network);
    const view = connection('1');
    view.rootSystemID = rootSystemID;
    const grant = view.grants[0].record;
    delete grant.data.signingSystemID;
    delete view.storageBindings[0].record.data.storageSystemID;
    grant.data.storageManifestHash = deriveAppAuthorizationStorageManifest(
      view.storageBindings.map(({record}) => record),
      rootSystemID,
    );

    expect(
      getExistingAuthorizationStorageBindings(view, appID, rootSystemID),
    ).toEqual([
      expect.objectContaining({storageSystemID: rootSystemID}),
    ]);
    expect(view.storageBindings[0].record.data.storageSystemID).toBeUndefined();
  },
);

test('inherits a nonroot grant system without treating its host identity as the default', () => {
  const nonrootSystemID = id('other-system');
  const view = connection('1');
  const grant = view.grants[0].record;
  grant.data.signingSystemID = nonrootSystemID;
  delete view.storageBindings[0].record.data.storageSystemID;
  grant.data.storageManifestHash = deriveAppAuthorizationStorageManifest(
    view.storageBindings.map(({record}) => record),
    nonrootSystemID,
  );

  expect(
    getExistingAuthorizationStorageBindings(view, appID, nonrootSystemID),
  ).toEqual([
    expect.objectContaining({storageSystemID: nonrootSystemID}),
  ]);
  delete grant.data.signingSystemID;
  expect(
    getExistingAuthorizationStorageBindings(view, appID, nonrootSystemID),
  ).toEqual([]);
});

test('ignores other apps and leaves a connection without storage open for a first selection', () => {
  expect(
    selected(
      merge(connection('1', []), connection('2', ['foreign'], id('other-app'))),
    ),
  ).toEqual([]);
  expect(
    selected(merge(connection('1', []), connection('2'))).map(
      binding => binding.storageID,
    ),
  ).toEqual([id('storage')]);
});

test('rejects conflicting storage sets instead of silently selecting or combining them', () => {
  expect(() =>
    selected(merge(connection('1', ['one']), connection('2', ['two']))),
  ).toThrow('different storage selections');
});

test('rejects incomplete storage records instead of permitting a new selection', () => {
  const view = connection('1');
  view.storageBindings = [];
  expect(() => selected(view)).toThrow('incomplete or conflicting');
});

test('rejects conflicting copies of the same grant', () => {
  const view = merge(connection('1'), connection('1', ['other-storage']));
  expect(() => selected(view)).toThrow('incomplete or conflicting');
});

test('requires identity history before allowing a new storage selection', () => {
  const view = connection('1');
  delete view.grants[0].identities;
  view.grants[0].identityError = 'Identity history unavailable';

  expect(() => selected(view)).toThrow('Refresh to load its identity history');
});
