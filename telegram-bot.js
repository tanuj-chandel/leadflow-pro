import { db } from './database.js';

if (process.env.ALLOW_INSECURE_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Send a message via Telegram Bot API using native fetch
 */
export async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) {
    throw new Error('Telegram Bot Token and Chat ID are required.');
  }

  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const body = {
    chat_id: String(chatId).trim(),
    text: text,
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: options.disable_web_page_preview ?? false
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error (code ${data.error_code})`);
  }
  return data.result;
}

/**
 * Verify Bot Token and get bot details
 */
export async function getBotInfo(botToken) {
  if (!botToken) throw new Error('Bot token is required.');
  const url = `https://api.telegram.org/bot${botToken.trim()}/getMe`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Invalid Telegram Bot Token');
  }
  return data.result;
}

/**
 * Send alert to all configured chat IDs in Settings
 */
export async function sendTelegramBroadcast(text, options = {}) {
  const settings = db.getSettings();
  const token = settings.telegramBotToken;
  const rawChatIds = settings.telegramChatIds;

  if (!token || !rawChatIds) {
    return { success: false, reason: 'Telegram bot token or chat IDs not configured in Settings.' };
  }

  const chatIds = String(rawChatIds)
    .split(/[,\n\s]+/)
    .map(id => id.trim())
    .filter(Boolean);

  if (!chatIds.length) {
    return { success: false, reason: 'No valid Chat IDs found.' };
  }

  const results = [];
  for (const chatId of chatIds) {
    try {
      const res = await sendTelegramMessage(token, chatId, text, options);
      results.push({ chatId, success: true, messageId: res.message_id });
    } catch (err) {
      console.error(`[Telegram] Failed to send to ${chatId}:`, err.message);
      results.push({ chatId, success: false, error: err.message });
    }
  }

  return { success: results.some(r => r.success), results };
}

/**
 * Format and push a lead dossier to Telegram
 */
export async function sendLeadDossierToTelegram(lead) {
  const cleanPhone = (lead.phone || '').replace(/\D/g, '');
  const waLink = cleanPhone ? `https://wa.me/${cleanPhone}` : '';
  const tgLeadLink = cleanPhone ? `https://t.me/+${cleanPhone}` : '';

  const text = [
    `🎯 <b>AI Lead Alert: ${escapeHtml(lead.businessName || 'Business')}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    lead.segment ? `🏷️ <b>Segment:</b> ${escapeHtml(lead.segment)}` : '',
    lead.qualityScore ? `⭐ <b>Quality:</b> ${lead.qualityScore} (${escapeHtml(lead.qualityReason || 'Qualified')})` : '',
    lead.location ? `📍 <b>Location:</b> ${escapeHtml(lead.location)}` : '',
    lead.phone ? `📞 <b>Phone:</b> ${escapeHtml(lead.phone)}` : '',
    lead.website ? `🌐 <b>Website:</b> <a href="${escapeHtml(lead.website)}">${escapeHtml(lead.website)}</a>` : '',
    lead.email ? `✉️ <b>Email:</b> ${escapeHtml(lead.email)}` : '',
    '',
    lead.notes ? `💡 <b>AI Pitch:</b>\n<i>${escapeHtml(lead.notes.substring(0, 300))}</i>` : '',
    '',
    `🚀 <b>Quick Actions:</b>`,
    waLink ? `• <a href="${waLink}">💬 Chat on WhatsApp</a>` : '',
    tgLeadLink ? `• <a href="${tgLeadLink}">✈️ Chat on Telegram</a>` : '',
    lead.phone ? `• <a href="tel:${lead.phone}">📞 Call Directly</a>` : ''
  ].filter(Boolean).join('\n');

  return sendTelegramBroadcast(text, { parse_mode: 'HTML' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
