import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');
import { 
  ATTRIBUTION_MODELS, 
  computeAttributionWeights, 
  calculateOpportunityAttribution, 
  recognizeOpportunityRevenue,
  getRevenueAnalytics 
} from './revenue-attribution-engine.js';

console.log('===============================================================');
console.log('PHASE 2 STEP 10: REVENUE & ATTRIBUTION VERIFICATION SUITE');
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

let testOppId = null;

try {

// =========================================================================
// SECTION 1: DATABASE SCHEMA & ADDITIVE TABLES VERIFICATION
// =========================================================================
console.log('--- Section 1: Schema & Additive Tables Verification ---');

test('Table "revenue_attributions" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revenue_attributions'").get();
  assert.ok(table, 'revenue_attributions table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(revenue_attributions)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('opportunity_id'), 'has opportunity_id');
  assert.ok(cols.includes('lead_id'), 'has lead_id');
  assert.ok(cols.includes('campaign_id'), 'has campaign_id');
  assert.ok(cols.includes('campaign_touch_id'), 'has campaign_touch_id');
  assert.ok(cols.includes('touch_number'), 'has touch_number');
  assert.ok(cols.includes('channel'), 'has channel');
  assert.ok(cols.includes('model_name'), 'has model_name');
  assert.ok(cols.includes('attribution_weight'), 'has attribution_weight');
  assert.ok(cols.includes('attributed_value'), 'has attributed_value');
  assert.ok(cols.includes('currency'), 'has currency');
  assert.ok(cols.includes('touch_timestamp'), 'has touch_timestamp');
  assert.ok(cols.includes('calculated_at'), 'has calculated_at');
});

test('Table "revenue_ledger" exists with correct schema', () => {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revenue_ledger'").get();
  assert.ok(table, 'revenue_ledger table should exist');
  const cols = sqlite.prepare("PRAGMA table_info(revenue_ledger)").all().map(c => c.name);
  assert.ok(cols.includes('id'), 'has id');
  assert.ok(cols.includes('tenant_id'), 'has tenant_id');
  assert.ok(cols.includes('opportunity_id'), 'has opportunity_id');
  assert.ok(cols.includes('lead_id'), 'has lead_id');
  assert.ok(cols.includes('amount'), 'has amount');
  assert.ok(cols.includes('currency'), 'has currency');
  assert.ok(cols.includes('recognized_at'), 'has recognized_at');
  assert.ok(cols.includes('recognized_by_operator'), 'has recognized_by_operator');
  assert.ok(cols.includes('source_attribution_model'), 'has source_attribution_model');
});

// =========================================================================
// SECTION 2: ATTRIBUTION MATHEMATICAL PURITY & CANONICAL MODELS
// =========================================================================
console.log('\n--- Section 2: Mathematical Correctness Across All 5 Models ---');

const mockSingleTouch = [
  { id: 't1', channel: 'WHATSAPP', timestamp: '2026-09-01T10:00:00Z' }
];

test('Single touch allocates 100% (1.0000) for every attribution model', () => {
  for (const model of Object.values(ATTRIBUTION_MODELS)) {
    const weights = computeAttributionWeights(mockSingleTouch, model);
    assert.strictEqual(weights.length, 1);
    assert.strictEqual(weights[0].weight, 1.0);
  }
});

const mockTwoTouches = [
  { id: 't1', channel: 'EMAIL', timestamp: '2026-09-01T10:00:00Z' },
  { id: 't2', channel: 'WHATSAPP', timestamp: '2026-09-03T10:00:00Z' }
];

test('FIRST_TOUCH allocates 100% to initial touch and 0% to subsequent touches', () => {
  const weights = computeAttributionWeights(mockTwoTouches, ATTRIBUTION_MODELS.FIRST_TOUCH);
  assert.strictEqual(weights[0].weight, 1.0);
  assert.strictEqual(weights[1].weight, 0.0);
});

test('LAST_TOUCH allocates 100% to final touch and 0% to initial touches', () => {
  const weights = computeAttributionWeights(mockTwoTouches, ATTRIBUTION_MODELS.LAST_TOUCH);
  assert.strictEqual(weights[0].weight, 0.0);
  assert.strictEqual(weights[1].weight, 1.0);
});

test('LINEAR divides attribution weight uniformly across all touches', () => {
  const weights = computeAttributionWeights(mockTwoTouches, ATTRIBUTION_MODELS.LINEAR);
  assert.strictEqual(weights[0].weight, 0.50);
  assert.strictEqual(weights[1].weight, 0.50);

  const mockFourTouches = [
    { id: 't1', timestamp: '2026-09-01T00:00:00Z' },
    { id: 't2', timestamp: '2026-09-02T00:00:00Z' },
    { id: 't3', timestamp: '2026-09-03T00:00:00Z' },
    { id: 't4', timestamp: '2026-09-04T00:00:00Z' }
  ];
  const weights4 = computeAttributionWeights(mockFourTouches, ATTRIBUTION_MODELS.LINEAR);
  assert.strictEqual(weights4.length, 4);
  weights4.forEach(w => assert.strictEqual(w.weight, 0.25));
});

test('POSITION_BASED allocates 40/20/40 U-shaped curve for 3 touches', () => {
  const mockThreeTouches = [
    { id: 't1', timestamp: '2026-09-01T00:00:00Z' },
    { id: 't2', timestamp: '2026-09-02T00:00:00Z' },
    { id: 't3', timestamp: '2026-09-03T00:00:00Z' }
  ];
  const weights = computeAttributionWeights(mockThreeTouches, ATTRIBUTION_MODELS.POSITION_BASED);
  assert.strictEqual(weights[0].weight, 0.40);
  assert.strictEqual(weights[1].weight, 0.20);
  assert.strictEqual(weights[2].weight, 0.40);
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, 1.0);
});

