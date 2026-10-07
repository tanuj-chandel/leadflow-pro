import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');

console.log('===============================================================');
console.log('PHASE 2 STEP 9E: END-TO-END CRM & OPPORTUNITY HARDENING SUITE');
console.log('===============================================================\n');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

let oppTestId = null;
let oppTenantBId = null;

try {
  // Section 1: Threat Model Validation - Data Sanitization & Negative Values
  console.log('--- Section 1: Data Integrity & Valuation Sanitization ---');

test('TM-03: Deal valuation rejects negative amounts via database CHECK constraint', () => {
  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO opportunities (id, tenant_id, lead_id, title, deal_value, created_at, updated_at)
      VALUES ('opp_invalid_neg', 'default', 'lead_dummy', 'Negative Deal', -500.0, datetime('now'), datetime('now'))
    `).run();
  }, /CHECK constraint failed/);
});

test('TM-03: createOpportunity sanitizes negative deal values to 0.0 fail-closed', () => {
  // Setup temp lead
  sqlite.prepare("DELETE FROM leads WHERE id = 'lead_test_tm03'").run();
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, tenant_id, createdAt)
    VALUES ('lead_test_tm03', 'Valuation Test Biz', '+919876500003', 'default', datetime('now'))
  `).run();

  const opp = db.createOpportunity({
    lead_id: 'lead_test_tm03',
    title: 'Sanitized Valuation Deal',
    deal_value: -15000,
    tenant_id: 'default'
  });

  assert.strictEqual(opp.dealValue, 0.0, 'Negative values must be clamped to 0.0');

  // Cleanup
  sqlite.prepare("DELETE FROM leads WHERE id = 'lead_test_tm03'").run();
});

test('TM-12: Currency code strictly validated against ISO whitelist (INR, USD, EUR, GBP)', () => {
  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO opportunities (id, tenant_id, lead_id, title, deal_value, currency, created_at, updated_at)
      VALUES ('opp_invalid_curr', 'default', 'lead_dummy', 'Bad Currency', 1000.0, 'XYZ', datetime('now'), datetime('now'))
    `).run();
  }, /CHECK constraint failed/);
});

// Section 2: Threat Model Validation - Stage Machine & Loss Taxonomy
console.log('\n--- Section 2: Stage Machine & Mandatory Loss Reason Enforcement ---');

test('Setup lead and opportunity for stage machine testing', () => {
  sqlite.prepare("DELETE FROM leads WHERE id = 'lead_test_tm_stage'").run();
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, tenant_id, createdAt)
    VALUES ('lead_test_tm_stage', 'Stage Machine Test Hospital', '+919876500004', 'default', datetime('now'))
  `).run();

  const opp = db.createOpportunity({
    lead_id: 'lead_test_tm_stage',
    title: 'Hospital Enterprise Contract',
    deal_value: 200000.0,
    stage: 'DISCOVERY',
    tenant_id: 'default'
  });
  oppTestId = opp.id;
  assert.ok(oppTestId);
});

test('TM-05: Transitioning to CLOSED_LOST without valid loss_reason_code is blocked', () => {
  assert.throws(() => {
    db.updateOpportunityStage(oppTestId, {
      new_stage: 'CLOSED_LOST',
      operator_id: 'op_compliance',
      tenant_id: 'default'
    });
  }, /MISSING_OR_INVALID_LOSS_REASON_CODE/);
});

test('TM-05: Transitioning to CLOSED_LOST with invalid code is blocked', () => {
  assert.throws(() => {
    db.updateOpportunityStage(oppTestId, {
      new_stage: 'CLOSED_LOST',
      loss_reason_code: 'CLIENT_ANGRY', // Not in whitelist
      loss_reason_notes: 'Valid explanatory notes length',
      operator_id: 'op_compliance',
      tenant_id: 'default'
    });
  }, /MISSING_OR_INVALID_LOSS_REASON_CODE/);
});

test('TM-05: Transitioning to CLOSED_LOST with short notes (<5 chars) is blocked', () => {
  assert.throws(() => {
    db.updateOpportunityStage(oppTestId, {
      new_stage: 'CLOSED_LOST',
      loss_reason_code: 'COMPETITOR',
      loss_reason_notes: 'lost', // 4 characters
      operator_id: 'op_compliance',
      tenant_id: 'default'
    });
  }, /LOSS_REASON_NOTES_REQUIRED_MIN_5_CHARS/);
});

