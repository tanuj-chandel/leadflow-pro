/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 6D
 * CAMPAIGN SEQUENCE & TOUCH CADENCE PLANNER
 * ============================================================================
 * Pure, deterministic, advisory sequence and touch cadence planner.
 * Converts an approved campaign's sequence_plan into planned campaign touches.
 *
 * Safety Invariants:
 * - ZERO outbound messages (no WhatsApp, Telegram, Email, Phone, or WebForm).
 * - ZERO provider calls or network requests.
 * - ZERO quota reservations (reserveDailyQuota is NEVER called).
 * - ZERO attempts increment or outreach log creation.
 * - ZERO mutation of channel_outreach_state.
 * - Phase 1 gate remains untouched, fail-closed, and is NOT invoked.
 * - Preserves strict rule: VERIFIED MOBILE != VERIFIED WHATSAPP.
 * - Strictly ADVISORY planning: creates only PLANNED, BLOCKED, STOPPED, or CANCELLED touches.
 * - NO "SENT" or "AUTHORIZED" status generated.
 */

import { db as defaultDb } from './database.js';
import { evaluateCampaignLeadEligibility, ELIGIBILITY_STATUSES } from './campaign-eligibility-engine.js';

export const MAX_TOUCHES = 3;

export const MIN_INTERVAL_HOURS = Object.freeze({
  WHATSAPP: 48,
  EMAIL: 72,
  PHONE: 48,
  TELEGRAM: 48,
  WEB_FORM: 48,
  MANUAL_RESEARCH: 48
});

export const TOUCH_PURPOSES = Object.freeze({
  1: 'INITIAL_OUTREACH',
  2: 'VALUE_ADD_FOLLOWUP',
  3: 'POLITE_CLOSE'
});

export const TOUCH_STATUSES = Object.freeze({
  PLANNED: 'PLANNED',
  BLOCKED: 'BLOCKED',
  STOPPED: 'STOPPED',
  CANCELLED: 'CANCELLED'
});

export const SEQUENCE_STATUSES = Object.freeze({
  PLANNED: 'PLANNED',
  SEQUENCE_BLOCKED_RESEARCH: 'SEQUENCE_BLOCKED_RESEARCH',
  SEQUENCE_BLOCKED_INELIGIBLE: 'SEQUENCE_BLOCKED_INELIGIBLE',
  SEQUENCE_BLOCKED_HUMAN_REVIEW: 'SEQUENCE_BLOCKED_HUMAN_REVIEW'
});

export const STOP_CONDITIONS = Object.freeze({
  INBOUND_REPLY: 'INBOUND_REPLY',
  OPT_OUT: 'OPT_OUT',
  MANUAL_CANCEL: 'MANUAL_CANCEL',
  CAMPAIGN_PAUSED: 'CAMPAIGN_PAUSED',
  CAMPAIGN_CANCELLED: 'CAMPAIGN_CANCELLED'
});

/**
 * Validates and normalizes a sequence plan configuration.
 * Enforces hard safety limit of max 3 touches and minimum channel intervals.
 *
 * @param {object|string} sequencePlan
 * @returns {object} Validated and normalized sequence plan
 */
export function validateSequencePlan(sequencePlan) {
  let plan = sequencePlan;
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      throw new Error('sequence_plan must be a valid JSON object or string');
    }
  }

  if (!plan || typeof plan !== 'object') {
    plan = {};
  }

  const maxTouches = plan.max_touches !== undefined ? plan.max_touches : 3;
  if (!Number.isInteger(maxTouches) || maxTouches < 1 || maxTouches > MAX_TOUCHES) {
    throw new Error(`Invalid max_touches (${maxTouches}). Must be an integer between 1 and ${MAX_TOUCHES}`);
  }

  const intervals = { ...MIN_INTERVAL_HOURS };
  if (plan.interval_hours && typeof plan.interval_hours === 'object') {
    for (const [ch, hours] of Object.entries(plan.interval_hours)) {
      const channel = String(ch).toUpperCase();
      const h = Number(hours);
      if (isNaN(h) || h <= 0) {
        throw new Error(`Invalid interval hours for channel "${channel}": ${hours}`);
      }

      const minRequired = MIN_INTERVAL_HOURS[channel] || 48;
      if (h < minRequired) {
        throw new Error(
          `Configured interval for ${channel} (${h}h) is below the minimum required interval of ${minRequired}h`
        );
      }
      intervals[channel] = h;
    }
  }

  return {
    max_touches: maxTouches,
    interval_hours: intervals,
    channel_sequence: Array.isArray(plan.channel_sequence)
      ? plan.channel_sequence.map(c => String(c).toUpperCase())
      : null,
    stop_on_reply: plan.stop_on_reply !== false,
    stop_on_opt_out: plan.stop_on_opt_out !== false,
    stop_on_manual_cancel: plan.stop_on_manual_cancel !== false,
    stop_on_campaign_pause: plan.stop_on_campaign_pause !== false,
    stop_on_campaign_cancel: plan.stop_on_campaign_cancel !== false
  };
}

