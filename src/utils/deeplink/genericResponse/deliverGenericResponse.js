import axios from 'axios';
import base64url from 'base64url';
import {URL} from 'react-native-url-polyfill';
import {Linking} from 'react-native';
import {
  GENERIC_RESPONSE_DEEPLINK_VDXF_KEY,
  ResponseURI,
} from 'verus-typescript-primitives';
import {
  assertNoPlaintextAppEncryptionResponse,
  assertSecurePostResponseUri,
} from './responseDeliverySecurity';

export const isPostResponseUri = uri =>
  uri?.type != null &&
  (uri.type.eq
    ? uri.type.eq(ResponseURI.TYPE_POST)
    : Number(uri.type) === ResponseURI.TYPE_POST.toNumber());

export const isRedirectResponseUri = uri =>
  uri?.type != null &&
  (uri.type.eq
    ? uri.type.eq(ResponseURI.TYPE_REDIRECT)
    : Number(uri.type) === ResponseURI.TYPE_REDIRECT.toNumber());

export const getGenericResponseUri = uris =>
  (uris || []).find(isPostResponseUri) ||
  (uris || []).find(isRedirectResponseUri) ||
  null;

/** Deliver already prepared bytes. Transport retries must never rerun an operation. */
export const deliverGenericResponse = async (request, response) => {
  const uri = getGenericResponseUri(request?.responseURIs);
  if (!uri) return;
  assertNoPlaintextAppEncryptionResponse(response);
  if (isPostResponseUri(uri)) {
    const destination = assertSecurePostResponseUri(uri.getUriString());
    try {
      await axios.post(destination, response.toBuffer(), {
        headers: {'Content-Type': 'application/octet-stream'},
      });
    } catch (error) {
      const suffix =
        error?.response?.status == null
          ? ''
          : ` (HTTP ${error.response.status})`;
      throw Object.assign(
        new Error(`Failed to send the response to the requester${suffix}.`),
        {
          isResponsePostError: true,
        },
      );
    }
  } else {
    const destination = new URL(uri.getUriString());
    destination.searchParams.set(
      GENERIC_RESPONSE_DEEPLINK_VDXF_KEY.vdxfid,
      base64url(response.toBuffer()),
    );
    // Propagate launch failure so the caller can retain its retryable response.
    await Linking.openURL(destination.toString());
  }
};
