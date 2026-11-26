// Minimal in-memory stand-ins for D1 and R2 so the real Worker code can run under Node.
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | null;

export class FakeStmt {
  db: DatabaseSync;
  sql: string;
  params: Param[] = [];
  constructor(db: DatabaseSync, sql: string, params: Param[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...p: Param[]) {
    return new FakeStmt(this.db, this.sql, p);
  }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (st.columns().length > 0) {
      const results = st.all(...this.params) as Record<string, unknown>[];
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const r = st.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() { return this._exec(); }
  async all() { return this._exec(); }
  async first(col?: string) {
    const row = this._exec().results[0] ?? null;
    return row && col ? row[col] : row;
  }
}

export class FakeD1 {
  raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON');
  }
  prepare(sql: string) { return new FakeStmt(this.raw, sql); }
  async batch(stmts: FakeStmt[]) {
    this.raw.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}

export class FakeR2 {
  objects = new Map<string, { body: ArrayBuffer; uploaded: Date }>();
  async put(key: string, body: ArrayBuffer) { this.objects.set(key, { body, uploaded: new Date() }); }
  async list({ prefix = '' }: { prefix?: string; cursor?: string } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, size: v.body.byteLength, uploaded: v.uploaded }));
    return { objects, truncated: false, cursor: undefined };
  }
  async delete(keys: string | string[]) { for (const k of [].concat(keys as never)) this.objects.delete(k); }
}

export function makeEnv() {
  return {
    DB: new FakeD1(),
    BACKUPS: new FakeR2(),
    ASSETS: { fetch: async () => new Response('asset') },
    SETUP_TOKEN: 'setup-token-for-tests',
    BACKUP_RETENTION_DAYS: '30',
    PBKDF2_ITERATIONS: '1000', // fast for tests
  } as never;
}