test('POSITION_BASED allocates 40/10/10/40 U-shaped curve for 4 touches', () => {
  const mockFourTouches = [
    { id: 't1', timestamp: '2026-09-01T00:00:00Z' },
    { id: 't2', timestamp: '2026-09-02T00:00:00Z' },
    { id: 't3', timestamp: '2026-09-03T00:00:00Z' },
    { id: 't4', timestamp: '2026-09-04T00:00:00Z' }
  ];
  const weights = computeAttributionWeights(mockFourTouches, ATTRIBUTION_MODELS.POSITION_BASED);
  assert.strictEqual(weights[0].weight, 0.40);
  assert.strictEqual(weights[1].weight, 0.10);
  assert.strictEqual(weights[2].weight, 0.10);
  assert.strictEqual(weights[3].weight, 0.40);
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, 1.0);
});

test('TIME_DECAY gives exponentially greater weight to touches closer to conversion', () => {
  const mockDecayTouches = [
    { id: 't1', timestamp: '2026-09-01T00:00:00Z' }, // 14 days ago
    { id: 't2', timestamp: '2026-09-08T00:00:00Z' }, // 7 days ago
    { id: 't3', timestamp: '2026-09-15T00:00:00Z' }  // 0 days ago (close)
  ];
  const weights = computeAttributionWeights(mockDecayTouches, ATTRIBUTION_MODELS.TIME_DECAY);
  assert.ok(weights[2].weight > weights[1].weight, 'Recent touch has higher weight than intermediate touch');
  assert.ok(weights[1].weight > weights[0].weight, 'Intermediate touch has higher weight than oldest touch');
  const sum = weights.reduce((acc, w) => acc + w.weight, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, 1.0);
});

test('Mathematical invariant: Sum of weights across all touches is always exactly 1.0000', () => {
  for (let count = 1; count <= 7; count++) {
    const touches = Array.from({ length: count }, (_, i) => ({
      id: `t_${i}`,
      timestamp: new Date(Date.now() - (count - i) * 86400000).toISOString()
    }));
    for (const model of Object.values(ATTRIBUTION_MODELS)) {
      const w = computeAttributionWeights(touches, model);
      const total = w.reduce((acc, item) => acc + item.weight, 0);
      assert.ok(Math.abs(total - 1.0) < 0.0001, `Sum should equal 1.0 (got ${total} for count ${count} model ${model})`);
    }
  }
});

// =========================================================================
// SECTION 3: OPPORTUNITY REVENUE ATTRIBUTION CALCULATION & INTEGRATION
// =========================================================================
console.log('\n--- Section 3: Opportunity Revenue Attribution Integration ---');

// Use real baseline lead #1
const testLead = sqlite.prepare('SELECT id, businessName FROM leads ORDER BY id ASC LIMIT 1').get();
assert.ok(testLead, 'Baseline lead must exist');

testOppId = 'opp_test_rev_' + Date.now();
sqlite.prepare(`
  INSERT INTO opportunities (
    id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
  ) VALUES (?, 'default', ?, 'Enterprise Annual Automation Contract', 125000.0, 'INR', 'CLOSED_WON', 1.0, datetime('now'), datetime('now'))
`).run(testOppId, testLead.id);

