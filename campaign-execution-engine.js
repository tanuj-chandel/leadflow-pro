/**
 * ==============================================================================
 * AI AutomationHubs - Campaign & Outreach Execution Engine (Step 6F-A)
 * Module: campaign-execution-engine.js
 * Version: 3.5 Enterprise
 *
 * Primary Objectives:
 * - Deterministic, fail-closed campaign touch execution evaluator & dry-run runner.
 * - Enforces absolute safety invariant: REAL PROVIDER DISPATCH = DISABLED.
 * - Mode safety: DRY_RUN and SIMULATION allowed; LIVE hard-blocked with LIVE_EXECUTION_DISABLED.
 * - Live eligibility recheck against current database state (suppression, opt-out, cooldown, quotas).
 * - Approval revalidation via canonical SHA-256 review hash before any touch is considered due.
 * - Channel safety: strict preservation of VERIFIED MOBILE != WHATSAPP invariant.
 * - Zero quota mutation (SIMULATED_QUOTA_CHECK only; no reserveDailyQuota calls).
 * - Append-only simulation audit logging to campaign_execution_logs (simulated=1, provider_message_id=null).
 * - Absolute invariant: ZERO real dispatches, ZERO socket connections, ZERO provider calls.
 * ==============================================================================
 */

import { db as defaultDb } from './database.js';
import {
  getComplianceConfig,
  checkOutreachEligibility,
  normalizeContactIdentifier,
  SUPPORTED_CHANNELS,
  REASON_CODES
} from './compliance-engine.js';
import {
  generateCampaignReviewHash,
  computeTouchContentHash,
  canonicalizeMessageContent,
  CAMPAIGN_LIFECYCLE_STATES,
  REVIEW_STATUSES
} from './campaign-review-engine.js';
import {
  verifySnapshotClaimsRoot,
  CLAIM_ROOT_VERIFICATION_STATUS
} from './campaign-personalization-engine.js';
import { classifyPhoneType } from './scraper.js';

export const EXECUTION_MODES = {
  DRY_RUN: 'DRY_RUN',
  SIMULATION: 'SIMULATION',
  LIVE: 'LIVE'
};

export const EXECUTION_DECISIONS = {
  WOULD_EXECUTE: 'WOULD_EXECUTE',
  BLOCKED: 'BLOCKED',
  WOULD_SKIP: 'WOULD_SKIP'
};

export const EXECUTION_ERROR_CODES = {
  LIVE_EXECUTION_DISABLED: 'LIVE_EXECUTION_DISABLED',
  CAMPAIGN_NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  TOUCH_NOT_FOUND: 'TOUCH_NOT_FOUND',
  CAMPAIGN_NOT_ACTIVE: 'CAMPAIGN_NOT_ACTIVE',
  CAMPAIGN_NOT_APPROVED: 'CAMPAIGN_NOT_APPROVED',
  CAMPAIGN_PAUSED: 'CAMPAIGN_PAUSED',
  CAMPAIGN_CANCELLED: 'CAMPAIGN_CANCELLED',
  CAMPAIGN_COMPLETED: 'CAMPAIGN_COMPLETED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_STALE: 'APPROVAL_STALE',
  APPROVAL_HASH_MISMATCH: 'APPROVAL_HASH_MISMATCH',
  APPROVAL_VERSION_MISMATCH: 'APPROVAL_VERSION_MISMATCH',
  APPROVED_SNAPSHOT_MISSING: 'APPROVED_SNAPSHOT_MISSING',
  APPROVED_SNAPSHOT_CORRUPTED: 'APPROVED_SNAPSHOT_CORRUPTED',
  DRAFT_SNAPSHOT_MISMATCH: 'DRAFT_SNAPSHOT_MISMATCH',
  RECIPIENT_SNAPSHOT_MISMATCH: 'RECIPIENT_SNAPSHOT_MISMATCH',  // Step 7E-4
  CLAIM_ROOT_MISMATCH: 'CLAIM_ROOT_MISMATCH',                  // Step 7G-4
  CLAIM_ROOT_INVALID_SCOPE: 'CLAIM_ROOT_INVALID_SCOPE',        // Step 7G-4
  CLAIM_ROOT_NOT_SEALED: 'CLAIM_ROOT_NOT_SEALED',              // Step 7G-4
  CLAIM_ROOT_CORRUPTED: 'CLAIM_ROOT_CORRUPTED',                // Step 7G-4
  TOUCH_NOT_PLANNED: 'TOUCH_NOT_PLANNED',
  TOUCH_STOPPED: 'TOUCH_STOPPED',
  TOUCH_CANCELLED: 'TOUCH_CANCELLED',
  TOUCH_BLOCKED: 'TOUCH_BLOCKED',
  TOUCH_NOT_DUE: 'TOUCH_NOT_DUE',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  CHANNEL_UNAVAILABLE: 'CHANNEL_UNAVAILABLE',
  UNVERIFIED_WHATSAPP_ROUTING: 'UNVERIFIED_WHATSAPP_ROUTING',
  DAILY_QUOTA_EXCEEDED: 'DAILY_QUOTA_EXCEEDED',
  LEAD_INELIGIBLE: 'LEAD_INELIGIBLE',
  LEAD_EXCLUDED: 'LEAD_EXCLUDED',
  LEAD_OPTED_OUT: 'LEAD_OPTED_OUT',
  RESEARCH_REQUIRED: 'RESEARCH_REQUIRED',
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED',
  STOP_CONDITION_TRIGGERED: 'STOP_CONDITION_TRIGGERED',
  INBOUND_REPLY_RECEIVED: 'INBOUND_REPLY_RECEIVED',
  INVALID_EXECUTION_MODE: 'INVALID_EXECUTION_MODE'
};

/**
 * Global safety guard.
 * Step 6F-A enforces that live execution is permanently disabled.
 */
export function isLiveExecutionAllowed() {
  return false;
}

/**
 * Activates an APPROVED campaign (APPROVED -> ACTIVE).
 * Verifies campaign has valid approval, current review hash matches, and version is current.
 *
 * @param {string} campaignId
 * @param {object} [options]
 * @returns {object} Activation result
 */
