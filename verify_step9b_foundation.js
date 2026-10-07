import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');

console.log('===============================================================');
console.log('PHASE 2 STEP 9B: CRM & OPPORTUNITY MANAGEMENT VERIFICATION');
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

let testLeadDefaultId = null;
let testLeadTenantBId = null;
let testContactDefaultId = null;
let createdOppDefaultId = null;
let createdOppTenantBId = null;
let createdTaskId = null;

try {
  // Section 1: Database Schema & Migration Verification
  console.log('--- Section 1: Schema & Additive Tables Verification ---');

  test('Table "opportunities" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opportunities'").get();
  assert.ok(table, 'opportunities table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(opportunities)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('lead_id'), 'has lead_id');
  assert.ok(cols.includes('contact_id'), 'has contact_id');
  assert.ok(cols.includes('title'), 'has title');
  assert.ok(cols.includes('deal_value'), 'has deal_value');
  assert.ok(cols.includes('currency'), 'has currency');
  assert.ok(cols.includes('stage'), 'has stage');
  assert.ok(cols.includes('confidence_probability'), 'has confidence_probability');
  assert.ok(cols.includes('expected_close_date'), 'has expected_close_date');
  assert.ok(cols.includes('loss_reason_code'), 'has loss_reason_code');
  assert.ok(cols.includes('loss_reason_notes'), 'has loss_reason_notes');
  assert.ok(cols.includes('assigned_operator_id'), 'has assigned_operator_id');
});

test('Table "opportunity_stage_history" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opportunity_stage_history'").get();
  assert.ok(table, 'opportunity_stage_history table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(opportunity_stage_history)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('opportunity_id'), 'has opportunity_id');
  assert.ok(cols.includes('previous_stage'), 'has previous_stage');
  assert.ok(cols.includes('new_stage'), 'has new_stage');
  assert.ok(cols.includes('changed_by_operator'), 'has changed_by_operator');
  assert.ok(cols.includes('transition_reason'), 'has transition_reason');
});

test('Table "opportunity_tasks" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opportunity_tasks'").get();
  assert.ok(table, 'opportunity_tasks table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(opportunity_tasks)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('opportunity_id'), 'has opportunity_id');
  assert.ok(cols.includes('task_type'), 'has task_type');
  assert.ok(cols.includes('title'), 'has title');
  assert.ok(cols.includes('status'), 'has status');
  assert.ok(cols.includes('due_date'), 'has due_date');
});

// Section 2: Opportunity Creation & Scope Validation
console.log('\n--- Section 2: Multi-Tenant Opportunity Creation & Validation ---');

test('Setup isolated test leads and contacts for CRM testing', () => {
  const now = new Date().toISOString();
  
  // Clean up any old test records
  sqlite.prepare("DELETE FROM leads WHERE id IN ('lead_test_crm_default', 'lead_test_crm_tenantb') OR phone IN ('+919876599001', '+919876599002')").run();

  testLeadDefaultId = 'lead_test_crm_default';
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, email, tenant_id, createdAt)
    VALUES (?, 'CRM Test Enterprise Default', '+919876599001', 'crm.default@test.com', 'default', ?)
  `).run(testLeadDefaultId, now);

  testLeadTenantBId = 'lead_test_crm_tenantb';
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, email, tenant_id, createdAt)
    VALUES (?, 'CRM Test Enterprise TenantB', '+919876599002', 'crm.tenantb@test.com', 'tenant_b', ?)
  `).run(testLeadTenantBId, now);

  testContactDefaultId = `cnt_${Date.now()}_test`;
  sqlite.prepare(`
    INSERT INTO lead_contacts (id, lead_id, tenant_id, contact_name, email, phone, is_decision_maker, provenance_type, created_at, updated_at)
    VALUES (?, ?, 'default', 'Dr. Ramesh Sharma', 'ramesh@test.com', '+919876599001', 1, 'VERIFIED', ?, ?)
  `).run(testContactDefaultId, testLeadDefaultId, now, now);

  assert.ok(testLeadDefaultId);
  assert.ok(testLeadTenantBId);
});

