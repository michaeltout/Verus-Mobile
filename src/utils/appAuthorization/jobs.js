import {Buffer} from 'buffer';
import {GenericRequest} from 'verus-typescript-primitives';
import {
  getAppAuthorizationOperationID,
  validateAppAuthorizationRequest,
} from 'verusid-ts-client';
import store from '../../store';
import {requestServiceStoredData} from '../auth/authBox';
import {VERUSID_SERVICE_ID} from '../constants/services';
import {SET_APP_AUTHORIZATION_JOBS} from '../constants/storeType';
import {sha256} from '../crypto/hash';
import {modifyServiceStoredDataForUser} from '../../actions/actions/services/dispatchers/services';
import {
  captureSessionScope,
  scopeSessionAction,
  sessionScopeIsCurrent,
} from '../../actions/actions/updates/sessionRequests';

const COLLECTION_VERSION = 1;
const REFRESH_INTERVAL_MS = 30000;
const MAX_REFRESH_JOBS = 3;
const activeRefreshes = new Set();
const lastRefreshes = new Map();

export {AUTHORIZATION_STATUS} from './constants';
import {AUTHORIZATION_STATUS} from './constants';

const activeOperations = new Set();

// One local lock covers authorization writes and delivery for a job.
export const withAuthorizationJob = async (jobId, context, operation) => {
  const key = `${context.sessionScope.accountHash}:${jobId}`;
  if (activeOperations.has(key))
    throw new Error('This authorization is already being processed.');
  activeOperations.add(key);
  try {
    assertAuthorizationContext(context);
    return await operation();
  } finally {
    activeOperations.delete(key);
  }
};

export const captureAuthorizationContext = (context = {}) => ({
  ...context,
  sessionScope: context.sessionScope || captureSessionScope(store.getState()),
  network:
    context.network ??
    JSON.stringify(
      store.getState().authentication.activeAccount?.testnetOverrides || {},
    ),
});

export const assertAuthorizationContext = context => {
  const state = store.getState();
  if (
    context.signal?.aborted ||
    !context.sessionScope?.accountHash ||
    !sessionScopeIsCurrent(state, context.sessionScope) ||
    JSON.stringify(
      state.authentication.activeAccount?.testnetOverrides || {},
    ) !== context.network
  ) {
    throw Object.assign(
      new Error('The wallet changed. Open the authorization again.'),
      {code: 'SESSION_CHANGED'},
    );
  }
  context.assertActive?.();
};

// Deliberately allowlist fields. The original request can contain a gift seed;
// signed transaction bytes and response contents also stay in encrypted storage.
export const summarizeAuthorizationJob = job => ({
  id: job.id,
  accountHash: job.accountHash,
  systemId: job.systemId,
  delegateId: job.delegateId,
  appId: job.appId,
  status: job.status,
  kind: job.kind,
  ...(job.kind === 'removal' ? {selectedIdentity: job.selectedIdentity} : {}),
  expiryTime: job.expiryTime,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  hasGift: job.hasGift === true,
  giftRecoveryPending:
    !!job.authorizationPlan &&
    job.hasGift &&
    !!job.transactions?.grant &&
    !job.giftConfirmed,
  grantTxid: job.grantTransaction?.txid,
});

const readJobs = (data, context) => {
  const collection = data.authorizationJobs;
  if (collection == null) return {};
  if (
    collection.version !== COLLECTION_VERSION ||
    collection.accountHash !== context.sessionScope.accountHash ||
    !collection.jobs ||
    typeof collection.jobs !== 'object' ||
    Array.isArray(collection.jobs)
  ) {
    throw new Error(
      'Unsupported app authorization storage. Existing recovery data has been retained.',
    );
  }
  for (const [id, job] of Object.entries(collection.jobs)) {
    if (
      job.id !== id ||
      job.accountHash !== collection.accountHash ||
      !/^[a-f0-9]{64}$/.test(id)
    ) {
      throw new Error(
        'App authorization storage belongs to a different operation or wallet.',
      );
    }
  }
  return collection.jobs;
};

const publish = (jobs, context) => {
  assertAuthorizationContext(context);
  const summaries = Object.fromEntries(
    Object.entries(jobs).map(([id, job]) => [
      id,
      summarizeAuthorizationJob(job),
    ]),
  );
  store.dispatch(
    scopeSessionAction(
      {
        type: SET_APP_AUTHORIZATION_JOBS,
        payload: {authorizationJobs: summaries},
      },
      context.sessionScope,
    ),
  );
  return summaries;
};