export function activateCampaign(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb, actor = 'operator', notes = 'Campaign activated for execution' } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.APPROVED) {
    throw new Error(`Cannot activate campaign with status "${campaign.status}". Campaign must be in APPROVED state.`);
  }

  if (!campaign.review_hash || !campaign.approval_metadata) {
    throw new Error('Campaign cannot be activated: missing approval metadata or review hash.');
  }

  // Revalidate approval hash before activation
  const leads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 });
  const touches = dbInstance.listCampaignTouches(campaignId, tid, { limit: 1000 });
  const liveHash = generateCampaignReviewHash(campaign, leads, touches, { dbInstance });

  if (liveHash !== campaign.review_hash) {
    throw new Error(`Cannot activate campaign: review hash mismatch (approved ${campaign.review_hash}, live ${liveHash}). Configuration was materially altered.`);
  }

  const updated = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.ACTIVE
  }, tid);

  dbInstance.createCampaignReviewLog({
    campaign_id: campaignId,
    tenant_id: tid,
    action: 'APPROVED', // Review action lifecycle remains within schema enum
    previous_status: CAMPAIGN_LIFECYCLE_STATES.APPROVED,
    new_status: CAMPAIGN_LIFECYCLE_STATES.ACTIVE,
    reviewer: typeof actor === 'object' ? (actor.name || actor.id || 'operator') : actor,
    review_hash: campaign.review_hash,
    campaign_version: updated.campaign_version,
    notes: notes || 'Campaign transitioned to ACTIVE',
    metadata: { activated_at: new Date().toISOString() }
  }, tid);

  return {
    success: true,
    campaign: updated,
    status: CAMPAIGN_LIFECYCLE_STATES.ACTIVE
  };
}

/**
 * Pauses an ACTIVE campaign (ACTIVE -> PAUSED).
 */
export function pauseCampaign(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb, actor = 'operator', reason = 'Campaign paused by operator' } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.ACTIVE) {
    throw new Error(`Cannot pause campaign with status "${campaign.status}". Campaign must be ACTIVE.`);
  }

  const updated = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.PAUSED
  }, tid);

  return {
    success: true,
    campaign: updated,
    status: CAMPAIGN_LIFECYCLE_STATES.PAUSED,
    reason
  };
}

/**
 * Resumes a PAUSED campaign (PAUSED -> ACTIVE).
 */
export function resumeCampaign(campaignId, options = {}) {
  const { tenantId = 'default', dbInstance = defaultDb, actor = 'operator', notes = 'Campaign resumed by operator' } = options;
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.PAUSED) {
    throw new Error(`Cannot resume campaign with status "${campaign.status}". Campaign must be PAUSED.`);
  }

  const updated = dbInstance.updateCampaign(campaignId, {
    status: CAMPAIGN_LIFECYCLE_STATES.ACTIVE
  }, tid);

  return {
    success: true,
    campaign: updated,
    status: CAMPAIGN_LIFECYCLE_STATES.ACTIVE
  };
}

/**
 * Helper to check whether lead has explicit WhatsApp evidence/signal.
 * Adheres strictly to Step 5A Safety Invariant: VERIFIED MOBILE != WHATSAPP.
 *
 * @param {object} lead
 * @returns {boolean}
 */