/**
 * Checks channel routability for a specific lead touch without hallucinating WhatsApp from mobile.
 *
 * @param {string} desiredChannel
 * @param {object} dossier - Step 6C eligibility dossier
 * @param {object} [campaignLeadOrStrategy] - Campaign lead record or channel strategy
 * @param {object} [channelStrategy] - Campaign channel strategy
 * @param {object} [dbInstance] - Database instance
 * @returns {{ routable: boolean, channel: string, fallback_from: string|null, reason: string|null }}
 */
export function checkTouchChannelRoutability(desiredChannel, dossier, campaignLeadOrStrategy = {}, channelStrategy = {}, dbInstance = defaultDb) {
  const ch = String(desiredChannel || '').toUpperCase();
  
  let campaignLead = campaignLeadOrStrategy;
  let strategy = channelStrategy;
  if (campaignLeadOrStrategy && (campaignLeadOrStrategy.fallback_policy || campaignLeadOrStrategy.preferred_channels || campaignLeadOrStrategy.fallback || campaignLeadOrStrategy.primary)) {
    strategy = campaignLeadOrStrategy;
    campaignLead = {};
  }

  const tid = dossier.tenant_id || campaignLead?.tenant_id || 'default';
  const fallbackPolicy = Array.isArray(strategy.fallback_policy)
    ? strategy.fallback_policy.map(c => String(c).toUpperCase())
    : (strategy.fallback ? [String(strategy.fallback).toUpperCase()] : []);

  // 1. If desired channel matches Step 6C's verified selected channel, it is verified routable
  if (dossier.selected_channel && ch === String(dossier.selected_channel).toUpperCase()) {
    return { routable: true, channel: ch, fallback_from: null, reason: null };
  }

  // 2. Otherwise inspect contact_snapshot or lead data & intelligence for other channel capability
  const contact = dossier.contact_snapshot || {};
  const leadId = dossier.lead_id || campaignLead?.lead_id;
  const lead = (leadId && dbInstance && dbInstance.getLeadById) ? dbInstance.getLeadById(leadId, tid) : (dossier.lead || null);

  function isChannelAvailable(channelName) {
    if (dossier.selected_channel && channelName === String(dossier.selected_channel).toUpperCase()) {
      return true;
    }
    switch (channelName) {
      case 'WHATSAPP': {
        if (contact.whatsapp && contact.whatsapp.present === true) return true;
        if (contact.whatsapp && contact.whatsapp.present === false) return false;
        if (!lead || !lead.phone || !String(lead.phone).trim()) return false;
        // Strict invariant: VERIFIED MOBILE != VERIFIED WHATSAPP.
        // Requires explicit WhatsApp signal/evidence recorded in intelligence
        const signals = (dbInstance && dbInstance.getLeadSignals) ? dbInstance.getLeadSignals(leadId, tid) : [];
        const evidence = (dbInstance && dbInstance.getLeadEvidence) ? dbInstance.getLeadEvidence(leadId, tid) : [];
        const hasWhatsAppSignal = signals.some(s => s.signal_key === 'WHATSAPP_SCHEDULING_AUTOMATION' || s.signal_type === 'WHATSAPP_ONLY_BOOKING') ||
          evidence.some(e => e.evidence_type === 'WHATSAPP_WORKFLOW' || /wa\.me|whatsapp/i.test(e.extracted_value || '')) ||
          Boolean(lead.whatsapp);
        return hasWhatsAppSignal;
      }
      case 'EMAIL':
        if (contact.email && contact.email.present !== undefined) {
          return Boolean(contact.email.present);
        }
        return Boolean(lead && lead.email && String(lead.email).trim() && String(lead.email).includes('@'));
      case 'PHONE':
        if (contact.phone && contact.phone.present !== undefined) {
          return Boolean(contact.phone.present);
        }
        return Boolean(lead && lead.phone && String(lead.phone).trim());
      case 'WEB_FORM':
        if (contact.website && contact.website.present !== undefined) {
          return Boolean(contact.website.present);
        }
        return Boolean(lead && lead.website && String(lead.website).trim());
      case 'MANUAL_RESEARCH':
        return true;
      default:
        return false;
    }
  }

  if (isChannelAvailable(ch)) {
    return { routable: true, channel: ch, fallback_from: null, reason: null };
  }

  // Desired channel unavailable -> attempt configured campaign fallback
  for (const fb of fallbackPolicy) {
    if (fb !== ch && isChannelAvailable(fb)) {
      return {
        routable: true,
        channel: fb,
        fallback_from: ch,
        reason: `Fallback to ${fb} because ${ch} is unavailable`
      };
    }
  }

  return {
    routable: false,
    channel: ch,
    fallback_from: null,
    reason: `Channel "${ch}" is unavailable and no routable fallback found`
  };
}

