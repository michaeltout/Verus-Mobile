import React from 'react';
import { createStackNavigator } from "@react-navigation/stack";
import { defaultHeaderOptions } from '../../../utils/navigation/header';
import DeepLink from '../../DeepLink/DeepLink';
import AuthenticationRequestIdentity from '../../DeepLink/AuthenticationRequestIdentity/AuthenticationRequestIdentity';
import GenericRequestComplete from '../../DeepLink/GenericRequestComplete/GenericRequestComplete';
import LoginRequestIdentity from '../../DeepLink/LoginRequestIdentity/LoginRequestIdentity';
import LoginRequestComplete from '../../DeepLink/LoginRequestComplete/LoginRequestComplete';
import InvoicePaymentConfiguration from '../../DeepLink/InvoicePaymentConfiguration/InvoicePaymentConfiguration';
import AppAuthorizationRequestInfo from '../../DeepLink/AppAuthorizationRequestInfo/AppAuthorizationRequestInfo';
import LinkedAppInstances from '../../DeepLink/LinkedAppInstances/LinkedAppInstances';

const DeepLinkStack = createStackNavigator();

const DeepLinkStackScreens = props => {
  return (
    <DeepLinkStack.Navigator
      initialRouteName="VerifyDeepLink"
      screenOptions={defaultHeaderOptions}
    >
      <DeepLinkStack.Screen
        name="AppAuthorizationRequestInfo"
        component={AppAuthorizationRequestInfo}
        options={{title: 'App authorization', headerBackTitleVisible: false, headerRight: () => null}}
      />
      <DeepLinkStack.Screen
        name="LinkedAppInstances"
        component={LinkedAppInstances}
        options={{headerShown: false}}
      />
      <DeepLinkStack.Screen
        name="VerifyDeepLink"
        component={DeepLink}
        options={{
          headerShown: false
        }}
      />
      <DeepLinkStack.Screen
        name="LoginRequestIdentity"
        component={LoginRequestIdentity}
        options={{
          headerRight: () => null,
          title: "Select Identity"
        }}
      />
      <DeepLinkStack.Screen
        name="AuthenticationRequestIdentity"
        component={AuthenticationRequestIdentity}
        options={{
          headerRight: () => null,
          title: "Select Identity"
        }}
      />
      <DeepLinkStack.Screen
        name="LoginRequestComplete"
        component={LoginRequestComplete}
        options={{
          headerShown: false
        }}
      />
      <DeepLinkStack.Screen
        name="GenericRequestComplete"
        component={GenericRequestComplete}
        options={{
          headerShown: false
        }}
      />
      <DeepLinkStack.Screen
        name="InvoicePaymentConfiguration"
        component={InvoicePaymentConfiguration}
        options={{
          headerRight: () => null,
          title: "Configure Payment"
        }}
      />
    </DeepLinkStack.Navigator>
  );
};

export default DeepLinkStackScreens
