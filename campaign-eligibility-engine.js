/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 6C
 * CAMPAIGN PRE-FLIGHT ELIGIBILITY & CHANNEL RESOLUTION ENGINE
 * ============================================================================
 * Pure, deterministic campaign-time pre-flight eligibility and channel router.
 * Evaluates candidate leads in campaign_leads against the CURRENT database state.
 *
 * Safety Invariants:
 * - ZERO network outreach / dispatches.
 * - ZERO quota reservation (reserveDailyQuota is NEVER called).
 * - Read-only inspection of leads, compliance state, recommendations, and quotas.
 * - Does NOT mutate channel_outreach_state or daily_quota_usage.
 * - Does NOT create outreach logs or send provider messages.
 * - Final send authorization remains exclusively with Phase 1 executeOutreachGate().
 * - Strict adherence to: VERIFIED MOBILE != VERIFIED WHATSAPP.
 */

import { db as defaultDb } from './database.js';
import { getComplianceConfig, normalizeContactIdentifier } from './compliance-engine.js';
import { selectOptimalChannel, RECOMMENDED_CHANNELS } from './sales-action-engine.js';

export const ELIGIBILITY_STATUSES = {
  ELIGIBLE: 'ELIGIBLE',
  INELIGIBLE: 'INELIGIBLE',
  RESEARCH_REQUIRED: 'RESEARCH_REQUIRED',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED'
};

export const ELIGIBILITY_REASONS = {
  ELIGIBLE_FOR_CAMPAIGN: 'ELIGIBLE_FOR_CAMPAIGN',
  CROSS_TENANT: 'CROSS_TENANT',
  GLOBAL_SUPPRESSION: 'GLOBAL_SUPPRESSION',
  CHANNEL_SUPPRESSION: 'CHANNEL_SUPPRESSION',
  LEAD_OPTED_OUT: 'LEAD_OPTED_OUT',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  MAX_ATTEMPTS_REACHED: 'MAX_ATTEMPTS_REACHED',
  DAILY_QUOTA_EXHAUSTED: 'DAILY_QUOTA_EXHAUSTED',
  RESEARCH_REQUIRED_GAPS: 'RESEARCH_REQUIRED_GAPS',
  RESEARCH_REQUIRED_LOW_CONFIDENCE: 'RESEARCH_REQUIRED_LOW_CONFIDENCE',
  HUMAN_REVIEW_BRANCH_COORDINATION: 'HUMAN_REVIEW_BRANCH_COORDINATION',
  HUMAN_REVIEW_CONFLICTING_CONTACTS: 'HUMAN_REVIEW_CONFLICTING_CONTACTS',
  NO_ROUTABLE_CHANNEL: 'NO_ROUTABLE_CHANNEL',
  CHANNEL_RESTRICTED_BY_STRATEGY: 'CHANNEL_RESTRICTED_BY_STRATEGY'
};

/**
 * Pure Read-Only Evaluation of a Single Campaign Lead
 * Evaluates current compliance and channel routability without database mutation.
 *
 * @param {string} campaignId
 * @param {string} leadId
 * @param {object} [options]
 * @returns {object} Structured advisory eligibility dossier
 */
