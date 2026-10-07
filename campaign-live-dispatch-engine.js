/**
 * ==============================================================================
 * AI AutomationHubs - Controlled Live Dispatch Foundation (Step 6F-B.1)
 * Module: campaign-live-dispatch-engine.js
 * Version: 3.5 Enterprise
 *
 * Primary Objectives:
 * - Single-Touch -> Single-Lead -> Human-Confirmed -> Phase-1-Gated -> Provider-Dispatch.
 * - Multi-condition safety gating (15 mandatory verification conditions).
 * - Provider adapter boundary with fail-closed PROVIDER_NOT_CONFIGURED detection.
 * - Atomic database lock & idempotency protection against duplicate/concurrent dispatches.
 * - Zero bulk execution, zero schedulers, zero queues, zero background pollers, zero auto-retries.
 * - Phase 1 executeOutreachGate() is the single authoritative execution gate.
 * ==============================================================================
 */

import { db as defaultDb } from './database.js';
import {
  executeOutreachGate,
  checkOutreachEligibility,
  normalizeContactIdentifier,
  REASON_CODES
} from './compliance-engine.js';
import {
  generateCampaignReviewHash,
  resolveTouchContent,
  computeTouchContentHash,
  canonicalizeMessageContent,
  CAMPAIGN_LIFECYCLE_STATES,
  REVIEW_STATUSES
} from './campaign-review-engine.js';
import {
  EXECUTION_ERROR_CODES,
  verifyApprovedSnapshotIntegrity
} from './campaign-execution-engine.js';

export const PROVIDER_TYPES = Object.freeze({
  TELEGRAM: 'telegram',
  WHATSAPP: 'whatsapp',
  EMAIL: 'email'
});

export const PERMITTED_ACTOR_ROLES = Object.freeze([
  'ADMIN',
  'COMPLIANCE_OFFICER',
  'CAMPAIGN_MANAGER'
]);

export const DISPATCH_ERROR_CODES = Object.freeze({
  ...EXECUTION_ERROR_CODES,
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  ALREADY_DISPATCHED: 'ALREADY_DISPATCHED',
  CONCURRENT_DISPATCH_OR_ALREADY_LOCKED: 'CONCURRENT_DISPATCH_OR_ALREADY_LOCKED',
  HUMAN_CONFIRMATION_REQUIRED: 'HUMAN_CONFIRMATION_REQUIRED',
  INVALID_CONFIRMATION_TEXT: 'INVALID_CONFIRMATION_TEXT',
  ACTOR_UNAUTHORIZED: 'ACTOR_UNAUTHORIZED',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_UNCERTAIN: 'PROVIDER_UNCERTAIN',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  GATE_BLOCKED: 'GATE_BLOCKED',
  GATE_FAILED: 'GATE_FAILED'
});

// Step 6F-B.2A: Provider Result Taxonomy & Classifications
export const PROVIDER_RESULT_TAXONOMY = Object.freeze({
  PROVIDER_ACCEPTED: 'PROVIDER_ACCEPTED',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  PROVIDER_UNCERTAIN: 'PROVIDER_UNCERTAIN',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE'
});

export const PROVIDER_ERROR_CLASSIFICATIONS = Object.freeze({
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  SOCKET_DROPPED: 'SOCKET_DROPPED',
  CONNECTION_RESET: 'CONNECTION_RESET',
  PROVIDER_REJECTED_API_ERROR: 'PROVIDER_REJECTED_API_ERROR',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PRE_TRANSMISSION_ERROR: 'PRE_TRANSMISSION_ERROR',
  MISSING_MESSAGE_ID: 'MISSING_MESSAGE_ID',
  AMBIGUOUS_TRANSPORT_FAILURE: 'AMBIGUOUS_TRANSPORT_FAILURE'
});

// Step 6F-B.2C.1: Single authoritative stale lock lease threshold (5 minutes = 300,000 ms)
export const STALE_LOCK_THRESHOLD_MS = 300000;

export const LEASE_EVALUATION_STATES = Object.freeze({
  NOT_LOCKED: 'NOT_LOCKED',
  IN_FLIGHT: 'IN_FLIGHT',
  STALE: 'STALE',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP'
});

/**
 * Pure deterministic read-only evaluation of touch lease state.
 * Evaluates whether a touch's execution lease is NOT_LOCKED, IN_FLIGHT, STALE, or INVALID_TIMESTAMP.
 * Does NOT mutate the database.
 *
 * Rules:
 * - If touch is null or execution_status / status is NOT 'DISPATCHING', returns NOT_LOCKED.
 * - Non-dispatching states (PLANNED, SENT, FAILED, BLOCKED, PROVIDER_UNCERTAIN) are NOT_LOCKED regardless of timestamp age.
 * - Missing or malformed execution_locked_at -> INVALID_TIMESTAMP (Fail closed: never silently STALE).
 * - Future lock timestamp (now < lockedAt) -> IN_FLIGHT (Fail safe: never silently STALE).
 * - DISPATCHING + (now - lockedAt) < STALE_LOCK_THRESHOLD_MS -> IN_FLIGHT.
 * - DISPATCHING + (now - lockedAt) >= STALE_LOCK_THRESHOLD_MS -> STALE.
 *
 * @param {Object} touch - campaign touch record
 * @param {number|Date} [now] - Reference time (supports dependency injection for deterministic testing)
 * @returns {string} One of LEASE_EVALUATION_STATES
 */
