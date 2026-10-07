# 🧠 AI AutomationHubs - Project Memory & System Knowledge Base
**Repository:** `map_lead_scraper_redesigned`  
**Founders:** Tanuj Chandel (AI Generalist) & Amit Pandey (AI Automation Engineer)  
**Company:** AI AutomationHubs India (`ai-automation-hubs.com`)  
**Phones:** Tanuj: `+91-7704077700` | Amit: `+91-9990080408`  
**Official Email:** `automationhubsindia@gmail.com`  
**Version:** 3.5 Enterprise (Current) ➔ 4.0 (Next Version Roadmap)  
**Last Updated:** September 2026

---

## 1. Project Purpose & Executive Summary
An autonomous, enterprise-grade B2B lead scraper and multi-channel outreach engine designed to eliminate manual prospecting. It targets high-ticket international and domestic businesses, extracts verified direct contact information (emails, mobile phones, social links), and orchestrates outreach across WhatsApp, Telegram, and Gmail with zero ban risk and automated AI copilot reply handling.

---

## 2. Core Architecture & Tech Stack

```
                                  [ Web Dashboard ]
                      (HTML5 / CSS3 / Vanilla JS / SSE Live Stream)
                                          │
                                          ▼
                                [ Express.js Server ]
                                  (server.js - ESM)
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
          [ Scraping Engine ]     [ Outreach Engines ]   [ Storage Layer ]
        • Google Places API (New) • WhatsApp (Puppeteer) • SQLite (better-sqlite3)
        • Deep Website Crawler    • Telegram UserBot     • WAL Mode Concurrency
        • libphonenumber-js       • Gmail OAuth2 API     • Settings & Leads tables
```

- **Runtime:** Node.js v24+ (ESM mode `"type": "module"`)
- **Server:** Express.js (`server.js`), Server-Sent Events (SSE) on `/api/logs/stream`
- **Database:** SQLite (`leads.db`) via `better-sqlite3` with `PRAGMA journal_mode = WAL`
- **Maps API:** Google Places API v1 (New) (`https://places.googleapis.com/v1/places:searchText`)
- **WhatsApp:** `whatsapp-web.js` with Headless Chromium, anti-detection flags & session persistence in `.wwebjs_auth/`
- **Telegram UserBot:** GramJS (`telegram` npm) running as Tanuj Chandel, session string persisted in SQLite settings
- **Email Engine:** `googleapis` Gmail OAuth2 API creating 1-click personalized drafts in `automationhubsindia@gmail.com`
- **Inbound AI Copilot:** OpenAI GPT-4o-mini analyzing replies, moving leads to `Interested`, and alerting founders on Telegram with 1-tap quick actions

---

## 3. Critical Bugs Solved & Hard Lessons Learned (DO NOT REPEAT)

### 🔴 WhatsApp Client Stability on Windows
1. **Zombie Chrome & `.wwebjs_auth` Lock:**
   - *Problem:* Abnormal node restarts or Windows task kills leave orphaned `chrome.exe` processes holding locks on `DevToolsActivePort` and `SingletonLock`. The next startup fails with `Error: The browser is already running for ...\.wwebjs_auth\session`.
   - *Permanent Fix:* `clearStaleChromeLocks()` automatically cleans `SingletonLock`, `SingletonCookie`, `SingletonSocket`, and `DevToolsActivePort` before client initialization.
   - *Shutdown Hooks:* `server.js` listens to `SIGINT` and `SIGTERM` to gracefully destroy Puppeteer browsers before node exits.
2. **Auto-Recovery Watchdog:**
   - *Problem:* Disconnects or network hiccups previously left the client dead in `Disconnected` state.
   - *Permanent Fix:* `scheduleReconnect()` auto-reconnects with exponential backoff so the system self-heals without terminal commands.
3. **Anti-Detection Stealth:**
   - Headless Chrome user agent is overridden with desktop Chrome 128 User-Agent (`Mozilla/5.0 ... Chrome/128.0.0.0 Safari/537.36`).
   - Flags: `--disable-blink-features=AutomationControlled`, `takeoverOnConflict: true`, `bypassCSP: true`.
   - Realistic human typing presence (600–1,400ms) before every message dispatch.

