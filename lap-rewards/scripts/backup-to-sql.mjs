#!/usr/bin/env node
// Converts a LAP Rewards backup (.json.gz downloaded from R2) into a SQL file that can be loaded
// into a freshly deployed database:
//
//   node scripts/backup-to-sql.mjs lap-20261125T180000Z.json.gz > restore.sql
//   npx wrangler d1 execute <DATABASE_NAME> --remote --file restore.sql
//
// The target database must already have the schema (open the app once so the Worker applies it)
// and must be empty.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const literal = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Unsupported number: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`Unsupported value type: ${typeof v}`);
};

const ident = (s) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier: ${s}`);
  return s;
};

export function backupToSql(backup) {
  if (backup.format !== 'lap-rewards-backup' || backup.version !== 1) {
    throw new Error('Not a LAP Rewards backup (format/version mismatch).');
  }
  const lines = [`-- LAP Rewards restore generated from a backup created at ${backup.created_at}`];
  // Table order in the file is parents-before-children (see BACKUP_TABLES in src/backup.ts).
  for (const [table, rows] of Object.entries(backup.tables)) {
    for (const row of rows) {
      const cols = Object.keys(row).map(ident);
      lines.push(
        `INSERT INTO ${ident(table)} (${cols.join(', ')}) VALUES (${cols.map((c) => literal(row[c])).join(', ')});`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/backup-to-sql.mjs <backup.json.gz> > restore.sql');
    process.exit(1);
  }
  const raw = readFileSync(file);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  process.stdout.write(backupToSql(JSON.parse(text)));
}
