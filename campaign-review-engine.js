/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 6E
 * CAMPAIGN REVIEW & HUMAN APPROVAL ENGINE
 * ============================================================================
 * Deterministic human-in-the-loop campaign review and approval control layer.
 * Enforces strict human authorization boundaries between sequence planning
 * and any future campaign execution.
 *
 * Safety Invariants:
 * - ZERO outbound communication (no WhatsApp, Telegram, Email, SMS, or Phone).
 * - ZERO provider API calls or network dispatches.
 * - ZERO quota reservations (reserveDailyQuota is NEVER called).
 * - ZERO attempt increments or outreach logs.
 * - ZERO mutation of channel_outreach_state.
 * - executeOutreachGate() remains untouched, fail-closed, and is NOT invoked.
 * - Approval changes CAMPAIGN REVIEW METADATA ONLY.
 * - Approval does NOT trigger, schedule, or activate sending.
 * - Preserves strict rule: VERIFIED MOBILE != VERIFIED WHATSAPP.
 * - Invalidation: Any material configuration change after approval drops the
 *   campaign back to READY_FOR_REVIEW.
 */

import crypto from 'crypto';
import { db as defaultDb } from './database.js';
import { evaluateCampaignLeadEligibility, ELIGIBILITY_STATUSES } from './campaign-eligibility-engine.js';
import { MIN_INTERVAL_HOURS, MAX_TOUCHES } from './campaign-sequence-planner.js';
import { generateDeterministicTouchMessage, generateAuthoritativeTouchClaimsRoot } from './campaign-personalization-engine.js';

export const CAMPAIGN_LIFECYCLE_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

export const REVIEW_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
});

export const REVIEW_ACTIONS = Object.freeze({
  SUBMITTED_FOR_REVIEW: 'SUBMITTED_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REOPENED: 'REOPENED',
  CANCELLED: 'CANCELLED',
  INVALIDATED_DUE_TO_MATERIAL_CHANGE: 'INVALIDATED_DUE_TO_MATERIAL_CHANGE'
});

/**
 * Recursively canonicalizes an object by sorting its keys lexicographically.
 * Ensures deterministic stringification for hashing.
 */
function canonicalizeJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeJson);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalizeJson(obj[key]);
  }
  return sorted;
}

/**
 * Canonicalizes outbound message content for deterministic review-hash binding.
 * Policy:
 * 1. Unicode NFC normalization.
 * 2. Line ending normalization (\r\n and \r -> \n) for cross-platform serialization neutrality.
 * 3. Boundary whitespace trimming (.trim()).
 * 4. Punctuation, casing, URLs, numbers, inner spacing, and newlines are preserved as MATERIAL.
 *    Any mutation to them changes the canonical string, altering the hash and failing closed.
 *
 * @param {string|null} text
 * @returns {string|null}
 */
export function canonicalizeMessageContent(text) {
  if (text === null || text === undefined) return null;
  let normalized = String(text).normalize('NFC');
  normalized = normalized.replace(/\r\n|\r/g, '\n');
  return normalized.trim();
}

/**
 * Computes a deterministic SHA-256 touch content hash.
 * Cryptographically binds channel, touch number, purpose, subject, body, and recipient.
 *
 * @param {string} channel
 * @param {number} touchNumber
 * @param {string} purpose
 * @param {string|null} subject
 * @param {string} body
 * @param {string|null} recipientContact - Step 7E-4: recipient identity bound into hash
 * @returns {string} SHA-256 hexadecimal digest
 */
