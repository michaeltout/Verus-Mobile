import {Buffer} from 'buffer';
import {Transaction, networks, smarttxs} from '@bitgo/utxo-lib';
import {Identity} from 'verus-typescript-primitives';

/** Back a synthetic RPC revision with real identity-output bytes and a matching txid. */
export const authorizationIdentityTransaction = (revision, name) => {
  const identity = Identity.fromJson({
    ...revision.identity,
    name,
    systemid: revision.identity.parent,
    timelock: 0,
  });
  if (identity.getIdentityAddress() !== revision.identity.identityaddress) {
    throw new Error('The fixture name does not match its identity ID.');
  }
  const tx = Transaction.fromHex(
    smarttxs.createUnfundedIdentityUpdate(
      identity.toBuffer().toString('hex'),
      networks.verus,
      revision.blockheight + 20,
    ),
    networks.verus,
  );
  tx.addInput(Buffer.from(revision.txid, 'hex'), 0);
  return {
    revision: {...revision, txid: tx.getId(), identity: identity.toJson()},
    transaction: {
      txid: tx.getId(),
      hex: tx.toHex(),
      blockhash: '44'.repeat(32),
      height: revision.blockheight,
      confirmations: 1,
    },
  };
};
