/**
 * ==============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 7B
 * PERSONALIZATION FOUNDATION: FACT/CLAIM MODEL + DETERMINISTIC TEMPLATE ENGINE
 * ==============================================================================
 * Module: campaign-personalization-engine.js
 * Version: 3.5 Enterprise
 *
 * Primary Objectives:
 * - Deterministic, grounded fact/claim representation.
 * - Strict segregation of VERIFIED, INFERRED, and UNKNOWN facts.
 * - Invariant: INFERRED -> VERIFIED and UNKNOWN -> VERIFIED are strictly forbidden.
 * - Deterministic claim safety API: evaluates candidate claims against persisted evidence.
 * - Rejects unsupported quantitative claims (pricing, headcounts, lost revenue).
 * - Multi-touch (Touches 1-3), multi-channel (Email, WhatsApp, Telegram) deterministic template engine.
 * - Branching strategy: 'VERIFIED_ENRICHED' (for leads with DOM evidence) vs 'BASE_VERIFIED_ONLY' (for leads without DOM evidence).
 * - ZERO external AI/LLM API calls. ZERO provider calls. ZERO outbound messages.
 * - Fail-closed: missing provenance or unreplaced template variables fail closed.
 * - 100% Tenant Isolation on all lookups and operations.
 * ==============================================================================
 */

import crypto from 'crypto';
import { db as defaultDb } from './database.js';

/**
 * Authoritative Fact Provenance Levels
 */
