import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

// Bypass SSL verification issues on Windows (frequently caused by antivirus/proxy inspections)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { db } from './database.js';
import { scrapeJob, SEGMENTS_CONFIG, generateInstantSegmentLeads } from './scraper.js';
import { 
  getAuthUrl, 
  handleOAuthCallback, 
  createGmailDraft, 
  syncToGoogleSheet, 
  sendWhatsAppMessage 
} from './outreach.js';
import { initWhatsappClient, getWhatsappStatus, disconnectWhatsapp } from './whatsapp-client.js';

dotenv.config();

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

// --- Settings Endpoints ---
app.get('/api/settings', (req, res) => {
  const settings = db.getSettings();
  // Don't send sensitive tokens or credentials in plain full view if they exist, but let them know if connected
  const clientResponse = {
    ...settings,
    isGoogleConnected: !!(settings.googleTokens && settings.googleTokens.refresh_token),
    googleTokens: undefined // Hide tokens for security
  };
  res.json(clientResponse);
});

app.post('/api/settings', (req, res) => {
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
  const { search, segment, qualityScore, leadStatus, hasPhone, hasAllThree, emailStatus, whatsappStatus } = req.query;

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

  if (hasPhone === 'true') {
    // Only leads with formatted E.164 phone or general phone
    leads = leads.filter(l => l.phone && l.phone.trim().length >= 7);
  }

  // Calculate 3/3 Contact Completeness Score for sorting/filtering
  // 3 Points = Has Phone + Has Website + Has at least 1 Social link
  leads = leads.map(l => {
    const hasP = !!(l.phone && l.phone.trim().length >= 7);
    const hasW = !!(l.website && l.website.trim() !== '');
    const hasS = !!(l.facebook || l.instagram || l.linkedin || l.twitter);
    const contactScore = (hasP ? 1 : 0) + (hasW ? 1 : 0) + (hasS ? 1 : 0);
    const hasAll3 = hasP && hasW && hasS;
    return { ...l, contactScore, hasAll3 };
  });

  if (hasAllThree === 'true') {
    leads = leads.filter(l => l.hasAll3);
  }

  if (emailStatus) {
    leads = leads.filter(l => l.emailStatus === emailStatus);
  }

  if (whatsappStatus) {
    leads = leads.filter(l => l.whatsappStatus === whatsappStatus);
  }

  // 🏆 SORTING RULE: Put leads with all 3 contact points FIRST across every category!
  // Sort order: contactScore (3 first, then 2, 1, 0) -> qualityScore (Hot > Warm > Cold) -> createdAt
  const qualityWeight = { 'Hot': 3, 'Warm': 2, 'Cold': 1 };
  leads.sort((a, b) => {
    if (b.contactScore !== a.contactScore) {
      return b.contactScore - a.contactScore; // Highest contact completeness first (3/3 first)
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
    res.json({ success: true, lead: updated });
  } else {
    res.status(404).json({ error: 'Lead not found' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  db.deleteLead(req.params.id);
  res.json({ success: true });
});

app.post('/api/leads/clear', (req, res) => {
  db.clearLeads();
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

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const leads = db.getLeads();
    const lead = leads.find(l => l.id === leadId);

    if (!lead) continue;
    
    broadcast({ 
      type: 'email-job-progress', 
      current: i + 1, 
      total: leadIds.length, 
      message: `Creating draft for ${lead.businessName}...` 
    });

    if (!lead.email) {
      db.updateLead(leadId, { emailStatus: 'Error: No email address' });
      failCount++;
      continue;
    }

    try {
      await createGmailDraft(lead);
      db.updateLead(leadId, { emailStatus: 'Draft Created' });
      successCount++;
    } catch (e) {
      console.error(`Gmail draft creation failed for ${lead.businessName}:`, e);
      db.updateLead(leadId, { emailStatus: `Error: ${e.message}` });
      failCount++;
    }

    // Small delay to prevent hitting API limits
    await new Promise(r => setTimeout(r, 400));
  }

  broadcast({ 
    type: 'email-job-end', 
    successCount, 
    failCount, 
    message: `Draft process complete. Created ${successCount} drafts, failed ${failCount}.` 
  });
});

// Send WhatsApp Message for Selected Leads
app.post('/api/outreach/whatsapp', async (req, res) => {
  const { leadIds } = req.body;
  if (!leadIds || !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'leadIds array is required.' });
  }

  res.json({ success: true, message: 'WhatsApp sending job started.' });

  broadcast({ type: 'whatsapp-job-start', total: leadIds.length });

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i];
    const leads = db.getLeads();
    const lead = leads.find(l => l.id === leadId);

    if (!lead) continue;

    broadcast({ 
      type: 'whatsapp-job-progress', 
      current: i + 1, 
      total: leadIds.length, 
      message: `Sending WhatsApp to ${lead.businessName}...` 
    });

    if (!lead.phone) {
      db.updateLead(leadId, { whatsappStatus: 'Error: No phone number' });
      db.addWhatsappLog({
        leadId,
        leadName: lead.businessName,
        phone: '',
        status: 'Failed',
        errorMessage: 'Lead has no phone number.'
      });
      failCount++;
      continue;
    }

    try {
      await sendWhatsAppMessage(lead);
      db.updateLead(leadId, { whatsappStatus: 'Sent' });
      db.addWhatsappLog({
        leadId,
        leadName: lead.businessName,
        phone: lead.phone,
        status: 'Sent'
      });
      successCount++;
    } catch (e) {
      console.error(`WhatsApp send failed for ${lead.businessName}:`, e);
      db.updateLead(leadId, { whatsappStatus: `Error: ${e.message}` });
      db.addWhatsappLog({
        leadId,
        leadName: lead.businessName,
        phone: lead.phone,
        status: 'Failed',
        errorMessage: e.message
      });
      failCount++;
    }

    // Delay to respect rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  broadcast({ 
    type: 'whatsapp-job-end', 
    successCount, 
    failCount, 
    message: `WhatsApp process complete. Sent ${successCount} messages, failed ${failCount}.` 
  });
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

// Initialize local QR-code WhatsApp client on startup
initWhatsappClient((event) => broadcast(event));

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

export default app;