test('Successfully create opportunity in default tenant', () => {
  const opp = db.createOpportunity({
    lead_id: testLeadDefaultId,
    contact_id: testContactDefaultId,
    title: 'Hospital Workflow Automation',
    deal_value: 150000.0,
    currency: 'INR',
    stage: 'DISCOVERY',
    assigned_operator_id: 'op_dr_ramesh',
    metadata: { source: 'inbound_chat' },
    tenant_id: 'default',
    operator_id: 'admin_test'
  });

  assert.ok(opp);
  assert.ok(opp.id.startsWith('opp_'));
  assert.strictEqual(opp.tenantId, 'default');
  assert.strictEqual(opp.title, 'Hospital Workflow Automation');
  assert.strictEqual(opp.dealValue, 150000.0);
  assert.strictEqual(opp.stage, 'DISCOVERY');
  assert.strictEqual(opp.confidenceProbability, 0.20);
  assert.strictEqual(opp.lead.businessName, 'CRM Test Enterprise Default');
  assert.strictEqual(opp.contact.name, 'Dr. Ramesh Sharma');
  createdOppDefaultId = opp.id;
});

test('Creating opportunity creates initial append-only history record', () => {
  const history = db.getOpportunityHistory(createdOppDefaultId, 'default');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].previousStage, null);
  assert.strictEqual(history[0].newStage, 'DISCOVERY');
  assert.strictEqual(history[0].changedByOperator, 'admin_test');
  assert.strictEqual(history[0].transitionReason, 'OPPORTUNITY_CREATED');
});

test('Fail-closed: createOpportunity rejects non-existent lead', () => {
  assert.throws(() => {
    db.createOpportunity({
      lead_id: 99999999,
      title: 'Invalid Deal',
      tenant_id: 'default'
    });
  }, /LEAD_NOT_FOUND/);
});

test('Fail-closed: createOpportunity rejects cross-tenant lead association', () => {
  assert.throws(() => {
    // Attempting to attach tenant_b lead while acting as tenant 'default'
    db.createOpportunity({
      lead_id: testLeadTenantBId,
      title: 'Cross-Tenant Hijack',
      tenant_id: 'default'
    });
  }, /CROSS_TENANT_LEAD_FORBIDDEN/);
});

test('Fail-closed: createOpportunity rejects contact not belonging to lead', () => {
  assert.throws(() => {
    db.createOpportunity({
      lead_id: testLeadTenantBId,
      contact_id: testContactDefaultId, // Belongs to testLeadDefaultId!
      title: 'Mismatched Contact Deal',
      tenant_id: 'tenant_b'
    });
  }, /INVALID_CONTACT_ASSOCIATION/);
});

// Section 3: Multi-Tenant Retrieval & IDOR Isolation
console.log('\n--- Section 3: Multi-Tenant Isolation & IDOR Protection ---');

test('Create opportunity in tenant_b', () => {
  const oppB = db.createOpportunity({
    lead_id: testLeadTenantBId,
    title: 'Tenant B Exclusive Project',
    deal_value: 50000.0,
    currency: 'INR',
    stage: 'DEMO_BOOKED',
    tenant_id: 'tenant_b',
    operator_id: 'op_tenant_b'
  });

  assert.ok(oppB);
  assert.strictEqual(oppB.tenantId, 'tenant_b');
  assert.strictEqual(oppB.confidenceProbability, 0.40);
  createdOppTenantBId = oppB.id;
});

test('IDOR Protection: Tenant default cannot view Tenant B opportunity', () => {
  const opp = db.getOpportunityById(createdOppTenantBId, 'default');
  assert.strictEqual(opp, null, 'Cross-tenant lookup must return null (fail-closed)');
});

test('IDOR Protection: Tenant B cannot view Tenant default opportunity', () => {
  const opp = db.getOpportunityById(createdOppDefaultId, 'tenant_b');
  assert.strictEqual(opp, null, 'Cross-tenant lookup must return null (fail-closed)');
});

test('Multi-Tenant list isolation: listing by default tenant excludes tenant_b deals', () => {
  const listDefault = db.listOpportunities({ tenant_id: 'default' });
  const idsDefault = listDefault.map(o => o.id);
  assert.ok(idsDefault.includes(createdOppDefaultId));
  assert.ok(!idsDefault.includes(createdOppTenantBId), 'Tenant B deal must NOT appear in default list');

  const listB = db.listOpportunities({ tenant_id: 'tenant_b' });
  const idsB = listB.map(o => o.id);
  assert.ok(idsB.includes(createdOppTenantBId));
  assert.ok(!idsB.includes(createdOppDefaultId), 'Default deal must NOT appear in tenant_b list');
});

// Section 4: Pipeline State Machine Transitions & Audit History
console.log('\n--- Section 4: Pipeline State Machine Transitions & Audit History ---');

