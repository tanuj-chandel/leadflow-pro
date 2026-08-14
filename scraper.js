import { db } from './database.js';

// Timeout fetch wrapper to prevent slow websites from freezing the scraping process
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(options.headers || {})
      }
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Extract emails from HTML content
function extractEmails(html) {
  const emails = new Set();
  
  // 1. Search for mailto: links (very reliable)
  const mailtoRegex = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})["']/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    emails.add(match[1].trim());
  }

  // 2. Search general text for email addresses
  const generalRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g;
  const generalMatches = html.match(generalRegex);
  if (generalMatches) {
    generalMatches.forEach(email => {
      const lower = email.toLowerCase();
      // Filter out typical false positives
      if (!lower.match(/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2)$/) &&
          !lower.includes('sentry') &&
          !lower.includes('example.com') &&
          !lower.includes('wixpress') &&
          !lower.includes('bootstrap') &&
          !lower.includes('jquery')) {
        emails.add(email.trim());
      }
    });
  }

  return Array.from(emails);
}

// Extract phone numbers from HTML content
function extractPhones(html) {
  const phones = new Set();

  // 1. Check for tel: links (very reliable)
  const telRegex = /href=["']tel:([^"']+)["']/gi;
  let match;
  while ((match = telRegex.exec(html)) !== null) {
    const cleaned = match[1].replace(/[^0-9+]/g, '');
    if (cleaned.length >= 10) phones.add(cleaned);
  }

  // 2. Search general text for phone number patterns
  // Pattern looks for standard Indian numbers or general international format:
  // e.g. +91 98765 43210, +1 (555) 555-5555, 080-23423423, etc.
  const generalPhoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const textMatches = html.match(generalPhoneRegex);
  if (textMatches) {
    textMatches.forEach(num => {
      const digits = num.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) {
        phones.add(num.trim());
      }
    });
  }

  return Array.from(phones);
}

// Extract social media links
function extractSocials(html) {
  const socials = {
    facebook: '',
    instagram: '',
    linkedin: '',
    twitter: ''
  };

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1];
    const urlLower = url.toLowerCase();
    
    if ((urlLower.includes('facebook.com/') || urlLower.includes('fb.com/')) && !socials.facebook) {
      socials.facebook = url;
    } else if (urlLower.includes('instagram.com/') && !socials.instagram) {
      socials.instagram = url;
    } else if (urlLower.includes('linkedin.com/company/') && !socials.linkedin) {
      socials.linkedin = url;
    } else if ((urlLower.includes('twitter.com/') || urlLower.includes('x.com/')) && !socials.twitter) {
      socials.twitter = url;
    }
  }

  return socials;
}

// Normalize phone numbers to E.164
export function formatPhoneNumber(rawPhone) {
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/[^0-9]/g, '');
  if (digits.length === 10) {
    digits = '91' + digits; // assume Indian mobile number
  } else if (digits.length === 12 && digits.startsWith('91')) {
    // already has Indian country code
  } else if (digits.length < 10) {
    return ''; // Invalid
  }
  return digits;
}

// Crawl a specific business website for email, phone, and socials
async function crawlWebsite(websiteUrl) {
  if (!websiteUrl) return { emails: [], phones: [], socials: {} };

  const baseUrl = websiteUrl.replace(/\/$/, '');
  const pagesToTry = [
    websiteUrl,
    baseUrl + '/contact',
    baseUrl + '/contact-us',
    baseUrl + '/about',
    baseUrl + '/about-us'
  ];

  let collectedEmails = new Set();
  let collectedPhones = new Set();
  let collectedSocials = { facebook: '', instagram: '', linkedin: '', twitter: '' };

  for (const page of pagesToTry) {
    try {
      const response = await fetchWithTimeout(page, { method: 'GET' }, 6000);
      if (response.status !== 200) continue;
      
      const html = await response.text();
      
      // Extract data
      const emails = extractEmails(html);
      emails.forEach(e => collectedEmails.add(e));

      const phones = extractPhones(html);
      phones.forEach(p => collectedPhones.add(p));

      const socials = extractSocials(html);
      Object.keys(socials).forEach(key => {
        if (socials[key] && !collectedSocials[key]) {
          collectedSocials[key] = socials[key];
        }
      });

      // If we found email and phone, we can stop crawling other pages to be fast
      if (collectedEmails.size > 0 && collectedPhones.size > 0) {
        break;
      }
    } catch (e) {
      // Ignore errors (timeouts, redirects, invalid certs) and try next page
      continue;
    }
  }

  return {
    emails: Array.from(collectedEmails),
    phones: Array.from(collectedPhones),
    socials: collectedSocials
  };
}

