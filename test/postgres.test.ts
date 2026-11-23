import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore, SCHEMA_SQL, ensureSchema } from '../src/postgres.js';
import { describeLedger } from './conformance.js';

// A real PostgreSQL server (started by the `embedded-postgres` package) so the tests exercise
// real transactions, row locks and constraints, with no Docker and no setup.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const dataDir = mkdtempSync(join(tmpdir(), 'credit-ledger-pg-'));
let server: EmbeddedPostgres | undefined;
let pool: pg.Pool;
let opened = 0;
let closed = 0;

beforeAll(async () => {
  const port = await freePort();
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  pool = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    max: 20,
  });
  pool.on('connect', (client) => {
    opened += 1;
    client.on('end', () => {
      closed += 1;
    });
  });
  await ensureSchema(pool);
});

afterAll(async () => {
  await pool?.end();
  // pool.end() resolves when the clients were told to disconnect, not when the sockets are closed:
  // stop the server only after they are, or the last connections get a "terminating connection" error.
  for (let i = 0; i < 200 && closed < opened; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describeLedger('PostgresStore', async () => {
  await pool.query('TRUNCATE credit_idempotency, credit_entries, credit_holds, credit_accounts');
  return { store: new PostgresStore(pool) };
});

describe('PostgresStore specifics', () => {
  it('ships a migration file identical to SCHEMA_SQL', () => {
    const file = readFileSync(fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url)), 'utf8');
    expect(file.trim()).toBe(SCHEMA_SQL.trim());
  });

  it('can create the schema more than once', async () => {
    await ensureSchema(pool);
    await ensureSchema(pool);
  });

  it('lets the database itself refuse negative balances, even if application code is bypassed', async () => {
    await pool.query("INSERT INTO credit_accounts (id, available) VALUES ('direct', 5) ON CONFLICT DO NOTHING");
    await expect(
      pool.query("UPDATE credit_accounts SET available = -1 WHERE id = 'direct'"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps nothing from a transaction that fails half way', async () => {
    const store = new PostgresStore(pool);
    await store
      .transaction(async (tx) => {
        await tx.ensureAccount('half-way');
        throw new Error('boom');
      })
      .catch(() => undefined);
    const { rows } = await pool.query("SELECT 1 FROM credit_accounts WHERE id = 'half-way'");
    expect(rows).toHaveLength(0);
  });
});
