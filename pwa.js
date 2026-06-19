/* Quantra AI — PWA glue: service-worker registration, install prompt, web-push */
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    document.dispatchEvent(new CustomEvent('quantra:installable'));
  });
  window.addEventListener('appinstalled', () => { deferred = null; });

  function promptInstall() {
    if (!deferred) return false;
    deferred.prompt();
    deferred.userChoice.finally(() => { deferred = null; });
    return true;
  }

  function urlB64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    try { const t = localStorage.getItem('quantra.sid'); if (t) h.Authorization = 'Bearer ' + t; } catch {}
    return h;
  }
  async function pushConfig() { try { return await (await fetch('/api/push/config')).json(); } catch { return { enabled: false }; } }
  async function pushState() {
    if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try { const reg = await navigator.serviceWorker.ready; return (await reg.pushManager.getSubscription()) ? 'on' : 'off'; } catch { return 'off'; }
  }
  async function enablePush() {
    const cfg = await pushConfig();
    if (!cfg.enabled || !cfg.publicKey) return { ok: false, reason: 'disabled' };
    if (!('PushManager' in window) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'denied' };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(cfg.publicKey) });
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify({ subscription: sub }) });
    return { ok: r.ok, reason: r.ok ? null : 'signin' };
  }
  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { const ep = sub.endpoint; await sub.unsubscribe().catch(() => {}); await fetch('/api/push/unsubscribe', { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify({ endpoint: ep }) }).catch(() => {}); }
    } catch {}
    return { ok: true };
  }

  window.QuantraPWA = { promptInstall, hasInstall: () => !!deferred, enablePush, disablePush, pushState, pushConfig };
})();
