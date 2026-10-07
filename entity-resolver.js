/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 2: BUSINESS ENTITY RESOLVER
 * ============================================================================
 * Deterministic Business Entity & Contact Resolution Layer.
 *
 * Responsibilities:
 * 1. Normalization of Business Name, Phone (E.164), Website, Email, and Address.
 * 2. Deterministic Entity Matching Engine with explicit confidence scoring.
 * 3. Multi-Location vs. Duplicate differentiation.
 * 4. Contact Resolution & Deterministic Decision-Maker classification.
 * 5. Safe Relational Grouping (Zero destructive mutations on source leads).
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

// ----------------------------------------------------------------------------
// 1. CONSTANTS & DEFINITIONS
// ----------------------------------------------------------------------------

export const ENTITY_TYPES = {
  SINGLE_LOCATION: 'SINGLE_LOCATION',
  MULTI_LOCATION: 'MULTI_LOCATION',
  FRANCHISE: 'FRANCHISE',
  CORPORATE_PARENT: 'CORPORATE_PARENT',
  UNKNOWN: 'UNKNOWN'
};

export const MEMBER_ROLES = {
  CANONICAL: 'CANONICAL',
  DUPLICATE: 'DUPLICATE',
  RELATED_LOCATION: 'RELATED_LOCATION',
  POSSIBLE_DUPLICATE: 'POSSIBLE_DUPLICATE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED'
};

export const MATCH_LEVELS = {
  EXACT_MATCH: 'EXACT_MATCH',
  HIGH_CONFIDENCE_MATCH: 'HIGH_CONFIDENCE_MATCH',
  POSSIBLE_MATCH: 'POSSIBLE_MATCH',
  NO_MATCH: 'NO_MATCH',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA'
};

const GENERIC_EMAIL_PREFIXES = new Set([
  'info', 'enquiry', 'enquiries', 'contact', 'contactus', 'sales', 'support',
  'admin', 'administrator', 'help', 'helpdesk', 'office', 'booking', 'bookings',
  'frontdesk', 'reception', 'property', 'billing', 'accounts', 'marketing',
  'hello', 'care', 'customercare', 'team', 'service', 'services', 'mail', 'inbox'
]);

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'aol.com', 'zoho.com', 'mail.com', 'protonmail.com'
]);

const LEGAL_SUFFIX_REGEX = /\b(llc|l\.l\.c\.|l\.l\.c|fz-llc|fz llc|fzc|fze|ltd|limited|inc|incorporated|corp|corporation|co|co\.|pvt ltd|private limited|pvt|est|establishment|branch|group)\b/gi;

