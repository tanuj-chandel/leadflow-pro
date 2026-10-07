import { db } from './database.js';

export const ATTRIBUTION_MODELS = Object.freeze({
  FIRST_TOUCH: 'FIRST_TOUCH',
  LAST_TOUCH: 'LAST_TOUCH',
  LINEAR: 'LINEAR',
  POSITION_BASED: 'POSITION_BASED',
  TIME_DECAY: 'TIME_DECAY'
});

export const SUPPORTED_CHANNELS = Object.freeze([
  'WHATSAPP',
  'TELEGRAM',
  'EMAIL',
  'MANUAL',
  'INBOUND_WEBHOOK',
  'OTHER'
]);

/**
 * Normalizes any external or internal channel name into canonical enum.
 */
export function normalizeChannelName(rawChannel) {
  if (!rawChannel) return 'OTHER';
  const upper = String(rawChannel).toUpperCase().trim();
  if (upper.includes('WHATSAPP') || upper === 'WA') return 'WHATSAPP';
  if (upper.includes('TELEGRAM') || upper === 'TG') return 'TELEGRAM';
  if (upper.includes('EMAIL') || upper.includes('GMAIL')) return 'EMAIL';
  if (upper.includes('MANUAL') || upper.includes('DIRECT')) return 'MANUAL';
  if (upper.includes('WEBHOOK') || upper.includes('CAL')) return 'INBOUND_WEBHOOK';
  return 'OTHER';
}

/**
 * Discovers the chronological touch journey for a lead across campaign attempts
 * and conversation messages.
 */
export function getLeadTouchJourney(leadId, tenantId, dbInstance = db) {
  const tid = tenantId || 'default';
  const lead = (typeof dbInstance.getLeadById === 'function')
    ? dbInstance.getLeadById(leadId, tid)
    : dbInstance.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(leadId, tid);
  if (!lead) return [];

  const touches = [];

  // 1. Gather successful campaign execution attempts
  try {
    const attempts = dbInstance.sqlite.prepare(`
      SELECT 
        cea.id as attempt_id,
        cea.campaign_id,
        cea.campaign_touch_id,
        cea.channel,
        cea.created_at,
        ct.touch_number
      FROM campaign_execution_attempts cea
      LEFT JOIN campaign_touches ct ON cea.campaign_touch_id = ct.id
      WHERE cea.lead_id = ? AND cea.tenant_id = ?
        AND (cea.result_status IN ('PROVIDER_ACCEPTED', 'VERIFIED_SENT') OR ct.status = 'SENT')
      ORDER BY cea.created_at ASC
    `).all(leadId, tid);

    for (const a of attempts) {
      touches.push({
        id: a.attempt_id,
        type: 'CAMPAIGN_TOUCH',
        campaignId: a.campaign_id,
        campaignTouchId: a.campaign_touch_id,
        touchNumber: a.touch_number !== undefined ? a.touch_number : 1,
        channel: normalizeChannelName(a.channel),
        timestamp: a.created_at,
        source: 'CAMPAIGN'
      });
    }
  } catch (err) {
    // If table query fails, continue gracefully
  }

  // 2. Gather conversation messages (both inbound replies and approved outbound replies)
  try {
    const messages = dbInstance.sqlite.prepare(`
      SELECT 
        cm.id as message_id,
        c.channel,
        cm.created_at,
        cm.direction,
        cm.sender_type
      FROM conversation_messages cm
      JOIN conversations c ON cm.conversation_id = c.id
      WHERE c.lead_id = ? AND c.tenant_id = ?
        AND cm.delivery_status != 'FAILED'
      ORDER BY cm.created_at ASC
    `).all(leadId, tid);

    for (const m of messages) {
      touches.push({
        id: m.message_id,
        type: 'CONVERSATION_MESSAGE',
        campaignId: null,
        campaignTouchId: null,
        touchNumber: touches.length + 1,
        channel: normalizeChannelName(m.channel),
        timestamp: m.created_at,
        source: m.direction === 'INBOUND' ? 'INBOUND_REPLY' : 'OUTBOUND_REPLY'
      });
    }
  } catch (err) {
    // Continue gracefully
  }

  // Sort chronologically ascending
  touches.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // 3. Fallback: If no previous touches exist, synthesize an initial discovery touch
  if (touches.length === 0) {
    const creationTime = lead.createdAt || new Date().toISOString();
    touches.push({
      id: 'synth_init_' + leadId,
      type: 'INITIAL_DISCOVERY',
      campaignId: null,
      campaignTouchId: null,
      touchNumber: 1,
      channel: 'MANUAL',
      timestamp: creationTime,
      source: 'ORGANIC_DISCOVERY'
    });
  }

  return touches;
}

