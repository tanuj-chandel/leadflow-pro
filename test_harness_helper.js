import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { 
  DEFAULT_DB_PATH, 
  createDisposableDatabase, 
  cleanupDisposableDatabase, 
  createDisposableEnvFile,
  cleanupDisposableEnvFile,
  cleanupTestArtifacts 
} from './cleanup_test_data.js';

/**
 * Initializes the test database environment.
 * If running directly without SQLITE_PATH and without explicit --production/--allow-live flag,
 * this function transparently spawns a child process backed by an isolated disposable clone.
 */
export function initTestDatabase(callerUrl) {
  const isProdOptIn = process.argv.includes('--production') || 
                      process.argv.includes('--allow-live') || 
                      process.argv.includes('--live') || 
                      process.env.ALLOW_LIVE_DB === 'true';

  if (!process.env.SQLITE_PATH && !isProdOptIn) {
    const tempDb = createDisposableDatabase(DEFAULT_DB_PATH);
    const tempEnv = createDisposableEnvFile();
    const callerFile = fileURLToPath(callerUrl);
    console.log(`🛡️  [DISPOSABLE MODE] Running against isolated disposable clone: ${path.basename(tempDb)}`);
    console.log('    (Use --production or --allow-live to run against live leads.db)\n');

    let exitCode = 0;
    try {
      const result = spawnSync(process.execPath, [callerFile, ...process.argv.slice(2)], {
        env: { 
          ...process.env, 
          SQLITE_PATH: tempDb,
          ...(tempEnv ? { ENV_PATH: tempEnv } : {})
        },
        stdio: 'inherit'
      });
      exitCode = result.status ?? 0;
    } finally {
      cleanupDisposableDatabase(tempDb);
      if (tempEnv) cleanupDisposableEnvFile(tempEnv);
    }
    process.exit(exitCode);
  }

  const dbPath = process.env.SQLITE_PATH || DEFAULT_DB_PATH;
  const isDisposable = !!process.env.SQLITE_PATH && process.env.SQLITE_PATH.includes('_disposable_');

  if (isProdOptIn && !process.env.SQLITE_PATH) {
    console.warn(`⚠️  [CAUTION: PRODUCTION MODE] Explicit opt-in detected. Running directly against: ${dbPath}\n`);
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return { dbPath, sqlite, isDisposable };
}

/**
 * Robust teardown function that wipes test data across all tables
 */
export function performCompleteTeardown(sqlite, specificTenants = [], specificLeadIds = []) {
  if (!sqlite) return;

  try {
    sqlite.transaction(() => {
      sqlite.pragma('foreign_keys = OFF');

      // Purge specific tenants
      const allTenants = Array.from(new Set(specificTenants.filter(Boolean)));
      if (allTenants.length > 0) {
        const placeholders = allTenants.map(() => '?').join(',');
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        for (const t of tables) {
          const cols = sqlite.prepare(`PRAGMA table_info(${t.name})`).all();
          if (cols.some(c => c.name === 'tenant_id')) {
            sqlite.prepare(`DELETE FROM ${t.name} WHERE tenant_id IN (${placeholders})`).run(...allTenants);
          }
        }
      }

      // Purge specific lead IDs
      const allLeadIds = Array.from(new Set(specificLeadIds.filter(Boolean)));
      if (allLeadIds.length > 0) {
        const placeholders = allLeadIds.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM opportunities WHERE lead_id IN (${placeholders})`).run(...allLeadIds);
        sqlite.prepare(`DELETE FROM conversations WHERE lead_id IN (${placeholders})`).run(...allLeadIds);
        sqlite.prepare(`DELETE FROM lead_contacts WHERE lead_id IN (${placeholders})`).run(...allLeadIds);
        sqlite.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...allLeadIds);
      }

      sqlite.pragma('foreign_keys = ON');
    })();

    // Always run general artifact purge as final safeguard
    cleanupTestArtifacts(sqlite, { verbose: false });
  } catch (err) {
    console.warn('⚠️ Teardown warning:', err.message);
  }
}

/**
 * Asserts production database baseline invariants
 */
export function assertProductionBaselineInvariants(sqlite, options = {}) {
  const defaultLeads = sqlite.prepare("SELECT count(*) as c FROM leads WHERE tenant_id = 'default'").get().c;
  const totalLeads = sqlite.prepare("SELECT count(*) as c FROM leads").get().c;
  const totalEvidence = sqlite.prepare("SELECT count(*) as c FROM lead_evidence").get().c;
  const totalSnapshots = sqlite.prepare("SELECT count(*) as c FROM campaign_approved_snapshots").get().c;
  const integrity = sqlite.pragma('integrity_check')[0].integrity_check;
  const fkViolations = sqlite.pragma('foreign_key_check').length;
  const walMode = sqlite.pragma('journal_mode')[0].journal_mode;

  if (options.verbose) {
    console.log('   Production Baseline Invariants:');
    console.log(`     Default Leads: ${defaultLeads} (expected: 145)`);
    console.log(`     Total Leads: ${totalLeads} (expected: 145)`);
    console.log(`     Lead Evidence: ${totalEvidence} (expected: 175)`);
    console.log(`     Approved Snapshots: ${totalSnapshots} (expected: 40)`);
    console.log(`     PRAGMA integrity_check: ${integrity}`);
    console.log(`     PRAGMA foreign_key_check: ${fkViolations} violations`);
    console.log(`     Journal Mode: ${walMode}`);
  }

  assert.strictEqual(defaultLeads, 145, `Default leads must be 145, got ${defaultLeads}`);
  assert.strictEqual(totalLeads, 145, `Total leads must be 145 with zero test leakage, got ${totalLeads}`);
  assert.strictEqual(totalEvidence, 175, `Lead evidence must be 175, got ${totalEvidence}`);
  assert.strictEqual(totalSnapshots, 40, `Approved snapshots must be 40, got ${totalSnapshots}`);
  assert.strictEqual(integrity, 'ok', `Database integrity must be ok, got ${integrity}`);
  assert.strictEqual(fkViolations, 0, `Foreign key violations must be 0, got ${fkViolations}`);
  assert.strictEqual(walMode.toLowerCase(), 'wal', `Journal mode must be WAL, got ${walMode}`);

  return true;
}