/**
 * Generates an advisory touch plan for a single campaign lead.
 *
 * @param {object} campaign
 * @param {object} campaignLead
 * @param {object} dossier - Step 6C eligibility dossier
 * @param {object} sequencePlan - Validated sequence plan
 * @param {object} options
 * @returns {object} Lead touch plan
 */
export function planLeadTouches(campaign, campaignLead, dossier, sequencePlan, options = {}) {
  const {
    planned_start_at = campaign.created_at || new Date().toISOString(),
    dbInstance = defaultDb
  } = options;

  let sequenceStatus = SEQUENCE_STATUSES.PLANNED;
  let blockingReason = null;

  switch (dossier.eligibility_status) {
    case ELIGIBILITY_STATUSES.RESEARCH_REQUIRED:
      sequenceStatus = SEQUENCE_STATUSES.SEQUENCE_BLOCKED_RESEARCH;
      blockingReason = dossier.reason_code || 'RESEARCH_REQUIRED';
      break;
    case ELIGIBILITY_STATUSES.INELIGIBLE:
      sequenceStatus = SEQUENCE_STATUSES.SEQUENCE_BLOCKED_INELIGIBLE;
      blockingReason = dossier.reason_code || 'INELIGIBLE';
      break;
    case ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED:
      sequenceStatus = SEQUENCE_STATUSES.SEQUENCE_BLOCKED_HUMAN_REVIEW;
      blockingReason = dossier.reason_code || 'HUMAN_REVIEW_REQUIRED';
      break;
    case ELIGIBILITY_STATUSES.ELIGIBLE:
    default:
      sequenceStatus = SEQUENCE_STATUSES.PLANNED;
      blockingReason = null;
      break;
  }

  const touches = [];
  const maxTouches = sequencePlan.max_touches;
  let currentAnchorMs = Date.parse(planned_start_at);
  if (isNaN(currentAnchorMs)) {
    currentAnchorMs = Date.now();
  }

  const primaryChannel = dossier.selected_channel || campaignLead.planned_channel || 'PHONE';

  for (let touchNum = 1; touchNum <= maxTouches; touchNum++) {
    const purpose = TOUCH_PURPOSES[touchNum] || 'VALUE_ADD_FOLLOWUP';

    // Channel selection: explicit sequence progression or primary channel
    let requestedChannel = primaryChannel;
    if (sequencePlan.channel_sequence && sequencePlan.channel_sequence[touchNum - 1]) {
      requestedChannel = sequencePlan.channel_sequence[touchNum - 1];
    }

    const channelRoutability = checkTouchChannelRoutability(
      requestedChannel,
      dossier,
      campaignLead,
      campaign.channel_strategy || {},
      dbInstance
    );

    const plannedChannel = channelRoutability.channel;
    const fallbackFrom = channelRoutability.fallback_from;

    let touchStatus = TOUCH_STATUSES.PLANNED;
    let touchStopReason = null;

    if (sequenceStatus !== SEQUENCE_STATUSES.PLANNED) {
      touchStatus = TOUCH_STATUSES.BLOCKED;
      touchStopReason = sequenceStatus;
    } else if (!channelRoutability.routable) {
      touchStatus = TOUCH_STATUSES.BLOCKED;
      touchStopReason = 'CHANNEL_UNAVAILABLE';
    }

    const plannedAt = new Date(currentAnchorMs).toISOString();

    touches.push({
      touch_number: touchNum,
      purpose,
      planned_channel: plannedChannel,
      planned_at: plannedAt,
      status: touchStatus,
      stop_reason: touchStopReason,
      fallback_from: fallbackFrom,
      stop_conditions: [
        STOP_CONDITIONS.INBOUND_REPLY,
        STOP_CONDITIONS.OPT_OUT,
        STOP_CONDITIONS.MANUAL_CANCEL,
        STOP_CONDITIONS.CAMPAIGN_PAUSED,
        STOP_CONDITIONS.CAMPAIGN_CANCELLED
      ]
    });

    // Advance anchor by the interval of this touch's planned channel
    const intervalHours = sequencePlan.interval_hours[plannedChannel] || MIN_INTERVAL_HOURS[plannedChannel] || 48;
    currentAnchorMs += intervalHours * 3600 * 1000;
  }

  return {
    campaign_id: campaign.id,
    campaign_lead_id: campaignLead.id,
    lead_id: campaignLead.lead_id,
    eligibility_status: dossier.eligibility_status,
    sequence_status: sequenceStatus,
    blocking_reason: blockingReason,
    touch_count: touches.length,
    touches
  };
}