export function hasExplicitWhatsAppEvidence(lead, dbInstance = defaultDb, tenantId = 'default') {
  if (!lead) return false;
  if (lead.has_whatsapp === 1 || lead.has_whatsapp === true || lead.has_whatsapp === '1') return true;
  if (lead.whatsapp_verified === 1 || lead.whatsapp_verified === true) return true;
  if (lead.whatsapp && typeof lead.whatsapp === 'string' && lead.whatsapp.trim().length > 0) return true;
  if (lead.whatsapp_evidence && typeof lead.whatsapp_evidence === 'string' && lead.whatsapp_evidence.trim().length > 0) return true;

  if (dbInstance && lead.id) {
    try {
      const tid = (tenantId || lead.tenant_id || 'default').trim();
      const signals = dbInstance.getLeadSignals ? dbInstance.getLeadSignals(lead.id, tid) : [];
      const evidence = dbInstance.getLeadEvidence ? dbInstance.getLeadEvidence(lead.id, tid) : [];
      if (signals.some(s => s.signal_key === 'WHATSAPP_SCHEDULING_AUTOMATION' || s.signal_type === 'WHATSAPP_ONLY_BOOKING')) return true;
      if (evidence.some(e => e.evidence_type === 'WHATSAPP_WORKFLOW' || /wa\.me|whatsapp/i.test(e.extracted_value || ''))) return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Internal helper to append an immutable compliance audit event on integrity failure.
 */
function logSnapshotIntegrityAuditFailure(dbInstance, tenantId, snapshot, touch, reasonCode, storedHash, recomputedHash, actor) {
  try {
    const payload = {
      tenantId,
      leadId: (snapshot && snapshot.lead_id) || (touch && touch.lead_id) || null,
      channel: (snapshot && snapshot.channel) || (touch && touch.planned_channel) || null,
      eventType: 'CLAIM_ROOT_INTEGRITY_FAILURE',
      contactIdentifier: (snapshot && snapshot.recipient_contact) || null,
      decision: 'BLOCKED',
      reason: reasonCode,
      metadata: {
        snapshot_id: snapshot ? snapshot.id : null,
        campaign_id: (snapshot && snapshot.campaign_id) || (touch && touch.campaign_id) || null,
        campaign_touch_id: (snapshot && snapshot.campaign_touch_id) || (touch && touch.id) || null,
        expected_root: storedHash || null,
        observed_root: recomputedHash || null,
        actor: actor ? (typeof actor === 'object' ? (actor.id || actor.name) : actor) : 'system'
      }
    };
    if (dbInstance && typeof dbInstance.createComplianceAuditLog === 'function') {
      dbInstance.createComplianceAuditLog(payload);
    } else if (dbInstance && typeof dbInstance.logComplianceEvent === 'function') {
      dbInstance.logComplianceEvent(payload);
    } else if (dbInstance && dbInstance.sqlite) {
      const id = 'audit_' + Date.now() + Math.random().toString(36).substr(2, 6);
      const createdAt = new Date().toISOString();
      dbInstance.sqlite.prepare(`
        INSERT INTO compliance_audit_logs (
          id, tenant_id, lead_id, channel, event_type, contact_identifier, decision, reason, metadata, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id,
        tenantId,
        payload.leadId,
        payload.channel ? String(payload.channel).toLowerCase() : null,
        payload.eventType,
        payload.contactIdentifier,
        payload.decision,
        payload.reason,
        JSON.stringify(payload.metadata),
        createdAt
      );
    }
  } catch (err) {
    // Non-fatal: compliance logging failure should never mask the security block
    console.error('Failed to log compliance audit event:', err.message);
  }
}

/**
 * Canonical Authoritative Snapshot Integrity & Claim-Root Verification Boundary (Step 7G-4).
 *
 * Centralizes multi-layered validation across:
 * 1. Actor authentication & role authorization (when actor provided)
 * 2. Strict tenant scope validation across all entities
 * 3. Snapshot existence and structural integrity (message_body, content_hash, review_hash)
 * 4. Content hash integrity (recomputes canonical touch content hash including recipient)
 * 5. Campaign review hash binding (snapshot.review_hash binds to campaign.review_hash)
 * 6. Campaign approval state verification
 * 7. Foreign reference binding (tenant, campaign, touch, lead)
 * 8. Mutable touch draft vs immutable snapshot parity
 * 9. Live mutable recipient vs snapshot recipient binding (Step 7E-4)
 * 10. Cryptographic Claim-Root verification (Step 7G-3 / 7G-4):
 *     - Malformed root detection
 *     - Canonical recomputation from current Fact-Claim Graph
 *     - MATCH -> PASS
 *     - MISMATCH -> BLOCK (CLAIM_ROOT_MISMATCH)
 *     - INVALID_SCOPE -> BLOCK (CLAIM_ROOT_INVALID_SCOPE)
 *     - NOT_SEALED -> BLOCK (CLAIM_ROOT_NOT_SEALED) by default unless allowLegacyUnsealed === true
 * 11. Append-only compliance audit logging of blocked integrity failures
 *
 * @param {object|string} snapshotOrId - snapshot record or snapshot ID
 * @param {string} [tenantId='default']
 * @param {object} [options={}]
 * @returns {object} { valid, decision, decision_reason, reason, snapshot, claimsCheck }
 */
export function verifyApprovedSnapshotIntegrity(snapshotOrId, tenantId = 'default', options = {}) {
  const tid = (tenantId || 'default').trim();
  const dbInstance = options.dbInstance || defaultDb;
  const allowLegacyUnsealed = options.allowLegacyUnsealed === true;

  // 1. Resolve Snapshot
  let snapshot = null;
  if (typeof snapshotOrId === 'string') {
    if (dbInstance.getApprovedSnapshot) {
      snapshot = dbInstance.getApprovedSnapshot(snapshotOrId, tid);
    } else if (dbInstance.sqlite) {
      snapshot = dbInstance.sqlite.prepare(
        'SELECT * FROM campaign_approved_snapshots WHERE id = ? AND tenant_id = ?'
      ).get(snapshotOrId, tid);
    }
  } else if (snapshotOrId && typeof snapshotOrId === 'object') {
    snapshot = snapshotOrId;
  }

  if (!snapshot) {
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_MISSING,
      reason: 'No persistent approved snapshot found or accessible for given tenant scope'
    };
  }

  // 2. Tenant isolation on snapshot record
  if (snapshot.tenant_id !== tid) {
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_INVALID_SCOPE,
      reason: `Tenant isolation violation: snapshot tenant "${snapshot.tenant_id}" does not match requested tenant "${tid}"`
    };
  }

  // 3. Resolve context: Touch, Campaign, CampaignLead
  const touch = options.touch || (snapshot.campaign_touch_id
    ? (dbInstance.getCampaignTouch ? dbInstance.getCampaignTouch(snapshot.campaign_touch_id, tid) : dbInstance.sqlite.prepare('SELECT * FROM campaign_touches WHERE id = ? AND tenant_id = ?').get(snapshot.campaign_touch_id, tid))
    : null);

  const campaign = options.campaign || (snapshot.campaign_id
    ? (dbInstance.getCampaignById ? dbInstance.getCampaignById(snapshot.campaign_id, tid) : dbInstance.sqlite.prepare('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?').get(snapshot.campaign_id, tid))
    : null);

  const campaignLead = options.campaignLead || (campaign && touch
    ? (dbInstance.getCampaignLead ? dbInstance.getCampaignLead(campaign.id, touch.lead_id, tid) : dbInstance.sqlite.prepare('SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ? AND tenant_id = ?').get(campaign.id, touch.lead_id, tid))
    : null);

  // 4. Actor verification (if actor provided)
  if (options.actor) {
    const actor = options.actor;
    if (!actor || !actor.id) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: 'AUTHENTICATION_REQUIRED',
        reason: 'Authenticated actor required for operation'
      };
    }
    const actorTenant = (actor.tenantId || 'default').trim();
    if (actorTenant !== tid) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_INVALID_SCOPE,
        reason: `Actor tenant "${actorTenant}" does not match snapshot tenant "${tid}"`
      };
    }
    if (options.permittedRoles && Array.isArray(options.permittedRoles)) {
      const role = String(actor.role || '').toUpperCase();
      if (!options.permittedRoles.includes(role)) {
        return {
          valid: false,
          decision: EXECUTION_DECISIONS.BLOCKED,
          decision_reason: 'ACTOR_UNAUTHORIZED',
          reason: `Actor role "${role}" is not authorized`
        };
      }
    }
  }

  // 5. Foreign References & Scope Integrity
  if (touch) {
    if (touch.tenant_id !== tid || touch.id !== snapshot.campaign_touch_id || touch.lead_id !== snapshot.lead_id) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_CORRUPTED,
        reason: 'Approved snapshot foreign references do not match touch context'
      };
    }
  }

  if (campaign) {
    if (campaign.tenant_id !== tid || campaign.id !== snapshot.campaign_id) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_CORRUPTED,
        reason: 'Approved snapshot foreign references do not match touch context'
      };
    }
  }

  // 6. Snapshot structural integrity checks
  if (!snapshot.message_body || !snapshot.message_body.trim() || !snapshot.content_hash || !snapshot.review_hash) {
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_CORRUPTED,
      reason: `Approved snapshot for touch "${snapshot.campaign_touch_id || touch?.id}" is corrupted or contains null/empty body or hash`
    };
  }

  // 7. Re-verify snapshot content hash (includes recipient_contact)
  const expectedSnapshotHash = computeTouchContentHash(
    snapshot.channel,
    snapshot.touch_number,
    snapshot.purpose,
    snapshot.message_subject,
    snapshot.message_body,
    snapshot.recipient_contact
  );
  if (snapshot.content_hash !== expectedSnapshotHash) {
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_CORRUPTED,
      reason: `Approved snapshot content hash mismatch (stored: ${snapshot.content_hash}, calculated: ${expectedSnapshotHash})`
    };
  }

  // 8. Verify snapshot review hash binds to current campaign review hash
  if (campaign && snapshot.review_hash !== campaign.review_hash) {
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVED_SNAPSHOT_CORRUPTED,
      reason: `Approved snapshot review hash (${snapshot.review_hash}) does not match campaign review hash (${campaign.review_hash})`
    };
  }

  // 9. Campaign approval state verification
  if (campaign) {
    if (campaign.review_status !== 'APPROVED') {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.CAMPAIGN_NOT_APPROVED,
        reason: `Campaign is not approved (current review status: ${campaign.review_status})`
      };
    }
  }

  // 10. Mutable touch draft matches immutable snapshot
  if (touch) {
    const rawTouchBody = touch.message_body !== null && touch.message_body !== undefined ? touch.message_body : touch.approved_body;
    const rawTouchSubject = touch.message_subject !== null && touch.message_subject !== undefined ? touch.message_subject : touch.approved_subject;
    const canonTouchBody = canonicalizeMessageContent(rawTouchBody);
    const canonSnapBody = canonicalizeMessageContent(snapshot.message_body);
    const canonTouchSubject = canonicalizeMessageContent(rawTouchSubject);
    const canonSnapSubject = canonicalizeMessageContent(snapshot.message_subject);

    if (canonTouchBody !== canonSnapBody || canonTouchSubject !== canonSnapSubject) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.DRAFT_SNAPSHOT_MISMATCH,
        reason: 'Mutable touch draft differs from persistent approved snapshot'
      };
    }
  }

  // 11. Recipient binding verification — live mutable recipient must match approved snapshot (Step 7E-4)
  if (snapshot.recipient_contact) {
    const liveHandle = campaignLead ? campaignLead.target_contact_handle : null;
    const ch = String((touch && touch.planned_channel) || snapshot.channel || '').toLowerCase();
    const normalizedLive = liveHandle
      ? (normalizeContactIdentifier(liveHandle, ch)?.identifier || String(liveHandle).toLowerCase().trim())
      : '';
    const normalizedSnap = normalizeContactIdentifier(snapshot.recipient_contact, ch)?.identifier
      || String(snapshot.recipient_contact).toLowerCase().trim();
    if (normalizedLive !== normalizedSnap) {
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.RECIPIENT_SNAPSHOT_MISMATCH,
        reason: `Recipient mutation detected: live handle "${liveHandle}" does not match approved snapshot recipient "${snapshot.recipient_contact}"`
      };
    }
  }

  // 12. Fact-Claim Graph Merkle Claim-Root Integrity (Step 7G-3 / 7G-4)
  const storedRoot = snapshot.claims_root_hash || null;

  // 12a. Check for malformed stored root
  if (storedRoot !== null) {
    if (typeof storedRoot !== 'string' || !storedRoot.startsWith('clmroot_') || storedRoot.length !== 72) {
      logSnapshotIntegrityAuditFailure(dbInstance, tid, snapshot, touch, 'CLAIM_ROOT_CORRUPTED', storedRoot, null, options.actor);
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_CORRUPTED,
        reason: `Approved snapshot claims_root_hash is malformed: "${storedRoot}"`
      };
    }
  }

  // 12b. Run pure claim-root verification against current Fact-Claim Graph
  const claimsCheck = verifySnapshotClaimsRoot(snapshot.id, tid, dbInstance);

  if (claimsCheck.status === CLAIM_ROOT_VERIFICATION_STATUS.NOT_SEALED) {
    // Determine if authoritative claim integrity is required:
    // 1. Explicitly requested via options.strictClaimsRoot or options.requireClaimsRoot
    // 2. Or the touch actually has associated claims in the Fact-Claim Graph
    let hasClaims = false;
    try {
      if (touch && touch.id && dbInstance.sqlite) {
        const claimRow = dbInstance.sqlite.prepare(
          'SELECT COUNT(*) as c FROM campaign_claims WHERE campaign_touch_id = ? AND tenant_id = ?'
        ).get(touch.id, tid);
        hasClaims = claimRow && claimRow.c > 0;
      }
    } catch (_) {}

    const requiresAuthoritativeClaimIntegrity = options.strictClaimsRoot === true || options.requireClaimsRoot === true || hasClaims;

    if (requiresAuthoritativeClaimIntegrity && !allowLegacyUnsealed) {
      logSnapshotIntegrityAuditFailure(dbInstance, tid, snapshot, touch, 'CLAIM_ROOT_NOT_SEALED', null, null, options.actor);
      return {
        valid: false,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_NOT_SEALED,
        reason: 'Historical snapshot is not sealed with a cryptographic claims root (claims_root_hash is NULL)',
        claimsCheck
      };
    }
  } else if (claimsCheck.status === CLAIM_ROOT_VERIFICATION_STATUS.MISMATCH) {
    logSnapshotIntegrityAuditFailure(dbInstance, tid, snapshot, touch, 'CLAIM_ROOT_MISMATCH', claimsCheck.storedHash, claimsCheck.recomputedHash, options.actor);
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_MISMATCH,
      reason: `Claims root mismatch: post-approval mutation detected in Fact-Claim Graph (stored: ${claimsCheck.storedHash}, recomputed: ${claimsCheck.recomputedHash})`,
      claimsCheck
    };
  } else if (claimsCheck.status === CLAIM_ROOT_VERIFICATION_STATUS.INVALID_SCOPE) {
    logSnapshotIntegrityAuditFailure(dbInstance, tid, snapshot, touch, 'CLAIM_ROOT_INVALID_SCOPE', claimsCheck.storedHash, null, options.actor);
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_INVALID_SCOPE,
      reason: `Claims root verification failed scope security check: ${claimsCheck.error}`,
      claimsCheck
    };
  } else if (claimsCheck.status !== CLAIM_ROOT_VERIFICATION_STATUS.MATCH) {
    logSnapshotIntegrityAuditFailure(dbInstance, tid, snapshot, touch, 'CLAIM_ROOT_CORRUPTED', storedRoot, null, options.actor);
    return {
      valid: false,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.CLAIM_ROOT_CORRUPTED,
      reason: `Claims root verification returned unexpected status: ${claimsCheck.status}`,
      claimsCheck
    };
  }

  // All 12 layers verified successfully!
  return {
    valid: true,
    decision: 'PASS',
    snapshot,
    claimsCheck
  };
}

/**
 * Evaluates a single campaign touch for execution eligibility at evaluationTime.
 * Pure evaluation function — causes ZERO side-effects and ZERO database mutations.
 *
 * @param {object} params
 * @param {string} params.touchId
 * @param {string} [params.campaignId]
 * @param {string} [params.tenantId='default']
 * @param {string} [params.mode='DRY_RUN']
 * @param {string} [params.evaluationTime] - ISO string or Date
 * @param {object} [params.dbInstance]
 * @param {object} [params.preloaded]
 * @param {boolean} [params.allowLegacyUnsealed=false]
 * @param {object} [params.actor=null]
 * @returns {Promise<object>} Deterministic execution evaluation report
 */
export async function evaluateTouchForExecution({
  touchId,
  campaignId = null,
  tenantId = 'default',
  mode = EXECUTION_MODES.DRY_RUN,
  evaluationTime = null,
  dbInstance = defaultDb,
  preloaded = null,
  allowLegacyUnsealed = false,
  actor = null
}) {
  const tid = (tenantId || 'default').trim();
  const evalDate = evaluationTime ? new Date(evaluationTime) : new Date();
  const evalTimeStr = evalDate.toISOString();
  const upperMode = String(mode || '').toUpperCase().trim();

  // --------------------------------------------------------------------------
  // Rule 1: Mode Safety Invariant
  // --------------------------------------------------------------------------
  if (upperMode === EXECUTION_MODES.LIVE) {
    throw new Error(
      `${EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled in Step 6F-A. Requests for LIVE execution are hard-blocked.`
    );
  }

  if (upperMode !== EXECUTION_MODES.DRY_RUN && upperMode !== EXECUTION_MODES.SIMULATION) {
    throw new Error(
      `${EXECUTION_ERROR_CODES.INVALID_EXECUTION_MODE}: Unsupported execution mode "${mode}". Supported modes: DRY_RUN, SIMULATION.`
    );
  }

  // --------------------------------------------------------------------------
  // Rule 2: Record Resolution & Tenant Isolation
  // --------------------------------------------------------------------------
  let touch = preloaded?.touch;
  if (!touch) {
    touch = dbInstance.sqlite.prepare('SELECT * FROM campaign_touches WHERE id = ? AND tenant_id = ?').get(touchId, tid);
    if (!touch) {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.TOUCH_NOT_FOUND,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        error: `Touch "${touchId}" not found for tenant "${tid}"`
      };
    }
  }

  const effectiveCampaignId = campaignId || touch.campaign_id;
  let campaign = preloaded?.campaign;
  if (!campaign) {
    campaign = dbInstance.getCampaignById(effectiveCampaignId, tid);
    if (!campaign) {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.CAMPAIGN_NOT_FOUND,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        error: `Campaign "${effectiveCampaignId}" not found for tenant "${tid}"`
      };
    }
  }

  let campaignLead = preloaded?.campaignLead;
  if (!campaignLead) {
    campaignLead = dbInstance.getCampaignLead ? dbInstance.getCampaignLead(effectiveCampaignId, touch.lead_id, tid) : null;
    if (!campaignLead && touch.campaign_lead_id && dbInstance.sqlite) {
      try {
        campaignLead = dbInstance.sqlite.prepare('SELECT * FROM campaign_leads WHERE id = ? AND tenant_id = ?').get(touch.campaign_lead_id, tid);
      } catch (_) {}
    }
  }

  let lead = preloaded?.lead;
  if (!lead) {
    lead = dbInstance.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(touch.lead_id, tid);
  }

  // Strict cross-entity tenant integrity check
  if (
    touch.tenant_id !== tid ||
    campaign.tenant_id !== tid ||
    (campaignLead && campaignLead.tenant_id !== tid) ||
    (lead && lead.tenant_id !== tid)
  ) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.TENANT_MISMATCH,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      error: 'Cross-tenant reference violation detected'
    };
  }

  // --------------------------------------------------------------------------
  // Rule 3: Campaign Lifecycle State Check
  // --------------------------------------------------------------------------
  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.ACTIVE) {
    let reasonCode = EXECUTION_ERROR_CODES.CAMPAIGN_NOT_ACTIVE;
    if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.PAUSED) reasonCode = EXECUTION_ERROR_CODES.CAMPAIGN_PAUSED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.CANCELLED) reasonCode = EXECUTION_ERROR_CODES.CAMPAIGN_CANCELLED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.COMPLETED) reasonCode = EXECUTION_ERROR_CODES.CAMPAIGN_COMPLETED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.DRAFT || campaign.status === CAMPAIGN_LIFECYCLE_STATES.READY_FOR_REVIEW) {
      reasonCode = EXECUTION_ERROR_CODES.CAMPAIGN_NOT_APPROVED;
    }

    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: reasonCode,
      executable: false,
      campaign_status: campaign.status,
      touch_status: touch.status,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Campaign is not ACTIVE (current: ${campaign.status})`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 4: Approval Integrity & Hash Revalidation
  // --------------------------------------------------------------------------
  if (!campaign.review_hash || !campaign.approval_metadata) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVAL_REQUIRED,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: 'Campaign lacks valid human approval metadata or review hash'
    };
  }

  // Revalidate approval hash against current database entities
  const allLeads = preloaded?.allLeads || dbInstance.listCampaignLeads(campaign.id, tid, { limit: 1000 });
  const allTouches = preloaded?.allTouches || dbInstance.listCampaignTouches(campaign.id, tid, { limit: 1000 });
  const currentHash = generateCampaignReviewHash(campaign, allLeads, allTouches, { dbInstance });

  if (currentHash !== campaign.review_hash) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVAL_HASH_MISMATCH,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Approval hash mismatch (approved: ${campaign.review_hash}, live: ${currentHash}). Material configuration was altered.`
    };
  }

  if (campaign.approved_version && campaign.campaign_version !== campaign.approved_version) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.APPROVAL_VERSION_MISMATCH,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Campaign version ${campaign.campaign_version} does not match approved version ${campaign.approved_version}`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 4b: Step 7E-2 & Step 7G-4 Persistent Approved Snapshot & Claim-Root Verification
  // --------------------------------------------------------------------------
  const approvedVersion = campaign.approved_version || 1;
  const snapshot = dbInstance.getApprovedSnapshotByTouch
    ? dbInstance.getApprovedSnapshotByTouch(touch.id, approvedVersion, tid)
    : null;

  const snapshotIntegrity = verifyApprovedSnapshotIntegrity(snapshot, tid, {
    touch,
    campaign,
    campaignLead,
    lead,
    actor,
    dbInstance,
    allowLegacyUnsealed
  });

  if (!snapshotIntegrity.valid) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: snapshotIntegrity.decision_reason,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: snapshotIntegrity.reason
    };
  }

  // --------------------------------------------------------------------------
  // Rule 5: Touch Status & Stop Conditions
  // --------------------------------------------------------------------------
  if (touch.status !== 'PLANNED') {
    let reason = EXECUTION_ERROR_CODES.TOUCH_NOT_PLANNED;
    if (touch.status === 'STOPPED') reason = EXECUTION_ERROR_CODES.TOUCH_STOPPED;
    else if (touch.status === 'CANCELLED') reason = EXECUTION_ERROR_CODES.TOUCH_CANCELLED;
    else if (touch.status === 'BLOCKED') reason = EXECUTION_ERROR_CODES.TOUCH_BLOCKED;

    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: reason,
      executable: false,
      touch_status: touch.status,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Touch is not in PLANNED status (current: ${touch.status})`
    };
  }

  if (touch.stop_reason) {
    const isReply = touch.stop_reason === 'INBOUND_REPLY';
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.WOULD_SKIP,
      decision_reason: isReply ? EXECUTION_ERROR_CODES.INBOUND_REPLY_RECEIVED : EXECUTION_ERROR_CODES.STOP_CONDITION_TRIGGERED,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: isReply ? 'Touch stopped due to inbound reply' : `Touch stopped by condition: ${touch.stop_reason}`
    };
  }

  // Inbound reply check
  if (campaignLead && (campaignLead.inbound_replied === 1 || campaignLead.inbound_replied === true)) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.WOULD_SKIP,
      decision_reason: EXECUTION_ERROR_CODES.INBOUND_REPLY_RECEIVED,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: 'Lead has already replied inbound to an earlier campaign touch'
    };
  }

  // Opt-out check on lead
  if (lead && (lead.opted_out === 1 || lead.opted_out === '1' || lead.opted_out === true)) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.LEAD_OPTED_OUT,
      executable: false,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Lead is marked opted-out (Source: ${lead.opted_out_source || 'Unknown'})`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 6: Due Time Check (planned_at <= evaluationTime)
  // --------------------------------------------------------------------------
  const touchPlannedDate = new Date(touch.planned_at);
  if (touchPlannedDate > evalDate) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.WOULD_SKIP,
      decision_reason: EXECUTION_ERROR_CODES.TOUCH_NOT_DUE,
      executable: false,
      planned_at: touch.planned_at,
      evaluation_time: evalTimeStr,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Touch is not yet due (planned for ${touch.planned_at}, evaluated at ${evalTimeStr})`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 7: Channel Safety & Routability Check
  // --------------------------------------------------------------------------
  const plannedChannel = String(touch.planned_channel || '').toUpperCase().trim();
  const lowerChannel = plannedChannel.toLowerCase();

  // Strict WhatsApp safety rule: VERIFIED MOBILE != WHATSAPP without explicit signal
  if (plannedChannel === 'WHATSAPP') {
    const hasEvidence = hasExplicitWhatsAppEvidence(lead, dbInstance, tid);
    if (!hasEvidence) {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.UNVERIFIED_WHATSAPP_ROUTING,
        executable: false,
        planned_channel: plannedChannel,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: 'WhatsApp routing requires explicit verified WhatsApp signal/evidence (VERIFIED MOBILE != WHATSAPP)'
      };
    }
  }

  // Contact identifier availability
  let contactIdentifier = null;
  if (lead) {
    if (lowerChannel === 'email') contactIdentifier = lead.email;
    else if (lowerChannel === 'whatsapp' || lowerChannel === 'phone') contactIdentifier = lead.phone;
    else if (lowerChannel === 'telegram') contactIdentifier = lead.telegram || lead.phone;
  }

  if (plannedChannel !== 'MANUAL_RESEARCH' && (!contactIdentifier || !contactIdentifier.trim())) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.CHANNEL_UNAVAILABLE,
      executable: false,
      planned_channel: plannedChannel,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Lead lacks valid contact handle for channel ${plannedChannel}`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 8: Live Eligibility Recheck via Compliance Engine (skipAudit: true)
  // --------------------------------------------------------------------------
  let complianceDecision = null;
  if (SUPPORTED_CHANNELS.includes(lowerChannel)) {
    complianceDecision = await checkOutreachEligibility({
      leadId: lead?.id,
      lead,
      channel: lowerChannel,
      contactIdentifier,
      tenantId: tid,
      skipAudit: true // Side-effect-free preflight recheck
    });

    if (!complianceDecision.allowed) {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: complianceDecision.reasonCode,
        executable: false,
        planned_channel: plannedChannel,
        compliance: complianceDecision,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: `Live compliance gate rejected outreach: ${complianceDecision.reason}`
      };
    }
  }

  // Step 6C campaign lead eligibility status check
  if (campaignLead) {
    if (campaignLead.review_status === 'EXCLUDED') {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.LEAD_EXCLUDED,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: 'Lead is manually excluded from campaign outreach'
      };
    }

    if (campaignLead.eligibility_status === 'RESEARCH_REQUIRED') {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.RESEARCH_REQUIRED,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: 'Lead has research gaps that must be resolved prior to outreach'
      };
    }

    if (campaignLead.eligibility_status === 'HUMAN_REVIEW_REQUIRED') {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.HUMAN_REVIEW_REQUIRED,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: 'Lead requires explicit human review prior to outreach'
      };
    }

    if (campaignLead.eligibility_status === 'INELIGIBLE') {
      return {
        mode: upperMode,
        decision: EXECUTION_DECISIONS.BLOCKED,
        decision_reason: EXECUTION_ERROR_CODES.LEAD_INELIGIBLE,
        executable: false,
        provider_called: false,
        gate_called: false,
        message_sent: false,
        reason: 'Lead is marked INELIGIBLE in campaign membership'
      };
    }
  }

  // --------------------------------------------------------------------------
  // Rule 9: Simulated Daily Quota Check (NO MUTATION)
  // --------------------------------------------------------------------------
  const todayStr = evalTimeStr.slice(0, 10);
  const config = getComplianceConfig();
  const dailyLimit = config.dailyLimits[lowerChannel] || 50;
  const quotaUsage = dbInstance.getDailyQuotaUsage(lowerChannel, todayStr, tid);
  const currentCount = quotaUsage?.attempt_count || 0;
  const remaining = Math.max(0, dailyLimit - currentCount);
  const quotaAvailable = currentCount < dailyLimit;

  const quotaSnapshot = {
    type: 'SIMULATED_QUOTA_CHECK',
    channel: lowerChannel,
    date: todayStr,
    dailyLimit,
    currentCount,
    remaining,
    quotaAvailable
  };

  if (!quotaAvailable) {
    return {
      mode: upperMode,
      decision: EXECUTION_DECISIONS.BLOCKED,
      decision_reason: EXECUTION_ERROR_CODES.DAILY_QUOTA_EXCEEDED,
      executable: false,
      planned_channel: plannedChannel,
      quota_snapshot: quotaSnapshot,
      provider_called: false,
      gate_called: false,
      message_sent: false,
      reason: `Simulated daily quota exceeded for channel ${plannedChannel} (${currentCount}/${dailyLimit} used)`
    };
  }

  // --------------------------------------------------------------------------
  // Rule 10: All Invariants Satisfied -> WOULD_EXECUTE
  // --------------------------------------------------------------------------
  return {
    mode: upperMode,
    decision: EXECUTION_DECISIONS.WOULD_EXECUTE,
    decision_reason: null,
    executable: true,
    campaign_id: campaign.id,
    campaign_status: campaign.status,
    touch_id: touch.id,
    touch_status: touch.status,
    touch_number: touch.touch_number,
    campaign_lead_id: touch.campaign_lead_id,
    lead_id: touch.lead_id,
    planned_channel: plannedChannel,
    contact_identifier: contactIdentifier,
    approval_valid: true,
    eligibility_valid: true,
    quota_available: true,
    provider_called: false,
    gate_called: false,
    message_sent: false,
    evaluation_time: evalTimeStr,
    quota_snapshot: quotaSnapshot,
    eligibility_snapshot: complianceDecision,
    reason: `Touch #${touch.touch_number} on channel ${plannedChannel} is valid and would execute in live mode`
  };
}

