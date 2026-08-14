# 🚀 Map Lead Scraper & Cold Outreach Automation Suite

> An end-to-end B2B Lead Scraping, Contact Enrichment, and Automated Cold Outreach Platform powered by Node.js, Express, Google APIs, and WhatsApp Web integration.

---

## 🌟 Overview

**Map Lead Scraper** is a high-performance web platform designed to streamline lead generation and cold outreach. It enables businesses, agencies, and sales teams to scrape local businesses from Google Maps/Places, enrich lead profiles with verified emails, phone numbers, and social media handles via deep website crawling, and execute targeted email and WhatsApp outreach directly from a single dashboard.

---

## ✨ Key Features

### 🔍 1. Smart Multi-Source Lead Generation
- **Google Places API Scraper:** Fetch targeted business records based on search term, location, and desired volume.
- **Instant AI Lead Generator:** Generate industry-segmented leads instantly without requiring API keys for rapid testing and demonstrations.
- **Automated Web Crawler:** Crawl business websites (Home, Contact, About) to discover emails, phone numbers, and social links (Facebook, Instagram, LinkedIn, X/Twitter).

### 📊 2. Lead Scoring & Quality Matrix
- **3/3 Contact Completeness Score:** Automatically ranks leads with complete contact info (Phone + Website + Socials) at the top of your list.
- **Quality Score Rating:** Classifies leads into **Hot**, **Warm**, and **Cold** tiers based on data richness and customer rating.

### ✉️ 3. One-Click Gmail Outreach
- **Google OAuth Integration:** Securely connect your Google workspace account.
- **Automated Draft Creation:** Automatically compose dynamic Gmail drafts using customizable templates for batch outreach.
- **Google Sheets Sync:** Sync all scraped leads and outreach status directly to a live Google Sheet in real time.

### 💬 4. WhatsApp Web Integration
- **Direct WhatsApp Messaging:** Scan a single QR code to link your WhatsApp account via `whatsapp-web.js`.
- **Automated Bulk Messaging:** Send personalized outreach messages directly to leads with rate limiting and retry handling.
- **Audit Logs:** Track complete delivery status and failure history in real time.

### 📈 5. Real-Time Dashboard & Export
- **Server-Sent Events (SSE):** Stream live logs and progress indicators directly to the dashboard interface.
- **One-Click CSV Export:** Export lead datasets formatted for any CRM tool.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js (ES Modules)
- **Scraping & Automation:** Google Places API, `whatsapp-web.js`, Puppeteer
- **Outreach & APIs:** Google APIs (`googleapis` for Gmail & Google Sheets)
- **Frontend:** HTML5, Modern Vanilla CSS, JavaScript (ES6+), Server-Sent Events (SSE)
- **Database:** Atomic File-Backed JSON Store

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18.0.0 or higher
- **Google Chrome**: Installed locally on system (used by WhatsApp Web client)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/map-lead-scraper.git
   cd map-lead-scraper
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables (Optional):**
   Create a `.env` file in the root directory:
   ```env
   PORT=3000
   ```

4. **Start the application:**
   ```bash
   npm start
   ```

5. Open your browser and navigate to `http://localhost:3000`.

---

## 🔑 Configuration & Setup

1. **Google Places API Key (Optional):**
   - Go to **Settings** in the dashboard.
   - Enter your Google Places API key to scrape live Google Maps data. If omitted, the system seamlessly uses the **Instant Segment Generator**.

2. **Google Gmail & Sheets Integration:**
   - Add your Google OAuth Client ID and Secret in **Settings**.
   - Click **Connect Google Account** to authorize Gmail draft creation and Google Sheets sync.

3. **WhatsApp Linking:**
   - Navigate to the WhatsApp status panel in **Settings**.
   - Scan the rendered QR code with your mobile WhatsApp app to link outreach.

---

## 📁 Directory Structure

```
map-lead-scraper/
├── database.js          # File-backed JSON database engine
├── outreach.js          # Gmail OAuth, draft generator & Google Sheets sync
├── scraper.js           # Google Places API & deep website contact crawler
├── server.js            # Express API server & SSE live log streamer
├── whatsapp-client.js   # WhatsApp Web client wrapper
├── public/
│   ├── index.html       # Primary Lead Dashboard UI
│   ├── app.js           # Frontend client application logic
│   ├── styles.css       # Design tokens & responsive styles
│   └── sell.html        # Sales landing page layout
└── package.json         # Dependencies & scripts
```

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
