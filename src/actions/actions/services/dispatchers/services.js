import store from "../../../../store";
import {
  deleteServiceStoredDataForUser,
  loadServiceStoredData,
  loadServiceStoredDataForUser,
  storeServiceStoredDataForUser,
} from "../../../../utils/asyncStore/serviceStoredDataStorage";
import { requestPassword, requestServiceStoredData } from "../../../../utils/auth/authBox";
import {
  CONNECTED_SERVICES,
  WYRE_SERVICE_ID,
} from "../../../../utils/constants/services";
import { decryptkey, encryptkey } from "../../../../utils/seedCrypt";
import WyreProvider from "../../../../utils/services/WyreProvider";
import { setServiceStored } from "../creators/services";
import { queueServiceStorageWrite } from "../../../../utils/asyncStore/passwordProtectedStorageQueue";
import {
  captureSessionScope,
  scopeSessionAction,
  sessionScopeIsCurrent,
} from "../../updates/sessionRequests";

const getOriginatingSessionScope = (accountHash, requestContext) =>
  requestContext?.sessionScope ||
  (requestContext?.sessionScoped ? requestContext : null) ||
  captureSessionScope(store.getState(), accountHash);

const assertOriginatingSessionCurrent = (sessionScope, requestContext) => {
  if (
    requestContext?.signal?.aborted === true ||
    !sessionScopeIsCurrent(store.getState(), sessionScope)
  ) {
    const error = new Error(
      "Account changed while service data was being updated.",
    );
    error.code = "SESSION_CHANGED";
    throw error;
  }
};

const decryptServiceData = (encryptedData, password, service) => {
  if (encryptedData == null) return {};

  const decrypted = decryptkey(password, encryptedData);

  if (decrypted === false) {
    throw new Error("Unable to decrypt service stored data for " + service);
  }

  try {
    return JSON.parse(decrypted);
  } catch (_) {
    throw new Error("Unable to parse service stored data for " + service);
  }
};

export const saveEncryptedServiceStoredDataForUser = async (
  encryptedData = {},
  accountHash,
  requestContext,
  allStoredData,
) => {
  const sessionScope = getOriginatingSessionScope(accountHash, requestContext);
  assertOriginatingSessionCurrent(sessionScope, requestContext);
  const serviceStoredData = await storeServiceStoredDataForUser(
    encryptedData,
    accountHash,
    allStoredData,
  );
  assertOriginatingSessionCurrent(sessionScope, requestContext);
  store.dispatch(scopeSessionAction(setServiceStored(encryptedData), sessionScope));
  return serviceStoredData;
};

export const clearEncryptedServiceStoredDataForUser = async (
  accountHash
) => {
  const sessionScope = captureSessionScope(store.getState(), accountHash);

  return queueServiceStorageWrite(async () => {
    const serviceStoredData = await deleteServiceStoredDataForUser(
      accountHash
    );
    store.dispatch(scopeSessionAction(setServiceStored({}), sessionScope));
    return serviceStoredData;
  });
};

export const modifyServiceStoredDataForUser = async (
  data = {},
  service,
  accountHash,
  requestContext,
) => {
  const sessionScope = getOriginatingSessionScope(accountHash, requestContext);
  const scopedRequestContext = {
    ...(requestContext || {}),
    sessionScope,
  };

  if (sessionScope.accountHash !== accountHash) {
    throw new Error("Service data account does not match its originating session.");
  }
  assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);

  return queueServiceStorageWrite(async () => {
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);
    // The queue protects this snapshot until the write completes. Reusing it
    // avoids decrypting every profile's service data again just to save one.
    const allStoredData = await loadServiceStoredData();
    const serviceStoredData = {...allStoredData[accountHash]};
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);
    const password = await requestPassword(scopedRequestContext);
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);
    const currentData = decryptServiceData(
      serviceStoredData[service],
      password,
      service,
    );
    const nextData =
      typeof data === "function" ? await data(currentData) : data;
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);

    // Functional updates can explicitly keep the existing value. Polling an
    // unchanged job must not encrypt, persist, or publish the same data again.
    if (nextData === currentData) return nextData;

    serviceStoredData[service] = await encryptkey(
      password,
      JSON.stringify(nextData)
    );
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);
    await saveEncryptedServiceStoredDataForUser(
      serviceStoredData,
      accountHash,
      scopedRequestContext,
      allStoredData,
    );
    assertOriginatingSessionCurrent(sessionScope, scopedRequestContext);

    return nextData;
  });
};

export const resetServicesStoredEncryptionForUser = async (
  accountHash,
  oldPwd
) => {
  const sessionScope = captureSessionScope(store.getState(), accountHash);

  return queueServiceStorageWrite(async () => {
    let serviceStoredData = { ...(await loadServiceStoredDataForUser(accountHash)) };

    // Iterate through every key in the services data object and re-encrypt it with the current password
    for (let key in serviceStoredData) {
      if (serviceStoredData[key] == null) {
        continue;
      };

      const data = await requestServiceStoredData(key, oldPwd);
      serviceStoredData[key] = await encryptkey(await requestPassword(), JSON.stringify(data))
    }

    await saveEncryptedServiceStoredDataForUser(
      serviceStoredData,
      accountHash,
      sessionScope,
    );

    return serviceStoredData;
  });
};

export const initServiceStoredDataForUser = async (accountHash) => {
  const sessionScope = captureSessionScope(store.getState(), accountHash);
  const serviceStoredData = await loadServiceStoredDataForUser(accountHash);
  store.dispatch(
    scopeSessionAction(setServiceStored(serviceStoredData), sessionScope),
  );
  return serviceStoredData;
};

export const resetServices = async () => {
  const CONNECTED_SERVICE_PROVIDERS = {
    [WYRE_SERVICE_ID]: WyreProvider
  }

  for (const connectedService of CONNECTED_SERVICES) {    
    try {
      if (CONNECTED_SERVICE_PROVIDERS[connectedService]) {
        await CONNECTED_SERVICE_PROVIDERS[connectedService].reset();
      }
    } catch (e) {
      console.warn(e);
    }
  }
};