export const FACT_PROVENANCE_LEVELS = Object.freeze({
  VERIFIED: 'VERIFIED',
  INFERRED: 'INFERRED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Phase 2 Step 7G-1 Grounded Fact-Claim Taxonomy
 */
export const CLAIM_TYPES = Object.freeze({
  CORE_ATTRIBUTE: 'CORE_ATTRIBUTE',
  TECHNICAL_FACT: 'TECHNICAL_FACT',
  CONSULTATIVE_OPPORTUNITY: 'CONSULTATIVE_OPPORTUNITY',
  BENIGN_AGENCY: 'BENIGN_AGENCY',
  OPERATIONAL_ASSERTION: 'OPERATIONAL_ASSERTION',
  UNSUPPORTED_CLAIM: 'UNSUPPORTED_CLAIM'
});

/**
 * Computes deterministic normalized claim hash using NFC normalization, lowercase,
 * and whitespace collapsing.
 *
 * @param {string} claimText
 * @returns {string} SHA-256 hash hex string
 */
export function computeNormalizedClaimHash(claimText) {
  if (!claimText || typeof claimText !== 'string') return '';
  const normalized = String(claimText)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Claim Classification Taxonomy
 */
export const CLAIM_CLASSIFICATIONS = Object.freeze({
  VERIFIED_FACT: 'VERIFIED_FACT',
  QUALIFIED_INFERENCE: 'QUALIFIED_INFERENCE',
  UNSUPPORTED_CLAIM: 'UNSUPPORTED_CLAIM'
});

/**
 * Claim Validation Decisions
 */
export const CLAIM_VALIDATION_DECISIONS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
  UNSUPPORTED: 'UNSUPPORTED'
});

/**
 * Intelligence Coverage Tiers
 */
export const INTELLIGENCE_TIERS = Object.freeze({
  VERIFIED_ENRICHED: 'VERIFIED_ENRICHED',
  BASE_VERIFIED_ONLY: 'BASE_VERIFIED_ONLY',
  INSUFFICIENT: 'INSUFFICIENT'
});

/**
 * Unsupported / Hallucination Blacklist Regex Patterns
 * Patterns that represent fabricated ROI, invented pricing, unproven staff counts, or unverified losses.
 */
const FORBIDDEN_UNSUPPORTED_PATTERNS = [
  /\$\s*\d+[\d,]*/i,                                 // Invented dollar figures ($5,000, $70k)
  /\b\d+k\b/i,                                       // $70k, 20k
  /\b\d+%\s*(increase|decrease|growth|loss|drop)\b/i, // Invented percentage claims (35% increase)
  /\blosing\s+\d+\s+(leads|customers|inquiries)\b/i,  // Invented volume loss ("losing 40 leads")
  /\b(guarantee|guaranteed)\s+\d+/i,                 // Impossible timeline guarantees
  /\b\d+\s+staff\s+members\b/i,                      // Unverified employee headcount
  /\bfull-time\s+receptionist\s+costs\b/i             // Hardcoded ungrounded salary claims
];

/**
 * Canonical sender identity defaults
 */
const DEFAULT_SENDER = Object.freeze({
  coFounders: 'Tanuj Chandel & Amit Pandey',
  agencyName: 'AI AutomationHubs India',
  phone: '+91-7704077700',
  website: 'https://ai-automation-hubs.com',
  optOutNoticeWhatsApp: 'Reply STOP to opt out.',
  optOutNoticeEmail: 'To unsubscribe or update your contact preferences, simply reply with STOP.'
});

/**
 * Extracts allowed factual and consultative material for a lead from the database.
 * Strictly respects tenant isolation.
 *
 * @param {string} leadId
 * @param {string} tenantId
 * @param {object} [dbInstance]
 * @returns {object} Allowed claim material dossier
 */
export function extractAllowedClaimMaterial(leadId, tenantId = 'default', dbInstance = defaultDb) {
  const tid = String(tenantId || 'default').trim();
  const ownership = dbInstance.validateLeadOwnership(leadId, tid);
  if (!ownership || !ownership.valid || !ownership.lead) {
    return {
      allowed: false,
      reason: 'LEAD_TENANT_MISMATCH',
      leadId,
      tenantId: tid,
      tier: INTELLIGENCE_TIERS.INSUFFICIENT,
      verifiedFacts: {},
      qualifiedInferences: [],
      unknowns: ['ALL_ATTRIBUTES']
    };
  }

  const lead = ownership.lead;
  const intel = dbInstance.getLeadIntelligence ? dbInstance.getLeadIntelligence(leadId, tid) : null;
  const evidenceList = dbInstance.getLeadEvidence ? dbInstance.getLeadEvidence(leadId, tid) : [];
  const signalsList = dbInstance.getLeadSignals ? dbInstance.getLeadSignals(leadId, tid) : [];

  const verifiedFacts = {
    businessName: lead.businessName ? String(lead.businessName).trim() : null,
    location: lead.location ? String(lead.location).trim() : null,
    rating: (lead.rating !== null && lead.rating !== undefined && !isNaN(Number(lead.rating))) ? Number(lead.rating) : null,
    website: lead.website ? String(lead.website).trim() : null,
    segment: lead.segment ? String(lead.segment).trim() : null,
    verifiedTechnologies: [],
    hasSsl: false,
    hasMobileViewport: false
  };

  const qualifiedInferences = [];
  const unknowns = [];

  // Filter unexpired verified evidence
  const now = new Date();
  evidenceList.forEach(e => {
    const isExpired = e.expires_at ? (new Date(e.expires_at) < now) : false;
    if (isExpired) return;

    if (e.provenance_type === FACT_PROVENANCE_LEVELS.VERIFIED) {
      if (e.evidence_type === 'TECHNOLOGY_DETECTION' && e.extracted_value) {
        verifiedFacts.verifiedTechnologies.push(e.extracted_value);
      } else if (e.evidence_type === 'SSL_CERTIFICATE') {
        verifiedFacts.hasSsl = true;
      } else if (e.evidence_type === 'VIEWPORT_META') {
        verifiedFacts.hasMobileViewport = true;
      }
    } else if (e.provenance_type === FACT_PROVENANCE_LEVELS.INFERRED) {
      if (e.evidence_type === 'WHATSAPP_WORKFLOW') {
        qualifiedInferences.push({
          inference: 'WHATSAPP_ENQUIRY_STREAMLINING',
          rationale: 'Public website features manual WhatsApp contact without automated self-service scheduling.',
          evidenceId: e.id,
          confidence: e.confidence_score || 0.85
        });
      } else if (e.evidence_type === 'INQUIRY_FORM') {
        qualifiedInferences.push({
          inference: 'WEB_FORM_AUTOMATION',
          rationale: 'Website relies on static web inquiry forms that could benefit from instant qualification.',
          evidenceId: e.id,
          confidence: e.confidence_score || 0.85
        });
      }
    }
  });

  // Signals
  signalsList.forEach(s => {
    const isExpired = s.expires_at ? (new Date(s.expires_at) < now) : false;
    if (isExpired) return;

    if (s.provenance_type === FACT_PROVENANCE_LEVELS.INFERRED && s.signal_type === 'AUTOMATION_OPPORTUNITY') {
      qualifiedInferences.push({
        inference: 'WORKFLOW_AUTOMATION_OPPORTUNITY',
        rationale: s.signal_value || 'Operational automation opportunity observed.',
        signalId: s.id,
        confidence: s.confidence_score || 0.85
      });
    }
  });

  // Track explicit unknowns
  if (!lead.email) unknowns.push('DIRECT_EMAIL');
  if (!lead.phone) unknowns.push('TELEPHONE');
  if (!verifiedFacts.website) unknowns.push('OFFICIAL_WEBSITE');
  if (!intel || !intel.employee_count_estimate) unknowns.push('EMPLOYEE_COUNT');
  if (!intel || !intel.company_size_estimate) unknowns.push('COMPANY_SIZE');

  // Determine coverage tier
  let tier = INTELLIGENCE_TIERS.BASE_VERIFIED_ONLY;
  if (!verifiedFacts.businessName || !verifiedFacts.location) {
    tier = INTELLIGENCE_TIERS.INSUFFICIENT;
  } else if (evidenceList.length > 0) {
    tier = INTELLIGENCE_TIERS.VERIFIED_ENRICHED;
  }

  return {
    allowed: tier !== INTELLIGENCE_TIERS.INSUFFICIENT,
    leadId,
    tenantId: tid,
    tier,
    verifiedFacts,
    qualifiedInferences,
    unknowns,
    evidenceCount: evidenceList.length,
    signalCount: signalsList.length
  };
}

/**
 * Decomposes candidate text into atomic clauses/propositions.
 * Handles sentence boundaries, semicolons, and conjunctions/clause connectors
 * ("and", "but", "because", "so", "which means", "therefore", "while", "whereas").
 *
 * @param {string} text
 * @returns {Array<string>} Atomic clauses
 */
export function decomposeCandidateClaim(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  if (!clean) return [];

  let normalized = clean;
  // Handle front-position subordinate/causal/concessive clauses:
  // e.g. "Because the site uses WordPress, conversions could be falling."
  // "Although the site uses WordPress, visitors are leaving."
  // "Even though the site uses WordPress, bookings could be slipping."
  const frontSubMatch = normalized.match(/^(?:because\s+of|because|since|as|given that|while|although|even though|whereas|despite|in spite of|inasmuch as|in so far as|insofar as|provided that|seeing that|notwithstanding|even if)\s+([^,;:\n]+),\s*(.+)$/i);
  if (frontSubMatch) {
    normalized = frontSubMatch[1] + ' ; ' + frontSubMatch[2];
  }

  // Split on:
  // 1. Sentence boundaries: . ! ? followed by whitespace or end of string
  // 2. Clause delimiters: ; : \n \r \t
  // 3. Parentheses, brackets: ( ) [ ] { }
  // 4. Slashes and dashes: / | — – --
  // 5. Coordinating conjunctions & causal/concessive connectors with or without comma:
  //    and, but, so, because, because of, since, while, whereas, although, even though, despite, in spite of, inasmuch as, provided that, seeing that, notwithstanding, even if, as well as, or, yet, which means, meaning that, therefore, thus, hence, whereby, wherein, from which, to which, at which, in which, through which, by which, on which
  // 6. Relative pronouns / relative clauses: , which | , that | which currently | that currently | from which | to which | at which | in which | through which | by which | on which | where + subject
  // 7. Comma splices: comma followed by whitespace and a subject/pronoun/business-outcome noun
  const splitRegex = /(?:[;:\n\r\t\(\)\[\]\{\}\|\/]|[\.!\?]+(?:\s+|$)|[—–]|\s+--\s+|,\s*(?:and|but|so|because\s+of|because|since|while|whereas|although|even though|despite|in spite of|inasmuch as|provided that|seeing that|notwithstanding|even if|as well as|or|yet|which means|meaning that|which|that|whereby|wherein|from\s+which|to\s+which|at\s+which|in\s+which|through\s+which|by\s+which|on\s+which)\b|\b(?:and|but|so|because\s+of|because|since|while|whereas|although|even though|despite|in spite of|inasmuch as|provided that|seeing that|notwithstanding|even if|as well as|or|yet|which means|meaning that|therefore|thus|hence|whereby|wherein|from\s+which|to\s+which|at\s+which|in\s+which|through\s+which|by\s+which|on\s+which)\b|\bwhere\s+(?=(?:your|the|you|we|our|team|staff|it|this|there|i|he|she|they|conversions?|revenue|inquir\w*|enquir\w*|bookings?|sales|traffic|users?|visitors?|leads?|opportunities|customers?|prospects?|clients?|buyers?|orders?|transactions?|checkout|carts?|rates?|shoppers?|people|interested|prospective|potential|new|existing|some|many|few|all|less|fewer|more|unrealized|reduced|diminished|weaker|stagnant|higher|lower|demand|intake|throughput|uptake|friction|wasted|duplicated|unnecessary|avoidable|business|interest|purchases?)\b)|,\s+(?=(?:your|the|you|we|our|team|staff|it|this|there|i|he|she|they|conversions?|revenue|inquir\w*|enquir\w*|bookings?|sales|traffic|users?|visitors?|leads?|opportunities|customers?|prospects?|clients?|buyers?|orders?|transactions?|checkout|carts?|rates?|shoppers?|people|interested|prospective|potential|new|existing|some|many|few|all|less|fewer|more|unrealized|reduced|diminished|weaker|stagnant|higher|lower|demand|intake|throughput|uptake|friction|wasted|duplicated|unnecessary|avoidable|business|interest|purchases?)\b))/i;

  const rawSegments = normalized.split(splitRegex);
  const clauses = [];

  for (let seg of rawSegments) {
    let s = seg.trim();
    s = s.replace(/^(?:and|but|so|because\s+of|because|since|while|whereas|although|even though|despite|in spite of|inasmuch as|provided that|seeing that|notwithstanding|even if|as well as|or|yet|which means|meaning that|which|that|therefore|thus|hence|whereby|wherein|from\s+which|to\s+which|at\s+which|in\s+which|through\s+which|by\s+which|on\s+which|where|as)\s+/i, '').trim();
    s = s.replace(/^[,\-–—;:\s\/\(\)]+|[,\-–—;:\s\/\(\)]+$/g, '').trim();
    if (s.length > 0) {
      clauses.push(s);
    }
  }

  return clauses.length > 0 ? clauses : [clean];
}

/**
 * Proposition classifications for deterministic grounding boundaries.
 */
export const PROPOSITION_TYPES = Object.freeze({
  BENIGN_AGENCY: 'BENIGN_AGENCY',
  CORE_ATTRIBUTE: 'CORE_ATTRIBUTE',
  TECHNICAL_FACT: 'TECHNICAL_FACT',
  CONSULTATIVE_OPPORTUNITY: 'CONSULTATIVE_OPPORTUNITY',
  OPERATIONAL_ASSERTION: 'OPERATIONAL_ASSERTION',
  UNKNOWN_UNCLASSIFIED: 'UNKNOWN_UNCLASSIFIED'
});

/**
 * Generalized prospect operational indicators / pain point assertions.
 * Covers negative impact verbs on business assets, passive voice, manual handling,
 * team failures, causal/predictive loss claims, and modal qualifiers.
 */
export const prospectOperationalIndicators = [
  // Negative impact verbs on business assets (active or passive, with intervening words)
  /\b(?:potential|prospective|inbound|new|valuable|high-value|existing)?\s*(?:customers?|clients?|buyers?|shoppers?|prospects?|leads?|enquiries|inquiries|visitors?|traffic|calls?|sales|revenue|income|bookings?|appointments?|transactions?|orders?|conversions?|opportunities|follow-?ups?|pipeline|checkout|carts?|users?|interest|purchases?)\b.*?\b(?:missed?|missing|lost|losing|loss\w*|dropped?|dropping|drop[- ]?outs?|unanswered|slipping|slipped|disappear\w*|delayed?|slow\w*|leak\w*|bleed\w*|waste|wasting|wasted|left\s+without|fewer|less|poor\w*|bad|reduc\w*|lower\w*|decreas\w*|declin\w*|shrink\w*|fail\w*|going\s+(?:elsewhere|unanswered|away)|go\w*\s+(?:elsewhere|unanswered|away)|walk\w*\s+(?:away|elsewhere)|not\s+(?:be\s+|being\s+)?(?:reached|reaching|contacted|followed|captured|capturing|converted|converting|handled|attended|received|completed|completing)|never\s+(?:become|convert|reach|return)|rarely\s+return|fall\w*|fell|fallen|tank\w*|stagna(?:t\w*|nt)|churn\w*|abandon\w*|leav\w*|leaves?|left|incomplete|flee\w*|fled|quit\w*|exit\w*|evaporat\w*|deteriorat\w*|diminish\w*|disengag\w*|stop\w*\s+short)\b/i,

  // Impairment verbs followed by business assets (with optional intervening adjectives)
  /\b(?:miss\w*|los\w*|loss\s+of|drop\w*|leak\w*|bleed\w*|waste|wasting|wasted|hurt\w*|affect\w*|reduc\w*|lower\w*|poor\w*|fewer|less|decreas\w*|declin\w*|fail\w*\s+to\s+(?:capture|convert|reach|complete|finish|progress|proceed)|fall\w*|fell|fallen|tank\w*|stagna(?:t\w*|nt)|churn\w*|abandon\w*|leav\w*|slip\w*|flee\w*|quit\w*|exit\w*|evaporat\w*|deteriorat\w*|diminish\w*|disengag\w*|weaker|suboptimal)\s+(?:(?:\w+)\s+){0,3}(?:calls?|leads?|inquiries|enquiries|customers?|clients?|buyers?|shoppers?|prospects?|visitors?|opportunities|sales|revenue|conversions?|bookings?|transactions?|carts?|checkout|users?|interest|purchases?|completion|uptake|throughput|intake|business|demand|effort|handling|results?)\b/i,

  // Unanswered / Unreached / Untimely / Slipping / Leaving / Abandoning / Dropping out / Stagnating / Fleeing / Quitting / Exiting / Evaporating
  /\b(?:slipping\s+(?:away|through))\b/i,
  /\b(?:going\s+unanswered|unanswered|without\s+(?:a\s+)?response)\b/i,
  /\bnot\s+receiving\s+timely\s+attention\b/i,
  /\bnot\s+being\s+(?:contacted|reached|followed\s+up|captured)\b/i,
  /\bnot\s+(?:be\s+)?reaching\b/i,
  /\b(?:not\s+(?:be\s+)?capturing|failing\s+to\s+capture)\s+(?:(?:\w+)\s+){0,2}opportunit/i,
  /\bfall(?:ing)?\s+through\s+the\s+cracks\b/i,
  /\b(?:leaves?|leaving)\s+(?:money|revenue)\s+on\s+the\s+table\b/i,
  /\b(?:leaves?|leaving)\s+(?:before\s+contacting|without\s+contacting|the\s+site|your\s+site|the\s+page|checkout|cart)\b/i,
  /\b(?:abandon\w*)\s+(?:their\s+)?(?:carts?|checkout|baskets?|forms?|sessions?|process)\b/i,
  /\b(?:drop[- ]?out\w*|dropping\s+out)\b/i,
  /\b(?:not\s+completing|incomplete)\s+(?:checkout|transactions?|orders?|bookings?|forms?|purchases?)\b/i,
  /\b(?:stagna(?:t\w*|nt))\s+(?:conversion\s+rates?|growth|leads?|revenue|sales)\b/i,
  /\b(?:delayed?|delays?|slow|taking\s+too\s+long)\s+(?:(?:\w+)\s+){0,2}(?:responses?|follow-?ups?|replies)\b/i,
  /\bresponse\s+delays?\b/i,
  /\bslow\s+(?:(?:\w+)\s+){0,2}responses?\b/i,
  /\b(?:flee\w*|fled|quit\w*|exit\w*|evaporat\w*)\b/i,
  /\b(?:fail\w*|failing|failed)\s+to\s+(?:convert|complete|progress|finish|book|checkout|purchase|proceed)\b/i,
  /\b(?:quit|quitting|exit\w*|flee\w*)\s+(?:before|during|without)\b/i,

  // Departure & disengagement
  /\b(?:walk\w*|go\w*|turn\w*|look\w*)\s+(?:away|elsewhere)\b/i,
  /\b(?:disengag\w*|stop\w*\s+short|never\s+return\w*|rarely\s+return\w*|fail\w*\s+to\s+proceed)\b/i,
  /\bdriv\w*\s+(?:.*?\s+)?away\b/i,
  /\blose\s+interest\b/i,

  // Conversion, completion & uptake impairment
  /\b(?:lower|reduced|diminished|weaker|stagnant|poor|less|fewer|suppressed|compromised|suboptimal)\s+(?:completion\w*|conversions?|uptake|throughput|intake|results?|business|demand|interest)\b/i,
  /\b(?:completion|conversion|uptake|throughput|intake|results?)\s+(?:rates?|metrics?)?\s+(?:is|are|being)?\s*(?:lower|falling|dropping|reduced|diminished|weaker|stagnant|poor|suboptimal)\b/i,
  /\b(?:less|fewer)\s+(?:business|orders?|transactions?|enquiries|inquiries|sales|revenue|leads?|customers?)\s+(?:comes?|coming)?\s*(?:through|in)\b/i,
  /\b(?:might|may|could|can|would)\s+(?:not\s+be|never\s+be)\s+converting\b/i,
  /\bunlikely\s+to\s+(?:complete|convert|proceed|purchase|checkout|book|reach)\b/i,

  // Manual handling, friction & inefficiency
  /\bmanual(?:ly)?\s+(?:(?:\w+)\s+){0,4}(?:handling|handles|response|responds|entry|follow-up|booking|process|processed|processing|routed|routing|steps?)\b/i,
  /\bmanual(?:ly)?\s*(?:handling|handles|response|responds|entry|follow-up|booking|process|processed|processing|routed|routing)\b/i,
  /\b(?:by\s+hand|respond\s+by\s+hand|handling\s+(?:this\s+)?by\s+hand)\b/i,
  /\b(?:your|the|warehouse|reception|clinic|office|support|sales)?\s*team\s+(?:is|are|currently|handles|misses|fails|appears\s+to|struggles?|facing|experiencing)\b/i,
  /\b(?:your|the|warehouse|reception|clinic|office|support|sales)?\s*staff\s+(?:is|are|handles|misses|manually|struggles?|facing|experiencing)\b/i,
  /\b(?:operational|workflow|process)\s+(?:inefficienc\w*|bottlenecks?|problems?|issues?|friction|delays?|costs?|breakdowns?|slowdown)\b/i,
  /\b(?:client|customer|user|visitor|workflow|process|operational)\s+friction\b/i,
  /\b(?:wasted?|wasting)\s+(?:effort|time|hours?|resources?)\b/i,
  /\b(?:duplicat\w*)\s+(?:work|effort|handling|steps?)\b/i,
  /\b(?:unnecessary|redundant|avoidable)\s+(?:handling|manual(?:\s+steps?)?|steps?|work|effort|friction|delays?)\b/i,
  /\b(?:bottlenecks?|inefficienc\w*)\b/i,
  /\breduc\w*\s+(?:operational\s+)?efficiency\b/i,
  /\bcosts?\s+(?:you|your)\b/i,
  /\bcosting\s+(?:conversions?|leads?|sales|revenue|money)\b/i,
  /\b(?:facing|experiencing|suffering|encountering|dealing\s+with)\s+(?:delays?|slowdown|backlogs?|bottlenecks?|friction)\b/i,
  /\b(?:disput\w*|reconcil\w*)\s+(?:(?:\w+)\s+){0,3}(?:invoices?|payments?|billings?|charges?|records?|transactions?)\b/i,

  // Business impact & demand
  /\b(?:missed?|unrealized|lost)\s+(?:demand|opportunities|opportunity|business|revenue|sales|leads?)\b/i,
  /\b(?:reduced|lower|diminished|weaker|poor|suboptimal)\s+(?:intake|throughput|results?|yield)\b/i,
  /\b(?:causing|leading\s+to|resulting\s+in|yielding|creating)\s+.*?(?:unrealized\s+opportunit|missed\s+demand|lost\s+business|client\s+friction|wasted\s+effort|duplicated\s+work|unnecessary\s+handling|avoidable\s+manual|reduced\s+intake|lower\s+throughput|diminished\s+results)/i,

  // Causal / Predictive loss statements
  /\b(?:will|could|may|might|can|would)\s+(?:result\s+in|cause|lead\s+to|mean|create|reduce|prevent)\s+.*?(?:loss|losing|lost|leak|dropped?|missed?|delayed?|slow|unanswered|falling|hurt|affect|fewer|less|poor|fail|abandon|stagnat|slip|exit|quit|flee|evaporat|away|friction|wasted|duplicated|intake|throughput)/i,
  /\b(?:causes?|causing|leads?\s+to|leading\s+to|results?\s+in|resulting\s+in|contributes?\s+to|responsible\s+for)\s+.*?(?:loss|losing|lost|leak|dropped?|missed?|delayed?|slow|unanswered|falling|inefficiency|bottleneck|hurt|affect|fewer|less|poor|fail|abandon|stagnat|slip|exit|quit|flee|evaporat|friction|wasted|duplicated|intake|throughput)/i,

  // Modal / Qualifier combinations with operational loss
  /\b(?:could|may|might|perhaps|potentially|possibly|likely|probably|seems\s+to|appears\s+to)\s+(?:be\s+)?(?:losing|missing|dropping|leaking|failing|delayed|slow|unanswered|costing|going\s+elsewhere|reducing|falling|slipping|abandoning|leaving|stagnating|exiting|quitting|fleeing|evaporating|driving\s+.*?\s+away|causing\s+friction)/i,
  /\bpoor\s+conversions?\b/i,
  /\bconversion\s+(?:loss|drop|issue|problem|failure|stagnation)\b/i
];

/**
 * Operational outcome / commercial loss or impact pattern.
 * Ensures operational propositions dominate technical vocabulary.
 */
export const operationalOutcomeOrImpactRegex = /\b(?:cost\w*|loss\w*|losing|lost|drop\w*|miss\w*|leak\w*|bleed\w*|waste\w*|wasting|wasted|hurt\w*|affect\w*|reduc\w*|lower\w*|poor\w*|decreas\w*|declin\w*|limit\w*|suppress\w*|prevent\w*|fail\w*|going\s+elsewhere|go\w*\s+elsewhere|walk\w*\s+away|driv\w*\s+.*?away|fall\w*|fell|fallen|stagna(?:t\w*|nt)|tank\w*|leav\w*|leave|leaves|left|churn\w*|abandon\w*|slip\w*|slipped|drop[- ]?outs?|incomplete|not\s+completing|not\s+converting|flee\w*|fled|quit\w*|exit\w*|evaporat\w*|deteriorat\w*|diminish\w*|disengag\w*|stop\w*\s+short|never\s+return\w*|friction|duplicat\w*|unnecessary|avoidable|unrealized|weaker|suboptimal|delay\w*|backlog\w*|slowdown\w*|bottleneck\w*|disput\w*|reconcil\w*)\b.*?\b(?:calls?|leads?|inquiries|enquiries|customers?|clients?|buyers?|shoppers?|prospects?|visitors?|opportunities|sales|revenue|conversions?|bookings?|appointments?|transactions?|carts?|checkout|users?|traffic|orders?|rates?|interest|purchases?|completion|uptake|throughput|intake|business|demand|effort|handling|triage|results?|workflow|process|inventory|stock|processing|dispatch|fulfillment|shipments?|backlog|invoices?|billings?|charges?)\b|\b(?:calls?|leads?|inquiries|enquiries|customers?|clients?|buyers?|shoppers?|prospects?|visitors?|opportunities|sales|revenue|conversions?|bookings?|appointments?|transactions?|carts?|checkout|users?|traffic|orders?|rates?|interest|purchases?|completion|uptake|throughput|intake|business|demand|effort|handling|triage|results?|workflow|process|inventory|stock|processing|dispatch|fulfillment|shipments?|backlog|invoices?|billings?|charges?)\b.*?\b(?:cost\w*|loss\w*|losing|lost|drop\w*|miss\w*|leak\w*|bleed\w*|waste\w*|wasting|wasted|hurt\w*|affect\w*|reduc\w*|lower\w*|poor\w*|decreas\w*|declin\w*|limit\w*|suppress\w*|prevent\w*|fail\w*|going\s+elsewhere|go\w*\s+elsewhere|walk\w*\s+away|driv\w*\s+.*?away|fall\w*|fell|fallen|stagna(?:t\w*|nt)|tank\w*|leav\w*|leave|leaves|left|churn\w*|abandon\w*|slip\w*|slipped|drop[- ]?outs?|incomplete|not\s+completing|not\s+converting|flee\w*|fled|quit\w*|exit\w*|evaporat\w*|deteriorat\w*|diminish\w*|disengag\w*|stop\w*\s+short|never\s+return\w*|friction|duplicat\w*|unnecessary|avoidable|unrealized|weaker|suboptimal|delay\w*|backlog\w*|slowdown\w*|bottleneck\w*|disput\w*|reconcil\w*)\b/i;

/**
 * Operational workflow domains and their specific entity markers.
 * Used for deterministic domain-alignment verification between operational propositions and evidence.
 */
export const OPERATIONAL_DOMAINS = Object.freeze({
  ECOMMERCE_CHECKOUT: {
    id: 'ECOMMERCE_CHECKOUT',
    patterns: [/\b(?:checkout|cart|basket|payment|transaction|stripe|paypal|gateway|billing|order|purchase)\b/i]
  },
  TELEPHONY_RECEPTION: {
    id: 'TELEPHONY_RECEPTION',
    patterns: [/\b(?:phone|telephone|calls?|calling|reception|receptionist|voicemail|answering|telephony|dial)\b/i]
  },
  MESSAGING_CHAT: {
    id: 'MESSAGING_CHAT',
    patterns: [/\b(?:whatsapp|chat|instant\s+messag\w*|sms|text\s+messag\w*|inbox)\b/i]
  },
  WEB_FORMS: {
    id: 'WEB_FORMS',
    patterns: [/\b(?:web\s*forms?|contact\s*forms?|inquiry\s*forms?|form\s+submission|form\s+fill)\b/i]
  },
  APPOINTMENT_SCHEDULING: {
    id: 'APPOINTMENT_SCHEDULING',
    patterns: [/\b(?:appointment|booking|calendar|scheduling|reschedule|consultation)\b/i]
  },
  STAFFING_WORKFORCE: {
    id: 'STAFFING_WORKFORCE',
    patterns: [/\b(?:staff|staffing|understaffed|personnel|front\s+desk|manpower|shortage)\b/i]
  },
  TECHNICAL_INFRASTRUCTURE: {
    id: 'TECHNICAL_INFRASTRUCTURE',
    patterns: [/\b(?:server|hosting|outage|downtime|uptime|ssl\s+error|500\s+error|dns|crash)\b/i]
  },
  WEBSITE_DIGITAL: {
    id: 'WEBSITE_DIGITAL',
    patterns: [/\b(?:website|web\s*page|online\s+platform|site)\b/i]
  },
  MANUAL_RESPONSE_WORKFLOW: {
    id: 'MANUAL_RESPONSE_WORKFLOW',
    patterns: [/\b(?:manual(?:\s+\w+)?\s+(?:follow-?up|triage|outreach|responses?|replies|handling)|response\s*times?|response\s*delays?|slow(?:\s+\w+)?\s*responses?|reply\s*delays?)\b/i]
  },
  OPERATIONS_LOGISTICS: {
    id: 'OPERATIONS_LOGISTICS',
    patterns: [/\b(?:warehouse|inventory|dispatch|shipping|logistics|fulfillment|pallet|stock)\b/i]
  }
});

export function extractOperationalDomains(text) {
  const t = String(text || '');
  const domains = new Set();
  for (const [key, dom] of Object.entries(OPERATIONAL_DOMAINS)) {
    if (dom.patterns.some(p => p.test(t))) {
      domains.add(key);
    }
  }
  return domains;
}

export const GENERIC_OPERATIONAL_TERMS = new Set([
  'this', 'that', 'with', 'from', 'your', 'have', 'been', 'there', 'their', 'could',
  'would', 'might', 'should', 'about', 'experiencing', 'business', 'company', 'these',
  'those', 'being', 'they', 'them', 'some', 'many', 'very', 'currently', 'observed',
  'losing', 'lost', 'loss', 'losses', 'missing', 'missed', 'during', 'customer', 'customers',
  'client', 'clients', 'website', 'online', 'lead', 'leads', 'sale', 'sales', 'revenue',
  'opportunity', 'opportunities', 'issue', 'issues', 'problem', 'problems', 'time', 'times', 'team', 'teams',
  'hour', 'hours', 'daily', 'weekly', 'rate', 'rates', 'high', 'fewer', 'less',
  'drop', 'drops', 'dropped', 'dropping', 'delay', 'delays', 'delayed', 'delaying', 'facing', 'report',
  'reported', 'reports', 'reporting', 'potential', 'prospect', 'prospects', 'visitor', 'visitors',
  'result', 'results', 'resulted', 'resulting', 'cause', 'causes', 'causing', 'caused', 'setup', 'setups', 'current',
  'enquiry', 'enquiries', 'inquiry', 'inquiries', 'conversion', 'conversions',
  'contact', 'contacts', 'manual', 'manually', 'staff', 'work', 'works', 'worked', 'working', 'follow',
  'handling', 'handled', 'handles', 'handle', 'process', 'processes', 'processed', 'processing', 'system', 'systems', 'user', 'users',
  'people', 'action', 'actions', 'state', 'states', 'level', 'levels', 'count', 'counts', 'counted', 'counting',
  'order', 'orders', 'purchase', 'purchases', 'step', 'steps', 'effort', 'efforts',
  'activity', 'activities', 'metric', 'metrics',
  'show', 'shows', 'showed', 'showing', 'shown',
  'reveal', 'reveals', 'revealed', 'revealing',
  'display', 'displays', 'displayed', 'displaying',
  'note', 'notes', 'noted', 'noting',
  'frequent', 'frequently', 'often', 'rare', 'rarely'
]);

export const GENERIC_OPERATIONAL_STEMS = new Set([
  'delay', 'hour', 'day', 'daili', 'count', 'sale', 'work', 'action', 'state',
  'level', 'report', 'result', 'cause', 'process', 'system', 'issue', 'problem',
  'loss', 'drop', 'miss', 'lead', 'enquir', 'inquir', 'convers', 'visit',
  'prospect', 'custom', 'client', 'user', 'rate', 'time', 'team', 'staff',
  'follow', 'handl', 'setup', 'order', 'purchas', 'cart', 'checkout', 'transact',
  'operat', 'workflow', 'activ', 'number', 'metric', 'observ', 'experienc',
  'happen', 'occur', 'appear', 'seem', 'indicat', 'suggest', 'find', 'detect',
  'effort', 'step', 'intake', 'throughput', 'uptake', 'friction',
  'show', 'reveal', 'display', 'note', 'frequent'
]);

/**
 * Forward-looking consultative opportunity patterns (non-accusatory).
 */
export const consultativeOpportunityPatterns = [
  /\b(?:opportunity|potential|benefit)\s+to\s+(?:improve|streamline|automate|enhance|optimize|accelerate)\b/i,
  /\bworkflows?\s+(?:that\s+)?could\s+benefit\s+from\s+(?:instant|automated|self-service)\b/i,
  /\b(?:suggests?|indicates?)\s+(?:automated|instant|self-service)\s+(?:scheduling|qualification|enquiry|routing)\s+could\s+be\s+(?:helpful|beneficial|valuable)\b/i,
  /\bmay\s+indicate\s+an\s+opportunity\b/i
];

/**
 * Technical property keywords for web and DOM evidence matching.
 */
export const technicalKeywords = [
  /\b(?:wordpress|woocommerce|shopify|wix|squarespace|joomla|drupal|magento|webflow|hubspot|elementor|php|mysql|apache|nginx)\b/i,
  /\b(?:ssl|https|tls|encryption|security\s+certificate)\b/i,
  /\b(?:viewport|mobile\s+viewport|responsive\s+design|mobile-friendly)\b/i,
  /\b(?:structured\s+data|schema(?:\.org)?|rich\s+snippets?|json-ld)\b/i,
  /\b(?:inquiry\s+form|contact\s+form|web\s+form|form\s+submission)\b/i,
  /\b(?:whatsapp\s+button|whatsapp\s+link|whatsapp\s+contact)\b/i,
  /\b(?:built\s+on|powered\s+by|site\s+uses|website\s+lists|platform|tech\s+stack)\b/i
];

/**
 * Positive technical fact patterns.
 * Explicitly matches affirmative assertions of technical stack, configuration, or certificates.
 * Prevents non-technical propositions with technical keywords from being classified as TECHNICAL_FACT.
 */
export const positiveTechnicalFactPatterns = [
  /\b(?:built\s+(?:on|with)|powered\s+by|site\s+(?:uses|is\s+built|runs)|website\s+(?:uses|is\s+built|runs|lists|features|has|utilizes)|platform\s+(?:is|uses)|runs\s+(?:on|with)|running\s+on|developed\s+(?:with|on|in)|hosted\s+on|configured\s+with)\s+(?:(?:\w+)\s+){0,3}(?:wordpress|woocommerce|shopify|wix|squarespace|joomla|drupal|magento|webflow|hubspot|elementor|php|mysql|apache|nginx|http|https|ssl|tls|schema(?:\.org)?|structured\s+data)\b/i,
  /\b(?:wordpress|woocommerce|shopify|wix|squarespace|webflow|elementor|joomla|drupal|magento)\s+(?:(?:is|are)\s+)?(?:the\s+)?(?:cms|platform|framework|system|software|active|installed|used|detected|configured|deployed|running|found)\b/i,
  /\b(?:detected|observed|found|using|uses|runs|features|utilizes)\s+(?:(?:\w+)\s+){0,2}(?:wordpress|woocommerce|shopify|wix|squarespace|webflow|elementor|http|https|ssl|tls|schema(?:\.org)?|structured\s+data)\b/i,
  /\b(?:valid\s+)?(?:ssl|tls|security)\s+certificate\s+(?:is\s+)?(?:active|valid|configured|installed|present|detected|found)\b/i,
  /\b(?:ssl|tls|https|encryption)\s+(?:is\s+)?(?:active|enabled|configured|installed|valid|detected|present|supported)\b/i,
  /\b(?:site|website)\s+(?:uses|supports|enforces|has|utilizes|served\s+over|features)\s+(?:(?:\w+)\s+){0,2}(?:https?|ssl|tls|encryption|schema(?:\.org)?|structured\s+data|json-ld|rich\s+snippets?|viewport)\b/i,
  /\b(?:mobile\s+)?viewport\s+meta(?:\s+tag)?\s+(?:is\s+)?(?:present|configured|detected|set|active|found)\b/i,
  /\b(?:responsive|mobile-friendly)\s*(?:(?:design|viewport|layout)\s*)*(?:is\s+)?(?:configured|active|detected|present|supported|set)\b/i,
  /\b(?:schema(?:\.org)?|structured\s+data|json-ld|rich\s+snippets?)\s+(?:is\s+)?(?:present|deployed|found|detected|configured|active)\b/i,
  /\b(?:contact\s*form|inquiry\s*form|web\s*form|whatsapp\s+button|whatsapp\s+link|whatsapp\s+contact)\s+(?:is\s+)?(?:present|available|detected|found|configured|active)\b/i
];

/**
 * Classifies an atomic proposition into its grounding category.
 *
 * @param {string} clause
 * @returns {string} One of PROPOSITION_TYPES
 */
export function classifyProposition(clause) {
  const c = String(clause || '').trim();
  if (!c) return PROPOSITION_TYPES.UNKNOWN_UNCLASSIFIED;

  const benignAgencyPhrasing = [
    /^(?:hi|hello|namaste|dear)\b/i,
    /^we\s+(?:build|provide|help|create|develop|specialize)\b/i,
    /^would\s+you\s+be\s+open\b/i,
    /^happy\s+to\s+share\b/i,
    /^best\s+regards\b/i,
    /^warm\s+regards\b/i,
    /^reaching\s+out\s+to\s+you\b/i,
    /^closing\s+the\s+loop\b/i,
    /^reply\s+stop\s+to\s+opt\s+out\b/i
  ];
  if (benignAgencyPhrasing.some(p => p.test(c))) {
    return PROPOSITION_TYPES.BENIGN_AGENCY;
  }

  const isOperational = prospectOperationalIndicators.some(p => p.test(c)) || operationalOutcomeOrImpactRegex.test(c);

  // Prioritize operational assertions: any operational problem/loss/accusation takes precedence
  if (isOperational) {
    return PROPOSITION_TYPES.OPERATIONAL_ASSERTION;
  }

  if (consultativeOpportunityPatterns.some(p => p.test(c))) {
    return PROPOSITION_TYPES.CONSULTATIVE_OPPORTUNITY;
  }

  // POSITIVE TECHNICAL FACT INVARIANT (STEP 7D-10):
  // A proposition is ONLY a TECHNICAL_FACT if it states an affirmative technical configuration,
  // platform, certificate, or architecture of the digital asset.
  // The bare presence of a technical keyword does NOT make a sentence a technical fact.
  if (positiveTechnicalFactPatterns.some(p => p.test(c))) {
    return PROPOSITION_TYPES.TECHNICAL_FACT;
  }

  const coreAttributePhrasing = [
    /\b(?:location|located in|based in|address|city|country)\b/i,
    /\b(?:business name|company name|named|trading as)\b/i,
    /\b(?:google rating|reviews?|star rating|stars)\b/i,
    /\b(?:website|domain|url)\b/i
  ];
  if (coreAttributePhrasing.some(p => p.test(c))) {
    return PROPOSITION_TYPES.CORE_ATTRIBUTE;
  }

  return PROPOSITION_TYPES.UNKNOWN_UNCLASSIFIED;
}

/**
 * Checks deterministic semantic relevance between an operational clause and an operational evidence record.
 *
 * @param {string} clause
 * @param {object} evidence
 * @returns {boolean} True if evidence actually grounds the specific operational proposition
 */
export function isOperationalEvidenceRelevant(clause, evidence) {
  if (!evidence) return false;
  const c = String(clause || '').trim();
  const cLower = c.toLowerCase();
  const evText = (String(evidence.evidence_type || '') + ' ' + String(evidence.extracted_value || '') + ' ' + String(evidence.evidence_text || '')).toLowerCase();

  const clauseDomains = extractOperationalDomains(c);
  const evidenceDomains = extractOperationalDomains(evText);

  // 1. DOMAIN ALIGNMENT INVARIANT (STEP 7D-7 & 7D-10):
  // If the clause specifies any operational domains, the evidence MUST cover at least one of those domains!
  if (clauseDomains.size > 0) {
    let hasDomainMatch = false;
    for (const d of clauseDomains) {
      if (evidenceDomains.has(d)) {
        hasDomainMatch = true;
        break;
      }
    }
    if (!hasDomainMatch) return false;
  }

  // If the evidence specifies domains (e.g. ECOMMERCE or TELEPHONY), the clause MUST cover at least one:
  if (evidenceDomains.size > 0) {
    let hasDomainMatch = false;
    for (const d of evidenceDomains) {
      if (clauseDomains.has(d)) {
        hasDomainMatch = true;
        break;
      }
    }
    if (!hasDomainMatch) return false;
  }

  // 2. SUBSTANTIVE CORE ENTITY MATCH:
  // Filter out all generic operational stop-words and morphological stems.
  // Must match at least 1 domain-specific substantive entity (or 2 if multiple non-generics exist).
  const clauseWords = cLower.match(/[a-z]{3,}/g) || [];
  const substantiveWords = clauseWords.filter(w => {
    if (GENERIC_OPERATIONAL_TERMS.has(w)) return false;
    const stem = w.replace(/(?:ing|edly|ed|es|s)$/, '');
    if (GENERIC_OPERATIONAL_TERMS.has(stem) || GENERIC_OPERATIONAL_STEMS.has(stem)) return false;
    return w.length >= 4;
  });

  if (substantiveWords.length === 0) return false;

  const matchedSubstantive = substantiveWords.filter(w => evText.includes(w));
  if (matchedSubstantive.length === 0) return false;

  const requiredMatches = Math.min(2, substantiveWords.length);
  return matchedSubstantive.length >= requiredMatches;
}

/**
 * Evaluates whether a specific atomic clause is covered by verified evidence,
 * signals, or verified core lead attributes.
 *
 * @param {string} clause
 * @param {object} lead
 * @param {Array} evaluatedEvidence
 * @param {Array} evaluatedSignals
 * @param {object} context
 * @returns {object} Coverage evaluation result
 */
export function evaluateClauseCoverage(clause, lead = {}, evaluatedEvidence = [], evaluatedSignals = [], context = {}) {
  const cLower = String(clause || '').toLowerCase().trim();

  // 1. Check verified core lead attributes (businessName, location, rating, website)
  const bName = lead.businessName ? String(lead.businessName).toLowerCase().trim() : null;
  const loc = lead.location ? String(lead.location).toLowerCase().trim() : null;
  const web = lead.website ? String(lead.website).toLowerCase().trim() : null;

  let matchesCoreAttribute = false;
  if (bName && cLower.includes(bName)) matchesCoreAttribute = true;
  if (loc && cLower.includes(loc)) matchesCoreAttribute = true;
  if (web && cLower.includes(web)) matchesCoreAttribute = true;
  if (lead.rating && (cLower.includes(String(lead.rating)) || cLower.includes('rating') || cLower.includes('stars'))) {
    matchesCoreAttribute = true;
  }

  // 2. Check attached verified evidence records
  let matchesEvidence = false;
  let matchingEvidenceRecord = null;
  for (const evd of evaluatedEvidence) {
    if (evd.extracted_value && cLower.includes(String(evd.extracted_value).toLowerCase().trim())) {
      matchesEvidence = true;
      matchingEvidenceRecord = evd;
      break;
    }
    if (evd.evidence_type === 'SSL_CERTIFICATE' && (cLower.includes('ssl') || cLower.includes('tls') || cLower.includes('https') || cLower.includes('encryption'))) {
      matchesEvidence = true;
      matchingEvidenceRecord = evd;
      break;
    }
    if (evd.evidence_type === 'VIEWPORT_META' && (cLower.includes('mobile') || cLower.includes('responsive') || cLower.includes('viewport'))) {
      matchesEvidence = true;
      matchingEvidenceRecord = evd;
      break;
    }
    if (evd.evidence_type === 'STRUCTURED_DATA' && (cLower.includes('schema') || cLower.includes('structured data'))) {
      matchesEvidence = true;
      matchingEvidenceRecord = evd;
      break;
    }
  }

  // 3. Check attached signals
  let matchesSignal = false;
  let matchingSignalRecord = null;
  for (const sig of evaluatedSignals) {
    if (sig.signal_value && cLower.includes(String(sig.signal_value).toLowerCase().trim())) {
      matchesSignal = true;
      matchingSignalRecord = sig;
      break;
    }
    if (sig.signal_type && cLower.includes(String(sig.signal_type).toLowerCase().replace(/_/g, ' '))) {
      matchesSignal = true;
      matchingSignalRecord = sig;
      break;
    }
  }

  let propositionType = classifyProposition(clause);
  const hasOperationalAssertion = (propositionType === PROPOSITION_TYPES.OPERATIONAL_ASSERTION) || prospectOperationalIndicators.some(pattern => pattern.test(clause)) || operationalOutcomeOrImpactRegex.test(clause);
  const isBenignAgencyPhrasing = (propositionType === PROPOSITION_TYPES.BENIGN_AGENCY);

  // If the clause matches verified core attributes, and does NOT have an operational assertion:
  if (!hasOperationalAssertion && !isBenignAgencyPhrasing) {
    if (matchesCoreAttribute) {
      propositionType = PROPOSITION_TYPES.CORE_ATTRIBUTE;
    }
  }

  // Check if there is relevant operational evidence for an operational assertion
  let relevantOperationalEvidence = null;
  if (hasOperationalAssertion) {
    relevantOperationalEvidence = evaluatedEvidence.find(e =>
      ['OPERATIONAL_EVIDENCE', 'PAIN_POINT_SIGNAL', 'WORKFLOW_EVIDENCE'].includes(e.evidence_type) &&
      isOperationalEvidenceRelevant(clause, e)
    );
  }

  // HARD INVARIANT (STEP 7D-3 & STEP 7D-6):
  // 1. Technical DOM evidence CANNOT cover an operational assertion!
  // 2. Unrelated operational evidence CANNOT cover an unrelated operational assertion!
  // 3. Unknown/unclassified propositions CANNOT inherit authorization from technical evidence!
  let isCovered = false;
  if (isBenignAgencyPhrasing) {
    isCovered = true;
  } else if (propositionType === PROPOSITION_TYPES.CORE_ATTRIBUTE) {
    isCovered = matchesCoreAttribute;
  } else if (propositionType === PROPOSITION_TYPES.TECHNICAL_FACT) {
    isCovered = matchesEvidence;
  } else if (propositionType === PROPOSITION_TYPES.CONSULTATIVE_OPPORTUNITY) {
    isCovered = Boolean(matchesEvidence || matchesSignal || (evaluatedEvidence.length > 0) || (evaluatedSignals.length > 0));
    if (isCovered && evaluatedEvidence.length > 0) {
      matchesEvidence = true;
      matchingEvidenceRecord = matchingEvidenceRecord || evaluatedEvidence[0];
    }
  } else if (hasOperationalAssertion) {
    const isOperationalSignal = matchingSignalRecord && (matchingSignalRecord.signal_type === 'PAIN_POINT' || matchingSignalRecord.signal_type === 'AUTOMATION_OPPORTUNITY');
    isCovered = Boolean(relevantOperationalEvidence || isOperationalSignal);
    if (relevantOperationalEvidence) {
      matchesEvidence = true;
      matchingEvidenceRecord = relevantOperationalEvidence;
    }
  } else {
    // UNKNOWN_UNCLASSIFIED
    isCovered = false;
  }

  return {
    clause,
    propositionType,
    matchesCoreAttribute,
    matchesEvidence,
    matchingEvidenceRecord,
    matchesSignal,
    matchingSignalRecord,
    hasOperationalAssertion,
    isBenignAgencyPhrasing,
    isCovered
  };
}

/**
 * Validates a candidate factual or consultative claim against persisted evidence.
 * Fail-closed: missing evidence, mismatched tenant, or unproven statements return UNSUPPORTED.
 *
 * @param {object} params
 * @returns {object} Validation result
 */
export function validateCandidateClaim({
  claimText,
  claimType,
  leadId,
  tenantId = 'default',
  evidenceIds = [],
  signalIds = [],
  atomicClaims = null,
  context = {},
  dbInstance = defaultDb,
  persist = false,
  persistRejected = false,
  campaignId = null,
  campaignTouchId = null,
  generatorType = 'DETERMINISTIC_TEMPLATE',
  modelName = null,
  modelVersion = null,
  promptTemplateVersion = null
}) {
  const tid = String(tenantId || 'default').trim();
  const text = String(claimText || '').trim();

  // Helper to seal, score, and optionally persist the claim result
  const finalizeResult = (res, evdList = []) => {
    if (res.status === CLAIM_VALIDATION_DECISIONS.SUPPORTED) {
      res.normalizedClaimHash = computeNormalizedClaimHash(text);
      res.evaluatedEvidenceIds = evdList.map(e => e.id || e);

      if (persist && dbInstance && dbInstance.createCampaignClaimWithEvidence) {
        try {
          const claimPayload = {
            tenant_id: tid,
            lead_id: leadId,
            campaign_id: campaignId || null,
            campaign_touch_id: campaignTouchId || null,
            claim_text: text,
            normalized_claim_hash: res.normalizedClaimHash,
            claim_type: res.claimType || CLAIM_TYPES.TECHNICAL_FACT,
            provenance_level: res.provenance || FACT_PROVENANCE_LEVELS.VERIFIED,
            validation_status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
            confidence_score: res.confidenceScore !== undefined ? res.confidenceScore : 1.0,
            is_approved: 0,
            approval_snapshot_id: null,
            generator_type: generatorType,
            model_name: modelName,
            model_version: modelVersion,
            prompt_template_version: promptTemplateVersion,
            generated_at: new Date().toISOString()
          };
          const persisted = dbInstance.createCampaignClaimWithEvidence(
            claimPayload,
            res.evaluatedEvidenceIds,
            tid
          );
          res.claimRecord = persisted.claim;
          res.claimId = persisted.claim.id;
        } catch (err) {
          return {
            status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
            reason: `CLAIM_PERSISTENCE_TRANSACTION_FAILED: ${err.message}`,
            allowed: false
          };
        }
      }
    } else {
      // Rejection / review needed: persist for forensic compliance audit if requested
      if (persistRejected && dbInstance && dbInstance.createCampaignClaim && text && leadId) {
        try {
          const ownership = dbInstance.validateLeadOwnership ? dbInstance.validateLeadOwnership(leadId, tid) : { valid: true };
          if (ownership && ownership.valid) {
            const claimPayload = {
              tenant_id: tid,
              lead_id: leadId,
              campaign_id: campaignId || null,
              campaign_touch_id: campaignTouchId || null,
              claim_text: text,
              normalized_claim_hash: computeNormalizedClaimHash(text),
              claim_type: CLAIM_TYPES.UNSUPPORTED_CLAIM,
              provenance_level: FACT_PROVENANCE_LEVELS.UNKNOWN,
              validation_status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
              confidence_score: 0.0,
              is_approved: 0,
              approval_snapshot_id: null,
              generator_type: generatorType,
              model_name: modelName,
              model_version: modelVersion,
              prompt_template_version: promptTemplateVersion,
              generated_at: new Date().toISOString()
            };
            const persisted = dbInstance.createCampaignClaim(claimPayload, tid);
            res.claimRecord = persisted;
            res.claimId = persisted.id;
          }
        } catch (e) {
          // Fail closed without crashing
        }
      }
    }
    return res;
  };

  // Support pre-decomposed structured atomic claims
  if (Array.isArray(atomicClaims) && atomicClaims.length > 0) {
    for (let i = 0; i < atomicClaims.length; i++) {
      const subClaim = atomicClaims[i];
      if (!subClaim || typeof subClaim !== 'object') {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `ATOMIC_CLAIM_FAILED_AT_INDEX_${i}: INVALID_ATOMIC_CLAIM_OBJECT`,
          failedIndex: i,
          allowed: false
        });
      }
      const subText = String(subClaim.text || subClaim.claimText || '').trim();
      if (!subText) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `ATOMIC_CLAIM_FAILED_AT_INDEX_${i}: EMPTY_CLAIM_TEXT`,
          failedIndex: i,
          allowed: false
        });
      }
      const subResult = validateCandidateClaim({
        claimText: subText,
        claimType: subClaim.claimType || claimType,
        leadId,
        tenantId: tid,
        evidenceIds: subClaim.evidenceIds || [],
        signalIds: subClaim.signalIds || [],
        context: subClaim.context || context,
        dbInstance,
        persist,
        persistRejected,
        campaignId,
        campaignTouchId,
        generatorType,
        modelName,
        modelVersion,
        promptTemplateVersion
      });
      if (!subResult.allowed || subResult.status !== CLAIM_VALIDATION_DECISIONS.SUPPORTED) {
        return finalizeResult({
          status: subResult.status,
          reason: `ATOMIC_CLAIM_FAILED_AT_INDEX_${i}: ${subResult.reason}`,
          failedIndex: i,
          failedClaim: subText,
          allowed: false
        });
      }
    }
    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
      reason: 'ALL_ATOMIC_CLAIMS_INDEPENDENTLY_VALIDATED',
      atomicClaimsCount: atomicClaims.length,
      allowed: true
    });
  }

  // 1. Text & Basic Parameter Checks
  if (!text) {
    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
      reason: 'EMPTY_CLAIM_TEXT',
      allowed: false
    });
  }

  // 2. Tenant & Lead Ownership Verification
  const ownership = dbInstance.validateLeadOwnership(leadId, tid);
  if (!ownership || !ownership.valid || !ownership.lead) {
    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
      reason: 'LEAD_TENANT_MISMATCH',
      allowed: false
    });
  }

  // 3. Blacklist / Anti-Hallucination Regex Scan
  for (const pattern of FORBIDDEN_UNSUPPORTED_PATTERNS) {
    if (pattern.test(text)) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'FORBIDDEN_UNSUPPORTED_METRIC_OR_PROMISE',
        matchedPattern: pattern.toString(),
        allowed: false
      });
    }
  }

  // 4. Claim Classification & Unified Taxonomy Routing
  const upperType = String(claimType || '').toUpperCase().trim();
  if (upperType === CLAIM_CLASSIFICATIONS.UNSUPPORTED_CLAIM || upperType === CLAIM_TYPES.UNSUPPORTED_CLAIM) {
    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
      reason: 'UNSUPPORTED_CLAIM_CLASSIFICATION',
      allowed: false
    });
  }

  // 4b. Benign Agency Courtesy / Agency Identity
  if (upperType === CLAIM_TYPES.BENIGN_AGENCY) {
    const isBenign = classifyProposition(text) === PROPOSITION_TYPES.BENIGN_AGENCY;
    if (isBenign) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
        reason: 'BENIGN_AGENCY_VERIFIED',
        provenance: FACT_PROVENANCE_LEVELS.VERIFIED,
        confidenceScore: 1.0,
        claimType: CLAIM_TYPES.BENIGN_AGENCY,
        allowed: true
      }, []);
    }
    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
      reason: 'NOT_BENIGN_AGENCY_PHRASING',
      allowed: false
    });
  }

  // Routing flags for verified and inferred taxonomy types
  const isCoreAttr = (upperType === CLAIM_TYPES.CORE_ATTRIBUTE || context.isStandardLeadAttribute === true);
  const isVerifiedFact = (upperType === CLAIM_CLASSIFICATIONS.VERIFIED_FACT || upperType === CLAIM_TYPES.TECHNICAL_FACT || isCoreAttr);
  const isQualifiedInference = (upperType === CLAIM_CLASSIFICATIONS.QUALIFIED_INFERENCE || upperType === CLAIM_TYPES.CONSULTATIVE_OPPORTUNITY || upperType === CLAIM_TYPES.OPERATIONAL_ASSERTION);

  // 5. Evidence Verification for VERIFIED_FACT
  if (isVerifiedFact) {
    // If claim relies on standard verified Google Places lead properties (businessName, location, rating)
    if (isCoreAttr) {
      // Must not contain unevidenced operational accusations
      const clauses = decomposeCandidateClaim(text);
      for (const cl of clauses) {
        const evalRes = evaluateClauseCoverage(cl, ownership.lead, [], [], context);
        if (evalRes.hasOperationalAssertion) {
          return finalizeResult({
            status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
            reason: 'CANNOT_BYPASS_OPERATIONAL_ASSERTION_WITH_STANDARD_LEAD_ATTRIBUTE',
            uncoveredClause: cl,
            allowed: false
          });
        }
        if (!evalRes.matchesCoreAttribute && !evalRes.isBenignAgencyPhrasing) {
          return finalizeResult({
            status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
            reason: `STANDARD_LEAD_ATTRIBUTE_DOES_NOT_COVER_ASSERTION: "${cl}"`,
            uncoveredClause: cl,
            allowed: false
          });
        }
      }

      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
        reason: 'SUPPORTED_BY_VERIFIED_LEAD_CORE_ATTRIBUTES',
        provenance: FACT_PROVENANCE_LEVELS.VERIFIED,
        confidenceScore: 1.0,
        claimType: CLAIM_TYPES.CORE_ATTRIBUTE,
        allowed: true
      }, []);
    }

    if (!evidenceIds || evidenceIds.length === 0) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'MISSING_PROVENANCE_EVIDENCE_FOR_VERIFIED_FACT',
        allowed: false
      });
    }

    const now = new Date();
    const evaluatedEvidence = [];

    for (const evdId of evidenceIds) {
      const evd = dbInstance.sqlite.prepare(`
        SELECT * FROM lead_evidence WHERE id = ? AND lead_id = ? AND tenant_id = ?
      `).get(evdId, leadId, tid);

      if (!evd) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `EVIDENCE_NOT_FOUND_OR_TENANT_MISMATCH: ${evdId}`,
          allowed: false
        });
      }

      // Hard Invariant: INFERRED or UNKNOWN can NEVER support a VERIFIED_FACT
      if (evd.provenance_type !== FACT_PROVENANCE_LEVELS.VERIFIED) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `CANNOT_PROMOTE_INFERRED_EVIDENCE_TO_VERIFIED_FACT: evidence ${evdId} has provenance "${evd.provenance_type}"`,
          allowed: false
        });
      }

      // Freshness check
      if (evd.expires_at && new Date(evd.expires_at) < now) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `EVIDENCE_EXPIRED_STALE: evidence ${evdId} expired at ${evd.expires_at}`,
          allowed: false
        });
      }

      // Confidence threshold for verified facts (must be >= 0.85)
      if ((evd.confidence_score || 0) < 0.85) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.REQUIRES_REVIEW,
          reason: `EVIDENCE_LOW_CONFIDENCE: evidence ${evdId} confidence is ${evd.confidence_score} (required >= 0.85)`,
          allowed: false
        });
      }

      evaluatedEvidence.push(evd);
    }

    // --- STEP 7D-1: ATOMIC CLAUSE DECOMPOSITION & COVERAGE CHECK ---
    const clauses = decomposeCandidateClaim(text);

    // Verify that at least one clause matches the provided evaluatedEvidence
    let anyEvidenceMatched = false;
    for (const clause of clauses) {
      const cov = evaluateClauseCoverage(clause, ownership.lead, evaluatedEvidence, [], context);
      if (cov.matchesEvidence) {
        anyEvidenceMatched = true;
      }
      if (!cov.isCovered) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `COMPOUND_CLAIM_UNCOVERED_ASSERTION: Clause "${clause}" is not covered by verified evidence.`,
          uncoveredClause: clause,
          evaluatedClausesCount: clauses.length,
          allowed: false
        });
      }
    }

    if (!anyEvidenceMatched && evaluatedEvidence.length > 0) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'EVIDENCE_DOES_NOT_MATCH_CLAIM_PROPOSITIONS',
        allowed: false
      });
    }

    // Step 7G-1 Weakest-link confidence calculation:
    const minConf = evaluatedEvidence.length > 0
      ? Math.min(...evaluatedEvidence.map(e => (e.confidence_score !== null && e.confidence_score !== undefined) ? Number(e.confidence_score) : 0.0))
      : 1.0;

    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
      reason: 'VERIFIED_EVIDENCE_CONFIRMED',
      provenance: FACT_PROVENANCE_LEVELS.VERIFIED,
      confidenceScore: minConf,
      claimType: CLAIM_TYPES.TECHNICAL_FACT,
      evaluatedEvidenceCount: evaluatedEvidence.length,
      evaluatedClausesCount: clauses.length,
      allowed: true
    }, evaluatedEvidence);
  }

  // 6. Inferred Claim Handling (QUALIFIED_INFERENCE)
  if (isQualifiedInference) {
    if ((!evidenceIds || evidenceIds.length === 0) && (!signalIds || signalIds.length === 0)) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'MISSING_SUPPORTING_EVIDENCE_OR_SIGNAL_FOR_INFERENCE',
        allowed: false
      });
    }

    // Must verify evidence exists and belongs to lead and tenant
    const now = new Date();
    const evaluatedEvidence = [];
    for (const evdId of (evidenceIds || [])) {
      const evd = dbInstance.sqlite.prepare(`
        SELECT * FROM lead_evidence WHERE id = ? AND lead_id = ? AND tenant_id = ?
      `).get(evdId, leadId, tid);
      if (!evd) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `EVIDENCE_NOT_FOUND_OR_TENANT_MISMATCH: ${evdId}`,
          allowed: false
        });
      }
      if (evd.expires_at && new Date(evd.expires_at) < now) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `EVIDENCE_EXPIRED_STALE: evidence ${evdId} expired at ${evd.expires_at}`,
          allowed: false
        });
      }
      evaluatedEvidence.push(evd);
    }

    // Inferences CANNOT make definitive proof claims or unevidenced operational accusations
    const definitiveRegex = /\b(?:proves?|proven|guarantee[ds]?|certainly|definitely|fact is|will result in|results in|is causing|is costing|will cause|causes|responsible for)\b/i;
    if (definitiveRegex.test(text)) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'INFERENCE_CANNOT_MAKE_DEFINITIVE_OR_UNPROVEN_ACCUSATIONS',
        allowed: false
      });
    }

    // Operational accusations in inferences without operational evidence or signals
    const clauses = decomposeCandidateClaim(text);
    const hasAnyOperationalAssertion = clauses.some(cl => {
      const evalRes = evaluateClauseCoverage(cl, ownership.lead, evaluatedEvidence, [], context);
      return evalRes.hasOperationalAssertion;
    }) || prospectOperationalIndicators.some(p => p.test(text)) || operationalOutcomeOrImpactRegex.test(text);

    if (hasAnyOperationalAssertion) {
      const hasOperationalEvidence = evaluatedEvidence.some(e => ['OPERATIONAL_EVIDENCE', 'PAIN_POINT_SIGNAL', 'WORKFLOW_EVIDENCE'].includes(e.evidence_type));
      const hasOperationalSignal = (signalIds || []).length > 0;
      if (!hasOperationalEvidence && !hasOperationalSignal) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: 'TECHNICAL_EVIDENCE_CANNOT_AUTHORIZE_OPERATIONAL_INFERENCE',
          allowed: false
        });
      }
    }

    let anyEvidenceMatched = false;
    for (const cl of clauses) {
      const evalRes = evaluateClauseCoverage(cl, ownership.lead, evaluatedEvidence, [], context);
      if (evalRes.matchesEvidence || evalRes.matchesSignal || evalRes.matchesCoreAttribute) {
        anyEvidenceMatched = true;
      }
      if (evalRes.hasOperationalAssertion) {
        const relevantOpEvd = evaluatedEvidence.find(e =>
          ['OPERATIONAL_EVIDENCE', 'PAIN_POINT_SIGNAL', 'WORKFLOW_EVIDENCE'].includes(e.evidence_type) &&
          isOperationalEvidenceRelevant(cl, e)
        );
        const hasOperationalSignal = (signalIds || []).length > 0;
        if (!relevantOpEvd && !hasOperationalSignal) {
          const hasAnyOpEvd = evaluatedEvidence.some(e => ['OPERATIONAL_EVIDENCE', 'PAIN_POINT_SIGNAL', 'WORKFLOW_EVIDENCE'].includes(e.evidence_type));
          if (hasAnyOpEvd) {
            return finalizeResult({
              status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
              reason: `OPERATIONAL_EVIDENCE_MISMATCH_PROPOSITION: Clause "${cl}" is not supported by the provided operational evidence.`,
              uncoveredClause: cl,
              allowed: false
            });
          } else {
            return finalizeResult({
              status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
              reason: 'TECHNICAL_EVIDENCE_CANNOT_AUTHORIZE_OPERATIONAL_INFERENCE',
              uncoveredClause: cl,
              allowed: false
            });
          }
        }
      }
      if (!evalRes.isCovered) {
        return finalizeResult({
          status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
          reason: `COMPOUND_CLAIM_UNCOVERED_ASSERTION: Clause "${cl}" is not covered by verified evidence.`,
          uncoveredClause: cl,
          allowed: false
        });
      }
    }

    if (!anyEvidenceMatched && evaluatedEvidence.length > 0) {
      return finalizeResult({
        status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
        reason: 'EVIDENCE_DOES_NOT_MATCH_CLAIM_PROPOSITIONS',
        allowed: false
      });
    }

    // Step 7G-1 Weakest-link confidence calculation:
    const minConf = evaluatedEvidence.length > 0
      ? Math.min(...evaluatedEvidence.map(e => (e.confidence_score !== null && e.confidence_score !== undefined) ? Number(e.confidence_score) : 0.0))
      : 0.85;

    const resolvedClaimType = hasAnyOperationalAssertion
      ? CLAIM_TYPES.OPERATIONAL_ASSERTION
      : CLAIM_TYPES.CONSULTATIVE_OPPORTUNITY;

    return finalizeResult({
      status: CLAIM_VALIDATION_DECISIONS.SUPPORTED,
      reason: 'QUALIFIED_INFERENCE_SUPPORTED',
      provenance: FACT_PROVENANCE_LEVELS.INFERRED,
      confidenceScore: minConf,
      claimType: resolvedClaimType,
      allowed: true
    }, evaluatedEvidence);
  }

  // Fail-closed default
  return finalizeResult({
    status: CLAIM_VALIDATION_DECISIONS.UNSUPPORTED,
    reason: `UNKNOWN_CLAIM_TYPE: ${upperType}`,
    allowed: false
  });
}

