import type { Env } from './types.ts';

// Tables included in a backup (sessions and rate-limit data are deliberately excluded).
// Order matters for restore: parents before children.
export const BACKUP_TABLES = ['classes', 'users', 'rewards', 'point_transactions', 'redemptions', 'audit_logs'] as const;

const PREFIX = 'backups/';

export async function runBackup(env: Env, now = new Date()): Promise<string> {
  // A batch runs as one transaction, so all tables come from the same moment.
  const results = await env.DB.batch(BACKUP_TABLES.map((t) => env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`)));
  const tables: Record<string, unknown[]> = {};
  BACKUP_TABLES.forEach((t, i) => (tables[t] = results[i].results));

  const body = JSON.stringify({ format: 'lap-rewards-backup', version: 1, created_at: now.toISOString(), tables });
  const gz = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = await new Response(gz).arrayBuffer(); // R2 needs a known length
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const key = `${PREFIX}lap-${stamp}.json.gz`;
  await env.BACKUPS.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' } });
  return key;
}

export async function listBackups(env: Env): Promise<{ key: string; size: number; uploaded: string }[]> {
  const out: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix: PREFIX, cursor });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

/** Deletes backups older than BACKUP_RETENTION_DAYS (always keeps the newest one). */
export async function pruneBackups(env: Env, now = new Date()): Promise<number> {
  const days = Number(env.BACKUP_RETENTION_DAYS);
  if (!Number.isFinite(days) || days < 1) return 0;
  const cutoff = now.getTime() - days * 86_400_000;
  const all = await listBackups(env);
  const old = all.slice(1).filter((b) => new Date(b.uploaded).getTime() < cutoff).map((b) => b.key);
  if (old.length) await env.BACKUPS.delete(old);
  return old.length;
}
