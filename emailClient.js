'use strict';

/**
 * Waves Financial — Email Client
 *
 * Routes outbound emails through the configured provider:
 *   resend   → Resend API (transactional)
 *   leadfox  → Leadfox API (future)
 *   manual   → No emails sent, logged as skipped
 *
 * All sends are logged to Supabase email_log table.
 */

const { render, DEFAULTS } = require('./emailTemplates');

// ── PROVIDER DETECTION ────────────────────────────────────────────────────────

function getProvider() {
  return process.env.EMAIL_PROVIDER || 'manual';
}

function getResendKey() {
  return process.env.RESEND_API_KEY || '';
}

function getFromAddress() {
  return process.env.RESEND_FROM || 'noreply@wavesfinancial.ca';
}

function getCompanyDefaults() {
  return {
    company_name:  process.env.COMPANY_NAME  || 'Waves Financial Inc.',
    support_email: process.env.SUPPORT_EMAIL || 'support@wavesfinancial.ca',
    support_phone: process.env.SUPPORT_PHONE || '1-800-XXX-XXXX',
  };
}

// ── RESEND PROVIDER ───────────────────────────────────────────────────────────

async function sendViaResend({ to, subject, html, attachments = [] }) {
  const apiKey = getResendKey();
  if (!apiKey) throw new Error('RESEND_API_KEY not configured in Railway env vars');

  const body = {
    from:    getFromAddress(),
    to:      [to],
    subject,
    html,
  };

  if (attachments.length) {
    body.attachments = attachments; // [{ filename, content (base64) }]
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.name || `Resend error ${resp.status}`);
  return { id: data.id };
}

// ── LEADFOX PROVIDER (stub) ───────────────────────────────────────────────────

async function sendViaLeadfox({ to, subject, html }) {
  // TODO: implement when Leadfox credentials are available
  throw new Error('Leadfox integration not yet configured');
}

// ── MAIN SEND FUNCTION ────────────────────────────────────────────────────────

/**
 * sendEmail(opts) → { ok, provider, messageId?, skipped?, error? }
 *
 * @param {Object} opts
 *   event      — template event key (e.g. 'loan_approved')
 *   to         — recipient email
 *   data       — template variables
 *   template   — { subject, body_html } override (if loaded from DB)
 *   attachments — [{ filename, content }] optional
 *   supabase   — supabase client for logging + template lookup
 *   clientId   — for email_log
 *   loanRef    — for email_log
 */
async function sendEmail({ event, to, data = {}, template = null, attachments = [], supabase = null, clientId = null, loanRef = null }) {
  const provider = getProvider();

  // Merge company defaults into data
  const fullData = { ...getCompanyDefaults(), to_email: to, ...data };

  // Load template: use passed override, otherwise load from DB, fall back to hardcoded default
  let tpl = template;
  if (!tpl && supabase) {
    try {
      const { data: dbTpl } = await supabase
        .from('email_templates')
        .select('subject, body_html, enabled')
        .eq('event', event)
        .single();
      if (dbTpl?.enabled) tpl = { subject: dbTpl.subject, body_html: dbTpl.body_html };
    } catch { /* fall through to default */ }
  }
  if (!tpl) tpl = DEFAULTS[event];
  if (!tpl) throw new Error(`No template found for event: ${event}`);

  const { subject, body_html } = render(tpl, fullData);

  let result = { ok: false, provider, event, to };

  try {
    if (provider === 'manual') {
      result = { ok: true, provider: 'manual', skipped: true, event, to };
      console.log(`[email] MANUAL mode — skipped ${event} to ${to}`);
    } else if (provider === 'resend') {
      const sent = await sendViaResend({ to, subject, html: body_html, attachments });
      result = { ok: true, provider: 'resend', messageId: sent.id, event, to };
      console.log(`[email] Sent ${event} to ${to} via Resend — id: ${sent.id}`);
    } else if (provider === 'leadfox') {
      const sent = await sendViaLeadfox({ to, subject, html: body_html });
      result = { ok: true, provider: 'leadfox', event, to };
    } else {
      throw new Error(`Unknown email provider: ${provider}`);
    }
  } catch (err) {
    result = { ok: false, provider, error: err.message, event, to };
    console.error(`[email] Failed ${event} to ${to}:`, err.message);
  }

  // Log to Supabase
  if (supabase) {
    try {
      await supabase.from('email_log').insert({
        client_id: clientId || null,
        loan_ref:  loanRef  || null,
        event,
        to_email:  to,
        subject,
        provider,
        status:    result.ok ? (result.skipped ? 'skipped' : 'sent') : 'failed',
        error:     result.error || null,
      });
    } catch (logErr) {
      console.warn('[email] Log write failed:', logErr.message);
    }
  }

  return result;
}

module.exports = { sendEmail, getProvider };
