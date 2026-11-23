export type HoldStatus = 'held' | 'settled' | 'released' | 'expired';
export type EntryType = 'grant' | 'reserve' | 'settle' | 'release' | 'expire';

/** `available` can be reserved; `held` is reserved by open holds. */
export interface Balance {
  available: number;
  held: number;
}

/** Credits set aside for one job until it is settled, released or expires. */
export interface Hold {
  id: string;
  accountId: string;
  amount: number;
  status: HoldStatus;
  /** Credits actually consumed. `null` until the hold is settled. */
  settledAmount: number | null;
  /** ISO 8601 timestamp, or `null` when the hold never expires. */
  expiresAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** One line of the append-only history. */
export interface Entry {
  id: number;
  accountId: string;
  holdId: string | null;
  type: EntryType;
  amount: number;
  /** Account balances right after this entry. */
  availableAfter: number;
  heldAfter: number;
  idempotencyKey: string;
  createdAt: string;
}

export type NewEntry = Omit<Entry, 'id'>;

export interface AccountRow {
  id: string;
  available: number;
  held: number;
}

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  /** `null` while the operation that claimed the key is still running. */
  result: unknown;
}

export interface ListEntriesOptions {
  limit: number;
  beforeId?: number;
  afterId?: number;
  order: 'asc' | 'desc';
}

/**
 * The small set of primitives a store provides inside one transaction.
 * All business rules live in `Ledger`; a store only reads and writes rows.
 */
export interface LedgerTx {
  /** Insert the key. Returns `false` when it already exists (committed by another operation). */
  claimIdempotency(key: string, fingerprint: string): Promise<boolean>;
  findIdempotency(key: string): Promise<IdempotencyRecord | null>;
  completeIdempotency(key: string, result: unknown): Promise<void>;

  getAccount(id: string): Promise<AccountRow | null>;
  /** Read the account and block other writers of the same account until the transaction ends. */
  lockAccount(id: string): Promise<AccountRow | null>;
  ensureAccount(id: string): Promise<void>;
  setBalance(id: string, available: number, held: number): Promise<void>;

  getHold(id: string): Promise<Hold | null>;
  /** Must throw `LedgerError('HOLD_ALREADY_EXISTS')` when the id is taken. */
  insertHold(hold: Hold): Promise<void>;
  closeHold(
    id: string,
    patch: { status: HoldStatus; settledAmount: number | null; closedAt: string },
  ): Promise<void>;
  listExpiredHolds(nowIso: string, limit: number): Promise<Hold[]>;

  insertEntry(entry: NewEntry): Promise<void>;
  listEntries(accountId: string, options: ListEntriesOptions): Promise<Entry[]>;
}

export interface LedgerStore {
  /**
   * Run `fn` atomically: either every change it made is kept, or none is
   * (when `fn` throws). Concurrent transactions on the same account must not interleave.
   */
  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
}