const LOCATION_NOISE_REGEX = /\b(dubai|uae|united arab emirates|abu dhabi|sharjah|ajman|al ain|karama|satwa|jumeirah|burjuman|deira|marina|downtown|business bay|me'aisem|production city|al wasl|umm suqeim)\b/gi;

const DECISION_MAKER_KEYWORDS = [
  'owner', 'co-founder', 'founder', 'ceo', 'managing director', 'director',
  'managing partner', 'partner', 'principal dentist', 'chief surgeon',
  'chief executive', 'general manager', 'president', 'vp', 'vice president',
  'head of', 'chief operating officer', 'coo', 'chief technology officer', 'cto'
];

const NON_DECISION_MAKER_KEYWORDS = [
  'receptionist', 'secretary', 'assistant', 'intern', 'support agent',
  'coordinator', 'clerk', 'cashier', 'call center', 'operator'
];

// ----------------------------------------------------------------------------
// 2. NORMALIZATION UTILITIES
// ----------------------------------------------------------------------------

/**
 * Normalizes a business name by removing punctuation, legal suffixes,
 * and producing both a canonical normalized string and a root brand name.
 */
export function normalizeBusinessName(name) {
  if (!name || typeof name !== 'string') {
    return { normalizedName: '', rootBrandName: '', legalSuffixes: [] };
  }

  const trimmed = name.trim().toLowerCase();
  
  // Extract legal suffixes
  const matches = trimmed.match(LEGAL_SUFFIX_REGEX) || [];
  const legalSuffixes = Array.from(new Set(matches.map(s => s.replace(/\./g, '').trim())));

  // Remove legal suffixes
  let cleaned = trimmed.replace(LEGAL_SUFFIX_REGEX, ' ');
  
  // Normalize punctuation and whitespace
  cleaned = cleaned.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  const normalizedName = cleaned;

  // Extract root brand by removing common geographic qualifiers
  let rootBrand = cleaned.replace(LOCATION_NOISE_REGEX, ' ').replace(/\s+/g, ' ').trim();
  if (!rootBrand || rootBrand.length < 2) {
    rootBrand = normalizedName;
  }

  return {
    normalizedName,
    rootBrandName: rootBrand,
    legalSuffixes
  };
}

/**
 * Normalizes phone numbers to standard E.164 using libphonenumber-js.
 */
export function normalizePhone(phone, defaultCountry = 'AE') {
  if (!phone || typeof phone !== 'string') {
    return { raw: phone || '', e164: null, country: null, isValid: false };
  }

  const clean = phone.trim();
  try {
    const parsed = parsePhoneNumberFromString(clean, defaultCountry);
    if (parsed && parsed.isValid()) {
      return {
        raw: clean,
        e164: parsed.format('E.164'),
        country: parsed.country || defaultCountry,
        nationalNumber: parsed.nationalNumber,
        isValid: true
      };
    }
  } catch {
    // Fall back to clean numeric string with + if valid length
  }

  // Graceful fallback for non-standard digits
  const digits = clean.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15) {
    const e164 = clean.startsWith('+') ? `+${digits}` : (digits.startsWith('971') ? `+${digits}` : `+971${digits.replace(/^0/, '')}`);
    return { raw: clean, e164, country: defaultCountry, isValid: false };
  }

  return { raw: clean, e164: null, country: null, isValid: false };
}

/**
 * Normalizes a website URL: removes tracking parameters, hashes, www,
 * trailing slashes, and extracts registrable domain.
 */
export function normalizeWebsite(url) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { raw: url || '', cleanUrl: null, domain: null, rootDomain: null, isValid: false };
  }

  const raw = url.trim();
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
    
    // Extract root domain (support .ae, .com, .com.ae, .co.uk, etc.)
    const parts = domain.split('.');
    let rootDomain = domain;
    if (parts.length > 2) {
      const secondLevelTlds = new Set(['com', 'org', 'net', 'co', 'ac', 'gov', 'edu']);
      if (secondLevelTlds.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
        rootDomain = parts.slice(-3).join('.');
      } else {
        rootDomain = parts.slice(-2).join('.');
      }
    }

    // Build clean URL without search params or hash
    const cleanUrl = `${parsed.protocol}//${domain}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`;

    return {
      raw,
      cleanUrl,
      domain,
      rootDomain,
      isValid: true
    };
  } catch {
    return { raw, cleanUrl: null, domain: null, rootDomain: null, isValid: false };
  }
}

/**
 * Normalizes an email address: lowercases, trims, and determines if it is a generic inbox.
 */
export function normalizeEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { raw: email || '', cleanEmail: null, domain: null, isGeneric: false, isPublicProvider: false, isValid: false };
  }

  const clean = email.trim().toLowerCase();
  const [user, domain] = clean.split('@');
  if (!user || !domain || !domain.includes('.')) {
    return { raw: email, cleanEmail: null, domain: null, isGeneric: false, isPublicProvider: false, isValid: false };
  }

  // Strip alias (e.g. user+tag@domain.com)
  const baseUser = user.split('+')[0];
  const isGeneric = GENERIC_EMAIL_PREFIXES.has(baseUser);
  const isPublicProvider = PUBLIC_EMAIL_DOMAINS.has(domain);

  return {
    raw: email,
    cleanEmail: `${baseUser}@${domain}`,
    user: baseUser,
    domain,
    isGeneric,
    isPublicProvider,
    isValid: true
  };
}

/**
 * Normalizes physical address tokens.
 */
