/**
 * ==============================================================================
 * AI AutomationHubs - Core Compliance & Safety Engine
 * Module: compliance-engine.js
 * Version: 3.5 Enterprise
 *
 * Answers the core question:
 * "Is this lead/contact allowed to receive outreach on this channel RIGHT NOW?"
 *
 * Guarantees:
 * - Deterministic, explainable structured decisions
 * - Strict prioritization (Suppression > Max Attempts > Cooldown > Daily Quotas)
 * - Complete audit logging of every eligibility evaluation
 * - Strict FAIL-CLOSED security (no outreach allowed on error)
 * ==============================================================================
 */

import { db } from './database.js';
import { formatPhoneNumber, classifyPhoneType } from './scraper.js';
import { sendTelegramBroadcast } from './telegram-bot.js';

export const SUPPORTED_CHANNELS = ['whatsapp', 'telegram', 'email'];

export const REASON_CODES = {
  ALLOWED: 'ALLOWED',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  LEAD_NOT_FOUND: 'LEAD_NOT_FOUND',
  CONTACT_INVALID: 'CONTACT_INVALID',
  GLOBAL_SUPPRESSION: 'GLOBAL_SUPPRESSION',
  CHANNEL_SUPPRESSION: 'CHANNEL_SUPPRESSION',
  LEAD_OPTED_OUT: 'LEAD_OPTED_OUT',
  MAX_ATTEMPTS_REACHED: 'MAX_ATTEMPTS_REACHED',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  DAILY_QUOTA_EXCEEDED: 'DAILY_QUOTA_EXCEEDED',
  AUTHORIZATION_BLOCKED: 'AUTHORIZATION_BLOCKED',
  COMPLIANCE_CHECK_ERROR: 'COMPLIANCE_CHECK_ERROR'
};

/**
 * Retrieve centralized compliance and safety configuration.
 * Reads directly from SQLite settings via db.getSettings().
 */
export function getComplianceConfig() {
  const settings = db.getSettings();
  return {
    dailyLimits: {
      whatsapp: parseInt(settings.waDailyLimit, 10) || 50,
      telegram: parseInt(settings.tgDailyLimit, 10) || 30,
      email: parseInt(settings.emailDailyLimit, 10) || 100
    },
    cooldownHours: {
      whatsapp: parseInt(settings.waCooldownHours, 10) || 48,
      telegram: parseInt(settings.tgCooldownHours, 10) || 48,
      email: parseInt(settings.emailCooldownHours, 10) || 72
    },
    maxAttempts: {
      whatsapp: parseInt(settings.waMaxAttempts, 10) || 3,
      telegram: parseInt(settings.tgMaxAttempts, 10) || 3,
      email: parseInt(settings.emailMaxAttempts, 10) || 5
    }
  };
}

/**
 * Safely normalize contact identifiers based on channel requirements.
 * Reuses existing canonical scraper logic for phone numbers.
 *
 * @param {string} rawContact - Raw phone, email, or telegram handle
 * @param {string} channel - 'whatsapp', 'telegram', or 'email'
 * @returns {{ valid: boolean, identifier: string|null, type: string, error?: string }}
 */
export function normalizeContactIdentifier(rawContact, channel) {
  if (!rawContact || typeof rawContact !== 'string' || rawContact.trim() === '') {
    return { valid: false, identifier: null, type: 'unknown', error: 'Contact identifier is missing or empty' };
  }

  const ch = String(channel || '').toLowerCase().trim();
  const trimmed = rawContact.trim();

  // 1. WhatsApp Phone Normalization
  if (ch === 'whatsapp') {
    const classification = classifyPhoneType(trimmed);

    if (classification.type === 'in_landline') {
      return {
        valid: false,
        identifier: null,
        type: 'phone',
        error: `Landline detected (${classification.e164 || trimmed}). Landlines cannot receive WhatsApp messages.`
      };
    }

    if (!classification.isWhatsAppReady) {
      return {
        valid: false,
        identifier: null,
        type: 'phone',
        error: `Invalid or unroutable phone number format for WhatsApp: "${trimmed}"`
      };
    }

    const e164 = classification.e164 || formatPhoneNumber(trimmed);
    if (!e164 || !e164.startsWith('+') || e164.length < 8 || e164.length > 16) {
      return {
        valid: false,
        identifier: null,
        type: 'phone',
        error: `Failed to format phone number to E.164: "${trimmed}"`
      };
    }

    return { valid: true, identifier: e164, type: 'phone' };
  }

  // 2. Email Normalization
  if (ch === 'email') {
    const lower = trimmed.toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(lower)) {
      return {
        valid: false,
        identifier: null,
        type: 'email',
        error: `Invalid email address format: "${trimmed}"`
      };
    }
    return { valid: true, identifier: lower, type: 'email' };
  }

  // 3. Telegram Normalization (supports either @username or valid mobile phone)
  if (ch === 'telegram') {
    // If username or t.me link
    if (trimmed.startsWith('@') || trimmed.includes('t.me/')) {
      const username = trimmed.replace(/^@/, '').replace(/.*t\.me\//, '').trim().toLowerCase();
      if (username.length < 3 || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
        return {
          valid: false,
          identifier: null,
          type: 'telegram',
          error: `Invalid Telegram username format: "${trimmed}"`
        };
      }
      return { valid: true, identifier: '@' + username, type: 'telegram' };
    }

    // Otherwise evaluate as phone number
    const classification = classifyPhoneType(trimmed);
    if (classification.isMobile) {
      const e164 = classification.e164 || formatPhoneNumber(trimmed);
      return { valid: true, identifier: e164, type: 'telegram' };
    }

    return {
      valid: false,
      identifier: null,
      type: 'telegram',
      error: `Invalid Telegram identifier: "${trimmed}". Must be a valid @username or mobile number with country code.`
    };
  }

  return {
    valid: false,
    identifier: null,
    type: 'unknown',
    error: `Unsupported outreach channel: "${channel}"`
  };
}

/**
 * Determine the audit event type from a denial or approval reason code.
 */
