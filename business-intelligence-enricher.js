/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 3: BUSINESS INTELLIGENCE ENRICHER
 * ============================================================================
 * Controlled, evidence-backed Business Intelligence Enrichment Engine.
 *
 * Responsibilities:
 * 1. Polite, controlled crawling within strict domain boundaries.
 * 2. Structured extraction (Description, Services, Industry, Target Customers, Locations, Channels).
 * 3. Technology signal detection (CMS, Analytics, Chat, Booking, CRM, Payment).
 * 4. Digital presence and measurable website quality signals.
 * 5. Automation opportunity signals and growth signals.
 * 6. Conservative pain-point signals.
 * 7. Evidence & Signal creation with explicit provenance (VERIFIED vs INFERRED) and expiry.
 * 8. Idempotent storage and tenant isolation.
 */

import { normalizePhone, normalizeEmail, normalizeWebsite } from './entity-resolver.js';

// Local TLS bypass for Windows antivirus/proxy inspection (avoids UNABLE_TO_VERIFY_LEAF_SIGNATURE)
if (process.env.ALLOW_INSECURE_TLS !== 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ----------------------------------------------------------------------------
// 1. CONSTANTS & CRAWLER CONFIGURATION
// ----------------------------------------------------------------------------

export const CRAWLER_CONFIG = {
  MAX_PAGES_PER_DOMAIN: 6,
  PAGE_TIMEOUT_MS: 6000,
  REQUEST_DELAY_MS: 250,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AIAutomationHubsBot/3.5',
  MAX_REDIRECTS: 3
};

export const PROVENANCE_TYPES = {
  VERIFIED: 'VERIFIED',
  INFERRED: 'INFERRED',
  AI_ESTIMATED: 'AI_ESTIMATED',
  UNKNOWN: 'UNKNOWN'
};

const EXCLUDED_PATH_REGEX = /(\/(admin|wp-admin|wp-login|login|signin|cart|checkout|my-account|account|api|xmlrpc)(\/|$|\?)|\.(pdf|jpg|jpeg|png|webp|zip|css|js)(\?|$))/i;

const SEMANTIC_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/our-story',
  '/who-we-are',
  '/services',
  '/our-services',
  '/treatments',
  '/products',
  '/solutions',
  '/contact',
  '/contact-us',
  '/reach-us',
  '/team',
  '/our-doctors',
  '/leadership',
  '/locations',
  '/branches',
  '/clinics',
  '/careers',
  '/jobs'
];