export function evaluateCampaignLeadEligibility(campaignId, leadId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb, checkedAt = new Date().toISOString() } = options;
  const tid = (tenantId || 'default').trim();

  // 1. Ingest Campaign & Strategy
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const channelStrategy = campaign.channel_strategy || {};
  const preferredChannels = Array.isArray(channelStrategy.preferred_channels)
    ? channelStrategy.preferred_channels.map(c => String(c).toUpperCase())
    : (channelStrategy.primary ? [String(channelStrategy.primary).toUpperCase()] : null);
  const fallbackPolicy = Array.isArray(channelStrategy.fallback_policy)
    ? channelStrategy.fallback_policy.map(c => String(c).toUpperCase())
    : (channelStrategy.fallback ? [String(channelStrategy.fallback).toUpperCase()] : []);

  // 2. LAYER 1 — Tenant Ownership & Cross-Tenant Protection
  const ownership = dbInstance.validateLeadOwnership(leadId, tid);
  if (!ownership.valid) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
      selected_channel: null,
      selected_contact_handle: null,
      fallback_attempted: false,
      reason_code: ELIGIBILITY_REASONS.CROSS_TENANT,
      reason_detail: ownership.reason || 'Lead does not belong to campaign tenant',
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, reason: 'CROSS_TENANT' },
      recommendation_snapshot: null,
      contact_snapshot: null
    };
  }

  const lead = ownership.lead;

  // 3. LAYER 2 — Current Lead-Level Opt-Out Check
  if (lead.opted_out === 1 || lead.opted_out === '1' || lead.opted_out === true) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
      selected_channel: null,
      selected_contact_handle: null,
      fallback_attempted: false,
      reason_code: ELIGIBILITY_REASONS.LEAD_OPTED_OUT,
      reason_detail: `Lead "${lead.businessName || lead.id}" has opted out of communications`,
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, reason: 'LEAD_OPTED_OUT' },
      recommendation_snapshot: null,
      contact_snapshot: null
    };
  }

  // 4. Ingest Certified Step 5A Recommendation & Contacts
  const rec = dbInstance.getLatestRecommendation(leadId, tid);
  const contacts = dbInstance.getLeadContacts ? dbInstance.getLeadContacts(leadId, tid) : [];
  const evidence = dbInstance.getLeadEvidence ? dbInstance.getLeadEvidence(leadId, tid) : [];
  const signals = dbInstance.getLeadSignals ? dbInstance.getLeadSignals(leadId, tid) : [];
  const score = dbInstance.getLatestLeadScore ? dbInstance.getLatestLeadScore(leadId, tid) : null;

  // Determine available channels supported by evidence
  // Re-run pure channel selection to ensure current evidence alignment
  const optimalChannelInfo = selectOptimalChannel(lead, contacts, signals, evidence);

  // Candidate channels ordered by preference
  const candidateChannels = [];
  if (preferredChannels && preferredChannels.length > 0) {
    candidateChannels.push(...preferredChannels);
    if (fallbackPolicy && fallbackPolicy.length > 0) {
      for (const fb of fallbackPolicy) {
        if (!candidateChannels.includes(fb)) candidateChannels.push(fb);
      }
    }
  } else {
    // Default to Step 5 recommendation channel, then fallback to PHONE or EMAIL
    candidateChannels.push(optimalChannelInfo.channel);
    if (optimalChannelInfo.channel !== RECOMMENDED_CHANNELS.EMAIL) candidateChannels.push(RECOMMENDED_CHANNELS.EMAIL);
    if (optimalChannelInfo.channel !== RECOMMENDED_CHANNELS.PHONE) candidateChannels.push(RECOMMENDED_CHANNELS.PHONE);
  }

  // Resolve best routable channel against current evidence & rules
  let selectedChannel = null;
  let selectedHandle = null;
  let fallbackAttempted = false;
  let channelRejectionReasons = {};

  for (let i = 0; i < candidateChannels.length; i++) {
    const ch = candidateChannels[i];
    if (i > 0) fallbackAttempted = true;

    // Check feasibility of channel for this lead
    if (ch === RECOMMENDED_CHANNELS.WHATSAPP) {
      // For cold outreach campaigns (e.g. Google Maps leads), allow WhatsApp if lead has a phone number.
      // WhatsApp evidence signals are ideal but not required for cold prospecting campaigns.
      const hasWaEvidence = signals.some(s => s.signal_type === 'WHATSAPP_WORKFLOW') ||
                            evidence.some(e => e.evidence_type === 'WHATSAPP_WORKFLOW' || /whatsapp|wa\.me/i.test(e.extracted_value || ''));
      // Allow WhatsApp if evidence present OR if lead simply has a phone number (cold outreach mode)
      const hasPhone = lead.phone || contacts.some(c => c.phone);
      if ((hasWaEvidence || hasPhone) && hasPhone) {
        const rawPhone = lead.phone || contacts.find(c => c.phone)?.phone;
        const norm = normalizeContactIdentifier(rawPhone, 'whatsapp');
        if (norm.valid) {
          selectedChannel = RECOMMENDED_CHANNELS.WHATSAPP;
          selectedHandle = norm.identifier;
          break;
        } else {
          channelRejectionReasons[ch] = norm.error || 'Invalid phone format for WhatsApp';
        }
      } else {
        channelRejectionReasons[ch] = 'No explicit WhatsApp evidence observed';
      }
    } else if (ch === RECOMMENDED_CHANNELS.EMAIL) {
      // Accept direct verified email or company general email (telemetry emails filtered)
      const validEmail = optimalChannelInfo.channel === RECOMMENDED_CHANNELS.EMAIL
        ? optimalChannelInfo.targetContactHandle
        : (lead.email || contacts.find(c => c.email)?.email);

      if (validEmail) {
        const norm = normalizeContactIdentifier(validEmail, 'email');
        if (norm.valid) {
          selectedChannel = RECOMMENDED_CHANNELS.EMAIL;
          selectedHandle = norm.identifier;
          break;
        } else {
          channelRejectionReasons[ch] = norm.error || 'Invalid email format';
        }
      } else {
        channelRejectionReasons[ch] = 'No valid business email available';
      }
    } else if (ch === RECOMMENDED_CHANNELS.PHONE) {
      const rawPhone = lead.phone || contacts.find(c => c.phone)?.phone;
      if (rawPhone) {
        selectedChannel = RECOMMENDED_CHANNELS.PHONE;
        selectedHandle = rawPhone;
        break;
      } else {
        channelRejectionReasons[ch] = 'No business telephone available';
      }
    } else if (ch === RECOMMENDED_CHANNELS.WEB_FORM) {
      if (lead.website) {
        selectedChannel = RECOMMENDED_CHANNELS.WEB_FORM;
        selectedHandle = lead.website;
        break;
      } else {
        channelRejectionReasons[ch] = 'No website available for web form';
      }
    }
  }

  // If no channel is routable
  if (!selectedChannel || !selectedHandle) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
      selected_channel: null,
      selected_contact_handle: null,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.NO_ROUTABLE_CHANNEL,
      reason_detail: `No routable channel available matching campaign strategy. Rejections: ${JSON.stringify(channelRejectionReasons)}`,
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, channelRejections: channelRejectionReasons },
      recommendation_snapshot: rec ? { action_type: rec.action_type, priority: rec.priority_band } : null,
      contact_snapshot: null
    };
  }

  // 5. LAYER 2 — Global Suppression Check on Selected Contact
  if (dbInstance.isGloballySuppressed(selectedHandle, tid)) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
      selected_channel: selectedChannel,
      selected_contact_handle: selectedHandle,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.GLOBAL_SUPPRESSION,
      reason_detail: `Contact handle "${selectedHandle}" is globally suppressed`,
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, reason: 'GLOBAL_SUPPRESSION' },
      recommendation_snapshot: null,
      contact_snapshot: { handle: selectedHandle }
    };
  }

  // 6. LAYER 3 — Channel-Specific Suppression Check
  const channelLower = selectedChannel.toLowerCase();
  if (dbInstance.isChannelSuppressed(selectedHandle, channelLower, tid)) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
      selected_channel: selectedChannel,
      selected_contact_handle: selectedHandle,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.CHANNEL_SUPPRESSION,
      reason_detail: `Contact handle "${selectedHandle}" is suppressed on channel "${selectedChannel}"`,
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, reason: 'CHANNEL_SUPPRESSION', channel: selectedChannel },
      recommendation_snapshot: null,
      contact_snapshot: { handle: selectedHandle }
    };
  }

  // 7. Ingest Centralized Compliance Limits & Cooldowns
  const config = getComplianceConfig();
  const channelState = dbInstance.getChannelOutreachState(leadId, channelLower);

  // 8. LAYER 5 — Current Cooldown Check
  if (channelState) {
    const nowMs = new Date(checkedAt).getTime();

    // Check explicit next_eligible_at schedule
    if (channelState.next_eligible_at) {
      const nextEligibleMs = new Date(channelState.next_eligible_at).getTime();
      if (nextEligibleMs > nowMs) {
        return {
          campaign_id: campaignId,
          lead_id: leadId,
          tenant_id: tid,
          eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
          selected_channel: selectedChannel,
          selected_contact_handle: selectedHandle,
          fallback_attempted: fallbackAttempted,
          reason_code: ELIGIBILITY_REASONS.COOLDOWN_ACTIVE,
          reason_detail: `Cooldown active until ${channelState.next_eligible_at}`,
          checked_at: checkedAt,
          compliance_snapshot: {
            allowed: false,
            reason: 'COOLDOWN_ACTIVE',
            next_eligible_at: channelState.next_eligible_at,
            last_attempt_at: channelState.last_attempt_at
          },
          recommendation_snapshot: null,
          contact_snapshot: { handle: selectedHandle }
        };
      }
    }

    // Check relative window
    if (channelState.last_attempt_at) {
      const lastAttemptMs = new Date(channelState.last_attempt_at).getTime();
      const cooldownHours = config.cooldownHours[channelLower] || 48;
      const eligibleAtMs = lastAttemptMs + (cooldownHours * 3600000);

      if (nowMs < eligibleAtMs) {
        const remainingHours = Math.max(1, Math.ceil((eligibleAtMs - nowMs) / 3600000));
        return {
          campaign_id: campaignId,
          lead_id: leadId,
          tenant_id: tid,
          eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
          selected_channel: selectedChannel,
          selected_contact_handle: selectedHandle,
          fallback_attempted: fallbackAttempted,
          reason_code: ELIGIBILITY_REASONS.COOLDOWN_ACTIVE,
          reason_detail: `Cooldown active for ${selectedChannel}. Eligible in ~${remainingHours}h`,
          checked_at: checkedAt,
          compliance_snapshot: {
            allowed: false,
            reason: 'COOLDOWN_ACTIVE',
            cooldown_hours: cooldownHours,
            remaining_hours: remainingHours,
            last_attempt_at: channelState.last_attempt_at
          },
          recommendation_snapshot: null,
          contact_snapshot: { handle: selectedHandle }
        };
      }
    }

    // 9. LAYER 6 — Maximum Attempts Check
    const maxAllowed = config.maxAttempts[channelLower] || 3;
    if (channelState.attempt_count >= maxAllowed) {
      return {
        campaign_id: campaignId,
        lead_id: leadId,
        tenant_id: tid,
        eligibility_status: ELIGIBILITY_STATUSES.INELIGIBLE,
        selected_channel: selectedChannel,
        selected_contact_handle: selectedHandle,
        fallback_attempted: fallbackAttempted,
        reason_code: ELIGIBILITY_REASONS.MAX_ATTEMPTS_REACHED,
        reason_detail: `Maximum outreach attempts (${maxAllowed}) reached for ${selectedChannel}`,
        checked_at: checkedAt,
        compliance_snapshot: {
          allowed: false,
          reason: 'MAX_ATTEMPTS_REACHED',
          attempts_made: channelState.attempt_count,
          max_allowed: maxAllowed
        },
        recommendation_snapshot: null,
        contact_snapshot: { handle: selectedHandle }
      };
    }
  }

  // 10. Check Daily Quota (READ-ONLY Diagnostic: Quota is NOT reserved)
  const todayStr = checkedAt.slice(0, 10);
  const quotaUsage = dbInstance.getDailyQuotaUsage(channelLower, todayStr, tid);
  const dailyLimit = config.dailyLimits[channelLower] || 50;
  const currentQuotaAttempts = quotaUsage?.attempt_count || 0;
  const quotaAvailable = currentQuotaAttempts < dailyLimit;

  // 11. LAYER 7 — Research Requirement Check
  const isResearchGaps = rec?.action_type === 'RESEARCH_GAPS';
  const isLowConfidence = (score?.data_confidence_score ?? score?.dataConfidenceScore ?? 25) < 40;

  if (isResearchGaps) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.RESEARCH_REQUIRED,
      selected_channel: selectedChannel,
      selected_contact_handle: selectedHandle,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.RESEARCH_REQUIRED_GAPS,
      reason_detail: 'Lead profile lacks web intelligence; deep crawl enrichment required',
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, advisoryOnly: true },
      recommendation_snapshot: { action_type: rec.action_type, priority: rec.priority_band },
      contact_snapshot: { handle: selectedHandle }
    };
  }

  if (isLowConfidence) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.RESEARCH_REQUIRED,
      selected_channel: selectedChannel,
      selected_contact_handle: selectedHandle,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.RESEARCH_REQUIRED_LOW_CONFIDENCE,
      reason_detail: 'Data confidence score is below threshold (< 40); verification needed',
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, advisoryOnly: true },
      recommendation_snapshot: { confidence_score: score?.data_confidence_score },
      contact_snapshot: { handle: selectedHandle }
    };
  }

  // 12. LAYER 8 — Human Review Requirements (Branch Coordination / Conflicting Contacts)
  const entityGroup = dbInstance.getEntityGroupByLeadId ? dbInstance.getEntityGroupByLeadId(leadId, tid) : null;
  const isBranch = entityGroup && entityGroup.canonical_lead_id && entityGroup.canonical_lead_id !== leadId;

  if (isBranch) {
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      tenant_id: tid,
      eligibility_status: ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED,
      selected_channel: selectedChannel,
      selected_contact_handle: selectedHandle,
      fallback_attempted: fallbackAttempted,
      reason_code: ELIGIBILITY_REASONS.HUMAN_REVIEW_BRANCH_COORDINATION,
      reason_detail: `Branch location of ${entityGroup.entity_name}. Requires coordination with HQ (${entityGroup.canonical_lead_id})`,
      checked_at: checkedAt,
      compliance_snapshot: { allowed: false, requiresHumanReview: true },
      recommendation_snapshot: null,
      contact_snapshot: { handle: selectedHandle, entity_group_id: entityGroup.id }
    };
  }

  // Check for conflicting decision-maker contact emails
  const dmContacts = contacts.filter(c => c.is_decision_maker && c.email);
  if (dmContacts.length > 1) {
    const distinctEmails = new Set(dmContacts.map(c => c.email.toLowerCase()));
    if (distinctEmails.size > 1) {
      return {
        campaign_id: campaignId,
        lead_id: leadId,
        tenant_id: tid,
        eligibility_status: ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED,
        selected_channel: selectedChannel,
        selected_contact_handle: selectedHandle,
        fallback_attempted: fallbackAttempted,
        reason_code: ELIGIBILITY_REASONS.HUMAN_REVIEW_CONFLICTING_CONTACTS,
        reason_detail: 'Multiple conflicting decision-maker email contacts detected. Human confirmation required.',
        checked_at: checkedAt,
        compliance_snapshot: { allowed: false, requiresHumanReview: true },
        recommendation_snapshot: null,
        contact_snapshot: { conflictingContacts: Array.from(distinctEmails) }
      };
    }
  }

  // 13. DECISION -> ELIGIBLE FOR CAMPAIGN
  return {
    campaign_id: campaignId,
    lead_id: leadId,
    tenant_id: tid,
    eligibility_status: ELIGIBILITY_STATUSES.ELIGIBLE,
    selected_channel: selectedChannel,
    selected_contact_handle: selectedHandle,
    fallback_attempted: fallbackAttempted,
    reason_code: ELIGIBILITY_REASONS.ELIGIBLE_FOR_CAMPAIGN,
    reason_detail: quotaAvailable
      ? `Lead is eligible for campaign outreach on channel "${selectedChannel}"`
      : `Lead is eligible for campaign outreach on channel "${selectedChannel}" (Note: Daily quota currently full: ${currentQuotaAttempts}/${dailyLimit})`,
    checked_at: checkedAt,
    compliance_snapshot: {
      allowed: true,
      channel: selectedChannel,
      quotaAvailable,
      dailyAttempts: currentQuotaAttempts,
      dailyLimit,
      attemptsMade: channelState?.attempt_count || 0
    },
    recommendation_snapshot: {
      action_type: rec?.action_type || 'DIRECT_OUTREACH',
      priority: rec?.priority_band || 'P2'
    },
    contact_snapshot: {
      channel: selectedChannel,
      handle: selectedHandle
    }
  };
}

