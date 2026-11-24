import { captureSessionScope } from '../../actions/actions/updates/sessionRequests';

// Keep live request responses tied to their ingress. Saved-job screens pass
// null because their route already identifies the request after ingress clears.
export const getAppEncryptionSessionKey = (state, request = state.deeplink) =>
  JSON.stringify([
    captureSessionScope(state),
    state.authentication.signedIn,
    state.authentication.activeAccount?.testnetOverrides || {},
    request?.id,
    request?.data,
    request?.requestId,
  ]);
