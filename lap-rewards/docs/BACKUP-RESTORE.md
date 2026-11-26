# Backup and restore

## What is backed up

Once a day (and whenever an administrator presses **Back up now** in *Admin → Backups*) the Worker writes one gzip-compressed JSON file to the private R2 bucket under `backups/`, for example `backups/lap-20261125T180000Z.json.gz`.

It contains: classes, users (including password hashes), rewards, the full point ledger, redemptions and the activity log. Sessions and rate-limit counters are not included. D1 stays the source of truth; R2 only holds copies.

The bucket has no public URL. Do not enable an `r2.dev` or custom public domain for it.

Old backups are removed after `BACKUP_RETENTION_DAYS` days. The newest backup is never removed.

## Restore into a fresh database

Use this after losing the database or moving to a new Cloudflare account.

1. **Deploy** the project (see README). The Worker creates an empty database.
2. **Open the app once** (any page). The Worker applies the schema automatically. Do not create the first administrator: the backup already contains your accounts.
3. **Download** the backup file you want from the R2 bucket (Cloudflare dashboard → R2 → the bucket → `backups/` → download).
4. **Convert** it to SQL:
   ```bash
   node scripts/backup-to-sql.mjs lap-20261125T180000Z.json.gz > restore.sql
   ```
5. **Find the database name** and load the SQL:
   ```bash
   npx wrangler d1 list
   npx wrangler d1 execute <DATABASE_NAME> --remote --file restore.sql
   ```
6. **Check**: sign in with an existing account and compare a few balances with the Activity log.

The target database must be empty (apart from the schema). The ledger cannot be deleted by design, so to restore over a database that already has data, restore into a new database instead.

## Rolling back a mistake in a live database

Cloudflare D1 has its own point-in-time recovery feature (Time Travel). Check the current Cloudflare documentation for how far back it reaches on your plan and how to run it.

## Testing the restore

The automated test `test/backup.test.ts` creates data, takes a backup, restores it into a new empty database with `scripts/backup-to-sql.mjs`, and checks that every table is identical and that restored accounts can sign in. That test runs against SQLite locally; do a real restore drill on your own Cloudflare account before relying on it, and repeat it after major changes.
