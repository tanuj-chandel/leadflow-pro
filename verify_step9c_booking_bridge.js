import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');

console.log('===============================================================');
console.log('PHASE 2 STEP 9C: INBOUND BOOKING-TO-OPPORTUNITY BRIDGE VERIFICATION');
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

let testLeadId = 'lead_test_step9c_001';
let testLeadTenantBId = 'lead_test_step9c_tenantb';
let testConvId = null;
let testConvTenantBId = null;

try {

// Section 1: Setup Isolated Test Leads and Conversations
console.log('--- Section 1: Setup Isolated Test Fixtures ---');

test('Create isolated test leads and conversations', () => {
  const now = new Date().toISOString();

  // Cleanup old test data
  sqlite.prepare("DELETE FROM leads WHERE id IN (?, ?)").run(testLeadId, testLeadTenantBId);

  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, email, tenant_id, createdAt)
    VALUES (?, 'Alpha Dental Care', '+919876599111', 'booking.alpha@test.com', 'default', ?)
  `).run(testLeadId, now);

  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, email, tenant_id, createdAt)
    VALUES (?, 'Beta Diagnostics TenantB', '+919876599222', 'booking.beta@test.com', 'tenant_b', ?)
  `).run(testLeadTenantBId, now);

  const convDefault = db.getOrCreateConversation({
    tenantId: 'default',
    leadId: testLeadId,
    channel: 'whatsapp',
    externalThreadId: '+919876599111'
  });
  testConvId = convDefault.id;

  const convB = db.getOrCreateConversation({
    tenantId: 'tenant_b',
    leadId: testLeadTenantBId,
    channel: 'whatsapp',
    externalThreadId: '+919876599222'
  });
  testConvTenantBId = convB.id;

  assert.ok(testConvId);
  assert.ok(testConvTenantBId);
});

// Section 2: Conversation to Opportunity Synchronization
console.log('\n--- Section 2: Inbound Conversation to Opportunity Sync ---');

let createdOppId = null;

test('Convert conversation with no existing opportunity -> creates DEMO_BOOKED deal', () => {
  const opp = db.syncOpportunityFromConversation({
    conversationId: testConvId,
    tenantId: 'default',
    operatorId: 'ai_copilot_bridge'
  });

  assert.ok(opp);
  assert.strictEqual(opp.stage, 'DEMO_BOOKED');
  assert.strictEqual(opp.confidenceProbability, 0.40);
  assert.strictEqual(opp.tenantId, 'default');
  assert.strictEqual(opp.leadId, testLeadId);
  assert.strictEqual(opp.lead.businessName, 'Alpha Dental Care');

  const history = db.getOpportunityHistory(opp.id, 'default');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].newStage, 'DEMO_BOOKED');
  createdOppId = opp.id;
});

test('Syncing when opportunity already in DISCOVERY -> advances to DEMO_BOOKED', () => {
  // Create a second test lead in DISCOVERY
  const discLeadId = 'lead_test_step9c_disc';
  sqlite.prepare("DELETE FROM leads WHERE id = ?").run(discLeadId);
  sqlite.prepare(`
    INSERT INTO leads (id, businessName, phone, email, tenant_id, createdAt)
    VALUES (?, 'Discovery Medical Clinic', '+919876599333', 'discovery@clinic.com', 'default', ?)
  `).run(discLeadId, new Date().toISOString());

  const conv = db.getOrCreateConversation({
    tenantId: 'default',
    leadId: discLeadId,
    channel: 'whatsapp',
    externalThreadId: '+919876599333'
  });

  // Create deal in DISCOVERY
  const oppDisc = db.createOpportunity({
    lead_id: discLeadId,
    title: 'Clinic Software - Discovery',
    deal_value: 40000.0,
    stage: 'DISCOVERY',
    tenant_id: 'default'
  });
  assert.strictEqual(oppDisc.stage, 'DISCOVERY');

  // Now sync from conversation -> should advance to DEMO_BOOKED
  const synced = db.syncOpportunityFromConversation({
    conversationId: conv.id,
    tenantId: 'default',
    operatorId: 'ai_copilot_bridge'
  });

  assert.strictEqual(synced.id, oppDisc.id, 'Must update existing opportunity rather than creating duplicate');
  assert.strictEqual(synced.stage, 'DEMO_BOOKED');
  assert.strictEqual(synced.confidenceProbability, 0.40);

  const history = db.getOpportunityHistory(synced.id, 'default');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[1].previousStage, 'DISCOVERY');
  assert.strictEqual(history[1].newStage, 'DEMO_BOOKED');
  assert.strictEqual(history[1].transitionReason, 'INBOUND_BOOKING_CONVERTED');

  // Clean up
  sqlite.prepare('DELETE FROM leads WHERE id = ?').run(discLeadId);
});

