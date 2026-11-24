import React from 'react';
import {StyleSheet} from 'react-native';
import {Text} from 'react-native-paper';
import Colors from '../globals/colors';

// Match the secondary text used in the app's registration and review screens.
const SECONDARY_TEXT_COLOR = '#596579';

const signerNames = ({
  signerFqn,
  signerIdentityID,
  appOrDelegatorID,
  appOrDelegatorFqn,
  request,
  fallback = 'Requester',
}) => {
  const delegatorID =
    appOrDelegatorID ||
    (request?.hasAppOrDelegatorID?.()
      ? request.appOrDelegatorID.toIAddress()
      : null);

  return {
    signer:
      signerFqn ||
      signerIdentityID ||
      request?.signature?.identityID?.toIAddress?.() ||
      fallback,
    delegator: delegatorID ? appOrDelegatorFqn || delegatorID : null,
  };
};

/** The same attribution is used in prose and accessibility labels. */
export const getRequestSignerLabel = props => {
  const {signer, delegator} = signerNames(props);
  return delegator ? `${signer} on behalf of ${delegator}` : signer;
};

/** Keep the actual signer visible while giving the represented identity emphasis. */
export default function RequestSigner({
  signerFqn,
  signerIdentityID,
  appOrDelegatorID,
  appOrDelegatorFqn,
  request,
  fallback,
  style,
  ...textProps
}) {
  const {signer, delegator} = signerNames({
    signerFqn,
    signerIdentityID,
    appOrDelegatorID,
    appOrDelegatorFqn,
    request,
    fallback,
  });

  // One wrapping text element preserves reading order and Dynamic Type without
  // clipping either identity or relying on color to explain their relationship.
  return (
    <Text
      {...textProps}
      allowFontScaling
      accessibilityLabel={
        delegator ? `${signer} on behalf of ${delegator}` : signer
      }
      style={[styles.label, style]}>
      {delegator && (
        <Text style={styles.delegate}>{signer} on behalf of </Text>
      )}
      {delegator || signer}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.quaternaryColor,
    flexShrink: 1,
  },
  delegate: {
    fontSize: 16,
    fontWeight: '400',
    color: SECONDARY_TEXT_COLOR,
  },
});
