import {ECPair, networks} from '@bitgo/utxo-lib';
import {
  AuthenticationRequestOrdinalVDXFObject,
  AuthorizationCredential,
  fromBase58Check,
  I_ADDR_VERSION,
} from 'verus-typescript-primitives';
import {
  assertAppDelegatorProfileSupportedV1,
  hasAppAuthorizationRequest,
  inspectAuthorizationSigners,
  loadIdentityRevision,
  validateAuthenticationExpiry,
} from 'verusid-ts-client';
import store from '../../../store';
import {
  captureSessionScope,
  sessionScopeIsCurrent,
} from '../../../actions/actions/updates/sessionRequests';
import {requestPrivKey, requestServiceStoredData} from '../../auth/authBox';
import {CoinDirectory} from '../../CoinData/CoinDirectory';
import {VERUSID_SERVICE_ID} from '../../constants/services';
import VrpcProvider from '../../vrpc/vrpcInterface';
import {
  assertAuthorizationStorageControl,
  assertIndependentIdentityControl,
  authorizationContext,
  authorizationSource,
  withAuthorizationReadScope,
  walletAuthorizationKeys,
} from '../../appAuthorization/controls';
import {
  assertAuthorizationCredentialsCurrent,
  loadAuthorizationCredentials,
} from '../../appAuthorization/credentials';
import {getAppEncryptionSessionKey} from '../appEncryptionSession';
import {
  recordDelegatedTransaction,
  reserveDelegatedExecution,
  releaseDelegatedSigningReservation,
} from '../../appAuthorization/delegatedOperations';
import {
  appEncryptionIdentityMatchesConstraints,
  getAppEncryptionIdentityConstraints,
} from './appEncryptionIdentityConstraints';

const NO_LINKED_APP_APPROVAL =
  'No linked identity has a current app approval for this delegate. Complete an app authorization handshake first.';
const NO_CURRENT_APP_APPROVAL =
  'No current app approval authorizes this delegate. Link this app instance again.';

/** Linkage supplies candidates, never proof of an app's authority. */
const linkedAuthorizationUsers = (data, testnet, constraints) => {
  const users = new Map();

  for (const [chain, identities] of Object.entries(data.linked_ids || {})) {
    let coin;
    try {
      coin = CoinDirectory.findCoinObj(chain);
    } catch (_) {
      continue;
    }
    if (
      !coin?.system_id ||
      !coin.vrpc_endpoints?.length ||
      !!coin.testnet !== testnet ||
      (constraints.systemIDs.size && !constraints.systemIDs.has(coin.system_id))
    )
      continue;

    for (const identityID of Object.keys(identities || {})) {
      if (
        constraints.identityIDs.size &&
        !constraints.identityIDs.has(identityID)
      )
        continue;
      try {
        const user = {
          identityID: identityAddress(identityID),
          systemID: identityAddress(coin.system_id),
        };
        users.set(`${user.systemID}:${user.identityID}`, user);
      } catch (_) {
        // Ignore malformed inventory entries; they cannot establish authority.
      }
    }
  }

  return [...users.values()];
};

const identityAddress = address => {
  const decoded = fromBase58Check(address);

  if (decoded.version !== I_ADDR_VERSION || decoded.hash.length !== 20) {
    throw new Error('Invalid app encryption identity address.');
  }

  return address;
};

const identityResult = response => {
  if (response?.error) throw new Error(response.error.message);
  if (!response?.result?.identity)
    throw new Error('Identity could not be verified.');
  return response.result;
};

const requiredAuthorities = (result, keys, exclusive = false) => {
  const identity = result.identity;
  const threshold = identity.minimumsignatures;
  const addresses = new Set(identity.primaryaddresses || []);
  const controlled = new Set(
    keys.filter(key => addresses.has(key.address)).map(key => key.address),
  );

  if (
    (identity.flags & 0x8000) !== 0 ||
    (result.status != null && result.status !== 'active') ||
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    controlled.size < threshold
  ) {
    throw new Error(
      'The active profile must fully control the identity signing threshold.',
    );
  }

  if (exclusive && controlled.size !== addresses.size) {
    throw new Error(
      'The active profile must fully control every signing authority at the request signing height.',
    );
  }

  // Sole control requires usable private keys for every authority, even when
  // the identity's ordinary signing threshold is lower.
  return {addresses, threshold: exclusive ? addresses.size : threshold};
};