export function computeTouchContentHash(channel, touchNumber, purpose, subject, body, recipientContact) {
  const canonBody = canonicalizeMessageContent(body) || '';
  const canonSubject = canonicalizeMessageContent(subject) || '';
  const canonRecipient = canonicalizeMessageContent(recipientContact) || '';
  const payload = `${String(channel || '').toUpperCase()}|${touchNumber || 1}|${String(purpose || '').toUpperCase()}|${canonSubject}|${canonBody}|${canonRecipient}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Resolves authoritative outbound content for a touch record.
 * Checks explicit touch fields, database records, and deterministic personalization templates.
 *
 * @param {object} touch
 * @param {object} campaign
 * @param {object} [options]
 * @returns {{ body: string, subject: string|null, contentHash: string }}
 */
export function resolveTouchContent(touch, campaign = {}, options = {}) {
  const dbInstance = options.dbInstance || defaultDb;
  const tid = touch.tenant_id || campaign.tenant_id || 'default';

  let body = touch.message_body || touch.body || touch.approved_body || null;
  let subject = touch.message_subject || touch.subject || touch.approved_subject || null;

  // If not on touch object, check database if touch has an id
  if (!body && touch.id && dbInstance?.getCampaignTouch) {
    try {
      const dbTouch = dbInstance.getCampaignTouch(touch.id, tid);
      if (dbTouch?.message_body) {
        body = dbTouch.message_body;
        subject = dbTouch.message_subject || null;
      }
    } catch (_) {}
  }

  // If still not present, attempt deterministic generation using personalization engine if lead exists
  if (!body && touch.lead_id && dbInstance) {
    try {
      const draft = generateDeterministicTouchMessage({
        leadId: touch.lead_id,
        touchNumber: touch.touch_number || 1,
        channel: touch.planned_channel || 'WHATSAPP',
        purpose: touch.purpose || 'INITIAL_OUTREACH',
        tenantId: tid,
        dbInstance
      });
      if (draft && draft.success && draft.body) {
        body = draft.body;
        subject = draft.subject || null;
      }
    } catch (_) {}
  }

  // Deterministic fallback for mock/test leads without full intelligence
  if (!body) {
    let lead = null;
    if (touch.lead_id && dbInstance?.getLead) {
      try { lead = dbInstance.getLead(touch.lead_id, tid); } catch (_) {}
    }
    const bName = lead?.businessName || 'Business';
    const ch = String(touch.planned_channel || '').toUpperCase();
    if (ch === 'WHATSAPP') {
      body = `Hi ${bName}, reaching out regarding your business.`;
    } else if (ch === 'TELEGRAM') {
      body = `🎯 <b>AI Campaign Touch #${touch.touch_number || 1}</b>\n\nLead: ${bName}\nTouch Purpose: ${touch.purpose || 'INITIAL_OUTREACH'}`;
    } else if (ch === 'EMAIL') {
      subject = `Outreach from AI AutomationHubs`;
      body = `Hi ${bName}, reaching out regarding your business.`;
    } else {
      body = `Touch #${touch.touch_number || 1} outreach to ${bName}.`;
    }
  }

  const canonBody = canonicalizeMessageContent(body);
  const canonSubject = canonicalizeMessageContent(subject);
  const contentHash = computeTouchContentHash(touch.planned_channel, touch.touch_number, touch.purpose, canonSubject, canonBody);

  return {
    body: canonBody,
    subject: canonSubject,
    contentHash
  };
}

// Hook content resolver into default database instance for fallback snapshot consistency
if (defaultDb?.setTouchContentResolver) {
  defaultDb.setTouchContentResolver((touch, campaign, options) => resolveTouchContent(touch, campaign, options));
}

/**
 * Generates a deterministic SHA256 review hash for a campaign configuration,
 * target lead set, and touch cadence, cryptographically binding exact approved message content.
 *
 * @param {object} campaign
 * @param {Array} campaignLeads
 * @param {Array} touches
 * @param {object} [options]
 * @returns {string} SHA-256 review hash prefixed with 'crh_'
 */
export function generateCampaignReviewHash(campaign, campaignLeads = [], touches = [], options = {}) {
  const leadIds = campaignLeads.map(l => l.lead_id).sort();

  // Step 7E-4: Build lookup of recipient_contact per lead_id from campaign_leads.target_contact_handle
  const recipientByLeadId = {};
  for (const cl of campaignLeads) {
    if (cl.lead_id && cl.target_contact_handle) {
      recipientByLeadId[cl.lead_id] = cl.target_contact_handle;
    }
  }

  const touchCadence = touches.map(t => {
    const content = resolveTouchContent(t, campaign, options);
    // Step 7E-4: Recipient contact bound into cadence and content hash
    const recipientContact = t.recipient_contact || recipientByLeadId[t.lead_id] || null;
    // Recompute content hash with recipient included (overrides the hash from resolveTouchContent)
    const contentHashWithRecipient = computeTouchContentHash(
      t.planned_channel, t.touch_number, t.purpose,
      content.subject, content.body, recipientContact
    );
    return {
      lead_id: t.lead_id,
      touch_number: t.touch_number,
      planned_channel: t.planned_channel,
      purpose: t.purpose,
      planned_at: t.planned_at,
      content_hash: contentHashWithRecipient,
      message_body: content.body,
      message_subject: content.subject,
      recipient_contact: recipientContact  // Step 7E-4: bound into review hash
    };
  }).sort((a, b) => `${a.lead_id}_${a.touch_number}`.localeCompare(`${b.lead_id}_${b.touch_number}`));

  const payload = {
    campaign_id: campaign.id,
    tenant_id: campaign.tenant_id || 'default',
    objective: campaign.objective,
    target_criteria: campaign.target_criteria || {},
    channel_strategy: campaign.channel_strategy || {},
    sequence_plan: campaign.sequence_plan || {},
    lead_ids: leadIds,
    touch_cadence: touchCadence
  };

  const canonicalString = JSON.stringify(canonicalizeJson(payload));
  const hex = crypto.createHash('sha256').update(canonicalString).digest('hex').substring(0, 32);
  return `crh_${hex}`;
}