/**
 * Generates a pure, read-only preview of the campaign sequence plan.
 * Does NOT write to the database.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Advisory sequence preview
 */
export function previewCampaignSequence(campaignId, options = {}) {
  const {
    tenantId = 'default',
    dbInstance = defaultDb,
    planned_start_at = null,
    sequencePlanOverride = null
  } = options;

  const tid = (tenantId || 'default').trim();
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const rawPlan = sequencePlanOverride || campaign.sequence_plan || {};
  const sequencePlan = validateSequencePlan(rawPlan);

  const startAnchor = planned_start_at || campaign.created_at || new Date().toISOString();

  // Load all campaign leads
  const campaignLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 });

  const leadPlans = [];
  let eligibleCount = 0;
  let blockedResearchCount = 0;
  let blockedIneligibleCount = 0;
  let blockedHumanReviewCount = 0;
  let totalPlannedTouches = 0;
  let totalBlockedTouches = 0;

  for (const cpl of campaignLeads) {
    const dossier = evaluateCampaignLeadEligibility(campaignId, cpl.lead_id, {
      tenantId: tid,
      dbInstance
    });

    const leadPlan = planLeadTouches(campaign, cpl, dossier, sequencePlan, {
      planned_start_at: startAnchor,
      dbInstance
    });

    leadPlans.push(leadPlan);

    switch (leadPlan.sequence_status) {
      case SEQUENCE_STATUSES.PLANNED:
        eligibleCount++;
        break;
      case SEQUENCE_STATUSES.SEQUENCE_BLOCKED_RESEARCH:
        blockedResearchCount++;
        break;
      case SEQUENCE_STATUSES.SEQUENCE_BLOCKED_INELIGIBLE:
        blockedIneligibleCount++;
        break;
      case SEQUENCE_STATUSES.SEQUENCE_BLOCKED_HUMAN_REVIEW:
        blockedHumanReviewCount++;
        break;
    }

    for (const t of leadPlan.touches) {
      if (t.status === TOUCH_STATUSES.PLANNED) totalPlannedTouches++;
      else totalBlockedTouches++;
    }
  }

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective
    },
    tenant_id: tid,
    sequence_plan: sequencePlan,
    planned_start_at: startAnchor,
    summary: {
      total_leads: campaignLeads.length,
      eligible_leads: eligibleCount,
      blocked_research_leads: blockedResearchCount,
      blocked_ineligible_leads: blockedIneligibleCount,
      blocked_human_review_leads: blockedHumanReviewCount,
      total_planned_touches: totalPlannedTouches,
      total_blocked_touches: totalBlockedTouches
    },
    leads: leadPlans,
    evaluated_at: new Date().toISOString(),
    is_advisory: true,
    outbound_dispatch: 'ZERO'
  };
}

