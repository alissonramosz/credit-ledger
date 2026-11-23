import { LedgerError } from './errors.js';
import type {
  AccountRow,
  Entry,
  Hold,
  IdempotencyRecord,
  LedgerStore,
  LedgerTx,
  ListEntriesOptions,
  NewEntry,
} from './types.js';

// Minimal shapes of `pg`'s Pool and PoolClient, so this package has no runtime dependency on `pg`.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PgQueryResult {
  rows: any[];
  rowCount: number | null;
}
export interface PgClientLike {
  query(text: string, values?: any[]): Promise<PgQueryResult>;
}
export interface PgPoolClientLike extends PgClientLike {
  release(destroy?: boolean): void;
}
export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

/** The same text as `migrations/001_init.sql`. */
export const SCHEMA_SQL = `-- credit-ledger schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS credit_accounts (
  id         text PRIMARY KEY,
  available  bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  held       bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_holds (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES credit_accounts (id),
  amount         bigint NOT NULL CHECK (amount > 0),
  status         text NOT NULL CHECK (status IN ('held', 'settled', 'released', 'expired')),
  settled_amount bigint CHECK (settled_amount IS NULL OR settled_amount > 0),
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL,
  closed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS credit_holds_expiry_idx
  ON credit_holds (expires_at)
  WHERE status = 'held' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_entries (
  id              bigserial PRIMARY KEY,
  account_id      text NOT NULL REFERENCES credit_accounts (id),
  hold_id         text REFERENCES credit_holds (id),
  type            text NOT NULL CHECK (type IN ('grant', 'reserve', 'settle', 'release', 'expire')),
  amount          bigint NOT NULL CHECK (amount > 0),
  available_after bigint NOT NULL,
  held_after      bigint NOT NULL,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS credit_entries_account_idx ON credit_entries (account_id, id);

CREATE TABLE IF NOT EXISTS credit_idempotency (
  key         text PRIMARY KEY,
  fingerprint text NOT NULL,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;

/** Create the tables if they do not exist. Prefer running `migrations/001_init.sql` with your own tooling. */
export async function ensureSchema(pool: PgPoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
  } finally {
    client.release();
  }
}

/**
 * Stores the ledger in PostgreSQL. Each operation runs in one transaction and locks the
 * account row (`SELECT ... FOR UPDATE`), so concurrent operations on one account run one
 * after the other while different accounts do not block each other.
 */
export class PostgresStore implements LedgerStore {
  constructor(private readonly pool: PgPoolLike) {}

  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // the connection is unusable: have the pool discard it
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

function int(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new LedgerError('INVALID_ARGUMENT', 'A stored value is outside the safe integer range');
  }
  return n;
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string | Date).toISOString();
}

function toHold(row: any): Hold {
  return {
    id: row.id,
    accountId: row.account_id,
    amount: int(row.amount),
    status: row.status,
    settledAmount: row.settled_amount === null ? null : int(row.settled_amount),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at) as string,
    closedAt: iso(row.closed_at),
  };
}

function toEntry(row: any): Entry {
  return {
    id: int(row.id),
    accountId: row.account_id,
    holdId: row.hold_id,
    type: row.type,
    amount: int(row.amount),
    availableAfter: int(row.available_after),
    heldAfter: int(row.held_after),
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at) as string,
  };
}

const HOLD_COLUMNS =
  'id, account_id, amount, status, settled_amount, expires_at, created_at, closed_at';

class PgTx implements LedgerTx {
  constructor(private readonly client: PgClientLike) {}

  async claimIdempotency(key: string, fingerprint: string): Promise<boolean> {
    // A concurrent transaction holding the same key makes this wait until it commits or rolls back.
    const res = await this.client.query(
      'INSERT INTO credit_idempotency (key, fingerprint) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, fingerprint],
    );
    return res.rowCount === 1;
  }

  async findIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.client.query(
      'SELECT key, fingerprint, result FROM credit_idempotency WHERE key = $1',
      [key],
    );
    const row = rows[0];
    return row ? { key: row.key, fingerprint: row.fingerprint, result: row.result ?? null } : null;
  }

  async completeIdempotency(key: string, result: unknown): Promise<void> {
    await this.client.query('UPDATE credit_idempotency SET result = $2::jsonb WHERE key = $1', [
      key,
      JSON.stringify(result),
    ]);
  }

  getAccount(id: string): Promise<AccountRow | null> {
    return this.readAccount(id, '');
  }

  lockAccount(id: string): Promise<AccountRow | null> {
    return this.readAccount(id, ' FOR UPDATE');
  }

  private async readAccount(id: string, suffix: string): Promise<AccountRow | null> {
    const { rows } = await this.client.query(
      `SELECT id, available, held FROM credit_accounts WHERE id = $1${suffix}`,
      [id],
    );
    const row = rows[0];
    return row ? { id: row.id, available: int(row.available), held: int(row.held) } : null;
  }

  async ensureAccount(id: string): Promise<void> {
    await this.client.query('INSERT INTO credit_accounts (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id]);
  }

  async setBalance(id: string, available: number, held: number): Promise<void> {
    await this.client.query('UPDATE credit_accounts SET available = $2, held = $3 WHERE id = $1', [
      id,
      available,
      held,
    ]);
  }

  async getHold(id: string): Promise<Hold | null> {
    const { rows } = await this.client.query(`SELECT ${HOLD_COLUMNS} FROM credit_holds WHERE id = $1`, [id]);
    return rows[0] ? toHold(rows[0]) : null;
  }

  async insertHold(hold: Hold): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO credit_holds (${HOLD_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
        [
          hold.id,
          hold.accountId,
          hold.amount,
          hold.status,
          hold.settledAmount,
          hold.expiresAt,
          hold.createdAt,
          hold.closedAt,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new LedgerError('HOLD_ALREADY_EXISTS', `Hold "${hold.id}" already exists`);
      }
      throw error;
    }
  }

  async closeHold(
    id: string,
    patch: { status: Hold['status']; settledAmount: number | null; closedAt: string },
  ): Promise<void> {
    await this.client.query(
      'UPDATE credit_holds SET status = $2, settled_amount = $3, closed_at = $4::timestamptz WHERE id = $1',
      [id, patch.status, patch.settledAmount, patch.closedAt],
    );
  }

  async listExpiredHolds(nowIso: string, limit: number): Promise<Hold[]> {
    const { rows } = await this.client.query(
      `SELECT ${HOLD_COLUMNS} FROM credit_holds
       WHERE status = 'held' AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       ORDER BY expires_at LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(toHold);
  }

  async insertEntry(entry: NewEntry): Promise<void> {
    await this.client.query(
      `INSERT INTO credit_entries
         (account_id, hold_id, type, amount, available_after, held_after, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [
        entry.accountId,
        entry.holdId,
        entry.type,
        entry.amount,
        entry.availableAfter,
        entry.heldAfter,
        entry.idempotencyKey,
        entry.createdAt,
      ],
    );
  }

  async listEntries(accountId: string, options: ListEntriesOptions): Promise<Entry[]> {
    const values: unknown[] = [accountId];
    let where = 'account_id = $1';
    if (options.beforeId !== undefined) {
      values.push(options.beforeId);
      where += ` AND id < $${values.length}`;
    }
    if (options.afterId !== undefined) {
      values.push(options.afterId);
      where += ` AND id > $${values.length}`;
    }
    values.push(options.limit);
    const order = options.order === 'asc' ? 'ASC' : 'DESC';
    const { rows } = await this.client.query(
      `SELECT id, account_id, hold_id, type, amount, available_after, held_after, idempotency_key, created_at
       FROM credit_entries WHERE ${where} ORDER BY id ${order} LIMIT $${values.length}`,
      values,
    );
    return rows.map(toEntry);
  }
}