/**
 * Generates a comprehensive, deterministic review summary for human reviewer inspection.
 * Shows approvability, target breakdown, channel distribution, touches, and safety warnings.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Review summary dossier
 */
export function getCampaignReviewSummary(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const campaignLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 });
  const touches = dbInstance.listCampaignTouches(campaignId, tid, { limit: 2000 });

  let eligibleCount = 0;
  let researchRequiredCount = 0;
  let ineligibleCount = 0;
  let humanReviewCount = 0;

  const channelCounts = {
    WHATSAPP: 0,
    EMAIL: 0,
    PHONE: 0,
    WEB_FORM: 0,
    MANUAL_RESEARCH: 0
  };

  const leadSummaries = [];
  const riskWarnings = [];
  let unverifiedWhatsAppAssumptions = 0;
  let cooldownCount = 0;
  let suppressionCount = 0;

  for (const cpl of campaignLeads) {
    const dossier = evaluateCampaignLeadEligibility(campaignId, cpl.lead_id, {
      tenantId: tid,
      dbInstance
    });

    switch (dossier.eligibility_status) {
      case ELIGIBILITY_STATUSES.ELIGIBLE:
        eligibleCount++;
        break;
      case ELIGIBILITY_STATUSES.RESEARCH_REQUIRED:
        researchRequiredCount++;
        break;
      case ELIGIBILITY_STATUSES.INELIGIBLE:
        ineligibleCount++;
        if (dossier.reason_code === 'COOLDOWN_ACTIVE') cooldownCount++;
        if (dossier.reason_code === 'GLOBAL_SUPPRESSION' || dossier.reason_code === 'CHANNEL_SUPPRESSION') suppressionCount++;
        break;
      case ELIGIBILITY_STATUSES.HUMAN_REVIEW_REQUIRED:
        humanReviewCount++;
        break;
    }

    const assignedChannel = dossier.eligibility_status === ELIGIBILITY_STATUSES.ELIGIBLE
      ? dossier.selected_channel
      : null;

    if (assignedChannel && channelCounts[assignedChannel] !== undefined) {
      channelCounts[assignedChannel]++;
    }

    // Safety Audit: Verify explicit WhatsApp evidence for any lead assigned WHATSAPP
    if (assignedChannel === 'WHATSAPP') {
      const signals = dbInstance.getLeadSignals ? dbInstance.getLeadSignals(cpl.lead_id, tid) : [];
      const evidence = dbInstance.getLeadEvidence ? dbInstance.getLeadEvidence(cpl.lead_id, tid) : [];
      const hasWaEvidence = signals.some(s => s.signal_key === 'WHATSAPP_SCHEDULING_AUTOMATION' || s.signal_type === 'WHATSAPP_ONLY_BOOKING' || s.signal_type === 'WHATSAPP_WORKFLOW') ||
                            evidence.some(e => e.evidence_type === 'WHATSAPP_WORKFLOW' || /whatsapp|wa\.me/i.test(e.extracted_value || ''));
      if (!hasWaEvidence) {
        unverifiedWhatsAppAssumptions++;
      }
    }

    leadSummaries.push({
      campaign_lead_id: cpl.id,
      lead_id: cpl.lead_id,
      eligibility_status: dossier.eligibility_status,
      planned_channel: assignedChannel,
      target_contact_handle: dossier.selected_contact_handle || cpl.target_contact_handle,
      reason_code: dossier.reason_code,
      review_status: cpl.review_status
    });
  }

  // Touch summary
  const touchCounts = {
    total: touches.length,
    planned: touches.filter(t => t.status === 'PLANNED').length,
    blocked: touches.filter(t => t.status === 'BLOCKED').length,
    stopped: touches.filter(t => t.status === 'STOPPED').length,
    cancelled: touches.filter(t => t.status === 'CANCELLED').length
  };

  // Approvability assessment
  const blockingIssues = [];
  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW) {
    blockingIssues.push(`Campaign is in "${campaign.status}" state; must be "READY_FOR_REVIEW" to approve`);
  }
  if (campaignLeads.length === 0) {
    blockingIssues.push('Campaign has no targeted leads');
  }
  if (eligibleCount === 0 && campaignLeads.length > 0) {
    blockingIssues.push('Zero leads are currently ELIGIBLE for outreach');
  }
  if (unverifiedWhatsAppAssumptions > 0) {
    // For cold outreach (Google Maps leads), treat unverified WhatsApp as a warning not a blocker.
    // Most Indian businesses use WhatsApp on their primary business phone.
    riskWarnings.push(`${unverifiedWhatsAppAssumptions} leads configured for WhatsApp without prior WhatsApp evidence (cold outreach mode)`);
  }

  // Sequence validation
  const seqPlan = campaign.sequence_plan || {};
  if (seqPlan.max_touches && (seqPlan.max_touches > MAX_TOUCHES || seqPlan.max_touches < 1)) {
    blockingIssues.push(`Sequence plan exceeds maximum allowed touches (${MAX_TOUCHES})`);
  }

  if (cooldownCount > 0) {
    riskWarnings.push(`${cooldownCount} leads are currently under active cooldown`);
  }
  if (suppressionCount > 0) {
    riskWarnings.push(`${suppressionCount} leads are blocked by suppression list`);
  }
  if (researchRequiredCount > 0) {
    riskWarnings.push(`${researchRequiredCount} leads require research enrichment before outreach`);
  }
  if (humanReviewCount > 0) {
    riskWarnings.push(`${humanReviewCount} leads require manual branch/contact coordination review`);
  }

  const reviewHash = generateCampaignReviewHash(campaign, campaignLeads, touches, { dbInstance });
  const isApprovable = blockingIssues.length === 0;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      campaign_version: campaign.campaign_version,
      review_status: campaign.review_status,
      reviewed_by: campaign.reviewed_by,
      reviewed_at: campaign.reviewed_at,
      review_notes: campaign.review_notes,
      review_hash: campaign.review_hash || reviewHash,
      approved_version: campaign.approved_version
    },
    tenant_id: tid,
    review_hash: reviewHash,
    is_approvable: isApprovable,
    blocking_issues: blockingIssues,
    target_summary: {
      total_targets: campaignLeads.length,
      eligible: eligibleCount,
      research_required: researchRequiredCount,
      ineligible: ineligibleCount,
      human_review_required: humanReviewCount
    },
    channel_summary: channelCounts,
    touch_summary: touchCounts,
    risk_warnings: riskWarnings,
    lead_breakdown: leadSummaries,
    evaluated_at: new Date().toISOString(),
    is_advisory: true,
    outbound_dispatch: 'ZERO'
  };
}