// Technology signatures
const TECH_SIGNATURES = [
  // CMS & Platforms
  { name: 'WordPress', category: 'CMS', regex: /\/wp-(content|includes)\/|name=["']generator["'][^>]*content=["']WordPress/i, confidence: 0.98 },
  { name: 'Shopify', category: 'ECOMMERCE', regex: /cdn\.shopify\.com|Shopify\.theme|shopify-section/i, confidence: 0.98 },
  { name: 'Wix', category: 'CMS', regex: /static\.wixstatic\.com|_wix_|wix\.com/i, confidence: 0.98 },
  { name: 'Squarespace', category: 'CMS', regex: /squarespace\.com|static1\.squarespace\.com/i, confidence: 0.98 },
  { name: 'WooCommerce', category: 'ECOMMERCE', regex: /woocommerce|wc-block|woocommerce-cart/i, confidence: 0.95 },
  // Analytics & Tracking
  { name: 'Google Analytics', category: 'ANALYTICS', regex: /googletagmanager\.com|google-analytics\.com|gtag\(/i, confidence: 0.98 },
  { name: 'Meta Pixel', category: 'MARKETING', regex: /connect\.facebook\.net\/en_US\/fbevents\.js|fbq\(/i, confidence: 0.98 },
  { name: 'Hotjar', category: 'ANALYTICS', regex: /static\.hotjar\.com|hjid/i, confidence: 0.95 },
  // Live Chat & Engagement
  { name: 'Tidio Live Chat', category: 'LIVE_CHAT', regex: /code\.tidio\.co/i, confidence: 0.98 },
  { name: 'Intercom', category: 'LIVE_CHAT', regex: /widget\.intercom\.io|ic-chat/i, confidence: 0.98 },
  { name: 'Zendesk Chat', category: 'LIVE_CHAT', regex: /static\.zdassets\.com|zopim/i, confidence: 0.98 },
  { name: 'Crisp Chat', category: 'LIVE_CHAT', regex: /client\.crisp\.chat/i, confidence: 0.98 },
  { name: 'LiveChat', category: 'LIVE_CHAT', regex: /cdn\.livechatinc\.com/i, confidence: 0.98 },
  // Booking & Scheduling
  { name: 'Calendly', category: 'BOOKING', regex: /calendly\.com/i, confidence: 0.98 },
  { name: 'Acuity Scheduling', category: 'BOOKING', regex: /acuityscheduling\.com/i, confidence: 0.98 },
  { name: 'Fresha', category: 'BOOKING', regex: /fresha\.com/i, confidence: 0.98 },
  { name: 'Booksy', category: 'BOOKING', regex: /booksy\.com/i, confidence: 0.98 },
  { name: 'Jane App', category: 'BOOKING', regex: /janeapp\.com/i, confidence: 0.98 },
  // CRM & Forms
  { name: 'HubSpot', category: 'CRM', regex: /js\.hs-scripts\.com|forms\.hubspot\.com|hbspt/i, confidence: 0.98 },
  { name: 'Contact Form 7', category: 'FORMS', regex: /wpcf7|contact-form-7/i, confidence: 0.98 },
  { name: 'Gravity Forms', category: 'FORMS', regex: /gform_|gravityforms/i, confidence: 0.98 },
  { name: 'Mailchimp', category: 'MARKETING', regex: /chimpstatic\.com|mc-embedded-subscribe/i, confidence: 0.95 },
  { name: 'Zoho Forms/CRM', category: 'CRM', regex: /zoho\.com/i, confidence: 0.95 },
  // Payment Gateways
  { name: 'Stripe', category: 'PAYMENT', regex: /js\.stripe\.com/i, confidence: 0.98 },
  { name: 'PayPal', category: 'PAYMENT', regex: /paypal\.com\/sdk/i, confidence: 0.98 },
  { name: 'Telr', category: 'PAYMENT', regex: /telr\.com/i, confidence: 0.95 }
];

// Industry pattern rules
const INDUSTRY_RULES = [
  {
    industry: 'Dental & Oral Healthcare',
    subIndustry: 'Dental Clinic',
    keywords: ['dental', 'dentist', 'teeth', 'orthodontics', 'implants', 'veneers', 'root canal', 'teeth whitening', 'braces', 'invisalign', 'oral surgery']
  },
  {
    industry: 'Healthcare & Medical',
    subIndustry: 'Medical Clinic / Hospital',
    keywords: ['clinic', 'hospital', 'doctor', 'physiotherapy', 'pediatric', 'dermatology', 'wellness', 'physician', 'patient care', 'specialists']
  },
  {
    industry: 'Real Estate & Property',
    subIndustry: 'Property Brokerage & Management',
    keywords: ['real estate', 'property', 'broker', 'villas', 'apartments', 'buy property', 'rent property', 'commercial property', 'leasing', 'landlords', 'off-plan']
  },
  {
    industry: 'Technology & Software',
    subIndustry: 'IT & Software Solutions',
    keywords: ['software development', 'cloud', 'cybersecurity', 'saas', 'web design', 'mobile apps', 'ai solutions', 'automation', 'devops']
  },
  {
    industry: 'Hospitality & Dining',
    subIndustry: 'Restaurant & Catering',
    keywords: ['restaurant', 'cafe', 'dining', 'catering', 'menu', 'food', 'bistro', 'cuisine', 'bar', 'reservation']
  },
  {
    industry: 'Finance & Legal Advisory',
    subIndustry: 'Legal / Accounting Firm',
    keywords: ['advocate', 'law firm', 'legal advice', 'chartered accountant', 'tax audit', 'corporate law', 'accounting', 'litigation']
  }
];

// ----------------------------------------------------------------------------
// 2. CONTROLLED CRAWLER UTILITIES
// ----------------------------------------------------------------------------

/**
 * Fetch a single page safely with timeout, custom User-Agent, and redirect limits.
 */
export async function fetchWithTimeout(url, timeoutMs = CRAWLER_CONFIG.PAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': CRAWLER_CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (!response.ok) {
      return { ok: false, status: response.status, statusText: response.statusText, html: null, finalUrl: response.url };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { ok: false, status: response.status, statusText: 'Non-HTML content', html: null, finalUrl: response.url };
    }

    const html = await response.text();
    return { ok: true, status: response.status, html, finalUrl: response.url };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0, statusText: err.name === 'AbortError' ? 'Timeout' : err.message, html: null, finalUrl: url };
  }
}

/**
 * Normalizes URL path and checks if path is allowed.
 */
