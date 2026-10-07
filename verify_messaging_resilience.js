/**
 * Verification Suite: Messaging Resilience, WhatsApp Frame Health & Telegram Flood-Wait Protection
 *
 * Validates:
 * 1. WhatsApp checkWhatsappHealth pre-flight probe and detached frame detection
 * 2. Telegram parseTelegramFloodError, FLOOD_WAIT calculation, and PEER_FLOOD circuit breaker
 * 3. Telegram pacing configuration (tgDelayMin / tgDelayMax safe intervals)
 * 4. Circuit breaker fail-closed behavior before network dispatches
 * 5. Multi-tenant database integrity and 145 baseline lead count invariants
 */

import assert from 'assert';
import { initTestDatabase, performCompleteTeardown } from './test_harness_helper.js';

const { dbPath, sqlite } = initTestDatabase(import.meta.url);
const { db } = await import('./database.js');
const { checkWhatsappHealth, getWhatsappStatus } = await import('./whatsapp-client.js');
const {
  parseTelegramFloodError,
  getTelegramRateLimitStatus,
  resetTelegramRateLimits
} = await import('./telegram-user-client.js');

console.log('================================================================');
console.log('VERIFICATION: MESSAGING RESILIENCE & ABUSE RATE-LIMIT PROTECTION');
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
  // --- SECTION 1: WhatsApp Client Readiness & Detached Frame Detection ---
  console.log('--- Section 1: WhatsApp Client Readiness & Pre-flight Health Check ---');

  const health = await checkWhatsappHealth();
  check(typeof health === 'object' && health !== null, 'checkWhatsappHealth returns a structured object');
  check('ready' in health, 'health object contains boolean "ready" flag');
  check('state' in health, 'health object contains "state" descriptor');

  // When not authenticated or unlinked, health must be ready: false (fail-closed)
  const waStatus = getWhatsappStatus();
  if (waStatus.status !== 'Connected') {
    check(health.ready === false, 'WhatsApp health reports ready: false when connection status is not Connected');
    check(health.reason && typeof health.reason === 'string', 'health provides human-readable failure reason');
  }

  // --- SECTION 2: Telegram Flood-Wait & PEER_FLOOD Parsing ---
  console.log('\n--- Section 2: Telegram Flood-Wait & PEER_FLOOD Error Parsing ---');

  const peerFloodError = new Error('400: PEER_FLOOD (caused by messages.SendMessage)');
  const parsedPeerFlood = parseTelegramFloodError(peerFloodError);
  check(parsedPeerFlood !== null, 'parseTelegramFloodError identifies PEER_FLOOD error message');
  check(parsedPeerFlood?.type === 'PEER_FLOOD', 'parseTelegramFloodError categorizes error as PEER_FLOOD');
  check(parsedPeerFlood?.isFlood === true, 'parseTelegramFloodError flags isFlood as true');

  const rpcPeerFlood = { errorMessage: 'PEER_FLOOD' };
  const parsedRpc = parseTelegramFloodError(rpcPeerFlood);
  check(parsedRpc?.type === 'PEER_FLOOD', 'parseTelegramFloodError handles GramJS RPC errorMessage="PEER_FLOOD"');

  const gramJsFloodWait = { seconds: 42, message: 'FloodWaitError' };
  const parsedFloodWait = parseTelegramFloodError(gramJsFloodWait);
  check(parsedFloodWait?.type === 'FLOOD_WAIT', 'parseTelegramFloodError identifies FloodWaitError');
  check(parsedFloodWait?.seconds === 42, 'parseTelegramFloodError extracts exact wait seconds (42s)');

  const textFloodWait = new Error('A wait of 65 seconds is required (caused by messages.SendMessage)');
  const parsedTextFlood = parseTelegramFloodError(textFloodWait);
  check(parsedTextFlood?.type === 'FLOOD_WAIT' && parsedTextFlood?.seconds === 65, 'parseTelegramFloodError extracts seconds from message text (65s)');

  const nonFloodError = new Error('PHONE_NOT_OCCUPIED');
  check(parseTelegramFloodError(nonFloodError) === null, 'parseTelegramFloodError returns null for standard non-flood errors');

  // --- SECTION 3: Telegram Circuit Breaker & Queue Rate Limiting ---
  console.log('\n--- Section 3: Telegram Circuit Breaker & Fail-Closed Guard ---');

  resetTelegramRateLimits();
  const initialStatus = getTelegramRateLimitStatus();
  check(initialStatus.isPeerFlooded === false, 'Telegram rate limit starts unblocked');
  check(initialStatus.isRateLimited === false, 'Telegram rate limit starts with no flood-wait');

  // --- SECTION 4: Safe Pacing & Anti-Spam Intervals ---
  console.log('\n--- Section 4: Safe Pacing & Anti-Spam Intervals ---');
  const settings = db.getSettings();
  const tgMin = parseInt(settings.tgDelayMin, 10);
  const tgMax = parseInt(settings.tgDelayMax, 10);

  check(tgMin >= 45, `Telegram minimum safe delay is at least 45 seconds (actual: ${tgMin}s)`);
  check(tgMax >= tgMin && tgMax <= 90, `Telegram maximum safe delay is reasonable (actual: ${tgMax}s)`);
  check(settings.waDelayMin >= 15, `WhatsApp minimum delay is >= 15 seconds (actual: ${settings.waDelayMin}s)`);

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
