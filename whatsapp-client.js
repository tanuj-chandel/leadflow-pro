import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import path from 'path';
import fs from 'fs';

let client = null;
let qrCodeDataUrl = null;
let connectionStatus = 'Disconnected'; // Disconnected, Connecting, QR_Ready, Connected
let broadcastFn = null;

function getChromeExecutablePath() {
  const commonPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData/Local/Google/Chrome/Application/chrome.exe')
  ];

  for (const pathStr of commonPaths) {
    if (fs.existsSync(pathStr)) {
      console.log('Found Chrome executable at:', pathStr);
      return pathStr;
    }
  }

  console.warn('Google Chrome executable not found in common Windows directories.');
  return undefined;
}

export function getWhatsappStatus() {
  return {
    status: connectionStatus,
    qr: qrCodeDataUrl
  };
}

export function initWhatsappClient(broadcastCallback) {
  if (client) return;
  broadcastFn = broadcastCallback;

  console.log('Initializing WhatsApp client...');
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(process.cwd(), '.wwebjs_auth')
    }),
    puppeteer: {
      headless: true,
      executablePath: getChromeExecutablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    }
  });

  connectionStatus = 'Connecting';
  if (broadcastFn) broadcastFn({ type: 'wa-status', status: connectionStatus });

  client.on('qr', async (qr) => {
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
      connectionStatus = 'QR_Ready';
      if (broadcastFn) {
        broadcastFn({ type: 'wa-status', status: connectionStatus, qr: qrCodeDataUrl });
        broadcastFn({ type: 'log', message: 'WhatsApp QR code ready. Please scan it in settings.' });
      }
    } catch (err) {
      console.error('Failed to generate QR data URL:', err);
    }
  });

  client.on('ready', () => {
    connectionStatus = 'Connected';
    qrCodeDataUrl = null;
    console.log('WhatsApp client is ready!');
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: 'WhatsApp account linked and ready!' });
    }
  });

  client.on('auth_failure', (msg) => {
    connectionStatus = 'Disconnected';
    qrCodeDataUrl = null;
    console.error('WhatsApp auth failure:', msg);
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: `WhatsApp authentication failed: ${msg}` });
    }
  });

  client.on('disconnected', (reason) => {
    connectionStatus = 'Disconnected';
    qrCodeDataUrl = null;
    console.log('WhatsApp client disconnected:', reason);
    if (broadcastFn) {
      broadcastFn({ type: 'wa-status', status: connectionStatus });
      broadcastFn({ type: 'log', message: 'WhatsApp disconnected: ' + reason });
    }
  });

  client.initialize().catch(err => {
    console.error('Error initializing WhatsApp client:', err);
    connectionStatus = 'Disconnected';
    if (broadcastFn) broadcastFn({ type: 'wa-status', status: connectionStatus });
  });
}

export async function disconnectWhatsapp() {
  if (!client) return;
  try {
    await client.logout();
  } catch (e) {
    console.error('Error logging out from WhatsApp:', e);
  }
  try {
    await client.destroy();
  } catch (e) {
    console.error('Error destroying WhatsApp client:', e);
  }
  client = null;
  qrCodeDataUrl = null;
  connectionStatus = 'Disconnected';
  if (broadcastFn) {
    broadcastFn({ type: 'wa-status', status: connectionStatus });
    broadcastFn({ type: 'log', message: 'WhatsApp session logged out.' });
  }
  // Re-initialize a clean client instance
  initWhatsappClient(broadcastFn);
}

export async function sendWhatsappMessage(phone, messageText) {
  if (!client || connectionStatus !== 'Connected') {
    throw new Error('WhatsApp is not linked. Please scan the QR code first.');
  }

  // Remove all non-digits to get clean number
  let cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone) {
    throw new Error('Invalid phone number format.');
  }

  // Auto-format local Indian numbers (very common since leads are scraped locally)
  // If it starts with 0 and has 11 digits, replace leading 0 with 91
  if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
    cleanPhone = '91' + cleanPhone.substring(1);
  }
  // If it is a 10-digit number, prepend 91
  else if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }

  console.log(`Formatting phone: ${phone} -> Sending to: ${cleanPhone}`);

  const chatId = `${cleanPhone}@c.us`;
  const response = await client.sendMessage(chatId, messageText);
  return response;
}