function mapReasonCodeToAuditEvent(reasonCode) {
  switch (reasonCode) {
    case REASON_CODES.ALLOWED:
      return 'outreach_allowed';
    case REASON_CODES.COOLDOWN_ACTIVE:
      return 'cooldown_blocked';
    case REASON_CODES.DAILY_QUOTA_EXCEEDED:
      return 'quota_blocked';
    case REASON_CODES.CONTACT_INVALID:
    case REASON_CODES.INVALID_CHANNEL:
    case REASON_CODES.LEAD_NOT_FOUND:
      return 'invalid_contact_blocked';
    case REASON_CODES.GLOBAL_SUPPRESSION:
    case REASON_CODES.CHANNEL_SUPPRESSION:
    case REASON_CODES.LEAD_OPTED_OUT:
    case REASON_CODES.MAX_ATTEMPTS_REACHED:
      return 'outreach_blocked';
    case REASON_CODES.COMPLIANCE_CHECK_ERROR:
    default:
      return 'compliance_error';
  }
}

/**
 * CENTRAL ELIGIBILITY ENGINE:
 * Evaluates whether a lead/contact is permitted to receive outreach on the specified channel RIGHT NOW.
 *
 * Deterministic Decision Order:
 * 1. Channel validity
 * 2. Lead existence (if leadId provided)
 * 3. Contact identifier validity & normalization
 * 4. Global suppression check
 * 5. Channel-specific suppression check
 * 6. Lead-level opted-out flag
 * 7. Maximum outreach attempts check
 * 8. Cooldown window check
 * 9. Daily sending quota check
 * 10. ALLOWED
 *
 * Security: FAIL-CLOSED on any unexpected error.
 *
 * @param {object} params
 * @param {string} [params.leadId] - Lead ID
 * @param {string} params.channel - 'whatsapp', 'telegram', or 'email'
 * @param {string} [params.contactIdentifier] - Optional explicit phone/email/username
 * @param {object} [params.lead] - Optional preloaded lead object
 * @param {string} [params.tenantId='default'] - Tenant context
 * @param {boolean} [params.skipAudit=false] - If true, omits logging to compliance_audit_logs
 * @returns {Promise<{ allowed: boolean, reasonCode: string, reason: string, leadId: string|null, channel: string, contactIdentifier: string|null, checkedAt: string, details?: object }>}
 */
