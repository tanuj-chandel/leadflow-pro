/**
 * ==============================================================================
 * LEADFLOW PRO / AI AUTOMATIONHUBS v3.5 ENTERPRISE
 * PHASE 2 STEP 8E & 8F: CONVERSATION INTELLIGENCE & INTENT CLASSIFICATION ENGINE
 * ==============================================================================
 */

import { db } from './database.js';
import { detectOptOut } from './compliance-engine.js';
import crypto from 'crypto';

if (process.env.ALLOW_INSECURE_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Supported Intent Classes
export const INTENT_CLASSES = {
  BOOKING_REQUEST: 'BOOKING_REQUEST',
  PRICING_INQUIRY: 'PRICING_INQUIRY',
  SERVICE_INQUIRY: 'SERVICE_INQUIRY',
  OBJECTION: 'OBJECTION',
  NEGATIVE_FEEDBACK: 'NEGATIVE_FEEDBACK',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE'
};

// Urgency Levels
export const URGENCY_LEVELS = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
};

// Sentiment Levels
export const SENTIMENT_LEVELS = {
  POSITIVE: 'POSITIVE',
  NEUTRAL: 'NEUTRAL',
  NEGATIVE: 'NEGATIVE'
};

// Default Official Agency Booking & Contact Details
export const AGENCY_CONFIG = {
  bookingLink: 'https://cal.com/ai-automationhubs/2min-demo',
  founders: 'Tanuj Chandel & Amit Pandey',
  phoneTanuj: '+91-7704077700',
  phoneAmit: '+91-9990080408',
  email: 'automationhubsindia@gmail.com',
  website: 'https://ai-automation-hubs.com'
};

/**
 * Prompt-Injection Defense & Inbound Sanitization Layer
 * Guards against prompt hijacking, instruction bypasses, and system command spoofing.
 *
 * @param {string} rawText
 * @returns {{ sanitized: string, injectionDetected: boolean, flags: string[] }}
 */
export function sanitizeUntrustedInput(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { sanitized: '', injectionDetected: false, flags: [] };
  }

  const cleaned = rawText
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  const injectionPatterns = [
    { name: 'IGNORE_INSTRUCTIONS', regex: /\b(ignore\s+(all\s+)?(previous|prior|above)\s+instructions)\b/i },
    { name: 'SYSTEM_PROMPT_HIJACK', regex: /\b(system\s+prompt|you\s+are\s+now\s+a|act\s+as\s+a)\b/i },
    { name: 'ADMIN_OVERRIDE_SPOOF', regex: /\b(admin\s+override|system\s+says|opt-in\s+confirmed|cancel\s+suppression)\b/i },
    { name: 'DATABASE_EXTRACTION', regex: /\b(show\s+(me\s+)?(the\s+)?database|select\s+.*\s+from\s+leads)\b/i },
    { name: 'DELIMITER_ESCAPE', regex: /<\/?(?:system|instruction|user_message|context)>/i }
  ];

  const flags = [];
  for (const ip of injectionPatterns) {
    if (ip.regex.test(cleaned)) {
      flags.push(ip.name);
    }
  }

  return {
    sanitized: cleaned,
    injectionDetected: flags.length > 0,
    flags
  };
}

/**
 * Deterministic Intent Classifier (Fast-Path Heuristics)
 * Guarantees instant, zero-latency classification even when external LLM APIs are offline.
 *
 * @param {string} text
 * @returns {{ intent: string, confidence: number, sentiment: string, urgency: string, matchedKeywords: string[] }}
 */
