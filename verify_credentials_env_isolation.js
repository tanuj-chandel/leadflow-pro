/**
 * Verification Suite: Credential Isolation & Environment Variable Security
 *
 * Validates:
 * 1. Zero sensitive keys stored in SQLite settings table (leads.db)
 * 2. Transparent retrieval of credentials from process.env via db.getSettings()
 * 3. db.updateSettings writes sensitive updates to .env / process.env and NEVER to SQLite
 * 4. .env.example contains documentation and placeholders for all 7 required env vars
 * 5. Database invariants (PRAGMA integrity_check = ok, foreign_key_check = 0, 145 baseline leads)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db, SENSITIVE_SETTING_KEYS } = await import('./database.js');

console.log('================================================================');
console.log('VERIFICATION: CREDENTIAL ISOLATION & ENV SECURITY');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

try {
  // --- SECTION 1: SQLite Settings Sanitization Check ---
  console.log('--- Section 1: SQLite Settings Sanitization ---');

  const row = sqlite.prepare('SELECT data FROM settings WHERE id = 1').get();
  assert(row, 'Settings row exists in SQLite table');
  const dbData = JSON.parse(row.data);

  const sensitiveKeys = [
    'placesApiKey',
    'openaiApiKey',
    'googleClientSecret',
    'googleTokens',
    'telegramBotToken',
    'telegramApiHash',
    'telegramUserSession'
  ];

  const leakedKeys = sensitiveKeys.filter(k => k in dbData);
  check(leakedKeys.length === 0, `SQLite settings table contains 0 sensitive credentials (leaked: ${leakedKeys.join(', ') || 'none'})`);

  // --- SECTION 2: Transparent Retrieval from process.env ---
  console.log('\n--- Section 2: Transparent Retrieval via db.getSettings() ---');

  const settings = db.getSettings();
  assert(typeof settings === 'object', 'db.getSettings() returns settings object');

  // Verify all 7 keys are accessible on the settings object
  for (const k of sensitiveKeys) {
    const envVar = SENSITIVE_SETTING_KEYS[k];
    const expectedVal = process.env[envVar] || '';
    if (k === 'googleTokens') {
      const expectedObj = expectedVal ? JSON.parse(expectedVal) : null;
      check(JSON.stringify(settings[k]) === JSON.stringify(expectedObj), `settings.${k} accurately reflects process.env.${envVar}`);
    } else {
      check(settings[k] === expectedVal, `settings.${k} accurately reflects process.env.${envVar}`);
    }
  }

  // --- SECTION 3: updateSettings Never Leaks into SQLite ---
  console.log('\n--- Section 3: Safe updateSettings() Behavior ---');

  const targetEnvPath = process.env.ENV_PATH || path.join(process.cwd(), '.env');
  const originalEnvContent = fs.existsSync(targetEnvPath) ? fs.readFileSync(targetEnvPath, 'utf8') : null;
  const originalMemoryBotToken = process.env.TELEGRAM_BOT_TOKEN;

  try {
    const testTokenVal = 'test_token_' + Date.now();
    db.updateSettings({ telegramBotToken: testTokenVal });

    // 1. In-memory check
    check(process.env.TELEGRAM_BOT_TOKEN === testTokenVal, 'updateSettings immediately updates process.env in memory');
    check(db.getSettings().telegramBotToken === testTokenVal, 'db.getSettings() immediately returns updated credential');

    // 2. Direct SQLite inspection: Must NOT contain telegramBotToken
    const updatedRow = sqlite.prepare('SELECT data FROM settings WHERE id = 1').get();
    const updatedDbData = JSON.parse(updatedRow.data);
    check(!('telegramBotToken' in updatedDbData), 'SQLite settings JSON does NOT contain telegramBotToken after update');
  } finally {
    // Exact restoration of original .env content and process.env
    if (originalEnvContent !== null) {
      fs.writeFileSync(targetEnvPath, originalEnvContent, 'utf8');
    }
    if (originalMemoryBotToken !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = originalMemoryBotToken;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  }

  // --- SECTION 4: .env.example Documentation Check ---
  console.log('\n--- Section 4: .env.example Template Documentation ---');

  const examplePath = path.join(process.cwd(), '.env.example');
  check(fs.existsSync(examplePath), '.env.example file exists');

  const exampleContent = fs.readFileSync(examplePath, 'utf8');
  const requiredEnvVars = [
    'PLACES_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_TOKENS',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_API_HASH',
    'TELEGRAM_USER_SESSION'
  ];

  for (const envVar of requiredEnvVars) {
    const hasVar = exampleContent.includes(envVar + '=');
    check(hasVar, `.env.example documents placeholder for ${envVar}`);
  }

  // Ensure no real API keys leaked into .env.example
  check(!exampleContent.includes('AIzaSy'), '.env.example does not leak live Google API keys');
  check(!exampleContent.includes('sk-proj'), '.env.example does not leak live OpenAI keys');
  check(!exampleContent.includes('GOCSPX'), '.env.example does not leak live Google Client Secrets');

  // --- SECTION 5: Database Health & Baseline Invariants ---
  console.log('\n--- Section 5: Database Health & Baseline Invariants ---');

  const integrity = sqlite.pragma('integrity_check');
  check(integrity[0].integrity_check === 'ok', 'PRAGMA integrity_check returns ok');

  const fkCheck = sqlite.pragma('foreign_key_check');
  check(fkCheck.length === 0, `PRAGMA foreign_key_check returns 0 violations (actual: ${fkCheck.length})`);

  const totalLeads = sqlite.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  check(totalLeads === 145, `Authoritative baseline lead count is preserved at exactly 145 (actual: ${totalLeads})`);

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} / ${passed + failed} TESTS PASSED (${failed} FAILURES)`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
} finally {
  performCompleteTeardown(sqlite, [], []);
}
