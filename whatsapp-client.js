import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { formatPhoneNumber, classifyPhoneType } from './scraper.js';
import { db } from './database.js';
import { generateSuggestedReply } from './ai-copilot.js';
import { sendTelegramBroadcast } from './telegram-bot.js';
import { detectOptOut, handleInboundOptOut } from './compliance-engine.js';
import { processConversationIntelligence } from './conversation-ai-engine.js';

let client = null;
let qrCodeDataUrl = null;
let connectionStatus = 'Disconnected'; // Disconnected, Connecting, QR_Ready, Connected
let broadcastFn = null;
let reconnectTimer = null;
let keepAliveTimer = null;
let isReconnecting = false;

// Remove stale lock files left by abnormal Chrome exits and kill orphan processes
export function clearStaleChromeLocks(userDataDir) {
  try {
    // 1. On Windows, forcefully kill orphan Chrome processes launched from this specific userDataDir
    if (process.platform === 'win32') {
      try {
        execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name = \'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \'*wwebjs_auth*\' } | Stop-Process -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
      } catch (_) {}
    }

    const sessionDir = path.join(userDataDir, 'session');
    if (!fs.existsSync(sessionDir)) return;

    // 2. Comprehensive lock files and sockets cleanup
    const lockFiles = [
      'SingletonLock', 'SingletonCookie', 'SingletonSocket', 
      'DevToolsActivePort', 'parent.lock', 'lockfile'
    ];
    for (const f of lockFiles) {
      const p = path.join(sessionDir, f);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); console.log(`[WhatsApp Client] Cleaned stale lock file: ${f}`); } catch (_) {}
      }
    }

    // 3. Remove nested Default/LOCK and LevelDB lockfiles
    const defaultLock = path.join(sessionDir, 'Default', 'LOCK');
    if (fs.existsSync(defaultLock)) {
      try { fs.unlinkSync(defaultLock); console.log('[WhatsApp Client] Cleaned Default/LOCK'); } catch (_) {}
    }

    // LevelDB / IndexedDB lock files
    const levelDbDir = path.join(sessionDir, 'Default', 'IndexedDB');
    if (fs.existsSync(levelDbDir)) {
      try {
        const removeLocksRecursively = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              removeLocksRecursively(fullPath);
            } else if (/LOCK|lockfile/i.test(entry.name)) {
              try { fs.unlinkSync(fullPath); } catch (_) {}
            }
          }
        };
        removeLocksRecursively(levelDbDir);
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[WhatsApp Client] Lock cleanup non-fatal warning:', err.message);
  }
}

// Backup session tokens to withstand abnormal shutdowns
export function backupSession(authDir) {
  try {
    const srcDefault = path.join(authDir, 'session', 'Default');
    const backupDir = path.join(process.cwd(), '.wwebjs_auth_backup', 'session', 'Default');
    if (!fs.existsSync(srcDefault)) return;

    fs.mkdirSync(backupDir, { recursive: true });
    const criticalDirs = ['IndexedDB', 'Local Storage'];
    for (const dirName of criticalDirs) {
      const srcSub = path.join(srcDefault, dirName);
      const dstSub = path.join(backupDir, dirName);
      if (fs.existsSync(srcSub)) {
        fs.cpSync(srcSub, dstSub, { recursive: true, force: true });
      }
    }
    console.log('[WhatsApp Client] Session tokens safely backed up to .wwebjs_auth_backup');
  } catch (err) {
    console.warn('[WhatsApp Client] Session backup non-fatal warning:', err.message);
  }
}

