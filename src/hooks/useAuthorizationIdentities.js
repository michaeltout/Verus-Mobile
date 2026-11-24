import {useEffect, useState} from 'react';
import {useSelector} from 'react-redux';
import {requestServiceStoredData} from '../utils/auth/authBox';
import {VERUSID_SERVICE_ID} from '../utils/constants/services';
import {CoinDirectory} from '../utils/CoinData/CoinDirectory';
import {convertFqnToDisplayFormat} from '../utils/fullyqualifiedname';
import {assertAuthorizationContext} from '../utils/appAuthorization/jobs';

const EMPTY_IDENTITIES = Object.freeze([]);

// Shared by approval and management. This is a display inventory only; current
// independent control and recipient constraints are checked at submission.
export const useAuthorizationIdentities = (
  context,
  refresh = 0,
  includeStorage = false,
) => {
  const stored = useSelector(
    state => state.services.stored[VERUSID_SERVICE_ID],
  );
  const testnet = useSelector(
    state =>
      Object.keys(state.authentication.activeAccount?.testnetOverrides || {})
        .length > 0,
  );
  const [inventory, setInventory] = useState(null);

  useEffect(() => {
    let active = true;

    requestServiceStoredData(VERUSID_SERVICE_ID)
      .then(data => {
        assertAuthorizationContext(context);
        const choices = [];

        const chains = new Set([
          ...Object.keys(data.linked_ids || {}),
          ...(includeStorage ? Object.keys(data.storage_ids || {}) : []),
        ]);
        for (const chain of chains) {
          let coin;
          try {
            coin = CoinDirectory.findCoinObj(chain);
          } catch (_) {
            continue;
          }

          if (!coin?.system_id || !!coin.testnet !== testnet) continue;

          const storage = data.storage_ids?.[chain] || {};
          const entries = Object.entries(data.linked_ids?.[chain] || {})
            .filter(([identityID]) => !storage[identityID])
            .map(([identityID, name]) => ({
              identityID,
              name,
              isStorage: false,
            }));
          if (includeStorage) {
            entries.push(
              ...Object.entries(storage).map(([identityID, entry]) => ({
                identityID,
                ...entry,
                isStorage: true,
              })),
            );
          }

          for (const {
            identityID,
            name,
            isStorage,
            userIdentityIDs,
          } of entries) {
            choices.push({
              key: `${coin.system_id}:${identityID}`,
              identityID,
              systemID: coin.system_id,
              chain: coin.id,
              isStorage,
              ...(isStorage ? {userIdentityIDs} : {}),
              title: name ? convertFqnToDisplayFormat(name) : identityID,
              description: `${coin.display_ticker || coin.id} · ${identityID}`,
            });
          }
        }

        if (active) {
          setInventory({
            context,
            testnet,
            includeStorage,
            identities: choices.sort((a, b) => a.title.localeCompare(b.title)),
          });
        }
      })
      .catch(() => {
        // An unavailable inventory never substitutes for verified ownership.
        if (active) {
          setInventory({
            context,
            testnet,
            includeStorage,
            identities: EMPTY_IDENTITIES,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [stored, context, refresh, testnet, includeStorage]);

  // Bind display data at render time: effects run too late to prevent the first
  // render of a new profile from exposing the previous profile's identities.
  // Same-scope ciphertext updates retain choices while their read is pending.
  return inventory?.context === context &&
    inventory.testnet === testnet &&
    inventory.includeStorage === includeStorage
    ? inventory.identities
    : EMPTY_IDENTITIES;
};
