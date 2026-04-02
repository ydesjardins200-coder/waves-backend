'use strict';

/**
 * Waves Financial — CPA Standard 005 Return File Processor
 *
 * Handles Desjardins return files after PAD/DRD processing.
 * Each returned transaction gets:
 *   - Payment status updated (missed / failed / wrong_account)
 *   - $45 NSF fee logged for NSF returns (code 900)
 *   - Automatic retry scheduled 5 business days later for NSF
 *   - Client note added with return reason
 *   - Loan flagged if multiple returns
 */

const { supabase } = require('./supabaseClient');

// ─── RETURN CODES ─────────────────────────────────────────────────────────────

const RETURN_CODES = {
  '900': { reason: 'NSF — Insufficient Funds',            status: 'missed',        retry: true,  fee: true  },
  '901': { reason: 'Account Closed',                      status: 'failed',        retry: false, fee: false },
  '902': { reason: 'Account Frozen / Under Dispute',      status: 'failed',        retry: false, fee: false },
  '903': { reason: 'Wrong Account Number',                status: 'failed',        retry: false, fee: false },
  '905': { reason: 'Account Not Found',                   status: 'failed',        retry: false, fee: false },
  '906': { reason: 'Customer Cancelled PAD Agreement',    status: 'cancelled',     retry: false, fee: false },
  '907': { reason: 'Payment Stopped by Customer',         status: 'missed',        retry: false, fee: false },
  '910': { reason: 'Invalid Routing — Transit/Institution Wrong', status: 'failed',retry: false, fee: false },
  '911': { reason: 'Routing Changed — Account Moved',     status: 'failed',        retry: false, fee: false },
  '914': { reason: 'Account Type Mismatch',               status: 'failed',        retry: false, fee: false },
  '915': { reason: 'Invalid Account Number Format',       status: 'failed',        retry: false, fee: false },
  '920': { reason: 'Authorization Revoked by Customer',   status: 'cancelled',     retry: false, fee: false },
  '921': { reason: 'No Pre-Authorized Debit Agreement on File', status:'failed',   retry: false, fee: false },
};

const NSF_FEE_AMOUNT = 45.00;
const NSF_RETRY_DAYS = 5;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

function toISO(d) { return d.toISOString().slice(0, 10); }

// ─── CPA 005 RETURN FILE PARSER ───────────────────────────────────────────────

/**
 * parseReturnFile(content) → Array of return records
 *
 * CPA 005 return records are 240 chars (3 × 80-char lines).
 * Record type 'D' = returned debit (our PAD was rejected).
 * Record type 'C' = returned credit (our DRD disbursement was rejected).
 *
 * Key fields in a return record:
 *   1       Record type (D or C)
 *   2-4     Institution (borrower's bank)
 *   5-9     Transit
 *   10-22   Account number
 *   23-25   Original transaction type (430=debit, 450=credit)
 *   26-35   Amount (cents)
 *   36-41   Original effective date (Julian 0YYDDD)
 *   46-55   Originator ID
 *   56-69   Cross-reference (our loan ref + payment, e.g. WF-843805-P01)
 *   226-228 Return code (e.g. 900)
 *   229-231 Reserved / original transaction type
 */
function parseReturnFile(content) {
  // Normalize line endings
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').filter(l => l.length > 0);

  const returns = [];
  let i = 0;

  while (i < lines.length) {
    const firstChar = lines[i][0];

    // Skip header (A) and trailer (Z) records
    if (firstChar === 'A' || firstChar === 'Z') { i++; continue; }

    // Transaction records span 3 × 80-char lines
    if (firstChar === 'D' || firstChar === 'C') {
      // Collect up to 3 lines to build the 240-char record
      const parts = [];
      while (parts.length < 3 && i < lines.length && lines[i][0] !== 'A' && lines[i][0] !== 'Z') {
        parts.push(lines[i].padEnd(80, ' '));
        i++;
      }
      const rec = parts.join('');
      if (rec.length < 80) continue;

      const amtCents  = parseInt(rec.slice(25, 35)) || 0;
      const xref1     = rec.slice(55, 69).trim();   // 14-char primary xref
      const xref2     = rec.slice(139, 154).trim();  // 15-char full xref (more reliable)

      // Return code is at position 226-228 in the full 240-char record
      // Some banks put it at different offsets — check both common positions
      let returnCode = rec.slice(225, 228).trim() || rec.slice(222, 225).trim() || '';

      // If not found in standard position, scan for a 3-digit code pattern
      if (!returnCode || !RETURN_CODES[returnCode]) {
        const match = rec.match(/\b(9[0-2]\d)\b/);
        returnCode = match ? match[1] : '000';
      }

      const xref = xref2 || xref1; // prefer 15-char field

      returns.push({
        type:        firstChar,
        institution: rec.slice(1, 4).trim(),
        transit:     rec.slice(4, 9).trim(),
        account:     rec.slice(9, 22).trim(),
        txType:      rec.slice(22, 25).trim(),
        amountCAD:   amtCents / 100,
        xref,
        returnCode,
        returnReason: RETURN_CODES[returnCode]?.reason || `Unknown return code ${returnCode}`,
        raw: rec.substring(0, 240),
      });
      continue;
    }

    i++;
  }

  return returns;
}