/**
 * Convenience wrapper to validate and persist a candidate claim atomically
 * @param {object} params
 * @returns {object} validation and persistence result
 */
export function validateAndPersistCandidateClaim(params = {}) {
  return validateCandidateClaim({ ...params, persist: true });
}

/**
 * Deterministic Templates Matrix
 * Structured by: Channel -> Tier -> Touch Number -> Purpose
 */
const DETERMINISTIC_TEMPLATES = {
  WHATSAPP: {
    VERIFIED_ENRICHED: {
      1: {
        INITIAL_OUTREACH: 'Hi {{business_name}} team! We noticed your great {{rating_display}} reputation on Google Maps in {{location}}.\n\nWe build custom 24/7 AI WhatsApp Assistants that help service businesses streamline enquiry qualification and appointment bookings.\n\nWould you be open for a quick 2-minute call this week to see a live preview?\n\nBest regards,\n{{sender_founders}} | {{sender_agency}}\n{{opt_out_notice}}'
      },
      2: {
        VALUE_ADD_FOLLOWUP: 'Hi {{business_name}} team, following up on our note regarding enquiry automation for your team in {{location}}.\n\nWe recently created an interactive workflow demonstration of how an automated WhatsApp copilot handles after-hours patient/client requests.\n\nHappy to share a 60-second preview if you have a quick minute.\n\nWarm regards,\n{{sender_founders}}\n{{opt_out_notice}}'
      },
      3: {
        POLITE_CLOSE: 'Hi {{business_name}} team, closing the loop here. We know you are busy managing operations in {{location}}.\n\nIf you ever need automated WhatsApp enquiry booking or CRM qualification in the future, feel free to keep our contact saved.\n\nWishing you continued success!\n{{sender_founders}} | {{sender_agency}}\n{{opt_out_notice}}'
      }
    },
    BASE_VERIFIED_ONLY: {
      1: {
        INITIAL_OUTREACH: 'Hi {{business_name}} team, reaching out to you in {{location}}.\n\nWe help growing businesses automate customer inquiries and appointment scheduling via WhatsApp so no inbound client is missed.\n\nAre you open for a quick 2-minute call this week?\n\nBest regards,\n{{sender_founders}} | {{sender_agency}}\n{{opt_out_notice}}'
      },
      2: {
        VALUE_ADD_FOLLOWUP: 'Hi {{business_name}} team, quick follow up regarding automated customer follow-ups for your operations in {{location}}.\n\nWould love to share a quick 1-minute overview of how our assistants work whenever convenient for you.\n\nBest regards,\n{{sender_founders}}\n{{opt_out_notice}}'
      },
      3: {
        POLITE_CLOSE: 'Hi {{business_name}} team, I will not follow up further. Wishing your business in {{location}} all the best.\n\nFeel free to connect whenever you explore customer automation.\n\nBest regards,\n{{sender_founders}} | {{sender_agency}}\n{{opt_out_notice}}'
      }
    }
  },
  TELEGRAM: {
    VERIFIED_ENRICHED: {
      1: {
        INITIAL_OUTREACH: '<b>🎯 Business Enquiry Automation for {{business_name}}</b>\n\nHello team, we noticed your {{rating_display}} presence in {{location}}.\n\nWe develop tailored 24/7 conversational copilots that instantly qualify inbound inquiries and route bookings directly to your team.\n\nWould you be interested in a quick 2-minute introductory chat this week?\n\nBest regards,\n<b>{{sender_founders}}</b> | {{sender_agency}}'
      },
      2: {
        VALUE_ADD_FOLLOWUP: '<b>Following up — {{business_name}}</b>\n\nQuick follow-up for your team in {{location}}. We prepared a brief summary on how automated inquiry routing reduces lead response delays.\n\nLet us know if you would like us to send over the 1-minute breakdown.\n\nBest regards,\n{{sender_founders}}'
      },
      3: {
        POLITE_CLOSE: '<b>Closing note — {{business_name}}</b>\n\nUnderstood that timing may not be right for your operations in {{location}}. We will keep this on hold.\n\nWishing you and the team continued growth!\n\nBest regards,\n{{sender_founders}} | {{sender_agency}}'
      }
    },
    BASE_VERIFIED_ONLY: {
      1: {
        INITIAL_OUTREACH: '<b>🎯 Opportunity for {{business_name}}</b>\n\nHello team in {{location}}, we provide business workflow automation to handle after-hours inquiries and client scheduling automatically.\n\nOpen for a quick 2-minute introductory chat this week?\n\nBest regards,\n<b>{{sender_founders}}</b> | {{sender_agency}}'
      },
      2: {
        VALUE_ADD_FOLLOWUP: '<b>Quick follow-up — {{business_name}}</b>\n\nChecking in regarding conversational automation for your business in {{location}}.\n\nHappy to share a 1-minute walkthrough whenever your schedule allows.\n\nBest regards,\n{{sender_founders}}'
      },
      3: {
        POLITE_CLOSE: '<b>Closing note for {{business_name}}</b>\n\nWill step back here. Wishing your operations in {{location}} great success.\n\nBest regards,\n{{sender_founders}} | {{sender_agency}}'
      }
    }
  },
  EMAIL: {
    VERIFIED_ENRICHED: {
      1: {
        INITIAL_OUTREACH: {
          subject: 'Quick question for {{business_name}}',
          body: 'Hi {{business_name}} team,\n\nI came across your business in {{location}} and wanted to congratulate you on your {{rating_display}} Google rating.\n\nWe build custom 24/7 AI Copilots that qualify customer inquiries and automate appointment bookings so your team never misses high-value clients.\n\nWould you be open for a quick 2-minute introductory call this week?\n\nWarm regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\nDirect: {{sender_phone}} | {{sender_website}}\n\n---\n{{opt_out_notice}}'
        }
      },
      2: {
        VALUE_ADD_FOLLOWUP: {
          subject: 'Idea for {{business_name}} follow-up',
          body: 'Hi {{business_name}} team,\n\nFollowing up on my previous note regarding customer inquiry automation for your operations in {{location}}.\n\nWe put together a brief workflow showing how automated conversational booking captures after-hours inquiries with zero additional staff burden.\n\nWould it be helpful if I shared a 60-second screen-share this Thursday?\n\nBest regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\n{{sender_website}}\n\n---\n{{opt_out_notice}}'
        }
      },
      3: {
        POLITE_CLOSE: {
          subject: 'Closing note for {{business_name}}',
          body: 'Hi {{business_name}} team,\n\nI assume this is not a priority right now, which I completely understand. I will close the loop here so I do not crowd your inbox.\n\nIf you ever look to streamline customer inquiries or bookings for {{business_name}} in the future, feel free to reach back out.\n\nWishing you all the best with your business in {{location}}.\n\nWarm regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\n\n---\n{{opt_out_notice}}'
        }
      }
    },
    BASE_VERIFIED_ONLY: {
      1: {
        INITIAL_OUTREACH: {
          subject: 'Partnership idea for {{business_name}}',
          body: 'Hi {{business_name}} team,\n\nI came across your operations in {{location}} and wanted to reach out.\n\nWe help growing service businesses automate customer inquiry handling and qualification, ensuring inquiries are answered instantly 24/7.\n\nWould you be open for a quick 2-minute introductory conversation this week?\n\nWarm regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\nDirect: {{sender_phone}} | {{sender_website}}\n\n---\n{{opt_out_notice}}'
        }
      },
      2: {
        VALUE_ADD_FOLLOWUP: {
          subject: 'Quick follow up for {{business_name}}',
          body: 'Hi {{business_name}} team,\n\nFollowing up on my note regarding automated customer inquiry routing for {{business_name}} in {{location}}.\n\nHappy to share a 1-minute demo if you are open to exploring ways to capture more inbound opportunities.\n\nBest regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\n\n---\n{{opt_out_notice}}'
        }
      },
      3: {
        POLITE_CLOSE: {
          subject: 'Final note for {{business_name}}',
          body: 'Hi {{business_name}} team,\n\nI understand your team is busy and timing may not align. I will close the loop here.\n\nWishing {{business_name}} continued success in {{location}}.\n\nBest regards,\n\n{{sender_founders}}\nCo-founders, {{sender_agency}}\n\n---\n{{opt_out_notice}}'
        }
      }
    }
  }
};