test('Valid stage transition: DISCOVERY -> DEMO_BOOKED', () => {
  const updated = db.updateOpportunityStage(createdOppDefaultId, {
    new_stage: 'DEMO_BOOKED',
    operator_id: 'op_scheduler',
    transition_reason: 'Prospect scheduled Cal.com 2-min demo',
    tenant_id: 'default'
  });

  assert.strictEqual(updated.stage, 'DEMO_BOOKED');
  assert.strictEqual(updated.confidenceProbability, 0.40);

  const history = db.getOpportunityHistory(createdOppDefaultId, 'default');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[1].previousStage, 'DISCOVERY');
  assert.strictEqual(history[1].newStage, 'DEMO_BOOKED');
  assert.strictEqual(history[1].changedByOperator, 'op_scheduler');
});

test('Valid stage transition: DEMO_BOOKED -> QUALIFIED -> PROPOSAL_SENT', () => {
  db.updateOpportunityStage(createdOppDefaultId, {
    new_stage: 'QUALIFIED',
    operator_id: 'op_sales',
    transition_reason: 'Budget and pain confirmed during demo',
    tenant_id: 'default'
  });

  const updated = db.updateOpportunityStage(createdOppDefaultId, {
    new_stage: 'PROPOSAL_SENT',
    operator_id: 'op_sales',
    transition_reason: 'Enterprise automation proposal delivered via email',
    tenant_id: 'default'
  });

  assert.strictEqual(updated.stage, 'PROPOSAL_SENT');
  assert.strictEqual(updated.confidenceProbability, 0.75);

  const history = db.getOpportunityHistory(createdOppDefaultId, 'default');
  assert.strictEqual(history.length, 4);
});

test('Terminal State: Transition to CLOSED_LOST without loss_reason_code fails closed', () => {
  assert.throws(() => {
    db.updateOpportunityStage(createdOppDefaultId, {
      new_stage: 'CLOSED_LOST',
      operator_id: 'op_sales',
      tenant_id: 'default'
    });
  }, /MISSING_OR_INVALID_LOSS_REASON_CODE/);
});

test('Terminal State: Transition to CLOSED_LOST without sufficient notes fails closed', () => {
  assert.throws(() => {
    db.updateOpportunityStage(createdOppDefaultId, {
      new_stage: 'CLOSED_LOST',
      loss_reason_code: 'PRICING',
      loss_reason_notes: 'no', // Less than 5 characters!
      operator_id: 'op_sales',
      tenant_id: 'default'
    });
  }, /LOSS_REASON_NOTES_REQUIRED_MIN_5_CHARS/);
});

test('Terminal State: Valid CLOSED_LOST transition with audited reason succeeds', () => {
  const opp = db.createOpportunity({
    lead_id: testLeadDefaultId,
    title: 'Secondary Test Deal',
    deal_value: 30000.0,
    stage: 'DISCOVERY',
    tenant_id: 'default'
  });

  const lost = db.updateOpportunityStage(opp.id, {
    new_stage: 'CLOSED_LOST',
    loss_reason_code: 'NO_BUDGET',
    loss_reason_notes: 'Client decided to defer all software automation to Q3 budget cycle',
    operator_id: 'op_sales',
    transition_reason: 'Prospect requested postponement',
    tenant_id: 'default'
  });

  assert.strictEqual(lost.stage, 'CLOSED_LOST');
  assert.strictEqual(lost.confidenceProbability, 0.0);
  assert.strictEqual(lost.lossReasonCode, 'NO_BUDGET');
  assert.strictEqual(lost.lossReasonNotes, 'Client decided to defer all software automation to Q3 budget cycle');
});

test('Terminal State: Valid CLOSED_WON transition sets probability to 1.0', () => {
  const won = db.updateOpportunityStage(createdOppDefaultId, {
    new_stage: 'CLOSED_WON',
    operator_id: 'op_sales',
    transition_reason: 'Contract signed and initial deposit received',
    tenant_id: 'default'
  });

  assert.strictEqual(won.stage, 'CLOSED_WON');
  assert.strictEqual(won.confidenceProbability, 1.0);

  const history = db.getOpportunityHistory(createdOppDefaultId, 'default');
  const lastEntry = history[history.length - 1];
  assert.strictEqual(lastEntry.newStage, 'CLOSED_WON');
  assert.strictEqual(lastEntry.changedByOperator, 'op_sales');
});

// Section 5: Opportunity Tasks Lifecycle
console.log('\n--- Section 5: Opportunity Tasks Lifecycle ---');

test('Create task for opportunity', () => {
  const task = db.createOpportunityTask({
    opportunity_id: createdOppDefaultId,
    task_type: 'DEMO_MEETING',
    title: 'Conduct 2-minute workflow automation demo call',
    due_date: '2026-09-30T10:00:00Z',
    assigned_to: 'op_demo_specialist',
    tenant_id: 'default'
  });

  assert.ok(task);
  assert.ok(task.id.startsWith('opt_'));
  assert.strictEqual(task.status, 'PENDING');
  assert.strictEqual(task.taskType, 'DEMO_MEETING');
  createdTaskId = task.id;
});