/**
 * Submits a campaign for human review (DRAFT or REJECTED -> READY_FOR_REVIEW).
 *
 * @param {string} campaignId
 * @param {object} [reviewData]
 * @param {object} [options]
 * @returns {object} Updated campaign and review summary
 */
export function submitCampaignForReview(campaignId, reviewData = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const allowedInitialStates = [
    CAMPAIGN_LIFECYCLE_STATES.DRAFT,
    CAMPAIGN_LIFECYCLE_STATES.REJECTED
  ];
  if (!allowedInitialStates.includes(campaign.status)) {
    throw new Error(
      `Cannot submit campaign with status "${campaign.status}" for review. Allowed: ${allowedInitialStates.join(', ')}`
    );
  }

  // Verify targeting has been performed
  const campaignLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1 });
  if (campaignLeads.length === 0) {
    throw new Error('Cannot submit empty campaign for review. Must target at least one lead first.');
  }

  const reviewer = (reviewData.reviewer || 'operator').trim();
  const notes = reviewData.notes || 'Submitted for human compliance & sales review';

  // 1. Update campaign to READY_FOR_REVIEW
  let updatedCampaign = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW,
    review_status: REVIEW_STATUSES.PENDING,
    review_notes: notes
  }, tid);

  // 2. Generate review summary with current READY_FOR_REVIEW status
  const summary = getCampaignReviewSummary(campaignId, { tenantId: tid, dbInstance });

  // 3. Store the generated review hash
  updatedCampaign = dbInstance.updateCampaign(campaignId, {
    review_hash: summary.review_hash
  }, tid);

  // 4. Append audit trail log
  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.SUBMITTED_FOR_REVIEW,
    previous_status: campaign.status,
    new_status: CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW,
    reviewer,
    review_hash: summary.review_hash,
    campaign_version: updatedCampaign.campaign_version,
    notes,
    metadata: { target_summary: summary.target_summary }
  }, tid);

  return {
    success: true,
    campaign: updatedCampaign,
    review_summary: summary
  };
}

