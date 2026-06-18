/* ============================================================
   Quantra AI — mailer
   Sends via Resend (HTTP, no dependency) when RESEND_API_KEY is
   set; otherwise logs the link to the console for local dev.
   ============================================================ */
'use strict';
const APP_URL = process.env.APP_URL || ('http://localhost:' + (process.env.PORT || 5280));
const FROM = process.env.MAIL_FROM || 'Quantra AI <onboarding@resend.dev>';

async function sendMail(to, subject, html, text) {
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to, subject, html, text }),
      });
      if (!r.ok) console.warn('[mail] Resend error:', await r.text().catch(() => r.status));
      return r.ok;
    } catch (e) { console.warn('[mail] error:', e.message); return false; }
  }
  console.log(`\n[mail:dev] To: ${to}\n  Subject: ${subject}\n  ${text}\n`);
  return false;
}

function shell(title, body) {
  return `<div style="font-family:Arial,sans-serif;background:#0A0F1C;padding:32px;border-radius:14px;color:#E7ECF5;max-width:520px">
    <div style="font-size:20px;font-weight:700;margin-bottom:16px">Quantra<span style="color:#34D399">AI</span></div>
    <h2 style="font-size:18px;margin:0 0 12px">${title}</h2>${body}
    <p style="color:#8A94A6;font-size:12px;margin-top:24px">Quantra AI · educational analysis tool — not investment advice.</p></div>`;
}
const btn = (url, label) => `<a href="${url}" style="display:inline-block;background:#34D399;color:#051018;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px;margin:6px 0">${label}</a>`;

module.exports = { sendMail, shell, btn, APP_URL };
