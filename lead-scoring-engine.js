/**
 * PHASE 2 — STEP 4: LEAD SCORING, ICP FIT & SALES PRIORITY ENGINE
 * AI AutomationHubs v3.5 Enterprise
 *
 * Deterministic, Explainable, Evidence-backed, Versioned & Auditable.
 * Decision-support only (NO black-box predictions, NO autonomous outreach).
 */

import crypto from 'crypto';

export const SCORING_ENGINE_VERSION = 2;

/**
 * Priority Band Constants
 */
export const PRIORITY_LEVELS = {
  P1: 'P1 — VERY HIGH',
  P2: 'P2 — HIGH',
  P3: 'P3 — MEDIUM',
  P4: 'P4 — LOW',
  P5: 'P5 — INSUFFICIENT DATA'
};

/**
 * Default Ideal Customer Profile (Version 1)
 */
export const DEFAULT_ICP_PROFILE_V1 = {
  version: 1,
  name: 'Healthcare, Aesthetics & High-Ticket Local Services',
  description: 'Target profile for businesses with high customer value, manual inquiry points, and automation opportunities.',
  target_industries: [
    'Dental',
    'Dentist',
    'Dental Clinic',
    'Cosmetic Surgery',
    'Aesthetics',
    'Aesthetic Clinic',
    'Laser Clinic',
    'Healthcare',
    'Medical Center',
    'Wellness',
    'Real Estate',
    'Property Management',
    'Legal Services',
    'Law Firm',
    'Financial Services',
    'Accounting',
    'Home Services',
    'Automotive',
    'Hospitality'
  ],
  excluded_industries: [
    'Adult Entertainment',
    'Gambling',
    'Casino',
    'Weapons',
    'Tobacco',
    'Illegal Services',
    'Multi-Level Marketing'
  ],
  target_regions: [
    'UAE',
    'Dubai',
    'Abu Dhabi',
    'Sharjah',
    'India',
    'Mumbai',
    'Delhi',
    'Bangalore',
    'Kanpur',
    'Pune'
  ],
  business_types: ['B2C', 'HYBRID', 'B2B'],
  weights: {
    icp_fit: 0.40,
    opportunity: 0.35,
    data_confidence: 0.25
  },
  thresholds: {
    min_data_confidence_for_high_priority: 30.0,
    p1_sales_score: 75.0,
    p1_min_confidence: 60.0,
    p2_sales_score: 60.0,
    p2_min_confidence: 50.0,
    p3_sales_score: 45.0,
    p3_min_confidence: 35.0
  }
};

/**
 * Generate a deterministic SHA256 input hash to prevent duplicate score snapshots
 */