### 🔴 Lead Generation & Phone Intelligence
1. **Google Places API Pagination Bug:**
   - *Problem:* Scraping 50 leads previously stopped at 20 leads.
   - *Root Cause:* `nextPageToken` was omitted from `X-Goog-FieldMask`. In Google Places API (New), if `nextPageToken` is missing from the field mask, Google will NOT return it.
   - *Permanent Fix:* Added `nextPageToken` to `X-Goog-FieldMask` and a 1.5s delay before requesting the next page.
2. **Phone Number Overwriting Bug:**
   - *Problem:* Google Places gave authentic business phones, but the website crawler used a loose regex that matched timestamps, CSS pixel values, or image IDs on websites, corrupting the phone numbers.
   - *Permanent Fix:* Google Places' verified phone number is ALWAYS kept as canonical. Website crawler only extracts `tel:` and click-to-chat `wa.me/` links as fallback.
3. **UK vs UAE Market Realities:**
   - **United Kingdom (`+44 20...`):** UK business listings on Google Maps are **fixed-line reception desk landlines**. Landlines physically cannot have Telegram accounts! The winning channel for UK leads is **Email Outreach** (36 verified clinic emails extracted & drafted in Gmail).
   - **United Arab Emirates (`+971 5...`):** Dubai business owners and brokers use **mobile numbers** on Google Maps. Both **WhatsApp** and **Telegram** deliver with high reply rates.

### 🔴 Windows Antivirus TLS Inspection
- On Windows, corporate antivirus or proxy tools inspect HTTPS traffic, causing Node.js `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
- Always run server with `node --use-system-ca server.js` or ensure `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is active in local development.

---

## 4. Database Schema & Data Conventions

- **Database file:** `d:\AI AUTOMATION\map_lead_scraper_redesigned\leads.db` (Single source of truth).
- **`leads` Table:**
  - `id` (e.g. `lead_1788759857...`)
  - `businessName`, `address`, `phone`, `website`, `email`, `rating`
  - `segment` (15 categories: Real Estate, Healthcare, Tech/SaaS, HoReCa, Finance, etc.)
  - `qualityScore`: `Hot`, `Warm`, `Cold`
  - `leadStatus`: `New` ➔ `Contacted` ➔ `Interested` ➔ `Closed` / `Lost`
  - `emailStatus`: `Pending`, `Draft Created`, `Sent`
  - `whatsappStatus`: `Pending`, `Sent`, `Error`
  - `telegram`: `Sent`, `Error: ...`
  - `dataMode`: `REAL` (strictly zero mock data)
- **`settings` Table:** ID = 1, JSON object containing non-sensitive configuration (message templates, anti-spam delay intervals, daily quota limits). All sensitive credentials (`placesApiKey`, `openaiApiKey`, `googleClientSecret`, `googleTokens`, `telegramBotToken`, `telegramApiHash`, `telegramUserSession`) are strictly isolated in `.env` loaded via `dotenv`, preventing credential exposure when `leads.db` is backed up, zipped, or distributed.

---

## 5. Active Verified Campaigns in Database (145 Total Verified Leads)

*Live database synchronization generated via `generate_memory_campaign_section.js` from `SELECT location, COUNT(*) FROM leads GROUP BY location`.*

1. **London, UK (50 Leads):**
   - **Target / Search Terms:** Private Dental Clinics (50 Leads)
   - **Verified Phones:** 50 / 50 verified contact phones (`+44...`)
   - **Verified Emails:** 36 direct business emails extracted
   - **Outreach Status:** 36 Gmail drafts generated in `automationhubsindia@gmail.com`
2. **Dubai, UAE (50 Leads):**
   - **Target / Search Terms:** Real Estate Agency (50 Leads)
   - **Verified Phones:** 50 / 50 verified contact phones (`+971...`)
   - **Verified Emails:** 34 direct business emails extracted
   - **Outreach Status:** 34 Gmail drafts generated in `automationhubsindia@gmail.com`, 3 Telegram messages sent
3. **Dubai (14 Leads):**
   - **Target / Search Terms:** Dental Clinics (14 Leads)
   - **Verified Phones:** 14 / 14 verified contact phones (`+971...`)
   - **Verified Emails:** 9 direct business emails extracted
   - **Outreach Status:** Leads verified & staged in pipeline
