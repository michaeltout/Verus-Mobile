import { AuthenticationRequestOrdinalVDXFObject, GenericRequest, GenericResponse, ProvisionIdentityDetailsOrdinalVDXFObject,
  AppEncryptionRequestOrdinalVDXFObject
 } from "verus-typescript-primitives";
import { getSignedRequestDisplayProps } from './requestDisplayUtils';

/**
 * @param {GenericRequest} request
 * @param {GenericResponse} response
 * @param {number} detailIndex
 * @returns {{
 *  displayProps: {
 *    detailsBufferString: string;
 *    sigtime?: number;
 *    signerFqn?: string;
 *    signerSystemID?: string;
 *    signerSystemName?: string;
 *    signerIdentityID?: string;
 *  }
 *  response: GenericResponse;
 *  handledIndices: Array<number>;
 * }}
 */
export const handleAuthenticationRequestDetailsVDXFObject = async (request, response, detailIndex) => {
  /**
   * @type {AuthenticationRequestOrdinalVDXFObject}
   */
  const details = request.getDetails(detailIndex);

  if (details == null) throw new Error("Invalid index for request details");
  if (!(details instanceof AuthenticationRequestOrdinalVDXFObject)) throw new Error("Authentication request details not found at specified index");

  const possibleEncryptionDetail = request.details.find(x => x instanceof AppEncryptionRequestOrdinalVDXFObject);

  if (possibleEncryptionDetail) {
    return {
      displayProps: undefined,
      response,
      handledIndices: [detailIndex]
    };
  }

  const signer = await getSignedRequestDisplayProps(request);
  let provisioningDetailsBufferString;
  let provisioningDetailIndex;

  const provisioningIndex = request.details.findIndex(x => x instanceof ProvisionIdentityDetailsOrdinalVDXFObject);
  const possibleProvisioningDetail = provisioningIndex > -1 ? request.details[provisioningIndex] : null;
  
  if (possibleProvisioningDetail instanceof ProvisionIdentityDetailsOrdinalVDXFObject) {
    provisioningDetailsBufferString = possibleProvisioningDetail.data.toBuffer().toString('hex');
    provisioningDetailIndex = provisioningIndex;
  }

  return {
    displayProps: {
      detailsBufferString: details.data.toBuffer().toString('hex'),
      ...signer,
      provisioningDetailsBufferString,
      provisioningDetailIndex
    },
    response,
    handledIndices: []
  }
}
