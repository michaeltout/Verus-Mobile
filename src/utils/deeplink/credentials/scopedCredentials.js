import {
  Credential,
  CredentialKey,
  DataDescriptor,
  DataDescriptorKey,
  FqnVdxfUniValue,
  IDENTITY_CREDENTIAL,
  VdxfUniValue,
  fromBase58Check,
  toBase58Check,
} from "verus-typescript-primitives";
import { I_ADDR_VERSION } from "verus-typescript-primitives/dist/constants/vdxf";
import { CoinDirectory } from "../../CoinData/CoinDirectory";
import { getIdentityContent } from "../../api/channels/verusid/requests/getIdentityContent";
import { decryptData } from "../../api/channels/dlight/requests/decrypt";
import { zGetEncryptionAddress } from "../../api/channels/dlight/requests/zGetEncryptionAddress";
import { getConditionID } from "../../crypto/encryptCredentials";
import { getKeyMaterial } from "../../crypto/getKeyMaterial";
import {assertNoAppAuthorizationCredentials} from '../../appAuthorization/requestPolicy';

const asArray = value => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const scopeMatches = (credential, scope) => {
  if (!scope) return false;

  const scopes = credential.scopes;
  if (Array.isArray(scopes)) return scopes.includes(scope);

  if (scopes != null && typeof scopes === "object") {
    return (
      Object.keys(scopes).includes(scope) ||
      Object.values(scopes).includes(scope)
    );
  }

  return scopes === scope;
};

const parseVdxfUniValue = buffer => {
  const value = new VdxfUniValue();
  if (value.fromBuffer(buffer, 0) !== buffer.length) {
    throw new Error('Trailing encrypted credential data.');
  }
  return value;
};

const parseFqnVdxfUniValue = buffer => {
  const value = new FqnVdxfUniValue();
  if (value.fromBuffer(buffer, 0) !== buffer.length) {
    throw new Error('Trailing encrypted credential wrapper.');
  }
  return value;
};

const extractCredentialFromInnerDescriptor = descriptor => {
  if (!(descriptor instanceof DataDescriptor) || !descriptor.objectdata) {
    return [];
  }

  const innerValue = parseVdxfUniValue(descriptor.objectdata);
  const credentials = [];

  for (const entry of innerValue.values) {
    const credential = entry[CredentialKey.vdxfid];

    if (credential instanceof Credential) {
      credentials.push(credential);
    }
  }

  return credentials;
};

const extractCredentialsFromPlaintext = plaintextBuffer => {
  const outerValue = parseVdxfUniValue(plaintextBuffer);
  const credentials = [];

  for (const entry of outerValue.values) {
    const credential = entry[CredentialKey.vdxfid];
    if (credential instanceof Credential) {
      credentials.push(credential);
      continue;
    }

    const descriptor = entry[DataDescriptorKey.vdxfid];
    credentials.push(...extractCredentialFromInnerDescriptor(descriptor));
  }

  return credentials;
};

const parseDescriptorJson = value => {
  if (value instanceof DataDescriptor) return value;
  if (value == null || typeof value !== "object") return null;

  try {
    return DataDescriptor.fromJson(value);
  } catch (_) {
    return null;
  }
};

const getDescriptorFromStoredValue = storedValue => {
  if (storedValue instanceof DataDescriptor) return storedValue;

  if (typeof storedValue === "string") {
    const value = parseFqnVdxfUniValue(Buffer.from(storedValue, "hex"));

    for (const [key, data] of value.entries()) {
      if (key.toAddress() === DataDescriptorKey.vdxfid && data instanceof DataDescriptor) {
        return data;
      }
    }
  }

  if (storedValue != null && typeof storedValue === "object") {
    const descriptorData =
      storedValue[DataDescriptorKey.vdxfid] ||
      storedValue[DataDescriptorKey.qualifiedname.name];

    const descriptor = parseDescriptorJson(descriptorData);
    if (descriptor instanceof DataDescriptor) return descriptor;

    if (storedValue.objectdata != null) {
      return parseDescriptorJson(storedValue);
    }
  }

  return null;
};

const decryptCredentialDescriptor = async (descriptor, fallbackIvkHex) => {
  if (!(descriptor instanceof DataDescriptor)) return [];

  const symmetricKeyHex = descriptor.ssk ? descriptor.ssk.toString("hex") : null;
  let ivkHex = descriptor.ivk ? descriptor.ivk.toString("hex") : fallbackIvkHex;
  let ephemeralPublicKeyHex = descriptor.epk ? descriptor.epk.toString("hex") : null;

  if (symmetricKeyHex) {
    ivkHex = null;
    ephemeralPublicKeyHex = null;
  }

  const plaintext = await decryptData({
    ivkHex,
    ephemeralPublicKeyHex,
    ciphertextHex: descriptor.objectdata.toString("hex"),
    symmetricKeyHex,
  });

  const plaintextBuffer = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(plaintext, "hex");

  return extractCredentialsFromPlaintext(plaintextBuffer);
};

/**
 * Authorization reads must authenticate with this user's self channel. Public
 * IVKs/SSKs supplied inside an untrusted wrapper cannot replace that key, and a
 * failed/opaque entry cannot be skipped to produce an incomplete grant view.
 */
