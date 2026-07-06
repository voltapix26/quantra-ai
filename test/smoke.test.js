/* Quantra AI — server smoke test (boots the real server on an ephemeral port
   with an isolated file store; no external network needed for the checks).
   Run: node test/smoke.test.js */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5301 + Math.floor(Math.random() * 200);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'quantra-test-'));
let failures = 0;
const ok = (cond, name, detail) => {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, detail != null ? '— ' + String(detail).slice(0, 120) : ''); }
};

(async () => {
  console.log('smoke.test.js (port', PORT + ')');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), QUANTRA_DATA_DIR: DATA, DATABASE_URL: '', RENDER_EXTERNAL_URL: '', RESEND_API_KEY: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => (srvLog += d));

  const B = `http://localhost:${PORT}`;
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await new Promise((r) => setTimeout(r, 300)); } return false; };
  const up = await until(async () => (await fetch(`${B}/healthz`)).ok, 15000);
  ok(up, 'server boots and /healthz responds');
  if (!up) { console.error(srvLog.slice(-800)); srv.kill(); process.exit(1); }

  const j = async (p, opt) => { const r = await fetch(B + p, opt); return { status: r.status, body: await r.json().catch(() => null), text: null }; };
  const t = async (p) => { const r = await fetch(B + p); return { status: r.status, text: await r.text() }; };

  // static pages
  for (const page of ['/', '/terminal.html', '/brief.html', '/track-record.html']) {
    const r = await t(page);
    ok(r.status === 200 && r.text.includes('Quantra'), `serves ${page}`, r.status);
  }
  // security headers on documents
  {
    const r = await fetch(`${B}/terminal.html`);
    ok(!!r.headers.get('content-security-policy'), 'CSP header present');
    ok(r.headers.get('x-frame-options') === 'DENY' || !!r.headers.get('x-frame-options'), 'X-Frame-Options present');
  }
  // API basics (no upstream dependency)
  {
    const c = await j('/api/config');
    ok(c.status === 200 && typeof c.body.cryptoStream === 'boolean', '/api/config shape');
    ok(['finnhub', 'twelvedata', 'polygon', 'rapidapi'].every((k) => k in c.body), 'config reports all feed flags');
  }
  // auth: bad login rejected, admin gated, signup works end-to-end on file store
  {
    const bad = await j('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'no@x.com', password: 'wrongpass123' }) });
    ok(bad.status === 401 || (bad.body && bad.body.error), 'bad login rejected');
    const adm = await j('/api/admin/users');
    ok(adm.status === 401, 'admin endpoints gated (401 unauthenticated)');
    // regression: /api/org/* must be ROUTED (401 = reached auth), not 404 (dispatcher miss)
    for (const ep of ['/api/org/watch', '/api/org/members']) {
      const r = await j(ep);
      ok(r.status === 401, `${ep} routed + gated (401)`, r.status);
    }
    const su = await j('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'smoke@test.local', password: 'S8k#pQ2m!xZr', name: 'Smoke', consent: true }) });
    ok(su.status === 200 && su.body && (su.body.token || su.body.ok), 'signup succeeds on isolated store', JSON.stringify(su.body).slice(0, 80));
    const weak = await j('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'weak@test.local', password: 'password123', name: 'W', consent: true }) });
    ok(weak.status !== 200 || (weak.body && weak.body.error), 'weak password rejected');
  }
  // track record endpoint responds (may be building on fresh store)
  {
    const tr = await j('/api/track-record');
    ok(tr.status === 200 && tr.body && (tr.body.building || tr.body.days != null), '/api/track-record responds');
  }

  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall smoke tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