const authorize = async (
  request,
  selectedIdentity,
  context = {},
  signKey,
  onReserved,
) => {
  if (!request.isSigned())
    throw new Error('App encryption requires a signature.');
  if (signKey && selectedIdentity == null)
    throw new Error('Select a signing identity.');

  const initialState = store.getState();
  const sessionScope =
    context.sessionScope || captureSessionScope(initialState);
  const network = JSON.stringify(
    initialState.authentication.activeAccount?.testnetOverrides || {},
  );
  const walletKeys = JSON.stringify(
    initialState.authentication.activeAccount?.keys || {},
  );
  const reviewedRequest = request.toBuffer?.().toString('hex');
  const bootstrap = hasAppAuthorizationRequest(request);
  const needsProfile =
    selectedIdentity != null || (!bootstrap && request.hasAppOrDelegatorID());
  const assertActive = () => {
    context.assertActive?.();

    if (
      reviewedRequest != null &&
      request.toBuffer().toString('hex') !== reviewedRequest
    ) {
      throw Object.assign(new Error('The request changed. Review it again.'), {
        code: 'SESSION_CHANGED',
      });
    }

    if (!needsProfile) return;

    const state = store.getState();
    const account = state.authentication.activeAccount;

    if (
      !account ||
      state.authentication.signedIn === false ||
      !sessionScopeIsCurrent(state, sessionScope) ||
      JSON.stringify(account.testnetOverrides || {}) !== network ||
      JSON.stringify(account.keys || {}) !== walletKeys
    ) {
      throw Object.assign(
        new Error('The active profile changed. Review the request again.'),
        {code: 'SESSION_CHANGED'},
      );
    }

    if (
      Object.keys(account.testnetOverrides || {}).length > 0 !==
      request.isTestnet()
    ) {
      throw new Error('The active profile is on a different network.');
    }
  };

  // The phase also checks this binding after its final network round trip.
  context.authorizationChecks?.add(assertActive);
  assertActive();
  const signerID = identityAddress(request.signature.identityID.toIAddress());
  const coinObj = CoinDirectory.getBasicCoinObj(
    request.signature.systemID.toIAddress(),
  );

  if (!coinObj?.system_id || !coinObj.vrpc_endpoints?.[0]) {
    throw new Error('Unsupported app encryption request chain.');
  }

  if (!!coinObj.testnet !== request.isTestnet()) {
    throw new Error('The request is on a different network.');
  }

  VrpcProvider.initEndpoint(coinObj.system_id, coinObj.vrpc_endpoints[0]);
  const source = authorizationSource(coinObj.system_id, context);
  const client = source.client;

  // Bootstrap is the only scoped request admitted without an existing grant.
  // The SDK enforces exact detail ordering, expiry, current D signers and A's
  // effective profile guard before the wallet opens keys or claims a gift.
  if (bootstrap) {
    if (
      !(await client.verifyGenericRequest(
        request,
        undefined,
        coinObj.system_id,
      ))
    ) {
      throw new Error('Failed to verify app authorization request.');
    }
    assertActive();
    const authentication = request.details.find(
      detail => detail instanceof AuthenticationRequestOrdinalVDXFObject,
    );
    if (authentication) {
      context.authorizationChecks?.add(() =>
        validateAuthenticationExpiry(authentication.data),
      );
    }

    if (selectedIdentity) {
      const user = await assertIndependentIdentityControl(
        selectedIdentity,
        {...context, sessionScope, assertActive},
        signKey,
      );
      if (
        !appEncryptionIdentityMatchesConstraints(
          getAppEncryptionIdentityConstraints(request),
          {
            ...selectedIdentity,
            parentID: user.identity.parent,
          },
        )
      ) {
        throw new Error(
          'The selected identity does not satisfy the authentication constraints.',
        );
      }
    }

    return {
      coinObj,
      appScopeID: identityAddress(request.appOrDelegatorID.toIAddress()),
      bootstrap: true,
    };
  }

  const signer = identityResult(await source.rpc.getIdentity(signerID));
  assertActive();

  let signingIdentity = signer;

  if (request.hasAppOrDelegatorID()) {
    const {height} = await client.getSignatureInfo(
      signerID,
      request.signature.signatureAsVch.toString('base64'),
      coinObj.system_id,
    );
    assertActive();

    // Height zero means "current" to getidentity; it cannot prove past authority.
    if (!Number.isSafeInteger(height) || height <= 0 || height > 2147483647) {
      throw new Error('Invalid request signature height.');
    }

    signingIdentity = identityResult(
      await source.rpc.getIdentity(signerID, height),
    );
    assertActive();

    // RPC returns the last identity update height, which may precede signing.
    if (
      !Number.isSafeInteger(signingIdentity.blockheight) ||
      signingIdentity.blockheight < 0 ||
      signingIdentity.blockheight > height
    ) {
      throw new Error(
        'Unable to verify identity authority at the request signing height.',
      );
    }
  }

  // No wallet key is accessed until the signed request has been verified.
  // For explicit scopes, verify against the historical record, not today's keys.
  const verified = await client.verifyGenericRequest(
    request,
    signingIdentity,
    coinObj.system_id,
  );
  assertActive();
  if (!verified) throw new Error('Failed to verify request signature');
  const constraints = getAppEncryptionIdentityConstraints(request);

  const appScopeID = request.hasAppOrDelegatorID()
    ? identityAddress(request.appOrDelegatorID.toIAddress())
    : signerID;

  if (!needsProfile) return {coinObj, appScopeID};

  const identities = request.hasAppOrDelegatorID() ? [signer] : [];
  let selectedAddresses;

  if (selectedIdentity != null) {
    const selectedID = identityAddress(selectedIdentity.identityID);
    const selectedSystemID = identityAddress(selectedIdentity.systemID);
    const selectedCoin = CoinDirectory.getBasicCoinObj(selectedSystemID);

    if (
      selectedCoin?.system_id !== selectedSystemID ||
      !selectedCoin.vrpc_endpoints?.[0]
    ) {
      throw new Error('Unsupported selected identity chain.');
    }

    if (!!selectedCoin.testnet !== request.isTestnet()) {
      throw new Error('The selected identity is on a different network.');
    }

    VrpcProvider.initEndpoint(selectedSystemID, selectedCoin.vrpc_endpoints[0]);
    // The same ID can have different signing authorities on different chains.
    const selected =
      selectedID === signerID && selectedSystemID === coinObj.system_id
        ? signer
        : identityResult(
            await authorizationSource(
              selectedSystemID,
              context,
            ).rpc.getIdentity(selectedID),
          );

    assertActive();

    if (
      !appEncryptionIdentityMatchesConstraints(constraints, {
        identityID: selectedID,
        systemID: selectedSystemID,
        parentID: selected.identity.parent,
      })
    ) {
      throw new Error(
        'The selected identity does not satisfy the authentication constraints.',
      );
    }

    identities.push(selected);
    selectedAddresses = new Set(selected.identity.primaryaddresses);
  }

  const keys = walletAuthorizationKeys(
    store.getState().authentication.activeAccount,
    request.isTestnet(),
  );

  if (request.hasAppOrDelegatorID()) {
    let selfControlled = false;
    try {
      requiredAuthorities(signer, keys);
      requiredAuthorities(signingIdentity, keys, true);
      selfControlled = true;
    } catch (_) {
      // An external controller must present a complete stored grant. Choose the
      // path before loading grants; failure there never falls back to ownership.
    }

    if (!selfControlled) {
      if (
        !inspectAuthorizationSigners(
          request,
          {...signingIdentity, systemID: coinObj.system_id},
          {...signer, systemID: coinObj.system_id},
        ).valid
      ) {
        throw new Error(
          'The request is not signed by the delegate’s current authority.',
        );
      }
      const authentication = request.details.find(
        detail => detail instanceof AuthenticationRequestOrdinalVDXFObject,
      );
      if (authentication) validateAuthenticationExpiry(authentication.data);
      else if (
        !context.verifyFreshness ||
        !(await context.verifyFreshness(request))
      ) {
        throw new Error(
          'A delegated request requires a current signed expiry.',
        );
      }
      if (authentication) {
        context.authorizationChecks?.add(() =>
          validateAuthenticationExpiry(authentication.data),
        );
      }
      // Reject unsupported profiles before opening credentials. The SDK's grant
      // check reuses these reads, and the phase checks their freshness once.
      await assertAppDelegatorProfileSupportedV1(source, {
        systemID: coinObj.system_id,
        identityID: appScopeID,
      });
      assertActive();
      const guardedContext = authorizationContext({
        ...context,
        sessionScope,
        assertActive,
      });
      const linkedUsers = async () => {
        const data = await requestServiceStoredData(VERUSID_SERVICE_ID);
        guardedContext.assertActive();
        return linkedAuthorizationUsers(data, request.isTestnet(), constraints);
      };

      // Admission and execution use the same complete grant verifier. Discovery
      // checks one U at a time; it never combines records from different users.
      const verifyUser = async user => {
        const view = await loadAuthorizationCredentials(user, guardedContext);
        guardedContext.assertActive();
        if (
          !selectedIdentity &&
          !appEncryptionIdentityMatchesConstraints(constraints, {
            ...user,
            parentID: view.identity?.identity?.parent,
          })
        )
          throw new Error(
            'The linked identity does not satisfy the authentication constraints.',
          );

        if (
          !view.records.some(
            ({record, identities}) =>
              record instanceof AuthorizationCredential &&
              identities?.appID === appScopeID &&
              identities?.delegateID === signerID &&
              record.getSystemID(source.rootSystemID) === coinObj.system_id,
          )
        )
          throw new Error(NO_CURRENT_APP_APPROVAL);

        const usableKeys = [];
        // Credential loading already proves control. Open keys again only when
        // this operation needs signatures; the final verifier still checks U.
        if (signKey) {
          await assertIndependentIdentityControl(user, guardedContext, key =>
            usableKeys.push(key),
          );
        }

        const valid = await client.verifyDelegatedGenericRequest(request, {
          user,
          rootSystemID: source.rootSystemID,
          records: view.records,
          verifyFreshness: context.verifyFreshness,
          verifyUserControl: async currentUser => {
            guardedContext.assertActive();
            const current = await assertIndependentIdentityControl(
              currentUser,
              guardedContext,
            );
            await assertAuthorizationCredentialsCurrent(view, guardedContext);
            return appEncryptionIdentityMatchesConstraints(constraints, {
              ...currentUser,
              parentID: current.identity.parent,
            });
          },
          verifyStorageControl: async (binding, appKeyIDs) => {
            await assertAuthorizationStorageControl(
              binding,
              appKeyIDs,
              guardedContext,
            );
            return true;
          },
        });
        guardedContext.assertActive();
        if (!valid) throw new Error(NO_CURRENT_APP_APPROVAL);

        // Decryption and chain verification can take time. A removed link cannot
        // satisfy admission, even if its previously loaded grant was valid.
        if (
          !selectedIdentity &&
          !(await linkedUsers()).some(
            linked =>
              linked.identityID === user.identityID &&
              linked.systemID === user.systemID,
          )
        )
          throw new Error(
            'The authorized identity is no longer linked to this profile.',
          );

        await assertAuthorizationCredentialsCurrent(view, guardedContext);
        const finalDelegate = await loadIdentityRevision(source, {
          identityID: signerID,
          systemID: coinObj.system_id,
        });
        guardedContext.assertActive();
        if (
          finalDelegate.txid !== signer.txid ||
          finalDelegate.vout !== signer.vout ||
          finalDelegate.blockheight !== signer.blockheight
        ) {
          throw new Error(
            'The delegate identity changed during authorization. Review the request again.',
          );
        }
        let operation;
        if (selectedIdentity && context.executionStep) {
          operation = await reserveDelegatedExecution(
            request,
            user,
            context.executionStep,
            guardedContext,
          );
          onReserved?.(operation);
          if (context.executionReceipt) {
            await recordDelegatedTransaction(
              operation,
              context.executionStep,
              context.executionReceipt,
            );
          }
          guardedContext.assertActive();
        }
        if (authentication) validateAuthenticationExpiry(authentication.data);
        // Only execution with an explicitly selected U may produce signatures.
        if (signKey) usableKeys.forEach(signKey);
        return {coinObj, appScopeID, delegated: true, operation};
      };

      if (selectedIdentity) return verifyUser(selectedIdentity);

      // Finding a grant permits review, not automatic selection or execution.
      // Serial discovery avoids simultaneous native key/password prompts and
      // stops as soon as one independently verified linked identity qualifies.
      for (const user of await linkedUsers()) {
        try {
          return await verifyUser(user);
        } catch (error) {
          guardedContext.assertActive();
          if (
            error?.code === 'SESSION_CHANGED' ||
            error?.code === 'UNSUPPORTED_DELEGATOR_PROFILE'
          )
            throw error;
          if (authentication) validateAuthenticationExpiry(authentication.data);
          // An unrelated, unreadable or unauthorized U is not proof. Another
          // linked U may still supply its own complete, currently valid grant.
        }
      }
      throw new Error(NO_LINKED_APP_APPROVAL);
    }
  }

  // Check all thresholds before opening any private key, including the user's
  // selected identity. Signer equality with an explicit scope is no exception.
  const requirements = identities.map(identity =>
    requiredAuthorities(identity, keys),
  );

  if (request.hasAppOrDelegatorID()) {
    requirements.push(requiredAuthorities(signingIdentity, keys, true));
  }

  const usable = new Set();
  const controlled = () =>
    requirements.every(
      ({addresses, threshold}) =>
        [...usable].filter(address => addresses.has(address)).length >=
        threshold,
    );

  for (const key of keys) {
    if (
      usable.has(key.address) ||
      !requirements.some(({addresses}) => addresses.has(key.address))
    )
      continue;
    assertActive();
    let usablePair;

    try {
      const privateKey = await requestPrivKey(key.coin.id, key.channel, {
        sessionScope,
      });
      assertActive();
      const pair = ECPair.fromWIF(
        privateKey,
        networks[key.coin.bitgojs_network_key],
      );
      const address = ECPair.fromPublicKeyBuffer(
        pair.getPublicKeyBuffer(),
        networks.verus,
      ).getAddress();

      if (address === key.address) usablePair = pair;
    } catch (error) {
      assertActive();
      if (error?.code === 'SESSION_CHANGED') throw error;
    }

    if (usablePair) {
      usable.add(key.address);

      // Signing uses each proved key only within this call, never UI or state.
      if (signKey && selectedAddresses.has(key.address)) {
        usablePair.network = networks.verus;
        signKey(usablePair);
      }
    }

    if (controlled()) break;
  }

  assertActive();
  if (!controlled())
    throw new Error(
      'The active profile cannot use the required identity signing keys.',
    );

  return {coinObj, appScopeID};
};

