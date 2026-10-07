import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_DB_PATH = process.env.SQLITE_PATH || 
  (fs.existsSync(path.join(__dirname, 'leads.db')) ? path.join(__dirname, 'leads.db') : path.join(process.cwd(), 'leads.db'));

/**
 * Creates an isolated disposable copy of the database for safe test execution
 */
export function createDisposableDatabase(sourceDbPath = DEFAULT_DB_PATH, prefix = 'leads_disposable') {
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database not found at ${sourceDbPath}`);
  }

  const dir = path.dirname(sourceDbPath);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tempFileName = `${prefix}_${Date.now()}_${randomSuffix}.db`;
  const tempDbPath = path.join(dir, tempFileName);

  // Copy primary DB file
  fs.copyFileSync(sourceDbPath, tempDbPath);

  // If WAL / SHM files exist, ensure checkpoint or clean state
  const tempDb = new Database(tempDbPath);
  try {
    tempDb.pragma('journal_mode = WAL');
    tempDb.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    tempDb.close();
  }

  return tempDbPath;
}

/**
 * Removes a disposable database and any associated WAL/SHM artifacts
 */
export function cleanupDisposableDatabase(tempDbPath) {
  if (!tempDbPath || !tempDbPath.includes('_disposable_')) {
    // Safety check: Never delete a non-disposable database path
    return false;
  }

  const filesToDelete = [
    tempDbPath,
    `${tempDbPath}-wal`,
    `${tempDbPath}-shm`
  ];

  for (const file of filesToDelete) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        // Silently retry or log non-fatal error
      }
    }
  }
  return true;
}

/**
 * Creates an isolated disposable copy of .env for safe test execution
 */
export function createDisposableEnvFile(sourceEnvPath = path.join(process.cwd(), '.env'), prefix = '.env_disposable') {
  const dir = path.dirname(sourceEnvPath);
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tempEnvPath = path.join(dir, `${prefix}_${Date.now()}_${randomSuffix}`);

  if (fs.existsSync(sourceEnvPath)) {
    fs.copyFileSync(sourceEnvPath, tempEnvPath);
  } else {
    fs.writeFileSync(tempEnvPath, '', 'utf8');
  }

  return tempEnvPath;
}

/**
 * Safely removes a disposable .env copy
 */
export function cleanupDisposableEnvFile(tempEnvPath) {
  if (!tempEnvPath || !tempEnvPath.includes('_disposable_')) {
    return false;
  }
  if (fs.existsSync(tempEnvPath)) {
    try {
      fs.unlinkSync(tempEnvPath);
    } catch (_) {}
  }
  return true;
}

/**
 * Deletes all test tenant residue across every table in the database
 */
export function cleanupTestArtifacts(dbOrPath = DEFAULT_DB_PATH, options = {}) {
  const verbose = options.verbose ?? false;
  const isExistingInstance = typeof dbOrPath === 'object' && dbOrPath !== null && typeof dbOrPath.prepare === 'function';

  let sqlite;
  let shouldClose = false;

  if (isExistingInstance) {
    sqlite = dbOrPath;
  } else {
    if (!fs.existsSync(dbOrPath)) {
      throw new Error(`Database not found at ${dbOrPath}`);
    }
    sqlite = new Database(dbOrPath);
    sqlite.pragma('journal_mode = WAL');
    shouldClose = true;
  }

  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

  // Test tenant filter condition
  const testTenantCondition = `
    tenant_id LIKE 'test_%' 
    OR tenant_id LIKE '%_test%' 
    OR tenant_id LIKE 'tenant_prod_cert_%' 
    OR tenant_id = 'attacker_tenant_xyz'
    OR tenant_id LIKE 'cert_tenant_%'
    OR tenant_id LIKE 'tenant_step%'
    OR tenant_id LIKE 'tenant_recipient_%'
    OR tenant_id LIKE 'tenant_quota_%'
    OR tenant_id LIKE 'tenant_b%'
    OR tenant_id LIKE 'tenant_a%'
    OR tenant_id LIKE 'tenant_foreign_%'
    OR tenant_id LIKE 'mock_tenant_%'
  `;

  if (verbose) {
    const targetLabel = isExistingInstance ? 'Active DB Instance' : dbOrPath;
    console.log(`\n🧹 [CLEANUP] Starting test artifact purge on: ${targetLabel}`);
  }

  let totalDeleted = 0;
  const deletedByTable = {};

  sqlite.transaction(() => {
    // Disable FKs during bulk delete to avoid ordering deadlocks
    sqlite.pragma('foreign_keys = OFF');

    for (const t of tables) {
      const cols = sqlite.prepare(`PRAGMA table_info(${t.name})`).all();
      const hasTenant = cols.some(c => c.name === 'tenant_id');
      if (hasTenant) {
        const countBefore = sqlite.prepare(`SELECT COUNT(*) as c FROM ${t.name} WHERE ${testTenantCondition}`).get().c;
        if (countBefore > 0) {
          const res = sqlite.prepare(`DELETE FROM ${t.name} WHERE ${testTenantCondition}`).run();
          deletedByTable[t.name] = res.changes;
          totalDeleted += res.changes;
          if (verbose) {
            console.log(`  - Deleted ${res.changes} test row(s) from "${t.name}"`);
          }
        }
      }
    }

    // Additional specific non-tenant_id cleanup for leads created with default tenant
    const testLeadCleanup = sqlite.prepare(`
      DELETE FROM leads WHERE id LIKE 'lead_test_%' OR id LIKE 'test_%'
    `).run();
    if (testLeadCleanup.changes > 0) {
      totalDeleted += testLeadCleanup.changes;
      deletedByTable['leads (test ids)'] = (deletedByTable['leads (test ids)'] || 0) + testLeadCleanup.changes;
    }

    // Additional specific cleanup for test campaigns created with default tenant
    // Matches %Test%, Cohort%, or Step % (EXCLUDING campaigns holding certified baseline snapshots)
    const testCampaignsCondition = `
      tenant_id = 'default' 
      AND id NOT IN (SELECT campaign_id FROM campaign_approved_snapshots WHERE campaign_id IS NOT NULL)
      AND (name LIKE '%Test%' OR name LIKE 'Cohort%' OR name LIKE 'Step %')
    `;

    const testCampaignRows = sqlite.prepare(`SELECT id, name FROM campaigns WHERE ${testCampaignsCondition}`).all();
    if (testCampaignRows.length > 0) {
      const campIds = testCampaignRows.map(r => r.id);
      const placeholders = campIds.map(() => '?').join(',');

      // Delete child records first to preserve clean FK state
      const childTables = [
        'campaign_execution_attempts',
        'campaign_execution_logs',
        'campaign_touches',
        'campaign_leads',
        'campaign_review_logs',
        'campaign_reconciliation_records',
        'campaign_claims',
        'revenue_attributions'
      ];

      for (const ct of childTables) {
        try {
          const res = sqlite.prepare(`DELETE FROM ${ct} WHERE campaign_id IN (${placeholders})`).run(...campIds);
          if (res.changes > 0) {
            totalDeleted += res.changes;
            deletedByTable[`${ct} (test campaign children)`] = (deletedByTable[`${ct} (test campaign children)`] || 0) + res.changes;
          }
        } catch (_) {}
      }

      const campRes = sqlite.prepare(`DELETE FROM campaigns WHERE id IN (${placeholders})`).run(...campIds);
      if (campRes.changes > 0) {
        totalDeleted += campRes.changes;
        deletedByTable['campaigns (default test pattern)'] = (deletedByTable['campaigns (default test pattern)'] || 0) + campRes.changes;
        if (verbose) {
          console.log(`  - Deleted ${campRes.changes} default-tenant test campaign(s): ${testCampaignRows.map(r => r.name).join(', ')}`);
        }
      }
    }

    sqlite.pragma('foreign_keys = ON');
  })();

  // Verify foreign keys and integrity
  const fkViolations = sqlite.pragma('foreign_key_check');
  if (fkViolations.length > 0) {
    console.error('❌ WARNING: Foreign key check failed after cleanup:', fkViolations);
    throw new Error(`Foreign key check failed after cleanup: ${JSON.stringify(fkViolations)}`);
  }

  const integrity = sqlite.pragma('integrity_check')[0].integrity_check;
  if (integrity !== 'ok') {
    throw new Error(`Integrity check failed after cleanup: ${integrity}`);
  }

  if (verbose) {
    console.log(`✅ [CLEANUP COMPLETE] Purged ${totalDeleted} test rows across ${Object.keys(deletedByTable).length} tables.`);
    console.log(`   Foreign Key Check: 0 violations. PRAGMA integrity_check: ok.\n`);
  }

  if (shouldClose) {
    sqlite.close();
  }

  return { totalDeleted, deletedByTable };
}

// CLI Execution
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  try {
    cleanupTestArtifacts(DEFAULT_DB_PATH, { verbose: true });
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
  }
}
