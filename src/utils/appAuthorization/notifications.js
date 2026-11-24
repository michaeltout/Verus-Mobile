import {AUTHORIZATION_STATUS} from './constants';
import {CONNECTED_APPS_SERVICE_ID} from '../constants/services';

// Rebuilt from durable public summaries, independently of dismissible notices.
export const authorizationNotifications = (jobs, accountHash) =>
  Object.values(jobs || {})
    .filter(
      job =>
        job.accountHash === accountHash &&
        (job.giftRecoveryPending ||
          (job.status !== AUTHORIZATION_STATUS.COMPLETE &&
            job.status !== AUTHORIZATION_STATUS.CANCELLED)),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(job => {
      const removingAccess = job.kind === 'removal';
      const waiting = [
        AUTHORIZATION_STATUS.WAITING_FOR_REMOVAL,
        AUTHORIZATION_STATUS.WAITING_FOR_GRANT,
      ].includes(job.status);
      const attention = job.status === AUTHORIZATION_STATUS.EXPIRED;
      const statusText = waiting
        ? 'Waiting for confirmation'
        : attention
        ? 'Needs attention'
        : job.giftRecoveryPending
        ? 'Gift recovery pending'
        : 'Ready to continue';
      return {
        uid: `app-authorization:${job.id}`,
        kind: 'app-authorization',
        jobId: job.id,
        persistent: true,
        title: [
          removingAccess ? 'App access removal' : 'App authorization',
          ` — ${statusText}`,
        ],
        statusText,
        accessibilityHint: removingAccess
          ? 'Opens connected apps'
          : 'Opens this saved authorization request',
        body: waiting
          ? 'View progress'
          : job.giftRecoveryPending
          ? 'Review gift recovery'
          : attention
          ? 'Review request'
          : removingAccess
          ? 'Continue removal'
          : 'Continue authorization',
        isActionable: () => true,
        onAction: props =>
          props.navigation.navigate(
            removingAccess ? 'ServicesHome' : 'DeepLink',
            removingAccess
              ? {
                  screen: 'Service',
                  params: {service: CONNECTED_APPS_SERVICE_ID, user: job.selectedIdentity},
                }
              : {
                  screen: 'AppAuthorizationRequestInfo',
                  params: {jobId: job.id},
                },
          ),
      };
    });
