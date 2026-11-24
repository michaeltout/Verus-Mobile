import {convertFqnToDisplayFormat} from '../../../../fullyqualifiedname';
import {getIdentity} from './getIdentity';

// Names are display metadata. A caller resolving several identities together can
// share this operation's names and pending lookups without caching authority.
export const getFriendlyNameMap = async (
  systemId,
  identityObj,
  initAddresses = [],
  {names = {}, pending = new Map()} = {},
) => {
  const identity = identityObj.identity;
  const ownAddress = identity.identityaddress;
  Object.assign(names, {
    i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV: 'VRSC',
    iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq: 'VRSCTEST',
  });
  if (identityObj.fullyqualifiedname) {
    names[ownAddress] = convertFqnToDisplayFormat(
      identityObj.fullyqualifiedname,
    );
  }

  const addresses = new Set([
    ...initAddresses,
    ownAddress,
    identity.revocationauthority,
    identity.recoveryauthority,
    identity.systemid,
  ]);
  await Promise.all(
    [...addresses]
      .filter(address => address && !names[address])
      .map(async address => {
        const key = `${systemId}:${address}`;
        if (!pending.has(key)) {
          pending.set(
            key,
            getIdentity(systemId, address)
              .then(response => {
                if (response.error || !response.result?.fullyqualifiedname)
                  return null;
                return convertFqnToDisplayFormat(
                  response.result.fullyqualifiedname,
                );
              })
              .catch(() => null),
          );
        }
        const name = await pending.get(key);
        if (name) names[address] = name;
      }),
  );

  return names;
};
