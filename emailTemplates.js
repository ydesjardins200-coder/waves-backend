'use strict';

/**
 * Waves Financial — Email Template Engine
 * Supports borrower-facing and internal/staff-facing emails.
 * Each template has: audience ('borrower'|'internal'), enabled flag, variables.
 */

// ── AVAILABLE VARIABLES ───────────────────────────────────────────────────────
const VARIABLES = {
  borrower: [
    { key: 'first_name',      desc: 'Borrower first name' },
    { key: 'last_name',       desc: 'Borrower last name' },
    { key: 'to_email',        desc: 'Borrower email address' },
    { key: 'loan_ref',        desc: 'Loan reference number (e.g. WF-ABC123)' },
    { key: 'loan_amount',     desc: 'Approved loan amount in dollars' },
    { key: 'payment_amount',  desc: 'Per-payment amount' },
    { key: 'payment_count',   desc: 'Total number of payments' },
    { key: 'first_payment',   desc: 'First payment due date' },
    { key: 'fund_method',     desc: 'Funding method (Direct Deposit / e-Transfer)' },
    { key: 'apr',             desc: 'Annual percentage rate (e.g. 23)' },
    { key: 'nsf_fee',         desc: 'NSF fee amount' },
    { key: 'due_date',        desc: 'Payment due date' },
  ],
  company: [
    { key: 'company_name',    desc: 'Company name from env' },
    { key: 'support_email',   desc: 'Support email address' },
    { key: 'support_phone',   desc: 'Support phone number' },
  ],
};

// ── DEFAULT TEMPLATES ─────────────────────────────────────────────────────────

const baseStyle = `<style>
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f8;margin:0;padding:0;}
.wrap{max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
.header{padding:28px 40px;text-align:center;}
.header h1{color:#fff;margin:0;font-size:22px;font-weight:700;}
.header p{color:rgba(255,255,255,.75);margin:6px 0 0;font-size:13px;}
.body{padding:28px 40px;}
.body p{color:#444;font-size:15px;line-height:1.6;margin:0 0 14px;}
.highlight{border-left:4px solid;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0;}
.highlight .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:3px;}
.highlight .val{font-size:20px;font-weight:800;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;}
.cell{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px 14px;}
.cell .lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#999;margin-bottom:2px;}
.cell .val{font-size:14px;font-weight:700;color:#333;}
.footer{background:#f8f8fb;padding:18px 40px;text-align:center;}
.footer p{color:#aaa;font-size:12px;line-height:1.5;margin:0;}
</style>`;