4. **kanpur (10 Leads):**
   - **Target / Search Terms:** Gym & Fitness Club (10 Leads)
   - **Verified Phones:** 9 / 10 verified contact phones (`+91...`)
   - **Verified Emails:** 0 direct business emails extracted
   - **Outreach Status:** 3 WhatsApp messages sent
5. **bhopal (10 Leads):**
   - **Target / Search Terms:** Fine Dining Restaurant (3 Leads), Boutique Hotel (3 Leads), Catering Services (2 Leads), Cafe & Bakery (2 Leads)
   - **Verified Phones:** 10 / 10 verified contact phones (`+91...`)
   - **Verified Emails:** 10 direct business emails extracted
   - **Outreach Status:** 10 Gmail drafts generated in `automationhubsindia@gmail.com`, 3 WhatsApp messages sent
6. **Kanpur (5 Leads):**
   - **Target / Search Terms:** Cold Storage Warehouse (5 Leads)
   - **Verified Phones:** 5 / 5 verified contact phones (`+91...`)
   - **Verified Emails:** 4 direct business emails extracted
   - **Outreach Status:** 4 Gmail drafts generated in `automationhubsindia@gmail.com`
7. **Delhi (5 Leads):**
   - **Target / Search Terms:** Dentists (5 Leads)
   - **Verified Phones:** 5 / 5 verified contact phones (`+91...`)
   - **Verified Emails:** 3 direct business emails extracted
   - **Outreach Status:** 3 Gmail drafts generated in `automationhubsindia@gmail.com`
8. **Delhi NCR (1 Lead):**
   - **Target / Search Terms:** AI Automation Engineer (1 Lead)
   - **Verified Phones:** 1 / 1 verified contact phones (`+91...`)
   - **Verified Emails:** 1 direct business emails extracted
   - **Outreach Status:** 1 Telegram messages sent
9. **Interactive Solar AI Demo Simulator:**
   - Deployed at `http://localhost:3000/solar_demo.html` with NSW rebate calculator and automated booking simulator (Auxiliary asset).


---

## 6. Blueprint & Priorities for Next Version (v4.0 Roadmap)

When developing the next version, build directly on top of these foundations:

1. **Multi-Step Drip Sequence Engine:**
   - Automated timeline: Day 1 (Gmail Intro) ➔ Day 3 (WhatsApp Follow-Up) ➔ Day 6 (Telegram Bump).
2. **Inbound WhatsApp/Telegram Autonomous AI Sales Agent:**
   - Upgrade beyond suggested replies to full autonomous conversation booking directly onto Google Calendar / Cal.com.
3. **Cloud VPS / Docker Deployment:**
   - Migrate from local Windows to Ubuntu VPS (DigitalOcean / Hetzner / AWS) using Docker Compose with headless Chromium and PM2 process management.
4. **Custom CSV & CRM Sync:**
   - Direct two-way sync with HubSpot, GoHighLevel, and Notion.

---

## 7. Certified Milestones — Phase 2 Enterprise Progression

### ✅ Phase 2 Step 8 — Conversation Intelligence (CERTIFIED)
- **Inbound Multi-Channel Ingestion:** WhatsApp, Telegram, Gmail normalized into `conversations` & `conversation_messages`.
- **AI Analysis Engine:** Deterministic pre-sanitization stripped prompt injection attacks (`IGNORE_INSTRUCTIONS`, delimiter escapes); intent taxonomy (`INTERESTED`, `NOT_INTERESTED`, `PRICING_QUERY`, `STOP_REQUEST`).
- **Inverted Opt-Out Invariant:** Opt-out messages committed to suppression registry and audit log BEFORE subsequent message processing, immediately invalidating pending drafts.
- **Human-in-the-Loop Gating:** Drafts remain in `conversation_drafts` with `status = 'PENDING_APPROVAL'`. Outbound sending requires signed operator authorization and passes through `executeOutreachGate()`.

