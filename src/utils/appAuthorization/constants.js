export const AUTHORIZATION_STATUS = Object.freeze({
  RECEIVED: 'received',
  GIFT_REVIEW: 'gift_review',
  READY: 'ready_for_authorization',
  WAITING_FOR_GRANT: 'waiting_for_grant_confirmation',
  WAITING_FOR_REMOVAL: 'waiting_for_removal_confirmation',
  RESPONSE_READY: 'response_ready',
  COMPLETE: 'complete',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

export const GRANT_RECEIPT_KEY = 'grant';

export const STORAGE_ACCESS_STATE = Object.freeze({
  SHARED: 'shared',
  WALLET_ONLY: 'wallet-only',
  NEEDS_RECOVERY: 'needs-recovery',
  UNAVAILABLE: 'unavailable',
});

// V2 identity signatures contain a seven-byte header followed by each compact
// signature's one-byte length and 65-byte payload. The upstream allocator omits
// the extra length prefixes when several keys sign the same response.
export const IDENTITY_SIGNATURE_VERSION = 2;
export const IDENTITY_SIGNATURE_HEADER_BYTES = 7;
export const IDENTITY_COMPACT_SIGNATURE_BYTES = 66;
