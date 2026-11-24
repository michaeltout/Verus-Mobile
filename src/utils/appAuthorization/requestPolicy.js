import {Buffer} from 'buffer';
import {
  AuthorizationCredential,
  AuthorizationStorageBindingCredential,
  Credential,
  DataDescriptor,
  FqnVdxfUniValue,
  IDENTITY_CREDENTIAL,
  VdxfUniValue,
} from 'verus-typescript-primitives';

const AUTHORIZATION_CREDENTIAL_KEYS = new Set([
  AuthorizationCredential.CREDENTIAL_KEY,
  AuthorizationStorageBindingCredential.CREDENTIAL_KEY,
]);
const MAX_REVIEW_DEPTH = 32;

/**
 * Generic credential import cannot substitute for app authorization consent.
 * Inspect typed and serialized plaintext before local encryption or upload
 * building; the dedicated authorization writer creates these records itself.
 */
export const assertNoAppAuthorizationCredentials = input => {
  const ancestors = new Set();
  const visit = (value, depth = 0) => {
    if (depth > MAX_REVIEW_DEPTH)
      throw new Error('Credential data is nested too deeply.');
    if (value == null) return;

    if (
      AUTHORIZATION_CREDENTIAL_KEYS.has(
        value.credentialKey || value.credentialkey,
      )
    ) {
      throw new Error(
        'App approvals and storage-management records require the dedicated app authorization review.',
      );
    }

    if (value instanceof Credential) return;
    if (
      Buffer.isBuffer(value) ||
      (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value))
    ) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'hex');
      const decoded = new VdxfUniValue();
      try {
        if (
          decoded.fromBuffer(bytes) !== bytes.length ||
          !decoded.toBuffer().equals(bytes)
        )
          return;
      } catch (_) {
        return; // Unrecognized binary remains subject to the ordinary upload policy.
      }
      // Avoid rediscovering an opaque raw byte vector as its own wrapper.
      for (const entry of decoded.values) {
        for (const [key, child] of Object.entries(entry)) {
          if (key) visit(child, depth + 1);
        }
      }
      return;
    }

    if (typeof value !== 'object' || ancestors.has(value)) return;
    ancestors.add(value);
    try {
      if (value instanceof DataDescriptor) {
        if (!value.hasEncryptedData()) visit(value.objectdata, depth + 1);
      } else if (value instanceof FqnVdxfUniValue) {
        for (const [, child] of value.entries()) visit(child, depth + 1);
      } else if (value instanceof VdxfUniValue) {
        visit(value.values, depth + 1);
      } else if (value instanceof Map) {
        for (const child of value.values()) visit(child, depth + 1);
      } else {
        for (const child of Object.values(value)) visit(child, depth + 1);
      }
    } finally {
      ancestors.delete(value);
    }
  };
  visit(input);
};

/**
 * An opaque historical ciphertext is enough to resurrect a deleted approval.
 * Generic requests may add reviewed plaintext credentials through the existing
 * encryptor, but may not write directly into the derived self-credential bucket.
 */
export const assertNoDirectAuthorizationBucketUpdates = async (
  details,
  subject,
  coin,
  context = {},
) => {
  assertNoAppAuthorizationCredentials(details);
  const cmm = details.identity?.contentMultiMap?.kvContent;
  const directKeys = [
    ...[...(cmm?.entries() || [])]
      .filter(([, values]) => values.length)
      .map(([key]) => key.toAddress()),
    ...[...(details.signDataMap?.entries() || [])].map(([key]) =>
      key.toAddress(),
    ),
  ].filter(key => key !== IDENTITY_CREDENTIAL.vdxfid);
  if (!directKeys.length) return;

  const identity = subject.identity || subject;
  const privateAddress =
    details.identity?.privateAddresses?.[0]?.toAddressString?.() ||
    identity.privateaddress;
  if (!privateAddress) return;

  // Loaded lazily to keep the ordinary encryption helper's plaintext policy
  // check free of a module-initialization cycle.
  const {deriveCredentialSelfChannel} = require('../crypto/encryptCredentials');
  const {outerKey} = await deriveCredentialSelfChannel(
    coin.system_id,
    {
      ...identity,
      privateaddress: privateAddress,
    },
    coin,
    context,
  );
  context.assertActive?.();
  if (directKeys.includes(outerKey)) {
    throw new Error(
      'Direct writes to the self-encrypted credential bucket require dedicated app authorization review.',
    );
  }
};