### ✅ Phase 2 Step 9 — CRM & Opportunity Management (CERTIFIED)
- **Data Model:** Additive tables `opportunities`, `opportunity_stage_history`, `opportunity_tasks`.
- **Pipeline State Machine:** Strict sequential transitions (`DISCOVERY` ➔ `DEMO_BOOKED` ➔ `QUALIFIED` ➔ `PROPOSAL_SENT` ➔ `NEGOTIATION` ➔ `CLOSED_WON` / `CLOSED_LOST`).
- **Loss Reason Governance:** Mandatory taxonomy code and notes (>= 5 chars) enforced at database layer.
- **Cal.com Inbound Meeting Bridge:** Webhook maps prospect to deal and schedules meeting task idempotently without triggering outbound messages.

### ✅ Phase 2 Step 10 — Revenue & Attribution (CERTIFIED)
- **Data Model:** Additive tables `revenue_attributions`, `revenue_ledger`.
- **Attribution Models:** 5 canonical models mathematically verified (`FIRST_TOUCH`, `LAST_TOUCH`, `LINEAR`, `POSITION_BASED`, `TIME_DECAY`).
- **Financial Conservation Invariant:** Sum of weights strictly equals 1.0000; sum of attributed values equals deal value with zero penny rounding discrepancy.
- **Realization Ledger:** Realized revenue recorded immutably on `CLOSED_WON` transitions.
- **Verification:** 15 regression suites passing (923 assertions), 0 failures.

### ✅ Phase 2 Step 11 — Analytics & Decision Intelligence (CERTIFIED)
- **Data Model:** Additive Table 21 `decision_intelligence_snapshots` with multi-tenant index and check constraint on snapshot types (`PIPELINE_VELOCITY`, `COHORT_FUNNEL`, `SLA_ANALYSIS`, `CHANNEL_EFFECTIVENESS`, `LOSS_INTELLIGENCE`).
- **Pipeline Velocity Engine:** Exact velocity per day computed across qualified active opportunities, win rate, and average sales cycle length.
- **SLA & Bottleneck Detection:** Multi-stage SLA threshold tracking (`DISCOVERY`: 7d, `DEMO_BOOKED`: 7d, `QUALIFIED`: 10d, `PROPOSAL_SENT`: 14d, `NEGOTIATION`: 14d) with automated tactical recommendations.
- **Cohort Funnel Analytics:** Segment-level conversion tracking (Total $\rightarrow$ Enriched $\rightarrow$ Contacted $\rightarrow$ Opportunity $\rightarrow$ Won) with zero divide-by-zero risk.
- **Loss Reason Intelligence:** Automated taxonomy-driven distribution analysis and competitor/pricing resistance triggers.
- **Verification:** 16 regression suites passing (937 assertions), 0 failures.

### ✅ Phase 2 Step 12 — Production Certification & Phase 2 Finalization (CERTIFIED & SIGNED OFF)
- **Unified Lifecycle Integration:** Full verified lifecycle proof (Lead $\rightarrow$ Multi-Channel Touches $\rightarrow$ Opportunity $\rightarrow$ Closed Won $\rightarrow$ Position-Based Attribution $\rightarrow$ Revenue Ledger $\rightarrow$ Decision Snapshot).
- **Table Matrix Audit:** All 21 core architectural tables verified with multi-tenant scoping, check constraints, and foreign key cascades.
- **Architectural Safety Invariants:** Phase 1 supreme safety gate (`executeOutreachGate()`) preserved with zero bypass paths; fail-closed execution on missing operator approval or invalid transport.
- **Security & Multi-Tenant Isolation:** Complete cross-tenant boundary isolation proven cryptographically and procedurally.
- **Master Regression Suite:** 17 regression suites passing (945 assertions), 0 failures.
- **Database Baseline Health:** 145 real baseline leads, 175 evidence rows, 40 approved historical snapshots, 0 foreign key violations, PRAGMA integrity_check = ok, WAL mode active.

