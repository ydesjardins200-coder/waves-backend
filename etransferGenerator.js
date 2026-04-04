'use strict';

/**
 * Waves Financial — Desjardins Bulk Interac e-Transfer File Generator
 *
 * Generates a CSV file compatible with Desjardins AccèsD Business
 * bulk Interac e-Transfer disbursement feature.
 *
 * Each row = one e-Transfer to one borrower.
 * Security model: fixed Q&A — "What is your loan reference number?" / WF-XXXXXX
 *
 * NOTE: Column order / names may need adjustment once Desjardins provides
 * their exact spec. This follows the standard AccèsD Business bulk format.
 *
 * Columns:
 *   Recipient Name     — borrower full name (max 40 chars)
 *   Email Address      — borrower email
 *   Amount             — disbursement amount in dollars (e.g. 750.00)
 *   Reference Number   — loan ref (WF-XXXXXX), shown on borrower's notification
 *   Message            — shown in e-Transfer notification to borrower
 *   Security Question  — "What is your loan reference number?"
 *   Security Answer    — loan ref (WF-XXXXXX)
 */

/** Sanitize a string for CSV — remove commas, quotes, newlines */
function csvCell(val) {
  const s = String(val || '').replace(/[\r\n,]/g, ' ').replace(/"/g, "'").trim();
  // Quote if contains semicolons or special chars
  return s.includes(';') ? `"${s}"` : s;
}

/** Normalize accented characters to ASCII */
function toASCII(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim();
}

/** Format amount to 2 decimal places */
function fmtAmount(dollars) {
  return parseFloat(dollars || 0).toFixed(2);
}

/** Generate filename: WAVES_ETRANSFER_YYYYMMDD_NNNN.csv */
function etransferFilename(date = new Date(), fileNumber = 1) {
  const d = date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const n = String(fileNumber).padStart(4, '0');
  return `WAVES_ETRANSFER_${y}${m}${day}_${n}.csv`;
}

const SECURITY_QUESTION = 'What is your loan reference number?';

/**
 * generateETransfer(loans, opts) → { filename, content, summary, errors }
 *
 * @param {Array} loans - Array of loan objects:
 *   { ref, amount, borrowerName, borrowerEmail }
 * @param {Object} opts
 *   { effectiveDate: Date, fileNumber: number }
 */
function generateETransfer(loans, opts = {}) {
  const { effectiveDate = new Date(), fileNumber = 1 } = opts;

  const filename = etransferFilename(effectiveDate, fileNumber);
  const errors   = [];
  const rows     = [];

  let totalAmount = 0;

  for (const loan of loans) {
    // Validate required fields
    if (!loan.borrowerEmail || !loan.borrowerEmail.includes('@')) {
      errors.push({ ref: loan.ref, reason: 'Missing or invalid email address' });
      continue;
    }
    if (!loan.amount || parseFloat(loan.amount) <= 0) {
      errors.push({ ref: loan.ref, reason: 'Invalid amount' });
      continue;
    }

    const name    = toASCII(loan.borrowerName || 'Borrower').substring(0, 40);
    const email   = loan.borrowerEmail.trim().toLowerCase();
    const amount  = fmtAmount(loan.amount);
    const ref     = loan.ref || '';
    const message = toASCII(`Waves Financial loan disbursement — ${ref}`).substring(0, 100);
    const answer  = ref; // security answer = loan ref

    rows.push([
      csvCell(name),
      csvCell(email),
      csvCell(amount),
      csvCell(ref),
      csvCell(message),
      csvCell(SECURITY_QUESTION),
      csvCell(answer),
    ].join(','));

    totalAmount += parseFloat(loan.amount);
  }

  if (!rows.length) {
    return { filename, content: null, summary: null, errors };
  }

  // Header row
  const header = [
    'Recipient Name',
    'Email Address',
    'Amount',
    'Reference Number',
    'Message',
    'Security Question',
    'Security Answer',
  ].join(',');

  const content = [header, ...rows].join('\r\n') + '\r\n';

  const summary = {
    transactionCount: rows.length,
    totalAmount:      totalAmount.toFixed(2),
    effectiveDate:    effectiveDate.toISOString().slice(0, 10),
    filename,
  };

  return { filename, content, summary, errors };
}

module.exports = { generateETransfer, etransferFilename };
