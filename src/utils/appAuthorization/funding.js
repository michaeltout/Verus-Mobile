import {Buffer} from 'buffer';
import BigNumber from 'bignumber.js';
import {Transaction, networks} from '@bitgo/utxo-lib';
import {
  AuthorizationStorageBindingCredential,
  ContentMultiMap,
  ContentMultiMapRemove,
  ContentMultiMapRemoveKey,
  CredentialKey,
  DataDescriptor,
  DataDescriptorKey,
  Identity,
  IdentityScript,
  VdxfUniValue,
} from 'verus-typescript-primitives';
import {
  defaultIdentityUpdateFeeCap,
  identityUpdateFeeCap,
} from 'verusid-ts-client/lib/identity/updateFundingVerification';
import {nativeAmount} from 'verusid-ts-client/lib/identity/fundingPrimitives';
import {paymentOutput} from 'verusid-ts-client/lib/identity/registrationTransaction';
import {toTransferDestination} from '../spendableKey/claimHelpers';

const ATOMIC_UNITS_PER_COIN = 100000000;
const REMOVAL_FEE_MARGIN = '1.25';
const AUTHENTICATION_TAG_BYTES = 16;
const EPHEMERAL_PUBLIC_KEY_BYTES = 32;

/** Match encrypted credential sizes for this unsigned fee template, without encryption. */
const storageReplacementPlaceholder = payload => {
  const credential = AuthorizationStorageBindingCredential.fromPayload(payload)
    .toCredential();
  const innerDescriptor = new DataDescriptor({
    objectdata: new VdxfUniValue({
      values: [{[CredentialKey.vdxfid]: credential}],
    }).toBuffer(),
  });
  const plaintextLength = new VdxfUniValue({
    values: [{[DataDescriptorKey.vdxfid]: innerDescriptor}],
  }).getByteLength();

  // Reuse the descriptor serializers so CompactSize boundary changes are included.
  // These zero bytes never leave the local fee template.
  const descriptor = new DataDescriptor({
    flags: DataDescriptor.FLAG_ENCRYPTED_DATA,
    objectdata: Buffer.alloc(plaintextLength + AUTHENTICATION_TAG_BYTES),
    epk: Buffer.alloc(EPHEMERAL_PUBLIC_KEY_BYTES),
  });
  return new VdxfUniValue({
    values: [{[DataDescriptorKey.vdxfid]: descriptor}],
  }).toBuffer().toString('hex');
};

/** Allocate a gift using the existing size-aware fee policy, without an RPC quote. */
export const prepareAuthorizationGiftFunding = (
  updates,
  {
    userIdentityID,
    storageIdentities,
    existingRemovals = [],
    storageSystemReplacements,
  },
  fundingUtxos,
  systemID,
) => {
  const userUpdate = updates.find(
    update => update.identity.getIdentityAddress() === userIdentityID,
  );
  if (!userUpdate) {
    throw new Error('Gift funding needs the authorizing user identity.');
  }

  const storage = storageIdentities.map(json => Identity.fromJson(json));
  const storageIDs = storage.map(identity => identity.getIdentityAddress());
  if (
    new Set(storageIDs).size !== storageIDs.length ||
    storageIDs.includes(userIdentityID)
  ) {
    throw new Error('Gift funding needs distinct user and storage identities.');
  }

  // Include existing approvals affected by removing this instance or its
  // storage access, along with the credentials this transaction will write.
  // Retaining S's full key list makes this conservative: actual removal reduces
  // it to wallet-controlled keys. Future unrelated changes can change the fee.
  const userRemoval = new Identity();
  userRemoval.fromBuffer(userUpdate.identity.toBuffer());
  const newRemovals = [...userRemoval.contentMultiMap.kvContent.entries()].flatMap(
    ([key, values]) => values.map(value =>
      ContentMultiMapRemove.removeStoredValue(
        key.toString(),
        Buffer.isBuffer(value) ? value : value.toBuffer(),
      ),
    ),
  );
  userRemoval.clearContentMultiMap();
  const removals = [
    ...existingRemovals,
    ...newRemovals.map(removal => removal.toJson()),
  ];
  const removalContent = {};
  if (removals.length) {
    removalContent[ContentMultiMapRemoveKey.vdxfid] = removals.map(removal => ({
      [ContentMultiMapRemoveKey.vdxfid]: removal,
    }));
  }
  if (storageSystemReplacements?.payloads.length) {
    // A surviving binding must retain its inherited non-root system after its
    // grant is deleted. Reserve both its removal marker and replacement value.
    removalContent[storageSystemReplacements.outerKey] =
      storageSystemReplacements.payloads.map(storageReplacementPlaceholder);
  }
  userRemoval.contentMultiMap = ContentMultiMap.fromJson(removalContent);
  storage.forEach(identity => identity.clearContentMultiMap());

  // Only outputs affect this fee allowance. Reuse the transaction's network
  // header; this template is never signed or submitted.
  const template = Transaction.fromHex(
    userUpdate.rawIdentityTransaction,
    networks.verus,
  );
  template.ins = [];
  template.outs = [userRemoval, ...storage].map(identity => ({
    value: 0,
    script: IdentityScript.fromIdentity(identity).toBuffer(),
  }));
  const reserve = new BigNumber(identityUpdateFeeCap(
    defaultIdentityUpdateFeeCap(template.toHex()),
  )).times(REMOVAL_FEE_MARGIN).integerValue(BigNumber.ROUND_CEIL);

  const recipients = [userIdentityID, ...storageIDs];
  template.outs = updates.map(({identity}) => ({
    value: 0,
    script: IdentityScript.fromIdentity(identity).toBuffer(),
  }));
  // Payment amounts do not change their scripts. Include every destination in
  // the fee allowance before dividing the remaining balance in atomic units.
  for (const recipient of recipients) {
    const output = paymentOutput(
      recipient,
      {[systemID]: '1'},
      systemID,
      'change',
    );
    template.outs.push({value: 1, script: Buffer.from(output.scriptHex, 'hex')});
  }
  const nativeFee = identityUpdateFeeCap(
    defaultIdentityUpdateFeeCap(template.toHex()),
  );
  const total = fundingUtxos.reduce(
    (sum, utxo) => sum.plus(nativeAmount(utxo.satoshis)),
    new BigNumber(0),
  );
  nativeAmount(total.toNumber());
  const available = total.minus(nativeFee);
  if (available.lt(reserve.plus(storageIDs.length))) {
    throw new Error(
      'The gift needs more native funds for setup, the access-removal reserve, and app storage.',
    );
  }

  const userAmount = storageIDs.length ? reserve : available;
  const remaining = available.minus(userAmount);
  const share = storageIDs.length
    ? remaining.dividedToIntegerBy(storageIDs.length)
    : new BigNumber(0);
  const allocations = [userAmount, ...storageIDs.map((_, index) =>
    index === storageIDs.length - 1
      ? remaining.minus(share.times(index))
      : share,
  )].map((value, index) => ({
    identityID: recipients[index],
    atomic: value.toFixed(0),
    coins: value.dividedBy(ATOMIC_UNITS_PER_COIN).toFixed(),
  }));

  return {
    nativeFee,
    changeAddress: recipients[recipients.length - 1],
    allocatedAtomic: available.toFixed(0),
    currencyTransferOutputs: allocations.map(({identityID, atomic}) => ({
      address: toTransferDestination(identityID),
      currencies: {[systemID]: atomic},
    })),
    allocation: {
      currency: systemID,
      reserve: allocations[0],
      storage: allocations.slice(1),
    },
  };
};
