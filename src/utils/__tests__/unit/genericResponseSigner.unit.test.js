import BN from 'bn.js';
import {ECPair, IdentitySignature, networks} from '@bitgo/utxo-lib';
import {inspectAuthorizationSigners} from 'verusid-ts-client';
import {
  CompactIAddressObject,
  DataDescriptor,
  DataDescriptorOrdinalVDXFObject,
  EHashTypes,
  GenericResponse,
  TESTNET_VERUS_CHAINID,
  VerifiableSignatureData,
} from 'verus-typescript-primitives';
import {
  IDENTITY_SIGNATURE_VERSION,
  IDENTITY_SIGNATURE_HEADER_BYTES,
  IDENTITY_COMPACT_SIGNATURE_BYTES,
} from '../../appAuthorization/constants';
import {
  ensureGenericResponseSigner,
  getGenericResponseSigner,
} from '../../deeplink/genericResponse/ensureGenericResponseSigner';

const SYSTEM_ID = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const FIRST_IDENTITY = 'iHh1FFVvcNb2mcBudD11umfKJXHbBbH6Sj';
const SECOND_IDENTITY = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';

describe('generic response signer invariant', () => {
  it('sets and reuses one response signer', () => {
    const response = new GenericResponse();

    expect(
      ensureGenericResponseSigner({
        response,
        systemID: SYSTEM_ID,
        identityID: FIRST_IDENTITY,
      }),
    ).toBe(response);
    expect(getGenericResponseSigner(response)).toEqual({
      systemID: SYSTEM_ID,
      identityID: FIRST_IDENTITY,
    });

    expect(() =>
      ensureGenericResponseSigner({
        response,
        systemID: SYSTEM_ID,
        identityID: FIRST_IDENTITY,
      }),
    ).not.toThrow();
  });

  it('rejects a different identity for a later response detail', () => {
    const response = new GenericResponse();

    ensureGenericResponseSigner({
      response,
      systemID: SYSTEM_ID,
      identityID: FIRST_IDENTITY,
    });

    expect(() =>
      ensureGenericResponseSigner({
        response,
        systemID: SYSTEM_ID,
        identityID: SECOND_IDENTITY,
      }),
    ).toThrow('already locked');
  });

  it.each([1, 2])(
    'produces testnet response metadata accepted by the SDK with %s actual signatures',
    signatureCount => {
      const height = 100;
      const keys = Array.from({length: signatureCount}, (_, index) =>
        ECPair.fromPrivateKeyBuffer(
          Buffer.alloc(32, index + 1),
          networks.verus,
        ),
      );
      const response = new GenericResponse({
        flags: GenericResponse.FLAG_IS_TESTNET,
        createdAt: new BN(1700000000),
        requestID: CompactIAddressObject.fromAddress(SECOND_IDENTITY),
        appOrDelegatorID: CompactIAddressObject.fromAddress(SECOND_IDENTITY),
        requestHash: Buffer.alloc(32, 7),
        details: [
          new DataDescriptorOrdinalVDXFObject({
            data: new DataDescriptor({
              objectdata: Buffer.from('Synthetic response fixture'),
            }),
          }),
        ],
      });
      ensureGenericResponseSigner({
        response,
        systemID: TESTNET_VERUS_CHAINID,
        identityID: FIRST_IDENTITY,
      });

      // Exercise the actual wire signature and parser, not a metadata-only
      // mock: the app checks current U using this same SDK verifier.
      const signature = new IdentitySignature(
        networks.verus,
        IDENTITY_SIGNATURE_VERSION,
        EHashTypes.HASH_SHA256,
        height,
        [],
        TESTNET_VERUS_CHAINID,
        FIRST_IDENTITY,
      );
      const digest = response.getDetailsIdentitySignatureHash(height);
      keys.forEach(key => signature.signHashOffline(digest, key));
      const signatureBytes = Buffer.alloc(
        IDENTITY_SIGNATURE_HEADER_BYTES +
          IDENTITY_COMPACT_SIGNATURE_BYTES * signatureCount,
      );
      signature.toBuffer(signatureBytes);
      response.signature.signatureAsVch = signatureBytes;
      const bytes = response.toBuffer();
      const parsed = new GenericResponse();
      expect(parsed.fromBuffer(bytes)).toBe(bytes.length);
      expect(parsed.toBuffer()).toEqual(bytes);
      const revision = {
        systemID: TESTNET_VERUS_CHAINID,
        status: 'active',
        blockheight: height,
        txid: '11'.repeat(32),
        vout: 0,
        identity: {
          version: 3,
          flags: 0,
          identityaddress: FIRST_IDENTITY,
          parent: TESTNET_VERUS_CHAINID,
          primaryaddresses: keys.map(key => key.getAddress()),
          minimumsignatures: signatureCount,
        },
      };
      const evidence = inspectAuthorizationSigners(parsed, revision, revision);
      expect(evidence.valid).toBe(true);
      expect(evidence.requiredSignatures).toBe(signatureCount);
      expect(
        parsed.signature.version.eq(VerifiableSignatureData.DEFAULT_VERSION),
      ).toBe(true);
      expect(parsed.signature.identityID).toBeInstanceOf(CompactIAddressObject);
      expect(parsed.signature.systemID).toBeInstanceOf(CompactIAddressObject);
      expect(parsed.signature.systemID.toIAddress()).toBe(
        TESTNET_VERUS_CHAINID,
      );
      expect(parsed.isTestnet()).toBe(true);

      // The unchanged signed response remains frozen when another detail or
      // delivery retry confirms the same signer.
      ensureGenericResponseSigner({
        response: parsed,
        systemID: TESTNET_VERUS_CHAINID,
        identityID: FIRST_IDENTITY,
      });
      expect(parsed.toBuffer()).toEqual(bytes);
    },
  );

  it('rejects invalid signature metadata without repairing it', () => {
    const signature = new VerifiableSignatureData({
      systemID: CompactIAddressObject.fromAddress(TESTNET_VERUS_CHAINID),
      identityID: CompactIAddressObject.fromAddress(FIRST_IDENTITY),
    });
    const response = new GenericResponse({signature});

    expect(() =>
      ensureGenericResponseSigner({
        response,
        systemID: TESTNET_VERUS_CHAINID,
        identityID: FIRST_IDENTITY,
      }),
    ).toThrow('Unsupported generic response signature version');
    expect(signature.version.eq(VerifiableSignatureData.VERSION_INVALID)).toBe(
      true,
    );
  });
});