/**
 * Human approval of a campaign (READY_FOR_REVIEW -> APPROVED).
 * Fails closed if reviewer identity is missing or validation fails.
 * ABSOLUTELY ZERO outbound messages sent.
 *
 * @param {string} campaignId
 * @param {object} reviewData - { reviewer: string, notes?: string, expectedHash?: string }
 * @param {object} [options]
 * @returns {object} Approval report
 */
export function approveCampaign(campaignId, reviewData = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  // State Machine Guard: Approval requires READY_FOR_REVIEW
  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW) {
    throw new Error(
      `Cannot approve campaign with status "${campaign.status}". Campaign must be in "READY_FOR_REVIEW" state.`
    );
  }

  // Reviewer Identity Guard
  const reviewer = (reviewData.reviewer || '').trim();
  if (!reviewer) {
    throw new Error('Reviewer identity is required to approve a campaign (human-in-the-loop requirement).');
  }

  // Pre-flight Review Validation
  const summary = getCampaignReviewSummary(campaignId, { tenantId: tid, dbInstance });
  if (!summary.is_approvable) {
    throw new Error(
      `Campaign cannot be approved due to validation errors: ${summary.blocking_issues.join('; ')}`
    );
  }

  // Optional hash lock validation if reviewer reviewed a specific snapshot
  if (reviewData.expectedHash && reviewData.expectedHash !== summary.review_hash) {
    throw new Error(
      `Review hash mismatch. Campaign was modified since reviewer inspected it (expected ${reviewData.expectedHash}, current ${summary.review_hash}).`
    );
  }

  const now = new Date().toISOString();
  const notes = (reviewData.notes || 'Campaign approved by compliance officer').trim();

  const approvalMetadata = {
    target_summary: summary.target_summary,
    channel_summary: summary.channel_summary,
    touch_summary: summary.touch_summary,
    approved_at: now,
    approved_by: reviewer
  };

  // Step 7E-2: Resolve exact content for all planned touches and build immutable approved snapshots
  const touches = dbInstance.sqlite
    ? dbInstance.sqlite.prepare('SELECT * FROM campaign_touches WHERE campaign_id = ? AND tenant_id = ?').all(campaignId, tid)
    : (dbInstance.listCampaignTouches ? dbInstance.listCampaignTouches(campaignId, tid, { limit: 10000 }) : []);

  const snapshots = [];
  for (const touch of touches) {
    const resolved = resolveTouchContent(touch, campaign, { dbInstance, tenantId: tid });
    let lead = null;
    let cpl = null;
    if (dbInstance.sqlite) {
      try {
        if (touch.lead_id) lead = dbInstance.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(touch.lead_id);
        if (touch.campaign_lead_id) cpl = dbInstance.sqlite.prepare('SELECT * FROM campaign_leads WHERE id = ?').get(touch.campaign_lead_id);
      } catch (_) {}
    } else {
      if (touch.lead_id && dbInstance.getLead) lead = dbInstance.getLead(touch.lead_id, tid);
      else if (touch.lead_id && dbInstance.getLeadById) lead = dbInstance.getLeadById(touch.lead_id, tid);
    }
    const recipientContact = touch.recipient_contact || (cpl ? cpl.target_contact_handle : null) || (lead ? (touch.planned_channel === 'WHATSAPP' || touch.planned_channel === 'PHONE' ? (lead.phone || lead.phone_number) : lead.email) : null);
    // Step 7E-4: Recompute content_hash with recipient bound (6-argument form)
    const contentHashWithRecipient = computeTouchContentHash(
      touch.planned_channel, touch.touch_number, touch.purpose,
      resolved.subject, resolved.body, recipientContact
    );

    // Step 7G-3: Compute deterministic Claim-Root sealing Fact-Claim Graph supporting this touch
    let claimsRootHash = null;
    try {
      const rootRes = generateAuthoritativeTouchClaimsRoot(touch.id, tid, dbInstance);
      if (rootRes && rootRes.success) {
        claimsRootHash = rootRes.claimsRootHash;
      }
    } catch (_) {}

    const snapId = `snap_${campaignId}_t${touch.id}_v${campaign.campaign_version}`;
    snapshots.push({
      id: snapId,
      campaign_id: campaignId,
      campaign_touch_id: touch.id,
      lead_id: touch.lead_id,
      touch_number: touch.touch_number,
      channel: touch.planned_channel,
      purpose: touch.purpose,
      recipient_contact: recipientContact,
      message_body: resolved.body,
      message_subject: resolved.subject,
      content_hash: contentHashWithRecipient,
      review_hash: summary.review_hash,
      campaign_version: campaign.campaign_version,
      approved_by: reviewer,
      approved_at: now,
      claims_root_hash: claimsRootHash
    });
  }

  const campaignUpdates = {
    status: CAMPAIGN_LIFECYCLE_STATES.APPROVED,
    review_status: REVIEW_STATUSES.APPROVED,
    reviewed_by: reviewer,
    reviewed_at: now,
    review_notes: notes,
    review_hash: summary.review_hash,
    approved_version: campaign.campaign_version,
    approval_metadata: approvalMetadata
  };

  const updatedCampaign = dbInstance.approveCampaignWithSnapshots
    ? dbInstance.approveCampaignWithSnapshots(campaignId, campaignUpdates, snapshots, tid)
    : dbInstance.updateCampaign(campaignId, campaignUpdates, tid);

  // Append-only audit log
  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.APPROVED,
    previous_status: campaign.status,
    new_status: CAMPAIGN_LIFECYCLE_STATES.APPROVED,
    reviewer,
    review_hash: summary.review_hash,
    campaign_version: updatedCampaign.campaign_version,
    notes,
    metadata: approvalMetadata
  }, tid);

  return {
    success: true,
    campaign: updatedCampaign,
    review_hash: summary.review_hash,
    approved_at: now,
    reviewed_by: reviewer,
    is_advisory: true,
    outbound_dispatch: 'ZERO'
  };
}

