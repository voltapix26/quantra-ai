/* ============================================================
   Quantra AI — accounts, sessions & per-tenant sync (client)
   Watchlist + settings sync to the signed-in account; falls
   back to local-only when signed out or offline.
   ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const onServer = location.protocol === 'http:' || location.protocol === 'https:';
  const WKEY = 'quantra.watch', CKEY = 'quantra.currency', TKEY = 'quantra.sid';
  let user = null, mode = 'login', limits = null;

  // Session token fallback: works even when the browser drops the auth cookie
  // (https-wrapped previews, cross-site iframes, tunnels). Sent as a Bearer header.
  const getToken = () => { try { return localStorage.getItem(TKEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TKEY, t) : localStorage.removeItem(TKEY); } catch {} };

  window.QuantraAuth = { get user() { return user; }, get limits() { return limits; }, get token() { return getToken(); }, pushWatch, pushData };

  async function loadLimits() {
    try { limits = await api('/me/limits', {}); window.dispatchEvent(new CustomEvent('quantra:limits', { detail: limits })); } catch {}
  }

  async function api(p, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    const tok = getToken(); if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch('/api' + p, Object.assign({ credentials: 'same-origin' }, opts, { headers }));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  const getLocalWatch = () => { try { return JSON.parse(localStorage.getItem(WKEY) || '[]'); } catch { return []; } };
  const setLocalWatch = (a) => { try { localStorage.setItem(WKEY, JSON.stringify(a)); } catch {} };
  const wkey = (w) => w.type + ':' + w.id;

  let pushT = null;
  function pushData(patch) { if (!user || !onServer) return; clearTimeout(pushT); pushT = setTimeout(() => { api('/me/data', { method: 'PUT', body: JSON.stringify(patch) }).catch(() => {}); }, 600); }
  function pushWatch(arr) { pushData({ watchlist: arr }); }

  async function syncOnLogin() {
    if (!user || !onServer) return;
    try {
      const d = await api('/me/data', {});
      const local = getLocalWatch(), server = d.watchlist || [], map = new Map();
      [...server, ...local].forEach((w) => { if (w && w.id && w.type) map.set(wkey(w), w); });
      const merged = [...map.values()].slice(0, 200);
      setLocalWatch(merged);
      if (d.prefs && d.prefs.currency) { try { localStorage.setItem(CKEY, d.prefs.currency); } catch {} }
      api('/me/data', { method: 'PUT', body: JSON.stringify({ watchlist: merged }) }).catch(() => {});
      window.dispatchEvent(new CustomEvent('quantra:synced'));
    } catch {}
  }

  /* ---- UI ---- */
  function renderBtn() {
    const b = $('acctBtn'); if (!b) return;
    if (user) { b.textContent = (user.name || user.email).split('@')[0]; b.classList.add('is-auth'); }
    else { b.textContent = 'Sign in'; b.classList.remove('is-auth'); }
  }
  function openModal() {
    if (!onServer) { alert('Accounts need the live server — run: node server.js'); return; }
    $('authModal').hidden = false; setMode('login'); setTimeout(() => $('afEmail').focus(), 30);
  }
  function closeModal() { $('authModal').hidden = true; $('authErr').hidden = true; $('authForm').reset(); }
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.mtab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === m));
    $('nameField').hidden = m !== 'signup'; $('orgField').hidden = m !== 'signup';
    if ($('consentField')) $('consentField').hidden = m !== 'signup';
    $('authSubmit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    $('afPass').setAttribute('autocomplete', m === 'signup' ? 'new-password' : 'current-password');
    $('authErr').hidden = true;
  }
  async function submit(e) {
    e.preventDefault();
    const email = $('afEmail').value.trim(), password = $('afPass').value, name = $('afName').value.trim(), orgName = $('afOrg').value.trim();
    const consent = $('afConsent') ? $('afConsent').checked : true;
    if (mode === 'signup' && !consent) { const ee = $('authErr'); ee.hidden = false; ee.style.color = ''; ee.textContent = 'Please accept the Terms and Privacy Policy.'; return; }
    const btn = $('authSubmit'), old = btn.textContent; btn.disabled = true; btn.textContent = '…';
    try {
      let invite; try { invite = sessionStorage.getItem('quantra.invite') || undefined; } catch {}
      const r = await api(mode === 'signup' ? '/auth/signup' : '/auth/login', { method: 'POST', body: JSON.stringify({ email, password, name, orgName, consent, invite }) });
      if (r.token) setToken(r.token);
      if (mode === 'signup' && invite) { try { sessionStorage.removeItem('quantra.invite'); } catch {} }
      user = r.user; renderBtn(); closeModal(); await syncOnLogin(); await loadLimits();
    } catch (err) { const ee = $('authErr'); ee.hidden = false; ee.style.color = ''; ee.textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = old; }
  }
  function authHeaders(extra) { const h = Object.assign({}, extra); const t = getToken(); if (t) h.Authorization = 'Bearer ' + t; return h; }
  async function exportData() {
    try { const r = await fetch('/api/me/export', { credentials: 'same-origin', headers: authHeaders() }); const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'quantra-data-export.json'; a.click(); } catch {}
  }
  async function deleteAccount() {
    const pw = prompt('This permanently deletes your account, watchlist and workspace. Type your password to confirm:');
    if (!pw) return;
    try {
      const r = await fetch('/api/me/delete', { method: 'POST', credentials: 'same-origin', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ password: pw }) });
      const d = await r.json();
      if (r.ok && d.ok) { setToken(''); user = null; limits = null; renderBtn(); $('acctMenu').hidden = true; if (window.QuantraReport) window.QuantraReport.toast('Account deleted.'); window.dispatchEvent(new CustomEvent('quantra:limits', { detail: null })); }
      else alert((d && d.error) || 'Could not delete account.');
    } catch (e) { alert(e.message); }
  }
  const cap = (s) => (s || '').replace(/^./, (c) => c.toUpperCase());
  function toggleMenu() {
    const m = $('acctMenu');
    if (!m.hidden) { m.hidden = true; return; }
    $('amEmail').textContent = user.email;
    // super-admin: show the admin-panel + notes links (notes is admin-only)
    let adm = $('amAdmin'), nts = $('amNotes');
    if (user.superAdmin) {
      if (!nts) { nts = document.createElement('a'); nts.id = 'amNotes'; nts.href = 'notes.html'; nts.className = 'btn btn--ghost btn--block btn--sm'; nts.textContent = '📝 Notes (admin)'; nts.style.margin = '.2rem 0 .4rem'; m.insertBefore(nts, m.firstChild); }
      if (!adm) { adm = document.createElement('a'); adm.id = 'amAdmin'; adm.href = 'admin.html'; adm.className = 'btn btn--ghost btn--block btn--sm'; adm.textContent = '🛡 Admin panel'; adm.style.margin = '.2rem 0 .4rem'; m.insertBefore(adm, m.firstChild); }
      adm.hidden = false; nts.hidden = false;
    } else { if (adm) adm.hidden = true; if (nts) nts.hidden = true; }
    $('amPlan').textContent = cap(user.plan || 'free');
    $('amVerify').hidden = user.verified !== false;
    $('amBilling').innerHTML = '';
    api('/org', {}).then((o) => {
      $('amOrg').textContent = (o.name || '—') + (o.members > 1 ? ` · ${o.members} members` : '');
      $('amPlan').textContent = cap(o.plan || 'free');
      // M7: workspace owners can invite teammates (shared team watchlist + synced terminal)
      let inv = $('amInvite');
      if (o.role === 'owner') {
        if (!inv) {
          inv = document.createElement('button'); inv.id = 'amInvite'; inv.className = 'btn btn--ghost btn--block btn--sm'; inv.textContent = '👥 Invite teammate'; inv.style.margin = '.2rem 0 .4rem';
          const anchor = $('amExport'); anchor.parentNode.insertBefore(inv, anchor);
          inv.addEventListener('click', async () => {
            const em = prompt('Teammate email (optional — leave blank to just copy an invite link):') || '';
            try {
              const r = await api('/org/invite', { method: 'POST', body: JSON.stringify({ email: em.trim() }) });
              if (r.ok) {
                try { await navigator.clipboard.writeText(r.link); } catch {}
                const note = r.mailed ? 'Invite emailed ✓ (link also copied)' : 'Invite link copied — send it to your teammate';
                if (window.QuantraReport) window.QuantraReport.toast(note); else alert(note + '\n' + r.link);
              } else alert(r.error || 'Could not create invite.');
            } catch (e) { alert(e.message); }
          });
        }
        inv.hidden = false;
      } else if (inv) inv.hidden = true;
      const wrap = $('amBilling');
      if (!o.billingEnabled) {
        if (o.devBilling) {
          wrap.innerHTML = '<div class="acct-menu__note">Dev mode — simulate billing</div>' +
            (o.plan && o.plan !== 'free'
              ? '<button class="btn btn--ghost btn--block btn--sm" data-dev="free">Downgrade to Free</button>'
              : '<button class="btn btn--primary btn--block btn--sm" data-dev="pro">Simulate Pro</button><button class="btn btn--ghost btn--block btn--sm" data-dev="ultimate" style="margin-top:.4rem">Simulate Ultimate</button>');
          wrap.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => devUpgrade(b.dataset.dev)));
        } else { wrap.innerHTML = '<div class="acct-menu__note">Billing not configured</div>'; }
        return;
      }
      if (o.plan && o.plan !== 'free') {
        wrap.innerHTML = '<button class="btn btn--ghost btn--block btn--sm" data-bill="portal">Manage billing</button>';
      } else {
        wrap.innerHTML = '<button class="btn btn--primary btn--block btn--sm" data-bill="pro">Upgrade to Pro</button>' +
          '<button class="btn btn--ghost btn--block btn--sm" data-bill="ultimate" style="margin-top:.4rem">Upgrade to Ultimate</button>';
      }
      wrap.querySelectorAll('[data-bill]').forEach((b) => b.addEventListener('click', () => billing(b.dataset.bill)));
    }).catch(() => {});
    m.hidden = false;
  }
  async function billing(which) {
    try {
      const path = which === 'portal' ? '/billing/portal' : '/billing/checkout';
      const r = await api(path, { method: 'POST', body: JSON.stringify({ plan: which }) });
      if (r.ok && r.url) { location.href = r.url; return; }
      alert(r.reason === 'billing-disabled' ? 'Billing is not configured on this server yet.' : 'Could not start billing.');
    } catch (e) { alert(e.message); }
  }
  async function devUpgrade(plan) {
    try {
      const r = await api('/billing/dev-upgrade', { method: 'POST', body: JSON.stringify({ plan }) });
      if (r.ok) { if (user) user.plan = r.plan; await loadLimits(); $('acctMenu').hidden = true; if (window.QuantraReport) window.QuantraReport.toast('Plan set to ' + r.plan + ' (simulated)'); }
    } catch (e) { alert(e.message); }
  }
  async function resendVerify() { try { await api('/auth/resend-verify', { method: 'POST' }); $('amVerify').textContent = '✓ Verification email sent'; } catch {} }
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch {} setToken(''); user = null; renderBtn(); $('acctMenu').hidden = true; loadLimits(); }

  async function forgot() {
    const email = ($('afEmail').value || prompt('Enter your account email to reset your password:') || '').trim();
    if (!email) return;
    try { await api('/auth/request-reset', { method: 'POST', body: JSON.stringify({ email }) }); } catch {}
    const ee = $('authErr'); ee.hidden = false; ee.style.color = ''; ee.textContent = 'If that email has an account, a reset link is on its way.';
  }
  function wire() {
    $('acctBtn').addEventListener('click', () => (user ? toggleMenu() : openModal()));
    $('authClose').addEventListener('click', closeModal);
    $('authModal').addEventListener('click', (e) => { if (e.target.id === 'authModal') closeModal(); });
    document.querySelectorAll('.mtab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
    $('authForm').addEventListener('submit', submit);
    $('amLogout').addEventListener('click', logout);
    const ex = $('amExport'); if (ex) ex.addEventListener('click', exportData);
    const dl = $('amDelete'); if (dl) dl.addEventListener('click', deleteAccount);
    const fp = $('forgotLink'); if (fp) fp.addEventListener('click', (e) => { e.preventDefault(); forgot(); });
    const rs = $('amResend'); if (rs) rs.addEventListener('click', resendVerify);
    document.addEventListener('click', (e) => { if (!e.target.closest('#acctMenu') && e.target.id !== 'acctBtn') $('acctMenu').hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('acctMenu').hidden = true; } });
    // billing return
    const bp = new URLSearchParams(location.search).get('billing');
    if (bp && window.QuantraReport) { window.QuantraReport.toast(bp === 'success' ? 'Subscription active — welcome!' : 'Checkout cancelled'); history.replaceState(null, '', location.pathname); }
    // M7: workspace invite link — stash the token, then open signup so the new
    // account joins the inviter's workspace instead of creating its own.
    const inv = new URLSearchParams(location.search).get('invite');
    if (inv) {
      try { sessionStorage.setItem('quantra.invite', inv); } catch {}
      history.replaceState(null, '', location.pathname);
      if (!user) { setTimeout(() => { openModal(); setMode('signup'); if (window.QuantraReport) window.QuantraReport.toast('👥 Workspace invite — sign up to join'); }, 800); }
    }
  }

  // HARD GATE: app pages are unusable until signed in (matches the server-side 401
  // gate on all data APIs). Landing/verify/reset/legal pages stay public.
  const GATE_EXEMPT = /(^\/$|index\.html|verify\.html|reset\.html|terms\.html|privacy\.html|refund\.html|track-record\.html)/.test(location.pathname || '/');
  function authGate(show) {
    let g = document.getElementById('authGate');
    if (!show) { if (g) g.remove(); return; }
    if (g || GATE_EXEMPT || !onServer) return;
    g = document.createElement('div');
    g.id = 'authGate';
    g.style.cssText = 'position:fixed;inset:0;z-index:280;background:rgba(4,7,14,.88);backdrop-filter:blur(10px);display:grid;place-items:center;text-align:center;padding:1rem';
    g.innerHTML = '<div style="max-width:400px"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:1.7rem;font-weight:700;background:linear-gradient(100deg,#34D399,#22D3EE,#818CF8);-webkit-background-clip:text;background-clip:text;color:transparent">Quantra AI</div>' +
      '<p style="color:#93A0B8;margin:.7rem 0 1.1rem;line-height:1.55">Quantra needs an account — <b style="color:#E7ECF5">sign in or create one free</b> to use the terminal, live data and analysis.</p>' +
      '<button id="gateBtn" style="background:linear-gradient(100deg,#34D399,#22D3EE);border:0;border-radius:10px;padding:.7em 1.6em;font-weight:700;font-size:1rem;color:#06251c;cursor:pointer">Sign in / Create account</button>' +
      '<p style="color:#5A6680;font-size:.74rem;margin-top:1rem"><a href="index.html" style="color:#5A6680;text-decoration:underline">← back to the homepage</a></p></div>';
    document.body.appendChild(g);
    // the sign-in modal must stack ABOVE the gate (its default z-index is lower)
    const m = document.getElementById('authModal'); if (m) m.style.zIndex = '300';
    g.querySelector('#gateBtn').addEventListener('click', () => { try { openModal(); } catch {} });
  }
  window.addEventListener('quantra:limits', (e) => { if (e.detail && e.detail.loggedIn) authGate(false); });
  if (onServer) { api('/auth/me', {}).then((r) => { user = r.user; if (!user && getToken()) setToken(''); renderBtn(); if (user) { syncOnLogin(); authGate(false); } else authGate(true); }).catch(() => authGate(true)); loadLimits(); }
  if (document.readyState !== 'loading') wire(); else document.addEventListener('DOMContentLoaded', wire);
})();