const DEFAULTS = {

  // ── BORROWER-FACING ─────────────────────────────────────────────────────────

  loan_approved: {
    label:    'Loan Approved',
    audience: 'borrower',
    enabled:  true,
    subject:  'Your Waves Financial loan is approved — {{loan_ref}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#3B35B0,#5B52D8)">
    <h1>🌊 Waves Financial</h1><p>Loan Approval Confirmation</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Great news — your loan application has been <strong>approved</strong>.</p>
    <div class="highlight" style="background:#f0f0ff;border-color:#5B52D8">
      <div class="lbl">Loan Amount</div><div class="val" style="color:#3B35B0">${{loan_amount}}</div>
    </div>
    <div class="grid">
      <div class="cell"><div class="lbl">Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="cell"><div class="lbl">Funding Method</div><div class="val">{{fund_method}}</div></div>
      <div class="cell"><div class="lbl">Payment Amount</div><div class="val">${{payment_amount}} × {{payment_count}}</div></div>
      <div class="cell"><div class="lbl">First Payment</div><div class="val">{{first_payment}}</div></div>
    </div>
    <p>Questions? Contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>
  </div>
  <div class="footer"><p>{{company_name}} · APR: {{apr}}% · {{support_phone}}</p></div>
</div></body></html>`,
  },

  loan_declined: {
    label:    'Loan Declined',
    audience: 'borrower',
    enabled:  true,
    subject:  'Update on your Waves Financial application — {{loan_ref}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#2d2d3a,#444466)">
    <h1>🌊 Waves Financial</h1><p>Application Update</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Thank you for applying. After reviewing your application <strong>{{loan_ref}}</strong>, we are unable to approve your request at this time.</p>
    <p>You are welcome to reapply in the future if your financial situation changes.</p>
    <p>Questions? Contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>
  </div>
  <div class="footer"><p>{{company_name}} · {{support_phone}}</p></div>
</div></body></html>`,
  },

  nsf_triggered: {
    label:    'NSF Payment Failed',
    audience: 'borrower',
    enabled:  true,
    subject:  'Payment failed on your Waves Financial loan — {{loan_ref}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#b03535,#d85252)">
    <h1>🌊 Waves Financial</h1><p>Payment Failed Notice</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>We were unable to process your scheduled payment for loan <strong>{{loan_ref}}</strong>.</p>
    <div class="highlight" style="background:#fff5f5;border-color:#d85252">
      <div class="lbl">NSF Fee Applied</div><div class="val" style="color:#c00">${{nsf_fee}}</div>
    </div>
    <div class="grid">
      <div class="cell"><div class="lbl">Loan Ref</div><div class="val">{{loan_ref}}</div></div>
      <div class="cell"><div class="lbl">Payment Due</div><div class="val">${{payment_amount}}</div></div>
      <div class="cell"><div class="lbl">Due Date</div><div class="val">{{due_date}}</div></div>
      <div class="cell"><div class="lbl">NSF Fee</div><div class="val">${{nsf_fee}}</div></div>
    </div>
    <p>Please contact us immediately at <a href="mailto:{{support_email}}">{{support_email}}</a> or <strong>{{support_phone}}</strong>.</p>
  </div>
  <div class="footer"><p>{{company_name}} · {{support_phone}}</p></div>
</div></body></html>`,
  },

  disbursement_sent: {
    label:    'Funds Disbursed',
    audience: 'borrower',
    enabled:  true,
    subject:  'Your funds have been sent — {{loan_ref}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#0d7c5a,#1DE9C6 150%)">
    <h1>🌊 Waves Financial</h1><p>Funds Disbursed</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Your funds have been sent!</p>
    <div class="highlight" style="background:#f0fff9;border-color:#1DE9C6">
      <div class="lbl">Amount Sent</div><div class="val" style="color:#0d7c5a">${{loan_amount}}</div>
    </div>
    <div class="grid">
      <div class="cell"><div class="lbl">Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="cell"><div class="lbl">Method</div><div class="val">{{fund_method}}</div></div>
      <div class="cell"><div class="lbl">First Payment</div><div class="val">{{first_payment}}</div></div>
      <div class="cell"><div class="lbl">Payment Amount</div><div class="val">${{payment_amount}}</div></div>
    </div>
    <p>Payments will be collected automatically via Pre-Authorized Debit. Questions? <a href="mailto:{{support_email}}">{{support_email}}</a></p>
  </div>
  <div class="footer"><p>{{company_name}} · APR: {{apr}}% · {{support_phone}}</p></div>
</div></body></html>`,
  },

  payment_reminder: {
    label:    'Payment Reminder',
    audience: 'borrower',
    enabled:  false,
    subject:  'Payment reminder — {{loan_ref}} due {{due_date}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#3B35B0,#5B52D8)">
    <h1>🌊 Waves Financial</h1><p>Upcoming Payment Reminder</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>This is a friendly reminder that your next payment of <strong>${{payment_amount}}</strong> is due on <strong>{{due_date}}</strong>.</p>
    <p>Payments are collected automatically via Pre-Authorized Debit — no action required if funds are available.</p>
    <p>Questions? <a href="mailto:{{support_email}}">{{support_email}}</a> · {{support_phone}}</p>
  </div>
  <div class="footer"><p>{{company_name}} · Loan {{loan_ref}}</p></div>
</div></body></html>`,
  },

  loan_paid_off: {
    label:    'Loan Paid Off',
    audience: 'borrower',
    enabled:  false,
    subject:  'Your Waves Financial loan is fully paid off — {{loan_ref}}',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#0d7c5a,#1DE9C6 150%)">
    <h1>🌊 Waves Financial</h1><p>Congratulations!</p>
  </div>
  <div class="body">
    <p>Hi <strong>{{first_name}}</strong>,</p>
    <p>Your loan <strong>{{loan_ref}}</strong> has been fully paid off. Thank you for being a valued Waves Financial customer.</p>
    <p>You are welcome to apply again any time at <a href="https://wavesfinancial.ca">wavesfinancial.ca</a>.</p>
  </div>
  <div class="footer"><p>{{company_name}} · {{support_phone}}</p></div>
</div></body></html>`,
  },

  // ── INTERNAL / STAFF-FACING ─────────────────────────────────────────────────

  internal_new_application: {
    label:    'New Application Alert',
    audience: 'internal',
    enabled:  false,
    subject:  '[Waves] New application received — {{loan_ref}} ({{first_name}} {{last_name}})',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#1a1a2e,#2d2d5a)">
    <h1>🌊 Waves — Staff Alert</h1><p>New Application Received</p>
  </div>
  <div class="body">
    <p>A new loan application has been submitted and is pending review.</p>
    <div class="grid">
      <div class="cell"><div class="lbl">Reference</div><div class="val">{{loan_ref}}</div></div>
      <div class="cell"><div class="lbl">Applicant</div><div class="val">{{first_name}} {{last_name}}</div></div>
      <div class="cell"><div class="lbl">Amount</div><div class="val">${{loan_amount}}</div></div>
      <div class="cell"><div class="lbl">Email</div><div class="val">{{to_email}}</div></div>
    </div>
    <p><a href="https://wavesfinancial.ca/admin.html">Open Admin Dashboard →</a></p>
  </div>
</div></body></html>`,
  },

  internal_nsf_alert: {
    label:    'NSF Alert (Staff)',
    audience: 'internal',
    enabled:  false,
    subject:  '[Waves] NSF returned — {{loan_ref}} ({{first_name}} {{last_name}})',
    body_html: `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body><div class="wrap">
  <div class="header" style="background:linear-gradient(135deg,#b03535,#d85252)">
    <h1>🌊 Waves — Staff Alert</h1><p>NSF Return Received</p>
  </div>
  <div class="body">
    <p>A payment has been returned NSF and requires collections follow-up.</p>
    <div class="grid">
      <div class="cell"><div class="lbl">Loan Ref</div><div class="val">{{loan_ref}}</div></div>
      <div class="cell"><div class="lbl">Client</div><div class="val">{{first_name}} {{last_name}}</div></div>
      <div class="cell"><div class="lbl">Payment</div><div class="val">${{payment_amount}}</div></div>
      <div class="cell"><div class="lbl">NSF Fee</div><div class="val">${{nsf_fee}}</div></div>
    </div>
    <p><a href="https://wavesfinancial.ca/admin.html">Open Admin Dashboard →</a></p>
  </div>
</div></body></html>`,
  },

};

// ── VARIABLE SUBSTITUTION ─────────────────────────────────────────────────────

function fillTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined && data[key] !== null ? String(data[key]) : match;
  });
}

function render(template, data) {
  return {
    subject:   fillTemplate(template.subject,   data),
    body_html: fillTemplate(template.body_html, data),
  };
}

module.exports = { DEFAULTS, VARIABLES, fillTemplate, render };
