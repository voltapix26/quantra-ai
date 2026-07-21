# Backup and restore

Quantra takes a full encrypted backup of production every **Sunday 04:00 UTC** via
GitHub Actions (`.github/workflows/backup.yml`), and you can trigger one on demand
from the Actions tab → *Weekly backup* → *Run workflow*.

## One-time setup

Three values, set once. **Nothing below should ever be committed to this repo.**

### 1. On Render → Environment

| Key | Value |
| --- | --- |
| `BACKUP_TOKEN` | a long random string, e.g. `openssl rand -hex 32` |

Until this is set the export endpoint returns **404** — the feature is off, and it
does not even advertise that it exists.

### 2. On GitHub → Settings → Secrets and variables → Actions

| Secret | Value |
| --- | --- |
| `BACKUP_TOKEN` | **exactly** the same string you put on Render |
| `BACKUP_PASSPHRASE` | a second random string used to encrypt the dump |
| `BACKUP_URL` | *(optional)* defaults to `https://quantra-ai.onrender.com` |

### 3. Store `BACKUP_PASSPHRASE` somewhere outside GitHub

A password manager, not this repo and not a file next to the backups. **If you lose
the passphrase the backups are unrecoverable** — that is the point of encrypting them,
and there is no reset.

## Why the dump is encrypted

This repository is **public**. Artifacts attached to workflow runs on public repos can
be downloaded by anyone who has the run URL. The dump contains member email addresses,
scrypt password hashes and org API keys, so it is encrypted with AES-256-CBC (PBKDF2,
200k iterations) **on the runner, before upload**. The plaintext is shredded in the same
step and never reaches the artifact store or the logs.

Live credentials — session tokens and password-reset tokens — are deliberately **not**
exported. They are short-lived, worthless to restore, and pure risk sitting at rest.
Everyone is signed out after a restore; nobody has to change their password.

## What is in a backup

`users`, `userData` (watchlists, prefs, portfolios, paper trades, saved screens),
`orgs`, `snapshots` (the hash-chained track record), `stats`, `ideas`, `leaders`,
and the last 5,000 `audit` events.

## Restoring

Download the artifact from the workflow run, unzip it, then:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in quantra-backup-YYYY-MM-DD.json.enc -out backup.json

# dry run first — prints what it found and writes nothing
node scripts/restore-backup.js backup.json

# then, pointed at the target database
DATABASE_URL='postgres://…' node scripts/restore-backup.js backup.json --confirm
```

The restore is an **upsert, never a wipe**: records with the same key are overwritten,
anything not in the backup is left untouched. That makes it safe to replay onto a
half-populated database, and safe to run twice.

Without `DATABASE_URL` it restores into the file store at `QUANTRA_DATA_DIR`.

## Verifying a backup is good

Do this once now, not during an outage:

```bash
# restore into a scratch file store and log in with a known password
QUANTRA_DATA_DIR=/tmp/verify node scripts/restore-backup.js backup.json --confirm
QUANTRA_DATA_DIR=/tmp/verify PORT=8799 node server.js
curl -X POST localhost:8799/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'
curl localhost:8799/api/track-record/ledger    # "valid": true
```

A passing restore means: original passwords still work, watchlists and prefs are
intact, and the tamper-evident ledger still verifies.

## Known limits — read these

- **Artifact retention is 90 days.** Backups older than that are deleted by GitHub.
  For anything longer, download one periodically and keep it yourself.
- **GitHub disables scheduled workflows after 60 days of repository inactivity.** If
  you stop pushing, the backups stop silently. Check the Actions tab occasionally, or
  push anything to reset the clock.
- **This is not point-in-time recovery.** Worst case you lose up to a week of member
  data. If that becomes unacceptable, move to a Postgres plan with PITR rather than
  making this run more often.
- The backup is only as available as GitHub. It protects against the database being
  deleted — the failure that already happened once — not against everything.