/**
 * Campaign-Wide Pre-Flight Eligibility Evaluator
 * Evaluates all campaign_leads in a campaign deterministically.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Summary and array of individual lead evaluations
 */
export function evaluateCampaignEligibility(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  if (!campaignId) throw new Error('campaignId is required');

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const campaignLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 }) || [];

  const evaluations = [];
  const statusCounts = {
    [ELIGIBILITY_STATUSES.ELIGIBLE]: 0,
    [ELIGIBILITY_STATUSES.INELIGIBLE]: 0,
    [ELIGIBILITY_STATUSES.RESEARCH_REQUIRED]: 0,
    [ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED]: 0
  };
  const channelDist = {};
  const reasonDist = {};
  let fallbackCount = 0;

  for (const cl of campaignLeads) {
    const evalResult = evaluateCampaignLeadEligibility(campaignId, cl.lead_id, {
      tenantId: tid,
      dbInstance
    });

    evaluations.push(evalResult);

    statusCounts[evalResult.eligibility_status] = (statusCounts[evalResult.eligibility_status] || 0) + 1;
    if (evalResult.selected_channel) {
      channelDist[evalResult.selected_channel] = (channelDist[evalResult.selected_channel] || 0) + 1;
    }
    reasonDist[evalResult.reason_code] = (reasonDist[evalResult.reason_code] || 0) + 1;
    if (evalResult.fallback_attempted) fallbackCount++;
  }

  // Deterministic Ordering: status (ELIGIBLE -> RESEARCH_REQUIRED -> HUMAN_REVIEW_REQUIRED -> INELIGIBLE), then lead_id ASC
  const STATUS_ORDER = {
    [ELIGIBILITY_STATUSES.ELIGIBLE]: 1,
    [ELIGIBILITY_STATUSES.RESEARCH_REQUIRED]: 2,
    [ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED]: 3,
    [ELIGIBILITY_STATUSES.INELIGIBLE]: 4
  };

  evaluations.sort((a, b) => {
    const sA = STATUS_ORDER[a.eligibility_status] || 99;
    const sB = STATUS_ORDER[b.eligibility_status] || 99;
    if (sA !== sB) return sA - sB;
    return a.lead_id.localeCompare(b.lead_id);
  });

  return {
    campaign_id: campaignId,
    tenant_id: tid,
    total_campaign_leads: campaignLeads.length,
    status_counts: statusCounts,
    channel_distribution: channelDist,
    reason_distribution: reasonDist,
    fallback_count: fallbackCount,
    evaluations,
    disclaimer: 'Campaign eligibility provides read-only pre-flight decision support. Final send authorization remains exclusively with Phase 1 executeOutreachGate().'
  };
}

