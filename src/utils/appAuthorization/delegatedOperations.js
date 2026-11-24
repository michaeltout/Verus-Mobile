import {Buffer} from 'buffer';
import {
  AppEncryptionRequestOrdinalVDXFObject,
  AuthenticationRequestOrdinalVDXFObject,
  DataDescriptor,
  DataResponseOrdinalVDXFObject,
  GenericResponse,
  I_ADDR_VERSION,
  fromBase58Check,
} from 'verus-typescript-primitives';
import {hasAppAuthorizationRequest} from 'verusid-ts-client';
import store from '../../store';
import {requestServiceStoredData} from '../auth/authBox';
import {VERUSID_SERVICE_ID} from '../constants/services';
import {sha256} from '../crypto/hash';
import {modifyServiceStoredDataForUser} from '../../actions/actions/services/dispatchers/services';
import {authorizationContext} from './controls';
import {queueServiceStorageWrite} from '../asyncStore/passwordProtectedStorageQueue';

const COLLECTION_VERSION = 1;
const OPERATION_DOMAIN = 'VerusMobileDelegatedOperation/v1\0';
const owners = new Map();
const ENCRYPTION_STEP_PREFIX = 'app-encryption:';

/**
 * Local replay protection, scoped to this wallet profile. It does not promise
 * exactly-once execution across independent devices. Re-signing identical data
 * cannot create a new operation; the signer/system and raw request hash bind it.
 */
export const delegatedOperationID = request => {
  if (
    !request.isSigned() ||
    !request.hasAppOrDelegatorID() ||
    hasAppAuthorizationRequest(request)
  ) {
    throw new Error('Expected an ordinary signed delegated request.');
  }
  const ids = [request.signature.systemID, request.signature.identityID].map(
    compact => {
      const decoded = fromBase58Check(compact.toIAddress());
      if (decoded.version !== I_ADDR_VERSION || decoded.hash.length !== 20)
        throw new Error('Invalid delegate identity.');
      return decoded.hash;
    },
  );
  return sha256(
    Buffer.concat([
      Buffer.from(OPERATION_DOMAIN),
      ...ids,
      request.getRawDataSha256(),
    ]),
  ).toString('hex');
};

const collection = (data, accountHash) => {
  const value = data.delegatedOperations;
  if (!value) return {};
  if (
    value.version !== COLLECTION_VERSION ||
    value.accountHash !== accountHash ||
    !value.operations ||
    typeof value.operations !== 'object' ||
    Array.isArray(value.operations)
  ) {
    throw new Error(
      'Unsupported delegated-operation history. Existing receipts have been retained.',
    );
  }
  return value.operations;
};

const binding = (request, user, options) => {
  const context = authorizationContext(options, user);
  const id = delegatedOperationID(request);
  const accountHash = context.sessionScope.accountHash;
  const owner = JSON.stringify([
    context.sessionScope,
    store.getState().deeplink?.requestId,
  ]);
  return {
    context,
    id,
    accountHash,
    owner,
    key: `${accountHash}:${id}`,
    user: {...user},
  };
};

const sameUser = (left, right) =>
  left?.identityID === right.identityID && left?.systemID === right.systemID;

const encryptionStep = (request, index) => {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !(
      request.getDetails(index) instanceof AppEncryptionRequestOrdinalVDXFObject
    )
  ) {
    throw new Error('Invalid delegated encryption step.');
  }
  return `${ENCRYPTION_STEP_PREFIX}${index}`;
};

const assertEncryptionOnlyResume = (request, saved) => {
  const onlyEncryption =
    request.details.every(
      detail =>
        detail instanceof AuthenticationRequestOrdinalVDXFObject ||
        detail instanceof AppEncryptionRequestOrdinalVDXFObject,
    ) &&
    Object.entries(saved.steps || {}).every(([step, value]) => {
      const index = Number(step.slice(ENCRYPTION_STEP_PREFIX.length));
      return (
        step.startsWith(ENCRYPTION_STEP_PREFIX) &&
        !value.receipt &&
        Number.isSafeInteger(index) &&
        index >= 0 &&
        request.getDetails(index) instanceof
          AppEncryptionRequestOrdinalVDXFObject
      );
    });
  if (saved.responseHex || !onlyEncryption) {
    throw new Error(
      'This operation has other recorded effects. Reopen its saved response or request a new operation instead of executing again.',
    );
  }
};