### 🛡️ Test Rigor & Disposable Database Sandboxing
- **Disposable Sandbox Execution (Default):** `npm test` (`node run_all_verifications.js`) clones `leads.db` into an ephemeral sandbox (`leads_disposable_<timestamp>.db`) on the fly, runs all verification suites in isolation, and destroys the sandbox in `finally`. Zero test writes ever reach the production database.
- **Production Opt-In Gate:** Direct live database testing requires explicit opt-in via `npm run test:prod` or `node <script> --production`.
- **Guaranteed `try ... finally` Teardown:** Every `verify_step*.js` script encloses its test execution in `try ... finally` blocks backed by [`test_harness_helper.js`](file:///D:/AI%20AUTOMATION/map_lead_scraper_redesigned/test_harness_helper.js) and [`cleanup_test_data.js`](file:///D:/AI%20AUTOMATION/map_lead_scraper_redesigned/cleanup_test_data.js) to guarantee complete cleanup of every table touched (`campaigns`, `campaign_review_logs`, `compliance_audit_logs`, `operator_keys`, `daily_quota_usage`, `suppression_list`, `opportunities`, `leads`), leaving the database in pristine baseline condition even if assertions fail.
- **Standalone Purge Utility:** `npm run cleanup:test-data` (`node cleanup_test_data.js`) sweeps every table for test tenants (`test_%`, `%_test%`, `tenant_prod_cert_%`, `attacker_tenant_xyz`, `cert_tenant_%`, etc.) with automatic FK and integrity verification.

### 🛡️ Messaging Resilience & Rate-Limit Protections (CERTIFIED)
- **WhatsApp Pre-Flight Health Check (`checkWhatsappHealth()`):** Performs an active live ping against the underlying Puppeteer execution context before batch dispatch. If the client is disconnected or stuck on QR, batch outreach aborts immediately (HTTP 503) without mutating leads to error state.
- **Puppeteer Detached Frame Auto-Recovery:** Automatic detection of detached frame errors (`Attempted to use detached Frame`, `Execution context was destroyed`) in keep-alive monitoring and message dispatch. Triggers automatic Chromium session re-attaching/reconnecting (`scheduleReconnect()`) and fail-fast circuit breaking to prevent cascading batch failures.
- **Telegram GramJS Flood-Wait Handling (`parseTelegramFloodError()`):** Parses `FLOOD_WAIT_X` and `FloodWaitError` seconds, calculates backoff intervals, and pauses the dispatch queue with safety buffers.
- **Telegram PEER_FLOOD Abuse Protection:** Implements an immediate circuit breaker on Telegram spam flags (`400: PEER_FLOOD`). Instantly halts outreach queue execution to prevent account bans, broadcasts high-priority operator alerts pointing to `@SpamBot`, and rejects subsequent dispatches fail-closed until manual operator reset (`POST /api/telegram/rate-limit/reset`).
### 🛡️ Credential Isolation & Environment Security (CERTIFIED)
- **Environment Isolation:** Moved `placesApiKey`, `openaiApiKey`, `googleClientSecret`, `googleTokens`, `telegramBotToken`, `telegramApiHash`, and `telegramUserSession` out of SQLite `settings` table into `.env` loaded via `dotenv`.
- **Database Sanitization:** Purged all sensitive API keys, OAuth tokens, and GramJS session strings from `leads.db`. Future backups, zips, or repository distributions contain zero credentials.
- **Transparent Compatibility:** `db.getSettings()` transparently overlays credentials from `process.env`. `db.updateSettings(...)` updates `process.env` and `.env` while ensuring secrets are never persisted into SQLite.
- **Template Documentation:** Documented all 7 required environment variables with clean empty placeholders and usage comments in `.env.example`.

---

## 8. Phase 3 Roadmap — Advanced Campaign Playbooks & Autonomous Orchestration

With Phase 1 (Safety Engine) and Phase 2 (Enterprise Foundation & Lifecycle) 100% certified, the system is ready for **Phase 3**:

1. **Step 1: Multi-Channel Playbook Template Engine** (Dynamic multi-touch sequences across WhatsApp, Email, Telegram with branch conditions).
2. **Step 2: Smart Send-Time Optimization (STO)** (Timezone and engagement-aware dispatch windows).
3. **Step 3: Dynamic Fallback Escalation** (Email bounces $\rightarrow$ WhatsApp fallback $\rightarrow$ Telegram bump).
4. **Step 4: AI Reply Copilot v2 & Calendar Auto-Negotiation** (Real-time Cal.com availability negotiation with zero human friction).
5. **Step 5: Cloud Production Readiness & Container Deployment** (Docker, PM2, and headless Chromium stability on Linux VPS).
