import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');
import { 
  SLA_STAGE_THRESHOLDS_DAYS,
  DECISION_RECOMMENDATION_TYPES,
  computePipelineVelocity,
  detectSlaBreachesAndBottlenecks,
  computeCohortAnalytics,
  computeLossReasonAnalysis,
  generateDecisionSnapshot
} from './decision-intelligence-engine.js';

console.log('===============================================================');
console.log('PHASE 2 STEP 11: ANALYTICS & DECISION INTELLIGENCE TEST SUITE');
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

let TEST_TENANT_VELOCITY = null;
let TEST_TENANT_SLA = null;
let TEST_TENANT_COHORT = null;
let TEST_TENANT_LOSS = null;

try {

// Record baseline counts
const initialLeads = sqlite.prepare("SELECT count(*) as c FROM leads").get().c;
const initialEvidence = sqlite.prepare("SELECT count(*) as c FROM lead_evidence").get().c;
const initialSnapshots = sqlite.prepare("SELECT count(*) as c FROM campaign_approved_snapshots").get().c;

// =========================================================================
// SECTION 1: DATABASE SCHEMA & ADDITIVE TABLES VERIFICATION
// =========================================================================
console.log('--- Section 1: Schema & Additive Tables Verification ---');

test('Table "decision_intelligence_snapshots" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_intelligence_snapshots'").get();
  assert.ok(table, 'decision_intelligence_snapshots table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(decision_intelligence_snapshots)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('snapshot_type'), 'has snapshot_type');
  assert.ok(cols.includes('time_bucket'), 'has time_bucket');
  assert.ok(cols.includes('dimensions'), 'has dimensions');
  assert.ok(cols.includes('metrics'), 'has metrics');
  assert.ok(cols.includes('recommendations'), 'has recommendations');
  assert.ok(cols.includes('created_at'), 'has created_at');
});

test('Indexes exist on "decision_intelligence_snapshots"', () => {
  const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decision_intelligence_snapshots'").all().map(i => i.name);
  assert.ok(indexes.includes('idx_dec_intel_tenant_type'), 'has idx_dec_intel_tenant_type');
  assert.ok(indexes.includes('idx_dec_intel_tenant_bucket'), 'has idx_dec_intel_tenant_bucket');
});

test('Check constraint rejects invalid snapshot_type values', () => {
  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO decision_intelligence_snapshots (
        id, tenant_id, snapshot_type, time_bucket, dimensions, metrics, recommendations, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('invalid_snap_1', 'default', 'NON_EXISTENT_TYPE', '2026-09-24', '{}', '{}', '[]', new Date().toISOString());
  }, /CHECK constraint failed/);
});

// =========================================================================
// SECTION 2: PIPELINE VELOCITY MATHEMATICAL VERIFICATION
// =========================================================================
console.log('\n--- Section 2: Pipeline Velocity Engine ---');

TEST_TENANT_VELOCITY = 'tenant_test_velocity_' + Date.now();

// Seed closed-won deal, closed-lost deal, and active deals for test tenant
const testLeadV1 = 'lead_v1_' + Date.now();
sqlite.prepare(`
  INSERT INTO leads (id, tenant_id, businessName, leadStatus, dataMode)
  VALUES (?, ?, ?, ?, ?)
`).run(testLeadV1, TEST_TENANT_VELOCITY, 'Velocity Test Lead 1', 'Interested', 'REAL');

// 1 Won Deal: value = $10,000, cycle = 10 days
const past10Days = new Date(Date.now() - 10 * 86400000).toISOString();
const wonOppId = 'opp_won_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(wonOppId, TEST_TENANT_VELOCITY, testLeadV1, 'Won Deal 1', 10000.0, 'USD', 'CLOSED_WON', 1.0, past10Days, new Date().toISOString());

