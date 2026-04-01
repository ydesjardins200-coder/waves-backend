'use strict';

/**
 * Waves Financial — PDF Generator
 *
 * Generates two document types:
 *   1. Signed Loan Contract   — full legal agreement with repayment schedule
 *   2. Bank Verification Report — Flinks-verified bank data summary
 *
 * Returns a Buffer. Caller saves to Supabase Storage or streams to client.
 */

const PDFDocument = require('pdfkit');

// ─── BRAND COLOURS (as RGB 0–255) ─────────────────────────────────────────────
const C = {
  navy:       [13,  11,  31],   // deep background
  purple:     [91,  82, 216],   // iris
  teal:       [29, 233, 198],
  gold:       [255, 209, 102],
  coral:      [255, 107, 138],
  white:      [255, 255, 255],
  lightGrey:  [220, 218, 245],
  midGrey:    [160, 154, 200],
  darkGrey:   [80,  75, 120],
};


// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt$(n) {
  return '$' + (parseFloat(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-CA');
}
function val(v) { return v || '—'; }

// Draw a horizontal rule
function rule(doc, y, color = C.darkGrey) {
  doc.save().moveTo(50, y).lineTo(545, y)
    .strokeColor(color).lineWidth(0.5).stroke().restore();
}

// Section header bar
function sectionHeader(doc, text, y) {
  doc.save()
    .rect(50, y, 495, 18).fill(C.purple)
    .fillColor(C.white).fontSize(8).font('Helvetica-Bold')
    .text(text, 56, y + 5, { width: 483 })
    .restore();
  return y + 22;
}

// Two-column field
function field(doc, label, value, x, y, width = 200, highlight = false) {
  doc.save()
    .fillColor(C.midGrey).fontSize(7).font('Helvetica')
    .text(label.toUpperCase(), x, y, { width })
    .fillColor(highlight ? C.teal : C.white).fontSize(8.5).font('Helvetica-Bold')
    .text(String(value || '—'), x, y + 10, { width })
    .restore();
}

// Page header
function pageHeader(doc, title) {
  // Top bar
  doc.save()
    .rect(0, 0, 595, 48).fill(C.navy)
    .fillColor(C.purple).fontSize(20).font('Helvetica-Bold')
    .text('🌊', 50, 14)
    .fillColor(C.white).fontSize(11).font('Helvetica-Bold')
    .text('Waves Financial', 74, 18)
    .fillColor(C.lightGrey).fontSize(8).font('Helvetica')
    .text(title, 74, 32)
    .fillColor(C.midGrey).fontSize(7)
    .text('wavesfinancial.ca  ·  Licensed Canadian Lender', 300, 22, { align: 'right', width: 245 })
    .text('Generated: ' + new Date().toLocaleString('en-CA'), 300, 32, { align: 'right', width: 245 })
    .restore();
}

// Page footer
function pageFooter(doc, pageNum) {
  const y = 780;
  rule(doc, y, C.darkGrey);
  doc.save()
    .fillColor(C.midGrey).fontSize(7).font('Helvetica')
    .text('Waves Financial — Confidential — For authorized use only', 50, y + 6, { width: 350 })
    .text(`Page ${pageNum}`, 50, y + 6, { align: 'right', width: 495 })
    .restore();
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. SIGNED LOAN CONTRACT PDF
// ═══════════════════════════════════════════════════════════════════════════════

function generateContractPDF(contract, client, schedule) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── PAGE 1: Header & parties ──────────────────────────────────────────
    pageHeader(doc, 'SIGNED LOAN AGREEMENT');
    let y = 65;

    // Contract reference banner
    doc.save()
      .rect(50, y, 495, 28).fill([20, 18, 50])
      .fillColor(C.gold).fontSize(9).font('Helvetica-Bold')
      .text(`Loan Reference: ${contract.loan_ref || '—'}`, 56, y + 5)
      .fillColor(C.lightGrey).fontSize(8).font('Helvetica')
      .text(`Contract ID: ${contract.id?.slice(0, 8).toUpperCase() || '—'}`, 56, y + 16)
      .fillColor(C.teal).fontSize(9).font('Helvetica-Bold')
      .text('✓ ELECTRONICALLY SIGNED', 400, y + 10, { align: 'right', width: 140 })
      .restore();
    y += 36;

    // Parties
    y = sectionHeader(doc, 'PARTIES TO THIS AGREEMENT', y);
    doc.save().rect(50, y, 244, 56).fill([20, 18, 50]).restore();
    doc.save().rect(301, y, 244, 56).fill([20, 18, 50]).restore();

    doc.save()
      .fillColor(C.midGrey).fontSize(7).font('Helvetica')
      .text('LENDER', 58, y + 6).text('BORROWER', 309, y + 6)
      .fillColor(C.white).fontSize(9).font('Helvetica-Bold')
      .text('Waves Financial', 58, y + 17)
      .text(val(contract.borrower_name), 309, y + 17)
      .fillColor(C.lightGrey).fontSize(7.5).font('Helvetica')
      .text('Licensed Canadian Online Lender', 58, y + 29)
      .text(val(contract.borrower_email), 309, y + 29)
      .text('wavesfinancial.ca', 58, y + 40)
      .text(val(contract.borrower_address), 309, y + 40, { width: 230 })
      .restore();
    y += 64;

    // Loan terms
    y = sectionHeader(doc, 'LOAN TERMS', y);
    const terms = [
      ['Principal Amount',     fmt$(contract.principal),    true],
      ['Annual Percentage Rate (APR)', (contract.apr ? (contract.apr * 100).toFixed(2) : '23.00') + '%', false],
      ['Loan Term',            (contract.term_days || 112) + ' days', false],
      ['Payment Frequency',    val(contract.payment_frequency), false],
      ['Number of Payments',   String(contract.payment_count || 8), false],
      ['Payment Amount',       fmt$(contract.payment_amount), false],
      ['Total Amount Repayable', fmt$(contract.total_repayable), true],
      ['Fund Disbursement Method', val(contract.fund_method), false],
    ];
    let tx = 50, ty = y;
    terms.forEach(([label, value, hi], i) => {
      const col = i % 2 === 0 ? 50 : 300;
      if (i % 2 === 0 && i > 0) ty += 32;
      field(doc, label, value, col, ty, 240, hi);
    });
    y = ty + 36;

    // Key dates
    rule(doc, y); y += 8;
    const dates = [
      ['First Payment Due',    fmtDate(contract.first_payment_date)],
      ['Final Payment Due',    fmtDate(contract.final_payment_date)],
      ['Borrower Province',    val(contract.borrower_province)],
      ['PAD Authorized',       contract.pad_authorized ? 'Yes — Pre-Authorized Debit' : 'No'],
    ];
    dates.forEach(([label, value], i) => {
      const col = i % 2 === 0 ? 50 : 300;
      if (i % 2 === 0 && i > 0) y += 32;
      field(doc, label, value, col, y, 240);
    });
    y += 38;

    // Repayment schedule
    y = sectionHeader(doc, 'REPAYMENT SCHEDULE', y);
    const colW = [40, 100, 80, 80, 80, 80];
    const colX = [50, 100, 200, 280, 360, 440];
    const headers = ['#', 'Due Date', 'Capital', 'Fees', 'Insurance', 'Payment'];

    // Table header
    doc.save().rect(50, y, 495, 16).fill([30, 25, 70]).restore();
    headers.forEach((h, i) => {
      doc.save()
        .fillColor(C.lightGrey).fontSize(7).font('Helvetica-Bold')
        .text(h, colX[i], y + 5, { width: colW[i], align: i > 0 ? 'right' : 'left' })
        .restore();
    });
    y += 18;

    (schedule || []).forEach((row, idx) => {
      const bg = idx % 2 === 0 ? [16, 14, 42] : [20, 18, 50];
      doc.save().rect(50, y, 495, 15).fill(bg).restore();
      const statusColor = row.status === 'paid' ? C.teal : row.status === 'missed' ? C.coral : C.lightGrey;
      doc.save()
        .fillColor(statusColor).fontSize(7.5).font('Helvetica')
        .text(String(row.payment_number || idx + 1), colX[0], y + 4, { width: colW[0] })
        .text(fmtDateShort(row.due_date), colX[1], y + 4, { width: colW[1], align: 'right' })
        .text(fmt$(row.scheduled_amount), colX[2], y + 4, { width: colW[2], align: 'right' })
        .text('$0.00', colX[3], y + 4, { width: colW[3], align: 'right' })
        .text('$0.00', colX[4], y + 4, { width: colW[4], align: 'right' })
        .text(fmt$(row.scheduled_amount), colX[5], y + 4, { width: colW[5], align: 'right' })
        .restore();
      y += 16;
      if (y > 720 && idx < (schedule.length - 1)) {
        pageFooter(doc, doc.bufferedPageRange().count);
        doc.addPage();
        pageHeader(doc, 'SIGNED LOAN AGREEMENT — CONTINUED');
        y = 65;
      }
    });

    // Totals row
    const totalPayment = (schedule || []).reduce((s, r) => s + parseFloat(r.scheduled_amount || 0), 0);
    doc.save().rect(50, y, 495, 18).fill(C.purple).restore();
    doc.save()
      .fillColor(C.white).fontSize(8).font('Helvetica-Bold')
      .text('TOTAL', colX[0], y + 5, { width: 200 })
      .text(fmt$(contract.principal), colX[2], y + 5, { width: colW[2], align: 'right' })
      .text('$0.00', colX[3], y + 5, { width: colW[3], align: 'right' })
      .text('$0.00', colX[4], y + 5, { width: colW[4], align: 'right' })
      .text(fmt$(totalPayment), colX[5], y + 5, { width: colW[5], align: 'right' })
      .restore();
    y += 26;

    // Terms & conditions excerpt
    if (y > 640) {
      pageFooter(doc, doc.bufferedPageRange().count);
      doc.addPage();
      pageHeader(doc, 'SIGNED LOAN AGREEMENT — TERMS');
      y = 65;
    }
    y = sectionHeader(doc, 'TERMS & CONDITIONS (SUMMARY)', y);
    const terms_text = [
      'The Borrower agrees to repay the Principal Amount plus interest at the Annual Percentage Rate stated above.',
      'Payments will be made on the schedule above via the selected disbursement method.',
      'A missed payment may result in NSF fees and will be reported to our collections process.',
      'Early repayment is permitted at any time without penalty.',
      'This agreement is governed by the laws of the Province of ' + (contract.borrower_province || 'Canada') + '.',
      'The Borrower confirms that all information provided in the application is accurate and complete.',
      'Waves Financial is a licensed Canadian lender. Rates are subject to eligibility.',
    ];
    doc.save().fillColor(C.lightGrey).fontSize(7.5).font('Helvetica');
    terms_text.forEach(t => {
      doc.text('• ' + t, 56, y, { width: 483 });
      y += 14;
    });
    doc.restore();
    y += 8;

    // E-Signature block
    if (y > 680) {
      pageFooter(doc, doc.bufferedPageRange().count);
      doc.addPage();
      pageHeader(doc, 'SIGNED LOAN AGREEMENT — SIGNATURE');
      y = 65;
    }
    y = sectionHeader(doc, 'ELECTRONIC SIGNATURE', y);
    doc.save().rect(50, y, 495, 80).fill([20, 18, 50]).restore();

    doc.save()
      .fillColor(C.midGrey).fontSize(7).font('Helvetica')
      .text('BORROWER SIGNATURE', 58, y + 8)
      .fillColor(C.teal).fontSize(16).font('Helvetica-BoldOblique')
      .text(val(contract.esig_name), 58, y + 20, { width: 300 })
      .fillColor(C.midGrey).fontSize(7).font('Helvetica')
      .text('Typed full name constitutes a legally binding electronic signature', 58, y + 44)
      .text('Timestamp: ' + (contract.esig_timestamp ? new Date(contract.esig_timestamp).toLocaleString('en-CA') : '—'), 58, y + 55)
      .fillColor(C.gold).fontSize(9).font('Helvetica-Bold')
      .text('✓ SIGNED', 420, y + 30, { align: 'right', width: 118 })
      .restore();
    y += 90;

    // Legal disclaimer
    doc.save()
      .fillColor(C.darkGrey).fontSize(6.5).font('Helvetica')
      .text(
        'This document is an electronic record generated by Waves Financial. The electronic signature above is legally binding under applicable Canadian e-commerce legislation. ' +
        'This document is confidential and intended solely for the named borrower and authorized representatives of Waves Financial.',
        50, y, { width: 495 }
      )
      .restore();

    pageFooter(doc, doc.bufferedPageRange().count);
    doc.end();
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// 2. BANK VERIFICATION REPORT PDF
// ═══════════════════════════════════════════════════════════════════════════════

function generateBankReportPDF(application, client) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const s = application.signals || {};

    pageHeader(doc, 'BANK VERIFICATION REPORT — POWERED BY FLINKS');
    let y = 65;

    // Reference banner
    doc.save()
      .rect(50, y, 495, 28).fill([20, 18, 50])
      .fillColor(C.gold).fontSize(9).font('Helvetica-Bold')
      .text(`Application Ref: ${application.ref || '—'}`, 56, y + 5)
      .fillColor(C.lightGrey).fontSize(8).font('Helvetica')
      .text(`Login ID: ${application.flinks_login_id || '—'}`, 56, y + 16)
      .fillColor(C.teal).fontSize(9).font('Helvetica-Bold')
      .text('✓ FLINKS VERIFIED', 400, y + 10, { align: 'right', width: 140 })
      .restore();
    y += 36;

    // Applicant
    y = sectionHeader(doc, 'APPLICANT', y);
    field(doc, 'Full Name',  `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—', 50,  y, 230);
    field(doc, 'Email',       client.email || '—',       300, y, 230);
    y += 32;
    field(doc, 'Province',    client.province || '—',    50,  y, 230);
    field(doc, 'Verified On', fmtDate(application.submitted_at), 300, y, 230);
    y += 38;

    // Account Summary
    y = sectionHeader(doc, 'ACCOUNT SUMMARY', y);
    const acctFields = [
      ['Financial Institution', val(application.bank_name), false],
      ['Account Age',           application.account_age_days ? application.account_age_days + ' days' : '—', false],
      ['Average Daily Balance (90d)', application.avg_daily_balance ? fmt$(application.avg_daily_balance) : '—', true],
      ['Income Regularity',     val(application.income_regularity), false],
      ['Sandbox / Test Mode',   application.is_sandbox ? 'Yes' : 'No', false],
    ];
    let afx = 50, afy = y;
    acctFields.forEach(([l, v, hi], i) => {
      const col = i % 2 === 0 ? 50 : 300;
      if (i % 2 === 0 && i > 0) afy += 32;
      field(doc, l, v, col, afy, 230, hi);
    });
    y = afy + 38;

    // Income Analysis
    y = sectionHeader(doc, 'INCOME ANALYSIS', y);
    field(doc, 'Verified Monthly Income (Flinks)', application.verified_income ? fmt$(application.verified_income) : '—', 50,  y, 230, true);
    field(doc, 'Declared Monthly Income',          application.declared_monthly_income ? fmt$(application.declared_monthly_income) : '—', 300, y, 230);
    y += 32;
    const mismatch = s.misRatio != null ? (s.misRatio * 100).toFixed(1) + '%' : '—';
    const mismatchColor = (s.misRatio || 0) > 0.2;
    field(doc, 'Income Mismatch Ratio', mismatch, 50, y, 230, mismatchColor);
    field(doc, 'Fixed Monthly Obligations', application.fixed_obligations ? fmt$(application.fixed_obligations) : '—', 300, y, 230);
    y += 38;

    // Risk Indicators
    y = sectionHeader(doc, 'RISK INDICATORS (LAST 90 DAYS)', y);
    const riskFields = [
      ['NSF Events (Returned Items)',   String(application.nsf_count ?? '—'),       (application.nsf_count || 0) > 0],
      ['Payment Oppositions (Blocked PADs)', String(application.opposition_count ?? '—'), (application.opposition_count || 0) > 0],
      ['Debt-to-Income Ratio',          s.dtiRatio != null ? (s.dtiRatio * 100).toFixed(1) + '%' : '—', (s.dtiRatio || 0) > 0.5],
    ];
    riskFields.forEach(([l, v, warn], i) => {
      const col = i % 2 === 0 ? 50 : 300;
      const rowY = i < 2 ? y : y + 32;
      if (i === 2) { y += 32; }
      doc.save()
        .fillColor(C.midGrey).fontSize(7).font('Helvetica').text(l.toUpperCase(), col, rowY, { width: 230 })
        .fillColor(warn ? C.coral : C.teal).fontSize(8.5).font('Helvetica-Bold').text(v, col, rowY + 10, { width: 230 })
        .restore();
    });
    y += 38;

    // Scoring Result
    y = sectionHeader(doc, 'CREDIT DECISION', y);
    doc.save().rect(50, y, 495, 70).fill([20, 18, 50]).restore();
    const tierColors = { gold: C.gold, green: C.teal, blue: [0,229,255], yellow: [245,197,66], orange: C.gold, red: C.coral };
    const tierColor  = tierColors[application.tier] || C.lightGrey;

    doc.save()
      .fillColor(C.midGrey).fontSize(7).font('Helvetica')
      .text('RISK SCORE', 58, y + 8)
      .text('TIER', 180, y + 8)
      .text('DECISION', 300, y + 8)
      .fillColor(tierColor).fontSize(24).font('Helvetica-Bold')
      .text(String(application.risk_score ?? '—'), 58, y + 18, { width: 100 })
      .fillColor(tierColor).fontSize(14).font('Helvetica-Bold')
      .text((application.tier || '—').toUpperCase(), 180, y + 24, { width: 100 })
      .fillColor(application.decision === 'auto_approved' ? C.teal : application.decision === 'auto_declined' ? C.coral : C.lightGrey)
      .fontSize(11).font('Helvetica-Bold')
      .text(application.decision?.replace(/_/g, ' ').toUpperCase() || '—', 300, y + 24, { width: 240 })
      .restore();

    if (application.hard_decline) {
      doc.save()
        .fillColor(C.coral).fontSize(8).font('Helvetica-BoldOblique')
        .text('Decline Reason: ' + application.hard_decline, 58, y + 52, { width: 480 })
        .restore();
    }
    y += 80;

    // Signal breakdown
    if (s && Object.keys(s).length > 0) {
      y = sectionHeader(doc, 'SIGNAL BREAKDOWN', y);
      const signals = [
        ['NSF Events', s.nsfPts ?? 0, 25, application.nsf_count ?? 0],
        ['Payment Oppositions', s.oppPts ?? 0, 20, application.opposition_count ?? 0],
        ['Debt-to-Income Ratio', s.dtiPts ?? 0, 20, s.dtiRatio != null ? (s.dtiRatio * 100).toFixed(1) + '%' : '—'],
        ['Income Regularity', s.regPts ?? 0, 15, s.incomeRegularity || '—'],
        ['Income Mismatch', s.misPts ?? 0, 10, s.misRatio != null ? (s.misRatio * 100).toFixed(1) + '%' : '—'],
        ['Balance Cushion', s.balPts ?? 0, 10, application.avg_daily_balance ? fmt$(application.avg_daily_balance) : '—'],
      ];

      // Table header
      doc.save().rect(50, y, 495, 16).fill([30, 25, 70]).restore();
      doc.save()
        .fillColor(C.lightGrey).fontSize(7).font('Helvetica-Bold')
        .text('Signal', 56, y + 5, { width: 160 })
        .text('Value', 220, y + 5, { width: 100, align: 'right' })
        .text('Points', 330, y + 5, { width: 60, align: 'right' })
        .text('Max', 400, y + 5, { width: 40, align: 'right' })
        .text('Bar', 450, y + 5, { width: 90 })
        .restore();
      y += 18;

      signals.forEach(([ label, pts, maxPts, value ], idx) => {
        const bg = idx % 2 === 0 ? [16, 14, 42] : [20, 18, 50];
        const pct = Math.round((pts / maxPts) * 80);
        const barColor = pts === 0 ? C.teal : pts < maxPts * 0.5 ? C.gold : C.coral;
        doc.save().rect(50, y, 495, 18).fill(bg).restore();
        doc.save()
          .fillColor(C.lightGrey).fontSize(8).font('Helvetica')
          .text(label, 56, y + 5, { width: 160 })
          .text(String(value), 220, y + 5, { width: 100, align: 'right' })
          .fillColor(barColor).font('Helvetica-Bold')
          .text(`${pts}`, 330, y + 5, { width: 60, align: 'right' })
          .fillColor(C.midGrey).font('Helvetica')
          .text(`/ ${maxPts}`, 400, y + 5, { width: 40, align: 'right' })
          .restore();
        // Progress bar
        doc.save()
          .rect(452, y + 6, 80, 6).fill([30, 25, 70])
          .rect(452, y + 6, pct, 6).fill(barColor)
          .restore();
        y += 19;
      });

      // Total score row
      const totalPts = signals.reduce((s, r) => s + r[1], 0);
      const totalMax  = signals.reduce((s, r) => s + r[2], 0);
      doc.save().rect(50, y, 495, 20).fill(C.purple).restore();
      doc.save()
        .fillColor(C.white).fontSize(8.5).font('Helvetica-Bold')
        .text('TOTAL RISK SCORE', 56, y + 6, { width: 270 })
        .text(String(application.risk_score ?? totalPts), 330, y + 6, { width: 60, align: 'right' })
        .text('/ 100', 400, y + 6, { width: 40, align: 'right' })
        .restore();
      y += 28;
    }

    // Analyst flags
    if (application.flags && application.flags.length > 0) {
      y = sectionHeader(doc, 'ANALYST FLAGS', y);
      application.flags.forEach(flag => {
        doc.save()
          .fillColor(C.gold).fontSize(8).font('Helvetica')
          .text('⚑ ' + flag, 56, y, { width: 483 })
          .restore();
        y += 14;
      });
      y += 6;
    }

    // Disclaimer
    rule(doc, y); y += 10;
    doc.save()
      .fillColor(C.darkGrey).fontSize(6.5).font('Helvetica')
      .text(
        'This Bank Verification Report was generated using data provided by Flinks, a licensed Open Banking platform. ' +
        'The analysis reflects the 90-day lookback period ending on the application date. ' +
        'This report is confidential and for authorized Waves Financial use only. ' +
        'It does not constitute a full bank statement and should be used solely for credit adjudication purposes.',
        50, y, { width: 495 }
      )
      .restore();

    pageFooter(doc, doc.bufferedPageRange().count);
    doc.end();
  });
}


module.exports = { generateContractPDF, generateBankReportPDF };
