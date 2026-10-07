import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), 'leads.db');
const LEGACY_JSON_PATH = path.join(process.cwd(), 'data.json');

// Mapping of sensitive settings keys to environment variable names
export const SENSITIVE_SETTING_KEYS = {
  placesApiKey: 'PLACES_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  googleTokens: 'GOOGLE_TOKENS',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
  telegramApiHash: 'TELEGRAM_API_HASH',
  telegramUserSession: 'TELEGRAM_USER_SESSION'
};

/**
 * Persist updated sensitive environment variables into local .env file
 */
export function updateEnvFile(updates, overrideEnvPath = null) {
  try {
    const envPath = overrideEnvPath || process.env.ENV_PATH || path.join(process.cwd(), '.env');
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }

    const lines = content ? content.split(/\r?\n/) : [];
    const handled = new Set();

    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const k = line.substring(0, eqIdx).trim();
      if (k in updates) {
        handled.add(k);
        const val = updates[k] === null || updates[k] === undefined ? '' : String(updates[k]);
        return `${k}=${val}`;
      }
      return line;
    });

    for (const [k, v] of Object.entries(updates)) {
      if (!handled.has(k)) {
        const val = v === null || v === undefined ? '' : String(v);
        newLines.push(`${k}=${val}`);
      }
    }

    fs.writeFileSync(envPath, newLines.join('\n').trim() + '\n', 'utf8');
  } catch (err) {
    console.warn('[Database] Failed to write updates to .env file:', err.message);
  }
}

const DEFAULT_SETTINGS = {
  leadSourceProvider: 'auto',
  googleClientId: '',
  googleRedirectUri: 'http://localhost:3000/oauth2callback',
  googleSheetId: '',
  emailSubjectTemplate: 'Partnership Opportunity - {{BusinessName}}',
  emailBodyTemplate: 'Hi {{BusinessName}} team,\n\nI came across your business in {{Location}} and wanted to reach out. We provide solutions that could support your operations.\n\nWould you be open to a quick call this week?\n\nBest regards,\n[Your Name]\n[Your Company]',
  waMessageTemplate: 'Hi {{BusinessName}} team,\n\nI found your business in {{Location}} and wanted to connect. Do you have a few minutes for a quick call this week?\n\nBest regards,\n[Your Name]',
  waNoWebsiteTemplate: 'Namaste {{BusinessName}} team! 👋\n\nCongratulations on your {{Rating}} rating on Google Maps in {{Location}}!\n\nI noticed customers searching you on Google have no official website or instant WhatsApp booking link to view your services. You might be losing 30-50 inquiries every month to nearby competitors.\n\nWe build Instant 24/7 AI WhatsApp Chatbots & 1-Page Mobile Websites for businesses in {{Location}} so you automatically capture and reply to every customer inquiry instantly.\n\nCan I share a 60-second video demo for {{BusinessName}}?\n\nBest regards,\nTanuj Chandel & Amit Pandey | AI AutomationHubs (📞 +91-7704077700)',
  smsMessageTemplate: 'Hi {{BusinessName}}, we noticed your business in {{Location}} and have a quick growth opportunity to share. Can we connect today?',
  telegramMessageTemplate: 'Hi {{BusinessName}} team 👋\n\nI found your business in {{Location}} and wanted to connect!\n\nWe at AI AutomationHubs engineer custom AI Copilots & Business Automation Workflows to help businesses save time and cut costs.\n\n{{PersonalizedPitch}}\n\n📇 Our Visiting Card & Details:\n• Amit Pandey (Co-founder & AI Automation Engineer) | 📞 +91-9990080408\n• Tanuj Chandel (Co-founder & AI Generalist) | 📞 +91-7704077700\n• Card: http://localhost:3000/visiting_card.jpg\n• Website: https://ai-automation-hubs.com\n\nAre you open for a quick 2-minute chat this week?',
  waDelayMin: 15,
  waDelayMax: 30,
  tgDelayMin: 45,
  tgDelayMax: 75,
  waDailyLimit: 50,
  tgDailyLimit: 30,
  emailDailyLimit: 100,
  waCooldownHours: 48,
  tgCooldownHours: 48,
  emailCooldownHours: 72,
  waMaxAttempts: 3,
  tgMaxAttempts: 3,
  emailMaxAttempts: 5
};

class SQLiteDatabase {
  constructor() {
    this.sqlite = new Database(DB_PATH);
    // Enable WAL (Write-Ahead Logging) for high concurrency and zero locking issues
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.initTables();
    this.migrateFromLegacyJson();
    this.migrateAndSanitizeSettings();
  }