test('calculateOpportunityAttribution persists accurate financial allocation without penny loss', () => {
  const result = calculateOpportunityAttribution(testOppId, 'default', ATTRIBUTION_MODELS.LINEAR);
  assert.strictEqual(result.opportunityId, testOppId);
  assert.strictEqual(result.dealValue, 125000.0);
  assert.strictEqual(result.currency, 'INR');
  assert.ok(result.attributions.length >= 1, 'Should have at least 1 attribution row');

  // Sum of attributed values must match deal value down to the cent
  const totalAllocated = result.attributions.reduce((acc, r) => acc + r.attributedValue, 0);
  assert.strictEqual(Math.round(totalAllocated * 100) / 100, 125000.0, 'Allocated total must equal exactly deal value');

  const totalWeights = result.attributions.reduce((acc, r) => acc + r.attributionWeight, 0);
  assert.ok(Math.abs(totalWeights - 1.0) < 0.001, 'Allocated weights must equal 1.0');
});

test('calculateOpportunityAttribution works cleanly across all 5 models on same opportunity', () => {
  for (const model of Object.values(ATTRIBUTION_MODELS)) {
    const res = calculateOpportunityAttribution(testOppId, 'default', model);
    const sumVal = res.attributions.reduce((acc, r) => acc + r.attributedValue, 0);
    assert.strictEqual(Math.round(sumVal * 100) / 100, 125000.0);
  }
});

// =========================================================================
// SECTION 4: REALIZED REVENUE RECOGNITION & LEDGER INTEGRITY
// =========================================================================
console.log('\n--- Section 4: Realized Revenue Recognition & Ledger Integrity ---');

test('Fail-closed: recognizeOpportunityRevenue rejects non-CLOSED_WON opportunity', () => {
  const discoveryOppId = 'opp_disc_' + Date.now();
  sqlite.prepare(`
    INSERT INTO opportunities (
      id, tenant_id, lead_id, title, deal_value, currency, stage, confidence_probability, created_at, updated_at
    ) VALUES (?, 'default', ?, 'Discovery Deal', 50000.0, 'INR', 'DISCOVERY', 0.20, datetime('now'), datetime('now'))
  `).run(discoveryOppId, testLead.id);

  assert.throws(() => {
    recognizeOpportunityRevenue(discoveryOppId, 'operator_test', 'default');
  }, /INVALID_STAGE_FOR_REVENUE/);

  sqlite.prepare('DELETE FROM opportunities WHERE id = ?').run(discoveryOppId);
});

test('recognizeOpportunityRevenue writes immutable entry to revenue_ledger and computes all models', () => {
  const recResult = recognizeOpportunityRevenue(testOppId, 'op_chief_officer', 'default', {
    notes: 'Verified signed contract and bank remittance'
  });

  assert.strictEqual(recResult.success, true);
  assert.ok(recResult.ledgerEntry.id.startsWith('revled_'));
  assert.strictEqual(recResult.ledgerEntry.amount, 125000.0);
  assert.strictEqual(recResult.ledgerEntry.recognizedByOperator, 'op_chief_officer');

  // Verify DB state in revenue_ledger
  const ledgerInDb = sqlite.prepare('SELECT * FROM revenue_ledger WHERE id = ?').get(recResult.ledgerEntry.id);
  assert.ok(ledgerInDb, 'Record must exist in revenue_ledger');
  assert.strictEqual(ledgerInDb.opportunity_id, testOppId);
  assert.strictEqual(ledgerInDb.amount, 125000.0);

  // Verify all 5 models were computed
  for (const model of Object.values(ATTRIBUTION_MODELS)) {
    assert.ok(recResult.attributionsByModel[model], `Model ${model} must be computed`);
  }
});

test('getRevenueAnalytics returns aggregated tenant performance metrics', () => {
  const analytics = getRevenueAnalytics('default');
  assert.strictEqual(analytics.tenantId, 'default');
  assert.ok(analytics.metrics.totalOpportunities >= 1);
  assert.ok(analytics.metrics.closedWonCount >= 1);
  assert.ok(analytics.metrics.winRate >= 0.0 && analytics.metrics.winRate <= 1.0);
  assert.ok(Array.isArray(analytics.channelBreakdown));
  assert.ok(Array.isArray(analytics.recentLedger));
  assert.ok(analytics.recentLedger.some(e => e.opportunityId === testOppId));
});