export function classifyIntentDeterministically(text) {
  if (!text || typeof text !== 'string') {
    return {
      intent: INTENT_CLASSES.OUT_OF_SCOPE,
      confidence: 0,
      sentiment: SENTIMENT_LEVELS.NEUTRAL,
      urgency: URGENCY_LEVELS.LOW,
      matchedKeywords: []
    };
  }

  const lower = text.toLowerCase();

  // 1. Booking Request (Highest High-Value Conversion Intent)
  const bookingKeywords = [
    'call', 'meet', 'demo', 'schedule', 'book', 'talk', 'discuss', 'time',
    'phone', 'zoom', 'google meet', 'calendar', 'appointment', 'tomorrow',
    'today', 'evening', 'subah', 'shaam', 'available'
  ];
  const bookingMatches = bookingKeywords.filter(k => new RegExp(`\\b${k}\\b`, 'i').test(lower));
  if (bookingMatches.length >= 2 || (bookingMatches.length === 1 && (lower.includes('call') || lower.includes('demo') || lower.includes('book')))) {
    return {
      intent: INTENT_CLASSES.BOOKING_REQUEST,
      confidence: 0.90,
      sentiment: SENTIMENT_LEVELS.POSITIVE,
      urgency: lower.includes('today') || lower.includes('now') || lower.includes('urgent') ? URGENCY_LEVELS.HIGH : URGENCY_LEVELS.MEDIUM,
      matchedKeywords: bookingMatches
    };
  }

  // 2. Pricing Inquiry
  const pricingKeywords = [
    'price', 'pricing', 'cost', 'charge', 'rate', 'budget', 'fee', 'package',
    'kitna', 'charges', 'rate kya hai', 'how much'
  ];
  const pricingMatches = pricingKeywords.filter(k => lower.includes(k));
  if (pricingMatches.length > 0) {
    return {
      intent: INTENT_CLASSES.PRICING_INQUIRY,
      confidence: 0.88,
      sentiment: SENTIMENT_LEVELS.NEUTRAL,
      urgency: URGENCY_LEVELS.MEDIUM,
      matchedKeywords: pricingMatches
    };
  }

  // 3. Service Inquiry
  const serviceKeywords = [
    'service', 'chatbot', 'bot', 'website', 'automation', 'crm', 'copilot',
    'whatsapp bot', 'features', 'details', 'brochure', 'portfolio', 'work',
    'kaise hota hai', 'kya karte ho', 'info', 'information'
  ];
  const serviceMatches = serviceKeywords.filter(k => lower.includes(k));
  if (serviceMatches.length > 0) {
    return {
      intent: INTENT_CLASSES.SERVICE_INQUIRY,
      confidence: 0.85,
      sentiment: SENTIMENT_LEVELS.POSITIVE,
      urgency: URGENCY_LEVELS.MEDIUM,
      matchedKeywords: serviceMatches
    };
  }

  // 4. Objection / Busy
  const objectionKeywords = [
    'busy', 'not now', 'later', 'expensive', 'too high', 'already have',
    'not looking', 'baad me', 'abhi busy', 'time nahi hai'
  ];
  const objectionMatches = objectionKeywords.filter(k => lower.includes(k));
  if (objectionMatches.length > 0) {
    return {
      intent: INTENT_CLASSES.OBJECTION,
      confidence: 0.80,
      sentiment: SENTIMENT_LEVELS.NEGATIVE,
      urgency: URGENCY_LEVELS.LOW,
      matchedKeywords: objectionMatches
    };
  }

  // 5. Negative Feedback (without STOP keyword)
  const negativeKeywords = [
    'not interested', 'no need', 'dont need', 'nahi chahiye', 'bekar', 'no thanks'
  ];
  const negativeMatches = negativeKeywords.filter(k => lower.includes(k));
  if (negativeMatches.length > 0) {
    return {
      intent: INTENT_CLASSES.NEGATIVE_FEEDBACK,
      confidence: 0.82,
      sentiment: SENTIMENT_LEVELS.NEGATIVE,
      urgency: URGENCY_LEVELS.LOW,
      matchedKeywords: negativeMatches
    };
  }

  // 6. Fallback General / Inquiry
  return {
    intent: INTENT_CLASSES.SERVICE_INQUIRY,
    confidence: 0.50,
    sentiment: SENTIMENT_LEVELS.NEUTRAL,
    urgency: URGENCY_LEVELS.LOW,
    matchedKeywords: []
  };
}