export function normalizeAddress(address) {
  if (!address || typeof address !== 'string') {
    return { raw: address || '', cleanAddress: '', city: null, emirate: null, tokens: [] };
  }

  const clean = address.trim().toLowerCase().replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ');
  const tokens = clean.split(' ').filter(t => t.length > 1);

  let emirate = null;
  if (/dubai|دبي/.test(clean)) emirate = 'Dubai';
  else if (/abu dhabi|أبو ظبي/.test(clean)) emirate = 'Abu Dhabi';
  else if (/sharjah|الشارقة/.test(clean)) emirate = 'Sharjah';
  else if (/ajman|عجمان/.test(clean)) emirate = 'Ajman';
  else if (/ras al khaimah|رأس الخيمة/.test(clean)) emirate = 'Ras Al Khaimah';

  return {
    raw: address,
    cleanAddress: clean,
    city: emirate,
    emirate,
    tokens
  };
}

// ----------------------------------------------------------------------------
// 3. DETERMINISTIC STRING SIMILARITY ALGORITHMS
// ----------------------------------------------------------------------------

/**
 * Computes Jaro-Winkler similarity between two strings (0.0 to 1.0).
 */
export function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const str1 = s1.toLowerCase();
  const str2 = s2.toLowerCase();

  const len1 = str1.length;
  const len2 = str2.length;
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;

  const str1Matches = new Array(len1).fill(false);
  const str2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (str2Matches[j]) continue;
      if (str1[i] !== str2[j]) continue;
      str1Matches[i] = true;
      str2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!str1Matches[i]) continue;
    while (!str2Matches[k]) k++;
    if (str1[i] !== str2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix scaling (max 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (str1[i] === str2[i]) prefix++;
    else break;
  }

  return Math.min(1.0, jaro + prefix * 0.1 * (1 - jaro));
}

/**
 * Token set overlap / Jaccard similarity for multi-word business names.
 */