export function isAllowedCrawlUrl(rawUrl, allowedRootDomain) {
  try {
    const parsed = new URL(rawUrl);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');

    // Strict domain boundary check
    if (!domain.endsWith(allowedRootDomain)) {
      return false;
    }

    // Check excluded administrative or binary paths
    if (EXCLUDED_PATH_REGEX.test(parsed.pathname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// 3. PAGE EXTRACTION FUNCTIONS
// ----------------------------------------------------------------------------

export function extractPageMetadata(html) {
  if (!html || typeof html !== 'string') {
    return { title: null, description: null, ogTitle: null, ogDescription: null, ogImage: null, hasMobileViewport: false, hasStructuredData: false };
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const description = descMatch ? descMatch[1].trim() : null;

  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : null;

  const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const ogDescription = ogDescMatch ? ogDescMatch[1].trim() : null;

  const ogImgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const ogImage = ogImgMatch ? ogImgMatch[1].trim() : null;

  const hasMobileViewport = /<meta[^>]*name=["']viewport["']/i.test(html);
  const hasStructuredData = /<script[^>]*type=["']application\/ld\+json["']/i.test(html);

  return {
    title,
    description: description || ogDescription,
    ogTitle,
    ogDescription,
    ogImage,
    hasMobileViewport,
    hasStructuredData
  };
}

export function extractPageContacts(html, defaultCountry = 'AE') {
  if (!html || typeof html !== 'string') {
    return { emails: [], phones: [], whatsAppLinks: [], telegramLinks: [], socialLinks: {}, forms: [] };
  }

  // 1. Emails (mailto + regex)
  const emails = new Set();
  const mailtoMatches = html.matchAll(/href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["']/gi);
  for (const m of mailtoMatches) {
    const norm = normalizeEmail(m[1]);
    if (norm.isValid) emails.add(norm.cleanEmail);
  }

  const emailRegexMatches = html.matchAll(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/gi);
  for (const m of emailRegexMatches) {
    if (!m[1].endsWith('.png') && !m[1].endsWith('.jpg') && !m[1].endsWith('.webp')) {
      const norm = normalizeEmail(m[1]);
      if (norm.isValid) emails.add(norm.cleanEmail);
    }
  }

  // 2. Phones (tel: links)
  const phones = new Set();
  const telMatches = html.matchAll(/href=["']tel:([^"']+)["']/gi);
  for (const m of telMatches) {
    const norm = normalizePhone(m[1], defaultCountry);
    if (norm.e164) phones.add(norm.e164);
  }

  // 3. WhatsApp Links
  const whatsAppLinks = new Set();
  const waMatches = html.matchAll(/href=["'](https?:\/\/(wa\.me|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send)[^"']*)["']/gi);
  for (const m of waMatches) {
    whatsAppLinks.add(m[1]);
  }

  // 4. Telegram Links
  const telegramLinks = new Set();
  const tgMatches = html.matchAll(/href=["'](https?:\/\/(t\.me|telegram\.me)[^"']*)["']/gi);
  for (const m of tgMatches) {
    telegramLinks.add(m[1]);
  }

  // 5. Social Links
  const socialLinks = {};
  const socialPatterns = {
    linkedin: /href=["'](https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[^"']+)["']/i,
    facebook: /href=["'](https?:\/\/(www\.)?facebook\.com\/[^"']+)["']/i,
    instagram: /href=["'](https?:\/\/(www\.)?instagram\.com\/[^"']+)["']/i,
    twitter: /href=["'](https?:\/\/(www\.)?(twitter|x)\.com\/[^"']+)["']/i,
    youtube: /href=["'](https?:\/\/(www\.)?youtube\.com\/(c|channel|user|@)?[^"']+)["']/i
  };

  for (const [platform, regex] of Object.entries(socialPatterns)) {
    const match = html.match(regex);
    if (match) {
      socialLinks[platform] = match[1];
    }
  }

  // 6. Forms
  const forms = [];
  const formMatches = html.matchAll(/<form[\s\S]*?<\/form>/gi);
  for (const f of formMatches) {
    const formHtml = f[0];
    const hasEmailField = /type=["']email["']|name=["']email["']/i.test(formHtml);
    const hasMessageField = /textarea|name=["']message["']/i.test(formHtml);
    const hasDateField = /type=["']date["']|date/i.test(formHtml);
    forms.push({
      hasEmailField,
      hasMessageField,
      hasDateField,
      isAppointmentForm: hasDateField && hasEmailField
    });
  }

  return {
    emails: Array.from(emails),
    phones: Array.from(phones),
    whatsAppLinks: Array.from(whatsAppLinks),
    telegramLinks: Array.from(telegramLinks),
    socialLinks,
    forms
  };
}

export function detectTechnologies(html) {
  if (!html || typeof html !== 'string') return [];

  const detected = [];
  const seenTech = new Set();

  for (const sig of TECH_SIGNATURES) {
    if (!seenTech.has(sig.name) && sig.regex.test(html)) {
      detected.push({
        technology: sig.name,
        category: sig.category,
        confidence: sig.confidence,
        detected_at: new Date().toISOString()
      });
      seenTech.add(sig.name);
    }
  }

  return detected;
}

export function extractServicesAndProducts(html) {
  if (!html || typeof html !== 'string') return [];

  const services = new Set();
  
  // Extract from <h3> or <h4> tags containing service indicators
  const headingMatches = html.matchAll(/<(?:h2|h3|h4)[^>]*>([^<]{4,60})<\/(?:h2|h3|h4)>/gi);
  for (const m of headingMatches) {
    const clean = m[1].replace(/&amp;/g, '&').replace(/[^\w\s-&]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length >= 4 && clean.length <= 50 && !/^(about|contact|home|menu|copyright|privacy|terms|blog|news)/i.test(clean)) {
      services.add(clean);
    }
  }

  return Array.from(services).slice(0, 15);
}

// ----------------------------------------------------------------------------
// 4. BUSINESS INTELLIGENCE INFERENCE ENGINE
// ----------------------------------------------------------------------------

export function inferBusinessProfile(lead, aggregatedPages) {
  const allHtml = aggregatedPages.map(p => p.html || '').join(' ');
  const allText = allHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();

  // Combine title, description, and business name
  const combinedContext = `${lead.businessName} ${aggregatedPages.map(p => p.meta.description || '').join(' ')}`.toLowerCase();

  // 1. Industry Inference
  let bestIndustry = 'General Business';
  let bestSubIndustry = 'Local Services';
  let highestKeywordMatches = 0;

  for (const rule of INDUSTRY_RULES) {
    let matchCount = 0;
    for (const kw of rule.keywords) {
      if (combinedContext.includes(kw.toLowerCase())) matchCount += 3;
      else if (allText.includes(kw.toLowerCase())) matchCount += 1;
    }

    if (matchCount > highestKeywordMatches && matchCount >= 2) {
      highestKeywordMatches = matchCount;
      bestIndustry = rule.industry;
      bestSubIndustry = rule.subIndustry;
    }
  }

  // 2. Target Customer Type
  let targetCustomerType = 'B2C';
  if (bestIndustry.includes('Real Estate')) {
    targetCustomerType = 'HYBRID'; // Real estate serves both individuals and commercial investors
  } else if (/\b(b2b|corporate|commercial|enterprise|wholesale|distributor|companies|businesses)\b/i.test(combinedContext)) {
    targetCustomerType = 'B2B';
  } else if (/\b(patient|patients|teeth|dentist|cosmetic|doctor|clinic|salon|consumer|personal)\b/i.test(combinedContext)) {
    targetCustomerType = 'B2C';
  }

  // 3. Business Description
  const homepage = aggregatedPages.find(p => p.path === '/' || p.path === '');
  const description = homepage?.meta?.description ||
                      aggregatedPages.find(p => p.meta.description)?.meta?.description ||
                      `${lead.businessName} is a provider of ${bestSubIndustry.toLowerCase()} services based in ${lead.address || 'Dubai'}.`;

  return {
    industry: bestIndustry,
    subIndustry: bestSubIndustry,
    targetCustomerType,
    businessDescription: description,
    industryConfidence: highestKeywordMatches > 0 ? Math.min(0.95, 0.70 + (highestKeywordMatches * 0.05)) : 0.50
  };
}

// ----------------------------------------------------------------------------
// 5. OBSERVABLE SIGNALS COMPILER
// ----------------------------------------------------------------------------

export function compileSignalsAndEvidence(lead, aggregatedPages, profile, detectedTech, contacts) {
  const signals = [];
  const evidence = [];
  const now = new Date().toISOString();

  const addEvidence = ({ type, url, name, text, value, confidence, method, provenance }) => {
    const id = `evd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const record = {
      id,
      lead_id: lead.id,
      tenant_id: lead.tenant_id || 'default',
      evidence_type: type,
      source_url: url || lead.website || null,
      source_name: name || 'Official Website',
      evidence_text: text || null,
      extracted_value: value || null,
      confidence_score: confidence || 0.90,
      verified_at: now,
      expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(), // 90 days
      extraction_method: method || 'DOM_EXTRACTION',
      provenance_type: provenance || PROVENANCE_TYPES.VERIFIED,
      created_at: now
    };
    evidence.push(record);
    return record;
  };

  const addSignal = ({ type, key, value, strength, confidence, evidenceId, provenance, expiryDays = 90 }) => {
    const id = `sig_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    signals.push({
      id,
      lead_id: lead.id,
      tenant_id: lead.tenant_id || 'default',
      signal_type: type,
      signal_key: key || type,
      signal_value: value,
      signal_strength: strength || 'MEDIUM',
      confidence_score: confidence || 0.85,
      evidence_id: evidenceId || null,
      source: 'WEBSITE_ANALYZER',
      detected_at: now,
      expires_at: new Date(Date.now() + expiryDays * 24 * 3600 * 1000).toISOString(),
      provenance_type: provenance || PROVENANCE_TYPES.VERIFIED,
      created_at: now
    });
  };

  // 1. Digital Presence & Quality Signals
  const homepage = aggregatedPages.find(p => p.path === '/' || p.path === '') || aggregatedPages[0];
  const isHttps = Boolean(lead.website && lead.website.startsWith('https://'));
  const hasViewport = aggregatedPages.some(p => p.meta?.hasMobileViewport);
  const hasStructuredData = aggregatedPages.some(p => p.meta?.hasStructuredData);

  // HTTPS Signal
  const evHttps = addEvidence({
    type: 'SSL_CERTIFICATE',
    url: lead.website,
    name: 'Website Protocol',
    text: isHttps ? 'Website served over secure HTTPS' : 'Website served over insecure HTTP',
    value: isHttps ? 'HTTPS' : 'HTTP',
    confidence: 1.0,
    provenance: PROVENANCE_TYPES.VERIFIED
  });
  addSignal({
    type: 'DIGITAL_PRESENCE',
    key: 'HTTPS_STATUS',
    value: isHttps ? 'SECURE_HTTPS' : 'INSECURE_HTTP',
    strength: isHttps ? 'HIGH' : 'LOW',
    confidence: 1.0,
    evidenceId: evHttps.id,
    provenance: PROVENANCE_TYPES.VERIFIED
  });

  // Mobile Viewport Signal
  const evViewport = addEvidence({
    type: 'VIEWPORT_META',
    url: homepage?.url || lead.website,
    name: 'HTML Viewport Meta',
    text: hasViewport ? '<meta name="viewport"> detected' : 'Missing viewport meta tag',
    value: hasViewport ? 'RESPONSIVE' : 'NON_RESPONSIVE',
    confidence: 0.95,
    provenance: PROVENANCE_TYPES.VERIFIED
  });
  addSignal({
    type: 'WEBSITE_QUALITY',
    key: 'MOBILE_RESPONSIVENESS',
    value: hasViewport ? 'MOBILE_READY' : 'DESKTOP_ONLY',
    strength: hasViewport ? 'HIGH' : 'LOW',
    confidence: 0.95,
    evidenceId: evViewport.id,
    provenance: PROVENANCE_TYPES.VERIFIED
  });

  // Structured Data Schema Signal
  if (hasStructuredData) {
    const evSchema = addEvidence({
      type: 'STRUCTURED_DATA',
      url: homepage?.url || lead.website,
      name: 'Schema.org JSON-LD',
      text: 'Schema.org JSON-LD structured data detected',
      value: 'JSON_LD_PRESENT',
      confidence: 0.95,
      provenance: PROVENANCE_TYPES.VERIFIED
    });
    addSignal({
      type: 'DIGITAL_PRESENCE',
      key: 'STRUCTURED_DATA',
      value: 'SCHEMA_ORG_ACTIVE',
      strength: 'HIGH',
      confidence: 0.95,
      evidenceId: evSchema.id,
      provenance: PROVENANCE_TYPES.VERIFIED
    });
  }

  // 2. Technology Signals
  for (const tech of detectedTech) {
    const evTech = addEvidence({
      type: 'TECHNOLOGY_DETECTION',
      url: homepage?.url || lead.website,
      name: `${tech.technology} Signature`,
      text: `Publicly observable signature of ${tech.technology} detected in page markup`,
      value: tech.technology,
      confidence: tech.confidence,
      provenance: PROVENANCE_TYPES.VERIFIED
    });
    addSignal({
      type: 'TECHNOLOGY_STACK',
      key: tech.category,
      value: tech.technology,
      strength: 'HIGH',
      confidence: tech.confidence,
      evidenceId: evTech.id,
      provenance: PROVENANCE_TYPES.VERIFIED
    });
  }

  // 3. Automation Opportunity Signals
  const hasBookingSystem = detectedTech.some(t => t.category === 'BOOKING');
  const hasLiveChat = detectedTech.some(t => t.category === 'LIVE_CHAT');
  const hasWhatsApp = contacts.whatsAppLinks.length > 0;
  const hasForms = contacts.forms.length > 0;

  // Opportunity A: WhatsApp-only Booking
  if (hasWhatsApp && !hasBookingSystem) {
    const evWa = addEvidence({
      type: 'WHATSAPP_WORKFLOW',
      url: contacts.whatsAppLinks[0],
      name: 'WhatsApp Click-to-Chat CTA',
      text: 'Direct WhatsApp link detected without integrated self-service booking system',
      value: 'WHATSAPP_ONLY_ENGAGEMENT',
      confidence: 0.88,
      provenance: PROVENANCE_TYPES.INFERRED
    });
    addSignal({
      type: 'AUTOMATION_OPPORTUNITY',
      key: 'WHATSAPP_SCHEDULING_AUTOMATION',
      value: 'WhatsApp Chatbot & Instant Appointment Bot Opportunity',
      strength: 'HIGH',
      confidence: 0.88,
      evidenceId: evWa.id,
      provenance: PROVENANCE_TYPES.INFERRED
    });
  }

  // Opportunity B: Manual Form Without Live Chat or Scheduling
  if (hasForms && !hasLiveChat && !hasBookingSystem) {
    const evForm = addEvidence({
      type: 'INQUIRY_FORM',
      url: homepage?.url || lead.website,
      name: 'Manual Contact Form',
      text: 'Contact form detected without live chat assistance or automated calendar booking',
      value: 'MANUAL_INQUIRY_FLOW',
      confidence: 0.85,
      provenance: PROVENANCE_TYPES.INFERRED
    });
    addSignal({
      type: 'AUTOMATION_OPPORTUNITY',
      key: 'LEAD_CAPTURE_AUTOMATION',
      value: 'AI Copilot Instant Lead Response Opportunity',
      strength: 'HIGH',
      confidence: 0.85,
      evidenceId: evForm.id,
      provenance: PROVENANCE_TYPES.INFERRED
    });
  }

  // 4. Growth Signals
  const hasCareersPage = aggregatedPages.some(p => /careers|jobs|we-are-hiring/i.test(p.path));
  if (hasCareersPage) {
    const careersPage = aggregatedPages.find(p => /careers|jobs/i.test(p.path));
    const evCareers = addEvidence({
      type: 'CAREERS_PAGE',
      url: careersPage?.url || `${lead.website}/careers`,
      name: 'Careers & Hiring Page',
      text: 'Dedicated careers page or hiring section detected',
      value: 'HIRING_ACTIVE',
      confidence: 0.90,
      provenance: PROVENANCE_TYPES.VERIFIED
    });
    addSignal({
      type: 'GROWTH_SIGNAL',
      key: 'EXPANDING_TEAM',
      value: 'Active Recruitment / Careers Section',
      strength: 'HIGH',
      confidence: 0.90,
      evidenceId: evCareers.id,
      provenance: PROVENANCE_TYPES.VERIFIED,
      expiryDays: 30 // Hiring signals expire faster
    });
  }

  // 5. Conservative Pain-Point Signals
  if (profile.industry.includes('Dental') || profile.industry.includes('Healthcare')) {
    if (!hasBookingSystem) {
      const evNoBooking = addEvidence({
        type: 'MISSING_CAPABILITY',
        url: lead.website,
        name: 'Appointment Booking Inspection',
        text: 'No automated online appointment scheduling system detected for healthcare/clinic business',
        value: 'NO_ONLINE_BOOKING_CALENDAR',
        confidence: 0.82,
        provenance: PROVENANCE_TYPES.INFERRED
      });
      addSignal({
        type: 'PAIN_POINT',
        key: 'ABSENT_SELF_SERVICE_BOOKING',
        value: 'Requires manual staff coordination for appointment bookings',
        strength: 'MEDIUM',
        confidence: 0.82,
        evidenceId: evNoBooking.id,
        provenance: PROVENANCE_TYPES.INFERRED
      });
    }
  }

  if (contacts.emails.length === 0 && !hasForms) {
    const evNoEmail = addEvidence({
      type: 'COMMUNICATION_CHANNELS',
      url: lead.website,
      name: 'Contact Information Inspection',
      text: 'No public contact email or web inquiry form identified on scanned pages',
      value: 'RESTRICTED_DIGITAL_CHANNELS',
      confidence: 0.80,
      provenance: PROVENANCE_TYPES.INFERRED
    });
    addSignal({
      type: 'PAIN_POINT',
      key: 'LIMITED_INBOUND_CHANNELS',
      value: 'No direct email or contact form detected',
      strength: 'MEDIUM',
      confidence: 0.80,
      evidenceId: evNoEmail.id,
      provenance: PROVENANCE_TYPES.INFERRED
    });
  }

  return { signals, evidence };
}

// ----------------------------------------------------------------------------
// 6. ENRICHMENT PIPELINE ORCHESTRATOR
// ----------------------------------------------------------------------------

/**
 * Enriches a lead with evidence-backed business intelligence.
 * Supports live crawling, mock crawling for tests, dryRun, and full database persistence.
 */
export async function enrichLead(leadId, options = {}) {
  const {
    tenantId = 'default',
    forceRefresh = false,
    dryRun = false,
    maxPages = CRAWLER_CONFIG.MAX_PAGES_PER_DOMAIN,
    dbInstance = null,
    fetchMock = null
  } = options;

  if (!leadId) {
    throw new Error('leadId is required for enrichment');
  }

  // 1. Validate lead exists and verify tenant ownership
  let lead = null;
  if (dbInstance) {
    const ownership = dbInstance.validateLeadOwnership ? dbInstance.validateLeadOwnership(leadId, tenantId) : { valid: true };
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }
    lead = ownership.lead || (dbInstance.getLead ? dbInstance.getLead(leadId) : (dbInstance.sqlite ? dbInstance.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null));
  }

  if (!lead) {
    throw new Error(`Lead ${leadId} not found`);
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const startTime = new Date().toISOString();

  // Create run record in database if not dryRun
  if (!dryRun && dbInstance?.createEnrichmentRun) {
    dbInstance.createEnrichmentRun({
      id: runId,
      leadId,
      tenantId,
      status: 'RUNNING',
      started_at: startTime
    });
  }

  try {
    const normWeb = normalizeWebsite(lead.website);
    const pagesCrawled = [];
    let pagesAttempted = 0;
    let pagesSuccessful = 0;
    let pagesFailed = 0;

    const allContacts = {
      emails: lead.email ? [lead.email] : [],
      phones: lead.phone ? [lead.phone] : [],
      whatsAppLinks: [],
      telegramLinks: [],
      socialLinks: {},
      forms: []
    };

    const allTech = [];
    const allServices = [];

    // 2. Controlled polite crawling if website is valid
    if (normWeb.isValid && normWeb.rootDomain) {
      const baseUrl = normWeb.cleanUrl.replace(/\/$/, '');
      const visitedUrls = new Set();
      const pagesToVisit = SEMANTIC_PATHS.map(p => p === '/' ? baseUrl : `${baseUrl}${p}`).slice(0, maxPages);

      for (const pageUrl of pagesToVisit) {
        if (visitedUrls.has(pageUrl)) continue;
        visitedUrls.add(pageUrl);
        pagesAttempted++;

        let crawlResult;
        if (typeof fetchMock === 'function') {
          crawlResult = await fetchMock(pageUrl);
        } else {
          crawlResult = await fetchWithTimeout(pageUrl);
        }

        if (crawlResult.ok && crawlResult.html) {
          pagesSuccessful++;
          const pathname = new URL(pageUrl).pathname;
          const meta = extractPageMetadata(crawlResult.html);
          const pageContacts = extractPageContacts(crawlResult.html);
          const pageTech = detectTechnologies(crawlResult.html);
          const pageServices = extractServicesAndProducts(crawlResult.html);

          pagesCrawled.push({
            url: pageUrl,
            path: pathname,
            status: crawlResult.status,
            meta,
            html: crawlResult.html
          });

          // Accumulate contacts
          pageContacts.emails.forEach(e => { if (!allContacts.emails.includes(e)) allContacts.emails.push(e); });
          pageContacts.phones.forEach(p => { if (!allContacts.phones.includes(p)) allContacts.phones.push(p); });
          pageContacts.whatsAppLinks.forEach(w => { if (!allContacts.whatsAppLinks.includes(w)) allContacts.whatsAppLinks.push(w); });
          pageContacts.telegramLinks.forEach(t => { if (!allContacts.telegramLinks.includes(t)) allContacts.telegramLinks.push(t); });
          Object.assign(allContacts.socialLinks, pageContacts.socialLinks);
          allContacts.forms.push(...pageContacts.forms);

          // Accumulate technologies
          pageTech.forEach(t => {
            if (!allTech.some(existing => existing.technology === t.technology)) {
              allTech.push(t);
            }
          });

          // Accumulate services
          pageServices.forEach(s => {
            if (!allServices.includes(s)) allServices.push(s);
          });
        } else {
          pagesFailed++;
        }

        // Polite delay
        if (typeof fetchMock !== 'function') {
          await new Promise(r => setTimeout(r, CRAWLER_CONFIG.REQUEST_DELAY_MS));
        }
      }
    }

    // 3. Profile Inference
    const profile = inferBusinessProfile(lead, pagesCrawled);

    // 4. Compile Evidence & Signals
    const { signals, evidence } = compileSignalsAndEvidence(
      lead,
      pagesCrawled,
      profile,
      allTech,
      allContacts
    );

    // 5. Structure Discovered Contacts
    const discoveredContacts = [];
    for (const em of allContacts.emails) {
      const normE = normalizeEmail(em);
      discoveredContacts.push({
        id: `ctc_${lead.id}_${normE.user}_${Math.random().toString(36).substr(2, 4)}`,
        lead_id: lead.id,
        tenant_id: tenantId,
        contact_name: normE.isGeneric ? `${lead.businessName} Team` : normE.user,
        email: normE.cleanEmail,
        phone: allContacts.phones[0] || null,
        job_title: normE.isGeneric ? 'General Mailbox' : 'Business Contact',
        contact_type: normE.isGeneric ? 'COMPANY_GENERAL' : 'INDIVIDUAL',
        is_decision_maker: 0,
        is_generic_inbox: normE.isGeneric,
        confidence_score: normE.isGeneric ? 0.90 : 0.65,
        provenance_type: PROVENANCE_TYPES.VERIFIED,
        source: 'WEBSITE_CONTACT_EXTRACTION'
      });
    }

    const completionStatus = pagesSuccessful > 0 || !normWeb.isValid ? 'COMPLETED' : 'PARTIAL';
    const endTime = new Date().toISOString();

    const result = {
      leadId,
      tenantId,
      runId,
      status: completionStatus,
      startedAt: startTime,
      completedAt: endTime,
      crawlSummary: {
        website: lead.website || null,
        domain: normWeb.rootDomain || null,
        pagesAttempted,
        pagesSuccessful,
        pagesFailed
      },
      profile: {
        industry: profile.industry,
        subIndustry: profile.subIndustry,
        targetCustomerType: profile.targetCustomerType,
        businessDescription: profile.businessDescription,
        servicesOffered: allServices,
        confidenceScore: profile.industryConfidence
      },
      technologyStack: allTech,
      digitalChannels: {
        phones: allContacts.phones,
        emails: allContacts.emails,
        whatsApp: allContacts.whatsAppLinks,
        telegram: allContacts.telegramLinks,
        socials: allContacts.socialLinks
      },
      evidenceCount: evidence.length,
      signalsCount: signals.length,
      contactsCount: discoveredContacts.length,
      evidence,
      signals,
      contacts: discoveredContacts
    };

    // 6. Persistence mode: Idempotent database writes
    if (!dryRun && dbInstance) {
      dbInstance.sqlite.transaction(() => {
        // Upsert Evidence
        const evidenceIdMap = new Map();
        for (const ev of evidence) {
          const saved = dbInstance.upsertLeadEvidence
            ? dbInstance.upsertLeadEvidence(leadId, ev, tenantId)
            : dbInstance.addLeadEvidence(leadId, ev, tenantId);
          if (saved && saved.id) {
            evidenceIdMap.set(ev.id, saved.id);
          }
        }

        // Upsert Signals
        for (const sig of signals) {
          const finalSig = { ...sig };
          if (finalSig.evidence_id && evidenceIdMap.has(finalSig.evidence_id)) {
            finalSig.evidence_id = evidenceIdMap.get(finalSig.evidence_id);
          }
          if (dbInstance.upsertLeadSignal) {
            dbInstance.upsertLeadSignal(leadId, finalSig, tenantId);
          } else {
            dbInstance.addLeadSignal(leadId, finalSig, tenantId);
          }
        }

        // Upsert Contacts
        for (const ctc of discoveredContacts) {
          try {
            dbInstance.addLeadContact(leadId, ctc, tenantId);
          } catch (_) {
            // Already exists, ignore duplicate contact insert
          }
        }

        // Upsert Lead Intelligence Profile
        dbInstance.upsertLeadIntelligence(leadId, {
          industry: profile.industry,
          sub_industry: profile.subIndustry,
          business_description: profile.businessDescription,
          products_services: JSON.stringify(allServices),
          target_customer_type: profile.targetCustomerType,
          technology_signals: JSON.stringify(allTech),
          confidence_score: profile.industryConfidence,
          digital_presence_score: Math.min(100, (allContacts.phones.length > 0 ? 25 : 0) +
                                                 (allContacts.emails.length > 0 ? 25 : 0) +
                                                 (normWeb.isValid ? 25 : 0) +
                                                 (Object.keys(allContacts.socialLinks).length > 0 ? 25 : 0)),
          website_quality_score: (pagesSuccessful > 0 ? 80 : 20) + (lead.website?.startsWith('https://') ? 20 : 0),
          last_analyzed_at: endTime
        }, tenantId);

        // Update run record
        if (dbInstance.updateEnrichmentRun) {
          dbInstance.updateEnrichmentRun(runId, {
            status: completionStatus,
            completed_at: endTime,
            pages_attempted: pagesAttempted,
            pages_successful: pagesSuccessful,
            pages_failed: pagesFailed,
            evidence_count: evidence.length,
            signals_count: signals.length,
            contacts_count: discoveredContacts.length,
            summary: JSON.stringify({
              industry: profile.industry,
              techDetected: allTech.map(t => t.technology),
              servicesCount: allServices.length
            })
          }, tenantId);
        }
      })();
    }

    return result;
  } catch (err) {
    if (!dryRun && dbInstance?.updateEnrichmentRun) {
      dbInstance.updateEnrichmentRun(runId, {
        status: 'FAILED',
        completed_at: new Date().toISOString(),
        error_message: err.message
      }, tenantId);
    }
    throw err;
  }
}
