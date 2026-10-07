# Agent Guidelines & Memory Reference

This file instructs AI coding agents working on the **AI AutomationHubs LeadFlow Pro** codebase.

## 🧠 Permanent Memory & Knowledge Base
Before starting any development, bug fixing, or architectural updates, **ALWAYS review the detailed project memory**:
👉 [PROJECT_MEMORY.md](file:///d:/AI%20AUTOMATION/map_lead_scraper_redesigned/PROJECT_MEMORY.md)

## 📌 Critical Project Rules & Non-Negotiables
1. **Zero Mock / Fake Data Rule:**
   - Lead discovery MUST use the **Google Places API v1 (New)** or direct live crawling. NEVER generate fake phone numbers, fake addresses, or mock data.
   - Lead source provider setting in SQLite database MUST remain `places` or authentic Google Places in `auto` mode.
2. **Canonical Phone Integrity:**
   - The phone number returned by Google Places (`place.internationalPhoneNumber` / `place.nationalPhoneNumber`) is canonical.
   - NEVER overwrite it with random numbers matched in raw website HTML. Website crawler only extracts `tel:` and click-to-chat `wa.me/` links as fallback if Google Places provides no phone.
3. **WhatsApp Engine Resilience:**
   - Always run with `clearStaleChromeLocks()` before starting `whatsapp-web.js`.
   - Never remove the `SIGINT` / `SIGTERM` cleanup handlers or the `scheduleReconnect()` watchdog in `whatsapp-client.js`.
   - Keep anti-detection flags (`--disable-blink-features=AutomationControlled`, modern Chrome User-Agent, human typing delay).
4. **Telegram MTProto Rules:**
   - Telegram session string is saved permanently in SQLite under `telegramUserSession`. DO NOT wipe or overwrite it.
   - Always use `Api.contacts.ImportContacts` to resolve cold numbers to entities before sending Telegram messages.
5. **Runtime Protocol on Windows:**
   - Always execute Node with `node --use-system-ca server.js` to avoid Windows antivirus certificate verification errors.
6. **Next Version (v4.0) Focus:**
   - Multi-step drip outreach sequences (Email ➔ WhatsApp ➔ Telegram).
   - Autonomous appointment booking AI Copilot.
   - Docker containerization for VPS deployment.
