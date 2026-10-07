import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { db } from './database.js';
import { detectOptOut, handleInboundOptOut } from './compliance-engine.js';
import { processConversationIntelligence } from './conversation-ai-engine.js';

let client = null;
let broadcastCallback = null;
let isPeerFlooded = false;
let peerFloodedAt = null;
let rateLimitedUntil = 0; // timestamp in ms

export function parseTelegramFloodError(err) {
  if (!err) return null;

  const msg = String(err.message || err.errorMessage || '');

  // 1. PEER_FLOOD detection
  if (/PEER_FLOOD/i.test(msg) || err.errorMessage === 'PEER_FLOOD') {
    return {
      type: 'PEER_FLOOD',
      isFlood: true,
      seconds: null,
      message: 'Telegram PEER_FLOOD: Account restricted from sending cold messages to non-contacts.'
    };
  }

  // 2. GramJS FloodWaitError with seconds property
  if (typeof err.seconds === 'number' && err.seconds > 0) {
    return {
      type: 'FLOOD_WAIT',
      isFlood: true,
      seconds: err.seconds,
      message: `Telegram FLOOD_WAIT: A wait of ${err.seconds} seconds is required.`
    };
  }

  // 3. Regex matching for FLOOD_WAIT_X or "wait of X seconds"
  const match = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    return {
      type: 'FLOOD_WAIT',
      isFlood: true,
      seconds,
      message: `Telegram FLOOD_WAIT: A wait of ${seconds} seconds is required.`
    };
  }

  return null;
}

export function getTelegramRateLimitStatus() {
  const now = Date.now();
  const isRateLimited = rateLimitedUntil > now;
  const remainingSeconds = isRateLimited ? Math.ceil((rateLimitedUntil - now) / 1000) : 0;

  return {
    isPeerFlooded,
    peerFloodedAt,
    isRateLimited,
    rateLimitedUntil,
    remainingSeconds
  };
}

export function resetTelegramRateLimits() {
  isPeerFlooded = false;
  peerFloodedAt = null;
  rateLimitedUntil = 0;
  console.log('[Telegram User Client] Rate limits and PEER_FLOOD flag manually reset.');
  return { success: true };
}

export function getTelegramClientStatus() {
  const settings = db.getSettings();
  const hasSession = !!(settings.telegramUserSession && settings.telegramUserSession.trim());
  const isConnected = !!(client && client.connected);
  const rateLimit = getTelegramRateLimitStatus();

  return {
    configured: !!(settings.telegramApiId && settings.telegramApiHash),
    hasSession,
    isConnected,
    pendingAuth: !!settings.telegramPhoneCodeHash,
    ...rateLimit
  };
}

/**
 * Initialize existing saved session on startup
 */
