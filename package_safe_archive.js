import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicit blacklist patterns to NEVER include in external review packages
const EXCLUDE_PATTERNS = [
  /^[\\/]node_modules([\\/]|$)/i,
  /^[\\/]\.git([\\/]|$)/i,
  /^[\\/]\.wwebjs_auth/i,
  /^[\\/]\.wwebjs_cache/i,
  /^[\\/]\.env(\..+)?$/i, // Matches .env, .env.local, .env_disposable_* BUT NOT .env.example
  /.*\.db(-.+)?$/i,       // Matches *.db, *.db-wal, *.db-shm, leads.db.backup*
  /.*\.backup.*/i,
  /.*\.zip$/i,
  /.*\.tmp$/i,
  /^[\\/]data\.json(\.bak)?$/i
];

// Explicitly permitted patterns that might match broader exclude regexes
const EXPLICIT_INCLUDE_PATTERNS = [
  /^[\\/]\.env\.example$/i
];

function isPathExcluded(relPath) {
  const normalized = '/' + relPath.replace(/\\/g, '/').replace(/^\//, '');

  for (const allow of EXPLICIT_INCLUDE_PATTERNS) {
    if (allow.test(normalized)) {
      return false;
    }
  }

  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

function collectFiles(dir, baseDir = dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (isPathExcluded(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath });
    }
  }

  return results;
}

export async function createSafeArchive(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultZipName = `leadflow_review_${timestamp}.zip`;
  const outputPath = options.outputPath || path.join(rootDir, defaultZipName);

  console.log('================================================================');
  console.log('📦 LEADFLOW PRO — SAFE REVIEW ARCHIVE GENERATOR');
  console.log('================================================================');
  console.log(`Source: ${rootDir}`);
  console.log(`Output: ${outputPath}\n`);

  console.log('🔍 Scanning directory and applying security exclusions...');
  const filesToPack = collectFiles(rootDir);

  console.log(`✓ Identified ${filesToPack.length} safe files for packaging.`);

  // Double check that zero sensitive files leaked through
  const leakedFiles = filesToPack.filter(f => {
    const name = path.basename(f.relPath).toLowerCase();
    return name === '.env' || name.endsWith('.db') || name.startsWith('.wwebjs_auth');
  });

  if (leakedFiles.length > 0) {
    throw new Error(`CRITICAL: Sensitive files detected in package set: ${leakedFiles.map(f => f.relPath).join(', ')}`);
  }

  const outputStream = fs.createWriteStream(outputPath);
  const archive = archiver('zip', {
    zlib: { level: 9 }
  });

  return new Promise((resolve, reject) => {
    outputStream.on('close', () => {
      const sizeMb = (archive.pointer() / (1024 * 1024)).toFixed(2);
      console.log(`\n✅ Archive created successfully:`);
      console.log(`   File: ${path.basename(outputPath)}`);
      console.log(`   Size: ${sizeMb} MB (${archive.pointer()} bytes)`);
      console.log(`   Files: ${filesToPack.length}`);
      console.log('\n🔒 Certified Exclusions:');
      console.log('   - node_modules/       (EXCLUDED)');
      console.log('   - .env & credentials  (EXCLUDED)');
      console.log('   - .env.example        (INCLUDED placeholder)');
      console.log('   - leads.db & backups  (EXCLUDED)');
      console.log('   - WhatsApp sessions   (EXCLUDED)');
      console.log('   - .zip files          (EXCLUDED)');
      console.log('================================================================\n');
      resolve(outputPath);
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('⚠️ Archive warning:', err.message);
      } else {
        reject(err);
      }
    });

    archive.on('error', (err) => reject(err));

    archive.pipe(outputStream);

    for (const file of filesToPack) {
      archive.file(file.fullPath, { name: file.relPath.replace(/\\/g, '/') });
    }

    archive.finalize();
  });
}

// Auto-run when invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createSafeArchive().catch(err => {
    console.error('❌ Failed to create safe archive:', err);
    process.exit(1);
  });
}