export const decryptAuthorizationCredentialValue = async (
  storedBytes,
  ivkHex,
  assertActive,
) => {
  // Generic credentials currently use compact wrappers in the same self bucket.
  // They remain readable, but authorization records must use the native format.
  const nativeTypeKey = fromBase58Check(DataDescriptorKey.vdxfid).hash;
  const native = storedBytes
    .subarray(0, nativeTypeKey.length)
    .equals(nativeTypeKey);
  const wrapper = native
    ? parseVdxfUniValue(storedBytes)
    : parseFqnVdxfUniValue(storedBytes);
  const entries = native
    ? wrapper.values.flatMap(Object.entries)
    : [...wrapper.entries()].map(([key, value]) => [key.toAddress(), value]);
  const descriptor = entries[0]?.[1];

  if (
    entries.length !== 1 ||
    entries[0][0] !== DataDescriptorKey.vdxfid ||
    !(descriptor instanceof DataDescriptor) ||
    !descriptor.hasEncryptedData() ||
    descriptor.ivk?.length ||
    descriptor.ssk?.length ||
    descriptor.epk?.length !== 32 ||
    descriptor.objectdata?.length <= 16 ||
    !wrapper.toBuffer().equals(storedBytes)
  ) {
    throw new Error('Invalid self-encrypted authorization credential wrapper.');
  }

  assertActive();
  const plaintext = await decryptData({
    ivkHex,
    ephemeralPublicKeyHex: descriptor.epk.toString('hex'),
    ciphertextHex: descriptor.objectdata.toString('hex'),
  });
  assertActive();

  if (typeof plaintext !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(plaintext)) {
    throw new Error(
      'Invalid authenticated authorization credential plaintext.',
    );
  }

  const bytes = Buffer.from(plaintext, 'hex');
  if (bytes.length + 16 !== descriptor.objectdata.length) {
    throw new Error('Invalid authenticated authorization credential length.');
  }

  let decoded = parseVdxfUniValue(bytes);
  if (
    decoded.values.length !== 1 ||
    Object.keys(decoded.values[0]).length !== 1
  ) {
    throw new Error(
      'An encrypted credential must contain one complete record.',
    );
  }
  const inner = decoded.values[0][DataDescriptorKey.vdxfid];
  if (inner) {
    if (!(inner instanceof DataDescriptor) || inner.hasEncryptedData()) {
      throw new Error('Invalid inner credential descriptor.');
    }
    decoded = parseVdxfUniValue(inner.objectdata);
  }
  if (
    decoded.values.length !== 1 ||
    Object.keys(decoded.values[0]).length !== 1 ||
    !(decoded.values[0][CredentialKey.vdxfid] instanceof Credential)
  ) {
    throw new Error(
      'The encrypted credential could not be decoded completely.',
    );
  }
  const credential = decoded.values[0][CredentialKey.vdxfid];
  // Ordinary generic credentials may also use direct credential plaintext.
  // Authorization writes always use a native wrapper and an inner descriptor.
  if (!native || !inner) assertNoAppAuthorizationCredentials(credential);
  return [credential];
};

export const getScopedCredentials = async ({
  systemID,
  identityAddress,
  scope,
  credentialKeys,
}) => {
  const coinObj = CoinDirectory.getBasicCoinObj(systemID);

  if (!coinObj) {
    throw new Error("Unsupported system: " + systemID);
  }

  const keyMaterial = await getKeyMaterial(coinObj.id);
  const identityHash = fromBase58Check(identityAddress).hash;
  const idHex = Buffer.from(identityHash).toString("hex");

  const keys = await zGetEncryptionAddress(coinObj.system_id, {
    ...keyMaterial,
    fromId: idHex,
    toId: idHex,
  });

  if (!keys.ivk) {
    throw new Error("Unable to derive credential viewing key.");
  }

  const hashedKey = toBase58Check(
    getConditionID(IDENTITY_CREDENTIAL.vdxfid, keys.ivk),
    I_ADDR_VERSION,
  );

  const contentRes = await getIdentityContent(
    coinObj.system_id,
    identityAddress,
  );

  if (contentRes.error) {
    throw new Error(contentRes.error.message);
  }

  const contentMultiMap = contentRes.result?.identity?.contentmultimap || {};
  const encryptedEntries = asArray(contentMultiMap[hashedKey]);
  const requestedKeys = new Set(credentialKeys || []);
  const credentials = [];

  for (const entry of encryptedEntries) {
    try {
      const descriptor = getDescriptorFromStoredValue(entry);
      const decryptedCredentials = await decryptCredentialDescriptor(descriptor, keys.ivk);

      for (const credential of decryptedCredentials) {
        if (
          requestedKeys.has(credential.credentialKey) &&
          scopeMatches(credential, scope) &&
          credential.isValid()
        ) {
          credentials.push(credential);
        }
      }
    } catch (e) {
      console.warn("Unable to parse encrypted credential entry", e);
    }
  }

  return credentials;
};

export const getMissingCredentialKeys = (credentialKeys, credentials) => {
  const found = new Set(credentials.map(credential => credential.credentialKey));
  return credentialKeys.filter(key => !found.has(key));
};
