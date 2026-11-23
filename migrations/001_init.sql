-- credit-ledger schema. Safe to run more than once.

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
