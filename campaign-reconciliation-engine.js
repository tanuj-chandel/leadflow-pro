/**
 * ==============================================================================
 * AI AutomationHubs - Manual Reconciliation & Governed Recovery (Step 6F-B.2B)
 * Module: campaign-reconciliation-engine.js
 * Version: 3.5 Enterprise
 *
 * Primary Objectives:
 * - Governed manual human reconciliation for PROVIDER_UNCERTAIN touches and stale DISPATCHING locks.
 * - Explicit reconciliation outcomes: VERIFIED_SENT, VERIFIED_NOT_SENT, REMAINS_UNCERTAIN.
 * - Server-side operator identity authentication and role-based authorization.
 * - Multi-condition strict revalidation before any state mutation:
 *   * Operator authentication & role validation (ADMIN, CAMPAIGN_MANAGER, COMPLIANCE_OFFICER, OPERATOR).
 *   * Strict tenant isolation (rejects cross-tenant campaigns, touches, attempts).
 *   * Campaign lifecycle & version verification (recomputes review hash; blocks stale approvals).
 *   * Touch state compatibility (only PROVIDER_UNCERTAIN or stale DISPATCHING eligible).
 *   * Stale lock safety: 5-minute lease threshold; stale locks NEVER auto-revert to PLANNED or SENT.
 *   * Strict evidence requirement for VERIFIED_SENT (rejects weak/unsupported notes or absent proof).
 *   * Atomic concurrency protection: conditional update & immutable reconciliation log.
 * - ZERO provider API calls, ZERO Phase 1 gate calls, ZERO quota consumption, ZERO background workers.
 * ==============================================================================
 */

import { db as defaultDb } from './database.js';
import {
  generateCampaignReviewHash,
  CAMPAIGN_LIFECYCLE_STATES
} from './campaign-review-engine.js';
import {
  STALE_LOCK_THRESHOLD_MS,
  LEASE_EVALUATION_STATES,
  evaluateTouchLeaseState
} from './campaign-live-dispatch-engine.js';

export const RECONCILIATION_DECISIONS = Object.freeze({
  VERIFIED_SENT: 'VERIFIED_SENT',
  VERIFIED_NOT_SENT: 'VERIFIED_NOT_SENT',
  REMAINS_UNCERTAIN: 'REMAINS_UNCERTAIN'
});

export const ALLOWED_RECONCILIATION_ROLES = Object.freeze([
  'ADMIN',
  'CAMPAIGN_MANAGER',
  'COMPLIANCE_OFFICER',
  'OPERATOR'
]);

export const ALLOWED_EVIDENCE_TYPES = Object.freeze([
  'PROVIDER_MESSAGE_ID',
  'PROVIDER_API_QUERY',
  'PROVIDER_CONSOLE_LOG',
  'WEBHOOK_RECEIPT',
  'INSPECTION_CONFIRMATION',
  'MANUAL_OPERATOR_VERIFICATION'
]);

// Derived from single authoritative STALE_LOCK_THRESHOLD_MS in campaign-live-dispatch-engine.js
export const STALE_LOCK_THRESHOLD_MINUTES = STALE_LOCK_THRESHOLD_MS / (60 * 1000);

export const RECONCILIATION_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  ACTOR_UNAUTHORIZED: 'ACTOR_UNAUTHORIZED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  CAMPAIGN_NOT_FOUND: 'CAMPAIGN_NOT_FOUND',
  CAMPAIGN_CANCELLED: 'CAMPAIGN_CANCELLED',
  CAMPAIGN_NOT_ACTIVE: 'CAMPAIGN_NOT_ACTIVE',
  APPROVAL_MISSING: 'APPROVAL_MISSING',
  STALE_REVIEW_HASH: 'STALE_REVIEW_HASH',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  TOUCH_NOT_FOUND: 'TOUCH_NOT_FOUND',
  TOUCH_CAMPAIGN_MISMATCH: 'TOUCH_CAMPAIGN_MISMATCH',
  TOUCH_LEAD_MISMATCH: 'TOUCH_LEAD_MISMATCH',
  INVALID_STATE_FOR_RECONCILIATION: 'INVALID_STATE_FOR_RECONCILIATION',
  TOUCH_DISPATCH_IN_FLIGHT: 'TOUCH_DISPATCH_IN_FLIGHT',
  ATTEMPT_NOT_FOUND: 'ATTEMPT_NOT_FOUND',
  ATTEMPT_TOUCH_MISMATCH: 'ATTEMPT_TOUCH_MISMATCH',
  ATTEMPT_TENANT_MISMATCH: 'ATTEMPT_TENANT_MISMATCH',
  INVALID_DECISION: 'INVALID_DECISION',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  INSUFFICIENT_NOTES: 'INSUFFICIENT_NOTES',
  CONCURRENT_RECONCILIATION_OR_STATE_CHANGED: 'CONCURRENT_RECONCILIATION_OR_STATE_CHANGED'
});