const loadJobs = async context => {
  assertAuthorizationContext(context);
  const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
  assertAuthorizationContext(context);
  return readJobs(data, context);
};

// Management can reuse the validated journal for display relationships without
// treating its historical grants as current authorization evidence.
export {loadJobs as loadAuthorizationJobs};

export const requestFromAuthorizationJob = job => {
  const request = new GenericRequest();
  const bytes = Buffer.from(job.requestHex, 'hex');
  if (
    request.fromBuffer(bytes) !== bytes.length ||
    getAppAuthorizationOperationID(request) !== job.id
  ) {
    throw new Error(
      'The saved authorization request does not match this operation.',
    );
  }
  return request;
};

export const getAuthorizationJob = async (id, options) => {
  const context = captureAuthorizationContext(options);
  const jobs = await loadJobs(context);
  const job = jobs[id];
  if (!job) throw new Error('App authorization was not found in this wallet.');
  if (job.network !== context.network)
    throw new Error(
      'Switch to the original network to continue this authorization.',
    );
  return job;
};

export const findAuthorizationJob = async (request, options) => {
  const context = captureAuthorizationContext(options);
  const id = getAppAuthorizationOperationID(request);
  const jobs = await loadJobs(context);
  return jobs[id]?.network === context.network ? jobs[id] : null;
};

const writeJob = async (id, updater, context, create = false) => {
  let saved;
  let changed = false;
  const data = await modifyServiceStoredDataForUser(
    current => {
      assertAuthorizationContext(context);
      const jobs = readJobs(current, context);
      const previous = jobs[id];
      if (!previous && !create)
        throw new Error('App authorization was not found in this wallet.');
      const proposed = updater(previous);
      if (proposed?.then)
        throw new Error('Authorization storage updates must be synchronous.');
      if (previous) {
        for (const field of [
          'id',
          'accountHash',
          'network',
          'requestHex',
          'systemId',
          'delegateId',
          'appId',
          'expiryTime',
        ]) {
          if (proposed[field] !== previous[field])
            throw new Error(
              'A saved authorization request cannot be replaced.',
            );
        }
        if (proposed.revision !== previous.revision)
          throw new Error(
            'Authorization changed. Reload its current progress.',
          );
        if (
          previous.responseHex &&
          proposed.responseHex !== previous.responseHex
        ) {
          throw new Error(
            'A prepared authorization response cannot be changed.',
          );
        }
        if (
          previous.appEncryptionResponse &&
          JSON.stringify(proposed.appEncryptionResponse) !==
            JSON.stringify(previous.appEncryptionResponse)
        ) {
          throw new Error(
            'A prepared authorization encryption result cannot be changed.',
          );
        }
        // Reconciliation often observes the same chain state. Returning the
        // existing service document skips encryption and leaves its revision
        // unchanged, so subscribers do not reload an unchanged job.
        if (JSON.stringify(proposed) === JSON.stringify(previous)) {
          saved = previous;
          return current;
        }
      }
      changed = true;
      saved = {
        ...proposed,
        revision: (previous?.revision || 0) + 1,
        updatedAt: Date.now(),
      };
      return {
        ...current,
        authorizationJobs: {
          version: COLLECTION_VERSION,
          accountHash: context.sessionScope.accountHash,
          jobs: {...jobs, [id]: saved},
        },
      };
    },
    VERUSID_SERVICE_ID,
    context.sessionScope.accountHash,
    context,
  );
  assertAuthorizationContext(context);
  if (changed) publish(readJobs(data, context), context);
  return saved;
};

export const updateAuthorizationJob = (id, update, options) => {
  const context = captureAuthorizationContext(options);
  return writeJob(
    id,
    previous =>
      typeof update === 'function'
        ? update(previous)
        : {...previous, ...update},
    context,
  );
};

