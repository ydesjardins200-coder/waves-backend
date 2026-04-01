'use strict';

/**
 * Waves Financial — Desjardins DRD File Generator
 *
 * Generates a CPA Standard 005 (AFT) EFT batch file compatible with
 * Desjardins AccèsD Business for direct deposit (credit) transactions.
 *
 * Format: 80-character fixed-width records, each terminated by CRLF.
 *
 * Record types:
 *   A — Logical File Header
 *   C — Credit transaction (loan disbursement to borrower)
 *   Z — Logical File Trailer
 *
 * References:
 *   CPA Standard 005 — "Automated Funds Transfer"
 *   Desjardins AccèsD Business EFT Specifications (2024)
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ORIGINATOR_ID      = process.env.DRD_ORIGINATOR_ID || '0000000000'; // 10-digit assigned by Desjardins
const ORIGINATOR_SHORT   = process.env.DRD_ORIGINATOR_SHORT || 'WAVES FIN '; // max 15 chars, padded
const ORIGINATOR_LONG    = process.env.DRD_ORIGINATOR_LONG  || 'WAVES FINANCIAL INC         '; // 30 chars
const ORIGINATOR_TRANSIT = process.env.DRD_TRANSIT          || '00000'; // Your Desjardins branch transit
const ORIGINATOR_INST    = process.env.DRD_INSTITUTION       || '815';   // Desjardins institution number
const ORIGINATOR_ACCOUNT = process.env.DRD_ACCOUNT           || '0000000000000'; // Your funding account

const TRANSACTION_TYPE   = '450'; // Credit — Direct Deposit
const CURRENCY           = 'CAD';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Pad string to length, truncating if needed */
function padR(str, len) {
  return String(str || '').substring(0, len).padEnd(len, ' ');
}

/** Pad number to length with leading zeros */
function padL(num, len) {
  return String(num || '0').padStart(len, '0').substring(0, len);
}

/** Format date as YYYYMMDD (Julian day of year → 0YYDDD) */
function julianDate(d = new Date()) {
  const year     = d.getFullYear();
  const start    = new Date(year, 0, 0);
  const diff     = d - start;
  const oneDay   = 1000 * 60 * 60 * 24;
  const dayOfYear= Math.floor(diff / oneDay);
  const yy       = String(year).slice(-2);
  return '0' + yy + padL(dayOfYear, 3); // e.g. 026001 = Jan 1 2026
}

/** Format amount in cents, 10 digits */
function fmtAmount(dollars) {
  return padL(Math.round(parseFloat(dollars || 0) * 100), 10);
}

/** Generate a file creation number (sequential, 4 digits) */
function fileCreationNum(n = 1) {
  return padL(n, 4);
}

// ─── RECORD BUILDERS ─────────────────────────────────────────────────────────

/**
 * Record Type A — Logical File Header (1 record per file)
 * Position  Length  Description
 * 1         1       Record Type = 'A'
 * 2         3       Originator's Data Centre Routing No (Desjardins: '815')
 * 5-10      6       Reserved (spaces)
 * 11-20     10      Originator's ID
 * 21-24     4       File Creation Number
 * 25-30     6       Creation Date (0YYDDD Julian)
 * 31-35     5       Reserved (spaces)
 * 36-75     40      Originator's Short Name + Long Name
 * 76-80     5       Reserved (spaces)
 */
function buildHeaderRecord(fileNum, date) {
  return [
    'A',                              // 1 — Record type
    padL(ORIGINATOR_INST, 3),         // 2-4 — Institution routing
    padR('', 6),                      // 5-10 — Reserved
    padL(ORIGINATOR_ID, 10),          // 11-20 — Originator ID
    fileCreationNum(fileNum),         // 21-24 — File creation number
    julianDate(date),                 // 25-30 — Creation date
    padR('', 5),                      // 31-35 — Reserved
    padR(ORIGINATOR_LONG, 30),        // 36-65 — Originator long name
    padR(ORIGINATOR_SHORT, 15),       // 66-80 — Originator short name (last 15 of 40)
  ].join('').substring(0, 80);
}

/**
 * Record Type C — Credit Transaction (1 per loan disbursement)
 * Position  Length  Description
 * 1         1       Record Type = 'C'
 * 2-4       3       Institution Number (borrower's bank)
 * 5-9       5       Transit Number (borrower's branch)
 * 10-22     13      Account Number (borrower's account, left-justified)
 * 23-25     3       Transaction Type (450 = credit)
 * 26-35     10      Amount in cents (no decimal)
 * 36-41     6       Effective Date (0YYDDD Julian)
 * 42-45     4       Reserved (spaces)
 * 46-55     10      Originator's ID
 * 56-69     14      Cross-Reference Number (your loan ref, left-justified)
 * 70-72     3       Institution Number (originator = Desjardins)
 * 73-77     5       Transit Number (originator's branch)
 * 78-92     15      Originator's Short Name
 * 93-122    30      Payee Name (borrower full name)
 * 123-132   10      Originator's Long Name (first 10 chars)
 * 133-139   7       Reserved (spaces)
 * 140-154   15      Cross-Reference No (repeat)
 * 155-167   13      Institution Account (originator's account)
 *
 * Note: CPA 005 record is 240 characters for transaction records.
 * We output 2 lines of 120 chars each (some banks) or 1 line of 240.
 * Desjardins uses the full 240-char transaction record.
 */
