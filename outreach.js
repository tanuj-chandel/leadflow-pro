import { google } from 'googleapis';
import { db } from './database.js';
import { sendWhatsappMessage } from './whatsapp-client.js';
import { generatePersonalizedEmailDraft } from './ai-copilot.js';
import { detectOptOut, handleInboundOptOut } from './compliance-engine.js';
import { processConversationIntelligence } from './conversation-ai-engine.js';
import fs from 'fs';
import path from 'path';

export function getOAuth2Client() {
  const settings = db.getSettings();
  const { googleClientId, googleClientSecret, googleRedirectUri } = settings;
  if (!googleClientId || !googleClientSecret) {
    return null;
  }
  const oauth2Client = new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    googleRedirectUri
  );
  if (settings.googleTokens) {
    oauth2Client.setCredentials(settings.googleTokens);
  }
  return oauth2Client;
}

export function getAuthUrl() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('OAuth2 credentials not configured. Please add Client ID and Client Secret in Settings first.');
  }
  const scopes = [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ];
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent' // ensures we get a refresh token
  });
}

export async function handleOAuthCallback(code) {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) throw new Error('OAuth2 client not initialized');
  const { tokens } = await oauth2Client.getToken(code);
  
  const settings = db.getSettings();
  const existingTokens = settings.googleTokens || {};
  
  // Refresh token is only returned on the first consent flow. Keep it if it's not in the new tokens.
  const mergedTokens = {
    ...existingTokens,
    ...tokens
  };
  
  db.updateSettings({ googleTokens: mergedTokens });
  return mergedTokens;
}

function fillTemplate(template, fields) {
  let result = template;
  Object.keys(fields).forEach(key => {
    result = result.split('{{' + key + '}}').join(fields[key]);
  });
  return result;
}

export async function createGmailDraft(lead) {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth is not configured. Go to Settings and click Connect Gmail.');
  }

  // Double check if token is valid and refresh if needed
  try {
    const creds = await oauth2Client.getAccessToken();
    if (!creds.token) {
      throw new Error('Google authentication tokens are invalid or expired.');
    }
  } catch (err) {
    throw new Error(`Google OAuth error: ${err.message}. Please disconnect and reconnect your Google account.`);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const settings = db.getSettings();

  const fields = {
    BusinessName: lead.businessName || '',
    Location: lead.location || '',
    Address: lead.address || '',
    Phone: lead.phone || '',
    Website: lead.website || '',
    Segment: lead.segment || 'Business',
    Rating: lead.rating ? `⭐ ${lead.rating}` : '',
    PersonalizedPitch: lead.notes || ''
  };

  let subject = '';
  let body = '';
  try {
    const aiDraft = await generatePersonalizedEmailDraft(lead);
    subject = aiDraft.subject;
    body = aiDraft.body;
  } catch (aiErr) {
    console.warn('[Gmail Draft] AI personalization fallback to template:', aiErr.message);
    subject = fillTemplate(settings.emailSubjectTemplate, fields);
    body = fillTemplate(settings.emailBodyTemplate, fields);
  }

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const cardPath = path.join(process.cwd(), 'public', 'visiting_card.jpg');
  const hasCard = fs.existsSync(cardPath);

  let rawMime = '';
  if (hasCard) {
    const cardBase64 = fs.readFileSync(cardPath).toString('base64');
    rawMime = [
      `To: ${lead.email}`,
      `Subject: ${utf8Subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '',
      `--${boundary}`,
      'Content-Type: image/jpeg; name="AI_AutomationHubs_Visiting_Card.jpg"',
      'Content-Disposition: attachment; filename="AI_AutomationHubs_Visiting_Card.jpg"',
      'Content-Transfer-Encoding: base64',
      '',
      cardBase64,
      '',
      `--${boundary}--`
    ].join('\r\n');
  } else {
    rawMime = [
      `To: ${lead.email}`,
      `Subject: ${utf8Subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body
    ].join('\r\n');
  }

  const encodedMessage = Buffer.from(rawMime).toString('base64url');

  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: encodedMessage
      }
    }
  });
}

