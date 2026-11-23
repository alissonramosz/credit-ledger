import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type LedgerError, type LedgerStore } from '../src/index.js';

export interface Harness {
  store: LedgerStore;
  close?: () => Promise<void>;
}

export function fakeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const codeOf = (r: PromiseSettledResult<unknown>): string =>
  r.status === 'fulfilled' ? 'OK' : (r.reason as LedgerError).code;

/**
 * The behaviour every store must have. It runs unchanged against the in-memory store
 * and against a real PostgreSQL server.
 */
export function describeLedger(name: string, make: () => Promise<Harness>): void {
  describe(name, () => {
    let harness: Harness;
    let clock: ReturnType<typeof fakeClock>;
    let ledger: Ledger;

    beforeEach(async () => {
      harness = await make();
      clock = fakeClock();
      ledger = new Ledger({ store: harness.store, now: clock.now });
    });

    afterEach(async () => {
      await harness.close?.();
    });

    const rejects = (promise: Promise<unknown>, code: string) =>
      expect(promise).rejects.toMatchObject({ code });

    describe('grant', () => {
      it('creates the account and adds credits', async () => {
        const result = await ledger.grant('acc', 100, { idempotencyKey: 'g1' });
        expect(result).toEqual({
          accountId: 'acc',
          balance: { available: 100, held: 0 },
          replayed: false,
        });
        expect(await ledger.balance('acc')).toEqual({ available: 100, held: 0 });
      });

      it('replays a repeated key without adding credits twice', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'g1' });
        const again = await ledger.grant('acc', 100, { idempotencyKey: 'g1' });
        expect(again).toEqual({
          accountId: 'acc',
          balance: { available: 100, held: 0 },
          replayed: true,
        });
        expect(await ledger.balance('acc')).toEqual({ available: 100, held: 0 });
        expect(await ledger.history('acc')).toHaveLength(1);
      });

      it('refuses the same key for a different request', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'g1' });
        await rejects(ledger.grant('acc', 999, { idempotencyKey: 'g1' }), 'IDEMPOTENCY_CONFLICT');
        await rejects(ledger.grant('other', 100, { idempotencyKey: 'g1' }), 'IDEMPOTENCY_CONFLICT');
        expect(await ledger.balance('acc')).toEqual({ available: 100, held: 0 });
      });

      it('refuses invalid amounts, ids and keys', async () => {
        for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
          await rejects(ledger.grant('acc', bad, { idempotencyKey: 'bad' }), 'INVALID_ARGUMENT');
        }
        await rejects(ledger.grant('', 10, { idempotencyKey: 'k' }), 'INVALID_ARGUMENT');
        await rejects(ledger.grant('acc', 10, { idempotencyKey: '' }), 'INVALID_ARGUMENT');
        await rejects(
          ledger.grant('acc', 10, { idempotencyKey: 'system:expire:x' }),
          'INVALID_ARGUMENT',
        );
      });

      it('refuses a balance beyond the safe integer range', async () => {
        await ledger.grant('acc', Number.MAX_SAFE_INTEGER, { idempotencyKey: 'big' });
        await rejects(ledger.grant('acc', 1, { idempotencyKey: 'one-more' }), 'INVALID_ARGUMENT');
        expect((await ledger.balance('acc')).available).toBe(Number.MAX_SAFE_INTEGER);
      });
    });

    describe('reserve', () => {
      beforeEach(async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
      });

      it('moves credits from available to held', async () => {
        const r = await ledger.reserve('acc', 30, { idempotencyKey: 'r1' });
        expect(r.balance).toEqual({ available: 70, held: 30 });
        expect(r.hold).toMatchObject({
          accountId: 'acc',
          amount: 30,
          status: 'held',
          settledAmount: null,
          expiresAt: null,
          closedAt: null,
        });
        expect(await ledger.getHold(r.hold.id)).toEqual(r.hold);
      });

      it('fails with the numbers when credits are missing', async () => {
        await expect(ledger.reserve('acc', 130, { idempotencyKey: 'r1' })).rejects.toMatchObject({
          code: 'INSUFFICIENT_CREDITS',
          available: 100,
          requested: 130,
        });
        expect(await ledger.balance('acc')).toEqual({ available: 100, held: 0 });
      });

      it('fails for an account that does not exist', async () => {
        await rejects(ledger.reserve('ghost', 10, { idempotencyKey: 'r1' }), 'ACCOUNT_NOT_FOUND');
        await rejects(ledger.balance('ghost'), 'ACCOUNT_NOT_FOUND');
      });

      it('does not use up the key when the call fails', async () => {
        await rejects(ledger.reserve('acc', 150, { idempotencyKey: 'retry' }), 'INSUFFICIENT_CREDITS');
        await ledger.grant('acc', 100, { idempotencyKey: 'topup' });
        const r = await ledger.reserve('acc', 150, { idempotencyKey: 'retry' });
        expect(r).toMatchObject({ replayed: false, balance: { available: 50, held: 150 } });
      });

      it('replays a repeated key and returns the same hold', async () => {
        const first = await ledger.reserve('acc', 30, { idempotencyKey: 'r1' });
        const again = await ledger.reserve('acc', 30, { idempotencyKey: 'r1' });
        expect(again).toEqual({ ...first, replayed: true });
        expect(await ledger.balance('acc')).toEqual({ available: 70, held: 30 });
      });

      it('accepts a hold id chosen by the caller and refuses to reuse it', async () => {
        const r = await ledger.reserve('acc', 10, { idempotencyKey: 'a', holdId: 'job-1' });
        expect(r.hold.id).toBe('job-1');
        await rejects(
          ledger.reserve('acc', 10, { idempotencyKey: 'b', holdId: 'job-1' }),
          'HOLD_ALREADY_EXISTS',
        );
        expect(await ledger.balance('acc')).toEqual({ available: 90, held: 10 });
      });

      it('sets an expiry from ttlMs', async () => {
        const r = await ledger.reserve('acc', 10, { idempotencyKey: 'a', ttlMs: 60_000 });
        expect(r.hold.expiresAt).toBe('2026-01-01T00:01:00.000Z');
      });
    });

    describe('settle', () => {
      beforeEach(async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
        await ledger.reserve('acc', 40, { idempotencyKey: 'r', holdId: 'job' });
      });

      it('consumes the whole hold by default', async () => {
        const r = await ledger.settle('job', { idempotencyKey: 's' });
        expect(r).toMatchObject({
          consumed: 40,
          returned: 0,
          balance: { available: 60, held: 0 },
          replayed: false,
        });
        expect(r.hold).toMatchObject({ status: 'settled', settledAmount: 40 });
      });

      it('consumes part of the hold and returns the rest', async () => {
        const r = await ledger.settle('job', { amount: 25, idempotencyKey: 's' });
        expect(r).toMatchObject({ consumed: 25, returned: 15, balance: { available: 75, held: 0 } });
        expect(await ledger.getHold('job')).toMatchObject({ status: 'settled', settledAmount: 25 });
        const types = (await ledger.history('acc')).map((e) => e.type);
        expect(types).toEqual(['release', 'settle', 'reserve', 'grant']);
      });

      it('refuses to consume more than was held', async () => {
        await rejects(ledger.settle('job', { amount: 41, idempotencyKey: 's' }), 'SETTLE_EXCEEDS_HOLD');
        expect(await ledger.balance('acc')).toEqual({ available: 60, held: 40 });
      });

      it('refuses amounts that are not positive integers', async () => {
        for (const bad of [0, -1, 2.5]) {
          await rejects(ledger.settle('job', { amount: bad, idempotencyKey: 's' }), 'INVALID_ARGUMENT');
        }
      });

      it('refuses a hold that does not exist', async () => {
        await rejects(ledger.settle('nope', { idempotencyKey: 's' }), 'HOLD_NOT_FOUND');
      });

      it('replays the same key and refuses a new key on a closed hold', async () => {
        await ledger.settle('job', { amount: 25, idempotencyKey: 's' });
        const again = await ledger.settle('job', { amount: 25, idempotencyKey: 's' });
        expect(again).toMatchObject({ replayed: true, consumed: 25, returned: 15 });
        await rejects(ledger.settle('job', { amount: 25, idempotencyKey: 's2' }), 'HOLD_NOT_ACTIVE');
        await rejects(ledger.release('job', { idempotencyKey: 'rel' }), 'HOLD_NOT_ACTIVE');
        expect(await ledger.balance('acc')).toEqual({ available: 75, held: 0 });
      });
    });

    describe('release', () => {
      it('returns the whole hold and closes it', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
        const { hold } = await ledger.reserve('acc', 40, { idempotencyKey: 'r' });
        const r = await ledger.release(hold.id, { idempotencyKey: 'rel' });
        expect(r).toMatchObject({
          returned: 40,
          balance: { available: 100, held: 0 },
          hold: { status: 'released' },
        });
        await rejects(ledger.settle(hold.id, { idempotencyKey: 's' }), 'HOLD_NOT_ACTIVE');
        await rejects(ledger.release(hold.id, { idempotencyKey: 'rel2' }), 'HOLD_NOT_ACTIVE');
        expect(await ledger.release(hold.id, { idempotencyKey: 'rel' })).toMatchObject({ replayed: true });
      });
    });

    describe('expireHolds', () => {
      beforeEach(async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
      });

      it('returns the credits of holds past their ttl', async () => {
        await ledger.reserve('acc', 30, { idempotencyKey: 'a', holdId: 'a', ttlMs: 1_000 });
        await ledger.reserve('acc', 20, { idempotencyKey: 'b', holdId: 'b', ttlMs: 10_000 });
        await ledger.reserve('acc', 10, { idempotencyKey: 'c', holdId: 'c' });
        expect(await ledger.expireHolds()).toEqual({ expired: 0 });

        clock.advance(5_000);
        expect(await ledger.expireHolds()).toEqual({ expired: 1 });
        expect(await ledger.balance('acc')).toEqual({ available: 70, held: 30 });
        expect(await ledger.getHold('a')).toMatchObject({ status: 'expired' });
        expect(await ledger.expireHolds()).toEqual({ expired: 0 });

        clock.advance(60_000);
        expect(await ledger.expireHolds()).toEqual({ expired: 1 });
        expect(await ledger.getHold('c')).toMatchObject({ status: 'held' });
        expect(await ledger.balance('acc')).toEqual({ available: 90, held: 10 });
      });

      it('refuses to settle a hold that was already expired', async () => {
        await ledger.reserve('acc', 30, { idempotencyKey: 'a', holdId: 'a', ttlMs: 1_000 });
        clock.advance(2_000);
        await ledger.expireHolds();
        await rejects(ledger.settle('a', { idempotencyKey: 's' }), 'HOLD_NOT_ACTIVE');
      });

      it('only closes a hold when the sweep runs, so a late settle still works before that', async () => {
        await ledger.reserve('acc', 30, { idempotencyKey: 'a', holdId: 'a', ttlMs: 1_000 });
        clock.advance(2_000);
        expect(await ledger.settle('a', { idempotencyKey: 's' })).toMatchObject({ consumed: 30 });
        expect(await ledger.expireHolds()).toEqual({ expired: 0 });
      });

      it('refuses an invalid limit', async () => {
        await rejects(ledger.expireHolds({ limit: 0 }), 'INVALID_ARGUMENT');
      });
    });

    describe('history and verify', () => {
      it('lists entries newest first with the balance after each step, and pages with beforeId', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'g' });
        await ledger.reserve('acc', 40, { idempotencyKey: 'r', holdId: 'h' });
        await ledger.settle('h', { amount: 30, idempotencyKey: 's' });
        const all = await ledger.history('acc');
        expect(all.map((e) => [e.type, e.amount, e.availableAfter, e.heldAfter])).toEqual([
          ['release', 10, 70, 0],
          ['settle', 30, 60, 10],
          ['reserve', 40, 60, 40],
          ['grant', 100, 100, 0],
        ]);
        const page = await ledger.history('acc', { limit: 2, beforeId: all[1]!.id });
        expect(page.map((e) => e.type)).toEqual(['reserve', 'grant']);
      });

      it('refuses the history of an account that does not exist', async () => {
        await rejects(ledger.history('ghost'), 'ACCOUNT_NOT_FOUND');
        await rejects(ledger.verify('ghost'), 'ACCOUNT_NOT_FOUND');
      });

      it('verify replays the history and agrees with the stored balance', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'g' });
        await ledger.reserve('acc', 40, { idempotencyKey: 'r', holdId: 'h' });
        await ledger.settle('h', { amount: 30, idempotencyKey: 's' });
        const result = await ledger.verify('acc');
        expect(result).toEqual({
          ok: true,
          entries: 4,
          expected: { available: 70, held: 0 },
          actual: { available: 70, held: 0 },
        });
      });
    });

    describe('concurrency', () => {
      it('never spends more than the balance when reserves race', async () => {
        await ledger.grant('acc', 250, { idempotencyKey: 'seed' });
        const results = await Promise.allSettled(
          Array.from({ length: 100 }, (_, i) =>
            ledger.reserve('acc', 10, { idempotencyKey: `race-${i}` }),
          ),
        );
        expect(results.filter((r) => codeOf(r) === 'OK')).toHaveLength(25);
        expect(results.filter((r) => codeOf(r) === 'INSUFFICIENT_CREDITS')).toHaveLength(75);
        expect(await ledger.balance('acc')).toEqual({ available: 0, held: 250 });
        expect((await ledger.verify('acc')).ok).toBe(true);
      });

      it('creates one hold when the same request arrives many times at once', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
        const results = await Promise.all(
          Array.from({ length: 50 }, () => ledger.reserve('acc', 10, { idempotencyKey: 'same' })),
        );
        expect(new Set(results.map((r) => r.hold.id)).size).toBe(1);
        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(await ledger.balance('acc')).toEqual({ available: 90, held: 10 });
      });

      it('lets exactly one of settle and release win', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
        await ledger.reserve('acc', 40, { idempotencyKey: 'r', holdId: 'h' });
        const results = await Promise.allSettled([
          ledger.settle('h', { idempotencyKey: 's' }),
          ledger.release('h', { idempotencyKey: 'rel' }),
        ]);
        expect(results.map(codeOf).sort()).toEqual(['HOLD_NOT_ACTIVE', 'OK']);
        expect((await ledger.balance('acc')).held).toBe(0);
        expect((await ledger.verify('acc')).ok).toBe(true);
      });

      it('adds up grants that arrive together on a new account', async () => {
        await Promise.all(
          Array.from({ length: 40 }, (_, i) => ledger.grant('acc', 5, { idempotencyKey: `g-${i}` })),
        );
        expect(await ledger.balance('acc')).toEqual({ available: 200, held: 0 });
        expect((await ledger.verify('acc')).ok).toBe(true);
      });

      it('expires each hold once when two sweeps run at the same time', async () => {
        await ledger.grant('acc', 100, { idempotencyKey: 'seed' });
        for (let i = 0; i < 10; i += 1) {
          await ledger.reserve('acc', 5, { idempotencyKey: `r${i}`, ttlMs: 1_000 });
        }
        clock.advance(2_000);
        const [a, b] = await Promise.all([ledger.expireHolds(), ledger.expireHolds()]);
        expect(a.expired + b.expired).toBe(10);
        expect(await ledger.balance('acc')).toEqual({ available: 100, held: 0 });
        expect((await ledger.verify('acc')).ok).toBe(true);
      });
    });

    describe('model check', () => {
      it('matches a simple model across a long random sequence of operations', async () => {
        const rand = mulberry32(2026);
        const names = ['a', 'b', 'c'];
        const model = new Map(names.map((n) => [n, { available: 0, held: 0 }]));
        const open: { id: string; account: string; amount: number; expiresAt: number | null }[] = [];
        let seq = 0;
        const key = () => `op-${(seq += 1)}`;
        const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;

        for (const n of names) {
          await ledger.grant(n, 100, { idempotencyKey: key() });
          model.get(n)!.available = 100;
        }

        for (let step = 0; step < 250; step += 1) {
          const roll = rand();
          if (roll < 0.15) {
            const n = pick(names);
            const amount = 1 + Math.floor(rand() * 40);
            await ledger.grant(n, amount, { idempotencyKey: key() });
            model.get(n)!.available += amount;
          } else if (roll < 0.5) {
            const n = pick(names);
            const amount = 1 + Math.floor(rand() * 60);
            const ttlMs = rand() < 0.3 ? 1000 * (1 + Math.floor(rand() * 5)) : undefined;
            const m = model.get(n)!;
            if (amount <= m.available) {
              const r = await ledger.reserve(n, amount, { idempotencyKey: key(), ttlMs });
              m.available -= amount;
              m.held += amount;
              open.push({
                id: r.hold.id,
                account: n,
                amount,
                expiresAt: ttlMs === undefined ? null : clock.now().getTime() + ttlMs,
              });
            } else {
              await rejects(
                ledger.reserve(n, amount, { idempotencyKey: key(), ttlMs }),
                'INSUFFICIENT_CREDITS',
              );
            }
          } else if (roll < 0.75 && open.length > 0) {
            const h = open.splice(Math.floor(rand() * open.length), 1)[0]!;
            const consumed = 1 + Math.floor(rand() * h.amount);
            await ledger.settle(h.id, { amount: consumed, idempotencyKey: key() });
            const m = model.get(h.account)!;
            m.held -= h.amount;
            m.available += h.amount - consumed;
          } else if (roll < 0.9 && open.length > 0) {
            const h = open.splice(Math.floor(rand() * open.length), 1)[0]!;
            await ledger.release(h.id, { idempotencyKey: key() });
            const m = model.get(h.account)!;
            m.held -= h.amount;
            m.available += h.amount;
          } else {
            clock.advance(1000 * (1 + Math.floor(rand() * 3)));
            await ledger.expireHolds();
            const now = clock.now().getTime();
            for (let i = open.length - 1; i >= 0; i -= 1) {
              const h = open[i]!;
              if (h.expiresAt !== null && h.expiresAt <= now) {
                const m = model.get(h.account)!;
                m.held -= h.amount;
                m.available += h.amount;
                open.splice(i, 1);
              }
            }
          }
        }

        for (const n of names) {
          expect(await ledger.balance(n)).toEqual(model.get(n));
          expect((await ledger.verify(n)).ok).toBe(true);
        }
      });
    });
  });
}
