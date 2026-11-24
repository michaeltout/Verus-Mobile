import createHash from "create-hash";
import {IdentitySignature, networks} from '@bitgo/utxo-lib';
import {
  CompactAddressObject,
  DataDescriptor,
  DataResponseDetails,
  DataResponseOrdinalVDXFObject,
  EHashTypes,
  SignatureDataKey,
  VerifiableSignatureData,
  VdxfUniValue,
} from "verus-typescript-primitives";
import { requestPrivKey } from "../../auth/authBox";
import { VRPC } from "../../constants/intervalConstants";
import VrpcProvider from "../../vrpc/vrpcInterface";
import {withAppEncryptionSigningKeys} from '../validator/appEncryptionAuthorization';
import {IDENTITY_SIGNATURE_VERSION, IDENTITY_SIGNATURE_HEADER_BYTES, IDENTITY_COMPACT_SIGNATURE_BYTES} from '../../appAuthorization/constants';

const sha256 = buffer => createHash("sha256").update(buffer).digest();

export const getSignableObjectBuffer = signableObject => {
  if (typeof signableObject === "string") {
    return Buffer.from(signableObject, "utf8");
  }

  if (signableObject instanceof DataDescriptor) {
    return signableObject.toBuffer();
  }

  throw new Error("Unsupported signable object type.");
};

export const signDataPacketObject = async ({
  coinObj,
  identityAddress,
  signableObject,
  request,
  context,
}) => {
  const signableBuffer = getSignableObjectBuffer(signableObject);
  const signatureHash = sha256(signableBuffer);
  const scoped = request?.hasAppOrDelegatorID();
  const privKey = scoped ? null : await requestPrivKey(coinObj.id, VRPC, context);
  context?.assertActive?.();

  VrpcProvider.initEndpoint(coinObj.system_id, coinObj.vrpc_endpoints[0]);

  const verusIdInterface = VrpcProvider.getVerusIdInterface(coinObj.system_id);
  const height = await verusIdInterface.getCurrentHeight();
  context?.assertActive?.();

  const verifiableSignature = new VerifiableSignatureData({
    version: VerifiableSignatureData.TYPE_VERUSID_DEFAULT,
    systemID: CompactAddressObject.fromIAddress(coinObj.system_id),
    identityID: CompactAddressObject.fromIAddress(identityAddress),
  });

  const digest = verifiableSignature.getIdentityHash(height, signatureHash);
  if (scoped) {
    const signature = new IdentitySignature(
      networks.verus, IDENTITY_SIGNATURE_VERSION, EHashTypes.HASH_SHA256, height, [], coinObj.system_id, identityAddress,
    );
    await withAppEncryptionSigningKeys(request, {
      identityID: identityAddress, systemID: coinObj.system_id,
    }, context, key => signature.signHashOffline(digest, key));
    context?.assertActive?.();
    const bytes = Buffer.alloc(IDENTITY_SIGNATURE_HEADER_BYTES + IDENTITY_COMPACT_SIGNATURE_BYTES * signature.signatures.length);
    signature.toBuffer(bytes);
    verifiableSignature.signatureAsVch = bytes;
  } else {
    const signature = await verusIdInterface.signHash(
      identityAddress, digest, privKey, undefined, height, coinObj.system_id,
    );
    context?.assertActive?.();
    verifiableSignature.signatureAsVch = Buffer.from(signature, 'base64');
  }

  return verifiableSignature.toSignatureData(signatureHash);
};

export const buildDataPacketResponse = async ({
  coinObj,
  identityAddress,
  dataPacketDetail,
  request,
  context,
}) => {
  const values = [];

  for (const signableObject of dataPacketDetail.signableObjects) {
    const signatureData = await signDataPacketObject({
      coinObj,
      identityAddress,
      signableObject,
      request,
      context: context && {...context, executionStep: `data-packet:${context.detailIndex ?? dataPacketDetail.requestID?.toIAddress() ?? ''}:${values.length}`},
    });

    values.push({ [SignatureDataKey.vdxfid]: signatureData });
  }

  for (const statement of dataPacketDetail.statements || []) {
    const signatureData = await signDataPacketObject({
      coinObj,
      identityAddress,
      signableObject: statement,
      request,
      context: context && {...context, executionStep: `data-packet:${context.detailIndex ?? dataPacketDetail.requestID?.toIAddress() ?? ''}:${values.length}`},
    });

    values.push({ [SignatureDataKey.vdxfid]: signatureData });
  }

  const dataDescriptor = new DataDescriptor({
    version: DataDescriptor.DEFAULT_VERSION,
    objectdata: new VdxfUniValue({ values }).toBuffer(),
  });

  return new DataResponseOrdinalVDXFObject({
    data: new DataResponseDetails({
      requestID: dataPacketDetail.requestID,
      data: dataDescriptor,
    }),
  });
};
