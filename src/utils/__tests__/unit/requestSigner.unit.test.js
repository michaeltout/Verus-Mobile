import React from 'react';
import {create} from 'react-test-renderer';
import RequestSigner, {getRequestSignerLabel} from '../../../components/RequestSigner';

jest.mock('react-native', () => ({StyleSheet: {create: styles => styles}}));
jest.mock('react-native-paper', () => ({Text: 'Text'}));

const textContent = node => typeof node === 'string'
  ? node
  : (node.children || []).map(textContent).join('');

it('keeps both identities in reading order and in the accessible attribution', () => {
  const props = {
    signerFqn: 'delegate.Parent@',
    signerIdentityID: 'delegate-id',
    appOrDelegatorFqn: 'app.OtherParent@',
    appOrDelegatorID: 'app-id',
  };
  const view = create(<RequestSigner {...props} />);
  const expected = 'delegate.Parent@ on behalf of app.OtherParent@';

  expect(textContent(view.toJSON())).toBe(expected);
  expect(view.toJSON().props.accessibilityLabel).toBe(expected);
  expect(getRequestSignerLabel(props)).toBe(expected);
  view.unmount();
});

it('falls back to the distinct signed identities when display names are unavailable', () => {
  const props = {
    request: {
      signature: {identityID: {toIAddress: () => 'delegate-id'}},
      hasAppOrDelegatorID: () => true,
      appOrDelegatorID: {toIAddress: () => 'app-id'},
    },
  };
  const view = create(<RequestSigner {...props} />);
  expect(textContent(view.toJSON())).toBe('delegate-id on behalf of app-id');
  expect(getRequestSignerLabel(props)).toBe('delegate-id on behalf of app-id');
  view.unmount();
});

it('shows an explicit scope even when the signer and delegator are the same identity', () => {
  expect(getRequestSignerLabel({
    signerFqn: 'same@',
    signerIdentityID: 'same-id',
    appOrDelegatorID: 'same-id',
    appOrDelegatorFqn: 'same@',
  })).toBe('same@ on behalf of same@');
});

it('keeps ordinary unscoped requests attributed only to their signer', () => {
  const view = create(<RequestSigner signerFqn="signer@" />);
  expect(textContent(view.toJSON())).toBe('signer@');
  expect(view.toJSON().props.accessibilityLabel).toBe('signer@');
  expect(getRequestSignerLabel({fallback: 'An app'})).toBe('An app');
  view.unmount();
});

it('retains long fully qualified identities and supports larger system text', () => {
  const signerFqn = `${'delegate.'.repeat(10)}Parent@`;
  const appOrDelegatorFqn = `${'app.'.repeat(10)}OtherParent@`;
  const view = create(<RequestSigner
    signerFqn={signerFqn}
    appOrDelegatorID="app-id"
    appOrDelegatorFqn={appOrDelegatorFqn}
  />);

  expect(textContent(view.toJSON())).toBe(`${signerFqn} on behalf of ${appOrDelegatorFqn}`);
  expect(view.toJSON().props.allowFontScaling).toBe(true);
  expect(view.toJSON().props.numberOfLines).toBeUndefined();
  view.unmount();
});