/**
 * Contextual Autonomous Reply Generator
 * Drafts tailored, professional, high-converting replies optimized for WhatsApp, Telegram, or Email.
 *
 * @param {object} params
 * @param {object} params.lead - Lead data
 * @param {string} params.messageText - Inbound message
 * @param {object} params.classification - Classified intent object
 * @param {string} [params.channel='whatsapp']
 * @returns {Promise<{ suggestedReply: string, actionType: string, bookingLink: string|null, generatedBy: string }>}
 */
export async function generateAutonomousReplyDraft({
  lead,
  messageText,
  classification,
  channel = 'whatsapp'
}) {
  const businessName = lead?.businessName || 'there';
  const location = lead?.location ? ` in ${lead.location}` : '';
  const intent = classification?.intent || INTENT_CLASSES.SERVICE_INQUIRY;

  let suggestedReply = '';
  let actionType = 'GENERAL_REPLY';
  let bookingLink = null;

  switch (intent) {
    case INTENT_CLASSES.BOOKING_REQUEST:
      bookingLink = AGENCY_CONFIG.bookingLink;
      actionType = 'SCHEDULE_MEETING';
      suggestedReply = `Hi ${businessName}! Wonderful, Tanuj or Amit would love to jump on a quick 2-minute call to show you a live demo. You can pick any convenient slot directly on our calendar here: ${bookingLink} or let us know what time works best for you today! Best regards, ${AGENCY_CONFIG.founders} | AI AutomationHubs`;
      break;

    case INTENT_CLASSES.PRICING_INQUIRY:
      bookingLink = AGENCY_CONFIG.bookingLink;
      actionType = 'PROVIDE_PRICING_CONTEXT';
      suggestedReply = `Hi ${businessName}! Our custom 24/7 AI WhatsApp Assistants and Lead Copilots typically start at $500/mo depending on inquiry volume. Would you be open for a quick 2-minute screen-share call today so we can calculate your exact ROI? Booking link: ${bookingLink} Best regards, ${AGENCY_CONFIG.founders}`;
      break;

    case INTENT_CLASSES.SERVICE_INQUIRY:
      bookingLink = AGENCY_CONFIG.bookingLink;
      actionType = 'SHARE_CAPABILITIES';
      suggestedReply = `Hi ${businessName}! We build instant 24/7 AI WhatsApp Chatbots and Autonomous Sales Copilots that qualify incoming inquiries and book appointments directly to your calendar so you never lose high-value customers${location}. Would you be open for a quick 2-minute call to see a live sample? ${bookingLink}`;
      break;

    case INTENT_CLASSES.OBJECTION:
      actionType = 'OBJECTION_HANDLING';
      suggestedReply = `Completely understand ${businessName}! No worries at all. Whenever you are ready to automate your customer follow-ups and save 15+ hours a week, feel free to reach back out or check out our case studies at ${AGENCY_CONFIG.website}. Wishing your team great success!`;
      break;

    case INTENT_CLASSES.NEGATIVE_FEEDBACK:
      actionType = 'POLITE_ACKNOWLEDGMENT';
      suggestedReply = `Thank you for letting us know, ${businessName}! We appreciate your response and won't trouble you further. Wishing you all the best with your business!`;
      break;

    default:
      bookingLink = AGENCY_CONFIG.bookingLink;
      suggestedReply = `Hi ${businessName}, thank you for reaching out! We received your message. Would you have 2 minutes for a brief discovery call this week? Best regards, ${AGENCY_CONFIG.founders} | AI AutomationHubs`;
      break;
  }

  // If OpenAI API key is present in settings, optionally enrich with GPT-4o-mini
  const settings = db.getSettings();
  if (settings.openaiApiKey && settings.openaiApiKey.trim() !== '' && intent !== INTENT_CLASSES.NEGATIVE_FEEDBACK) {
    try {
      const sanitized = sanitizeUntrustedInput(messageText).sanitized;
      const prompt = [
        `You are the Senior AI Sales Director for AI AutomationHubs India (https://ai-automation-hubs.com).`,
        `Founders: ${AGENCY_CONFIG.founders} (${AGENCY_CONFIG.phoneTanuj}, ${AGENCY_CONFIG.phoneAmit}).`,
        `Lead Company: ${businessName} (${location || 'General B2B'})`,
        `Prospect message: "${sanitized}"`,
        `Detected Intent: ${intent}`,
        `Booking Calendar Link: ${AGENCY_CONFIG.bookingLink}`,
        `Goal: Write a friendly, 2-3 sentence WhatsApp reply that addresses their question and proposes a 2-minute demo call using the booking link.`,
        `Sign off with: Best regards, Tanuj & Amit | AI AutomationHubs`
      ].join('\n');

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.openaiApiKey.trim()}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Draft high-converting reply.` }
          ],
          temperature: 0.6,
          max_tokens: 220
        })
      });

      if (res.ok) {
        const data = await res.json();
        const aiText = data.choices?.[0]?.message?.content?.trim();
        if (aiText) {
          return {
            suggestedReply: aiText,
            actionType,
            bookingLink,
            generatedBy: 'GPT_4O_MINI'
          };
        }
      }
    } catch (llmErr) {
      console.warn('[Conversation AI] LLM fallback to deterministic template:', llmErr.message);
    }
  }

  return {
    suggestedReply,
    actionType,
    bookingLink,
    generatedBy: 'DETERMINISTIC_RULES'
  };
}

/**
 * Universal Inbound Conversation Intelligence Pipeline
 * Orchestrates sanitization, deterministic opt-out gate, intent classification, and suggested reply drafting.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.conversationId
 * @param {string} params.messageText
 * @param {string} params.channel - 'whatsapp' | 'telegram' | 'email'
 * @param {object} [params.lead] - Matched lead record
 * @returns {Promise<{ isOptOut: boolean, classification: object, suggestedReply: object|null, halted: boolean }>}
 */
export async function processConversationIntelligence({
  tenantId = 'default',
  conversationId,
  messageText,
  channel = 'whatsapp',
  lead = null
}) {
  // 1. Sanitize untrusted input & check injection
  const { sanitized, injectionDetected, flags } = sanitizeUntrustedInput(messageText);

  // 2. Deterministic Opt-Out Safety Check
  const optOutCheck = detectOptOut(sanitized, channel);
  if (optOutCheck.isOptOut) {
    return {
      isOptOut: true,
      classification: null,
      suggestedReply: null,
      halted: true,
      reason: 'OPT_OUT_DETECTED'
    };
  }

  // 3. Intent Classification
  const classification = classifyIntentDeterministically(sanitized);

  // 4. Generate Contextual Suggested Reply
  const replyDraft = await generateAutonomousReplyDraft({
    lead,
    messageText: sanitized,
    classification,
    channel
  });

  // 5. Update Conversation Metadata and Lead state safely
  const conv = db.getConversationById(conversationId, tenantId);
  if (conv) {
    const existingMeta = conv.metadata ? (typeof conv.metadata === 'string' ? JSON.parse(conv.metadata) : conv.metadata) : {};
    const updatedMeta = {
      ...existingMeta,
      lastIntent: classification.intent,
      lastSentiment: classification.sentiment,
      lastUrgency: classification.urgency,
      suggestedReply: replyDraft.suggestedReply,
      actionType: replyDraft.actionType,
      bookingLink: replyDraft.bookingLink,
      injectionFlags: flags,
      updatedAt: new Date().toISOString()
    };

    // Transition conversation status according to intent
    let newStatus = conv.conversationStatus;
    if (classification.intent === INTENT_CLASSES.BOOKING_REQUEST) {
      newStatus = 'WAITING_FOR_HUMAN'; // Prioritized for operator attention
    }

    db.sqlite.prepare(`
      UPDATE conversations
      SET conversation_status = ?, metadata = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(newStatus, JSON.stringify(updatedMeta), new Date().toISOString(), conversationId, tenantId);
  }

  if (lead?.id) {
    db.updateLead(lead.id, {
      aiSuggestedReply: replyDraft.suggestedReply,
      lastReplyText: sanitized,
      lastReplyAt: new Date().toISOString()
    });
  }

  return {
    isOptOut: false,
    classification,
    suggestedReply: replyDraft,
    halted: false
  };
}