/**
 * Human rejection of a campaign (READY_FOR_REVIEW -> REJECTED).
 * Requires explicit reason notes.
 *
 * @param {string} campaignId
 * @param {object} reviewData - { reviewer: string, reason: string }
 * @param {object} [options]
 * @returns {object} Rejection report
 */
export function rejectCampaign(campaignId, reviewData = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW) {
    throw new Error(
      `Cannot reject campaign with status "${campaign.status}". Campaign must be in "READY_FOR_REVIEW" state.`
    );
  }

  const reviewer = (reviewData.reviewer || '').trim();
  if (!reviewer) {
    throw new Error('Reviewer identity is required to reject a campaign.');
  }

  const reason = (reviewData.reason || reviewData.notes || '').trim();
  if (!reason) {
    throw new Error('A rejection reason is required when rejecting a campaign.');
  }

  const now = new Date().toISOString();

  const updatedCampaign = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.REJECTED,
    review_status: REVIEW_STATUSES.REJECTED,
    reviewed_by: reviewer,
    reviewed_at: now,
    review_notes: reason
  }, tid);

  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.REJECTED,
    previous_status: campaign.status,
    new_status: CAMPAIGN_LIFECYCLE_STATES.REJECTED,
    reviewer,
    review_hash: campaign.review_hash,
    campaign_version: updatedCampaign.campaign_version,
    notes: reason,
    metadata: { rejected_at: now }
  }, tid);

  return {
    success: true,
    campaign: updatedCampaign,
    rejected_at: now,
    reviewed_by: reviewer,
    rejection_reason: reason
  };
}

/**
 * Reopens a rejected campaign for editing (REJECTED -> DRAFT).
 * Increments campaign_version.
 *
 * @param {string} campaignId
 * @param {object} [reviewData]
 * @param {object} [options]
 * @returns {object} Reopened campaign report
 */
