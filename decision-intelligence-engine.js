import { db } from './database.js';

export const SLA_STAGE_THRESHOLDS_DAYS = Object.freeze({
  DISCOVERY: 7,
  DEMO_BOOKED: 7,
  QUALIFIED: 10,
  PROPOSAL_SENT: 14,
  NEGOTIATION: 14
});

export const DECISION_RECOMMENDATION_TYPES = Object.freeze({
  RE_ENGAGE_DECISION_MAKER: 'RE_ENGAGE_DECISION_MAKER',
  FOLLOW_UP_PROPOSAL_EXPIRY: 'FOLLOW_UP_PROPOSAL_EXPIRY',
  CONFIRM_MEETING_ATTENDANCE: 'CONFIRM_MEETING_ATTENDANCE',
  ESCALATE_PRICING_OBJECTION: 'ESCALATE_PRICING_OBJECTION',
  ACCELERATE_HIGH_VALUE_DEAL: 'ACCELERATE_HIGH_VALUE_DEAL',
  NURTURE_OR_DISQUALIFY: 'NURTURE_OR_DISQUALIFY',
  PRICING_STRUCTURE_REVIEW: 'PRICING_STRUCTURE_REVIEW'
});

/**
 * Computes Sales Pipeline Velocity for a tenant:
 * Velocity = (Qualified Opps Count * Avg Won Deal Size * Win Rate) / Avg Sales Cycle (Days)
 */