export async function syncToGoogleSheet() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth is not configured. Go to Settings and click Connect Google account.');
  }

  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const settings = db.getSettings();
  let spreadsheetId = settings.googleSheetId;

  // Verify the existing sheet is accessible
  if (spreadsheetId) {
    try {
      await sheets.spreadsheets.get({ spreadsheetId });
    } catch (e) {
      spreadsheetId = null; // Spreadsheet was deleted or is inaccessible
    }
  }

  // Create a new sheet if needed
  if (!spreadsheetId) {
    const createResponse = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'Map Lead Scraper & Outreach Results' }
      }
    });
    spreadsheetId = createResponse.data.spreadsheetId;
    db.updateSettings({ googleSheetId: spreadsheetId });
  }

  const leads = db.getLeads();
  const headers = [
    'Business Name', 'Search Term', 'Location', 'Phone/Mobile', 'Email', 
    'Website', 'Facebook', 'Instagram', 'LinkedIn', 'Twitter/X', 
    'Address', 'Rating', 'Email Draft Status', 'WhatsApp Status', 'Date Scraped'
  ];

  const rows = leads.map(l => [
    l.businessName || '',
    l.searchTerm || '',
    l.location || '',
    l.phone || '',
    l.email || '',
    l.website || '',
    l.facebook || '',
    l.instagram || '',
    l.linkedin || '',
    l.twitter || '',
    l.address || '',
    l.rating || '',
    l.emailStatus || 'Pending',
    l.whatsappStatus || 'Pending',
    l.createdAt ? l.createdAt.split('T')[0] : ''
  ]);

  // Clear first sheet (e.g. Sheet1)
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Sheet1!A1:Z' + (leads.length + 100)
    });
  } catch (clearErr) {
    // If clearing Sheet1 fails (e.g. if the default sheet has a different name in some locals),
    // get the sheet list and clear the first tab name
    const docInfo = await sheets.spreadsheets.get({ spreadsheetId });
    const tabName = docInfo.data.sheets[0].properties.title;
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${tabName}'!A1:Z` + (leads.length + 100)
    });
  }

  // Write headers and data rows
  const docInfo = await sheets.spreadsheets.get({ spreadsheetId });
  const tabName = docInfo.data.sheets[0].properties.title;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [headers, ...rows]
    }
  });

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
  };
}

