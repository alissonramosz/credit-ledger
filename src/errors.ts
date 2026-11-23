export type LedgerErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_CREDITS'
  | 'HOLD_NOT_FOUND'
  | 'HOLD_ALREADY_EXISTS'
  | 'HOLD_NOT_ACTIVE'
  | 'SETTLE_EXCEEDS_HOLD'
  | 'IDEMPOTENCY_CONFLICT';

/** Every error the ledger throws on purpose. Branch on `code`, not on the message. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** The account does not have enough available credits for a reservation. */
export class InsufficientCreditsError extends LedgerError {
  readonly accountId: string;
  readonly available: number;
  readonly requested: number;

  constructor(accountId: string, available: number, requested: number) {
    super(
      'INSUFFICIENT_CREDITS',
      `Account "${accountId}" has ${available} available credits but ${requested} were requested`,
    );
    this.name = 'InsufficientCreditsError';
    this.accountId = accountId;
    this.available = available;
    this.requested = requested;
  }
}

/** The hold was already settled, released or expired by an earlier operation. */
export class HoldNotActiveError extends LedgerError {
  readonly holdId: string;
  readonly status: string;

  constructor(holdId: string, status: string) {
    super('HOLD_NOT_ACTIVE', `Hold "${holdId}" is already ${status}`);
    this.name = 'HoldNotActiveError';
    this.holdId = holdId;
    this.status = status;
  }
}

/** The idempotency key was already used for a different request. */
export class IdempotencyConflictError extends LedgerError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key "${idempotencyKey}" was already used for a different request`,
    );
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}
