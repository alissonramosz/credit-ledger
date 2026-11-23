import { createHash, randomUUID } from 'node:crypto';
import {
  HoldNotActiveError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  LedgerError,
} from './errors.js';
import type { AccountRow, Balance, Entry, Hold, LedgerStore, LedgerTx } from './types.js';
import { assertAmount, assertKey, assertText, safeSum } from './validate.js';

export interface LedgerOptions {
  store: LedgerStore;
  /** Clock for timestamps and hold expiry. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface GrantResult {
  accountId: string;
  balance: Balance;
  /** `true` when this call was a retry and the original result is returned unchanged. */
  replayed: boolean;
}

export interface ReserveResult {
  hold: Hold;
  balance: Balance;
  replayed: boolean;
}

export interface SettleResult {
  hold: Hold;
  /** Credits consumed by the job. */
  consumed: number;
  /** Credits from the hold that went back to `available`. */
  returned: number;
  balance: Balance;
  replayed: boolean;
}

export interface ReleaseResult {
  hold: Hold;
  returned: number;
  balance: Balance;
  replayed: boolean;
}

export interface VerifyResult {
  /** `true` when replaying the history reproduces the stored balance. */
  ok: boolean;
  entries: number;
  expected: Balance;
  actual: Balance;
}

/**
 * Credits for work that takes time, can fail and gets retried.
 *
 * - `reserve` sets credits aside before the work starts.
 * - `settle` consumes what the work used and returns the rest.
 * - `release` returns everything (the work failed or was cancelled).
 *
 * Every write needs an `idempotencyKey`. Repeating a call with the same key and
 * the same arguments returns the first result (`replayed: true`) and changes nothing.
 * Only successful calls are remembered, so a call that failed can be retried.
 */
export class Ledger {
  private readonly store: LedgerStore;
  private readonly clock: () => Date;

  constructor(options: LedgerOptions) {
    this.store = options.store;
    this.clock = options.now ?? (() => new Date());
  }

  /** Add credits to an account. The account is created by its first grant. */
  async grant(
    accountId: string,
    amount: number,
    options: { idempotencyKey: string },
  ): Promise<GrantResult> {
    assertText('accountId', accountId);
    assertAmount('amount', amount);
    const key = options.idempotencyKey;
    return this.run(key, { op: 'grant', accountId, amount }, async (tx) => {
      await tx.ensureAccount(accountId);
      const account = await this.lock(tx, accountId);
      const available = safeSum(account.available, amount);
      await tx.setBalance(accountId, available, account.held);
      await tx.insertEntry({
        accountId,
        holdId: null,
        type: 'grant',
        amount,
        availableAfter: available,
        heldAfter: account.held,
        idempotencyKey: key,
        createdAt: this.stamp(),
      });
      return { accountId, balance: { available, held: account.held } };
    });
  }

  /**
   * Set credits aside for a job. Fails with `INSUFFICIENT_CREDITS` when the account
   * cannot cover it. Pass `holdId` to choose the id (for example the job id) and
   * `ttlMs` to let the hold expire when `expireHolds()` runs.
   */
  async reserve(
    accountId: string,
    amount: number,
    options: { idempotencyKey: string; holdId?: string; ttlMs?: number },
  ): Promise<ReserveResult> {
    assertText('accountId', accountId);
    assertAmount('amount', amount);
    if (options.holdId !== undefined) assertText('holdId', options.holdId);
    if (options.ttlMs !== undefined) assertAmount('ttlMs', options.ttlMs);
    const key = options.idempotencyKey;
    const fingerprint = {
      op: 'reserve',
      accountId,
      amount,
      holdId: options.holdId ?? null,
      ttlMs: options.ttlMs ?? null,
    };
    return this.run(key, fingerprint, async (tx) => {
      const account = await this.lock(tx, accountId);
      if (account.available < amount) {
        throw new InsufficientCreditsError(accountId, account.available, amount);
      }
      const now = this.clock();
      const hold: Hold = {
        id: options.holdId ?? randomUUID(),
        accountId,
        amount,
        status: 'held',
        settledAmount: null,
        expiresAt:
          options.ttlMs === undefined ? null : new Date(now.getTime() + options.ttlMs).toISOString(),
        createdAt: now.toISOString(),
        closedAt: null,
      };
      const available = account.available - amount;
      const held = safeSum(account.held, amount);
      await tx.insertHold(hold);
      await tx.setBalance(accountId, available, held);
      await tx.insertEntry({
        accountId,
        holdId: hold.id,
        type: 'reserve',
        amount,
        availableAfter: available,
        heldAfter: held,
        idempotencyKey: key,
        createdAt: hold.createdAt,
      });
      return { hold, balance: { available, held } };
    });
  }