export async function sendWhatsAppMessage(lead) {
  const settings = db.getSettings();
  const isNoWeb = !lead.website || lead.website.trim() === '';
  const term = `${lead.searchTerm || ''} ${lead.businessName || ''} ${lead.category || ''}`.toLowerCase();

  let template;
  if (/dental|dentist/i.test(term)) {
    template = `Namaste {{BusinessName}} team! 👋

Congratulations on your {{Rating}} on Google Maps in {{Location}}!

I noticed that patients searching for dental clinics in {{Location}} after clinic hours or on weekends often have questions about treatments & appointments, but have no instant way to book on WhatsApp. You might be losing 20-30 patients every month to other clinics.

We build 24/7 AI WhatsApp Receptionists specifically for dental clinics in {{Location}}:
• Instantly answers patient queries regarding treatments, cleaning & consultation.
• Collects patient details and books appointments into your schedule 24/7.
• Captures after-hours inquiries automatically.

Can I share a 60-second video demo showing how it works for {{BusinessName}}?

Best regards,
Tanuj Chandel & Amit Pandey | AI AutomationHubs
📞 +91-7704077700
🌐 https://ai-automation-hubs.com`;
  } else if (/coaching|classes|institute|academy|tutor|education/i.test(term)) {
    template = `Namaste {{BusinessName}} team! 👋

Congratulations on your {{Rating}} reputation in {{Location}}!

During admission season, parents & students searching for {{BusinessName}} on Google frequently ask about batch timings, fee structures, and courses over WhatsApp. If they don't get an instant reply, they often contact another center.

We build 24/7 AI Student Counselors for top coaching institutes in {{Location}}:
• Instantly answers course inquiries, batch timings & syllabus questions.
• Automatically captures student name, standard & parent contact numbers.
• Sends instant brochure details and schedules counseling visits.

Can I share a 60-second video demo showing how it works for {{BusinessName}}?

Best regards,
Tanuj Chandel & Amit Pandey | AI AutomationHubs
📞 +91-7704077700
🌐 https://ai-automation-hubs.com`;
  } else if (isNoWeb && settings.waNoWebsiteTemplate) {
    template = settings.waNoWebsiteTemplate;
  } else {
    template = settings.waMessageTemplate || 
      'Hi {{BusinessName}},\n\nI found your business in {{Location}} and wanted to reach out. Are you open to a quick call?\n\nBest regards,\nTanuj Chandel | AI AutomationHubs (📞 +91-7704077700)';
  }

  const toPhone = lead.phone;
  if (!toPhone) {
    throw new Error('Lead has no phone number.');
  }

  const fields = {
    BusinessName: lead.businessName || '',
    Location: lead.location || '',
    Address: lead.address || '',
    Phone: lead.phone || '',
    Website: lead.website || '',
    Segment: lead.segment || 'Business',
    Rating: lead.rating ? `⭐ ${lead.rating}` : 'top-rated',
    PersonalizedPitch: lead.notes || ''
  };

  const messageText = fillTemplate(template, fields);

  // Send via our QR code connected client
  const result = await sendWhatsappMessage(toPhone, messageText);
  return result;
}

/**
 * Universal Inbound Message Processor for Email
 * Implements Step 8C/8D: Inverted ordering, thread persistence, deterministic opt-out gate,
 * and conversation intelligence integration.
 *
 * @param {object} params
 * @param {string} params.fromEmail
 * @param {string} [params.subject='']
 * @param {string} params.bodyText
 * @param {string} [params.providerMessageId]
 * @param {string} [params.tenantId='default']
 * @param {function} [params.broadcastFn]
 * @returns {Promise<{ status: string, conversationId?: string, messageId?: string, optOut?: boolean, intel?: object }>}
 */