test('TM-06: Append-only history ledger records every intermediate stage and attribution', () => {
  // Advance through full sequence
  db.updateOpportunityStage(oppTestId, {
    new_stage: 'DEMO_BOOKED',
    operator_id: 'op_scheduler',
    transition_reason: 'Cal.com booking confirmed',
    tenant_id: 'default'
  });
  db.updateOpportunityStage(oppTestId, {
    new_stage: 'QUALIFIED',
    operator_id: 'op_sales_rep',
    transition_reason: 'Needs analysis and budget validated',
    tenant_id: 'default'
  });
  db.updateOpportunityStage(oppTestId, {
    new_stage: 'PROPOSAL_SENT',
    operator_id: 'op_sales_director',
    transition_reason: 'Formal proposal sent via email',
    tenant_id: 'default'
  });
  db.updateOpportunityStage(oppTestId, {
    new_stage: 'NEGOTIATION',
    operator_id: 'op_sales_director',
    transition_reason: 'Contract discount terms under review',
    tenant_id: 'default'
  });
  db.updateOpportunityStage(oppTestId, {
    new_stage: 'CLOSED_WON',
    operator_id: 'op_sales_director',
    transition_reason: 'Signed service agreement received',
    tenant_id: 'default'
  });

  const history = db.getOpportunityHistory(oppTestId, 'default');
  assert.strictEqual(history.length, 6, 'Should have exactly 6 historical stage records');
  assert.strictEqual(history[0].newStage, 'DISCOVERY');
  assert.strictEqual(history[1].newStage, 'DEMO_BOOKED');
  assert.strictEqual(history[2].newStage, 'QUALIFIED');
  assert.strictEqual(history[3].newStage, 'PROPOSAL_SENT');
  assert.strictEqual(history[4].newStage, 'NEGOTIATION');
  assert.strictEqual(history[5].newStage, 'CLOSED_WON');
});

// Section 3: Cross-Tenant Isolation & IDOR Attack Matrix
console.log('\n--- Section 3: Cross-Tenant Isolation & IDOR Protection ---');

let oppTenantBId = null;