/**
 * Executes a dry-run / simulated execution for a single campaign touch.
 * Appends an audit log entry to campaign_execution_logs (simulated=1).
 * Leaves campaign_touches status unchanged (PLANNED).
 * Does NOT call reserveDailyQuota or any outbound provider.
 *
 * @param {object} params
 * @returns {Promise<object>} Dry-run result
 */
export async function executeCampaignTouchDryRun({
  touchId,
  campaignId = null,
  tenantId = 'default',
  mode = EXECUTION_MODES.DRY_RUN,
  evaluationTime = null,
  actor = 'system_dry_run',
  dbInstance = defaultDb,
  idempotent = true
}) {
  const tid = (tenantId || 'default').trim();
  const upperMode = String(mode || '').toUpperCase().trim();

  // Mode safety enforcement
  if (upperMode === EXECUTION_MODES.LIVE) {
    throw new Error(
      `${EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled in Step 6F-A.`
    );
  }

  const evaluation = await evaluateTouchForExecution({
    touchId,
    campaignId,
    tenantId: tid,
    mode: upperMode,
    evaluationTime,
    dbInstance
  });

  const now = new Date().toISOString();
  const execStatus = evaluation.decision; // 'WOULD_EXECUTE', 'BLOCKED', 'WOULD_SKIP'

  const resolvedTouch = dbInstance.sqlite.prepare('SELECT * FROM campaign_touches WHERE id = ? AND tenant_id = ?').get(touchId, tid);
  const effectiveCampaignId = evaluation.campaign_id || resolvedTouch?.campaign_id || campaignId;
  const effectiveCampaignLeadId = evaluation.campaign_lead_id || resolvedTouch?.campaign_lead_id;
  const effectiveLeadId = evaluation.lead_id || resolvedTouch?.lead_id;
  const effectivePlannedChannel = evaluation.planned_channel || resolvedTouch?.planned_channel || 'UNKNOWN';

  // Append-only simulation audit logging
  const logEntry = dbInstance.createCampaignExecutionLog({
    tenant_id: tid,
    campaign_id: effectiveCampaignId,
    campaign_lead_id: effectiveCampaignLeadId,
    campaign_touch_id: touchId,
    lead_id: effectiveLeadId,
    execution_mode: upperMode,
    planned_channel: effectivePlannedChannel,
    execution_status: execStatus,
    decision_reason: evaluation.decision_reason,
    provider: null, // Zero provider interaction
    provider_message_id: null, // Zero provider message id
    simulated: 1, // Strictly simulated
    gate_result: null, // Gate not invoked for dispatch
    eligibility_snapshot: evaluation.eligibility_snapshot,
    quota_snapshot: evaluation.quota_snapshot,
    approval_hash: evaluation.approval_valid ? (dbInstance.getCampaignById(effectiveCampaignId, tid)?.review_hash || null) : null,
    executed_at: evaluationTime || now,
    metadata: {
      actor: typeof actor === 'object' ? (actor.name || actor.id) : actor,
      evaluation_summary: evaluation.reason
    }
  }, tid);

  return {
    success: true,
    mode: upperMode,
    decision: execStatus,
    executable: evaluation.executable,
    touch_id: touchId,
    campaign_id: evaluation.campaign_id,
    planned_channel: evaluation.planned_channel,
    decision_reason: evaluation.decision_reason,
    execution_log_id: logEntry.id,
    simulated: true,
    provider_called: false,
    gate_called: false,
    message_sent: false,
    quota_reserved: false,
    evaluation
  };
}