// Restore session from snapshot ONLY if IndexedDB exists and has real files
export function restoreSessionIfCorrupted(authDir) {
  try {
    const sessionIndexedDB = path.join(authDir, 'session', 'Default', 'IndexedDB');
    const backupIndexedDB = path.join(process.cwd(), '.wwebjs_auth_backup', 'session', 'Default', 'IndexedDB');

    const sessionHasData = fs.existsSync(sessionIndexedDB) && fs.readdirSync(sessionIndexedDB).length > 0;
    const backupHasData = fs.existsSync(backupIndexedDB) && fs.readdirSync(backupIndexedDB).length > 0;

    if (!sessionHasData && backupHasData) {
      console.log('[WhatsApp Client] Auto-restoring session from reliable backup...');
      const targetDefault = path.join(authDir, 'session', 'Default');
      fs.mkdirSync(targetDefault, { recursive: true });
      const backupDir = path.join(process.cwd(), '.wwebjs_auth_backup', 'session', 'Default');
      fs.cpSync(backupDir, targetDefault, { recursive: true, force: true });
      console.log('[WhatsApp Client] Session successfully restored.');
    }
  } catch (err) {
    console.warn('[WhatsApp Client] Session restore non-fatal warning:', err.message);
  }
}

// Periodic keep-alive ping to prevent Meta idle timeout and detect frame detachment
let disconnectedSince = null; // Track when we went disconnected for watchdog

export function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  disconnectedSince = null; // Reset watchdog on successful connect
  keepAliveTimer = setInterval(async () => {
    if (client && connectionStatus === 'Connected') {
      try {
        const state = await client.getState();
        if (state !== 'CONNECTED' && state !== null) {
          console.warn(`[WhatsApp Keep-Alive] Session state changed to ${state}. Initiating auto-recovery...`);
          scheduleReconnect(5000, `keepalive_state_${state}`);
        } else {
          disconnectedSince = null; // Still alive, reset watchdog
        }
      } catch (err) {
        if (/detached Frame|Execution context was destroyed|Session closed|Target closed/i.test(err.message)) {
          console.warn(`[WhatsApp Keep-Alive] Critical: Execution frame detached (${err.message}). Triggering client recovery...`);
          scheduleReconnect(3000, 'detached_frame_keepalive');
        } else {
          console.warn('[WhatsApp Keep-Alive] Ping check non-fatal notice:', err.message);
        }
      }
    } else if (connectionStatus === 'Disconnected' && !isReconnecting) {
      // WATCHDOG: If stuck Disconnected for >3 min, force reconnect
      const now = Date.now();
      if (!disconnectedSince) {
        disconnectedSince = now;
      } else if (now - disconnectedSince > 180000) {
        console.warn('[WhatsApp Watchdog] Stuck Disconnected for 3+ min. Forcing reconnect...');
        disconnectedSince = null;
        scheduleReconnect(2000, 'watchdog_stuck_disconnected');
      }
    }
  }, 30000); // Ping every 30 seconds (was 2 min — too slow)
}

export function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}


