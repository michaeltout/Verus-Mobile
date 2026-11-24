import { SERVICE_STORAGE_INTERNAL_KEY } from "../../../env/index";
import {
  GIFT_CARD_SERVICE_ID,
  VERUSID_SERVICE_ID,
  WYRE_SERVICE_ID,
} from "../constants/services";
import { SecureStorage } from "../keychain/secureStore";

export const storeServiceStoredData = (data) => {
  if (typeof data !== "object")
    throw new Error(
      `Service auth store function expected object, received ${typeof data}`
    );

  return new Promise((resolve, reject) => {
    SecureStorage.setItem(
      SERVICE_STORAGE_INTERNAL_KEY,
      JSON.stringify(data)
    )
      .then(() => {
        resolve(data);
      })
      .catch((err) => reject(err));
  });
};

export const loadServiceStoredData = async () => {
  const stored = await SecureStorage.getItem(SERVICE_STORAGE_INTERNAL_KEY);
  return stored ? JSON.parse(stored) : {};
};

export const clearServiceStoredData = () => {
  return new Promise((resolve, reject) => {
    SecureStorage.removeItem(SERVICE_STORAGE_INTERNAL_KEY)
      .then(() => {
        resolve();
      })
      .catch((err) => reject(err));
  });
};

export const storeServiceStoredDataForUser = async (
  data,
  accountHash,
  // Reuse a snapshot only while holding the service-storage write queue.
  allStoredData = null,
) => {
  const stored = allStoredData || await loadServiceStoredData();
  return (await storeServiceStoredData({...stored, [accountHash]: data}))[
    accountHash
  ];
};

export const deleteServiceStoredDataForUser = async (accountHash) => {
  let allStoredData = { ...(await loadServiceStoredData()) };
  delete allStoredData[accountHash]
  return (await storeServiceStoredData(allStoredData))[accountHash];
};

export const loadServiceStoredDataForUser = async (accountHash) => {
  const allStoredData = await loadServiceStoredData();

  if (allStoredData[accountHash] == null)
    return {
      [WYRE_SERVICE_ID]: null,
      [VERUSID_SERVICE_ID]: null,
      [GIFT_CARD_SERVICE_ID]: null,
    };
  else return allStoredData[accountHash];
};
