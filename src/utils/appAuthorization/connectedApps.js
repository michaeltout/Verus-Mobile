import {loadIdentityRevision} from 'verusid-ts-client';
import {getFriendlyNameMap} from '../api/channels/verusid/requests/getFriendlyNameMap';
import {identityLabel} from '../../containers/Services/ServiceComponents/VerusIdService/IdentityRegistration/presentation';
import {loadAuthorizationCredentials} from './credentials';
import {authorizationSource, withAuthorizationReadScope} from './controls';
import {assertAuthorizationContext, loadAuthorizationJobs} from './jobs';
import {STORAGE_ACCESS_STATE} from './constants';
import {
  inspectAuthorizationStorageAccess,
  listAuthorizationStorageAccess,
} from './storageManagement';

const identityKey = identity => `${identity.systemID}:${identity.identityID}`;

/**
 * Collect display rows across the profile's linked identities. Current encrypted
 * credentials supply approvals; the local journal only identifies the app for
 * storage records retained after an instance's approval was removed.
 */
export const loadConnectedApps = async (identities, context) => {
  assertAuthorizationContext(context);
  if (!identities.length) return {apps: [], errors: [], unassignedStorage: []};
  const apps = new Map();
  const errors = [];
  const storageRows = new Map();
  const assignedStorage = new Set();
  const unreadUsers = new Set();
  const namesBySystem = new Map();
  const users = new Map();
  let jobs = [];

  for (const identity of identities) {
    const names = namesBySystem.get(identity.systemID) || {};
    if (identity.title && identity.title !== identity.identityID)
      names[identity.identityID] = identity.title;
    namesBySystem.set(identity.systemID, names);
    if (!identity.isStorage) {
      users.set(identityKey(identity), {
        identityID: identity.identityID,
        systemID: identity.systemID,
        title: identity.title || identityLabel(identity.identityID),
      });
    }
  }

  try {
    // Retain only display associations, not requests, gift keys or responses.
    jobs = Object.values(await loadAuthorizationJobs(context))
      .filter(job => job.network === context.network)
      .map(job => {
        const systemID = job.systemId || job.selectedIdentity?.systemID;
        return {
          users: [job.selectedIdentity, ...(job.targets?.users || [])]
            .filter(Boolean)
            .map(({identityID, systemID}) => ({identityID, systemID})),
          appID: job.appId || job.targets?.appID,
          systemID,
          grantIDs: job.grantID ? [job.grantID] : job.targets?.grantIDs || [],
          storage: [
            ...(job.storageBindings || []),
            ...(job.targets?.storage || []),
          ].map(binding => ({
            storageID: binding.storageID,
            storageSystemID: binding.storageSystemID || systemID,
          })),
        };
      });
  } catch (error) {
    assertAuthorizationContext(context);
    if (error.code === 'SESSION_CHANGED') throw error;
    errors.push({
      message: `Saved app information could not be read. ${error.message}`,
      blocksRemoval: true,
    });
  }

  const appGroup = (appID, systemID) => {
    const key = `${systemID}:${appID}`;
    if (!apps.has(key))
      apps.set(key, {
        key,
        appID,
        systemID,
        approvalUnknown: false,
        instances: new Map(),
        storage: new Map(),
      });
    return apps.get(key);
  };

  // Keep one row per S so all apps share its current state and affected users.
  const storageRow = (storageID, storageSystemID) => {
    const key = `${storageSystemID}:${storageID}`;
    if (!storageRows.has(key))
      storageRows.set(key, {
        key,
        storageID,
        storageSystemID,
        hasCredentials: false,
        users: new Map(),
      });
    return storageRows.get(key);
  };

  const assignStorage = (row, appID, systemID) => {
    const app = appGroup(appID, systemID);
    app.storage.set(row.key, row);
    assignedStorage.add(row.key);
    return app;
  };

  // Native key access stays serial. Each user has its own bounded read phase so
  // an unavailable identity does not hide another identity's valid connections.
  for (const user of users.values()) {
    try {
      const binding = {identityID: user.identityID, systemID: user.systemID};
      const {view, storage} = await withAuthorizationReadScope(
        context,
        async scoped => {
          const current = await loadIdentityRevision(
            authorizationSource(binding.systemID, scoped),
            binding,
          );
          // Ordinary linked IDs need not have a credential channel. Skip them
          // without opening keys; an app grant requires this private address.
          if (!current.identity.privateaddress)
            return {view: null, storage: []};
          const view = await loadAuthorizationCredentials(binding, scoped);
          const storage = await listAuthorizationStorageAccess(
            binding,
            scoped,
            view,
          );
          return {view, storage};
        },
      );
      assertAuthorizationContext(context);
      if (!view) continue;

      for (const {record, identities} of view.grants) {
        if (!identities) {
          errors.push({
            user,
            blocksRemoval: false,
            message: `${user.title}: An app approval’s identity history could not be loaded. Refresh to identify its app and instance. Storage access can still be managed below.`,
          });
          continue;
        }
        const systemID = record.getSystemID(view.rootSystemID);
        const app = appGroup(identities.appID, systemID);
        const key = `${systemID}:${identities.delegateID}`;
        if (!app.instances.has(key))
          app.instances.set(key, {
            key,
            delegateID: identities.delegateID,
            users: new Map(),
          });
        app.instances.get(key).users.set(identityKey(user), user);
      }

      for (const binding of storage) {
        // Removing storage access affects every app using S. Share its owners
        // across app groups so one removal can clear all affected user records.
        const row = storageRow(binding.storageID, binding.storageSystemID);
        row.hasCredentials = true;
        row.users.set(identityKey(user), user);
        let appID = binding.appID;
        let systemID = binding.appSystemID;
        if (!appID) {
          const matches = jobs.filter(
            job =>
              job.users.some(
                owner =>
                  owner.identityID === user.identityID &&
                  owner.systemID === user.systemID,
              ) &&
              job.systemID === (binding.appSystemID ?? user.systemID) &&
              job.grantIDs.includes(binding.grantID) &&
              job.appID,
          );
          const associations = new Map(
            matches.map(job => {
              const app = {appID: job.appID, systemID: job.systemID};
              return [`${app.systemID}:${app.appID}`, app];
            }),
          );
          if (associations.size === 1)
            ({appID, systemID} = associations.values().next().value);
        }

        if (appID) {
          const app = assignStorage(row, appID, systemID);
          if (binding.approvalUnknown) app.approvalUnknown = true;
        }
      }
    } catch (error) {
      assertAuthorizationContext(context);
      if (error.code === 'SESSION_CHANGED') throw error;
      unreadUsers.add(identityKey(user));
      errors.push({
        user,
        blocksRemoval: true,
        message: `${user.title}: ${
          error.message || 'Unable to read app access.'
        }`,
      });
    }
  }

  // Revocation may remove every portable relationship before S is added back
  // to the wallet. Use an explicit historical S/system/U relationship only to
  // identify its app; history never creates an active approval or instance.
  for (const identity of identities.filter(item => item.isStorage)) {
    const row = storageRow(identity.identityID, identity.systemID);
    const localOwners = [...users.values()].filter(
      user =>
        user.systemID === identity.systemID &&
        identity.userIdentityIDs?.includes(user.identityID),
    );
    for (const owner of localOwners) row.users.set(identityKey(owner), owner);

    for (const job of jobs) {
      if (
        !job.appID ||
        job.systemID !== identity.systemID ||
        !job.storage.some(
          binding =>
            binding.storageID === identity.identityID &&
            binding.storageSystemID === identity.systemID,
        )
      )
        continue;

      const owners = job.users.filter(
        owner =>
          owner.systemID === identity.systemID &&
          users.has(identityKey(owner)) &&
          (!identity.userIdentityIDs?.length ||
            identity.userIdentityIDs.includes(owner.identityID)),
      );
      if (!owners.length) continue;
      // History can label S without establishing a current managing user.
      // Only local ownership associations or portable records enable actions.
      const app = assignStorage(row, job.appID, job.systemID);
      if (owners.some(owner => unreadUsers.has(identityKey(owner))))
        app.approvalUnknown = true;
    }
  }

  // Storage control is independent of an app approval. Fetch each S once and
  // leave failed reads on the row so another app's controls remain available.
  if (storageRows.size)
    await withAuthorizationReadScope(context, scoped =>
      Promise.all(
        [...storageRows.values()].map(async row => {
          try {
            const {status} = await inspectAuthorizationStorageAccess(
              row,
              scoped,
            );
            row.status = status;
          } catch (error) {
            assertAuthorizationContext(context);
            if (error.code === 'SESSION_CHANGED') throw error;
            row.status = STORAGE_ACCESS_STATE.UNAVAILABLE;
          }
        }),
      ),
    );

  // Resolve display names together, sharing overlapping lookups within each
  // system. Failures keep recognizable address labels and never change access.
  const systems = new Set([
    ...[...apps.values()].map(app => app.systemID),
    ...[...storageRows.values()].map(storage => storage.storageSystemID),
  ]);
  await Promise.all(
    [...systems].map(async systemID => {
      const groups = [...apps.values()].filter(
        app => app.systemID === systemID,
      );
      const addresses = groups.flatMap(app => [
        app.appID,
        ...[...app.instances.values()].map(instance => instance.delegateID),
      ]);
      addresses.push(
        ...[...storageRows.values()]
          .filter(storage => storage.storageSystemID === systemID)
          .map(storage => storage.storageID),
      );
      const names = namesBySystem.get(systemID) || {};
      try {
        await getFriendlyNameMap(
          systemID,
          {identity: {identityaddress: addresses[0]}},
          addresses,
          {names, pending: new Map()},
        );
      } catch (error) {
        assertAuthorizationContext(context);
        if (error.code === 'SESSION_CHANGED') throw error;
        errors.push({
          message:
            'Some identity names could not be loaded. Their addresses are shown instead.',
        });
      }
      namesBySystem.set(systemID, names);
    }),
  );
  assertAuthorizationContext(context);

  const sortByTitle = (left, right) => left.title.localeCompare(right.title);
  const displayStorage = storage => ({
    ...storage,
    title: identityLabel(
      storage.storageID,
      namesBySystem.get(storage.storageSystemID),
      'Storage',
    ),
    users: [...storage.users.values()].sort(sortByTitle),
  });
  return {
    apps: [...apps.values()]
      .map(app => {
        const names = namesBySystem.get(app.systemID) || {};
        return {
          ...app,
          title: identityLabel(app.appID, names, 'App'),
          approvalUnknown:
            app.approvalUnknown ||
            [...app.storage.values()].some(storage =>
              [...storage.users.keys()].some(key => unreadUsers.has(key)),
            ),
          instances: [...app.instances.values()]
            .map(instance => ({
              ...instance,
              title: identityLabel(instance.delegateID, names, 'App instance'),
              users: [...instance.users.values()].sort(sortByTitle),
            }))
            .sort(sortByTitle),
          storage: [...app.storage.values()]
            .map(displayStorage)
            .sort(sortByTitle),
        };
      })
      .sort(sortByTitle),
    errors,
    unassignedStorage: [...storageRows.values()]
      .filter(storage => !assignedStorage.has(storage.key))
      .map(displayStorage)
      .sort(sortByTitle),
  };
};
