import { MIGRATIONS } from './migrations.ts';

const ready = new WeakMap<object, Promise<void>>();

/** Applies pending migrations once per isolate (cheap no-op afterwards). */
export function ensureSchema(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch((e) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}

async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _migrations (
         id         TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       )`,
    )
    .run();
  const { results } = await db.prepare('SELECT id FROM _migrations').all<{ id: string }>();
  const done = new Set(results.map((r) => r.id));

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    try {
      // One batch = one transaction: a migration is applied fully or not at all.
      await db.batch([
        ...m.statements.map((s) => db.prepare(s)),
        db.prepare('INSERT INTO _migrations (id) VALUES (?1)').bind(m.id),
      ]);
    } catch (e) {
      // Another isolate may have applied it concurrently.
      const row = await db.prepare('SELECT 1 AS x FROM _migrations WHERE id = ?1').bind(m.id).first();
      if (!row) throw e;
    }
  }
}
