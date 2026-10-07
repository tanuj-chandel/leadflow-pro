# Antigravity Project Rules & Persistent Memory

This workspace operates under strict production engineering standards for **AI AutomationHubs India**.

## 🧠 Permanent System Memory
All system architecture, past bug fixes, market targeting insights, and credentials conventions are documented in:
👉 [PROJECT_MEMORY.md](file:///d:/AI%20AUTOMATION/map_lead_scraper_redesigned/PROJECT_MEMORY.md)

## ⚡ Key Architectural Commandments
- **Zero Mock / Fake Data:** Strictly use Google Places API v1 (New) and verified website crawl data. Never inject placeholder or hallucinated numbers.
- **WhatsApp Anti-Crash Architecture:** Preserve `clearStaleChromeLocks()`, process termination signal hooks (`SIGINT`/`SIGTERM`), and `scheduleReconnect()` watchdog in `whatsapp-client.js`.
- **Phone Number Priority:** Google Places API phone is canonical; do not overwrite with loose regex matches from HTML pages.
- **Telegram UserBot Persistence:** Telegram StringSession is stored permanently in SQLite settings table; preserve it across reloads.
- **Windows Runtime:** Run Node with `--use-system-ca` to prevent corporate antivirus TLS handshake failures.