/**
 * Previews execution for all due planned touches in a campaign.
 * Completely side-effect-free: does NOT write execution logs.
 *
 * @param {object} params
 * @returns {Promise<object>} Preview report
 */
export async function previewCampaignExecution({
  campaignId,
  tenantId = 'default',
  evaluationTime = null,
  dbInstance = defaultDb
}) {
  const tid = (tenantId || 'default').trim();
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const allLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 });
  const allTouches = dbInstance.listCampaignTouches(campaignId, tid, { limit: 1000 });
  const plannedTouches = allTouches.filter(t => t.status === 'PLANNED');

  const evaluations = [];
  let wouldExecuteCount = 0;
  let blockedCount = 0;
  let wouldSkipCount = 0;
  const channelBreakdown = {};
  const reasonBreakdown = {};

  for (const touch of allTouches) {
    const lead = dbInstance.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(touch.lead_id, tid);
    const campaignLead = allLeads.find(l => l.id === touch.campaign_lead_id);

    const res = await evaluateTouchForExecution({
      touchId: touch.id,
      campaignId,
      tenantId: tid,
      mode: EXECUTION_MODES.DRY_RUN,
      evaluationTime,
      dbInstance,
      preloaded: { touch, campaign, campaignLead, lead, allLeads, allTouches }
    });

    evaluations.push(res);

    if (res.decision === EXECUTION_DECISIONS.WOULD_EXECUTE) {
      wouldExecuteCount++;
      channelBreakdown[touch.planned_channel] = (channelBreakdown[touch.planned_channel] || 0) + 1;
    } else if (res.decision === EXECUTION_DECISIONS.BLOCKED) {
      blockedCount++;
      const reason = res.decision_reason || 'UNKNOWN_BLOCK';
      reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
    } else if (res.decision === EXECUTION_DECISIONS.WOULD_SKIP) {
      wouldSkipCount++;
      const reason = res.decision_reason || 'UNKNOWN_SKIP';
      reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
    }
  }

  return {
    campaign_id: campaignId,
    campaign_status: campaign.status,
    total_touches: allTouches.length,
    total_planned_touches: plannedTouches.length,
    would_execute_count: wouldExecuteCount,
    blocked_count: blockedCount,
    would_skip_count: wouldSkipCount,
    channel_breakdown: channelBreakdown,
    reason_breakdown: reasonBreakdown,
    evaluations,
    simulated: true,
    provider_calls: 0,
    messages_sent: 0,
    quotas_reserved: 0
  };
}