function buildCreditRecord(loan, effectiveDate) {
  const {
    borrowerTransit,
    borrowerInstitution,
    borrowerAccount,
    amount,
    ref,
    borrowerName,
  } = loan;

  // Validate required fields
  if (!borrowerTransit || !borrowerInstitution || !borrowerAccount) {
    throw new Error(`Loan ${ref}: missing banking coordinates (transit/institution/account)`);
  }

  const line = [
    'C',                                          // 1 — Record type
    padL(borrowerInstitution, 3),                 // 2-4 — Borrower institution
    padL(borrowerTransit, 5),                     // 5-9 — Borrower transit
    padR(borrowerAccount, 13),                    // 10-22 — Borrower account (left-justified)
    TRANSACTION_TYPE,                             // 23-25 — 450 = credit
    fmtAmount(amount),                            // 26-35 — Amount in cents
    julianDate(effectiveDate),                    // 36-41 — Effective date
    padR('', 4),                                  // 42-45 — Reserved
    padL(ORIGINATOR_ID, 10),                      // 46-55 — Originator ID
    padR(ref, 14),                                // 56-69 — Cross-reference (loan ref)
    padL(ORIGINATOR_INST, 3),                     // 70-72 — Originator institution
    padL(ORIGINATOR_TRANSIT, 5),                  // 73-77 — Originator transit
    padR(ORIGINATOR_SHORT, 15),                   // 78-92 — Originator short name
    padR(borrowerName, 30),                       // 93-122 — Payee (borrower) name
    padR(ORIGINATOR_LONG.substring(0, 10), 10),   // 123-132 — Originator long name (first 10)
    padR('', 7),                                  // 133-139 — Reserved
    padR(ref, 15),                                // 140-154 — Cross-ref (repeat)
    padR(ORIGINATOR_ACCOUNT, 13),                 // 155-167 — Originator account
    padR('', 73),                                 // 168-240 — Padding to 240 chars
  ].join('');

  // CPA 005 transaction record = 240 characters
  // Split into 3 × 80-char lines for compatibility
  return [
    line.substring(0, 80),
    line.substring(80, 160),
    line.substring(160, 240),
  ].join('\r\n');
}

/**
 * Record Type Z — Logical File Trailer (1 record per file)
 * Position  Length  Description
 * 1         1       Record Type = 'Z'
 * 2-4       3       Institution Routing (same as header)
 * 5-10      6       Reserved
 * 11-20     10      Originator ID
 * 21-24     4       File Creation Number
 * 25-34     10      Total credit value (cents)
 * 35-42     8       Total debit value (zeros — no debits)
 * 43-50     8       Credit transaction count (right-justified, zero-padded)
 * 51-58     8       Debit transaction count (zeros)
 * 59-62     4       Reserved
 * 63-80     18      Reserved (spaces)
 */
function buildTrailerRecord(fileNum, totalAmount, transactionCount) {
  return [
    'Z',
    padL(ORIGINATOR_INST, 3),
    padR('', 6),
    padL(ORIGINATOR_ID, 10),
    fileCreationNum(fileNum),
    fmtAmount(totalAmount),           // Total credit value
    padL('0', 10),                    // Total debit value (none)
    padL(transactionCount, 8),        // Credit count
    padL('0', 8),                     // Debit count
    padR('', 4),
    padR('', 18),
  ].join('').substring(0, 80);
}

// ─── MAIN GENERATOR ──────────────────────────────────────────────────────────

/**
 * generateDRD(loans, options) → { filename, content, summary }
 *
 * @param {Array} loans  Array of loan objects with:
 *   - ref               string    Loan reference (WF-XXXXXX)
 *   - amount            number    Disbursement amount in CAD
 *   - borrowerName      string    Full name of borrower
 *   - borrowerTransit   string    5-digit branch transit
 *   - borrowerInstitution string  3-digit institution number
 *   - borrowerAccount   string    Account number
 *
 * @param {Object} options
 *   - effectiveDate     Date      When funds should be credited (default: next business day)
 *   - fileNumber        number    Sequential file number (default: 1)
 *
 * @returns { filename, content, summary, errors }
 */
function generateDRD(loans, options = {}) {
  const effectiveDate = options.effectiveDate || nextBusinessDay();
  const fileNumber    = options.fileNumber || 1;
  const creationDate  = new Date();

  const records     = [];
  const errors      = [];
  const validLoans  = [];

  // Build transaction records, collect errors
  for (const loan of loans) {
    try {
      const record = buildCreditRecord(loan, effectiveDate);
      records.push(record);
      validLoans.push(loan);
    } catch (err) {
      errors.push({ ref: loan.ref, error: err.message });
    }
  }

  if (!validLoans.length) {
    return { filename: null, content: null, summary: null, errors };
  }

  const totalAmount = validLoans.reduce((s, l) => s + parseFloat(l.amount || 0), 0);

  const header  = buildHeaderRecord(fileNumber, creationDate);
  const trailer = buildTrailerRecord(fileNumber, totalAmount, validLoans.length);

  const content = [header, ...records, trailer].join('\r\n') + '\r\n';

  const dateStr = effectiveDate.toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `WAVES_DRD_${dateStr}_${fileNumber.toString().padStart(4, '0')}.txt`;

  const summary = {
    filename,
    effectiveDate: effectiveDate.toISOString().slice(0, 10),
    transactionCount: validLoans.length,
    totalAmount: totalAmount.toFixed(2),
    loans: validLoans.map(l => ({
      ref:    l.ref,
      amount: parseFloat(l.amount || 0).toFixed(2),
      name:   l.borrowerName,
    })),
    errors,
  };

  return { filename, content, summary, errors };
}

/** Returns next business day (Mon–Fri), skipping weekends */
function nextBusinessDay(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

module.exports = { generateDRD, nextBusinessDay };