export function generateScoringInputHash(lead, profile, contacts, evidence, signals, icpProfile) {
  const payload = {
    leadId: lead.id,
    businessName: lead.businessName,
    phone: lead.phone,
    website: lead.website,
    email: lead.email,
    location: lead.location || lead.address,
    rating: lead.rating,
    profileIndustry: profile?.industry || null,
    profileSubIndustry: profile?.subIndustry || null,
    profileBusinessType: profile?.businessType || null,
    targetCustomerType: profile?.targetCustomerType || null,
    contactsCount: (contacts || []).length,
    contactsKey: (contacts || []).map(c => `${c.email || ''}:${c.phone || ''}:${c.is_decision_maker || 0}`).sort().join(';'),
    evidenceCount: (evidence || []).length,
    evidenceKey: (evidence || []).map(e => `${e.evidence_type}:${e.extracted_value || ''}:${e.provenance_type}`).sort().join(';'),
    signalsCount: (signals || []).length,
    signalsKey: (signals || []).map(s => `${s.signal_type}:${s.signal_value || ''}:${s.provenance_type}`).sort().join(';'),
    icpVersion: icpProfile.version,
    scoringVersion: SCORING_ENGINE_VERSION
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Determine Freshness Status based on timestamp and expiry days
 */
export function evaluateFreshness(timestamp, maxDays = 90) {
  if (!timestamp) return 'UNKNOWN';
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 'FRESH';
  if (ageDays <= maxDays * 0.5) return 'FRESH';
  if (ageDays <= maxDays) return 'AGING';
  return 'STALE';
}

/**
 * Calculate ICP Fit Score (0 - 100)
 */
export function calculateIcpFitScore(lead, profile, entityGroup, icpProfile) {
  let score = 0;
  const breakdown = {};
  const positive = [];
  const negative = [];
  const unknown = [];

  const targetIndustries = (icpProfile.target_industries || []).map(i => i.toLowerCase());
  const excludedIndustries = (icpProfile.excluded_industries || []).map(i => i.toLowerCase());
  const targetRegions = (icpProfile.target_regions || []).map(r => r.toLowerCase());

  // 1. Industry Fit (up to 30 pts)
  const leadIndustry = (profile?.industry || lead.segment || '').toLowerCase();
  const leadSubIndustry = (profile?.subIndustry || '').toLowerCase();

  let isExcluded = false;
  for (const exc of excludedIndustries) {
    if (leadIndustry.includes(exc) || leadSubIndustry.includes(exc)) {
      isExcluded = true;
      break;
    }
  }

  if (isExcluded) {
    breakdown.industry_fit = 0;
    negative.push(`Industry (${profile?.industry || lead.segment}) matches configured excluded industry list`);
    return {
      score: 0,
      breakdown,
      positive,
      negative,
      unknown,
      isExcluded: true
    };
  }

  let industryPts = 0;
  if (leadIndustry || leadSubIndustry) {
    let matched = false;
    for (const tgt of targetIndustries) {
      if (leadIndustry.includes(tgt) || leadSubIndustry.includes(tgt)) {
        matched = true;
        industryPts = 30;
        positive.push(`Industry matches target ICP: "${tgt.toUpperCase()}" (${profile?.industry || lead.segment})`);
        break;
      }
    }
    if (!matched) {
      industryPts = 10;
      negative.push(`Industry (${profile?.industry || lead.segment}) is outside top target ICP verticals`);
    }
  } else {
    industryPts = 5;
    unknown.push('Industry vertical could not be verified from public data');
  }
  breakdown.industry_fit = industryPts;
  score += industryPts;

  // 2. Geographic Fit (up to 15 pts)
  const leadLoc = (lead.location || lead.address || '').toLowerCase();
  let geoPts = 0;
  if (leadLoc) {
    let geoMatched = false;
    for (const region of targetRegions) {
      if (leadLoc.includes(region)) {
        geoMatched = true;
        geoPts = 15;
        positive.push(`Geographic market matches configured target region: "${region.toUpperCase()}"`);
        break;
      }
    }
    if (!geoMatched) {
      geoPts = 8;
      negative.push(`Location is outside primary target regions: "${lead.location || lead.address}"`);
    }
  } else {
    unknown.push('Operating city / region not specified');
  }
  breakdown.geographic_fit = geoPts;
  score += geoPts;

  // 3. Business Type & Customer Model (up to 15 pts)
  const targetTypes = (icpProfile.business_types || ['B2C', 'HYBRID', 'B2B']).map(t => t.toUpperCase());
  const customerType = (profile?.target_customer_type || profile?.targetCustomerType || 'UNKNOWN').toUpperCase();
  let typePts = 0;
  if (customerType !== 'UNKNOWN') {
    if (targetTypes.includes(customerType)) {
      typePts = 15;
      positive.push(`Customer model matches ICP preferences: "${customerType}"`);
    } else {
      typePts = 5;
      negative.push(`Customer model "${customerType}" outside preferred types`);
    }
  } else {
    typePts = 5;
    unknown.push('Target customer model (B2B/B2C) unconfirmed from public profile');
  }
  breakdown.business_type_fit = typePts;
  score += typePts;

  // 4. Digital Maturity Baseline (up to 15 pts)
  let digitalPts = 0;
  if (lead.website) {
    digitalPts += 7;
    positive.push('Verified business domain website present');
    if (lead.website.startsWith('https://')) {
      digitalPts += 3;
    }
  } else {
    digitalPts += 4;
    negative.push('No official business domain listed');
  }

  if (lead.phone) {
    digitalPts += 5;
    positive.push('Direct telephone or mobile line active');
  }
  breakdown.digital_maturity_fit = digitalPts;
  score += digitalPts;

  // 5. Multi-Location / Enterprise Scope (up to 15 pts)
  let scopePts = 5; // standard baseline for single location
  if (entityGroup && (entityGroup.entity_type === 'MULTI_LOCATION' || entityGroup.entity_type === 'FRANCHISE')) {
    scopePts = 15;
    positive.push(`Multi-location / multi-branch network detected (${entityGroup.member_count || 'multiple'} locations)`);
  } else {
    unknown.push('Company employee headcount / multi-branch network not confirmed');
  }
  breakdown.enterprise_scope = scopePts;
  score += scopePts;

  // 6. Technology Environment Compatibility (up to 10 pts)
  let techPts = 5;
  const techSignals = profile?.technology_signals ? (typeof profile.technology_signals === 'string' ? JSON.parse(profile.technology_signals) : profile.technology_signals) : [];
  if (techSignals.length > 0) {
    techPts = 10;
    positive.push(`Modern CMS / web technology environment detected (${techSignals.slice(0, 3).map(t => t.name || t).join(', ')})`);
  } else {
    unknown.push('CMS / tech infrastructure partially observable or custom build');
  }
  breakdown.tech_environment = techPts;
  score += techPts;

  return {
    score: Math.min(100, Math.round(score)),
    breakdown,
    positive,
    negative,
    unknown,
    isExcluded: false
  };
}

/**
 * Calculate Observable Opportunity Score (0 - 100)
 * Note: Never describe as "pain" or "inefficient" unless observable evidence exists.
 */
/**
 * Calculate Observable Opportunity Score (0 - 100) - Version 2
 * Objective, evidence-backed, and differentiated without speculation.
 */
export function calculateOpportunityScore(signals = [], evidence = [], lead = {}, profile = null, entityGroup = null) {
  let score = 0;
  const breakdown = {};
  const positive = [];
  const negative = [];
  const unknown = [];

  const signalTypes = new Set(signals.map(s => (s.signal_type || s.type || '').toUpperCase()));
  const signalKeys = new Set(signals.map(s => (s.signal_key || s.key || '').toUpperCase()));
  const signalValues = signals.map(s => (s.signal_value || s.value || '').toString());

  const evidenceTypes = new Set(evidence.map(e => (e.evidence_type || e.type || '').toUpperCase()));
  const evidenceValues = evidence.map(e => (e.extracted_value || e.value || '').toString());
  const evidenceNames = evidence.map(e => (e.evidence_name || e.name || '').toString());

  // Safe helper to test if any signal or evidence matches pattern
  const matchesSignalOrEvidence = (regex) => {
    return signalValues.some(v => regex.test(v)) ||
           evidenceValues.some(v => regex.test(v)) ||
           evidenceNames.some(n => regex.test(n)) ||
           Array.from(signalKeys).some(k => regex.test(k)) ||
           Array.from(signalTypes).some(t => regex.test(t)) ||
           Array.from(evidenceTypes).some(t => regex.test(t));
  };

  const isAppointmentVertical = () => {
    const industryStr = `${profile?.industry || ''} ${profile?.subIndustry || ''} ${lead.segment || ''} ${lead.businessName || ''}`.toLowerCase();
    return /dental|dentist|clinic|aesthetic|laser|cosmetic|medical|surgery|healthcare|salon|wellness|physio|chiro/i.test(industryStr);
  };

  // Anti-gaming: Social media count, technology signature count, and crawl depth do NOT add opportunity points.

  // 1. WhatsApp Only / Primary Booking Flow (+25 pts)
  const hasWhatsApp = signalKeys.has('WHATSAPP_SCHEDULING_AUTOMATION') ||
                      signalTypes.has('WHATSAPP_ONLY_BOOKING') ||
                      evidenceTypes.has('WHATSAPP_WORKFLOW') ||
                      matchesSignalOrEvidence(/whatsapp/i);

  if (hasWhatsApp) {
    breakdown.whatsapp_booking_opportunity = 25;
    score += 25;
    positive.push('Observable workflow: WhatsApp-dependent customer booking / direct chat entrypoint detected without integrated booking');
  } else {
    breakdown.whatsapp_booking_opportunity = 0;
  }

  // 2. Manual Inquiry Form Workflow (+20 pts)
  const hasManualInquiry = signalKeys.has('LEAD_CAPTURE_AUTOMATION') ||
                           signalKeys.has('FORM_TO_CHAT_AUTOMATION') ||
                           signalTypes.has('MANUAL_INQUIRY_FORM') ||
                           evidenceTypes.has('INQUIRY_FORM') ||
                           matchesSignalOrEvidence(/manual_inquiry|lead response opportunity|form automation/i);

  if (hasManualInquiry) {
    breakdown.manual_inquiry_opportunity = 20;
    score += 20;
    positive.push('Observable workflow: Static web inquiry form without conversational automated responder');
  } else {
    breakdown.manual_inquiry_opportunity = 0;
  }

  // 3. No Online Booking Engine Where Appointment Workflow is Relevant (+20 pts)
  const hasNoOnlineBooking = signalKeys.has('ABSENT_SELF_SERVICE_BOOKING') ||
                             signalTypes.has('NO_ONLINE_BOOKING') ||
                             evidenceTypes.has('MISSING_CAPABILITY') ||
                             matchesSignalOrEvidence(/no_online_booking|absent_self_service_booking|no_online_booking_calendar|manual staff coordination for appointment/i);

  if (hasNoOnlineBooking) {
    breakdown.no_booking_engine = 20;
    score += 20;
    positive.push('Automation opportunity: Missing integrated online calendar / self-service booking system for appointment-based service');
  } else {
    breakdown.no_booking_engine = 0;
  }

  // 4. Multiple Customer-Facing Inquiry Channels / Fragmented Channels (+10 pts)
  const hasFragmentedChannels = signalKeys.has('LIMITED_INBOUND_CHANNELS') ||
                                matchesSignalOrEvidence(/limited_inbound_channels|restricted_digital_channels|no_email_detected/i) ||
                                (lead.phone && !lead.email && !evidence.some(e => e.evidence_type === 'EMAIL_DISCOVERY'));

  if (hasFragmentedChannels) {
    breakdown.fragmented_channels = 10;
    score += 10;
    positive.push('Contact opportunity: Direct mobile / WhatsApp exposed with no public email detected');
  } else {
    breakdown.fragmented_channels = 0;
  }

  // 5. Active Hiring / Growth Signals (+15 pts)
  const hasHiring = signalTypes.has('GROWTH_SIGNAL') ||
                    signalKeys.has('EXPANDING_TEAM') ||
                    signalTypes.has('CAREERS_PAGE_DETECTED') ||
                    evidenceTypes.has('CAREERS_PAGE') ||
                    matchesSignalOrEvidence(/careers|hiring|recruitment/i);

  if (hasHiring) {
    breakdown.growth_signal = 15;
    score += 15;
    positive.push('Growth signal: Active careers / recruitment section detected on website');
  } else {
    breakdown.growth_signal = 0;
    unknown.push('Company growth / recruitment activity unobserved');
  }

  // 6. Complex Service Catalog (+10 pts)
  let servicesCount = 0;
  if (profile?.services_offered) {
    try {
      const parsed = typeof profile.services_offered === 'string' ? JSON.parse(profile.services_offered) : profile.services_offered;
      servicesCount = parsed.length;
    } catch (_) {}
  }
  const hasComplexCatalog = servicesCount >= 4;
  if (hasComplexCatalog) {
    breakdown.complex_catalog = 10;
    score += 10;
    positive.push(`Catalog complexity: ${servicesCount} distinct service offerings identified`);
  }

  // 7. High Reputation Candidate without Modern Website (+10 pts)
  if ((!lead.website || lead.website.trim() === '') && (parseFloat(lead.rating) >= 4.0)) {
    breakdown.high_ticket_no_web = 10;
    score += 10;
    positive.push(`High reputation opportunity: Google Rating ${lead.rating}★ without official web portal`);
  }

  // Explicit Combination Rule 1: Appointment Automation Synergy (+15 pts)
  if (isAppointmentVertical() && hasWhatsApp && hasNoOnlineBooking) {
    breakdown.synergy_appointment_whatsapp = 15;
    score += 15;
    positive.push('Combination synergy: Appointment-driven business relying on direct WhatsApp messaging without self-service booking (+15 pts)');
  }

  // Explicit Combination Rule 2: Multi-Location Coordination Synergy (+10 pts)
  const isMultiLocation = entityGroup && (
    entityGroup.entity_type === 'MULTI_LOCATION' ||
    entityGroup.entity_type === 'FRANCHISE' ||
    (entityGroup.member_count && entityGroup.member_count > 1)
  );
  if (isMultiLocation && (hasManualInquiry || hasFragmentedChannels || hasWhatsApp)) {
    breakdown.synergy_multilocation = 10;
    score += 10;
    positive.push('Combination synergy: Multi-branch business network operating separate direct communication flows (+10 pts)');
  }

  // Explicit Combination Rule 3: Inquiry Volume & Catalog Complexity Synergy (+10 pts)
  if (hasComplexCatalog && hasManualInquiry) {
    breakdown.synergy_catalog_inquiry = 10;
    score += 10;
    positive.push('Combination synergy: Multi-service catalog paired with manual static form inquiry (+10 pts)');
  }

  // If no automation workflow gaps were observed, add clear explanation
  if (!hasWhatsApp && !hasManualInquiry && !hasNoOnlineBooking) {
    unknown.push('No observable workflow automation gaps detected in public pages');
  }

  // Baseline if completely 0
  if (score === 0) {
    score = 10;
    breakdown.baseline = 10;
  }

  return {
    score: Math.min(100, Math.round(score)),
    breakdown,
    positive,
    negative,
    unknown
  };
}

/**
 * Calculate Data Confidence Score (0 - 100) - Version 2
 * Measures data quality, verification status, freshness, and completeness.
 */
export function calculateDataConfidenceScore(lead, profile, contacts = [], evidence = [], signals = []) {
  let score = 0;
  const breakdown = {};
  const positive = [];
  const negative = [];
  const unknown = [];

  const isGenericEmail = (email) => /^(info|contact|support|admin|sales|help|office|hello|team|mail|enquiries)@/i.test(email || '');

  // 1. Verified Contact Quality (up to 30 pts)
  let contactPts = 0;
  let hasDecisionMaker = false;
  let hasGenericEmail = false;

  for (const c of contacts) {
    const isVerified = c.provenance_type === 'VERIFIED' || !c.provenance_type;
    const notInferred = c.provenance_type !== 'INFERRED';
    if ((c.is_decision_maker || c.contact_type === 'EXECUTIVE' || c.contact_type === 'FOUNDER') && !isGenericEmail(c.email) && notInferred) {
      hasDecisionMaker = true;
    }
    if (c.email && isGenericEmail(c.email)) {
      hasGenericEmail = true;
    }
  }

  if (hasDecisionMaker) {
    contactPts += 20;
    positive.push('Verified decision-maker / executive contact identified');
  } else if (lead.email || contacts.length > 0) {
    const primaryEmail = lead.email || contacts[0]?.email;
    const isPrimaryInferred = contacts[0]?.provenance_type === 'INFERRED';
    if (isGenericEmail(primaryEmail) || hasGenericEmail) {
      contactPts += 10;
      positive.push('Public general business contact email confirmed');
    } else if (!isPrimaryInferred) {
      contactPts += 14;
      positive.push('Direct professional business email verified');
    } else {
      contactPts += 8;
      positive.push('Inferred contact email identified');
    }
  } else {
    negative.push('Public business email not detected');
  }

  if (lead.phone) {
    contactPts += 10;
    positive.push('Verified phone number present');
  } else {
    negative.push('No verified telephone number available');
  }
  breakdown.contact_quality = contactPts;
  score += contactPts;

  // 2. Verified Domain / Website Presence (up to 25 pts)
  let webPts = 0;
  if (lead.website && lead.website.trim().length > 0) {
    webPts += 20;
    positive.push('Official business domain website verified');
    if (lead.website.startsWith('https://')) {
      webPts += 5;
    }
  } else {
    negative.push('Website unavailable or unverified');
  }
  breakdown.website_verification = webPts;
  score += webPts;

  // 3. Evidence Coverage & Diversity (up to 25 pts)
  let evidencePts = 0;
  const verifiedEvidence = evidence.filter(e => e.provenance_type === 'VERIFIED');
  const inferredEvidence = evidence.filter(e => e.provenance_type === 'INFERRED');

  // Provenance weighting: VERIFIED (1.0x) > INFERRED (0.6x)
  if (verifiedEvidence.length >= 3) {
    evidencePts = 25;
    positive.push(`High evidence coverage: ${verifiedEvidence.length} verified DOM / page facts recorded`);
  } else if (verifiedEvidence.length >= 1) {
    evidencePts = 18;
    positive.push(`Moderate evidence coverage: ${verifiedEvidence.length} verified records recorded`);
  } else if (inferredEvidence.length > 0) {
    evidencePts = 10;
    positive.push(`Inferred evidence coverage: ${inferredEvidence.length} multi-signal records recorded`);
  } else {
    evidencePts = 5;
    unknown.push('Limited evidence recorded in intelligence database');
  }
  breakdown.evidence_coverage = evidencePts;
  score += evidencePts;

  // 4. Intelligence Freshness Lifecycle (up to 20 pts)
  let freshnessPts = 0;
  const latestVerifiedAt = evidence.map(e => e.verified_at || e.created_at).sort().reverse()[0] || profile?.last_analyzed_at || lead.updatedAt || lead.createdAt;
  const freshness = evaluateFreshness(latestVerifiedAt, 60);

  if (freshness === 'FRESH') {
    freshnessPts = 20;
    positive.push('Intelligence is FRESH (verified within past 30-45 days)');
  } else if (freshness === 'AGING') {
    freshnessPts = 12;
    negative.push('Intelligence is AGING (verified over 45 days ago; refresh recommended)');
  } else if (freshness === 'STALE') {
    freshnessPts = 5;
    negative.push('Intelligence is STALE (verified over 90 days ago)');
  } else {
    freshnessPts = 5;
    unknown.push('Verification timestamp unavailable');
  }
  breakdown.freshness_score = freshnessPts;
  breakdown.freshness_status = freshness;
  score += freshnessPts;

  return {
    score: Math.min(100, Math.round(score)),
    breakdown,
    positive,
    negative,
    unknown,
    freshness
  };
}

/**
 * Determine Deterministic Priority Level
 */
export function determinePriorityLevel(salesScore, dataConfidence, icpFit, icpProfile) {
  const thresholds = icpProfile.thresholds || DEFAULT_ICP_PROFILE_V1.thresholds;

  // Insufficient Data Gate: If data confidence is below minimum threshold, cannot be high priority
  if (dataConfidence < thresholds.min_data_confidence_for_high_priority) {
    return PRIORITY_LEVELS.P5;
  }

  if (salesScore >= thresholds.p1_sales_score && dataConfidence >= thresholds.p1_min_confidence) {
    return PRIORITY_LEVELS.P1;
  }

  if (salesScore >= thresholds.p2_sales_score && dataConfidence >= thresholds.p2_min_confidence) {
    return PRIORITY_LEVELS.P2;
  }

  if (salesScore >= thresholds.p3_sales_score && dataConfidence >= thresholds.p3_min_confidence) {
    return PRIORITY_LEVELS.P3;
  }

  return PRIORITY_LEVELS.P4;
}

/**
 * Calculate Complete Lead Score Dossier
 */
export function calculateLeadScores(leadId, options = {}) {
  const {
    tenantId = 'default',
    dbInstance,
    icpProfile = null,
    forceRecalculate = false
  } = options;

  if (!dbInstance) {
    throw new Error('dbInstance is required for scoring calculation');
  }

  const ownership = dbInstance.validateLeadOwnership(leadId, tenantId);
  if (!ownership.valid) {
    throw new Error(ownership.reason || 'Lead authorization failed');
  }

  const lead = ownership.lead;

  // Fetch active ICP profile if not explicitly supplied
  const activeIcp = icpProfile || dbInstance.getIcpProfile(tenantId) || DEFAULT_ICP_PROFILE_V1;

  // Retrieve existing intelligence, contacts, evidence, signals, entity group
  const profile = dbInstance.getLeadIntelligence(leadId, tenantId);
  const contacts = dbInstance.getLeadContacts(leadId, tenantId) || [];
  const evidence = dbInstance.getLeadEvidence(leadId, tenantId) || [];
  const signals = dbInstance.getLeadSignals(leadId, tenantId) || [];
  const entityGroup = dbInstance.getEntityGroupByLeadId ? dbInstance.getEntityGroupByLeadId(leadId, tenantId) : null;

  // Generate deterministic input hash
  const inputHash = generateScoringInputHash(lead, profile, contacts, evidence, signals, activeIcp);

  // Check if identical unchanged calculation already exists (unless forceRecalculate is true)
  if (!forceRecalculate) {
    const existingScore = dbInstance.getScoreByInputHash(leadId, inputHash, tenantId);
    if (existingScore) {
      return {
        leadId,
        tenantId,
        cached: true,
        scoreId: existingScore.id,
        scoreVersion: existingScore.score_version,
        scoringVersion: existingScore.scoring_version || 1,
        icpProfileVersion: existingScore.icp_profile_version,
        icpFitScore: existingScore.icp_fit_score,
        opportunityScore: existingScore.opportunity_score,
        dataConfidenceScore: existingScore.data_confidence_score,
        salesPriorityScore: existingScore.sales_priority_score,
        priorityLevel: existingScore.priority_level,
        positiveFactors: typeof existingScore.positive_factors === 'string' ? JSON.parse(existingScore.positive_factors) : existingScore.positive_factors,
        negativeFactors: typeof existingScore.negative_factors === 'string' ? JSON.parse(existingScore.negative_factors) : existingScore.negative_factors,
        unknownFactors: typeof existingScore.unknown_factors === 'string' ? JSON.parse(existingScore.unknown_factors) : existingScore.unknown_factors,
        scoreBreakdown: typeof existingScore.score_breakdown === 'string' ? JSON.parse(existingScore.score_breakdown) : existingScore.score_breakdown,
        inputHash: existingScore.input_hash,
        calculatedAt: existingScore.calculated_at,
        freshness: evaluateFreshness(existingScore.calculated_at, 60),
        disclaimer: 'Priority score is an evidence-based sales prioritization aid, not a prediction of conversion, revenue, or business success.'
      };
    }
  }

  // 1. Calculate Component Dimensions
  const icpResult = calculateIcpFitScore(lead, profile, entityGroup, activeIcp);
  const oppResult = calculateOpportunityScore(signals, evidence, lead, profile, entityGroup);
  const confResult = calculateDataConfidenceScore(lead, profile, contacts, evidence, signals);

  // 2. Composite Sales Priority Score Formula
  const weights = activeIcp.weights || DEFAULT_ICP_PROFILE_V1.weights;
  const icpWeight = weights.icp_fit ?? 0.40;
  const oppWeight = weights.opportunity ?? 0.35;
  const confWeight = weights.data_confidence ?? 0.25;

  const rawSalesScore = (icpResult.score * icpWeight) + (oppResult.score * oppWeight) + (confResult.score * confWeight);
  const salesPriorityScore = Math.min(100, Math.round(rawSalesScore * 10) / 10);

  // 3. Determine Priority Level
  const priorityLevel = determinePriorityLevel(salesPriorityScore, confResult.score, icpResult.score, activeIcp);

  // 4. Compile Factor Explanations
  const positiveFactors = [...icpResult.positive, ...oppResult.positive, ...confResult.positive];
  const negativeFactors = [...icpResult.negative, ...oppResult.negative, ...confResult.negative];
  const unknownFactors = [...icpResult.unknown, ...oppResult.unknown, ...confResult.unknown];

  const scoreBreakdown = {
    weights: {
      icp_fit: icpWeight,
      opportunity: oppWeight,
      data_confidence: confWeight
    },
    dimensions: {
      icp_fit: {
        score: icpResult.score,
        breakdown: icpResult.breakdown
      },
      opportunity: {
        score: oppResult.score,
        breakdown: oppResult.breakdown
      },
      data_confidence: {
        score: confResult.score,
        freshness: confResult.freshness,
        breakdown: confResult.breakdown
      }
    },
    composite_formula: `(${icpResult.score} * ${icpWeight}) + (${oppResult.score} * ${oppWeight}) + (${confResult.score} * ${confWeight}) = ${salesPriorityScore}`
  };

  const inputsSnapshot = {
    businessName: lead.businessName,
    website: lead.website,
    phone: lead.phone,
    email: lead.email,
    location: lead.location || lead.address,
    rating: lead.rating,
    industry: profile?.industry || lead.segment,
    contactsCount: contacts.length,
    evidenceCount: evidence.length,
    signalsCount: signals.length,
    icpProfileVersion: activeIcp.version,
    scoringVersion: SCORING_ENGINE_VERSION
  };

  // 5. Persist Versioned Score Snapshot in lead_scores
  const record = dbInstance.addLeadScore(leadId, {
    score_type: 'sales_priority',
    score: salesPriorityScore,
    confidence_score: confResult.score,
    scoring_reason: `Priority ${priorityLevel}: ICP Fit ${icpResult.score}, Opportunity ${oppResult.score}, Confidence ${confResult.score}`,
    icp_profile_version: activeIcp.version || 1,
    scoring_version: SCORING_ENGINE_VERSION,
    icp_fit_score: icpResult.score,
    opportunity_score: oppResult.score,
    data_confidence_score: confResult.score,
    sales_priority_score: salesPriorityScore,
    priority_level: priorityLevel,
    positive_factors: positiveFactors,
    negative_factors: negativeFactors,
    unknown_factors: unknownFactors,
    score_breakdown: scoreBreakdown,
    scoring_inputs_snapshot: inputsSnapshot,
    input_hash: inputHash
  }, tenantId);

  return {
    leadId,
    tenantId,
    cached: false,
    scoreId: record.id,
    scoreVersion: record.score_version,
    scoringVersion: record.scoring_version || SCORING_ENGINE_VERSION,
    icpProfileVersion: record.icp_profile_version,
    icpFitScore: record.icp_fit_score,
    opportunityScore: record.opportunity_score,
    dataConfidenceScore: record.data_confidence_score,
    salesPriorityScore: record.sales_priority_score,
    priorityLevel: record.priority_level,
    positiveFactors,
    negativeFactors,
    unknownFactors,
    scoreBreakdown,
    inputHash,
    calculatedAt: record.calculated_at,
    freshness: confResult.freshness,
    disclaimer: 'Priority score is an evidence-based sales prioritization aid, not a prediction of conversion, revenue, or business success.'
  };
}

/**
 * Batch Score Multiple Leads with Observability
 */
export async function batchScoreLeads(leadIds = [], options = {}) {
  const {
    tenantId = 'default',
    dbInstance,
    forceRecalculate = false,
    maxBatchSize = 50
  } = options;

  if (!dbInstance) {
    throw new Error('dbInstance is required for batch scoring');
  }

  const boundedIds = leadIds.slice(0, maxBatchSize);
  const activeIcp = dbInstance.getIcpProfile(tenantId) || DEFAULT_ICP_PROFILE_V1;

  // Create scoring run for observability
  const run = dbInstance.createScoringRun({
    tenant_id: tenantId,
    status: 'RUNNING',
    scoring_version: SCORING_ENGINE_VERSION,
    icp_version: activeIcp.version || 1,
    total_requested: boundedIds.length
  }, tenantId);

  const results = [];
  const errors = [];
  let scoredCount = 0;
  let skippedCount = 0;

  for (const id of boundedIds) {
    try {
      const scored = calculateLeadScores(id, {
        tenantId,
        dbInstance,
        icpProfile: activeIcp,
        forceRecalculate
      });

      if (scored.cached) {
        skippedCount++;
      } else {
        scoredCount++;
      }

      results.push(scored);
    } catch (err) {
      errors.push({ leadId: id, error: err.message });
      skippedCount++;
    }
  }

  const status = errors.length === 0 ? 'COMPLETED' : (scoredCount > 0 ? 'PARTIAL' : 'FAILED');

  // Update scoring run
  dbInstance.updateScoringRun(run.id, {
    status,
    leads_processed: boundedIds.length,
    leads_scored: scoredCount,
    leads_skipped: skippedCount,
    errors,
    summary: `Processed ${boundedIds.length} leads: ${scoredCount} scored, ${skippedCount} skipped/cached. Status: ${status}`,
    completed_at: new Date().toISOString()
  }, tenantId);

  return {
    runId: run.id,
    tenantId,
    status,
    totalRequested: boundedIds.length,
    leadsScored: scoredCount,
    leadsSkipped: skippedCount,
    errors,
    results
  };
}