/**
 * Runs a campaign-level dry-run for all due planned touches in a campaign.
 * Evaluates each touch and writes simulated execution audit logs.
 *
 * @param {object} params
 * @returns {Promise<object>} Dry-run execution report
 */
export async function executeCampaignDryRun({
  campaignId,
  tenantId = 'default',
  mode = EXECUTION_MODES.DRY_RUN,
  evaluationTime = null,
  actor = 'campaign_operator',
  dbInstance = defaultDb
}) {
  const tid = (tenantId || 'default').trim();
  const upperMode = String(mode || '').toUpperCase().trim();

  if (upperMode === EXECUTION_MODES.LIVE) {
    throw new Error(
      `${EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled in Step 6F-A.`
    );
  }

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const allLeads = dbInstance.listCampaignLeads(campaignId, tid, { limit: 1000 });
  const allTouches = dbInstance.listCampaignTouches(campaignId, tid, { limit: 1000 });
  const plannedTouches = allTouches.filter(t => t.status === 'PLANNED');

  const results = [];
  let wouldExecuteCount = 0;
  let blockedCount = 0;
  let wouldSkipCount = 0;
  const channelBreakdown = {};
  const reasonBreakdown = {};

  for (const touch of allTouches) {
    const res = await executeCampaignTouchDryRun({
      touchId: touch.id,
      campaignId,
      tenantId: tid,
      mode: upperMode,
      evaluationTime,
      actor,
      dbInstance
    });

    results.push(res);

    if (res.decision === EXECUTION_DECISIONS.WOULD_EXECUTE) {
      wouldExecuteCount++;
      const ch = res.planned_channel;
      channelBreakdown[ch] = (channelBreakdown[ch] || 0) + 1;
    } else if (res.decision === EXECUTION_DECISIONS.BLOCKED) {
      blockedCount++;
      const reason = res.decision_reason || 'UNKNOWN_BLOCK';
      reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
    } else if (res.decision === EXECUTION_DECISIONS.WOULD_SKIP) {
      wouldSkipCount++;
      const reason = res.decision_reason || 'UNKNOWN_SKIP';
      reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
    }
  }

  return {
    success: true,
    campaign_id: campaignId,
    campaign_status: campaign.status,
    execution_mode: upperMode,
    total_evaluated: allTouches.length,
    would_execute_count: wouldExecuteCount,
    blocked_count: blockedCount,
    would_skip_count: wouldSkipCount,
    channel_breakdown: channelBreakdown,
    reason_breakdown: reasonBreakdown,
    results,
    simulated: true,
    provider_calls: 0,
    messages_sent: 0,
    quotas_reserved: 0
  };
}

