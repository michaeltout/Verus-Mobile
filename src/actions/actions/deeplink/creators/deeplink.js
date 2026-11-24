import { SET_DEEPLINK_DATA, SET_DEEPLINK_URL } from "../../../../utils/constants/storeType"
import {protectAuthorizationTransport} from '../../../../utils/deeplink/privateRequestTransport';
import {GENERIC_REQUEST_DEEPLINK_VDXF_KEY} from 'verus-typescript-primitives';

export const setDeeplinkUrl = (url, passthrough = null) => {
  return {
    type: SET_DEEPLINK_URL,
    payload: { url: protectAuthorizationTransport(url, true), passthrough }
  }
}

export const setDeeplinkData = (
  id,
  data,
  fromService = null,
  passthrough = null,
) => {
  return {
    type: SET_DEEPLINK_DATA,
    payload: {
      id,
      data: protectAuthorizationTransport(data, false, id === GENERIC_REQUEST_DEEPLINK_VDXF_KEY.vdxfid),
      fromService,
      passthrough,
    }
  }
}

export const resetDeeplinkData = expectedRequestId => {
  return {
    type: SET_DEEPLINK_DATA,
    payload: {id: null, data: {}, fromService: null, passthrough: null,
      ...(expectedRequestId == null ? {} : {expectedRequestId})}
  }
}
