'use strict';

/**
 * Waves Financial — Database Layer v2
 *
 * Tables: clients, loan_applications, loans, repayment_schedule, contracts
 *
 * Entry point: saveApplication(applicationPayload, scoringResult, bankData)
 *   1. Upsert client (by email)
 *   2. Save loan_application (linked to client)
 *   3. If auto_approved: create loan + repayment_schedule + contract
 */

const { supabase } = require('./supabaseClient');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const APR           = 0.23;
const TERM_DAYS     = 112;
const PAYMENT_COUNT = 8;
const PAYMENT_FREQ  = 'biweekly';
const BIWEEKLY_DAYS = 14;


// ─── HELPERS ──────────────────────────────────────────────────────────────────

function calcPaymentAmount(principal) {
  return parseFloat(((principal * (1 + APR * TERM_DAYS / 365)) / PAYMENT_COUNT).toFixed(2));
}

function calcTotalRepayable(principal) {
  return parseFloat((calcPaymentAmount(principal) * PAYMENT_COUNT).toFixed(2));
}

// Generate the 8 biweekly due dates starting from nextPayDate
function generateDueDates(nextPayDateStr) {
  const dates = [];
  let d = nextPayDateStr ? new Date(nextPayDateStr) : new Date();
  // Ensure we start in the future
  const today = new Date();
  if (d <= today) {
    d = new Date(today.getTime() + BIWEEKLY_DAYS * 86400000);
  }
  for (let i = 0; i < PAYMENT_COUNT; i++) {
    dates.push(new Date(d));
    d = new Date(d.getTime() + BIWEEKLY_DAYS * 86400000);
  }
  return dates;
}

function dateToISO(d) {
  return d.toISOString().slice(0, 10);
}


// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

async function saveApplication(applicationPayload, scoringResult, bankData) {
  if (!supabase) {
    console.warn('[db] Supabase not configured — skipping save');
    return null;
  }

  const { personal, employment, loan, signature, banking, safetyContact } = applicationPayload;

  try {
    // 1. Upsert client
    const client = await upsertClient(applicationPayload, scoringResult);
    if (!client) throw new Error('Failed to upsert client');

    // 2. Save application
    const application = await saveAppRecord(applicationPayload, scoringResult, bankData, client.id);
    if (!application) throw new Error('Failed to save application record');

    // 3. If auto_approved — create loan, schedule, contract
    if (scoringResult.decision === 'auto_approved') {
      const loanRecord = await createLoan(applicationPayload, scoringResult, client.id, application.id);
      if (loanRecord) {
        // Link application to loan
        await supabase.from('loan_applications').update({ loan_id: loanRecord.id }).eq('id', application.id);
        await createRepaymentSchedule(loanRecord, client.id, employment?.nextPay);
        await createContract(applicationPayload, scoringResult, loanRecord, client.id, application.id);
        // Update client stats
        await updateClientStats(client.id);
      }
    } else {
      // Update client stats (total_applications)
      await updateClientStats(client.id);
    }

    console.log(`[db] Saved: ${applicationPayload.ref} → client ${client.id.slice(0,8)}… (${scoringResult.decision})`);
    return { clientId: client.id, applicationId: application.id };

  } catch (err) {
    console.error('[db] saveApplication error:', err.message);
    return null;
  }
}


// ─── UPSERT CLIENT ────────────────────────────────────────────────────────────

async function upsertClient(payload, scoringResult) {
  const { personal, employment, banking } = payload;
  const email = personal?.email?.toLowerCase().trim();
  if (!email) return null;

  const clientData = {
    email,
    first_name:              personal.firstName,
    last_name:               personal.lastName,
    cell_phone:              personal.cellPhone,
    home_phone:              personal.homePhone,
    dob:                     personal.dob || null,
    sex:                     personal.sex,
    address:                 personal.address,
    apt:                     personal.apt,
    city:                    personal.city,
    province:                personal.province,
    postal:                  personal.postal,
    employment_status:       employment?.source ?? employment?.employmentStatus,
    employer:                employment?.employer,
    work_phone:              employment?.workPhone,
    job_desc:                employment?.jobDesc,
    hire_date:               employment?.hireDate || null,
    paid_by:                 employment?.paidBy,
    pay_frequency:           employment?.payFrequency ?? employment?.payFreq,
    declared_monthly_income: personal?.declaredIncome ?? employment?.monthlyIncome ?? null,
    bank_transit:            banking?.transitNumber    || null,
    bank_institution:        banking?.institutionNumber || null,
    bank_account:            banking?.accountNumber    || null,
    bank_name:               banking?.institution      || null,
    ...(banking?.iq11Token ? { vopay_token: banking.iq11Token, vopay_token_at: new Date().toISOString() } : {}),
    latest_tier:             scoringResult.tier,
    latest_score:            scoringResult.score,
    latest_decision:         scoringResult.decision,
    updated_at:              new Date().toISOString(),
  };

  // Try to find existing client first
  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    // Update existing client with latest info
    const { data, error } = await supabase
      .from('clients')
      .update(clientData)
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) { console.error('[db] Client update error:', error.message); return existing; }
    return data || existing;
  } else {
    // Create new client
    const { data, error } = await supabase
      .from('clients')
      .insert({ ...clientData, created_at: new Date().toISOString() })
      .select('id')
      .single();
    if (error) { console.error('[db] Client insert error:', error.message); return null; }
    return data;
  }
}