test('Setup Tenant B deal for IDOR attack tests', () => {
  sqlite.prepare("DELETE FROM leads WHERE id = 'lead_test_tm_tenantb'").run();
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, tenant_id, createdAt)
    VALUES ('lead_test_tm_tenantb', 'Tenant B Target Clinic', '+919876500005', 'tenant_b', datetime('now'))
  `).run();

  const oppB = db.createOpportunity({
    lead_id: 'lead_test_tm_tenantb',
    title: 'Confidential Tenant B Project',
    deal_value: 95000.0,
    stage: 'DEMO_BOOKED',
    tenant_id: 'tenant_b'
  });
  oppTenantBId = oppB.id;
  assert.ok(oppTenantBId);
});

test('TM-01: IDOR Attack - Tenant A cannot view Tenant B opportunity via getOpportunityById', () => {
  const opp = db.getOpportunityById(oppTenantBId, 'default');
  assert.strictEqual(opp, null, 'Must fail closed with null');
});

test('TM-01: IDOR Attack - Tenant A cannot update Tenant B opportunity stage', () => {
  assert.throws(() => {
    db.updateOpportunityStage(oppTenantBId, {
      new_stage: 'CLOSED_WON',
      tenant_id: 'default'
    });
  }, /OPPORTUNITY_NOT_FOUND/);
});

test('TM-01: IDOR Attack - Tenant A cannot update Tenant B opportunity details', () => {
  assert.throws(() => {
    db.updateOpportunity(oppTenantBId, {
      title: 'Hacked Title'
    }, 'default');
  }, /OPPORTUNITY_NOT_FOUND/);
});

test('TM-10: IDOR Attack - Tenant A cannot create or view tasks on Tenant B opportunity', () => {
  assert.throws(() => {
    db.createOpportunityTask({
      opportunity_id: oppTenantBId,
      task_type: 'CALL',
      title: 'Unauthorized Task',
      due_date: '2026-10-01T10:00:00Z',
      tenant_id: 'default'
    });
  }, /OPPORTUNITY_NOT_FOUND/);

  const tasks = db.listOpportunityTasks(oppTenantBId, 'default');
  assert.strictEqual(tasks.length, 0, 'Cross-tenant task list must be empty');
});

// Section 4: Cal.com Webhook Idempotency & Meeting Task Deduplication
console.log('\n--- Section 4: Cal.com Webhook Bridge & Task Deduplication ---');

test('TM-08: Cal.com booking sync creates opportunity and scheduled meeting task', () => {
  const conv = db.getOrCreateConversation({
    tenantId: 'default',
    leadId: 'lead_test_tm_stage',
    channel: 'whatsapp',
    externalThreadId: '+919876500004'
  });

  const synced = db.syncOpportunityFromConversation({
    conversationId: conv.id,
    tenantId: 'default',
    bookingData: {
      bookingUid: 'cal_uid_adversarial_001',
      startTime: '2026-10-15T11:00:00Z',
      name: 'Dr. Stage Test'
    },
    operatorId: 'cal_com_webhook'
  });

  assert.ok(synced);
  const tasks = db.listOpportunityTasks(synced.id, 'default');
  assert.ok(tasks.length >= 1);
  const meetingTask = tasks.find(t => t.title.includes('cal_uid_adversarial_001'));
  assert.ok(meetingTask, 'Task must be created for booking UID');
  assert.strictEqual(meetingTask.status, 'PENDING');
});

test('TM-08: Cal.com duplicate webhook replay does NOT create duplicate tasks', () => {
  const conv = db.getOrCreateConversation({
    tenantId: 'default',
    leadId: 'lead_test_tm_stage',
    channel: 'whatsapp',
    externalThreadId: '+919876500004'
  });

  const tasksBefore = db.listOpportunityTasks(oppTestId, 'default');

  // Replay identical webhook
  db.syncOpportunityFromConversation({
    conversationId: conv.id,
    tenantId: 'default',
    bookingData: {
      bookingUid: 'cal_uid_adversarial_001',
      startTime: '2026-10-15T11:00:00Z',
      name: 'Dr. Stage Test'
    },
    operatorId: 'cal_com_webhook'
  });

  const tasksAfter = db.listOpportunityTasks(oppTestId, 'default');
  assert.strictEqual(tasksAfter.length, tasksBefore.length, 'Task count must remain strictly identical');
});

// Section 5: Referential Integrity & Cleanup
console.log('\n--- Section 5: Referential Integrity & Cleanup ---');

test('TM-02: Deleting leads cascades and removes opportunities, history, and tasks', () => {
  sqlite.prepare("DELETE FROM leads WHERE id IN ('lead_test_tm_stage', 'lead_test_tm_tenantb')").run();

  // Verify opportunity deleted
  const checkOppA = sqlite.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppTestId);
  const checkOppB = sqlite.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppTenantBId);
  assert.strictEqual(checkOppA, undefined);
  assert.strictEqual(checkOppB, undefined);

  // Verify history deleted
  const history = sqlite.prepare('SELECT * FROM opportunity_stage_history WHERE opportunity_id = ?').all(oppTestId);
  assert.strictEqual(history.length, 0);

  // Verify tasks deleted
  const tasks = sqlite.prepare('SELECT * FROM opportunity_tasks WHERE opportunity_id = ?').all(oppTestId);
  assert.strictEqual(tasks.length, 0);
});

// Section 6: Baseline Invariants Verification
console.log('\n--- Section 6: Database Baseline Invariants Confirmation ---');

test('TM-11: Baseline Invariant - Exactly 145 real baseline leads in tenant "default"', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM leads WHERE tenant_id = 'default'").get().c;
  assert.strictEqual(count, 145, `Expected 145 baseline leads, found ${count}`);
});

test('TM-11: Baseline Invariant - Exactly 175 lead evidence rows preserved', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM lead_evidence").get().c;
  assert.strictEqual(count, 175, `Expected 175 evidence rows, found ${count}`);
});

test('TM-11: Baseline Invariant - Exactly 40 approved historical snapshots preserved', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM campaign_approved_snapshots").get().c;
  assert.strictEqual(count, 40, `Expected 40 approved snapshots, found ${count}`);
});

test('TM-11: Baseline Invariant - SQLite WAL mode active', () => {
  const jm = sqlite.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.strictEqual(jm.toLowerCase(), 'wal');
});

test('TM-11: Baseline Invariant - Foreign keys enabled and 0 violations', () => {
  const fk = sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys;
  assert.strictEqual(fk, 1);
  const fkCheck = sqlite.prepare("PRAGMA foreign_key_check").all();
  assert.strictEqual(fkCheck.length, 0, `Expected 0 violations, found ${fkCheck.length}`);
});

test('TM-11: Baseline Invariant - PRAGMA integrity_check = ok', () => {
  const ic = sqlite.prepare("PRAGMA integrity_check").get().integrity_check;
  assert.strictEqual(ic, 'ok');
});

console.log('\n===============================================================');
console.log(`STEP 9E HARVEST COMPLETE: ${passCount} / ${passCount} ASSERTIONS PASS (100%)`);
console.log('===============================================================\n');
} finally {
  try {
    performCompleteTeardown(sqlite, ['tenant_b', 'tenant_a'], [
      'lead_test_tm03', 
      'lead_test_tm_stage', 
      'lead_test_tm_tenantb', 
      'lead_dummy'
    ]);
  } catch (err) {
    console.error('  ⚠️ Teardown error:', err.message);
  } finally {
    sqlite.close();
  }
}