export async function checkOutreachEligibility({
  leadId = null,
  channel,
  contactIdentifier = null,
  lead = null,
  tenantId = 'default',
  skipAudit = false
}) {
  const checkedAt = new Date().toISOString();
  let ch = 'unknown';

  try {
    ch = String(channel || '').toLowerCase().trim();
    // ------------------------------------------------------------------------
    // Step 1: Channel Validity Check
    // ------------------------------------------------------------------------
    if (!SUPPORTED_CHANNELS.includes(ch)) {
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.INVALID_CHANNEL,
        reason: `Unsupported channel "${channel}". Supported channels: ${SUPPORTED_CHANNELS.join(', ')}`,
        leadId,
        channel: ch || 'invalid',
        contactIdentifier,
        checkedAt,
        tenantId,
        skipAudit
      });
    }

    // ------------------------------------------------------------------------
    // Step 2: Resolve Lead
    // ------------------------------------------------------------------------
    let targetLead = lead;
    if (!targetLead && leadId) {
      targetLead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) || null;
      if (!targetLead) {
        return buildDecision({
          allowed: false,
          reasonCode: REASON_CODES.LEAD_NOT_FOUND,
          reason: `Lead with ID "${leadId}" was not found in database`,
          leadId,
          channel: ch,
          contactIdentifier,
          checkedAt,
          tenantId,
          skipAudit
        });
      }
    }

    // ------------------------------------------------------------------------
    // Step 3: Resolve & Normalize Contact Identifier
    // ------------------------------------------------------------------------
    let rawContact = contactIdentifier;
    if (!rawContact && targetLead) {
      if (ch === 'whatsapp') rawContact = targetLead.phone;
      else if (ch === 'telegram') rawContact = targetLead.telegram || targetLead.phone;
      else if (ch === 'email') rawContact = targetLead.email;
    }

    const normalized = normalizeContactIdentifier(rawContact, ch);
    if (!normalized.valid) {
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.CONTACT_INVALID,
        reason: normalized.error || `Missing or invalid contact identifier for ${ch}`,
        leadId: targetLead?.id || leadId,
        channel: ch,
        contactIdentifier: rawContact || null,
        checkedAt,
        details: { rawContact },
        tenantId,
        skipAudit
      });
    }

    const finalContact = normalized.identifier;

    // ------------------------------------------------------------------------
    // Step 4: Global Suppression Check (Highest Priority Rule)
    // ------------------------------------------------------------------------
    const isGlobal = db.isGloballySuppressed(finalContact, tenantId);
    if (isGlobal) {
      const supRecord = db.getSuppression(finalContact, 'ALL', tenantId);
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.GLOBAL_SUPPRESSION,
        reason: `Contact ${finalContact} is globally suppressed (Reason: ${supRecord?.reason || 'GLOBAL_DO_NOT_CONTACT'})`,
        leadId: targetLead?.id || leadId,
        channel: ch,
        contactIdentifier: finalContact,
        checkedAt,
        details: { suppression: supRecord },
        tenantId,
        skipAudit
      });
    }

    // ------------------------------------------------------------------------
    // Step 5: Channel-Specific Suppression Check
    // ------------------------------------------------------------------------
    const isChannelSup = db.isChannelSuppressed(finalContact, ch, tenantId);
    if (isChannelSup) {
      const supRecord = db.getSuppression(finalContact, ch, tenantId);
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.CHANNEL_SUPPRESSION,
        reason: `Contact ${finalContact} is suppressed for channel "${ch}" (Reason: ${supRecord?.reason || 'CHANNEL_OPT_OUT'})`,
        leadId: targetLead?.id || leadId,
        channel: ch,
        contactIdentifier: finalContact,
        checkedAt,
        details: { suppression: supRecord },
        tenantId,
        skipAudit
      });
    }

    // ------------------------------------------------------------------------
    // Step 6: Lead-Level Opted-Out State Check
    // ------------------------------------------------------------------------
    if (targetLead && (targetLead.opted_out === 1 || targetLead.opted_out === '1' || targetLead.opted_out === true)) {
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.LEAD_OPTED_OUT,
        reason: `Lead "${targetLead.businessName || targetLead.id}" is marked as opted out (Source: ${targetLead.opted_out_source || 'Unknown'})`,
        leadId: targetLead.id,
        channel: ch,
        contactIdentifier: finalContact,
        checkedAt,
        details: { opted_out_at: targetLead.opted_out_at, opted_out_source: targetLead.opted_out_source },
        tenantId,
        skipAudit
      });
    }

    // Load centralized configuration
    const config = getComplianceConfig();

    // ------------------------------------------------------------------------
    // Step 7: Maximum Attempts Check
    // ------------------------------------------------------------------------
    let channelState = null;
    if (targetLead) {
      channelState = db.getChannelOutreachState(targetLead.id, ch);
      const maxAllowed = config.maxAttempts[ch] || 3;

      if (channelState && channelState.attempt_count >= maxAllowed) {
        return buildDecision({
          allowed: false,
          reasonCode: REASON_CODES.MAX_ATTEMPTS_REACHED,
          reason: `Maximum outreach attempts (${maxAllowed}) reached for channel "${ch}" (Attempts made: ${channelState.attempt_count})`,
          leadId: targetLead.id,
          channel: ch,
          contactIdentifier: finalContact,
          checkedAt,
          details: { attempt_count: channelState.attempt_count, maxAllowed },
          tenantId,
          skipAudit
        });
      }
    }

    // ------------------------------------------------------------------------
    // Step 8: Cooldown Check
    // ------------------------------------------------------------------------
    if (targetLead && channelState) {
      const nowMs = Date.now();

      // Check explicit next_eligible_at schedule
      if (channelState.next_eligible_at) {
        const nextEligibleMs = new Date(channelState.next_eligible_at).getTime();
        if (nextEligibleMs > nowMs) {
          return buildDecision({
            allowed: false,
            reasonCode: REASON_CODES.COOLDOWN_ACTIVE,
            reason: `Channel outreach cooldown active until ${channelState.next_eligible_at}`,
            leadId: targetLead.id,
            channel: ch,
            contactIdentifier: finalContact,
            checkedAt,
            details: { next_eligible_at: channelState.next_eligible_at },
            tenantId,
            skipAudit
          });
        }
      }

      // Check relative cooldown duration from last_attempt_at
      if (channelState.last_attempt_at) {
        const lastAttemptMs = new Date(channelState.last_attempt_at).getTime();
        const cooldownWindowMs = (config.cooldownHours[ch] || 48) * 3600000;
        const eligibleAtMs = lastAttemptMs + cooldownWindowMs;

        if (nowMs < eligibleAtMs) {
          const remainingHours = Math.max(1, Math.ceil((eligibleAtMs - nowMs) / 3600000));
          const nextEligibleStr = new Date(eligibleAtMs).toISOString();

          return buildDecision({
            allowed: false,
            reasonCode: REASON_CODES.COOLDOWN_ACTIVE,
            reason: `Outreach cooldown active for ${ch}. Contacted previously. Eligible again in ~${remainingHours}h (${nextEligibleStr})`,
            leadId: targetLead.id,
            channel: ch,
            contactIdentifier: finalContact,
            checkedAt,
            details: {
              last_attempt_at: channelState.last_attempt_at,
              cooldown_hours: config.cooldownHours[ch],
              next_eligible_at: nextEligibleStr
            },
            tenantId,
            skipAudit
          });
        }
      }
    }

    // ------------------------------------------------------------------------
    // Step 9: Daily Quota Check
    // ------------------------------------------------------------------------
    const todayStr = checkedAt.slice(0, 10);
    const quotaUsage = db.getDailyQuotaUsage(ch, todayStr, tenantId);
    const dailyLimit = config.dailyLimits[ch] || 50;
    const currentCount = quotaUsage?.attempt_count || 0;

    if (currentCount >= dailyLimit) {
      return buildDecision({
        allowed: false,
        reasonCode: REASON_CODES.DAILY_QUOTA_EXCEEDED,
        reason: `Daily outreach quota for "${ch}" has been reached (${currentCount}/${dailyLimit} on ${todayStr})`,
        leadId: targetLead?.id || leadId,
        channel: ch,
        contactIdentifier: finalContact,
        checkedAt,
        details: {
          channel: ch,
          date: todayStr,
          currentCount,
          dailyLimit,
          remaining: 0
        },
        tenantId,
        skipAudit
      });
    }

    // ------------------------------------------------------------------------
    // Step 10: Decision -> ALLOWED
    // ------------------------------------------------------------------------
    const remainingQuota = Math.max(0, dailyLimit - currentCount);

    return buildDecision({
      allowed: true,
      reasonCode: REASON_CODES.ALLOWED,
      reason: `Lead is eligible for outreach on channel "${ch}"`,
      leadId: targetLead?.id || leadId,
      channel: ch,
      contactIdentifier: finalContact,
      checkedAt,
      details: {
        attemptsMade: channelState?.attempt_count || 0,
        maxAttempts: config.maxAttempts[ch],
        remainingDailyQuota: remainingQuota,
        dailyLimit
      },
      tenantId,
      skipAudit
    });

  } catch (err) {
    // ------------------------------------------------------------------------
    // Step 11: Fail Closed Guard
    // ------------------------------------------------------------------------
    console.error(`🚨 [Compliance Engine] Critical check error on channel "${ch}":`, err);

    return buildDecision({
      allowed: false,
      reasonCode: REASON_CODES.COMPLIANCE_CHECK_ERROR,
      reason: `Compliance engine internal failure: ${err.message}`,
      leadId: lead?.id || leadId,
      channel: ch || 'unknown',
      contactIdentifier,
      checkedAt,
      details: { error: err.stack },
      tenantId,
      skipAudit
    });
  }
}

/**
 * Internal helper to format the decision object and record audit logs.
 */
