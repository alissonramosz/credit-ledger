// Run it with: npm run example
import { Ledger, MemoryStore } from '../dist/index.js';

const ledger = new Ledger({ store: new MemoryStore() });
const show = (label, value) => console.log(`${label.padEnd(30)} ${JSON.stringify(value)}`);

// 1. A customer buys 100 credits. The key makes the top-up safe to retry.
const granted = await ledger.grant('customer-1', 100, { idempotencyKey: 'order-981' });
show('grant 100', granted.balance);

// 2. A job starts. Set an estimate aside before doing any paid work.
await ledger.reserve('customer-1', 40, {
  idempotencyKey: 'job-42:reserve',
  holdId: 'job-42',
  ttlMs: 10 * 60_000,
});
show('reserve 40 for job-42', await ledger.balance('customer-1'));

// 3. The job finishes and used less than the estimate: 25 are consumed, 15 come back.
const settled = await ledger.settle('job-42', { amount: 25, idempotencyKey: 'job-42:settle' });
show('settle 25', settled.balance);

// 4. The same call arrives again (a retry, a duplicated webhook). Nothing changes.
const again = await ledger.settle('job-42', { amount: 25, idempotencyKey: 'job-42:settle' });
show('settle again, same key', { replayed: again.replayed, balance: again.balance });

// 5. A different call on the closed hold is a bug in the caller, and the ledger says so.
try {
  await ledger.release('job-42', { idempotencyKey: 'job-42:release' });
} catch (error) {
  show('release after settle', { code: error.code });
}

// 6. Every change is in the history. `verify` replays it and compares with the balance.
for (const entry of (await ledger.history('customer-1')).reverse()) {
  show(`#${entry.id} ${entry.type} ${entry.amount}`, {
    available: entry.availableAfter,
    held: entry.heldAfter,
  });
}
show('verify', await ledger.verify('customer-1'));