const WEAK_NOTE_PATTERNS = [
  /^ok$/i,
  /^sent$/i,
  /^probably sent$/i,
  /^i think it sent$/i,
  /^force send$/i,
  /^retry$/i,
  /^done$/i,
  /^test$/i,
  /^yes$/i,
  /^no$/i,
  /^n\/a$/i
];

/**
 * Validates that notes provided by operator are non-trivial and meaningful.
 */
export function validateReconciliationNotes(notes) {
  if (!notes || typeof notes !== 'string') {
    return { valid: false, error: 'Notes must be a non-empty string.' };
  }
  const trimmed = notes.trim();
  if (trimmed.length < 10) {
    return { valid: false, error: 'Notes must be at least 10 characters long describing the reconciliation evidence and rationale.' };
  }
  for (const pat of WEAK_NOTE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { valid: false, error: `Weak or unspecific notes "${trimmed}" are rejected. Operator must provide meaningful context.` };
    }
  }
  return { valid: true };
}

/**
 * Validates evidence provided for the chosen reconciliation decision.
 */
export function validateReconciliationEvidence(decision, evidence) {
  if (decision === RECONCILIATION_DECISIONS.VERIFIED_SENT) {
    if (!evidence || typeof evidence !== 'object') {
      return {
        valid: false,
        error: 'Evidence object is mandatory for VERIFIED_SENT decision. Must provide type and reference.'
      };
    }
    const { type, reference } = evidence;
    if (!type || !ALLOWED_EVIDENCE_TYPES.includes(type)) {
      return {
        valid: false,
        error: `Invalid or unsupported evidence type "${type}". Allowed: ${ALLOWED_EVIDENCE_TYPES.join(', ')}`
      };
    }
    if (!reference || typeof reference !== 'string' || reference.trim().length < 3) {
      return {
        valid: false,
        error: 'Evidence reference (e.g. provider message ID, transaction log ID, or audit receipt) must be at least 3 characters long.'
      };
    }
    return { valid: true, type, reference: reference.trim() };
  }

  if (decision === RECONCILIATION_DECISIONS.VERIFIED_NOT_SENT) {
    if (evidence && typeof evidence === 'object') {
      const type = evidence.type;
      if (type && !ALLOWED_EVIDENCE_TYPES.includes(type)) {
        return {
          valid: false,
          error: `Invalid evidence type "${type}". Allowed: ${ALLOWED_EVIDENCE_TYPES.join(', ')}`
        };
      }
      return { valid: true, type: type || 'MANUAL_OPERATOR_VERIFICATION', reference: evidence.reference ? String(evidence.reference).trim() : null };
    }
    return { valid: true, type: 'MANUAL_OPERATOR_VERIFICATION', reference: null };
  }

  // REMAINS_UNCERTAIN
  return { valid: true, type: evidence?.type || null, reference: evidence?.reference ? String(evidence.reference).trim() : null };
}

/**
 * Checks whether a touch with DISPATCHING execution status has exceeded the lease threshold.
 * Uses pure deterministic evaluateTouchLeaseState when evaluating default threshold.
 */
export function isTouchLockStale(touch, thresholdMinutes = STALE_LOCK_THRESHOLD_MINUTES, now = Date.now()) {
  if (!touch) return false;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  if (thresholdMs === STALE_LOCK_THRESHOLD_MS) {
    return evaluateTouchLeaseState(touch, now) === LEASE_EVALUATION_STATES.STALE;
  }
  if (touch.execution_status !== 'DISPATCHING') return false;
  if (!touch.execution_locked_at) return false; // fail closed: never silently classify missing as stale
  const lockedMs = new Date(touch.execution_locked_at).getTime();
  if (isNaN(lockedMs)) return false; // fail closed: never silently classify malformed as stale
  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : new Date(now).getTime());
  const elapsed = currentMs - lockedMs;
  if (elapsed < 0) return false; // clock anomaly / future timestamp: fail safe
  return elapsed >= thresholdMs;
}