function buildDecision({
  allowed,
  reasonCode,
  reason,
  leadId,
  channel,
  contactIdentifier,
  checkedAt,
  details = {},
  tenantId = 'default',
  skipAudit = false
}) {
  const decision = {
    allowed,
    reasonCode,
    reason,
    leadId: leadId || null,
    channel,
    contactIdentifier: contactIdentifier || null,
    checkedAt,
    details
  };

  if (!skipAudit) {
    try {
      const eventType = mapReasonCodeToAuditEvent(reasonCode);
      const auditDecision = allowed ? 'ALLOWED' : 'BLOCKED';

      db.createComplianceAuditLog({
        tenantId,
        leadId: leadId || null,
        channel,
        eventType,
        contactIdentifier: contactIdentifier || null,
        decision: auditDecision,
        reason: `${reasonCode}: ${reason}`,
        metadata: details
      });
    } catch (auditErr) {
      console.error('[Compliance Engine] Non-fatal: Failed to record audit log:', auditErr.message);
    }
  }

  return decision;
}

/**
 * Convenience helper to evaluate eligibility for a batch of leads.
 * Does not perform sending; returns partitioned eligible and blocked lists.
 *
 * @param {string[]} leadIds - Array of lead IDs
 * @param {string} channel - 'whatsapp', 'telegram', or 'email'
 * @param {object} [options]
 * @returns {Promise<{ eligible: object[], blocked: object[], summary: object }>}
 */
export async function checkBatchEligibility(leadIds, channel, options = {}) {
  const eligible = [];
  const blocked = [];
  const reasonsSummary = {};

  for (const id of leadIds) {
    const decision = await checkOutreachEligibility({
      leadId: id,
      channel,
      tenantId: options.tenantId || 'default',
      skipAudit: options.skipAudit || false
    });

    if (decision.allowed) {
      eligible.push(decision);
    } else {
      blocked.push(decision);
      reasonsSummary[decision.reasonCode] = (reasonsSummary[decision.reasonCode] || 0) + 1;
    }
  }

  return {
    channel,
    eligible,
    blocked,
    summary: {
      total: leadIds.length,
      allowedCount: eligible.length,
      blockedCount: blocked.length,
      reasonsSummary
    }
  };
}

// ==============================================================================
// INBOUND OPT-OUT / STOP PROTECTION ENGINE
// ==============================================================================

/**
 * Deterministic, phrase-aware opt-out detection.
 * Evaluates prospect messages for explicit intent to cease communications.
 *
 * Designed with strict false-positive guards:
 * - "Can you stop by our office tomorrow?" -> NOT opt-out
 * - "Please stop the meeting at 5 PM." -> NOT opt-out
 * - "Please stop messaging me." -> OPT-OUT
 *
 * @param {string} messageText - The raw inbound message text
 * @param {string} [defaultChannel='whatsapp'] - Ingress channel context
 * @returns {{ isOptOut: boolean, scope: 'GLOBAL'|'CHANNEL'|'TEMPORARY'|'NONE', channel: string|null, matchedPattern: string|null, matchedText?: string, confidence: number, reason?: string, expiresAt?: string|null, normalizedText?: string }}
 */
