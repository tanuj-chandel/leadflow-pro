import Database from 'better-sqlite3';

const db = new Database('./leads.db');
const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();

if (row) {
  const settings = JSON.parse(row.data);
  const newTemplate = `Hi {{BusinessName}}, Tanuj here 👋

Not selling generic marketing or random agency services.

Most businesses face the exact same 2 problems:
1. Finding verified, qualified customer leads consistently.
2. Replying to those inquiries on WhatsApp within 5 seconds before a competitor steals them.

We built an autonomous Dual-AI system:
• Lead Agent: Extracts & verifies high-intent business/customer leads globally.
• WhatsApp Agent: Handles conversations 24/7 and books appointments automatically.

Rather than making big promises, let me just prove it:

I can pull 5 verified leads for you right now for FREE — in any city globally (India, Dubai, US, UK, etc.).

Reply with your Target City & Business Niche, and I'll send your 5 free sample leads right here on WhatsApp.

—
Tanuj Chandel | AI AutomationHubs
🌐 ai-automation-hubs.com`;

  settings.waMessageTemplate = newTemplate;
  db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(settings));
  console.log('✅ Template updated successfully in DB!');
} else {
  console.log('❌ Settings row not found');
}