/**
 * Core Manual Reconciliation Entry Point.
 * Governs state transitions for PROVIDER_UNCERTAIN touches and stale DISPATCHING locks.
 *
 * Enforces all 18 pre-reconciliation conditions:
 * 1. Authenticated identity
 * 2. Authorized role
 * 3. Tenant isolation
 * 4. Campaign ownership & existence
 * 5. Campaign not cancelled
 * 6. Approval metadata exists
 * 7. Approval hash valid
 * 8. Campaign version == approved version
 * 9. Current review hash == approved hash
 * 10. Touch belongs to campaign
 * 11. Lead belongs to campaign
 * 12. Touch state compatible (PROVIDER_UNCERTAIN or stale DISPATCHING)
 * 13. Decision valid
 * 14. Reason valid
 * 15. Notes meaningful & non-trivial
 * 16. Evidence valid & verified
 * 17. Atomic transactional update
 * 18. Zero provider calls, zero Phase 1 gate invocations, zero quota reservations.
 */
export async function reconcileCampaignTouchManual(params = {}) {
  const {
    campaignId,
    touchId,
    tenantId = 'default',
    decision,
    reason,
    notes,
    evidence = null,
    authenticatedActor = null,
    now = Date.now(),
    dbInstance = defaultDb
  } = params;

  const tid = (tenantId || 'default').trim();
  const evalNow = (now !== undefined && now !== null)
    ? (typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : new Date(now).getTime()))
    : Date.now();

  // 1. Authenticated Identity Verification
  if (!authenticatedActor || typeof authenticatedActor !== 'object' || !authenticatedActor.id) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.AUTHENTICATION_REQUIRED,
      message: 'Server-side operator authentication required for manual touch reconciliation.'
    };
  }

  // 2. Role Authorization Verification
  const actorRole = (authenticatedActor.role || '').toUpperCase();
  if (!ALLOWED_RECONCILIATION_ROLES.includes(actorRole)) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.ACTOR_UNAUTHORIZED,
      message: `Actor role "${actorRole}" is not authorized for manual reconciliation. Allowed: ${ALLOWED_RECONCILIATION_ROLES.join(', ')}.`
    };
  }

  // 3. Strict Tenant Isolation Verification
  const actorTenant = (authenticatedActor.tenantId || 'default').trim();
  if (actorTenant !== tid) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.TENANT_MISMATCH,
      message: `Authenticated actor tenant "${actorTenant}" cannot reconcile touch in foreign tenant "${tid}".`
    };
  }

  // 4. Decision Validation
  if (!decision || !Object.values(RECONCILIATION_DECISIONS).includes(decision)) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.INVALID_DECISION,
      message: `Invalid reconciliation decision "${decision}". Allowed: ${Object.values(RECONCILIATION_DECISIONS).join(', ')}.`
    };
  }

  // 5. Reason Validation
  if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.INSUFFICIENT_NOTES,
      message: 'Reconciliation reason is mandatory and must be at least 3 characters long.'
    };
  }

  // 6. Notes Validation (Reject trivial/weak notes)
  const notesValidation = validateReconciliationNotes(notes);
  if (!notesValidation.valid) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.INSUFFICIENT_NOTES,
      message: notesValidation.error
    };
  }

  // 7. Evidence Validation
  const evidenceValidation = validateReconciliationEvidence(decision, evidence);
  if (!evidenceValidation.valid) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.INSUFFICIENT_EVIDENCE,
      message: evidenceValidation.error
    };
  }

  // 8. Campaign Existence & Ownership
  if (!campaignId) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.CAMPAIGN_NOT_FOUND,
      message: 'campaignId is required.'
    };
  }
  const campaign = dbInstance.getCampaign(campaignId, tid);
  if (!campaign) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.CAMPAIGN_NOT_FOUND,
      message: `Campaign "${campaignId}" not found for tenant "${tid}".`
    };
  }

  // 9. Campaign Lifecycle Check (Not CANCELLED)
  if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.CANCELLED) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.CAMPAIGN_CANCELLED,
      message: `Campaign "${campaignId}" is CANCELLED. Reconciling touches on cancelled campaigns is forbidden.`
    };
  }

  // 10. Approval Metadata & Version Validation
  if (campaign.review_status !== 'APPROVED' || !campaign.approval_metadata || !campaign.review_hash || campaign.approved_version === null || campaign.approved_version === undefined) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.APPROVAL_MISSING,
      message: `Campaign "${campaignId}" lacks valid human approval metadata.`
    };
  }

  if (campaign.campaign_version !== campaign.approved_version) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.VERSION_MISMATCH,
      message: `Campaign version ${campaign.campaign_version} does not match approved version ${campaign.approved_version}. Approval invalidated.`
    };
  }

  // 11. Recompute and Verify Current Review Hash
  const allCampaignLeads = dbInstance.listCampaignLeads(campaign.id, tid, { limit: 10000 }) || [];
  const allTouches = dbInstance.listCampaignTouches(campaign.id, tid, { limit: 10000 }) || [];
  const currentReviewHash = generateCampaignReviewHash(campaign, allCampaignLeads, allTouches, { dbInstance });
  if (currentReviewHash !== campaign.review_hash) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.STALE_REVIEW_HASH,
      message: 'Campaign review hash mismatch. Campaign topology or settings modified since approval; reconciliation blocked.'
    };
  }

  // 11b. Campaign ACTIVE State Validation
  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.ACTIVE) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.CAMPAIGN_NOT_ACTIVE,
      message: `Campaign "${campaignId}" is not in ACTIVE state (current status: "${campaign.status}"). Reconciliation requires an ACTIVE campaign.`
    };
  }

  // 12. Touch Lookup & Campaign Membership
  if (!touchId) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.TOUCH_NOT_FOUND,
      message: 'touchId is required.'
    };
  }
  const touch = dbInstance.getCampaignTouch(touchId, tid);
  if (!touch) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.TOUCH_NOT_FOUND,
      message: `Campaign touch "${touchId}" not found for tenant "${tid}".`
    };
  }

  if (touch.campaign_id !== campaign.id) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.TOUCH_CAMPAIGN_MISMATCH,
      message: `Campaign touch "${touchId}" belongs to campaign "${touch.campaign_id}", not target campaign "${campaign.id}".`
    };
  }

  // 13. Touch Lead Membership
  const leadMatch = allCampaignLeads.some(l => l.lead_id === touch.lead_id);
  if (!leadMatch) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.TOUCH_LEAD_MISMATCH,
      message: `Touch lead "${touch.lead_id}" does not belong to campaign "${campaign.id}".`
    };
  }

  // 14. Current State Compatibility Check
  const isUncertain = touch.execution_status === 'PROVIDER_UNCERTAIN' || (touch.status === 'BLOCKED' && touch.execution_status === 'PROVIDER_UNCERTAIN');
  const isDispatching = touch.execution_status === 'DISPATCHING';

  if (!isUncertain && !isDispatching) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.INVALID_STATE_FOR_RECONCILIATION,
      message: `Touch "${touchId}" is in state status="${touch.status}" / execution_status="${touch.execution_status}". Only PROVIDER_UNCERTAIN touches or stale DISPATCHING locks are eligible for manual reconciliation.`
    };
  }

  // If DISPATCHING, verify stale lease threshold
  if (isDispatching) {
    if (!touch.execution_locked_at) {
      return {
        success: false,
        blocked: true,
        decision_reason: RECONCILIATION_ERROR_CODES.INVALID_STATE_FOR_RECONCILIATION,
        message: `Touch "${touchId}" is in DISPATCHING state but has no execution_locked_at timestamp; cannot verify lease state.`
      };
    }
    const lockedMs = new Date(touch.execution_locked_at).getTime();
    if (isNaN(lockedMs)) {
      return {
        success: false,
        blocked: true,
        decision_reason: RECONCILIATION_ERROR_CODES.INVALID_STATE_FOR_RECONCILIATION,
        message: `Touch "${touchId}" has invalid execution_locked_at timestamp; cannot verify lease state.`
      };
    }
    if (!isTouchLockStale(touch, STALE_LOCK_THRESHOLD_MINUTES, evalNow)) {
      return {
        success: false,
        blocked: true,
        decision_reason: RECONCILIATION_ERROR_CODES.TOUCH_DISPATCH_IN_FLIGHT,
        message: `Touch "${touchId}" dispatch is currently in flight (locked at ${touch.execution_locked_at}). Reconciliation is rejected until the 5-minute lease threshold expires.`
      };
    }
  }

  // 15. Attempt Validation (if attempts exist)
  const latestAttempt = dbInstance.getLatestExecutionAttempt(touchId, tid);
  if (latestAttempt) {
    if (latestAttempt.campaign_touch_id !== touch.id) {
      return {
        success: false,
        blocked: true,
        decision_reason: RECONCILIATION_ERROR_CODES.ATTEMPT_TOUCH_MISMATCH,
        message: 'Execution attempt does not belong to the target touch.'
      };
    }
    if (latestAttempt.tenant_id !== tid) {
      return {
        success: false,
        blocked: true,
        decision_reason: RECONCILIATION_ERROR_CODES.ATTEMPT_TENANT_MISMATCH,
        message: 'Execution attempt belongs to a foreign tenant.'
      };
    }
  }

  // 16. Atomic Reconciliation via Database Service
  try {
    const atomicResult = dbInstance.reconcileTouchAtomic(touch.id, tid, {
      decision,
      reason: reason.trim(),
      notes: notes.trim(),
      evidenceType: evidenceValidation.type,
      evidenceReference: evidenceValidation.reference,
      operatorId: authenticatedActor.id,
      operatorName: authenticatedActor.name || 'Operator',
      operatorRole: actorRole,
      approvalHash: campaign.review_hash,
      campaignVersion: campaign.campaign_version,
      now: evalNow,
      providerMessageId: (decision === RECONCILIATION_DECISIONS.VERIFIED_SENT && evidenceValidation.type === 'PROVIDER_MESSAGE_ID')
        ? evidenceValidation.reference
        : null
    });

    return {
      success: true,
      reconciled: true,
      decision,
      campaign_id: campaign.id,
      touch_id: touch.id,
      tenant_id: tid,
      previous_state: {
        status: touch.status,
        execution_status: touch.execution_status
      },
      new_state: {
        status: atomicResult.touch.status,
        execution_status: atomicResult.touch.execution_status
      },
      reconciliation: atomicResult.reconciliation,
      touch: atomicResult.touch,
      actor: {
        id: authenticatedActor.id,
        name: authenticatedActor.name || 'Operator',
        role: actorRole,
        tenantId: tid
      },
      provider_called: false,
      message_sent: false,
      quotas_reserved: 0
    };
  } catch (err) {
    return {
      success: false,
      blocked: true,
      decision_reason: RECONCILIATION_ERROR_CODES.CONCURRENT_RECONCILIATION_OR_STATE_CHANGED,
      message: `Failed to apply atomic reconciliation: ${err.message}`
    };
  }
}

/**
 * Read-only inquiry for touches that have stale execution locks in a campaign.
 * Evaluates stale status deterministically against the specified or current timestamp.
 * Does NOT mutate database records.
 */
export function getStaleDispatchingTouches(campaignId, tenantId = 'default', nowOrDb = Date.now(), dbInstance = defaultDb) {
  const tid = (tenantId || 'default').trim();
  let now = Date.now();
  let db = dbInstance;
  if (nowOrDb && typeof nowOrDb === 'object' && typeof nowOrDb.findStaleDispatchingTouches === 'function') {
    db = nowOrDb;
  } else if (nowOrDb !== undefined && nowOrDb !== null) {
    now = nowOrDb;
  }
  const allStale = db.findStaleDispatchingTouches(tid, now, STALE_LOCK_THRESHOLD_MS);
  if (!campaignId) return allStale;
  return allStale.filter(t => t.campaign_id === campaignId);
}

/**
 * Read-only inquiry for reconciliation history on a touch.
 */
export function getTouchReconciliationHistory(touchId, tenantId = 'default', dbInstance = defaultDb) {
  const tid = (tenantId || 'default').trim();
  return dbInstance.listReconciliationRecords(touchId, tid);
}