/**
 * Pure Deterministic Touch Message Generator
 * Generates an auditable, grounded, channel-constrained draft WITHOUT calling an LLM.
 *
 * @param {object} params
 * @returns {object} Deterministic draft result
 */
export function generateDeterministicTouchMessage({
  leadId,
  touchNumber = 1,
  channel = 'WHATSAPP',
  purpose = 'INITIAL_OUTREACH',
  tenantId = 'default',
  dbInstance = defaultDb,
  senderOverrides = {}
}) {
  const tid = String(tenantId || 'default').trim();
  const upperChannel = String(channel || '').toUpperCase().trim();
  const touchNum = parseInt(touchNumber, 10) || 1;
  const upperPurpose = String(purpose || 'INITIAL_OUTREACH').toUpperCase().trim();

  if (touchNum < 1 || touchNum > 3) {
    return {
      success: false,
      error: `INVALID_TOUCH_NUMBER: ${touchNumber}. Must be between 1 and 3.`
    };
  }

  // 1. Extract Allowed Material (Strict Tenant Isolation)
  const material = extractAllowedClaimMaterial(leadId, tid, dbInstance);
  if (!material.allowed || material.tier === INTELLIGENCE_TIERS.INSUFFICIENT) {
    return {
      success: false,
      error: `INSUFFICIENT_LEAD_INTELLIGENCE: ${material.reason || 'Missing required core lead attributes'}`
    };
  }

  const verified = material.verifiedFacts;
  const tier = material.tier; // 'VERIFIED_ENRICHED' or 'BASE_VERIFIED_ONLY'

  // 2. Resolve Channel Templates
  const channelTemplates = DETERMINISTIC_TEMPLATES[upperChannel];
  if (!channelTemplates) {
    return {
      success: false,
      error: `UNSUPPORTED_CHANNEL: "${channel}". Supported channels: EMAIL, WHATSAPP, TELEGRAM.`
    };
  }

  const tierTemplates = channelTemplates[tier] || channelTemplates[INTELLIGENCE_TIERS.BASE_VERIFIED_ONLY];
  const touchTemplates = tierTemplates[touchNum];
  if (!touchTemplates || !touchTemplates[upperPurpose]) {
    return {
      success: false,
      error: `NO_TEMPLATE_FOR_TOUCH: channel=${upperChannel}, tier=${tier}, touch=${touchNum}, purpose=${upperPurpose}`
    };
  }

  const rawTemplate = touchTemplates[upperPurpose];

  // 3. Prepare Merge Variables
  const sender = { ...DEFAULT_SENDER, ...senderOverrides };
  const ratingDisplay = verified.rating ? `${verified.rating}★` : 'strong';
  const optOutNotice = upperChannel === 'WHATSAPP' ? sender.optOutNoticeWhatsApp : sender.optOutNoticeEmail;

  const replacements = {
    business_name: verified.businessName,
    location: verified.location,
    rating_display: ratingDisplay,
    sender_founders: sender.coFounders,
    sender_agency: sender.agencyName,
    sender_phone: sender.phone,
    sender_website: sender.website,
    opt_out_notice: optOutNotice
  };

  const applyReplacements = (templateStr) => {
    let rendered = templateStr;
    for (const [key, val] of Object.entries(replacements)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, val !== null && val !== undefined ? String(val) : '');
    }
    return rendered;
  };

  let renderedSubject = null;
  let renderedBody = '';

  if (upperChannel === 'EMAIL') {
    renderedSubject = applyReplacements(rawTemplate.subject);
    renderedBody = applyReplacements(rawTemplate.body);
  } else {
    renderedBody = applyReplacements(rawTemplate);
  }

  // 4. Fail-Closed Placeholder Validation: Ensure no unresolved {{...}} tag remains
  const unreplacedTagPattern = /\{\{[\w_]+\}\}/;
  if (unreplacedTagPattern.test(renderedBody) || (renderedSubject && unreplacedTagPattern.test(renderedSubject))) {
    return {
      success: false,
      error: 'UNRESOLVED_TEMPLATE_PLACEHOLDERS_DETECTED',
      renderedBody
    };
  }

  // 5. Anti-Hallucination & Blacklist Scan on rendered output
  for (const pattern of FORBIDDEN_UNSUPPORTED_PATTERNS) {
    if (pattern.test(renderedBody) || (renderedSubject && pattern.test(renderedSubject))) {
      return {
        success: false,
        error: 'RENDERED_TEMPLATE_VIOLATED_SAFETY_BLACKLIST',
        matchedPattern: pattern.toString()
      };
    }
  }

  // 6. Compute Cryptographic Content Hash
  const hashPayload = `${upperChannel}|${touchNum}|${upperPurpose}|${renderedSubject || ''}|${renderedBody}`;
  const contentHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  return {
    success: true,
    leadId,
    tenantId: tid,
    channel: upperChannel,
    touchNumber: touchNum,
    purpose: upperPurpose,
    intelligenceTier: tier,
    subject: renderedSubject,
    body: renderedBody,
    contentHash,
    generationMethod: 'DETERMINISTIC_TEMPLATE',
    usedFacts: {
      businessName: verified.businessName,
      location: verified.location,
      rating: verified.rating
    },
    usedEvidenceCount: material.evidenceCount,
    usedSignalCount: material.signalCount
  };
}