const decodeEncryptionResult = (request, index, hex) => {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex))
    throw new Error('Invalid saved encryption response.');
  const bytes = Buffer.from(hex, 'hex');
  const responseDetail = new DataResponseOrdinalVDXFObject();
  if (
    responseDetail.fromBuffer(bytes) !== bytes.length ||
    !responseDetail.toBuffer().equals(bytes)
  )
    throw new Error('Invalid saved encryption response.');
  const descriptor = responseDetail.data.data;
  const requestedID = request.getDetails(index).data.requestID?.toIAddress();
  if (
    responseDetail.data.requestID?.toIAddress() !== requestedID ||
    descriptor.flags.and(DataDescriptor.FLAG_ENCRYPTED_DATA).isZero() ||
    descriptor.epk?.length !== 32 ||
    !descriptor.objectdata?.length ||
    descriptor.ivk?.length ||
    descriptor.ssk?.length
  ) {
    throw new Error(
      'The saved encryption response is not the requested encrypted result.',
    );
  }
  return {
    responseDetail,
    encryptedDescriptorJson: {
      version: descriptor.version.toNumber(),
      flags: descriptor.flags.toNumber(),
      objectdata: descriptor.objectdata.toString('hex'),
      epk: descriptor.epk.toString('hex'),
    },
  };
};

/** Called only after fresh grant/U checks; cached ciphertext never re-derives keys. */
export const loadDelegatedEncryptionResult = async (
  request,
  user,
  index,
  options = {},
) => {
  const operation = binding(request, user, options);
  const step = encryptionStep(request, index);
  // Share the writer's mutex without rewriting encrypted data. A response or
  // transaction reservation must not race the saved-step check and owner claim.
  return queueServiceStorageWrite(async () => {
    const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
    operation.context.assertActive();
    const saved = collection(data, operation.accountHash)[operation.id];
    if (!saved) return null;
    if (saved.id !== operation.id || !sameUser(saved.user, user))
      throw new Error(
        'The recorded encryption belongs to another operation or user.',
      );
    if (!saved.steps?.[step]) return null;
    assertEncryptionOnlyResume(request, saved);
    const result = decodeEncryptionResult(
      request,
      index,
      saved.steps[step].resultHex,
    );
    // Only saved ciphertext can resume across scans/restarts. Any consumed payment,
    // identity update or unfinished response-signing step remains fail-closed.
    owners.set(operation.key, operation.owner);
    return result;
  });
};

/** Commit consumption and its encrypted result together, before releasing it to UI. */
export const saveDelegatedEncryptionResult = async (
  request,
  user,
  index,
  result,
  options = {},
) => {
  const operation = binding(request, user, options);
  const {context, id, accountHash, owner, key} = operation;
  const step = encryptionStep(request, index);
  const candidateHex = result.responseDetail.toBuffer().toString('hex');
  decodeEncryptionResult(request, index, candidateHex);
  let resultHex;
  await modifyServiceStoredDataForUser(
    data => {
      context.assertActive();
      const operations = collection(data, accountHash);
      const previous = operations[id];
      if (previous && (previous.id !== id || !sameUser(previous.user, user)))
        throw new Error(
          'The recorded encryption belongs to another operation or user.',
        );
      if (
        previous?.responseHex ||
        previous?.steps?.[step] ||
        (previous && owners.get(key) !== owner)
      ) {
        assertEncryptionOnlyResume(request, previous);
      }
      // A step and its ciphertext are committed together. A recorded step with
      // no valid result is incomplete, not permission to derive a replacement.
      const savedStep = previous?.steps?.[step];
      resultHex = savedStep ? savedStep.resultHex : candidateHex;
      decodeEncryptionResult(request, index, resultHex);
      owners.set(key, owner);
      return {
        ...data,
        delegatedOperations: {
          version: COLLECTION_VERSION,
          accountHash,
          operations: {
            ...operations,
            [id]: {
              ...(previous || {id, user: {...user}, createdAt: Date.now()}),
              steps: {
                ...previous?.steps,
                [step]: {
                  startedAt: previous?.steps?.[step]?.startedAt || Date.now(),
                  resultHex,
                },
              },
            },
          },
        },
      };
    },
    VERUSID_SERVICE_ID,
    accountHash,
    context,
  );
  context.assertActive();
  return decodeEncryptionResult(request, index, resultHex);
};

const assertResponseBinding = (request, user, response) => {
  if (
    !response.isSigned() ||
    !response.signature?.signatureAsVch?.length ||
    response.signature.identityID.toIAddress() !== user.identityID ||
    response.signature.systemID.toIAddress() !== user.systemID ||
    response.appOrDelegatorID?.toIAddress() !==
      request.appOrDelegatorID.toIAddress() ||
    !response.requestHash?.equals(request.getRawDataSha256())
  ) {
    throw new Error(
      'The prepared response does not match this delegated request and user.',
    );
  }
};

