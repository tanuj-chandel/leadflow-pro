/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 6B
 * CAMPAIGN TARGETING & FILTERING ENGINE
 * ============================================================================
 * Pure planning and targeting layer that deterministically evaluates the lead
 * population against campaign criteria and applies hard exclusions, certified
 * Step 5A recommendations, and Step 2 entity resolution.
 *
 * Safety Invariants:
 * - ZERO network outreach / dispatches.
 * - Read-only ingestion of leads, scores, recommendations, and entity groups.
 * - Does NOT modify existing lead, score, or recommendation records.
 * - Strict tenant isolation & IDOR protection.
 * - VERIFIED MOBILE != VERIFIED WHATSAPP.
 * - RESEARCH_GAPS records preserved and protected from false mature-stack labeling.
 */

import { db as defaultDb } from './database.js';

export const TARGETING_RESULT_TAXONOMY = {
  MATCHED: 'MATCHED',
  EXCLUDED_SUPPRESSED: 'EXCLUDED_SUPPRESSED',
  EXCLUDED_OPTOUT: 'EXCLUDED_OPTOUT',
  EXCLUDED_CROSS_TENANT: 'EXCLUDED_CROSS_TENANT',
  EXCLUDED_ENTITY_DUPLICATE: 'EXCLUDED_ENTITY_DUPLICATE',
  EXCLUDED_ACTION_MISMATCH: 'EXCLUDED_ACTION_MISMATCH',
  EXCLUDED_PRIORITY_MISMATCH: 'EXCLUDED_PRIORITY_MISMATCH',
  EXCLUDED_SCORE_THRESHOLD: 'EXCLUDED_SCORE_THRESHOLD',
  EXCLUDED_INDUSTRY: 'EXCLUDED_INDUSTRY',
  EXCLUDED_CHANNEL: 'EXCLUDED_CHANNEL',
  RESEARCH_REQUIRED: 'RESEARCH_REQUIRED',
  ALREADY_IN_CAMPAIGN: 'ALREADY_IN_CAMPAIGN'
};

const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/**
 * Deterministic Campaign Targeting Evaluator
 * Evaluates candidate leads against targeting criteria in strict layer order.
 * 
 * @param {string} campaignId
 * @param {object} criteria
 * @param {object} [options]
 * @returns {object} Full preview dossier with candidate leads and distribution metrics
 */
