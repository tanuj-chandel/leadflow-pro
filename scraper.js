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

// Main scrape process
export async function scrapeJob(locationId, broadcastCallback) {
  const locations = db.getLocations();
  const loc = locations.find(l => l.id === locationId);
  if (!loc) throw new Error('Location not found');

  db.updateLocation(locationId, { status: 'Scraping', error: '' });
  broadcastCallback({ type: 'location-update', id: locationId, status: 'Scraping' });

  const settings = db.getSettings();
  const apiKey = settings.placesApiKey;
  if (!apiKey) {
    const errorMsg = 'Google Places API Key is missing. Add it in settings.';
    db.updateLocation(locationId, { status: 'Error', error: errorMsg });
    broadcastCallback({ type: 'location-update', id: locationId, status: 'Error', error: errorMsg });
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
