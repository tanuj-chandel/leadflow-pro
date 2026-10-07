import path from 'path';
import fs from 'fs';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERIFICATION_SCRIPTS = [
  'verify_step9b_foundation.js',
  'verify_step9c_booking_bridge.js',
  'verify_step9_comprehensive.js',
  'verify_step10_revenue_attribution.js',
  'verify_step11_decision_intelligence.js',
  'verify_step12_production_certification.js',
  'verify_messaging_resilience.js',
  'verify_credentials_env_isolation.js'
];

async function main() {
  const isProdOptIn = process.argv.includes('--production') || 
                      process.argv.includes('--allow-live') || 
                      process.argv.includes('--live') || 
                      process.env.ALLOW_LIVE_DB === 'true';

  let targetDbPath;
  let targetEnvPath = null;
  let isDisposable = false;

  console.log('================================================================');
  console.log('🛡️  LEADFLOW PRO — MASTER VERIFICATION & TEST SUITE RUNNER');
  console.log('================================================================');

  if (isProdOptIn) {
    targetDbPath = DEFAULT_DB_PATH;
    console.warn('\n⚠️  [WARNING: PRODUCTION MODE] Explicit --production flag supplied.');
    console.warn(`    Tests will execute against LIVE database: ${targetDbPath}`);
    console.warn('    Safety invariants and cleanup teardowns will run automatically.\n');
  } else {
    isDisposable = true;
    targetDbPath = createDisposableDatabase(DEFAULT_DB_PATH);
    targetEnvPath = createDisposableEnvFile();
    console.log(`\n🔒 [SAFE DISPOSABLE MODE (DEFAULT)]`);
    console.log(`    Cloned live database to isolated sandbox: ${path.basename(targetDbPath)}`);
    if (targetEnvPath) {
      console.log(`    Cloned .env to isolated sandbox: ${path.basename(targetEnvPath)}`);
    }
    console.log('    Zero test writes will touch your production leads.db or .env.');
    console.log('    (To test live database, explicitly supply: npm test -- --production)\n');
  }

  const results = [];
  let allPassed = true;
  const suiteStartTime = Date.now();

  try {
    for (let i = 0; i < VERIFICATION_SCRIPTS.length; i++) {
      const scriptName = VERIFICATION_SCRIPTS[i];
      const scriptPath = path.join(__dirname, scriptName);

      if (!fs.existsSync(scriptPath)) {
        console.error(`❌ Script not found: ${scriptName}`);
        results.push({ script: scriptName, status: 'NOT FOUND', durationMs: 0 });
        allPassed = false;
        continue;
      }

      console.log(`\n▶️  [${i + 1}/${VERIFICATION_SCRIPTS.length}] Executing ${scriptName}...`);
      const startTime = Date.now();

      const proc = spawnSync(process.execPath, [scriptPath], {
        cwd: __dirname,
        env: {
          ...process.env,
          SQLITE_PATH: targetDbPath,
          ...(targetEnvPath ? { ENV_PATH: targetEnvPath } : {})
        },
        stdio: 'inherit'
      });

      const durationMs = Date.now() - startTime;
      const passed = proc.status === 0;
      if (!passed) allPassed = false;

      results.push({
        script: scriptName,
        status: passed ? 'PASSED' : 'FAILED',
        durationMs,
        exitCode: proc.status
      });
    }
  } finally {
    console.log('\n----------------------------------------------------------------');
    console.log('🧹 [SUITE TEARDOWN & RECOVERY]');
    if (isDisposable) {
      cleanupDisposableDatabase(targetDbPath);
      console.log(`  ✓ Destroyed disposable sandbox: ${path.basename(targetDbPath)}`);
      if (targetEnvPath) {
        cleanupDisposableEnvFile(targetEnvPath);
        console.log(`  ✓ Destroyed disposable env sandbox: ${path.basename(targetEnvPath)}`);
      }
    } else {
      console.log('  Purging test artifacts from live database...');
      cleanupTestArtifacts(targetDbPath, { verbose: true });
    }
    console.log('----------------------------------------------------------------\n');
  }

  const totalDuration = ((Date.now() - suiteStartTime) / 1000).toFixed(2);

  console.log('================================================================');
  console.log(`MASTER VERIFICATION RESULTS (${allPassed ? '✅ ALL SUITES PASSED' : '❌ SOME SUITES FAILED'})`);
  console.log('================================================================');
  results.forEach(r => {
    const icon = r.status === 'PASSED' ? '✅' : '❌';
    console.log(`  ${icon} ${r.script.padEnd(45)} [${r.status}] (${(r.durationMs / 1000).toFixed(2)}s)`);
  });
  console.log('================================================================');
  console.log(`Total Execution Time: ${totalDuration}s`);
  console.log('Target Environment: ' + (isDisposable ? 'Disposable Sandbox (Cleaned)' : 'Production (Purged & Verified)'));
  console.log('================================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
