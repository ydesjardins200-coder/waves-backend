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
const { generateETransfer }                         = require('./etransferGenerator');
const { processReturnFile, getRetryQueue, RETURN_CODES } = require('./returnProcessor');
const { fetchCreditReport, getAccessToken } = require('./equifaxClient');
const vopay    = require('./vopayClient');
const ibv      = require('./ibvClient');
const kyc      = require('./kycClient');
const settings = require('./settings');

// ── PAYMENT METHODS DEFAULT CONFIG ───────────────────────────────────────────
function getDefaultPaymentMethods() {
  return [
    { id:'direct',   label:'Direct Deposit',      description:'Same day if approved before 2:30 PM EST.',               fee:0, enabled:true,  badgeType:'free', provinces:[] },
    { id:'instant',  label:'Instant Deposit',      description:'In your account within 1–2 hours of approval.',          fee:0, enabled:true,  badgeType:'none', provinces:[] },
    { id:'etransfer',label:'Interac e-Transfer®',  description:'Sent to your email on file within ~2 minutes of approval.', fee:6, enabled:true, badgeType:'fee',  provinces:[] },
  ];
}

// ── STARTUP: load persisted settings from Supabase ────────────────────────────
settings.load().then(() => {
  console.log('[startup] Settings loaded:', JSON.stringify(settings.getAll()));
});

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

      const loanCfg      = settings.getLoanSettings();
      const APR           = loanCfg.apr;
      const TERM_DAYS     = loanCfg.termDays;
      const PAYMENT_COUNT = loanCfg.paymentCount;

      // Optional fees — loaded from application record, spread across payments
      const optionalFees     = app.optional_fees ? JSON.parse(app.optional_fees) : [];
      const optionalFeesTotal = optionalFees.reduce((s, f) => s + parseFloat(f.fee || 0), 0);
      const feePerPayment    = parseFloat((optionalFeesTotal / PAYMENT_COUNT).toFixed(2));

      const paymentAmt     = parseFloat(((approvedAmount * (1 + APR * TERM_DAYS / 365)) / PAYMENT_COUNT).toFixed(2)) + feePerPayment;
      const totalRepayable = parseFloat((paymentAmt * PAYMENT_COUNT).toFixed(2));

      if (optionalFeesTotal > 0) {
        console.log(`[approve] Optional fees: $${optionalFeesTotal} (${optionalFees.map(f=>f.label).join(', ')}) — +$${feePerPayment}/payment`);
      }

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
          optional_fees:     app.optional_fees || null,
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

      // ── STEP 10: AUTO-DISBURSE VIA VOPAY (if active) ─────────────────────────
      // ── STEP 9B: AUTO KYC SCREEN (if enabled, run before disburse) ───────────
      if (settings.isKYCEnabled() && kyc.isConfigured()) {
        console.log('[approve] KYC — screening', app.ref);
        try {
          const kycResult = await kyc.screenIndividual({
            firstName: client.first_name,
            lastName:  client.last_name,
            dob:       client.dob,
            address:   client.address,
            city:      client.city,
            province:  client.province,
            postal:    client.postal,
          });

          await supabase.from('loan_applications').update({
            kyc_status:     kycResult.status,
            kyc_result:     kycResult,
            kyc_checked_at: new Date().toISOString(),
          }).eq('id', applicationId);

          // Block disbursement if flagged — leave as pending_disbursement for manual review
          if (kycResult.status === 'flag') {
            console.warn(`[approve] KYC FLAGGED for ${app.ref} — ${kycResult.summary}`);
            await supabase.from('client_notes').insert({
              client_id: app.client_id,
              agent:     'system',
              note:      `⚠️ KYC FLAG: ${kycResult.summary}. Loan ${app.ref} requires compliance review before disbursement.`,
              context:   'kyc_flag',
            }).then(()=>{}, ()=>{});
          }
          console.log(`[approve] KYC ${app.ref} → ${kycResult.status}`);
        } catch (kycErr) {
          console.error('[approve] KYC error (non-fatal):', kycErr.message);
        }
      }
      let vopayDisburseTxId   = null;
      let vopayDisburseStatus = null;

      if (settings.getProcessor() === 'vopay' && vopay.isConfigured()) {
        console.log('[approve] Step 10 — disbursing via VoPay');
        try {
          // Grab banking coords — prefer app-level, fall back to client-level
          const { data: appBanking } = await supabase
            .from('loan_applications')
            .select('bank_transit, bank_institution, bank_account')
            .eq('id', applicationId).single();

          const bankToken   = client.vopay_token   || null;
          const transit     = appBanking?.bank_transit      || client.bank_transit;
          const institution = appBanking?.bank_institution  || client.bank_institution;
          const account     = appBanking?.bank_account      || client.bank_account;

          const result = await vopay.disburse({
            loanId:      loanId,
            loanRef:     app.ref,
            amount:      approvedAmount,
            email:       client.email,
            firstName:   client.first_name,
            lastName:    client.last_name,
            bankToken,
            transit,
            institution,
            account,
          });

          vopayDisburseTxId   = result.TransactionID || result.EFTTransactionID || null;
          vopayDisburseStatus = 'submitted';

          // Store VoPay transaction ID on the loan
          await supabase.from('loans').update({
            vopay_disburse_tx_id:   vopayDisburseTxId,
            vopay_disburse_status:  'submitted',
            // Keep as pending_disbursement until webhook confirms
          }).eq('id', loanId);

          console.log(`[approve] VoPay disburse submitted — txId: ${vopayDisburseTxId}`);
        } catch (vpErr) {
          // Non-fatal — loan stays as pending_disbursement, admin can retry manually
          console.error('[approve] VoPay disburse error (non-fatal):', vpErr.message);
          vopayDisburseStatus = 'error: ' + vpErr.message;

          await supabase.from('client_notes').insert({
            client_id: app.client_id,
            agent:     'system',
            note:      `VoPay disbursement failed for ${app.ref}: ${vpErr.message}. Loan remains pending_disbursement — retry via admin.`,
            context:   'vopay_error',
          }).then(()=>{}, ()=>{});
        }
      }

      sendJSON(res, 200, {
        ok:                  true,
        loanId,
        approvedAmount,
        paymentAmount:       paymentAmt,
        totalRepayable,
        scheduleCount:       scheduleRows.length,
        firstPayment:        scheduleRows[0].due_date,
        finalPayment:        finalDate,
        processor:           settings.getProcessor(),
        vopayDisburseTxId,
        vopayDisburseStatus,
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

  // ── GET /api/eft/etransfer ────────────────────────────────────────────────
  // Generates Desjardins bulk Interac e-Transfer CSV for all
  // pending_disbursement loans where fund_method = 'etransfer'
  if (req.method === 'GET' && req.url.startsWith('/api/eft/etransfer') && !req.url.includes('/confirm')) {
    try {
      const urlObj  = new URL(req.url, 'http://localhost');
      const loanIds = urlObj.searchParams.get('loanIds')?.split(',').filter(Boolean) || [];
      const fileNum = parseInt(urlObj.searchParams.get('fileNum') || '1');
      const effDate = urlObj.searchParams.get('effectiveDate')
        ? new Date(urlObj.searchParams.get('effectiveDate'))
        : new Date();

      // Load e-transfer pending loans
      let query = supabase
        .from('loans')
        .select('id, ref, principal, client_id, fund_method, status')
        .eq('status', 'pending_disbursement')
        .eq('fund_method', 'etransfer')
        .order('created_at', { ascending: true });

      if (loanIds.length) query = query.in('id', loanIds);
      const { data: loans, error } = await query;
      if (error) throw error;

      if (!loans || !loans.length) {
        sendJSON(res, 200, { message: 'No pending e-Transfer loans found', content: null });
        return;
      }

      // Enrich with borrower email
      const etLoans = [];
      for (const loan of loans) {
        const clientRes = await supabase
          .from('clients')
          .select('first_name, last_name, email')
          .eq('id', loan.client_id).single();
        const client = clientRes.data || {};
        etLoans.push({
          ref:           loan.ref,
          amount:        loan.principal,
          borrowerName:  `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—',
          borrowerEmail: client.email || '',
        });
      }

      const { filename, content, summary, errors } = generateETransfer(etLoans, { effectiveDate: effDate, fileNumber: fileNum });

      if (!content) {
        sendJSON(res, 400, { error: 'No valid loans — missing email addresses', errors });
        return;
      }

      if (errors.length) console.warn('[eft/etransfer] Skipped loans:', errors);

      const buf = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      buf.length,
        'X-ETRANSFER-Summary': JSON.stringify(summary),
        'X-ETRANSFER-Loan-Ids': loans.map(l => l.id).join(','),
      });
      res.end(buf);
      console.log(`[eft/etransfer] Generated ${filename} — ${summary.transactionCount} transfers — $${summary.totalAmount}`);
    } catch (err) {
      console.error('[eft/etransfer] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/etransfer/confirm ────────────────────────────────────────
  // Called after admin submits e-Transfer CSV to Desjardins — marks loans active
  if (req.method === 'POST' && req.url === '/api/eft/etransfer/confirm') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { loanIds: rawIds, confirmedBy = 'analyst', note = '' } = body;
    const loanIds = Array.isArray(rawIds)
      ? rawIds.filter(Boolean)
      : String(rawIds || '').split(',').map(s => s.trim()).filter(Boolean);

    if (!loanIds.length) { sendJSON(res, 400, { error: 'loanIds array required' }); return; }

    if (!supabase) {
      sendJSON(res, 500, { error: 'Database not connected' });
      return;
    }

    try {
      const now = new Date().toISOString();

      const { data: updated, error } = await supabase
        .from('loans')
        .update({ status: 'active', disbursed_at: now })
        .in('id', loanIds)
        .eq('status', 'pending_disbursement')
        .select('id, ref, principal, client_id');

      if (error) throw new Error(error.message);

      for (const loan of (updated || [])) {
        await supabase.from('client_notes').insert({
          client_id: loan.client_id,
          agent:     confirmedBy || 'analyst',
          note:      `Loan ${loan.ref} ($${loan.principal}) disbursed via Interac e-Transfer — marked active. ${note}`.trim(),
          context:   'disbursement',
        }).then(() => {}, () => {});
      }

      const count = updated?.length || 0;
      console.log(`[eft/etransfer/confirm] ${count} loans marked active by ${confirmedBy}`);
      sendJSON(res, 200, { ok: true, activated: count, loans: updated?.map(l => ({ id: l.id, ref: l.ref })) });
    } catch (err) {
      console.error('[eft/etransfer/confirm] Error:', err.message);
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
        'X-DRD-Loan-Ids':      loans.map(l => l.id).join(','),
      });
      res.end(buf);
      console.log(`[eft/drd] Generated ${filename} — ${summary.transactionCount} loans — $${summary.totalAmount}`);
    } catch (err) {
      console.error('[eft/drd] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/eft/drd/confirm ─────────────────────────────────────────────
  // Called after admin submits DRD file to Desjardins — marks loans as active
  if (req.method === 'POST' && req.url === '/api/eft/drd/confirm') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    const { loanIds: rawIds, confirmedBy = 'analyst', note = '' } = body;

    // Defensive: accept array or comma-string
    const loanIds = Array.isArray(rawIds)
      ? rawIds.filter(Boolean)
      : String(rawIds || '').split(',').map(s => s.trim()).filter(Boolean);

    if (!loanIds.length) { sendJSON(res, 400, { error: 'loanIds array required' }); return; }

    console.log(`[eft/drd/confirm] Confirming ${loanIds.length} loans:`, loanIds);

    // Guard: supabase must be available
    if (!supabase) {
      sendJSON(res, 500, { error: 'Database not connected — check SUPABASE_URL and SUPABASE_API_KEY in Railway env vars' });
      return;
    }

    try {
      const now = new Date().toISOString();

      // Flip all listed loans from pending_disbursement → active
      const { data: updated, error } = await supabase
        .from('loans')
        .update({ status: 'active' })
        .in('id', loanIds)
        .eq('status', 'pending_disbursement')
        .select('id, ref, principal, client_id');

      if (error) {
        console.error('[eft/drd/confirm] Supabase update error:', error);
        throw new Error(error.message || JSON.stringify(error));
      }

      // Try to stamp disbursed_at if the column exists
      try {
        await supabase.from('loans').update({ disbursed_at: now }).in('id', loanIds);
      } catch (e) {
        console.warn('[eft/drd/confirm] disbursed_at not set:', e.message);
      }

      // Write a client note for each loan
      for (const loan of (updated || [])) {
        await supabase.from('client_notes').insert({
          client_id: loan.client_id,
          agent:     confirmedBy || 'analyst',
          note:      `Loan ${loan.ref} ($${loan.principal}) disbursed via DRD — marked active. ${note}`.trim(),
          context:   'disbursement',
        }).then(()=>{}, ()=>{});
      }

      const count = updated?.length || 0;
      console.log(`[eft/drd/confirm] ${count} loans marked active by ${confirmedBy}`);
      sendJSON(res, 200, { ok: true, activated: count, loans: updated?.map(l => ({ id: l.id, ref: l.ref })) });
    } catch (err) {
      console.error('[eft/drd/confirm] Error:', err.message, err.stack?.split('\n')[1]);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/eft/pads/preview ──────────────────────────────────────────────
  // SAFE: Read-only preview. Never stamps anything.
  // Returns scheduled+failed payments due in next N days from ACTIVE loans only.
  if (req.method === 'GET' && req.url.startsWith('/api/eft/pads/preview')) {
    try {
      const urlObj    = new URL(req.url, 'http://localhost');
      const daysAhead = parseInt(urlObj.searchParams.get('days') || '5');
      const cutoff    = new Date();
      cutoff.setDate(cutoff.getDate() + daysAhead);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const today     = new Date().toISOString().slice(0, 10);

      // Scope to active loans only
      const { data: activeLoans } = await supabase.from('loans').select('id').eq('status', 'active');
      const activeLoanIds = (activeLoans || []).map(l => l.id);
      if (!activeLoanIds.length) {
        sendJSON(res, 200, { count: 0, totalAmount: '0.00', cutoffDate: cutoffStr, payments: [], summary: {}, warning: 'No active loans' });
        return;
      }

      // Include scheduled + failed (NSF retries need to go into next PAD)
      // Exclude only paid / cancelled rows
      const { data: schedRows, error } = await supabase
        .from('repayment_schedule')
        .select('id, loan_id, payment_number, due_date, scheduled_amount, status, eft_submitted_at, eft_file')
        .in('status', ['scheduled', 'failed'])
        .in('loan_id', activeLoanIds)
        .lte('due_date', cutoffStr)
        .order('due_date', { ascending: true });
      if (error) throw error;

      const enriched = [];
      for (const row of (schedRows || [])) {
        const { data: loan } = await supabase.from('loans').select('ref, client_id').eq('id', row.loan_id).single();
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
          status:              row.status,
          alreadySubmitted:    !!row.eft_submitted_at,
          isOverdue:           row.due_date < today,
          eftFile:             row.eft_file || null,
          borrowerName:        `${client.first_name || ''} ${client.last_name || ''}`.trim() || '—',
          borrowerEmail:       client.email || '',
          borrowerTransit:     app.bank_transit     || client.bank_transit     || null,
          borrowerInstitution: app.bank_institution || client.bank_institution || null,
          borrowerAccount:     app.bank_account     || client.bank_account     || null,
          hasBankingCoords:    !!(app.bank_transit  || client.bank_transit),
        });
      }

      const includedInPAD = enriched.filter(p => !p.alreadySubmitted && p.hasBankingCoords);
      const total         = includedInPAD.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
      const summary = {
        includedInPAD:    includedInPAD.length,
        alreadySubmitted: enriched.filter(p => p.alreadySubmitted).length,
        missingCoords:    enriched.filter(p => !p.hasBankingCoords).length,
        failed:           enriched.filter(p => p.status === 'failed').length,
        overdue:          enriched.filter(p => p.isOverdue).length,
      };
      const warn = enriched.length === 0
        ? 'No payments due in this window'
        : summary.missingCoords
          ? `${summary.missingCoords} payment(s) missing banking coords — excluded from PAD`
          : null;
      sendJSON(res, 200, {
        count: includedInPAD.length, totalAmount: total.toFixed(2),
        cutoffDate: cutoffStr, effectiveDate: nextBusinessDay().toISOString().slice(0, 10),
        payments: enriched, summary, warning: warn,
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

  // ── POST /api/loans/:loanId/recalc-fees ──────────────────────────────────────
  // Recalculates scheduled_amount on all schedule rows to include optional fees
  // Used when a loan was approved before optional fees were wired into the calc
  if (req.method === 'POST' && req.url.match(/^\/api\/loans\/[^/]+\/recalc-fees$/)) {
    const loanId = req.url.split('/')[3];
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { applicationId } = body;

    try {
      // Load the loan
      const { data: loan } = await supabase.from('loans')
        .select('id, ref, principal, payment_count, payment_frequency, apr, term_days, client_id, total_paid')
        .eq('id', loanId).single();
      if (!loan) { sendJSON(res, 404, { error: 'Loan not found' }); return; }

      // Load optional fees from the application
      const appQuery = applicationId
        ? supabase.from('loan_applications').select('optional_fees').eq('id', applicationId).single()
        : supabase.from('loan_applications').select('optional_fees').eq('ref', loan.ref).single();
      const { data: app } = await appQuery;

      const optionalFees      = (app?.optional_fees && app.optional_fees !== 'null')
        ? JSON.parse(app.optional_fees) : [];
      const optionalFeesTotal = optionalFees.reduce((s, f) => s + parseFloat(f.fee || 0), 0);

      // Recalculate payment amount
      const loanCfg2      = settings.getLoanSettings();
      const APR            = parseFloat(loan.apr || loanCfg2.apr);
      const termDays       = loan.term_days || loanCfg2.termDays;
      const paymentCount   = loan.payment_count || loanCfg2.paymentCount;
      const principal      = parseFloat(loan.principal);
      const feePerPayment  = parseFloat((optionalFeesTotal / paymentCount).toFixed(2));
      const basePayment    = parseFloat(((principal * (1 + APR * termDays / 365)) / paymentCount).toFixed(2));
      const newPaymentAmt  = basePayment + feePerPayment;
      const newTotalRepay  = parseFloat((newPaymentAmt * paymentCount).toFixed(2));

      console.log(`[recalc-fees] ${loan.ref} — principal $${principal}, optFees $${optionalFeesTotal}, base $${basePayment} + $${feePerPayment}/pmt = $${newPaymentAmt}, total $${newTotalRepay}`);

      // Update all non-paid rows (scheduled, failed, missed — anything not yet settled)
      const { data: updated, error } = await supabase
        .from('repayment_schedule')
        .update({ scheduled_amount: newPaymentAmt })
        .eq('loan_id', loanId)
        .in('status', ['scheduled', 'failed', 'missed'])
        .select('id');

      if (error) {
        console.error('[recalc-fees] schedule update error:', error.message, error.details, error.hint);
        throw new Error('Schedule update failed: ' + error.message);
      }

      console.log(`[recalc-fees] updated ${updated?.length || 0} schedule rows`);

      // Update loan totals
      await supabase.from('loans').update({
        payment_amount:    newPaymentAmt,
        total_repayable:   newTotalRepay,
        remaining_balance: newTotalRepay - parseFloat(loan.total_paid || 0),
      }).eq('id', loanId);

      sendJSON(res, 200, {
        ok:               true,
        loanRef:          loan.ref,
        newPaymentAmount: newPaymentAmt,
        newTotalRepay,
        paymentsUpdated:  updated?.length || 0,
        optionalFees,
        optionalFeesTotal,
      });
    } catch (err) {
      console.error('[recalc-fees] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/admin/reset-db ──────────────────────────────────────────────────
  // Wipes all operational data — clients, loans, applications, schedule, contracts, NSF
  // Requires { confirm: 'RESET' } in body. Double-gated: wrong confirm = 403.
  if (req.method === 'POST' && req.url === '/api/admin/reset-db') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    if (body?.confirm !== 'RESET') { sendJSON(res, 403, { error: 'Confirm token mismatch' }); return; }
    try {
      const tables = ['nsf_fees','repayment_schedule','contracts','client_notes','application_notes','loans','loan_applications','clients'];
      const results = [];
      for (const table of tables) {
        const { error, count } = await supabase.from(table).delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
        if (error) { console.error(`[reset-db] ${table}:`, error.message); results.push(`${table}: error`); }
        else results.push(`${table}: ${count||0} deleted`);
      }
      console.log('[reset-db] Reset complete:', results.join(', '));
      sendJSON(res, 200, { ok: true, deleted: results.join(' · ') });
    } catch(err) {
      console.error('[reset-db] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/config/loan-settings ────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/config/loan-settings') {
    await settings.waitUntilLoaded();
    sendJSON(res, 200, settings.getLoanSettings());
    return;
  }

  // ── POST /api/config/loan-settings ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/config/loan-settings') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const allowed = ['min_loan','max_loan','apr','term_days','payment_count','nsf_fee','pad_cutoff_time','email_notifications'];
    for (const key of allowed) {
      if (body[key] !== undefined) await settings.set(key, String(body[key]));
    }
    console.log('[config] Loan settings saved:', JSON.stringify(body));
    sendJSON(res, 200, { ok: true, settings: settings.getLoanSettings() });
    return;
  }

  // ── GET /api/config/optional-fees ────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/config/optional-fees') {
    await settings.waitUntilLoaded();
    const raw  = settings.get('optional_fees');
    const fees = (raw && raw !== 'null') ? JSON.parse(raw) : [];
    sendJSON(res, 200, { fees });
    return;
  }

  // ── POST /api/config/optional-fees ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/config/optional-fees') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { fees } = body;
    if (!Array.isArray(fees)) { sendJSON(res, 400, { error: 'fees array required' }); return; }
    for (const f of fees) {
      if (!f.id || !f.label) { sendJSON(res, 400, { error: 'Each fee needs id and label' }); return; }
      f.fee     = parseFloat(f.fee || 0);
      f.enabled = !!f.enabled;
    }
    await settings.set('optional_fees', JSON.stringify(fees));
    console.log('[config] Optional fees saved:', fees.map(f => `${f.id}($${f.fee})`).join(', '));
    sendJSON(res, 200, { ok: true, fees });
    return;
  }

  // ── GET /api/config/payment-methods ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/config/payment-methods') {
    await settings.waitUntilLoaded();
    const raw = settings.get('payment_methods');
    const methods = (raw && raw !== 'null') ? JSON.parse(raw) : getDefaultPaymentMethods();
    sendJSON(res, 200, { methods });
    return;
  }

  // ── POST /api/config/payment-methods ─────────────────────────────────────────
  // Saves payment methods config from admin
  if (req.method === 'POST' && req.url === '/api/config/payment-methods') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { methods } = body;
    if (!Array.isArray(methods)) { sendJSON(res, 400, { error: 'methods array required' }); return; }
    // Validate each method has required fields
    for (const m of methods) {
      if (!m.id || !m.label) { sendJSON(res, 400, { error: 'Each method needs id and label' }); return; }
      m.fee     = parseFloat(m.fee || 0);
      m.enabled = !!m.enabled;
    }
    await settings.set('payment_methods', JSON.stringify(methods));
    console.log('[config] Payment methods saved:', methods.map(m => `${m.id}(${m.enabled?'on':'off'} $${m.fee})`).join(', '));
    sendJSON(res, 200, { ok: true, methods });
    return;
  }

  // ── GET /api/kyc/status ───────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/kyc/status') {
    sendJSON(res, 200, { ...kyc.getStatus(), enabled: settings.isKYCEnabled() });
    return;
  }

  // ── POST /api/kyc/screen/:applicationId ───────────────────────────────────────
  // Manually trigger KYC screen from admin (for re-screening or initial screen)
  if (req.method === 'POST' && req.url.startsWith('/api/kyc/screen/')) {
    const applicationId = req.url.split('/api/kyc/screen/')[1];
    if (!applicationId) { sendJSON(res, 400, { error: 'applicationId required' }); return; }

    try {
      const { data: app } = await supabase
        .from('loan_applications')
        .select('*, clients(first_name, last_name, dob, address, city, province, postal)')
        .eq('id', applicationId).single();
      if (!app) { sendJSON(res, 404, { error: 'Application not found' }); return; }

      const client    = app.clients || {};
      const firstName = client.first_name || app.first_name;
      const lastName  = client.last_name  || app.last_name;

      const result = await kyc.screenIndividual({
        firstName, lastName,
        dob:      client.dob      || app.dob,
        address:  client.address  || app.address,
        city:     client.city     || app.city,
        province: client.province || app.province,
        postal:   client.postal   || app.postal,
      });

      // Save result to application
      await supabase.from('loan_applications').update({
        kyc_status:     result.status,
        kyc_result:     result,
        kyc_checked_at: new Date().toISOString(),
      }).eq('id', applicationId);

      console.log(`[kyc] Manual screen ${app.ref} → ${result.status}`);
      sendJSON(res, 200, { ok: true, applicationId, ref: app.ref, ...result });
    } catch (err) {
      console.error('[kyc] Manual screen error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/kyc/toggle ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/kyc/toggle') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { enabled } = body;
    if (typeof enabled !== 'boolean') { sendJSON(res, 400, { error: 'enabled (boolean) required' }); return; }
    if (enabled && !kyc.isConfigured()) {
      sendJSON(res, 400, { error: 'KYC not configured — set KYC_API_KEY in Railway env vars first' }); return;
    }
    await settings.set('kyc_enabled', String(enabled));
    console.log(`[kyc] KYC screening ${enabled ? 'enabled' : 'disabled'}`);
    sendJSON(res, 200, { ok: true, enabled: settings.isKYCEnabled() });
    return;
  }

  // ── POST /api/kyc/bulk-screen ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/kyc/bulk-screen') {
    if (!settings.isKYCEnabled() || !kyc.isConfigured()) {
      sendJSON(res, 400, { error: 'KYC not configured — set KYC_API_KEY and enable KYC in admin' });
      return;
    }
    try {
      const { data: apps } = await supabase
        .from('loan_applications')
        .select('id, ref, first_name, last_name, dob, address, city, province, postal, client_id')
        .is('kyc_status', null)
        .limit(50);

      if (!apps?.length) {
        sendJSON(res, 200, { ok: true, screened: 0, message: 'No unscreened applications' });
        return;
      }

      const results = [];
      for (const app of apps) {
        const result = await kyc.screenIndividual({
          firstName: app.first_name,
          lastName:  app.last_name,
          dob:       app.dob,
          address:   app.address,
          city:      app.city,
          province:  app.province,
          postal:    app.postal,
        });

        await supabase.from('loan_applications').update({
          kyc_status:     result.status,
          kyc_result:     result,
          kyc_checked_at: new Date().toISOString(),
        }).eq('id', app.id);

        results.push({ ref: app.ref, status: result.status, summary: result.summary });

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      }

      const flagged = results.filter(r => r.status === 'flag').length;
      const review  = results.filter(r => r.status === 'review').length;
      console.log(`[kyc] Bulk screen: ${results.length} apps, ${flagged} flagged, ${review} for review`);
      sendJSON(res, 200, { ok: true, screened: results.length, flagged, review, results });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── GET /api/ibv/status ───────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/ibv/status') {
    sendJSON(res, 200, { ...ibv.getStatus(), provider: settings.getIBVProvider() });
    return;
  }

  // ── GET /api/ibv/embed-url ────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/ibv/embed-url')) {
    try {
      const urlParams  = new URL('http://x' + req.url).searchParams;
      const redirectUrl = urlParams.get('redirectUrl') || undefined;
      // Use persisted provider from settings, not env var
      const config = await ibv.getEmbedConfig({ redirectUrl, providerOverride: settings.getIBVProvider() });
      sendJSON(res, 200, config);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/ibv/provider/set ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/ibv/provider/set') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }
    const { provider } = body;
    if (!['flinks', 'vopay'].includes(provider)) {
      sendJSON(res, 400, { error: 'provider must be flinks or vopay' }); return;
    }
    if (provider === 'vopay' && !ibv.isVoPayConfigured()) {
      sendJSON(res, 400, { error: 'VoPay credentials not configured — add VOPAY_ACCOUNT_ID, VOPAY_API_KEY, VOPAY_API_SECRET to Railway env vars' }); return;
    }
    await settings.set('ibv_provider', provider);
    console.log(`[ibv] Provider switched to: ${provider}`);
    sendJSON(res, 200, { ok: true, provider: settings.getIBVProvider() });
    return;
  }

  // ── GET /api/vopay/status ─────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/vopay/status') {
    sendJSON(res, 200, { ...vopay.getStatus(), activeProcessor: settings.getProcessor() });
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
    await settings.set('payment_processor', processor);
    console.log(`[processor] Switched to: ${processor}`);
    sendJSON(res, 200, { ok: true, activeProcessor: settings.getProcessor() });
    return;
  }

  // ── GET /api/processor/status ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/processor/status') {
    sendJSON(res, 200, { activeProcessor: settings.getProcessor(), vopay: vopay.getStatus() });
    return;
  }

  // ── POST /api/vopay/webhook ───────────────────────────────────────────────────
  // VoPay posts all transaction status updates here
  if (req.method === 'POST' && req.url === '/api/vopay/webhook') {
    let body;
    try { body = await readBody(req); } catch { sendJSON(res, 400, { error: 'Invalid body' }); return; }

    const event = vopay.parseWebhook(body);
    console.log(`[vopay webhook] ${event.type} — ${event.status} — ref: ${event.ref} — txId: ${event.txId}`);

    try {
      // ── DISBURSEMENT CONFIRMED → flip loan to active ────────────────────────
      if ((event.type === 'EFTWithdraw' || event.type === 'InteracETransfer') && event.isCompleted) {
        const { data: loan } = await supabase
          .from('loans').select('id,ref,client_id')
          .eq('vopay_disburse_tx_id', event.txId).maybeSingle();

        if (loan) {
          await supabase.from('loans').update({
            status:                 'active',
            vopay_disburse_status:  'completed',
          }).eq('id', loan.id);

          await supabase.from('client_notes').insert({
            client_id: loan.client_id,
            agent:     'system',
            note:      `Loan ${loan.ref} disbursement confirmed by VoPay (txId: ${event.txId}). Loan is now active.`,
            context:   'vopay_disburse',
          });
          console.log(`[vopay webhook] Loan ${loan.ref} activated — disbursement confirmed`);
        }
      }

      // ── DISBURSEMENT FAILED → log note, keep pending ────────────────────────
      if ((event.type === 'EFTWithdraw' || event.type === 'InteracETransfer') && event.isReturned) {
        const { data: loan } = await supabase
          .from('loans').select('id,ref,client_id')
          .eq('vopay_disburse_tx_id', event.txId).maybeSingle();

        if (loan) {
          await supabase.from('loans').update({
            vopay_disburse_status: 'failed: ' + (event.returnMsg || event.returnCode),
          }).eq('id', loan.id);

          await supabase.from('client_notes').insert({
            client_id: loan.client_id,
            agent:     'system',
            note:      `VoPay disbursement FAILED for ${loan.ref} — ${event.returnMsg||event.returnCode} (txId: ${event.txId}). Loan remains pending_disbursement.`,
            context:   'vopay_error',
          });
          console.error(`[vopay webhook] Disbursement failed for loan ${loan.ref}: ${event.returnMsg}`);
        }
      }

      // ── PAYMENT COLLECTED → mark schedule row as paid ──────────────────────
      if (event.type === 'EFTFund' && event.isCompleted && event.ref) {
        const { data: schedRow } = await supabase
          .from('repayment_schedule').select('id,loan_id,scheduled_amount,payment_number')
          .eq('vopay_tx_id', event.txId).maybeSingle();

        if (schedRow) {
          const now = new Date().toISOString();
          await supabase.from('repayment_schedule').update({
            status:  'paid',
            paid_at: now,
          }).eq('id', schedRow.id);

          // Update loan totals
          const { data: loan } = await supabase
            .from('loans').select('total_paid,total_repayable,remaining_balance').eq('id', schedRow.loan_id).single();
          if (loan) {
            const newPaid   = parseFloat(loan.total_paid || 0) + parseFloat(schedRow.scheduled_amount);
            const newRemain = Math.max(0, parseFloat(loan.remaining_balance || 0) - parseFloat(schedRow.scheduled_amount));
            const paidOff   = newRemain <= 0.01;
            await supabase.from('loans').update({
              total_paid:        newPaid,
              remaining_balance: newRemain,
              ...(paidOff ? { status: 'paid_off' } : {}),
            }).eq('id', schedRow.loan_id);
            console.log(`[vopay webhook] Payment collected — loan ${schedRow.loan_id} P${schedRow.payment_number} — ${paidOff ? 'PAID OFF' : 'active'}`);
          }
        }
      }

      // ── PAYMENT RETURNED / NSF ──────────────────────────────────────────────
      if (event.type === 'EFTFund' && (event.isReturned || event.isNSF)) {
        const refParts = event.ref.split('-P');
        const loanRef  = refParts[0];

        if (loanRef) {
          const { data: loan } = await supabase
            .from('loans').select('id,client_id').eq('ref', loanRef).maybeSingle();

          if (loan) {
            // Mark the specific schedule row as failed
            let schedQuery = supabase.from('repayment_schedule')
              .update({ status: 'failed', return_code: event.returnCode, return_reason: event.returnMsg, returned_at: new Date().toISOString() });

            if (event.txId) {
              schedQuery = schedQuery.eq('vopay_tx_id', event.txId);
            } else {
              schedQuery = schedQuery.eq('loan_id', loan.id).eq('status', 'scheduled');
            }
            await schedQuery;

            // Charge NSF fee
            if (event.isNSF) {
              await supabase.from('nsf_fees').insert({
                client_id:   loan.client_id,
                loan_id:     loan.id,
                amount:      settings.getLoanSettings().nsfFee,
                reason:      event.returnMsg || 'NSF via VoPay',
                return_code: event.returnCode,
                status:      'outstanding',
              });
              console.log(`[vopay webhook] NSF charged — loan ${loanRef}`);
            }
          }
        }
      }

    } catch (err) {
      console.error('[vopay webhook] Processing error:', err.message);
    }

    sendJSON(res, 200, { ok: true, received: event });
    return;
  }

  // ── POST /api/vopay/collect-today ─────────────────────────────────────────────
  // Cron endpoint — collect all payments due today via VoPay
  // Call daily: GET https://web-production-31ce.up.railway.app/api/vopay/collect-today
  if (req.method === 'POST' && req.url === '/api/vopay/collect-today') {
    if (!vopay.isConfigured()) {
      sendJSON(res, 400, { error: 'VoPay not configured' }); return;
    }

    const today = new Date().toISOString().slice(0, 10);
    console.log(`[vopay cron] Collecting payments due ${today}`);

    try {
      // Load all scheduled payments due today
      const { data: dueSched, error: schedErr } = await supabase
        .from('repayment_schedule')
        .select('*, loans(id,ref,client_id,payment_amount), clients(first_name,last_name,email,bank_transit,bank_institution,bank_account,vopay_token)')
        .eq('status', 'scheduled')
        .eq('due_date', today)
        .is('vopay_tx_id', null); // not already submitted

      if (schedErr) throw new Error(schedErr.message);
      if (!dueSched?.length) {
        sendJSON(res, 200, { ok: true, collected: 0, message: 'No payments due today' });
        return;
      }

      const results = [];
      for (const row of dueSched) {
        const loan   = row.loans;
        const client = row.clients;
        if (!loan || !client) { results.push({ id: row.id, error: 'Missing loan/client' }); continue; }

        try {
          const result = await vopay.collect({
            paymentId:   row.payment_number,
            loanRef:     loan.ref,
            amount:      parseFloat(row.scheduled_amount),
            firstName:   client.first_name,
            lastName:    client.last_name,
            bankToken:   client.vopay_token,
            transit:     client.bank_transit,
            institution: client.bank_institution,
            account:     client.bank_account,
            dueDate:     today,
          });

          const txId = result.TransactionID || result.EFTTransactionID;

          // Stamp the schedule row with VoPay tx ID
          await supabase.from('repayment_schedule').update({
            vopay_tx_id:       txId,
            vopay_submitted_at: new Date().toISOString(),
          }).eq('id', row.id);

          results.push({ id: row.id, loanRef: loan.ref, txId, status: 'submitted' });
          console.log(`[vopay cron] Submitted ${loan.ref} P${row.payment_number} — txId: ${txId}`);
        } catch (err) {
          results.push({ id: row.id, loanRef: loan.ref, error: err.message });
          console.error(`[vopay cron] Failed ${loan.ref} P${row.payment_number}:`, err.message);
        }
      }

      const submitted = results.filter(r => r.txId).length;
      const failed    = results.filter(r => r.error).length;
      console.log(`[vopay cron] Done — ${submitted} submitted, ${failed} failed`);
      sendJSON(res, 200, { ok: true, date: today, submitted, failed, results });
    } catch (err) {
      console.error('[vopay cron] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/vopay/disburse/:loanId ─────────────────────────────────────────
  // Manual VoPay disburse trigger from admin — for pending_disbursement loans
  if (req.method === 'POST' && req.url.startsWith('/api/vopay/disburse/')) {
    const loanId = req.url.split('/api/vopay/disburse/')[1];
    if (!loanId) { sendJSON(res, 400, { error: 'loanId required' }); return; }
    if (!vopay.isConfigured()) { sendJSON(res, 400, { error: 'VoPay not configured' }); return; }

    try {
      const { data: loan } = await supabase
        .from('loans').select('*').eq('id', loanId).single();
      if (!loan) { sendJSON(res, 404, { error: 'Loan not found' }); return; }
      if (loan.status !== 'pending_disbursement') {
        sendJSON(res, 400, { error: `Loan status is ${loan.status} — can only disburse pending_disbursement loans` }); return;
      }

      const { data: client } = await supabase
        .from('clients').select('*').eq('id', loan.client_id).single();
      const { data: appBanking } = await supabase
        .from('loan_applications').select('bank_transit,bank_institution,bank_account').eq('ref', loan.ref).maybeSingle();

      const result = await vopay.disburse({
        loanId:      loan.id,
        loanRef:     loan.ref,
        amount:      parseFloat(loan.principal),
        email:       client.email,
        firstName:   client.first_name,
        lastName:    client.last_name,
        bankToken:   client.vopay_token,
        transit:     appBanking?.bank_transit      || client.bank_transit,
        institution: appBanking?.bank_institution  || client.bank_institution,
        account:     appBanking?.bank_account      || client.bank_account,
      });

      const txId = result.TransactionID || result.EFTTransactionID;
      await supabase.from('loans').update({
        vopay_disburse_tx_id:  txId,
        vopay_disburse_status: 'submitted',
      }).eq('id', loanId);

      sendJSON(res, 200, { ok: true, txId, loanRef: loan.ref, amount: loan.principal });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
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
