import { getIdentity } from "../../api/channels/verusid/callCreators";
import { getBlock } from "../../api/channels/vrpc/requests/getBlock";
import { getSignatureInfo } from "../../api/channels/vrpc/requests/getSignatureInfo";
import { CoinDirectory } from "../../CoinData/CoinDirectory";
import { convertFqnToDisplayFormat } from "../../fullyqualifiedname";
import VrpcProvider from "../../vrpc/vrpcInterface";

export const getSignedRequestDisplayProps = async request => {
  const systemID = request.signature.systemID.toIAddress();
  const signerIdentityID = request.signature.identityID.toIAddress();
  const appOrDelegatorID = request.hasAppOrDelegatorID?.()
    ? request.appOrDelegatorID.toIAddress()
    : null;
  const coinObj = CoinDirectory.getBasicCoinObj(systemID);

  if (!coinObj) {
    throw new Error("Unsupported system: " + systemID);
  }

  VrpcProvider.initEndpoint(coinObj.system_id, coinObj.vrpc_endpoints[0]);

  // The signature always identifies D. Resolve A independently on D's chain;
  // a missing display name must never replace or obscure the actual signer.
  const [signerLookup, appLookup, signatureLookup] = await Promise.allSettled([
    getIdentity(systemID, signerIdentityID),
    appOrDelegatorID && appOrDelegatorID !== signerIdentityID
      ? getIdentity(systemID, appOrDelegatorID)
      : Promise.resolve(null),
    request.signature.signatureAsVch == null
      ? Promise.resolve(null)
      : getSignatureInfo(
          systemID,
          signerIdentityID,
          request.signature.signatureAsVch.toString('base64'),
        ),
  ]);
  const displayName = (lookup, identityID) => {
    const result = lookup.status === 'fulfilled' ? lookup.value : null;
    return !result?.error && result?.result?.fullyqualifiedname
      ? convertFqnToDisplayFormat(result.result.fullyqualifiedname)
      : identityID;
  };
  const signerFqn = displayName(signerLookup, signerIdentityID);
  const appOrDelegatorFqn =
    appOrDelegatorID === signerIdentityID
      ? signerFqn
      : displayName(appLookup, appOrDelegatorID);

  let sigtime = null;
  try {
    const sig =
      signatureLookup.status === 'fulfilled' ? signatureLookup.value : null;
    if (sig && sig.height != null) {
      const sigblock = await getBlock(systemID, sig.height);
      if (!sigblock.error && sigblock.result) {
        sigtime = sigblock.result.time;
      }
    }
  } catch (_) {}

  return {
    signerFqn,
    signerSystemID: systemID,
    signerSystemName:
      coinObj.display_ticker || coinObj.display_name || systemID,
    signerIdentityID,
    sigtime,
    ...(appOrDelegatorID ? {appOrDelegatorID, appOrDelegatorFqn} : {}),
  };
};

export const getRequestScope = request => {
  // A malformed explicit scope must fail, never fall back to the signer.
  return request.hasAppOrDelegatorID()
    ? request.appOrDelegatorID.toIAddress()
    : request.signature.identityID.toIAddress();
};
