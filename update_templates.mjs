import { db } from "./database.js";

const WA_MAIN = `Namaste {{BusinessName}} 👋

Tanuj here from *AI AutomationHubs* — I noticed your business in {{Location}} on Google Maps.

Quick question — is your team still handling customer inquiries, bookings, or follow-ups manually? 🤔

We have helped 50+ businesses across India automate exactly this — saving 4-6 hours daily and tripling their response speed.

{{PersonalizedPitch}}

Would love to show you a *60-second demo* — no pitch, just results.

Open for a quick call this week?
*Tanuj:* +91-7704077700
*Amit:* +91-9990080408
https://ai-automation-hubs.com`;

const WA_NO_WEBSITE = `Namaste {{BusinessName}} 👋

Congratulations on your *{{Rating}} star rating* on Google Maps in {{Location}} — that is impressive!

I noticed one thing though — customers searching for you on Google cannot find a website or WhatsApp link to contact you directly. You could be missing *30-50 inquiries every month* to competitors who have one.

We build *1-Page Mobile Websites + 24/7 AI WhatsApp Bots* specifically for top-rated local businesses in {{Location}}.

Your inquiries get captured automatically — even at midnight.
Ready in 48 hours. Priced for local businesses.

Can I send you a *60-second video demo* of how it works for a business like yours?

Tanuj: +91-7704077700
https://ai-automation-hubs.com`;

const EMAIL_SUBJECT = `Quick idea for {{BusinessName}} — worth 2 minutes?`;

const EMAIL_BODY = `Hi {{BusinessName}} Team,

I came across your business in {{Location}} and genuinely wanted to reach out — not with a generic pitch, but with something specific.

{{PersonalizedPitch}}

We at AI AutomationHubs help local and growing businesses set up:

- AI-powered WhatsApp Assistants — reply to every customer inquiry instantly, 24/7
- Automated Follow-up Workflows — so no lead or booking falls through the cracks
- 1-Page Mobile Websites — for businesses that want an instant digital presence

We have helped 50+ businesses across India save 4-6 hours daily and grow their inbound leads by 3x — without hiring extra staff.

Would you be open to a quick 2-minute call this week?

Warm regards,

Tanuj Chandel & Amit Pandey
Co-founders, AI AutomationHubs India
Tanuj: +91-7704077700 | Amit: +91-9990080408
https://ai-automation-hubs.com
info@ai-automation-hubs.com

P.S. No hard sell — just a 2-minute screen share. If it is not a fit, no worries at all.`;

const SMS = `Hi {{BusinessName}}! Tanuj here from AI AutomationHubs. We automate WhatsApp replies, bookings & follow-ups for {{Location}} businesses — saving 4-6 hrs/day. 2-min demo? +91-7704077700 | ai-automation-hubs.com`;

const TELEGRAM = `Namaste {{BusinessName}} 👋

Tanuj here from *AI AutomationHubs* — I spotted your business in {{Location}} and wanted to connect personally.

{{PersonalizedPitch}}

Here is what we do:
🤖 *AI WhatsApp Assistants* — handle customer queries 24/7, automatically
⚙️ *Booking & Follow-up Automation* — zero manual effort, zero missed leads
🌐 *1-Page Mobile Websites* — instant online presence for local businesses

Results our clients typically see:
📈 3x more inbound responses
⏱️ 4-6 hours saved every day
💰 30-40% lower follow-up costs

Can I share a *60-second demo video* for {{BusinessName}}?

*Tanuj Chandel:* +91-7704077700 | https://t.me/+917704077700
*Amit Pandey:* +91-9990080408 | https://t.me/+919990080408
🌐 https://ai-automation-hubs.com`;

const updated = db.updateSettings({
  waMessageTemplate: WA_MAIN,
  waNoWebsiteTemplate: WA_NO_WEBSITE,
  emailSubjectTemplate: EMAIL_SUBJECT,
  emailBodyTemplate: EMAIL_BODY,
  smsMessageTemplate: SMS,
  telegramMessageTemplate: TELEGRAM
});

console.log("✅ All 6 templates updated!\n");
console.log("WA MAIN preview:", updated.waMessageTemplate.split("\n").slice(0,2).join(" | "));
console.log("WA NO-WEBSITE preview:", updated.waNoWebsiteTemplate.split("\n").slice(0,2).join(" | "));
console.log("EMAIL SUBJECT:", updated.emailSubjectTemplate);
console.log("SMS:", updated.smsMessageTemplate.substring(0, 80) + "...");
console.log("TELEGRAM preview:", updated.telegramMessageTemplate.split("\n").slice(0,2).join(" | "));
console.log("\nDone.");
process.exit(0);
