import {validateAppAuthorizationRequest} from 'verusid-ts-client';
import {AppAuthorizationRequestOrdinalVDXFObject} from 'verus-typescript-primitives';
import {validateSeedDetails} from '../../seedDetails/seedDetails';

// Admission limits are wallet policy, not additions to the wire protocol. The
// smaller URL transport limit continues to apply to requests received by URL.
export const MAX_APP_AUTHORIZATION_REQUEST_BYTES = 64 * 1024;
export const MAX_APP_AUTHORIZATION_GIFT_BYTES = 32 * 1024;

export const validateAppAuthorizationRequestVDXFObject = (
  request,
  detailIndex,
) => {
  if (
    !(
      request.getDetails(detailIndex) instanceof
      AppAuthorizationRequestOrdinalVDXFObject
    )
  ) {
    throw new Error(
      'App authorization details not found at the specified index.',
    );
  }

  const {authorization} = validateAppAuthorizationRequest(request, {
    maxRequestBytes: MAX_APP_AUTHORIZATION_REQUEST_BYTES,
    maxGiftBytes: MAX_APP_AUTHORIZATION_GIFT_BYTES,
  });

  if (authorization.gift) {
    validateSeedDetails(authorization.gift, {
      invalidMessage: 'Invalid authorization gift.',
      unsupportedSeedMessage: 'Only BIP39 authorization gifts are supported.',
    });
  }
};