/**
 * Persistently applies the sequence plan to the database by populating campaign_touches.
 * Idempotent: Repeated application does NOT duplicate touches.
 * Safety: REJECTED or CANCELLED campaigns are rejected.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Application report with touches persisted
 */
export function applyCampaignSequence(campaignId, options = {}) {
  const {
    tenantId = 'default',
    dbInstance = defaultDb,
    planned_start_at = null,
    sequencePlanOverride = null
  } = options;

  const tid = (tenantId || 'default').trim();
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  // Enforce campaign lifecycle state rules
  if (campaign.status === 'REJECTED' || campaign.status === 'CANCELLED') {
    throw new Error(`Cannot apply sequence on ${campaign.status} campaign "${campaignId}"`);
  }

  // Generate pure preview first
  const preview = previewCampaignSequence(campaignId, {
    tenantId: tid,
    dbInstance,
    planned_start_at,
    sequencePlanOverride
  });

  // Persist touches into campaign_touches idempotently using DB upsert
  let touchesPersisted = 0;
  const persistedTouches = [];

  for (const leadPlan of preview.leads) {
    for (const t of leadPlan.touches) {
      const touchRecord = dbInstance.createCampaignTouch({
        campaign_id: leadPlan.campaign_id,
        campaign_lead_id: leadPlan.campaign_lead_id,
        lead_id: leadPlan.lead_id,
        tenant_id: tid,
        touch_number: t.touch_number,
        planned_channel: t.planned_channel,
        planned_at: t.planned_at,
        purpose: t.purpose,
        status: t.status,
        stop_reason: t.stop_reason,
        fallback_from: t.fallback_from
      }, tid);

      persistedTouches.push(touchRecord);
      touchesPersisted++;
    }
  }

  return {
    campaign_id: campaign.id,
    tenant_id: tid,
    status: campaign.status,
    total_leads: preview.summary.total_leads,
    touches_persisted: touchesPersisted,
    summary: preview.summary,
    persisted_touches: persistedTouches,
    applied_at: new Date().toISOString(),
    is_advisory: true,
    outbound_dispatch: 'ZERO'
  };
}

/**
 * Handles stop condition events (e.g. INBOUND_REPLY, OPT_OUT, MANUAL_CANCEL, CAMPAIGN_PAUSED, CAMPAIGN_CANCELLED).
 * Deterministically updates affected PLANNED touches in campaign_touches to STOPPED, BLOCKED, or CANCELLED.
 *
 * @param {string} campaignId
 * @param {string} event - Event name
 * @param {object} [options]
 * @returns {object} Stop condition result
 */
export function handleStopConditionEvent(campaignId, event, options = {}) {
  const { tenantId = 'default', leadId = null, dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const validEvents = Object.values(STOP_CONDITIONS);
  if (!validEvents.includes(event)) {
    throw new Error(`Invalid stop condition event "${event}". Allowed: ${validEvents.join(', ')}`);
  }

  let newStatus = TOUCH_STATUSES.STOPPED;
  if (event === STOP_CONDITIONS.CAMPAIGN_PAUSED) newStatus = TOUCH_STATUSES.BLOCKED;
  if (event === STOP_CONDITIONS.CAMPAIGN_CANCELLED) newStatus = TOUCH_STATUSES.CANCELLED;

  let query = 'SELECT * FROM campaign_touches WHERE campaign_id = ? AND tenant_id = ? AND status = ?';
  const params = [campaignId, tid, TOUCH_STATUSES.PLANNED];

  if (leadId) {
    query += ' AND lead_id = ?';
    params.push(leadId);
  }

  const plannedTouches = dbInstance.sqlite.prepare(query).all(...params);
  let updatedCount = 0;

  for (const touch of plannedTouches) {
    dbInstance.updateCampaignTouch(touch.id, {
      status: newStatus,
      stop_reason: event
    }, tid);
    updatedCount++;
  }

  return {
    campaign_id: campaignId,
    event,
    affected_touches: updatedCount,
    new_status: newStatus
  };
}