export const createAuthorizationJob = async (request, options) => {
  const context = captureAuthorizationContext(options);
  assertAuthorizationContext(context);
  const {authentication, authorization} = validateAppAuthorizationRequest(
    request,
    {checkExpiry: false},
  );
  const id = getAppAuthorizationOperationID(request);
  const requestHex = request.toBuffer().toString('hex');
  // Signature encodings may differ for one logical request. The first admitted
  // bytes remain authoritative, so replay cannot install a deleted grant anew.
  return writeJob(
    id,
    previous => {
      if (previous) return previous;
      validateAppAuthorizationRequest(request);
      return {
        id,
        accountHash: context.sessionScope.accountHash,
        network: context.network,
        pendingDeeplinkId: context.pendingDeeplinkId,
        requestHex,
        systemId: request.signature.systemID.toIAddress(),
        delegateId: request.signature.identityID.toIAddress(),
        appId: request.appOrDelegatorID.toIAddress(),
        expiryTime: authentication.expiryTime.toNumber(),
        hasGift: authorization.gift != null,
        status: authorization.gift
          ? AUTHORIZATION_STATUS.GIFT_REVIEW
          : AUTHORIZATION_STATUS.RECEIVED,
        createdAt: Date.now(),
      };
    },
    context,
    true,
  );
};

// Management is a local user action, independent of an app request. Its stable
// target set makes interrupted removals resumable after restart.
export const authorizationMaintenanceUsers = (user, options = {}) => {
  const users = new Map();
  for (const current of [user, ...(options.relatedUsers || [])]) {
    if (current.systemID !== user.systemID) {
      throw new Error(
        'App access can only be changed across identities on the same network.',
      );
    }
    users.set(current.identityID, {
      identityID: current.identityID,
      systemID: current.systemID,
    });
  }
  return [...users.values()].sort((left, right) =>
    left.identityID.localeCompare(right.identityID),
  );
};

export const createAuthorizationMaintenanceJob = async (
  user,
  targets,
  options,
) => {
  const context = captureAuthorizationContext(options);
  assertAuthorizationContext(context);
  const id = sha256(
    Buffer.from(
      JSON.stringify(['app-authorization-removal', user, targets]),
      'utf8',
    ),
  ).toString('hex');
  return writeJob(
    id,
    previous =>
      previous || {
        id,
        kind: 'removal',
        accountHash: context.sessionScope.accountHash,
        network: context.network,
        selectedIdentity: {...user},
        systemId: user.systemID,
        targets,
        status: AUTHORIZATION_STATUS.READY,
        createdAt: Date.now(),
      },
    context,
    true,
  );
};

export const publishAuthorizationJobs = async options => {
  const context = captureAuthorizationContext(options);
  return publish(await loadJobs(context), context);
};

// Foreground service refresh performs bounded reconciliation only. It never
// approves an update, unlocks a new signing key, or submits another transaction.
export const refreshAuthorizationJobs = async options => {
  const context = captureAuthorizationContext(options);
  const scope = `${context.sessionScope.accountHash}:${context.sessionScope.sessionEpoch}`;
  const jobs = await loadJobs(context);
  publish(jobs, context);
  if (activeRefreshes.has(scope)) return;
  activeRefreshes.add(scope);
  try {
    const candidates = Object.values(jobs)
      .filter(
        job =>
          job.network === context.network &&
          !activeOperations.has(
            `${context.sessionScope.accountHash}:${job.id}`,
          ) &&
          ((job.status !== AUTHORIZATION_STATUS.COMPLETE &&
            job.status !== AUTHORIZATION_STATUS.RESPONSE_READY &&
            job.status !== AUTHORIZATION_STATUS.CANCELLED) ||
            (job.authorizationPlan &&
              job.transactions?.grant &&
              ((job.hasGift && !job.giftConfirmed) ||
                (job.status === AUTHORIZATION_STATUS.CANCELLED &&
                  job.storageBindings?.length &&
                  !job.storageIdentitiesManaged)))) &&
          Date.now() - (lastRefreshes.get(`${scope}:${job.id}`) || 0) >=
            REFRESH_INTERVAL_MS,
      )
      .slice(0, MAX_REFRESH_JOBS);
    for (const job of candidates) {
      lastRefreshes.set(`${scope}:${job.id}`, Date.now());
      try {
        const {reconcileAuthorizationJob} = require('./workflow');
        await reconcileAuthorizationJob(job.id, context);
      } catch (_) {
        assertAuthorizationContext(context);
        // RPC failure is not evidence of transaction failure. Keep the receipt.
      }
    }
  } finally {
    activeRefreshes.delete(scope);
    for (const key of lastRefreshes.keys())
      if (!key.startsWith(`${scope}:`)) lastRefreshes.delete(key);
  }
};