export function previewCampaignTargets(campaignId, criteria = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  // 1. Verify Campaign exists and belongs to tenant
  let campaign = null;
  if (campaignId) {
    campaign = dbInstance.getCampaignById(campaignId, tid);
    if (!campaign) {
      throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
    }
  }

  // Merge criteria: explicit criteria override campaign.target_criteria
  const activeCriteria = {
    ...(campaign?.target_criteria || {}),
    ...criteria
  };

  const {
    priority_bands = null, // e.g. ['P1', 'P2']
    actions = null, // e.g. ['DIRECT_OUTREACH']
    min_icp_fit = null,
    min_opportunity = null,
    min_data_confidence = null,
    industries = null, // e.g. ['Dental Clinics', 'Real Estate']
    channels_allowed = null, // e.g. ['WHATSAPP', 'EMAIL']
    allow_branches = false // if false, only canonical HQ is selected for multi-location groups
  } = activeCriteria;

  // Normalization of criteria sets
  const allowedPriorities = Array.isArray(priority_bands) && priority_bands.length > 0
    ? new Set(priority_bands.map(p => String(p).trim().toUpperCase()))
    : null;

  const allowedActions = Array.isArray(actions) && actions.length > 0
    ? new Set(actions.map(a => String(a).trim().toUpperCase()))
    : null;

  const allowedIndustries = Array.isArray(industries) && industries.length > 0
    ? industries.map(i => String(i).trim().toLowerCase())
    : null;

  const allowedChannels = Array.isArray(channels_allowed) && channels_allowed.length > 0
    ? new Set(channels_allowed.map(c => String(c).trim().toUpperCase()))
    : null;

  // Retrieve all leads for tenant
  const allLeads = dbInstance.getLeads(tid) || [];

  const matched = [];
  const excluded = [];
  const exclusionReasons = {};
  const priorityDist = {};
  const actionDist = {};
  const channelDist = {};
  const industryDist = {};
  let researchRequiredCount = 0;
  let entityDuplicateCount = 0;

  // Track entity canonicals already claimed in this campaign evaluation
  const seenEntityGroups = new Set();

  for (const lead of allLeads) {
    const leadId = lead.id;

    // ------------------------------------------------------------------------
    // LAYER 1: Tenant Ownership & Isolation Check
    // ------------------------------------------------------------------------
    const leadTenant = lead.tenant_id || 'default';
    if (leadTenant !== tid) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_CROSS_TENANT, details: 'Tenant mismatch' });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_CROSS_TENANT] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_CROSS_TENANT] || 0) + 1;
      continue;
    }

    // ------------------------------------------------------------------------
    // LAYER 2: Hard Exclusions (Suppression, Opt-Out, Missing Identity)
    // ------------------------------------------------------------------------
    if (lead.opted_out === 1 || lead.opted_out === '1' || lead.opted_out === true) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_OPTOUT, details: 'Lead explicitly opted out' });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_OPTOUT] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_OPTOUT] || 0) + 1;
      continue;
    }

    const isSuppressed = (lead.phone && dbInstance.isGloballySuppressed(lead.phone, tid)) ||
                         (lead.email && dbInstance.isGloballySuppressed(lead.email, tid));
    if (isSuppressed) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_SUPPRESSED, details: 'Lead contact is globally suppressed' });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SUPPRESSED] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SUPPRESSED] || 0) + 1;
      continue;
    }

    // ------------------------------------------------------------------------
    // LAYER 3: Entity Safety & Multi-Location Branch Coordination
    // ------------------------------------------------------------------------
    const entityGroup = dbInstance.getEntityGroupByLeadId ? dbInstance.getEntityGroupByLeadId(leadId, tid) : null;
    let isBranch = false;
    let canonicalHqId = null;

    if (entityGroup) {
      canonicalHqId = entityGroup.canonical_lead_id;
      if (canonicalHqId && canonicalHqId !== leadId) {
        isBranch = true;
      }

      // If campaign does not allow branch prospecting and this is a branch, exclude or coordinate with HQ
      if (isBranch && !allow_branches) {
        excluded.push({
          leadId,
          reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE,
          details: `Branch location of ${entityGroup.entity_name} (HQ: ${canonicalHqId}). Only canonical HQ targeted.`
        });
        exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE] || 0) + 1;
        entityDuplicateCount++;
        continue;
      }

      // If canonical HQ already matched from same entity group, avoid multi-contacting same entity
      if (entityGroup.id && seenEntityGroups.has(entityGroup.id) && !allow_branches) {
        excluded.push({
          leadId,
          reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE,
          details: `Another location from entity group ${entityGroup.entity_name} already matched.`
        });
        exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ENTITY_DUPLICATE] || 0) + 1;
        entityDuplicateCount++;
        continue;
      }
    }

    // ------------------------------------------------------------------------
    // LAYER 4: Ingest Certified Step 5A Sales Recommendation
    // ------------------------------------------------------------------------
    const rec = dbInstance.getLatestRecommendation(leadId, tid);
    const leadAction = rec?.action_type || 'RESEARCH_GAPS';
    const leadPriority = (rec?.priority_band || 'P3').split(' ')[0];
    const recChannel = rec?.recommended_channel || 'MANUAL_RESEARCH';
    const recHandle = rec?.target_contact_handle || null;

    if (allowedActions && !allowedActions.has(leadAction)) {
      excluded.push({
        leadId,
        reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_ACTION_MISMATCH,
        details: `Action "${leadAction}" does not match criteria [${Array.from(allowedActions).join(', ')}]`
      });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ACTION_MISMATCH] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_ACTION_MISMATCH] || 0) + 1;
      continue;
    }

    if (allowedPriorities && !allowedPriorities.has(leadPriority)) {
      excluded.push({
        leadId,
        reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_PRIORITY_MISMATCH,
        details: `Priority "${leadPriority}" does not match criteria [${Array.from(allowedPriorities).join(', ')}]`
      });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_PRIORITY_MISMATCH] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_PRIORITY_MISMATCH] || 0) + 1;
      continue;
    }

    // ------------------------------------------------------------------------
    // LAYER 5: Ingest Certified Step 4 Scoring V2 Thresholds
    // ------------------------------------------------------------------------
    const score = dbInstance.getLatestLeadScore(leadId, tid);
    const icpFit = score?.icp_fit_score ?? score?.icpFitScore ?? 50.0;
    const oppScore = score?.opportunity_score ?? score?.opportunityScore ?? 10.0;
    const dataConf = score?.data_confidence_score ?? score?.dataConfidenceScore ?? 25.0;

    if (min_icp_fit !== null && icpFit < min_icp_fit) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD, details: `ICP Fit ${icpFit} < min ${min_icp_fit}` });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] || 0) + 1;
      continue;
    }

    if (min_opportunity !== null && oppScore < min_opportunity) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD, details: `Opportunity ${oppScore} < min ${min_opportunity}` });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] || 0) + 1;
      continue;
    }

    if (min_data_confidence !== null && dataConf < min_data_confidence) {
      excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD, details: `Data Confidence ${dataConf} < min ${min_data_confidence}` });
      exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_SCORE_THRESHOLD] || 0) + 1;
      continue;
    }

    // ------------------------------------------------------------------------
    // LAYER 6: Industry / Category Targeting
    // ------------------------------------------------------------------------
    const leadCategory = (lead.searchTerm || lead.segment || '').trim().toLowerCase();
    if (allowedIndustries) {
      const matchesIndustry = allowedIndustries.some(ind => leadCategory.includes(ind) || ind.includes(leadCategory));
      if (!matchesIndustry) {
        excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_INDUSTRY, details: `Category "${leadCategory}" does not match targeted industries` });
        exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_INDUSTRY] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_INDUSTRY] || 0) + 1;
        continue;
      }
    }

    // ------------------------------------------------------------------------
    // LAYER 7: Channel Feasibility & Contactability (Strict WhatsApp Guard)
    // ------------------------------------------------------------------------
    if (allowedChannels) {
      // Strictly respect certified Step 5 channel: Never manufacture WhatsApp eligibility from a phone number
      if (!allowedChannels.has(recChannel)) {
        excluded.push({ leadId, reason: TARGETING_RESULT_TAXONOMY.EXCLUDED_CHANNEL, details: `Recommended channel "${recChannel}" not in allowed channels` });
        exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_CHANNEL] = (exclusionReasons[TARGETING_RESULT_TAXONOMY.EXCLUDED_CHANNEL] || 0) + 1;
        continue;
      }
    }

    // Track research required
    if (leadAction === 'RESEARCH_GAPS' || dataConf < 40) {
      researchRequiredCount++;
    }

    if (entityGroup?.id) {
      seenEntityGroups.add(entityGroup.id);
    }

    // Tally distributions
    priorityDist[leadPriority] = (priorityDist[leadPriority] || 0) + 1;
    actionDist[leadAction] = (actionDist[leadAction] || 0) + 1;
    channelDist[recChannel] = (channelDist[recChannel] || 0) + 1;
    const catLabel = lead.searchTerm || 'Unknown';
    industryDist[catLabel] = (industryDist[catLabel] || 0) + 1;

    matched.push({
      lead_id: leadId,
      business_name: lead.businessName,
      priority_band: leadPriority,
      action_type: leadAction,
      planned_channel: recChannel,
      target_contact_handle: recHandle,
      icp_fit: icpFit,
      opportunity_score: oppScore,
      data_confidence: dataConf,
      is_branch: isBranch,
      entity_group_id: entityGroup?.id || null,
      recommendation_id: rec?.id || null
    });
  }

  // Deterministic Ordering: Priority band ASC (P1 -> P2 -> P3 -> P4 -> P5), then Lead ID ASC
  matched.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.priority_band] || 99;
    const pB = PRIORITY_ORDER[b.priority_band] || 99;
    if (pA !== pB) return pA - pB;
    return a.lead_id.localeCompare(b.lead_id);
  });

  return {
    campaign_id: campaignId || null,
    tenant_id: tid,
    total_evaluated: allLeads.length,
    matched_count: matched.length,
    excluded_count: excluded.length,
    research_required_count: researchRequiredCount,
    entity_duplicate_count: entityDuplicateCount,
    exclusion_reasons: exclusionReasons,
    priority_distribution: priorityDist,
    action_distribution: actionDist,
    channel_distribution: channelDist,
    industry_distribution: industryDist,
    candidates: matched,
    disclaimer: 'Target preview provides deterministic candidate analysis. Zero messages sent.'
  };
}