  initTables() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        term TEXT,
        location TEXT,
        maxLeads INTEGER DEFAULT 20,
        status TEXT DEFAULT 'Pending',
        error TEXT DEFAULT '',
        createdAt TEXT
      );

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        createdAt TEXT,
        searchTerm TEXT,
        location TEXT,
        businessName TEXT,
        address TEXT,
        phone TEXT,
        website TEXT,
        email TEXT,
        rating REAL,
        facebook TEXT,
        instagram TEXT,
        linkedin TEXT,
        twitter TEXT,
        segment TEXT,
        qualityScore TEXT,
        leadStatus TEXT DEFAULT 'New',
        emailStatus TEXT DEFAULT 'Pending',
        whatsappStatus TEXT DEFAULT 'Pending',
        scrapeStatus TEXT,
        placeId TEXT,
        notes TEXT,
        humanApproval TEXT,
        scoring TEXT,
        verificationStatus TEXT,
        dataMode TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_leads_placeId ON leads(placeId);
      CREATE INDEX IF NOT EXISTS idx_leads_website ON leads(website);
      CREATE INDEX IF NOT EXISTS idx_leads_segment ON leads(segment);
      CREATE INDEX IF NOT EXISTS idx_leads_qualityScore ON leads(qualityScore);

      CREATE TABLE IF NOT EXISTS whatsapp_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        leadId TEXT,
        leadName TEXT,
        phone TEXT,
        status TEXT,
        errorMessage TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON whatsapp_logs(timestamp);
    `);

    try {
      this.sqlite.exec(`ALTER TABLE leads ADD COLUMN telegram TEXT;`);
    } catch (e) {
      // Column already exists
    }
    try { this.sqlite.exec(`ALTER TABLE leads ADD COLUMN lastReplyText TEXT;`); } catch (e) {}
    try { this.sqlite.exec(`ALTER TABLE leads ADD COLUMN lastReplyAt TEXT;`); } catch (e) {}
    try { this.sqlite.exec(`ALTER TABLE leads ADD COLUMN aiSuggestedReply TEXT;`); } catch (e) {}

    // Run Phase 1 Compliance & Safety Schema Migration
    this.runComplianceSchemaMigration();

    // Run Phase 2 Advanced Lead Intelligence Schema Migration
    this.runIntelligenceSchemaMigration();

    // Run Phase 2 Step 6 Campaign & Outreach Planning Schema Migration
    this.runCampaignSchemaMigration();

    // Ensure foreign key constraints are enabled
    this.sqlite.pragma('foreign_keys = ON');

    // Ensure default settings row exists
    const row = this.sqlite.prepare('SELECT id FROM settings WHERE id = 1').get();
    if (!row) {
      this.sqlite.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  runComplianceSchemaMigration() {
    try {
      // 1. Lead Safety Fields (Idempotent column addition via PRAGMA check)
      const leadColumns = this.sqlite.prepare(`PRAGMA table_info(leads)`).all().map(c => c.name);

      const safetyColumns = [
        { name: 'outreach_attempt_count', def: 'INTEGER DEFAULT 0' },
        { name: 'last_outreach_at', def: 'TEXT DEFAULT NULL' },
        { name: 'last_outreach_channel', def: 'TEXT DEFAULT NULL' },
        { name: 'last_inbound_at', def: 'TEXT DEFAULT NULL' },
        { name: 'opted_out', def: 'INTEGER DEFAULT 0' },
        { name: 'opted_out_at', def: 'TEXT DEFAULT NULL' },
        { name: 'opted_out_source', def: 'TEXT DEFAULT NULL' }
      ];

      for (const col of safetyColumns) {
        if (!leadColumns.includes(col.name)) {
          this.sqlite.exec(`ALTER TABLE leads ADD COLUMN ${col.name} ${col.def};`);
        }
      }

      // Add tenant_id to leads table if not present
      if (!leadColumns.includes('tenant_id')) {
        this.sqlite.exec(`ALTER TABLE leads ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';`);
        this.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);`);
      }

      // Backfill last_inbound_at from existing lastReplyAt if available
      try {
        this.sqlite.exec(`
          UPDATE leads
          SET last_inbound_at = lastReplyAt
          WHERE (last_inbound_at IS NULL OR last_inbound_at = '')
            AND lastReplyAt IS NOT NULL AND lastReplyAt != '';
        `);
      } catch (_) {}

      // 2. Suppression List Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS suppression_list (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          lead_id TEXT DEFAULT NULL,
          normalized_contact TEXT NOT NULL,
          contact_type TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'ALL',
          original_contact TEXT DEFAULT NULL,
          reason TEXT NOT NULL,
          source TEXT NOT NULL,
          suppressed_at TEXT NOT NULL,
          expires_at TEXT DEFAULT NULL,
          notes TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_unique
          ON suppression_list(tenant_id, normalized_contact, channel);
        CREATE INDEX IF NOT EXISTS idx_suppression_contact
          ON suppression_list(normalized_contact);
        CREATE INDEX IF NOT EXISTS idx_suppression_tenant_channel
          ON suppression_list(tenant_id, channel);
        CREATE INDEX IF NOT EXISTS idx_suppression_expires
          ON suppression_list(expires_at);
        CREATE INDEX IF NOT EXISTS idx_suppression_leadId
          ON suppression_list(lead_id);
      `);

      // 3. Compliance Audit Logs Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS compliance_audit_logs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          lead_id TEXT DEFAULT NULL,
          channel TEXT DEFAULT NULL,
          event_type TEXT NOT NULL,
          contact_identifier TEXT DEFAULT NULL,
          decision TEXT NOT NULL,
          reason TEXT DEFAULT NULL,
          metadata TEXT DEFAULT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_audit_created
          ON compliance_audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_lead
          ON compliance_audit_logs(lead_id);
        CREATE INDEX IF NOT EXISTS idx_audit_event
          ON compliance_audit_logs(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_tenant_channel
          ON compliance_audit_logs(tenant_id, channel);
      `);

      // 4. Channel Outreach State Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS channel_outreach_state (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          attempt_count INTEGER DEFAULT 0,
          last_attempt_at TEXT DEFAULT NULL,
          next_eligible_at TEXT DEFAULT NULL,
          last_result TEXT DEFAULT NULL,
          blocked_reason TEXT DEFAULT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_state_lead_channel
          ON channel_outreach_state(lead_id, channel);
        CREATE INDEX IF NOT EXISTS idx_channel_state_next_eligible
          ON channel_outreach_state(next_eligible_at);
        CREATE INDEX IF NOT EXISTS idx_channel_state_lead
          ON channel_outreach_state(lead_id);
      `);

      // 5. Daily Quota Usage Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS daily_quota_usage (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          channel TEXT NOT NULL,
          date TEXT NOT NULL,
          attempt_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          blocked_count INTEGER DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_quota_unique
          ON daily_quota_usage(tenant_id, channel, date);
        CREATE INDEX IF NOT EXISTS idx_daily_quota_lookup
          ON daily_quota_usage(tenant_id, channel, date);
      `);

      // 6. Lead Safety Indexes
      this.sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_opted_out ON leads(opted_out);
        CREATE INDEX IF NOT EXISTS idx_leads_last_outreach ON leads(last_outreach_at);
      `);

    } catch (err) {
      console.error('❌ Failed to run compliance schema migration:', err);
      throw err;
    }
  }

  runIntelligenceSchemaMigration() {
    try {
      // 1. Lead Intelligence Table (1:1 Profile per lead)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_intelligence (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          industry TEXT DEFAULT NULL,
          sub_industry TEXT DEFAULT NULL,
          business_type TEXT DEFAULT NULL,
          company_size_estimate TEXT DEFAULT NULL,
          employee_count_estimate INTEGER DEFAULT NULL,
          geographic_scope TEXT DEFAULT NULL,
          service_area TEXT DEFAULT NULL,
          business_description TEXT DEFAULT NULL,
          products_services TEXT DEFAULT NULL,
          target_customer_type TEXT DEFAULT NULL,
          technology_signals TEXT DEFAULT NULL,
          automation_signals TEXT DEFAULT NULL,
          growth_signals TEXT DEFAULT NULL,
          pain_point_signals TEXT DEFAULT NULL,
          website_quality_score REAL DEFAULT 0.0,
          digital_presence_score REAL DEFAULT 0.0,
          intelligence_score REAL DEFAULT 0.0,
          confidence_score REAL DEFAULT 0.0,
          last_analyzed_at TEXT DEFAULT NULL,
          intelligence_version INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_lead_id
          ON lead_intelligence(lead_id);
        CREATE INDEX IF NOT EXISTS idx_intel_tenant
          ON lead_intelligence(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_intel_industry
          ON lead_intelligence(industry);
        CREATE INDEX IF NOT EXISTS idx_intel_score
          ON lead_intelligence(intelligence_score);
      `);

      // 2. Lead Contacts Table (1:N Contacts per lead)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_contacts (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          contact_name TEXT DEFAULT NULL,
          first_name TEXT DEFAULT NULL,
          last_name TEXT DEFAULT NULL,
          job_title TEXT DEFAULT NULL,
          department TEXT DEFAULT NULL,
          contact_type TEXT DEFAULT 'OTHER',
          phone TEXT DEFAULT NULL,
          email TEXT DEFAULT NULL,
          linkedin_url TEXT DEFAULT NULL,
          source TEXT DEFAULT NULL,
          verification_status TEXT DEFAULT 'UNVERIFIED',
          confidence_score REAL DEFAULT 0.0,
          is_decision_maker INTEGER DEFAULT 0,
          provenance_type TEXT CHECK (provenance_type IN ('VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN')) DEFAULT 'UNKNOWN',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_contacts_lead_id
          ON lead_contacts(lead_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_tenant
          ON lead_contacts(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_decision_maker
          ON lead_contacts(is_decision_maker);
        CREATE INDEX IF NOT EXISTS idx_contacts_email
          ON lead_contacts(email);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone
          ON lead_contacts(phone);
      `);

      // 3. Lead Evidence Table (1:N Verifiable evidence records)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_evidence (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          evidence_type TEXT NOT NULL,
          source_url TEXT DEFAULT NULL,
          source_name TEXT DEFAULT NULL,
          evidence_text TEXT DEFAULT NULL,
          extracted_value TEXT DEFAULT NULL,
          confidence_score REAL DEFAULT 0.0,
          verified_at TEXT DEFAULT NULL,
          expires_at TEXT DEFAULT NULL,
          extraction_method TEXT DEFAULT NULL,
          provenance_type TEXT CHECK (provenance_type IN ('VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN')) DEFAULT 'UNKNOWN',
          created_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_evidence_lead_id
          ON lead_evidence(lead_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_tenant
          ON lead_evidence(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_type
          ON lead_evidence(evidence_type);
      `);

      // 4. Lead Signals Table (1:N Signals linked to evidence)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_signals (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          signal_type TEXT NOT NULL,
          signal_value TEXT DEFAULT NULL,
          signal_strength TEXT DEFAULT 'MEDIUM',
          source TEXT DEFAULT NULL,
          evidence_id TEXT DEFAULT NULL,
          confidence_score REAL DEFAULT 0.0,
          detected_at TEXT NOT NULL,
          expires_at TEXT DEFAULT NULL,
          provenance_type TEXT CHECK (provenance_type IN ('VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN')) DEFAULT 'UNKNOWN',
          created_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (evidence_id) REFERENCES lead_evidence(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_signals_lead_id
          ON lead_signals(lead_id);
        CREATE INDEX IF NOT EXISTS idx_signals_tenant
          ON lead_signals(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_signals_type
          ON lead_signals(signal_type);
        CREATE INDEX IF NOT EXISTS idx_signals_evidence
          ON lead_signals(evidence_id);
      `);

      // 5. Lead Scores Table (1:N Versioned score records)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_scores (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          score_type TEXT NOT NULL,
          score REAL NOT NULL,
          score_version INTEGER DEFAULT 1,
          scoring_reason TEXT DEFAULT NULL,
          confidence_score REAL DEFAULT 0.0,
          calculated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_scores_lead_id
          ON lead_scores(lead_id);
        CREATE INDEX IF NOT EXISTS idx_scores_tenant
          ON lead_scores(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_scores_type
          ON lead_scores(score_type);
      `);

      // 6. Lead Entity Groups Table (Business Entities)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_entity_groups (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          canonical_lead_id TEXT DEFAULT NULL,
          entity_name TEXT NOT NULL,
          normalized_name TEXT,
          primary_domain TEXT,
          entity_type TEXT CHECK (entity_type IN ('SINGLE_LOCATION', 'MULTI_LOCATION', 'FRANCHISE', 'CORPORATE_PARENT', 'UNKNOWN')) DEFAULT 'SINGLE_LOCATION',
          confidence_score REAL DEFAULT 1.0,
          status TEXT CHECK (status IN ('AUTO_RESOLVED', 'MANUALLY_CONFIRMED', 'SPLIT', 'MERGED', 'PENDING_REVIEW')) DEFAULT 'AUTO_RESOLVED',
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (canonical_lead_id) REFERENCES leads(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_entity_groups_tenant
          ON lead_entity_groups(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_entity_groups_canonical
          ON lead_entity_groups(canonical_lead_id);
        CREATE INDEX IF NOT EXISTS idx_entity_groups_domain
          ON lead_entity_groups(primary_domain);
        CREATE INDEX IF NOT EXISTS idx_entity_groups_norm_name
          ON lead_entity_groups(normalized_name);
        CREATE INDEX IF NOT EXISTS idx_entity_groups_type
          ON lead_entity_groups(entity_type);
        CREATE INDEX IF NOT EXISTS idx_entity_groups_status
          ON lead_entity_groups(status);
      `);

      // 7. Lead Entity Members Table (Entity Graph Memberships)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS lead_entity_members (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          role TEXT CHECK (role IN ('CANONICAL', 'DUPLICATE', 'RELATED_LOCATION', 'POSSIBLE_DUPLICATE', 'REVIEW_REQUIRED')) NOT NULL,
          match_confidence REAL NOT NULL,
          match_reason TEXT NOT NULL,
          match_signals TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (group_id) REFERENCES lead_entity_groups(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          UNIQUE (group_id, lead_id)
        );

        CREATE INDEX IF NOT EXISTS idx_entity_members_group
          ON lead_entity_members(group_id);
        CREATE INDEX IF NOT EXISTS idx_entity_members_lead
          ON lead_entity_members(lead_id);
        CREATE INDEX IF NOT EXISTS idx_entity_members_tenant
          ON lead_entity_members(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_entity_members_role
          ON lead_entity_members(role);
      `);

      // 8. Enrichment Runs Observability Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS enrichment_runs (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          status TEXT CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')) DEFAULT 'QUEUED',
          started_at TEXT NOT NULL,
          completed_at TEXT DEFAULT NULL,
          pages_attempted INTEGER DEFAULT 0,
          pages_successful INTEGER DEFAULT 0,
          pages_failed INTEGER DEFAULT 0,
          evidence_count INTEGER DEFAULT 0,
          signals_count INTEGER DEFAULT 0,
          contacts_count INTEGER DEFAULT 0,
          error_message TEXT DEFAULT NULL,
          summary TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_enrichment_runs_lead
          ON enrichment_runs(lead_id);
        CREATE INDEX IF NOT EXISTS idx_enrichment_runs_tenant
          ON enrichment_runs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_enrichment_runs_status
          ON enrichment_runs(status);
      `);

      // 9. Phase 2 Step 4: Lead Scores Schema Extension (Idempotent column addition via PRAGMA check)
      const scoreColumns = this.sqlite.prepare(`PRAGMA table_info(lead_scores)`).all().map(c => c.name);
      const scoreExtensions = [
        { name: 'scoring_version', def: 'INTEGER DEFAULT 1' },
        { name: 'icp_profile_version', def: 'INTEGER DEFAULT 1' },
        { name: 'icp_fit_score', def: 'REAL DEFAULT 0.0' },
        { name: 'opportunity_score', def: 'REAL DEFAULT 0.0' },
        { name: 'data_confidence_score', def: 'REAL DEFAULT 0.0' },
        { name: 'sales_priority_score', def: 'REAL DEFAULT 0.0' },
        { name: 'priority_level', def: "TEXT DEFAULT 'P5'" },
        { name: 'positive_factors', def: "TEXT DEFAULT '[]'" },
        { name: 'negative_factors', def: "TEXT DEFAULT '[]'" },
        { name: 'unknown_factors', def: "TEXT DEFAULT '[]'" },
        { name: 'score_breakdown', def: "TEXT DEFAULT '{}'" },
        { name: 'scoring_inputs_snapshot', def: "TEXT DEFAULT '{}'" },
        { name: 'input_hash', def: 'TEXT DEFAULT NULL' }
      ];

      for (const col of scoreExtensions) {
        if (!scoreColumns.includes(col.name)) {
          this.sqlite.exec(`ALTER TABLE lead_scores ADD COLUMN ${col.name} ${col.def};`);
        }
      }

      this.sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_scores_priority
          ON lead_scores(priority_level);
        CREATE INDEX IF NOT EXISTS idx_scores_sales_priority
          ON lead_scores(sales_priority_score);
        CREATE INDEX IF NOT EXISTS idx_scores_input_hash
          ON lead_scores(lead_id, input_hash);
      `);

      // 10. Phase 2 Step 4: ICP Profiles Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS icp_profiles (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          version INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          description TEXT DEFAULT NULL,
          target_industries TEXT DEFAULT '[]',
          excluded_industries TEXT DEFAULT '[]',
          target_regions TEXT DEFAULT '[]',
          business_types TEXT DEFAULT '[]',
          weights TEXT DEFAULT '{}',
          rules TEXT DEFAULT '{}',
          is_active INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_tenant_version
          ON icp_profiles(tenant_id, version);
        CREATE INDEX IF NOT EXISTS idx_icp_tenant_active
          ON icp_profiles(tenant_id, is_active);
      `);

      // 11. Phase 2 Step 4: Scoring Runs Observability Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS scoring_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          status TEXT CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')) DEFAULT 'QUEUED',
          scoring_version INTEGER NOT NULL DEFAULT 1,
          icp_version INTEGER NOT NULL DEFAULT 1,
          total_requested INTEGER DEFAULT 0,
          leads_processed INTEGER DEFAULT 0,
          leads_scored INTEGER DEFAULT 0,
          leads_skipped INTEGER DEFAULT 0,
          errors TEXT DEFAULT '[]',
          summary TEXT DEFAULT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_scoring_runs_tenant
          ON scoring_runs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_scoring_runs_status
          ON scoring_runs(status);
      `);

      // 12. Phase 2 Step 5: Sales Action Recommendations Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS sales_action_recommendations (
          id TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          recommendation_version INTEGER NOT NULL DEFAULT 1,
          engine_version INTEGER NOT NULL DEFAULT 1,
          score_id TEXT,
          action_type TEXT NOT NULL,
          priority_band TEXT NOT NULL,
          urgency TEXT NOT NULL,
          recommended_channel TEXT NOT NULL,
          target_contact_id TEXT,
          target_contact_name TEXT,
          target_contact_handle TEXT,
          headline TEXT NOT NULL,
          reasoning_summary TEXT NOT NULL,
          supporting_factors TEXT NOT NULL,
          supporting_evidence_ids TEXT,
          supporting_signal_ids TEXT,
          confidence_score REAL NOT NULL,
          freshness_status TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          review_status TEXT NOT NULL DEFAULT 'PENDING',
          review_notes TEXT,
          reviewed_by TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (score_id) REFERENCES lead_scores(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_recs_lead_tenant
          ON sales_action_recommendations(lead_id, tenant_id);
        CREATE INDEX IF NOT EXISTS idx_recs_action_priority
          ON sales_action_recommendations(action_type, priority_band);
        CREATE INDEX IF NOT EXISTS idx_recs_review_status
          ON sales_action_recommendations(review_status);
        CREATE INDEX IF NOT EXISTS idx_recs_input_hash
          ON sales_action_recommendations(lead_id, input_hash);
      `);

    } catch (err) {
      console.error('❌ Failed to run intelligence schema migration:', err);
      throw err;
    }
  }

  runCampaignSchemaMigration() {
    try {
      // 1. Campaigns Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          name TEXT NOT NULL,
          objective TEXT NOT NULL CHECK (objective IN ('GENERATE_MEETINGS', 'QUALIFY_LEADS', 'RESEARCH_ENRICHMENT', 'REACTIVATE_COLD', 'MULTI_LOCATION_HQ')),
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
          target_criteria TEXT NOT NULL,
          channel_strategy TEXT NOT NULL,
          sequence_plan TEXT DEFAULT NULL,
          total_leads INTEGER NOT NULL DEFAULT 0 CHECK (total_leads >= 0),
          eligible_leads INTEGER NOT NULL DEFAULT 0 CHECK (eligible_leads >= 0),
          review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'APPROVED', 'REJECTED')),
          reviewed_by TEXT DEFAULT NULL,
          reviewed_at TEXT DEFAULT NULL,
          review_notes TEXT DEFAULT NULL,
          campaign_version INTEGER NOT NULL DEFAULT 1 CHECK (campaign_version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_campaigns_tenant
          ON campaigns(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaigns_status
          ON campaigns(status);
        CREATE INDEX IF NOT EXISTS idx_campaigns_review_status
          ON campaigns(review_status);
        CREATE INDEX IF NOT EXISTS idx_campaigns_created_at
          ON campaigns(created_at);
      `);

      // 2. Campaign Leads Join Table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaign_leads (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('ELIGIBLE', 'INELIGIBLE', 'RESEARCH_REQUIRED', 'HUMAN_REVIEW_REQUIRED')),
          planned_channel TEXT CHECK (planned_channel IS NULL OR planned_channel IN ('WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH')),
          target_contact_handle TEXT DEFAULT NULL,
          sequence_step INTEGER NOT NULL DEFAULT 1 CHECK (sequence_step >= 1),
          review_status TEXT NOT NULL DEFAULT 'INCLUDED' CHECK (review_status IN ('INCLUDED', 'EXCLUDED_BY_USER')),
          exclusion_reason TEXT DEFAULT NULL,
          eligibility_details TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          UNIQUE (campaign_id, lead_id)
        );

        CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign
          ON campaign_leads(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead
          ON campaign_leads(lead_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_tenant
          ON campaign_leads(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_eligibility
          ON campaign_leads(eligibility_status);
        CREATE INDEX IF NOT EXISTS idx_campaign_leads_channel
          ON campaign_leads(planned_channel);
      `);

      // 3. Campaign Touches Table (Step 6D)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaign_touches (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          campaign_lead_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          touch_number INTEGER NOT NULL CHECK (touch_number >= 1 AND touch_number <= 3),
          planned_channel TEXT NOT NULL CHECK (planned_channel IN ('WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH')),
          planned_at TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('INITIAL_OUTREACH', 'VALUE_ADD_FOLLOWUP', 'POLITE_CLOSE')),
          status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'BLOCKED', 'STOPPED', 'CANCELLED', 'DISPATCHING', 'SENT', 'FAILED')),
          stop_reason TEXT DEFAULT NULL,
          fallback_from TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          UNIQUE (campaign_lead_id, touch_number)
        );

        CREATE INDEX IF NOT EXISTS idx_campaign_touches_campaign
          ON campaign_touches(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_cpl
          ON campaign_touches(campaign_lead_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_lead
          ON campaign_touches(lead_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_tenant
          ON campaign_touches(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_status
          ON campaign_touches(status);
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_planned_at
          ON campaign_touches(planned_at);
      `);

      // 4. Schema Enhancements & Campaign Review Logs Table (Step 6E)
      const campaignCols = this.sqlite.prepare('PRAGMA table_info(campaigns)').all().map(c => c.name);
      if (!campaignCols.includes('review_hash')) {
        this.sqlite.exec('ALTER TABLE campaigns ADD COLUMN review_hash TEXT DEFAULT NULL;');
      }
      if (!campaignCols.includes('approved_version')) {
        this.sqlite.exec('ALTER TABLE campaigns ADD COLUMN approved_version INTEGER DEFAULT NULL;');
      }
      if (!campaignCols.includes('approval_metadata')) {
        this.sqlite.exec('ALTER TABLE campaigns ADD COLUMN approval_metadata TEXT DEFAULT NULL;');
      }

      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaign_review_logs (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          action TEXT NOT NULL CHECK (action IN ('SUBMITTED_FOR_REVIEW', 'APPROVED', 'REJECTED', 'REOPENED', 'CANCELLED', 'INVALIDATED_DUE_TO_MATERIAL_CHANGE')),
          previous_status TEXT NOT NULL,
          new_status TEXT NOT NULL,
          reviewer TEXT NOT NULL,
          review_hash TEXT DEFAULT NULL,
          campaign_version INTEGER NOT NULL DEFAULT 1,
          notes TEXT DEFAULT NULL,
          metadata TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_campaign_review_logs_campaign
          ON campaign_review_logs(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_review_logs_tenant
          ON campaign_review_logs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_review_logs_created_at
          ON campaign_review_logs(created_at);
      `);

      // 5. Campaign Execution Logs Table (Step 6F-A)
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaign_execution_logs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          campaign_id TEXT NOT NULL,
          campaign_lead_id TEXT NOT NULL,
          campaign_touch_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'SIMULATION', 'LIVE')),
          planned_channel TEXT NOT NULL,
          execution_status TEXT NOT NULL CHECK (execution_status IN ('WOULD_EXECUTE', 'BLOCKED', 'WOULD_SKIP', 'EXECUTED', 'FAILED')),
          decision_reason TEXT DEFAULT NULL,
          provider TEXT DEFAULT NULL,
          provider_message_id TEXT DEFAULT NULL,
          simulated INTEGER NOT NULL DEFAULT 1,
          gate_result TEXT DEFAULT NULL,
          eligibility_snapshot TEXT DEFAULT NULL,
          quota_snapshot TEXT DEFAULT NULL,
          approval_hash TEXT DEFAULT NULL,
          executed_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          metadata TEXT DEFAULT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_campaign
          ON campaign_execution_logs(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_touch
          ON campaign_execution_logs(campaign_touch_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_lead
          ON campaign_execution_logs(lead_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_tenant
          ON campaign_execution_logs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_created_at
          ON campaign_execution_logs(created_at);
      `);

      // 6. Campaign Touches Execution Columns (Step 6F-B.1)
      const touchCols = this.sqlite.prepare('PRAGMA table_info(campaign_touches)').all().map(c => c.name);
      if (!touchCols.includes('execution_status')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_status TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('dispatched_at')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN dispatched_at TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('provider_message_id')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN provider_message_id TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('execution_lock')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_lock TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('execution_error')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_error TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('execution_metadata')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_metadata TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('message_body')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN message_body TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('message_subject')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN message_subject TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('content_hash')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN content_hash TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_body')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_body TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_subject')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_subject TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_content_hash')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_content_hash TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_review_hash')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_review_hash TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_version')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_version INTEGER DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_at')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_at TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_by')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_by TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('approved_snapshot_id')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN approved_snapshot_id TEXT DEFAULT NULL;');
      }

      // 6b. Expand campaign_touches.status CHECK constraint (Step 6F-B.1 live dispatch)
      // SQLite does not allow ALTER TABLE to modify CHECK constraints; must rebuild the table.
      // Detect if the old narrow constraint exists by examining the stored DDL.
      const touchDdl = this.sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='campaign_touches'"
      ).get();
      const needsStatusExpansion = touchDdl && touchDdl.sql &&
        touchDdl.sql.includes("status IN ('PLANNED', 'BLOCKED', 'STOPPED', 'CANCELLED')") &&
        !touchDdl.sql.includes('DISPATCHING');

      if (needsStatusExpansion) {
        // Disable FK enforcement while rebuilding (must be outside a transaction)
        this.sqlite.pragma('foreign_keys = OFF');
        const rebuildTouches = this.sqlite.transaction(() => {
          this.sqlite.exec(`ALTER TABLE campaign_touches RENAME TO _campaign_touches_old;`);
          this.sqlite.exec(`
            CREATE TABLE campaign_touches (
              id TEXT PRIMARY KEY,
              campaign_id TEXT NOT NULL,
              campaign_lead_id TEXT NOT NULL,
              lead_id TEXT NOT NULL,
              tenant_id TEXT NOT NULL DEFAULT 'default',
              touch_number INTEGER NOT NULL CHECK (touch_number >= 1 AND touch_number <= 3),
              planned_channel TEXT NOT NULL CHECK (planned_channel IN ('WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH')),
              planned_at TEXT NOT NULL,
              purpose TEXT NOT NULL CHECK (purpose IN ('INITIAL_OUTREACH', 'VALUE_ADD_FOLLOWUP', 'POLITE_CLOSE')),
              status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'BLOCKED', 'STOPPED', 'CANCELLED', 'DISPATCHING', 'SENT', 'FAILED')),
              stop_reason TEXT DEFAULT NULL,
              fallback_from TEXT DEFAULT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              execution_status TEXT DEFAULT NULL,
              dispatched_at TEXT DEFAULT NULL,
              provider_message_id TEXT DEFAULT NULL,
              execution_lock TEXT DEFAULT NULL,
              execution_error TEXT DEFAULT NULL,
              execution_metadata TEXT DEFAULT NULL,
              message_body TEXT DEFAULT NULL,
              message_subject TEXT DEFAULT NULL,
              content_hash TEXT DEFAULT NULL,
              approved_body TEXT DEFAULT NULL,
              approved_subject TEXT DEFAULT NULL,
              approved_content_hash TEXT DEFAULT NULL,
              approved_review_hash TEXT DEFAULT NULL,
              approved_version INTEGER DEFAULT NULL,
              approved_at TEXT DEFAULT NULL,
              approved_by TEXT DEFAULT NULL,
              approved_snapshot_id TEXT DEFAULT NULL,
              execution_attempt_count INTEGER NOT NULL DEFAULT 0,
              execution_locked_at TEXT DEFAULT NULL,
              last_attempt_id TEXT DEFAULT NULL,
              FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
              FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
              FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
              UNIQUE (campaign_lead_id, touch_number)
            );
          `);
          this.sqlite.exec(`
            INSERT INTO campaign_touches
              SELECT
                id, campaign_id, campaign_lead_id, lead_id, tenant_id,
                touch_number, planned_channel, planned_at, purpose, status,
                stop_reason, fallback_from, created_at, updated_at,
                execution_status, dispatched_at, provider_message_id,
                execution_lock, execution_error, execution_metadata,
                message_body, message_subject, content_hash,
                approved_body, approved_subject, approved_content_hash,
                approved_review_hash, approved_version, approved_at,
                approved_by, approved_snapshot_id,
                execution_attempt_count, execution_locked_at, last_attempt_id
              FROM _campaign_touches_old;
          `);
          this.sqlite.exec(`DROP TABLE _campaign_touches_old;`);
        });
        rebuildTouches();
        this.sqlite.pragma('foreign_keys = ON');
        // Re-create indexes dropped along with the old table
        this.sqlite.exec(`
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_campaign ON campaign_touches(campaign_id);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_cpl ON campaign_touches(campaign_lead_id);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_lead ON campaign_touches(lead_id);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_tenant ON campaign_touches(tenant_id);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_status ON campaign_touches(status);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_planned_at ON campaign_touches(planned_at);
          CREATE INDEX IF NOT EXISTS idx_campaign_touches_lease ON campaign_touches(tenant_id, execution_status, execution_locked_at);
        `);
      }

      // 6c. Repair corrupted campaign-touch-dependent table FKs (safety net)
      // If the status constraint migration (6b) was interrupted mid-transaction,
      // tables created between the RENAME and DROP steps will have FKs pointing
      // to "_campaign_touches_old" instead of "campaign_touches". This renders
      // all INSERT/UPDATE operations on those tables broken.
      // Affected tables: campaign_approved_snapshots, campaign_execution_logs,
      //                  campaign_execution_attempts, campaign_reconciliation_records
      {
        const _touchDepTables = [
          {
            name: 'campaign_approved_snapshots',
            dropIdxSql: `
              DROP INDEX IF EXISTS idx_camp_approved_snapshots_camp;
              DROP INDEX IF EXISTS idx_camp_approved_snapshots_touch;
              DROP INDEX IF EXISTS idx_camp_approved_snapshots_lead;
              DROP INDEX IF EXISTS idx_camp_approved_snapshots_tenant;
              DROP INDEX IF EXISTS idx_camp_approved_snapshots_ver;
            `,
            createSql: `
              CREATE TABLE campaign_approved_snapshots (
                id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL DEFAULT 'default',
                campaign_touch_id TEXT NOT NULL,
                lead_id TEXT NOT NULL,
                touch_number INTEGER NOT NULL,
                channel TEXT NOT NULL,
                purpose TEXT NOT NULL,
                recipient_contact TEXT DEFAULT NULL,
                message_body TEXT NOT NULL,
                message_subject TEXT DEFAULT NULL,
                content_hash TEXT NOT NULL,
                review_hash TEXT NOT NULL,
                campaign_version INTEGER NOT NULL,
                approved_by TEXT NOT NULL,
                approved_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                claims_root_hash TEXT DEFAULT NULL,
                FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_camp ON campaign_approved_snapshots(campaign_id);
              CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_touch ON campaign_approved_snapshots(campaign_touch_id);
              CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_lead ON campaign_approved_snapshots(lead_id);
              CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_tenant ON campaign_approved_snapshots(tenant_id);
              CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_ver ON campaign_approved_snapshots(campaign_id, campaign_version);
            `
          },
          {
            name: 'campaign_execution_logs',
            dropIdxSql: `
              DROP INDEX IF EXISTS idx_campaign_execution_logs_campaign;
              DROP INDEX IF EXISTS idx_campaign_execution_logs_touch;
              DROP INDEX IF EXISTS idx_campaign_execution_logs_lead;
              DROP INDEX IF EXISTS idx_campaign_execution_logs_tenant;
              DROP INDEX IF EXISTS idx_campaign_execution_logs_created_at;
            `,
            createSql: `
              CREATE TABLE campaign_execution_logs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT 'default',
                campaign_id TEXT NOT NULL,
                campaign_lead_id TEXT NOT NULL,
                campaign_touch_id TEXT NOT NULL,
                lead_id TEXT NOT NULL,
                execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'SIMULATION', 'LIVE')),
                planned_channel TEXT NOT NULL,
                execution_status TEXT NOT NULL CHECK (execution_status IN ('WOULD_EXECUTE', 'BLOCKED', 'WOULD_SKIP', 'EXECUTED', 'FAILED')),
                decision_reason TEXT DEFAULT NULL,
                provider TEXT DEFAULT NULL,
                provider_message_id TEXT DEFAULT NULL,
                simulated INTEGER NOT NULL DEFAULT 1,
                gate_result TEXT DEFAULT NULL,
                eligibility_snapshot TEXT DEFAULT NULL,
                quota_snapshot TEXT DEFAULT NULL,
                approval_hash TEXT DEFAULT NULL,
                executed_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL,
                metadata TEXT DEFAULT NULL,
                FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_campaign ON campaign_execution_logs(campaign_id);
              CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_touch ON campaign_execution_logs(campaign_touch_id);
              CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_lead ON campaign_execution_logs(lead_id);
              CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_tenant ON campaign_execution_logs(tenant_id);
              CREATE INDEX IF NOT EXISTS idx_campaign_execution_logs_created_at ON campaign_execution_logs(created_at);
            `
          },
          {
            name: 'campaign_execution_attempts',
            dropIdxSql: `
              DROP INDEX IF EXISTS idx_exec_attempts_touch;
              DROP INDEX IF EXISTS idx_exec_attempts_campaign;
              DROP INDEX IF EXISTS idx_exec_attempts_idempotency;
              DROP INDEX IF EXISTS idx_exec_attempts_tenant;
              DROP INDEX IF EXISTS idx_exec_attempts_created_at;
            `,
            createSql: `
              CREATE TABLE campaign_execution_attempts (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT 'default',
                campaign_id TEXT NOT NULL,
                campaign_lead_id TEXT NOT NULL,
                campaign_touch_id TEXT NOT NULL,
                lead_id TEXT NOT NULL,
                operator_id TEXT NOT NULL,
                operator_name TEXT NOT NULL,
                operator_role TEXT NOT NULL,
                channel TEXT NOT NULL,
                provider TEXT DEFAULT NULL,
                attempt_number INTEGER NOT NULL DEFAULT 1,
                idempotency_key TEXT UNIQUE NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT DEFAULT NULL,
                result_status TEXT NOT NULL CHECK (result_status IN ('STARTED', 'PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN', 'PROVIDER_UNAVAILABLE', 'BLOCKED')),
                provider_message_id TEXT DEFAULT NULL,
                provider_response TEXT DEFAULT NULL,
                error_classification TEXT DEFAULT NULL,
                error_message TEXT DEFAULT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
                FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_exec_attempts_touch ON campaign_execution_attempts(campaign_touch_id);
              CREATE INDEX IF NOT EXISTS idx_exec_attempts_campaign ON campaign_execution_attempts(campaign_id);
              CREATE INDEX IF NOT EXISTS idx_exec_attempts_idempotency ON campaign_execution_attempts(idempotency_key);
              CREATE INDEX IF NOT EXISTS idx_exec_attempts_tenant ON campaign_execution_attempts(tenant_id);
              CREATE INDEX IF NOT EXISTS idx_exec_attempts_created_at ON campaign_execution_attempts(created_at);
            `
          },
          {
            name: 'campaign_reconciliation_records',
            dropIdxSql: `
              DROP INDEX IF EXISTS idx_reconcil_touch;
              DROP INDEX IF EXISTS idx_reconcil_campaign;
              DROP INDEX IF EXISTS idx_reconcil_attempt;
              DROP INDEX IF EXISTS idx_reconcil_tenant;
              DROP INDEX IF EXISTS idx_reconcil_created_at;
            `,
            createSql: `
              CREATE TABLE campaign_reconciliation_records (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT 'default',
                campaign_id TEXT NOT NULL,
                campaign_touch_id TEXT NOT NULL,
                campaign_lead_id TEXT NOT NULL,
                attempt_id TEXT DEFAULT NULL,
                operator_id TEXT NOT NULL,
                operator_name TEXT NOT NULL,
                operator_role TEXT NOT NULL,
                decision TEXT NOT NULL CHECK (decision IN ('VERIFIED_SENT', 'VERIFIED_NOT_SENT', 'REMAINS_UNCERTAIN')),
                reason TEXT NOT NULL,
                notes TEXT NOT NULL,
                evidence_type TEXT DEFAULT NULL,
                evidence_reference TEXT DEFAULT NULL,
                previous_touch_status TEXT NOT NULL,
                new_touch_status TEXT NOT NULL,
                previous_execution_status TEXT NOT NULL,
                new_execution_status TEXT NOT NULL,
                approval_hash TEXT DEFAULT NULL,
                campaign_version INTEGER DEFAULT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
                FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS idx_reconcil_touch ON campaign_reconciliation_records(campaign_touch_id);
              CREATE INDEX IF NOT EXISTS idx_reconcil_campaign ON campaign_reconciliation_records(campaign_id);
              CREATE INDEX IF NOT EXISTS idx_reconcil_attempt ON campaign_reconciliation_records(attempt_id);
              CREATE INDEX IF NOT EXISTS idx_reconcil_tenant ON campaign_reconciliation_records(tenant_id);
              CREATE INDEX IF NOT EXISTS idx_reconcil_created_at ON campaign_reconciliation_records(created_at);
            `
          }
        ];

        for (const tbl of _touchDepTables) {
          const ddl = this.sqlite.prepare(
            `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tbl.name}'`
          ).get();
          if (ddl && ddl.sql && ddl.sql.includes('_campaign_touches_old')) {
            console.warn(`⚠️  Repairing corrupted ${tbl.name} FK...`);
            this.sqlite.pragma('foreign_keys = OFF');
            const rowCount = this.sqlite.prepare(`SELECT COUNT(*) as c FROM "${tbl.name}"`).get().c;
            const tmpName = `_${tbl.name}_fk_repair_old`;
            const repair = this.sqlite.transaction(() => {
              this.sqlite.exec(tbl.dropIdxSql);
              this.sqlite.exec(`ALTER TABLE "${tbl.name}" RENAME TO "${tmpName}";`);
              this.sqlite.exec(tbl.createSql);
              if (rowCount > 0) {
                this.sqlite.exec(`INSERT INTO "${tbl.name}" SELECT * FROM "${tmpName}";`);
              }
              this.sqlite.exec(`DROP TABLE "${tmpName}";`);
            });
            repair();
            this.sqlite.pragma('foreign_keys = ON');
            console.warn(`✅ ${tbl.name} FK repaired.`);
          }
        }
      }

      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS operator_keys (
          id TEXT PRIMARY KEY,
          key_hash TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          actor_role TEXT NOT NULL CHECK (actor_role IN ('ADMIN', 'CAMPAIGN_MANAGER', 'COMPLIANCE_OFFICER', 'VIEWER', 'USER')),
          tenant_id TEXT NOT NULL DEFAULT 'default',
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          expires_at TEXT DEFAULT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_operator_keys_hash ON operator_keys(key_hash);
        CREATE INDEX IF NOT EXISTS idx_operator_keys_tenant ON operator_keys(tenant_id);
      `);

      // 8. Execution Attempts Table & Touch Tracking Columns (Step 6F-B.2A)
      if (!touchCols.includes('execution_attempt_count')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_attempt_count INTEGER NOT NULL DEFAULT 0;');
      }
      if (!touchCols.includes('execution_locked_at')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN execution_locked_at TEXT DEFAULT NULL;');
      }
      if (!touchCols.includes('last_attempt_id')) {
        this.sqlite.exec('ALTER TABLE campaign_touches ADD COLUMN last_attempt_id TEXT DEFAULT NULL;');
      }

      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS campaign_execution_attempts (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          campaign_id TEXT NOT NULL,
          campaign_lead_id TEXT NOT NULL,
          campaign_touch_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          operator_id TEXT NOT NULL,
          operator_name TEXT NOT NULL,
          operator_role TEXT NOT NULL,
          channel TEXT NOT NULL,
          provider TEXT DEFAULT NULL,
          attempt_number INTEGER NOT NULL DEFAULT 1,
          idempotency_key TEXT UNIQUE NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT DEFAULT NULL,
          result_status TEXT NOT NULL CHECK (result_status IN ('STARTED', 'PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'PROVIDER_UNCERTAIN', 'PROVIDER_UNAVAILABLE', 'BLOCKED')),
          provider_message_id TEXT DEFAULT NULL,
          provider_response TEXT DEFAULT NULL,
          error_classification TEXT DEFAULT NULL,
          error_message TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_exec_attempts_touch ON campaign_execution_attempts(campaign_touch_id);
        CREATE INDEX IF NOT EXISTS idx_exec_attempts_campaign ON campaign_execution_attempts(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_exec_attempts_idempotency ON campaign_execution_attempts(idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_exec_attempts_tenant ON campaign_execution_attempts(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_exec_attempts_created_at ON campaign_execution_attempts(created_at);

        -- 9. Reconciliation Records Table (Step 6F-B.2B Manual Reconciliation & Governed Recovery)
        CREATE TABLE IF NOT EXISTS campaign_reconciliation_records (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          campaign_id TEXT NOT NULL,
          campaign_touch_id TEXT NOT NULL,
          campaign_lead_id TEXT NOT NULL,
          attempt_id TEXT DEFAULT NULL,
          operator_id TEXT NOT NULL,
          operator_name TEXT NOT NULL,
          operator_role TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('VERIFIED_SENT', 'VERIFIED_NOT_SENT', 'REMAINS_UNCERTAIN')),
          reason TEXT NOT NULL,
          notes TEXT NOT NULL,
          evidence_type TEXT DEFAULT NULL,
          evidence_reference TEXT DEFAULT NULL,
          previous_touch_status TEXT NOT NULL,
          new_touch_status TEXT NOT NULL,
          previous_execution_status TEXT NOT NULL,
          new_execution_status TEXT NOT NULL,
          approval_hash TEXT DEFAULT NULL,
          campaign_version INTEGER DEFAULT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_lead_id) REFERENCES campaign_leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_reconcil_touch ON campaign_reconciliation_records(campaign_touch_id);
        CREATE INDEX IF NOT EXISTS idx_reconcil_campaign ON campaign_reconciliation_records(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_reconcil_attempt ON campaign_reconciliation_records(attempt_id);
        CREATE INDEX IF NOT EXISTS idx_reconcil_tenant ON campaign_reconciliation_records(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_reconcil_created_at ON campaign_reconciliation_records(created_at);

        -- 10. Touch Lease Diagnostic Index (Step 6F-B.2C.1)
        CREATE INDEX IF NOT EXISTS idx_campaign_touches_lease
          ON campaign_touches(tenant_id, execution_status, execution_locked_at);

        -- 11. Campaign Approved Snapshots Table (Step 7E-2 Persistent Approved-Draft Architecture)
        CREATE TABLE IF NOT EXISTS campaign_approved_snapshots (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          campaign_touch_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          touch_number INTEGER NOT NULL,
          channel TEXT NOT NULL,
          purpose TEXT NOT NULL,
          recipient_contact TEXT DEFAULT NULL,
          message_body TEXT NOT NULL,
          message_subject TEXT DEFAULT NULL,
          content_hash TEXT NOT NULL,
          review_hash TEXT NOT NULL,
          campaign_version INTEGER NOT NULL,
          approved_by TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          claims_root_hash TEXT DEFAULT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );
      `);

      // Step 7G-3: Additive migration for claims_root_hash column on campaign_approved_snapshots
      const snapCols = this.sqlite.prepare('PRAGMA table_info(campaign_approved_snapshots)').all().map(c => c.name);
      if (!snapCols.includes('claims_root_hash')) {
        this.sqlite.exec('ALTER TABLE campaign_approved_snapshots ADD COLUMN claims_root_hash TEXT DEFAULT NULL;');
      }

      this.sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_camp ON campaign_approved_snapshots(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_touch ON campaign_approved_snapshots(campaign_touch_id);
        CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_lead ON campaign_approved_snapshots(lead_id);
        CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_tenant ON campaign_approved_snapshots(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_camp_approved_snapshots_ver ON campaign_approved_snapshots(campaign_id, campaign_version);

        -- 12. Campaign Claims Table (Step 7G-1 Fact-Claim Graph)
        CREATE TABLE IF NOT EXISTS campaign_claims (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          lead_id TEXT NOT NULL,
          campaign_id TEXT DEFAULT NULL,
          campaign_touch_id TEXT DEFAULT NULL,
          claim_text TEXT NOT NULL,
          normalized_claim_hash TEXT NOT NULL,
          claim_type TEXT NOT NULL CHECK (claim_type IN (
            'CORE_ATTRIBUTE',
            'TECHNICAL_FACT',
            'CONSULTATIVE_OPPORTUNITY',
            'BENIGN_AGENCY',
            'OPERATIONAL_ASSERTION',
            'UNSUPPORTED_CLAIM'
          )),
          provenance_level TEXT NOT NULL CHECK (provenance_level IN ('VERIFIED', 'INFERRED', 'UNKNOWN')),
          validation_status TEXT NOT NULL CHECK (validation_status IN ('SUPPORTED', 'REQUIRES_REVIEW', 'UNSUPPORTED')),
          confidence_score REAL NOT NULL CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0),
          evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
          is_approved INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0, 1)),
          approval_snapshot_id TEXT DEFAULT NULL,
          generator_type TEXT NOT NULL DEFAULT 'DETERMINISTIC_TEMPLATE' CHECK (generator_type IN (
            'DETERMINISTIC_TEMPLATE',
            'AI_PROPOSITION_MODEL',
            'HUMAN_OPERATOR'
          )),
          model_name TEXT DEFAULT NULL,
          model_version TEXT DEFAULT NULL,
          prompt_template_version TEXT DEFAULT NULL,
          generated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE CASCADE,
          FOREIGN KEY (approval_snapshot_id) REFERENCES campaign_approved_snapshots(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_campaign_claims_tenant ON campaign_claims(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_claims_lead ON campaign_claims(lead_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_claims_campaign ON campaign_claims(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_claims_touch ON campaign_claims(campaign_touch_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_claims_status ON campaign_claims(validation_status);
        CREATE INDEX IF NOT EXISTS idx_campaign_claims_snapshot ON campaign_claims(approval_snapshot_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_claims_touch_claim 
          ON campaign_claims(tenant_id, lead_id, campaign_touch_id, normalized_claim_hash) 
          WHERE campaign_touch_id IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_claims_lead_claim 
          ON campaign_claims(tenant_id, lead_id, normalized_claim_hash) 
          WHERE campaign_touch_id IS NULL;

        -- 13. Campaign Claim Evidence Junction Table (Step 7G-1)
        CREATE TABLE IF NOT EXISTS campaign_claim_evidence (
          claim_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          PRIMARY KEY (claim_id, evidence_id),
          FOREIGN KEY (claim_id) REFERENCES campaign_claims(id) ON DELETE CASCADE,
          FOREIGN KEY (evidence_id) REFERENCES lead_evidence(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON campaign_claim_evidence(claim_id);
        CREATE INDEX IF NOT EXISTS idx_claim_evidence_evidence ON campaign_claim_evidence(evidence_id);
        CREATE INDEX IF NOT EXISTS idx_claim_evidence_tenant ON campaign_claim_evidence(tenant_id);

        -- 14. Conversations Table (Step 8B Multi-Tenant Conversation Intelligence Foundation)
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          lead_id TEXT NOT NULL,
          contact_id TEXT DEFAULT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'telegram', 'email', 'sms')),
          external_thread_id TEXT NOT NULL,
          conversation_status TEXT NOT NULL DEFAULT 'NEW' CHECK (conversation_status IN (
            'NEW', 'ACTIVE', 'WAITING_FOR_HUMAN', 'WAITING_FOR_PROSPECT',
            'HUMAN_REVIEW_REQUIRED', 'AMBIGUOUS_IDENTITY', 'OPTED_OUT', 'CLOSED', 'BLOCKED'
          )),
          unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
          metadata TEXT DEFAULT NULL,
          last_message_at TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (contact_id) REFERENCES lead_contacts(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_tenant_channel_thread
          ON conversations(tenant_id, channel, external_thread_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lead
          ON conversations(tenant_id, lead_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status
          ON conversations(tenant_id, conversation_status);
        CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
          ON conversations(last_message_at);

        -- 15. Conversation Messages Table (Step 8B Multi-Tenant Message Ingestion & Idempotency)
        CREATE TABLE IF NOT EXISTS conversation_messages (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          conversation_id TEXT NOT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'telegram', 'email', 'sms')),
          direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
          sender_identifier TEXT NOT NULL,
          recipient_identifier TEXT NOT NULL,
          provider_message_id TEXT NOT NULL,
          message_text TEXT NOT NULL,
          raw_payload TEXT DEFAULT NULL,
          delivery_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (delivery_status IN (
            'RECEIVED', 'DELIVERED', 'READ', 'SENT', 'FAILED', 'PENDING'
          )),
          has_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (has_opt_out IN (0, 1)),
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_messages_idempotency
          ON conversation_messages(tenant_id, channel, provider_message_id);
        CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_created
          ON conversation_messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conv_messages_tenant_sender
          ON conversation_messages(tenant_id, sender_identifier);
        CREATE INDEX IF NOT EXISTS idx_conv_messages_tenant_channel
          ON conversation_messages(tenant_id, channel);

        -- 16. Opportunities Table (Step 9 Multi-Tenant CRM Deal Management)
        CREATE TABLE IF NOT EXISTS opportunities (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          lead_id TEXT NOT NULL,
          contact_id TEXT DEFAULT NULL,
          title TEXT NOT NULL,
          deal_value REAL DEFAULT 0.0 CHECK (deal_value >= 0.0),
          currency TEXT DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
          stage TEXT NOT NULL DEFAULT 'DISCOVERY' CHECK (stage IN (
            'DISCOVERY', 'DEMO_BOOKED', 'QUALIFIED', 'PROPOSAL_SENT', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'
          )),
          confidence_probability REAL DEFAULT 0.20 CHECK (confidence_probability >= 0.0 AND confidence_probability <= 1.0),
          expected_close_date TEXT DEFAULT NULL,
          loss_reason_code TEXT DEFAULT NULL CHECK (loss_reason_code IS NULL OR loss_reason_code IN (
            'PRICING', 'TIMING', 'COMPETITOR', 'UNRESPONSIVE', 'NO_BUDGET', 'POOR_FIT', 'OTHER'
          )),
          loss_reason_notes TEXT DEFAULT NULL,
          assigned_operator_id TEXT DEFAULT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (contact_id) REFERENCES lead_contacts(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_stage
          ON opportunities(tenant_id, stage);
        CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_lead
          ON opportunities(tenant_id, lead_id);
        CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_contact
          ON opportunities(tenant_id, contact_id);

        -- 17. Opportunity Stage History Table (Step 9 Append-Only Transition Audit Ledger)
        CREATE TABLE IF NOT EXISTS opportunity_stage_history (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          opportunity_id TEXT NOT NULL,
          previous_stage TEXT DEFAULT NULL,
          new_stage TEXT NOT NULL,
          changed_by_operator TEXT NOT NULL,
          transition_reason TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_opp_history_tenant_opp
          ON opportunity_stage_history(tenant_id, opportunity_id, created_at);

        -- 18. Opportunity Tasks Table (Step 9 Follow-ups and Action Items)
        CREATE TABLE IF NOT EXISTS opportunity_tasks (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          opportunity_id TEXT NOT NULL,
          task_type TEXT NOT NULL CHECK (task_type IN ('CALL', 'DEMO_MEETING', 'PROPOSAL_PREP', 'CONTRACT_REVIEW', 'FOLLOW_UP', 'OTHER')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
          due_date TEXT NOT NULL,
          assigned_to TEXT DEFAULT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_opp_tasks_tenant_opp
          ON opportunity_tasks(tenant_id, opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_opp_tasks_tenant_status_due
          ON opportunity_tasks(tenant_id, status, due_date);

        -- 19. Revenue Attributions Table (Step 10 Multi-Touch Deal Attribution)
        CREATE TABLE IF NOT EXISTS revenue_attributions (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          opportunity_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          campaign_id TEXT DEFAULT NULL,
          campaign_touch_id TEXT DEFAULT NULL,
          touch_number INTEGER DEFAULT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('WHATSAPP', 'TELEGRAM', 'EMAIL', 'MANUAL', 'INBOUND_WEBHOOK', 'OTHER')),
          model_name TEXT NOT NULL CHECK (model_name IN ('FIRST_TOUCH', 'LAST_TOUCH', 'LINEAR', 'POSITION_BASED', 'TIME_DECAY')),
          attribution_weight REAL NOT NULL CHECK (attribution_weight >= 0.0 AND attribution_weight <= 1.0),
          attributed_value REAL NOT NULL CHECK (attributed_value >= 0.0),
          currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
          touch_timestamp TEXT NOT NULL,
          calculated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
          FOREIGN KEY (campaign_touch_id) REFERENCES campaign_touches(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rev_attr_tenant_opp ON revenue_attributions(tenant_id, opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_rev_attr_tenant_camp ON revenue_attributions(tenant_id, campaign_id);
        CREATE INDEX IF NOT EXISTS idx_rev_attr_tenant_channel ON revenue_attributions(tenant_id, channel);
        CREATE INDEX IF NOT EXISTS idx_rev_attr_tenant_model ON revenue_attributions(tenant_id, model_name);

        -- 20. Revenue Ledger Table (Step 10 Realized Revenue Financial Audit Ledger)
        CREATE TABLE IF NOT EXISTS revenue_ledger (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          opportunity_id TEXT NOT NULL,
          lead_id TEXT NOT NULL,
          amount REAL NOT NULL CHECK (amount >= 0.0),
          currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
          recognized_at TEXT NOT NULL,
          recognized_by_operator TEXT NOT NULL,
          source_attribution_model TEXT NOT NULL DEFAULT 'LINEAR',
          metadata TEXT DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_rev_ledger_tenant_opp ON revenue_ledger(tenant_id, opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_rev_ledger_tenant_rec ON revenue_ledger(tenant_id, recognized_at);

        -- 21. Decision Intelligence Snapshots Table (Step 11 Analytics & Decision Intel)
        CREATE TABLE IF NOT EXISTS decision_intelligence_snapshots (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('PIPELINE_VELOCITY', 'COHORT_FUNNEL', 'SLA_ANALYSIS', 'CHANNEL_EFFECTIVENESS', 'LOSS_INTELLIGENCE')),
          time_bucket TEXT NOT NULL,
          dimensions TEXT NOT NULL DEFAULT '{}',
          metrics TEXT NOT NULL DEFAULT '{}',
          recommendations TEXT DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_dec_intel_tenant_type ON decision_intelligence_snapshots(tenant_id, snapshot_type);
        CREATE INDEX IF NOT EXISTS idx_dec_intel_tenant_bucket ON decision_intelligence_snapshots(tenant_id, time_bucket);
      `);
    } catch (err) {
      console.error('❌ Failed to run campaign schema migration:', err);
      throw err;
    }
  }

  migrateFromLegacyJson() {
    try {
      if (!fs.existsSync(LEGACY_JSON_PATH)) return;

      const leadsCount = this.sqlite.prepare('SELECT COUNT(*) as count FROM leads').get().count;
      if (leadsCount > 0) return; // Already populated, skip migration

      console.log('🔄 Migrating legacy data.json to SQLite database...');
      const fileContent = fs.readFileSync(LEGACY_JSON_PATH, 'utf8');
      const legacyData = JSON.parse(fileContent);

      // 1. Settings
      if (legacyData.settings) {
        const mergedSettings = { ...DEFAULT_SETTINGS, ...legacyData.settings };
        this.sqlite.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(mergedSettings));
      }

      // 2. Locations
      if (Array.isArray(legacyData.locations)) {
        const insertLoc = this.sqlite.prepare(`
          INSERT OR IGNORE INTO locations (id, term, location, maxLeads, status, error, createdAt)
          VALUES (@id, @term, @location, @maxLeads, @status, @error, @createdAt)
        `);
        const insertManyLocs = this.sqlite.transaction((locations) => {
          for (const loc of locations) {
            insertLoc.run({
              id: loc.id || 'loc_' + Date.now(),
              term: loc.term || '',
              location: loc.location || '',
              maxLeads: loc.maxLeads || 20,
              status: loc.status || 'Pending',
              error: loc.error || '',
              createdAt: loc.createdAt || new Date().toISOString()
            });
          }
        });
        insertManyLocs(legacyData.locations);
      }

      // 3. Leads
      if (Array.isArray(legacyData.leads)) {
        const insertLead = this.sqlite.prepare(`
          INSERT OR IGNORE INTO leads (
            id, createdAt, searchTerm, location, businessName, address, phone, website,
            email, rating, facebook, instagram, linkedin, twitter, segment, qualityScore,
            leadStatus, emailStatus, whatsappStatus, scrapeStatus, placeId, notes,
            humanApproval, scoring, verificationStatus, dataMode
          ) VALUES (
            @id, @createdAt, @searchTerm, @location, @businessName, @address, @phone, @website,
            @email, @rating, @facebook, @instagram, @linkedin, @twitter, @segment, @qualityScore,
            @leadStatus, @emailStatus, @whatsappStatus, @scrapeStatus, @placeId, @notes,
            @humanApproval, @scoring, @verificationStatus, @dataMode
          )
        `);

        const insertManyLeads = this.sqlite.transaction((leads) => {
          for (const lead of leads) {
            insertLead.run({
              id: lead.id || 'lead_' + Date.now() + Math.random().toString(36).substr(2, 5),
              createdAt: lead.createdAt || new Date().toISOString(),
              searchTerm: lead.searchTerm || '',
              location: lead.location || '',
              businessName: lead.businessName || '',
              address: lead.address || '',
              phone: lead.phone || '',
              website: lead.website || '',
              email: lead.email || '',
              rating: typeof lead.rating === 'number' ? lead.rating : parseFloat(lead.rating) || null,
              facebook: lead.facebook || '',
              instagram: lead.instagram || '',
              linkedin: lead.linkedin || '',
              twitter: lead.twitter || '',
              segment: lead.segment || 'General Business',
              qualityScore: lead.qualityScore || 'Warm',
              leadStatus: lead.leadStatus || 'New',
              emailStatus: lead.emailStatus || 'Pending',
              whatsappStatus: lead.whatsappStatus || 'Pending',
              scrapeStatus: lead.scrapeStatus || 'Scraped',
              placeId: lead.placeId || '',
              notes: lead.notes || '',
              humanApproval: lead.humanApproval ? JSON.stringify(lead.humanApproval) : null,
              scoring: lead.scoring ? JSON.stringify(lead.scoring) : null,
              verificationStatus: lead.verificationStatus ? JSON.stringify(lead.verificationStatus) : null,
              dataMode: lead.dataMode || 'REAL'
            });
          }
        });
        insertManyLeads(legacyData.leads);
      }

      // 4. WhatsApp logs
      if (Array.isArray(legacyData.whatsappLogs)) {
        const insertLog = this.sqlite.prepare(`
          INSERT OR IGNORE INTO whatsapp_logs (id, timestamp, leadId, leadName, phone, status, errorMessage)
          VALUES (@id, @timestamp, @leadId, @leadName, @phone, @status, @errorMessage)
        `);
        const insertManyLogs = this.sqlite.transaction((logs) => {
          for (const log of logs) {
            insertLog.run({
              id: log.id || 'log_' + Date.now(),
              timestamp: log.timestamp || new Date().toISOString(),
              leadId: log.leadId || '',
              leadName: log.leadName || '',
              phone: log.phone || '',
              status: log.status || 'Pending',
              errorMessage: log.errorMessage || ''
            });
          }
        });
        insertManyLogs(legacyData.whatsappLogs);
      }

      console.log(`✅ SQLite migration completed successfully. Created backup at data.json.bak`);
      try {
        fs.copyFileSync(LEGACY_JSON_PATH, `${LEGACY_JSON_PATH}.bak`);
      } catch (e) {
        // Ignore backup copy failure
      }
    } catch (err) {
      console.error('Migration error from data.json:', err);
    }
  }

  // --- Settings Sanitization & Migration ---
  migrateAndSanitizeSettings() {
    try {
      const row = this.sqlite.prepare('SELECT data FROM settings WHERE id = 1').get();
      if (!row) return;

      let data;
      try {
        data = JSON.parse(row.data);
      } catch (_) {
        return;
      }

      let modified = false;
      const envUpdates = {};

      for (const [settingKey, envVarName] of Object.entries(SENSITIVE_SETTING_KEYS)) {
        if (settingKey in data) {
          const val = data[settingKey];
          // If value is non-empty, ensure it is migrated to process.env and .env
          if (val !== null && val !== undefined && val !== '') {
            const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
            if (!process.env[envVarName] || !process.env[envVarName].trim()) {
              process.env[envVarName] = strVal;
              envUpdates[envVarName] = strVal;
            }
          }
          // Remove sensitive key from database JSON payload
          delete data[settingKey];
          modified = true;
        }
      }

      if (Object.keys(envUpdates).length > 0) {
        updateEnvFile(envUpdates);
      }

      if (modified) {
        this.sqlite.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data));
        console.log('🔒 [Database] Sensitive credentials successfully migrated to .env and purged from leads.db settings table.');
      }
    } catch (err) {
      console.warn('[Database] Non-fatal settings sanitization warning:', err.message);
    }
  }

  // --- Settings ---
  getSettings() {
    const row = this.sqlite.prepare('SELECT data FROM settings WHERE id = 1').get();
    let dbSettings = {};
    if (row) {
      try {
        dbSettings = JSON.parse(row.data);
      } catch (e) {
        dbSettings = {};
      }
    }

    // Safely parse GOOGLE_TOKENS from environment if present
    let googleTokens = null;
    if (process.env.GOOGLE_TOKENS && process.env.GOOGLE_TOKENS.trim()) {
      try {
        googleTokens = JSON.parse(process.env.GOOGLE_TOKENS);
      } catch (_) {
        googleTokens = null;
      }
    }

    // Overlay sensitive credentials from environment variables
    const envOverrides = {
      placesApiKey: process.env.PLACES_API_KEY || '',
      openaiApiKey: process.env.OPENAI_API_KEY || '',
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      googleTokens: googleTokens,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
      telegramApiHash: process.env.TELEGRAM_API_HASH || '',
      telegramUserSession: process.env.TELEGRAM_USER_SESSION || ''
    };

    return {
      ...DEFAULT_SETTINGS,
      ...dbSettings,
      ...envOverrides
    };
  }

  updateSettings(newSettings) {
    const envUpdates = {};

    // 1. Separate sensitive credentials and persist to process.env and .env
    for (const [settingKey, envVarName] of Object.entries(SENSITIVE_SETTING_KEYS)) {
      if (settingKey in newSettings) {
        const val = newSettings[settingKey];
        if (val === null || val === undefined || val === '') {
          delete process.env[envVarName];
          envUpdates[envVarName] = '';
        } else {
          const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
          process.env[envVarName] = strVal;
          envUpdates[envVarName] = strVal;
        }
      }
    }

    if (Object.keys(envUpdates).length > 0) {
      updateEnvFile(envUpdates);
    }

    // 2. Prepare database payload WITHOUT sensitive keys
    const row = this.sqlite.prepare('SELECT data FROM settings WHERE id = 1').get();
    let currentDbData = {};
    if (row) {
      try {
        currentDbData = JSON.parse(row.data);
      } catch (_) {}
    }

    const updatedDbData = { ...currentDbData, ...newSettings };
    // Explicitly delete all sensitive keys from DB payload so they NEVER reach SQLite
    for (const settingKey of Object.keys(SENSITIVE_SETTING_KEYS)) {
      delete updatedDbData[settingKey];
    }

    this.sqlite.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(updatedDbData));

    // Return merged settings including env overrides
    return this.getSettings();
  }

  // --- Locations ---
  getLocations() {
    return this.sqlite.prepare('SELECT * FROM locations ORDER BY createdAt DESC').all();
  }

  addLocation(term, location, maxLeads = 20) {
    const newLoc = {
      id: 'loc_' + Date.now() + Math.random().toString(36).substr(2, 5),
      term,
      location,
      maxLeads: parseInt(maxLeads, 10) || 20,
      status: 'Pending',
      error: '',
      createdAt: new Date().toISOString()
    };
    this.sqlite.prepare(`
      INSERT INTO locations (id, term, location, maxLeads, status, error, createdAt)
      VALUES (@id, @term, @location, @maxLeads, @status, @error, @createdAt)
    `).run(newLoc);
    return newLoc;
  }

  updateLocation(id, updates) {
    const current = this.sqlite.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    if (!current) return null;
    const merged = { ...current, ...updates };
    this.sqlite.prepare(`
      UPDATE locations
      SET term = @term, location = @location, maxLeads = @maxLeads, status = @status, error = @error
      WHERE id = @id
    `).run(merged);
    return merged;
  }

  deleteLocation(id) {
    this.sqlite.prepare('DELETE FROM locations WHERE id = ?').run(id);
  }

  getLeads() {
    const rows = this.sqlite.prepare('SELECT * FROM leads ORDER BY createdAt DESC').all();
    return rows.map(r => {
      return {
        ...r,
        humanApproval: r.humanApproval ? JSON.parse(r.humanApproval) : null,
        scoring: r.scoring ? JSON.parse(r.scoring) : null,
        verificationStatus: r.verificationStatus ? JSON.parse(r.verificationStatus) : null
      };
    });
  }

  getLeadById(id, tid = undefined) {
    let sql = 'SELECT * FROM leads WHERE id = ?';
    const params = [id];
    if (tid) {
      sql += ' AND tenant_id = ?';
      params.push(tid);
    }
    const r = this.sqlite.prepare(sql).get(...params);
    if (!r) return null;
    return {
      ...r,
      humanApproval: r.humanApproval ? JSON.parse(r.humanApproval) : null,
      scoring: r.scoring ? JSON.parse(r.scoring) : null,
      verificationStatus: r.verificationStatus ? JSON.parse(r.verificationStatus) : null
    };
  }

  calculateQualityScore(lead) {
    let scorePoints = 0;
    if (lead.email && lead.email.trim() !== '') scorePoints += 2;
    if (lead.phone && lead.phone.trim() !== '') scorePoints += 2;
    if (lead.website && lead.website.trim() !== '') scorePoints += 1;
    if (lead.rating && parseFloat(lead.rating) >= 4.0) scorePoints += 1;
    if (lead.facebook || lead.instagram || lead.linkedin || lead.twitter) scorePoints += 1;

    if (scorePoints >= 5) return 'Hot';
    if (scorePoints >= 3) return 'Warm';
    return 'Cold';
  }

  addLead(lead) {
    // Check for duplicate website or placeId
    if (lead.placeId) {
      const existsPlace = this.sqlite.prepare('SELECT id FROM leads WHERE placeId = ? LIMIT 1').get(lead.placeId);
      if (existsPlace) return null;
    }
    if (lead.website && lead.website.trim() !== '') {
      const existsWeb = this.sqlite.prepare('SELECT id FROM leads WHERE website = ? LIMIT 1').get(lead.website);
      if (existsWeb) return null;
    }

    const qualityScore = lead.qualityScore || this.calculateQualityScore(lead);
    const segment = lead.segment || 'General Business';
    const id = 'lead_' + Date.now() + Math.random().toString(36).substr(2, 5);
    const createdAt = new Date().toISOString();

    const record = {
      id,
      createdAt,
      searchTerm: lead.searchTerm || '',
      location: lead.location || '',
      businessName: lead.businessName || '',
      address: lead.address || '',
      phone: lead.phone || '',
      website: lead.website || '',
      email: lead.email || '',
      rating: typeof lead.rating === 'number' ? lead.rating : parseFloat(lead.rating) || null,
      facebook: lead.facebook || '',
      instagram: lead.instagram || '',
      linkedin: lead.linkedin || '',
      twitter: lead.twitter || '',
      telegram: lead.telegram || '',
      segment,
      qualityScore,
      leadStatus: lead.leadStatus || 'New',
      emailStatus: lead.emailStatus || 'Pending',
      whatsappStatus: lead.whatsappStatus || 'Pending',
      scrapeStatus: lead.scrapeStatus || 'Scraped',
      placeId: lead.placeId || '',
      notes: lead.notes || '',
      humanApproval: lead.humanApproval ? JSON.stringify(lead.humanApproval) : null,
      scoring: lead.scoring ? JSON.stringify(lead.scoring) : null,
      verificationStatus: lead.verificationStatus ? JSON.stringify(lead.verificationStatus) : null,
      dataMode: lead.dataMode || 'REAL',
      outreach_attempt_count: lead.outreach_attempt_count || 0,
      last_outreach_at: lead.last_outreach_at || null,
      last_outreach_channel: lead.last_outreach_channel || null,
      last_inbound_at: lead.last_inbound_at || null,
      opted_out: lead.opted_out ? 1 : 0,
      opted_out_at: lead.opted_out_at || null,
      opted_out_source: lead.opted_out_source || null,
      tenant_id: lead.tenant_id || lead.tenantId || 'default'
    };

    this.sqlite.prepare(`
      INSERT INTO leads (
        id, createdAt, searchTerm, location, businessName, address, phone, website,
        email, rating, facebook, instagram, linkedin, twitter, telegram, segment, qualityScore,
        leadStatus, emailStatus, whatsappStatus, scrapeStatus, placeId, notes,
        humanApproval, scoring, verificationStatus, dataMode,
        outreach_attempt_count, last_outreach_at, last_outreach_channel, last_inbound_at,
        opted_out, opted_out_at, opted_out_source, tenant_id
      ) VALUES (
        @id, @createdAt, @searchTerm, @location, @businessName, @address, @phone, @website,
        @email, @rating, @facebook, @instagram, @linkedin, @twitter, @telegram, @segment, @qualityScore,
        @leadStatus, @emailStatus, @whatsappStatus, @scrapeStatus, @placeId, @notes,
        @humanApproval, @scoring, @verificationStatus, @dataMode,
        @outreach_attempt_count, @last_outreach_at, @last_outreach_channel, @last_inbound_at,
        @opted_out, @opted_out_at, @opted_out_source, @tenant_id
      )
    `).run(record);

    return {
      ...record,
      humanApproval: lead.humanApproval || null,
      scoring: lead.scoring || null,
      verificationStatus: lead.verificationStatus || null
    };
  }

  updateLead(id, updates) {
    const current = this.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!current) return null;

    const merged = { ...current, ...updates };

    if (updates.humanApproval && typeof updates.humanApproval === 'object') {
      merged.humanApproval = JSON.stringify(updates.humanApproval);
    }
    if (updates.scoring && typeof updates.scoring === 'object') {
      merged.scoring = JSON.stringify(updates.scoring);
    }
    if (updates.verificationStatus && typeof updates.verificationStatus === 'object') {
      merged.verificationStatus = JSON.stringify(updates.verificationStatus);
    }

    if (updates.email !== undefined || updates.phone !== undefined || updates.website !== undefined) {
      merged.qualityScore = this.calculateQualityScore(merged);
    }

    this.sqlite.prepare(`
      UPDATE leads
      SET searchTerm = @searchTerm, location = @location, businessName = @businessName,
          address = @address, phone = @phone, website = @website, email = @email,
          rating = @rating, facebook = @facebook, instagram = @instagram,
          linkedin = @linkedin, twitter = @twitter, telegram = @telegram, segment = @segment,
          qualityScore = @qualityScore, leadStatus = @leadStatus,
          emailStatus = @emailStatus, whatsappStatus = @whatsappStatus,
          scrapeStatus = @scrapeStatus, placeId = @placeId, notes = @notes,
          humanApproval = @humanApproval, scoring = @scoring,
          verificationStatus = @verificationStatus, dataMode = @dataMode,
          lastReplyText = @lastReplyText, lastReplyAt = @lastReplyAt,
          aiSuggestedReply = @aiSuggestedReply,
          outreach_attempt_count = @outreach_attempt_count,
          last_outreach_at = @last_outreach_at,
          last_outreach_channel = @last_outreach_channel,
          last_inbound_at = @last_inbound_at,
          opted_out = @opted_out,
          opted_out_at = @opted_out_at,
          opted_out_source = @opted_out_source
      WHERE id = @id
    `).run({
      ...merged,
      telegram: merged.telegram || '',
      lastReplyText: merged.lastReplyText || null,
      lastReplyAt: merged.lastReplyAt || null,
      aiSuggestedReply: merged.aiSuggestedReply || null,
      outreach_attempt_count: merged.outreach_attempt_count ?? 0,
      last_outreach_at: merged.last_outreach_at || null,
      last_outreach_channel: merged.last_outreach_channel || null,
      last_inbound_at: merged.last_inbound_at || null,
      opted_out: merged.opted_out ? 1 : 0,
      opted_out_at: merged.opted_out_at || null,
      opted_out_source: merged.opted_out_source || null
    });

    return {
      ...merged,
      humanApproval: merged.humanApproval ? JSON.parse(merged.humanApproval) : null,
      scoring: merged.scoring ? JSON.parse(merged.scoring) : null,
      verificationStatus: merged.verificationStatus ? JSON.parse(merged.verificationStatus) : null
    };
  }

  formatPhoneNumber(rawPhone, defaultCountry = undefined) {
    if (!rawPhone) return '';
    const str = String(rawPhone).trim();

    let parsed = parsePhoneNumberFromString(str);
    if (parsed && parsed.isValid()) {
      return parsed.format('E.164');
    }

    if (str.startsWith('00')) {
      parsed = parsePhoneNumberFromString('+' + str.slice(2));
      if (parsed && parsed.isValid()) {
        return parsed.format('E.164');
      }
    }

    if (defaultCountry) {
      parsed = parsePhoneNumberFromString(str, defaultCountry);
      if (parsed && parsed.isValid()) {
        return parsed.format('E.164');
      }
    }

    const digitsOnly = str.replace(/\D/g, '');
    if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
      const local = digitsOnly.slice(1);
      if (/^[6-9]\d{9}$/.test(local)) {
        return `+91${local}`;
      }
    }

    const cleanPlus = str.replace(/[^\d+]/g, '');
    if (cleanPlus.startsWith('+') && cleanPlus.length >= 8 && cleanPlus.length <= 16) {
      return cleanPlus;
    }

    if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
      if (digitsOnly.length === 10 && /^[6-9]/.test(digitsOnly)) {
        return `+91${digitsOnly}`;
      }
      return `+${digitsOnly}`;
    }

    return str;
  }

  _formatLeadRecord(r) {
    if (!r) return null;
    return {
      ...r,
      humanApproval: r.humanApproval ? JSON.parse(r.humanApproval) : null,
      scoring: r.scoring ? JSON.parse(r.scoring) : null,
      verificationStatus: r.verificationStatus ? JSON.parse(r.verificationStatus) : null
    };
  }

  /**
   * Tenant-scoped identity resolution for phone numbers.
   * Deterministically distinguishes NO_MATCH, MATCHED, and AMBIGUOUS_IDENTITY.
   *
   * @param {string} rawPhone - Raw phone number
   * @param {string} tenantId - Authoritative routing tenant ID
   * @returns {{ status: 'NO_MATCH'|'MATCHED'|'AMBIGUOUS_IDENTITY', lead: object|null, candidates: object[], tenant_id: string }}
   */
  findLeadByPhoneScoped(rawPhone, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    if (!rawPhone || typeof rawPhone !== 'string' || !rawPhone.trim()) {
      return { status: 'NO_MATCH', lead: null, candidates: [], tenant_id: tid };
    }

    const normalized = this.formatPhoneNumber(rawPhone);
    const digitsOnly = String(rawPhone).replace(/\D/g, '');
    if (digitsOnly.length < 6) {
      return { status: 'NO_MATCH', lead: null, candidates: [], tenant_id: tid };
    }

    // Build target matching candidates: exact raw, formatted E.164, and 10-digit national suffix
    const candidatePatterns = new Set();
    candidatePatterns.add(rawPhone.trim());
    if (normalized) candidatePatterns.add(normalized);
    if (digitsOnly.length >= 10) {
      const suffix10 = digitsOnly.slice(-10);
      candidatePatterns.add(suffix10);
      candidatePatterns.add(`%${suffix10}`);
    }

    // Query exclusively within the specified tenant_id
    const rows = this.sqlite.prepare(`
      SELECT * FROM leads
      WHERE tenant_id = ?
        AND phone IS NOT NULL
        AND phone != ''
        AND (
          phone = ?
          OR phone = ?
          OR phone LIKE ?
        )
    `).all(tid, rawPhone.trim(), normalized || '', digitsOnly.length >= 10 ? `%${digitsOnly.slice(-10)}` : rawPhone.trim());

    // Filter strictly to ensure true digit equality or normalized E.164 equivalence
    const matchedLeads = [];
    const target10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;

    for (const r of rows) {
      const lNorm = this.formatPhoneNumber(r.phone);
      const lDigits = String(r.phone).replace(/\D/g, '');

      const isExact = (r.phone === rawPhone.trim());
      const isNormMatch = Boolean(normalized && lNorm && normalized === lNorm);
      const isSuffixMatch = Boolean(target10 && lDigits && (lDigits.endsWith(target10) || target10.endsWith(lDigits.slice(-10))));

      if (isExact || isNormMatch || isSuffixMatch) {
        matchedLeads.push(this._formatLeadRecord(r));
      }
    }

    if (matchedLeads.length === 0) {
      return {
        status: 'NO_MATCH',
        lead: null,
        candidates: [],
        tenant_id: tid
      };
    }

    if (matchedLeads.length === 1) {
      return {
        status: 'MATCHED',
        lead: matchedLeads[0],
        candidates: matchedLeads,
        tenant_id: tid
      };
    }

    // FAIL-CLOSED: Multiple candidates in the same tenant -> AMBIGUOUS_IDENTITY
    return {
      status: 'AMBIGUOUS_IDENTITY',
      lead: null,
      candidates: matchedLeads,
      tenant_id: tid
    };
  }

  /**
   * Legacy findLeadByPhone: Preserved for backward compatibility.
   * Internally routed safely through default tenant scoped resolution.
   */
  findLeadByPhone(rawPhone) {
    const res = this.findLeadByPhoneScoped(rawPhone, 'default');
    if (res.status === 'MATCHED') {
      return res.lead;
    }
    // In ambiguous or no-match case, return null to fail closed
    return null;
  }

  recordLeadReply(phone, replyText, aiDraft = '') {
    const lead = this.findLeadByPhone(phone);
    if (!lead) return null;

    const now = new Date().toISOString();
    return this.updateLead(lead.id, {
      leadStatus: 'Interested', // Auto-move to Interested pipeline stage!
      lastReplyText: replyText,
      lastReplyAt: now,
      last_inbound_at: now,
      aiSuggestedReply: aiDraft
    });
  }

  deleteLead(id) {
    this.sqlite.prepare('DELETE FROM leads WHERE id = ?').run(id);
  }

  clearLeads() {
    this.sqlite.prepare('DELETE FROM leads').run();
  }

  clearLeadsForQuery(term, location) {
    this.sqlite.prepare(`
      DELETE FROM leads
      WHERE LOWER(searchTerm) = LOWER(?) AND LOWER(location) = LOWER(?)
    `).run(term, location);
  }

  // --- WhatsApp Logs ---
  getWhatsappLogs() {
    return this.sqlite.prepare('SELECT * FROM whatsapp_logs ORDER BY timestamp DESC LIMIT 1000').all();
  }

  addWhatsappLog(log) {
    const newLog = {
      id: 'log_' + Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      leadId: log.leadId || '',
      leadName: log.leadName || '',
      phone: log.phone || '',
      status: log.status || 'Pending',
      errorMessage: log.errorMessage || ''
    };
    this.sqlite.prepare(`
      INSERT INTO whatsapp_logs (id, timestamp, leadId, leadName, phone, status, errorMessage)
      VALUES (@id, @timestamp, @leadId, @leadName, @phone, @status, @errorMessage)
    `).run(newLog);
    return newLog;
  }

  // ==========================================================================
  // PHASE 1: COMPLIANCE & SAFETY ENGINE DATABASE HELPERS
  // ==========================================================================

  // --- Suppression Management ---
  createSuppression({
    tenantId = 'default',
    leadId = null,
    normalizedContact,
    contactType,
    channel = 'ALL',
    originalContact = null,
    reason,
    source,
    expiresAt = null,
    notes = null
  }) {
    if (!normalizedContact) {
      throw new Error('normalizedContact is required to create a suppression record.');
    }

    const cleanContact = String(normalizedContact).trim();
    const ch = String(channel || 'ALL').toUpperCase() === 'ALL' ? 'ALL' : String(channel).toLowerCase().trim();
    const cType = String(contactType || 'unknown').toLowerCase().trim();
    const rsn = String(reason || 'UNSPECIFIED').trim();
    const src = String(source || 'SYSTEM').trim();
    const now = new Date().toISOString();
    const id = 'sup_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    const record = {
      id,
      tenant_id: tenantId,
      lead_id: leadId || null,
      normalized_contact: cleanContact,
      contact_type: cType,
      channel: ch,
      original_contact: originalContact ? String(originalContact).trim() : cleanContact,
      reason: rsn,
      source: src,
      suppressed_at: now,
      expires_at: expiresAt || null,
      notes: notes || null,
      created_at: now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO suppression_list (
        id, tenant_id, lead_id, normalized_contact, contact_type, channel,
        original_contact, reason, source, suppressed_at, expires_at, notes, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @lead_id, @normalized_contact, @contact_type, @channel,
        @original_contact, @reason, @source, @suppressed_at, @expires_at, @notes, @created_at, @updated_at
      ) ON CONFLICT(tenant_id, normalized_contact, channel) DO UPDATE SET
        lead_id = COALESCE(excluded.lead_id, suppression_list.lead_id),
        contact_type = excluded.contact_type,
        original_contact = COALESCE(excluded.original_contact, suppression_list.original_contact),
        reason = excluded.reason,
        source = excluded.source,
        expires_at = excluded.expires_at,
        notes = COALESCE(excluded.notes, suppression_list.notes),
        updated_at = excluded.updated_at
    `).run(record);

    // If a leadId was passed and channel is 'ALL' (global suppression), update lead-level safety fields
    if (leadId && (channel === 'ALL' || record.channel === 'ALL')) {
      this.updateLeadSafetyState(leadId, {
        opted_out: 1,
        opted_out_at: now,
        opted_out_source: src
      });
    }

    return record;
  }

  isGloballySuppressed(normalizedContact, tenantId = 'default') {
    if (!normalizedContact) return false;
    const clean = String(normalizedContact).trim();
    const row = this.sqlite.prepare(`
      SELECT id FROM suppression_list
      WHERE tenant_id = ?
        AND normalized_contact = ?
        AND channel = 'ALL'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `).get(tenantId, clean);
    return !!row;
  }

  isChannelSuppressed(normalizedContact, channel, tenantId = 'default') {
    if (!normalizedContact) return false;
    const clean = String(normalizedContact).trim();
    const ch = String(channel || 'ALL').trim();
    const row = this.sqlite.prepare(`
      SELECT id FROM suppression_list
      WHERE tenant_id = ?
        AND normalized_contact = ?
        AND (channel = 'ALL' OR LOWER(channel) = LOWER(?))
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `).get(tenantId, clean, ch);
    return !!row;
  }

  getSuppression(normalizedContact, channel = null, tenantId = 'default') {
    if (!normalizedContact) return null;
    const clean = String(normalizedContact).trim();

    if (channel) {
      const ch = String(channel).trim();
      return this.sqlite.prepare(`
        SELECT * FROM suppression_list
        WHERE tenant_id = ?
          AND normalized_contact = ?
          AND (channel = 'ALL' OR LOWER(channel) = LOWER(?))
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY CASE WHEN channel = 'ALL' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(tenantId, clean, ch) || null;
    }

    return this.sqlite.prepare(`
      SELECT * FROM suppression_list
      WHERE tenant_id = ?
        AND normalized_contact = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY CASE WHEN channel = 'ALL' THEN 1 ELSE 2 END
      LIMIT 1
    `).get(tenantId, clean) || null;
  }

  removeSuppression(normalizedContact, channel = 'ALL', tenantId = 'default') {
    if (!normalizedContact) return { deleted: false, changes: 0 };
    const clean = String(normalizedContact).trim();
    const ch = String(channel).trim();

    let stmt;
    if (ch === 'ANY') {
      stmt = this.sqlite.prepare(`
        DELETE FROM suppression_list
        WHERE tenant_id = ? AND normalized_contact = ?
      `);
      const info = stmt.run(tenantId, clean);
      return { deleted: info.changes > 0, changes: info.changes };
    } else {
      stmt = this.sqlite.prepare(`
        DELETE FROM suppression_list
        WHERE tenant_id = ? AND normalized_contact = ? AND (channel = ? OR LOWER(channel) = LOWER(?))
      `);
      const info = stmt.run(tenantId, clean, ch, ch);
      return { deleted: info.changes > 0, changes: info.changes };
    }
  }

  listSuppressions({ tenantId = 'default', contactType = null, channel = null, limit = 100, offset = 0 } = {}) {
    let sql = `SELECT * FROM suppression_list WHERE tenant_id = ?`;
    const params = [tenantId];

    if (contactType) {
      sql += ` AND LOWER(contact_type) = LOWER(?)`;
      params.push(contactType);
    }
    if (channel) {
      sql += ` AND (channel = 'ALL' OR LOWER(channel) = LOWER(?))`;
      params.push(channel);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, parseInt(limit, 10) || 100));
    params.push(Math.max(0, parseInt(offset, 10) || 0));

    return this.sqlite.prepare(sql).all(...params);
  }

  // --- Compliance Audit Logs ---
  createComplianceAuditLog({
    tenantId = 'default',
    leadId = null,
    channel = null,
    eventType,
    contactIdentifier = null,
    decision,
    reason = null,
    metadata = null
  }) {
    if (!eventType || !decision) {
      throw new Error('eventType and decision are required for compliance audit log.');
    }
    const id = 'audit_' + Date.now() + Math.random().toString(36).substr(2, 6);
    const createdAt = new Date().toISOString();
    const metaStr = metadata ? (typeof metadata === 'object' ? JSON.stringify(metadata) : String(metadata)) : null;

    const record = {
      id,
      tenant_id: tenantId,
      lead_id: leadId || null,
      channel: channel ? String(channel).toLowerCase() : null,
      event_type: eventType,
      contact_identifier: contactIdentifier ? String(contactIdentifier).trim() : null,
      decision: decision,
      reason: reason || null,
      metadata: metaStr,
      created_at: createdAt
    };

    this.sqlite.prepare(`
      INSERT INTO compliance_audit_logs (
        id, tenant_id, lead_id, channel, event_type, contact_identifier, decision, reason, metadata, created_at
      ) VALUES (
        @id, @tenant_id, @lead_id, @channel, @event_type, @contact_identifier, @decision, @reason, @metadata, @created_at
      )
    `).run(record);

    return record;
  }

  getComplianceAuditLogs({
    tenantId = 'default',
    leadId = null,
    channel = null,
    eventType = null,
    limit = 100,
    offset = 0
  } = {}) {
    let sql = `SELECT * FROM compliance_audit_logs WHERE tenant_id = ?`;
    const params = [tenantId];

    if (leadId) {
      sql += ` AND lead_id = ?`;
      params.push(leadId);
    }
    if (channel) {
      sql += ` AND LOWER(channel) = LOWER(?)`;
      params.push(channel);
    }
    if (eventType) {
      sql += ` AND event_type = ?`;
      params.push(eventType);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, parseInt(limit, 10) || 100));
    params.push(Math.max(0, parseInt(offset, 10) || 0));

    return this.sqlite.prepare(sql).all(...params).map(row => {
      let parsedMeta = null;
      if (row.metadata) {
        try { parsedMeta = JSON.parse(row.metadata); } catch (_) { parsedMeta = row.metadata; }
      }
      return { ...row, metadata: parsedMeta };
    });
  }

  // --- Channel Outreach State ---
  getChannelOutreachState(leadId, channel) {
    if (!leadId || !channel) return null;
    const ch = String(channel).toLowerCase();
    const row = this.sqlite.prepare(`
      SELECT * FROM channel_outreach_state
      WHERE lead_id = ? AND channel = ?
    `).get(leadId, ch);

    if (row) return row;
    return {
      id: null,
      lead_id: leadId,
      channel: ch,
      attempt_count: 0,
      last_attempt_at: null,
      next_eligible_at: null,
      last_result: null,
      blocked_reason: null,
      updated_at: null
    };
  }

  updateChannelOutreachState(leadId, channel, updates = {}) {
    if (!leadId || !channel) return null;
    const ch = String(channel).toLowerCase();
    const current = this.getChannelOutreachState(leadId, ch);
    const now = new Date().toISOString();

    const merged = {
      id: current.id || ('cos_' + leadId + '_' + ch),
      lead_id: leadId,
      channel: ch,
      attempt_count: updates.attempt_count !== undefined ? updates.attempt_count : current.attempt_count,
      last_attempt_at: updates.last_attempt_at !== undefined ? updates.last_attempt_at : current.last_attempt_at,
      next_eligible_at: updates.next_eligible_at !== undefined ? updates.next_eligible_at : current.next_eligible_at,
      last_result: updates.last_result !== undefined ? updates.last_result : current.last_result,
      blocked_reason: updates.blocked_reason !== undefined ? updates.blocked_reason : current.blocked_reason,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO channel_outreach_state (
        id, lead_id, channel, attempt_count, last_attempt_at, next_eligible_at, last_result, blocked_reason, updated_at
      ) VALUES (
        @id, @lead_id, @channel, @attempt_count, @last_attempt_at, @next_eligible_at, @last_result, @blocked_reason, @updated_at
      ) ON CONFLICT(lead_id, channel) DO UPDATE SET
        attempt_count = excluded.attempt_count,
        last_attempt_at = excluded.last_attempt_at,
        next_eligible_at = excluded.next_eligible_at,
        last_result = excluded.last_result,
        blocked_reason = excluded.blocked_reason,
        updated_at = excluded.updated_at
    `).run(merged);

    return merged;
  }

  incrementChannelOutreachAttempt(leadId, channel, { result = 'Sent', nextEligibleAt = null, blockedReason = null } = {}) {
    if (!leadId || !channel) return null;
    const ch = String(channel).toLowerCase();
    const now = new Date().toISOString();
    const id = 'cos_' + leadId + '_' + ch;

    this.sqlite.prepare(`
      INSERT INTO channel_outreach_state (
        id, lead_id, channel, attempt_count, last_attempt_at, next_eligible_at, last_result, blocked_reason, updated_at
      ) VALUES (
        @id, @lead_id, @channel, 1, @now, @next_eligible_at, @last_result, @blocked_reason, @now
      ) ON CONFLICT(lead_id, channel) DO UPDATE SET
        attempt_count = channel_outreach_state.attempt_count + 1,
        last_attempt_at = excluded.last_attempt_at,
        next_eligible_at = excluded.next_eligible_at,
        last_result = excluded.last_result,
        blocked_reason = excluded.blocked_reason,
        updated_at = excluded.updated_at
    `).run({
      id,
      lead_id: leadId,
      channel: ch,
      now,
      next_eligible_at: nextEligibleAt || null,
      last_result: result,
      blocked_reason: blockedReason || null
    });

    // Update overall lead safety state
    try {
      this.sqlite.prepare(`
        UPDATE leads
        SET outreach_attempt_count = COALESCE(outreach_attempt_count, 0) + 1,
            last_outreach_at = ?,
            last_outreach_channel = ?
        WHERE id = ?
      `).run(now, ch, leadId);
    } catch (_) {}

    return this.getChannelOutreachState(leadId, ch);
  }

  // --- Daily Quota Usage ---
  getDailyQuotaUsage(channel, date = null, tenantId = 'default') {
    if (!channel) return null;
    const ch = String(channel).toLowerCase();
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const row = this.sqlite.prepare(`
      SELECT * FROM daily_quota_usage
      WHERE tenant_id = ? AND channel = ? AND date = ?
    `).get(tenantId, ch, targetDate);

    if (row) return row;
    return {
      id: null,
      tenant_id: tenantId,
      channel: ch,
      date: targetDate,
      attempt_count: 0,
      success_count: 0,
      blocked_count: 0,
      updated_at: null
    };
  }

  incrementDailyQuota(channel, date = null, tenantId = 'default', type = 'attempt') {
    if (!channel) return null;
    const ch = String(channel).toLowerCase();
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const id = 'dqu_' + tenantId + '_' + ch + '_' + targetDate;

    const isAttempt = type === 'attempt' ? 1 : 0;
    const isSuccess = type === 'success' ? 1 : 0;
    const isBlocked = type === 'blocked' ? 1 : 0;

    this.sqlite.prepare(`
      INSERT INTO daily_quota_usage (
        id, tenant_id, channel, date, attempt_count, success_count, blocked_count, updated_at
      ) VALUES (
        @id, @tenant_id, @channel, @date, @isAttempt, @isSuccess, @isBlocked, @now
      ) ON CONFLICT(tenant_id, channel, date) DO UPDATE SET
        attempt_count = daily_quota_usage.attempt_count + excluded.attempt_count,
        success_count = daily_quota_usage.success_count + excluded.success_count,
        blocked_count = daily_quota_usage.blocked_count + excluded.blocked_count,
        updated_at = excluded.updated_at
    `).run({
      id,
      tenant_id: tenantId,
      channel: ch,
      date: targetDate,
      isAttempt,
      isSuccess,
      isBlocked,
      now
    });

    return this.getDailyQuotaUsage(ch, targetDate, tenantId);
  }

  /**
   * Atomically verify and reserve a daily quota slot within a SQLite transaction.
   * Eliminates race conditions where concurrent requests exceed daily limits.
   *
   * @param {string} channel - 'whatsapp', 'telegram', or 'email'
   * @param {string|null} [date=null] - YYYY-MM-DD
   * @param {string} [tenantId='default']
   * @param {number} [limit=50]
   * @returns {{ reserved: boolean, currentCount: number, limit: number, usage: object, reason?: string }}
   */
  reserveDailyQuota(channel, date = null, tenantId = 'default', limit = 50) {
    if (!channel) return { reserved: false, reason: 'Channel is required' };
    const ch = String(channel).toLowerCase().trim();
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    const id = 'dqu_' + tenantId + '_' + ch + '_' + targetDate;

    const reserveTx = this.sqlite.transaction(() => {
      // 1. Ensure the row exists
      this.sqlite.prepare(`
        INSERT OR IGNORE INTO daily_quota_usage (
          id, tenant_id, channel, date, attempt_count, success_count, blocked_count, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, 0, ?)
      `).run(id, tenantId, ch, targetDate, now);

      // 2. Atomically check and increment ONLY IF attempt_count < limit
      const res = this.sqlite.prepare(`
        UPDATE daily_quota_usage
        SET attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE tenant_id = ? AND channel = ? AND date = ? AND attempt_count < ?
      `).run(now, tenantId, ch, targetDate, limit);

      // 3. Read current state
      const current = this.sqlite.prepare(`
        SELECT * FROM daily_quota_usage
        WHERE tenant_id = ? AND channel = ? AND date = ?
      `).get(tenantId, ch, targetDate);

      if (res.changes > 0) {
        return {
          reserved: true,
          currentCount: current.attempt_count,
          limit,
          usage: current
        };
      } else {
        // Daily limit already met or exceeded
        this.sqlite.prepare(`
          UPDATE daily_quota_usage
          SET blocked_count = blocked_count + 1,
              updated_at = ?
          WHERE tenant_id = ? AND channel = ? AND date = ?
        `).run(now, tenantId, ch, targetDate);

        return {
          reserved: false,
          currentCount: current.attempt_count,
          limit,
          usage: current,
          reason: `Daily quota for "${ch}" has been reached (${current.attempt_count}/${limit} on ${targetDate})`
        };
      }
    });

    return reserveTx();
  }

  /**
   * Release a previously reserved quota attempt in case of non-attempt rollbacks.
   */
  releaseDailyQuotaReservation(channel, date = null, tenantId = 'default') {
    if (!channel) return null;
    const ch = String(channel).toLowerCase().trim();
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    return this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE daily_quota_usage
        SET attempt_count = MAX(0, attempt_count - 1),
            updated_at = ?
        WHERE tenant_id = ? AND channel = ? AND date = ?
      `).run(now, tenantId, ch, targetDate);

      return this.getDailyQuotaUsage(ch, targetDate, tenantId);
    })();
  }

  /**
   * Validate lead ownership and tenant isolation.
   * Prevents IDOR and cross-tenant outreach dispatch.
   */
  validateLeadOwnership(leadId, tenantId = 'default') {
    if (!leadId) return { valid: false, reason: 'Lead ID is required' };
    const lead = this.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) return { valid: false, reason: `Lead "${leadId}" does not exist`, notFound: true };
    const leadTenant = lead.tenant_id || 'default';
    if (leadTenant !== tenantId) {
      return {
        valid: false,
        reason: `Cross-tenant access violation: lead belongs to tenant "${leadTenant}", requested by "${tenantId}"`,
        lead
      };
    }
    return { valid: true, lead };
  }

  // --- Lead Safety State ---
  updateLeadSafetyState(leadId, safetyUpdates = {}) {
    const current = this.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!current) return null;

    const allowed = [
      'opted_out', 'opted_out_at', 'opted_out_source',
      'outreach_attempt_count', 'last_outreach_at', 'last_outreach_channel', 'last_inbound_at'
    ];

    const sets = [];
    const params = { id: leadId };

    for (const key of allowed) {
      if (safetyUpdates[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = safetyUpdates[key];
      }
    }

    if (!sets.length) return current;

    this.sqlite.prepare(`
      UPDATE leads
      SET ${sets.join(', ')}
      WHERE id = @id
    `).run(params);

    return this.sqlite.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  }

  getLeadSafetyState(leadId) {
    const lead = this.sqlite.prepare(`
      SELECT id, businessName, phone, email, telegram, leadStatus,
             outreach_attempt_count, last_outreach_at, last_outreach_channel, last_inbound_at,
             opted_out, opted_out_at, opted_out_source
      FROM leads
      WHERE id = ?
    `).get(leadId);

    if (!lead) return null;

    const channels = this.sqlite.prepare(`
      SELECT * FROM channel_outreach_state
      WHERE lead_id = ?
    `).all(leadId);

    return {
      lead,
      channels
    };
  }

  // ==========================================================================
  // PHASE 2 — ADVANCED LEAD INTELLIGENCE HELPERS
  // ==========================================================================

  /**
   * 1. Upsert a lead's intelligence profile (1:1 per lead)
   */
  upsertLeadIntelligence(leadId, data = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }

    const now = new Date().toISOString();
    const id = data.id || `intel_${leadId}`;

    const serializeJson = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === 'string') return val;
      return JSON.stringify(val);
    };

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      industry: data.industry || null,
      sub_industry: data.sub_industry || null,
      business_type: data.business_type || null,
      company_size_estimate: data.company_size_estimate || null,
      employee_count_estimate: data.employee_count_estimate !== undefined ? parseInt(data.employee_count_estimate, 10) || null : null,
      geographic_scope: data.geographic_scope || null,
      service_area: data.service_area || null,
      business_description: data.business_description || null,
      products_services: data.products_services || null,
      target_customer_type: data.target_customer_type || null,
      technology_signals: serializeJson(data.technology_signals),
      automation_signals: serializeJson(data.automation_signals),
      growth_signals: serializeJson(data.growth_signals),
      pain_point_signals: serializeJson(data.pain_point_signals),
      website_quality_score: parseFloat(data.website_quality_score) || 0.0,
      digital_presence_score: parseFloat(data.digital_presence_score) || 0.0,
      intelligence_score: parseFloat(data.intelligence_score) || 0.0,
      confidence_score: parseFloat(data.confidence_score) || 0.0,
      last_analyzed_at: data.last_analyzed_at || now,
      intelligence_version: parseInt(data.intelligence_version, 10) || 1,
      created_at: data.created_at || now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_intelligence (
        id, lead_id, tenant_id, industry, sub_industry, business_type,
        company_size_estimate, employee_count_estimate, geographic_scope, service_area,
        business_description, products_services, target_customer_type,
        technology_signals, automation_signals, growth_signals, pain_point_signals,
        website_quality_score, digital_presence_score, intelligence_score, confidence_score,
        last_analyzed_at, intelligence_version, created_at, updated_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @industry, @sub_industry, @business_type,
        @company_size_estimate, @employee_count_estimate, @geographic_scope, @service_area,
        @business_description, @products_services, @target_customer_type,
        @technology_signals, @automation_signals, @growth_signals, @pain_point_signals,
        @website_quality_score, @digital_presence_score, @intelligence_score, @confidence_score,
        @last_analyzed_at, @intelligence_version, @created_at, @updated_at
      ) ON CONFLICT(lead_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        industry = COALESCE(excluded.industry, lead_intelligence.industry),
        sub_industry = COALESCE(excluded.sub_industry, lead_intelligence.sub_industry),
        business_type = COALESCE(excluded.business_type, lead_intelligence.business_type),
        company_size_estimate = COALESCE(excluded.company_size_estimate, lead_intelligence.company_size_estimate),
        employee_count_estimate = COALESCE(excluded.employee_count_estimate, lead_intelligence.employee_count_estimate),
        geographic_scope = COALESCE(excluded.geographic_scope, lead_intelligence.geographic_scope),
        service_area = COALESCE(excluded.service_area, lead_intelligence.service_area),
        business_description = COALESCE(excluded.business_description, lead_intelligence.business_description),
        products_services = COALESCE(excluded.products_services, lead_intelligence.products_services),
        target_customer_type = COALESCE(excluded.target_customer_type, lead_intelligence.target_customer_type),
        technology_signals = COALESCE(excluded.technology_signals, lead_intelligence.technology_signals),
        automation_signals = COALESCE(excluded.automation_signals, lead_intelligence.automation_signals),
        growth_signals = COALESCE(excluded.growth_signals, lead_intelligence.growth_signals),
        pain_point_signals = COALESCE(excluded.pain_point_signals, lead_intelligence.pain_point_signals),
        website_quality_score = excluded.website_quality_score,
        digital_presence_score = excluded.digital_presence_score,
        intelligence_score = excluded.intelligence_score,
        confidence_score = excluded.confidence_score,
        last_analyzed_at = excluded.last_analyzed_at,
        intelligence_version = excluded.intelligence_version,
        updated_at = excluded.updated_at
    `).run(record);

    return this.getLeadIntelligence(leadId, tenantId);
  }

  /**
   * Retrieve intelligence profile for a lead
   */
  getLeadIntelligence(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    const row = this.sqlite.prepare(`
      SELECT * FROM lead_intelligence
      WHERE lead_id = ? AND tenant_id = ?
    `).get(leadId, tenantId);

    if (!row) return null;

    const safeParse = (str) => {
      if (!str) return null;
      try { return JSON.parse(str); } catch (_) { return str; }
    };

    return {
      ...row,
      technology_signals: safeParse(row.technology_signals),
      automation_signals: safeParse(row.automation_signals),
      growth_signals: safeParse(row.growth_signals),
      pain_point_signals: safeParse(row.pain_point_signals)
    };
  }

  /**
   * 2. Add contact to lead
   */
  addLeadContact(leadId, contactData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }

    const now = new Date().toISOString();
    const id = contactData.id || `ctc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const allowedProvenance = ['VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN'];
    const provenance_type = allowedProvenance.includes(contactData.provenance_type) ? contactData.provenance_type : 'UNKNOWN';

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      contact_name: contactData.contact_name || (contactData.first_name ? `${contactData.first_name} ${contactData.last_name || ''}`.trim() : null),
      first_name: contactData.first_name || null,
      last_name: contactData.last_name || null,
      job_title: contactData.job_title || null,
      department: contactData.department || null,
      contact_type: contactData.contact_type || 'OTHER',
      phone: contactData.phone || null,
      email: contactData.email || null,
      linkedin_url: contactData.linkedin_url || null,
      source: contactData.source || 'manual',
      verification_status: contactData.verification_status || 'UNVERIFIED',
      confidence_score: parseFloat(contactData.confidence_score) || 0.0,
      is_decision_maker: contactData.is_decision_maker ? 1 : 0,
      provenance_type,
      created_at: now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_contacts (
        id, lead_id, tenant_id, contact_name, first_name, last_name,
        job_title, department, contact_type, phone, email, linkedin_url,
        source, verification_status, confidence_score, is_decision_maker,
        provenance_type, created_at, updated_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @contact_name, @first_name, @last_name,
        @job_title, @department, @contact_type, @phone, @email, @linkedin_url,
        @source, @verification_status, @confidence_score, @is_decision_maker,
        @provenance_type, @created_at, @updated_at
      )
    `).run(record);

    return record;
  }

  /**
   * Retrieve contacts for a lead
   */
  getLeadContacts(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    return this.sqlite.prepare(`
      SELECT * FROM lead_contacts
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY is_decision_maker DESC, created_at ASC
    `).all(leadId, tenantId);
  }

  /**
   * 3. Add evidence record
   */
  addLeadEvidence(leadId, evidenceData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }

    const now = new Date().toISOString();
    const id = evidenceData.id || `evd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const allowedProvenance = ['VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN'];
    const provenance_type = allowedProvenance.includes(evidenceData.provenance_type) ? evidenceData.provenance_type : 'UNKNOWN';

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      evidence_type: evidenceData.evidence_type || 'OTHER',
      source_url: evidenceData.source_url || null,
      source_name: evidenceData.source_name || null,
      evidence_text: evidenceData.evidence_text || null,
      extracted_value: evidenceData.extracted_value || null,
      confidence_score: parseFloat(evidenceData.confidence_score) || 0.0,
      verified_at: evidenceData.verified_at || null,
      expires_at: evidenceData.expires_at || null,
      extraction_method: evidenceData.extraction_method || 'manual',
      provenance_type,
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_evidence (
        id, lead_id, tenant_id, evidence_type, source_url, source_name,
        evidence_text, extracted_value, confidence_score, verified_at,
        expires_at, extraction_method, provenance_type, created_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @evidence_type, @source_url, @source_name,
        @evidence_text, @extracted_value, @confidence_score, @verified_at,
        @expires_at, @extraction_method, @provenance_type, @created_at
      )
    `).run(record);

    return record;
  }

  /**
   * Retrieve evidence records for a lead
   */
  getLeadEvidence(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    return this.sqlite.prepare(`
      SELECT * FROM lead_evidence
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY created_at DESC
    `).all(leadId, tenantId);
  }

  /**
   * 4. Add business signal linked to evidence
   */
  addLeadSignal(leadId, signalData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }

    // If evidence_id is passed, verify it belongs to this lead
    if (signalData.evidence_id) {
      const evd = this.sqlite.prepare(`
        SELECT id FROM lead_evidence WHERE id = ? AND lead_id = ?
      `).get(signalData.evidence_id, leadId);
      if (!evd) {
        throw new Error(`Evidence ID "${signalData.evidence_id}" does not exist for lead "${leadId}"`);
      }
    }

    const now = new Date().toISOString();
    const id = signalData.id || `sig_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const allowedProvenance = ['VERIFIED', 'INFERRED', 'AI_ESTIMATED', 'UNKNOWN'];
    const provenance_type = allowedProvenance.includes(signalData.provenance_type) ? signalData.provenance_type : 'UNKNOWN';

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      signal_type: signalData.signal_type,
      signal_value: signalData.signal_value || null,
      signal_strength: signalData.signal_strength || 'MEDIUM',
      source: signalData.source || 'scanner',
      evidence_id: signalData.evidence_id || null,
      confidence_score: parseFloat(signalData.confidence_score) || 0.0,
      detected_at: signalData.detected_at || now,
      expires_at: signalData.expires_at || null,
      provenance_type,
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_signals (
        id, lead_id, tenant_id, signal_type, signal_value, signal_strength,
        source, evidence_id, confidence_score, detected_at, expires_at,
        provenance_type, created_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @signal_type, @signal_value, @signal_strength,
        @source, @evidence_id, @confidence_score, @detected_at, @expires_at,
        @provenance_type, @created_at
      )
    `).run(record);

    return record;
  }

  /**
   * Retrieve signals for a lead
   */
  getLeadSignals(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    return this.sqlite.prepare(`
      SELECT * FROM lead_signals
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY detected_at DESC
    `).all(leadId, tenantId);
  }

  /**
   * 5. Add versioned score snapshot
   */
  addLeadScore(leadId, scoreData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) {
      throw new Error(ownership.reason || 'Lead authorization failed');
    }

    if (!scoreData.score_type) {
      throw new Error('score_type is required');
    }

    const now = new Date().toISOString();
    const id = scoreData.id || `scr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Auto-calculate version if not explicitly supplied
    let scoreVersion = scoreData.score_version;
    if (!scoreVersion) {
      const latest = this.sqlite.prepare(`
        SELECT MAX(score_version) as max_v FROM lead_scores
        WHERE lead_id = ? AND score_type = ?
      `).get(leadId, scoreData.score_type);
      scoreVersion = (latest?.max_v || 0) + 1;
    }

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      score_type: scoreData.score_type,
      score: parseFloat(scoreData.score) || 0.0,
      score_version: parseInt(scoreVersion, 10) || 1,
      scoring_version: parseInt(scoreData.scoring_version, 10) || 1,
      scoring_reason: scoreData.scoring_reason || null,
      confidence_score: parseFloat(scoreData.confidence_score) || 0.0,
      calculated_at: scoreData.calculated_at || now,
      created_at: now,
      icp_profile_version: parseInt(scoreData.icp_profile_version, 10) || 1,
      icp_fit_score: parseFloat(scoreData.icp_fit_score) || 0.0,
      opportunity_score: parseFloat(scoreData.opportunity_score) || 0.0,
      data_confidence_score: parseFloat(scoreData.data_confidence_score) || 0.0,
      sales_priority_score: parseFloat(scoreData.sales_priority_score) || 0.0,
      priority_level: scoreData.priority_level || 'P5',
      positive_factors: typeof scoreData.positive_factors === 'string' ? scoreData.positive_factors : JSON.stringify(scoreData.positive_factors || []),
      negative_factors: typeof scoreData.negative_factors === 'string' ? scoreData.negative_factors : JSON.stringify(scoreData.negative_factors || []),
      unknown_factors: typeof scoreData.unknown_factors === 'string' ? scoreData.unknown_factors : JSON.stringify(scoreData.unknown_factors || []),
      score_breakdown: typeof scoreData.score_breakdown === 'string' ? scoreData.score_breakdown : JSON.stringify(scoreData.score_breakdown || {}),
      scoring_inputs_snapshot: typeof scoreData.scoring_inputs_snapshot === 'string' ? scoreData.scoring_inputs_snapshot : JSON.stringify(scoreData.scoring_inputs_snapshot || {}),
      input_hash: scoreData.input_hash || null
    };

    this.sqlite.prepare(`
      INSERT INTO lead_scores (
        id, lead_id, tenant_id, score_type, score, score_version, scoring_version,
        scoring_reason, confidence_score, calculated_at, created_at,
        icp_profile_version, icp_fit_score, opportunity_score, data_confidence_score,
        sales_priority_score, priority_level, positive_factors, negative_factors,
        unknown_factors, score_breakdown, scoring_inputs_snapshot, input_hash
      ) VALUES (
        @id, @lead_id, @tenant_id, @score_type, @score, @score_version, @scoring_version,
        @scoring_reason, @confidence_score, @calculated_at, @created_at,
        @icp_profile_version, @icp_fit_score, @opportunity_score, @data_confidence_score,
        @sales_priority_score, @priority_level, @positive_factors, @negative_factors,
        @unknown_factors, @score_breakdown, @scoring_inputs_snapshot, @input_hash
      )
    `).run(record);

    return record;
  }

  /**
   * Retrieve versioned score snapshots for a lead
   */
  getLeadScores(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    return this.sqlite.prepare(`
      SELECT * FROM lead_scores
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY calculated_at DESC, score_version DESC
    `).all(leadId, tenantId);
  }

  /**
   * Retrieve latest score record for a lead (overall or by score_type)
   */
  getLatestLeadScore(leadId, tenantId = 'default', scoreType = null) {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    if (scoreType) {
      return this.sqlite.prepare(`
        SELECT * FROM lead_scores
        WHERE lead_id = ? AND tenant_id = ? AND score_type = ?
        ORDER BY score_version DESC, calculated_at DESC
        LIMIT 1
      `).get(leadId, tenantId, scoreType) || null;
    }

    return this.sqlite.prepare(`
      SELECT * FROM lead_scores
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY calculated_at DESC, score_version DESC
      LIMIT 1
    `).get(leadId, tenantId) || null;
  }

  /**
   * Check if a score snapshot with identical input_hash already exists
   */
  getScoreByInputHash(leadId, inputHash, tenantId = 'default') {
    if (!inputHash) return null;
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    return this.sqlite.prepare(`
      SELECT * FROM lead_scores
      WHERE lead_id = ? AND tenant_id = ? AND input_hash = ?
      ORDER BY score_version DESC
      LIMIT 1
    `).get(leadId, tenantId, inputHash) || null;
  }

  // ==========================================================================
  // PHASE 2 STEP 4: ICP PROFILES & SCORING RUN HELPERS
  // ==========================================================================

  /**
   * Get active or specific version ICP profile for tenant
   */
  getIcpProfile(tenantId = 'default', version = null) {
    if (version !== null && version !== undefined) {
      return this.sqlite.prepare(`
        SELECT * FROM icp_profiles
        WHERE tenant_id = ? AND version = ?
      `).get(tenantId, parseInt(version, 10)) || null;
    }

    return this.sqlite.prepare(`
      SELECT * FROM icp_profiles
      WHERE tenant_id = ? AND is_active = 1
      ORDER BY version DESC
      LIMIT 1
    `).get(tenantId) || null;
  }

  /**
   * Create or increment ICP profile version
   */
  saveIcpProfile(tenantId = 'default', profileData = {}) {
    const now = new Date().toISOString();
    const latest = this.sqlite.prepare(`
      SELECT MAX(version) as max_v FROM icp_profiles WHERE tenant_id = ?
    `).get(tenantId);
    const nextVersion = (latest?.max_v || 0) + 1;

    // Deactivate previous active profiles if this one is active
    if (profileData.is_active !== 0) {
      this.sqlite.prepare(`
        UPDATE icp_profiles SET is_active = 0 WHERE tenant_id = ?
      `).run(tenantId);
    }

    const id = profileData.id || `icp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const record = {
      id,
      tenant_id: tenantId,
      version: nextVersion,
      name: profileData.name || `ICP Profile v${nextVersion}`,
      description: profileData.description || null,
      target_industries: typeof profileData.target_industries === 'string' ? profileData.target_industries : JSON.stringify(profileData.target_industries || []),
      excluded_industries: typeof profileData.excluded_industries === 'string' ? profileData.excluded_industries : JSON.stringify(profileData.excluded_industries || []),
      target_regions: typeof profileData.target_regions === 'string' ? profileData.target_regions : JSON.stringify(profileData.target_regions || []),
      business_types: typeof profileData.business_types === 'string' ? profileData.business_types : JSON.stringify(profileData.business_types || []),
      weights: typeof profileData.weights === 'string' ? profileData.weights : JSON.stringify(profileData.weights || {}),
      rules: typeof profileData.rules === 'string' ? profileData.rules : JSON.stringify(profileData.rules || {}),
      is_active: profileData.is_active !== undefined ? (profileData.is_active ? 1 : 0) : 1,
      created_at: now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO icp_profiles (
        id, tenant_id, version, name, description, target_industries,
        excluded_industries, target_regions, business_types, weights,
        rules, is_active, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @version, @name, @description, @target_industries,
        @excluded_industries, @target_regions, @business_types, @weights,
        @rules, @is_active, @created_at, @updated_at
      )
    `).run(record);

    return record;
  }

  /**
   * Scoring run observability helpers
   */
  createScoringRun(data = {}, tenantId = 'default') {
    const now = new Date().toISOString();
    const id = data.id || `scrun_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const record = {
      id,
      tenant_id: data.tenant_id || tenantId,
      status: data.status || 'QUEUED',
      scoring_version: data.scoring_version || 1,
      icp_version: data.icp_version || 1,
      total_requested: data.total_requested || 0,
      leads_processed: data.leads_processed || 0,
      leads_scored: data.leads_scored || 0,
      leads_skipped: data.leads_skipped || 0,
      errors: typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors || []),
      summary: data.summary || null,
      started_at: data.started_at || now,
      completed_at: data.completed_at || null,
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO scoring_runs (
        id, tenant_id, status, scoring_version, icp_version,
        total_requested, leads_processed, leads_scored, leads_skipped,
        errors, summary, started_at, completed_at, created_at
      ) VALUES (
        @id, @tenant_id, @status, @scoring_version, @icp_version,
        @total_requested, @leads_processed, @leads_scored, @leads_skipped,
        @errors, @summary, @started_at, @completed_at, @created_at
      )
    `).run(record);

    return record;
  }

  updateScoringRun(id, updates = {}, tenantId = 'default') {
    const fields = [];
    const params = { id, tenantId };

    for (const [key, value] of Object.entries(updates)) {
      if (['status', 'leads_processed', 'leads_scored', 'leads_skipped', 'summary', 'completed_at'].includes(key)) {
        fields.push(`${key} = @${key}`);
        params[key] = value;
      } else if (key === 'errors') {
        fields.push(`errors = @${key}`);
        params[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }

    if (fields.length === 0) return;

    this.sqlite.prepare(`
      UPDATE scoring_runs
      SET ${fields.join(', ')}
      WHERE id = @id AND tenant_id = @tenantId
    `).run(params);
  }

  getScoringRun(id, tenantId = 'default') {
    return this.sqlite.prepare(`
      SELECT * FROM scoring_runs WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId) || null;
  }

  // ==========================================================================
  // PHASE 2 STEP 2: BUSINESS ENTITY & CONTACT RESOLUTION HELPERS
  // ==========================================================================

  /**
   * Create an entity group
   */
  createEntityGroup(data = {}, tenantId = 'default') {
    const tid = data.tenant_id || tenantId;
    const now = new Date().toISOString();
    const id = data.id || `grp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const record = {
      id,
      tenant_id: tid,
      canonical_lead_id: data.canonical_lead_id || null,
      entity_name: data.entity_name || 'Unknown Entity',
      normalized_name: data.normalized_name || null,
      primary_domain: data.primary_domain || null,
      entity_type: data.entity_type || 'SINGLE_LOCATION',
      confidence_score: typeof data.confidence_score === 'number' ? data.confidence_score : 1.0,
      status: data.status || 'AUTO_RESOLVED',
      metadata: typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || null),
      created_at: data.created_at || now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_entity_groups (
        id, tenant_id, canonical_lead_id, entity_name, normalized_name,
        primary_domain, entity_type, confidence_score, status, metadata,
        created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @canonical_lead_id, @entity_name, @normalized_name,
        @primary_domain, @entity_type, @confidence_score, @status, @metadata,
        @created_at, @updated_at
      )
    `).run(record);

    return record;
  }

  /**
   * Add a member lead to an entity group
   */
  addEntityMember(data = {}, tenantId = 'default') {
    const tid = data.tenant_id || tenantId;
    const now = new Date().toISOString();
    const id = data.id || `mem_${data.group_id}_${data.lead_id}`;

    const record = {
      id,
      group_id: data.group_id,
      lead_id: data.lead_id,
      tenant_id: tid,
      role: data.role || 'CANONICAL',
      match_confidence: typeof data.match_confidence === 'number' ? data.match_confidence : 1.0,
      match_reason: data.match_reason || 'Manual assignment',
      match_signals: typeof data.match_signals === 'object' ? JSON.stringify(data.match_signals) : (data.match_signals || null),
      created_at: data.created_at || now,
      updated_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO lead_entity_members (
        id, group_id, lead_id, tenant_id, role, match_confidence,
        match_reason, match_signals, created_at, updated_at
      ) VALUES (
        @id, @group_id, @lead_id, @tenant_id, @role, @match_confidence,
        @match_reason, @match_signals, @created_at, @updated_at
      )
    `).run(record);

    return record;
  }

  /**
   * Get entity group by its group ID
   */
  getEntityGroupById(groupId, tenantId = 'default') {
    const group = this.sqlite.prepare(`
      SELECT * FROM lead_entity_groups
      WHERE id = ? AND tenant_id = ?
    `).get(groupId, tenantId);

    if (!group) return null;

    const members = this.sqlite.prepare(`
      SELECT m.*, l.businessName, l.phone, l.email, l.website, l.address, l.location, l.placeId
      FROM lead_entity_members m
      JOIN leads l ON m.lead_id = l.id
      WHERE m.group_id = ? AND m.tenant_id = ?
      ORDER BY CASE m.role WHEN 'CANONICAL' THEN 1 WHEN 'RELATED_LOCATION' THEN 2 WHEN 'DUPLICATE' THEN 3 ELSE 4 END
    `).all(groupId, tenantId);

    return {
      ...group,
      metadata: group.metadata ? JSON.parse(group.metadata) : null,
      members: members.map(m => ({
        ...m,
        match_signals: m.match_signals ? JSON.parse(m.match_signals) : null
      }))
    };
  }

  /**
   * Get entity group for a specific lead ID
   */
  getEntityGroupByLeadId(leadId, tenantId = 'default') {
    const member = this.sqlite.prepare(`
      SELECT * FROM lead_entity_members
      WHERE lead_id = ? AND tenant_id = ?
    `).get(leadId, tenantId);

    if (!member) return null;
    return this.getEntityGroupById(member.group_id, tenantId);
  }

  /**
   * Get all members of an entity group
   */
  getEntityGroupMembers(groupId, tenantId = 'default') {
    return this.sqlite.prepare(`
      SELECT m.*, l.businessName, l.phone, l.email, l.website, l.address, l.location
      FROM lead_entity_members m
      JOIN leads l ON m.lead_id = l.id
      WHERE m.group_id = ? AND m.tenant_id = ?
    `).all(groupId, tenantId);
  }

  /**
   * List entity groups with optional filtering
   */
  listEntityGroups({ tenantId = 'default', entityType = null, status = null, limit = 50, offset = 0 } = {}) {
    let sql = `SELECT * FROM lead_entity_groups WHERE tenant_id = ?`;
    const params = [tenantId];

    if (entityType) {
      sql += ` AND entity_type = ?`;
      params.push(entityType);
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);

    const groups = this.sqlite.prepare(sql).all(...params);
    return groups.map(g => ({
      ...g,
      metadata: g.metadata ? JSON.parse(g.metadata) : null
    }));
  }

  /**
   * Update member role in entity group
   */
  updateEntityMemberRole(groupId, leadId, role, tenantId = 'default') {
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      UPDATE lead_entity_members
      SET role = ?, updated_at = ?
      WHERE group_id = ? AND lead_id = ? AND tenant_id = ?
    `).run(role, now, groupId, leadId, tenantId);
  }

  /**
   * Update entity group status or canonical lead
   */
  updateEntityGroup(groupId, updates = {}, tenantId = 'default') {
    const now = new Date().toISOString();
    const sets = ['updated_at = ?'];
    const params = [now];

    if (updates.status) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.canonical_lead_id) {
      sets.push('canonical_lead_id = ?');
      params.push(updates.canonical_lead_id);
    }
    if (updates.entity_type) {
      sets.push('entity_type = ?');
      params.push(updates.entity_type);
    }

    params.push(groupId, tenantId);

    return this.sqlite.prepare(`
      UPDATE lead_entity_groups
      SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ?
    `).run(...params);
  }

  // ==========================================================================
  // PHASE 2 STEP 3: ENRICHMENT RUNS & IDEMPOTENT RECORDING HELPERS
  // ==========================================================================

  /**
   * Create an enrichment run tracking record
   */
  createEnrichmentRun(data = {}) {
    const id = data.id || `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const tenantId = data.tenantId || data.tenant_id || 'default';
    const now = new Date().toISOString();

    const record = {
      id,
      lead_id: data.leadId || data.lead_id,
      tenant_id: tenantId,
      status: data.status || 'QUEUED',
      started_at: data.started_at || now,
      completed_at: data.completed_at || null,
      pages_attempted: data.pages_attempted || 0,
      pages_successful: data.pages_successful || 0,
      pages_failed: data.pages_failed || 0,
      evidence_count: data.evidence_count || 0,
      signals_count: data.signals_count || 0,
      contacts_count: data.contacts_count || 0,
      error_message: data.error_message || null,
      summary: data.summary || null,
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO enrichment_runs (
        id, lead_id, tenant_id, status, started_at, completed_at,
        pages_attempted, pages_successful, pages_failed, evidence_count,
        signals_count, contacts_count, error_message, summary, created_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @status, @started_at, @completed_at,
        @pages_attempted, @pages_successful, @pages_failed, @evidence_count,
        @signals_count, @contacts_count, @error_message, @summary, @created_at
      )
    `).run(record);

    return record;
  }

  /**
   * Update an enrichment run record
   */
  updateEnrichmentRun(runId, updates = {}, tenantId = 'default') {
    const sets = [];
    const params = [];

    const allowed = [
      'status', 'completed_at', 'pages_attempted', 'pages_successful',
      'pages_failed', 'evidence_count', 'signals_count', 'contacts_count',
      'error_message', 'summary'
    ];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(updates[key]);
      }
    }

    if (sets.length === 0) return { changes: 0 };

    params.push(runId, tenantId);
    return this.sqlite.prepare(`
      UPDATE enrichment_runs
      SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ?
    `).run(...params);
  }

  /**
   * Get latest enrichment run for a lead
   */
  getLatestEnrichmentRun(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    return this.sqlite.prepare(`
      SELECT * FROM enrichment_runs
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(leadId, tenantId);
  }

  /**
   * Get all enrichment runs for a lead
   */
  getEnrichmentRunsByLeadId(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    return this.sqlite.prepare(`
      SELECT * FROM enrichment_runs
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY started_at DESC
    `).all(leadId, tenantId);
  }

  /**
   * Idempotent evidence insertion: updates existing if same type & URL
   */
  upsertLeadEvidence(leadId, evidenceData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) throw new Error(ownership.reason || 'Lead authorization failed');

    const extVal = evidenceData.extracted_value || null;
    const srcUrl = evidenceData.source_url || null;

    const existing = this.sqlite.prepare(`
      SELECT id FROM lead_evidence
      WHERE lead_id = ? AND tenant_id = ? AND evidence_type = ?
        AND (source_url = ? OR (source_url IS NULL AND ? IS NULL))
        AND (extracted_value = ? OR (extracted_value IS NULL AND ? IS NULL))
    `).get(leadId, tenantId, evidenceData.evidence_type, srcUrl, srcUrl, extVal, extVal);

    if (existing) {
      const now = new Date().toISOString();
      this.sqlite.prepare(`
        UPDATE lead_evidence
        SET confidence_score = ?, verified_at = ?, expires_at = ?, evidence_text = ?
        WHERE id = ?
      `).run(
        parseFloat(evidenceData.confidence_score) || 0.90,
        now,
        evidenceData.expires_at || null,
        evidenceData.evidence_text || null,
        existing.id
      );
      return { ...evidenceData, id: existing.id, updated: true };
    }

    return this.addLeadEvidence(leadId, evidenceData, tenantId);
  }

  /**
   * Idempotent signal insertion: updates existing if same type & value
   */
  upsertLeadSignal(leadId, signalData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) throw new Error(ownership.reason || 'Lead authorization failed');

    const existing = this.sqlite.prepare(`
      SELECT id FROM lead_signals
      WHERE lead_id = ? AND tenant_id = ? AND signal_type = ? AND signal_value = ?
    `).get(leadId, tenantId, signalData.signal_type, signalData.signal_value || null);

    if (existing) {
      const now = new Date().toISOString();
      this.sqlite.prepare(`
        UPDATE lead_signals
        SET confidence_score = ?, signal_strength = ?, evidence_id = ?, detected_at = ?, expires_at = ?
        WHERE id = ?
      `).run(
        parseFloat(signalData.confidence_score) || 0.85,
        signalData.signal_strength || 'MEDIUM',
        signalData.evidence_id || null,
        now,
        signalData.expires_at || null,
        existing.id
      );
      return { ...signalData, id: existing.id, updated: true };
    }

    return this.addLeadSignal(leadId, signalData, tenantId);
  }

  // ==========================================================================
  // PHASE 2 STEP 5: SALES ACTION RECOMMENDATION HELPERS
  // ==========================================================================

  /**
   * Add a versioned sales action recommendation snapshot
   */
  addRecommendation(leadId, recData = {}, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) throw new Error(ownership.reason || 'Lead authorization failed');

    const now = new Date().toISOString();
    const id = recData.id || `rec_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Compute next recommendation version for this lead
    const latest = this.sqlite.prepare(`
      SELECT MAX(recommendation_version) as max_v 
      FROM sales_action_recommendations 
      WHERE lead_id = ? AND tenant_id = ?
    `).get(leadId, tenantId);
    const recVersion = (latest?.max_v || 0) + 1;

    const record = {
      id,
      lead_id: leadId,
      tenant_id: tenantId,
      recommendation_version: parseInt(recData.recommendation_version || recVersion, 10),
      engine_version: parseInt(recData.engine_version, 10) || 1,
      score_id: recData.score_id || null,
      action_type: recData.action_type || 'RESEARCH_GAPS',
      priority_band: recData.priority_band || 'P3',
      urgency: recData.urgency || 'STANDARD',
      recommended_channel: recData.recommended_channel || 'NONE',
      target_contact_id: recData.target_contact_id || null,
      target_contact_name: recData.target_contact_name || null,
      target_contact_handle: recData.target_contact_handle || null,
      headline: recData.headline || '',
      reasoning_summary: recData.reasoning_summary || '',
      supporting_factors: typeof recData.supporting_factors === 'string' ? recData.supporting_factors : JSON.stringify(recData.supporting_factors || []),
      supporting_evidence_ids: typeof recData.supporting_evidence_ids === 'string' ? recData.supporting_evidence_ids : JSON.stringify(recData.supporting_evidence_ids || []),
      supporting_signal_ids: typeof recData.supporting_signal_ids === 'string' ? recData.supporting_signal_ids : JSON.stringify(recData.supporting_signal_ids || []),
      confidence_score: parseFloat(recData.confidence_score) || 0.0,
      freshness_status: recData.freshness_status || 'FRESH',
      input_hash: recData.input_hash || '',
      review_status: recData.review_status || 'PENDING',
      review_notes: recData.review_notes || null,
      reviewed_by: recData.reviewed_by || null,
      reviewed_at: recData.reviewed_at || null,
      created_at: recData.created_at || now,
      expires_at: recData.expires_at || null
    };

    this.sqlite.prepare(`
      INSERT INTO sales_action_recommendations (
        id, lead_id, tenant_id, recommendation_version, engine_version,
        score_id, action_type, priority_band, urgency, recommended_channel,
        target_contact_id, target_contact_name, target_contact_handle,
        headline, reasoning_summary, supporting_factors, supporting_evidence_ids,
        supporting_signal_ids, confidence_score, freshness_status, input_hash,
        review_status, review_notes, reviewed_by, reviewed_at, created_at, expires_at
      ) VALUES (
        @id, @lead_id, @tenant_id, @recommendation_version, @engine_version,
        @score_id, @action_type, @priority_band, @urgency, @recommended_channel,
        @target_contact_id, @target_contact_name, @target_contact_handle,
        @headline, @reasoning_summary, @supporting_factors, @supporting_evidence_ids,
        @supporting_signal_ids, @confidence_score, @freshness_status, @input_hash,
        @review_status, @review_notes, @reviewed_by, @reviewed_at, @created_at, @expires_at
      )
    `).run(record);

    return record;
  }

  /**
   * Get latest recommendation for a lead
   */
  getLatestRecommendation(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    const row = this.sqlite.prepare(`
      SELECT * FROM sales_action_recommendations
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY recommendation_version DESC, created_at DESC
      LIMIT 1
    `).get(leadId, tenantId);

    if (!row) return null;
    return this._formatRecommendationRecord(row);
  }

  /**
   * Get all recommendations history for a lead
   */
  getRecommendationsByLeadId(leadId, tenantId = 'default') {
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return [];

    const rows = this.sqlite.prepare(`
      SELECT * FROM sales_action_recommendations
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY recommendation_version DESC
    `).all(leadId, tenantId);

    return rows.map(r => this._formatRecommendationRecord(r));
  }

  /**
   * Check if recommendation with identical input_hash already exists
   */
  getRecommendationByInputHash(leadId, inputHash, tenantId = 'default') {
    if (!inputHash) return null;
    const ownership = this.validateLeadOwnership(leadId, tenantId);
    if (!ownership.valid) return null;

    const row = this.sqlite.prepare(`
      SELECT * FROM sales_action_recommendations
      WHERE lead_id = ? AND tenant_id = ? AND input_hash = ?
      ORDER BY recommendation_version DESC
      LIMIT 1
    `).get(leadId, tenantId, inputHash);

    if (!row) return null;
    return this._formatRecommendationRecord(row);
  }

  /**
   * List recommendations across tenant with filtering & pagination
   */
  listRecommendations({ tenantId = 'default', actionType = null, priorityBand = null, reviewStatus = null, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT r.*, l.businessName, l.segment, l.phone, l.email, l.website
      FROM sales_action_recommendations r
      JOIN leads l ON r.lead_id = l.id
      INNER JOIN (
        SELECT lead_id, MAX(recommendation_version) as max_v
        FROM sales_action_recommendations
        WHERE tenant_id = ?
        GROUP BY lead_id
      ) latest ON r.lead_id = latest.lead_id AND r.recommendation_version = latest.max_v
      WHERE r.tenant_id = ?
    `;
    const params = [tenantId, tenantId];

    if (actionType) {
      sql += ` AND r.action_type = ?`;
      params.push(actionType);
    }
    if (priorityBand) {
      sql += ` AND r.priority_band = ?`;
      params.push(priorityBand);
    }
    if (reviewStatus) {
      sql += ` AND r.review_status = ?`;
      params.push(reviewStatus);
    }

    sql += ` ORDER BY CASE r.priority_band WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END, r.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatRecommendationRecord(r));
  }

  /**
   * Update recommendation review status (Human-in-the-Loop)
   */
  updateRecommendationReviewState(id, reviewData = {}, notesOrTenant = null, tenant = 'default') {
    let status = 'ACCEPTED';
    let notes = null;
    let reviewedBy = 'sales_rep';
    let tenantId = 'default';

    if (typeof reviewData === 'string') {
      status = reviewData.toUpperCase();
      if (typeof notesOrTenant === 'string') {
        notes = notesOrTenant;
        tenantId = tenant || 'default';
      }
    } else {
      status = reviewData.status ? reviewData.status.toUpperCase() : 'ACCEPTED';
      notes = reviewData.notes || null;
      reviewedBy = reviewData.reviewed_by || 'sales_rep';
      tenantId = typeof notesOrTenant === 'string' ? notesOrTenant : (reviewData.tenant_id || 'default');
    }

    const allowed = ['ACCEPTED', 'REJECTED', 'DISMISSED', 'ACTIONED', 'PENDING'];
    if (!allowed.includes(status)) throw new Error(`Invalid review status: ${status}`);

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      UPDATE sales_action_recommendations
      SET review_status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(
      status,
      notes,
      reviewedBy,
      now,
      id,
      tenantId
    );

    const updated = this.sqlite.prepare(`
      SELECT * FROM sales_action_recommendations
      WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId);

    return this._formatRecommendationRecord(updated);
  }


  _formatRecommendationRecord(row) {
    if (!row) return null;
    return {
      ...row,
      supporting_factors: typeof row.supporting_factors === 'string' ? JSON.parse(row.supporting_factors) : row.supporting_factors,
      supporting_evidence_ids: typeof row.supporting_evidence_ids === 'string' ? JSON.parse(row.supporting_evidence_ids) : row.supporting_evidence_ids,
      supporting_signal_ids: typeof row.supporting_signal_ids === 'string' ? JSON.parse(row.supporting_signal_ids) : row.supporting_signal_ids
    };
  }

  // ==========================================================================
  // PHASE 2 — STEP 6A: CAMPAIGN & OUTREACH PLANNING MODEL HELPERS
  // ==========================================================================

  _validateJson(data, fieldName) {
    if (typeof data === 'object' && data !== null) {
      try {
        return JSON.stringify(data);
      } catch (err) {
        throw new Error(`Field "${fieldName}" failed JSON serialization: ${err.message}`);
      }
    }
    if (typeof data === 'string') {
      try {
        JSON.parse(data);
        return data;
      } catch (err) {
        throw new Error(`Field "${fieldName}" contains invalid JSON: ${err.message}`);
      }
    }
    throw new Error(`Field "${fieldName}" must be a valid JSON object or JSON string`);
  }

  _safeParseJson(str, defaultValue = null) {
    if (!str) return defaultValue;
    if (typeof str === 'object') return str;
    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  }

  _formatCampaignRecord(row) {
    if (!row) return null;
    return {
      ...row,
      target_criteria: this._safeParseJson(row.target_criteria, {}),
      channel_strategy: this._safeParseJson(row.channel_strategy, {}),
      sequence_plan: this._safeParseJson(row.sequence_plan, null),
      approval_metadata: this._safeParseJson(row.approval_metadata, null)
    };
  }

  _formatCampaignLeadRecord(row) {
    if (!row) return null;
    return {
      ...row,
      eligibility_details: this._safeParseJson(row.eligibility_details, null)
    };
  }

  createCampaign(campaignData = {}, tenantId = 'default') {
    const {
      name,
      objective,
      target_criteria,
      channel_strategy,
      sequence_plan = null,
      status = 'DRAFT',
      campaign_version = 1
    } = campaignData;

    const tid = (campaignData.tenant_id || tenantId || 'default').trim();

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Campaign name is required');
    }

    const ALLOWED_OBJECTIVES = ['GENERATE_MEETINGS', 'QUALIFY_LEADS', 'RESEARCH_ENRICHMENT', 'REACTIVATE_COLD', 'MULTI_LOCATION_HQ'];
    if (!objective || !ALLOWED_OBJECTIVES.includes(objective)) {
      throw new Error(`Invalid campaign objective "${objective}". Allowed: ${ALLOWED_OBJECTIVES.join(', ')}`);
    }

    const ALLOWED_STATUSES = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
    if (status && !ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid campaign status "${status}". Allowed: ${ALLOWED_STATUSES.join(', ')}`);
    }

    const targetCriteriaStr = this._validateJson(target_criteria, 'target_criteria');
    const channelStrategyStr = this._validateJson(channel_strategy, 'channel_strategy');
    const sequencePlanStr = sequence_plan ? this._validateJson(sequence_plan, 'sequence_plan') : null;

    if (campaign_version < 1) {
      throw new Error('Campaign version must be >= 1');
    }

    const id = campaignData.id || `cmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    this.sqlite.prepare(`
      INSERT INTO campaigns (
        id, tenant_id, name, objective, status, target_criteria, channel_strategy, sequence_plan,
        total_leads, eligible_leads, review_status, campaign_version, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @name, @objective, @status, @target_criteria, @channel_strategy, @sequence_plan,
        0, 0, 'PENDING', @campaign_version, @created_at, @updated_at
      )
    `).run({
      id,
      tenant_id: tid,
      name: name.trim(),
      objective,
      status,
      target_criteria: targetCriteriaStr,
      channel_strategy: channelStrategyStr,
      sequence_plan: sequencePlanStr,
      campaign_version,
      created_at: now,
      updated_at: now
    });

    return this.getCampaignById(id, tid);
  }

  getCampaignById(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?').get(id, tid);
    return this._formatCampaignRecord(row);
  }

  getCampaign(id, tenantId = 'default') {
    return this.getCampaignById(id, tenantId);
  }

  listCampaigns(tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { status = null, review_status = null, limit = 50, offset = 0 } = options;

    let sql = 'SELECT * FROM campaigns WHERE tenant_id = ?';
    const params = [tid];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (review_status) {
      sql += ' AND review_status = ?';
      params.push(review_status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatCampaignRecord(r));
  }

  updateCampaign(id, updates = {}, tenantId = 'default') {
    const current = this.getCampaignById(id, tenantId);
    if (!current) {
      throw new Error(`Campaign "${id}" not found for tenant "${tenantId}"`);
    }

    const tid = (tenantId || 'default').trim();
    const sets = [];
    const params = { id, tenant_id: tid };

    // Material change invalidation for APPROVED campaigns
    const hasMaterialChange = (
      updates.target_criteria !== undefined ||
      updates.channel_strategy !== undefined ||
      updates.sequence_plan !== undefined ||
      updates.objective !== undefined
    );

    if (current.status === 'APPROVED' && hasMaterialChange && !updates.status) {
      updates.status = 'READY_FOR_REVIEW';
      updates.review_status = 'PENDING';
      updates.review_notes = updates.review_notes || 'Approval invalidated due to material configuration change';

      this.createCampaignReviewLog({
        campaign_id: id,
        tenant_id: tid,
        action: 'INVALIDATED_DUE_TO_MATERIAL_CHANGE',
        previous_status: 'APPROVED',
        new_status: 'READY_FOR_REVIEW',
        reviewer: 'system_invalidation',
        review_hash: current.review_hash,
        campaign_version: current.campaign_version,
        notes: updates.review_notes,
        metadata: {
          invalidated_fields: ['target_criteria', 'channel_strategy', 'sequence_plan', 'objective'].filter(f => updates[f] !== undefined)
        }
      }, tid);
    }

    // Lifecycle transition safety rules
    if (updates.status && updates.status !== current.status) {
      const validTransitions = {
        DRAFT: ['READY_FOR_REVIEW', 'CANCELLED'],
        READY_FOR_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
        APPROVED: ['ACTIVE', 'PAUSED', 'CANCELLED', 'READY_FOR_REVIEW', 'DRAFT'],
        REJECTED: ['DRAFT', 'READY_FOR_REVIEW', 'CANCELLED'],
        ACTIVE: ['PAUSED', 'COMPLETED', 'CANCELLED', 'DRAFT', 'READY_FOR_REVIEW'],
        PAUSED: ['ACTIVE', 'COMPLETED', 'CANCELLED', 'DRAFT', 'READY_FOR_REVIEW'],
        COMPLETED: [],
        CANCELLED: []
      };

      const allowedNext = validTransitions[current.status] || [];
      if (!allowedNext.includes(updates.status)) {
        throw new Error(`Invalid lifecycle transition from ${current.status} to ${updates.status}`);
      }

      sets.push('status = @status');
      params.status = updates.status;
    }

    if (updates.name !== undefined) {
      if (!updates.name || typeof updates.name !== 'string' || !updates.name.trim()) {
        throw new Error('Campaign name cannot be empty');
      }
      sets.push('name = @name');
      params.name = updates.name.trim();
    }

    if (updates.objective !== undefined) {
      const ALLOWED_OBJECTIVES = ['GENERATE_MEETINGS', 'QUALIFY_LEADS', 'RESEARCH_ENRICHMENT', 'REACTIVATE_COLD', 'MULTI_LOCATION_HQ'];
      if (!ALLOWED_OBJECTIVES.includes(updates.objective)) {
        throw new Error(`Invalid campaign objective "${updates.objective}"`);
      }
      sets.push('objective = @objective');
      params.objective = updates.objective;
    }

    if (updates.target_criteria !== undefined) {
      sets.push('target_criteria = @target_criteria');
      params.target_criteria = this._validateJson(updates.target_criteria, 'target_criteria');
    }

    if (updates.channel_strategy !== undefined) {
      sets.push('channel_strategy = @channel_strategy');
      params.channel_strategy = this._validateJson(updates.channel_strategy, 'channel_strategy');
    }

    if (updates.sequence_plan !== undefined) {
      sets.push('sequence_plan = @sequence_plan');
      params.sequence_plan = updates.sequence_plan ? this._validateJson(updates.sequence_plan, 'sequence_plan') : null;
    }

    if (updates.review_status !== undefined) {
      const ALLOWED_REVIEWS = ['PENDING', 'APPROVED', 'REJECTED'];
      if (!ALLOWED_REVIEWS.includes(updates.review_status)) {
        throw new Error(`Invalid review status "${updates.review_status}"`);
      }
      sets.push('review_status = @review_status');
      params.review_status = updates.review_status;
    }

    if (updates.reviewed_by !== undefined) {
      sets.push('reviewed_by = @reviewed_by');
      params.reviewed_by = updates.reviewed_by;
    }

    if (updates.reviewed_at !== undefined) {
      sets.push('reviewed_at = @reviewed_at');
      params.reviewed_at = updates.reviewed_at;
    }

    if (updates.review_notes !== undefined) {
      sets.push('review_notes = @review_notes');
      params.review_notes = updates.review_notes;
    }

    if (updates.review_hash !== undefined) {
      sets.push('review_hash = @review_hash');
      params.review_hash = updates.review_hash;
    }

    if (updates.approved_version !== undefined) {
      sets.push('approved_version = @approved_version');
      params.approved_version = updates.approved_version;
    }

    if (updates.approval_metadata !== undefined) {
      sets.push('approval_metadata = @approval_metadata');
      params.approval_metadata = updates.approval_metadata ? this._validateJson(updates.approval_metadata, 'approval_metadata') : null;
    }

    if (updates.campaign_version !== undefined) {
      if (updates.campaign_version < 1) throw new Error('campaign_version must be >= 1');
      sets.push('campaign_version = @campaign_version');
      params.campaign_version = updates.campaign_version;
    }

    if (sets.length === 0) return current;

    sets.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();

    this.sqlite.prepare(`
      UPDATE campaigns
      SET ${sets.join(', ')}
      WHERE id = @id AND tenant_id = @tenant_id
    `).run(params);

    // If campaign is transitioned to APPROVED with a review_hash, ensure snapshots exist
    if ((updates.status === 'APPROVED' || updates.review_status === 'APPROVED') && updates.review_hash) {
      const targetVersion = updates.approved_version !== undefined ? updates.approved_version : (updates.campaign_version !== undefined ? updates.campaign_version : current.campaign_version);
      const approver = updates.reviewed_by || 'system_approver';
      const approvedAt = updates.reviewed_at || new Date().toISOString();

      const touches = this.sqlite.prepare(
        'SELECT * FROM campaign_touches WHERE campaign_id = ? AND tenant_id = ?'
      ).all(id, tid);

      for (const touch of touches) {
        const existingSnap = this.sqlite.prepare(
          'SELECT id FROM campaign_approved_snapshots WHERE campaign_touch_id = ? AND campaign_version = ? AND tenant_id = ?'
        ).get(touch.id, targetVersion, tid);

        if (!existingSnap) {
          // Step 7E-4: Resolve lead & recipient before hash so it can be bound into content hash
          let lead = null;
          if (touch.lead_id) {
            try { lead = this.getLeadById ? this.getLeadById(touch.lead_id, tid) : (this.getLead ? this.getLead(touch.lead_id, tid) : null); } catch (_) {}
          }
          let body = touch.message_body || touch.approved_body || null;
          let subject = touch.message_subject || touch.approved_subject || null;
          if (!body && this._touchContentResolver) {
            try {
              const res = this._touchContentResolver(touch, current, { dbInstance: this, tenantId: tid });
              if (res?.body) {
                body = res.body;
                subject = res.subject || null;
              }
            } catch (_) {}
          }
          if (!body) {
            const bName = lead?.businessName || 'Business';
            const ch = String(touch.planned_channel || '').toUpperCase();
            if (ch === 'WHATSAPP') {
              body = `Hi ${bName}, reaching out regarding your business.`;
            } else if (ch === 'TELEGRAM') {
              body = `🎯 <b>AI Campaign Touch #${touch.touch_number || 1}</b>\n\nLead: ${bName}\nTouch Purpose: ${touch.purpose || 'INITIAL_OUTREACH'}`;
            } else if (ch === 'EMAIL') {
              subject = `Outreach from AI AutomationHubs`;
              body = `Hi ${bName}, reaching out regarding your business.`;
            } else {
              body = `Touch #${touch.touch_number || 1} outreach to ${bName}.`;
            }
          }
          const recipientContact = touch.recipient_contact || (lead ? (touch.planned_channel === 'WHATSAPP' || touch.planned_channel === 'PHONE' ? (lead.phone || lead.phone_number) : lead.email) : null);
          const contentHash = touch.content_hash || touch.approved_content_hash || this._computeTouchContentHash(touch.planned_channel, touch.touch_number, touch.purpose, subject, body, recipientContact);
          const snapId = `snap_${id}_t${touch.id}_v${targetVersion}`;


          this.sqlite.prepare(`
            INSERT OR REPLACE INTO campaign_approved_snapshots (
              id, campaign_id, tenant_id, campaign_touch_id, lead_id, touch_number,
              channel, purpose, recipient_contact, message_body, message_subject,
              content_hash, review_hash, campaign_version, approved_by, approved_at, created_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?
            )
          `).run(
            snapId, id, tid, touch.id, touch.lead_id, touch.touch_number,
            touch.planned_channel, touch.purpose, recipientContact,
            body, subject,
            contentHash, updates.review_hash, targetVersion, approver, approvedAt, approvedAt
          );

          this.sqlite.prepare(`
            UPDATE campaign_touches
            SET approved_body = COALESCE(approved_body, ?),
                approved_subject = COALESCE(approved_subject, ?),
                approved_content_hash = COALESCE(approved_content_hash, ?),
                approved_review_hash = COALESCE(approved_review_hash, ?),
                approved_version = COALESCE(approved_version, ?),
                approved_at = COALESCE(approved_at, ?),
                approved_by = COALESCE(approved_by, ?),
                approved_snapshot_id = COALESCE(approved_snapshot_id, ?)
            WHERE id = ? AND tenant_id = ?
          `).run(
            body, subject, contentHash, updates.review_hash, targetVersion, approvedAt, approver, snapId,
            touch.id, tid
          );
        }
      }
    }

    return this.getCampaignById(id, tid);
  }

  deleteCampaign(id, tenantId = 'default') {
    const current = this.getCampaignById(id, tenantId);
    if (!current) return false;

    // Safety: Only DRAFT, REJECTED, or CANCELLED campaigns can be deleted
    const deletableStatuses = ['DRAFT', 'REJECTED', 'CANCELLED'];
    if (!deletableStatuses.includes(current.status)) {
      throw new Error(`Cannot delete campaign with status "${current.status}". Only DRAFT, REJECTED, or CANCELLED campaigns can be deleted.`);
    }

    const res = this.sqlite.prepare('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?').run(id, (tenantId || 'default').trim());
    return res.changes > 0;
  }

  _recomputeCampaignCounts(campaignId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const stats = this.sqlite.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN eligibility_status = 'ELIGIBLE' AND review_status = 'INCLUDED' THEN 1 ELSE 0 END) as eligible
      FROM campaign_leads
      WHERE campaign_id = ? AND tenant_id = ?
    `).get(campaignId, tid);

    const total = stats?.total || 0;
    const eligible = stats?.eligible || 0;

    this.sqlite.prepare(`
      UPDATE campaigns
      SET total_leads = ?, eligible_leads = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(total, eligible, new Date().toISOString(), campaignId, tid);

    return { total, eligible };
  }

  createCampaignLead(campaignLeadData = {}, tenantId = 'default') {
    const {
      campaign_id,
      lead_id,
      eligibility_status,
      planned_channel = null,
      target_contact_handle = null,
      sequence_step = 1,
      review_status = 'INCLUDED',
      exclusion_reason = null,
      eligibility_details = null
    } = campaignLeadData;

    const tid = (campaignLeadData.tenant_id || tenantId || 'default').trim();

    if (!campaign_id) throw new Error('campaign_id is required');
    if (!lead_id) throw new Error('lead_id is required');

    // 1. Verify Campaign exists and belongs to tenant
    const campaign = this.getCampaignById(campaign_id, tid);
    if (!campaign) {
      throw new Error(`Campaign "${campaign_id}" not found for tenant "${tid}"`);
    }

    // 2. Validate Lead Ownership & Tenant Isolation
    const ownership = this.validateLeadOwnership(lead_id, tid);
    if (!ownership.valid) {
      throw new Error(ownership.reason || `Cross-tenant violation: lead "${lead_id}" does not belong to tenant "${tid}"`);
    }

    // 3. Validate Enums
    const ALLOWED_ELIGIBILITY = ['ELIGIBLE', 'INELIGIBLE', 'RESEARCH_REQUIRED', 'HUMAN_REVIEW_REQUIRED'];
    if (!eligibility_status || !ALLOWED_ELIGIBILITY.includes(eligibility_status)) {
      throw new Error(`Invalid eligibility_status "${eligibility_status}". Allowed: ${ALLOWED_ELIGIBILITY.join(', ')}`);
    }

    const ALLOWED_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH'];
    if (planned_channel && !ALLOWED_CHANNELS.includes(planned_channel)) {
      throw new Error(`Invalid planned_channel "${planned_channel}". Allowed: ${ALLOWED_CHANNELS.join(', ')}`);
    }

    const ALLOWED_REVIEWS = ['INCLUDED', 'EXCLUDED_BY_USER'];
    if (review_status && !ALLOWED_REVIEWS.includes(review_status)) {
      throw new Error(`Invalid review_status "${review_status}". Allowed: ${ALLOWED_REVIEWS.join(', ')}`);
    }

    if (sequence_step < 1) {
      throw new Error('sequence_step must be >= 1');
    }

    const detailsStr = eligibility_details ? this._validateJson(eligibility_details, 'eligibility_details') : null;
    const id = campaignLeadData.id || `cpl_${campaign_id}_${lead_id}`;
    const now = new Date().toISOString();

    this.sqlite.prepare(`
      INSERT INTO campaign_leads (
        id, campaign_id, lead_id, tenant_id, eligibility_status, planned_channel,
        target_contact_handle, sequence_step, review_status, exclusion_reason,
        eligibility_details, created_at, updated_at
      ) VALUES (
        @id, @campaign_id, @lead_id, @tenant_id, @eligibility_status, @planned_channel,
        @target_contact_handle, @sequence_step, @review_status, @exclusion_reason,
        @eligibility_details, @created_at, @updated_at
      )
    `).run({
      id,
      campaign_id,
      lead_id,
      tenant_id: tid,
      eligibility_status,
      planned_channel: planned_channel || null,
      target_contact_handle: target_contact_handle || null,
      sequence_step,
      review_status,
      exclusion_reason: exclusion_reason || null,
      eligibility_details: detailsStr,
      created_at: now,
      updated_at: now
    });

    this._recomputeCampaignCounts(campaign_id, tid);
    return this.getCampaignLead(campaign_id, lead_id, tid);
  }

  getCampaignLead(campaignId, leadId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare(`
      SELECT * FROM campaign_leads
      WHERE campaign_id = ? AND lead_id = ? AND tenant_id = ?
    `).get(campaignId, leadId, tid);
    return this._formatCampaignLeadRecord(row);
  }

  listCampaignLeads(campaignId, tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { eligibility_status = null, review_status = null, planned_channel = null, limit = 100, offset = 0 } = options;

    let sql = 'SELECT * FROM campaign_leads WHERE campaign_id = ? AND tenant_id = ?';
    const params = [campaignId, tid];

    if (eligibility_status) {
      sql += ' AND eligibility_status = ?';
      params.push(eligibility_status);
    }
    if (review_status) {
      sql += ' AND review_status = ?';
      params.push(review_status);
    }
    if (planned_channel) {
      sql += ' AND planned_channel = ?';
      params.push(planned_channel);
    }

    sql += ' ORDER BY sequence_step ASC, created_at ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 100, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatCampaignLeadRecord(r));
  }

  updateCampaignLead(campaignId, leadId, updates = {}, tenantId = 'default') {
    const current = this.getCampaignLead(campaignId, leadId, tenantId);
    if (!current) {
      throw new Error(`Campaign lead "${leadId}" in campaign "${campaignId}" not found for tenant "${tenantId}"`);
    }

    const tid = (tenantId || 'default').trim();
    const sets = [];
    const params = { campaign_id: campaignId, lead_id: leadId, tenant_id: tid };

    if (updates.eligibility_status !== undefined) {
      const ALLOWED_ELIGIBILITY = ['ELIGIBLE', 'INELIGIBLE', 'RESEARCH_REQUIRED', 'HUMAN_REVIEW_REQUIRED'];
      if (!ALLOWED_ELIGIBILITY.includes(updates.eligibility_status)) {
        throw new Error(`Invalid eligibility_status "${updates.eligibility_status}"`);
      }
      sets.push('eligibility_status = @eligibility_status');
      params.eligibility_status = updates.eligibility_status;
    }

    if (updates.planned_channel !== undefined) {
      const ALLOWED_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH'];
      if (updates.planned_channel !== null && !ALLOWED_CHANNELS.includes(updates.planned_channel)) {
        throw new Error(`Invalid planned_channel "${updates.planned_channel}"`);
      }
      sets.push('planned_channel = @planned_channel');
      params.planned_channel = updates.planned_channel;
    }

    if (updates.target_contact_handle !== undefined) {
      sets.push('target_contact_handle = @target_contact_handle');
      params.target_contact_handle = updates.target_contact_handle;
    }

    if (updates.sequence_step !== undefined) {
      if (updates.sequence_step < 1) throw new Error('sequence_step must be >= 1');
      sets.push('sequence_step = @sequence_step');
      params.sequence_step = updates.sequence_step;
    }

    if (updates.review_status !== undefined) {
      const ALLOWED_REVIEWS = ['INCLUDED', 'EXCLUDED_BY_USER'];
      if (!ALLOWED_REVIEWS.includes(updates.review_status)) {
        throw new Error(`Invalid review_status "${updates.review_status}"`);
      }
      sets.push('review_status = @review_status');
      params.review_status = updates.review_status;
    }

    if (updates.exclusion_reason !== undefined) {
      sets.push('exclusion_reason = @exclusion_reason');
      params.exclusion_reason = updates.exclusion_reason;
    }

    if (updates.eligibility_details !== undefined) {
      sets.push('eligibility_details = @eligibility_details');
      params.eligibility_details = updates.eligibility_details ? this._validateJson(updates.eligibility_details, 'eligibility_details') : null;
    }

    if (sets.length === 0) return current;

    sets.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();

    this.sqlite.prepare(`
      UPDATE campaign_leads
      SET ${sets.join(', ')}
      WHERE campaign_id = @campaign_id AND lead_id = @lead_id AND tenant_id = @tenant_id
    `).run(params);

    this._recomputeCampaignCounts(campaignId, tid);
    return this.getCampaignLead(campaignId, leadId, tid);
  }

  removeCampaignLead(campaignId, leadId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const res = this.sqlite.prepare(`
      DELETE FROM campaign_leads
      WHERE campaign_id = ? AND lead_id = ? AND tenant_id = ?
    `).run(campaignId, leadId, tid);

    if (res.changes > 0) {
      this._recomputeCampaignCounts(campaignId, tid);
      return true;
    }
    return false;
  }

  // ============================================================================
  // PHASE 2 STEP 6D: CAMPAIGN TOUCHES MODEL HELPERS
  // ============================================================================

  _formatCampaignTouchRecord(row) {
    if (!row) return null;
    return {
      ...row
    };
  }

  createCampaignTouch(touchData = {}, tenantId = 'default') {
    const {
      campaign_id,
      campaign_lead_id,
      lead_id,
      touch_number,
      planned_channel,
      planned_at,
      purpose,
      status = 'PLANNED',
      stop_reason = null,
      fallback_from = null,
      message_body = null,
      message_subject = null,
      content_hash = null,
      approved_body = null,
      approved_subject = null,
      approved_content_hash = null,
      approved_review_hash = null,
      approved_version = null,
      approved_at = null,
      approved_by = null,
      approved_snapshot_id = null
    } = touchData;

    const tid = (touchData.tenant_id || tenantId || 'default').trim();

    if (!campaign_id) throw new Error('campaign_id is required');
    if (!campaign_lead_id) throw new Error('campaign_lead_id is required');
    if (!lead_id) throw new Error('lead_id is required');
    if (touch_number === undefined || touch_number < 1 || touch_number > 3) {
      throw new Error('touch_number must be between 1 and 3');
    }

    const ALLOWED_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH', 'TELEGRAM'];
    if (!planned_channel || !ALLOWED_CHANNELS.includes(planned_channel)) {
      throw new Error(`Invalid planned_channel "${planned_channel}". Allowed: ${ALLOWED_CHANNELS.join(', ')}`);
    }

    if (!planned_at || isNaN(Date.parse(planned_at))) {
      throw new Error(`Invalid planned_at timestamp "${planned_at}"`);
    }

    const ALLOWED_PURPOSES = ['INITIAL_OUTREACH', 'VALUE_ADD_FOLLOWUP', 'POLITE_CLOSE'];
    if (!purpose || !ALLOWED_PURPOSES.includes(purpose)) {
      throw new Error(`Invalid purpose "${purpose}". Allowed: ${ALLOWED_PURPOSES.join(', ')}`);
    }

    const ALLOWED_STATUSES = ['PLANNED', 'BLOCKED', 'STOPPED', 'CANCELLED'];
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      throw new Error(`Invalid status "${status}". Allowed: ${ALLOWED_STATUSES.join(', ')}`);
    }

    const id = touchData.id || `tch_${campaign_lead_id}_t${touch_number}`;
    const now = new Date().toISOString();

    this.sqlite.prepare(`
      INSERT INTO campaign_touches (
        id, campaign_id, campaign_lead_id, lead_id, tenant_id, touch_number,
        planned_channel, planned_at, purpose, status, stop_reason, fallback_from,
        message_body, message_subject, content_hash,
        approved_body, approved_subject, approved_content_hash, approved_review_hash,
        approved_version, approved_at, approved_by, approved_snapshot_id,
        created_at, updated_at
      ) VALUES (
        @id, @campaign_id, @campaign_lead_id, @lead_id, @tenant_id, @touch_number,
        @planned_channel, @planned_at, @purpose, @status, @stop_reason, @fallback_from,
        @message_body, @message_subject, @content_hash,
        @approved_body, @approved_subject, @approved_content_hash, @approved_review_hash,
        @approved_version, @approved_at, @approved_by, @approved_snapshot_id,
        @created_at, @updated_at
      )
      ON CONFLICT(campaign_lead_id, touch_number) DO UPDATE SET
        planned_channel = excluded.planned_channel,
        planned_at = excluded.planned_at,
        purpose = excluded.purpose,
        status = excluded.status,
        stop_reason = excluded.stop_reason,
        fallback_from = excluded.fallback_from,
        message_body = COALESCE(excluded.message_body, campaign_touches.message_body),
        message_subject = COALESCE(excluded.message_subject, campaign_touches.message_subject),
        content_hash = COALESCE(excluded.content_hash, campaign_touches.content_hash),
        approved_body = COALESCE(excluded.approved_body, campaign_touches.approved_body),
        approved_subject = COALESCE(excluded.approved_subject, campaign_touches.approved_subject),
        approved_content_hash = COALESCE(excluded.approved_content_hash, campaign_touches.approved_content_hash),
        approved_review_hash = COALESCE(excluded.approved_review_hash, campaign_touches.approved_review_hash),
        approved_version = COALESCE(excluded.approved_version, campaign_touches.approved_version),
        approved_at = COALESCE(excluded.approved_at, campaign_touches.approved_at),
        approved_by = COALESCE(excluded.approved_by, campaign_touches.approved_by),
        approved_snapshot_id = COALESCE(excluded.approved_snapshot_id, campaign_touches.approved_snapshot_id),
        updated_at = excluded.updated_at
    `).run({
      id,
      campaign_id,
      campaign_lead_id,
      lead_id,
      tenant_id: tid,
      touch_number,
      planned_channel,
      planned_at,
      purpose,
      status,
      stop_reason: stop_reason || null,
      fallback_from: fallback_from || null,
      message_body: message_body || null,
      message_subject: message_subject || null,
      content_hash: content_hash || null,
      approved_body: approved_body || null,
      approved_subject: approved_subject || null,
      approved_content_hash: approved_content_hash || null,
      approved_review_hash: approved_review_hash || null,
      approved_version: approved_version || null,
      approved_at: approved_at || null,
      approved_by: approved_by || null,
      approved_snapshot_id: approved_snapshot_id || null,
      created_at: now,
      updated_at: now
    });

    return this.getCampaignTouch(id, tid);
  }

  getCampaignTouch(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare(`
      SELECT * FROM campaign_touches
      WHERE id = ? AND tenant_id = ?
    `).get(id, tid);
    return this._formatCampaignTouchRecord(row);
  }

  getCampaignTouchByLeadAndNumber(campaignLeadId, touchNumber, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare(`
      SELECT * FROM campaign_touches
      WHERE campaign_lead_id = ? AND touch_number = ? AND tenant_id = ?
    `).get(campaignLeadId, touchNumber, tid);
    return this._formatCampaignTouchRecord(row);
  }

  listCampaignTouches(campaignId, tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { campaign_lead_id = null, lead_id = null, status = null, touch_number = null, limit = 500, offset = 0 } = options;

    let sql = 'SELECT * FROM campaign_touches WHERE campaign_id = ? AND tenant_id = ?';
    const params = [campaignId, tid];

    if (campaign_lead_id) {
      sql += ' AND campaign_lead_id = ?';
      params.push(campaign_lead_id);
    }
    if (lead_id) {
      sql += ' AND lead_id = ?';
      params.push(lead_id);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (touch_number) {
      sql += ' AND touch_number = ?';
      params.push(touch_number);
    }

    sql += ' ORDER BY touch_number ASC, planned_at ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 500, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatCampaignTouchRecord(r));
  }

  getCampaignTouches(campaignId, tenantId = 'default', options = {}) {
    return this.listCampaignTouches(campaignId, tenantId, options);
  }

  updateCampaignTouch(id, updates = {}, tenantId = 'default') {
    const current = this.getCampaignTouch(id, tenantId);
    if (!current) {
      throw new Error(`Campaign touch "${id}" not found for tenant "${tenantId}"`);
    }

    const tid = (tenantId || 'default').trim();
    const sets = [];
    const params = { id, tenant_id: tid };

    if (updates.status !== undefined) {
      const ALLOWED_STATUSES = ['PLANNED', 'DISPATCHING', 'SENT', 'FAILED', 'BLOCKED', 'STOPPED', 'CANCELLED'];
      if (!ALLOWED_STATUSES.includes(updates.status)) {
        throw new Error(`Invalid status "${updates.status}"`);
      }
      sets.push('status = @status');
      params.status = updates.status;
    }

    if (updates.stop_reason !== undefined) {
      sets.push('stop_reason = @stop_reason');
      params.stop_reason = updates.stop_reason;
    }

    if (updates.planned_channel !== undefined) {
      const ALLOWED_CHANNELS = ['WHATSAPP', 'EMAIL', 'PHONE', 'WEB_FORM', 'MANUAL_RESEARCH', 'TELEGRAM'];
      if (!ALLOWED_CHANNELS.includes(updates.planned_channel)) {
        throw new Error(`Invalid planned_channel "${updates.planned_channel}"`);
      }
      sets.push('planned_channel = @planned_channel');
      params.planned_channel = updates.planned_channel;
    }

    if (updates.planned_at !== undefined) {
      if (!updates.planned_at || isNaN(Date.parse(updates.planned_at))) {
        throw new Error(`Invalid planned_at "${updates.planned_at}"`);
      }
      sets.push('planned_at = @planned_at');
      params.planned_at = updates.planned_at;
    }

    if (updates.purpose !== undefined) {
      const ALLOWED_PURPOSES = ['INITIAL_OUTREACH', 'VALUE_ADD_FOLLOWUP', 'POLITE_CLOSE'];
      if (!ALLOWED_PURPOSES.includes(updates.purpose)) {
        throw new Error(`Invalid purpose "${updates.purpose}"`);
      }
      sets.push('purpose = @purpose');
      params.purpose = updates.purpose;
    }

    if (updates.fallback_from !== undefined) {
      sets.push('fallback_from = @fallback_from');
      params.fallback_from = updates.fallback_from;
    }

    if (updates.execution_status !== undefined) {
      sets.push('execution_status = @execution_status');
      params.execution_status = updates.execution_status;
    }

    if (updates.dispatched_at !== undefined) {
      sets.push('dispatched_at = @dispatched_at');
      params.dispatched_at = updates.dispatched_at;
    }

    if (updates.provider_message_id !== undefined) {
      sets.push('provider_message_id = @provider_message_id');
      params.provider_message_id = updates.provider_message_id;
    }

    if (updates.execution_lock !== undefined) {
      sets.push('execution_lock = @execution_lock');
      params.execution_lock = updates.execution_lock;
    }

    if (updates.execution_error !== undefined) {
      sets.push('execution_error = @execution_error');
      params.execution_error = updates.execution_error;
    }

    if (updates.execution_metadata !== undefined) {
      sets.push('execution_metadata = @execution_metadata');
      params.execution_metadata = typeof updates.execution_metadata === 'object' && updates.execution_metadata !== null
        ? JSON.stringify(updates.execution_metadata)
        : updates.execution_metadata;
    }

    if (updates.message_body !== undefined) {
      sets.push('message_body = @message_body');
      params.message_body = updates.message_body;
    }

    if (updates.message_subject !== undefined) {
      sets.push('message_subject = @message_subject');
      params.message_subject = updates.message_subject;
    }

    if (updates.content_hash !== undefined) {
      sets.push('content_hash = @content_hash');
      params.content_hash = updates.content_hash;
    }

    if (updates.approved_body !== undefined) {
      sets.push('approved_body = @approved_body');
      params.approved_body = updates.approved_body;
    }

    if (updates.approved_subject !== undefined) {
      sets.push('approved_subject = @approved_subject');
      params.approved_subject = updates.approved_subject;
    }

    if (updates.approved_content_hash !== undefined) {
      sets.push('approved_content_hash = @approved_content_hash');
      params.approved_content_hash = updates.approved_content_hash;
    }

    if (updates.approved_review_hash !== undefined) {
      sets.push('approved_review_hash = @approved_review_hash');
      params.approved_review_hash = updates.approved_review_hash;
    }

    if (updates.approved_version !== undefined) {
      sets.push('approved_version = @approved_version');
      params.approved_version = updates.approved_version;
    }

    if (updates.approved_at !== undefined) {
      sets.push('approved_at = @approved_at');
      params.approved_at = updates.approved_at;
    }

    if (updates.approved_by !== undefined) {
      sets.push('approved_by = @approved_by');
      params.approved_by = updates.approved_by;
    }

    if (updates.approved_snapshot_id !== undefined) {
      sets.push('approved_snapshot_id = @approved_snapshot_id');
      params.approved_snapshot_id = updates.approved_snapshot_id;
    }

    if (sets.length === 0) return current;

    sets.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();

    this.sqlite.prepare(`
      UPDATE campaign_touches
      SET ${sets.join(', ')}
      WHERE id = @id AND tenant_id = @tenant_id
    `).run(params);

    return this.getCampaignTouch(id, tid);
  }

  deleteCampaignTouches(campaignId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const res = this.sqlite.prepare(`
      DELETE FROM campaign_touches
      WHERE campaign_id = ? AND tenant_id = ?
    `).run(campaignId, tid);
    return res.changes;
  }

  setTouchContentResolver(fn) {
    this._touchContentResolver = typeof fn === 'function' ? fn : null;
  }

  // ============================================================================
  // PHASE 2 STEP 7E-2: PERSISTENT APPROVED-DRAFT ARCHITECTURE HELPERS
  // ============================================================================

  _computeTouchContentHash(channel, touchNumber, purpose, subject, body, recipientContact) {
    const canonBody = (body === null || body === undefined) ? '' : String(body).normalize('NFC').replace(/\r\n|\r/g, '\n').trim();
    const canonSubject = (subject === null || subject === undefined) ? '' : String(subject).normalize('NFC').replace(/\r\n|\r/g, '\n').trim();
    const canonRecipient = (recipientContact === null || recipientContact === undefined) ? '' : String(recipientContact).normalize('NFC').replace(/\r\n|\r/g, '\n').trim();
    const payload = `${String(channel || '').toUpperCase()}|${touchNumber || 1}|${String(purpose || '').toUpperCase()}|${canonSubject}|${canonBody}|${canonRecipient}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  createApprovedSnapshot(snapshotData = {}, tenantId = 'default') {
    const {
      id = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      campaign_id,
      campaign_touch_id,
      lead_id,
      touch_number,
      channel,
      purpose,
      recipient_contact = null,
      message_body,
      message_subject = null,
      content_hash,
      review_hash,
      campaign_version = 1,
      approved_by,
      approved_at = new Date().toISOString()
    } = snapshotData;

    const tid = (snapshotData.tenant_id || tenantId || 'default').trim();
    if (!campaign_id) throw new Error('campaign_id is required');
    if (!campaign_touch_id) throw new Error('campaign_touch_id is required');
    if (!lead_id) throw new Error('lead_id is required');
    if (touch_number === undefined) throw new Error('touch_number is required');
    if (!channel) throw new Error('channel is required');
    if (!purpose) throw new Error('purpose is required');
    if (!message_body) throw new Error('message_body is required');
    if (!content_hash) throw new Error('content_hash is required');
    if (!review_hash) throw new Error('review_hash is required');
    if (!approved_by) throw new Error('approved_by is required');

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO campaign_approved_snapshots (
        id, campaign_id, tenant_id, campaign_touch_id, lead_id, touch_number,
        channel, purpose, recipient_contact, message_body, message_subject,
        content_hash, review_hash, campaign_version, approved_by, approved_at, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `).run(
      id, campaign_id, tid, campaign_touch_id, lead_id, touch_number,
      channel, purpose, recipient_contact, message_body, message_subject,
      content_hash, review_hash, campaign_version, approved_by, approved_at, now
    );

    return this.getApprovedSnapshot(id, tid);
  }

  getApprovedSnapshot(snapshotId, tenantId = 'default') {
    if (!snapshotId) return null;
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_approved_snapshots
      WHERE id = ? AND tenant_id = ?
    `).get(snapshotId, tid) || null;
  }

  getApprovedSnapshotByTouch(touchId, version = null, tenantId = 'default') {
    if (!touchId) return null;
    const tid = (tenantId || 'default').trim();
    if (version !== null && version !== undefined) {
      return this.sqlite.prepare(`
        SELECT * FROM campaign_approved_snapshots
        WHERE campaign_touch_id = ? AND campaign_version = ? AND tenant_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(touchId, version, tid) || null;
    }
    return this.sqlite.prepare(`
      SELECT * FROM campaign_approved_snapshots
      WHERE campaign_touch_id = ? AND tenant_id = ?
      ORDER BY campaign_version DESC, created_at DESC LIMIT 1
    `).get(touchId, tid) || null;
  }

  listApprovedSnapshots(campaignId, tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { campaign_touch_id = null, lead_id = null, version = null, limit = 500, offset = 0 } = options;
    let sql = 'SELECT * FROM campaign_approved_snapshots WHERE campaign_id = ? AND tenant_id = ?';
    const params = [campaignId, tid];
    if (campaign_touch_id) {
      sql += ' AND campaign_touch_id = ?';
      params.push(campaign_touch_id);
    }
    if (lead_id) {
      sql += ' AND lead_id = ?';
      params.push(lead_id);
    }
    if (version !== null && version !== undefined) {
      sql += ' AND campaign_version = ?';
      params.push(version);
    }
    sql += ' ORDER BY touch_number ASC, created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 500, parseInt(offset, 10) || 0);
    return this.sqlite.prepare(sql).all(...params);
  }

  approveCampaignWithSnapshots(campaignId, campaignUpdates, snapshots = [], tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const tx = this.sqlite.transaction(() => {
      // 1. Insert snapshots and update touches
      const insertSnapshotStmt = this.sqlite.prepare(`
        INSERT OR REPLACE INTO campaign_approved_snapshots (
          id, campaign_id, tenant_id, campaign_touch_id, lead_id, touch_number,
          channel, purpose, recipient_contact, message_body, message_subject,
          content_hash, review_hash, campaign_version, approved_by, approved_at, created_at,
          claims_root_hash
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?
        )
      `);

      const updateTouchStmt = this.sqlite.prepare(`
        UPDATE campaign_touches
        SET message_body = @message_body,
            message_subject = @message_subject,
            content_hash = @content_hash,
            approved_body = @approved_body,
            approved_subject = @approved_subject,
            approved_content_hash = @approved_content_hash,
            approved_review_hash = @approved_review_hash,
            approved_version = @approved_version,
            approved_at = @approved_at,
            approved_by = @approved_by,
            approved_snapshot_id = @approved_snapshot_id,
            updated_at = @updated_at
        WHERE id = @id AND tenant_id = @tenant_id
      `);

      const now = new Date().toISOString();
      for (const snap of snapshots) {
        insertSnapshotStmt.run(
          snap.id, snap.campaign_id, tid, snap.campaign_touch_id, snap.lead_id, snap.touch_number,
          snap.channel, snap.purpose, snap.recipient_contact || null, snap.message_body, snap.message_subject || null,
          snap.content_hash, snap.review_hash, snap.campaign_version, snap.approved_by, snap.approved_at || now, now,
          snap.claims_root_hash || null
        );

        updateTouchStmt.run({
          id: snap.campaign_touch_id,
          tenant_id: tid,
          message_body: snap.message_body,
          message_subject: snap.message_subject || null,
          content_hash: snap.content_hash,
          approved_body: snap.message_body,
          approved_subject: snap.message_subject || null,
          approved_content_hash: snap.content_hash,
          approved_review_hash: snap.review_hash,
          approved_version: snap.campaign_version,
          approved_at: snap.approved_at || now,
          approved_by: snap.approved_by,
          approved_snapshot_id: snap.id,
          updated_at: now
        });
      }

      // 2. Update campaign
      const updatedCampaign = this.updateCampaign(campaignId, campaignUpdates, tid);
      return updatedCampaign;
    });

    return tx();
  }

  invalidateCampaignApproval(campaignId, reason = 'Approval invalidated', reviewer = 'system', tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const campaign = this.getCampaignById(campaignId, tid);
    if (!campaign) {
      throw new Error(`Campaign "${campaignId}" not found for tenant "${tid}"`);
    }

    const now = new Date().toISOString();
    const newVersion = (campaign.campaign_version || 1) + 1;

    const updatedCampaign = this.updateCampaign(campaignId, {
      status: 'DRAFT',
      review_status: 'PENDING',
      review_notes: reason,
      review_hash: null,
      approved_version: null,
      campaign_version: newVersion
    }, tid);

    this.createCampaignReviewLog({
      campaign_id: campaignId,
      tenant_id: tid,
      action: 'INVALIDATED_DUE_TO_MATERIAL_CHANGE',
      previous_status: campaign.status,
      new_status: 'DRAFT',
      reviewer,
      review_hash: campaign.review_hash,
      campaign_version: newVersion,
      notes: reason,
      metadata: { invalidated_at: now }
    }, tid);

    return updatedCampaign;
  }

  // ============================================================================
  // PHASE 2 STEP 7G-1: FACT-CLAIM GRAPH DATABASE METHODS
  // ============================================================================

  /**
   * Create a single campaign claim record
   * @param {object} claimData
   * @param {string} tenantId
   * @returns {object} created claim
   */
  createCampaignClaim(claimData = {}, tenantId = 'default') {
    const tid = (claimData.tenant_id || tenantId || 'default').trim();
    const {
      id = `clm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      lead_id,
      campaign_id = null,
      campaign_touch_id = null,
      claim_text,
      normalized_claim_hash,
      claim_type,
      provenance_level = 'UNKNOWN',
      validation_status = 'UNSUPPORTED',
      confidence_score = 0.0,
      evidence_count = 0,
      is_approved = 0,
      approval_snapshot_id = null,
      generator_type = 'DETERMINISTIC_TEMPLATE',
      model_name = null,
      model_version = null,
      prompt_template_version = null,
      generated_at = new Date().toISOString()
    } = claimData;

    if (!lead_id) throw new Error('lead_id is required for campaign_claims');
    if (!claim_text) throw new Error('claim_text is required for campaign_claims');
    if (!normalized_claim_hash) throw new Error('normalized_claim_hash is required for campaign_claims');
    if (!claim_type) throw new Error('claim_type is required for campaign_claims');

    const ownership = this.validateLeadOwnership(lead_id, tid);
    if (!ownership || !ownership.valid) {
      throw new Error(`LEAD_TENANT_MISMATCH: Lead "${lead_id}" does not belong to tenant "${tid}"`);
    }

    const conf = Number(confidence_score);
    if (isNaN(conf) || conf < 0.0 || conf > 1.0) {
      throw new Error(`INVALID_CONFIDENCE_SCORE: ${confidence_score}. Must be between 0.0 and 1.0`);
    }

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO campaign_claims (
        id, tenant_id, lead_id, campaign_id, campaign_touch_id,
        claim_text, normalized_claim_hash, claim_type, provenance_level,
        validation_status, confidence_score, evidence_count, is_approved,
        approval_snapshot_id, generator_type, model_name, model_version,
        prompt_template_version, generated_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      id, tid, lead_id, campaign_id, campaign_touch_id,
      claim_text, normalized_claim_hash, claim_type, provenance_level,
      validation_status, conf, evidence_count, is_approved ? 1 : 0,
      approval_snapshot_id, generator_type, model_name, model_version,
      prompt_template_version, generated_at, now, now
    );

    return this.getCampaignClaim(id, tid);
  }

  /**
   * Atomically create a claim and its evidence relationships
   * Enforces cross-tenant and cross-lead rejection in a single transaction.
   * @param {object} claimData
   * @param {Array<string>} evidenceIds
   * @param {string} tenantId
   * @returns {object} { claim, evidenceCount, evidenceIds }
   */
  createCampaignClaimWithEvidence(claimData = {}, evidenceIds = [], tenantId = 'default') {
    const tid = (claimData.tenant_id || tenantId || 'default').trim();
    const leadId = claimData.lead_id;
    if (!leadId) throw new Error('lead_id is required');

    const ownership = this.validateLeadOwnership(leadId, tid);
    if (!ownership || !ownership.valid) {
      throw new Error(`LEAD_TENANT_MISMATCH: Lead "${leadId}" does not belong to tenant "${tid}"`);
    }

    const now = new Date().toISOString();
    const evIds = Array.isArray(evidenceIds) ? evidenceIds : [];

    const tx = this.sqlite.transaction(() => {
      // 1. Verify all evidence records belong strictly to the SAME tenant and SAME lead
      const validatedEvidence = [];
      const evCheckStmt = this.sqlite.prepare(`
        SELECT id, lead_id, tenant_id, confidence_score, provenance_type, expires_at
        FROM lead_evidence
        WHERE id = ? AND tenant_id = ?
      `);

      for (const evId of evIds) {
        const ev = evCheckStmt.get(evId, tid);
        if (!ev) {
          throw new Error(`EVIDENCE_TENANT_OR_NOT_FOUND: Evidence "${evId}" not found for tenant "${tid}"`);
        }
        if (ev.lead_id !== leadId) {
          throw new Error(`EVIDENCE_CROSS_LEAD_VIOLATION: Evidence "${evId}" belongs to lead "${ev.lead_id}", not target lead "${leadId}"`);
        }
        validatedEvidence.push(ev);
      }

      // 2. Insert claim record
      const claimWithCount = {
        ...claimData,
        tenant_id: tid,
        evidence_count: validatedEvidence.length
      };
      const createdClaim = this.createCampaignClaim(claimWithCount, tid);

      // 3. Insert junction rows
      const insertJunctionStmt = this.sqlite.prepare(`
        INSERT OR IGNORE INTO campaign_claim_evidence (
          claim_id, evidence_id, tenant_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);

      for (const ev of validatedEvidence) {
        insertJunctionStmt.run(createdClaim.id, ev.id, tid, now);
      }

      return {
        claim: createdClaim,
        evidenceCount: validatedEvidence.length,
        evidenceIds: validatedEvidence.map(e => e.id)
      };
    });

    return tx();
  }

  /**
   * Retrieve a campaign claim by ID with tenant isolation
   */
  getCampaignClaim(claimId, tenantId = 'default') {
    if (!claimId) return null;
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_claims
      WHERE id = ? AND tenant_id = ?
    `).get(claimId, tid) || null;
  }

  /**
   * List campaign claims with filtering
   */
  listCampaignClaims(filters = {}, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const {
      lead_id = null,
      campaign_id = null,
      campaign_touch_id = null,
      validation_status = null,
      claim_type = null,
      limit = 500,
      offset = 0
    } = filters;

    let sql = 'SELECT * FROM campaign_claims WHERE tenant_id = ?';
    const params = [tid];

    if (lead_id) {
      sql += ' AND lead_id = ?';
      params.push(lead_id);
    }
    if (campaign_id) {
      sql += ' AND campaign_id = ?';
      params.push(campaign_id);
    }
    if (campaign_touch_id) {
      sql += ' AND campaign_touch_id = ?';
      params.push(campaign_touch_id);
    }
    if (validation_status) {
      sql += ' AND validation_status = ?';
      params.push(validation_status);
    }
    if (claim_type) {
      sql += ' AND claim_type = ?';
      params.push(claim_type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 500, parseInt(offset, 10) || 0);

    return this.sqlite.prepare(sql).all(...params);
  }

  /**
   * Retrieve all supporting evidence records for a claim
   */
  getClaimEvidence(claimId, tenantId = 'default') {
    if (!claimId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT e.*
      FROM lead_evidence e
      JOIN campaign_claim_evidence cce ON e.id = cce.evidence_id
      WHERE cce.claim_id = ? AND cce.tenant_id = ?
      ORDER BY e.created_at DESC
    `).all(claimId, tid);
  }

  /**
   * Retrieve claims for a specific touch
   */
  getClaimsForTouch(campaignTouchId, tenantId = 'default') {
    if (!campaignTouchId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_claims
      WHERE campaign_touch_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `).all(campaignTouchId, tid);
  }

  /**
   * Retrieve claims for a campaign
   */
  getClaimsForCampaign(campaignId, tenantId = 'default') {
    if (!campaignId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_claims
      WHERE campaign_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `).all(campaignId, tid);
  }

  /**
   * Retrieve claims for a lead
   */
  getClaimsForLead(leadId, tenantId = 'default') {
    if (!leadId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_claims
      WHERE lead_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `).all(leadId, tid);
  }

  // ============================================================================
  // PHASE 2 STEP 6F-B.1: ATOMIC TOUCH EXECUTION & LOCKING HELPERS
  // ============================================================================

  /**
   * Atomically claims a campaign touch for live execution.
   * Ensures idempotency and single-flight dispatch lock.
   * Returns true if lock was acquired, false if already locked/dispatched.
   */
  claimCampaignTouchForExecution(touchId, tenantId = 'default', lockId) {
    if (!touchId) throw new Error('touchId is required');
    if (!lockId) throw new Error('lockId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();

    const info = this.sqlite.prepare(`
      UPDATE campaign_touches
      SET execution_lock = ?,
          status = 'DISPATCHING',
          execution_status = 'DISPATCHING',
          execution_locked_at = ?,
          execution_attempt_count = COALESCE(execution_attempt_count, 0) + 1,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND (execution_lock IS NULL OR execution_lock = '')
        AND status = 'PLANNED'
        AND (execution_status IS NULL OR execution_status NOT IN ('SENT', 'DISPATCHING', 'PROVIDER_UNCERTAIN'))
    `).run(lockId, now, now, touchId, tid);

    return info.changes > 0;
  }

  /**
   * Atomically records successful live execution on a locked touch.
   * Sets status and execution_status to SENT, stores provider message ID and timestamp,
   * and clears the execution lock.
   */
  recordCampaignTouchExecutionSuccess(touchId, tenantId = 'default', lockId, details = {}) {
    if (!touchId) throw new Error('touchId is required');
    if (!lockId) throw new Error('lockId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();
    const metaStr = details.metadata ? JSON.stringify(details.metadata) : null;

    const info = this.sqlite.prepare(`
      UPDATE campaign_touches
      SET status = 'SENT',
          execution_status = 'SENT',
          provider_message_id = ?,
          dispatched_at = ?,
          execution_lock = NULL,
          execution_locked_at = NULL,
          last_attempt_id = ?,
          execution_metadata = ?,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND execution_lock = ?
    `).run(
      details.providerMessageId ? String(details.providerMessageId) : null,
      details.dispatchedAt || now,
      details.attemptId ? String(details.attemptId) : null,
      metaStr,
      now,
      touchId,
      tid,
      lockId
    );

    return info.changes > 0;
  }

  /**
   * Atomically records live execution failure on a locked touch.
   * Sets status and execution_status to FAILED, stores sanitized error,
   * and clears the execution lock. Does NOT automatically retry.
   */
  recordCampaignTouchExecutionFailure(touchId, tenantId = 'default', lockId, details = {}) {
    if (!touchId) throw new Error('touchId is required');
    if (!lockId) throw new Error('lockId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();
    const metaStr = details.metadata ? JSON.stringify(details.metadata) : null;
    const errorStr = String(details.error || 'Unknown execution failure');

    const info = this.sqlite.prepare(`
      UPDATE campaign_touches
      SET status = 'FAILED',
          execution_status = 'FAILED',
          execution_error = ?,
          execution_lock = NULL,
          execution_locked_at = NULL,
          last_attempt_id = ?,
          execution_metadata = ?,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND execution_lock = ?
    `).run(
      errorStr,
      details.attemptId ? String(details.attemptId) : null,
      metaStr,
      now,
      touchId,
      tid,
      lockId
    );

    return info.changes > 0;
  }

  /**
   * Atomically records live execution as PROVIDER_UNCERTAIN on a locked touch.
   * Sets execution_status to PROVIDER_UNCERTAIN, status to BLOCKED (preventing auto-reexecution),
   * stores error classification and clears execution_lock. Does NOT mark as FAILED or SENT.
   */
  recordCampaignTouchExecutionUncertain(touchId, tenantId = 'default', lockId, details = {}) {
    if (!touchId) throw new Error('touchId is required');
    if (!lockId) throw new Error('lockId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();
    const metaStr = details.metadata ? JSON.stringify(details.metadata) : null;
    const errorStr = String(details.error || 'Provider response uncertain / network partition');

    const info = this.sqlite.prepare(`
      UPDATE campaign_touches
      SET status = 'BLOCKED',
          execution_status = 'PROVIDER_UNCERTAIN',
          stop_reason = 'PROVIDER_UNCERTAIN',
          execution_error = ?,
          execution_lock = NULL,
          execution_locked_at = NULL,
          last_attempt_id = ?,
          execution_metadata = ?,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND execution_lock = ?
    `).run(
      errorStr,
      details.attemptId ? String(details.attemptId) : null,
      metaStr,
      now,
      touchId,
      tid,
      lockId
    );

    return info.changes > 0;
  }

  /**
   * Releases an execution lock without marking the touch as SENT, FAILED, or UNCERTAIN.
   * Reverts status to PLANNED and execution_status to NULL.
   * Used when pre-transport checks or gate block execution before any send attempt.
   */
  releaseCampaignTouchExecutionLock(touchId, tenantId = 'default', lockId) {
    if (!touchId) throw new Error('touchId is required');
    if (!lockId) throw new Error('lockId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();

    const info = this.sqlite.prepare(`
      UPDATE campaign_touches
      SET status = 'PLANNED',
          execution_status = NULL,
          execution_lock = NULL,
          execution_locked_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND tenant_id = ?
        AND execution_lock = ?
    `).run(now, touchId, tid, lockId);

    return info.changes > 0;
  }

  // ============================================================================
  // PHASE 2 STEP 6F-B.2A: EXECUTION ATTEMPTS (APPEND-ONLY MODEL)
  // ============================================================================

  recordExecutionAttemptStart(attemptData = {}) {
    const {
      id,
      tenant_id = 'default',
      campaign_id,
      campaign_lead_id,
      campaign_touch_id,
      lead_id,
      operator_id,
      operator_name,
      operator_role,
      channel,
      provider = null,
      attempt_number = 1,
      idempotency_key,
      started_at = new Date().toISOString()
    } = attemptData;

    if (!campaign_id) throw new Error('campaign_id is required');
    if (!campaign_touch_id) throw new Error('campaign_touch_id is required');
    if (!idempotency_key) throw new Error('idempotency_key is required');

    const tid = (tenant_id || 'default').trim();
    const attemptId = id || `att_${campaign_touch_id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    this.sqlite.prepare(`
      INSERT INTO campaign_execution_attempts (
        id, tenant_id, campaign_id, campaign_lead_id, campaign_touch_id, lead_id,
        operator_id, operator_name, operator_role, channel, provider,
        attempt_number, idempotency_key, started_at, result_status, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, 'STARTED', ?
      )
    `).run(
      attemptId, tid, campaign_id, campaign_lead_id, campaign_touch_id, lead_id,
      operator_id || 'operator', operator_name || 'Operator', operator_role || 'ADMIN',
      channel, provider, attempt_number, idempotency_key, started_at, now
    );

    return this.getExecutionAttempt(attemptId, tid);
  }

  finalizeExecutionAttempt(attemptId, tenantId = 'default', finalData = {}) {
    if (!attemptId) throw new Error('attemptId is required');
    const tid = (tenantId || 'default').trim();
    const now = new Date().toISOString();

    const {
      result_status,
      provider_message_id = null,
      provider_response = null,
      error_classification = null,
      error_message = null,
      finished_at = now
    } = finalData;

    if (!result_status) throw new Error('result_status is required for finalizing attempt');

    const respStr = provider_response ? (typeof provider_response === 'object' ? JSON.stringify(provider_response) : String(provider_response)) : null;

    const res = this.sqlite.prepare(`
      UPDATE campaign_execution_attempts
      SET result_status = ?,
          provider_message_id = ?,
          provider_response = ?,
          error_classification = ?,
          error_message = ?,
          finished_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(
      result_status,
      provider_message_id ? String(provider_message_id) : null,
      respStr,
      error_classification || null,
      error_message || null,
      finished_at,
      attemptId,
      tid
    );

    return res.changes > 0;
  }

  getExecutionAttempt(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM campaign_execution_attempts WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!row) return null;
    return {
      ...row,
      provider_response: this._safeParseJson(row.provider_response, null)
    };
  }

  listExecutionAttempts(touchId, tenantId = 'default') {
    if (!touchId) return [];
    const tid = (tenantId || 'default').trim();
    const rows = this.sqlite.prepare(`
      SELECT * FROM campaign_execution_attempts
      WHERE campaign_touch_id = ? AND tenant_id = ?
      ORDER BY attempt_number ASC, created_at ASC
    `).all(touchId, tid);

    return rows.map(r => ({
      ...r,
      provider_response: this._safeParseJson(r.provider_response, null)
    }));
  }

  getLatestExecutionAttempt(touchId, tenantId = 'default') {
    if (!touchId) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare(`
      SELECT * FROM campaign_execution_attempts
      WHERE campaign_touch_id = ? AND tenant_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(touchId, tid);
    if (!row) return null;
    return {
      ...row,
      provider_response: this._safeParseJson(row.provider_response, null)
    };
  }

  // ============================================================================
  // PHASE 2 STEP 6F-B.2B: MANUAL RECONCILIATION & GOVERNED RECOVERY HELPERS
  // ============================================================================

  createReconciliationRecord(recordData, tenantId = 'default') {
    const tid = (recordData.tenant_id || tenantId || 'default').trim();
    const id = recordData.id || `rec_${recordData.campaign_touch_id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = new Date().toISOString();

    const {
      campaign_id,
      campaign_touch_id,
      campaign_lead_id,
      attempt_id = null,
      operator_id = 'operator',
      operator_name = 'Operator',
      operator_role = 'ADMIN',
      decision,
      reason,
      notes,
      evidence_type = null,
      evidence_reference = null,
      previous_touch_status,
      new_touch_status,
      previous_execution_status,
      new_execution_status,
      approval_hash = null,
      campaign_version = null
    } = recordData;

    if (!campaign_id) throw new Error('campaign_id is required for reconciliation record');
    if (!campaign_touch_id) throw new Error('campaign_touch_id is required for reconciliation record');
    if (!campaign_lead_id) throw new Error('campaign_lead_id is required for reconciliation record');
    if (!decision) throw new Error('decision is required for reconciliation record');
    if (!reason) throw new Error('reason is required for reconciliation record');
    if (!notes) throw new Error('notes is required for reconciliation record');

    this.sqlite.prepare(`
      INSERT INTO campaign_reconciliation_records (
        id, tenant_id, campaign_id, campaign_touch_id, campaign_lead_id,
        attempt_id, operator_id, operator_name, operator_role,
        decision, reason, notes, evidence_type, evidence_reference,
        previous_touch_status, new_touch_status,
        previous_execution_status, new_execution_status,
        approval_hash, campaign_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tid, campaign_id, campaign_touch_id, campaign_lead_id,
      attempt_id, operator_id, operator_name, operator_role,
      decision, reason, notes, evidence_type, evidence_reference,
      previous_touch_status, new_touch_status,
      previous_execution_status, new_execution_status,
      approval_hash, campaign_version, now
    );

    return this.getReconciliationRecord(id, tid);
  }

  getReconciliationRecord(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_reconciliation_records
      WHERE id = ? AND tenant_id = ?
    `).get(id, tid);
  }

  listReconciliationRecords(touchId, tenantId = 'default') {
    if (!touchId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_reconciliation_records
      WHERE campaign_touch_id = ? AND tenant_id = ?
      ORDER BY created_at DESC
    `).all(touchId, tid);
  }

  listCampaignReconciliationRecords(campaignId, tenantId = 'default') {
    if (!campaignId) return [];
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT * FROM campaign_reconciliation_records
      WHERE campaign_id = ? AND tenant_id = ?
      ORDER BY created_at DESC
    `).all(campaignId, tid);
  }

  findStaleDispatchingTouches(tenantId = 'default', nowOrThreshold = Date.now(), thresholdMs = 300000) {
    const tid = (tenantId || 'default').trim();
    const rows = this.sqlite.prepare(`
      SELECT * FROM campaign_touches
      WHERE tenant_id = ? AND execution_status = 'DISPATCHING'
      ORDER BY execution_locked_at ASC
    `).all(tid);

    let now = Date.now();
    let limitMs = thresholdMs;

    // If second arg is a small number <= 120, treat it as thresholdMinutes
    if (typeof nowOrThreshold === 'number' && nowOrThreshold > 0 && nowOrThreshold <= 120) {
      limitMs = nowOrThreshold * 60 * 1000;
      now = Date.now();
    } else if (nowOrThreshold) {
      now = typeof nowOrThreshold === 'number' ? nowOrThreshold : new Date(nowOrThreshold).getTime();
    }

    return rows.filter(r => {
      if (!r.execution_locked_at) return false; // fail-closed: never silently classify missing as stale
      const lockedMs = new Date(r.execution_locked_at).getTime();
      if (isNaN(lockedMs)) return false; // fail-closed: never silently classify malformed as stale
      const elapsed = now - lockedMs;
      if (elapsed < 0) return false; // clock anomaly / future timestamp: fail safe
      return elapsed >= limitMs;
    });
  }

  reconcileTouchAtomic(touchId, tenantId = 'default', options = {}) {
    if (!touchId) throw new Error('touchId is required');
    const tid = (tenantId || 'default').trim();
    const currentMs = (options && options.now !== undefined && options.now !== null)
      ? (typeof options.now === 'number' ? options.now : (options.now instanceof Date ? options.now.getTime() : new Date(options.now).getTime()))
      : Date.now();
    const now = new Date(currentMs).toISOString();

    const {
      decision,
      reason,
      notes,
      evidenceType = null,
      evidenceReference = null,
      operatorId = 'operator',
      operatorName = 'Operator',
      operatorRole = 'ADMIN',
      approvalHash = null,
      campaignVersion = null,
      providerMessageId = null
    } = options;

    return this.sqlite.transaction(() => {
      // 1. Re-fetch current touch state under transaction
      const touch = this.sqlite.prepare(`
        SELECT * FROM campaign_touches
        WHERE id = ? AND tenant_id = ?
      `).get(touchId, tid);

      if (!touch) {
        throw new Error(`TOUCH_NOT_FOUND: Campaign touch "${touchId}" not found for tenant "${tid}"`);
      }

      // 2. Strict state eligibility validation
      const isUncertain = touch.execution_status === 'PROVIDER_UNCERTAIN' || (touch.status === 'BLOCKED' && touch.execution_status === 'PROVIDER_UNCERTAIN');
      const isDispatching = touch.execution_status === 'DISPATCHING';

      if (!isUncertain && !isDispatching) {
        throw new Error(`INVALID_STATE_FOR_RECONCILIATION: Touch current status "${touch.status}" / execution_status "${touch.execution_status}" is not eligible for manual reconciliation.`);
      }

      // If DISPATCHING, verify stale lock threshold (5 minutes)
      if (isDispatching) {
        const thresholdMs = 5 * 60 * 1000;
        if (!touch.execution_locked_at) {
          throw new Error('INVALID_STATE_FOR_RECONCILIATION: DISPATCHING touch has no execution_locked_at timestamp.');
        }
        const lockedMs = new Date(touch.execution_locked_at).getTime();
        if (isNaN(lockedMs)) {
          throw new Error('INVALID_STATE_FOR_RECONCILIATION: DISPATCHING touch has invalid execution_locked_at timestamp.');
        }
        const elapsed = currentMs - lockedMs;
        if (elapsed < thresholdMs) {
          throw new Error('TOUCH_DISPATCH_IN_FLIGHT: Touch dispatch is currently in flight and execution lock is not yet stale.');
        }
      }

      // 3. Determine new state based on explicit human decision
      let newTouchStatus;
      let newExecutionStatus;
      let newStopReason = null;
      let finalProviderMessageId = touch.provider_message_id;

      if (decision === 'VERIFIED_SENT') {
        newTouchStatus = 'SENT';
        newExecutionStatus = 'SENT';
        if (evidenceReference && evidenceType === 'PROVIDER_MESSAGE_ID') {
          finalProviderMessageId = String(evidenceReference);
        } else if (providerMessageId) {
          finalProviderMessageId = String(providerMessageId);
        }
      } else if (decision === 'VERIFIED_NOT_SENT') {
        newTouchStatus = 'PLANNED';
        newExecutionStatus = null;
        finalProviderMessageId = null;
      } else if (decision === 'REMAINS_UNCERTAIN') {
        newTouchStatus = 'BLOCKED';
        newExecutionStatus = 'PROVIDER_UNCERTAIN';
        newStopReason = 'REMAINS_UNCERTAIN';
      } else {
        throw new Error(`INVALID_DECISION: Unknown reconciliation decision "${decision}"`);
      }

      // 4. Find latest attempt (if any)
      const attempt = this.sqlite.prepare(`
        SELECT * FROM campaign_execution_attempts
        WHERE campaign_touch_id = ? AND tenant_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(touchId, tid);

      // 5. Create immutable reconciliation record
      const recId = `rec_${touchId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      this.sqlite.prepare(`
        INSERT INTO campaign_reconciliation_records (
          id, tenant_id, campaign_id, campaign_touch_id, campaign_lead_id,
          attempt_id, operator_id, operator_name, operator_role,
          decision, reason, notes, evidence_type, evidence_reference,
          previous_touch_status, new_touch_status,
          previous_execution_status, new_execution_status,
          approval_hash, campaign_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recId, tid, touch.campaign_id, touch.id, touch.campaign_lead_id,
        attempt ? attempt.id : null, operatorId, operatorName, operatorRole,
        decision, reason, notes, evidenceType, evidenceReference,
        touch.status, newTouchStatus,
        touch.execution_status || 'NONE', newExecutionStatus || 'NONE',
        approvalHash, campaignVersion, now
      );

      // 6. Log to campaign_execution_logs
      let logExecutionStatus = 'BLOCKED';
      if (decision === 'VERIFIED_SENT') {
        logExecutionStatus = 'EXECUTED';
      } else if (decision === 'VERIFIED_NOT_SENT') {
        logExecutionStatus = 'FAILED';
      } else if (decision === 'REMAINS_UNCERTAIN') {
        logExecutionStatus = 'BLOCKED';
      }

      this.createCampaignExecutionLog({
        campaign_id: touch.campaign_id,
        campaign_lead_id: touch.campaign_lead_id,
        campaign_touch_id: touch.id,
        lead_id: touch.lead_id,
        tenant_id: tid,
        execution_mode: 'LIVE',
        planned_channel: touch.planned_channel,
        execution_status: logExecutionStatus,
        decision_reason: `MANUAL_RECONCILIATION_${decision}`,
        simulated: 0,
        provider_message_id: finalProviderMessageId,
        approval_hash: approvalHash,
        executed_at: now,
        metadata: {
          reconciliation_id: recId,
          decision,
          reason,
          notes,
          operator_id: operatorId,
          operator_role: operatorRole,
          evidence_type: evidenceType,
          evidence_reference: evidenceReference,
          previous_touch_status: touch.status,
          previous_execution_status: touch.execution_status
        }
      }, tid);

      // 7. Atomic update of campaign_touches with conditional state checking
      const updateResult = this.sqlite.prepare(`
        UPDATE campaign_touches
        SET status = ?,
            execution_status = ?,
            dispatched_at = CASE WHEN ? = 'SENT' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
            provider_message_id = ?,
            execution_lock = NULL,
            execution_locked_at = NULL,
            stop_reason = ?,
            execution_error = CASE WHEN ? = 'PLANNED' THEN NULL ELSE execution_error END,
            updated_at = ?
        WHERE id = ? AND tenant_id = ? AND (execution_status = ? OR (execution_status IS NULL AND ? IS NULL))
      `).run(
        newTouchStatus,
        newExecutionStatus,
        newTouchStatus,
        now,
        finalProviderMessageId,
        newStopReason,
        newTouchStatus,
        now,
        touchId,
        tid,
        touch.execution_status,
        touch.execution_status
      );

      if (updateResult.changes !== 1) {
        throw new Error('CONCURRENT_RECONCILIATION_OR_STATE_CHANGED: Touch state modified by another transaction.');
      }

      return {
        reconciliation: this.getReconciliationRecord(recId, tid),
        touch: this.getCampaignTouch(touchId, tid)
      };
    })();
  }

  // ============================================================================
  // PHASE 2 STEP 6E: CAMPAIGN REVIEW AUDIT TRAIL HELPERS
  // ============================================================================

  createCampaignReviewLog(logData = {}, tenantId = 'default') {
    const {
      campaign_id,
      action,
      previous_status,
      new_status,
      reviewer,
      review_hash = null,
      campaign_version = 1,
      notes = null,
      metadata = null
    } = logData;

    const tid = (logData.tenant_id || tenantId || 'default').trim();

    if (!campaign_id) throw new Error('campaign_id is required');
    if (!action) throw new Error('action is required');
    if (!previous_status) throw new Error('previous_status is required');
    if (!new_status) throw new Error('new_status is required');
    if (!reviewer || typeof reviewer !== 'string' || !reviewer.trim()) {
      throw new Error('reviewer identity is required');
    }

    const ALLOWED_ACTIONS = [
      'SUBMITTED_FOR_REVIEW',
      'APPROVED',
      'REJECTED',
      'REOPENED',
      'CANCELLED',
      'INVALIDATED_DUE_TO_MATERIAL_CHANGE'
    ];
    if (!ALLOWED_ACTIONS.includes(action)) {
      throw new Error(`Invalid review action "${action}". Allowed: ${ALLOWED_ACTIONS.join(', ')}`);
    }

    const id = logData.id || `crl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const metaStr = metadata ? this._validateJson(metadata, 'metadata') : null;

    this.sqlite.prepare(`
      INSERT INTO campaign_review_logs (
        id, campaign_id, tenant_id, action, previous_status, new_status,
        reviewer, review_hash, campaign_version, notes, metadata, created_at
      ) VALUES (
        @id, @campaign_id, @tenant_id, @action, @previous_status, @new_status,
        @reviewer, @review_hash, @campaign_version, @notes, @metadata, @created_at
      )
    `).run({
      id,
      campaign_id,
      tenant_id: tid,
      action,
      previous_status,
      new_status,
      reviewer: reviewer.trim(),
      review_hash: review_hash || null,
      campaign_version: parseInt(campaign_version, 10) || 1,
      notes: notes || null,
      metadata: metaStr,
      created_at: now
    });

    return this.getCampaignReviewLog(id, tid);
  }

  getCampaignReviewLog(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM campaign_review_logs WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!row) return null;
    return {
      ...row,
      metadata: this._safeParseJson(row.metadata, null)
    };
  }

  listCampaignReviewLogs(campaignId, tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { limit = 100, offset = 0 } = options;

    let sql = 'SELECT * FROM campaign_review_logs WHERE campaign_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const rows = this.sqlite.prepare(sql).all(campaignId, tid, parseInt(limit, 10) || 100, parseInt(offset, 10) || 0);
    return rows.map(r => ({
      ...r,
      metadata: this._safeParseJson(r.metadata, null)
    }));
  }

  createCampaignExecutionLog(logData, tenantId = 'default') {
    const tid = (logData.tenant_id || tenantId || 'default').trim();
    const id = logData.id || `exec_log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    const {
      campaign_id,
      campaign_lead_id,
      campaign_touch_id,
      lead_id,
      execution_mode = 'DRY_RUN',
      planned_channel,
      execution_status,
      decision_reason = null,
      provider = null,
      provider_message_id = null,
      simulated = 1,
      gate_result = null,
      eligibility_snapshot = null,
      quota_snapshot = null,
      approval_hash = null,
      executed_at = null,
      metadata = null
    } = logData;

    if (!campaign_id) throw new Error('campaign_id is required for execution log');
    if (!campaign_touch_id) throw new Error('campaign_touch_id is required for execution log');

    this.sqlite.prepare(`
      INSERT INTO campaign_execution_logs (
        id, tenant_id, campaign_id, campaign_lead_id, campaign_touch_id, lead_id,
        execution_mode, planned_channel, execution_status, decision_reason,
        provider, provider_message_id, simulated, gate_result,
        eligibility_snapshot, quota_snapshot, approval_hash, executed_at, created_at, metadata
      ) VALUES (
        @id, @tenant_id, @campaign_id, @campaign_lead_id, @campaign_touch_id, @lead_id,
        @execution_mode, @planned_channel, @execution_status, @decision_reason,
        @provider, @provider_message_id, @simulated, @gate_result,
        @eligibility_snapshot, @quota_snapshot, @approval_hash, @executed_at, @created_at, @metadata
      )
    `).run({
      id,
      tenant_id: tid,
      campaign_id,
      campaign_lead_id,
      campaign_touch_id,
      lead_id,
      execution_mode,
      planned_channel,
      execution_status,
      decision_reason,
      provider,
      provider_message_id,
      simulated: simulated ? 1 : 0,
      gate_result: gate_result ? (typeof gate_result === 'object' ? JSON.stringify(gate_result) : gate_result) : null,
      eligibility_snapshot: eligibility_snapshot ? (typeof eligibility_snapshot === 'object' ? JSON.stringify(eligibility_snapshot) : eligibility_snapshot) : null,
      quota_snapshot: quota_snapshot ? (typeof quota_snapshot === 'object' ? JSON.stringify(quota_snapshot) : quota_snapshot) : null,
      approval_hash: approval_hash || null,
      executed_at: executed_at || now,
      created_at: now,
      metadata: metadata ? (typeof metadata === 'object' ? JSON.stringify(metadata) : metadata) : null
    });

    return this.getCampaignExecutionLog(id, tid);
  }

  getCampaignExecutionLog(id, tenantId = 'default') {
    if (!id) return null;
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM campaign_execution_logs WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!row) return null;
    return {
      ...row,
      simulated: Boolean(row.simulated),
      gate_result: this._safeParseJson(row.gate_result, null),
      eligibility_snapshot: this._safeParseJson(row.eligibility_snapshot, null),
      quota_snapshot: this._safeParseJson(row.quota_snapshot, null),
      metadata: this._safeParseJson(row.metadata, null)
    };
  }

  listCampaignExecutionLogs(campaignId, tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { limit = 100, offset = 0, touchId = null, executionMode = null } = options;

    let sql = 'SELECT * FROM campaign_execution_logs WHERE campaign_id = ? AND tenant_id = ?';
    const params = [campaignId, tid];

    if (touchId) {
      sql += ' AND campaign_touch_id = ?';
      params.push(touchId);
    }
    if (executionMode) {
      sql += ' AND execution_mode = ?';
      params.push(executionMode);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 100, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => ({
      ...r,
      simulated: Boolean(r.simulated),
      gate_result: this._safeParseJson(r.gate_result, null),
      eligibility_snapshot: this._safeParseJson(r.eligibility_snapshot, null),
      quota_snapshot: this._safeParseJson(r.quota_snapshot, null),
      metadata: this._safeParseJson(r.metadata, null)
    }));
  }

  // ==============================================================================
  // OPERATOR AUTHENTICATION & API KEY MANAGEMENT (Step 6F-B.1 Auth Hardening)
  // ==============================================================================

  hashOperatorKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
  }

  createOperatorKey({
    actorId,
    actorName,
    actorRole,
    tenantId = 'default',
    rawKey = null,
    expiresAt = null
  }) {
    if (!actorId || !actorName || !actorRole) {
      throw new Error('actorId, actorName, and actorRole are required to create an operator key');
    }
    const validRoles = ['ADMIN', 'CAMPAIGN_MANAGER', 'COMPLIANCE_OFFICER', 'VIEWER', 'USER'];
    const upperRole = String(actorRole).toUpperCase().trim();
    if (!validRoles.includes(upperRole)) {
      throw new Error(`Invalid actorRole: ${actorRole}. Must be one of: ${validRoles.join(', ')}`);
    }

    const id = 'opk_' + crypto.randomBytes(8).toString('hex');
    const secretKey = rawKey && typeof rawKey === 'string' && rawKey.trim()
      ? rawKey.trim()
      : 'lfop_' + crypto.randomBytes(24).toString('hex');
    const keyHash = this.hashOperatorKey(secretKey);
    const createdAt = new Date().toISOString();
    const tid = (tenantId || 'default').trim();

    const stmt = this.sqlite.prepare(`
      INSERT INTO operator_keys (id, key_hash, actor_id, actor_name, actor_role, tenant_id, is_active, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    stmt.run(id, keyHash, actorId.trim(), actorName.trim(), upperRole, tid, createdAt, expiresAt || null);

    return {
      id,
      rawKey: secretKey,
      actorId: actorId.trim(),
      actorName: actorName.trim(),
      actorRole: upperRole,
      tenantId: tid,
      createdAt,
      expiresAt: expiresAt || null
    };
  }

  authenticateOperatorKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    const keyHash = this.hashOperatorKey(rawKey);
    if (!keyHash) return null;

    const row = this.sqlite.prepare(`
      SELECT * FROM operator_keys
      WHERE key_hash = ? AND is_active = 1
    `).get(keyHash);

    if (!row) return null;

    if (row.expires_at) {
      const expiry = new Date(row.expires_at).getTime();
      if (!isNaN(expiry) && Date.now() > expiry) {
        return null; // Expired
      }
    }

    return {
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      tenantId: row.tenant_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  revokeOperatorKey(keyId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const res = this.sqlite.prepare(`
      UPDATE operator_keys SET is_active = 0 WHERE id = ? AND tenant_id = ?
    `).run(keyId, tid);
    return res.changes > 0;
  }

  getOperatorKeys(tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    return this.sqlite.prepare(`
      SELECT id, actor_id, actor_name, actor_role, tenant_id, is_active, created_at, expires_at
      FROM operator_keys WHERE tenant_id = ? ORDER BY created_at DESC
    `).all(tid);
  }

  // ============================================================================
  // PHASE 2 STEP 8B: CONVERSATION INTELLIGENCE FOUNDATION DATA ACCESS METHODS
  // ============================================================================

  /**
   * Create or locate an existing conversation thread idempotently.
   * Enforces tenant consistency between lead, contact, and conversation.
   *
   * @param {object} params
   * @param {string} params.tenantId
   * @param {string} params.leadId
   * @param {string} [params.contactId]
   * @param {string} params.channel - 'whatsapp' | 'telegram' | 'email' | 'sms'
   * @param {string} params.externalThreadId
   * @param {string} [params.status='NEW']
   * @param {object} [params.metadata]
   * @returns {object} conversation record
   */
  getOrCreateConversation({
    tenantId = 'default',
    leadId,
    contactId = null,
    channel,
    externalThreadId,
    status = 'NEW',
    metadata = null
  }) {
    const tid = (tenantId || 'default').trim();
    if (!leadId || !channel || !externalThreadId) {
      throw new Error('leadId, channel, and externalThreadId are required to create a conversation');
    }

    const validChannels = ['whatsapp', 'telegram', 'email', 'sms'];
    const ch = String(channel).toLowerCase().trim();
    if (!validChannels.includes(ch)) {
      throw new Error(`Invalid channel "${channel}". Allowed: ${validChannels.join(', ')}`);
    }

    const threadId = String(externalThreadId).trim();
    if (!threadId) {
      throw new Error('externalThreadId cannot be empty');
    }

    // 1. Verify lead exists and belongs strictly to the authenticated tenant
    const lead = this.sqlite.prepare('SELECT id, tenant_id FROM leads WHERE id = ?').get(leadId);
    if (!lead) {
      throw new Error(`Lead "${leadId}" not found`);
    }
    if (lead.tenant_id !== tid) {
      this.createComplianceAuditLog({
        tenantId: tid,
        leadId,
        channel: ch,
        eventType: 'CROSS_TENANT_CONVERSATION_BLOCKED',
        decision: 'BLOCKED',
        reason: `Lead tenant "${lead.tenant_id}" does not match conversation tenant "${tid}"`
      });
      throw new Error(`Tenant mismatch: lead belongs to tenant "${lead.tenant_id}", not "${tid}"`);
    }

    // 2. If contactId is provided, verify it belongs strictly to this lead and tenant
    if (contactId) {
      const contact = this.sqlite.prepare('SELECT id, lead_id, tenant_id FROM lead_contacts WHERE id = ?').get(contactId);
      if (!contact) {
        throw new Error(`Contact "${contactId}" not found`);
      }
      if (contact.tenant_id !== tid || contact.lead_id !== leadId) {
        this.createComplianceAuditLog({
          tenantId: tid,
          leadId,
          channel: ch,
          eventType: 'CROSS_TENANT_CONTACT_BLOCKED',
          decision: 'BLOCKED',
          reason: `Contact tenant/lead mismatch: contact (${contact.tenant_id}/${contact.lead_id}) vs expected (${tid}/${leadId})`
        });
        throw new Error(`Tenant/lead mismatch for contact "${contactId}"`);
      }
    }

    // 3. Atomic check-and-insert using SQLite transaction
    const tx = this.sqlite.transaction(() => {
      // Check existing conversation
      const existing = this.sqlite.prepare(`
        SELECT * FROM conversations
        WHERE tenant_id = ? AND channel = ? AND external_thread_id = ?
      `).get(tid, ch, threadId);

      if (existing) {
        return this._formatConversationRecord(existing);
      }

      const id = 'cnv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const metaStr = metadata ? JSON.stringify(metadata) : null;

      try {
        this.sqlite.prepare(`
          INSERT INTO conversations (
            id, tenant_id, lead_id, contact_id, channel, external_thread_id,
            conversation_status, unread_count, metadata, last_message_at, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?
          )
        `).run(id, tid, leadId, contactId, ch, threadId, status, metaStr, now, now, now);

        const created = this.sqlite.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
        return this._formatConversationRecord(created);
      } catch (insertErr) {
        // Handle concurrent race winning insert
        if (insertErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || insertErr.message?.includes('UNIQUE constraint failed')) {
          const raceWinner = this.sqlite.prepare(`
            SELECT * FROM conversations
            WHERE tenant_id = ? AND channel = ? AND external_thread_id = ?
          `).get(tid, ch, threadId);
          if (raceWinner) {
            return this._formatConversationRecord(raceWinner);
          }
        }
        throw insertErr;
      }
    });

    return tx();
  }

  getConversationById(id, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, tid);
    return row ? this._formatConversationRecord(row) : null;
  }

  listConversations(tenantId = 'default', options = {}) {
    const tid = (tenantId || 'default').trim();
    const { leadId = null, channel = null, status = null, limit = 50, offset = 0 } = options;

    let sql = 'SELECT * FROM conversations WHERE tenant_id = ?';
    const params = [tid];

    if (leadId) {
      sql += ' AND lead_id = ?';
      params.push(leadId);
    }
    if (channel) {
      sql += ' AND channel = ?';
      params.push(channel);
    }
    if (status) {
      sql += ' AND conversation_status = ?';
      params.push(status);
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatConversationRecord(r));
  }

  updateConversationStatus(id, newStatus, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const validStatuses = [
      'NEW', 'ACTIVE', 'WAITING_FOR_HUMAN', 'WAITING_FOR_PROSPECT',
      'HUMAN_REVIEW_REQUIRED', 'AMBIGUOUS_IDENTITY', 'OPTED_OUT', 'CLOSED', 'BLOCKED'
    ];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid conversation status "${newStatus}". Allowed: ${validStatuses.join(', ')}`);
    }

    const now = new Date().toISOString();
    const res = this.sqlite.prepare(`
      UPDATE conversations
      SET conversation_status = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(newStatus, now, id, tid);

    return res.changes > 0;
  }

  /**
   * Ingest a conversation message with atomic deduplication.
   * Guarantees strict multi-tenant validation between message, conversation, and lead.
   *
   * @param {object} params
   * @param {string} params.tenantId
   * @param {string} params.conversationId
   * @param {string} params.channel
   * @param {string} params.direction - 'INBOUND' | 'OUTBOUND'
   * @param {string} params.senderIdentifier
   * @param {string} params.recipientIdentifier
   * @param {string} params.providerMessageId
   * @param {string} params.messageText
   * @param {object} [params.rawPayload]
   * @param {string} [params.receivedAt]
   * @param {number} [params.hasOptOut=0]
   * @returns {{ duplicate: boolean, message: object }}
   */
  ingestConversationMessage({
    tenantId = 'default',
    conversationId,
    channel,
    direction = 'INBOUND',
    senderIdentifier,
    recipientIdentifier,
    providerMessageId,
    messageText,
    rawPayload = null,
    receivedAt = null,
    hasOptOut = 0
  }) {
    const tid = (tenantId || 'default').trim();
    if (!conversationId || !channel || !direction || !senderIdentifier || !recipientIdentifier || !providerMessageId || messageText === undefined) {
      throw new Error('conversationId, channel, direction, senderIdentifier, recipientIdentifier, providerMessageId, and messageText are required');
    }

    const pMsgId = String(providerMessageId).trim();
    if (!pMsgId) {
      throw new Error('providerMessageId cannot be empty');
    }

    const ch = String(channel).toLowerCase().trim();
    const dir = String(direction).toUpperCase().trim();
    if (!['INBOUND', 'OUTBOUND'].includes(dir)) {
      throw new Error(`Invalid message direction "${direction}". Must be INBOUND or OUTBOUND.`);
    }

    // 1. Transactional check and insertion
    const tx = this.sqlite.transaction(() => {
      // Verify conversation exists and strictly belongs to this tenant
      const conv = this.sqlite.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
      if (!conv) {
        throw new Error(`Conversation "${conversationId}" not found`);
      }
      if (conv.tenant_id !== tid) {
        this.createComplianceAuditLog({
          tenantId: tid,
          leadId: conv.lead_id,
          channel: ch,
          eventType: 'CROSS_TENANT_MESSAGE_BLOCKED',
          decision: 'BLOCKED',
          reason: `Conversation tenant "${conv.tenant_id}" does not match message tenant "${tid}"`
        });
        throw new Error(`Tenant mismatch: conversation belongs to tenant "${conv.tenant_id}", not "${tid}"`);
      }

      // Check if message already exists with this provider ID in this tenant
      const existing = this.sqlite.prepare(`
        SELECT * FROM conversation_messages
        WHERE tenant_id = ? AND channel = ? AND provider_message_id = ?
      `).get(tid, ch, pMsgId);

      if (existing) {
        return {
          duplicate: true,
          message: this._formatMessageRecord(existing)
        };
      }

      const id = 'cmsg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const rcvAt = receivedAt || now;
      const rawStr = rawPayload ? (typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload)) : null;

      try {
        this.sqlite.prepare(`
          INSERT INTO conversation_messages (
            id, tenant_id, conversation_id, channel, direction, sender_identifier,
            recipient_identifier, provider_message_id, message_text, raw_payload,
            delivery_status, has_opt_out, received_at, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?
          )
        `).run(
          id, tid, conversationId, ch, dir, String(senderIdentifier).trim(),
          String(recipientIdentifier).trim(), pMsgId, String(messageText), rawStr,
          hasOptOut ? 1 : 0, rcvAt, now
        );

        // Update conversation thread timestamp and unread counter if inbound
        this.sqlite.prepare(`
          UPDATE conversations
          SET last_message_at = ?,
              unread_count = unread_count + (CASE WHEN ? = 'INBOUND' THEN 1 ELSE 0 END),
              updated_at = ?
          WHERE id = ?
        `).run(rcvAt, dir, now, conversationId);

        // Update lead last_inbound_at without mutating sales status!
        if (dir === 'INBOUND' && conv.lead_id) {
          this.sqlite.prepare(`
            UPDATE leads
            SET last_inbound_at = ?,
                lastReplyText = ?,
                lastReplyAt = ?
            WHERE id = ? AND tenant_id = ?
          `).run(rcvAt, String(messageText), rcvAt, conv.lead_id, tid);
        }

        const created = this.sqlite.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id);
        return {
          duplicate: false,
          message: this._formatMessageRecord(created)
        };
      } catch (insertErr) {
        if (insertErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || insertErr.message?.includes('UNIQUE constraint failed')) {
          const raceWinner = this.sqlite.prepare(`
            SELECT * FROM conversation_messages
            WHERE tenant_id = ? AND channel = ? AND provider_message_id = ?
          `).get(tid, ch, pMsgId);
          if (raceWinner) {
            return {
              duplicate: true,
              message: this._formatMessageRecord(raceWinner)
            };
          }
        }
        throw insertErr;
      }
    });

    return tx();
  }

  getConversationMessageById(id, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    const row = this.sqlite.prepare('SELECT * FROM conversation_messages WHERE id = ? AND tenant_id = ?').get(id, tid);
    return row ? this._formatMessageRecord(row) : null;
  }

  listConversationMessages(conversationId, tenantId = 'default') {
    const tid = (tenantId || 'default').trim();
    // Validate conversation tenant first
    const conv = this.getConversationById(conversationId, tid);
    if (!conv) {
      throw new Error(`Conversation "${conversationId}" not found for tenant "${tid}"`);
    }

    const rows = this.sqlite.prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ? AND tenant_id = ?
      ORDER BY received_at ASC, created_at ASC
    `).all(conversationId, tid);

    return rows.map(r => this._formatMessageRecord(r));
  }

  _formatConversationRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      leadId: row.lead_id,
      contactId: row.contact_id,
      channel: row.channel,
      externalThreadId: row.external_thread_id,
      conversationStatus: row.conversation_status,
      unreadCount: row.unread_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  _formatMessageRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      channel: row.channel,
      direction: row.direction,
      senderIdentifier: row.sender_identifier,
      recipientIdentifier: row.recipient_identifier,
      providerMessageId: row.provider_message_id,
      messageText: row.message_text,
      rawPayload: row.raw_payload ? JSON.parse(row.raw_payload) : null,
      deliveryStatus: row.delivery_status,
      hasOptOut: Boolean(row.has_opt_out),
      receivedAt: row.received_at,
      createdAt: row.created_at
    };
  }

  // ==========================================
  // STEP 9: CRM & OPPORTUNITY MANAGEMENT ENGINE
  // ==========================================

  createOpportunity({
    lead_id,
    contact_id = null,
    title,
    deal_value = 0.0,
    currency = 'INR',
    stage = 'DISCOVERY',
    confidence_probability = null,
    expected_close_date = null,
    loss_reason_code = null,
    loss_reason_notes = null,
    assigned_operator_id = null,
    metadata = {},
    tenant_id = 'default',
    operator_id = 'system'
  }) {
    const tid = tenant_id || 'default';
    if (!lead_id) throw new Error('lead_id is required');
    if (!title || typeof title !== 'string' || !title.trim()) throw new Error('title is required');

    // 1. Verify lead exists and belongs to tenant
    const lead = this.sqlite.prepare('SELECT id, tenant_id FROM leads WHERE id = ?').get(lead_id);
    if (!lead) throw new Error('LEAD_NOT_FOUND');
    if (lead.tenant_id !== tid) throw new Error('CROSS_TENANT_LEAD_FORBIDDEN');

    // 2. Verify contact_id if supplied
    if (contact_id) {
      const contact = this.sqlite.prepare('SELECT id, lead_id, tenant_id FROM lead_contacts WHERE id = ?').get(contact_id);
      if (!contact || contact.lead_id !== lead_id || contact.tenant_id !== tid) {
        throw new Error('INVALID_CONTACT_ASSOCIATION');
      }
    }

    // 3. Stage probability mapping if not specified
    const defaultProbabilities = {
      DISCOVERY: 0.20,
      DEMO_BOOKED: 0.40,
      QUALIFIED: 0.60,
      PROPOSAL_SENT: 0.75,
      NEGOTIATION: 0.90,
      CLOSED_WON: 1.0,
      CLOSED_LOST: 0.0
    };

    const finalProb = confidence_probability !== null && confidence_probability !== undefined
      ? parseFloat(confidence_probability)
      : (defaultProbabilities[stage] ?? 0.20);

    const oppId = `opp_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    const insertOppTx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO opportunities (
          id, tenant_id, lead_id, contact_id, title, deal_value, currency,
          stage, confidence_probability, expected_close_date, loss_reason_code,
          loss_reason_notes, assigned_operator_id, metadata, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        oppId, tid, lead_id, contact_id, title.trim(), Math.max(0, parseFloat(deal_value) || 0.0), currency,
        stage, finalProb, expected_close_date, loss_reason_code,
        loss_reason_notes, assigned_operator_id, JSON.stringify(metadata || {}), now, now
      );

      const historyId = `oph_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).substring(2, 9)}`;
      this.sqlite.prepare(`
        INSERT INTO opportunity_stage_history (
          id, tenant_id, opportunity_id, previous_stage, new_stage,
          changed_by_operator, transition_reason, metadata, created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, 'OPPORTUNITY_CREATED', ?, ?)
      `).run(
        historyId, tid, oppId, stage, operator_id, JSON.stringify({ initial_probability: finalProb }), now
      );
    });

    insertOppTx();
    return this.getOpportunityById(oppId, tid);
  }

  getOpportunityById(id, tenant_id = 'default') {
    const tid = tenant_id || 'default';
    const row = this.sqlite.prepare(`
      SELECT 
        o.*,
        l.businessName as lead_business_name,
        l.phone as lead_phone,
        l.email as lead_email,
        l.leadStatus as lead_status,
        c.contact_name,
        c.email as contact_email,
        c.phone as contact_phone
      FROM opportunities o
      JOIN leads l ON o.lead_id = l.id
      LEFT JOIN lead_contacts c ON o.contact_id = c.id
      WHERE o.id = ? AND o.tenant_id = ?
    `).get(id, tid);

    return this._formatOpportunityRecord(row);
  }

  listOpportunities({ tenant_id = 'default', stage, lead_id, limit = 50, offset = 0 } = {}) {
    const tid = tenant_id || 'default';
    let sql = `
      SELECT 
        o.*,
        l.businessName as lead_business_name,
        l.phone as lead_phone,
        l.email as lead_email,
        l.leadStatus as lead_status,
        c.contact_name,
        c.email as contact_email,
        c.phone as contact_phone
      FROM opportunities o
      JOIN leads l ON o.lead_id = l.id
      LEFT JOIN lead_contacts c ON o.contact_id = c.id
      WHERE o.tenant_id = ?
    `;
    const params = [tid];

    if (stage) {
      sql += ' AND o.stage = ?';
      params.push(stage);
    }
    if (lead_id) {
      sql += ' AND o.lead_id = ?';
      params.push(lead_id);
    }

    sql += ' ORDER BY o.updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatOpportunityRecord(r));
  }

  updateOpportunityStage(id, {
    new_stage,
    operator_id = 'system',
    transition_reason = 'STAGE_TRANSITION',
    loss_reason_code = null,
    loss_reason_notes = null,
    confidence_probability = null,
    tenant_id = 'default'
  }) {
    const tid = tenant_id || 'default';
    const opp = this.getOpportunityById(id, tid);
    if (!opp) throw new Error('OPPORTUNITY_NOT_FOUND');

    const validStages = ['DISCOVERY', 'DEMO_BOOKED', 'QUALIFIED', 'PROPOSAL_SENT', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];
    if (!validStages.includes(new_stage)) {
      throw new Error(`INVALID_STAGE: ${new_stage}`);
    }

    // Terminal state rules
    if (new_stage === 'CLOSED_LOST') {
      const validLossCodes = ['PRICING', 'TIMING', 'COMPETITOR', 'UNRESPONSIVE', 'NO_BUDGET', 'POOR_FIT', 'OTHER'];
      if (!loss_reason_code || !validLossCodes.includes(loss_reason_code)) {
        throw new Error('MISSING_OR_INVALID_LOSS_REASON_CODE');
      }
      if (!loss_reason_notes || typeof loss_reason_notes !== 'string' || loss_reason_notes.trim().length < 5) {
        throw new Error('LOSS_REASON_NOTES_REQUIRED_MIN_5_CHARS');
      }
    }

    const defaultProbabilities = {
      DISCOVERY: 0.20,
      DEMO_BOOKED: 0.40,
      QUALIFIED: 0.60,
      PROPOSAL_SENT: 0.75,
      NEGOTIATION: 0.90,
      CLOSED_WON: 1.0,
      CLOSED_LOST: 0.0
    };

    const finalProb = confidence_probability !== null && confidence_probability !== undefined
      ? parseFloat(confidence_probability)
      : defaultProbabilities[new_stage];

    const now = new Date().toISOString();

    const updateTx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE opportunities
        SET 
          stage = ?,
          confidence_probability = ?,
          loss_reason_code = ?,
          loss_reason_notes = ?,
          updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(
        new_stage,
        finalProb,
        new_stage === 'CLOSED_LOST' ? loss_reason_code : (opp.lossReasonCode || null),
        new_stage === 'CLOSED_LOST' ? loss_reason_notes.trim() : (opp.lossReasonNotes || null),
        now,
        id,
        tid
      );

      const historyId = `oph_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).substring(2, 9)}`;
      this.sqlite.prepare(`
        INSERT INTO opportunity_stage_history (
          id, tenant_id, opportunity_id, previous_stage, new_stage,
          changed_by_operator, transition_reason, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        historyId,
        tid,
        id,
        opp.stage,
        new_stage,
        operator_id,
        transition_reason,
        JSON.stringify({ probability: finalProb, loss_code: loss_reason_code }),
        now
      );
    });

    updateTx();
    return this.getOpportunityById(id, tid);
  }

  updateOpportunity(id, updates = {}, tenant_id = 'default') {
    const tid = tenant_id || 'default';
    const opp = this.getOpportunityById(id, tid);
    if (!opp) throw new Error('OPPORTUNITY_NOT_FOUND');

    const allowed = ['title', 'deal_value', 'currency', 'expected_close_date', 'assigned_operator_id', 'metadata'];
    const sets = [];
    const params = [];

    for (const [key, val] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        params.push(key === 'metadata' ? JSON.stringify(val) : val);
      }
    }

    if (sets.length === 0) return opp;

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id, tid);

    this.sqlite.prepare(`UPDATE opportunities SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return this.getOpportunityById(id, tid);
  }

  getOpportunityHistory(opportunity_id, tenant_id = 'default') {
    const tid = tenant_id || 'default';
    const rows = this.sqlite.prepare(`
      SELECT * FROM opportunity_stage_history
      WHERE opportunity_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `).all(opportunity_id, tid);

    return rows.map(r => this._formatOpportunityHistoryRecord(r));
  }

  createOpportunityTask({
    opportunity_id,
    task_type,
    title,
    due_date,
    assigned_to = null,
    tenant_id = 'default'
  }) {
    const tid = tenant_id || 'default';
    const opp = this.getOpportunityById(opportunity_id, tid);
    if (!opp) throw new Error('OPPORTUNITY_NOT_FOUND');

    const validTaskTypes = ['CALL', 'DEMO_MEETING', 'PROPOSAL_PREP', 'CONTRACT_REVIEW', 'FOLLOW_UP', 'OTHER'];
    if (!validTaskTypes.includes(task_type)) {
      throw new Error(`INVALID_TASK_TYPE: ${task_type}`);
    }

    const taskId = `opt_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    this.sqlite.prepare(`
      INSERT INTO opportunity_tasks (
        id, tenant_id, opportunity_id, task_type, title, status, due_date, assigned_to, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
    `).run(
      taskId, tid, opportunity_id, task_type, title.trim(), due_date, assigned_to, now, now
    );

    const row = this.sqlite.prepare('SELECT * FROM opportunity_tasks WHERE id = ? AND tenant_id = ?').get(taskId, tid);
    return this._formatOpportunityTaskRecord(row);
  }

  listOpportunityTasks(opportunity_id, tenant_id = 'default') {
    const tid = tenant_id || 'default';
    const rows = this.sqlite.prepare(`
      SELECT * FROM opportunity_tasks
      WHERE opportunity_id = ? AND tenant_id = ?
      ORDER BY due_date ASC
    `).all(opportunity_id, tid);

    return rows.map(r => this._formatOpportunityTaskRecord(r));
  }

  updateOpportunityTaskStatus(taskId, status, tenant_id = 'default') {
    const tid = tenant_id || 'default';
    const validStatuses = ['PENDING', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      throw new Error(`INVALID_TASK_STATUS: ${status}`);
    }

    const now = new Date().toISOString();
    const res = this.sqlite.prepare(`
      UPDATE opportunity_tasks
      SET status = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(status, now, taskId, tid);

    if (res.changes === 0) throw new Error('TASK_NOT_FOUND');

    const row = this.sqlite.prepare('SELECT * FROM opportunity_tasks WHERE id = ? AND tenant_id = ?').get(taskId, tid);
    return this._formatOpportunityTaskRecord(row);
  }

  syncOpportunityFromConversation({
    conversationId,
    tenantId = 'default',
    bookingData = null,
    operatorId = 'system'
  }) {
    const tid = tenantId || 'default';
    const conv = this.getConversationById(conversationId, tid);
    if (!conv) throw new Error('CONVERSATION_NOT_FOUND');
    if (!conv.leadId) throw new Error('CONVERSATION_HAS_NO_LEAD');

    const lead = this.sqlite.prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?').get(conv.leadId, tid);
    if (!lead) throw new Error('LEAD_NOT_FOUND');

    // 1. Check if an active non-terminal opportunity already exists
    const existingOpp = this.sqlite.prepare(`
      SELECT * FROM opportunities 
      WHERE lead_id = ? AND tenant_id = ? AND stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')
      ORDER BY updated_at DESC LIMIT 1
    `).get(conv.leadId, tid);

    let opportunity;

    if (existingOpp) {
      // If in DISCOVERY, advance to DEMO_BOOKED
      if (existingOpp.stage === 'DISCOVERY') {
        opportunity = this.updateOpportunityStage(existingOpp.id, {
          new_stage: 'DEMO_BOOKED',
          operator_id: operatorId,
          transition_reason: bookingData ? 'CAL_COM_MEETING_SCHEDULED' : 'INBOUND_BOOKING_CONVERTED',
          confidence_probability: 0.40,
          tenant_id: tid
        });
      } else {
        opportunity = this.getOpportunityById(existingOpp.id, tid);
      }
    } else {
      // Create new opportunity in DEMO_BOOKED
      opportunity = this.createOpportunity({
        lead_id: conv.leadId,
        contact_id: conv.contactId || null,
        title: `Workflow Automation - ${lead.businessName || 'Prospect'}`,
        deal_value: 50000.0,
        currency: 'INR',
        stage: 'DEMO_BOOKED',
        confidence_probability: 0.40,
        assigned_operator_id: operatorId,
        metadata: {
          converted_from_conversation_id: conversationId,
          booking_data: bookingData || null
        },
        tenant_id: tid,
        operator_id: operatorId
      });
    }

    // 2. If bookingData is provided, create a scheduled DEMO_MEETING task idempotently
    if (bookingData && bookingData.startTime) {
      const bookingUid = bookingData.bookingUid || bookingData.uid;
      const existingTasks = this.listOpportunityTasks(opportunity.id, tid);
      const isDuplicate = bookingUid && existingTasks.some(t => {
        return t.title.includes(bookingUid);
      });

      if (!isDuplicate) {
        this.createOpportunityTask({
          opportunity_id: opportunity.id,
          task_type: 'DEMO_MEETING',
          title: `Cal.com Demo Meeting: ${lead.businessName || 'Prospect'} [${bookingUid || 'auto'}]`,
          due_date: bookingData.startTime,
          assigned_to: bookingData.assignedTo || operatorId,
          tenant_id: tid
        });
      }
    }

    return opportunity;
  }

  _formatOpportunityRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      leadId: row.lead_id,
      contactId: row.contact_id,
      title: row.title,
      dealValue: row.deal_value,
      currency: row.currency,
      stage: row.stage,
      confidenceProbability: row.confidence_probability,
      expectedCloseDate: row.expected_close_date,
      lossReasonCode: row.loss_reason_code,
      lossReasonNotes: row.loss_reason_notes,
      assignedOperatorId: row.assigned_operator_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lead: {
        businessName: row.lead_business_name,
        phone: row.lead_phone,
        email: row.lead_email,
        leadStatus: row.lead_status
      },
      contact: row.contact_id ? {
        id: row.contact_id,
        name: row.contact_name,
        email: row.contact_email,
        phone: row.contact_phone
      } : null
    };
  }

  _formatOpportunityHistoryRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      opportunityId: row.opportunity_id,
      previousStage: row.previous_stage,
      newStage: row.new_stage,
      changedByOperator: row.changed_by_operator,
      transitionReason: row.transition_reason,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.created_at
    };
  }

  _formatOpportunityTaskRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      opportunityId: row.opportunity_id,
      taskType: row.task_type,
      title: row.title,
      status: row.status,
      dueDate: row.due_date,
      assignedTo: row.assigned_to,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // --- Step 10: Revenue & Attribution Methods ---

  recordRevenueLedgerEntry(entry, tid = 'default') {
    const id = entry.id || 'revled_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();
    const row = {
      id,
      tenant_id: tid,
      opportunity_id: entry.opportunityId,
      lead_id: entry.leadId,
      amount: parseFloat(entry.amount) || 0.0,
      currency: entry.currency || 'INR',
      recognized_at: entry.recognizedAt || now,
      recognized_by_operator: entry.recognizedByOperator || 'SYSTEM',
      source_attribution_model: entry.sourceAttributionModel || 'LINEAR',
      metadata: typeof entry.metadata === 'object' ? JSON.stringify(entry.metadata) : (entry.metadata || '{}'),
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO revenue_ledger (
        id, tenant_id, opportunity_id, lead_id, amount, currency,
        recognized_at, recognized_by_operator, source_attribution_model, metadata, created_at
      ) VALUES (
        @id, @tenant_id, @opportunity_id, @lead_id, @amount, @currency,
        @recognized_at, @recognized_by_operator, @source_attribution_model, @metadata, @created_at
      )
    `).run(row);

    return this.getRevenueLedgerEntry(id, tid);
  }

  getRevenueLedgerEntry(id, tid = 'default') {
    const row = this.sqlite.prepare('SELECT * FROM revenue_ledger WHERE id = ? AND tenant_id = ?').get(id, tid);
    return this._formatRevenueLedgerRecord(row);
  }

  getRevenueLedgerForOpportunity(opportunityId, tid = 'default') {
    const rows = this.sqlite.prepare('SELECT * FROM revenue_ledger WHERE opportunity_id = ? AND tenant_id = ? ORDER BY recognized_at DESC').all(opportunityId, tid);
    return rows.map(r => this._formatRevenueLedgerRecord(r));
  }

  getRevenueLedgerList(tid = 'default', limit = 100) {
    const rows = this.sqlite.prepare(`
      SELECT rl.*, o.title as opportunity_title, l.businessName as lead_name
      FROM revenue_ledger rl
      LEFT JOIN opportunities o ON rl.opportunity_id = o.id
      LEFT JOIN leads l ON rl.lead_id = l.id
      WHERE rl.tenant_id = ?
      ORDER BY rl.recognized_at DESC
      LIMIT ?
    `).all(tid, limit);
    return rows.map(r => ({
      ...this._formatRevenueLedgerRecord(r),
      opportunityTitle: r.opportunity_title,
      leadName: r.lead_name
    }));
  }

  saveRevenueAttributions(opportunityId, modelName, attributions, tid = 'default') {
    const now = new Date().toISOString();
    const insertStmt = this.sqlite.prepare(`
      INSERT INTO revenue_attributions (
        id, tenant_id, opportunity_id, lead_id, campaign_id, campaign_touch_id,
        touch_number, channel, model_name, attribution_weight, attributed_value,
        currency, touch_timestamp, calculated_at, created_at
      ) VALUES (
        @id, @tenant_id, @opportunity_id, @lead_id, @campaign_id, @campaign_touch_id,
        @touch_number, @channel, @model_name, @attribution_weight, @attributed_value,
        @currency, @touch_timestamp, @calculated_at, @created_at
      )
    `);

    const runTx = this.sqlite.transaction((records) => {
      this.sqlite.prepare('DELETE FROM revenue_attributions WHERE tenant_id = ? AND opportunity_id = ? AND model_name = ?')
        .run(tid, opportunityId, modelName);

      for (const rec of records) {
        insertStmt.run({
          id: rec.id || 'revattr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          tenant_id: tid,
          opportunity_id: opportunityId,
          lead_id: rec.leadId,
          campaign_id: rec.campaignId || null,
          campaign_touch_id: rec.campaignTouchId || null,
          touch_number: rec.touchNumber !== undefined ? rec.touchNumber : null,
          channel: rec.channel || 'OTHER',
          model_name: modelName,
          attribution_weight: rec.attributionWeight,
          attributed_value: rec.attributedValue,
          currency: rec.currency || 'INR',
          touch_timestamp: rec.touchTimestamp || now,
          calculated_at: now,
          created_at: now
        });
      }
    });

    runTx(attributions);
    return this.getRevenueAttributions(opportunityId, modelName, tid);
  }

  getRevenueAttributions(opportunityId, modelName, tid = 'default') {
    let sql = 'SELECT * FROM revenue_attributions WHERE tenant_id = ? AND opportunity_id = ?';
    const params = [tid, opportunityId];
    if (modelName) {
      sql += ' AND model_name = ?';
      params.push(modelName);
    }
    sql += ' ORDER BY touch_number ASC, touch_timestamp ASC';
    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => this._formatRevenueAttributionRecord(r));
  }

  getTenantRevenueMetrics(tid = 'default') {
    const totalWon = this.sqlite.prepare(`
      SELECT 
        COUNT(DISTINCT id) as closed_won_count,
        COALESCE(SUM(deal_value), 0.0) as total_won_revenue,
        currency
      FROM opportunities
      WHERE tenant_id = ? AND stage = 'CLOSED_WON'
      GROUP BY currency
    `).all(tid);

    const totalPipeline = this.sqlite.prepare(`
      SELECT 
        COUNT(DISTINCT id) as pipeline_deal_count,
        COALESCE(SUM(deal_value), 0.0) as total_pipeline_value,
        COALESCE(SUM(deal_value * confidence_probability), 0.0) as weighted_pipeline_value,
        currency
      FROM opportunities
      WHERE tenant_id = ? AND stage NOT IN ('CLOSED_WON', 'CLOSED_LOST')
      GROUP BY currency
    `).all(tid);

    const totalOpportunities = this.sqlite.prepare(`
      SELECT 
        COUNT(*) as total_count,
        SUM(CASE WHEN stage = 'CLOSED_WON' THEN 1 ELSE 0 END) as won_count,
        SUM(CASE WHEN stage = 'CLOSED_LOST' THEN 1 ELSE 0 END) as lost_count
      FROM opportunities
      WHERE tenant_id = ?
    `).get(tid) || { total_count: 0, won_count: 0, lost_count: 0 };

    const closedTotal = (totalOpportunities.won_count || 0) + (totalOpportunities.lost_count || 0);
    const winRate = closedTotal > 0 ? (totalOpportunities.won_count / closedTotal) : 0.0;

    return {
      totalWon,
      totalPipeline,
      totalOpportunities: totalOpportunities.total_count || 0,
      closedWonCount: totalOpportunities.won_count || 0,
      closedLostCount: totalOpportunities.lost_count || 0,
      winRate: parseFloat(winRate.toFixed(4))
    };
  }

  getChannelRevenueSummary(tid = 'default', modelName = 'LINEAR') {
    const rows = this.sqlite.prepare(`
      SELECT 
        channel,
        model_name,
        currency,
        COUNT(DISTINCT opportunity_id) as opportunity_count,
        ROUND(SUM(attributed_value), 2) as total_attributed_value,
        ROUND(SUM(attribution_weight), 4) as total_attribution_weight
      FROM revenue_attributions
      WHERE tenant_id = ? AND model_name = ?
      GROUP BY channel, currency
      ORDER BY total_attributed_value DESC
    `).all(tid, modelName);
    return rows;
  }

  getCampaignRevenueSummary(campaignId, tid = 'default', modelName = 'LINEAR') {
    const rows = this.sqlite.prepare(`
      SELECT 
        campaign_id,
        channel,
        currency,
        COUNT(DISTINCT opportunity_id) as opportunity_count,
        ROUND(SUM(attributed_value), 2) as total_attributed_value,
        ROUND(SUM(attribution_weight), 4) as total_attribution_weight
      FROM revenue_attributions
      WHERE tenant_id = ? AND campaign_id = ? AND model_name = ?
      GROUP BY channel, currency
    `).all(tid, campaignId, modelName);
    return rows;
  }

  _formatRevenueLedgerRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      opportunityId: row.opportunity_id,
      leadId: row.lead_id,
      amount: row.amount,
      currency: row.currency,
      recognizedAt: row.recognized_at,
      recognizedByOperator: row.recognized_by_operator,
      sourceAttributionModel: row.source_attribution_model,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {},
      createdAt: row.created_at
    };
  }

  _formatRevenueAttributionRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      opportunityId: row.opportunity_id,
      leadId: row.lead_id,
      campaignId: row.campaign_id,
      campaignTouchId: row.campaign_touch_id,
      touchNumber: row.touch_number,
      channel: row.channel,
      modelName: row.model_name,
      attributionWeight: row.attribution_weight,
      attributedValue: row.attributed_value,
      currency: row.currency,
      touchTimestamp: row.touch_timestamp,
      calculatedAt: row.calculated_at,
      createdAt: row.created_at
    };
  }

  // --- Step 11: Analytics & Decision Intelligence Methods ---

  saveDecisionSnapshot(snapshot, tid = 'default') {
    const id = snapshot.id || 'dsnap_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();
    const row = {
      id,
      tenant_id: tid,
      snapshot_type: snapshot.snapshotType,
      time_bucket: snapshot.timeBucket || now.substring(0, 10),
      dimensions: typeof snapshot.dimensions === 'object' ? JSON.stringify(snapshot.dimensions) : (snapshot.dimensions || '{}'),
      metrics: typeof snapshot.metrics === 'object' ? JSON.stringify(snapshot.metrics) : (snapshot.metrics || '{}'),
      recommendations: Array.isArray(snapshot.recommendations) ? JSON.stringify(snapshot.recommendations) : (snapshot.recommendations || '[]'),
      created_at: now
    };

    this.sqlite.prepare(`
      INSERT INTO decision_intelligence_snapshots (
        id, tenant_id, snapshot_type, time_bucket, dimensions, metrics, recommendations, created_at
      ) VALUES (
        @id, @tenant_id, @snapshot_type, @time_bucket, @dimensions, @metrics, @recommendations, @created_at
      )
    `).run(row);

    return this.getDecisionSnapshot(id, tid);
  }

  getDecisionSnapshot(id, tid = 'default') {
    const row = this.sqlite.prepare('SELECT * FROM decision_intelligence_snapshots WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      snapshotType: row.snapshot_type,
      timeBucket: row.time_bucket,
      dimensions: JSON.parse(row.dimensions || '{}'),
      metrics: JSON.parse(row.metrics || '{}'),
      recommendations: JSON.parse(row.recommendations || '[]'),
      createdAt: row.created_at
    };
  }

  getDecisionSnapshots(snapshotType, tid = 'default', limit = 20) {
    let sql = 'SELECT * FROM decision_intelligence_snapshots WHERE tenant_id = ?';
    const params = [tid];
    if (snapshotType) {
      sql += ' AND snapshot_type = ?';
      params.push(snapshotType);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.sqlite.prepare(sql).all(...params);
    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenant_id,
      snapshotType: r.snapshot_type,
      timeBucket: r.time_bucket,
      dimensions: JSON.parse(r.dimensions || '{}'),
      metrics: JSON.parse(r.metrics || '{}'),
      recommendations: JSON.parse(r.recommendations || '[]'),
      createdAt: r.created_at
    }));
  }

  getOpportunitiesWithStageDurations(tid = 'default') {
    const rows = this.sqlite.prepare(`
      SELECT 
        o.id,
        o.tenant_id,
        o.title,
        o.lead_id,
        l.businessName as lead_name,
        o.deal_value,
        o.currency,
        o.stage,
        o.confidence_probability,
        o.assigned_operator_id,
        o.created_at,
        o.updated_at,
        COALESCE(
          (SELECT MAX(created_at) FROM opportunity_stage_history osh WHERE osh.opportunity_id = o.id AND osh.new_stage = o.stage),
          o.created_at
        ) as stage_entered_at
      FROM opportunities o
      LEFT JOIN leads l ON o.lead_id = l.id
      WHERE o.tenant_id = ?
      ORDER BY o.updated_at DESC
    `).all(tid);
    return rows;
  }

  getCohortLeadFunnelData(tid = 'default') {
    const rows = this.sqlite.prepare(`
      SELECT 
        l.segment,
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT li.id) as enriched_leads,
        SUM(CASE WHEN l.leadStatus NOT IN ('New', '') THEN 1 ELSE 0 END) as contacted_leads,
        COUNT(DISTINCT o.id) as opportunity_count,
        SUM(CASE WHEN o.stage = 'CLOSED_WON' THEN 1 ELSE 0 END) as won_count,
        COALESCE(SUM(CASE WHEN o.stage = 'CLOSED_WON' THEN o.deal_value ELSE 0 END), 0.0) as won_revenue
      FROM leads l
      LEFT JOIN lead_intelligence li ON l.id = li.lead_id AND li.tenant_id = l.tenant_id
      LEFT JOIN opportunities o ON l.id = o.lead_id AND o.tenant_id = l.tenant_id
      WHERE l.tenant_id = ?
      GROUP BY l.segment
      ORDER BY total_leads DESC
    `).all(tid);
    return rows;
  }

  getLossReasonDistribution(tid = 'default') {
    const rows = this.sqlite.prepare(`
      SELECT 
        COALESCE(loss_reason_code, 'UNSPECIFIED') as loss_reason_code,
        currency,
        COUNT(*) as loss_count,
        ROUND(SUM(deal_value), 2) as total_lost_value,
        ROUND(AVG(deal_value), 2) as avg_lost_deal_value
      FROM opportunities
      WHERE tenant_id = ? AND stage = 'CLOSED_LOST'
      GROUP BY loss_reason_code, currency
      ORDER BY total_lost_value DESC
    `).all(tid);
    return rows;
  }
}

export const db = new SQLiteDatabase();