// Auto-recovery watchdog with debouncing
export function scheduleReconnect(delayMs = 5000, reason = 'unknown') {
  if (isReconnecting) return;
  isReconnecting = true;
  stopKeepAlive();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[WhatsApp Client] Auto-reconnecting in ${delayMs / 1000}s (reason: ${reason})...`);
  if (broadcastFn) broadcastFn({ type: 'log', message: `🔄 WhatsApp auto-reconnecting in ${Math.round(delayMs/1000)}s (${reason})...` });

  reconnectTimer = setTimeout(async () => {
    try {
      // CRITICAL FIX: Always destroy and null-out client first so initWhatsappClient
      // guard (if client) return; never blocks the re-initialization
      if (client) {
        try { await client.destroy(); } catch (_) {}
        client = null; // Must be null BEFORE calling initWhatsappClient
      }
      qrCodeDataUrl = null;
      connectionStatus = 'Connecting';

      const authDir = path.join(process.cwd(), '.wwebjs_auth');
      restoreSessionIfCorrupted(authDir);
      clearStaleChromeLocks(authDir);

      // Extra 1.5s wait on Windows for Chrome file handles to release
      await new Promise(r => setTimeout(r, 1500));

      isReconnecting = false; // Reset BEFORE calling init so no guard blocks it
      initWhatsappClient(broadcastFn);
    } catch (e) {
      console.error('[WhatsApp Client] Reconnect attempt failed:', e.message);
      isReconnecting = false;
      // Auto-retry after 15s if reconnect itself failed
      setTimeout(() => scheduleReconnect(5000, `retry_after_${reason}_failure`), 15000);
    }
  }, delayMs);
}

export function getChromeExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('Using Puppeteer executable path from env:', process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const commonPaths = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    // Linux / VPS / Docker
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const pathStr of commonPaths) {
    if (pathStr && fs.existsSync(pathStr)) {
      console.log('Found Chrome/Chromium executable at:', pathStr);
      return pathStr;
    }
  }

  console.warn('Chrome/Chromium executable not found in common system paths. Falling back to default Puppeteer detection.');
  return undefined;
}

export function getWhatsappStatus() {
  return {
    status: connectionStatus,
    qr: qrCodeDataUrl,
    info: client?.info ? {
      pushname: client.info.pushname || null,
      phone: client.info.wid?.user || null
    } : null
  };
}

/**
 * Startup and pre-flight health check to verify active WhatsApp client readiness
 * Performs an active ping probe against the underlying Puppeteer execution context.
 */
export async function checkWhatsappHealth(probeTimeoutMs = 4000) {
  if (!client) {
    return {
      ready: false,
      state: 'NOT_INITIALIZED',
      connectionStatus,
      reason: 'WhatsApp client is not initialized.'
    };
  }

  if (connectionStatus !== 'Connected') {
    return {
      ready: false,
      state: connectionStatus,
      connectionStatus,
      reason: connectionStatus === 'QR_Ready'
        ? 'WhatsApp is not linked. QR code is ready to scan.'
        : `WhatsApp is currently ${connectionStatus}. Please wait for connection or link account.`
    };
  }

  // Active live probe: test if client.getState() responds and is CONNECTED
  try {
    const statePromise = client.getState();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`WhatsApp client probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs)
    );
    const state = await Promise.race([statePromise, timeoutPromise]);

    if (state !== 'CONNECTED') {
      console.warn(`[WhatsApp Health] Health probe returned non-connected state: ${state}`);
      scheduleReconnect(3000, `health_state_${state}`);
      return {
        ready: false,
        state: state || 'UNKNOWN',
        connectionStatus,
        reason: `WhatsApp session is in state: ${state || 'UNKNOWN'}. Expected CONNECTED.`
      };
    }

    return {
      ready: true,
      state: 'CONNECTED',
      connectionStatus,
      info: client?.info ? {
        pushname: client.info.pushname || null,
        phone: client.info.wid?.user || null
      } : null
    };
  } catch (probeErr) {
    console.error('[WhatsApp Health] Live probe check failed:', probeErr.message);
    if (/detached Frame|Execution context was destroyed|Session closed|Target closed/i.test(probeErr.message)) {
      console.warn('⚠️ [WhatsApp Health] Frame detached during health probe. Triggering client recovery...');
      scheduleReconnect(2000, 'detached_frame_health_probe');
    }
    return {
      ready: false,
      state: 'PROBE_FAILED',
      connectionStatus,
      reason: `WhatsApp client live probe failed: ${probeErr.message}`
    };
  }
}