// ─── CROSS-REFERENCE MATCHER ──────────────────────────────────────────────────

/**
 * Match a cross-reference back to a repayment_schedule row.
 *
 * Formats to handle:
 *   WF-843805-P01      → loan ref WF-843805, payment 1
 *   R-417391-P02       → loan ref WF-R-417391, payment 2  (truncated — WF- stripped)
 *   WF-R-417391-P01    → loan ref WF-R-417391, payment 1
 */
async function findScheduleRow(xref) {
  if (!xref) return null;

  // Try to parse the xref format: {loanRef}-P{nn}
  const match = xref.match(/^(.*)-P(\d+)$/);
  if (!match) return null;

  let loanRef   = match[1].trim();
  const pmtNum  = parseInt(match[2]);

  // If WF- was stripped (14-char field), prepend it back
  if (!loanRef.startsWith('WF-')) loanRef = 'WF-' + loanRef;

  // Find the loan by ref
  const { data: loan } = await supabase
    .from('loans').select('id, client_id, ref').eq('ref', loanRef).single();
  if (!loan) return null;

  // Find the schedule row
  const { data: schedRow } = await supabase
    .from('repayment_schedule')
    .select('*')
    .eq('loan_id', loan.id)
    .eq('payment_number', pmtNum)
    .single();

  return schedRow ? { ...schedRow, loan } : null;
}

// ─── MAIN PROCESSOR ───────────────────────────────────────────────────────────

/**
 * processReturnFile(content, filename) → summary
 *
 * Parses the return file and processes each returned transaction:
 * 1. Matches to repayment_schedule row via cross-reference
 * 2. Updates payment status (missed / failed / cancelled)
 * 3. Charges $45 NSF fee for code 900
 * 4. Schedules automatic retry in 5 business days for NSF
 * 5. Logs client note with return reason
 * 6. Returns full summary of what was processed
 */