  /**
   * Consume credits from a hold. Without `amount` the whole hold is consumed; with a
   * smaller `amount` the difference returns to `available`. Use `release` to consume nothing.
   */
  async settle(
    holdId: string,
    options: { idempotencyKey: string; amount?: number },
  ): Promise<SettleResult> {
    assertText('holdId', holdId);
    if (options.amount !== undefined) assertAmount('amount', options.amount);
    const key = options.idempotencyKey;
    return this.run(key, { op: 'settle', holdId, amount: options.amount ?? null }, async (tx) => {
      const { account, hold } = await this.lockHold(tx, holdId);
      const consumed = options.amount ?? hold.amount;
      if (consumed > hold.amount) {
        throw new LedgerError(
          'SETTLE_EXCEEDS_HOLD',
          `Cannot settle ${consumed} credits from a hold of ${hold.amount}`,
        );
      }
      const returned = hold.amount - consumed;
      const stamp = this.stamp();
      let available = account.available;
      let held = account.held - consumed;
      await tx.insertEntry({
        accountId: account.id,
        holdId,
        type: 'settle',
        amount: consumed,
        availableAfter: available,
        heldAfter: held,
        idempotencyKey: key,
        createdAt: stamp,
      });
      if (returned > 0) {
        available = safeSum(available, returned);
        held -= returned;
        await tx.insertEntry({
          accountId: account.id,
          holdId,
          type: 'release',
          amount: returned,
          availableAfter: available,
          heldAfter: held,
          idempotencyKey: key,
          createdAt: stamp,
        });
      }
      await tx.setBalance(account.id, available, held);
      await tx.closeHold(holdId, { status: 'settled', settledAmount: consumed, closedAt: stamp });
      const closed: Hold = { ...hold, status: 'settled', settledAmount: consumed, closedAt: stamp };
      return { hold: closed, consumed, returned, balance: { available, held } };
    });
  }

  /** Return the whole hold to `available`: the job failed or was cancelled. */
  async release(holdId: string, options: { idempotencyKey: string }): Promise<ReleaseResult> {
    assertText('holdId', holdId);
    const key = options.idempotencyKey;
    return this.run(key, { op: 'release', holdId }, async (tx) => {
      const { account, hold } = await this.lockHold(tx, holdId);
      const closed = await this.returnHold(tx, account, hold, 'released', 'release', key, this.stamp());
      return { hold: closed.hold, returned: hold.amount, balance: closed.balance };
    });
  }