export function tokenSetSimilarity(str1, str2) {
  if (!str1 || !str2) return 0.0;
  const tokens1 = new Set(str1.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  const tokens2 = new Set(str2.toLowerCase().split(/\s+/).filter(t => t.length > 1));

  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  return union > 0 ? intersection / union : 0.0;
}

// ----------------------------------------------------------------------------
// 4. ENTITY MATCH EVALUATION ENGINE
// ----------------------------------------------------------------------------

/**
 * Evaluates the match relationship between two lead records.
 * Returns a structured decision with matchLevel, confidence, relationType, and reasons.
 */
export function evaluateLeadMatch(leadA, leadB) {
  if (!leadA || !leadB) {
    return {
      matchLevel: MATCH_LEVELS.INSUFFICIENT_DATA,
      confidence: 0.0,
      relationType: MEMBER_ROLES.REVIEW_REQUIRED,
      reasons: ['One or both lead records are null or undefined'],
      signals: {}
    };
  }

  // 1. Same ID Check
  if (leadA.id === leadB.id) {
    return {
      matchLevel: MATCH_LEVELS.EXACT_MATCH,
      confidence: 1.0,
      relationType: MEMBER_ROLES.CANONICAL,
      reasons: ['Identical Lead ID'],
      signals: { sameLeadId: true }
    };
  }

  // 2. Normalize components
  const normA = {
    name: normalizeBusinessName(leadA.businessName),
    phone: normalizePhone(leadA.phone),
    web: normalizeWebsite(leadA.website),
    email: normalizeEmail(leadA.email),
    addr: normalizeAddress(leadA.address || leadA.location),
    placeId: leadA.placeId || null
  };

  const normB = {
    name: normalizeBusinessName(leadB.businessName),
    phone: normalizePhone(leadB.phone),
    web: normalizeWebsite(leadB.website),
    email: normalizeEmail(leadB.email),
    addr: normalizeAddress(leadB.address || leadB.location),
    placeId: leadB.placeId || null
  };

  // Signals
  const placeIdMatch = Boolean(normA.placeId && normB.placeId && normA.placeId === normB.placeId);
  const phoneMatch = Boolean(normA.phone.e164 && normB.phone.e164 && normA.phone.e164 === normB.phone.e164);
  
  // Non-public corporate domain match
  const validDomainA = normA.web.rootDomain || (!normA.email.isPublicProvider ? normA.email.domain : null);
  const validDomainB = normB.web.rootDomain || (!normB.email.isPublicProvider ? normB.email.domain : null);
  const domainMatch = Boolean(validDomainA && validDomainB && validDomainA.toLowerCase() === validDomainB.toLowerCase());

  const emailMatch = Boolean(normA.email.cleanEmail && normB.email.cleanEmail && normA.email.cleanEmail === normB.email.cleanEmail);

  // String similarities
  const nameJaro = jaroWinkler(normA.name.normalizedName, normB.name.normalizedName);
  const brandJaro = jaroWinkler(normA.name.rootBrandName, normB.name.rootBrandName);
  const tokenSim = tokenSetSimilarity(normA.name.normalizedName, normB.name.normalizedName);
  const nameSimilarity = Math.max(nameJaro, (nameJaro + tokenSim) / 2);

  // Address similarity
  const addrSim = tokenSetSimilarity(normA.addr.cleanAddress, normB.addr.cleanAddress);
  const sameAddress = addrSim >= 0.85;

  const signals = {
    placeIdMatch,
    phoneMatch,
    domainMatch,
    emailMatch,
    nameSimilarity,
    brandJaro,
    addrSim,
    sameAddress,
    sharedDomain: domainMatch ? validDomainA : null
  };

  // --------------------------------------------------------------------------
  // DETERMINISTIC CLASSIFICATION RULES
  // --------------------------------------------------------------------------

  // Rule 1: Identical Google Place ID -> EXACT_MATCH
  if (placeIdMatch) {
    return {
      matchLevel: MATCH_LEVELS.EXACT_MATCH,
      confidence: 1.0,
      relationType: sameAddress ? MEMBER_ROLES.DUPLICATE : MEMBER_ROLES.RELATED_LOCATION,
      reasons: ['Identical Google Place ID confirmed'],
      signals
    };
  }

  // Rule 2: Same corporate domain AND matching brand name
  if (domainMatch && (brandJaro >= 0.80 || nameSimilarity >= 0.80)) {
    // Check if it's a multi-location entity or duplicate
    if (!sameAddress || (normA.phone.e164 && normB.phone.e164 && normA.phone.e164 !== normB.phone.e164)) {
      return {
        matchLevel: MATCH_LEVELS.HIGH_CONFIDENCE_MATCH,
        confidence: 0.94,
        relationType: MEMBER_ROLES.RELATED_LOCATION,
        reasons: [
          `Identical corporate domain (${validDomainA}) with brand match (${(brandJaro * 100).toFixed(0)}%) across distinct locations/phones`
        ],
        signals
      };
    } else {
      return {
        matchLevel: MATCH_LEVELS.EXACT_MATCH,
        confidence: 0.98,
        relationType: MEMBER_ROLES.DUPLICATE,
        reasons: [`Identical corporate domain (${validDomainA}), matching brand, and matching physical location`],
        signals
      };
    }
  }

  // Rule 3: Same verified phone AND matching brand name
  if (phoneMatch && (brandJaro >= 0.80 || nameSimilarity >= 0.80)) {
    if (!sameAddress) {
      return {
        matchLevel: MATCH_LEVELS.HIGH_CONFIDENCE_MATCH,
        confidence: 0.91,
        relationType: MEMBER_ROLES.RELATED_LOCATION,
        reasons: [
          `Identical phone (${normA.phone.e164}) and matching brand (${(brandJaro * 100).toFixed(0)}%) across distinct clinic/branch addresses`
        ],
        signals
      };
    } else {
      return {
        matchLevel: MATCH_LEVELS.EXACT_MATCH,
        confidence: 0.96,
        relationType: MEMBER_ROLES.DUPLICATE,
        reasons: [`Identical phone (${normA.phone.e164}), matching brand, and matching physical address`],
        signals
      };
    }
  }

  // Rule 4: Same corporate domain, differing brand name (Corporate Parent or Franchise)
  if (domainMatch && !PUBLIC_EMAIL_DOMAINS.has(validDomainA)) {
    return {
      matchLevel: MATCH_LEVELS.POSSIBLE_MATCH,
      confidence: 0.75,
      relationType: MEMBER_ROLES.REVIEW_REQUIRED,
      reasons: [`Shared corporate domain (${validDomainA}) but differing brand names require human verification`],
      signals
    };
  }

  // Rule 5: High brand name similarity without phone or domain corroboration
  if (brandJaro >= 0.88 && normA.addr.emirate && normB.addr.emirate && normA.addr.emirate === normB.addr.emirate) {
    return {
      matchLevel: MATCH_LEVELS.POSSIBLE_MATCH,
      confidence: 0.65,
      relationType: MEMBER_ROLES.POSSIBLE_DUPLICATE,
      reasons: [
        `High brand similarity (${(brandJaro * 100).toFixed(0)}%) in same region (${normA.addr.emirate}) without shared domain or phone`
      ],
      signals
    };
  }

  // Default: No Match
  return {
    matchLevel: MATCH_LEVELS.NO_MATCH,
    confidence: 0.0,
    relationType: MEMBER_ROLES.REVIEW_REQUIRED,
    reasons: ['No corroborating identity signals found across records'],
    signals
  };
}

// ----------------------------------------------------------------------------
// 5. CONTACT RESOLUTION & DECISION-MAKER CLASSIFICATION
// ----------------------------------------------------------------------------

/**
 * Resolves contacts for a given lead, tagging generic inboxes vs individual contacts,
 * and deterministically classifies decision-maker status.
 */
export function resolveLeadContacts(lead, existingContacts = []) {
  const resolved = [];
  const seenEmails = new Set();
  const seenPhones = new Set();

  // 1. Process existing contacts from database if provided
  if (Array.isArray(existingContacts)) {
    for (const c of existingContacts) {
      const emailNorm = normalizeEmail(c.email);
      const phoneNorm = normalizePhone(c.phone);

      let isDecisionMaker = c.is_decision_maker || 0;
      let provenance = c.provenance_type || 'UNKNOWN';
      let confidence = c.confidence_score || 0.5;

      const title = (c.job_title || '').toLowerCase();
      
      // Deterministic classification based on explicit title
      if (DECISION_MAKER_KEYWORDS.some(k => title.includes(k))) {
        isDecisionMaker = 1;
        provenance = 'VERIFIED';
        confidence = 0.95;
      } else if (NON_DECISION_MAKER_KEYWORDS.some(k => title.includes(k))) {
        isDecisionMaker = 0;
        provenance = 'VERIFIED';
        confidence = 0.95;
      } else if (emailNorm.isGeneric) {
        isDecisionMaker = 0;
        provenance = 'VERIFIED';
        confidence = 0.90;
      }

      const key = `${emailNorm.cleanEmail || ''}_${phoneNorm.e164 || ''}`;
      resolved.push({
        ...c,
        email: emailNorm.cleanEmail || c.email,
        phone: phoneNorm.e164 || c.phone,
        is_decision_maker: isDecisionMaker,
        provenance_type: provenance,
        confidence_score: confidence,
        is_generic_inbox: emailNorm.isGeneric
      });

      if (emailNorm.cleanEmail) seenEmails.add(emailNorm.cleanEmail);
      if (phoneNorm.e164) seenPhones.add(phoneNorm.e164);
    }
  }

  // 2. Synthesize contact from primary lead record if email/phone present and not yet captured
  const leadEmailNorm = normalizeEmail(lead.email);
  const leadPhoneNorm = normalizePhone(lead.phone);

  if (leadEmailNorm.isValid && !seenEmails.has(leadEmailNorm.cleanEmail)) {
    let isDecisionMaker = 0;
    let jobTitle = leadEmailNorm.isGeneric ? 'Company General Inbox' : 'Business Contact';
    let contactType = leadEmailNorm.isGeneric ? 'COMPANY_GENERAL' : 'INDIVIDUAL';
    let provenance = 'INFERRED';
    let confidence = 0.70;

    // Deterministic rule: generic email is NEVER a decision maker
    if (leadEmailNorm.isGeneric) {
      isDecisionMaker = 0;
      provenance = 'VERIFIED';
      confidence = 0.90;
    }

    resolved.push({
      id: `contact_${lead.id}_email`,
      lead_id: lead.id,
      tenant_id: lead.tenant_id || 'default',
      contact_name: leadEmailNorm.isGeneric ? `${lead.businessName} Team` : lead.businessName,
      job_title: jobTitle,
      contact_type: contactType,
      phone: leadPhoneNorm.e164 || null,
      email: leadEmailNorm.cleanEmail,
      is_decision_maker: isDecisionMaker,
      is_generic_inbox: leadEmailNorm.isGeneric,
      verification_status: 'UNVERIFIED',
      confidence_score: confidence,
      provenance_type: provenance
    });
  }

  return resolved;
}

// ----------------------------------------------------------------------------
// 6. RESOLUTION PIPELINE & GRAPH CLUSTERING
// ----------------------------------------------------------------------------

/**
 * Deterministically groups a collection of leads into entity groups and member assignments.
 * Supports both dry-run inspection and relational database persistence.
 */
export function resolveAllEntities(leads, options = {}) {
  const { tenantId = 'default', dryRun = false, dbInstance = null } = options;

  if (!Array.isArray(leads) || leads.length === 0) {
    return {
      success: true,
      totalLeads: 0,
      totalGroups: 0,
      groups: [],
      stats: { multiLocationCount: 0, duplicateCount: 0, singleCount: 0 }
    };
  }

  // Build lookup structures for fast clustering
  const parentMap = new Map(); // leadId -> canonical cluster leader leadId
  const find = (id) => {
    let root = id;
    while (parentMap.has(root)) root = parentMap.get(root);
    let curr = id;
    while (curr !== root) {
      const next = parentMap.get(curr) || root;
      parentMap.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (id1, id2) => {
    const root1 = find(id1);
    const root2 = find(id2);
    if (root1 !== root2) {
      parentMap.set(root2, root1);
    }
  };

  // Pairwise evaluation cache
  const pairwiseMatches = new Map(); // "idA:idB" -> matchResult

  // 1. Grouping pass
  for (let i = 0; i < leads.length; i++) {
    for (let j = i + 1; j < leads.length; j++) {
      const leadA = leads[i];
      const leadB = leads[j];

      const match = evaluateLeadMatch(leadA, leadB);
      if (match.matchLevel === MATCH_LEVELS.EXACT_MATCH || match.matchLevel === MATCH_LEVELS.HIGH_CONFIDENCE_MATCH) {
        union(leadA.id, leadB.id);
        const pairKey = [leadA.id, leadB.id].sort().join(':');
        pairwiseMatches.set(pairKey, match);
      }
    }
  }

  // 2. Assemble raw clusters
  const clusters = new Map(); // leaderId -> lead[]
  for (const lead of leads) {
    const root = find(lead.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(lead);
  }

  // 3. Process each cluster to determine canonical lead, group type, and member roles
  const entityGroups = [];
  let multiLocationCount = 0;
  let duplicateCount = 0;
  let singleCount = 0;

  for (const [_, clusterLeads] of clusters.entries()) {
    // Determine Canonical Lead:
    // Highest completeness score (phone + email + website + address + placeId)
    // Tie-breaker: oldest created_at or lowest id
    const scoredLeads = clusterLeads.map(l => {
      let score = 0;
      if (l.placeId) score += 3;
      if (l.website) score += 2;
      if (l.email) score += 2;
      if (l.phone) score += 2;
      if (l.address || l.location) score += 1;
      return { lead: l, score };
    });

    scoredLeads.sort((a, b) => b.score - a.score || (a.lead.id < b.lead.id ? -1 : 1));
    const canonicalLead = scoredLeads[0].lead;

    const normCanonicalName = normalizeBusinessName(canonicalLead.businessName);
    const normCanonicalWeb = normalizeWebsite(canonicalLead.website);
    const normCanonicalPhone = normalizePhone(canonicalLead.phone);

    const members = [];
    let hasRelatedLocations = false;
    let hasDuplicates = false;

    for (const item of scoredLeads) {
      const lead = item.lead;
      if (lead.id === canonicalLead.id) {
        members.push({
          leadId: lead.id,
          role: MEMBER_ROLES.CANONICAL,
          matchConfidence: 1.0,
          matchReason: 'Designated primary canonical record for this business entity group',
          matchSignals: { isCanonical: true, profileCompletenessScore: item.score }
        });
      } else {
        const pairKey = [canonicalLead.id, lead.id].sort().join(':');
        const match = pairwiseMatches.get(pairKey) || evaluateLeadMatch(canonicalLead, lead);

        let role = match.relationType;
        if (role === MEMBER_ROLES.CANONICAL) role = MEMBER_ROLES.DUPLICATE;

        if (role === MEMBER_ROLES.RELATED_LOCATION) hasRelatedLocations = true;
        if (role === MEMBER_ROLES.DUPLICATE) hasDuplicates = true;

        members.push({
          leadId: lead.id,
          role,
          matchConfidence: match.confidence,
          matchReason: match.reasons.join('; '),
          matchSignals: match.signals
        });
      }
    }

    // Determine Entity Type
    let entityType = ENTITY_TYPES.SINGLE_LOCATION;
    if (clusterLeads.length > 1) {
      if (hasRelatedLocations) {
        entityType = ENTITY_TYPES.MULTI_LOCATION;
        multiLocationCount++;
      } else {
        entityType = ENTITY_TYPES.SINGLE_LOCATION;
        duplicateCount++;
      }
    } else {
      singleCount++;
    }

    const groupId = `grp_${canonicalLead.id}`;
    const group = {
      id: groupId,
      tenantId,
      canonicalLeadId: canonicalLead.id,
      entityName: canonicalLead.businessName,
      normalizedName: normCanonicalName.normalizedName,
      rootBrandName: normCanonicalName.rootBrandName,
      primaryDomain: normCanonicalWeb.rootDomain || null,
      primaryPhone: normCanonicalPhone.e164 || null,
      entityType,
      confidenceScore: clusterLeads.length > 1 ? 0.95 : 1.0,
      status: 'AUTO_RESOLVED',
      metadata: {
        memberCount: members.length,
        hasDuplicates,
        hasRelatedLocations
      },
      members
    };

    entityGroups.push(group);
  }

  const result = {
    success: true,
    totalLeads: leads.length,
    totalGroups: entityGroups.length,
    stats: {
      singleCount,
      multiLocationCount,
      duplicateCount
    },
    groups: entityGroups
  };

  // 4. If persistence mode requested and dbInstance provided, execute transaction
  if (!dryRun && dbInstance) {
    const now = new Date().toISOString();
    
    // We execute in an atomic transaction
    dbInstance.transaction(() => {
      // Clear existing entity groups and members for this tenant
      dbInstance.prepare(`DELETE FROM lead_entity_members WHERE tenant_id = ?`).run(tenantId);
      dbInstance.prepare(`DELETE FROM lead_entity_groups WHERE tenant_id = ?`).run(tenantId);

      const insertGroup = dbInstance.prepare(`
        INSERT INTO lead_entity_groups (
          id, tenant_id, canonical_lead_id, entity_name, normalized_name,
          primary_domain, entity_type, confidence_score, status, metadata,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMember = dbInstance.prepare(`
        INSERT INTO lead_entity_members (
          id, group_id, lead_id, tenant_id, role, match_confidence,
          match_reason, match_signals, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const grp of entityGroups) {
        insertGroup.run(
          grp.id,
          grp.tenantId,
          grp.canonicalLeadId,
          grp.entityName,
          grp.normalizedName,
          grp.primaryDomain,
          grp.entityType,
          grp.confidenceScore,
          grp.status,
          JSON.stringify(grp.metadata),
          now,
          now
        );

        for (const m of grp.members) {
          const memberId = `mem_${grp.id}_${m.leadId}`;
          insertMember.run(
            memberId,
            grp.id,
            m.leadId,
            grp.tenantId,
            m.role,
            m.matchConfidence,
            m.matchReason,
            JSON.stringify(m.matchSignals),
            now,
            now
          );
        }
      }
    })();
  }

  return result;
}