/**
 * Computes normalized attribution weights for an array of touches based on model.
 * Invariant: Sum of weights across all touches ALWAYS equals exactly 1.0000.
 */
export function computeAttributionWeights(touches, modelName, options = {}) {
  if (!touches || touches.length === 0) return [];
  const N = touches.length;

  if (!Object.values(ATTRIBUTION_MODELS).includes(modelName)) {
    throw new Error(`INVALID_ATTRIBUTION_MODEL: "${modelName}" is not a recognized attribution model.`);
  }

  // Base case: exactly 1 touch accounts for 100% of attribution in every model
  if (N === 1) {
    return [{ ...touches[0], weight: 1.0 }];
  }

  const result = touches.map(t => ({ ...t, weight: 0.0 }));

  switch (modelName) {
    case ATTRIBUTION_MODELS.FIRST_TOUCH: {
      result[0].weight = 1.0;
      break;
    }

    case ATTRIBUTION_MODELS.LAST_TOUCH: {
      result[N - 1].weight = 1.0;
      break;
    }

    case ATTRIBUTION_MODELS.LINEAR: {
      const equalShare = 1.0 / N;
      for (let i = 0; i < N; i++) {
        result[i].weight = equalShare;
      }
      break;
    }

    case ATTRIBUTION_MODELS.POSITION_BASED: {
      if (N === 2) {
        result[0].weight = 0.50;
        result[1].weight = 0.50;
      } else {
        result[0].weight = 0.40;
        result[N - 1].weight = 0.40;
        const middleShare = 0.20 / (N - 2);
        for (let i = 1; i < N - 1; i++) {
          result[i].weight = middleShare;
        }
      }
      break;
    }

    case ATTRIBUTION_MODELS.TIME_DECAY: {
      // 7-day half-life decay model
      const halfLifeDays = options.halfLifeDays || 7;
      const lambda = halfLifeDays * 86400 * 1000; // ms
      const lastTime = new Date(touches[N - 1].timestamp).getTime();

      let sumRawWeights = 0.0;
      const rawWeights = [];

      for (let i = 0; i < N; i++) {
        const touchTime = new Date(touches[i].timestamp).getTime();
        const deltaMs = Math.max(0, lastTime - touchTime);
        const rawW = Math.pow(2, -deltaMs / lambda);
        rawWeights.push(rawW);
        sumRawWeights += rawW;
      }

      if (sumRawWeights <= 0) {
        for (let i = 0; i < N; i++) result[i].weight = 1.0 / N;
      } else {
        for (let i = 0; i < N; i++) {
          result[i].weight = rawWeights[i] / sumRawWeights;
        }
      }
      break;
    }

    default:
      throw new Error(`Unsupported model: ${modelName}`);
  }

  // Floating-point normalization to guarantee sum === 1.000000
  let totalW = 0.0;
  for (let i = 0; i < N; i++) {
    result[i].weight = parseFloat(result[i].weight.toFixed(6));
    totalW += result[i].weight;
  }

  const diff = 1.0 - totalW;
  if (Math.abs(diff) > 0.000001) {
    // Add residual rounding difference to the primary touch
    const primaryIdx = modelName === ATTRIBUTION_MODELS.FIRST_TOUCH ? 0 : (N - 1);
    result[primaryIdx].weight = parseFloat((result[primaryIdx].weight + diff).toFixed(6));
  }

  return result;
}

/**
 * Calculates and persists opportunity attribution records for a specific model or all models.
 */
