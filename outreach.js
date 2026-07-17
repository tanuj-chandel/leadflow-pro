import { google } from 'googleapis';
import { db } from './database.js';
import { sendWhatsappMessage } from './whatsapp-client.js';

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
    Website: lead.website || ''
  };

  const subject = fillTemplate(settings.emailSubjectTemplate, fields);
  const body = fillTemplate(settings.emailBodyTemplate, fields);

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${lead.email}`,
    `Subject: ${utf8Subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ];
  const message = messageParts.join('\n');
  const encodedMessage = Buffer.from(message).toString('base64url');

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
  const template = settings.waMessageTemplate || 
    'Hi {{BusinessName}},\n\nI found your business in {{Location}} and wanted to reach out. Are you open to a quick call?\n\nBest regards,\n[Your Name]';

  const toPhone = lead.phone;
  if (!toPhone) {
    throw new Error('Lead has no phone number.');
  }

  const fields = {
    BusinessName: lead.businessName || '',
    Location: lead.location || '',
    Address: lead.address || '',
    Phone: lead.phone || '',
    Website: lead.website || ''
  };

  const messageText = fillTemplate(template, fields);

  // Send via our QR code connected client
  const result = await sendWhatsappMessage(toPhone, messageText);
  return result;
}