// ─── SAVE APPLICATION RECORD ──────────────────────────────────────────────────

async function saveAppRecord(payload, scoringResult, bankData, clientId) {
  const { personal, employment, loan, signature, banking, safetyContact } = payload;

  const sc = safetyContact;
  const row = {
    ref:            payload.ref,
    submitted_at:   payload.submittedAt,
    type:           payload.type || 'new',
    client_id:      clientId,

    decision:       scoringResult.decision,
    tier:           scoringResult.tier,
    risk_score:     scoringResult.score,
    approved_amount: scoringResult.approvedAmount,
    feasible_amount:   scoringResult.feasibleAmount ?? scoringResult.approvedAmount,
    feasibility_list:  scoringResult.feasibilityList ?? [],
    hard_decline:      scoringResult.hardDecline,
    flags:          scoringResult.flags,
    signals:        scoringResult.signals,

    requested_amount: loan?.amount,
    fund_method:      loan?.fundMethod,
    bankrupt_now:     loan?.bankruptNow,
    bankrupt_past:    loan?.bankruptPast,

    employment_status:       employment?.source ?? employment?.employmentStatus,
    employer:                employment?.employer,
    work_phone:              employment?.workPhone,
    job_desc:                employment?.jobDesc,
    supervisor:              employment?.supervisor,
    hire_date:               employment?.hireDate || null,
    ei_start_date:           employment?.eiStart || null,
    paid_by:                 employment?.paidBy,
    other_income_type:       employment?.otherIncome,
    pay_frequency:           employment?.payFrequency ?? employment?.payFreq,
    next_pay_date:           employment?.nextPay || null,
    declared_monthly_income: personal?.declaredIncome ?? employment?.monthlyIncome ?? null,

    sex:                     personal?.sex,
    apt:                     personal?.apt,

    flinks_login_id:   banking?.flinksLoginId,
    bank_name:         banking?.institution,
    is_sandbox:        banking?.sandbox ?? false,
    bank_transit:      banking?.transitNumber   || null,
    bank_institution:  banking?.institutionNumber || null,
    bank_account:      banking?.accountNumber   || null,
    iq11_token:        banking?.iq11Token        || null,
    verified_income:   bankData?.verifiedIncome,
    fixed_obligations: bankData?.fixedObligations,
    avg_daily_balance: bankData?.avgDailyBalance,
    nsf_count:         bankData?.nsfCount,
    opposition_count:  bankData?.oppositionCount,
    account_age_days:  bankData?.accountAgeDays,
    income_regularity: bankData?.incomeRegularity,

    esig_name:      signature?.fullName,
    esig_timestamp: signature?.timestamp,

    safety_contact_name:        sc ? `${sc.firstName || ''} ${sc.lastName || ''}`.trim() : null,
    safety_contact_first_name:  sc?.firstName || null,
    safety_contact_last_name:   sc?.lastName  || null,
    safety_contact_phone:       sc?.phone,
    safety_contact_rel:         sc?.relationship,
  };

  const { data, error } = await supabase
    .from('loan_applications')
    .insert(row)
    .select('id')
    .single();

  if (error) { console.error('[db] Application insert error:', error.message); return null; }
  return data;
}


// ─── CREATE LOAN ──────────────────────────────────────────────────────────────

