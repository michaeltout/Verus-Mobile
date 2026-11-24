import store from '../../store';
import {
  captureSessionScope,
  scopeSessionAction,
  sessionScopeIsCurrent,
} from '../../actions/actions/updates/sessionRequests';
import {unlinkVerusId} from '../../actions/actions/services/dispatchers/verusid/verusid';
import {requestServiceStoredData} from '../auth/authBox';
import {VERUSID_SERVICE_ID} from '../constants/services';
import {SET_WATCHED_VERUSIDS} from '../constants/storeType';
import {validateIdentityAuthority} from './identityDefinition';

const assertCurrent = context => {
  if (
    !context.sessionScope.accountHash ||
    context.signal?.aborted ||
    !sessionScopeIsCurrent(store.getState(), context.sessionScope)
  ) {
    throw Object.assign(
      new Error('Account changed before linked identities could be refreshed.'),
      {code: 'SESSION_CHANGED'},
    );
  }
  context.assertActive?.();
};

const captureWalletContext = (chainTicker, requestContext) => {
  const context = {
    ...(requestContext || {}),
    sessionScope:
      requestContext?.sessionScope ||
      (requestContext?.sessionScoped
        ? requestContext
        : captureSessionScope(store.getState())),
  };
  assertCurrent(context);

  if (typeof chainTicker !== 'string' || !chainTicker.trim()) {
    throw new Error('Choose the identity’s network.');
  }

  return context;
};

/** Rebuild wallet cards and polling from the saved links without reconciling jobs. */
export const refreshLinkedIdentityWallet = async (chainTicker, requestContext) => {
  const context = captureWalletContext(chainTicker, requestContext);

  const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
  assertCurrent(context);
  store.dispatch(
    scopeSessionAction({
      type: SET_WATCHED_VERUSIDS,
      payload: {watchedVerusIds: data.linked_ids || {}},
    }, context.sessionScope),
  );
  assertCurrent(context);

  // updateVerusIdWallet also reconciles registration and authorization jobs.
  // This local refresh is safe to call from those jobs after their link changes.
  const {setUserCoins} = require('../../actions/actionCreators');
  const {
    clearChainLifecycle,
    refreshActiveChainLifecycles,
  } = require('../../actions/actions/intervals/dispatchers/lifecycleManager');
  clearChainLifecycle(chainTicker, undefined, context.sessionScope);
  assertCurrent(context);

  const state = store.getState();
  const action = setUserCoins(
    state.coins.activeCoinList,
    state.authentication.activeAccount.id,
  );
  store.dispatch(scopeSessionAction(action, context.sessionScope));
  assertCurrent(context);
  refreshActiveChainLifecycles(action.payload.activeCoinsForUser);
  assertCurrent(context);
};

/**
 * Remove the local link after an accepted update. Repeating this cleanup after
 * a storage or wallet-refresh failure never signs or resubmits the transaction.
 */
export const unlinkUpdatedIdentity = async (
  {identityAddress, chainTicker},
  requestContext,
) => {
  const context = captureWalletContext(chainTicker, requestContext);
  validateIdentityAuthority(identityAddress, 'Updated identity');

  // The existing writer removes only this link inside the encrypted-storage
  // queue, preserving concurrently saved identities and registration records.
  await unlinkVerusId(identityAddress, chainTicker, context);
  assertCurrent(context);
  await refreshLinkedIdentityWallet(chainTicker, context);
  return {unlinked: true};
};