export function calculateOpportunityAttribution(opportunityId, tenantId, modelName = ATTRIBUTION_MODELS.LINEAR, options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const opp = dbInstance.getOpportunityById(opportunityId, tid);
  if (!opp) {
    throw new Error(`OPPORTUNITY_NOT_FOUND: Opportunity "${opportunityId}" does not exist in tenant "${tid}".`);
  }

  const dealValue = parseFloat(opp.dealValue) || 0.0;
  const currency = opp.currency || 'INR';
  const touches = getLeadTouchJourney(opp.leadId, tid, dbInstance);

  const weightedTouches = computeAttributionWeights(touches, modelName, options);

  // Compute attributed currency values ensuring sum(values) === dealValue
  let allocatedValue = 0.0;
  const attributionRecords = weightedTouches.map((wt, idx) => {
    let val = Math.round(dealValue * wt.weight * 100) / 100;
    allocatedValue += val;
    return {
      opportunityId,
      leadId: opp.leadId,
      campaignId: wt.campaignId || null,
      campaignTouchId: wt.campaignTouchId || null,
      touchNumber: wt.touchNumber || (idx + 1),
      channel: wt.channel,
      modelName,
      attributionWeight: wt.weight,
      attributedValue: val,
      currency,
      touchTimestamp: wt.timestamp
    };
  });

  // Adjust penny roundoff difference to largest attribution share
  const valDiff = Math.round((dealValue - allocatedValue) * 100) / 100;
  if (Math.abs(valDiff) > 0 && attributionRecords.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < attributionRecords.length; i++) {
      if (attributionRecords[i].attributionWeight > attributionRecords[maxIdx].attributionWeight) {
        maxIdx = i;
      }
    }
    attributionRecords[maxIdx].attributedValue = Math.round((attributionRecords[maxIdx].attributedValue + valDiff) * 100) / 100;
  }

  // Persist transactionally
  const savedRecords = dbInstance.saveRevenueAttributions(opportunityId, modelName, attributionRecords, tid);

  return {
    opportunityId,
    tenantId: tid,
    dealValue,
    currency,
    modelName,
    touchCount: touches.length,
    attributions: savedRecords
  };
}

/**
 * Recognizes realized revenue for a CLOSED_WON opportunity and calculates multi-touch attribution.
 */
export function recognizeOpportunityRevenue(opportunityId, operatorId, tenantId, options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const opp = dbInstance.getOpportunityById(opportunityId, tid);
  if (!opp) {
    throw new Error(`OPPORTUNITY_NOT_FOUND: Opportunity "${opportunityId}" not found in tenant "${tid}".`);
  }

  if (opp.stage !== 'CLOSED_WON' && !options.allowNonWonRecognition) {
    throw new Error(`INVALID_STAGE_FOR_REVENUE: Opportunity must be in 'CLOSED_WON' stage to recognize revenue (current: ${opp.stage}).`);
  }

  const dealValue = parseFloat(opp.dealValue) || 0.0;
  if (dealValue < 0.0) {
    throw new Error(`INVALID_DEAL_VALUE: Cannot recognize negative deal value (${dealValue}).`);
  }

  // 1. Record immutable entry in revenue_ledger
  const ledgerEntry = dbInstance.recordRevenueLedgerEntry({
    opportunityId,
    leadId: opp.leadId,
    amount: dealValue,
    currency: opp.currency || 'INR',
    recognizedAt: options.recognizedAt || new Date().toISOString(),
    recognizedByOperator: operatorId || 'SYSTEM',
    sourceAttributionModel: options.preferredModel || ATTRIBUTION_MODELS.LINEAR,
    metadata: {
      opportunityTitle: opp.title,
      expectedCloseDate: opp.expectedCloseDate,
      assignedOperatorId: opp.assignedOperatorId,
      calculatedModels: Object.values(ATTRIBUTION_MODELS)
    }
  }, tid);

  // 2. Automatically compute attribution for all 5 standard models
  const attributionsByModel = {};
  for (const model of Object.values(ATTRIBUTION_MODELS)) {
    attributionsByModel[model] = calculateOpportunityAttribution(opportunityId, tid, model, options, dbInstance);
  }

  return {
    success: true,
    ledgerEntry,
    attributionsByModel
  };
}

/**
 * Returns revenue KPIs and attribution analytics for a tenant.
 */
export function getRevenueAnalytics(tenantId, options = {}, dbInstance = db) {
  const tid = tenantId || 'default';
  const modelName = options.modelName || ATTRIBUTION_MODELS.LINEAR;

  const tenantMetrics = dbInstance.getTenantRevenueMetrics(tid);
  const channelBreakdown = dbInstance.getChannelRevenueSummary(tid, modelName);
  const recentLedger = dbInstance.getRevenueLedgerList(tid, options.limit || 20);

  return {
    tenantId: tid,
    attributionModel: modelName,
    metrics: tenantMetrics,
    channelBreakdown,
    recentLedger
  };
}