export function initWhatsappClient(broadcastCallback) {
  if (client) return;
  broadcastFn = broadcastCallback;

  console.log('Initializing WhatsApp client...');
  const executablePath = getChromeExecutablePath();

  const authDir = path.join(process.cwd(), '.wwebjs_auth');
  restoreSessionIfCorrupted(authDir);
  clearStaleChromeLocks(authDir);

  // Start watchdog immediately on init so it can auto-recover even before first connect
  startKeepAlive();

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: authDir
    }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000,
    bypassCSP: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    authTimeoutMs: 120000,
    qrMaxRetries: 30,
    puppeteer: {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--no-first-run',
        '--no-zygote',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection'
      ]
    }
  });

  client.on('error', (err) => {
    console.error('WhatsApp Client internal error:', err);
  });

  connectionStatus = 'Connecting';
  if (broadcastFn) broadcastFn({ type: 'wa-status', status: connectionStatus });

  client.on('qr', async (qr) => {
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr, { margin: 3, width: 320, errorCorrectionLevel: 'M' });
      connectionStatus = 'QR_Ready';
      if (broadcastFn) {
        broadcastFn({ type: 'wa-status', status: connectionStatus, qr: qrCodeDataUrl });
        broadcastFn({ type: 'log', message: '📱 WhatsApp QR code ready. Please scan it to link session.' });
      }
    } catch (err) {
      console.error('Failed to generate QR data URL:', err);
    }
  });

  client.on('authenticated', () => {
    connectionStatus = 'Connected';
    qrCodeDataUrl = null;
    startKeepAlive();
    backupSession(authDir);
    console.log('WhatsApp client authenticated!');
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: '📱 WhatsApp authenticated successfully!' });
    }
  });

  client.on('ready', () => {
    connectionStatus = 'Connected';
    qrCodeDataUrl = null;
    startKeepAlive();
    backupSession(authDir);
    console.log('WhatsApp client is ready and session backed up!');
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: '✅ WhatsApp account linked and ready for testing!' });
    }
  });

  // ── Real-Time Incoming Reply Listener (Option 2: Hybrid AI Copilot) ──────
  client.on('message', async (msg) => {
    try {
      // Ignore broadcast status updates, group chats, newsletters, or our own messages
      if (msg.fromMe || !msg.from || !msg.from.endsWith('@c.us')) {
        return;
      }

      const senderPhone = msg.from.replace('@c.us', '');
      const incomingText = (msg.body || '').trim();
      if (!incomingText) return;

      console.log(`[WhatsApp Incoming] Received reply from +${senderPhone}: "${incomingText}"`);

      // Try to find matching lead in database using tenant-scoped resolution (Step 8B)
      const tenantId = 'default';
      const resolution = db.findLeadByPhoneScoped(senderPhone, tenantId);
      let lead = resolution.lead;
      const leadName = lead ? lead.businessName : `+${senderPhone}`;
      const location = lead?.location || 'Unknown Location';

      // Step 8C: Inbound Processing Pipeline
      const providerMsgId = (msg.id && (msg.id._serialized || msg.id.id))
        ? String(msg.id._serialized || msg.id.id)
        : `wmsg_${Date.now()}_${senderPhone}`;

      let conv = null;
      let ingestedMsg = null;

      // 1. Thread & Message Persistence
      if (resolution.status === 'MATCHED' && lead) {
        try {
          conv = db.getOrCreateConversation({
            tenantId,
            leadId: lead.id,
            channel: 'whatsapp',
            externalThreadId: senderPhone,
            status: 'ACTIVE'
          });

          // Run deterministic opt-out check to determine hasOptOut flag
          const optOutCheck = detectOptOut(incomingText, 'whatsapp');

          const ingestRes = db.ingestConversationMessage({
            tenantId,
            conversationId: conv.id,
            channel: 'whatsapp',
            direction: 'INBOUND',
            senderIdentifier: `+${senderPhone}`,
            recipientIdentifier: 'agency_whatsapp',
            providerMessageId: providerMsgId,
            messageText: incomingText,
            hasOptOut: optOutCheck.isOptOut ? 1 : 0,
            rawPayload: { from: msg.from, timestamp: msg.timestamp },
            receivedAt: new Date().toISOString()
          });
          ingestedMsg = ingestRes.message;

          // 2. Central Inbound Opt-Out / STOP Protection
          if (optOutCheck.isOptOut) {
            console.warn(`🛑 [WhatsApp Inbound] Explicit Opt-Out detected from +${senderPhone} (${leadName}): "${incomingText}" [Pattern: ${optOutCheck.matchedPattern}, Scope: ${optOutCheck.scope}]`);
            await handleInboundOptOut({
              senderPhone,
              incomingText,
              matchedPattern: optOutCheck.matchedPattern,
              scope: optOutCheck.scope,
              targetChannel: 'whatsapp',
              expiresAt: optOutCheck.expiresAt,
              conversationId: conv.id,
              messageId: ingestedMsg?.id,
              lead,
              broadcastFn,
              tenantId
            });
            return; // HARD STOP: HALT PIPELINE. DO NOT INVOKE AI COPILOT. DO NOT MOVE TO INTERESTED.
          }
        } catch (convErr) {
          console.error('[WhatsApp Inbound] Error persisting conversation/message:', convErr.message);
        }
      } else if (resolution.status === 'AMBIGUOUS_IDENTITY') {
        console.warn(`⚠️ [WhatsApp Inbound] Ambiguous identity detected for +${senderPhone} (${resolution.candidates.length} candidate leads). Quarantine required.`);
      } else {
        // Fallback opt-out check for unlinked contacts
        const optOutCheck = detectOptOut(incomingText, 'whatsapp');
        if (optOutCheck.isOptOut) {
          await handleInboundOptOut({
            senderPhone,
            incomingText,
            matchedPattern: optOutCheck.matchedPattern,
            scope: optOutCheck.scope,
            targetChannel: 'whatsapp',
            expiresAt: optOutCheck.expiresAt,
            broadcastFn,
            tenantId
          });
          return;
        }
      }

      // 1. Process Conversation Intelligence & Intent Classification
      let aiDraft = '';
      let detectedIntent = 'SERVICE_INQUIRY';
      try {
        const intelResult = await processConversationIntelligence({
          tenantId,
          conversationId: conv?.id,
          messageText: incomingText,
          channel: 'whatsapp',
          lead
        });
        aiDraft = intelResult.suggestedReply?.suggestedReply || '';
        detectedIntent = intelResult.classification?.intent || 'SERVICE_INQUIRY';
      } catch (aiErr) {
        console.warn('[WhatsApp Inbound] Fallback suggested reply:', aiErr.message);
        aiDraft = `Hi ${leadName}, thank you for reaching out! Would you be open for a quick 2-minute call today? Best regards, Tanuj & Amit | AI AutomationHubs`;
      }

      // 2. Step 8B Inbound Safety: Update lead response timestamps without mutating leadStatus to Interested!
      if (lead) {
        db.updateLead(lead.id, {
          lastReplyText: incomingText,
          lastReplyAt: new Date().toISOString(),
          last_inbound_at: new Date().toISOString(),
          aiSuggestedReply: aiDraft
        });
      }

      // 3. Broadcast real-time event to Web Dashboard
      if (broadcastFn) {
        broadcastFn({
          type: 'lead-replied',
          phone: senderPhone,
          businessName: leadName,
          replyText: incomingText,
          aiDraft: aiDraft,
          leadId: lead?.id || null,
          intent: detectedIntent
        });
        broadcastFn({
          type: 'log',
          message: `💬 WhatsApp reply from "${leadName}" [${detectedIntent}]: "${incomingText.substring(0, 50)}..."`
        });
        broadcastFn({ type: 'leads-updated' });
        broadcastFn({ type: 'conversations-updated' });
      }

      // 4. Send Instant Push Alert to Tanuj & Amit on Telegram Bot
      try {
        const cleanDigits = senderPhone.replace(/\D/g, '');
        const waSendLink = `https://wa.me/${cleanDigits}?text=${encodeURIComponent(aiDraft)}`;
        const callLink = `tel:+${cleanDigits}`;

        const tgAlertText = [
          `🔔 <b>New WhatsApp Reply Received!</b>`,
          `━━━━━━━━━━━━━━━━━━`,
          `🏢 <b>Lead:</b> ${escapeHtml(leadName)}`,
          `📍 <b>Location:</b> ${escapeHtml(location)}`,
          `📞 <b>Phone:</b> +${cleanDigits}`,
          `🏷️ <b>CRM Status:</b> Auto-moved to <b>Interested</b>`,
          ``,
          `💬 <b>Client Message:</b>`,
          `<i>"${escapeHtml(incomingText)}"</i>`,
          ``,
          `🤖 <b>OpenAI Suggested Reply (Ready to Send):</b>`,
          `<code>${escapeHtml(aiDraft)}</code>`,
          ``,
          `⚡ <b>1-Tap Quick Actions:</b>`,
          `👉 <a href="${waSendLink}"><b>[📲 Open WhatsApp with AI Draft]</b></a>`,
          `👉 <a href="${callLink}"><b>[📞 Call Lead Directly]</b></a>`
        ].join('\n');

        await sendTelegramBroadcast(tgAlertText, { parse_mode: 'HTML' });
      } catch (tgErr) {
        console.error('[WhatsApp Client] Failed to send Telegram alert for incoming reply:', tgErr.message);
      }

      // 5. Autonomous AI Auto-Reply (Hands-Free Dispatch)
      const settings = db.getSettings();
      const autoReplyEnabled = settings.waAutoReplyEnabled !== false;

      if (autoReplyEnabled && aiDraft && !optOutCheck?.isOptOut) {
        console.log(`[WhatsApp Auto-Reply] Scheduling autonomous reply for ${leadName} (+${senderPhone}) in 5s...`);
        if (broadcastFn) {
          broadcastFn({
            type: 'log',
            message: `🤖 [AI Auto-Reply] Queuing automated reply to "${leadName}" in 5s...`
          });
        }

        const typingDelay = Math.floor(Math.random() * 3000) + 4000; // 4 to 7 seconds realistic delay
        setTimeout(async () => {
          try {
            await sendWhatsappMessage(senderPhone, aiDraft);
            console.log(`✅ [WhatsApp Auto-Reply] Autonomous reply delivered to +${senderPhone}`);

            db.addWhatsappLog({
              leadId: lead?.id || null,
              leadName: leadName,
              phone: `+${senderPhone}`,
              status: 'AutoReplied',
              errorMessage: ''
            });

            if (conv) {
              try {
                db.ingestConversationMessage({
                  tenantId,
                  conversationId: conv.id,
                  channel: 'whatsapp',
                  direction: 'OUTBOUND',
                  senderIdentifier: 'agency_whatsapp',
                  recipientIdentifier: `+${senderPhone}`,
                  providerMessageId: `automsg_${Date.now()}_${senderPhone}`,
                  messageText: aiDraft,
                  rawPayload: { autoReply: true, intent: detectedIntent },
                  receivedAt: new Date().toISOString()
                });
              } catch (_) {}
            }

            if (broadcastFn) {
              broadcastFn({
                type: 'log',
                message: `✅ [AI Auto-Reply Sent] To "${leadName}": "${aiDraft.substring(0, 60)}..."`
              });
              broadcastFn({ type: 'leads-updated' });
              broadcastFn({ type: 'conversations-updated' });
            }

            // Telegram confirmation
            const tgConfirm = [
              `🤖 <b>AI Auto-Reply Sent!</b>`,
              `━━━━━━━━━━━━━━━━━━`,
              `🏢 <b>Lead:</b> ${escapeHtml(leadName)}`,
              `📞 <b>Phone:</b> +${senderPhone}`,
              `⚡ <b>Sent Message:</b>`,
              `<code>${escapeHtml(aiDraft)}</code>`
            ].join('\n');
            await sendTelegramBroadcast(tgConfirm, { parse_mode: 'HTML' });
          } catch (autoErr) {
            console.error(`[WhatsApp Auto-Reply] Failed to send to +${senderPhone}:`, autoErr.message);
          }
        }, typingDelay);
      }

    } catch (err) {
      console.error('[WhatsApp Client] Error processing incoming message:', err);
    }
  });

  client.on('auth_failure', (msg) => {
    stopKeepAlive();
    connectionStatus = 'Disconnected';
    qrCodeDataUrl = null;
    console.error('[WhatsApp Client] Auth failure:', msg);
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: `WhatsApp authentication failed: ${msg}. Scheduling auto-recovery...` });
    }
    scheduleReconnect(3000, 'auth_failure');
  });

  client.on('disconnected', (reason) => {
    stopKeepAlive();
    connectionStatus = 'Disconnected';
    qrCodeDataUrl = null;
    console.log('[WhatsApp Client] Disconnected:', reason);
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: `WhatsApp disconnected (${reason}). Auto-reconnecting...` });
    }
    // Auto-reconnect so the agent never dies permanently
    scheduleReconnect(5000, `disconnected_${reason}`);
  });

  client.initialize().catch(async err => {
    console.error('[WhatsApp Client] Error initializing WhatsApp client:', err);
    connectionStatus = 'Disconnected';
    if (broadcastFn) broadcastFn({ type: 'wa-status', status: connectionStatus });

    const authDir = path.join(process.cwd(), '.wwebjs_auth');
    // If Chrome is already running or directory is locked, clear locks and auto-retry
    if (err?.message?.includes('browser is already running') || err?.message?.includes('userDataDir')) {
      console.warn('⚠️ [WhatsApp Client] Detected zombie Chrome or locked directory. Cleaning stale locks and retrying in 5s...');
      clearStaleChromeLocks(authDir);
      scheduleReconnect(5000, 'browser_locked');
    } else {
      scheduleReconnect(10000, 'init_error');
    }
  });
}