export async function initTelegramUserClient(broadcastCb = null) {
  if (broadcastCb) broadcastCallback = broadcastCb;
  const settings = db.getSettings();
  const apiId = parseInt(settings.telegramApiId, 10);
  const apiHash = settings.telegramApiHash;
  const sessionString = settings.telegramUserSession || '';

  if (!apiId || !apiHash || !sessionString) {
    return { success: false, reason: 'Credentials or session missing.' };
  }

  try {
    const stringSession = new StringSession(sessionString);
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5
    });

    await client.connect();
    console.log('✅ Telegram User Client connected successfully using saved session.');
    registerInboundListener();
    return { success: true };
  } catch (err) {
    console.error('Failed to init Telegram User Client:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Step 1: Request OTP code to be sent to user's Telegram app and persist auth state in DB
 */
export async function sendLoginCode(phoneNumber) {
  const settings = db.getSettings();
  const apiId = parseInt(settings.telegramApiId, 10);
  const apiHash = settings.telegramApiHash;

  if (!apiId || !apiHash) {
    throw new Error('Please configure telegramApiId and telegramApiHash first.');
  }

  const cleanPhone = String(phoneNumber).trim().replace(/[^\d+]/g, '');
  const stringSession = new StringSession('');
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();

  const res = await client.sendCode(
    {
      apiId,
      apiHash
    },
    cleanPhone
  );

  const phoneCodeHash = res.phoneCodeHash;
  const tempSession = client.session.save();

  db.updateSettings({
    telegramPendingPhone: cleanPhone,
    telegramPhoneCodeHash: phoneCodeHash,
    telegramTempSession: tempSession
  });

  return {
    success: true,
    phoneCodeHash,
    phoneNumber: cleanPhone
  };
}

/**
 * Step 2: Complete login using OTP code (and optional 2FA password) with DB persisted state
 */
export async function completeLogin(code, password = '') {
  const settings = db.getSettings();
  const apiId = parseInt(settings.telegramApiId, 10);
  const apiHash = settings.telegramApiHash;
  const pendingPhone = settings.telegramPendingPhone;
  const phoneCodeHash = settings.telegramPhoneCodeHash;
  const tempSession = settings.telegramTempSession || '';

  if (!pendingPhone || !phoneCodeHash) {
    throw new Error('No pending login request found. Please request OTP first.');
  }

  const stringSession = new StringSession(tempSession);
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();

  try {
    await client.signInUser(
      {
        apiId,
        apiHash
      },
      {
        phoneNumber: pendingPhone,
        phoneCodeHash,
        phoneCode: String(code).trim(),
        password: password ? String(password) : undefined
      }
    );

    const sessionString = client.session.save();
    db.updateSettings({
      telegramUserSession: sessionString,
      telegramPendingPhone: '',
      telegramPhoneCodeHash: '',
      telegramTempSession: ''
    });

    console.log('✅ Telegram User Client authenticated and permanent session saved.');
    registerInboundListener();
    return { success: true };
  } catch (err) {
    throw new Error(err.message);
  }
}

/**
 * Send Telegram message directly to a lead's phone number or username
 */
export async function sendLeadTelegramMessage(lead, customMessage = '') {
  const settings = db.getSettings();

  // 1. Fail-closed rate limit and PEER_FLOOD circuit breaker
  const rateLimitStatus = getTelegramRateLimitStatus();
  if (rateLimitStatus.isPeerFlooded) {
    const err = new Error('Telegram outreach is blocked due to active PEER_FLOOD restriction. Please contact @SpamBot on Telegram to resolve restrictions before sending.');
    err.code = 'PEER_FLOOD';
    throw err;
  }

  if (rateLimitStatus.isRateLimited) {
    const err = new Error(`Telegram outreach is paused due to active FLOOD_WAIT. Please wait ${rateLimitStatus.remainingSeconds}s before sending.`);
    err.code = 'FLOOD_WAIT';
    err.waitSeconds = rateLimitStatus.remainingSeconds;
    throw err;
  }

  if (!client || !client.connected) {
    const initRes = await initTelegramUserClient();
    if (!initRes.success) {
      throw new Error('Telegram account is not logged in. Please authenticate with OTP first.');
    }
  }

  const phone = lead.phone ? lead.phone.replace(/[^\d+]/g, '') : '';
  const username = lead.telegram ? lead.telegram.replace(/^@/, '').replace(/.*t\.me\//, '') : '';

  const target = username || phone;
  if (!target) {
    throw new Error('Lead does not have a phone number or Telegram username.');
  }

  const template = customMessage || settings.telegramMessageTemplate || 'Hi {{BusinessName}}, wanted to connect!';
  const messageText = template
    .replace(/{{BusinessName}}/g, lead.businessName || 'there')
    .replace(/{{Location}}/g, lead.location || '')
    .replace(/{{Rating}}/g, lead.rating ? `⭐ ${lead.rating}` : '')
    .replace(/{{PersonalizedPitch}}/g, lead.notes || '');

  try {
    let peer = target;
    if (!username && phone) {
      // Import phone contact on-the-fly to resolve Telegram entity
      const importRes = await client.invoke(
        new Api.contacts.ImportContacts({
          contacts: [
            new Api.InputPhoneContact({
              clientId: BigInt(Date.now()),
              phone: phone,
              firstName: (lead.businessName || 'Lead').substring(0, 30),
              lastName: ''
            })
          ]
        })
      );

      if (!importRes.users || !importRes.users.length) {
        throw new Error(`The phone number ${phone} is not registered on Telegram.`);
      }
      peer = importRes.users[0];
    }

    const result = await client.sendMessage(peer, { message: messageText });
    return { success: true, messageId: result.id };
  } catch (err) {
    // 2. Handle Telegram Flood / Abuse rate limits immediately
    const floodInfo = parseTelegramFloodError(err);
    if (floodInfo) {
      if (floodInfo.type === 'PEER_FLOOD') {
        isPeerFlooded = true;
        peerFloodedAt = new Date().toISOString();
        console.error('🚨 [Telegram User Client] CRITICAL: PEER_FLOOD triggered. Account restricted from messaging cold contacts.');
        if (broadcastCallback) {
          broadcastCallback({
            type: 'log',
            message: '🚨 [Telegram Alert] PEER_FLOOD detected! Telegram flagged cold outreach. Queue halted to protect account.'
          });
          broadcastCallback({
            type: 'tg-rate-limit',
            status: getTelegramRateLimitStatus()
          });
        }
        const customErr = new Error('Telegram PEER_FLOOD: Account restricted from messaging cold leads. Queue halted to prevent account ban. Check @SpamBot.');
        customErr.code = 'PEER_FLOOD';
        throw customErr;
      }

      if (floodInfo.type === 'FLOOD_WAIT') {
        const waitSec = floodInfo.seconds || 60;
        rateLimitedUntil = Date.now() + (waitSec * 1000) + 5000;
        console.warn(`⏳ [Telegram User Client] FLOOD_WAIT_${waitSec} triggered. Backing off until ${new Date(rateLimitedUntil).toISOString()}`);
        if (broadcastCallback) {
          broadcastCallback({
            type: 'log',
            message: `⏳ [Telegram Rate Limit] FLOOD_WAIT detected. Pausing for ${waitSec}s.`
          });
          broadcastCallback({
            type: 'tg-rate-limit',
            status: getTelegramRateLimitStatus()
          });
        }
        const customErr = new Error(`Telegram FLOOD_WAIT: Required wait of ${waitSec} seconds.`);
        customErr.code = 'FLOOD_WAIT';
        customErr.waitSeconds = waitSec;
        throw customErr;
      }
    }

    if (err.message && (err.message.includes('PHONE_NOT_OCCUPIED') || err.message.includes('not registered'))) {
      throw new Error(`The phone number ${phone} is not registered on Telegram.`);
    }
    throw err;
  }
}

/**
 * Attaches the Telegram incoming message event handler
 */
function registerInboundListener() {
  if (!client) return;
  try {
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || message.out) return; // Ignore our own outbound messages
        const messageText = (message.message || '').trim();
        if (!messageText) return;

        let senderPhone = '';
        let senderUsername = '';
        try {
          const sender = await message.getSender();
          if (sender) {
            senderPhone = sender.phone ? String(sender.phone).replace(/[^\d+]/g, '') : '';
            senderUsername = sender.username || '';
          }
        } catch (e) {
          // peer resolution fallback
        }

        await handleTelegramInboundMessage({
          senderPhone,
          senderUsername,
          messageText,
          providerMessageId: String(message.id),
          tenantId: 'default',
          broadcastFn: broadcastCallback
        });
      } catch (err) {
        console.error('[Telegram Inbound] Error handling incoming message:', err.message);
      }
    }, new NewMessage({ incoming: true }));
    console.log('✅ Telegram inbound message listener registered.');
  } catch (listenerErr) {
    console.warn('[Telegram Inbound] Failed to attach listener:', listenerErr.message);
  }
}

