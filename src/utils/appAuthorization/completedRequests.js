import {AUTHORIZATION_STATUS} from './constants';

// Once transaction processing is finished, notification retries need only
// identifiers, submission evidence, and the frozen signed response.
const RECEIPT_FIELDS = [
  'systemId',
  'txid',
  'type',
  'status',
  'broadcastAttempted',
  'admittedAt',
  'submitted',
  'acknowledged',
  'submittedAt',
];

const DELEGATE_DISPLAY_FIELDS = [
  'txid',
  'vout',
  'blockheight',
  'fullyqualifiedname',
  'identity',
];

const COMPLETED_JOB_PAYLOADS = [
  'authorizationPlan',
  'giftDiscovery',
  'expectedGrant',
  'approvedDelegator',
  'appEncryptionResponse',
];

const retainFields = (value, fields) => {
  if (value == null) return value;
  const retained = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      retained[field] = value[field];
    }
  }
  return Object.keys(retained).length === Object.keys(value).length
    ? value
    : retained;
};

// Preserve references when nothing changes so progress updates can skip a
// storage write. Copy changed records; callers may still be displaying them.
const compactRecords = (records, compact) => {
  let updated = records;
  for (const [id, record] of Object.entries(records || {})) {
    const next = compact(record);
    if (next !== record) {
      if (updated === records) updated = {...records};
      updated[id] = next;
    }
  }
  return updated;
};

export const compactCompletedAuthorizationJob = job => {
  // A frozen response already passed the final grant checks. Delivery and
  // wallet-card bookkeeping do not require transaction construction data.
  // Cancelled requests may still need their plan for gift/storage recovery.
  const transactionProcessingComplete =
    job.kind === 'removal'
      ? job.status === AUTHORIZATION_STATUS.COMPLETE
      : (job.status === AUTHORIZATION_STATUS.COMPLETE ||
          job.status === AUTHORIZATION_STATUS.RESPONSE_READY) &&
        !!job.responseHex &&
        job.grantConfirmed === true &&
        (!job.hasGift || job.giftConfirmed === true);
  if (!transactionProcessingComplete) return job;

  const compacted = {...job};
  for (const field of COMPLETED_JOB_PAYLOADS) delete compacted[field];

  if (job.transactions) {
    compacted.transactions = compactRecords(job.transactions, receipt =>
      retainFields(receipt, RECEIPT_FIELDS),
    );
  }

  if (job.approvedDelegate) {
    const delegate = retainFields(
      job.approvedDelegate,
      DELEGATE_DISPLAY_FIELDS,
    );
    const identity = retainFields(delegate.identity, [
      'primaryaddresses',
      'minimumsignatures',
    ]);
    compacted.approvedDelegate =
      identity === delegate.identity ? delegate : {...delegate, identity};
  }

  if (job.kind === 'removal' && job.targets?.values) {
    compacted.targets = {...job.targets};
    delete compacted.targets.values;
  }

  return Object.keys(compacted).length === Object.keys(job).length &&
    Object.keys(compacted).every(field => compacted[field] === job[field])
    ? job
    : compacted;
};

export const compactCompletedDelegatedOperation = operation => {
  // A reservation or transaction receipt alone is not a completed request.
  // The signed response is the durable result used for every subsequent retry.
  if (!operation.responseHex) return operation;

  const steps = compactRecords(operation.steps, step => {
    const receipt = retainFields(step.receipt, RECEIPT_FIELDS);
    if (
      !Object.prototype.hasOwnProperty.call(step, 'resultHex') &&
      receipt === step.receipt
    ) {
      return step;
    }

    const compacted = {...step};
    delete compacted.resultHex;
    if (step.receipt != null) compacted.receipt = receipt;
    return compacted;
  });
  return steps === operation.steps ? operation : {...operation, steps};
};

