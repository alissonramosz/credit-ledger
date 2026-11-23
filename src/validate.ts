import { LedgerError } from './errors.js';

export function assertAmount(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new LedgerError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
  }
}

export function assertText(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new LedgerError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most 255 characters`,
    );
  }
}

export function assertKey(value: unknown): asserts value is string {
  assertText('idempotencyKey', value);
  if (value.startsWith('system:')) {
    throw new LedgerError(
      'INVALID_ARGUMENT',
      'idempotencyKey must not start with "system:" (reserved for the ledger)',
    );
  }
}

export function safeSum(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new LedgerError('INVALID_ARGUMENT', 'The balance would exceed the largest safe integer');
  }
  return sum;
}