export function detectOptOut(messageText, defaultChannel = 'whatsapp') {
  if (!messageText || typeof messageText !== 'string') {
    return { isOptOut: false, scope: 'NONE', channel: null, matchedPattern: null, confidence: 0 };
  }

  const raw = messageText.trim();
  if (!raw) {
    return { isOptOut: false, scope: 'NONE', channel: null, matchedPattern: null, confidence: 0 };
  }

  // 1. Multi-lingual Token Normalization
  let lower = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  // Hinglish / phonetic spelling normalizations
  lower = lower
    .replace(/\b(msg|massage|mesage)\b/g, 'message')
    .replace(/\b(mtt|maat)\b/g, 'mat')
    .replace(/\b(kro|krna|karna|kre|karein|kijiye)\b/g, 'karo')
    .replace(/\b(muje|hume|humko|mereko)\b/g, 'mujhe')
    .replace(/\b(nhi|nahin|nai)\b/g, 'nahi')
    .replace(/\b(dubara|dubaara|phir|fir)\b/g, 'dobara')
    .replace(/\b(whats\s*app|watsapp|wa)\b/g, 'whatsapp');

  const stripped = lower.replace(/^[^\w\s@#+]+|[^\w\s@#+]+$/g, '').trim();

  // 2. Preceding Negation Guard
  // Reject phrases where negation immediately precedes stop or cease directives
  const negationGuards = [
    /\b(do\s*not|don'?t|never|mat|nahi|band\s+mat)\s+(stop|band|cease|halt|roko)\b/i,
    /\b(didn'?t|did\s+not)\s+say\s+stop\b/i
  ];
  for (const ng of negationGuards) {
    if (ng.test(lower)) {
      return {
        isOptOut: false,
        scope: 'NONE',
        channel: null,
        matchedPattern: null,
        confidence: 0,
        reason: 'Negation preceding stop directive'
      };
    }
  }

  // 3. False-Positive Protection
  // Reject colloquial usages, physical visits, meeting timers, scheduling or format preferences
  const falsePositivePatterns = [
    /\bstop\s+by\b/i,
    /\bstop\s+in\b/i,
    /\bbus\s+stop\b/i,
    /\bmetro\s+stop\b/i,
    /\bfull\s+stop\b/i,
    /\bpit\s+stop\b/i,
    /\bstop\s+the\s+(meeting|campaign|project|call|service|video|audio|recording|timer|clock|car|music|train|press)\b/i,
    /\bstop\s+at\s+(\d+|the\s+)/i,
    /\b(abhi|now)\s+mat\s+(bhejo|karo)\b/i,
    /\bmat\s+(bhejo|karo)\s+(abhi|now)\b/i,
    /\b(pdf|link|brochure|image|photo|video)\s+mat\s+(bhejo|send)\b/i,
    /\b(price|pricing|rate|cost)\s+mat\s+(batao|bhejo)\b/i,
    /\bremove\s+(the\s+)?(second|item|old\s+quote|quotation|line)\b/i,
    /\bno\s+problem\b/i,
    /\bno\s+worries\b/i,
    /\bno\s+doubt\b/i,
    /\bnot\s+a\s+bad\s+idea\b/i,
    /\b(don'?t|do\s*not)\s+worry\b/i,
    /\b(don'?t|do\s*not)\s+hesitate\b/i,
    /\bi\s+stopped\s+using\s+my\s+old\b/i
  ];

  for (const fp of falsePositivePatterns) {
    if (fp.test(lower)) {
      return {
        isOptOut: false,
        scope: 'NONE',
        channel: null,
        matchedPattern: null,
        confidence: 0,
        reason: 'False-positive guard matched'
      };
    }
  }

  // 4. Standalone Global Opt-Out Directives (Confidence 1.0)
  const standalonePattern = /^(please\s+|kindly\s+|plz\s+)?(stop|unsubscribe|cancel|optout|opt\s+out|quit|end|halt|remove|discontinue)(\s+(please|thanks|thank\s+you|plz))?$/i;
  if (standalonePattern.test(stripped)) {
    return {
      isOptOut: true,
      scope: 'GLOBAL',
      channel: null,
      matchedPattern: 'STANDALONE_OPT_OUT',
      matchedText: raw,
      confidence: 1.0,
      normalizedText: lower
    };
  }

  // 5. Channel-Specific Directives
  // Channel switching: "Don't WhatsApp me, send email" or "No WhatsApp, email is fine"
  const channelSwitchPattern = /\b(no|don'?t|do\s*not|mat)\s+whatsapp\b.*\b(email|mail|call)\b/i;
  if (channelSwitchPattern.test(lower)) {
    return {
      isOptOut: true,
      scope: 'CHANNEL',
      channel: 'whatsapp',
      matchedPattern: 'CHANNEL_OPT_OUT_WHATSAPP_REDIRECT',
      matchedText: raw,
      confidence: 0.95,
      normalizedText: lower
    };
  }

  const whatsappSpecific = [
    /\b(do\s*not|don'?t|stop|no\s+more|never)\s+whatsapp\b/i,
    /\bwhatsapp\s+(mat\s+karo|band\s+karo|pe\s+message\s+mat\s+karo)\b/i,
    /\bstop\s+whatsapp\s+messages?\b/i
  ];
  for (const p of whatsappSpecific) {
    if (p.test(lower)) {
      return {
        isOptOut: true,
        scope: 'CHANNEL',
        channel: 'whatsapp',
        matchedPattern: 'CHANNEL_OPT_OUT_WHATSAPP',
        matchedText: raw,
        confidence: 0.95,
        normalizedText: lower
      };
    }
  }

  const callSpecific = [
    /\b(do\s*not|don'?t|stop|no\s+more|never)\s+(call|calling)\b/i,
    /\b(call|phone)\s+mat\s+karo\b/i,
    /\bphone\s+mat\s+karna\b/i
  ];
  for (const p of callSpecific) {
    if (p.test(lower)) {
      return {
        isOptOut: true,
        scope: 'CHANNEL',
        channel: 'call',
        matchedPattern: 'CHANNEL_OPT_OUT_CALL',
        matchedText: raw,
        confidence: 0.95,
        normalizedText: lower
      };
    }
  }

  const emailSpecific = [
    /\b(do\s*not|don'?t|stop|no\s+more|never)\s+(email|emailing)\b/i,
    /\b(email|mail)\s+mat\s+(karo|bhejo)\b/i,
    /\bunsubscribe\s+from\s+email\b/i
  ];
  for (const p of emailSpecific) {
    if (p.test(lower)) {
      return {
        isOptOut: true,
        scope: 'CHANNEL',
        channel: 'email',
        matchedPattern: 'CHANNEL_OPT_OUT_EMAIL',
        matchedText: raw,
        confidence: 0.95,
        normalizedText: lower
      };
    }
  }

  // 6. Temporary Cease Requests
  const temporaryPatterns = [
    /\b(stop|don'?t\s+message|pause)\s+(for\s+now|today|this\s+week)\b/i,
    /\b(abhi|kal\s+tak)\s+mat\s+bhejo\b/i
  ];
  for (const p of temporaryPatterns) {
    if (p.test(lower)) {
      const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      return {
        isOptOut: true,
        scope: 'TEMPORARY',
        channel: defaultChannel,
        expiresAt,
        matchedPattern: 'TEMPORARY_OPT_OUT',
        matchedText: raw,
        confidence: 0.90,
        normalizedText: lower
      };
    }
  }

  // 7. Multi-Word Explicit Global Opt-Out & Cease-Communication Phrases
  const explicitGlobalPatterns = [
    // Unsubscribe variants
    /\b(please\s+|plz\s+)?unsubscribe(\s+me)?\b/i,
    /\bopt\s*out\b/i,

    // Removal from list / database
    /\bremove\s+(me|my\s+number|our\s+number|this\s+number|my\s+email|our\s+email|this\s+email|us)\b/i,
    /\bremove\s+(?:.*?\s+)?from\s+(?:your\s+|the\s+)?(?:list|database)\b/i,
    /\bdelete\s+(me|my\s+number|our\s+number|my\s+contact|my\s+details|my\s+email|our\s+email|this\s+number|us)\b/i,
    /\btake\s+(me|my\s+number|our\s+number|us)\s+off(\s+(your|the)\s+(list|database))?\b/i,
    /\btake\s+me\s+off\s+your\s+list\b/i,

    // Cease communication directives
    /\b(do\s*not|don'?t)\s+(contact|message|text|reach\s+out|bother|spam)(\s+(me|us|our\s+company))?\b/i,
    /\bnever\s+(contact|message|text|reach\s+out)(\s+(me|us))?\b/i,
    /\bnever\s+contact\s+me\s+again\b/i,

    // Stop + communication action
    /\bstop\s+(messaging|contacting|texting|sending|bothering|spamming)(\s+(me|us|our\s+company))?\b/i,
    /\bstop\s+it\b/i,

    // "No more" directives
    /\bno\s+more\s+(messages|texts|marketing|promo|promotions)\b/i,

    // Leave alone
    /\bleave\s+(me|us)\s+alone\b/i,
    /\bbother\s+someone\s+else\b/i,

    // Wrong number / Not interested + Stop
    /\bwrong\s+number\b/i,
    /\bnot\s+interested\s+(please\s+|plz\s+)?stop\b/i,

    // Common Hindi / Hinglish opt-out expressions
    /\b(mat\s+bhejo|message\s+mat\s+karo|mujhe\s+message\s+mat\s+karo|band\s+karo)\b/i,
    /\b(ye\s+(sab\s+)?messages?\s+band\s+karo)\b/i,
    /\b(pareshan|disturb|spam)\s+mat\s+karo\b/i,
    /\b(list\s+se\s+(hata|nikal)\s+do|hata\s+do\s+(mujhe|mera\s+number))\b/i,
    /\b(mera\s+number\s+delete\s+karo|delete\s+kar\s+do\s+mera\s+number|number\s+delete\s+karo)\b/i,
    /\b(dobara|aage\s+se)\s+(message\s+|contact\s+)?mat\s+(karo|bhejna|bhejo)\b/i,
    /\bkripya\s+message\s+na\s+(karein|karo|bheje|bhejo)\b/i,
    /\b(nahi\s+chahiye|interest\s+nahi\s+hai)\s+(stop|mat\s+bhejo|band\s+karo)\b/i
  ];

  for (const pattern of explicitGlobalPatterns) {
    if (pattern.test(lower)) {
      return {
        isOptOut: true,
        scope: 'GLOBAL',
        channel: null,
        matchedPattern: pattern.toString(),
        matchedText: raw,
        confidence: 0.95,
        normalizedText: lower
      };
    }
  }

  return { isOptOut: false, scope: 'NONE', channel: null, matchedPattern: null, confidence: 0 };
}

/**
 * Handle detected inbound opt-out immediately before reaching AI sales pipeline.
 * Deterministically applies multi-tenant suppression, updates safety state, and decouples
 * channel-specific opt-out from global lead qualification.
 *
 * @param {object} params
 * @param {string} params.senderPhone - Phone digits of sender
 * @param {string} params.incomingText - The message received
 * @param {string} [params.matchedPattern] - Name or regex of pattern that matched
 * @param {object} [params.lead] - Matched lead object if found
 * @param {Function} [params.broadcastFn] - SSE broadcast function
 * @param {string} [params.tenantId='default'] - Tenant context
 * @param {string|null} [params.conversationId] - Conversation thread ID if matched
 * @param {string|null} [params.messageId] - Ingested message ID
 * @param {'GLOBAL'|'CHANNEL'|'TEMPORARY'} [params.scope='GLOBAL'] - Opt-out scope
 * @param {string} [params.targetChannel='whatsapp'] - Target channel
 * @param {string|null} [params.expiresAt] - Expiration timestamp for temporary opt-out
 * @returns {Promise<{ success: boolean, normalizedPhone: string, leadId: string|null, leadName: string, suppressedAt: string, scope: string }>}
 */
export async function handleInboundOptOut({
  senderPhone,
  incomingText,
  matchedPattern = 'EXPLICIT_OPT_OUT',
  lead = null,
  broadcastFn = null,
  tenantId = 'default',
  conversationId = null,
  messageId = null,
  scope = 'GLOBAL',
  targetChannel = 'whatsapp',
  expiresAt = null
}) {
  const now = new Date().toISOString();
  const rawDigits = String(senderPhone || '').replace(/\D/g, '');
  const normalizedPhone = rawDigits.startsWith('+') ? rawDigits : ('+' + rawDigits);
  const leadName = lead ? lead.businessName : normalizedPhone;
  const leadId = lead ? lead.id : null;
  const ch = String(targetChannel || 'whatsapp').toLowerCase().trim();

  console.warn(`🛑 [Compliance Engine] Processing Opt-Out (${scope}) for "${leadName}" (${normalizedPhone}) on channel "${ch}" - Pattern: ${matchedPattern}`);

  // 1. Create Suppression in SQLite (idempotent ON CONFLICT)
  try {
    db.createSuppression({
      tenantId,
      leadId,
      normalizedContact: normalizedPhone,
      contactType: 'phone',
      channel: scope === 'GLOBAL' ? 'ALL' : ch,
      originalContact: `+${rawDigits}`,
      reason: scope === 'GLOBAL' ? 'inbound_global_opt_out' : `inbound_${ch}_opt_out`,
      source: `${ch}_inbound`,
      expiresAt: expiresAt || null,
      notes: `Prospect replied with ${scope} opt-out: "${incomingText.substring(0, 100)}"`
    });
  } catch (supErr) {
    console.error('[Inbound Opt-Out] Error creating suppression record:', supErr.message);
  }

  // 2. Update Lead Safety State & Lead Status
  if (leadId) {
    try {
      if (scope === 'GLOBAL') {
        db.updateLeadSafetyState(leadId, {
          opted_out: 1,
          opted_out_at: now,
          opted_out_source: `${ch}_inbound`,
          last_inbound_at: now
        });

        // Global opt-out: Move pipeline to Unqualified (NEVER 'Interested'!)
        db.updateLead(leadId, {
          leadStatus: 'Unqualified',
          lastReplyText: incomingText,
          lastReplyAt: now
        });
      } else {
        // Channel-specific suppression: Record in channel_outreach_state, preserve leadStatus for other channels
        db.updateChannelOutreachState(leadId, ch, {
          blocked_reason: 'CHANNEL_OPT_OUT',
          last_result: 'Suppressed'
        });
        db.updateLead(leadId, {
          lastReplyText: incomingText,
          lastReplyAt: now,
          last_inbound_at: now
        });
      }
    } catch (leadErr) {
      console.error('[Inbound Opt-Out] Error updating lead safety state:', leadErr.message);
    }
  }

  // 3. Update Conversation Status to OPTED_OUT
  if (conversationId) {
    try {
      db.updateConversationStatus(conversationId, 'OPTED_OUT', tenantId);
    } catch (convErr) {
      console.error('[Inbound Opt-Out] Error updating conversation status:', convErr.message);
    }
  }

  // 4. Compliance Audit Log (do NOT log full message body)
  try {
    db.createComplianceAuditLog({
      tenantId,
      leadId,
      channel: ch,
      eventType: scope === 'GLOBAL' ? 'opt_out_detected' : 'channel_opt_out_detected',
      contactIdentifier: normalizedPhone,
      decision: 'BLOCKED',
      reason: scope === 'GLOBAL' ? 'inbound_global_opt_out' : `inbound_${ch}_opt_out`,
      metadata: {
        matchedPattern: String(matchedPattern),
        scope,
        channel: ch,
        source: `${ch}_inbound`,
        leadName,
        conversationId,
        messageId
      }
    });
  } catch (auditErr) {
    console.error('[Inbound Opt-Out] Error writing audit log:', auditErr.message);
  }

  // 5. Send Founder Telegram Alert (isolated in try/catch so failure never blocks suppression)
  try {
    const alertHtml = [
      `🛑 <b>Opt-Out Received & Suppressed (${scope})</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `🏢 <b>Lead:</b> ${escapeHtml(leadName)}`,
      `📞 <b>Phone:</b> ${normalizedPhone}`,
      lead?.location ? `📍 <b>Location:</b> ${escapeHtml(lead.location)}` : '',
      `🏷️ <b>Action Taken:</b> ${scope === 'GLOBAL' ? 'Global Opt-Out (All Channels Suppressed)' : `Channel Opt-Out (${ch.toUpperCase()} Suppressed)`}`,
      ``,
      `💬 <b>Client Message:</b>`,
      `<i>"${escapeHtml(incomingText.substring(0, 100))}"</i>`,
      `🔍 <b>Pattern:</b> <code>${escapeHtml(String(matchedPattern))}</code>`,
      ``,
      `⛔ <i>AI sales reply generator halted. Outbound messaging is now blocked on target channel.</i>`
    ].filter(Boolean).join('\n');

    await sendTelegramBroadcast(alertHtml, { parse_mode: 'HTML' });
  } catch (tgErr) {
    console.error('[Inbound Opt-Out] Non-fatal: Founder Telegram alert failed:', tgErr.message);
  }

  // 6. Broadcast real-time SSE to Dashboard
  if (broadcastFn) {
    try {
      broadcastFn({
        type: 'opt-out-received',
        phone: rawDigits,
        leadId,
        leadName,
        scope,
        channel: ch,
        matchedPattern: String(matchedPattern)
      });
      broadcastFn({
        type: 'log',
        message: `🛑 Opt-out (${scope}) received from "${leadName}" (+${rawDigits}). Contact suppressed on ${scope === 'GLOBAL' ? 'ALL channels' : ch}.`
      });
      broadcastFn({ type: 'leads-updated' });
    } catch (_) {}
  }

  return {
    success: true,
    normalizedPhone,
    leadId,
    leadName,
    suppressedAt: now,
    scope
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==============================================================================
// OUTBOUND COMPLIANCE GATE & ATOMIC SAFETY ENGINE
// ==============================================================================

/**
 * Validate requester authorization and tenant boundaries.
 * Prevents unauthorized or cross-tenant dispatch.
 *
 * @param {object} params
 * @param {string} [params.leadId]
 * @param {object} [params.lead]
 * @param {string} [params.tenantId='default']
 * @param {object} [params.req]
 * @returns {{ authorized: boolean, reason?: string, reasonCode?: string, lead?: object, tenantId: string }}
 */
export function validateOutreachAuthorization({
  leadId = null,
  lead = null,
  tenantId = 'default',
  req = null
} = {}) {
  // 1. Resolve requested tenant from req context if available
  const requestedTenant = (req?.headers?.['x-tenant-id'] || req?.body?.tenantId || tenantId || 'default').trim();

  // 2. If an explicit leadId is provided, validate ownership via database
  if (leadId) {
    const ownership = db.validateLeadOwnership(leadId, requestedTenant);
    if (!ownership.valid) {
      return {
        authorized: false,
        reason: ownership.reason,
        reasonCode: ownership.notFound ? REASON_CODES.LEAD_NOT_FOUND : REASON_CODES.AUTHORIZATION_BLOCKED,
        lead: ownership.lead || null,
        tenantId: requestedTenant
      };
    }
    return { authorized: true, tenantId: requestedTenant, lead: ownership.lead };
  }

  // 3. If a preloaded lead object is provided
  if (lead) {
    const leadTenant = lead.tenant_id || 'default';
    if (leadTenant !== requestedTenant) {
      return {
        authorized: false,
        reason: `Cross-tenant access violation: lead belongs to tenant "${leadTenant}", requested by "${requestedTenant}"`,
        reasonCode: REASON_CODES.AUTHORIZATION_BLOCKED,
        lead,
        tenantId: requestedTenant
      };
    }
    return { authorized: true, tenantId: requestedTenant, lead };
  }

  return { authorized: true, tenantId: requestedTenant, lead: null };
}

/**
 * MANDATORY OUTBOUND COMPLIANCE GATE & ATOMIC SAFETY ENGINE
 *
 * Executes the full outbound safety lifecycle:
 * 1. Authorization & Tenant Boundary Validation
 * 2. Pre-flight Eligibility Check (checkOutreachEligibility)
 * 3. Atomic Daily Quota Reservation (reserveDailyQuota)
 * 4. Attempt State Recording (channel_outreach_state, leads)
 * 5. Sender Execution (sendFn)
 * 6. Result & Success Quota Tracking
 *
 * Security: FAIL-CLOSED on any unexpected error.
 *
 * @param {object} params
 * @param {string} [params.leadId]
 * @param {object} [params.lead]
 * @param {string} params.channel - 'whatsapp', 'telegram', or 'email'
 * @param {string} [params.contactIdentifier]
 * @param {string} [params.tenantId='default']
 * @param {Function} params.sendFn - Async callback executing the low-level transport
 * @param {object} [params.req] - Express request object for auth/tenant inspection
 * @returns {Promise<{ success: boolean, blocked: boolean, allowed: boolean, reasonCode?: string, reason?: string, result?: any, error?: string, compliance: object }>}
 */
export async function executeOutreachGate({
  leadId = null,
  lead = null,
  channel,
  contactIdentifier = null,
  tenantId = 'default',
  sendFn,
  req = null
}) {
  const ch = String(channel || '').toLowerCase().trim();
  const checkedAt = new Date().toISOString();

  try {
    // ------------------------------------------------------------------------
    // Step 1: Authorization & Ownership Validation
    // ------------------------------------------------------------------------
    const authCheck = validateOutreachAuthorization({ leadId, lead, tenantId, req });
    if (!authCheck.authorized) {
      try {
        db.createComplianceAuditLog({
          tenantId: authCheck.tenantId || tenantId,
          leadId: leadId || lead?.id || null,
          channel: ch,
          eventType: 'authorization_blocked',
          contactIdentifier: contactIdentifier || lead?.phone || null,
          decision: 'BLOCKED',
          reason: authCheck.reason
        });
      } catch (_) {}

      return {
        success: false,
        blocked: true,
        allowed: false,
        reasonCode: authCheck.reasonCode || REASON_CODES.AUTHORIZATION_BLOCKED,
        reason: authCheck.reason,
        compliance: { allowed: false, checkedAt }
      };
    }

    const effectiveTenantId = authCheck.tenantId || tenantId;
    const resolvedLead = authCheck.lead || lead;
    const targetLeadId = resolvedLead?.id || leadId;

    // ------------------------------------------------------------------------
    // Step 2: Central Pre-flight Eligibility Check
    // ------------------------------------------------------------------------
    const eligibility = await checkOutreachEligibility({
      leadId: targetLeadId,
      lead: resolvedLead,
      channel: ch,
      contactIdentifier,
      tenantId: effectiveTenantId
    });

    if (!eligibility.allowed) {
      return {
        success: false,
        blocked: true,
        allowed: false,
        reasonCode: eligibility.reasonCode,
        reason: eligibility.reason,
        decision: eligibility,
        compliance: {
          allowed: false,
          reasonCode: eligibility.reasonCode,
          reason: eligibility.reason,
          checkedAt
        }
      };
    }

    // ------------------------------------------------------------------------
    // Step 3: Atomic Daily Quota Reservation
    // ------------------------------------------------------------------------
    const config = getComplianceConfig();
    const dailyLimit = config.dailyLimits[ch] || 50;

    const reservation = db.reserveDailyQuota(ch, null, effectiveTenantId, dailyLimit);
    if (!reservation.reserved) {
      try {
        db.createComplianceAuditLog({
          tenantId: effectiveTenantId,
          leadId: targetLeadId,
          channel: ch,
          eventType: 'quota_blocked',
          contactIdentifier: eligibility.contactIdentifier || contactIdentifier,
          decision: 'BLOCKED',
          reason: reservation.reason
        });
      } catch (_) {}

      return {
        success: false,
        blocked: true,
        allowed: false,
        reasonCode: REASON_CODES.DAILY_QUOTA_EXCEEDED,
        reason: reservation.reason,
        compliance: {
          allowed: false,
          reasonCode: REASON_CODES.DAILY_QUOTA_EXCEEDED,
          reason: reservation.reason,
          currentCount: reservation.currentCount,
          limit: dailyLimit,
          checkedAt
        }
      };
    }

    // ------------------------------------------------------------------------
    // Step 4: Record Outbound Attempt & Cooldown Window
    // ------------------------------------------------------------------------
    const cooldownHours = config.cooldownHours[ch] || 48;
    const nextEligibleAt = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();

    if (targetLeadId) {
      try {
        db.incrementChannelOutreachAttempt(targetLeadId, ch, {
          result: 'Attempted',
          nextEligibleAt
        });
      } catch (attErr) {
        console.error('[Outreach Gate] Failed to record channel attempt:', attErr.message);
      }
    }

    // ------------------------------------------------------------------------
    // Step 5: Execute Sender Function
    // ------------------------------------------------------------------------
    if (typeof sendFn !== 'function') {
      throw new Error('Missing or invalid sendFn transport function in executeOutreachGate');
    }

    let senderResult;
    try {
      senderResult = await sendFn(resolvedLead);
    } catch (sendError) {
      // Dispatch failed at transport level
      console.error(`❌ [Outreach Gate] Transport dispatch failed on channel "${ch}":`, sendError.message);

      if (targetLeadId) {
        try {
          db.updateChannelOutreachState(targetLeadId, ch, {
            last_result: 'Failed',
            blocked_reason: sendError.message
          });
        } catch (_) {}
      }

      try {
        db.createComplianceAuditLog({
          tenantId: effectiveTenantId,
          leadId: targetLeadId,
          channel: ch,
          eventType: 'outreach_failed',
          contactIdentifier: eligibility.contactIdentifier,
          decision: 'ALLOWED_BUT_FAILED',
          reason: sendError.message,
          metadata: {
            error: sendError.message,
            channel: ch,
            leadId: targetLeadId
          }
        });
      } catch (_) {}

      return {
        success: false,
        blocked: false,
        allowed: true,
        error: sendError.message,
        compliance: {
          allowed: true,
          quotaUsed: reservation.currentCount,
          limit: dailyLimit,
          checkedAt
        }
      };
    }

    // ------------------------------------------------------------------------
    // Step 6: Update Success State & Audit Trail
    // ------------------------------------------------------------------------
    try {
      db.incrementDailyQuota(ch, null, effectiveTenantId, 'success');
    } catch (_) {}

    if (targetLeadId) {
      try {
        db.updateChannelOutreachState(targetLeadId, ch, {
          last_result: 'Success',
          blocked_reason: null
        });
      } catch (_) {}
    }

    try {
      db.createComplianceAuditLog({
        tenantId: effectiveTenantId,
        leadId: targetLeadId,
        channel: ch,
        eventType: 'outreach_allowed',
        contactIdentifier: eligibility.contactIdentifier,
        decision: 'ALLOWED',
        reason: 'Outreach dispatched successfully',
        metadata: {
          channel: ch,
          leadId: targetLeadId,
          quotaCount: reservation.currentCount
        }
      });
    } catch (_) {}

    return {
      success: true,
      blocked: false,
      allowed: true,
      result: senderResult,
      compliance: {
        allowed: true,
        currentCount: reservation.currentCount,
        limit: dailyLimit,
        checkedAt
      }
    };

  } catch (error) {
    // Critical safety failure - FAIL CLOSED
    console.error(`🚨 [Outreach Gate] Fail-closed caught exception on channel "${ch}":`, error.message);

    try {
      db.createComplianceAuditLog({
        tenantId,
        leadId: lead?.id || leadId || null,
        channel: ch || 'unknown',
        eventType: 'compliance_error',
        contactIdentifier: contactIdentifier || lead?.phone || null,
        decision: 'BLOCKED',
        reason: `Outreach gate internal error: ${error.message}`
      });
    } catch (_) {}

    return {
      success: false,
      blocked: true,
      allowed: false,
      reasonCode: REASON_CODES.COMPLIANCE_CHECK_ERROR,
      reason: `Safety engine failure: ${error.message}. Outbound dispatch strictly blocked.`,
      compliance: { allowed: false, checkedAt }
    };
  }
}