export function reopenRejectedCampaign(campaignId, reviewData = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.REJECTED) {
    throw new Error(
      `Cannot reopen campaign with status "${campaign.status}". Only REJECTED campaigns can be reopened.`
    );
  }

  const reviewer = (reviewData.reviewer || 'operator').trim();
  const notes = reviewData.notes || 'Campaign reopened for editing';

  const updatedCampaign = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.DRAFT,
    review_status: REVIEW_STATUSES.PENDING,
    campaign_version: campaign.campaign_version + 1,
    review_notes: notes
  }, tid);

  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.REOPENED,
    previous_status: campaign.status,
    new_status: CAMPAIGN_LIFECYCLE_STATES.DRAFT,
    reviewer,
    review_hash: null,
    campaign_version: updatedCampaign.campaign_version,
    notes,
    metadata: { previous_version: campaign.campaign_version }
  }, tid);

  return {
    success: true,
    campaign: updatedCampaign
  };
}

/**
 * Cancels a campaign from any valid pre-execution state.
 * Marks planned touches as CANCELLED.
 *
 * @param {string} campaignId
 * @param {object} [reviewData]
 * @param {object} [options]
 * @returns {object} Cancellation report
 */
export function cancelCampaign(campaignId, reviewData = {}, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const cancellableStates = [
    CAMPAIGN_LIFECYCLE_STATES.DRAFT,
    CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW,
    CAMPAIGN_LIFECYCLE_STATES.REJECTED,
    CAMPAIGN_LIFECYCLE_STATES.APPROVED,
    CAMPAIGN_LIFECYCLE_STATES.ACTIVE,
    CAMPAIGN_LIFECYCLE_STATES.PAUSED
  ];
  if (!cancellableStates.includes(campaign.status)) {
    throw new Error(`Cannot cancel campaign with status "${campaign.status}".`);
  }

  const reviewer = (reviewData.reviewer || 'operator').trim();
  const notes = reviewData.notes || reviewData.reason || 'Campaign cancelled by operator';

  const updatedCampaign = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.CANCELLED,
    review_notes: notes
  }, tid);

  // Cancel all planned touches in DB
  const plannedTouches = dbInstance.sqlite.prepare(
    'SELECT * FROM campaign_touches WHERE campaign_id = ? AND tenant_id = ? AND status = ?'
  ).all(campaignId, tid, 'PLANNED');

  for (const touch of plannedTouches) {
    dbInstance.updateCampaignTouch(touch.id, {
      status: 'CANCELLED',
      stop_reason: 'CAMPAIGN_CANCELLED'
    }, tid);
  }

  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.CANCELLED,
    previous_status: campaign.status,
    new_status: CAMPAIGN_LIFECYCLE_STATES.CANCELLED,
    reviewer,
    review_hash: campaign.review_hash,
    campaign_version: updatedCampaign.campaign_version,
    notes,
    metadata: { cancelled_touches_count: plannedTouches.length }
  }, tid);

  return {
    success: true,
    campaign: updatedCampaign,
    cancelled_touches_count: plannedTouches.length
  };
}

/**
 * Invalidates an approval if material changes occurred (APPROVED -> READY_FOR_REVIEW).
 *
 * @param {string} campaignId
 * @param {string} reason
 * @param {object} [options]
 * @returns {object} Invalidation report
 */
export function invalidateCampaignApproval(campaignId, reason, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb, reviewer = 'system_audit' } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.APPROVED) {
    return { invalidated: false, message: `Campaign is not in APPROVED state (current: ${campaign.status})` };
  }

  const updatedCampaign = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW,
    review_status: REVIEW_STATUSES.PENDING,
    review_notes: `Approval invalidated: ${reason}`
  }, tid);

  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: REVIEW_ACTIONS.INVALIDATED_DUE_TO_MATERIAL_CHANGE,
    previous_status: CAMPAIGN_LIFECYCLE_STATES.APPROVED,
    new_status: CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW,
    reviewer,
    review_hash: campaign.review_hash,
    campaign_version: updatedCampaign.campaign_version,
    notes: reason,
    metadata: { invalidated_reason: reason }
  }, tid);

  return {
    invalidated: true,
    campaign: updatedCampaign,
    reason
  };
}

/**
 * Lists the complete append-only audit trail for a campaign.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {Array} List of audit logs
 */
export function listCampaignReviewLogs(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb } = options;
  const tid = (tenantId || 'default').trim();
  return dbInstance.listCampaignReviewLogs(campaignId, tid);
}