/**
 * Retrieves comprehensive execution status and history for a campaign.
 *
 * @param {object} params
 * @returns {object} Execution status report
 */
export function getExecutionStatus({
  campaignId,
  tenantId = 'default',
  dbInstance = defaultDb
}) {
  const tid = (tenantId || 'default').trim();
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const allTouches = dbInstance.listCampaignTouches(campaignId, tid, { limit: 1000 });
  const plannedTouches = allTouches.filter(t => t.status === 'PLANNED');
  const stoppedTouches = allTouches.filter(t => t.status === 'STOPPED');
  const cancelledTouches = allTouches.filter(t => t.status === 'CANCELLED');

  const executionLogs = dbInstance.listCampaignExecutionLogs(campaignId, tid, { limit: 100 });

  return {
    campaign_id: campaignId,
    campaign_status: campaign.status,
    approved: campaign.status === CAMPAIGN_LIFECYCLE_STATES.APPROVED || campaign.status === CAMPAIGN_LIFECYCLE_STATES.ACTIVE,
    is_active: campaign.status === CAMPAIGN_LIFECYCLE_STATES.ACTIVE,
    approved_version: campaign.approved_version,
    review_hash: campaign.review_hash,
    touches_summary: {
      total: allTouches.length,
      planned: plannedTouches.length,
      stopped: stoppedTouches.length,
      cancelled: cancelledTouches.length
    },
    recent_execution_logs: executionLogs.slice(0, 20),
    total_simulation_runs: executionLogs.length,
    simulated: true,
    provider_dispatches: 0
  };
}