test('List tasks for opportunity', () => {
  const tasks = db.listOpportunityTasks(createdOppDefaultId, 'default');
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].id, createdTaskId);
});

test('Update task status: PENDING -> COMPLETED', () => {
  const updatedTask = db.updateOpportunityTaskStatus(createdTaskId, 'COMPLETED', 'default');
  assert.strictEqual(updatedTask.status, 'COMPLETED');
});

test('IDOR Protection: Tenant B cannot list or mutate tasks of Tenant default', () => {
  const tasksB = db.listOpportunityTasks(createdOppDefaultId, 'tenant_b');
  assert.strictEqual(tasksB.length, 0, 'Cross-tenant task list must be empty');

  assert.throws(() => {
    db.updateOpportunityTaskStatus(createdTaskId, 'CANCELLED', 'tenant_b');
  }, /TASK_NOT_FOUND/);
});

// Section 6: Cascading Deletions & Referential Integrity
console.log('\n--- Section 6: Cascading Deletions & Referential Integrity ---');

test('Deleting test lead cleanly cascades to opportunities, history, and tasks', () => {
  // Delete the test leads
  sqlite.prepare('DELETE FROM leads WHERE id IN (?, ?)').run(testLeadDefaultId, testLeadTenantBId);

  // Verify opportunities deleted
  const oppDefault = sqlite.prepare('SELECT * FROM opportunities WHERE id = ?').get(createdOppDefaultId);
  const oppB = sqlite.prepare('SELECT * FROM opportunities WHERE id = ?').get(createdOppTenantBId);
  assert.strictEqual(oppDefault, undefined, 'Opportunity should be cascade-deleted');
  assert.strictEqual(oppB, undefined, 'Opportunity B should be cascade-deleted');

  // Verify stage history deleted
  const history = sqlite.prepare('SELECT * FROM opportunity_stage_history WHERE opportunity_id = ?').all(createdOppDefaultId);
  assert.strictEqual(history.length, 0, 'Stage history should be cascade-deleted');

  // Verify tasks deleted
  const tasks = sqlite.prepare('SELECT * FROM opportunity_tasks WHERE id = ?').all(createdTaskId);
  assert.strictEqual(tasks.length, 0, 'Tasks should be cascade-deleted');
});

// Section 7: Database Baseline Invariants Confirmation
console.log('\n--- Section 7: Database Baseline Invariants Confirmation ---');

test('Baseline Invariant: Exactly 145 real baseline leads in tenant "default"', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM leads WHERE tenant_id = 'default'").get().c;
  assert.strictEqual(count, 145, `Expected exactly 145 baseline leads, found ${count}`);
});

test('Baseline Invariant: Exactly 175 lead evidence rows preserved', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM lead_evidence").get().c;
  assert.strictEqual(count, 175, `Expected 175 evidence rows, found ${count}`);
});

test('Baseline Invariant: Exactly 40 approved historical snapshots preserved', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM campaign_approved_snapshots").get().c;
  assert.strictEqual(count, 40, `Expected 40 approved snapshots, found ${count}`);
});

test('Baseline Invariant: SQLite WAL mode is active', () => {
  const jm = sqlite.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.strictEqual(jm.toLowerCase(), 'wal', `Journal mode must be WAL, found ${jm}`);
});

test('Baseline Invariant: Foreign keys enabled and 0 violations', () => {
  const fk = sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys;
  assert.strictEqual(fk, 1, 'Foreign keys must be 1');
  const fkCheck = sqlite.prepare("PRAGMA foreign_key_check").all();
  assert.strictEqual(fkCheck.length, 0, `Expected 0 FK check violations, found ${fkCheck.length}`);
});

test('Baseline Invariant: PRAGMA integrity_check = ok', () => {
  const ic = sqlite.prepare("PRAGMA integrity_check").get().integrity_check;
  assert.strictEqual(ic, 'ok', `Integrity check failed: ${ic}`);
});

console.log('\n===============================================================');
console.log(`STEP 9B VERIFICATION COMPLETE: ${passCount} / ${passCount} ASSERTIONS PASS (100%)`);
console.log('===============================================================\n');
} finally {
  try {
    performCompleteTeardown(sqlite, ['tenant_b', 'tenant_a'], [testLeadDefaultId, testLeadTenantBId]);
  } catch (err) {
    console.error('  ⚠️ Teardown error:', err.message);
  } finally {
    sqlite.close();
  }
}

