// Schema migrations. They are applied automatically by the Worker (see db.ts),
// so a fresh deployment needs no manual `wrangler d1 migrations apply` step.
// Rules: never edit a migration that has shipped; add a new one instead.
// Every entry in `statements` must be exactly one SQL statement.

export interface Migration {
  id: string;
  statements: string[];
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    statements: [
      `CREATE TABLE classes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (${NOW})
      )`,

      `CREATE TABLE users (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        login_id             TEXT NOT NULL UNIQUE,
        nickname             TEXT NOT NULL,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
        class_id             INTEGER REFERENCES classes(id) ON DELETE SET NULL,
        balance              INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        must_change_password INTEGER NOT NULL DEFAULT 0,
        is_active            INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (${NOW})
      )`,
      `CREATE INDEX idx_users_role_class ON users(role, class_id)`,

      `CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX idx_sessions_expiry ON sessions(expires_at)`,

      `CREATE TABLE auth_attempts (
        key TEXT NOT NULL,
        at  INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_auth_attempts ON auth_attempts(key, at)`,

      // Append-only ledger. users.balance is a cache maintained by a trigger.
      `CREATE TABLE point_transactions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id         INTEGER NOT NULL REFERENCES users(id),
        amount             INTEGER NOT NULL CHECK (amount <> 0),
        balance_after      INTEGER NOT NULL CHECK (balance_after >= 0),
        type               TEXT NOT NULL CHECK (type IN
          ('award','deduction','award_cancel','redeem','redeem_cancel','correction')),
        reason             TEXT NOT NULL CHECK (length(reason) > 0),
        operator_id        INTEGER NOT NULL REFERENCES users(id),
        ref_transaction_id INTEGER REFERENCES point_transactions(id),
        idempotency_key    TEXT NOT NULL UNIQUE,
        created_at         TEXT NOT NULL DEFAULT (${NOW})
      )`,
      `CREATE INDEX idx_pt_student ON point_transactions(student_id, id)`,
      // A transaction can be cancelled at most once.
      `CREATE UNIQUE INDEX uq_pt_cancel_once ON point_transactions(ref_transaction_id)
         WHERE ref_transaction_id IS NOT NULL`,
      `CREATE TRIGGER trg_pt_apply_balance AFTER INSERT ON point_transactions
       BEGIN
         UPDATE users SET balance = NEW.balance_after WHERE id = NEW.student_id;
       END`,
      `CREATE TRIGGER trg_pt_no_update BEFORE UPDATE ON point_transactions
       BEGIN
         SELECT RAISE(ABORT, 'point_transactions is append-only');
       END`,
      `CREATE TRIGGER trg_pt_no_delete BEFORE DELETE ON point_transactions
       BEGIN
         SELECT RAISE(ABORT, 'point_transactions is append-only');
       END`,

      `CREATE TABLE rewards (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cost        INTEGER NOT NULL CHECK (cost > 0),
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (${NOW})
      )`,

      `CREATE TABLE redemptions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id      INTEGER NOT NULL REFERENCES users(id),
        reward_id       INTEGER NOT NULL REFERENCES rewards(id),
        cost_at_request INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','completed','cancelled')),
        transaction_id  INTEGER NOT NULL REFERENCES point_transactions(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL DEFAULT (${NOW}),
        updated_at      TEXT
      )`,
      `CREATE INDEX idx_redemptions_student ON redemptions(student_id, id)`,
      `CREATE INDEX idx_redemptions_status ON redemptions(status, id)`,

      `CREATE TABLE audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id    INTEGER NOT NULL REFERENCES users(id),
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   INTEGER,
        detail      TEXT,
        created_at  TEXT NOT NULL DEFAULT (${NOW})
      )`,
    ],
  },
];
