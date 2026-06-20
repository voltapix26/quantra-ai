/* ============================================================
   Quantra AI — mailer
   Sends via Resend (HTTP, no dependency) when RESEND_API_KEY is
   set; otherwise logs the link to the console for local dev.
   ============================================================ */
'use strict';
const APP_URL = process.env.APP_URL || ('http://localhost:' + (process.env.PORT || 5280));
const FROM = process.env.MAIL_FROM || 'Quantra AI <onboarding@resend.dev>';

// Reports how email delivery is configured (for the admin panel / diagnostics).
function mailConfig() {
  return {
    configured: !!process.env.RESEND_API_KEY,
    from: FROM,
    // Resend's onboarding@resend.dev sandbox sender ONLY delivers to your own Resend
    // signup address — real recipients are silently rejected until you verify a domain.
    sandbox: /resend\.dev/i.test(FROM),
  };
}

// Returns { ok, status?, id?, error?, dev? } so callers/diagnostics can see why a send failed.
async function sendMail(to, subject, html, text) {
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to, subject, html, text }),
      });
      const raw = await r.text().catch(() => '');
      if (!r.ok) { console.warn('[mail] Resend error:', r.status, raw); return { ok: false, status: r.status, error: raw || ('HTTP ' + r.status) }; }
      let id = null; try { id = JSON.parse(raw).id; } catch {}
      return { ok: true, status: r.status, id };
    } catch (e) { console.warn('[mail] error:', e.message); return { ok: false, error: e.message }; }
  }
  console.log(`\n[mail:dev] To: ${to}\n  Subject: ${subject}\n  ${text}\n`);
  return { ok: false, dev: true, error: 'RESEND_API_KEY is not set — email was logged to the server console (dev mode), not sent.' };
}

function shell(title, body) {
  return `<div style="font-family:Arial,sans-serif;background:#0A0F1C;padding:32px;border-radius:14px;color:#E7ECF5;max-width:520px">
    <div style="font-size:20px;font-weight:700;margin-bottom:16px">Quantra<span style="color:#34D399">AI</span></div>
    <h2 style="font-size:18px;margin:0 0 12px">${title}</h2>${body}
    <p style="color:#8A94A6;font-size:12px;margin-top:24px">Quantra AI · market analysis — not investment advice.</p></div>`;
}
const btn = (url, label) => `<a href="${url}" style="display:inline-block;background:#34D399;color:#051018;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px;margin:6px 0">${label}</a>`;

module.exports = { sendMail, mailConfig, shell, btn, APP_URL };
