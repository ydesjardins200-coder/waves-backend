'use strict';

/**
 * Waves Financial — Backend Server
 *
 * Endpoints:
 *   POST /api/apply/new      — New loan application
 *   POST /api/apply/renewal  — Loan renewal application
 *   GET  /health             — Health check
 */

const http    = require('http');
const { resolveApplication } = require('./decisionResolver');
const {
  saveApplication,
  updateClientStats,
  createLoan,
  createRepaymentSchedule,
  createContract,
} = require('./db');
const { generateContractPDF, generateBankReportPDF } = require('./pdfGenerator');
const { supabase } = require('./supabaseClient');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// In development, allow localhost origins automatically
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8888');
}


// ─── HELPERS ──────────────────────────────────────────────────────────────────

function setCORSHeaders(req, res) {
  const origin = req.headers['origin'];
  const allowAll = ALLOWED_ORIGINS.length === 0; // no list configured → open (dev mode)
  if (origin && (allowAll || ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV !== 'production')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (allowAll) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Graceful fallback response — never let the applicant see a broken experience
function fallbackResponse(ref) {
  return {
    ref,
    decision:       'manual_review',
    tier:           'green',
    score:          null,
    approvedAmount: null,
    message:        'Your application is under review.',
    nextSteps: [
      'Our team will review your application during business hours.',
      'You will receive an email with our decision shortly.',
    ],
  };
}

// Validate that the minimum required fields are present
function validatePayload(body, type) {
  const errors = [];

  if (!body?.personal?.firstName)  errors.push('personal.firstName is required');
  if (!body?.personal?.lastName)   errors.push('personal.lastName is required');
  if (!body?.personal?.email)      errors.push('personal.email is required');
  if (!body?.loan?.amount)         errors.push('loan.amount is required');
  if (!body?.banking?.flinksLoginId) errors.push('banking.flinksLoginId is required');

  if (type === 'new') {
    if (!body?.employment?.payFrequency) errors.push('employment.payFrequency is required');
    if (!body?.employment?.nextPay)      errors.push('employment.nextPay is required');
  }

  return errors;
}

// Generate a reference number: WF-XXXXXX
function generateRef() {
  return 'WF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}


// ─── REQUEST HANDLER ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setCORSHeaders(req, res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Debug endpoint — test Supabase connection
  if (req.method === 'GET' && req.url === '/debug') {
    const { supabase } = require('./supabaseClient');
    const result = {
      supabase_url_set:     !!process.env.SUPABASE_URL,
      supabase_key_set:     !!process.env.SUPABASE_API_KEY,
      supabase_client:      !!supabase,
      node_env:             process.env.NODE_ENV,
      allowed_origins:      process.env.ALLOWED_ORIGINS || '(not set)',
    };
    if (supabase) {
      try {
        const { data, error } = await supabase.from('applications').select('id').limit(1);
        result.supabase_query = error ? ('ERROR: ' + error.message) : 'OK — table reachable';
        result.row_count_sample = data ? data.length : 0;
      } catch(e) {
        result.supabase_query = 'EXCEPTION: ' + e.message;
      }
    }
    sendJSON(res, 200, result);
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, {
      status: 'ok',
      env:    process.env.NODE_ENV || 'development',
      time:   new Date().toISOString(),
    });
    return;
  }

  // ── POST /api/apply/new ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/apply/new') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid request body' });
      return;
    }

    // Attach ref and timestamp if not present
    body.ref         = body.ref || generateRef();
    body.submittedAt = body.submittedAt || new Date().toISOString();
    body.type        = 'new';

    // Validate
    const errors = validatePayload(body, 'new');
    if (errors.length) {
      sendJSON(res, 422, { error: 'Validation failed', details: errors });
      return;
    }

    console.log(`[new] ${body.ref} — ${body.personal.firstName} ${body.personal.lastName} — $${body.loan.amount}`);

    try {
      const decision = await resolveApplication(body);
      console.log(`[new] ${body.ref} → ${decision.decision} (tier: ${decision.tier}, score: ${decision.score})`);
      sendJSON(res, 200, decision);
    } catch (err) {
      console.error(`[new] ${body.ref} pipeline error:`, err.message);
      sendJSON(res, 200, fallbackResponse(body.ref));
    }
    return;
  }

  // ── POST /api/apply/renewal ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/apply/renewal') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid request body' });
      return;
    }

    body.ref         = body.ref || generateRef();
    body.submittedAt = body.submittedAt || new Date().toISOString();
    body.type        = 'renewal';

    const errors = validatePayload(body, 'renewal');
    if (errors.length) {
      sendJSON(res, 422, { error: 'Validation failed', details: errors });
      return;
    }

    console.log(`[renewal] ${body.ref} — ${body.personal.firstName} ${body.personal.lastName} — $${body.loan.amount}`);

    try {
      const decision = await resolveApplication(body);
      console.log(`[renewal] ${body.ref} → ${decision.decision} (tier: ${decision.tier}, score: ${decision.score})`);
      sendJSON(res, 200, decision);
    } catch (err) {
      console.error(`[renewal] ${body.ref} pipeline error:`, err.message);
      sendJSON(res, 200, fallbackResponse(body.ref));
    }
    return;
  }

  // ── GET /api/pdf/contract/:loanId ──────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/pdf/contract/')) {
    const loanId = req.url.split('/api/pdf/contract/')[1]?.split('?')[0];
    if (!loanId) { sendJSON(res, 400, { error: 'loanId required' }); return; }

    try {
      // Fetch contract + schedule + client
      const [contractRes, schedRes] = await Promise.all([
        supabase.from('contracts').select('*, loans(ref, client_id)').eq('loan_id', loanId).single(),
        supabase.from('repayment_schedule').select('*').eq('loan_id', loanId).order('payment_number'),
      ]);
      if (contractRes.error) { sendJSON(res, 404, { error: 'Contract not found' }); return; }

      const contract = { ...contractRes.data, loan_ref: contractRes.data.loans?.ref };
      const clientId = contractRes.data.loans?.client_id;
      const clientRes = clientId
        ? await supabase.from('clients').select('*').eq('id', clientId).single()
        : { data: {} };

      const pdf = await generateContractPDF(contract, clientRes.data || {}, schedRes.data || []);

      const filename = `contract-${contract.loan_ref || loanId}.pdf`;
      res.writeHead(200, {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      pdf.length,
      });
      res.end(pdf);
    } catch (err) {
      console.error('[pdf/contract] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/pdf/bank-report/:applicationId ─────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/pdf/bank-report/')) {
    const appId = req.url.split('/api/pdf/bank-report/')[1]?.split('?')[0];
    if (!appId) { sendJSON(res, 400, { error: 'applicationId required' }); return; }

    try {
      const appRes = await supabase.from('loan_applications').select('*').eq('id', appId).single();
      if (appRes.error) { sendJSON(res, 404, { error: 'Application not found' }); return; }

      const app = appRes.data;
      const clientRes = app.client_id
        ? await supabase.from('clients').select('*').eq('id', app.client_id).single()
        : { data: {} };

      const pdf = await generateBankReportPDF(app, clientRes.data || {});

      const filename = `bank-report-${app.ref || appId}.pdf`;
      res.writeHead(200, {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      pdf.length,
      });
      res.end(pdf);
    } catch (err) {
      console.error('[pdf/bank-report] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/approve ──────────────────────────────────────────────────────
  // Full approval flow: stamp application → update loan → generate schedule + contract → update client stats
  if (req.method === 'POST' && req.url === '/api/approve') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { applicationId, analystNote } = body;
    if (!applicationId) { sendJSON(res, 400, { error: 'applicationId required' }); return; }

    try {
      // 1. Load the application
      const { data: app, error: appErr } = await supabase
        .from('loan_applications').select('*').eq('id', applicationId).single();
      if (appErr || !app) { sendJSON(res, 404, { error: 'Application not found' }); return; }

      // 2. Load the client
      const { data: client } = await supabase
        .from('clients').select('*').eq('id', app.client_id).single();
      if (!client) { sendJSON(res, 404, { error: 'Client not found' }); return; }

      // 3. Determine the approved amount (analyst may have overridden it)
      const approvedAmount = app.approved_amount || app.requested_amount;
      if (!approvedAmount || approvedAmount <= 0) {
        sendJSON(res, 400, { error: 'No valid approved amount on application' }); return;
      }

      const APR           = 0.23;
      const TERM_DAYS     = 112;
      const PAYMENT_COUNT = 8;
      const paymentAmt    = parseFloat(((approvedAmount * (1 + APR * TERM_DAYS / 365)) / PAYMENT_COUNT).toFixed(2));
      const totalRepayable = parseFloat((paymentAmt * PAYMENT_COUNT).toFixed(2));

      // 4. Check if a loan record already exists for this application
      const { data: existingLoan } = await supabase
        .from('loans').select('id, status').eq('ref', app.ref).single().catch(() => ({ data: null }));

      let loanId;

      if (existingLoan) {
        // Update the existing loan with approved amount + set to pending_disbursement
        await supabase.from('loans').update({
          status:            'pending_disbursement',
          principal:         approvedAmount,
          payment_amount:    paymentAmt,
          total_repayable:   totalRepayable,
          remaining_balance: totalRepayable,
          total_paid:        0,
          apr:               APR,
        }).eq('id', existingLoan.id);
        loanId = existingLoan.id;
      } else {
        // Create a brand-new loan record
        const { data: newLoan, error: loanErr } = await supabase.from('loans').insert({
          client_id:         app.client_id,
          application_id:    app.id,
          ref:               app.ref,
          type:              app.type || 'new',
          principal:         approvedAmount,
          apr:               APR,
          term_days:         TERM_DAYS,
          payment_count:     PAYMENT_COUNT,
          payment_frequency: app.pay_frequency || 'biweekly',
          payment_amount:    paymentAmt,
          total_repayable:   totalRepayable,
          remaining_balance: totalRepayable,
          total_paid:        0,
          status:            'pending_disbursement',
          fund_method:       app.fund_method,
        }).select('id, ref, principal, payment_amount, total_repayable, payment_count').single();
        if (loanErr) throw new Error('Loan create failed: ' + loanErr.message);
        loanId = newLoan.id;
      }

      // 5. Generate repayment schedule (delete old one first if exists)
      await supabase.from('repayment_schedule').delete().eq('loan_id', loanId);

      const nextPay      = app.next_pay_date;
      const BIWEEKLY     = 14;
      const intervalDays = app.pay_frequency === 'weekly' ? 7
        : app.pay_frequency === 'monthly' ? 30
        : app.pay_frequency === 'semi-monthly' ? 15
        : BIWEEKLY;

      let d = nextPay ? new Date(nextPay) : new Date();
      const today = new Date();
      if (d <= today) d = new Date(today.getTime() + intervalDays * 86400000);

      const scheduleRows = [];
      for (let i = 0; i < PAYMENT_COUNT; i++) {
        scheduleRows.push({
          loan_id:          loanId,
          client_id:        app.client_id,
          payment_number:   i + 1,
          due_date:         d.toISOString().slice(0, 10),
          scheduled_amount: paymentAmt,
          status:           'scheduled',
        });
        d = new Date(d.getTime() + intervalDays * 86400000);
      }
      const finalDate = scheduleRows[scheduleRows.length - 1].due_date;
      await supabase.from('repayment_schedule').insert(scheduleRows);
      await supabase.from('loans').update({ due_date: finalDate }).eq('id', loanId);

      // 6. Create / update contract
      await supabase.from('contracts').delete().eq('loan_id', loanId);
      await supabase.from('contracts').insert({
        loan_id:            loanId,
        client_id:          app.client_id,
        application_id:     app.id,
        principal:          approvedAmount,
        apr:                APR,
        term_days:          TERM_DAYS,
        payment_count:      PAYMENT_COUNT,
        payment_amount:     paymentAmt,
        total_repayable:    totalRepayable,
        payment_frequency:  app.pay_frequency || 'biweekly',
        first_payment_date: scheduleRows[0].due_date,
        final_payment_date: finalDate,
        fund_method:        app.fund_method,
        borrower_name:      `${client.first_name || ''} ${client.last_name || ''}`.trim(),
        borrower_email:     client.email,
        borrower_address:   [client.address, client.apt, client.city, client.province, client.postal].filter(Boolean).join(', '),
        borrower_province:  client.province,
        esig_name:          app.esig_name,
        esig_timestamp:     app.esig_timestamp,
        pad_authorized:     true,
        pad_institution:    app.bank_name,
      });

      // 7. Stamp the application as reviewed + approved
      const now = new Date().toISOString();
      await supabase.from('loan_applications').update({
        reviewed_at:     now,
        reviewed_by:     'analyst',
        final_decision:  'approved',
        approved_amount: approvedAmount,
      }).eq('id', applicationId);

      // 8. Save analyst note if provided
      if (analystNote?.trim()) {
        await supabase.from('application_notes').insert({
          application_id: applicationId,
          client_id:      app.client_id,
          agent:          'analyst',
          note:           analystNote.trim(),
        });
        // Also add a client-level note for the approval
        await supabase.from('client_notes').insert({
          client_id: app.client_id,
          agent:     'analyst',
          note:      `Loan ${app.ref} approved for $${approvedAmount.toLocaleString()}. ${analystNote.trim()}`,
          context:   'approval',
        });
      } else {
        // Auto-log the approval in client notes
        await supabase.from('client_notes').insert({
          client_id: app.client_id,
          agent:     'system',
          note:      `Loan ${app.ref} approved for $${approvedAmount.toLocaleString()} — pending disbursement.`,
          context:   'approval',
        });
      }

      // 9. Update client stats + latest tier
      const { count: appCount } = await supabase
        .from('loan_applications').select('id', { count: 'exact' }).eq('client_id', app.client_id);
      const { data: allLoans } = await supabase
        .from('loans').select('principal, total_paid').eq('client_id', app.client_id);
      await supabase.from('clients').update({
        total_applications: appCount ?? 0,
        total_loans:        allLoans?.length ?? 0,
        total_borrowed:     allLoans?.reduce((s, l) => s + parseFloat(l.principal || 0), 0) ?? 0,
        total_repaid:       allLoans?.reduce((s, l) => s + parseFloat(l.total_paid || 0), 0) ?? 0,
        latest_tier:        app.tier,
      }).eq('id', app.client_id);

      console.log(`[approve] ${app.ref} approved — $${approvedAmount} — loan ${loanId}`);
      sendJSON(res, 200, {
        ok:              true,
        loanId,
        approvedAmount,
        paymentAmount:   paymentAmt,
        totalRepayable,
        scheduleCount:   scheduleRows.length,
        firstPayment:    scheduleRows[0].due_date,
        finalPayment:    finalDate,
      });
    } catch (err) {
      console.error('[approve] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/decline ──────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/decline') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { applicationId, analystNote } = body;
    if (!applicationId) { sendJSON(res, 400, { error: 'applicationId required' }); return; }

    try {
      const { data: app } = await supabase
        .from('loan_applications').select('ref, client_id, tier').eq('id', applicationId).single();
      if (!app) { sendJSON(res, 404, { error: 'Application not found' }); return; }

      const now = new Date().toISOString();
      await supabase.from('loan_applications').update({
        reviewed_at:    now,
        reviewed_by:    'analyst',
        final_decision: 'declined',
      }).eq('id', applicationId);

      // Cancel the pending loan if one exists
      await supabase.from('loans')
        .update({ status: 'cancelled' })
        .eq('ref', app.ref)
        .eq('status', 'pending_disbursement');

      // Log note
      const noteText = analystNote?.trim() || `Loan ${app.ref} declined by analyst.`;
      await supabase.from('client_notes').insert({
        client_id: app.client_id,
        agent:     'analyst',
        note:      noteText,
        context:   'decline',
      });
      if (analystNote?.trim()) {
        await supabase.from('application_notes').insert({
          application_id: applicationId,
          client_id:      app.client_id,
          agent:          'analyst',
          note:           analystNote.trim(),
        });
      }

      // Update client stats
      const { count: appCount } = await supabase
        .from('loan_applications').select('id', { count: 'exact' }).eq('client_id', app.client_id);
      await supabase.from('clients').update({
        total_applications: appCount ?? 0,
        latest_tier:        app.tier,
      }).eq('id', app.client_id);

      console.log(`[decline] ${app.ref} declined`);
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      console.error('[decline] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // 404 for everything else
  sendJSON(res, 404, { error: 'Not found' });
}


// ─── START ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n✅ Waves Financial backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   New loan:    POST http://localhost:${PORT}/api/apply/new`);
  console.log(`   Renewal:     POST http://localhost:${PORT}/api/apply/renewal\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down gracefully');
  server.close(() => process.exit(0));
});
