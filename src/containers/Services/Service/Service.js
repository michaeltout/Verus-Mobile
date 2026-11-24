/* One service registry reuses the existing feature screens. */

import React from 'react';
import {SafeAreaView} from 'react-native';
import {Text} from 'react-native-paper';
import {useSelector} from 'react-redux';
import {
  CONNECTED_APPS_SERVICE_ID,
  GIFT_CARD_SERVICE_ID,
  PBAAS_PRECONVERT_SERVICE_ID,
  VERUSID_SERVICE_ID,
  WYRE_SERVICE_ID,
} from '../../../utils/constants/services';
import {isExperimentalGenericRequestsEnabled} from '../../../utils/deeplink/experimentalDeeplinks';
import Styles from '../../../styles';
import VerusIdService from '../ServiceComponents/VerusIdService/VerusIdService';
import WyreService from '../ServiceComponents/WyreService/WyreService';
import PbaasPreconvertService from '../ServiceComponents/PbaasPreconvertService/PbaasPreconvertService';
import GiftCardService from '../ServiceComponents/GiftCardService/GiftCardService';
import LinkedAppInstances from '../../DeepLink/LinkedAppInstances/LinkedAppInstances';

const SERVICE_COMPONENTS = {
  [WYRE_SERVICE_ID]: WyreService,
  [VERUSID_SERVICE_ID]: VerusIdService,
  [PBAAS_PRECONVERT_SERVICE_ID]: PbaasPreconvertService,
  [GIFT_CARD_SERVICE_ID]: GiftCardService,
  [CONNECTED_APPS_SERVICE_ID]: LinkedAppInstances,
};

export default function Service({navigation, route}) {
  const experimentalRequestsEnabled = useSelector(
    isExperimentalGenericRequestsEnabled,
  );
  const service = route.params.service;

  // A saved navigation action must obey the same gate as the Services list.
  if (service === CONNECTED_APPS_SERVICE_ID && !experimentalRequestsEnabled) {
    return (
      <SafeAreaView style={Styles.root}>
        <Text>
          Enable experimental deeplinks in General settings to manage connected apps.
        </Text>
      </SafeAreaView>
    );
  }

  const ServiceComponent = SERVICE_COMPONENTS[service];
  return ServiceComponent ? (
    <ServiceComponent navigation={navigation} route={route} />
  ) : null;
}