export async function handleEmailInboundMessage({
  fromEmail,
  subject = '',
  bodyText = '',
  providerMessageId = null,
  tenantId = 'default',
  broadcastFn = null
}) {
  const tid = (tenantId || 'default').trim();
  const cleanEmail = String(fromEmail || '').toLowerCase().trim();
  const text = (bodyText || '').trim();

  if (!cleanEmail || !text) {
    return { status: 'INVALID_INPUT' };
  }

  const pMsgId = providerMessageId ? String(providerMessageId) : `emmsg_${Date.now()}_${Math.random().toString(36).substring(2)}`;

  // 1. Scoped lead identity resolution by email
  const lead = db.sqlite.prepare(`
    SELECT * FROM leads 
    WHERE tenant_id = ? AND LOWER(email) = ?
  `).get(tid, cleanEmail);

  let conv = null;
  let ingestedMsg = null;

  // 2. Deterministic Opt-Out Safety Check
  const optOutCheck = detectOptOut(text, 'email');

  if (lead) {
    try {
      conv = db.getOrCreateConversation({
        tenantId: tid,
        leadId: lead.id,
        channel: 'email',
        externalThreadId: cleanEmail,
        status: 'ACTIVE'
      });

      const ingestRes = db.ingestConversationMessage({
        tenantId: tid,
        conversationId: conv.id,
        channel: 'email',
        direction: 'INBOUND',
        senderIdentifier: cleanEmail,
        recipientIdentifier: 'agency_email',
        providerMessageId: pMsgId,
        messageText: text,
        hasOptOut: optOutCheck.isOptOut ? 1 : 0,
        rawPayload: { fromEmail: cleanEmail, subject, providerMessageId: pMsgId },
        receivedAt: new Date().toISOString()
      });
      ingestedMsg = ingestRes.message;

      // 3. Central Inbound Opt-Out Protection (Decoupled & Inverted)
      if (optOutCheck.isOptOut) {
        console.warn(`🛑 [Email Inbound] Explicit Opt-Out detected from ${cleanEmail} (${lead.businessName}): "${text}" [Pattern: ${optOutCheck.matchedPattern}, Scope: ${optOutCheck.scope}]`);
        await handleInboundOptOut({
          senderPhone: lead.phone || cleanEmail,
          incomingText: text,
          matchedPattern: optOutCheck.matchedPattern,
          scope: optOutCheck.scope,
          targetChannel: 'email',
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
      console.error('[Email Inbound] Error persisting conversation/message:', convErr.message);
    }
  } else {
    // Unmatched email opt-out check
    if (optOutCheck.isOptOut) {
      await handleInboundOptOut({
        senderPhone: cleanEmail,
        incomingText: text,
        matchedPattern: optOutCheck.matchedPattern,
        scope: optOutCheck.scope,
        targetChannel: 'email',
        expiresAt: optOutCheck.expiresAt,
        broadcastFn,
        tenantId: tid
      });
      return { status: 'OPT_OUT_HALTED_UNMATCHED', optOut: true };
    }
    return { status: 'UNMATCHED_NO_OP' };
  }

  // 4. Conversation Intelligence & Intent Classification
  let intelResult = null;
  try {
    intelResult = await processConversationIntelligence({
      tenantId: tid,
      conversationId: conv?.id,
      messageText: text,
      channel: 'email',
      lead
    });
  } catch (aiErr) {
    console.warn('[Email Inbound] Fallback suggested reply:', aiErr.message);
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
  if (broadcastFn) {
    broadcastFn({
      type: 'lead-replied',
      channel: 'email',
      email: cleanEmail,
      businessName: lead ? lead.businessName : cleanEmail,
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

/**
 * Polls Gmail for incoming replies from leads, processes opt-outs, and triggers intelligence pipeline.
 *
 * @param {object} params
 * @param {string} [params.tenantId='default']
 * @param {function} [params.broadcastFn]
 * @returns {Promise<{ success: boolean, processedCount?: number, reason?: string }>}
 */
export async function pollGmailInboundReplies({ tenantId = 'default', broadcastFn = null } = {}) {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    return { success: false, reason: 'Google OAuth is not configured' };
  }

  try {
    const creds = await oauth2Client.getAccessToken();
    if (!creds.token) {
      return { success: false, reason: 'Google authentication tokens are invalid or expired' };
    }
  } catch (err) {
    return { success: false, reason: `OAuth error: ${err.message}` };
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  let processedCount = 0;

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread label:INBOX',
      maxResults: 15
    });

    const messages = listRes.data.messages || [];
    for (const m of messages) {
      try {
        const detail = await gmail.users.messages.get({ userId: 'me', id: m.id });
        const headers = detail.data.payload?.headers || [];
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const snippet = detail.data.snippet || '';

        const emailMatch = fromHeader.match(/<([^>]+)>/) || [null, fromHeader];
        const fromEmail = (emailMatch[1] || fromHeader).trim();

        if (fromEmail && snippet) {
          await handleEmailInboundMessage({
            fromEmail,
            subject: subjectHeader,
            bodyText: snippet,
            providerMessageId: m.id,
            tenantId,
            broadcastFn
          });
          processedCount++;
        }

        // Mark as read to avoid duplicate processing
        await gmail.users.messages.modify({
          userId: 'me',
          id: m.id,
          requestBody: { removeLabelIds: ['UNREAD'] }
        });
      } catch (msgErr) {
        console.warn(`[Gmail Polling] Error processing message ${m.id}:`, msgErr.message);
      }
    }

    return { success: true, processedCount };
  } catch (err) {
    console.error('[Gmail Polling] Failed to list messages:', err.message);
    return { success: false, reason: err.message };
  }
}