async function createLoan(payload, scoringResult, clientId, applicationId) {
  const principal = scoringResult.approvedAmount;
  const paymentAmt = calcPaymentAmount(principal);
  const totalRepayable = calcTotalRepayable(principal);

  const row = {
    client_id:       clientId,
    application_id:  applicationId,
    ref:             payload.ref,
    type:            payload.type || 'new',
    principal,
    apr:             APR,
    term_days:       TERM_DAYS,
    payment_count:   PAYMENT_COUNT,
    payment_frequency: PAYMENT_FREQ,
    payment_amount:  paymentAmt,
    total_repayable: totalRepayable,
    remaining_balance: totalRepayable,
    status:          'pending_disbursement',
    fund_method:     payload.loan?.fundMethod,
    disbursed_at:    new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('loans')
    .insert(row)
    .select('id, ref, principal, payment_amount, total_repayable')
    .single();

  if (error) { console.error('[db] Loan insert error:', error.message); return null; }
  return data;
}


// ─── CREATE REPAYMENT SCHEDULE ────────────────────────────────────────────────

async function createRepaymentSchedule(loanRecord, clientId, nextPayDateStr) {
  const dueDates = generateDueDates(nextPayDateStr);
  const paymentAmt = loanRecord.payment_amount;

  const rows = dueDates.map((date, i) => ({
    loan_id:          loanRecord.id,
    client_id:        clientId,
    payment_number:   i + 1,
    due_date:         dateToISO(date),
    scheduled_amount: paymentAmt,
    status:           'scheduled',
  }));

  const { error } = await supabase.from('repayment_schedule').insert(rows);
  if (error) console.error('[db] Schedule insert error:', error.message);

  // Update loan due_date to final payment date
  const finalDate = dateToISO(dueDates[dueDates.length - 1]);
  await supabase.from('loans').update({ due_date: finalDate }).eq('id', loanRecord.id);
}


// ─── CREATE CONTRACT ──────────────────────────────────────────────────────────

async function createContract(payload, scoringResult, loanRecord, clientId, applicationId) {
  const { personal, employment, loan, signature, banking } = payload;
  const dueDates = generateDueDates(employment?.nextPay);

  const row = {
    loan_id:          loanRecord.id,
    client_id:        clientId,
    application_id:   applicationId,
    principal:        loanRecord.principal,
    apr:              APR,
    term_days:        TERM_DAYS,
    payment_count:    PAYMENT_COUNT,
    payment_amount:   loanRecord.payment_amount,
    total_repayable:  loanRecord.total_repayable,
    payment_frequency: PAYMENT_FREQ,
    first_payment_date: dueDates.length ? dateToISO(dueDates[0]) : null,
    final_payment_date: dueDates.length ? dateToISO(dueDates[dueDates.length - 1]) : null,
    fund_method:      loan?.fundMethod,
    borrower_name:    `${personal?.firstName || ''} ${personal?.lastName || ''}`.trim(),
    borrower_email:   personal?.email,
    borrower_address: [personal?.address, personal?.city, personal?.province, personal?.postal].filter(Boolean).join(', '),
    borrower_province: personal?.province,
    esig_name:        signature?.fullName,
    esig_timestamp:   signature?.timestamp,
    pad_authorized:   true,
    pad_institution:  banking?.institution,
  };

  const { error } = await supabase.from('contracts').insert(row);
  if (error) console.error('[db] Contract insert error:', error.message);
}


// ─── UPDATE CLIENT STATS ──────────────────────────────────────────────────────

async function updateClientStats(clientId) {
  // Count applications
  const { count: appCount } = await supabase
    .from('loan_applications')
    .select('id', { count: 'exact' })
    .eq('client_id', clientId);

  // Count and sum loans
  const { data: loans } = await supabase
    .from('loans')
    .select('principal, total_paid')
    .eq('client_id', clientId);

  const totalLoans    = loans?.length ?? 0;
  const totalBorrowed = loans?.reduce((s, l) => s + parseFloat(l.principal || 0), 0) ?? 0;
  const totalRepaid   = loans?.reduce((s, l) => s + parseFloat(l.total_paid || 0), 0) ?? 0;

  await supabase.from('clients').update({
    total_applications: appCount ?? 0,
    total_loans:        totalLoans,
    total_borrowed:     totalBorrowed,
    total_repaid:       totalRepaid,
  }).eq('id', clientId);
}


// ─── READ OPERATIONS (for admin dashboard) ────────────────────────────────────

async function getClientByEmail(email) {
  if (!supabase) return null;
  const { data } = await supabase.from('clients').select('*').eq('email', email.toLowerCase()).single();
  return data;
}

async function getClientById(id) {
  if (!supabase) return null;
  const { data } = await supabase.from('clients').select('*').eq('id', id).single();
  return data;
}

async function getClientApplications(clientId) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('loan_applications')
    .select('*')
    .eq('client_id', clientId)
    .order('submitted_at', { ascending: false });
  return data ?? [];
}

async function getClientLoans(clientId) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('loans')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

async function getLoanSchedule(loanId) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('repayment_schedule')
    .select('*')
    .eq('loan_id', loanId)
    .order('payment_number', { ascending: true });
  return data ?? [];
}

async function getLoanContract(loanId) {
  if (!supabase) return null;
  const { data } = await supabase.from('contracts').select('*').eq('loan_id', loanId).single();
  return data;
}

async function getApplicationByRef(ref) {
  if (!supabase) return null;
  const { data } = await supabase.from('loan_applications').select('*').eq('ref', ref).single();
  return data;
}

async function sendMagicLink(email, redirectTo) {
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
  if (error) return { error: error.message };
  return { success: true };
}


module.exports = {
  saveApplication,
  upsertClient,
  updateClientStats,
  getClientByEmail,
  getClientById,
  getClientApplications,
  getClientLoans,
  getLoanSchedule,
  getLoanContract,
  getApplicationByRef,
  sendMagicLink,
  // approval flow
  createLoan,
  createRepaymentSchedule,
  createContract,
};