// ============================================================================
// PHASE 2 STEP 7G-3: CANONICAL FACT-CLAIM MERKLE ROOT SEALING & VERIFICATION
// ============================================================================

/**
 * Status codes for Claim-Root verification
 */
export const CLAIM_ROOT_VERIFICATION_STATUS = Object.freeze({
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOT_SEALED: 'NOT_SEALED',
  INVALID_SCOPE: 'INVALID_SCOPE',
  MISSING_CLAIM: 'MISSING_CLAIM',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE'
});

/**
 * Deterministic Empty Tree Constants
 */
export const EMPTY_EVIDENCE_SUBROOT = 'evroot_0000000000000000000000000000000000000000000000000000000000000000';
export const EMPTY_CLAIMS_ROOT = 'clmroot_0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Canonical string sanitizer: trim, NFC normalize, lowercase.
 * Handles null/undefined with standard '__NULL__' token.
 */
function canonStr(val) {
  if (val === null || val === undefined) return '__NULL__';
  return String(val).normalize('NFC').trim().toLowerCase();
}

/**
 * Canonical float formatter: formats number to exact 4 decimal places.
 */
function canonScore(val) {
  const num = Number(val);
  if (isNaN(num)) return '0.0000';
  return num.toFixed(4);
}

/**
 * Deterministic Pairwise Merkle Tree Reducer.
 * Sorts/pairs leaves deterministically.
 * Odd-node rule: if length is odd, the last node is paired with itself.
 *
 * @param {Array<string>} leaves - Hex string hashes
 * @param {string} prefix - Optional prefix for the root hash
 * @returns {string} Root hash hex
 */