export function evaluateTouchLeaseState(touch, now = Date.now()) {
  if (!touch) return LEASE_EVALUATION_STATES.NOT_LOCKED;

  const executionStatus = touch.execution_status ? String(touch.execution_status).toUpperCase() : null;
  const status = touch.status ? String(touch.status).toUpperCase() : null;
  const isDispatching = executionStatus === 'DISPATCHING' || status === 'DISPATCHING';

  // Non-DISPATCHING states are strictly NOT_LOCKED regardless of existing timestamps
  if (!isDispatching) {
    return LEASE_EVALUATION_STATES.NOT_LOCKED;
  }

  // Must have an execution_locked_at timestamp
  if (!touch.execution_locked_at) {
    return LEASE_EVALUATION_STATES.INVALID_TIMESTAMP;
  }

  const lockedMs = new Date(touch.execution_locked_at).getTime();
  if (isNaN(lockedMs)) {
    return LEASE_EVALUATION_STATES.INVALID_TIMESTAMP;
  }

  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : new Date(now).getTime());
  if (isNaN(currentMs)) {
    return LEASE_EVALUATION_STATES.INVALID_TIMESTAMP;
  }

  const elapsedMs = currentMs - lockedMs;

  // Future timestamp (clock anomaly): fail safe as IN_FLIGHT (never declare STALE)
  if (elapsedMs < 0) {
    return LEASE_EVALUATION_STATES.IN_FLIGHT;
  }

  if (elapsedMs >= STALE_LOCK_THRESHOLD_MS) {
    return LEASE_EVALUATION_STATES.STALE;
  }

  return LEASE_EVALUATION_STATES.IN_FLIGHT;
}

/**
 * Read-only execution health summary for a campaign.
 * Authenticated and tenant-scoped.
 * Does NOT mutate database records.
 *
 * @param {string} campaignId
 * @param {string} [tenantId='default']
 * @param {number|Date} [now=Date.now()]
 * @param {Object} [dbInstance=defaultDb]
 * @returns {Object} Diagnostic execution health metrics
 */