/**
 * Deterministic Campaign Target Application
 * Applies criteria and writes matched candidates to campaign_leads join table.
 * Idempotent: calling multiple times will not insert duplicates.
 * 
 * @param {string} campaignId
 * @param {object} criteria
 * @param {object} [options]
 * @returns {object} Application summary with added, skipped, and total counts
 */
export function applyCampaignTargets(campaignId, criteria = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  if (!campaignId) throw new Error('campaignId is required');

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  // Generate preview of targets
  const preview = previewCampaignTargets(campaignId, criteria, { tenantId: tid, dbInstance });

  let addedCount = 0;
  let skippedCount = 0;
  const errors = [];

  for (const candidate of preview.candidates) {
    const existing = dbInstance.getCampaignLead(campaignId, candidate.lead_id, tid);
    if (existing) {
      skippedCount++;
      continue;
    }

    try {
      // Map candidate status to Step 6A eligibility taxonomy
      let eligibilityStatus = 'ELIGIBLE';
      if (candidate.action_type === 'RESEARCH_GAPS') {
        eligibilityStatus = 'RESEARCH_REQUIRED';
      } else if (candidate.is_branch) {
        eligibilityStatus = 'HUMAN_REVIEW_REQUIRED';
      }

      dbInstance.createCampaignLead({
        campaign_id: campaignId,
        lead_id: candidate.lead_id,
        tenant_id: tid,
        eligibility_status: eligibilityStatus,
        planned_channel: candidate.planned_channel,
        target_contact_handle: candidate.target_contact_handle,
        sequence_step: 1,
        review_status: 'INCLUDED',
        eligibility_details: {
          priority_band: candidate.priority_band,
          action_type: candidate.action_type,
          icp_fit: candidate.icp_fit,
          opportunity_score: candidate.opportunity_score,
          data_confidence: candidate.data_confidence,
          recommendation_id: candidate.recommendation_id
        }
      }, tid);

      addedCount++;
    } catch (err) {
      errors.push({ leadId: candidate.lead_id, error: err.message });
    }
  }

  // Update campaign targeting criteria if new criteria were passed
  if (Object.keys(criteria).length > 0) {
    const mergedCriteria = {
      ...(campaign.target_criteria || {}),
      ...criteria
    };
    dbInstance.updateCampaign(campaignId, { target_criteria: mergedCriteria }, tid);
  }

  // Fetch recomputed campaign counts
  const updatedCampaign = dbInstance.getCampaignById(campaignId, tid);

  return {
    campaign_id: campaignId,
    tenant_id: tid,
    total_candidates_matched: preview.matched_count,
    added_to_campaign: addedCount,
    skipped_existing: skippedCount,
    failed_count: errors.length,
    errors,
    campaign_total_leads: updatedCampaign.total_leads,
    campaign_eligible_leads: updatedCampaign.eligible_leads,
    disclaimer: 'Campaign targets applied as advisory planning records. Zero outbound dispatch performed.'
  };
}
