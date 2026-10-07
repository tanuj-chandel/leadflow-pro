import dotenv from 'dotenv';
dotenv.config();

// Refuse to start if ADMIN_PASSWORD or STAFF_PASSWORD are not set
if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_PASSWORD.trim() || !process.env.STAFF_PASSWORD || !process.env.STAFF_PASSWORD.trim()) {
  console.error('\n================================================================================');
  console.error('[FATAL STARTUP ERROR] Security Enforcement:');
  console.error('ADMIN_PASSWORD and STAFF_PASSWORD must be explicitly set in your .env file.');
  console.error('Server execution halted to prevent unauthorized access.');
  console.error('================================================================================\n');
  process.exit(1);
}

import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';

// Local TLS bypass for Windows antivirus/proxy inspection (avoids UNABLE_TO_VERIFY_LEAF_SIGNATURE)
if (process.env.ALLOW_INSECURE_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
import { db } from './database.js';
import { 
  evaluateLeadMatch, 
  resolveLeadContacts, 
  resolveAllEntities, 
  MEMBER_ROLES, 
  ENTITY_TYPES, 
  MATCH_LEVELS 
} from './entity-resolver.js';
import { enrichLead } from './business-intelligence-enricher.js';
import { 
  calculateLeadScores, 
  batchScoreLeads, 
  DEFAULT_ICP_PROFILE_V1, 
  PRIORITY_LEVELS, 
  SCORING_ENGINE_VERSION 
} from './lead-scoring-engine.js';
import {
  generateLeadRecommendation,
  batchGenerateRecommendations,
  ACTION_TYPES,
  RECOMMENDED_CHANNELS,
  URGENCY_LEVELS,
  RECOMMENDATION_ENGINE_VERSION
} from './sales-action-engine.js';
import {
  getCampaignReviewSummary,
  submitCampaignForReview,
  approveCampaign,
  rejectCampaign,
  reopenRejectedCampaign,
  cancelCampaign,
  listCampaignReviewLogs
} from './campaign-review-engine.js';
import {
  getExecutionStatus,
  previewCampaignExecution,
  executeCampaignDryRun,
  executeCampaignTouchDryRun,
  activateCampaign,
  pauseCampaign,
  resumeCampaign,
  EXECUTION_ERROR_CODES,
  EXECUTION_MODES
} from './campaign-execution-engine.js';
import {
  dispatchCampaignTouchLive,
  DISPATCH_ERROR_CODES,
  STALE_LOCK_THRESHOLD_MS,
  getCampaignExecutionHealth
} from './campaign-live-dispatch-engine.js';
import {
  reconcileCampaignTouchManual,
  getTouchReconciliationHistory,
  getStaleDispatchingTouches,
  RECONCILIATION_ERROR_CODES
} from './campaign-reconciliation-engine.js';
import { scrapeJob, SEGMENTS_CONFIG, generateInstantSegmentLeads, classifyPhoneType } from './scraper.js';
import { 
  getAuthUrl, 
  handleOAuthCallback, 
  createGmailDraft, 
  syncToGoogleSheet, 
  sendWhatsAppMessage,
  pollGmailInboundReplies
} from './outreach.js';
import { initWhatsappClient, getWhatsappStatus, checkWhatsappHealth, disconnectWhatsapp, cleanupWhatsappProcess, sendWhatsappMessage as sendRawWhatsappMessage } from './whatsapp-client.js';
import { getBotInfo, sendTelegramMessage, sendTelegramBroadcast, sendLeadDossierToTelegram } from './telegram-bot.js';
import { 
  getTelegramClientStatus, 
  getTelegramRateLimitStatus,
  resetTelegramRateLimits,
  sendLoginCode, 
  completeLogin, 
  sendLeadTelegramMessage, 
  initTelegramUserClient 
} from './telegram-user-client.js';
import { executeOutreachGate, checkBatchEligibility, checkOutreachEligibility, getComplianceConfig, REASON_CODES, SUPPORTED_CHANNELS } from './compliance-engine.js';
import { 
  ATTRIBUTION_MODELS,
  calculateOpportunityAttribution, 
  recognizeOpportunityRevenue, 
  getRevenueAnalytics 
} from './revenue-attribution-engine.js';
import {
  computePipelineVelocity,
  detectSlaBreachesAndBottlenecks,
  computeCohortAnalytics,
  computeLossReasonAnalysis,
  generateDecisionSnapshot
} from './decision-intelligence-engine.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Request logger for debugging connection issues
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(process.cwd(), 'public')));

// SSE Log Clients
let logClients = [];

function broadcast(data) {
  logClients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// --- Real-time Logging Event Stream ---
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  logClients.push(res);

  req.on('close', () => {
    logClients = logClients.filter(c => c !== res);
  });
});

// --- Session & Operator Authentication for Web UI ---
const activeWebSessions = new Map();

function verifyWebSession(req) {
  const token = req.headers['x-session-token'] || req.query.token;
  if (!token) return null;
  const session = activeWebSessions.get(token);
  if (!session) return null;
  if (session.expiresAt && Date.now() > session.expiresAt) {
    activeWebSessions.delete(token);
    return null;
  }
  return session;
}

// 1. Web Login endpoint
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();

  const adminUser = (process.env.ADMIN_USERNAME || 'tanuj').trim().toLowerCase();
  const adminPass = (process.env.ADMIN_PASSWORD || '').trim();

  const staffUser = (process.env.STAFF_USERNAME || 'operator').trim().toLowerCase();
  const staffPass = (process.env.STAFF_PASSWORD || '').trim();

  let userRole = null;
  let displayName = null;

  if (cleanUser === adminUser && cleanPass === adminPass) {
    userRole = 'ADMIN';
    displayName = 'Tanuj Chandel (Admin)';
  } else if (cleanUser === staffUser && cleanPass === staffPass) {
    userRole = 'STAFF';
    displayName = 'Operator';
  } else {
    return res.status(401).json({ success: false, error: 'Invalid username or password' });
  }

  const sessionToken = 'sess_' + crypto.randomBytes(24).toString('hex');
  const sessionData = {
    username: cleanUser,
    displayName,
    role: userRole,
    createdAt: Date.now(),
    expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
  };
  activeWebSessions.set(sessionToken, sessionData);

  res.json({
    success: true,
    token: sessionToken,
    user: {
      username: cleanUser,
      displayName,
      role: userRole
    }
  });
});

// 2. Check current session / user profile
app.get('/api/auth/me', (req, res) => {
  const session = verifyWebSession(req);
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: {
      username: session.username,
      displayName: session.displayName,
      role: session.role
    }
  });
});

// 3. Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) activeWebSessions.delete(token);
  res.json({ success: true, message: 'Logged out successfully' });
});

// --- Settings Endpoints (STRICT ADMIN ACCESS ONLY) ---
app.get('/api/settings', (req, res) => {
  const session = verifyWebSession(req);
  // If not admin, deny access completely to protect all API keys
  if (!session || session.role !== 'ADMIN') {
    return res.status(403).json({ 
      error: 'ACCESS_DENIED', 
      message: 'Settings tab is restricted to Administrator only.' 
    });
  }

  const settings = db.getSettings();
  const clientResponse = {
    ...settings,
    isGoogleConnected: !!(settings.googleTokens && settings.googleTokens.refresh_token),
    googleTokens: undefined
  };
  res.json(clientResponse);
});

app.post('/api/settings', (req, res) => {
  const session = verifyWebSession(req);
  if (!session || session.role !== 'ADMIN') {
    return res.status(403).json({ 
      error: 'ACCESS_DENIED', 
      message: 'Modifying settings is restricted to Administrator only.' 
    });
  }

  const settings = db.updateSettings(req.body);
  res.json({
    success: true,
    settings: {
      ...settings,
      isGoogleConnected: !!(settings.googleTokens && settings.googleTokens.refresh_token),
      googleTokens: undefined
    }
  });
});

// --- Locations Endpoints ---
app.get('/api/locations', (req, res) => {
  res.json(db.getLocations());
});

app.post('/api/locations', (req, res) => {
  const { term, location, maxLeads } = req.body;
  if (!term || !location) {
    return res.status(400).json({ error: 'Term and Location are required.' });
  }
  const newLoc = db.addLocation(term, location, maxLeads);
  res.json(newLoc);
});

app.delete('/api/locations/:id', (req, res) => {
  db.deleteLocation(req.params.id);
  res.json({ success: true });
});

app.post('/api/locations/:id/run', async (req, res) => {
  const { id } = req.params;
  const { overwrite } = req.body;
  const locs = db.getLocations();
  const found = locs.find(l => l.id === id);

  if (!found) {
    return res.status(404).json({ error: 'Location search not found' });
  }

  if (found.status === 'Scraping') {
    return res.status(400).json({ error: 'Scraper is already running for this location.' });
  }

  // Clear existing leads for this specific query if overwrite mode is selected
  if (overwrite) {
    db.clearLeadsForQuery(found.term, found.location);
  }

  // Run asynchronously
  res.json({ success: true, message: 'Scraper started' });
  
  try {
    await scrapeJob(id, (event) => broadcast(event));
  } catch (err) {
    console.error('Job run failure:', err);
    broadcast({ type: 'location-update', id, status: 'Error', error: err.message });
  }
});

// --- Segments Endpoints ---
app.get('/api/segments', (req, res) => {
  const leads = db.getLeads();
  const segmentStats = SEGMENTS_CONFIG.map(seg => {
    const segLeads = leads.filter(l => l.segment === seg.name);
    return {
      ...seg,
      totalLeads: segLeads.length,
      hotLeads: segLeads.filter(l => l.qualityScore === 'Hot').length,
      withPhone: segLeads.filter(l => l.phone && l.phone.trim().length >= 10).length,
      withEmail: segLeads.filter(l => l.email && l.email.trim() !== '').length
    };
  });
  res.json(segmentStats);
});

app.post('/api/leads/generate-instant', async (req, res) => {
  const { segmentId, location, count } = req.body;
  const numCount = parseInt(count, 10) || 10;
  
  try {
    const added = await generateInstantSegmentLeads(segmentId, location, numCount, (event) => broadcast(event));
    broadcast({ type: 'leads-updated' });
    res.json({ success: true, added, message: `Generated ${added} leads.` });
  } catch (err) {
    console.error('Instant lead generation failed:', err);
    broadcast({ type: 'log', message: `❌ Error: ${err.message}` });
    res.status(500).json({ success: false, error: err.message });
  }
});


