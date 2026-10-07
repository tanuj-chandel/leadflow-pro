/**
 * ============================================================================
 * AI AUTOMATIONHUBS ENTERPRISE — PHASE 2 STEP 5
 * SALES ACTION RECOMMENDATION ENGINE
 * ============================================================================
 * Deterministic, explainable, evidence-backed sales action recommendations.
 * 
 * Safety Invariant:
 * - NO autonomous outbound execution.
 * - Read-only intelligence and score ingestion.
 * - Advisory decision support for human sales reps.
 * - Outbound execution remains gated behind Phase 1 executeOutreachGate.
 */

import crypto from 'crypto';
import { evaluateFreshness } from './lead-scoring-engine.js';

export const RECOMMENDATION_ENGINE_VERSION = 2;

/**
 * Deterministic Recommendation Action Types
 */
export const ACTION_TYPES = {
  DIRECT_OUTREACH: 'DIRECT_OUTREACH',
  CONTACT_DECISION_MAKER: 'CONTACT_DECISION_MAKER',
  RESEARCH_GAPS: 'RESEARCH_GAPS',
  MONITOR_NURTURE: 'MONITOR_NURTURE',
  QUALIFY_LOW_FIT: 'QUALIFY_LOW_FIT',
  INSUFFICIENT_DATA_HOLD: 'INSUFFICIENT_DATA_HOLD'
};

/**
 * Deterministic Channel Recommendations
 */
export const RECOMMENDED_CHANNELS = {
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  WEB_FORM: 'WEB_FORM',
  MANUAL_RESEARCH: 'MANUAL_RESEARCH',
  NONE: 'NONE'
};

/**
 * Urgency Levels
 */
export const URGENCY_LEVELS = {
  IMMEDIATE: 'IMMEDIATE',
  HIGH: 'HIGH',
  STANDARD: 'STANDARD',
  LOW: 'LOW',
  BLOCKED: 'BLOCKED'
};

/**
 * Generate a deterministic SHA256 input hash for recommendation caching
 */