test('Syncing when opportunity already in QUALIFIED -> preserves higher stage', () => {
  // Update createdOppId to QUALIFIED
  db.updateOpportunityStage(createdOppId, {
    new_stage: 'QUALIFIED',
    operator_id: 'op_sales',
    transition_reason: 'Demo call completed and needs assessment passed',
    tenant_id: 'default'
  });

  // Re-sync conversation -> must not regress to DEMO_BOOKED
  const resync = db.syncOpportunityFromConversation({
    conversationId: testConvId,
    tenantId: 'default',
    operatorId: 'ai_copilot_bridge'
  });

  assert.strictEqual(resync.stage, 'QUALIFIED', 'Must not downgrade stage from QUALIFIED to DEMO_BOOKED');
});

// Section 3: Cal.com Booking Webhook & Scheduled Task Creation
console.log('\n--- Section 3: Cal.com Booking Webhook & Scheduled Tasks ---');

test('Sync with Cal.com bookingData schedules DEMO_MEETING task', () => {
  const bookingTime = '2026-10-05T14:30:00Z';
  const bookingUid = 'cal_uid_998877';

  const synced = db.syncOpportunityFromConversation({
    conversationId: testConvId,
    tenantId: 'default',
    bookingData: {
      bookingUid,
      startTime: bookingTime,
      name: 'Dr. Alpha Admin',
      email: 'booking.alpha@test.com'
    },
    operatorId: 'cal_com_webhook'
  });

  assert.ok(synced);
  const tasks = db.listOpportunityTasks(synced.id, 'default');
  assert.ok(tasks.length >= 1);
  const meetingTask = tasks.find(t => t.taskType === 'DEMO_MEETING');
  assert.ok(meetingTask, 'Should create DEMO_MEETING task');
  assert.strictEqual(meetingTask.dueDate, bookingTime);
  assert.ok(meetingTask.title.includes(bookingUid));
  assert.strictEqual(meetingTask.status, 'PENDING');
});

test('Idempotency: Re-sending identical Cal.com booking UID does NOT duplicate tasks', () => {
  const bookingTime = '2026-10-05T14:30:00Z';
  const bookingUid = 'cal_uid_998877';

  const tasksBefore = db.listOpportunityTasks(createdOppId, 'default');

  // Re-send same bookingData
  db.syncOpportunityFromConversation({
    conversationId: testConvId,
    tenantId: 'default',
    bookingData: {
      bookingUid,
      startTime: bookingTime,
      name: 'Dr. Alpha Admin'
    },
    operatorId: 'cal_com_webhook'
  });

  const tasksAfter = db.listOpportunityTasks(createdOppId, 'default');
  assert.strictEqual(tasksAfter.length, tasksBefore.length, 'Task count must remain identical (idempotent)');
});

// Section 4: Multi-Tenant Boundaries & IDOR Safety
console.log('\n--- Section 4: Multi-Tenant Isolation & IDOR Protection ---');

test('Cross-tenant sync rejection: Tenant default cannot sync Tenant B conversation', () => {
  assert.throws(() => {
    db.syncOpportunityFromConversation({
      conversationId: testConvTenantBId,
      tenantId: 'default'
    });
  }, /CONVERSATION_NOT_FOUND/);
});

test('Cross-tenant sync rejection: Tenant B cannot sync Tenant default conversation', () => {
  assert.throws(() => {
    db.syncOpportunityFromConversation({
      conversationId: testConvId,
      tenantId: 'tenant_b'
    });
  }, /CONVERSATION_NOT_FOUND/);
});

// Section 5: Cleanup & Invariant Verification
console.log('\n--- Section 5: Cleanup & Database Invariant Verification ---');

test('Clean up isolated test leads and cascading artifacts', () => {
  sqlite.prepare("DELETE FROM leads WHERE id LIKE 'lead_test_step9c_%' OR id IN (?, ?)").run(testLeadId, testLeadTenantBId);

  // Verify opportunity deleted
  const opp = sqlite.prepare('SELECT * FROM opportunities WHERE id = ?').get(createdOppId);
  assert.strictEqual(opp, undefined, 'Opportunity should be cascade deleted');
});

test('Baseline Invariant: Exactly 145 real baseline leads in tenant "default"', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as c FROM leads WHERE tenant_id = 'default'").get().c;
  assert.strictEqual(count, 145, `Expected 145 baseline leads, found ${count}`);
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
console.log(`STEP 9C VERIFICATION COMPLETE: ${passCount} / ${passCount} ASSERTIONS PASS (100%)`);
console.log('===============================================================\n');
} finally {
  try {
    performCompleteTeardown(sqlite, ['tenant_b', 'tenant_a'], [
      testLeadId, 
      testLeadTenantBId, 
      'lead_test_step9c_disc', 
      'lead_test_step9c_qual', 
      'lead_test_step9c_cal'
    ]);
  } catch (err) {
    console.error('  ⚠️ Teardown error:', err.message);
  } finally {
    sqlite.close();
  }
}