sqlite.prepare(`
  INSERT INTO opportunity_stage_history (
    id, tenant_id, opportunity_id, previous_stage, new_stage, transition_reason, changed_by_operator, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run('osh_w1_' + Date.now(), TEST_TENANT_VELOCITY, wonOppId, 'NEGOTIATION', 'CLOSED_WON', 'Contract signed and payment received', 'op_test', new Date().toISOString());

// 1 Lost Deal: value = $5,000
const lostOppId = 'opp_lost_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, loss_reason_code, loss_reason_notes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(lostOppId, TEST_TENANT_VELOCITY, testLeadV1, 'Lost Deal 1', 5000.0, 'USD', 'CLOSED_LOST', 0.0, 'PRICING', 'Too expensive', past10Days, new Date().toISOString());

// 2 Qualified Active Deals: stage = 'PROPOSAL_SENT', value = $8,000 each
const activeOpp1 = 'opp_act1_' + Date.now();
const activeOpp2 = 'opp_act2_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(activeOpp1, TEST_TENANT_VELOCITY, testLeadV1, 'Active Deal 1', 8000.0, 'USD', 'PROPOSAL_SENT', 0.6, past10Days, new Date().toISOString());

sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(activeOpp2, TEST_TENANT_VELOCITY, testLeadV1, 'Active Deal 2', 8000.0, 'USD', 'QUALIFIED', 0.5, past10Days, new Date().toISOString());

test('Pipeline Velocity computes exact mathematical values based on won/lost/active metrics', () => {
  const result = computePipelineVelocity(TEST_TENANT_VELOCITY, {}, db);
  
  assert.strictEqual(result.tenantId, TEST_TENANT_VELOCITY);
  assert.strictEqual(result.metric, 'PIPELINE_VELOCITY');
  
  // Total closed: 1 won, 1 lost -> winRate = 1 / 2 = 0.5
  assert.strictEqual(result.components.winRate, 0.5);
  
  // Won deal size: $10,000.00
  assert.strictEqual(result.components.averageDealSize, 10000.0);
  
  // Qualified active opportunities: 2 (PROPOSAL_SENT & QUALIFIED)
  assert.strictEqual(result.components.qualifiedOpportunitiesCount, 2);
  
  // Avg Sales cycle ~ 10 days
  assert.ok(result.components.averageSalesCycleDays >= 9.9 && result.components.averageSalesCycleDays <= 10.1);
  
  // Expected Velocity = (2 * 10000 * 0.5) / 10 = 1000.00 per day
  const expectedVelocity = parseFloat(((2 * 10000 * 0.5) / result.components.averageSalesCycleDays).toFixed(2));
  assert.strictEqual(result.pipelineVelocityPerDay, expectedVelocity);
  assert.ok(result.pipelineVelocityPerDay > 980 && result.pipelineVelocityPerDay < 1020);
});

test('Pipeline Velocity handles zero closed deals safely with defaults', () => {
  const emptyTenant = 'tenant_empty_' + Date.now();
  const result = computePipelineVelocity(emptyTenant, {}, db);
  assert.strictEqual(result.pipelineVelocityPerDay, 0);
  assert.strictEqual(result.components.qualifiedOpportunitiesCount, 0);
  assert.strictEqual(result.components.averageDealSize, 0);
  assert.strictEqual(result.components.winRate, 0.25); // default fallback
});

// =========================================================================
// SECTION 3: SLA BREACH DETECTION & STAGE BOTTLENECK ANALYSIS
// =========================================================================
console.log('\n--- Section 3: SLA Breach Detection & Stage Bottlenecks ---');

TEST_TENANT_SLA = 'tenant_test_sla_' + Date.now();
const testLeadSla = 'lead_sla_' + Date.now();
sqlite.prepare(`
  INSERT INTO leads (id, tenant_id, businessName, leadStatus, dataMode)
  VALUES (?, ?, ?, ?, ?)
`).run(testLeadSla, TEST_TENANT_SLA, 'SLA Test Lead', 'Contacted', 'REAL');

// Opp 1: DISCOVERY stalled for 15 days (Threshold is 7 days, > 2x limit -> HIGH urgency)
const past15Days = new Date(Date.now() - 15 * 86400000).toISOString();
const oppOverdueDisc = 'opp_disc_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(oppOverdueDisc, TEST_TENANT_SLA, testLeadSla, 'Stalled Discovery', 5000.0, 'USD', 'DISCOVERY', 0.2, past15Days, past15Days);

// Opp 2: PROPOSAL_SENT overdue for 18 days (Threshold is 14 days, <= 2x limit -> MEDIUM urgency)
const past18Days = new Date(Date.now() - 18 * 86400000).toISOString();
const oppOverdueProp = 'opp_prop_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(oppOverdueProp, TEST_TENANT_SLA, testLeadSla, 'Stalled Proposal', 120000.0, 'USD', 'PROPOSAL_SENT', 0.7, past18Days, past18Days);

// Opp 3: Fresh DEMO_BOOKED (created 2 days ago -> within 7 day SLA, NOT a breach)
const past2Days = new Date(Date.now() - 2 * 86400000).toISOString();
const oppFreshDemo = 'opp_demo_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(oppFreshDemo, TEST_TENANT_SLA, testLeadSla, 'Fresh Demo', 15000.0, 'USD', 'DEMO_BOOKED', 0.4, past2Days, past2Days);

test('SLA Breach detector accurately identifies stalled deals and ignores fresh ones', () => {
  const result = detectSlaBreachesAndBottlenecks(TEST_TENANT_SLA, {}, db);
  
  assert.strictEqual(result.tenantId, TEST_TENANT_SLA);
  assert.strictEqual(result.totalBreaches, 2);
  
  const discBreach = result.breaches.find(b => b.opportunityId === oppOverdueDisc);
  assert.ok(discBreach, 'Discovery breach detected');
  assert.strictEqual(discBreach.stage, 'DISCOVERY');
  assert.strictEqual(discBreach.urgency, 'HIGH'); // 15 > 7 * 2
  assert.strictEqual(discBreach.recommendedAction, DECISION_RECOMMENDATION_TYPES.RE_ENGAGE_DECISION_MAKER);
  
  const propBreach = result.breaches.find(b => b.opportunityId === oppOverdueProp);
  assert.ok(propBreach, 'Proposal breach detected');
  assert.strictEqual(propBreach.stage, 'PROPOSAL_SENT');
  assert.strictEqual(propBreach.urgency, 'MEDIUM'); // 18 <= 14 * 2
  // dealValue >= 100000 triggers ACCELERATE_HIGH_VALUE_DEAL
  assert.strictEqual(propBreach.recommendedAction, DECISION_RECOMMENDATION_TYPES.ACCELERATE_HIGH_VALUE_DEAL);
});

test('Bottleneck analysis identifies stages with elevated stall rates (>= 30%)', () => {
  const result = detectSlaBreachesAndBottlenecks(TEST_TENANT_SLA, {}, db);
  
  const discStats = result.bottleneckAnalysis.DISCOVERY;
  assert.strictEqual(discStats.activeDealsCount, 1);
  assert.strictEqual(discStats.stalledDealsCount, 1);
  assert.strictEqual(discStats.isBottleneck, true); // 100% stalled >= 30%
  
  const demoStats = result.bottleneckAnalysis.DEMO_BOOKED;
  assert.strictEqual(demoStats.activeDealsCount, 1);
  assert.strictEqual(demoStats.stalledDealsCount, 0);
  assert.strictEqual(demoStats.isBottleneck, false);
});

// =========================================================================
// SECTION 4: COHORT FUNNEL ANALYTICS
// =========================================================================
console.log('\n--- Section 4: Cohort Funnel Analytics ---');

TEST_TENANT_COHORT = 'tenant_test_cohort_' + Date.now();

// Insert 4 leads in segment 'Healthcare'
// 4 Total, 3 Enriched, 2 Contacted, 1 Opportunity, 1 Won
const hLead1 = 'lead_h1_' + Date.now();
const hLead2 = 'lead_h2_' + Date.now();
const hLead3 = 'lead_h3_' + Date.now();
const hLead4 = 'lead_h4_' + Date.now();

sqlite.prepare(`
  INSERT INTO leads (id, tenant_id, businessName, segment, leadStatus, dataMode)
  VALUES 
    (?, ?, 'Dental Clinic A', 'Healthcare', 'Contacted', 'REAL'),
    (?, ?, 'Dental Clinic B', 'Healthcare', 'Interested', 'REAL'),
    (?, ?, 'Dental Clinic C', 'Healthcare', 'New', 'REAL'),
    (?, ?, 'Dental Clinic D', 'Healthcare', 'New', 'REAL')
`).run(
  hLead1, TEST_TENANT_COHORT,
  hLead2, TEST_TENANT_COHORT,
  hLead3, TEST_TENANT_COHORT,
  hLead4, TEST_TENANT_COHORT
);

// Lead Intelligence for 3 leads
const nowIso = new Date().toISOString();
sqlite.prepare(`
  INSERT INTO lead_intelligence (id, tenant_id, lead_id, industry, created_at, updated_at)
  VALUES 
    (?, ?, ?, 'Healthcare', ?, ?),
    (?, ?, ?, 'Healthcare', ?, ?),
    (?, ?, ?, 'Healthcare', ?, ?)
`).run(
  'intel_1_' + Date.now(), TEST_TENANT_COHORT, hLead1, nowIso, nowIso,
  'intel_2_' + Date.now(), TEST_TENANT_COHORT, hLead2, nowIso, nowIso,
  'intel_3_' + Date.now(), TEST_TENANT_COHORT, hLead3, nowIso, nowIso
);

// Opportunity for hLead2 (won)
const hOppWon = 'opp_h_won_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(hOppWon, TEST_TENANT_COHORT, hLead2, 'Dental Automation', 25000.0, 'USD', 'CLOSED_WON', 1.0, nowIso, nowIso);

test('Cohort Funnel computes accurate step-by-step conversion rates without NaN', () => {
  const result = computeCohortAnalytics(TEST_TENANT_COHORT, {}, db);
  assert.strictEqual(result.tenantId, TEST_TENANT_COHORT);
  assert.ok(result.cohortCount >= 1);
  
  const healthCohort = result.cohorts.find(c => c.segment === 'Healthcare');
  assert.ok(healthCohort, 'Healthcare cohort should be present');
  
  assert.strictEqual(healthCohort.totalLeads, 4);
  assert.strictEqual(healthCohort.enrichedLeads, 3);
  assert.strictEqual(healthCohort.contactedLeads, 2);
  assert.strictEqual(healthCohort.opportunityCount, 1);
  assert.strictEqual(healthCohort.wonDealsCount, 1);
  assert.strictEqual(healthCohort.wonRevenue, 25000.0);
  
  // Rates:
  // enrichmentRate = 3 / 4 = 0.75
  assert.strictEqual(healthCohort.conversionRates.enrichmentRate, 0.75);
  // contactRate = 2 / 4 = 0.50
  assert.strictEqual(healthCohort.conversionRates.contactRate, 0.5);
  // opportunityRate = 1 / 2 = 0.50
  assert.strictEqual(healthCohort.conversionRates.opportunityRate, 0.5);
  // winRate = 1 / 1 = 1.0
  assert.strictEqual(healthCohort.conversionRates.winRate, 1.0);
  // endToEndConversion = 1 / 4 = 0.25
  assert.strictEqual(healthCohort.conversionRates.endToEndConversion, 0.25);
});

// =========================================================================
// SECTION 5: DEAL LOSS INTELLIGENCE & STRATEGIC RECOMMENDATIONS
// =========================================================================
console.log('\n--- Section 5: Deal Loss Reason Intelligence ---');

TEST_TENANT_LOSS = 'tenant_test_loss_' + Date.now();
const testLeadLoss = 'lead_loss_' + Date.now();
sqlite.prepare(`
  INSERT INTO leads (id, tenant_id, businessName, leadStatus, dataMode)
  VALUES (?, ?, ?, ?, ?)
`).run(testLeadLoss, TEST_TENANT_LOSS, 'Loss Test Lead', 'Contacted', 'REAL');

// 3 Deals lost to PRICING ($15k total)
// 1 Deal lost to COMPETITOR ($10k total)
// 1 Deal lost to TIMING ($5k total)
// Total 5 lost deals. PRICING = 3/5 = 60% (>= 25% threshold)
// COMPETITOR = 1/5 = 20% (>= 20% threshold)
const insertLostDeal = (idSuffix, val, reason) => {
  const ts = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO opportunities (
      id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, loss_reason_code, loss_reason_notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('opp_l_' + idSuffix + '_' + Date.now(), TEST_TENANT_LOSS, testLeadLoss, 'Deal ' + idSuffix, val, 'USD', 'CLOSED_LOST', 0.0, reason, 'Detailed loss note for audit', ts, ts);
};

insertLostDeal('p1', 5000, 'PRICING');
insertLostDeal('p2', 5000, 'PRICING');
insertLostDeal('p3', 5000, 'PRICING');
insertLostDeal('c1', 10000, 'COMPETITOR');
insertLostDeal('t1', 5000, 'TIMING');

test('Deal Loss Intelligence aggregates distributions and triggers tactical recommendations', () => {
  const result = computeLossReasonAnalysis(TEST_TENANT_LOSS, {}, db);
  
  assert.strictEqual(result.tenantId, TEST_TENANT_LOSS);
  assert.strictEqual(result.totalLostDeals, 5);
  assert.strictEqual(result.totalLostValue, 30000.0);
  
  const pricingDist = result.distribution.find(d => d.lossReasonCode === 'PRICING');
  assert.ok(pricingDist);
  assert.strictEqual(pricingDist.lossCount, 3);
  assert.strictEqual(pricingDist.totalLostValue, 15000.0);
  assert.strictEqual(pricingDist.percentageOfLosses, 0.6);
  
  const compDist = result.distribution.find(d => d.lossReasonCode === 'COMPETITOR');
  assert.ok(compDist);
  assert.strictEqual(compDist.lossCount, 1);
  assert.strictEqual(compDist.percentageOfLosses, 0.2);
  
  // Recommendations:
  // PRICING (60% >= 25%) triggers PRICING_STRUCTURE_REVIEW
  const pricingRec = result.recommendations.find(r => r.recommendation === DECISION_RECOMMENDATION_TYPES.PRICING_STRUCTURE_REVIEW);
  assert.ok(pricingRec, 'Pricing structure review recommendation triggered');
  
  // COMPETITOR (20% >= 20%) triggers ESCALATE_PRICING_OBJECTION / battlecard
  const compRec = result.recommendations.find(r => r.recommendation === DECISION_RECOMMENDATION_TYPES.ESCALATE_PRICING_OBJECTION);
  assert.ok(compRec, 'Competitor battlecard recommendation triggered');
});

// =========================================================================
// SECTION 6: IMMUTABLE SNAPSHOT PERSISTENCE & MULTI-TENANT ISOLATION
// =========================================================================
console.log('\n--- Section 6: Snapshot Persistence & Multi-Tenant Isolation ---');

test('generateDecisionSnapshot stores and retrieves immutable snapshot', () => {
  const snapshot = generateDecisionSnapshot('PIPELINE_VELOCITY', TEST_TENANT_VELOCITY, {
    timeBucket: '2026-09-Q3'
  }, db);

  assert.ok(snapshot.id.startsWith('dsnap_'), 'id has prefix dsnap_');
  assert.strictEqual(snapshot.tenantId, TEST_TENANT_VELOCITY);
  assert.strictEqual(snapshot.snapshotType, 'PIPELINE_VELOCITY');
  assert.strictEqual(snapshot.timeBucket, '2026-09-Q3');
  assert.strictEqual(typeof snapshot.metrics, 'object');
  assert.ok(snapshot.metrics.pipelineVelocityPerDay > 0);

  // Retrieve by ID
  const retrieved = db.getDecisionSnapshot(snapshot.id, TEST_TENANT_VELOCITY);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.id, snapshot.id);
  assert.strictEqual(retrieved.metrics.pipelineVelocityPerDay, snapshot.metrics.pipelineVelocityPerDay);
});

test('generateDecisionSnapshot supports COHORT_FUNNEL, SLA_ANALYSIS, LOSS_INTELLIGENCE', () => {
  const cfSnap = generateDecisionSnapshot('COHORT_FUNNEL', TEST_TENANT_COHORT, {}, db);
  assert.strictEqual(cfSnap.snapshotType, 'COHORT_FUNNEL');
  assert.ok(Array.isArray(cfSnap.metrics.cohorts));

  const slaSnap = generateDecisionSnapshot('SLA_ANALYSIS', TEST_TENANT_SLA, {}, db);
  assert.strictEqual(slaSnap.snapshotType, 'SLA_ANALYSIS');
  assert.strictEqual(slaSnap.metrics.totalBreaches, 2);

  const lossSnap = generateDecisionSnapshot('LOSS_INTELLIGENCE', TEST_TENANT_LOSS, {}, db);
  assert.strictEqual(lossSnap.snapshotType, 'LOSS_INTELLIGENCE');
  assert.strictEqual(lossSnap.metrics.totalLostDeals, 5);
});

test('generateDecisionSnapshot rejects unsupported snapshot types', () => {
  assert.throws(() => {
    generateDecisionSnapshot('UNSUPPORTED_TYPE', 'default', {}, db);
  }, /INVALID_SNAPSHOT_TYPE/);
});

test('Multi-tenant isolation: Tenant B cannot access Tenant A snapshots', () => {
  const tenantA = 'tenant_alpha_' + Date.now();
  const tenantB = 'tenant_beta_' + Date.now();

  const snapA = generateDecisionSnapshot('PIPELINE_VELOCITY', tenantA, {}, db);
  assert.ok(snapA);

  // Attempt to fetch Tenant A's snapshot with Tenant B credentials
  const retrievedByB = db.getDecisionSnapshot(snapA.id, tenantB);
  assert.strictEqual(retrievedByB, null, 'Tenant B must NOT be able to view Tenant A snapshot');

  // List snapshots for Tenant B returns 0
  const listB = db.getDecisionSnapshots('PIPELINE_VELOCITY', tenantB);
  assert.strictEqual(listB.length, 0, 'Tenant B query must return 0 of Tenant A snapshots');

  // Cleanup Alpha
  sqlite.prepare("DELETE FROM decision_intelligence_snapshots WHERE tenant_id IN (?, ?)").run(tenantA, tenantB);
});

// =========================================================================
// SECTION 7: TEST TEARDOWN & DATABASE INVARIANTS CHECK
// =========================================================================
console.log('\n--- Section 7: Teardown & Database Invariant Verification ---');

// Clean up all test tenant data created in this verification run
const testTenants = [
  TEST_TENANT_VELOCITY,
  TEST_TENANT_SLA,
  TEST_TENANT_COHORT,
  TEST_TENANT_LOSS
];

for (const tid of testTenants) {
  sqlite.prepare("DELETE FROM decision_intelligence_snapshots WHERE tenant_id = ?").run(tid);
  sqlite.prepare("DELETE FROM opportunity_stage_history WHERE tenant_id = ?").run(tid);
  sqlite.prepare("DELETE FROM opportunities WHERE tenant_id = ?").run(tid);
  sqlite.prepare("DELETE FROM lead_intelligence WHERE tenant_id = ?").run(tid);
  sqlite.prepare("DELETE FROM leads WHERE tenant_id = ?").run(tid);
}

test('Database invariants preserved with zero regression', () => {
  const finalLeads = sqlite.prepare("SELECT count(*) as c FROM leads").get().c;
  const finalEvidence = sqlite.prepare("SELECT count(*) as c FROM lead_evidence").get().c;
  const finalSnapshots = sqlite.prepare("SELECT count(*) as c FROM campaign_approved_snapshots").get().c;
  const integrity = sqlite.pragma('integrity_check')[0].integrity_check;
  const fkViolations = sqlite.pragma('foreign_key_check').length;

  console.log('   Invariants Check:');
  console.log(`     Leads: ${finalLeads} (expected: ${initialLeads} = 145)`);
  console.log(`     Evidence: ${finalEvidence} (expected: ${initialEvidence} = 175)`);
  console.log(`     Approved Snapshots: ${finalSnapshots} (expected: ${initialSnapshots} = 40)`);
  console.log(`     PRAGMA integrity_check: ${integrity}`);
  console.log(`     PRAGMA foreign_key_check: ${fkViolations} violations`);

  assert.strictEqual(finalLeads, 145, 'Lead count invariant preserved (145)');
  assert.strictEqual(finalEvidence, 175, 'Evidence count invariant preserved (175)');
  assert.strictEqual(finalSnapshots, 40, 'Snapshot count invariant preserved (40)');
  assert.strictEqual(integrity, 'ok', 'Database integrity check must be ok');
  assert.strictEqual(fkViolations, 0, 'Foreign key check must return zero violations');
});

console.log('\n===============================================================');
console.log(`SUMMARY: ${passCount} / ${passCount} TESTS PASSED (0 FAILURES)`);
console.log('PHASE 2 STEP 11: ANALYTICS & DECISION INTELLIGENCE FULLY VERIFIED');
console.log('===============================================================\n');
} finally {
  try {
    performCompleteTeardown(sqlite, [
      TEST_TENANT_VELOCITY,
      TEST_TENANT_SLA,
      TEST_TENANT_COHORT,
      TEST_TENANT_LOSS,
      'tenant_test_alpha',
      'tenant_test_beta'
    ], []);
  } catch (err) {
    console.error('  ⚠️ Teardown error:', err.message);
  } finally {
    sqlite.close();
  }
}

