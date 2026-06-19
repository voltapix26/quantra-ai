/* ============================================================
   Quantra AI — storage layer (async)
   Selects Postgres when DATABASE_URL is set, else JSON files.
   The same async interface powers both, so the routes never
   change between local dev and cloud.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');

function fileStore() {
  fs.mkdirSync(path.join(DATA, 'users'), { recursive: true });
  const F = (n) => path.join(DATA, n);
  const ld = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const sv = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch {} };
  const users = ld(F('users.json'), {}), orgs = ld(F('orgs.json'), {}), sessions = ld(F('sessions.json'), {}), tokens = ld(F('tokens.json'), {}), snaps = ld(F('snapshots.json'), {});
  const audit = ld(F('audit.json'), []);
  const stats = ld(F('stats.json'), {});
  const ideas = ld(F('ideas.json'), []);
  const leaders = ld(F('leaders.json'), {});
  return {
    kind: 'file',
    async addIdea(idea) { ideas.unshift(idea); if (ideas.length > 1000) ideas.length = 1000; sv(F('ideas.json'), ideas); },
    async listIdeas(limit) { return ideas.slice(0, limit || 100); },
    async getIdea(id) { return ideas.find((i) => i.id === id) || null; },
    async updateIdea(idea) { const i = ideas.findIndex((x) => x.id === idea.id); if (i >= 0) { ideas[i] = idea; sv(F('ideas.json'), ideas); } },
    async deleteIdea(id) { const i = ideas.findIndex((x) => x.id === id); if (i >= 0) { ideas.splice(i, 1); sv(F('ideas.json'), ideas); } },
    async putLeader(uid, rec) { leaders[uid] = rec; sv(F('leaders.json'), leaders); },
    async allLeaders() { return Object.values(leaders); },
    async allUsers() { return Object.values(users); },
    async getStats(date) { return stats[date] || null; },
    async putStats(date, rec) { stats[date] = rec; sv(F('stats.json'), stats); },
    async allStats() { return Object.keys(stats).sort().map((date) => ({ date, ...stats[date] })); },
    async appendAudit(ev) { audit.push(ev); if (audit.length > 5000) audit.splice(0, audit.length - 5000); sv(F('audit.json'), audit); },
    async listAudit(limit, offset) { const n = audit.length, off = offset || 0, lim = limit || 200; return audit.slice(Math.max(0, n - off - lim), n - off).reverse(); },
    async getSnapshot(date) { return snaps[date] || null; },
    async putSnapshot(date, rec) { snaps[date] = rec; sv(F('snapshots.json'), snaps); },
    async allSnapshots() { return Object.keys(snaps).sort().map((date) => { const v = snaps[date]; return (v && !Array.isArray(v) && v.items) ? { date, ...v } : { date, items: v }; }); },
    async ready() {},
    async getUserByEmail(e) { return users[e] || null; },
    async getUserById(id) { return Object.values(users).find((u) => u.id === id) || null; },
    async putUser(u) { users[u.email] = u; sv(F('users.json'), users); },
    async getOrg(id) { return orgs[id] || null; },
    async putOrg(o) { orgs[o.id] = o; sv(F('orgs.json'), orgs); },
    async countMembers(orgId) { return Object.values(users).filter((u) => u.orgId === orgId).length; },
    async findOrgByStripeCustomer(cid) { return Object.values(orgs).find((o) => o.stripeCustomerId === cid) || null; },
    async getSession(t) { return sessions[t] || null; },
    async putSession(t, s) { sessions[t] = s; sv(F('sessions.json'), sessions); },
    async delSession(t) { delete sessions[t]; sv(F('sessions.json'), sessions); },
    async putToken(t, o) { tokens[t] = o; sv(F('tokens.json'), tokens); },
    async getToken(t) { return tokens[t] || null; },
    async delToken(t) { delete tokens[t]; sv(F('tokens.json'), tokens); },
    async getUserData(uid) { return ld(path.join(DATA, 'users', uid + '.json'), { watchlist: [], prefs: {}, screens: [] }); },
    async putUserData(uid, d) { sv(path.join(DATA, 'users', uid + '.json'), d); },
    async deleteUser(email) { delete users[email]; sv(F('users.json'), users); },
    async deleteUserData(uid) { try { fs.unlinkSync(path.join(DATA, 'users', uid + '.json')); } catch {} },
    async deleteOrg(id) { delete orgs[id]; sv(F('orgs.json'), orgs); },
    async delSessionsForEmail(email) { let ch = false; for (const t of Object.keys(sessions)) { if (sessions[t] && sessions[t].email === email) { delete sessions[t]; ch = true; } } if (ch) sv(F('sessions.json'), sessions); },
  };
}

function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  // CRITICAL: managed Postgres drops idle connections; without this handler the
  // pool's 'error' event is unhandled and Node crashes the whole process
  // (Render then restarts it → crash loop / intermittent 502s). Swallow + log.
  pool.on('error', (err) => { console.error('[pg] idle client error (recovered):', err.message); });
  const q = (t, p) => pool.query(t, p);
  const one = (r) => (r.rows[0] ? r.rows[0].data : null);
  return {
    kind: 'postgres',
    async addIdea(idea) { await q('insert into ideas(id,data) values($1,$2) on conflict(id) do update set data=$2', [idea.id, idea]); },
    async listIdeas(limit) { const r = await q("select data from ideas order by (data->>'ts')::bigint desc limit $1", [limit || 100]); return r.rows.map((x) => x.data); },
    async getIdea(id) { return one(await q('select data from ideas where id=$1', [id])); },
    async updateIdea(idea) { await q('update ideas set data=$2 where id=$1', [idea.id, idea]); },
    async deleteIdea(id) { await q('delete from ideas where id=$1', [id]); },
    async putLeader(uid, rec) { await q('insert into leaderboard(uid,data) values($1,$2) on conflict(uid) do update set data=$2', [uid, rec]); },
    async allLeaders() { const r = await q('select data from leaderboard'); return r.rows.map((x) => x.data); },
    async allUsers() { const r = await q('select data from users'); return r.rows.map((x) => x.data); },
    async getStats(date) { return one(await q('select data from stats where date=$1', [date])); },
    async putStats(date, rec) { await q('insert into stats(date,data) values($1,$2) on conflict(date) do update set data=$2', [date, rec]); },
    async allStats() { const r = await q('select date, data from stats order by date'); return r.rows.map((x) => ({ date: x.date, ...x.data })); },
    async appendAudit(ev) { await q('insert into audit(data) values($1)', [ev]); },
    async listAudit(limit, offset) { const r = await q('select data from audit order by id desc limit $1 offset $2', [limit || 200, offset || 0]); return r.rows.map((x) => x.data); },
    async getSnapshot(date) { return one(await q('select data from snapshots where date=$1', [date])); },
    async putSnapshot(date, rec) { await q('insert into snapshots(date,data) values($1,$2) on conflict(date) do update set data=$2', [date, rec]); },
    async allSnapshots() { const r = await q('select date, data from snapshots order by date'); return r.rows.map((x) => { const v = x.data; return (v && !Array.isArray(v) && v.items) ? { date: x.date, ...v } : { date: x.date, items: v }; }); },
    async ready() {
      await q('CREATE TABLE IF NOT EXISTS orgs(id text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS snapshots(date text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS users(email text primary key, id text, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS sessions(token text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS tokens(token text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS userdata(uid text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS audit(id bigserial primary key, data jsonb, at timestamptz default now())');
      await q('CREATE TABLE IF NOT EXISTS stats(date text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS ideas(id text primary key, data jsonb)');
      await q('CREATE TABLE IF NOT EXISTS leaderboard(uid text primary key, data jsonb)');
      await q('CREATE INDEX IF NOT EXISTS users_id_idx ON users(id)');
    },
    async getUserByEmail(e) { return one(await q('select data from users where email=$1', [e])); },
    async getUserById(id) { return one(await q('select data from users where id=$1', [id])); },
    async putUser(u) { await q('insert into users(email,id,data) values($1,$2,$3) on conflict(email) do update set data=$3, id=$2', [u.email, u.id, u]); },
    async getOrg(id) { return one(await q('select data from orgs where id=$1', [id])); },
    async putOrg(o) { await q('insert into orgs(id,data) values($1,$2) on conflict(id) do update set data=$2', [o.id, o]); },
    async countMembers(orgId) { const r = await q("select count(*)::int n from users where data->>'orgId'=$1", [orgId]); return r.rows[0].n; },
    async findOrgByStripeCustomer(cid) { return one(await q("select data from orgs where data->>'stripeCustomerId'=$1", [cid])); },
    async getSession(t) { return one(await q('select data from sessions where token=$1', [t])); },
    async putSession(t, s) { await q('insert into sessions(token,data) values($1,$2) on conflict(token) do update set data=$2', [t, s]); },
    async delSession(t) { await q('delete from sessions where token=$1', [t]); },
    async putToken(t, o) { await q('insert into tokens(token,data) values($1,$2) on conflict(token) do update set data=$2', [t, o]); },
    async getToken(t) { return one(await q('select data from tokens where token=$1', [t])); },
    async delToken(t) { await q('delete from tokens where token=$1', [t]); },
    async getUserData(uid) { return one(await q('select data from userdata where uid=$1', [uid])) || { watchlist: [], prefs: {}, screens: [] }; },
    async putUserData(uid, d) { await q('insert into userdata(uid,data) values($1,$2) on conflict(uid) do update set data=$2', [uid, d]); },
    async deleteUser(email) { await q('delete from users where email=$1', [email]); },
    async deleteUserData(uid) { await q('delete from userdata where uid=$1', [uid]); },
    async deleteOrg(id) { await q('delete from orgs where id=$1', [id]); },
    async delSessionsForEmail(email) { await q("delete from sessions where data->>'email'=$1", [email]); },
  };
}

module.exports = process.env.DATABASE_URL ? pgStore() : fileStore();