// --- Leads Endpoints ---
app.get('/api/leads', (req, res) => {
  let leads = db.getLeads();
  const { 
    search, 
    segment, 
    qualityScore, 
    leadStatus, 
    hasPhone, 
    hasAllThree, 
    emailStatus, 
    whatsappStatus, 
    minRating,
    noWebsite,
    mobileOnly,
    highOpportunity,
    safetyStatusFilter
  } = req.query;

  // Fetch active suppressions map for fast O(1) safety lookup
  const activeSuppressions = new Map();
  try {
    const suppRows = db.sqlite.prepare(`
      SELECT normalized_contact, channel, reason FROM suppression_list
      WHERE expires_at IS NULL OR expires_at > datetime('now')
    `).all();
    for (const s of suppRows) {
      if (!activeSuppressions.has(s.normalized_contact)) {
        activeSuppressions.set(s.normalized_contact, []);
      }
      activeSuppressions.get(s.normalized_contact).push(s);
    }
  } catch (_) {}

  const complianceCfg = getComplianceConfig();
  const maxAttempts = complianceCfg?.maxAttempts?.whatsapp || 3;
  const cooldownHours = complianceCfg?.cooldownHours?.whatsapp || 48;

  // Compute phone type, website status, high-opportunity flags, safety status, and provenance
  leads = leads.map(l => {
    const hasP = !!(l.phone && l.phone.trim().length >= 7);
    const hasW = !!(l.website && l.website.trim() !== '');
    const hasS = !!(l.facebook || l.instagram || l.linkedin || l.twitter);
    const contactScore = (hasP ? 1 : 0) + (hasW ? 1 : 0) + (hasS ? 1 : 0);
    const hasAll3 = hasP && hasW && hasS;

    const phoneClass = classifyPhoneType(l.phone);
    const isMobile = phoneClass.isMobile;
    const isLandline = phoneClass.type === 'in_landline';
    const isWhatsAppReady = phoneClass.isWhatsAppReady;
    const isNoWebsite = !hasW;
    const ratingNum = typeof l.rating === 'number' ? l.rating : 0;
    // High Opportunity: Strong rating (>= 4.0) with NO website
    const isHighOpportunity = isNoWebsite && ratingNum >= 4.0;

    // Safety status calculation
    let safetyStatus = 'ALLOWED';
    let safetyReasonCode = 'ALLOWED';
    let safetyReason = 'Eligible for outreach';

    if (l.opted_out === 1) {
      safetyStatus = 'BLOCKED';
      safetyReasonCode = 'LEAD_OPTED_OUT';
      safetyReason = 'Lead opted out / sent STOP';
    } else if (l.phone && activeSuppressions.has(l.phone)) {
      safetyStatus = 'BLOCKED';
      const supp = activeSuppressions.get(l.phone)[0];
      safetyReasonCode = supp.channel === 'ALL' ? 'GLOBAL_SUPPRESSION' : 'CHANNEL_SUPPRESSION';
      safetyReason = `Suppressed: ${supp.reason || 'Opt-out'}`;
    } else if (l.email && activeSuppressions.has(l.email.toLowerCase().trim())) {
      safetyStatus = 'BLOCKED';
      const supp = activeSuppressions.get(l.email.toLowerCase().trim())[0];
      safetyReasonCode = supp.channel === 'ALL' ? 'GLOBAL_SUPPRESSION' : 'CHANNEL_SUPPRESSION';
      safetyReason = `Email suppressed: ${supp.reason || 'Opt-out'}`;
    } else if ((l.outreach_attempt_count || 0) >= maxAttempts) {
      safetyStatus = 'BLOCKED';
      safetyReasonCode = 'MAX_ATTEMPTS_REACHED';
      safetyReason = `Max outreach attempts (${l.outreach_attempt_count}/${maxAttempts}) reached`;
    } else if (l.last_outreach_at) {
      const elapsedMs = Date.now() - new Date(l.last_outreach_at).getTime();
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        safetyStatus = 'RESTRICTED';
        safetyReasonCode = 'COOLDOWN_ACTIVE';
        const remHours = Math.ceil((cooldownMs - elapsedMs) / (60 * 60 * 1000));
        safetyReason = `Cooldown active (~${remHours}h remaining)`;
      }
    }

    // Provenance & verification flags
    const isMock = l.dataMode === 'MOCK' || l.dataMode === 'SIMULATED' || l.isMock === true;
    const dataProvenance = isMock ? 'MOCK / SIMULATED' : 'REAL';
    const isPlacesVerified = Boolean(l.placeId && l.placeId.length > 5);
    const isPhoneVerified = hasP;
    const isWebsiteActive = hasW;

    return { 
      ...l, 
      contactScore, 
      hasAll3,
      phoneType: phoneClass.type,
      phoneLabel: phoneClass.label,
      isMobile,
      isLandline,
      isWhatsAppReady,
      isNoWebsite,
      isHighOpportunity,
      safetyStatus,
      safetyReasonCode,
      safetyReason,
      dataProvenance,
      isPlacesVerified,
      isPhoneVerified,
      isWebsiteActive
    };
  });

  if (search) {
    const q = String(search).toLowerCase();
    leads = leads.filter(l => 
      (l.businessName && l.businessName.toLowerCase().includes(q)) ||
      (l.email && l.email.toLowerCase().includes(q)) ||
      (l.searchTerm && l.searchTerm.toLowerCase().includes(q)) ||
      (l.location && l.location.toLowerCase().includes(q)) ||
      (l.segment && l.segment.toLowerCase().includes(q))
    );
  }

  if (segment && segment !== 'all') {
    leads = leads.filter(l => l.segment && l.segment.toLowerCase() === segment.toLowerCase());
  }

  if (qualityScore && qualityScore !== 'all') {
    leads = leads.filter(l => l.qualityScore === qualityScore);
  }

  if (leadStatus && leadStatus !== 'all') {
    leads = leads.filter(l => l.leadStatus === leadStatus);
  }

  if (minRating && minRating !== 'all') {
    if (minRating === '4.5') {
      leads = leads.filter(l => typeof l.rating === 'number' && l.rating >= 4.5);
    } else if (minRating === '4.0') {
      leads = leads.filter(l => typeof l.rating === 'number' && l.rating >= 4.0);
    } else if (minRating === 'under4') {
      leads = leads.filter(l => typeof l.rating === 'number' && l.rating < 4.0);
    }
  }

  if (hasPhone === 'true') {
    leads = leads.filter(l => l.phone && l.phone.trim().length >= 7);
  }

  if (mobileOnly === 'true') {
    leads = leads.filter(l => l.isMobile);
  }

  if (req.query.telegramReady === 'true') {
    leads = leads.filter(l => l.isMobile || (l.telegram && l.telegram.trim() !== ''));
  }

  if (noWebsite === 'true') {
    leads = leads.filter(l => l.isNoWebsite);
  }

  if (highOpportunity === 'true') {
    leads = leads.filter(l => l.isHighOpportunity);
  }

  if (hasAllThree === 'true') {
    leads = leads.filter(l => l.hasAll3);
  }

  if (emailStatus) {
    leads = leads.filter(l => l.emailStatus === emailStatus);
  }

  if (whatsappStatus) {
    leads = leads.filter(l => l.whatsappStatus === whatsappStatus);
  }

  if (safetyStatusFilter && safetyStatusFilter !== 'all') {
    leads = leads.filter(l => l.safetyStatus === safetyStatusFilter);
  }

  // Sorting rule:
  // 1. High Opportunity (No Website & 4★+) or 3/3 Complete
  // 2. qualityScore (Hot > Warm > Cold)
  // 3. Recency
  const qualityWeight = { 'Hot': 3, 'Warm': 2, 'Cold': 1 };
  leads.sort((a, b) => {
    // Put leads with valid WhatsApp-ready mobile first if requested
    if (b.isHighOpportunity !== a.isHighOpportunity) {
      return (b.isHighOpportunity ? 1 : 0) - (a.isHighOpportunity ? 1 : 0);
    }
    if (b.contactScore !== a.contactScore) {
      return b.contactScore - a.contactScore;
    }
    const weightA = qualityWeight[a.qualityScore] || 0;
    const weightB = qualityWeight[b.qualityScore] || 0;
    if (weightB !== weightA) {
      return weightB - weightA;
    }
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  res.json(leads);
});


app.put('/api/leads/:id', (req, res) => {
  const updated = db.updateLead(req.params.id, req.body);
  if (updated) {
    broadcast({ type: 'leads-updated', leadId: req.params.id });
    res.json({ success: true, lead: updated });
  } else {
    res.status(404).json({ error: 'Lead not found' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  db.deleteLead(req.params.id);
  broadcast({ type: 'leads-updated' });
  res.json({ success: true });
});

app.post('/api/leads/clear', (req, res) => {
  db.clearLeads();
  broadcast({ type: 'leads-updated' });
  res.json({ success: true });
});

app.post('/api/leads/sync-sheets', async (req, res) => {
  try {
    const result = await syncToGoogleSheet();
    res.json({ success: true, url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/export-csv', (req, res) => {
  const leads = db.getLeads();
  
  const headers = [
    'Business Name', 'Segment', 'Quality Score', 'Lead Status',
    'Search Term', 'Location', 'Phone', 'Email', 
    'Website', 'Facebook', 'Instagram', 'LinkedIn', 'Twitter', 
    'Address', 'Rating', 'Email Draft Status', 'WhatsApp Status'
  ];

  const esc = (v) => `"${(v || '').toString().replace(/"/g, '""')}"`;

  const rows = leads.map(l => [
    esc(l.businessName), esc(l.segment), esc(l.qualityScore), esc(l.leadStatus),
    esc(l.searchTerm), esc(l.location), esc(l.phone), esc(l.email),
    esc(l.website), esc(l.facebook), esc(l.instagram), esc(l.linkedin), esc(l.twitter),
    esc(l.address), esc(l.rating), esc(l.emailStatus || 'Pending'), esc(l.whatsappStatus || 'Pending')
  ]);

  const csvContent = [headers.map(h => `"${h}"`).join(','), ...rows.map(r => r.join(','))].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leadflow_export_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csvContent);
});

// --- OAuth Google Endpoints ---
app.get('/api/oauth/connect', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authentication code missing.');
  }
  try {
    await handleOAuthCallback(code);
    // Redirect back to our app's main page
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

app.post('/api/oauth/disconnect', (req, res) => {
  db.updateSettings({ googleTokens: null, googleSheetId: '' });
  res.json({ success: true });
});

// --- Telegram Bot Endpoints ---
app.post('/api/telegram/test', async (req, res) => {
  try {
    const { botToken, chatIds } = req.body;
    const settings = db.getSettings();
    const token = (botToken || settings.telegramBotToken || '').trim();
    const rawIds = (chatIds || settings.telegramChatIds || '').trim();

    if (!token) {
      return res.status(400).json({ error: 'Telegram Bot Token is required.' });
    }
    if (!rawIds) {
      return res.status(400).json({ error: 'At least one Telegram Chat ID is required.' });
    }

    const bot = await getBotInfo(token);
    const idList = String(rawIds).split(/[\n,\s]+/).map(id => id.trim()).filter(Boolean);

    if (!idList.length) {
      return res.status(400).json({ error: 'Please enter at least one valid Chat ID.' });
    }

    const results = [];
    for (const chatId of idList) {
      try {
        const text = `🤖 <b>AI AutomationHubs Bot Connected!</b>\n\n✅ Successfully verified bot: <b>@${bot.username}</b>\n\n👥 <b>Team:</b>\n• Tanuj Chandel (📞 +91-7704077700)\n• Amit Pandey (📞 +91-9990080408)\n\n🚀 You will receive instant live lead alerts on this chat!`;
        await sendTelegramMessage(token, chatId, text, { parse_mode: 'HTML' });
        results.push({ chatId, status: 'Sent' });
      } catch (e) {
        results.push({ chatId, status: 'Error', error: e.message });
      }
    }

    const anySuccess = results.some(r => r.status === 'Sent');
    if (anySuccess) {
      res.json({ success: true, bot, results });
    } else {
      res.status(400).json({ error: 'Failed to deliver message to Chat IDs', results });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/telegram/push-lead/:id', async (req, res) => {
  try {
    const lead = db.getLeads().find(l => l.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const result = await sendLeadDossierToTelegram(lead);
    if (result.success) {
      res.json({ success: true, message: 'Lead pushed to Telegram successfully!' });
    } else {
      res.status(400).json({ error: result.reason || 'Failed to dispatch to Telegram.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Telegram User Client (Direct Lead Messaging) Endpoints ---
app.get('/api/telegram-user/status', (req, res) => {
  res.json(getTelegramClientStatus());
});

app.post('/api/telegram-user/send-code', async (req, res) => {
  try {
    const { phone } = req.body;
    const targetPhone = phone || '+917704077700';
    const result = await sendLoginCode(targetPhone);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/telegram-user/verify-code', async (req, res) => {
  try {
    const { code, password } = req.body;
    if (!code) return res.status(400).json({ error: 'OTP Code is required.' });
    const result = await completeLogin(code, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/telegram-user/send-lead/:id', async (req, res) => {
  try {
    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const { message } = req.body;

    const gateResult = await executeOutreachGate({
      leadId: req.params.id,
      lead,
      channel: 'telegram',
      sendFn: async (l) => {
        return await sendLeadTelegramMessage(l, message);
      },
      req
    });

    if (gateResult.blocked) {
      return res.status(403).json({
        success: false,
        blocked: true,
        reasonCode: gateResult.reasonCode,
        reason: gateResult.reason,
        compliance: gateResult.compliance
      });
    }

    if (!gateResult.success) {
      return res.status(400).json({
        success: false,
        blocked: false,
        error: gateResult.error,
        compliance: gateResult.compliance
      });
    }

    db.updateLead(lead.id, { telegram: 'Sent', leadStatus: 'Contacted' });
    res.json({
      success: true,
      result: gateResult.result,
      compliance: gateResult.compliance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Outreach API Endpoints ---

// Create Email Drafts in Gmail for Selected Leads
app.post('/api/outreach/email-draft', async (req, res) => {
  const { leadIds } = req.body;
  if (!leadIds || !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds array is required.' });
  }

  res.json({ success: true, message: 'Gmail draft creation job started.' });

  // Process in the background and broadcast progress
  broadcast({ type: 'email-job-start', total: leadIds.length });

  let successCount = 0;
  let failCount = 0;
  let blockedCount = 0;

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

    if (!lead) continue;
    
    broadcast({ 
      type: 'email-job-progress', 
      current: i + 1, 
      total: leadIds.length, 
      message: `Evaluating compliance & creating draft for ${lead.businessName}...` 
    });

    const gateResult = await executeOutreachGate({
      leadId,
      lead,
      channel: 'email',
      sendFn: async (l) => {
        return await createGmailDraft(l);
      },
      req
    });

    if (gateResult.blocked) {
      db.updateLead(leadId, { emailStatus: `Blocked: ${gateResult.reasonCode}` });
      broadcast({ 
        type: 'log', 
        message: `🛑 [Compliance Blocked] Email draft for "${lead.businessName}": ${gateResult.reason}` 
      });
      blockedCount++;
      continue;
    }

    if (gateResult.success) {
      db.updateLead(leadId, { emailStatus: 'Draft Created' });
      successCount++;
    } else {
      console.error(`Gmail draft creation failed for ${lead.businessName}:`, gateResult.error);
      db.updateLead(leadId, { emailStatus: `Error: ${gateResult.error}` });
      failCount++;
    }

    // Small delay to prevent hitting API limits
    await new Promise(r => setTimeout(r, 400));
  }

  broadcast({ 
    type: 'email-job-end', 
    successCount, 
    failCount, 
    blockedCount,
    message: `Draft process complete. Created ${successCount} drafts, blocked ${blockedCount}, failed ${failCount}.` 
  });
  broadcast({ type: 'leads-updated' });
});

// Send WhatsApp Message for Selected Leads
app.post('/api/outreach/whatsapp', async (req, res) => {
  const { leadIds } = req.body;
  if (!leadIds || !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds array is required.' });
  }

  // Pre-flight health check: Verify WhatsApp client is connected and responsive
  const health = await checkWhatsappHealth();
  if (!health.ready) {
    return res.status(503).json({
      success: false,
      error: `WhatsApp client is not ready (${health.reason || health.state}). Please scan the QR code or wait for session reconnection before initiating batch outreach.`,
      health
    });
  }

  res.json({ success: true, message: 'WhatsApp sending job started.' });

  broadcast({ type: 'whatsapp-job-start', total: leadIds.length });

  let successCount = 0;
  let failCount = 0;
  let blockedCount = 0;

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

    if (!lead) continue;

    broadcast({ 
      type: 'whatsapp-job-progress', 
      current: i + 1, 
      total: leadIds.length, 
      message: `Evaluating compliance & sending WhatsApp to ${lead.businessName}...` 
    });

    const gateResult = await executeOutreachGate({
      leadId,
      lead,
      channel: 'whatsapp',
      sendFn: async (l) => {
        return await sendWhatsAppMessage(l);
      },
      req
    });

    if (gateResult.blocked) {
      db.updateLead(leadId, { whatsappStatus: `Blocked: ${gateResult.reasonCode}` });
      broadcast({ 
        type: 'log', 
        message: `🛑 [Compliance Blocked] WhatsApp to "${lead.businessName}": ${gateResult.reason}` 
      });
      blockedCount++;
      continue;
    }

    if (gateResult.success) {
      db.updateLead(leadId, { 
        whatsappStatus: 'Sent',
        leadStatus: 'Contacted'
      });
      db.addWhatsappLog({
        leadId,
        leadName: lead.businessName,
        phone: lead.phone,
        status: 'Sent'
      });
      successCount++;
    } else {
      console.error(`WhatsApp send failed for ${lead.businessName}:`, gateResult.error);
      db.updateLead(leadId, { whatsappStatus: `Error: ${gateResult.error}` });
      db.addWhatsappLog({
        leadId,
        leadName: lead.businessName,
        phone: lead.phone,
        status: 'Failed',
        errorMessage: gateResult.error
      });
      failCount++;

      // Fail-fast circuit breaker: if error indicates detached frame or unlinked client, halt batch immediately
      if (gateResult.error && /detached Frame|frame detached|WhatsApp is not linked|scan the QR/i.test(gateResult.error)) {
        const remaining = leadIds.length - (i + 1);
        broadcast({
          type: 'log',
          message: `🛑 [WhatsApp Circuit Breaker] Client session dropped or frame detached (${gateResult.error}). Halting remaining ${remaining} leads to prevent error cascading.`
        });
        break;
      }
    }

    // Anti-spam randomized human delay between messages (prevents immediate WhatsApp ban)
    if (i < leadIds.length - 1) {
      const settings = db.getSettings();
      const minDelay = parseInt(settings.waDelayMin, 10) || 15;
      const maxDelay = parseInt(settings.waDelayMax, 10) || 30;
      const delaySec = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      
      broadcast({
        type: 'log',
        message: `⏳ Anti-ban safety interval: waiting ${delaySec}s before reaching next contact...`
      });

      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  broadcast({ 
    type: 'whatsapp-job-end', 
    successCount, 
    failCount, 
    blockedCount,
    message: `WhatsApp process complete. Sent ${successCount} messages, blocked ${blockedCount}, failed ${failCount}.` 
  });
  broadcast({ type: 'leads-updated' });
  broadcast({ type: 'whatsapp-updated' });
});

// Bulk Telegram Outreach for Selected Leads
app.post('/api/outreach/telegram', async (req, res) => {
  const { leadIds } = req.body;
  if (!leadIds || !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds array is required.' });
  }

  // Pre-flight check: Verify Telegram account is not restricted by PEER_FLOOD
  const rateLimitStatus = getTelegramRateLimitStatus();
  if (rateLimitStatus.isPeerFlooded) {
    return res.status(429).json({
      success: false,
      error: 'Telegram outreach is currently blocked due to active PEER_FLOOD restriction. Please contact @SpamBot on Telegram to resolve restrictions.',
      rateLimitStatus
    });
  }

  if (rateLimitStatus.isRateLimited) {
    return res.status(429).json({
      success: false,
      error: `Telegram is currently in flood-wait. Please wait ${rateLimitStatus.remainingSeconds}s before starting outreach.`,
      rateLimitStatus
    });
  }

  res.json({ success: true, message: 'Telegram outreach job started.' });

  broadcast({ type: 'tg-job-start', total: leadIds.length });

  let successCount = 0;
  let failCount = 0;
  let blockedCount = 0;

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

    if (!lead) continue;

    broadcast({ 
      type: 'tg-job-progress', 
      current: i + 1, 
      total: leadIds.length, 
      message: `Evaluating compliance & sending Telegram to ${lead.businessName}...` 
    });

    const gateResult = await executeOutreachGate({
      leadId,
      lead,
      channel: 'telegram',
      sendFn: async (l) => {
        return await sendLeadTelegramMessage(l);
      },
      req
    });

    if (gateResult.blocked) {
      db.updateLead(leadId, { telegram: `Blocked: ${gateResult.reasonCode}` });
      broadcast({ 
        type: 'log', 
        message: `🛑 [Compliance Blocked] Telegram to "${lead.businessName}": ${gateResult.reason}` 
      });
      blockedCount++;
      continue;
    }

    if (gateResult.success) {
      db.updateLead(leadId, { telegram: 'Sent', leadStatus: 'Contacted' });
      successCount++;
    } else {
      console.error(`Telegram send failed for ${lead.businessName}:`, gateResult.error);
      db.updateLead(leadId, { telegram: `Error: ${gateResult.error}` });
      failCount++;

      // Circuit Breaker 1: PEER_FLOOD abuse rate limit triggered
      if (gateResult.error && /PEER_FLOOD/i.test(gateResult.error)) {
        const remaining = leadIds.length - (i + 1);
        broadcast({
          type: 'log',
          message: `🚨 [Telegram Circuit Breaker] PEER_FLOOD abuse limit triggered! Halting remaining ${remaining} leads to protect Telegram account from permanent ban. Check @SpamBot.`
        });
        break;
      }

      // Circuit Breaker 2: FLOOD_WAIT rate limit triggered
      if (gateResult.error && /FLOOD_WAIT/i.test(gateResult.error)) {
        const status = getTelegramRateLimitStatus();
        const waitSec = status.remainingSeconds || 60;
        broadcast({
          type: 'log',
          message: `⏳ [Telegram Queue Pause] Flood-wait triggered. Pausing queue for ${waitSec}s before reaching next contact...`
        });
        await new Promise(r => setTimeout(r, (waitSec + 2) * 1000));
      }
    }

    // Conservative anti-spam randomized delay between Telegram messages (prevents PEER_FLOOD triggers)
    if (i < leadIds.length - 1) {
      const settings = db.getSettings();
      const minDelay = parseInt(settings.tgDelayMin, 10) || 45;
      const maxDelay = parseInt(settings.tgDelayMax, 10) || 75;
      const delaySec = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      broadcast({
        type: 'log',
        message: `⏳ Telegram safe pacing interval: waiting ${delaySec}s before reaching next contact...`
      });
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  broadcast({ 
    type: 'tg-job-end', 
    successCount, 
    failCount, 
    blockedCount,
    message: `Telegram process complete. Sent ${successCount} messages, blocked ${blockedCount}, failed ${failCount}.` 
  });
  broadcast({ type: 'leads-updated' });
});

// Pre-flight live WhatsApp client health check endpoint
app.get('/api/whatsapp/health', async (req, res) => {
  try {
    const health = await checkWhatsappHealth();
    if (!health.ready) {
      return res.status(503).json(health);
    }
    res.json(health);
  } catch (err) {
    res.status(500).json({ ready: false, error: err.message });
  }
});

// Telegram rate limit status and manual reset endpoints
app.get('/api/telegram/rate-limit', (req, res) => {
  res.json(getTelegramRateLimitStatus());
});

app.post('/api/telegram/rate-limit/reset', (req, res) => {
  res.json(resetTelegramRateLimits());
});

// Get WhatsApp logs/history
// Get WhatsApp logs/history
app.get('/api/whatsapp/logs', (req, res) => {
  res.json(db.getWhatsappLogs().reverse()); // Newest first
});

// Get WhatsApp QR code & client link status
app.get('/api/whatsapp/status', (req, res) => {
  res.json(getWhatsappStatus());
});

// Disconnect/Logout WhatsApp session
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    await disconnectWhatsapp();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preflight Batch Eligibility Check Endpoint
app.post('/api/outreach/preflight', async (req, res) => {
  try {
    const { leadIds, channel } = req.body;
    if (!leadIds || !Array.isArray(leadIds) || !channel) {
      return res.status(400).json({ error: 'leadIds array and channel are required.' });
    }
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const opts = { tenantId };
    const batchResult = await checkBatchEligibility(leadIds, channel, opts);
    res.json({
      channel,
      totalChecked: batchResult.summary?.total || leadIds.length,
      eligibleCount: batchResult.summary?.allowedCount || batchResult.eligible?.length || 0,
      blockedCount: batchResult.summary?.blockedCount || batchResult.blocked?.length || 0,
      eligibleLeadIds: (batchResult.eligible || []).map(d => d.leadId),
      blockedLeadIds: (batchResult.blocked || []).map(d => d.leadId),
      eligible: batchResult.eligible || [],
      blockedLeads: batchResult.blocked || [],
      reasonsSummary: batchResult.summary?.reasonsSummary || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 1 STEP 5: Compliance & Safety UI API Endpoints
// ==============================================================================

// 1. Dashboard Global & Channel Safety Stats
app.get('/api/compliance/stats', (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const config = getComplianceConfig();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Most recent compliance audit event
    const lastAudit = db.sqlite.prepare(`
      SELECT created_at, decision, reason, channel FROM compliance_audit_logs 
      WHERE tenant_id = ? 
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId);

    // Active channels stats
    const channels = ['whatsapp', 'telegram', 'email'];
    const channelStats = {};

    for (const ch of channels) {
      const quota = db.getDailyQuotaUsage(ch, todayStr, tenantId);
      const limit = config.dailyLimits[ch] || 50;
      const used = quota.attempt_count || 0;
      const remaining = Math.max(0, limit - used);

      const suppressedRow = db.sqlite.prepare(`
        SELECT COUNT(*) as count FROM suppression_list
        WHERE tenant_id = ? 
          AND (channel = 'ALL' OR LOWER(channel) = LOWER(?))
          AND (expires_at IS NULL OR expires_at > datetime('now'))
      `).get(tenantId, ch);

      channelStats[ch] = {
        allowed: remaining > 0,
        dailyLimit: limit,
        usedToday: used,
        remainingToday: remaining,
        attemptsToday: quota.attempt_count || 0,
        successToday: quota.success_count || 0,
        blockedToday: quota.blocked_count || 0,
        suppressedCount: suppressedRow ? suppressedRow.count : 0,
        cooldownHours: config.cooldownHours[ch] || 48,
        maxAttempts: config.maxAttempts[ch] || 3
      };
    }

    res.json({
      engineStatus: 'ACTIVE',
      outboundSafety: 'VERIFIED',
      failClosedProtection: 'ACTIVE',
      lastCheckTimestamp: lastAudit ? lastAudit.created_at : null,
      lastCheckDecision: lastAudit ? lastAudit.decision : null,
      channels: channelStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Suppression List Retrieval with Filtering & Search
app.get('/api/compliance/suppressions', (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const { channel, contactType, search, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT s.*, l.businessName as lead_business_name 
      FROM suppression_list s
      LEFT JOIN leads l ON s.lead_id = l.id
      WHERE s.tenant_id = ?
    `;
    const params = [tenantId];

    if (channel && channel !== 'ALL' && channel !== 'ALL_CHANNELS') {
      sql += ` AND (s.channel = 'ALL' OR LOWER(s.channel) = LOWER(?))`;
      params.push(channel);
    }
    if (contactType && contactType !== 'ALL') {
      sql += ` AND LOWER(s.contact_type) = LOWER(?)`;
      params.push(contactType);
    }
    if (search) {
      sql += ` AND (s.normalized_contact LIKE ? OR s.reason LIKE ? OR l.businessName LIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countRow = db.sqlite.prepare(countSql).get(...params);

    sql += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, parseInt(limit, 10) || 50));
    params.push(Math.max(0, parseInt(offset, 10) || 0));

    const rows = db.sqlite.prepare(sql).all(...params);

    res.json({
      total: countRow ? countRow.total : rows.length,
      suppressions: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Add Manual Suppression
app.post('/api/compliance/suppressions', (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const { contact, contactType = 'phone', channel = 'ALL', reason = 'MANUAL_SUPPRESSION', notes } = req.body;
    if (!contact) {
      return res.status(400).json({ error: 'Contact identifier is required.' });
    }
    const record = db.createSuppression({
      tenantId,
      normalizedContact: contact,
      contactType,
      channel,
      reason,
      source: 'ADMIN_UI',
      notes
    });
    db.createComplianceAuditLog({
      tenantId,
      channel: channel || 'ALL',
      eventType: 'manual_suppression_added',
      contactIdentifier: contact,
      decision: 'BLOCKED',
      reason: `Manual suppression via UI: ${reason}`,
      metadata: { notes, addedBy: 'ADMIN_UI' }
    });
    res.json({ success: true, suppression: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Remove / Unsuppress Contact
app.delete('/api/compliance/suppressions', (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const { contact, channel = 'ALL', id } = req.body;

    if (id) {
      const existing = db.sqlite.prepare('SELECT * FROM suppression_list WHERE id = ? AND tenant_id = ?').get(id, tenantId);
      if (existing) {
        db.sqlite.prepare('DELETE FROM suppression_list WHERE id = ? AND tenant_id = ?').run(id, tenantId);
        db.createComplianceAuditLog({
          tenantId,
          channel: existing.channel,
          eventType: 'suppression_removed',
          contactIdentifier: existing.normalized_contact,
          decision: 'REMOVED',
          reason: 'Manual unsuppression via UI',
          metadata: { id, removedBy: 'ADMIN_UI' }
        });
        return res.json({ success: true, changes: 1 });
      }
    }

    if (!contact) {
      return res.status(400).json({ error: 'Contact or id is required.' });
    }

    const result = db.removeSuppression(contact, channel, tenantId);
    db.createComplianceAuditLog({
      tenantId,
      channel: channel || 'ALL',
      eventType: 'suppression_removed',
      contactIdentifier: contact,
      decision: 'REMOVED',
      reason: 'Manual unsuppression via UI',
      metadata: { channel, removedBy: 'ADMIN_UI' }
    });
    res.json({ success: true, changes: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Compliance Audit Logs (Sanitized, No Private Message Bodies)
app.get('/api/compliance/audit-logs', (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const { channel, decision, eventType, leadId, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT a.*, l.businessName as lead_business_name
      FROM compliance_audit_logs a
      LEFT JOIN leads l ON a.lead_id = l.id
      WHERE a.tenant_id = ?
    `;
    const params = [tenantId];

    if (channel && channel !== 'ALL') {
      sql += ` AND LOWER(a.channel) = LOWER(?)`;
      params.push(channel);
    }
    if (decision && decision !== 'ALL') {
      sql += ` AND a.decision = ?`;
      params.push(decision);
    }
    if (eventType && eventType !== 'ALL') {
      sql += ` AND a.event_type = ?`;
      params.push(eventType);
    }
    if (leadId) {
      sql += ` AND a.lead_id = ?`;
      params.push(leadId);
    }

    const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
    const countRow = db.sqlite.prepare(countSql).get(...params);

    sql += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, parseInt(limit, 10) || 50));
    params.push(Math.max(0, parseInt(offset, 10) || 0));

    const rows = db.sqlite.prepare(sql).all(...params).map(row => {
      let meta = null;
      if (row.metadata) {
        try {
          meta = JSON.parse(row.metadata);
          if (meta && typeof meta === 'object') {
            delete meta.message;
            delete meta.body;
            delete meta.rawText;
            delete meta.token;
            delete meta.secret;
          }
        } catch (_) {
          meta = null;
        }
      }
      return { ...row, metadata: meta };
    });

    res.json({
      total: countRow ? countRow.total : rows.length,
      logs: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Single Lead Realtime Preflight Safety Check
app.get('/api/compliance/check-lead/:id/:channel', async (req, res) => {
  try {
    const { id, channel } = req.params;
    const tenantId = req.headers['x-tenant-id'] || 'default';
    const result = await checkOutreachEligibility(id, channel, tenantId);

    let safetyStatus = 'BLOCKED';
    if (result.eligible) {
      safetyStatus = 'ALLOWED';
    } else if (result.reasonCode === REASON_CODES.COOLDOWN_ACTIVE || result.reasonCode === REASON_CODES.DAILY_QUOTA_EXCEEDED) {
      safetyStatus = 'RESTRICTED';
    }

    res.json({
      leadId: id,
      channel,
      eligible: result.eligible,
      safetyStatus,
      reasonCode: result.reasonCode,
      reason: result.reason,
      contactIdentifier: result.contactIdentifier,
      cooldownRemainingMs: result.cooldownRemainingMs || 0,
      quotaRemaining: result.quotaRemaining !== undefined ? result.quotaRemaining : null,
      checkedAt: result.checkedAt
    });
  } catch (err) {
    res.status(500).json({
      eligible: false,
      safetyStatus: 'BLOCKED',
      reasonCode: 'COMPLIANCE_CHECK_ERROR',
      reason: err.message
    });
  }
});

// Send Test WhatsApp message to user
app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    const targetPhone = (phone || '+918791338600').trim();
    const testMsg = message || `🧪 *WhatsApp Test Verification*\n\nHello! Your WhatsApp automation integration is linked and operational.\n\n⏰ Sent at: ${new Date().toLocaleTimeString()}\n🚀 AI AutomationHubs LeadFlow Pro`;

    const gateResult = await executeOutreachGate({
      contactIdentifier: targetPhone,
      channel: 'whatsapp',
      sendFn: async () => {
        return await sendRawWhatsappMessage(targetPhone, testMsg);
      },
      req
    });

    if (gateResult.blocked) {
      return res.status(403).json({
        success: false,
        blocked: true,
        reasonCode: gateResult.reasonCode,
        reason: gateResult.reason,
        compliance: gateResult.compliance
      });
    }

    if (!gateResult.success) {
      return res.status(500).json({
        success: false,
        blocked: false,
        error: gateResult.error,
        compliance: gateResult.compliance
      });
    }

    db.addWhatsappLog({
      leadName: 'WhatsApp Test Verification',
      phone: targetPhone,
      status: 'Sent',
      errorMessage: ''
    });

    broadcast({ type: 'log', message: `✅ Live test WhatsApp sent to ${targetPhone}` });
    broadcast({ type: 'whatsapp-updated' });

    res.json({
      success: true,
      phone: targetPhone,
      message: testMsg,
      compliance: gateResult.compliance
    });
  } catch (err) {
    console.error('Test WhatsApp error:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch test WhatsApp message' });
  }
});

// ==============================================================================
// PHASE 2 — ADVANCED LEAD INTELLIGENCE API ENDPOINTS
// ==============================================================================

// Helper middleware for lead ownership validation
function checkLeadIntelligenceAuth(req, res, next) {
  const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
  const leadId = req.params.leadId || req.params.id;
  const ownership = db.validateLeadOwnership(leadId, tenantId);
  if (!ownership.valid) {
    return res.status(ownership.notFound ? 404 : 403).json({
      error: ownership.reason,
      reasonCode: ownership.notFound ? 'LEAD_NOT_FOUND' : 'AUTHORIZATION_BLOCKED'
    });
  }
  req.intelligenceLead = ownership.lead;
  req.intelligenceTenant = tenantId;
  next();
}

// 1. Get intelligence profile for a lead
app.get('/api/intelligence/leads/:id', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const profile = db.getLeadIntelligence(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      intelligence: profile
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get normalized contacts for a lead
app.get('/api/intelligence/leads/:id/contacts', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const contacts = db.getLeadContacts(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: contacts.length,
      contacts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get evidence trail for a lead
app.get('/api/intelligence/leads/:id/evidence', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const evidence = db.getLeadEvidence(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: evidence.length,
      evidence
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get business signals for a lead
app.get('/api/intelligence/leads/:id/signals', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const signals = db.getLeadSignals(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: signals.length,
      signals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get versioned score snapshots for a lead
app.get('/api/intelligence/leads/:id/scores', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const scores = db.getLeadScores(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: scores.length,
      scores
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 — STEP 2: BUSINESS ENTITY & CONTACT RESOLUTION API ENDPOINTS
// ==============================================================================

// 1. Get Entity details, canonical status, and siblings for a lead
app.get('/api/intelligence/entity/:id', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const entityGroup = db.getEntityGroupByLeadId(leadId, tenantId);

    if (!entityGroup) {
      return res.json({
        leadId,
        tenantId,
        resolved: false,
        entityGroup: null,
        message: 'Lead has not been grouped into an entity yet. Run entity resolution or add manually.'
      });
    }

    const memberRecord = entityGroup.members.find(m => m.lead_id === leadId);
    const siblings = entityGroup.members.filter(m => m.lead_id !== leadId);

    res.json({
      leadId,
      tenantId,
      resolved: true,
      role: memberRecord ? memberRecord.role : 'UNKNOWN',
      matchConfidence: memberRecord ? memberRecord.match_confidence : 1.0,
      matchReason: memberRecord ? memberRecord.match_reason : null,
      canonicalLeadId: entityGroup.canonical_lead_id,
      isCanonical: entityGroup.canonical_lead_id === leadId,
      entityGroup: {
        id: entityGroup.id,
        entityName: entityGroup.entity_name,
        normalizedName: entityGroup.normalized_name,
        primaryDomain: entityGroup.primary_domain,
        entityType: entityGroup.entity_type,
        confidenceScore: entityGroup.confidence_score,
        status: entityGroup.status,
        metadata: entityGroup.metadata,
        memberCount: entityGroup.members.length,
        siblings
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Real-time candidate matches for a lead
app.get('/api/intelligence/entity/:id/matches', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const lead = req.intelligenceLead;
    const tenantId = req.intelligenceTenant;
    const allLeads = db.getLeads(tenantId);

    const matches = [];
    for (const other of allLeads) {
      if (other.id === lead.id) continue;
      const evaluation = evaluateLeadMatch(lead, other);
      if (evaluation.matchLevel !== MATCH_LEVELS.NO_MATCH) {
        matches.push({
          candidateLeadId: other.id,
          businessName: other.businessName,
          phone: other.phone,
          email: other.email,
          website: other.website,
          address: other.address || other.location,
          matchLevel: evaluation.matchLevel,
          confidence: evaluation.confidence,
          relationType: evaluation.relationType,
          reasons: evaluation.reasons,
          signals: evaluation.signals
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);

    res.json({
      leadId: lead.id,
      tenantId,
      totalMatches: matches.length,
      matches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Resolved contacts with deterministic decision-maker classification
app.get('/api/intelligence/entity/:id/contacts', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const lead = req.intelligenceLead;
    const tenantId = req.intelligenceTenant;
    const storedContacts = db.getLeadContacts(lead.id, tenantId);
    const resolvedContacts = resolveLeadContacts(lead, storedContacts);

    res.json({
      leadId: lead.id,
      tenantId,
      count: resolvedContacts.length,
      contacts: resolvedContacts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. List entity groups for tenant
app.get('/api/intelligence/entity/groups', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const { entityType, status, limit = 50, offset = 0 } = req.query;

    const groups = db.listEntityGroups({
      tenantId,
      entityType: entityType || null,
      status: status || null,
      limit,
      offset
    });

    res.json({
      tenantId,
      count: groups.length,
      groups
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Trigger deterministic entity resolution across tenant leads
app.post('/api/intelligence/entity/resolve', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const dryRun = req.body.dryRun !== false; // Default to true (DRY RUN FIRST) for safety

    const leads = db.getLeads(tenantId);
    const result = resolveAllEntities(leads, {
      tenantId,
      dryRun,
      dbInstance: db.sqlite
    });

    res.json({
      tenantId,
      dryRun,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Manual review and role update for entity memberships
app.post('/api/intelligence/entity/review', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const { action, groupId, leadId, role, status, canonicalLeadId, entityType } = req.body;

    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required.' });
    }

    if (action === 'UPDATE_ROLE') {
      if (!leadId || !role) {
        return res.status(400).json({ error: 'leadId and role are required for UPDATE_ROLE action.' });
      }
      if (!Object.values(MEMBER_ROLES).includes(role)) {
        return res.status(400).json({ error: `Invalid role. Allowed roles: ${Object.values(MEMBER_ROLES).join(', ')}` });
      }
      db.updateEntityMemberRole(groupId, leadId, role, tenantId);
      return res.json({ success: true, message: `Member ${leadId} role updated to ${role}` });
    }

    if (action === 'UPDATE_GROUP') {
      db.updateEntityGroup(groupId, { status, canonical_lead_id: canonicalLeadId, entity_type: entityType }, tenantId);
      return res.json({ success: true, message: `Entity group ${groupId} updated successfully` });
    }

    res.status(400).json({ error: 'Invalid review action. Supported actions: UPDATE_ROLE, UPDATE_GROUP' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 — STEP 3: BUSINESS INTELLIGENCE ENRICHMENT API ENDPOINTS
// ==============================================================================

// 1. Enrich a single lead
app.post('/api/intelligence/enrich/:id', checkLeadIntelligenceAuth, async (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const { forceRefresh = false, dryRun = false, maxPages = 5 } = req.body;

    const result = await enrichLead(leadId, {
      tenantId,
      forceRefresh,
      dryRun,
      maxPages,
      dbInstance: db
    });

    res.json({
      success: true,
      leadId,
      tenantId,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Batch enrichment
app.post('/api/intelligence/enrich/batch', async (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const { leadIds, limit = 10, dryRun = false, forceRefresh = false } = req.body;

    let targetIds = leadIds;
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      const tenantLeads = db.getLeads(tenantId);
      targetIds = tenantLeads.slice(0, Math.min(parseInt(limit, 10) || 10, 50)).map(l => l.id);
    }

    const results = [];
    for (const id of targetIds) {
      const ownership = db.validateLeadOwnership(id, tenantId);
      if (!ownership.valid) {
        results.push({ leadId: id, status: 'SKIPPED', error: 'Unauthorized lead' });
        continue;
      }
      try {
        const enriched = await enrichLead(id, {
          tenantId,
          forceRefresh,
          dryRun,
          dbInstance: db
        });
        results.push({
          leadId: id,
          status: enriched.status,
          industry: enriched.profile.industry,
          evidenceCount: enriched.evidenceCount,
          signalsCount: enriched.signalsCount,
          contactsCount: enriched.contactsCount
        });
      } catch (err) {
        results.push({ leadId: id, status: 'FAILED', error: err.message });
      }
    }

    res.json({
      success: true,
      tenantId,
      totalRequested: targetIds.length,
      processed: results.length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get enrichment run status
app.get('/api/intelligence/enrich/:id/status', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const run = db.getLatestEnrichmentRun(leadId, tenantId);

    res.json({
      leadId,
      tenantId,
      hasRun: Boolean(run),
      latestRun: run || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get comprehensive intelligence summary
app.get('/api/intelligence/enrich/:id/summary', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const intelligence = db.getLeadIntelligence(leadId, tenantId);
    const evidence = db.getLeadEvidence(leadId, tenantId);
    const signals = db.getLeadSignals(leadId, tenantId);
    const contacts = db.getLeadContacts(leadId, tenantId);
    const latestRun = db.getLatestEnrichmentRun(leadId, tenantId);

    res.json({
      leadId,
      tenantId,
      businessName: req.intelligenceLead.businessName,
      website: req.intelligenceLead.website,
      phone: req.intelligenceLead.phone,
      intelligence,
      evidenceCount: evidence.length,
      signalsCount: signals.length,
      contactsCount: contacts.length,
      latestRun,
      evidence,
      signals,
      contacts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get evidence list
app.get('/api/intelligence/enrich/:id/evidence', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const evidence = db.getLeadEvidence(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: evidence.length,
      evidence
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get signals list
app.get('/api/intelligence/enrich/:id/signals', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const signals = db.getLeadSignals(req.params.id, req.intelligenceTenant);
    res.json({
      leadId: req.params.id,
      tenantId: req.intelligenceTenant,
      count: signals.length,
      signals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Force refresh enrichment
app.post('/api/intelligence/enrich/:id/refresh', checkLeadIntelligenceAuth, async (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const result = await enrichLead(leadId, {
      tenantId,
      forceRefresh: true,
      dbInstance: db
    });

    res.json({
      success: true,
      leadId,
      tenantId,
      refreshed: true,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 — STEP 4: LEAD SCORING, ICP FIT & SALES PRIORITY API ENDPOINTS
// ==============================================================================

// 1. Batch score multiple leads (must precede :id route)
app.post('/api/intelligence/score/batch', async (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId || 'default').trim();
    const { leadIds = [], forceRecalculate = false } = req.body || {};

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds array is required.' });
    }

    const targetIds = leadIds.slice(0, 50);
    const batchResult = await batchScoreLeads(targetIds, {
      tenantId,
      dbInstance: db,
      forceRecalculate: Boolean(forceRecalculate)
    });

    res.json({
      success: true,
      ...batchResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Calculate / Retrieve score for a single lead
app.post('/api/intelligence/score/:id', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const { forceRecalculate = false } = req.body || {};

    const scoreResult = calculateLeadScores(leadId, {
      tenantId,
      dbInstance: db,
      forceRecalculate: Boolean(forceRecalculate)
    });

    res.json({
      success: true,
      ...scoreResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get current score for a lead
app.get('/api/intelligence/score/:id', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const latest = db.getLatestLeadScore(leadId, tenantId, 'sales_priority');

    if (!latest) {
      // Calculate on-the-fly if not scored yet
      const calculated = calculateLeadScores(leadId, {
        tenantId,
        dbInstance: db,
        forceRecalculate: false
      });
      return res.json({
        success: true,
        ...calculated
      });
    }

    res.json({
      success: true,
      leadId,
      tenantId,
      scoreId: latest.id,
      scoreVersion: latest.score_version,
      scoringVersion: latest.scoring_version || 1,
      icpProfileVersion: latest.icp_profile_version,
      icpFitScore: latest.icp_fit_score,
      opportunityScore: latest.opportunity_score,
      dataConfidenceScore: latest.data_confidence_score,
      salesPriorityScore: latest.sales_priority_score,
      priorityLevel: latest.priority_level,
      positiveFactors: typeof latest.positive_factors === 'string' ? JSON.parse(latest.positive_factors) : latest.positive_factors,
      negativeFactors: typeof latest.negative_factors === 'string' ? JSON.parse(latest.negative_factors) : latest.negative_factors,
      unknownFactors: typeof latest.unknown_factors === 'string' ? JSON.parse(latest.unknown_factors) : latest.unknown_factors,
      scoreBreakdown: typeof latest.score_breakdown === 'string' ? JSON.parse(latest.score_breakdown) : latest.score_breakdown,
      inputHash: latest.input_hash,
      calculatedAt: latest.calculated_at,
      disclaimer: 'Priority score is an evidence-based sales prioritization aid, not a prediction of conversion, revenue, or business success.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get score version history for a lead
app.get('/api/intelligence/score/:id/history', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const allScores = db.getLeadScores(leadId, tenantId);

    res.json({
      success: true,
      leadId,
      tenantId,
      count: allScores.length,
      history: allScores.map(s => ({
        id: s.id,
        scoreVersion: s.score_version,
        scoringVersion: s.scoring_version || 1,
        scoreType: s.score_type,
        salesPriorityScore: s.sales_priority_score,
        icpFitScore: s.icp_fit_score,
        opportunityScore: s.opportunity_score,
        dataConfidenceScore: s.data_confidence_score,
        priorityLevel: s.priority_level,
        calculatedAt: s.calculated_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get explainable score breakdown and decision-support rationale
app.get('/api/intelligence/score/:id/explanation', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const latest = db.getLatestLeadScore(leadId, tenantId, 'sales_priority') || calculateLeadScores(leadId, { tenantId, dbInstance: db });

    res.json({
      success: true,
      leadId,
      tenantId,
      businessName: req.intelligenceLead.businessName,
      scoringVersion: latest.scoring_version || latest.scoringVersion || 1,
      priorityLevel: latest.priority_level || latest.priorityLevel,
      salesPriorityScore: latest.sales_priority_score || latest.salesPriorityScore,
      icpFitScore: latest.icp_fit_score || latest.icpFitScore,
      opportunityScore: latest.opportunity_score || latest.opportunityScore,
      dataConfidenceScore: latest.data_confidence_score || latest.dataConfidenceScore,
      positiveFactors: typeof latest.positive_factors === 'string' ? JSON.parse(latest.positive_factors) : (latest.positiveFactors || latest.positive_factors),
      negativeFactors: typeof latest.negative_factors === 'string' ? JSON.parse(latest.negative_factors) : (latest.negativeFactors || latest.negative_factors),
      unknownFactors: typeof latest.unknown_factors === 'string' ? JSON.parse(latest.unknown_factors) : (latest.unknownFactors || latest.unknown_factors),
      scoreBreakdown: typeof latest.score_breakdown === 'string' ? JSON.parse(latest.score_breakdown) : (latest.scoreBreakdown || latest.score_breakdown),
      disclaimer: 'Priority score is an evidence-based sales prioritization aid, not a prediction of conversion, revenue, or business success.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get active ICP configuration for tenant
app.get('/api/intelligence/icp/config', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const version = req.query.version;
    const profile = db.getIcpProfile(tenantId, version) || DEFAULT_ICP_PROFILE_V1;

    res.json({
      success: true,
      tenantId,
      profile: {
        ...profile,
        target_industries: typeof profile.target_industries === 'string' ? JSON.parse(profile.target_industries) : profile.target_industries,
        excluded_industries: typeof profile.excluded_industries === 'string' ? JSON.parse(profile.excluded_industries) : profile.excluded_industries,
        target_regions: typeof profile.target_regions === 'string' ? JSON.parse(profile.target_regions) : profile.target_regions,
        business_types: typeof profile.business_types === 'string' ? JSON.parse(profile.business_types) : profile.business_types,
        weights: typeof profile.weights === 'string' ? JSON.parse(profile.weights) : profile.weights,
        rules: typeof profile.rules === 'string' ? JSON.parse(profile.rules) : profile.rules
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Save / update ICP configuration for tenant (increments version)
app.post('/api/intelligence/icp/config', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const profileData = req.body || {};

    const saved = db.saveIcpProfile(tenantId, profileData);

    res.json({
      success: true,
      tenantId,
      message: `Saved ICP configuration version ${saved.version}`,
      profile: saved
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 — STEP 5: SALES ACTION RECOMMENDATIONS API ENDPOINTS
// ==============================================================================

// 1. Batch generate recommendations (must precede :id route)
app.post('/api/intelligence/recommendations/batch', async (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || req.body?.tenantId || 'default').trim();
    const { leadIds = [], forceRecalculate = false } = req.body || {};

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'leadIds array is required.' });
    }

    const targetIds = leadIds.slice(0, 50);
    const batchResult = await batchGenerateRecommendations(targetIds, {
      tenantId,
      dbInstance: db,
      forceRecalculate: Boolean(forceRecalculate)
    });

    res.json({
      success: true,
      ...batchResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. List recommendations with filters (actionType, priorityBand, reviewStatus)
app.get('/api/intelligence/recommendations', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const { actionType, priorityBand, reviewStatus, limit = 50, offset = 0 } = req.query;

    const recommendations = db.listRecommendations({
      tenantId,
      actionType: actionType || null,
      priorityBand: priorityBand || null,
      reviewStatus: reviewStatus || null,
      limit,
      offset
    });

    res.json({
      success: true,
      tenantId,
      count: recommendations.length,
      recommendations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get latest recommendation for a single lead
app.get('/api/intelligence/recommendations/:id', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const { forceRecalculate = false } = req.query;

    const recommendation = generateLeadRecommendation(leadId, {
      tenantId,
      dbInstance: db,
      forceRecalculate: forceRecalculate === 'true' || forceRecalculate === true
    });

    res.json({
      success: true,
      leadId,
      tenantId,
      businessName: req.intelligenceLead.businessName,
      recommendation
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Force refresh/recalculate recommendation for a single lead
app.post('/api/intelligence/recommendations/:id/refresh', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;

    const recommendation = generateLeadRecommendation(leadId, {
      tenantId,
      dbInstance: db,
      forceRecalculate: true
    });

    res.json({
      success: true,
      refreshed: true,
      leadId,
      tenantId,
      recommendation
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Submit human review feedback on a recommendation (Human-in-the-Loop)
app.post('/api/intelligence/recommendations/:id/review', checkLeadIntelligenceAuth, (req, res) => {
  try {
    const leadId = req.params.id;
    const tenantId = req.intelligenceTenant;
    const { status = 'ACCEPTED', notes = null, reviewedBy = 'sales_rep', recommendationId } = req.body || {};

    let targetRecId = recommendationId;
    if (!targetRecId) {
      const latest = db.getLatestRecommendation(leadId, tenantId);
      if (!latest) {
        return res.status(404).json({ error: `No recommendation found to review for lead ${leadId}` });
      }
      targetRecId = latest.id;
    }

    const updated = db.updateRecommendationReviewState(targetRecId, {
      status,
      notes,
      reviewed_by: reviewedBy
    }, tenantId);

    res.json({
      success: true,
      leadId,
      tenantId,
      recommendation: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// CAMPAIGN CRUD ROUTES — List, Create, Get, Update, Delete campaigns
// ==============================================================================

// GET /api/campaigns — List all campaigns for tenant
app.get('/api/campaigns', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const { status, review_status, limit = 50, offset = 0 } = req.query;
    const campaigns = db.listCampaigns(tenantId, {
      status: status || null,
      review_status: review_status || null,
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0
    });
    res.json({ success: true, campaigns, count: campaigns.length, tenantId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — Create a new campaign
app.post('/api/campaigns', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const { name, objective, target_criteria, channel_strategy, sequence_plan, status } = req.body;
    const campaign = db.createCampaign({
      name,
      objective,
      target_criteria: target_criteria || {},
      channel_strategy: channel_strategy || { primary: 'EMAIL' },
      sequence_plan: sequence_plan || null,
      status: status || 'DRAFT'
    }, tenantId);
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/campaigns/:id — Get a single campaign
app.get('/api/campaigns/:id', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const campaign = db.getCampaignById(req.params.id, tenantId);
    if (!campaign) {
      return res.status(404).json({ error: `Campaign "${req.params.id}" not found`, reasonCode: 'CAMPAIGN_NOT_FOUND' });
    }
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaigns/:id — Update a campaign
app.put('/api/campaigns/:id', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const allowed = ['name', 'objective', 'target_criteria', 'channel_strategy', 'sequence_plan', 'status'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const campaign = db.updateCampaign(req.params.id, updates, tenantId);
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id — Cancel/delete a draft campaign
app.delete('/api/campaigns/:id', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const campaign = db.getCampaignById(req.params.id, tenantId);
    if (!campaign) {
      return res.status(404).json({ error: `Campaign "${req.params.id}" not found`, reasonCode: 'CAMPAIGN_NOT_FOUND' });
    }
    // Only allow deleting DRAFT campaigns — others must use /cancel
    if (!['DRAFT', 'PENDING', 'REJECTED'].includes(campaign.status)) {
      return res.status(409).json({
        error: `Cannot delete campaign in status "${campaign.status}". Use /cancel for active campaigns.`,
        reasonCode: 'INVALID_STATUS_FOR_DELETE'
      });
    }
    db.updateCampaign(req.params.id, { status: 'CANCELLED' }, tenantId);
    res.json({ success: true, message: `Campaign "${req.params.id}" cancelled.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/leads — List leads in a campaign
app.get('/api/campaigns/:id/leads', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const campaign = db.getCampaignById(req.params.id, tenantId);
    if (!campaign) {
      return res.status(404).json({ error: `Campaign "${req.params.id}" not found`, reasonCode: 'CAMPAIGN_NOT_FOUND' });
    }
    const leads = db.listCampaignLeads(req.params.id, tenantId);
    res.json({ success: true, campaignId: req.params.id, leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/leads — Add a lead to a campaign
app.post('/api/campaigns/:id/leads', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const { lead_id, target_contact_handle, channel, eligibility_status } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
    const campaignLead = db.createCampaignLead({
      campaign_id: req.params.id,
      lead_id,
      tenant_id: tenantId,
      target_contact_handle: target_contact_handle || null,
      channel: channel || null,
      eligibility_status: eligibility_status || 'ELIGIBLE'
    }, tenantId);
    res.status(201).json({ success: true, campaignLead });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==============================================================================
// OPERATOR KEY MANAGEMENT ROUTES
// ==============================================================================

// GET /api/operator-keys — List all operator keys for tenant
app.get('/api/operator-keys', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const keys = db.getOperatorKeys(tenantId);
    // Never expose key_hash — return safe fields only
    const safeKeys = keys.map(k => ({
      id: k.id,
      actorId: k.actor_id,
      actorName: k.actor_name,
      actorRole: k.actor_role,
      tenantId: k.tenant_id,
      isActive: k.is_active,
      createdAt: k.created_at,
      expiresAt: k.expires_at
    }));
    res.json({ success: true, keys: safeKeys, count: safeKeys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/operator-keys — Create a new operator key
app.post('/api/operator-keys', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.body.tenantId || 'default').trim();
    const { actorId, actorName, actorRole, expiresAt } = req.body;
    if (!actorId || !actorName || !actorRole) {
      return res.status(400).json({ error: 'actorId, actorName, and actorRole are required' });
    }
    const result = db.createOperatorKey({ actorId, actorName, actorRole, tenantId, expiresAt: expiresAt || null });
    res.status(201).json({
      success: true,
      key: result,
      warning: 'Store the rawKey securely — it cannot be retrieved again.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/operator-keys/:keyId — Revoke an operator key
app.delete('/api/operator-keys/:keyId', (req, res) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
    const revoked = db.revokeOperatorKey(req.params.keyId, tenantId);
    if (!revoked) {
      return res.status(404).json({ error: `Operator key "${req.params.keyId}" not found`, reasonCode: 'KEY_NOT_FOUND' });
    }
    res.json({ success: true, message: `Operator key "${req.params.keyId}" revoked.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 STEP 6E / 6F-B.1 — AUTHENTICATION & CAMPAIGN AUTHORIZATION MIDDLEWARE
// ==============================================================================

// Step 6F-B.1 Authentication Hardening: Operator Key Authentication Middleware
export function authenticateOperator(req, res, next) {
  const authHeader = req.headers['authorization'];
  const opKeyHeader = req.headers['x-operator-key'];

  let rawKey = null;
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && (parts[0].toLowerCase() === 'bearer' || parts[0].toLowerCase() === 'apikey')) {
      rawKey = parts[1];
    } else if (parts.length === 1 && !parts[0].toLowerCase().startsWith('bearer')) {
      rawKey = parts[0];
    }
  } else if (opKeyHeader && typeof opKeyHeader === 'string') {
    rawKey = opKeyHeader.trim();
  }

  if (!rawKey) {
    return res.status(401).json({
      error: 'AUTHENTICATION_REQUIRED',
      reasonCode: 'AUTHENTICATION_REQUIRED',
      message: 'Operator authentication token (Bearer token or x-operator-key header) is required.'
    });
  }

  const identity = db.authenticateOperatorKey(rawKey);
  if (!identity) {
    return res.status(401).json({
      error: 'INVALID_AUTHENTICATION',
      reasonCode: 'INVALID_AUTHENTICATION',
      message: 'Invalid, inactive, or expired operator key.'
    });
  }

  req.authenticatedUser = {
    id: identity.actorId,
    name: identity.actorName,
    role: identity.actorRole,
    tenantId: identity.tenantId
  };
  req.user = req.authenticatedUser;
  next();
}

// Helper middleware for campaign ownership validation
export function checkCampaignAuth(req, res, next) {
  let tenantId;
  if (req.authenticatedUser && req.authenticatedUser.tenantId) {
    // Authoritative tenant derived exclusively from server-side authenticated identity
    tenantId = req.authenticatedUser.tenantId;
    const requestedHeaderTenant = req.headers['x-tenant-id'];
    if (requestedHeaderTenant && requestedHeaderTenant.trim() !== tenantId) {
      return res.status(403).json({
        error: `Authenticated actor tenant "${tenantId}" cannot access foreign tenant "${requestedHeaderTenant.trim()}".`,
        reasonCode: 'TENANT_MISMATCH'
      });
    }
  } else {
    tenantId = (req.headers['x-tenant-id'] || req.query.tenantId || 'default').trim();
  }

  const campaignId = req.params.id;
  const campaign = db.getCampaignById(campaignId, tenantId);
  if (!campaign) {
    return res.status(404).json({
      error: `Campaign "${campaignId}" not found for tenant "${tenantId}"`,
      reasonCode: 'CAMPAIGN_NOT_FOUND'
    });
  }
  req.campaign = campaign;
  req.campaignTenant = tenantId;
  next();
}

// 1. Get campaign review summary dossier
app.get('/api/campaigns/:id/review', checkCampaignAuth, (req, res) => {
  try {
    const summary = getCampaignReviewSummary(req.params.id, { tenantId: req.campaignTenant });
    res.json({
      success: true,
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      reviewSummary: summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Submit campaign for human review (DRAFT/REJECTED -> READY_FOR_REVIEW)
app.post('/api/campaigns/:id/submit-review', checkCampaignAuth, (req, res) => {
  try {
    const { reviewer = 'operator', notes = null } = req.body || {};
    const result = submitCampaignForReview(req.params.id, { reviewer, notes }, { tenantId: req.campaignTenant });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Approve campaign (READY_FOR_REVIEW -> APPROVED)
app.post('/api/campaigns/:id/approve', checkCampaignAuth, (req, res) => {
  try {
    const { reviewer, notes = null, expectedHash = null } = req.body || {};
    if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
      return res.status(400).json({
        error: 'Reviewer identity is required for campaign approval',
        reasonCode: 'REVIEWER_REQUIRED'
      });
    }
    const result = approveCampaign(req.params.id, { reviewer, notes, expectedHash }, { tenantId: req.campaignTenant });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Reject campaign (READY_FOR_REVIEW -> REJECTED)
app.post('/api/campaigns/:id/reject', checkCampaignAuth, (req, res) => {
  try {
    const { reviewer, reason = null, notes = null } = req.body || {};
    const rejectionReason = reason || notes;
    if (!rejectionReason || typeof rejectionReason !== 'string' || !rejectionReason.trim()) {
      return res.status(400).json({
        error: 'A rejection reason is required when rejecting a campaign',
        reasonCode: 'REASON_REQUIRED'
      });
    }
    const result = rejectCampaign(req.params.id, { reviewer, reason: rejectionReason }, { tenantId: req.campaignTenant });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Reopen rejected campaign (REJECTED -> DRAFT)
app.post('/api/campaigns/:id/reopen', checkCampaignAuth, (req, res) => {
  try {
    const { reviewer = 'operator', notes = null } = req.body || {};
    const result = reopenRejectedCampaign(req.params.id, { reviewer, notes }, { tenantId: req.campaignTenant });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Cancel campaign (Pre-execution cancellation)
app.post('/api/campaigns/:id/cancel', checkCampaignAuth, (req, res) => {
  try {
    const { reviewer = 'operator', notes = null } = req.body || {};
    const result = cancelCampaign(req.params.id, { reviewer, notes }, { tenantId: req.campaignTenant });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 7. Get campaign review audit trail
app.get('/api/campaigns/:id/review-logs', checkCampaignAuth, (req, res) => {
  try {
    const logs = listCampaignReviewLogs(req.params.id, { tenantId: req.campaignTenant });
    res.json({
      success: true,
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      logs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 — STEP 6F-A: CAMPAIGN EXECUTION & DISPATCH ENGINE (DRY-RUN / PREVIEW)
// ==============================================================================

// 1. Get campaign execution status & history
app.get('/api/campaigns/:id/execution-status', checkCampaignAuth, (req, res) => {
  try {
    const status = getExecutionStatus({
      campaignId: req.params.id,
      tenantId: req.campaignTenant
    });
    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Preview campaign execution (side-effect-free)
app.post('/api/campaigns/:id/execution/preview', checkCampaignAuth, async (req, res) => {
  try {
    const { evaluationTime = null } = req.body || {};
    const preview = await previewCampaignExecution({
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      evaluationTime
    });
    res.json({
      success: true,
      ...preview
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Execute campaign dry-run (simulation logs appended)
app.post('/api/campaigns/:id/execution/dry-run', checkCampaignAuth, async (req, res) => {
  try {
    const { mode = 'DRY_RUN', evaluationTime = null, actor = 'operator' } = req.body || {};
    if (String(mode).toUpperCase() === 'LIVE') {
      return res.status(403).json({
        error: `${EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled in Step 6F-A.`
      });
    }

    const result = await executeCampaignDryRun({
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      mode,
      evaluationTime,
      actor
    });
    res.json(result);
  } catch (err) {
    const isModeError = err.message && err.message.includes(EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED);
    res.status(isModeError ? 403 : 400).json({ error: err.message });
  }
});

// 4. Execute single touch dry-run
app.post('/api/campaigns/:id/touches/:touchId/dry-run', checkCampaignAuth, async (req, res) => {
  try {
    const { mode = 'DRY_RUN', evaluationTime = null, actor = 'operator' } = req.body || {};
    if (String(mode).toUpperCase() === 'LIVE') {
      return res.status(403).json({
        error: `${EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED}: Real provider dispatch is disabled in Step 6F-A.`
      });
    }

    const result = await executeCampaignTouchDryRun({
      touchId: req.params.touchId,
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      mode,
      evaluationTime,
      actor
    });
    res.json(result);
  } catch (err) {
    const isModeError = err.message && err.message.includes(EXECUTION_ERROR_CODES.LIVE_EXECUTION_DISABLED);
    res.status(isModeError ? 403 : 400).json({ error: err.message });
  }
});

// 4b. Execute single touch live dispatch (Step 6F-B.1)
app.post('/api/campaigns/:id/touches/:touchId/dispatch', authenticateOperator, checkCampaignAuth, async (req, res) => {
  try {
    const { mode = 'LIVE', confirm = false, confirmation_text = '', actor = null, evaluationTime = null } = req.body || {};

    const result = await dispatchCampaignTouchLive({
      campaignId: req.params.id,
      touchId: req.params.touchId,
      tenantId: req.campaignTenant,
      mode,
      confirm,
      confirmation_text,
      actor: null, // Untrusted client body actor is discarded
      clientActor: actor, // Provided only for logging/tamper detection
      evaluationTime,
      req,
      authenticatedActor: req.authenticatedUser // Server-side authenticated identity
    });

    if (!result.success) {
      const code = result.decision_reason || result.reasonCode;
      const status = (code === DISPATCH_ERROR_CODES.AUTHENTICATION_REQUIRED || code === 'INVALID_AUTHENTICATION') ? 401 :
                     (code === DISPATCH_ERROR_CODES.LIVE_EXECUTION_DISABLED || code === DISPATCH_ERROR_CODES.ACTOR_UNAUTHORIZED || code === DISPATCH_ERROR_CODES.TENANT_MISMATCH) ? 403 :
                     (code === DISPATCH_ERROR_CODES.ALREADY_DISPATCHED || code === DISPATCH_ERROR_CODES.CONCURRENT_DISPATCH_OR_ALREADY_LOCKED) ? 409 :
                     (code === DISPATCH_ERROR_CODES.CAMPAIGN_NOT_FOUND || code === DISPATCH_ERROR_CODES.TOUCH_NOT_FOUND) ? 404 : 400;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. Read-only execution attempts inquiry (Step 6F-B.2A)
app.get('/api/campaigns/:id/touches/:touchId/attempts', authenticateOperator, checkCampaignAuth, (req, res) => {
  try {
    const attempts = db.listExecutionAttempts(req.params.touchId, req.campaignTenant);
    res.json({
      success: true,
      campaignId: req.params.id,
      touchId: req.params.touchId,
      tenantId: req.campaignTenant,
      count: attempts.length,
      attempts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4d. Manual touch reconciliation (Step 6F-B.2B / 6F-B.2C.2)
export async function handleReconcileTouch(req, res) {
  try {
    const { decision, reason, notes, evidence = null, now = null } = req.body || {};
    const evalNow = now ? (isNaN(Number(now)) ? Date.now() : Number(now)) : (req.query?.now ? Number(req.query.now) : Date.now());

    const result = await reconcileCampaignTouchManual({
      campaignId: req.params.id,
      touchId: req.params.touchId,
      tenantId: req.campaignTenant,
      decision,
      reason,
      notes,
      evidence,
      now: evalNow,
      authenticatedActor: req.authenticatedUser
    });

    if (!result.success) {
      const code = result.decision_reason;
      const status = (code === RECONCILIATION_ERROR_CODES.AUTHENTICATION_REQUIRED) ? 401 :
                     (code === RECONCILIATION_ERROR_CODES.ACTOR_UNAUTHORIZED || code === RECONCILIATION_ERROR_CODES.TENANT_MISMATCH) ? 403 :
                     (code === RECONCILIATION_ERROR_CODES.CAMPAIGN_NOT_FOUND || code === RECONCILIATION_ERROR_CODES.TOUCH_NOT_FOUND) ? 404 :
                     (code === RECONCILIATION_ERROR_CODES.CONCURRENT_RECONCILIATION_OR_STATE_CHANGED ||
                      code === RECONCILIATION_ERROR_CODES.TOUCH_DISPATCH_IN_FLIGHT ||
                      code === RECONCILIATION_ERROR_CODES.INVALID_STATE_FOR_RECONCILIATION) ? 409 : 400;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.post('/api/campaigns/:id/touches/:touchId/reconcile', authenticateOperator, checkCampaignAuth, handleReconcileTouch);

// 4e. Read-only touch reconciliation history inquiry (Step 6F-B.2B)
app.get('/api/campaigns/:id/touches/:touchId/reconciliations', authenticateOperator, checkCampaignAuth, (req, res) => {
  try {
    const reconciliations = getTouchReconciliationHistory(req.params.touchId, req.campaignTenant);
    res.json({
      success: true,
      campaignId: req.params.id,
      touchId: req.params.touchId,
      tenantId: req.campaignTenant,
      count: reconciliations.length,
      reconciliations
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4f. Read-only stale dispatching touches inquiry (Step 6F-B.2C.1)
export function handleGetStaleTouches(req, res) {
  try {
    const now = req.query.now ? (isNaN(Number(req.query.now)) ? Date.now() : Number(req.query.now)) : Date.now();
    const staleTouches = getStaleDispatchingTouches(req.params.id, req.campaignTenant, now);
    
    const formattedTouches = staleTouches.map(t => {
      const lockedMs = t.execution_locked_at ? new Date(t.execution_locked_at).getTime() : NaN;
      const elapsedMs = !isNaN(lockedMs) ? Math.max(0, now - lockedMs) : null;
      return {
        touchId: t.id,
        campaignId: t.campaign_id,
        campaignLeadId: t.campaign_lead_id,
        leadId: t.lead_id,
        touchNumber: t.touch_number,
        plannedChannel: t.planned_channel,
        status: t.status,
        executionStatus: t.execution_status,
        executionLock: t.execution_lock,
        executionLockedAt: t.execution_locked_at,
        elapsedAgeMs: elapsedMs,
        executionAttemptCount: t.execution_attempt_count || 0,
        lastAttemptId: t.last_attempt_id || null
      };
    });

    res.json({
      success: true,
      campaignId: req.params.id,
      tenantId: req.campaignTenant,
      count: formattedTouches.length,
      staleThresholdMs: STALE_LOCK_THRESHOLD_MS,
      evaluatedAt: new Date(now).toISOString(),
      staleTouches: formattedTouches
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.get('/api/campaigns/:id/stale-touches', authenticateOperator, checkCampaignAuth, handleGetStaleTouches);

// 4g. Read-only campaign execution health inquiry (Step 6F-B.2C.1)
export function handleGetExecutionHealth(req, res) {
  try {
    const now = req.query.now ? (isNaN(Number(req.query.now)) ? Date.now() : Number(req.query.now)) : Date.now();
    const health = getCampaignExecutionHealth(req.params.id, req.campaignTenant, now);
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
app.get('/api/campaigns/:id/execution-health', authenticateOperator, checkCampaignAuth, handleGetExecutionHealth);

// 5. Activate campaign (APPROVED -> ACTIVE)
app.post('/api/campaigns/:id/activate', checkCampaignAuth, (req, res) => {
  try {
    const { actor = 'operator', notes = null } = req.body || {};
    const result = activateCampaign(req.params.id, {
      tenantId: req.campaignTenant,
      actor,
      notes
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Pause campaign (ACTIVE -> PAUSED)
app.post('/api/campaigns/:id/pause', checkCampaignAuth, (req, res) => {
  try {
    const { actor = 'operator', reason = null } = req.body || {};
    const result = pauseCampaign(req.params.id, {
      tenantId: req.campaignTenant,
      actor,
      reason
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 7. Resume campaign (PAUSED -> ACTIVE)
app.post('/api/campaigns/:id/resume', checkCampaignAuth, (req, res) => {
  try {
    const { actor = 'operator', notes = null } = req.body || {};
    const result = resumeCampaign(req.params.id, {
      tenantId: req.campaignTenant,
      actor,
      notes
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==============================================================================
// PHASE 2 STEP 8B — CONVERSATION INTELLIGENCE FOUNDATION ENDPOINTS
// ==============================================================================

// 1. List conversations for authenticated tenant
app.get('/api/conversations', authenticateOperator, (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { leadId, channel, status, limit, offset } = req.query;
    const conversations = db.listConversations(tenantId, {
      leadId: leadId || null,
      channel: channel || null,
      status: status || null,
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0
    });

    // Enrich with lead details for UI Inbox
    const enriched = conversations.map(c => {
      const lead = c.leadId ? db.sqlite.prepare('SELECT id, businessName, phone, email, leadStatus, aiSuggestedReply FROM leads WHERE id = ? AND tenant_id = ?').get(c.leadId, tenantId) : null;
      return {
        ...c,
        lead: lead || null
      };
    });

    res.json({ success: true, count: enriched.length, conversations: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get conversation by ID
app.get('/api/conversations/:id', authenticateOperator, (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const conv = db.getConversationById(req.params.id, tenantId);
    if (!conv) {
      return res.status(404).json({ error: `Conversation "${req.params.id}" not found`, reasonCode: 'CONVERSATION_NOT_FOUND' });
    }
    const lead = conv.leadId ? db.sqlite.prepare('SELECT id, businessName, phone, email, leadStatus, aiSuggestedReply FROM leads WHERE id = ? AND tenant_id = ?').get(conv.leadId, tenantId) : null;
    res.json({ success: true, conversation: { ...conv, lead: lead || null } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. List messages in a conversation
app.get('/api/conversations/:id/messages', authenticateOperator, (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const messages = db.listConversationMessages(req.params.id, tenantId);
    res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// 4. Update conversation status
app.put('/api/conversations/:id/status', authenticateOperator, (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const success = db.updateConversationStatus(req.params.id, status, tenantId);
    if (!success) {
      return res.status(404).json({ error: `Conversation "${req.params.id}" not found`, reasonCode: 'CONVERSATION_NOT_FOUND' });
    }
    res.json({ success: true, message: `Conversation status updated to "${status}"` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Send manual outbound reply to a conversation (Gated by executeOutreachGate)
app.post('/api/conversations/:id/reply', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { messageText, simulateOnly = true } = req.body || {};

    if (!messageText || typeof messageText !== 'string' || !messageText.trim()) {
      return res.status(400).json({ error: 'messageText is required', reasonCode: 'INVALID_MESSAGE_TEXT' });
    }

    const conv = db.getConversationById(req.params.id, tenantId);
    if (!conv) {
      return res.status(404).json({ error: `Conversation "${req.params.id}" not found`, reasonCode: 'CONVERSATION_NOT_FOUND' });
    }

    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(conv.leadId, tenantId);
    if (!lead) {
      return res.status(404).json({ error: `Lead "${conv.leadId}" not found for tenant "${tenantId}"`, reasonCode: 'LEAD_NOT_FOUND' });
    }

    // Step 8G Hardening: Every outbound reply must pass the supreme executeOutreachGate!
    const recipient = conv.externalThreadId;
    let liveDispatched = false;
    const gateResult = await executeOutreachGate({
      tenantId,
      leadId: conv.leadId,
      channel: conv.channel,
      contactIdentifier: recipient,
      sendFn: async () => {
        if (!simulateOnly) {
          if (conv.channel === 'whatsapp') {
            await sendRawWhatsappMessage(recipient, messageText.trim());
            liveDispatched = true;
          } else if (conv.channel === 'telegram') {
            await sendLeadTelegramMessage(lead, messageText.trim());
            liveDispatched = true;
          }
        }
        return { dispatched: liveDispatched };
      }
    });

    if (gateResult.blocked || !gateResult.allowed) {
      return res.status(403).json({
        success: false,
        blocked: true,
        decision: 'BLOCKED',
        reason: gateResult.reason,
        reasonCode: gateResult.reasonCode || 'OUTREACH_GATE_BLOCKED',
        compliance: gateResult.compliance
      });
    }

    // Ingest the outbound message into conversation_messages
    const pMsgId = `out_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const ingestRes = db.ingestConversationMessage({
      tenantId,
      conversationId: conv.id,
      channel: conv.channel,
      direction: 'OUTBOUND',
      senderIdentifier: 'operator',
      recipientIdentifier: recipient,
      providerMessageId: pMsgId,
      messageText: messageText.trim(),
      hasOptOut: 0,
      receivedAt: new Date().toISOString()
    });

    // Update conversation thread state
    db.sqlite.prepare(`
      UPDATE conversations
      SET conversation_status = 'WAITING_FOR_PROSPECT',
          unread_count = 0,
          updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(new Date().toISOString(), conv.id, tenantId);

    res.json({
      success: true,
      message: ingestRes.message,
      liveDispatched,
      gateResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. One-click approve AI suggested reply draft
app.post('/api/conversations/:id/approve-draft', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { simulateOnly = true } = req.body || {};

    const conv = db.getConversationById(req.params.id, tenantId);
    if (!conv) {
      return res.status(404).json({ error: `Conversation "${req.params.id}" not found`, reasonCode: 'CONVERSATION_NOT_FOUND' });
    }

    const lead = db.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(conv.leadId, tenantId);
    if (!lead) {
      return res.status(404).json({ error: `Lead "${conv.leadId}" not found for tenant "${tenantId}"`, reasonCode: 'LEAD_NOT_FOUND' });
    }

    const suggestedReply = conv.metadata?.suggestedReply || lead.aiSuggestedReply;
    if (!suggestedReply || !suggestedReply.trim()) {
      return res.status(400).json({ error: 'No suggested reply draft available for this conversation', reasonCode: 'NO_SUGGESTED_DRAFT' });
    }

    // Step 8G Hardening: Gated by supreme executeOutreachGate!
    const recipient = conv.externalThreadId;
    let liveDispatched = false;
    const gateResult = await executeOutreachGate({
      tenantId,
      leadId: conv.leadId,
      channel: conv.channel,
      contactIdentifier: recipient,
      sendFn: async () => {
        if (!simulateOnly) {
          if (conv.channel === 'whatsapp') {
            await sendRawWhatsappMessage(recipient, suggestedReply.trim());
            liveDispatched = true;
          } else if (conv.channel === 'telegram') {
            await sendLeadTelegramMessage(lead, suggestedReply.trim());
            liveDispatched = true;
          }
        }
        return { dispatched: liveDispatched };
      }
    });

    if (gateResult.blocked || !gateResult.allowed) {
      return res.status(403).json({
        success: false,
        blocked: true,
        decision: 'BLOCKED',
        reason: gateResult.reason,
        reasonCode: gateResult.reasonCode || 'OUTREACH_GATE_BLOCKED',
        compliance: gateResult.compliance
      });
    }

    // Ingest the outbound approved message
    const pMsgId = `out_draft_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const ingestRes = db.ingestConversationMessage({
      tenantId,
      conversationId: conv.id,
      channel: conv.channel,
      direction: 'OUTBOUND',
      senderIdentifier: 'operator:approved_draft',
      recipientIdentifier: recipient,
      providerMessageId: pMsgId,
      messageText: suggestedReply.trim(),
      hasOptOut: 0,
      receivedAt: new Date().toISOString()
    });

    // Update conversation metadata to record approved draft
    const meta = conv.metadata || {};
    meta.draftApproved = true;
    meta.draftApprovedAt = new Date().toISOString();
    meta.approvedBy = req.authenticatedUser.id || 'operator';

    db.sqlite.prepare(`
      UPDATE conversations
      SET conversation_status = 'WAITING_FOR_PROSPECT',
          metadata = ?,
          unread_count = 0,
          updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(JSON.stringify(meta), new Date().toISOString(), conv.id, tenantId);

    res.json({
      success: true,
      message: ingestRes.message,
      liveDispatched,
      gateResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Poll Inbound Messages (Gmail / Email manual trigger)
app.post('/api/conversations/poll-inbound', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const gmailResult = await pollGmailInboundReplies({ tenantId, broadcastFn: broadcast });
    res.json({
      success: true,
      gmail: gmailResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// STEP 9: CRM & OPPORTUNITY MANAGEMENT ENDPOINTS
// ==========================================

// 1. Create Opportunity
app.post('/api/opportunities', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const operatorId = req.authenticatedUser.operatorId || 'operator';
    const {
      leadId,
      contactId,
      title,
      dealValue,
      currency,
      stage,
      confidenceProbability,
      expectedCloseDate,
      assignedOperatorId,
      metadata
    } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const opp = db.createOpportunity({
      lead_id: leadId,
      contact_id: contactId || null,
      title: title.trim(),
      deal_value: dealValue,
      currency,
      stage: stage || 'DISCOVERY',
      confidence_probability: confidenceProbability,
      expected_close_date: expectedCloseDate,
      assigned_operator_id: assignedOperatorId,
      metadata,
      tenant_id: tenantId,
      operator_id: operatorId
    });

    res.status(201).json({ success: true, opportunity: opp });
  } catch (err) {
    if (err.message === 'LEAD_NOT_FOUND' || err.message === 'CROSS_TENANT_LEAD_FORBIDDEN') {
      return res.status(404).json({ error: 'Lead not found or inaccessible' });
    }
    if (err.message === 'INVALID_CONTACT_ASSOCIATION') {
      return res.status(400).json({ error: 'Contact does not belong to specified lead' });
    }
    res.status(500).json({ error: err.message });
  }
});

// 2. List Opportunities (Tenant-Scoped with filtering)
app.get('/api/opportunities', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { stage, leadId, limit, offset } = req.query;

    const list = db.listOpportunities({
      tenant_id: tenantId,
      stage: stage || undefined,
      lead_id: leadId ? parseInt(leadId, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0
    });

    res.json({ success: true, opportunities: list, total: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Single Opportunity with History & Tasks
app.get('/api/opportunities/:id', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const opp = db.getOpportunityById(req.params.id, tenantId);
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const history = db.getOpportunityHistory(req.params.id, tenantId);
    const tasks = db.listOpportunityTasks(req.params.id, tenantId);

    res.json({
      success: true,
      opportunity: {
        ...opp,
        history,
        tasks
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Opportunity Stage
app.put('/api/opportunities/:id/stage', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const operatorId = req.authenticatedUser.operatorId || 'operator';
    const {
      newStage,
      transitionReason,
      lossReasonCode,
      lossReasonNotes,
      confidenceProbability
    } = req.body;

    if (!newStage) {
      return res.status(400).json({ error: 'newStage is required' });
    }

    const updated = db.updateOpportunityStage(req.params.id, {
      new_stage: newStage,
      operator_id: operatorId,
      transition_reason: transitionReason || 'OPERATOR_STAGE_UPDATE',
      loss_reason_code: lossReasonCode,
      loss_reason_notes: lossReasonNotes,
      confidence_probability: confidenceProbability,
      tenant_id: tenantId
    });

    res.json({ success: true, opportunity: updated });
  } catch (err) {
    if (err.message === 'OPPORTUNITY_NOT_FOUND') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    if (err.message.includes('INVALID_STAGE') || err.message.includes('LOSS_REASON')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 5. Update Opportunity Details
app.put('/api/opportunities/:id', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { title, dealValue, currency, expectedCloseDate, assignedOperatorId, metadata } = req.body;

    const updated = db.updateOpportunity(req.params.id, {
      title,
      deal_value: dealValue,
      currency,
      expected_close_date: expectedCloseDate,
      assigned_operator_id: assignedOperatorId,
      metadata
    }, tenantId);

    res.json({ success: true, opportunity: updated });
  } catch (err) {
    if (err.message === 'OPPORTUNITY_NOT_FOUND') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

// 6. Create Task for Opportunity
app.post('/api/opportunities/:id/tasks', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { taskType, title, dueDate, assignedTo } = req.body;

    if (!taskType || !title || !dueDate) {
      return res.status(400).json({ error: 'taskType, title, and dueDate are required' });
    }

    const task = db.createOpportunityTask({
      opportunity_id: req.params.id,
      task_type: taskType,
      title,
      due_date: dueDate,
      assigned_to: assignedTo,
      tenant_id: tenantId
    });

    res.status(201).json({ success: true, task });
  } catch (err) {
    if (err.message === 'OPPORTUNITY_NOT_FOUND') {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    if (err.message.includes('INVALID_TASK_TYPE')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 7. Update Task Status
app.put('/api/opportunities/tasks/:taskId/status', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const task = db.updateOpportunityTaskStatus(req.params.taskId, status, tenantId);
    res.json({ success: true, task });
  } catch (err) {
    if (err.message === 'TASK_NOT_FOUND') {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (err.message.includes('INVALID_TASK_STATUS')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 8. Sync Opportunity from Conversation (Bridge Step 8 to Step 9)
app.post('/api/opportunities/sync-conversation/:conversationId', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const operatorId = req.authenticatedUser.operatorId || 'operator';
    const { bookingData } = req.body;

    const opp = db.syncOpportunityFromConversation({
      conversationId: req.params.conversationId,
      tenantId,
      bookingData: bookingData || null,
      operatorId
    });

    res.json({ success: true, opportunity: opp });
  } catch (err) {
    if (err.message === 'CONVERSATION_NOT_FOUND' || err.message === 'LEAD_NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 9. Cal.com Inbound Booking Webhook
app.post('/api/webhooks/cal-com', async (req, res) => {
  try {
    const event = req.body.event || req.body.triggerEvent;
    const payload = req.body.payload || req.body;
    const tenantId = req.headers['x-tenant-id'] || 'default';

    if (!payload || !payload.uid) {
      return res.status(400).json({ error: 'Invalid Cal.com payload: missing uid' });
    }

    // Extract prospect email and phone
    const attendee = (payload.attendees && payload.attendees[0]) || {};
    const prospectEmail = attendee.email || (payload.responses && payload.responses.email);
    const prospectPhone = attendee.phone || (payload.responses && payload.responses.phone);

    let matchedLead = null;
    if (prospectPhone) {
      const match = db.findLeadByPhoneScoped(prospectPhone, tenantId);
      if (match && match.status === 'MATCHED') {
        matchedLead = match.lead;
      }
    }
    if (!matchedLead && prospectEmail) {
      matchedLead = db.sqlite.prepare('SELECT * FROM leads WHERE email = ? AND tenant_id = ?').get(prospectEmail.trim().toLowerCase(), tenantId);
    }

    if (!matchedLead) {
      return res.status(404).json({
        success: false,
        error: 'No matching lead found in tenant for Cal.com booking'
      });
    }

    // Find conversation if one exists
    const conv = db.sqlite.prepare(`
      SELECT * FROM conversations WHERE lead_id = ? AND tenant_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(matchedLead.id, tenantId);

    const bookingData = {
      bookingUid: payload.uid,
      startTime: payload.startTime,
      endTime: payload.endTime,
      name: attendee.name || matchedLead.businessName,
      email: prospectEmail,
      phone: prospectPhone
    };

    let opportunity;
    if (conv) {
      opportunity = db.syncOpportunityFromConversation({
        conversationId: conv.id,
        tenantId,
        bookingData,
        operatorId: 'cal_com_webhook'
      });
    } else {
      // Create opportunity directly if no conversation exists
      opportunity = db.createOpportunity({
        lead_id: matchedLead.id,
        title: `Workflow Automation - ${matchedLead.businessName}`,
        deal_value: 50000.0,
        currency: 'INR',
        stage: 'DEMO_BOOKED',
        confidence_probability: 0.40,
        metadata: { cal_booking_uid: payload.uid, booking_data: bookingData },
        tenant_id: tenantId,
        operator_id: 'cal_com_webhook'
      });

      if (payload.startTime) {
        db.createOpportunityTask({
          opportunity_id: opportunity.id,
          task_type: 'DEMO_MEETING',
          title: `Cal.com Demo Meeting: ${matchedLead.businessName} [${payload.uid}]`,
          due_date: payload.startTime,
          assigned_to: 'cal_com_webhook',
          tenant_id: tenantId
        });
      }
    }

    res.json({ success: true, opportunity, event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// STEP 10: REVENUE & ATTRIBUTION API ENDPOINTS (Multi-Tenant Scoped)
// =========================================================================

// 1. Recognize Won Revenue for an Opportunity
app.post('/api/opportunities/:id/recognize-revenue', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const operatorId = req.authenticatedUser.operatorId || 'operator';
    const { preferredModel, recognizedAt, notes } = req.body;

    const result = recognizeOpportunityRevenue(
      req.params.id,
      operatorId,
      tenantId,
      { preferredModel, recognizedAt, notes },
      db
    );

    res.status(201).json(result);
  } catch (err) {
    if (err.message.startsWith('OPPORTUNITY_NOT_FOUND')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.startsWith('INVALID_STAGE_FOR_REVENUE') || err.message.startsWith('INVALID_DEAL_VALUE')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Opportunity Attribution Breakdown
app.get('/api/opportunities/:id/attribution', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const model = (req.query.model || 'LINEAR').toUpperCase();

    if (!Object.values(ATTRIBUTION_MODELS).includes(model)) {
      return res.status(400).json({ 
        error: `Invalid model. Choose one of: ${Object.values(ATTRIBUTION_MODELS).join(', ')}` 
      });
    }

    let attributions = db.getRevenueAttributions(req.params.id, model, tenantId);

    // If not calculated yet, compute and persist automatically
    if (!attributions || attributions.length === 0) {
      const calcResult = calculateOpportunityAttribution(req.params.id, tenantId, model, {}, db);
      attributions = calcResult.attributions;
    }

    res.json({
      success: true,
      opportunityId: req.params.id,
      model,
      attributions,
      totalAttributedValue: attributions.reduce((sum, a) => sum + a.attributedValue, 0),
      totalAttributionWeight: attributions.reduce((sum, a) => sum + a.attributionWeight, 0)
    });
  } catch (err) {
    if (err.message.startsWith('OPPORTUNITY_NOT_FOUND')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 3. Recalculate Opportunity Attribution
app.post('/api/opportunities/:id/attribution/recalculate', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const model = (req.body.model || 'LINEAR').toUpperCase();

    if (model !== 'ALL' && !Object.values(ATTRIBUTION_MODELS).includes(model)) {
      return res.status(400).json({ 
        error: `Invalid model. Choose one of: ${Object.values(ATTRIBUTION_MODELS).join(', ')}, or 'ALL'` 
      });
    }

    if (model === 'ALL') {
      const allResults = {};
      for (const m of Object.values(ATTRIBUTION_MODELS)) {
        allResults[m] = calculateOpportunityAttribution(req.params.id, tenantId, m, {}, db);
      }
      return res.json({ success: true, opportunityId: req.params.id, models: allResults });
    }

    const result = calculateOpportunityAttribution(req.params.id, tenantId, model, {}, db);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message.startsWith('OPPORTUNITY_NOT_FOUND')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Tenant Revenue Analytics & Performance KPIs
app.get('/api/revenue/analytics', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const model = (req.query.model || 'LINEAR').toUpperCase();
    const analytics = getRevenueAnalytics(tenantId, { modelName: model }, db);

    res.json({ success: true, ...analytics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get Tenant Revenue Realization Ledger
app.get('/api/revenue/ledger', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const limit = parseInt(req.query.limit, 10) || 50;
    const entries = db.getRevenueLedgerList(tenantId, limit);

    res.json({ success: true, entries, total: entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get Campaign Revenue Attribution Summary
app.get('/api/revenue/campaigns/:id', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const model = (req.query.model || 'LINEAR').toUpperCase();
    const summary = db.getCampaignRevenueSummary(req.params.id, tenantId, model);

    res.json({
      success: true,
      campaignId: req.params.id,
      model,
      summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// STEP 11: ANALYTICS & DECISION INTELLIGENCE ENDPOINTS (Multi-Tenant Scoped)
// =========================================================================

// 1. Sales Pipeline Velocity & Funnel Dynamics
app.get('/api/analytics/velocity', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const velocity = computePipelineVelocity(tenantId, {}, db);
    res.json({ success: true, ...velocity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. SLA Breaches & Stage Bottlenecks
app.get('/api/analytics/sla-breaches', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const sla = detectSlaBreachesAndBottlenecks(tenantId, {}, db);
    res.json({ success: true, ...sla });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Cohort Conversion Funnel by Segment
app.get('/api/analytics/cohorts', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const cohorts = computeCohortAnalytics(tenantId, {}, db);
    res.json({ success: true, ...cohorts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Deal Loss Intelligence & Strategic Recommendations
app.get('/api/analytics/loss-analysis', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const loss = computeLossReasonAnalysis(tenantId, {}, db);
    res.json({ success: true, ...loss });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Generate & Persist Decision Intelligence Snapshot
app.post('/api/analytics/snapshots', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { snapshotType, timeBucket } = req.body;

    if (!snapshotType) {
      return res.status(400).json({ error: 'snapshotType is required' });
    }

    const snapshot = generateDecisionSnapshot(snapshotType, tenantId, { timeBucket }, db);
    res.status(201).json({ success: true, snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. List Decision Intelligence Snapshots
app.get('/api/analytics/snapshots', authenticateOperator, async (req, res) => {
  try {
    const tenantId = req.authenticatedUser.tenantId;
    const { snapshotType, limit } = req.query;
    const snapshots = db.getDecisionSnapshots(snapshotType || null, tenantId, parseInt(limit, 10) || 20);
    res.json({ success: true, snapshots, total: snapshots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize local QR-code WhatsApp client on startup
initWhatsappClient((event) => broadcast(event));

// --- Start Server ---
const server = app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

// Graceful process exit handling
const handleGracefulShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Gracefully shutting down...`);
  try {
    await cleanupWhatsappProcess();
  } catch (err) {
    console.error('Error during cleanup:', err.message);
  }
  server.close(() => {
    process.exit(0);
  });
  // Force exit if hanging
  setTimeout(() => process.exit(0), 4000);
};

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));

export default app;