// =========================================================================
// SECTION 5: MULTI-TENANT ISOLATION & ATTACK DEFENSE
// =========================================================================
console.log('\n--- Section 5: Multi-Tenant Isolation & Security Checks ---');

test('IDOR Defense: Operator from Tenant B cannot calculate attribution for Tenant A opportunity', () => {
  assert.throws(() => {
    calculateOpportunityAttribution(testOppId, 'tenant_foreign_b');
  }, /OPPORTUNITY_NOT_FOUND/);
});

test('IDOR Defense: Operator from Tenant B cannot recognize revenue for Tenant A opportunity', () => {
  assert.throws(() => {
    recognizeOpportunityRevenue(testOppId, 'op_b', 'tenant_foreign_b');
  }, /OPPORTUNITY_NOT_FOUND/);
});

test('Tenant revenue metrics strictly isolate calculations by tenant', () => {
  const metricsA = db.getTenantRevenueMetrics('default');
  const metricsB = db.getTenantRevenueMetrics('tenant_foreign_b');
  assert.ok(metricsA.closedWonCount >= 1);
  assert.strictEqual(metricsB.closedWonCount, 0);
  assert.strictEqual(metricsB.totalOpportunities, 0);
});

test('DB Check Constraint: Negative deal_value is rejected by database check constraints', () => {
  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO opportunities (
        id, tenant_id, lead_id, title, deal_value, currency, stage, created_at, updated_at
      ) VALUES ('opp_neg', 'default', ?, 'Invalid Negative Opp', -5000.0, 'INR', 'DISCOVERY', datetime('now'), datetime('now'))
    `).run(testLead.id);
  }, /CHECK constraint failed/);
});

test('DB Check Constraint: Negative ledger amount is rejected by database check constraints', () => {
  assert.throws(() => {
    sqlite.prepare(`
      INSERT INTO revenue_ledger (
        id, tenant_id, opportunity_id, lead_id, amount, currency, recognized_at, recognized_by_operator, created_at
      ) VALUES ('rev_neg', 'default', ?, ?, -100.0, 'INR', datetime('now'), 'op', datetime('now'))
    `).run(testOppId, testLead.id);
  }, /CHECK constraint failed/);
});

// Clean up synthetic test records
sqlite.prepare('DELETE FROM revenue_attributions WHERE opportunity_id = ?').run(testOppId);
sqlite.prepare('DELETE FROM revenue_ledger WHERE opportunity_id = ?').run(testOppId);
sqlite.prepare('DELETE FROM opportunities WHERE id = ?').run(testOppId);

// =========================================================================
// SECTION 6: DATABASE INTEGRITY & INVARIANTS PRESERVATION
// =========================================================================
console.log('\n--- Section 6: Database Integrity & Forensic Checks ---');

test('PRAGMA integrity_check returns ok', () => {
  const row = sqlite.prepare('PRAGMA integrity_check').get();
  assert.strictEqual(row.integrity_check, 'ok');
});

test('PRAGMA foreign_key_check returns 0 violations', () => {
  const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
  assert.strictEqual(violations.length, 0, `Expected 0 FK violations, found: ${JSON.stringify(violations)}`);
});

test('PRAGMA journal_mode is WAL', () => {
  const row = sqlite.prepare('PRAGMA journal_mode').get();
  assert.strictEqual(row.journal_mode.toLowerCase(), 'wal');
});

test('Baseline lead count remains exactly 145', () => {
  const count = sqlite.prepare("SELECT COUNT(*) as count FROM leads WHERE tenant_id = 'default'").get().count;
  assert.strictEqual(count, 145, `Expected 145 baseline leads, found: ${count}`);
});

console.log('\n===============================================================');
console.log(`STEP 10 VERIFICATION COMPLETE: All ${passCount} tests passed!`);
console.log('===============================================================\n');
} finally {
  try {
    if (testOppId) {
      sqlite.prepare('DELETE FROM revenue_attributions WHERE opportunity_id = ?').run(testOppId);
      sqlite.prepare('DELETE FROM revenue_ledger WHERE opportunity_id = ?').run(testOppId);
      sqlite.prepare('DELETE FROM opportunities WHERE id = ?').run(testOppId);
    }
    performCompleteTeardown(sqlite, ['tenant_foreign_b', 'tenant_b'], []);
  } catch (err) {
    console.error('  ⚠️ Teardown error:', err.message);
  } finally {
    sqlite.close();
  }
}