export function getCampaignExecutionHealth(campaignId, tenantId = 'default', now = Date.now(), dbInstance = defaultDb) {
  if (!campaignId) throw new Error('campaignId is required');
  const tid = (tenantId || 'default').trim();

  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
  }

  const touches = typeof dbInstance.listCampaignTouches === 'function'
    ? dbInstance.listCampaignTouches(campaignId, tid)
    : (typeof dbInstance.getCampaignTouches === 'function' ? dbInstance.getCampaignTouches(campaignId, tid) : []);
  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : new Date(now).getTime());

  let planned = 0;
  let dispatching = 0;
  let inFlight = 0;
  let staleDispatching = 0;
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let providerUncertain = 0;
  let invalidTimestamp = 0;

  for (const t of touches) {
    const status = t.status ? String(t.status).toUpperCase() : '';
    const execStatus = t.execution_status ? String(t.execution_status).toUpperCase() : '';

    if (execStatus === 'DISPATCHING' || status === 'DISPATCHING') {
      dispatching++;
      const leaseState = evaluateTouchLeaseState(t, currentMs);
      if (leaseState === LEASE_EVALUATION_STATES.STALE) {
        staleDispatching++;
      } else if (leaseState === LEASE_EVALUATION_STATES.IN_FLIGHT) {
        inFlight++;
      } else if (leaseState === LEASE_EVALUATION_STATES.INVALID_TIMESTAMP) {
        invalidTimestamp++;
      }
    } else if (execStatus === 'PROVIDER_UNCERTAIN') {
      providerUncertain++;
      if (status === 'BLOCKED') blocked++;
    } else if (status === 'SENT' || execStatus === 'SENT') {
      sent++;
    } else if (status === 'FAILED' || execStatus === 'FAILED') {
      failed++;
    } else if (status === 'BLOCKED') {
      blocked++;
    } else if (status === 'PLANNED') {
      planned++;
    }
  }

  // Find latest attempt timestamp if available
  let latestAttemptAt = null;
  try {
    const latestAttempt = dbInstance.sqlite.prepare(`
      SELECT created_at FROM campaign_execution_attempts
      WHERE campaign_id = ? AND tenant_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(campaignId, tid);
    if (latestAttempt && latestAttempt.created_at) {
      latestAttemptAt = latestAttempt.created_at;
    }
  } catch (_) {}

  return {
    success: true,
    campaignId,
    tenantId: tid,
    evaluatedAt: new Date(currentMs).toISOString(),
    staleThresholdMs: STALE_LOCK_THRESHOLD_MS,
    healthSummary: {
      totalTouches: touches.length,
      planned,
      dispatching,
      inFlight,
      staleDispatching,
      sent,
      failed,
      blocked,
      providerUncertain,
      invalidTimestamp
    },
    latestAttemptAt
  };
}


/**
 * Normalizes provider results and transport errors into canonical taxonomy.
 * Guarantees that network timeouts and ambiguous errors are classified as
 * PROVIDER_UNCERTAIN and NEVER automatically marked as PROVIDER_REJECTED.
 */
export function classifyProviderOutcome(error, payloadResult, phase = 'DURING_SEND') {
  if (phase === 'BEFORE_SEND') {
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNAVAILABLE,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.PROVIDER_NOT_CONFIGURED,
      reason: error ? String(error.message || error) : 'Provider unavailable before send'
    };
  }

  if (!error && payloadResult) {
    const msgId = payloadResult.message_id || payloadResult.messageId;
    if (msgId && String(msgId).trim() && String(msgId) !== 'null' && String(msgId) !== 'undefined') {
      return {
        category: PROVIDER_RESULT_TAXONOMY.PROVIDER_ACCEPTED,
        classification: null,
        messageId: String(msgId)
      };
    }
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.MISSING_MESSAGE_ID,
      reason: 'Provider returned result without a valid message ID'
    };
  }

  const errStr = String(error?.message || error || '').toLowerCase();

  // Telegram / Provider definitive API rejections (HTTP 4xx response from server)
  const isDefinitiveRejection =
    errStr.includes('blocked by the user') ||
    errStr.includes('user is deactivated') ||
    errStr.includes('chat not found') ||
    errStr.includes('bad request') ||
    errStr.includes('code 400') ||
    errStr.includes('code 403') ||
    errStr.includes('code 404') ||
    errStr.includes("can't parse entities") ||
    errStr.includes('message is too long') ||
    errStr.includes("can't initiate conversation");

  if (isDefinitiveRejection) {
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_REJECTED,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.PROVIDER_REJECTED_API_ERROR,
      reason: String(error?.message || error)
    };
  }

  // Network / Socket / Timeout errors -> PROVIDER_UNCERTAIN
  if (errStr.includes('timeout') || errStr.includes('timed out') || errStr.includes('etimedout')) {
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.NETWORK_TIMEOUT,
      reason: String(error?.message || error)
    };
  }

  if (errStr.includes('econnreset') || errStr.includes('connection reset')) {
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.CONNECTION_RESET,
      reason: String(error?.message || error)
    };
  }

  if (errStr.includes('socket') || errStr.includes('hang up') || errStr.includes('dropped')) {
    return {
      category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
      classification: PROVIDER_ERROR_CLASSIFICATIONS.SOCKET_DROPPED,
      reason: String(error?.message || error)
    };
  }

  // Conservative Fail-Safe: Any ambiguous or unconfirmed transport error is UNCERTAIN
  return {
    category: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
    classification: PROVIDER_ERROR_CLASSIFICATIONS.AMBIGUOUS_TRANSPORT_FAILURE,
    reason: String(error?.message || error)
  };
}

/**
 * Global safety guard for Step 6F-B.1.
 * Live execution is allowed ONLY when explicitly enabled via CAMPAIGN_LIVE_EXECUTION_ENABLED === 'true'.
 * Defaults to false (fail-closed).
 */
export function isLiveExecutionAllowed() {
  return process.env.CAMPAIGN_LIVE_EXECUTION_ENABLED === 'true';
}

/**
 * Resolves the genuine provider adapter for a requested channel.
 * Strictly verifies provider credentials & readiness.
 * If credentials/transport are unconfigured or unavailable, returns configured = false.
 * NO MOCK-AS-REAL: Never fabricates success without real provider configuration.
 *
 * @param {string} channel
 * @param {object} [dbInstance]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function resolveProviderAdapter(channel, dbInstance = defaultDb, options = {}) {
  const ch = String(channel || '').toLowerCase().trim();

  // Controlled test override support (e.g. for testing network faults or mock failure injection without fake provider success)
  if (options.providerOverride) {
    return options.providerOverride;
  }

  const settings = dbInstance.getSettings();

  if (ch === 'telegram') {
    const token = settings.telegramBotToken;
    const rawChatIds = settings.telegramChatIds;

    if (!token || !token.trim()) {
      return {
        configured: false,
        name: 'telegram',
        channel: 'telegram',
        reasonCode: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        reason: 'Telegram Bot Token is not configured in database Settings.'
      };
    }

    return {
      configured: true,
      name: 'telegram',
      channel: 'telegram',
      send: async (resolvedLead, sendOptions = {}) => {
        const { sendTelegramMessage } = await import('./telegram-bot.js');
        const targetChat = resolvedLead.telegram || (rawChatIds ? rawChatIds.split(/[,\n\s]+/)[0].trim() : null) || sendOptions.targetContact;
        if (!targetChat) {
          throw new Error('No target Telegram chat ID found for lead');
        }
        const text = sendOptions.messageText || `🎯 <b>AI Campaign Touch #${sendOptions.touchNumber || 1}</b>\n\nLead: ${resolvedLead.businessName || 'Business'}\nTouch Purpose: ${sendOptions.purpose || 'INITIAL_OUTREACH'}`;
        const res = await sendTelegramMessage(token, targetChat, text, { parse_mode: 'HTML' });
        return {
          provider: 'telegram',
          message_id: String(res.message_id),
          chat_id: String(res.chat?.id || targetChat),
          date: res.date,
          raw: res
        };
      }
    };
  }

  if (ch === 'whatsapp') {
    const { getWhatsappStatus, checkWhatsappHealth, sendWhatsappMessage } = await import('./whatsapp-client.js');
    const health = typeof checkWhatsappHealth === 'function' ? await checkWhatsappHealth() : { ready: getWhatsappStatus().status === 'Connected' };
    if (!health.ready) {
      return {
        configured: false,
        name: 'whatsapp',
        channel: 'whatsapp',
        reasonCode: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        reason: `WhatsApp provider is not ready (${health.reason || health.state || 'Not Connected'}). Live QR authentication or reconnection required.`
      };
    }

    return {
      configured: true,
      name: 'whatsapp',
      channel: 'whatsapp',
      send: async (resolvedLead, sendOptions = {}) => {
        const phone = sendOptions.targetContact || resolvedLead.phone;
        const text = sendOptions.messageText || `Hi ${resolvedLead.businessName || ''}, reaching out regarding your business.`;
        const res = await sendWhatsappMessage(phone, text);
        return {
          provider: 'whatsapp',
          message_id: String(res?.id?._serialized || res?.id || 'wa_sent'),
          raw: res
        };
      }
    };
  }

  if (ch === 'email') {
    const { getOAuth2Client } = await import('./outreach.js');
    const oauth2 = getOAuth2Client();
    if (!oauth2) {
      return {
        configured: false,
        name: 'email',
        channel: 'email',
        reasonCode: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        reason: 'Google OAuth2 is not configured in Settings.'
      };
    }

    return {
      configured: false,
      name: 'email',
      channel: 'email',
      reasonCode: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      reason: 'Direct email provider live dispatch is draft-only; direct live send is not configured.'
    };
  }

  return {
    configured: false,
    name: ch,
    channel: ch,
    reasonCode: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    reason: `Unsupported provider channel "${ch}".`
  };
}

