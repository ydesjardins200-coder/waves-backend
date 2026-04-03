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
const { generateDRD, generatePAD, nextBusinessDay } = require('./drdGenerator');
const { processReturnFile, getRetryQueue, RETURN_CODES } = require('./returnProcessor');
const { fetchCreditReport, getAccessToken } = require('./equifaxClient');
const vopay = require('./vopayClient');

// ── PAYMENT PROCESSOR STATE ───────────────────────────────────────────────────
// Persisted in memory — survives restarts via PAYMENT_PROCESSOR env var
// Admin can switch via POST /api/processor/set
let activeProcessor = process.env.PAYMENT_PROCESSOR || 'manual'; // 'manual' | 'vopay'
console.log(`[processor] Active payment processor: ${activeProcessor}`);

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Confirmed-By');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-PAD-Summary, X-DRD-Summary, X-Retry-Summary');
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

    // ── Normalize renewal payload to match new loan field shape ──────────
    if (!body.personal) body.personal = {};

    // Flatten address changes into personal
    if (body.address) {
      if (body.address.changed === 'yes' || body.address.changed === true) {
        body.personal.address  = body.address.address  || body.personal.address;
        body.personal.city     = body.address.city     || body.personal.city;
        body.personal.province = body.address.province || body.personal.province;
        body.personal.postal   = body.address.postal   || body.personal.postal;
      }
    }

    // Normalize banking field names
    if (body.banking) {
      body.banking.transitNumber     = body.banking.transit     || body.banking.transitNumber;
      body.banking.institutionNumber = body.banking.institution || body.banking.institutionNumber;
      body.banking.accountNumber     = body.banking.account     || body.banking.accountNumber;
      body.banking.institution       = body.banking.flinksInstitution || body.banking.institution;
      body.banking.sandbox           = !!body.banking.sandbox;
    }

    // Normalize employment field names
    if (body.employment) {
      body.employment.source       = body.employment.source || body.employment.employmentStatus;
      body.employment.payFrequency = body.employment.payFrequency || body.employment.payFreq;
    }

    // Look up existing client by email and inherit missing fields
    if (body.personal?.email) {
      try {
        const { data: existingClient } = await supabase
          .from('clients')
          .select('*')
          .eq('email', body.personal.email.toLowerCase().trim())
          .single();

        if (existingClient) {
          console.log(`[renewal] Matched existing client ${existingClient.id.slice(0,8)} — ${existingClient.first_name} ${existingClient.last_name}`);
          // Personal — inherit what renewal form doesn't collect
          body.personal.apt              = body.personal.apt              || existingClient.apt;
          body.personal.sin              = body.personal.sin              || existingClient.sin;
          body.personal.sex              = body.personal.sex              || existingClient.sex;
          body.personal.dob              = body.personal.dob              || existingClient.dob;
          body.personal.cellPhone        = body.personal.cellPhone        || existingClient.cell_phone;
          body.personal.homePhone        = body.personal.homePhone        || existingClient.home_phone;
          body.personal.declaredIncome   = body.personal.declaredIncome   || existingClient.declared_monthly_income;
          // Address — inherit if renewal didn't update it
          if (!body.personal.address) {
            body.personal.address  = existingClient.address;
            body.personal.city     = existingClient.city;
            body.personal.province = existingClient.province;
            body.personal.postal   = existingClient.postal;
          }
          // Employment — inherit from client record if not on renewal form
          if (!body.employment) body.employment = {};
          body.employment.source       = body.employment.source    || existingClient.employment_status;
          body.employment.employer     = body.employment.employer  || existingClient.employer;
          body.employment.workPhone    = body.employment.workPhone || existingClient.work_phone;
          body.employment.jobDesc      = body.employment.jobDesc   || existingClient.job_desc;
          body.employment.hireDate     = body.employment.hireDate  || existingClient.hire_date;
          body.employment.paidBy       = body.employment.paidBy    || existingClient.paid_by;
          // Banking — inherit if renewal didn't update it
          if (body.banking && !body.banking.transitNumber && existingClient.bank_transit) {
            body.banking.transitNumber     = existingClient.bank_transit;
            body.banking.institutionNumber = existingClient.bank_institution;
            body.banking.accountNumber     = existingClient.bank_account;
            body.banking.institution       = existingClient.bank_name || body.banking.institution;
          }
          body._existingClientId = existingClient.id;
        } else {
          console.log(`[renewal] No existing client for ${body.personal.email} — will create new`);
        }
      } catch (lookupErr) {
        console.warn('[renewal] Client lookup skipped (non-fatal):', lookupErr.message);
      }
    }

    const errors = validatePayload(body, 'renewal');
    if (errors.length) {
      sendJSON(res, 422, { error: 'Validation failed', details: errors });
      return;
    }

    console.log(`[renewal] ${body.ref} — ${body.personal.firstName} ${body.personal.lastName} — $${body.loan.amount}${body._existingClientId ? ' (existing client)' : ' (new client)'}`);

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
      console.log('[approve] Step 1 — loading application', applicationId);
      const { data: app, error: appErr } = await supabase
        .from('loan_applications').select('*').eq('id', applicationId).single();
      if (appErr || !app) { sendJSON(res, 404, { error: 'Application not found: ' + (appErr?.message||'null') }); return; }
      console.log('[approve] App loaded:', app.ref, 'client:', app.client_id);

      // 2. Load the client
      console.log('[approve] Step 2 — loading client', app.client_id);
      const { data: client, error: clientErr } = await supabase
        .from('clients').select('*').eq('id', app.client_id).single();
      if (!client) { sendJSON(res, 404, { error: 'Client not found: ' + (clientErr?.message||'null') }); return; }

      // 3. Determine the approved amount (analyst may have overridden it)
      const approvedAmount = app.approved_amount || app.requested_amount;
      console.log('[approve] Step 3 — approved amount:', approvedAmount);
      if (!approvedAmount || approvedAmount <= 0) {
        sendJSON(res, 400, { error: 'No valid approved amount on application' }); return;
      }

      const APR           = 0.23;
      const TERM_DAYS     = 112;
      const PAYMENT_COUNT = 8;
      const paymentAmt    = parseFloat(((approvedAmount * (1 + APR * TERM_DAYS / 365)) / PAYMENT_COUNT).toFixed(2));
      const totalRepayable = parseFloat((paymentAmt * PAYMENT_COUNT).toFixed(2));

      console.log('[approve] Step 4 — checking for existing loan ref:', app.ref);
      // 4. Check if a loan record already exists for this application
      const { data: existingLoan } = await supabase
        .from('loans').select('id, status').eq('ref', app.ref).maybeSingle();

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

      console.log('[approve] Step 5 — generating schedule, loanId:', loanId);
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

      console.log('[approve] Step 6 — creating contract');
      // 6. Create / update contract
      await supabase.from('contracts').delete().eq('loan_id', loanId);
      await supabase.from('contracts').insert({
        loan_id:            loanId,
        client_id:          app.client_id,
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

      console.log('[approve] Step 7 — stamping application');
      // 7. Stamp the application as reviewed + approved
      const now = new Date().toISOString();
      await supabase.from('loan_applications').update({
        reviewed_at:     now,
        reviewed_by:     'analyst',
        final_decision:  'approved',
        approved_amount: approvedAmount,
      }).eq('id', applicationId);

      console.log('[approve] Step 8 — saving notes');
      // 8. Save analyst note if provided (non-fatal — tables may not exist yet)
      try {
        if (analystNote?.trim()) {
          await supabase.from('application_notes').insert({
            application_id: applicationId,
            client_id:      app.client_id,
            agent:          'analyst',
            note:           analystNote.trim(),
          });
          await supabase.from('client_notes').insert({
            client_id: app.client_id,
            agent:     'analyst',
            note:      `Loan ${app.ref} approved for $${approvedAmount.toLocaleString()}. ${analystNote.trim()}`,
            context:   'approval',
          });
        } else {
          await supabase.from('client_notes').insert({
            client_id: app.client_id,
            agent:     'system',
            note:      `Loan ${app.ref} approved for $${approvedAmount.toLocaleString()} — pending disbursement.`,
            context:   'approval',
          });
        }
      } catch (noteErr) {
        console.warn('[approve] Note write skipped (tables may not exist):', noteErr.message);
      }

      console.log('[approve] Step 9 — updating client stats');
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

      // Log note (non-fatal)
      try {
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
      } catch (noteErr) {
        console.warn('[decline] Note write skipped:', noteErr.message);
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

  // ── GET /api/eft/pending ────────────────────────────────────────────────────
  // Returns JSON list of all pending_disbursement loans with banking coords
  if (req.method === 'GET' && req.url.startsWith('/api/eft/pending')) {
    try {
      const { data: loans, error } = await supabase
        .from('loans')
        .select('id, ref, principal, client_id, status, fund_method')
        .eq('status', 'pending_disbursement')
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Enrich with client + application banking coords
      const enriched = [];
      for (const loan of (loans || [])) {
        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, email, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};

        // Prefer application-level coords (most recent), fall back to client record
        enriched.push({
          loanId:              loan.id,
          ref:                 loan.ref,
          amount:              loan.principal,
          fundMethod:          loan.fund_method,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—',
          borrowerEmail:       client.email || '',
          borrowerTransit:     app.bank_transit      || client.bank_transit      || null,
          borrowerInstitution: app.bank_institution  || client.bank_institution  || null,
          borrowerAccount:     app.bank_account      || client.bank_account      || null,
          hasBankingCoords:    !!(app.bank_transit || client.bank_transit),
        });
      }

      sendJSON(res, 200, {
        count:      enriched.length,
        effectiveDate: nextBusinessDay().toISOString().slice(0, 10),
        loans:      enriched,
      });
    } catch (err) {
      console.error('[eft/pending] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/drd ────────────────────────────────────────────────────────
  // Generates and downloads a Desjardins DRD (CPA 005) file for all
  // pending_disbursement loans. Optionally pass ?loanIds=id1,id2 to subset.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/drd')) {
    try {
      const urlObj   = new URL(req.url, 'http://localhost');
      const loanIds  = urlObj.searchParams.get('loanIds')?.split(',').filter(Boolean) || [];
      const fileNum  = parseInt(urlObj.searchParams.get('fileNum') || '1');
      const effDate  = urlObj.searchParams.get('effectiveDate')
        ? new Date(urlObj.searchParams.get('effectiveDate'))
        : nextBusinessDay();

      // Load loans
      let query = supabase
        .from('loans')
        .select('id, ref, principal, client_id, fund_method, status')
        .eq('status', 'pending_disbursement')
        .order('created_at', { ascending: true });

      if (loanIds.length) query = query.in('id', loanIds);
      const { data: loans, error } = await query;
      if (error) throw error;
      if (!loans || !loans.length) {
        sendJSON(res, 200, { message: 'No pending loans found', content: null }); return;
      }

      // Enrich with banking coords
      const drdLoans = [];
      for (const loan of loans) {
        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};
        drdLoans.push({
          ref:                 loan.ref,
          amount:              loan.principal,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim(),
          borrowerTransit:     app.bank_transit      || client.bank_transit,
          borrowerInstitution: app.bank_institution  || client.bank_institution,
          borrowerAccount:     app.bank_account      || client.bank_account,
        });
      }

      const { filename, content, summary, errors } = generateDRD(drdLoans, { effectiveDate: effDate, fileNumber: fileNum });

      if (!content) {
        sendJSON(res, 400, { error: 'No valid loans — missing banking coordinates', errors }); return;
      }

      // Log any skipped loans
      if (errors.length) console.warn('[eft/drd] Skipped loans:', errors);

      const buf = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'Content-Type':        'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      buf.length,
        'X-DRD-Summary':       JSON.stringify(summary),
      });
      res.end(buf);
      console.log(`[eft/drd] Generated ${filename} — ${summary.transactionCount} loans — $${summary.totalAmount}`);
    } catch (err) {
      console.error('[eft/drd] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/pads/preview ──────────────────────────────────────────────
  // SAFE: Read-only preview. Never stamps anything. Use this to review before generating.
  // Returns all unsubmitted scheduled payments due within next N days.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/pads/preview')) {
    try {
      const urlObj    = new URL(req.url, 'http://localhost');
      const daysAhead = parseInt(urlObj.searchParams.get('days') || '5');
      const cutoff    = new Date();
      cutoff.setDate(cutoff.getDate() + daysAhead);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const { data: schedRows, error } = await supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, status, eft_submitted_at, eft_file')
        .eq('status', 'scheduled')
        .is('eft_submitted_at', null)          // ← NEVER SUBMITTED
        .lte('due_date', cutoffStr)
        .order('due_date', { ascending: true });

      if (error) throw error;

      const enriched = [];
      for (const row of (schedRows || [])) {
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id').eq('id', row.loan_id).single();
        if (!loan) continue;
        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, email, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};
        enriched.push({
          scheduleId:          row.id,
          ref:                 loan.ref,
          paymentNumber:       row.payment_number,
          amount:              row.scheduled_amount,
          dueDate:             row.due_date,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—',
          borrowerEmail:       client.email || '',
          borrowerTransit:     app.bank_transit     || client.bank_transit     || null,
          borrowerInstitution: app.bank_institution || client.bank_institution || null,
          borrowerAccount:     app.bank_account     || client.bank_account     || null,
          hasBankingCoords:    !!(app.bank_transit  || client.bank_transit),
        });
      }

      const total = enriched.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      sendJSON(res, 200, {
        count:         enriched.length,
        totalAmount:   total.toFixed(2),
        cutoffDate:    cutoffStr,
        effectiveDate: nextBusinessDay().toISOString().slice(0, 10),
        payments:      enriched,
        warning:       enriched.length === 0 ? 'No unsubmitted payments due in this window' : null,
      });
    } catch (err) {
      console.error('[eft/pads/preview] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/pads/pending ───────────────────────────────────────────────
  // Legacy alias for /preview — same behaviour, read-only.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/pads/pending')) {
    try {
      const urlObj   = new URL(req.url, 'http://localhost');
      const daysAhead = parseInt(urlObj.searchParams.get('days') || '5');
      const cutoff    = new Date();
      cutoff.setDate(cutoff.getDate() + daysAhead);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      // Load scheduled payments due on or before cutoff
      const { data: schedRows, error } = await supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, status')
        .eq('status', 'scheduled')
        .lte('due_date', cutoffStr)
        .order('due_date', { ascending: true });

      if (error) throw error;

      // Enrich each payment with client banking coords via the loan
      const enriched = [];
      for (const row of (schedRows || [])) {
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id').eq('id', row.loan_id).single();
        if (!loan) continue;

        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, email, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};

        enriched.push({
          scheduleId:          row.id,
          loanId:              row.loan_id,
          ref:                 loan.ref,
          paymentNumber:       row.payment_number,
          amount:              row.scheduled_amount,
          dueDate:             row.due_date,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—',
          borrowerEmail:       client.email || '',
          borrowerTransit:     app.bank_transit      || client.bank_transit      || null,
          borrowerInstitution: app.bank_institution  || client.bank_institution  || null,
          borrowerAccount:     app.bank_account      || client.bank_account      || null,
          hasBankingCoords:    !!(app.bank_transit || client.bank_transit),
        });
      }

      const total = enriched.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      sendJSON(res, 200, {
        count:         enriched.length,
        totalAmount:   total.toFixed(2),
        cutoffDate:    cutoffStr,
        effectiveDate: nextBusinessDay().toISOString().slice(0, 10),
        payments:      enriched,
      });
    } catch (err) {
      console.error('[eft/pads/pending] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/pad/generate ─────────────────────────────────────────────
  // DESTRUCTIVE: Generates + stamps. Must be POST to prevent accidental double-trigger.
  // Body: { days: 5, scheduleIds: [...], fileNum: 1, confirmedBy: 'analyst' }
  //
  // Safety locks:
  //   1. POST only — GET requests cannot generate files
  //   2. Filters eft_submitted_at IS NULL — already-stamped rows are excluded
  //   3. Atomic stamp — marks rows BEFORE returning the file (prevents race)
  //   4. confirmedBy required — human must explicitly confirm
  //   5. Idempotency key — same scheduleIds always produce same filename
  if (req.method === 'POST' && req.url === '/api/eft/pad/generate') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { days = 5, scheduleIds = [], fileNum = 1, confirmedBy } = body;

    if (!confirmedBy || !confirmedBy.trim()) {
      sendJSON(res, 400, { error: 'confirmedBy is required — pass the analyst name who approved this run' });
      return;
    }

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + parseInt(days));
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      // ── LOCK: query only unsubmitted rows ──────────────────────────────────
      let query = supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, status, eft_submitted_at')
        .eq('status', 'scheduled')
        .is('eft_submitted_at', null)           // CRITICAL: exclude already submitted
        .lte('due_date', cutoffStr)
        .order('due_date', { ascending: true });

      if (scheduleIds.length) query = query.in('id', scheduleIds);
      const { data: schedRows, error: fetchErr } = await query;
      if (fetchErr) throw fetchErr;

      if (!schedRows || !schedRows.length) {
        sendJSON(res, 200, { message: 'No unsubmitted payments due in this window — nothing generated', filename: null });
        return;
      }

      // ── ENRICH with banking coords ─────────────────────────────────────────
      const padPayments = [];
      const rowIds      = [];
      for (const row of schedRows) {
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id').eq('id', row.loan_id).single();
        if (!loan) { console.warn(`[eft/pad] No loan for schedule ${row.id} — skipped`); continue; }

        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};

        padPayments.push({
          ref:                 loan.ref,
          paymentNumber:       row.payment_number,
          amount:              row.scheduled_amount,
          dueDate:             row.due_date,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim(),
          borrowerTransit:     app.bank_transit     || client.bank_transit,
          borrowerInstitution: app.bank_institution || client.bank_institution,
          borrowerAccount:     app.bank_account     || client.bank_account,
        });
        rowIds.push(row.id);
      }

      if (!padPayments.length) {
        sendJSON(res, 400, { error: 'No valid payments — all are missing banking coordinates' });
        return;
      }

      // ── GENERATE FILE ──────────────────────────────────────────────────────
      const { filename, content, summary, errors } = generatePAD(padPayments, { fileNumber: parseInt(fileNum) });

      if (!content || !filename) {
        sendJSON(res, 400, { error: 'File generation failed', errors });
        return;
      }

      // ── ATOMIC STAMP — mark as submitted BEFORE returning file ────────────
      // If the stamp fails, we abort and do NOT return the file.
      // This means no file is sent if we can't record the submission.
      const stampedAt = new Date().toISOString();
      const { error: stampErr } = await supabase
        .from('repayment_schedule')
        .update({
          eft_submitted_at: stampedAt,
          eft_file:         filename,
        })
        .in('id', rowIds);

      if (stampErr) {
        // CRITICAL: Do NOT send the file if we can't stamp.
        console.error('[eft/pad] STAMP FAILED — file NOT sent to prevent duplicate:', stampErr.message);
        sendJSON(res, 500, {
          error: 'Could not record submission — file NOT generated to prevent duplicate PAD. Fix DB connection and retry.',
          detail: stampErr.message,
        });
        return;
      }

      // Log skipped payments (missing coords) — these were NOT included
      if (errors.length) {
        console.warn(`[eft/pad] ${errors.length} payment(s) skipped (missing coords):`, errors);
      }

      console.log(`[eft/pad] ✅ Generated + stamped: ${filename} — ${summary.transactionCount} payments — $${summary.totalAmount} — by ${confirmedBy}`);

      // Return file as download
      const buf = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'Content-Type':        'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      buf.length,
        'X-PAD-Summary':       JSON.stringify({ ...summary, stampedAt, confirmedBy, skipped: errors }),
      });
      res.end(buf);

    } catch (err) {
      console.error('[eft/pad/generate] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/returns ───────────────────────────────────────────────────
  // Upload a Desjardins CPA 005 return file.
  // Body: { content: "<file text>", filename: "RETURN_20260405.txt" }
  // OR multipart — Content-Type: text/plain with raw file content in body.
  if (req.method === 'POST' && req.url === '/api/eft/returns') {
    let body;
    try {
      // Accept raw text body (file content) or JSON wrapper
      const raw = await new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', c => { buf += c; });
        req.on('end',  () => resolve(buf));
        req.on('error', reject);
      });

      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        body = JSON.parse(raw);
      } else {
        // Raw file upload — plain text
        body = { content: raw, filename: req.headers['x-filename'] || 'return-file.txt' };
      }
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid body: ' + e.message }); return;
    }

    const { content, filename } = body;
    if (!content || !content.trim()) {
      sendJSON(res, 400, { error: 'File content is required' }); return;
    }

    try {
      const summary = await processReturnFile(content, filename || 'return-file.txt');
      sendJSON(res, 200, summary);
    } catch (err) {
      console.error('[eft/returns] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/retries/preview ───────────────────────────────────────────
  // Returns all NSF payments whose retry date has arrived + outstanding NSF fees.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/retries/preview')) {
    try {
      const { payments: queue, nsfFees } = await getRetryQueue(new Date());

      // Build a map of loanId → outstanding NSF fees for quick lookup
      const feesByLoan = {};
      for (const fee of nsfFees) {
        if (!feesByLoan[fee.loan_id]) feesByLoan[fee.loan_id] = [];
        feesByLoan[fee.loan_id].push(fee);
      }

      const enriched = [];
      for (const row of queue) {
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id').eq('id', row.loan_id).single();
        if (!loan) continue;

        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, email, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};
        const coords = {
          borrowerTransit:     app.bank_transit     || client.bank_transit     || null,
          borrowerInstitution: app.bank_institution || client.bank_institution || null,
          borrowerAccount:     app.bank_account     || client.bank_account     || null,
          hasBankingCoords:    !!(app.bank_transit  || client.bank_transit),
        };

        // Payment retry record
        enriched.push({
          type:          'retry',
          scheduleId:    row.id,
          ref:           loan.ref,
          paymentNumber: row.payment_number,
          amount:        row.scheduled_amount,
          retryDate:     row.retry_date,
          retryCount:    row.retry_count,
          borrowerName:  `${client.first_name || ''} ${client.last_name || ''}`.trim(),
          borrowerEmail: client.email || '',
          ...coords,
        });

        // NSF fee records for this loan (separate D record each)
        for (const fee of (feesByLoan[loan.id] || [])) {
          enriched.push({
            type:          'nsf_fee',
            feeId:         fee.id,
            scheduleId:    fee.schedule_id,
            ref:           loan.ref,
            paymentNumber: row.payment_number,
            amount:        fee.amount,
            retryDate:     row.retry_date,
            retryCount:    row.retry_count,
            borrowerName:  `${client.first_name || ''} ${client.last_name || ''}`.trim(),
            borrowerEmail: client.email || '',
            ...coords,
          });
        }
      }

      const retryTotal = enriched.filter(p=>p.type==='retry').reduce((s,p)=>s+parseFloat(p.amount||0),0);
      const feeTotal   = enriched.filter(p=>p.type==='nsf_fee').reduce((s,p)=>s+parseFloat(p.amount||0),0);
      sendJSON(res, 200, {
        count:        enriched.length,
        retryCount:   enriched.filter(p=>p.type==='retry').length,
        feeCount:     enriched.filter(p=>p.type==='nsf_fee').length,
        retryTotal:   retryTotal.toFixed(2),
        feeTotal:     feeTotal.toFixed(2),
        totalAmount:  (retryTotal + feeTotal).toFixed(2),
        payments:     enriched,
      });
    } catch (err) {
      console.error('[eft/retries/preview] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/retries/generate ─────────────────────────────────────────
  // Generates a PAD retry file: one D record per missed payment + one D record
  // per outstanding $45 NSF fee. Atomically stamps both before returning file.
  if (req.method === 'POST' && req.url === '/api/eft/retries/generate') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { confirmedBy, fileNum = 1 } = body;
    if (!confirmedBy || !confirmedBy.trim()) {
      sendJSON(res, 400, { error: 'confirmedBy is required' }); return;
    }

    try {
      const { payments: queue, nsfFees } = await getRetryQueue(new Date());
      if (!queue.length && !nsfFees.length) {
        sendJSON(res, 200, { message: 'No NSF retries or fees due today', filename: null }); return;
      }

      const padPayments  = [];   // D records for the file
      const schedRowIds  = [];   // repayment_schedule IDs to stamp eft_retry_at
      const feeIds       = [];   // nsf_fees IDs to stamp as collected

      // Build a coords cache to avoid N duplicate lookups
      const coordsCache  = {};
      async function getCoords(loanId) {
        if (coordsCache[loanId]) return coordsCache[loanId];
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id').eq('id', loanId).single();
        if (!loan) return null;
        const [clientRes, appRes] = await Promise.all([
          supabase.from('clients').select('first_name, last_name, bank_transit, bank_institution, bank_account').eq('id', loan.client_id).single(),
          supabase.from('loan_applications').select('bank_transit, bank_institution, bank_account').eq('ref', loan.ref).single(),
        ]);
        const client = clientRes.data || {};
        const app    = appRes.data    || {};
        coordsCache[loanId] = {
          loanRef:             loan.ref,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim(),
          borrowerTransit:     app.bank_transit     || client.bank_transit,
          borrowerInstitution: app.bank_institution || client.bank_institution,
          borrowerAccount:     app.bank_account     || client.bank_account,
        };
        return coordsCache[loanId];
      }

      // ── 1. Payment retry records ─────────────────────────────────────────
      for (const row of queue) {
        const coords = await getCoords(row.loan_id);
        if (!coords) { console.warn(`[eft/retries] No loan for schedule ${row.id} — skipped`); continue; }
        padPayments.push({
          ref:                 coords.loanRef,
          paymentNumber:       row.payment_number,
          amount:              row.scheduled_amount,
          dueDate:             row.retry_date,
          borrowerName:        coords.borrowerName,
          borrowerTransit:     coords.borrowerTransit,
          borrowerInstitution: coords.borrowerInstitution,
          borrowerAccount:     coords.borrowerAccount,
        });
        schedRowIds.push(row.id);
      }

      // ── 2. NSF fee records ($45 each — separate D record) ────────────────
      for (const fee of nsfFees) {
        const coords = await getCoords(fee.loan_id);
        if (!coords) { console.warn(`[eft/retries] No loan for fee ${fee.id} — skipped`); continue; }
        // Use a special payment number suffix to distinguish in xref: e.g. WF-843805-F01
        padPayments.push({
          ref:                 coords.loanRef,
          paymentNumber:       `F${String(feeIds.length + 1).padStart(2, '0')}`, // F01, F02...
          amount:              fee.amount,
          dueDate:             new Date().toISOString().slice(0, 10),
          borrowerName:        coords.borrowerName,
          borrowerTransit:     coords.borrowerTransit,
          borrowerInstitution: coords.borrowerInstitution,
          borrowerAccount:     coords.borrowerAccount,
        });
        feeIds.push(fee.id);
      }

      if (!padPayments.length) {
        sendJSON(res, 400, { error: 'No valid records — all missing banking coordinates' }); return;
      }

      const { filename, content, summary, errors } = generatePAD(padPayments, { fileNumber: parseInt(fileNum) });
      if (!content) {
        sendJSON(res, 400, { error: 'File generation failed', errors }); return;
      }

      // ── ATOMIC STAMP — both schedule rows AND fee rows before returning ──
      const stampedAt  = new Date().toISOString();
      const stampOps   = [];

      if (schedRowIds.length) {
        stampOps.push(
          supabase.from('repayment_schedule')
            .update({ eft_retry_at: stampedAt, eft_retry_file: filename })
            .in('id', schedRowIds)
        );
      }
      if (feeIds.length) {
        stampOps.push(
          supabase.from('nsf_fees')
            .update({ status: 'collected', paid_at: stampedAt })
            .in('id', feeIds)
        );
      }

      const stampResults = await Promise.all(stampOps);
      const stampErr = stampResults.find(r => r.error)?.error;

      if (stampErr) {
        console.error('[eft/retries] STAMP FAILED — file NOT sent:', stampErr.message);
        sendJSON(res, 500, { error: 'Stamp failed — file not sent to prevent duplicate', detail: stampErr.message }); return;
      }

      const retryAmt = queue.reduce((s,r)=>s+parseFloat(r.scheduled_amount||0),0);
      const feeAmt   = nsfFees.reduce((s,f)=>s+parseFloat(f.amount||0),0);
      console.log(`[eft/retries] ✅ ${filename} — ${schedRowIds.length} retries ($${retryAmt.toFixed(2)}) + ${feeIds.length} NSF fees ($${feeAmt.toFixed(2)}) = $${(retryAmt+feeAmt).toFixed(2)} — by ${confirmedBy}`);

      const buf = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'Content-Type':        'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      buf.length,
        'X-Retry-Summary':     JSON.stringify({ ...summary, stampedAt, confirmedBy, retryCount: schedRowIds.length, feeCount: feeIds.length }),
      });
      res.end(buf);
    } catch (err) {
      console.error('[eft/retries/generate] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/clearable ─────────────────────────────────────────────────
  // Returns all submitted PAD payments that have no return code and whose
  // effective date was at least N days ago (default 5 — return window closed).
  // These are safe to mark as paid.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/clearable')) {
    try {
      const urlObj     = new URL(req.url, 'http://localhost');
      const windowDays = parseInt(urlObj.searchParams.get('days') || '5');
      const cutoff     = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);
      const cutoffStr  = cutoff.toISOString().slice(0, 10);

      // Payments that were submitted, not returned, not already paid,
      // and whose due_date is older than the return window
      const { data: rows, error } = await supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, eft_submitted_at, eft_file, eft_retry_at, status, return_code')
        .not('eft_submitted_at', 'is', null)  // was submitted
        .is('return_code', null)              // no return = cleared
        .not('status', 'eq', 'paid')          // not already marked paid
        .not('status', 'eq', 'failed')        // not failed
        .not('status', 'eq', 'cancelled')     // not cancelled
        .lte('due_date', cutoffStr)           // return window has passed
        .order('due_date', { ascending: true });

      if (error) throw error;

      const enriched = [];
      for (const row of (rows || [])) {
        const { data: loan } = await supabase
          .from('loans').select('ref, client_id, total_paid, total_repayable, principal').eq('id', row.loan_id).single();
        if (!loan) continue;
        const { data: client } = await supabase
          .from('clients').select('first_name, last_name, email').eq('id', loan.client_id).single();
        enriched.push({
          scheduleId:    row.id,
          loanId:        row.loan_id,
          ref:           loan.ref,
          paymentNumber: row.payment_number,
          amount:        row.scheduled_amount,
          dueDate:       row.due_date,
          eftFile:       row.eft_retry_at ? row.eft_retry_file : row.eft_file,
          wasRetry:      !!row.eft_retry_at,
          borrowerName:  client ? `${client.first_name || ''} ${client.last_name || ''}`.trim() : '—',
          totalPaid:     loan.total_paid,
          totalRepayable: loan.total_repayable,
        });
      }

      const total = enriched.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      sendJSON(res, 200, {
        count:          enriched.length,
        totalAmount:    total.toFixed(2),
        windowDays,
        cutoffDate:     cutoffStr,
        payments:       enriched,
      });
    } catch (err) {
      console.error('[eft/clearable] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/clear ────────────────────────────────────────────────────
  // Marks submitted payments as paid, updates loan totals, detects paid-off loans.
  // Body: { confirmedBy: 'analyst', scheduleIds: [...], days: 5 }
  // If scheduleIds not provided, clears ALL clearable payments in the window.
  if (req.method === 'POST' && req.url === '/api/eft/clear') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { confirmedBy, scheduleIds = [], days = 5 } = body;
    if (!confirmedBy || !confirmedBy.trim()) {
      sendJSON(res, 400, { error: 'confirmedBy is required' }); return;
    }

    try {
      const cutoff    = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(days));
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      // Load clearable rows
      let query = supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, eft_file, eft_retry_at, eft_retry_file')
        .not('eft_submitted_at', 'is', null)
        .is('return_code', null)
        .not('status', 'eq', 'paid')
        .not('status', 'eq', 'failed')
        .not('status', 'eq', 'cancelled')
        .lte('due_date', cutoffStr);

      if (scheduleIds.length) query = query.in('id', scheduleIds);
      const { data: rows, error: fetchErr } = await query;
      if (fetchErr) throw fetchErr;

      if (!rows || !rows.length) {
        sendJSON(res, 200, { message: 'No clearable payments found', cleared: 0 });
        return;
      }

      const clearedAt = new Date().toISOString();
      const results   = [];

      // Group by loan for efficient total_paid updates
      const byLoan = {};
      for (const row of rows) {
        if (!byLoan[row.loan_id]) byLoan[row.loan_id] = [];
        byLoan[row.loan_id].push(row);
      }

      for (const [loanId, loanRows] of Object.entries(byLoan)) {
        // Load current loan state
        const { data: loan } = await supabase
          .from('loans')
          .select('id, ref, client_id, total_paid, total_repayable, payment_count, status')
          .eq('id', loanId).single();
        if (!loan) continue;

        // Mark each schedule row as paid
        const rowIds       = loanRows.map(r => r.id);
        const amountCleared = loanRows.reduce((s, r) => s + parseFloat(r.scheduled_amount || 0), 0);

        const { error: schedErr } = await supabase
          .from('repayment_schedule')
          .update({ status: 'paid', paid_at: clearedAt })
          .in('id', rowIds);
        if (schedErr) { console.error(`[eft/clear] Schedule update error ${loan.ref}:`, schedErr.message); continue; }

        // Update loan total_paid + remaining_balance
        const newTotalPaid       = parseFloat(loan.total_paid || 0) + amountCleared;
        const newRemainingBalance = Math.max(0, parseFloat(loan.total_repayable || 0) - newTotalPaid);

        // Check if loan is fully paid off
        const allPaid = await supabase
          .from('repayment_schedule')
          .select('id', { count: 'exact' })
          .eq('loan_id', loanId)
          .not('status', 'eq', 'paid');
        const isPaidOff = allPaid.count === 0;

        const loanUpdate = {
          total_paid:        newTotalPaid,
          remaining_balance: newRemainingBalance,
        };
        if (isPaidOff) loanUpdate.status = 'paid_off';

        await supabase.from('loans').update(loanUpdate).eq('id', loanId);

        // Update client total_repaid
        try {
          await supabase.from('clients')
            .update({ total_repaid: newTotalPaid })
            .eq('id', loan.client_id);
        } catch(e) { /* non-fatal */ }

        // Log client note
        const noteText = isPaidOff
          ? `Loan ${loan.ref} fully paid off. All ${loan.payment_count} payments cleared. Total repaid: $${newTotalPaid.toFixed(2)}.`
          : `${loanRows.length} payment(s) cleared for ${loan.ref}: $${amountCleared.toFixed(2)}. Total paid: $${newTotalPaid.toFixed(2)} / $${loan.total_repayable}.`;

        try {
          await supabase.from('client_notes').insert({
            client_id: loan.client_id,
            agent:     'system',
            note:      noteText,
            context:   isPaidOff ? 'paid_off' : 'payment_cleared',
          });
        } catch(e) { console.warn('[eft/clear] note error:', e.message); }

        if (isPaidOff) {
          console.log(`[eft/clear] 🎉 PAID OFF: ${loan.ref} — $${newTotalPaid.toFixed(2)} total repaid`);
        }

        results.push({
          ref:              loan.ref,
          paymentsCleared:  loanRows.length,
          amountCleared:    amountCleared.toFixed(2),
          newTotalPaid:     newTotalPaid.toFixed(2),
          remainingBalance: newRemainingBalance.toFixed(2),
          paidOff:          isPaidOff,
        });
      }

      const totalCleared = results.reduce((s, r) => s + parseFloat(r.amountCleared), 0);
      const paidOffLoans = results.filter(r => r.paidOff);

      console.log(`[eft/clear] ✅ Cleared ${rows.length} payments — $${totalCleared.toFixed(2)} — ${paidOffLoans.length} loan(s) paid off — by ${confirmedBy}`);

      sendJSON(res, 200, {
        cleared:       rows.length,
        totalCleared:  totalCleared.toFixed(2),
        paidOffCount:  paidOffLoans.length,
        paidOffLoans:  paidOffLoans.map(r => r.ref),
        results,
        clearedAt,
        confirmedBy,
      });

    } catch (err) {
      console.error('[eft/clear] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/vopay/status ─────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/vopay/status') {
    sendJSON(res, 200, { ...vopay.getStatus(), activeProcessor });
    return;
  }

  // ── POST /api/processor/set ───────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/processor/set') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { processor } = body;
    if (!['manual', 'vopay'].includes(processor)) {
      sendJSON(res, 400, { error: 'processor must be manual or vopay' }); return;
    }
    if (processor === 'vopay' && !vopay.isConfigured()) {
      sendJSON(res, 400, { error: 'VoPay credentials not configured — add VOPAY_ACCOUNT_ID, VOPAY_API_KEY, VOPAY_API_SECRET to Railway env vars' }); return;
    }
    activeProcessor = processor;
    console.log(`[processor] Switched to: ${processor}`);
    sendJSON(res, 200, { ok: true, activeProcessor });
    return;
  }

  // ── GET /api/processor/status ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/processor/status') {
    sendJSON(res, 200, { activeProcessor, vopay: vopay.getStatus() });
    return;
  }

  // ── POST /api/vopay/webhook ───────────────────────────────────────────────────
  // VoPay posts return/NSF notifications here — same effect as importing a return file
  if (req.method === 'POST' && req.url === '/api/vopay/webhook') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid body' }); return; }

    const event = vopay.parseWebhook(body);
    console.log(`[vopay webhook] ${event.type} — ${event.status} — ref: ${event.ref} — txId: ${event.txId}`);

    if (event.isReturned || event.isNSF) {
      // Match to repayment_schedule by ClientReferenceNumber (loanRef-P{paymentNum})
      const refParts = event.ref.split('-P');
      const loanRef  = refParts[0];

      if (loanRef) {
        try {
          // Find the loan
          const { data: loan } = await supabase.from('loans').select('id,client_id').eq('ref', loanRef).single();
          if (loan) {
            // Update schedule row — mark as failed
            await supabase.from('repayment_schedule')
              .update({
                status:        'failed',
                return_code:   event.returnCode,
                return_reason: event.returnMsg || event.status,
                returned_at:   new Date().toISOString(),
              })
              .eq('loan_id', loan.id)
              .eq('status',  'scheduled');

            // Charge NSF fee if actual NSF
            if (event.isNSF) {
              await supabase.from('nsf_fees').insert({
                client_id: loan.client_id,
                loan_id:   loan.id,
                amount:    45.00,
                reason:    event.returnMsg || 'NSF via VoPay webhook',
                return_code: event.returnCode,
                status:    'outstanding',
              });
              console.log(`[vopay webhook] NSF fee charged for loan ${loanRef}`);
            }
          }
        } catch (err) {
          console.error('[vopay webhook] DB update error:', err.message);
        }
      }
    }

    sendJSON(res, 200, { ok: true, received: event });
    return;
  }

  // ── GET /api/credit/raw-test ─────────────────────────────────────────────────
  // Returns raw Equifax sandbox response for debugging
  if (req.method === 'GET' && req.url === '/api/credit/raw-test') {
    try {
      const { getAccessToken } = require('./equifaxClient');
      const https = require('https');
      const token = await getAccessToken();
      const EFX_REPORT_URL = process.env.EQUIFAX_REPORT_URL || 'https://api.equifax.com/business/oneview/consumer-credit/v1/report';

      const body = JSON.stringify({
        consumers: {
          name: [{ identifier: 'current', firstName: 'John', lastName: 'Smith' }],
          addresses: [{ identifier: 'current', street: '123 Main St', city: 'Toronto', state: 'ON', zip: 'M5V1A1', countryCode: 'CA' }],
        },
      });

      const url = new URL(EFX_REPORT_URL);
      const result = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: url.hostname, path: url.pathname, port: 443, method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' },
        }, (res2) => {
          let data = '';
          res2.on('data', c => { data += c; });
          res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
        });
        req2.on('error', reject);
        req2.write(body); req2.end();
      });

      sendJSON(res, 200, { status: result.status, url: EFX_REPORT_URL, rawBody: result.body.slice(0, 2000) });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/credit/report ─────────────────────────────────────────────────
  // Fetches Equifax OneView credit report for a client.
  // Called server-side only — credentials never exposed to browser.
  // Body: { clientId } — we look up their info from Supabase
  if (req.method === 'POST' && req.url === '/api/credit/report') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { clientId } = body;
    if (!clientId) { sendJSON(res, 400, { error: 'clientId required' }); return; }

    try {
      // Load client from Supabase
      const { data: client, error: clientErr } = await supabase
        .from('clients').select('first_name, last_name, dob, address, city, province, postal').eq('id', clientId).single();
      if (clientErr || !client) { sendJSON(res, 404, { error: 'Client not found' }); return; }

      const report = await fetchCreditReport({
        firstName: client.first_name,
        lastName:  client.last_name,
        dob:       client.dob,
        address:   client.address,
        city:      client.city,
        province:  client.province,
        postal:    client.postal,
      });

      sendJSON(res, 200, report);
      console.log(`[credit] Report fetched for client ${clientId.slice(0,8)} — score: ${report.score}`);
    } catch (err) {
      console.error('[credit] Error:', err.message);
      sendJSON(res, 500, { error: err.message, stack: err.stack?.split('\n').slice(0,3) });
    }
    return;
  }

  // ── GET /api/credit/token-test ───────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/credit/token-test') {
    try {
      const token = await getAccessToken();
      const mode  = process.env.EQUIFAX_STATIC_TOKEN ? 'sandbox-static' : 'oauth-client-credentials';
      sendJSON(res, 200, {
        ok:      true,
        mode,
        token:   token.slice(0, 8) + '…',
        reportUrl: process.env.EQUIFAX_REPORT_URL || 'https://api.equifax.com/business/oneview/consumer-credit/v1/report',
        message: `Equifax token ready (${mode})`,
      });
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: err.message });
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