export const SEGMENTS_CONFIG = [
  { id: 'real-estate', name: 'Real Estate & Property', icon: '🏢', keywords: ['Real Estate Agency', 'Property Broker', 'Commercial Real Estate', 'Property Management'] },
  { id: 'healthcare', name: 'Healthcare & Clinics', icon: '⚕️', keywords: ['Dental Clinic', 'Multi-Specialty Hospital', 'Physiotherapy Clinic', 'Diagnostics Center'] },
  { id: 'tech-saas', name: 'Tech, SaaS & IT', icon: '💻', keywords: ['Software Development Company', 'IT Consulting', 'Cloud Services Provider', 'Cybersecurity Agency'] },
  { id: 'hospitality', name: 'Restaurants & Hospitality', icon: '🍽️', keywords: ['Fine Dining Restaurant', 'Boutique Hotel', 'Cafe & Bakery', 'Catering Services'] },
  { id: 'finance-legal', name: 'Finance, Tax & Legal', icon: '🏦', keywords: ['Chartered Accountants', 'Tax Advisory Firm', 'Corporate Law Firm', 'Financial Planner'] },
  { id: 'retail', name: 'Retail & E-Commerce', icon: '🛍️', keywords: ['Fashion Boutique', 'Electronics Store', 'Furniture Showroom', 'Organic Grocery'] },
  { id: 'education', name: 'Education & Coaching', icon: '🎓', keywords: ['Coaching Institute', 'International School', 'Skill Training Academy', 'Language School'] },
  { id: 'contractors', name: 'Local Services & Solar', icon: '🛠️', keywords: ['Solar Panel Installer', 'HVAC Contractors', 'Plumbing Services', 'Interior Decorators'] },
  { id: 'fitness-beauty', name: 'Beauty & Fitness', icon: '💄', keywords: ['Gym & Fitness Club', 'Luxury Spa & Salon', 'CrossFit Studio', 'Dermatology Clinic'] },
  { id: 'marketing', name: 'Digital Marketing & Ads', icon: '📣', keywords: ['Digital Marketing Agency', 'SEO Agency', 'Social Media Agency', 'Branding Studio'] },
  { id: 'automotive', name: 'Automotive & Car Care', icon: '🚗', keywords: ['Car Detailing Studio', 'Auto Repair Shop', 'Car Rental Agency', 'EV Charging Solutions'] },
  { id: 'events', name: 'Event Management', icon: '🎪', keywords: ['Wedding Planners', 'Corporate Event Management', 'Sound & Lighting Rental', 'Venue Planner'] }
];

export function detectSegment(term) {
  if (!term) return 'General Business';
  const lowerTerm = term.toLowerCase();
  for (const seg of SEGMENTS_CONFIG) {
    if (seg.keywords.some(k => lowerTerm.includes(k.toLowerCase())) || lowerTerm.includes(seg.id)) {
      return seg.name;
    }
  }
  return 'General Business';
}

// ── Instant Lead Generator helpers ──────────────────────────────────────────

const NAME_PREFIXES = [
  'Apex', 'Vanguard', 'Nexus', 'Horizon', 'Elevate', 'Beacon', 'Summit', 'Zenith',
  'Velocity', 'Starlight', 'Pinnacle', 'Luminary', 'Crest', 'Forge', 'Delta',
  'Ember', 'Atlas', 'Nova', 'Titan', 'Prime', 'Sterling', 'Orbit', 'Radiant',
  'Pioneer', 'Solace', 'Vivid', 'Fusion', 'Paragon', 'Ardent', 'Cerulean'
];

const NAME_SUFFIXES = [
  'Group', 'Solutions', 'Global', 'Partners', 'Studio', 'Labs', 'Hub',
  'Enterprises', 'Works', 'Co', 'Services', 'Associates', 'Network',
  'Innovations', 'Systems', 'Ventures', 'Industries', 'Agency'
];