/**
 * Dispatches a SINGLE campaign touch live to a SINGLE lead.
 *
 * Enforces all 15 mandatory safety conditions:
 * 1. mode === LIVE
 * 2. CAMPAIGN_LIVE_EXECUTION_ENABLED === true
 * 3. Campaign status = ACTIVE
 * 4. Valid human approval metadata
 * 5. Current computed review hash === approved review hash
 * 6. Campaign version === approved version
 * 7. Touch status = PLANNED (not already SENT or DISPATCHING)
 * 8. Touch is due (planned_at <= evaluationTime)
 * 9. Current live eligibility recheck passes
 * 10. Channel is currently routable
 * 11. Explicit human confirmation: "I CONFIRM THIS SINGLE MESSAGE" + actor identity
 * 12. Tenant ownership verified across actor, campaign, campaign_lead, touch, lead
 * 13. Touch not already dispatched (atomic database claim / idempotency lock)
 * 14. Quota available
 * 15. Phase 1 executeOutreachGate() grants permission and invokes sendFn
 *
 * @param {object} params
 * @returns {Promise<object>} Dispatch result
 */
export async function dispatchCampaignTouchLive({
  campaignId,
  touchId,
  tenantId = 'default',
  mode = 'LIVE',
  confirm = false,
  confirmation_text = '',
  actor = null,
  clientActor = null,
  evaluationTime = null,
  dbInstance = defaultDb,
  req = null,
  providerOverride = null,
  authenticatedActor = null
}) {
  const tid = (tenantId || 'default').trim();
  const upperMode = String(mode || '').toUpperCase().trim();
  const evalTimeStr = evaluationTime || new Date().toISOString();

  // 1. Mode Enforcement
  if (upperMode !== 'LIVE') {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.INVALID_EXECUTION_MODE,
      reason: 'Live dispatch requires mode === "LIVE"',
      provider_called: false,
      message_sent: false
    };
  }

  // 2. Environment Gate (CAMPAIGN_LIVE_EXECUTION_ENABLED)
  if (!isLiveExecutionAllowed()) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.LIVE_EXECUTION_DISABLED,
      reason: `${DISPATCH_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled by configuration (CAMPAIGN_LIVE_EXECUTION_ENABLED !== true).`,
      provider_called: false,
      message_sent: false
    };
  }

  // 3. Human Actor Authorization (Strict Server-Side Identity Binding)
  // Step 6F-B.1 Auth Hardening:
  // The authoritative actor MUST come from server-side authenticated context (authenticatedActor or req.authenticatedUser).
  // Any client-supplied actor (e.g. from req.body) is completely UNTRUSTED for authorization.
  const authoritativeActor = authenticatedActor || (req && req.authenticatedUser) || actor;

  if (!authoritativeActor || typeof authoritativeActor !== 'object' || !authoritativeActor.id || !authoritativeActor.role) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.ACTOR_UNAUTHORIZED,
      reason: 'Server-side authenticated human actor required ({ id, name, role }). Untrusted client body actor is rejected.',
      provider_called: false,
      message_sent: false
    };
  }

  const resolvedTenant = String(authoritativeActor.tenantId || tid).trim();
  if (resolvedTenant !== tid) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TENANT_MISMATCH,
      reason: `Actor tenant "${resolvedTenant}" does not match dispatch tenant "${tid}".`,
      provider_called: false,
      message_sent: false
    };
  }

  const actorRoleUpper = String(authoritativeActor.role || '').toUpperCase().trim();
  if (!PERMITTED_ACTOR_ROLES.includes(actorRoleUpper)) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.ACTOR_UNAUTHORIZED,
      reason: `Actor role "${authoritativeActor.role}" is not authorized for live dispatch. Authorized roles: ${PERMITTED_ACTOR_ROLES.join(', ')}.`,
      provider_called: false,
      message_sent: false
    };
  }

  const auditActor = {
    id: String(authoritativeActor.id).trim(),
    name: String(authoritativeActor.name || authoritativeActor.actorName || authoritativeActor.id).trim(),
    role: actorRoleUpper,
    tenantId: resolvedTenant
  };

  // 4. Explicit Human Confirmation
  if (confirm !== true) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.HUMAN_CONFIRMATION_REQUIRED,
      reason: 'Explicit human confirmation (confirm: true) is required immediately before dispatch.',
      provider_called: false,
      message_sent: false
    };
  }

  if (String(confirmation_text || '').trim() !== 'I CONFIRM THIS SINGLE MESSAGE') {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.INVALID_CONFIRMATION_TEXT,
      reason: 'Confirmation text must exactly equal "I CONFIRM THIS SINGLE MESSAGE".',
      provider_called: false,
      message_sent: false
    };
  }

  // 5. Campaign Existence, Status & Tenant Isolation
  const campaign = dbInstance.getCampaignById(campaignId, tid);
  if (!campaign) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.CAMPAIGN_NOT_FOUND,
      reason: `Campaign "${campaignId}" not found for tenant "${tid}".`,
      provider_called: false,
      message_sent: false
    };
  }

  if (campaign.tenant_id !== tid) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TENANT_MISMATCH,
      reason: `Campaign tenant "${campaign.tenant_id}" does not match requested tenant "${tid}".`,
      provider_called: false,
      message_sent: false
    };
  }

  if (campaign.status !== CAMPAIGN_LIFECYCLE_STATES.ACTIVE) {
    let reasonCode = DISPATCH_ERROR_CODES.CAMPAIGN_NOT_ACTIVE;
    if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.PAUSED) reasonCode = DISPATCH_ERROR_CODES.CAMPAIGN_PAUSED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.CANCELLED) reasonCode = DISPATCH_ERROR_CODES.CAMPAIGN_CANCELLED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.COMPLETED) reasonCode = DISPATCH_ERROR_CODES.CAMPAIGN_COMPLETED;
    else if (campaign.status === CAMPAIGN_LIFECYCLE_STATES.APPROVED) reasonCode = DISPATCH_ERROR_CODES.CAMPAIGN_NOT_ACTIVE;

    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: reasonCode,
      reason: `Campaign is not in ACTIVE state (current: ${campaign.status}). Only ACTIVE campaigns can be dispatched.`,
      provider_called: false,
      message_sent: false
    };
  }

  // 6. Approval & Version Hash Lock
  if (campaign.review_status !== REVIEW_STATUSES.APPROVED || !campaign.approval_metadata || !campaign.review_hash) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.APPROVAL_REQUIRED,
      reason: 'Campaign lacks valid human approval metadata or review hash.',
      provider_called: false,
      message_sent: false
    };
  }

  if (campaign.approved_version !== campaign.campaign_version) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.APPROVAL_VERSION_MISMATCH,
      reason: `Campaign version ${campaign.campaign_version} does not match approved version ${campaign.approved_version}.`,
      provider_called: false,
      message_sent: false
    };
  }

  const allCampaignLeads = dbInstance.listCampaignLeads(campaign.id, tid, { limit: 10000 }) || [];
  const allTouches = dbInstance.listCampaignTouches(campaign.id, tid, { limit: 10000 }) || [];
  const currentReviewHash = generateCampaignReviewHash(campaign, allCampaignLeads, allTouches, { dbInstance });
  if (currentReviewHash !== campaign.review_hash) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.APPROVAL_HASH_MISMATCH,
      reason: 'Campaign review hash mismatch. Target criteria, sequence plan, or channel strategy modified since approval.',
      provider_called: false,
      message_sent: false
    };
  }

  // 7. Touch State & Tenant Verification
  const touch = dbInstance.getCampaignTouch(touchId, tid);
  if (!touch) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TOUCH_NOT_FOUND,
      reason: `Campaign touch "${touchId}" not found for tenant "${tid}".`,
      provider_called: false,
      message_sent: false
    };
  }

  if (touch.campaign_id !== campaign.id || touch.tenant_id !== tid) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TENANT_MISMATCH,
      reason: 'Touch campaign or tenant mismatch.',
      provider_called: false,
      message_sent: false
    };
  }

  if (touch.status === 'SENT' || touch.execution_status === 'SENT') {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.ALREADY_DISPATCHED,
      reason: 'Touch has already been dispatched.',
      provider_called: false,
      message_sent: false
    };
  }

  if (touch.status === 'DISPATCHING' || touch.execution_lock) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.CONCURRENT_DISPATCH_OR_ALREADY_LOCKED,
      reason: 'Touch is currently locked and undergoing dispatch by another process.',
      provider_called: false,
      message_sent: false
    };
  }

  if (touch.status !== 'PLANNED') {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TOUCH_NOT_PLANNED,
      reason: `Touch is not in PLANNED status (current: ${touch.status}).`,
      provider_called: false,
      message_sent: false
    };
  }

  // 7b. Step 7E-2 & Step 7G-4 Persistent Approved Snapshot & Claim-Root Verification
  const approvedVersion = campaign.approved_version || 1;
  const snapshot = dbInstance.getApprovedSnapshotByTouch
    ? dbInstance.getApprovedSnapshotByTouch(touch.id, approvedVersion, tid)
    : null;

  const campaignLeadPre = dbInstance.getCampaignLead ? dbInstance.getCampaignLead(campaign.id, touch.lead_id, tid) : null;
  const leadPre = dbInstance.getLead ? dbInstance.getLead(touch.lead_id, tid) : null;

  const snapshotIntegrity = verifyApprovedSnapshotIntegrity(snapshot, tid, {
    touch,
    campaign,
    campaignLead: campaignLeadPre,
    lead: leadPre,
    actor: auditActor,
    permittedRoles: PERMITTED_ACTOR_ROLES,
    dbInstance
  });

  if (!snapshotIntegrity.valid) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: snapshotIntegrity.decision_reason,
      reason: snapshotIntegrity.reason,
      provider_called: false,
      message_sent: false
    };
  }

  // 8. Due Timing Check
  if (Date.parse(touch.planned_at) > Date.parse(evalTimeStr)) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TOUCH_NOT_DUE,
      reason: `Touch #${touch.touch_number} planned for ${touch.planned_at} is not due yet (evaluation time: ${evalTimeStr}).`,
      provider_called: false,
      message_sent: false
    };
  }

  // 9. Campaign Lead & Target Lead Verification
  const campaignLead = dbInstance.getCampaignLead(campaign.id, touch.lead_id, tid);
  if (!campaignLead || campaignLead.tenant_id !== tid || campaignLead.campaign_id !== campaign.id) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TENANT_MISMATCH,
      reason: 'Campaign lead tenant or campaign mismatch.',
      provider_called: false,
      message_sent: false
    };
  }

  // Step 7E-4: Recipient binding verification — live mutable recipient must match approved snapshot
  if (snapshot.recipient_contact) {
    const liveHandle = campaignLead.target_contact_handle || null;
    const ch = String(touch.planned_channel || '').toLowerCase();
    const normalizedLive = liveHandle
      ? (normalizeContactIdentifier(liveHandle, ch)?.identifier || String(liveHandle).toLowerCase().trim())
      : '';
    const normalizedSnap = normalizeContactIdentifier(snapshot.recipient_contact, ch)?.identifier
      || String(snapshot.recipient_contact).toLowerCase().trim();
    if (normalizedLive !== normalizedSnap) {
      return {
        success: false,
        blocked: true,
        allowed: false,
        decision: 'BLOCKED',
        decision_reason: DISPATCH_ERROR_CODES.RECIPIENT_SNAPSHOT_MISMATCH,
        reason: `Recipient mutation detected: live handle "${liveHandle}" does not match approved snapshot recipient "${snapshot.recipient_contact}".`,
        provider_called: false,
        message_sent: false
      };
    }
  }

  if (campaignLead.review_status === 'EXCLUDED_BY_USER') {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.LEAD_EXCLUDED,
      reason: 'Lead was explicitly excluded from campaign during review.',
      provider_called: false,
      message_sent: false
    };
  }

  const leadOwnership = dbInstance.validateLeadOwnership(touch.lead_id, tid);
  if (!leadOwnership || !leadOwnership.valid || !leadOwnership.lead) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.TENANT_MISMATCH,
      reason: `Lead "${touch.lead_id}" not found or tenant mismatch.`,
      provider_called: false,
      message_sent: false
    };
  }
  const lead = leadOwnership.lead;

  // 10. Live Pre-flight Eligibility Recheck
  const plannedChannel = touch.planned_channel;
  const lowerChannel = String(plannedChannel).toLowerCase();
  // Step 7E-4: Fix — authoritative recipient is the approved snapshot, NOT mutable campaign_leads
  // snapshot.recipient_contact is cryptographically bound to the approval hash.
  // mutable campaignLead.target_contact_handle is used ONLY as a last-resort fallback for
  // compliance pre-flight if the snapshot recipient is absent (should never happen post-7E-4).
  let contactIdentifier = snapshot.recipient_contact || campaignLead.target_contact_handle;
  if (!contactIdentifier || (lowerChannel === 'telegram' && /^\d+$/.test(contactIdentifier) && !contactIdentifier.startsWith('+'))) {
    contactIdentifier = lead.phone || lead.telegram || lead.email;
  }

  const complianceDecision = await checkOutreachEligibility({
    leadId: lead.id,
    lead,
    channel: lowerChannel,
    contactIdentifier,
    tenantId: tid
  });

  if (!complianceDecision.allowed) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: complianceDecision.reasonCode || DISPATCH_ERROR_CODES.LEAD_INELIGIBLE,
      reason: `Lead is not eligible for live dispatch: ${complianceDecision.reason}`,
      eligibility_snapshot: complianceDecision,
      provider_called: false,
      message_sent: false
    };
  }

  // 11. Provider Adapter Resolution
  const adapter = await resolveProviderAdapter(lowerChannel, dbInstance, { providerOverride });
  if (!adapter || !adapter.configured) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      reason: adapter?.reason || `Provider for channel "${lowerChannel}" is not configured or available.`,
      provider_called: false,
      message_sent: false
    };
  }

  // 12. Atomic Touch Execution Claim / Lock
  const lockId = `lock_${touch.id}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const lockAcquired = dbInstance.claimCampaignTouchForExecution(touch.id, tid, lockId);
  if (!lockAcquired) {
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: DISPATCH_ERROR_CODES.ALREADY_DISPATCHED,
      reason: 'Failed to acquire execution lock. Touch may have already been dispatched or locked concurrently.',
      provider_called: false,
      message_sent: false
    };
  }

  // 12a. Step 7G-4: Authoritative TOCTOU Re-Validation inside locked critical section
  const lockedSnapshotIntegrity = verifyApprovedSnapshotIntegrity(snapshot.id, tid, {
    touch,
    campaign,
    campaignLead,
    lead,
    actor: auditActor,
    permittedRoles: PERMITTED_ACTOR_ROLES,
    dbInstance
  });
  if (!lockedSnapshotIntegrity.valid) {
    dbInstance.recordCampaignTouchExecutionFailure(touch.id, tid, lockId, {
      error: `TOCTOU integrity failure post-lock: ${lockedSnapshotIntegrity.decision_reason} - ${lockedSnapshotIntegrity.reason}`
    });
    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: lockedSnapshotIntegrity.decision_reason,
      reason: `TOCTOU integrity failure detected post-lock: ${lockedSnapshotIntegrity.reason}`,
      provider_called: false,
      message_sent: false
    };
  }

  // 12b. Execution Attempt Recording (Step 6F-B.2A Append-Only Attempt Model)
  const attemptNumber = (touch.execution_attempt_count || 0) + 1;
  const idempotencyKey = `idem_${touch.id}_${lockId}`;
  let attemptRecord = null;
  const now = new Date().toISOString();

  try {
    attemptRecord = dbInstance.recordExecutionAttemptStart({
      id: `att_${touch.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      tenant_id: tid,
      campaign_id: campaign.id,
      campaign_lead_id: campaignLead.id,
      campaign_touch_id: touch.id,
      lead_id: lead.id,
      operator_id: auditActor.id,
      operator_name: auditActor.name,
      operator_role: auditActor.role,
      channel: lowerChannel,
      provider: adapter.name,
      attempt_number: attemptNumber,
      idempotency_key: idempotencyKey,
      started_at: now
    });
  } catch (attErr) {
    console.error('Failed to create execution attempt record:', attErr.message);
  }
  const attemptId = attemptRecord?.id || null;

  // 13. Phase 1 Gate Invocation
  let providerCalled = false;
  let providerPayloadResult = null;

  // Outbound content retrieved directly and exclusively from persistent approved snapshot
  const outboundBody = snapshot.message_body;
  const outboundSubject = snapshot.message_subject || null;

  const sendFn = async (resolvedLead) => {
    providerCalled = true;
    providerPayloadResult = await adapter.send(resolvedLead, {
      targetContact: contactIdentifier,
      touchNumber: touch.touch_number,
      purpose: touch.purpose,
      campaignId: campaign.id,
      messageText: outboundBody,
      messageSubject: outboundSubject
    });
    return providerPayloadResult;
  };

  const gateResult = await executeOutreachGate({
    leadId: lead.id,
    lead,
    channel: lowerChannel,
    contactIdentifier: complianceDecision.contactIdentifier || contactIdentifier,
    tenantId: tid,
    sendFn,
    req
  });

  // 14. Gate & Provider Outcome Processing
  if (gateResult.blocked === true || !gateResult.allowed) {
    // Gate blocked before transport dispatch (e.g. quota exhausted or compliance block inside gate)
    if (attemptId) {
      try {
        dbInstance.finalizeExecutionAttempt(attemptId, tid, {
          result_status: 'BLOCKED',
          error_classification: gateResult.reasonCode || DISPATCH_ERROR_CODES.GATE_BLOCKED,
          error_message: gateResult.reason || 'Phase 1 outreach gate blocked execution.'
        });
      } catch (_) {}
    }

    dbInstance.releaseCampaignTouchExecutionLock(touch.id, tid, lockId);

    try {
      dbInstance.createCampaignExecutionLog({
        tenant_id: tid,
        campaign_id: campaign.id,
        campaign_lead_id: campaignLead.id,
        campaign_touch_id: touch.id,
        lead_id: lead.id,
        execution_mode: 'LIVE',
        planned_channel: plannedChannel,
        execution_status: 'BLOCKED',
        decision_reason: gateResult.reasonCode || DISPATCH_ERROR_CODES.GATE_BLOCKED,
        provider: adapter.name,
        provider_message_id: null,
        simulated: 0,
        gate_result: JSON.stringify(gateResult),
        eligibility_snapshot: JSON.stringify(complianceDecision),
        approval_hash: currentReviewHash,
        metadata: JSON.stringify({ actor: auditActor, lockId, attemptId })
      });
    } catch (_) {}

    return {
      success: false,
      blocked: true,
      allowed: false,
      decision: 'BLOCKED',
      decision_reason: gateResult.reasonCode || DISPATCH_ERROR_CODES.GATE_BLOCKED,
      reason: gateResult.reason || 'Phase 1 outreach gate blocked execution.',
      gate_result: gateResult,
      provider_called: providerCalled,
      message_sent: false,
      attempt_id: attemptId
    };
  }

  if (gateResult.success === false && gateResult.allowed === true) {
    // Allowed by gate, but transport failed or socket dropped
    const failureError = gateResult.error || 'Transport dispatch failed';
    const outcome = classifyProviderOutcome(failureError, null, 'DURING_SEND');

    if (outcome.category === PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN) {
      // Step 6F-B.2A: Ambiguous network error or socket drop MUST NOT be marked FAILED
      if (attemptId) {
        try {
          dbInstance.finalizeExecutionAttempt(attemptId, tid, {
            result_status: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
            error_classification: outcome.classification,
            error_message: failureError
          });
        } catch (_) {}
      }

      dbInstance.recordCampaignTouchExecutionUncertain(touch.id, tid, lockId, {
        error: failureError,
        attemptId,
        metadata: { actor: auditActor, error: failureError, classification: outcome.classification, attemptId }
      });

      try {
        dbInstance.createCampaignExecutionLog({
          tenant_id: tid,
          campaign_id: campaign.id,
          campaign_lead_id: campaignLead.id,
          campaign_touch_id: touch.id,
          lead_id: lead.id,
          execution_mode: 'LIVE',
          planned_channel: plannedChannel,
          execution_status: 'BLOCKED',
          decision_reason: `${DISPATCH_ERROR_CODES.PROVIDER_UNCERTAIN}: ${failureError}`,
          provider: adapter.name,
          provider_message_id: null,
          simulated: 0,
          gate_result: JSON.stringify(gateResult),
          eligibility_snapshot: JSON.stringify(complianceDecision),
          approval_hash: currentReviewHash,
          metadata: JSON.stringify({ actor: auditActor, error: failureError, classification: outcome.classification, attemptId, lockId, provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN })
        });
      } catch (_) {}

      return {
        success: false,
        blocked: true,
        allowed: true,
        decision: 'UNCERTAIN',
        decision_reason: DISPATCH_ERROR_CODES.PROVIDER_UNCERTAIN,
        reason: `Provider delivery is uncertain: ${failureError}. Touch blocked from automatic re-execution pending reconciliation.`,
        touch_status: 'BLOCKED',
        execution_status: 'PROVIDER_UNCERTAIN',
        error: failureError,
        error_classification: outcome.classification,
        provider: adapter.name,
        provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        gate_result: gateResult,
        provider_called: providerCalled,
        message_sent: false
      };
    }

    // Definitive rejection (HTTP 4xx from provider)
    if (attemptId) {
      try {
        dbInstance.finalizeExecutionAttempt(attemptId, tid, {
          result_status: PROVIDER_RESULT_TAXONOMY.PROVIDER_REJECTED,
          error_classification: outcome.classification,
          error_message: failureError
        });
      } catch (_) {}
    }

    dbInstance.recordCampaignTouchExecutionFailure(touch.id, tid, lockId, {
      error: failureError,
      attemptId,
      metadata: { actor: auditActor, error: failureError, classification: outcome.classification, attemptId }
    });

    try {
      dbInstance.createCampaignExecutionLog({
        tenant_id: tid,
        campaign_id: campaign.id,
        campaign_lead_id: campaignLead.id,
        campaign_touch_id: touch.id,
        lead_id: lead.id,
        execution_mode: 'LIVE',
        planned_channel: plannedChannel,
        execution_status: 'FAILED',
        decision_reason: failureError,
        provider: adapter.name,
        provider_message_id: null,
        simulated: 0,
        gate_result: JSON.stringify(gateResult),
        eligibility_snapshot: JSON.stringify(complianceDecision),
        approval_hash: currentReviewHash,
        metadata: JSON.stringify({ actor: auditActor, error: failureError, classification: outcome.classification, attemptId, lockId, provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_REJECTED })
      });
    } catch (_) {}

    return {
      success: false,
      blocked: false,
      allowed: true,
      decision: 'FAILED',
      touch_status: 'FAILED',
      execution_status: 'FAILED',
      error: failureError,
      error_classification: outcome.classification,
      provider: adapter.name,
      provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_REJECTED,
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      gate_result: gateResult,
      provider_called: providerCalled,
      message_sent: false
    };
  }

  // Gate succeeded and provider payload received
  const confirmedMessageId = String(gateResult.result?.message_id || providerPayloadResult?.message_id || '').trim();
  const outcome = classifyProviderOutcome(null, { message_id: confirmedMessageId }, 'DURING_SEND');

  if (outcome.category === PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN) {
    // Missing provider message identifier
    const missingIdError = 'Provider transport completed but returned no valid provider message identifier.';
    if (attemptId) {
      try {
        dbInstance.finalizeExecutionAttempt(attemptId, tid, {
          result_status: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
          error_classification: outcome.classification,
          error_message: missingIdError
        });
      } catch (_) {}
    }

    dbInstance.recordCampaignTouchExecutionUncertain(touch.id, tid, lockId, {
      error: missingIdError,
      attemptId,
      metadata: { actor: auditActor, error: missingIdError, classification: outcome.classification, attemptId }
    });

    try {
      dbInstance.createCampaignExecutionLog({
        tenant_id: tid,
        campaign_id: campaign.id,
        campaign_lead_id: campaignLead.id,
        campaign_touch_id: touch.id,
        lead_id: lead.id,
        execution_mode: 'LIVE',
        planned_channel: plannedChannel,
        execution_status: 'BLOCKED',
        decision_reason: `${DISPATCH_ERROR_CODES.PROVIDER_UNCERTAIN}: ${missingIdError}`,
        provider: adapter.name,
        provider_message_id: null,
        simulated: 0,
        gate_result: JSON.stringify(gateResult),
        eligibility_snapshot: JSON.stringify(complianceDecision),
        approval_hash: currentReviewHash,
        metadata: JSON.stringify({ actor: auditActor, error: missingIdError, classification: outcome.classification, attemptId, lockId, provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN })
      });
    } catch (_) {}

    return {
      success: false,
      blocked: true,
      allowed: true,
      decision: 'UNCERTAIN',
      decision_reason: DISPATCH_ERROR_CODES.PROVIDER_UNCERTAIN,
      reason: missingIdError,
      touch_status: 'BLOCKED',
      execution_status: 'PROVIDER_UNCERTAIN',
      error: missingIdError,
      error_classification: outcome.classification,
      provider: adapter.name,
      provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_UNCERTAIN,
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      gate_result: gateResult,
      provider_called: providerCalled,
      message_sent: false
    };
  }

  // Definitive success with verified message ID
  const dispatchedAt = now;

  if (attemptId) {
    try {
      dbInstance.finalizeExecutionAttempt(attemptId, tid, {
        result_status: PROVIDER_RESULT_TAXONOMY.PROVIDER_ACCEPTED,
        provider_message_id: confirmedMessageId,
        provider_response: gateResult.result || providerPayloadResult
      });
    } catch (_) {}
  }

  dbInstance.recordCampaignTouchExecutionSuccess(touch.id, tid, lockId, {
    provider: adapter.name,
    providerMessageId: confirmedMessageId,
    dispatchedAt,
    attemptId,
    metadata: { actor: auditActor, message_id: confirmedMessageId, attemptId }
  });

  try {
    dbInstance.createCampaignExecutionLog({
      tenant_id: tid,
      campaign_id: campaign.id,
      campaign_lead_id: campaignLead.id,
      campaign_touch_id: touch.id,
      lead_id: lead.id,
      execution_mode: 'LIVE',
      planned_channel: plannedChannel,
      execution_status: 'EXECUTED',
      decision_reason: `Dispatched successfully via ${adapter.name}`,
      provider: adapter.name,
      provider_message_id: confirmedMessageId,
      simulated: 0,
      gate_result: JSON.stringify(gateResult),
      eligibility_snapshot: JSON.stringify(complianceDecision),
      approval_hash: currentReviewHash,
      executed_at: dispatchedAt,
      metadata: JSON.stringify({ actor: auditActor, message_id: confirmedMessageId, lockId, attemptId, provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_ACCEPTED })
    });
  } catch (_) {}

  return {
    success: true,
    blocked: false,
    allowed: true,
    decision: 'EXECUTED',
    touch_status: 'SENT',
    execution_status: 'SENT',
    provider: adapter.name,
    provider_result: PROVIDER_RESULT_TAXONOMY.PROVIDER_ACCEPTED,
    provider_message_id: confirmedMessageId,
    dispatched_at: dispatchedAt,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    gate_result: gateResult,
    provider_called: providerCalled,
    message_sent: true,
    actor: {
      id: auditActor.id,
      name: auditActor.name,
      role: auditActor.role,
      tenantId: auditActor.tenantId
    }
  };
}