/**
 * Universal Inbound Message Processor for Telegram
 * Implements Step 8C/8D: Inverted ordering, thread persistence, deterministic opt-out gate,
 * and conversation intelligence integration.
 *
 * @param {object} params
 * @param {string} [params.senderPhone]
 * @param {string} [params.senderUsername]
 * @param {string} params.messageText
 * @param {string} [params.providerMessageId]
 * @param {string} [params.tenantId='default']
 * @param {function} [params.broadcastFn]
 * @returns {Promise<{ status: string, conversationId?: string, messageId?: string, optOut?: boolean, intel?: object }>}
 */
export async function handleTelegramInboundMessage({
  senderPhone = '',
  senderUsername = '',
  messageText = '',
  providerMessageId = null,
  tenantId = 'default',
  broadcastFn = null
}) {
  const tid = (tenantId || 'default').trim();
  const text = (messageText || '').trim();
  if (!text) return { status: 'EMPTY_MESSAGE' };

  const pMsgId = providerMessageId ? String(providerMessageId) : `tgmsg_${Date.now()}_${Math.random().toString(36).substring(2)}`;

  // 1. Scoped lead identity resolution
  let lead = null;
  let resolutionStatus = 'UNMATCHED';

  if (senderPhone) {
    const res = db.findLeadByPhoneScoped(senderPhone, tid);
    resolutionStatus = res.status;
    if (res.status === 'MATCHED') {
      lead = res.lead;
    }
  }

  // Fallback to Telegram username / handle if phone didn't match
  if (!lead && senderUsername) {
    const cleanUser = senderUsername.replace(/^@/, '').trim();
    const matchedLead = db.sqlite.prepare(`
      SELECT * FROM leads 
      WHERE tenant_id = ? AND (
        LOWER(telegram) = LOWER(?) OR 
        LOWER(telegram) = LOWER(?) OR 
        LOWER(telegram) LIKE ?
      )
    `).get(tid, cleanUser, `@${cleanUser}`, `%${cleanUser}%`);
    if (matchedLead) {
      lead = matchedLead;
      resolutionStatus = 'MATCHED';
    }
  }

  const threadIdentifier = senderPhone || senderUsername || pMsgId;
  let conv = null;
  let ingestedMsg = null;

  // 2. Deterministic Opt-Out Safety Check
  const optOutCheck = detectOptOut(text, 'telegram');

  if (resolutionStatus === 'MATCHED' && lead) {
    try {
      conv = db.getOrCreateConversation({
        tenantId: tid,
        leadId: lead.id,
        channel: 'telegram',
        externalThreadId: threadIdentifier,
        status: 'ACTIVE'
      });

      const ingestRes = db.ingestConversationMessage({
        tenantId: tid,
        conversationId: conv.id,
        channel: 'telegram',
        direction: 'INBOUND',
        senderIdentifier: threadIdentifier,
        recipientIdentifier: 'agency_telegram',
        providerMessageId: pMsgId,
        messageText: text,
        hasOptOut: optOutCheck.isOptOut ? 1 : 0,
        rawPayload: { senderPhone, senderUsername, providerMessageId: pMsgId },
        receivedAt: new Date().toISOString()
      });
      ingestedMsg = ingestRes.message;

      // 3. Central Inbound Opt-Out Protection (Decoupled & Inverted)
      if (optOutCheck.isOptOut) {
        console.warn(`🛑 [Telegram Inbound] Explicit Opt-Out detected from ${threadIdentifier} (${lead.businessName}): "${text}" [Pattern: ${optOutCheck.matchedPattern}, Scope: ${optOutCheck.scope}]`);
        await handleInboundOptOut({
          senderPhone: senderPhone || lead.phone || threadIdentifier,
          incomingText: text,
          matchedPattern: optOutCheck.matchedPattern,
          scope: optOutCheck.scope,
          targetChannel: 'telegram',
          expiresAt: optOutCheck.expiresAt,
          conversationId: conv.id,
          messageId: ingestedMsg?.id,
          lead,
          broadcastFn,
          tenantId: tid
        });
        return { status: 'OPT_OUT_HALTED', conversationId: conv.id, messageId: ingestedMsg?.id, optOut: true };
      }
    } catch (convErr) {
      console.error('[Telegram Inbound] Error persisting conversation/message:', convErr.message);
    }
  } else if (resolutionStatus === 'AMBIGUOUS_IDENTITY') {
    console.warn(`⚠️ [Telegram Inbound] Ambiguous identity detected for ${threadIdentifier}. Quarantine required.`);
    return { status: 'AMBIGUOUS_IDENTITY_QUARANTINED' };
  } else {
    // Unmatched contact opt-out check
    if (optOutCheck.isOptOut) {
      await handleInboundOptOut({
        senderPhone: senderPhone || threadIdentifier,
        incomingText: text,
        matchedPattern: optOutCheck.matchedPattern,
        scope: optOutCheck.scope,
        targetChannel: 'telegram',
        expiresAt: optOutCheck.expiresAt,
        broadcastFn,
        tenantId: tid
      });
      return { status: 'OPT_OUT_HALTED_UNMATCHED', optOut: true };
    }
  }

  // 4. Conversation Intelligence & Intent Classification
  let intelResult = null;
  try {
    intelResult = await processConversationIntelligence({
      tenantId: tid,
      conversationId: conv?.id,
      messageText: text,
      channel: 'telegram',
      lead
    });
  } catch (aiErr) {
    console.warn('[Telegram Inbound] Fallback suggested reply:', aiErr.message);
  }

  // 5. Inbound Safety: Update lead response timestamps without mutating sales status to Interested
  if (lead) {
    db.updateLead(lead.id, {
      lastReplyText: text,
      lastReplyAt: new Date().toISOString(),
      last_inbound_at: new Date().toISOString(),
      aiSuggestedReply: intelResult?.suggestedReply?.suggestedReply || ''
    });
  }

  // 6. Broadcast SSE event
  if (broadcastFn || broadcastCallback) {
    const fn = broadcastFn || broadcastCallback;
    fn({
      type: 'lead-replied',
      channel: 'telegram',
      phone: senderPhone || lead?.phone,
      businessName: lead ? lead.businessName : threadIdentifier,
      replyText: text,
      aiDraft: intelResult?.suggestedReply?.suggestedReply || '',
      leadId: lead?.id || null,
      intent: intelResult?.classification?.intent || 'SERVICE_INQUIRY'
    });
  }

  return {
    status: 'PROCESSED',
    conversationId: conv?.id,
    messageId: ingestedMsg?.id,
    optOut: false,
    intel: intelResult
  };
}