export const assertSignedRequestAuthorization = (request, context) =>
  withAuthorizationReadScope(context, scoped =>
    authorize(request, null, scoped),
  );

// Called again at approval time; envelope validation may belong to an older
// profile or identity selection and cannot authorize access to channel keys.
export const assertAppEncryptionAuthorization = (
  request,
  selectedIdentity,
  context,
) => {
  if (selectedIdentity == null) throw new Error('Select a signing identity.');
  return withAuthorizationReadScope(context, scoped =>
    authorize(request, selectedIdentity, scoped),
  );
};

export const withAppEncryptionSigningKeys = async (
  request,
  selectedIdentity,
  context,
  signKey,
) => {
  const keys = [];
  let reservation;
  let signingStarted = false;
  try {
    // Signing owns a fresh phase even when a caller still has review evidence.
    const result = await withAuthorizationReadScope(
      {...context, authorizationSources: undefined},
      scoped =>
        authorize(
          request,
          selectedIdentity,
          scoped,
          key => keys.push(key),
          operation => {
            reservation = operation;
          },
        ),
    );
    // Never produce a signature until the phase's final fresh check succeeds.
    context?.assertActive?.();
    signingStarted = true;
    keys.forEach(signKey);
    return result;
  } catch (error) {
    if (reservation && !signingStarted) {
      try {
        // A failed final RPC check produced no signature. Keep retry possible
        // for this request, while retaining any already recorded side effect.
        await releaseDelegatedSigningReservation(
          reservation,
          context.executionStep,
        );
      } catch (_) {
        // Session changes or a saved result keep the durable replay protection.
      }
    }
    throw error;
  } finally {
    keys.length = 0;
  }
};

/** Freeze the reviewed request and UI/session binding across an operation's awaits. */
export const scopedRequestContext = (request, user, context = {}) => {
  const guarded = authorizationContext(context, user);
  const requestHex = request.toBuffer().toString('hex');
  const sessionKey = getAppEncryptionSessionKey(store.getState());
  return {
    ...guarded,
    assertActive: () => {
      guarded.assertActive();
      if (
        getAppEncryptionSessionKey(store.getState()) !== sessionKey ||
        request.toBuffer().toString('hex') !== requestHex
      ) {
        throw Object.assign(
          new Error('The request changed. Review it again.'),
          {code: 'SESSION_CHANGED'},
        );
      }
    },
  };
};
