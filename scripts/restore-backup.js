#!/usr/bin/env node
/* Restore a Quantra backup produced by GET /api/admin/backup.
 *
 *   node scripts/restore-backup.js backup.json              # dry run — reports only
 *   node scripts/restore-backup.js backup.json --confirm    # actually writes
 *
 * Targets whatever store the environment points at: DATABASE_URL for Postgres,
 * otherwise the file store under QUANTRA_DATA_DIR. Restore is an UPSERT, never a
 * wipe — existing rows with the same key are overwritten, anything not in the
 * backup is left alone. That makes it safe to replay onto a half-populated DB.
 *
 * Sessions are not in the backup, so everyone is signed out after a restore.
 * That is intentional: password hashes come back, live credentials do not.
 */
'use strict';
const fs = require('fs');

const [, , file, ...flags] = process.argv;
const CONFIRM = flags.includes('--confirm');

if (!file) {
  console.error('usage: node scripts/restore-backup.js <backup.json> [--confirm]');
  process.exit(2);
}

(async () => {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.error('Could not read backup:', e.message); process.exit(2);
  }
  if (dump.format !== 'quantra-backup/1') {
    console.error(`Unrecognised backup format: ${dump.format || '(none)'} — refusing to restore.`);
    process.exit(2);
  }

  const target = process.env.DATABASE_URL ? 'postgres' : `file store (${process.env.QUANTRA_DATA_DIR || './data'})`;
  console.log(`Backup taken ${dump.takenAt} from the ${dump.backend} backend.`);
  console.log('Contents:', JSON.stringify(dump.counts || {}));
  console.log(`Restore target: ${target}`);

  if (!CONFIRM) {
    console.log('\nDRY RUN — nothing was written. Re-run with --confirm to restore.');
    return;
  }

  const store = require('../store.js');
  await store.ready();

  let n = 0;
  const step = async (label, items, fn) => {
    let ok = 0, bad = 0;
    for (const it of (items || [])) {
      try { await fn(it); ok++; } catch (e) { bad++; if (bad <= 3) console.error(`  ! ${label}: ${e.message}`); }
    }
    n += ok;
    console.log(`  ${label}: ${ok} restored${bad ? `, ${bad} failed` : ''}`);
  };

  console.log('\nRestoring…');
  await step('orgs', dump.orgs, (o) => store.putOrg(o));
  await step('users', dump.users, (u) => store.putUser(u));
  await step('user data', Object.entries(dump.userData || {}), ([uid, d]) => store.putUserData(uid, d));
  // snapshots carry the hash chain — restore the record byte-for-byte minus the
  // date key, or the tamper-evident ledger no longer verifies
  await step('snapshots', dump.snapshots, (s) => { const { date, ...rec } = s; return store.putSnapshot(date, rec); });
  await step('stats', dump.stats, (s) => { const { date, ...rest } = s; return store.putStats(date, rest); });
  await step('ideas', dump.ideas, (i) => store.addIdea(i));
  await step('leaders', dump.leaders, (l) => store.putLeader(l.uid || l.id, l));

  console.log(`\nDone — ${n} records restored. Everyone is signed out (sessions are not backed up).`);
  process.exit(0);
})().catch((e) => { console.error('Restore failed:', e); process.exit(1); });