export async function disconnectWhatsapp(hardReset = true) {
  stopKeepAlive();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isReconnecting = false;

  if (client) {
    try {
      await client.logout();
    } catch (e) {
      console.warn('[WhatsApp Client] Logout warning:', e.message);
    }
    try {
      await client.destroy();
    } catch (e) {
      console.warn('[WhatsApp Client] Destroy warning:', e.message);
    }
    client = null;
  }

  qrCodeDataUrl = null;
  connectionStatus = 'Connecting';
  if (broadcastFn) {
    broadcastFn({ type: 'wa-status', status: connectionStatus });
    broadcastFn({ type: 'log', message: 'WhatsApp session reset. Generating fresh QR code...' });
  }

  const authDir = path.join(process.cwd(), '.wwebjs_auth');
  const backupDir = path.join(process.cwd(), '.wwebjs_auth_backup');
  clearStaleChromeLocks(authDir);

  if (hardReset) {
    try {
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
      console.log('[WhatsApp Client] Cleaned old session and backup files for fresh QR generation.');
    } catch (e) {
      console.warn('[WhatsApp Client] Clean warning:', e.message);
    }
  }

  // Wait 2.5s for Windows to release file handles before re-launching
  setTimeout(() => {
    try {
      initWhatsappClient(broadcastFn);
    } catch (err) {
      console.error('[WhatsApp Client] Re-init WhatsApp failed:', err);
    }
  }, 2500);
}