/** Reserve a particular irreversible step after approval and current grant checks. */
export const reserveDelegatedExecution = async (
  request,
  user,
  step,
  options = {},
) => {
  if (typeof step !== 'string' || !step.length)
    throw new Error('A delegated execution step is required.');
  const operation = binding(request, user, options);
  const {context, id, accountHash, owner, key} = operation;
  const activeOwner = owners.get(key);
  if (activeOwner && activeOwner !== owner)
    throw new Error('This delegated request is already being processed.');

  await modifyServiceStoredDataForUser(
    data => {
      context.assertActive();
      const operations = collection(data, accountHash);
      const previous = operations[id];
      if (
        previous &&
        (owners.get(key) !== owner || !sameUser(previous.user, user))
      ) {
        throw new Error(
          'This delegated request was already started. Its recorded outcome must be reconciled; request a new operation before executing again.',
        );
      }
      if (previous?.responseHex || previous?.steps?.[step]) {
        throw new Error(
          'This delegated operation step has already been executed.',
        );
      }
      // Ownership lives only in memory. A restart or a newly scanned copy cannot
      // reuse a durable consumed record as permission for another side effect.
      owners.set(key, owner);
      return {
        ...data,
        delegatedOperations: {
          version: COLLECTION_VERSION,
          accountHash,
          operations: {
            ...operations,
            [id]: {
              ...(previous || {id, user: {...user}, createdAt: Date.now()}),
              steps: {...previous?.steps, [step]: {startedAt: Date.now()}},
            },
          },
        },
      };
    },
    VERUSID_SERVICE_ID,
    accountHash,
    context,
  );
  context.assertActive();
  return operation;
};

const updateOperation = async (operation, update) => {
  const {context, accountHash, id, owner, key} = operation;
  await modifyServiceStoredDataForUser(
    data => {
      context.assertActive();
      const operations = collection(data, accountHash);
      const previous = operations[id];
      if (
        !previous ||
        owners.get(key) !== owner ||
        !sameUser(previous.user, operation.user)
      ) {
        throw new Error(
          'The delegated operation no longer belongs to this request.',
        );
      }
      return {
        ...data,
        delegatedOperations: {
          version: COLLECTION_VERSION,
          accountHash,
          operations: {...operations, [id]: update(previous)},
        },
      };
    },
    VERUSID_SERVICE_ID,
    accountHash,
    context,
  );
  context.assertActive();
};

/** Release only a reservation whose signing callback has never been entered. */
export const releaseDelegatedSigningReservation = (operation, step) =>
  updateOperation(operation, previous => {
    const reserved = previous.steps?.[step];
    if (
      !reserved ||
      previous.responseHex ||
      reserved.receipt ||
      reserved.resultHex
    )
      throw new Error('A recorded delegated result cannot be released.');
    const steps = {...previous.steps};
    delete steps[step];
    return {...previous, steps};
  });

/** Keep exact transaction receipts for later reconciliation, including uncertain sends. */
export const recordDelegatedTransaction = (operation, step, receipt) =>
  updateOperation(operation, previous => {
    if (!previous.steps[step] || previous.steps[step].receipt)
      throw new Error('Delegated transaction was already recorded.');
    return {
      ...previous,
      steps: {...previous.steps, [step]: {...previous.steps[step], receipt}},
    };
  });

/** Freeze the signed ciphertext; callback failure must not recreate or re-sign it. */
export const saveDelegatedResponse = async (
  request,
  user,
  response,
  options = {},
) => {
  const operation = binding(request, user, options);
  assertResponseBinding(request, user, response);
  const responseHex = response.toBuffer().toString('hex');
  await updateOperation(operation, previous => {
    if (previous.responseHex && previous.responseHex !== responseHex)
      throw new Error('A prepared response cannot be replaced.');
    return {...previous, responseHex};
  });
};

const readPreparedDelegatedResponse = async (request, user, options) => {
  const operation = binding(request, user, options);
  const requestHex = request.toBuffer().toString('hex');
  const testnet =
    Object.keys(
      store.getState().authentication.activeAccount?.testnetOverrides || {},
    ).length > 0;
  if (testnet !== request.isTestnet())
    throw new Error(
      'The saved response belongs to a different wallet network.',
    );
  const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
  operation.context.assertActive();
  if (request.toBuffer().toString('hex') !== requestHex)
    throw new Error('The delegated request changed during response lookup.');
  const saved = collection(data, operation.accountHash)[operation.id];
  if (!saved?.responseHex) return null;
  if (saved.id !== operation.id || (user && !sameUser(saved.user, user))) {
    throw new Error(
      'The saved response belongs to a different operation or user identity.',
    );
  }
  if (
    typeof saved.responseHex !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/i.test(saved.responseHex)
  ) {
    throw new Error('The saved delegated response has invalid encoding.');
  }
  const response = new GenericResponse();
  const bytes = Buffer.from(saved.responseHex, 'hex');
  if (
    response.fromBuffer(bytes) !== bytes.length ||
    !response.toBuffer().equals(bytes)
  ) {
    throw new Error(
      'The saved response does not match this delegated request.',
    );
  }
  assertResponseBinding(request, saved.user, response);
  return {
    response,
    user: {identityID: saved.user.identityID, systemID: saved.user.systemID},
  };
};

export const loadDelegatedResponse = async (request, user, options = {}) =>
  (await readPreparedDelegatedResponse(request, user, options))?.response ||
  null;

/** Resume delivery after a scan/restart without replaying any request handler. */
export const findPreparedDelegatedResponse = (request, options = {}) =>
  readPreparedDelegatedResponse(request, undefined, options);
