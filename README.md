# LAP Rewards

A point-based reward system for schools. Students earn points for passing quizzes and tests, and exchange them for rewards such as cafeteria tickets.

Runs entirely on Cloudflare: **Workers** (API and app), **D1** (database), **R2** (backups). The frontend is an installable **PWA**.

## Deploy (fully automatic after the first setup)

1. Push this repository to GitHub.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository** and select it.
   - Worker name: `lap-rewards` (it must match `name` in `wrangler.jsonc`).
   - Build command: leave empty (there is nothing to build).
   - Deploy command: `npx wrangler deploy`.
3. The first build creates the D1 database and the R2 bucket by itself. `wrangler.jsonc` lists the bindings without IDs, which makes Wrangler provision them on deploy (needs Wrangler 4.45.0 or newer; `package.json` already asks for it). No manual `wrangler d1 create` / `r2 bucket create` is needed.
4. Open the Worker, go to **Settings → Variables and Secrets** and add a **Secret** named `SETUP_TOKEN` (any long random string). Then open the site, and use "Set up the first administrator" with that token. After the first administrator exists the token is no longer used and can be deleted.

From then on, **every push to the connected branch builds and deploys automatically.**

### Database schema updates are automatic too

The schema lives in `src/migrations.ts`. The Worker applies any pending migration the first time it handles a request after a deploy (and in the daily cron run), inside a single transaction. To change the schema, **add a new entry** to `MIGRATIONS`; never edit one that has already shipped.

### Settings (`wrangler.jsonc` → `vars`)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_RETENTION_DAYS` | `30` | Backups older than this are deleted (the newest is always kept). |
| `PBKDF2_ITERATIONS` | `100000` | Password hashing cost. 100,000 is the maximum Workers allow. Already-stored hashes keep the cost they were created with. |

The backup schedule is `triggers.crons` (default `0 18 * * *` = 18:00 UTC = 03:00 JST).

## Languages

The interface is available in **English and Japanese**. It follows the browser language on first visit, and users can switch at any time (language selector on the sign-in screen and on the Account page); the choice is remembered in the browser.

Translations live in `public/i18n.js`. The English text is the key, so adding a language or a string is one dictionary entry. `npm test` fails if any string in the code (or any static server message) has no Japanese translation.

## Roles

- **Student**: self-registers, sees balance and history, redeems rewards, changes password.
- **Teacher**: searches students (by name or login ID, or by class), awards points to one or many students, cancels awards they made, creates and edits classes, assigns students to classes.
- **Administrator**: everything a teacher can do, plus accounts (create, reset password, deactivate, change role), manual point adjustments, rewards, redemptions, activity log, backups. An administrator can also cancel any award.

All permissions are enforced on the server.

## Local development

```bash
npm install
npm run dev        # http://localhost:8787 (local D1/R2 are created automatically)
npm test           # needs Node 22.18 or newer
npm run typecheck
```

For local sign-in create `.dev.vars` with `SETUP_TOKEN=any-local-secret` (this file is git-ignored).

## Backups and restore

See [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md).

## Security notes

- Passwords: PBKDF2-SHA256 with a random salt; never stored or logged in plaintext.
- Sessions: random token in an `HttpOnly; Secure; SameSite=Strict` cookie; only its SHA-256 hash is stored. Changing a password signs out every device.
- Every point change is a row in an append-only ledger (database triggers reject UPDATE and DELETE). Cancellations are new rows that reference the original; an original can be cancelled once.
- Submissions carry a one-time key, so double clicks and retries cannot award or redeem twice.
- All queries use bound parameters. State-changing requests must come from the same origin.
- Login, registration, password change and other sensitive endpoints are rate limited.
- No secrets are stored in the repository. `SETUP_TOKEN` is a Worker secret.

## Status

Implemented: accounts, roles, classes, points (single, bulk, cancel, adjust), rewards and redemptions, administration, activity log, PWA shell, daily backups, English/Japanese interface.
Not yet implemented: Web Push notifications and notification preferences.