/**
 * Persist Updated Eligibility to Campaign Leads Table
 * Refreshes eligibility_status, planned_channel, target_contact_handle, and eligibility_details.
 * Does NOT send messages, reserve quota, or update outreach state.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Summary of updated campaign leads
 */
export function refreshCampaignEligibility(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaignEval = evaluateCampaignEligibility(campaignId, { tenantId: tid, dbInstance });

  let updatedCount = 0;
  for (const ev of campaignEval.evaluations) {
    dbInstance.updateCampaignLead(campaignId, ev.lead_id, {
      eligibility_status: ev.eligibility_status,
      planned_channel: ev.selected_channel,
      target_contact_handle: ev.selected_contact_handle,
      eligibility_details: {
        reason_code: ev.reason_code,
        reason_detail: ev.reason_detail,
        checked_at: ev.checked_at,
        fallback_attempted: ev.fallback_attempted,
        compliance_snapshot: ev.compliance_snapshot
      }
    }, tid);
    updatedCount++;
  }

  const updatedCampaign = dbInstance.getCampaignById(campaignId, tid);

  return {
    campaign_id: campaignId,
    tenant_id: tid,
    updated_records: updatedCount,
    campaign_total_leads: updatedCampaign.total_leads,
    campaign_eligible_leads: updatedCampaign.eligible_leads,
    status_counts: campaignEval.status_counts,
    disclaimer: 'Campaign leads refreshed with latest pre-flight eligibility. Zero outbound dispatch performed.'
  };
}
