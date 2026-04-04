'use strict';

/**
 * Waves Financial — Email Template Engine
 *
 * Handles variable substitution for email templates.
 * Templates are stored in Supabase email_templates table
 * and cached in memory. Variables use {{snake_case}} syntax.
 */

// ── DEFAULT TEMPLATES ─────────────────────────────────────────────────────────

const DEFAULTS = {

  loan_approved: {
    subject: 'Your Waves Financial loan is approved — {{loan_ref}}',
    body_html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f8;margin:0;padding:0;}
.wrap{max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#3B35B0,#5B52D8);padding:32px 40px;text-align:center;}
.header h1{color:#ffffff;margin:0;font-size:24px;font-weight:700;}
.header p{color:rgba(255,255,255,.75);margin:8px 0 0;font-size:14px;}
.body{padding:32px 40px;}
.body p{color:#444;font-size:15px;line-height:1.6;margin:0 0 16px;}
.highlight{background:#f0f0ff;border-left:4px solid #5B52D8;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;}
.highlight .label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px;}
.highlight .value{font-size:22px;font-weight:800;color:#3B35B0;}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;}
.info-item{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:12px 14px;}
.info-item .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#999;margin-bottom:3px;}
.info-item .val{font-size:14px;font-weight:700;color:#333;}
.cta{text-align:center;margin:28px 0;}
.cta a{background:linear-gradient(135deg,#3B35B0,#5B52D8);color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;display:inline-block;}
.footer{background:#f8f8fb;padding:20px 40px;text-align:center;}
.footer p{color:#aaa;font-size:12px;line-height:1.5;margin:0;}
</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>🌊 Waves Financial</h1>
    <p>Loan Approval Confirmation</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Great news — your loan application has been <strong>approved</strong>. Here are your loan details:</p>
    <div class="highlight">
      <div class="label">Loan Amount</div>
      <div class="value">${{loan_amount}}</div>
    </div>
    <div class="info-grid">
      <div class="info-item"><div class="lbl">Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="info-item"><div class="lbl">Funding Method</div><div class="val">{{fund_method}}</div></div>
      <div class="info-item"><div class="lbl">Payment Amount</div><div class="val">${{payment_amount}} × {{payment_count}}</div></div>
      <div class="info-item"><div class="lbl">First Payment</div><div class="val">{{first_payment}}</div></div>
    </div>
    <p>Your funds will be disbursed via your chosen method. Please review your signed loan agreement attached to this email.</p>
    <p>If you have any questions, contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>
  </div>
  <div class="footer">
    <p>{{company_name}} · Licensed Canadian Lender<br>
    APR: {{apr}}% · This email was sent to {{to_email}}<br>
    Questions? {{support_phone}}</p>
  </div>
</div></body></html>`,
  },

  loan_declined: {
    subject: 'Update on your Waves Financial application — {{loan_ref}}',
    body_html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f8;margin:0;padding:0;}
.wrap{max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#2d2d3a,#444466);padding:32px 40px;text-align:center;}
.header h1{color:#ffffff;margin:0;font-size:24px;font-weight:700;}
.header p{color:rgba(255,255,255,.65);margin:8px 0 0;font-size:14px;}
.body{padding:32px 40px;}
.body p{color:#444;font-size:15px;line-height:1.6;margin:0 0 16px;}
.ref{background:#f8f8fb;border:1px solid #eee;border-radius:8px;padding:12px 16px;font-size:13px;color:#888;margin:16px 0;}
.footer{background:#f8f8fb;padding:20px 40px;text-align:center;}
.footer p{color:#aaa;font-size:12px;line-height:1.5;margin:0;}
</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>🌊 Waves Financial</h1>
    <p>Application Update</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Thank you for applying with Waves Financial. After reviewing your application <strong>{{loan_ref}}</strong>, we are unable to approve your request at this time.</p>
    <p>This decision is based on the information provided and does not reflect negatively on you as an individual. You are welcome to reapply in the future if your financial situation changes.</p>
    <div class="ref">Reference number: <strong>{{loan_ref}}</strong></div>
    <p>If you have questions, please contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>
  </div>
  <div class="footer">
    <p>{{company_name}} · Licensed Canadian Lender<br>{{support_phone}}</p>
  </div>
</div></body></html>`,
  },

  nsf_triggered: {
    subject: 'Payment failed on your Waves Financial loan — {{loan_ref}}',
    body_html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f8;margin:0;padding:0;}
.wrap{max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#b03535,#d85252);padding:32px 40px;text-align:center;}
.header h1{color:#ffffff;margin:0;font-size:24px;font-weight:700;}
.header p{color:rgba(255,255,255,.75);margin:8px 0 0;font-size:14px;}
.body{padding:32px 40px;}
.body p{color:#444;font-size:15px;line-height:1.6;margin:0 0 16px;}
.alert{background:#fff5f5;border:1px solid #fcc;border-radius:8px;padding:16px 20px;margin:16px 0;}
.alert .label{font-size:12px;font-weight:700;text-transform:uppercase;color:#c00;margin-bottom:4px;}
.alert .value{font-size:20px;font-weight:800;color:#c00;}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;}
.info-item{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px 14px;}
.info-item .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#999;margin-bottom:2px;}
.info-item .val{font-size:14px;font-weight:700;color:#333;}
.footer{background:#f8f8fb;padding:20px 40px;text-align:center;}
.footer p{color:#aaa;font-size:12px;line-height:1.5;margin:0;}
</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>🌊 Waves Financial</h1>
    <p>Payment Failed Notice</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>We were unable to process your scheduled payment for loan <strong>{{loan_ref}}</strong>. Please ensure sufficient funds are available in your account.</p>
    <div class="alert">
      <div class="label">NSF Fee Applied</div>
      <div class="value">${{nsf_fee}}</div>
    </div>
    <div class="info-grid">
      <div class="info-item"><div class="lbl">Loan Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="info-item"><div class="lbl">Payment Due</div><div class="val">${{payment_amount}}</div></div>
      <div class="info-item"><div class="lbl">Due Date</div><div class="val">{{due_date}}</div></div>
      <div class="info-item"><div class="lbl">NSF Fee</div><div class="val">${{nsf_fee}}</div></div>
    </div>
    <p>A retry will be attempted on your next pay date. Please contact us immediately at <a href="mailto:{{support_email}}">{{support_email}}</a> or <strong>{{support_phone}}</strong> if you need assistance.</p>
  </div>
  <div class="footer">
    <p>{{company_name}} · Licensed Canadian Lender<br>{{support_phone}}</p>
  </div>
</div></body></html>`,
  },

  disbursement_sent: {
    subject: 'Your funds have been sent — {{loan_ref}}',
    body_html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f8;margin:0;padding:0;}
.wrap{max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#0d7c5a,#1DE9C6 150%);padding:32px 40px;text-align:center;}
.header h1{color:#ffffff;margin:0;font-size:24px;font-weight:700;}
.header p{color:rgba(255,255,255,.8);margin:8px 0 0;font-size:14px;}
.body{padding:32px 40px;}
.body p{color:#444;font-size:15px;line-height:1.6;margin:0 0 16px;}
.highlight{background:#f0fff9;border-left:4px solid #1DE9C6;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;}
.highlight .label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px;}
.highlight .value{font-size:22px;font-weight:800;color:#0d7c5a;}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;}
.info-item{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px 14px;}
.info-item .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#999;margin-bottom:2px;}
.info-item .val{font-size:14px;font-weight:700;color:#333;}
.footer{background:#f8f8fb;padding:20px 40px;text-align:center;}
.footer p{color:#aaa;font-size:12px;line-height:1.5;margin:0;}
</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>🌊 Waves Financial</h1>
    <p>Funds Disbursed</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Your funds have been sent! Here's a summary of your disbursement:</p>
    <div class="highlight">
      <div class="label">Amount Sent</div>
      <div class="value">${{loan_amount}}</div>
    </div>
    <div class="info-grid">
      <div class="info-item"><div class="lbl">Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="info-item"><div class="lbl">Method</div><div class="val">{{fund_method}}</div></div>
      <div class="info-item"><div class="lbl">First Payment</div><div class="val">{{first_payment}}</div></div>
      <div class="info-item"><div class="lbl">Payment Amount</div><div class="val">${{payment_amount}}</div></div>
    </div>
    <p>Payments will be collected automatically via Pre-Authorized Debit on your scheduled dates. If you have questions, contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>
  </div>
  <div class="footer">
    <p>{{company_name}} · Licensed Canadian Lender<br>
    APR: {{apr}}% · {{support_phone}}</p>
  </div>
</div></body></html>`,
  },
};

// ── VARIABLE SUBSTITUTION ─────────────────────────────────────────────────────

/**
 * Fill {{variables}} in a template string with values from a data object.
 * Unknown variables are left as-is.
 */
function fillTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined && data[key] !== null ? String(data[key]) : match;
  });
}

/**
 * Render a full email (subject + body) from a template object and data.
 */
function render(template, data) {
  return {
    subject:   fillTemplate(template.subject,   data),
    body_html: fillTemplate(template.body_html, data),
  };
}

module.exports = { DEFAULTS, fillTemplate, render };