  /**
   * Return the credits of every hold whose `ttlMs` has passed. The ledger has no background
   * timer: call this from your own scheduler. Safe to run twice and from several workers.
   */
  async expireHolds(options: { limit?: number } = {}): Promise<{ expired: number }> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new LedgerError('INVALID_ARGUMENT', 'limit must be between 1 and 1000');
    }
    const now = this.stamp();
    const candidates = await this.store.transaction((tx) => tx.listExpiredHolds(now, limit));
    let expired = 0;
    for (const candidate of candidates) {
      const done = await this.store.transaction(async (tx) => {
        const account = await tx.lockAccount(candidate.accountId);
        const hold = await tx.getHold(candidate.id);
        if (!account || !hold || hold.status !== 'held') return false;
        if (hold.expiresAt === null || hold.expiresAt > now) return false;
        await this.returnHold(tx, account, hold, 'expired', 'expire', `system:expire:${hold.id}`, now);
        return true;
      });
      if (done) expired += 1;
    }
    return { expired };
  }

  async balance(accountId: string): Promise<Balance> {
    assertText('accountId', accountId);
    return this.store.transaction(async (tx) => {
      const account = await tx.getAccount(accountId);
      if (!account) throw notFound(accountId);
      return { available: account.available, held: account.held };
    });
  }

  async getHold(holdId: string): Promise<Hold | null> {
    assertText('holdId', holdId);
    return this.store.transaction((tx) => tx.getHold(holdId));
  }

  /** The append-only history, newest first. Page backwards with `beforeId`. */
  async history(
    accountId: string,
    options: { limit?: number; beforeId?: number } = {},
  ): Promise<Entry[]> {
    assertText('accountId', accountId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new LedgerError('INVALID_ARGUMENT', 'limit must be between 1 and 1000');
    }
    return this.store.transaction(async (tx) => {
      if (!(await tx.getAccount(accountId))) throw notFound(accountId);
      return tx.listEntries(accountId, { limit, beforeId: options.beforeId, order: 'desc' });
    });
  }

  /**
   * Replay the whole history of an account and compare it with the stored balance.
   * It locks the account while it reads, so use it for audits and tests, not on a hot path.
   */
  async verify(accountId: string): Promise<VerifyResult> {
    assertText('accountId', accountId);
    return this.store.transaction(async (tx) => {
      const account = await this.lock(tx, accountId);
      let available = 0;
      let held = 0;
      let afterId = 0;
      let count = 0;
      let consistent = true;
      for (;;) {
        const page = await tx.listEntries(accountId, { limit: 500, afterId, order: 'asc' });
        if (page.length === 0) break;
        for (const entry of page) {
          switch (entry.type) {
            case 'grant':
              available += entry.amount;
              break;
            case 'reserve':
              available -= entry.amount;
              held += entry.amount;
              break;
            case 'settle':
              held -= entry.amount;
              break;
            case 'release':
            case 'expire':
              held -= entry.amount;
              available += entry.amount;
              break;
          }
          if (entry.availableAfter !== available || entry.heldAfter !== held) consistent = false;
          afterId = entry.id;
          count += 1;
        }
      }
      return {
        ok: consistent && available === account.available && held === account.held,
        entries: count,
        expected: { available, held },
        actual: { available: account.available, held: account.held },
      };
    });
  }

  // ---------------------------------------------------------------------------

  private stamp(): string {
    return this.clock().toISOString();
  }

  /** Claim the key, run the work, remember the result. A repeated key replays the first result. */
  private run<T extends object>(
    key: string,
    fingerprint: object,
    work: (tx: LedgerTx) => Promise<T>,
  ): Promise<T & { replayed: boolean }> {
    assertKey(key);
    const digest = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
    return this.store.transaction(async (tx) => {
      if (!(await tx.claimIdempotency(key, digest))) {
        const record = await tx.findIdempotency(key);
        if (!record || record.result === null) {
          throw new LedgerError(
            'IDEMPOTENCY_CONFLICT',
            `Idempotency key "${key}" belongs to an operation that has not finished`,
          );
        }
        if (record.fingerprint !== digest) throw new IdempotencyConflictError(key);
        return { ...(record.result as T), replayed: true };
      }
      const result = await work(tx);
      await tx.completeIdempotency(key, result);
      return { ...result, replayed: false };
    });
  }

  private async lock(tx: LedgerTx, accountId: string): Promise<AccountRow> {
    const account = await tx.lockAccount(accountId);
    if (!account) throw notFound(accountId);
    return account;
  }

  /**
   * Lock the hold's account, then read the hold again: another operation may have closed it
   * between the first read and the lock.
   */
  private async lockHold(tx: LedgerTx, holdId: string): Promise<{ account: AccountRow; hold: Hold }> {
    const peek = await tx.getHold(holdId);
    if (!peek) throw holdNotFound(holdId);
    const account = await this.lock(tx, peek.accountId);
    const hold = await tx.getHold(holdId);
    if (!hold) throw holdNotFound(holdId);
    if (hold.status !== 'held') throw new HoldNotActiveError(hold.id, hold.status);
    return { account, hold };
  }

  /** Give the whole hold back to `available` (used by `release` and by expiry). */
  private async returnHold(
    tx: LedgerTx,
    account: AccountRow,
    hold: Hold,
    status: 'released' | 'expired',
    type: 'release' | 'expire',
    key: string,
    stamp: string,
  ): Promise<{ hold: Hold; balance: Balance }> {
    const available = safeSum(account.available, hold.amount);
    const held = account.held - hold.amount;
    await tx.insertEntry({
      accountId: account.id,
      holdId: hold.id,
      type,
      amount: hold.amount,
      availableAfter: available,
      heldAfter: held,
      idempotencyKey: key,
      createdAt: stamp,
    });
    await tx.setBalance(account.id, available, held);
    await tx.closeHold(hold.id, { status, settledAmount: null, closedAt: stamp });
    return { hold: { ...hold, status, closedAt: stamp }, balance: { available, held } };
  }
}

function notFound(accountId: string): LedgerError {
  return new LedgerError('ACCOUNT_NOT_FOUND', `Account "${accountId}" does not exist`);
}

function holdNotFound(holdId: string): LedgerError {
  return new LedgerError('HOLD_NOT_FOUND', `Hold "${holdId}" does not exist`);
}