async function processReturnFile(content, filename = 'return-file.txt') {
  const returns  = parseReturnFile(content);
  const now      = new Date().toISOString();
  const summary  = {
    filename,
    processedAt:    now,
    totalReturns:   returns.length,
    matched:        0,
    unmatched:      0,
    nsfFees:        0,
    nsfTotal:       0,
    retriesScheduled: 0,
    results: [],
    unmatched_xrefs: [],
  };

  for (const ret of returns) {
    const codeInfo   = RETURN_CODES[ret.returnCode] || { reason: ret.returnReason, status: 'failed', retry: false, fee: false };
    const schedData  = await findScheduleRow(ret.xref);

    if (!schedData) {
      console.warn(`[returns] No match for xref: ${ret.xref} (code ${ret.returnCode})`);
      summary.unmatched++;
      summary.unmatched_xrefs.push({ xref: ret.xref, code: ret.returnCode, reason: codeInfo.reason });
      continue;
    }

    const { loan, ...schedRow } = schedData;
    summary.matched++;

    const updates = {
      status:       codeInfo.status,
      returned_at:  now,
      return_code:  ret.returnCode,
      return_reason: codeInfo.reason,
      return_file:  filename,
    };

    // ── NSF: charge $45 fee + schedule retry ──────────────────────────────
    if (codeInfo.fee && ret.returnCode === '900') {
      const retryDate = addBusinessDays(new Date(), NSF_RETRY_DAYS);
      updates.nsf_fee_charged = true;
      updates.retry_date      = toISO(retryDate);
      updates.retry_count     = (schedRow.retry_count || 0) + 1;

      // Insert NSF fee record
      const { error: feeErr } = await supabase.from('nsf_fees').insert({
        client_id:   loan.client_id,
        loan_id:     loan.id,
        schedule_id: schedRow.id,
        amount:      NSF_FEE_AMOUNT,
        reason:      `NSF on payment ${schedRow.payment_number} of ${loan.ref}`,
        return_code: ret.returnCode,
        status:      'outstanding',
      });
      if (feeErr) console.error('[returns] NSF fee insert error:', feeErr.message);
      else { summary.nsfFees++; summary.nsfTotal += NSF_FEE_AMOUNT; }

      // Log client note
      try {
        await supabase.from('client_notes').insert({
          client_id: loan.client_id,
          agent:     'system',
          note:      `NSF returned on ${loan.ref} payment #${schedRow.payment_number} ($${parseFloat(schedRow.scheduled_amount).toFixed(2)}). $${NSF_FEE_AMOUNT} fee charged. Retry scheduled: ${toISO(retryDate)}.`,
          context:   'nsf',
        });
      } catch(e) { console.warn('[returns] client note error:', e.message); }

      summary.retriesScheduled++;
      console.log(`[returns] NSF: ${loan.ref} P${schedRow.payment_number} — fee charged, retry ${toISO(retryDate)}`);

    } else if (codeInfo.status === 'failed' || codeInfo.status === 'cancelled') {
      // Non-NSF failure — log note, no retry
      try {
        await supabase.from('client_notes').insert({
          client_id: loan.client_id,
          agent:     'system',
          note:      `Payment returned on ${loan.ref} #${schedRow.payment_number}: ${codeInfo.reason} (code ${ret.returnCode}). Manual follow-up required.`,
          context:   'return',
        });
      } catch(e) { console.warn('[returns] client note error:', e.message); }

      console.log(`[returns] ${codeInfo.status.toUpperCase()}: ${loan.ref} P${schedRow.payment_number} — ${codeInfo.reason}`);
    }

    // ── Update schedule row ────────────────────────────────────────────────
    const { error: updErr } = await supabase
      .from('repayment_schedule')
      .update(updates)
      .eq('id', schedRow.id);
    if (updErr) console.error(`[returns] Schedule update error for ${ret.xref}:`, updErr.message);

    summary.results.push({
      xref:          ret.xref,
      loan:          loan.ref,
      payment:       schedRow.payment_number,
      amount:        parseFloat(schedRow.scheduled_amount).toFixed(2),
      returnCode:    ret.returnCode,
      reason:        codeInfo.reason,
      newStatus:     codeInfo.status,
      nsfFee:        codeInfo.fee ? `$${NSF_FEE_AMOUNT}` : null,
      retryDate:     updates.retry_date || null,
    });
  }

  console.log(`[returns] ✅ Processed ${filename}: ${summary.matched} matched, ${summary.unmatched} unmatched, ${summary.nsfFees} NSF fees ($${summary.nsfTotal}), ${summary.retriesScheduled} retries scheduled`);
  return summary;
}

// ─── RETRY QUEUE BUILDER ──────────────────────────────────────────────────────

/**
 * getRetryQueue(cutoffDate) → { payments, nsfFees }
 *
 * Returns all NSF-returned payments whose retry_date has arrived (not yet retried),
 * plus all outstanding NSF fees for the same loans (to collect in the same PAD run).
 */
async function getRetryQueue(cutoffDate = new Date()) {
  const cutoffStr = toISO(cutoffDate);

  const { data: payments, error: pmtErr } = await supabase
    .from('repayment_schedule')
    .select('id, loan_id, payment_number, due_date, retry_date, scheduled_amount, return_code, retry_count')
    .eq('status', 'missed')
    .eq('return_code', '900')
    .is('eft_retry_at', null)
    .lte('retry_date', cutoffStr)
    .order('retry_date', { ascending: true });

  if (pmtErr) {
    console.error('[returns] Retry queue error:', pmtErr.message);
    return { payments: [], nsfFees: [] };
  }

  // Fetch outstanding NSF fees for the loans in this retry run
  const loanIds = [...new Set((payments || []).map(p => p.loan_id))];
  let nsfFees = [];
  if (loanIds.length) {
    const { data: fees } = await supabase
      .from('nsf_fees')
      .select('*')
      .in('loan_id', loanIds)
      .eq('status', 'outstanding');
    nsfFees = fees || [];
  }

  return { payments: payments || [], nsfFees };
}

module.exports = { processReturnFile, parseReturnFile, getRetryQueue, RETURN_CODES, NSF_FEE_AMOUNT };