export function generateRecommendationInputHash(lead, score, contacts = [], evidence = [], signals = []) {
  const payload = {
    leadId: lead.id,
    businessName: lead.businessName,
    phone: lead.phone,
    website: lead.website,
    email: lead.email,
    rating: lead.rating,
    scoreId: score?.id || null,
    salesPriorityScore: score?.sales_priority_score ?? score?.salesPriorityScore ?? null,
    opportunityScore: score?.opportunity_score ?? score?.opportunityScore ?? null,
    icpFitScore: score?.icp_fit_score ?? score?.icpFitScore ?? null,
    dataConfidenceScore: score?.data_confidence_score ?? score?.dataConfidenceScore ?? null,
    priorityLevel: score?.priority_level ?? score?.priorityLevel ?? null,
    contactsKey: contacts.map(c => `${c.email || ''}:${c.phone || ''}:${c.is_decision_maker || 0}:${c.provenance_type}`).sort().join(';'),
    evidenceKey: evidence.map(e => `${e.evidence_type}:${e.provenance_type}`).sort().join(';'),
    signalsKey: signals.map(s => `${s.signal_type}:${s.provenance_type}`).sort().join(';'),
    engineVersion: RECOMMENDATION_ENGINE_VERSION
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Deterministic Channel Selector
 * Strictly prioritizes verified direct channels over generic ones.
 */
export function selectOptimalChannel(lead, contacts = [], signals = [], evidence = []) {
  // Exclude automated telemetry, crash-reporting, and error-tracking addresses (e.g. Sentry, Wixpress SDKs)
  const isTelemetryOrInvalidEmail = (email) => {
    if (!email || typeof email !== 'string') return true;
    return /@([a-z0-9.-]+\.)?(sentry|wixpress)\.[a-z]{2,}/i.test(email);
  };

  const isGenericEmail = (email) => {
    if (!email) return false;
    return /^(info|contact|support|admin|sales|help|office|hello|team|mail|enquiries)@/i.test(email);
  };

  // 1. Check for verified Decision-Maker Direct Email
  const dmContact = contacts.find(c => 
    (c.is_decision_maker || c.contact_type === 'EXECUTIVE') && 
    c.email && 
    !isTelemetryOrInvalidEmail(c.email) && 
    !isGenericEmail(c.email) && 
    c.provenance_type === 'VERIFIED'
  );
  
  // 2. Check for Direct Professional Email
  const directEmailContact = contacts.find(c => 
    c.email && 
    !isTelemetryOrInvalidEmail(c.email) && 
    !isGenericEmail(c.email) && 
    c.provenance_type === 'VERIFIED'
  );

  const rawPrimaryEmail = dmContact?.email || directEmailContact?.email || lead.email;
  const primaryEmail = (rawPrimaryEmail && !isTelemetryOrInvalidEmail(rawPrimaryEmail)) ? rawPrimaryEmail : null;

  // 3. Check for explicit WhatsApp capability / evidence
  const hasWhatsAppSignal = signals.some(s => s.signal_key === 'WHATSAPP_SCHEDULING_AUTOMATION' || s.signal_type === 'WHATSAPP_ONLY_BOOKING') ||
                            evidence.some(e => e.evidence_type === 'WHATSAPP_WORKFLOW' || /wa\.me|whatsapp/i.test(e.extracted_value || ''));
  const isMobile = Boolean(lead.isMobile || contacts.some(c => c.phone && (c.contact_type === 'MOBILE' || c.is_decision_maker)));

  // 4. Decision Logic
  // A. If EXPLICIT WhatsApp evidence/signal exists and phone is available -> WhatsApp is primary
  if (hasWhatsAppSignal && (lead.phone || contacts.some(c => c.phone))) {
    const handle = lead.phone || contacts.find(c => c.phone)?.phone;
    return {
      channel: RECOMMENDED_CHANNELS.WHATSAPP,
      targetContactId: null,
      targetContactName: dmContact?.contact_name || null,
      targetContactHandle: handle,
      rationale: 'Observable WhatsApp entrypoint / mobile communication gap on public page'
    };
  }

  // B. If decision-maker email is verified -> Email is primary
  if (dmContact && dmContact.email) {
    return {
      channel: RECOMMENDED_CHANNELS.EMAIL,
      targetContactId: dmContact.id || null,
      targetContactName: dmContact.contact_name || dmContact.first_name || 'Decision Maker',
      targetContactHandle: dmContact.email,
      rationale: `Verified decision-maker email identified (${dmContact.job_title || 'Executive'})`
    };
  }

  // C. If direct professional email exists -> Email
  if (primaryEmail && !isGenericEmail(primaryEmail)) {
    return {
      channel: RECOMMENDED_CHANNELS.EMAIL,
      targetContactId: directEmailContact?.id || null,
      targetContactName: directEmailContact?.contact_name || null,
      targetContactHandle: primaryEmail,
      rationale: 'Direct verified professional business email'
    };
  }

  // D. Verified mobile WITHOUT explicit WhatsApp evidence -> PHONE (telephony)
  if (lead.phone && isMobile) {
    return {
      channel: RECOMMENDED_CHANNELS.PHONE,
      targetContactId: null,
      targetContactName: null,
      targetContactHandle: lead.phone,
      rationale: 'Verified direct mobile line (telephony; no explicit WhatsApp evidence observed)'
    };
  }

  // E. Direct Phone Line (landline or unclassified)
  if (lead.phone) {
    return {
      channel: RECOMMENDED_CHANNELS.PHONE,
      targetContactId: null,
      targetContactName: null,
      targetContactHandle: lead.phone,
      rationale: 'Direct business telephone line'
    };
  }

  // F. Generic Business Email (info@, contact@)
  if (primaryEmail && !isTelemetryOrInvalidEmail(primaryEmail)) {
    return {
      channel: RECOMMENDED_CHANNELS.EMAIL,
      targetContactId: null,
      targetContactName: null,
      targetContactHandle: primaryEmail,
      rationale: 'Public general business email address'
    };
  }

  // G. Web Form Only
  const hasWebForm = evidence.some(e => e.evidence_type === 'INQUIRY_FORM' || /form|contact/i.test(e.extracted_value || ''));
  if (hasWebForm && lead.website) {
    return {
      channel: RECOMMENDED_CHANNELS.WEB_FORM,
      targetContactId: null,
      targetContactName: null,
      targetContactHandle: lead.website,
      rationale: 'Static web contact/inquiry form detected'
    };
  }

  // H. No direct outbound channel
  return {
    channel: RECOMMENDED_CHANNELS.MANUAL_RESEARCH,
    targetContactId: null,
    targetContactName: null,
    targetContactHandle: null,
    rationale: 'No verified direct phone or email channel currently available'
  };
}

/**
 * Separate facts strictly into VERIFIED, INFERRED, and UNKNOWN
 */
export function segregateRecommendationFacts(lead, profile, contacts = [], evidence = [], signals = [], score = {}) {
  const verified = [];
  const inferred = [];
  const unknown = [];

  // Domain & Web presence
  if (lead.website) {
    if (lead.website.startsWith('https://')) {
      verified.push('Official business domain with HTTPS security active');
    } else {
      verified.push('Official business domain listed (HTTP only)');
    }
  } else {
    verified.push('Zero official web domain listed on Google Maps');
  }

  // Contact channels
  if (lead.phone) {
    if (lead.isMobile) {
      verified.push(`Direct mobile telephone line: ${lead.phone}`);
    } else {
      verified.push(`Business telephone line: ${lead.phone}`);
    }
  } else {
    unknown.push('Public direct telephone number unavailable');
  }

  if (lead.email) {
    verified.push(`Direct business email address: ${lead.email}`);
  } else {
    unknown.push('Public business email address unconfirmed');
  }

  // Extracted DOM Evidence (VERIFIED)
  evidence.forEach(e => {
    if (e.provenance_type === 'VERIFIED') {
      if (e.evidence_type === 'STRUCTURED_DATA') verified.push('Schema.org structured business data detected on website');
      else if (e.evidence_type === 'SSL_CERTIFICATE') verified.push('Valid SSL encryption certificate verified');
      else if (e.evidence_type === 'VIEWPORT_META') verified.push('Mobile-optimized responsive viewport detected');
      else if (e.evidence_type === 'TECHNOLOGY_DETECTION') verified.push(`Web technology detected: ${e.extracted_value}`);
    } else if (e.provenance_type === 'INFERRED') {
      if (e.evidence_type === 'WHATSAPP_WORKFLOW') inferred.push('WhatsApp-dependent appointment inquiry flow identified');
      else if (e.evidence_type === 'INQUIRY_FORM') inferred.push('Static contact form without conversational automation detected');
      else if (e.evidence_type === 'MISSING_CAPABILITY') inferred.push('Absent self-service booking system for service business');
    }
  });

  // Services catalog
  if (profile?.products_services) {
    try {
      const services = typeof profile.products_services === 'string' ? JSON.parse(profile.products_services) : profile.products_services;
      if (services.length >= 4) {
        verified.push(`Multi-service catalog: ${services.length} procedure/service offerings listed`);
      }
    } catch (_) {}
  }

  // Google Rating
  if (parseFloat(lead.rating) >= 4.5) {
    verified.push(`High customer satisfaction reputation: ${lead.rating}★ Google Rating`);
  }

  // Inferred Customer Type
  if (profile?.target_customer_type) {
    inferred.push(`Commercial model inferred as: ${profile.target_customer_type}`);
  }

  return { verified, inferred, unknown };
}

/**
 * Detect whether the business has verified evidence of a mature modern digital / automation stack.
 * Strictly excludes generic web presence (SSL, viewport, generic CMS, social media, ratings).
 */
export function hasMatureDigitalStack(evidence = [], signals = []) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;

  const matureTechPattern = /acuity|fresha|booksy|jane\s*app|calendly|mindbody|zenoti|hubspot|zoho\s*(crm|forms)|salesforce|activecampaign|intercom|drift|tidio|livechat/i;

  // 1. Evidence check
  const hasMatureEvidence = evidence.some(e => {
    const type = (e.evidence_type || '').toUpperCase();
    if (['ONLINE_BOOKING', 'BOOKING_SYSTEM', 'CRM_INTEGRATION', 'CONVERSATIONAL_AGENT'].includes(type)) return true;
    if (type === 'TECHNOLOGY_DETECTION' && matureTechPattern.test(e.extracted_value || e.evidence_name || '')) return true;
    return false;
  });

  if (hasMatureEvidence) return true;

  // 2. Signals check
  const hasMatureSignal = (signals || []).some(s => {
    const type = (s.signal_type || s.type || '').toUpperCase();
    const key = (s.signal_key || s.key || '').toUpperCase();
    const val = (s.signal_value || s.value || '').toString();

    if (type === 'TECHNOLOGY_STACK' && ['BOOKING', 'CRM', 'LIVE_CHAT', 'AUTOMATION'].includes(key)) return true;
    if (['SELF_SERVICE_BOOKING', 'ONLINE_SCHEDULING', 'CRM_INTEGRATION', 'AUTOMATION_WORKFLOW'].includes(key)) return true;
    if (matureTechPattern.test(val)) return true;
    return false;
  });

  return Boolean(hasMatureSignal);
}

/**
 * Evaluate Deterministic Action Category and Urgency
 */
export function evaluateActionCategory(lead, score, channelInfo, freshness, evidence = [], signals = [], profile = null) {
  const priorityBand = (score?.priority_level || 'P3').split(' ')[0];
  const oppScore = score?.opportunity_score ?? score?.opportunityScore ?? 10;
  const dataConf = score?.data_confidence_score ?? score?.dataConfidenceScore ?? 50;
  const hasEvidence = Array.isArray(evidence) && evidence.length > 0;

  // 1. P5 Disqualified -> INSUFFICIENT_DATA_HOLD
  if (priorityBand === 'P5') {
    return {
      actionType: ACTION_TYPES.INSUFFICIENT_DATA_HOLD,
      urgency: URGENCY_LEVELS.BLOCKED,
      headline: 'Hold in Enrichment Queue — Disqualified Lead',
      reasoning: 'Lead is disqualified or outside of operational parameters.'
    };
  }

  // 2. P4 Low ICP Fit -> QUALIFY_LOW_FIT
  if (priorityBand === 'P4') {
    return {
      actionType: ACTION_TYPES.QUALIFY_LOW_FIT,
      urgency: URGENCY_LEVELS.LOW,
      headline: 'Deprioritize — Outside Primary Target ICP Verticals',
      reasoning: 'Business category exhibits lower ICP fit alignment. Recommended for passive inbound qualification only.'
    };
  }

  // 3. Stale Evidence (>90 Days) -> RESEARCH_GAPS
  if (freshness === 'STALE') {
    return {
      actionType: ACTION_TYPES.RESEARCH_GAPS,
      urgency: URGENCY_LEVELS.STANDARD,
      headline: 'Refresh Intelligence — Verification Evidence Is Aging (>90 Days)',
      reasoning: 'Stored web crawl evidence is over 90 days old. Perform a fresh web analysis before conducting high-priority outreach.'
    };
  }

  // 4. Un-enriched Baseline Leads (Zero Crawled Evidence) -> RESEARCH_GAPS
  // Un-enriched baseline leads must NOT be assumed to have low opportunity or mature digital stack.
  if (!hasEvidence) {
    return {
      actionType: ACTION_TYPES.RESEARCH_GAPS,
      urgency: URGENCY_LEVELS.STANDARD,
      headline: 'Enrich Lead Profile — Un-enriched Baseline Record Lacks Web Intelligence',
      reasoning: 'Zero web crawl evidence recorded. Opportunity score is uncalibrated baseline. Run web intelligence enrichment before sales prioritization.'
    };
  }

  // 5. Low Data Confidence (< 30) on scored lead with evidence -> INSUFFICIENT_DATA_HOLD
  if (dataConf < 30) {
    return {
      actionType: ACTION_TYPES.INSUFFICIENT_DATA_HOLD,
      urgency: URGENCY_LEVELS.BLOCKED,
      headline: 'Hold in Enrichment Queue — Insufficient Observable Intelligence',
      reasoning: 'Data confidence is below minimum operational threshold. Direct sales outreach is paused until web presence or contact verification is performed.'
    };
  }

  // 6. High Priority P1 or P2 with Verified Direct Channel -> DIRECT_OUTREACH
  const hasDirectChannel = [RECOMMENDED_CHANNELS.WHATSAPP, RECOMMENDED_CHANNELS.EMAIL, RECOMMENDED_CHANNELS.PHONE].includes(channelInfo.channel);
  
  if ((priorityBand === 'P1' || priorityBand === 'P2') && oppScore >= 40 && hasDirectChannel) {
    const isWhatsApp = channelInfo.channel === RECOMMENDED_CHANNELS.WHATSAPP;
    return {
      actionType: ACTION_TYPES.DIRECT_OUTREACH,
      urgency: priorityBand === 'P1' ? URGENCY_LEVELS.IMMEDIATE : URGENCY_LEVELS.HIGH,
      headline: isWhatsApp 
        ? 'Prioritize for WhatsApp Booking & Inquiry Automation Pitch'
        : 'Prioritize for Executive Outreach & Workflow Automation Pitch',
      reasoning: isWhatsApp
        ? 'High ICP fit combined with observable reliance on manual WhatsApp/phone inquiry without self-service booking. High likelihood of immediate ROI.'
        : 'Strong ICP fit with direct verified communication channel and observable manual inquiry bottlenecks.'
    };
  }

  // 7. High Priority but only Generic Channel or Missing DM -> CONTACT_DECISION_MAKER
  if ((priorityBand === 'P1' || priorityBand === 'P2') && oppScore >= 40 && !hasDirectChannel) {
    return {
      actionType: ACTION_TYPES.CONTACT_DECISION_MAKER,
      urgency: URGENCY_LEVELS.HIGH,
      headline: 'Research Executive Contact — Strong Opportunity with Generic Channel Only',
      reasoning: 'Significant automation gaps detected, but direct executive mobile or email is unconfirmed. Research decision-maker before outreach.'
    };
  }

  // 8. Low Observable Opportunity (<= 20) with VERIFIED MATURE STACK -> MONITOR_NURTURE
  if (oppScore <= 20) {
    const isMature = hasMatureDigitalStack(evidence, signals);
    if (isMature) {
      return {
        actionType: ACTION_TYPES.MONITOR_NURTURE,
        urgency: URGENCY_LEVELS.LOW,
        headline: 'Nurture & Monitor — Modern Digital Capabilities Already Active',
        reasoning: 'Business exhibits verified digital booking, integrated CRM, or modern conversational responder. No acute automation bottlenecks observed.'
      };
    }
    // Low opportunity baseline without confirmed mature stack -> RESEARCH_GAPS
    return {
      actionType: ACTION_TYPES.RESEARCH_GAPS,
      urgency: URGENCY_LEVELS.STANDARD,
      headline: 'Investigate Opportunity — Low Opportunity Baseline Without Confirmed Mature Stack',
      reasoning: 'Observed opportunity is low but no mature self-service booking or CRM platform was confirmed. Further research required.'
    };
  }

  // 9. Baseline / Incomplete Signal Coverage -> RESEARCH_GAPS
  return {
    actionType: ACTION_TYPES.RESEARCH_GAPS,
    urgency: URGENCY_LEVELS.STANDARD,
    headline: 'Investigate Opportunity — Moderate ICP Fit with Incomplete Signal Coverage',
    reasoning: 'Baseline opportunity profile. Initiate web crawl enrichment to uncover specific workflow bottlenecks.'
  };
}

/**
 * Generate Complete Sales Action Recommendation Dossier
 */
export function generateLeadRecommendation(leadId, options = {}) {
  const {
    tenantId = 'default',
    dbInstance,
    persist = true,
    forceRecalculate = false
  } = options;

  if (!dbInstance) {
    throw new Error('dbInstance is required for recommendation generation');
  }

  const ownership = dbInstance.validateLeadOwnership(leadId, tenantId);
  if (!ownership.valid) {
    throw new Error(ownership.reason || 'Lead authorization failed');
  }

  const lead = ownership.lead;

  // 1. Ingest existing scores (or fetch latest snapshot)
  let score = dbInstance.getLatestLeadScore(leadId, tenantId);
  if (!score) {
    throw new Error(`No scoring snapshot found for lead ${leadId}. Lead must be scored first.`);
  }

  // 2. Ingest intelligence, contacts, evidence, signals, entity group
  const profile = dbInstance.getLeadIntelligence(leadId, tenantId);
  const contacts = dbInstance.getLeadContacts(leadId, tenantId) || [];
  const evidence = dbInstance.getLeadEvidence(leadId, tenantId) || [];
  const signals = dbInstance.getLeadSignals(leadId, tenantId) || [];
  const entityGroup = dbInstance.getEntityGroupByLeadId ? dbInstance.getEntityGroupByLeadId(leadId, tenantId) : null;

  // 3. Compute Input Hash
  const inputHash = generateRecommendationInputHash(lead, score, contacts, evidence, signals);

  // 4. Caching Check
  if (persist && !forceRecalculate) {
    const existingRec = dbInstance.getRecommendationByInputHash(leadId, inputHash, tenantId);
    if (existingRec) {
      return {
        ...existingRec,
        cached: true
      };
    }
  }

  // 5. Evaluate Freshness
  const latestVerifiedAt = evidence.map(e => e.verified_at || e.created_at).sort().reverse()[0] || profile?.last_analyzed_at || lead.updatedAt || lead.createdAt;
  const freshness = evaluateFreshness(latestVerifiedAt, 60);

  // 6. Select Optimal Channel
  const channelInfo = selectOptimalChannel(lead, contacts, signals, evidence);

  // 7. Evaluate Action Category & Urgency
  const actionEvaluation = evaluateActionCategory(lead, score, channelInfo, freshness, evidence, signals, profile);

  // 8. Segregate Facts (Verified vs Inferred vs Unknown)
  const facts = segregateRecommendationFacts(lead, profile, contacts, evidence, signals, score);

  // 9. Multi-Location Awareness
  let multiLocationContext = null;
  if (entityGroup && (entityGroup.entity_type === 'MULTI_LOCATION' || entityGroup.entity_type === 'FRANCHISE')) {
    const isCanonical = entityGroup.canonical_lead_id === leadId;
    multiLocationContext = {
      groupId: entityGroup.id,
      entityName: entityGroup.entity_name,
      isCanonical,
      role: isCanonical ? 'PRIMARY_LOCATION' : 'BRANCH_LOCATION',
      guidance: isCanonical
        ? `Primary/Headquarters location for ${entityGroup.entity_name}. Direct enterprise outreach recommended.`
        : `Branch location of ${entityGroup.entity_name}. Coordinate outreach with Primary Location.`
    };
  }

  // 10. Supporting Factor References
  const supportingFactors = [
    `Priority Band: ${(score.priority_level || 'P3').split(' ')[0]} (Sales Priority: ${score.sales_priority_score ?? score.salesPriorityScore})`,
    `Observable Opportunity: ${score.opportunity_score ?? score.opportunityScore}/100`,
    `Target ICP Fit: ${score.icp_fit_score ?? score.icpFitScore}/100`,
    `Recommended Channel: ${channelInfo.channel} (${channelInfo.rationale})`
  ];

  if (multiLocationContext) {
    supportingFactors.push(multiLocationContext.guidance);
  }

  const recommendationRecord = {
    lead_id: leadId,
    tenant_id: tenantId,
    engine_version: RECOMMENDATION_ENGINE_VERSION,
    score_id: score.id || null,
    action_type: actionEvaluation.actionType,
    priority_band: (score.priority_level || 'P3').split(' ')[0],
    urgency: actionEvaluation.urgency,
    recommended_channel: channelInfo.channel,
    target_contact_id: channelInfo.targetContactId,
    target_contact_name: channelInfo.targetContactName,
    target_contact_handle: channelInfo.targetContactHandle,
    headline: actionEvaluation.headline,
    reasoning_summary: actionEvaluation.reasoning,
    supporting_factors: supportingFactors,
    supporting_evidence_ids: evidence.map(e => e.id),
    supporting_signal_ids: signals.map(s => s.id),
    confidence_score: score.data_confidence_score ?? score.dataConfidenceScore ?? 50.0,
    freshness_status: freshness,
    input_hash: inputHash,
    review_status: 'PENDING',
    created_at: new Date().toISOString()
  };

  // 11. Persist Snapshot if requested
  let savedRecord = recommendationRecord;
  if (persist) {
    savedRecord = dbInstance.addRecommendation(leadId, recommendationRecord, tenantId);
  }

  return {
    ...savedRecord,
    cached: false,
    channelInfo,
    facts,
    multiLocationContext,
    disclaimer: 'Sales action recommendations are advisory decision-support suggestions for human sales representatives. Zero autonomous outreach is performed.'
  };
}

/**
 * Batch Generate Recommendations
 */
export async function batchGenerateRecommendations(leadIds = [], options = {}) {
  const { tenantId = 'default', dbInstance, forceRecalculate = false } = options;
  if (!dbInstance) throw new Error('dbInstance is required');

  const results = [];
  const errors = [];

  for (const id of leadIds) {
    try {
      const rec = generateLeadRecommendation(id, { tenantId, dbInstance, forceRecalculate });
      results.push(rec);
    } catch (err) {
      errors.push({ leadId: id, error: err.message });
    }
  }

  return {
    totalRequested: leadIds.length,
    processed: results.length,
    failed: errors.length,
    errors,
    results
  };
}
