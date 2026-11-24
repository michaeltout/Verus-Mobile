import {
  DEEPLINK_PROTOCOL_URL_STRING,
  GenericRequest,
  VALU_MOBILE_GENERIC_REQUEST_HANDLER_ID,
  VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
} from 'verus-typescript-primitives';
import {hasAppAuthorizationRequest} from 'verusid-ts-client';

// Authorization may contain a gift seed. Redux actions and navigation receive
// only this opaque handle; the parser immediately moves its contents to the
// encrypted pending-request store. Weak keys allow abandoned ingress to expire.
const privateRequests = new WeakMap();

export const hasAuthorizationDetails = hasAppAuthorizationRequest;

export const protectAuthorizationTransport = (
  value,
  isUrl = false,
  isGenericRequest = false,
) => {
  if (typeof value !== 'string') return value;

  try {
    if (isUrl) {
      const canonicalUrl = [
        VALU_MOBILE_GENERIC_REQUEST_HANDLER_ID,
        VERUS_MOBILE_GENERIC_REQUEST_HANDLER_ID,
      ].reduce(
        (uri, handler) =>
          uri.replace(
            `${DEEPLINK_PROTOCOL_URL_STRING}${handler}:`,
            `${DEEPLINK_PROTOCOL_URL_STRING}:`,
          ),
        value,
      );
      const prefix = `${DEEPLINK_PROTOCOL_URL_STRING}://`;

      // Classify the transport without decoding its payload. Even an oversized
      // or malformed authorization can contain a valid gift seed; let the saga
      // reject it without putting those bytes in an action or Redux state.
      if (
        !canonicalUrl.startsWith(prefix) ||
        !canonicalUrl.slice(prefix.length).includes('/')
      )
        return value;
    } else if (!isGenericRequest) {
      const request = new GenericRequest();
      request.fromBuffer(Buffer.from(value, 'hex'));
      if (!hasAuthorizationDetails(request)) return value;
    }

    const handle = Object.freeze({privateAuthorizationRequest: true});
    privateRequests.set(handle, value);
    return handle;
  } catch (_) {
    // Ordinary malformed input is rejected by the normal ingress validator.
    return value;
  }
};

export const readAuthorizationTransport = value => {
  if (value?.privateAuthorizationRequest !== true) return value;

  const original = privateRequests.get(value);
  if (original == null) {
    throw new Error(
      'This request must be reopened from its saved authorization.',
    );
  }

  return original;
};