export function computePipelineVelocity(tenantId = 'default', options = {}, dbInstance = db) {
  const tid = tenantId || 'default';

  // 1. Fetch won deals to compute cycle length and average deal size
  const closedWonRows = dbInstance.sqlite.prepare(`
    SELECT 
      id,
      deal_value,
      currency,
      created_at,
      COALESCE(
        (SELECT MAX(created_at) FROM opportunity_stage_history osh WHERE osh.opportunity_id = o.id AND osh.new_stage = 'CLOSED_WON'),
        updated_at
      ) as won_at
    FROM opportunities o
    WHERE tenant_id = ? AND stage = 'CLOSED_WON'
  `).all(tid);

  let totalCycleDays = 0;
  let wonCount = closedWonRows.length;
  let totalWonRevenue = 0.0;

  for (const row of closedWonRows) {
    const start = new Date(row.created_at).getTime();
    const end = new Date(row.won_at).getTime();
    const days = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
    totalCycleDays += days;
    totalWonRevenue += (parseFloat(row.deal_value) || 0.0);
  }

  const avgSalesCycleDays = wonCount > 0 ? parseFloat((totalCycleDays / wonCount).toFixed(1)) : 14.0;
  const avgDealSize = wonCount > 0 ? parseFloat((totalWonRevenue / wonCount).toFixed(2)) : 0.0;

  // 2. Fetch qualified active pipeline opportunities
  const activeOpps = dbInstance.sqlite.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(deal_value), 0.0) as active_val
    FROM opportunities
    WHERE tenant_id = ? AND stage NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'DISCOVERY')
  `).get(tid);

  const qualifiedCount = activeOpps ? activeOpps.count : 0;

  // 3. Compute win rate
  const allClosed = dbInstance.sqlite.prepare(`
    SELECT 
      SUM(CASE WHEN stage = 'CLOSED_WON' THEN 1 ELSE 0 END) as won_count,
      SUM(CASE WHEN stage = 'CLOSED_LOST' THEN 1 ELSE 0 END) as lost_count
    FROM opportunities
    WHERE tenant_id = ?
  `).get(tid);

  const totalClosed = ((allClosed?.won_count) || 0) + ((allClosed?.lost_count) || 0);
  const winRate = totalClosed > 0 ? parseFloat((allClosed.won_count / totalClosed).toFixed(4)) : 0.25;

  // 4. Calculate Velocity ($ per day)
  const pipelineVelocity = avgSalesCycleDays > 0
    ? parseFloat(((qualifiedCount * avgDealSize * winRate) / avgSalesCycleDays).toFixed(2))
    : 0.0;

  return {
    tenantId: tid,
    metric: 'PIPELINE_VELOCITY',
    pipelineVelocityPerDay: pipelineVelocity,
    components: {
      qualifiedOpportunitiesCount: qualifiedCount,
      averageDealSize: avgDealSize,
      winRate,
      averageSalesCycleDays: avgSalesCycleDays
    },
    totalClosedWonRevenue: totalWonRevenue,
    totalClosedDeals: totalClosed,
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Detects SLA breaches, stage bottlenecks, and stalled opportunities.
 */
export function detectSlaBreachesAndBottlenecks(tenantId = 'default', options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const customThresholds = options.thresholds || SLA_STAGE_THRESHOLDS_DAYS;
  const opps = dbInstance.getOpportunitiesWithStageDurations(tid);

  const breaches = [];
  const stageStats = {
    DISCOVERY: { count: 0, totalDays: 0, stalledCount: 0 },
    DEMO_BOOKED: { count: 0, totalDays: 0, stalledCount: 0 },
    QUALIFIED: { count: 0, totalDays: 0, stalledCount: 0 },
    PROPOSAL_SENT: { count: 0, totalDays: 0, stalledCount: 0 },
    NEGOTIATION: { count: 0, totalDays: 0, stalledCount: 0 }
  };

  const now = new Date().getTime();

  for (const opp of opps) {
    if (opp.stage === 'CLOSED_WON' || opp.stage === 'CLOSED_LOST') continue;

    const enteredAt = new Date(opp.stage_entered_at).getTime();
    const daysInStage = parseFloat(Math.max(0, (now - enteredAt) / (1000 * 60 * 60 * 24)).toFixed(1));
    const threshold = customThresholds[opp.stage] || 10;

    if (stageStats[opp.stage]) {
      stageStats[opp.stage].count++;
      stageStats[opp.stage].totalDays += daysInStage;
    }

    if (daysInStage > threshold) {
      if (stageStats[opp.stage]) stageStats[opp.stage].stalledCount++;

      let recommendation = DECISION_RECOMMENDATION_TYPES.RE_ENGAGE_DECISION_MAKER;
      if (opp.stage === 'PROPOSAL_SENT') recommendation = DECISION_RECOMMENDATION_TYPES.FOLLOW_UP_PROPOSAL_EXPIRY;
      if (opp.stage === 'DEMO_BOOKED') recommendation = DECISION_RECOMMENDATION_TYPES.CONFIRM_MEETING_ATTENDANCE;
      if (opp.deal_value >= 100000) recommendation = DECISION_RECOMMENDATION_TYPES.ACCELERATE_HIGH_VALUE_DEAL;

      breaches.push({
        opportunityId: opp.id,
        title: opp.title,
        leadName: opp.lead_name,
        stage: opp.stage,
        dealValue: opp.deal_value,
        currency: opp.currency,
        daysInStage,
        slaThresholdDays: threshold,
        daysOverdue: parseFloat((daysInStage - threshold).toFixed(1)),
        assignedOperatorId: opp.assigned_operator_id,
        recommendedAction: recommendation,
        urgency: daysInStage > threshold * 2 ? 'HIGH' : 'MEDIUM'
      });
    }
  }

  // Calculate average stage duration
  const bottleneckAnalysis = {};
  for (const [stg, stats] of Object.entries(stageStats)) {
    bottleneckAnalysis[stg] = {
      activeDealsCount: stats.count,
      avgDaysInStage: stats.count > 0 ? parseFloat((stats.totalDays / stats.count).toFixed(1)) : 0.0,
      stalledDealsCount: stats.stalledCount,
      slaLimitDays: customThresholds[stg] || 10,
      isBottleneck: stats.stalledCount > 0 && (stats.stalledCount / (stats.count || 1)) >= 0.30
    };
  }

  // Sort breaches by urgency and deal value descending
  breaches.sort((a, b) => b.dealValue - a.dealValue);

  return {
    tenantId: tid,
    totalBreaches: breaches.length,
    breaches,
    bottleneckAnalysis,
    detectedAt: new Date().toISOString()
  };
}

/**
 * Computes cohort conversion funnels by business segment.
 */
export function computeCohortAnalytics(tenantId = 'default', options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const rows = dbInstance.getCohortLeadFunnelData(tid);

  const cohorts = rows.map(r => {
    const total = r.total_leads || 0;
    const enriched = r.enriched_leads || 0;
    const contacted = r.contacted_leads || 0;
    const opps = r.opportunity_count || 0;
    const won = r.won_count || 0;

    return {
      segment: r.segment || 'General',
      totalLeads: total,
      enrichedLeads: enriched,
      contactedLeads: contacted,
      opportunityCount: opps,
      wonDealsCount: won,
      wonRevenue: r.won_revenue || 0.0,
      conversionRates: {
        enrichmentRate: total > 0 ? parseFloat((enriched / total).toFixed(4)) : 0.0,
        contactRate: total > 0 ? parseFloat((contacted / total).toFixed(4)) : 0.0,
        opportunityRate: contacted > 0 ? parseFloat((opps / contacted).toFixed(4)) : 0.0,
        winRate: opps > 0 ? parseFloat((won / opps).toFixed(4)) : 0.0,
        endToEndConversion: total > 0 ? parseFloat((won / total).toFixed(4)) : 0.0
      }
    };
  });

  return {
    tenantId: tid,
    cohortCount: cohorts.length,
    cohorts,
    computedAt: new Date().toISOString()
  };
}

/**
 * Computes loss reason intelligence to pinpoint why deals are lost.
 */
export function computeLossReasonAnalysis(tenantId = 'default', options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const rows = dbInstance.getLossReasonDistribution(tid);

  const totalLostCount = rows.reduce((sum, r) => sum + r.loss_count, 0);
  const totalLostValue = rows.reduce((sum, r) => sum + r.total_lost_value, 0);

  const distribution = rows.map(r => ({
    lossReasonCode: r.loss_reason_code,
    currency: r.currency,
    lossCount: r.loss_count,
    totalLostValue: r.total_lost_value,
    avgLostDealValue: r.avg_lost_deal_value,
    percentageOfLosses: totalLostCount > 0 ? parseFloat((r.loss_count / totalLostCount).toFixed(4)) : 0.0
  }));

  const recommendations = [];
  const pricingLoss = distribution.find(d => d.lossReasonCode === 'PRICING');
  if (pricingLoss && pricingLoss.percentageOfLosses >= 0.25) {
    recommendations.push({
      issue: 'Elevated pricing resistance detected',
      percentage: pricingLoss.percentageOfLosses,
      recommendation: DECISION_RECOMMENDATION_TYPES.PRICING_STRUCTURE_REVIEW,
      action: 'Introduce structured modular pricing or pilot discounts for contested accounts.'
    });
  }

  const competitorLoss = distribution.find(d => d.lossReasonCode === 'COMPETITOR');
  if (competitorLoss && competitorLoss.percentageOfLosses >= 0.20) {
    recommendations.push({
      issue: 'Competitor displace rate high',
      percentage: competitorLoss.percentageOfLosses,
      recommendation: DECISION_RECOMMENDATION_TYPES.ESCALATE_PRICING_OBJECTION,
      action: 'Strengthen battlecard comparisons highlighting 24/7 AI WhatsApp response superiority.'
    });
  }

  return {
    tenantId: tid,
    totalLostDeals: totalLostCount,
    totalLostValue: Math.round(totalLostValue * 100) / 100,
    distribution,
    recommendations,
    analyzedAt: new Date().toISOString()
  };
}

/**
 * Generates and stores an immutable decision intelligence snapshot for auditing and executive review.
 */
export function generateDecisionSnapshot(snapshotType, tenantId = 'default', options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  let metrics = {};
  let recommendations = [];

  switch (snapshotType) {
    case 'PIPELINE_VELOCITY':
      metrics = computePipelineVelocity(tid, options, dbInstance);
      break;
    case 'COHORT_FUNNEL':
      metrics = computeCohortAnalytics(tid, options, dbInstance);
      break;
    case 'SLA_ANALYSIS': {
      const sla = detectSlaBreachesAndBottlenecks(tid, options, dbInstance);
      metrics = sla;
      recommendations = sla.breaches.map(b => ({
        opportunityId: b.opportunityId,
        action: b.recommendedAction,
        urgency: b.urgency
      }));
      break;
    }
    case 'LOSS_INTELLIGENCE': {
      const loss = computeLossReasonAnalysis(tid, options, dbInstance);
      metrics = loss;
      recommendations = loss.recommendations;
      break;
    }
    default:
      throw new Error(`INVALID_SNAPSHOT_TYPE: "${snapshotType}" is not supported.`);
  }

  return dbInstance.saveDecisionSnapshot({
    snapshotType,
    timeBucket: options.timeBucket || new Date().toISOString().substring(0, 10),
    dimensions: options.dimensions || { tenantId: tid },
    metrics,
    recommendations
  }, tid);
}