export function computeMerkleRootFromLeaves(leaves = [], prefix = '') {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return prefix ? `${prefix}0000000000000000000000000000000000000000000000000000000000000000` : crypto.createHash('sha256').update('__EMPTY_LEAVES__').digest('hex');
  }

  if (leaves.length === 1) {
    return prefix ? `${prefix}${leaves[0]}` : leaves[0];
  }

  let currentLevel = [...leaves];
  while (currentLevel.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = (i + 1 < currentLevel.length) ? currentLevel[i + 1] : left; // Odd-node rule: duplicate with itself
      const combined = `${left}|${right}`;
      const parent = crypto.createHash('sha256').update(combined).digest('hex');
      nextLevel.push(parent);
    }
    currentLevel = nextLevel;
  }

  return prefix ? `${prefix}${currentLevel[0]}` : currentLevel[0];
}

/**
 * Level 1: Evidence Leaf computation
 * Computes deterministic hash for a single lead_evidence row.
 *
 * @param {object} evidence
 * @returns {string} SHA-256 hex string
 */
export function computeEvidenceLeaf(evidence = {}) {
  const evId = String(evidence.id || '').trim();
  const evType = canonStr(evidence.evidence_type);
  const srcName = canonStr(evidence.source_name);
  const srcUrl = canonStr(evidence.source_url);
  const evText = canonStr(evidence.evidence_text);
  const extVal = canonStr(evidence.extracted_value);
  const conf = canonScore(evidence.confidence_score);
  const prov = canonStr(evidence.provenance_type);
  const extMethod = canonStr(evidence.extraction_method);

  const preimage = `EV_LEAF|${evId}|${evType}|${srcName}|${srcUrl}|${evText}|${extVal}|${conf}|${prov}|${extMethod}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

/**
 * Level 2: Evidence Sub-Root computation
 * Aggregates evidence leaves for a claim into a Merkle root.
 *
 * @param {Array<object>} evidenceList
 * @returns {string} SHA-256 hex string (or EMPTY_EVIDENCE_SUBROOT)
 */
export function computeEvidenceSubRoot(evidenceList = []) {
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
    return EMPTY_EVIDENCE_SUBROOT;
  }

  // Deduplicate and sort deterministically by evidence.id ASC
  const uniqueMap = new Map();
  for (const ev of evidenceList) {
    if (ev && ev.id) uniqueMap.set(ev.id, ev);
  }

  const sortedEvidence = Array.from(uniqueMap.values()).sort((a, b) =>
    String(a.id).localeCompare(String(b.id), 'en', { numeric: false })
  );

  const leaves = sortedEvidence.map(ev => computeEvidenceLeaf(ev));
  return computeMerkleRootFromLeaves(leaves, 'evroot_');
}

/**
 * Level 3: Claim Leaf computation
 * Computes deterministic hash for a single campaign_claim record, binding its EvidenceSubRoot.
 *
 * @param {object} claim
 * @param {string} evidenceSubRoot
 * @returns {string} SHA-256 hex string
 */
export function computeClaimLeaf(claim = {}, evidenceSubRoot = EMPTY_EVIDENCE_SUBROOT) {
  const claimId = String(claim.id || '').trim();
  const normHash = claim.claim_text ? computeNormalizedClaimHash(claim.claim_text) : String(claim.normalized_claim_hash || '').trim();
  const claimType = canonStr(claim.claim_type);
  const provLevel = canonStr(claim.provenance_level);
  const conf = canonScore(claim.confidence_score);
  const valStatus = canonStr(claim.validation_status);
  const subRoot = String(evidenceSubRoot || EMPTY_EVIDENCE_SUBROOT).trim();

  const preimage = `CLM_LEAF|${claimId}|${normHash}|${claimType}|${provLevel}|${conf}|${valStatus}|${subRoot}`;
  return crypto.createHash('sha256').update(preimage).digest('hex');
}

/**
 * Level 4: Touch Claim-Root computation
 * Pure deterministic calculation over a touch and its associated claims with evidence.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.leadId
 * @param {string} params.campaignTouchId
 * @param {Array<object>} params.claimsWithEvidence - Array of { claim, evidence: [...] }
 * @returns {string} SHA-256 touch claims root hex string prefixed with 'clmroot_'
 */
export function computeTouchClaimsRoot({
  tenantId = 'default',
  leadId,
  campaignTouchId,
  claimsWithEvidence = []
}) {
  const tid = String(tenantId || 'default').trim();
  const lid = String(leadId || '').trim();
  const touchId = String(campaignTouchId || '').trim();

  if (!Array.isArray(claimsWithEvidence) || claimsWithEvidence.length === 0) {
    // Deterministic empty root binding the tenant, lead, and touch
    const emptyPreimage = `TOUCH_CLM_ROOT|${tid}|${lid}|${touchId}|${EMPTY_CLAIMS_ROOT}`;
    const hex = crypto.createHash('sha256').update(emptyPreimage).digest('hex');
    return `clmroot_${hex}`;
  }

  // Deduplicate and sort claims by claim.id ASC
  const uniqueClaims = new Map();
  for (const item of claimsWithEvidence) {
    const clm = item.claim || item;
    if (clm && clm.id) {
      uniqueClaims.set(clm.id, {
        claim: clm,
        evidence: item.evidence || []
      });
    }
  }

  const sortedItems = Array.from(uniqueClaims.values()).sort((a, b) =>
    String(a.claim.id).localeCompare(String(b.claim.id), 'en', { numeric: false })
  );

  const claimLeaves = sortedItems.map(item => {
    const subRoot = computeEvidenceSubRoot(item.evidence);
    return computeClaimLeaf(item.claim, subRoot);
  });

  const claimsMerkleRoot = computeMerkleRootFromLeaves(claimLeaves, '');
  const touchPreimage = `TOUCH_CLM_ROOT|${tid}|${lid}|${touchId}|${claimsMerkleRoot}`;
  const rootHex = crypto.createHash('sha256').update(touchPreimage).digest('hex');
  return `clmroot_${rootHex}`;
}

/**
 * Computes the authoritative Claim-Root for a touch directly from the database.
 * Strictly enforces tenant, lead, and touch scoping.
 *
 * @param {string} touchId
 * @param {string} tenantId
 * @param {object} [dbInstance]
 * @returns {object} { success, claimsRootHash, claimCount, error }
 */
export function generateAuthoritativeTouchClaimsRoot(touchId, tenantId = 'default', dbInstance = defaultDb) {
  const tid = String(tenantId || 'default').trim();
  if (!touchId) {
    return { success: false, error: 'TOUCH_ID_REQUIRED', claimsRootHash: null };
  }

  // 1. Fetch touch to identify lead_id
  let touch = null;
  if (dbInstance.sqlite) {
    touch = dbInstance.sqlite.prepare(
      'SELECT id, campaign_id, lead_id, tenant_id FROM campaign_touches WHERE id = ? AND tenant_id = ?'
    ).get(touchId, tid);
  } else if (dbInstance.getCampaignTouch) {
    touch = dbInstance.getCampaignTouch(touchId, tid);
  }

  if (!touch) {
    return { success: false, error: 'TOUCH_NOT_FOUND', claimsRootHash: null };
  }

  // 2. Fetch all claims associated with this touch
  let claims = [];
  if (dbInstance.getClaimsForTouch) {
    claims = dbInstance.getClaimsForTouch(touchId, tid);
  } else if (dbInstance.sqlite) {
    claims = dbInstance.sqlite.prepare(
      'SELECT * FROM campaign_claims WHERE campaign_touch_id = ? AND tenant_id = ? ORDER BY id ASC'
    ).all(touchId, tid);
  }

  // 3. For each claim, fetch linked evidence and validate scope
  const claimsWithEvidence = [];
  for (const clm of claims) {
    // Verify claim tenant and lead
    if (clm.tenant_id !== tid || clm.lead_id !== touch.lead_id) {
      return {
        success: false,
        error: `INVALID_SCOPE: Claim "${clm.id}" does not match tenant/lead scope`,
        claimsRootHash: null
      };
    }

    let evList = [];
    if (dbInstance.getClaimEvidence) {
      evList = dbInstance.getClaimEvidence(clm.id, tid);
    } else if (dbInstance.sqlite) {
      evList = dbInstance.sqlite.prepare(`
        SELECT e.* FROM lead_evidence e
        JOIN campaign_claim_evidence cce ON e.id = cce.evidence_id
        WHERE cce.claim_id = ? AND cce.tenant_id = ?
        ORDER BY e.id ASC
      `).all(clm.id, tid);
    }

    // Verify all linked evidence records belong strictly to the SAME tenant and SAME lead
    for (const ev of evList) {
      if (ev.tenant_id !== tid || ev.lead_id !== touch.lead_id) {
        return {
          success: false,
          error: `INVALID_SCOPE: Evidence "${ev.id}" violates tenant/lead isolation boundary`,
          claimsRootHash: null
        };
      }
    }

    claimsWithEvidence.push({
      claim: clm,
      evidence: evList
    });
  }

  const claimsRootHash = computeTouchClaimsRoot({
    tenantId: tid,
    leadId: touch.lead_id,
    campaignTouchId: touch.id,
    claimsWithEvidence
  });

  return {
    success: true,
    claimsRootHash,
    claimCount: claimsWithEvidence.length
  };
}

/**
 * Pure Read-Only Verification API for Snapshot Claim-Root.
 * Recomputes the root from the current database state and compares against snapshot.claims_root_hash.
 *
 * @param {string} snapshotId
 * @param {string} tenantId
 * @param {object} [dbInstance]
 * @returns {object} { status, storedHash, recomputedHash, details }
 */
export function verifySnapshotClaimsRoot(snapshotId, tenantId = 'default', dbInstance = defaultDb) {
  const tid = String(tenantId || 'default').trim();
  if (!snapshotId) {
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.INVALID_SCOPE,
      error: 'SNAPSHOT_ID_REQUIRED'
    };
  }

  // 1. Fetch snapshot
  let snapshot = null;
  if (dbInstance.getApprovedSnapshot) {
    snapshot = dbInstance.getApprovedSnapshot(snapshotId, tid);
  } else if (dbInstance.sqlite) {
    snapshot = dbInstance.sqlite.prepare(
      'SELECT * FROM campaign_approved_snapshots WHERE id = ? AND tenant_id = ?'
    ).get(snapshotId, tid);
  }

  if (!snapshot) {
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.INVALID_SCOPE,
      error: `SNAPSHOT_NOT_FOUND: ${snapshotId}`
    };
  }

  // 2. Check if snapshot was sealed
  const storedHash = snapshot.claims_root_hash || null;
  if (!storedHash) {
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.NOT_SEALED,
      snapshotId,
      storedHash: null,
      recomputedHash: null,
      message: 'Historical snapshot was not sealed with a claims_root_hash'
    };
  }

  // 3. Recompute claims root for the snapshot's touch
  const calcResult = generateAuthoritativeTouchClaimsRoot(snapshot.campaign_touch_id, tid, dbInstance);
  if (!calcResult.success) {
    if (calcResult.error && calcResult.error.includes('INVALID_SCOPE')) {
      return {
        status: CLAIM_ROOT_VERIFICATION_STATUS.INVALID_SCOPE,
        snapshotId,
        storedHash,
        error: calcResult.error
      };
    }
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.MISMATCH,
      snapshotId,
      storedHash,
      error: calcResult.error
    };
  }

  const recomputedHash = calcResult.claimsRootHash;

  // 4. Compare hashes
  if (storedHash === recomputedHash) {
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.MATCH,
      snapshotId,
      storedHash,
      recomputedHash,
      claimCount: calcResult.claimCount
    };
  } else {
    return {
      status: CLAIM_ROOT_VERIFICATION_STATUS.MISMATCH,
      snapshotId,
      storedHash,
      recomputedHash,
      claimCount: calcResult.claimCount,
      message: 'Claims root mismatch: post-approval mutation detected in Fact-Claim Graph'
    };
  }
}