// Graceful cleanup for server shutdown (SIGINT / SIGTERM)
export async function cleanupWhatsappProcess() {
  stopKeepAlive();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (client) {
    try {
      console.log('[WhatsApp Client] Gracefully closing browser...');
      await client.destroy();
    } catch (_) {}
    client = null;
  }
  const authDir = path.join(process.cwd(), '.wwebjs_auth');
  clearStaleChromeLocks(authDir);
}

function isDetachedFrameError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return /detached Frame|Execution context was destroyed|Session closed|Target closed/i.test(msg);
}

// Send WhatsApp message with worldwide number formatting, LID verification, typing emulation, and detached frame resilience
export async function sendWhatsappMessage(phone, messageText) {
  if (!client || connectionStatus !== 'Connected') {
    throw new Error('WhatsApp is not linked. Please scan the QR code first.');
  }

  // Pre-validate phone type to block landlines
  const phoneClassification = classifyPhoneType(phone);
  if (phoneClassification.type === 'in_landline') {
    throw new Error(`Landline number detected (${phoneClassification.e164}). Indian landlines/STD numbers cannot receive WhatsApp messages. Please provide a 10-digit mobile number.`);
  }

  // Clean digits using classification e164 or normalized input
  let cleanDigits = '';
  if (phoneClassification.e164) {
    cleanDigits = phoneClassification.e164.replace(/\D/g, '');
  } else {
    let rawDigits = String(phone || '').replace(/\D/g, '');
    if (rawDigits.length === 11 && rawDigits.startsWith('0')) {
      rawDigits = rawDigits.slice(1);
    }
    if (rawDigits.length === 10 && /^[6-9]/.test(rawDigits)) {
      rawDigits = '91' + rawDigits;
    }
    cleanDigits = rawDigits;
  }

  if (!cleanDigits || cleanDigits.length < 8 || cleanDigits.length > 15) {
    throw new Error(`Invalid phone number format: "${phone}". Please enter a valid number with country code.`);
  }

  console.log(`Worldwide WhatsApp dispatch: ${phone} -> Clean E.164: +${cleanDigits}`);
  const chatId = `${cleanDigits}@c.us`;

  // Verify number is registered on WhatsApp using getNumberId to prevent "No LID" error
  let targetJid = chatId;
  try {
    const numberId = await client.getNumberId(chatId);
    if (!numberId) {
      throw new Error(`The phone number +${cleanDigits} is not registered on WhatsApp. Please check that the country code and 10-digit number are correct.`);
    }
    targetJid = numberId._serialized;
  } catch (lookupErr) {
    if (isDetachedFrameError(lookupErr)) {
      console.warn(`⚠️ [WhatsApp Send] Execution frame detached during number lookup for +${cleanDigits}. Triggering client recovery...`);
      scheduleReconnect(2000, 'detached_frame_number_lookup');
      throw new Error('WhatsApp browser frame detached. Client auto-recovery initiated.');
    }
    if (lookupErr.message && lookupErr.message.includes('not registered')) throw lookupErr;
    // Otherwise fallback to direct targetJid
  }

  // Emulate realistic human typing presence before dispatching
  try {
    const chat = await client.getChatById(targetJid);
    if (chat) {
      await chat.sendStateTyping();
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 800) + 600));
      await chat.clearState();
    }
  } catch (presenceErr) {
    if (isDetachedFrameError(presenceErr)) {
      console.warn(`⚠️ [WhatsApp Send] Execution frame detached during presence emulation. Triggering recovery...`);
      scheduleReconnect(2000, 'detached_frame_presence');
      throw new Error('WhatsApp browser frame detached. Client auto-recovery initiated.');
    }
    // If presence check fails for other reasons, proceed with dispatch
  }

  try {
    const response = await client.sendMessage(targetJid, messageText);
    return response;
  } catch (sendErr) {
    if (isDetachedFrameError(sendErr)) {
      console.warn(`⚠️ [WhatsApp Send] Execution frame detached during message send to +${cleanDigits}. Triggering recovery...`);
      scheduleReconnect(2000, 'detached_frame_send');
      throw new Error('WhatsApp browser frame detached. Client auto-recovery initiated.');
    }
    if (sendErr.message && sendErr.message.includes('No LID')) {
      throw new Error(`The phone number +${cleanDigits} is not registered on WhatsApp. Please verify the 10-digit number and country code.`);
    }
    throw sendErr;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