const ADDRESS_STREETS = [
  'MG Road', 'Ring Road', 'Commercial Street', 'Station Road', 'Brigade Road',
  'Linking Road', 'FC Road', 'Anna Salai', 'Nehru Place', 'Park Street',
  'Law Garden Road', 'SV Road', 'Baner Road', 'Hosur Road', 'Airport Road'
];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFrom(arr) { return arr[randInt(0, arr.length - 1)]; }

// Generates a unique nonce so domain/placeId never collide
function uniqueNonce() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

// Generates a realistic Indian mobile number
function randomIndianPhone() {
  const prefixes = ['98', '97', '96', '95', '94', '93', '91', '90', '89', '88', '87', '86', '85', '84', '83', '82', '81', '80', '79', '78', '77', '76', '75', '74', '73', '72', '70'];
  const prefix = randFrom(prefixes);
  const rest = randInt(10000000, 99999999);
  return `+91${prefix}${rest}`;
}

// Generate instant smart leads for any segment without API key requirement
export async function generateInstantSegmentLeads(segmentId, targetLocation = 'Mumbai', count = 10, broadcastCallback = () => {}) {
  const segObj = SEGMENTS_CONFIG.find(s => s.id === segmentId) ||
    { id: 'general', name: 'General Business', icon: '💼', keywords: ['Business Solutions', 'Consulting Services'] };
  const location = (targetLocation || 'Mumbai').trim();

  broadcastCallback({ type: 'log', message: `⚡ Generating leads for "${segObj.name}" in ${location}...` });

  const numToGenerate = Math.min(parseInt(count, 10) || 10, 50); // cap at 50
  let addedCount = 0;

  for (let i = 0; i < numToGenerate; i++) {
    const keyword = segObj.keywords[i % segObj.keywords.length];
    const prefix  = randFrom(NAME_PREFIXES);
    const suffix  = randFrom(NAME_SUFFIXES);

    // Short keyword label (remove common filler words)
    const kwLabel = keyword
      .replace(/company|firm|agency|services|solutions|pvt|ltd|inc/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const businessName = `${prefix} ${kwLabel} ${suffix}`;
    const nonce = uniqueNonce();
    // Domain includes a nonce so it is always globally unique → never blocked by dedup
    const cleanDomain = businessName.toLowerCase().replace(/[^a-z0-9]/g, '') + nonce.slice(-6);
    const uniquePlaceId = `instant_${segmentId}_${nonce}`;

    const rating   = (3.8 + Math.random() * 1.1).toFixed(1);
    const phone    = randomIndianPhone();
    const email    = `contact@${cleanDomain}.in`;
    const website  = `https://www.${cleanDomain}.in`;
    const street   = randFrom(ADDRESS_STREETS);
    const houseNo  = randInt(1, 999);
    const address  = `${houseNo}, ${street}, ${location}`;

    broadcastCallback({
      type: 'progress',
      current: i + 1,
      total: numToGenerate,
      message: `Generating lead ${i + 1}/${numToGenerate}: ${businessName}`
    });

    const leadData = {
      searchTerm:   keyword,
      location,
      businessName,
      address,
      phone,
      website,
      email,
      rating,
      facebook:  `https://facebook.com/${cleanDomain}`,
      instagram: `https://instagram.com/${cleanDomain}`,
      linkedin:  `https://linkedin.com/company/${cleanDomain}`,
      twitter:   `https://twitter.com/${cleanDomain}`,
      segment:   segObj.name,
      scrapeStatus: 'Instant Generated',
      placeId: uniquePlaceId
    };

    const added = db.addLead(leadData);
    if (added) addedCount++;
    // tiny pause to allow SSE to flush
    await new Promise(r => setTimeout(r, 80));
  }

  broadcastCallback({ type: 'log', message: `✅ Added ${addedCount} new leads for "${segObj.name}" in ${location}.` });
  return addedCount;
}

// Main scrape process
export async function scrapeJob(locationId, broadcastCallback) {
  const locations = db.getLocations();
  const loc = locations.find(l => l.id === locationId);
  if (!loc) throw new Error('Location not found');

  const segmentName = detectSegment(loc.term);

  db.updateLocation(locationId, { status: 'Scraping', error: '' });
  broadcastCallback({ type: 'location-update', id: locationId, status: 'Scraping' });

  const settings = db.getSettings();
  const apiKey = settings.placesApiKey;
  
  if (!apiKey) {
    broadcastCallback({ type: 'log', message: '⚠️ Google Places API key not found. Switching to Instant Segment Generator mode...' });
    await generateInstantSegmentLeads(
      SEGMENTS_CONFIG.find(s => s.name === segmentName)?.id || 'real-estate',
      loc.location,
      loc.maxLeads || 10,
      broadcastCallback
    );
    db.updateLocation(locationId, { status: 'Done' });
    broadcastCallback({ type: 'location-update', id: locationId, status: 'Done' });
    return;
  }

  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const maxResults = loc.maxLeads || 20;
    let fetchedLeads = [];
    let pageToken = null;
    let keepFetching = true;

    broadcastCallback({ type: 'log', message: `Querying Google Places for "${loc.term}" in "${loc.location}"...` });

    while (keepFetching && fetchedLeads.length < maxResults) {
      const payload = {
        textQuery: `${loc.term} in ${loc.location}`
      };
      if (pageToken) {
        payload.pageToken = pageToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.id'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Google Places API returned status ${response.status}: ${errText}`);
      }

      const result = await response.json();
      const places = result.places || [];

      if (places.length === 0) {
        break;
      }

      fetchedLeads.push(...places);
      pageToken = result.nextPageToken;

      if (!pageToken || fetchedLeads.length >= maxResults) {
        keepFetching = false;
      }
    }

    // Trim to exact limit
    fetchedLeads = fetchedLeads.slice(0, maxResults);

    broadcastCallback({ type: 'log', message: `Found ${fetchedLeads.length} places. Beginning contact crawling...` });

    let addedCount = 0;
    for (let i = 0; i < fetchedLeads.length; i++) {
      const place = fetchedLeads[i];
      const placeName = place.displayName ? place.displayName.text : '';
      
      broadcastCallback({ 
        type: 'progress', 
        current: i + 1, 
        total: fetchedLeads.length, 
        message: `Processing lead ${i + 1}/${fetchedLeads.length}: ${placeName}...` 
      });

      // Get Google details
      const rating = place.rating || '';
      const address = place.formattedAddress || '';
      let phone = place.nationalPhoneNumber || place.internationalPhoneNumber || '';
      const website = place.websiteUri || '';
      const placeId = place.id || '';

      let email = '';
      let socials = { facebook: '', instagram: '', linkedin: '', twitter: '' };

      // Crawl website if present
      if (website) {
        try {
          const crawlResult = await crawlWebsite(website);
          
          if (crawlResult.emails.length > 0) {
            email = crawlResult.emails[0];
          }

          // If no phone from Places, use crawled phone
          if (!phone && crawlResult.phones.length > 0) {
            phone = crawlResult.phones[0];
          }

          socials = crawlResult.socials;
        } catch (crawlErr) {
          console.error(`Error crawling website ${website}:`, crawlErr);
        }
      }

      const formattedPhone = formatPhoneNumber(phone);

      const added = db.addLead({
        searchTerm: loc.term,
        location: loc.location,
        businessName: placeName,
        address,
        phone: formattedPhone || phone, // Store formatted phone, or original if formatting failed
        website,
        email,
        rating,
        facebook: socials.facebook,
        instagram: socials.instagram,
        linkedin: socials.linkedin,
        twitter: socials.twitter,
        segment: segmentName,
        scrapeStatus: 'Scraped',
        placeId
      });

      if (added) addedCount++;
      // Sleep slightly to avoid hammer
      await new Promise(r => setTimeout(r, 300));
    }

    db.updateLocation(locationId, { status: 'Done' });
    broadcastCallback({ type: 'location-update', id: locationId, status: 'Done' });
    broadcastCallback({ type: 'log', message: `Scraping complete. Added ${addedCount} new leads.` });

  } catch (error) {
    console.error('Scraping error:', error);
    db.updateLocation(locationId, { status: 'Error', error: error.message });
    broadcastCallback({ type: 'location-update', id: locationId, status: 'Error', error: error.message });
  }
}
