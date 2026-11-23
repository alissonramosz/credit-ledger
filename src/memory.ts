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

interface State {
  accounts: Map<string, AccountRow>;
  holds: Map<string, Hold>;
  entries: Entry[];
  idempotency: Map<string, IdempotencyRecord>;
  nextEntryId: number;
}

function emptyState(): State {
  return { accounts: new Map(), holds: new Map(), entries: [], idempotency: new Map(), nextEntryId: 1 };
}

class MemoryTx implements LedgerTx {
  constructor(private readonly state: State) {}

  async claimIdempotency(key: string, fingerprint: string): Promise<boolean> {
    if (this.state.idempotency.has(key)) return false;
    this.state.idempotency.set(key, { key, fingerprint, result: null });
    return true;
  }

  async findIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const record = this.state.idempotency.get(key);
    return record ? structuredClone(record) : null;
  }

  async completeIdempotency(key: string, result: unknown): Promise<void> {
    const record = this.state.idempotency.get(key);
    if (record) record.result = structuredClone(result);
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    const account = this.state.accounts.get(id);
    return account ? { ...account } : null;
  }

  lockAccount(id: string): Promise<AccountRow | null> {
    // Transactions already run one at a time, so reading is as good as locking.
    return this.getAccount(id);
  }

  async ensureAccount(id: string): Promise<void> {
    if (!this.state.accounts.has(id)) this.state.accounts.set(id, { id, available: 0, held: 0 });
  }

  async setBalance(id: string, available: number, held: number): Promise<void> {
    const account = this.state.accounts.get(id);
    if (account) {
      account.available = available;
      account.held = held;
    }
  }

  async getHold(id: string): Promise<Hold | null> {
    const hold = this.state.holds.get(id);
    return hold ? { ...hold } : null;
  }

  async insertHold(hold: Hold): Promise<void> {
    if (this.state.holds.has(hold.id)) {
      throw new LedgerError('HOLD_ALREADY_EXISTS', `Hold "${hold.id}" already exists`);
    }
    this.state.holds.set(hold.id, { ...hold });
  }

  async closeHold(
    id: string,
    patch: { status: Hold['status']; settledAmount: number | null; closedAt: string },
  ): Promise<void> {
    const hold = this.state.holds.get(id);
    if (hold) Object.assign(hold, patch);
  }

  async listExpiredHolds(nowIso: string, limit: number): Promise<Hold[]> {
    return [...this.state.holds.values()]
      .filter((h) => h.status === 'held' && h.expiresAt !== null && h.expiresAt <= nowIso)
      .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
      .slice(0, limit)
      .map((h) => ({ ...h }));
  }

  async insertEntry(entry: NewEntry): Promise<void> {
    this.state.entries.push({ ...entry, id: this.state.nextEntryId++ });
  }

  async listEntries(accountId: string, options: ListEntriesOptions): Promise<Entry[]> {
    let rows = this.state.entries.filter(
      (e) =>
        e.accountId === accountId &&
        (options.beforeId === undefined || e.id < options.beforeId) &&
        (options.afterId === undefined || e.id > options.afterId),
    );
    if (options.order === 'desc') rows = [...rows].reverse();
    return rows.slice(0, options.limit).map((e) => ({ ...e }));
  }
}

/**
 * Keeps everything in memory. Meant for tests, demos and single-process scripts:
 * each transaction copies the whole state, so it does not scale and it forgets
 * everything when the process ends.
 */
export class MemoryStore implements LedgerStore {
  private state: State = emptyState();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(new MemoryTx(draft));
      this.state = draft; // commit only when fn did not throw
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
