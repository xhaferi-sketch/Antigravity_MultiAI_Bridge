'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (_) {
  AdmZip = null;
}

const localExecutorModule = require('./local_executor');
const {
  createLocalExecutor,
  parseCodeBlocksFromMarkdown,
  computeCheckpointIdentity,
  parseCheckpointAudit,
  normalizeCheckpointTarget,
  isTargetVerifiedForCheckpoint,
  migrateLegacyCheckpointReceipts,
  appendBatchAudit,
  runBatchQuickChecks,
  applyBatch,
  runFinalBuildAndTests
} = localExecutorModule;

let defaultLocalExecutor = null;
function getDefaultLocalExecutor() {
  if (!defaultLocalExecutor) {
    defaultLocalExecutor = createLocalExecutor({
      ensureProjectSetup: function() { return { roles: {} }; }
    });
  }
  return defaultLocalExecutor;
}

function persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
  return getDefaultLocalExecutor().persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity);
}

function classifyAttachmentHandshakeStrict(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return { ok: false, code: 'BLANK' };
  if (/Lexo skedarin e bashkëngjitur|Mos shkruaj kod ende/i.test(normalized)) {
    return { ok: false, code: 'PROMPT_ECHO' };
  }
  const clean = normalized.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const positive = /(^|\b)(ok|e lexova|lexova|jam gati|gati|ready|received|read it|file received|attachment received)(\b|$)/i.test(clean);
  if (!positive) return { ok: false, code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED' };
  return { ok: true, code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED' };
}

function buildSearchAiCleanPrompt(mode) {
  if (mode === 'plan') {
    return 'Analizo arkitekturen dhe kerkesen e perdoruesit nga attachments/context. Kthe nje plan teknik ekzekutimi me seksionet: 1. OBJEKTIVAT DHE NON-GOALS, 2. ENTRY POINT DHE ROOT CAUSE, 3. ALLOWED_FILES, 4. SPECIFIKIMI SKEDAR MË SKEDAR (FILE-BY-FILE), 5. DEFINITION OF DONE & HARDENING TESTS. Sheno cdo skedar me FILE_TARGET: path.';
  }
  return 'Analizo kodin dhe kerkesen. Kthe zbatimin teknik te plote.';
}

function validatePlanOutput(text, opts) {
  opts = opts || {};
  const clean = String(text || '').replace(/\n?PLANI_PERFUNDOI_100\s*$/i, '').trim();
  if (clean.length < 250) return { ok: false, reason: 'TOO_SHORT', missing: ['minimum_length'] };
  const targetRegex = /^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)\s*$/gmi;
  const targets = [];
  let tm;
  while ((tm = targetRegex.exec(clean)) !== null) {
    const v = tm[1].trim().replace(/["'`*]/g, '');
    if (!targets.includes(v)) targets.push(v);
  }
  if (targets.some(function(x) { return /^(?:[a-z]:[\\/]|\\\\|\/)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(x); })) {
    return { ok: false, reason: 'UNSAFE_PATH', targets: targets };
  }
  return { ok: targets.length > 0, reason: targets.length > 0 ? '' : 'NO_TARGETS', targets: targets };
}

async function defaultRunGeminiAttachmentIngestHandshake(args) {
  return { status: 'VERIFIED' };
}

const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);

const PACK_MODES = Object.freeze({
  PLANNING_FULL: 'PLANNING_FULL',
  CODING_FOCUSED: 'CODING_FOCUSED',
  REVIEW_FOCUSED: 'REVIEW_FOCUSED',
  RETRY_COMPACT: 'RETRY_COMPACT'
});

const CHUNK_ENGINE_LIMITS = Object.freeze({
  repoMapSoft: 48 * 1024,
  repoMapHard: 64 * 1024,
  planningSafe: 240 * 1024,
  chunkSoft: 160 * 1024,
  chunkHard: 240 * 1024,
  summaryHard: 24 * 1024,
  batchSoft: 160 * 1024,
  batchHard: 192 * 1024,
  recoveryHard: 160 * 1024,
  contractPerBatch: 16 * 1024,
  contractCumulative: 64 * 1024,
  reviewSoft: 160 * 1024,
  reviewHard: 240 * 1024,
  maxBatchFiles: 2,
  testMaxFiles: 1,
  maxBatchTargetSourceBytes: 18 * 1024,
  maxHalvingLevel: 4,
  maxWebAnalysisChunks: 4,
  maxInlineChars: 12 * 1024,
  maxInlineBytes: 12 * 1024,
  batchMiniMapSoft: 8 * 1024
});

const TEXT_BUNDLE_DENIED_DIRECTORIES = new Set([
  '__pycache__', '.git', '.svn', '.hg', 'node_modules', 'bin', 'obj', 'dist',
  'build', 'coverage', '.cache', 'cache', 'tmp', 'temp', '.venv', 'venv'
]);

const TEXT_BUNDLE_DENIED_EXTENSIONS = new Set([
  '.pyc', '.pyo', '.pyd', '.dll', '.exe', '.com', '.msi', '.so', '.dylib', '.a',
  '.lib', '.o', '.obj', '.db', '.sqlite', '.sqlite3', '.mdb', '.zip', '.7z',
  '.rar', '.tar', '.gz', '.bz2', '.xz', '.png', '.jpg', '.jpeg', '.gif', '.bmp',
  '.webp', '.ico', '.tif', '.tiff', '.mp3', '.wav', '.flac', '.aac', '.ogg',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.pdf', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.class', '.jar', '.war', '.rvt', '.rfa', '.ifc', '.dwg', '.dxf'
]);

const ADAPTIVE_HALVING_CODES = new Set([
  'BATCH_OUTPUT_INCOMPLETE',
  'BATCH_TARGET_MISSING',
  'BATCH_OUTPUT_TRUNCATED',
  'BATCH_RESPONSE_BUDGET_EXCEEDED',
  'BATCH_PARSE_INCOMPLETE'
]);

function inspectTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  const total = buffer.length;
  const nulCount = buffer.reduce(function(n, b) { return n + (b === 0 ? 1 : 0); }, 0);
  const utf16Bom = total >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  let text = '', utf8Valid = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    utf8Valid = false;
  }
  let controlCount = 0;
  if (utf8Valid) {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if ((cp >= 1 && cp <= 8) || cp === 11 || (cp >= 14 && cp <= 31) || cp === 127) controlCount++;
    }
  }
  const isText = !utf16Bom && nulCount === 0 && utf8Valid && (total === 0 || (controlCount / total) < 0.05);
  return { isText: isText, utf8Valid: utf8Valid, nulCount: nulCount, controlCount: controlCount, total: total, text: isText ? text : '' };
}

function validateFinalTextArtifact(text, mode) {
  if (typeof text !== 'string') throw new Error('ARTIFACT_NOT_A_STRING: ' + mode);
  if (text.length === 0) throw new Error('EMPTY_ARTIFACT: ' + mode);
  return true;
}

function truncateUtf8(text, maxBytes) {
  if (typeof text !== 'string') text = String(text || '');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8');
}

function classifyWorkspaceFile(rel, meta) {
  meta = meta || {};
  const low = String(rel || '').replace(/\\/g, '/').toLowerCase(), ext = path.extname(low), segments = low.split('/');
  const source = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs', '.cs', '.php', '.rb', '.swift', '.cpp', '.c', '.h', '.hpp', '.vue', '.svelte', '.sql', '.sh', '.ps1']);
  const config = /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements[^/]*\.txt|[^/]*(?:lock|config)[^/]*)$/.test(low);
  const generated = segments.some(function(x) { return /^(logs?|reports?|outputs?|artifacts?|generated|caches?|tmp|temp|backups?|archive|exports?|coverage|dist|build|node_modules|venv|\.git)$/.test(x); }) || /(?:^|[_-])\d{4}[-_]\d{2}[-_]\d{2}(?:[_-]|\.)/.test(low);
  const binary = /\.(png|jpe?g|gif|webp|zip|pdf|mp4|mov|mp3|wav|exe|dll|so|bin)$/i.test(low);
  const runtime = /\.(json|csv|ndjson|log)$/i.test(low) && /(data|queue|history|session|state|dump|lead|runtime|report)/i.test(low);
  let tier = config ? 0 : source.has(ext) ? 1 : /(test|spec|docs?|readme|schema|migration)/i.test(low) ? 2 : 3;
  if (meta.explicitTarget || meta.errorReferenced || meta.entryPoint) tier = 0;
  return { tier: tier, sourceFile: source.has(ext), configFile: config, generatedSignal: generated, runtimeDataSignal: runtime, binary: binary };
}

function scoreWorkspaceFile(info) {
  const m = info.meta || {}, c = info.classification || classifyWorkspaceFile(info.rel, m);
  return (m.explicitTarget ? 10000 : 0) + (m.errorReferenced ? 8000 : 0) + (m.entryPoint ? 6000 : 0) + (m.importedByTarget ? 4000 : 0) + (c.sourceFile ? 2500 : 0) + (c.configFile ? 2200 : 0) + (m.testForTarget ? 1800 : 0) + (m.recentlyModifiedSource ? 400 : 0) - (c.generatedSignal ? 3000 : 0) - (c.runtimeDataSignal ? 2500 : 0) - (m.duplicateContent ? 5000 : 0) - Math.floor((info.size || 0) / 65536) * 100;
}

function compactWorkspaceContent(rel, content, maxBytes, classification) {
  const bytes = Buffer.byteLength(content);
  if (bytes <= maxBytes) return { text: content, summarized: false };
  const ext = path.extname(rel).toLowerCase(), lines = content.split(/\r?\n/);
  if (ext === '.json' || ext === '.csv' || ext === '.ndjson') {
    let summary = '[STRUCTURED DATA SUMMARY] ' + rel + ' bytes=' + bytes + ' rows=' + lines.length + NL;
    if (ext === '.json') {
      try {
        const v = JSON.parse(content);
        summary += 'type=' + (Array.isArray(v) ? 'array' : 'object') + ' keys=' + Object.keys(Array.isArray(v) ? (v[0] || {}) : v).slice(0, 40).join(',');
      } catch (_) {
        summary += 'invalid_or_streaming_json';
      }
    } else summary += 'columns=' + (lines[0] || '').slice(0, 1000);
    return { text: summary, summarized: true };
  }
  if (ext === '.log' || (classification && classification.runtimeDataSignal)) return { text: '[LOG TAIL] ' + rel + NL + lines.slice(-120).join(NL), summarized: true };
  if (/\.(md|txt|rst)$/i.test(ext)) {
    const headings = lines.filter(function(x) { return /^#{1,6}\s|^[A-Z][A-Z 0-9_-]{5,}$/.test(x); }).slice(0, 100);
    return { text: '[DOCUMENT OUTLINE] ' + rel + NL + headings.join(NL) + NL + '[TAIL]' + NL + lines.slice(-40).join(NL), summarized: true };
  }
  const half = Math.max(512, Math.floor(maxBytes / 2) - 100);
  return { text: Buffer.from(content).subarray(0, half).toString('utf8') + NL + '...[COMPACTED ' + (bytes - maxBytes) + ' BYTES]...' + NL + Buffer.from(content).subarray(-half).toString('utf8'), summarized: true };
}

function buildBudgetedWorkspaceBundle(projectRoot, opts) {
  opts = opts || {};
  const cleanRoot = fs.realpathSync(path.resolve(projectRoot));
  const mode = PACK_MODES[opts.mode] ? opts.mode : PACK_MODES.PLANNING_FULL;
  const budget = Math.min(512 * 1024, Math.max(4096, Number(opts.budgetBytes || 256 * 1024)));
  const targets = new Set((opts.explicitTargets || []).map(function(x) { return String(x).replace(/\\/g, '/'); }));
  const errors = new Set((opts.errorReferenced || []).map(function(x) { return String(x).replace(/\\/g, '/'); }));
  const files = [], excluded = [], hashes = new Map();
  let budgetReachedLogged = false, excludedBinaryExtensionCount = 0, excludedBinaryContentCount = 0, excludedInvalidUtf8Count = 0;

  function budgetReachedOnce() {
    if (!budgetReachedLogged) budgetReachedLogged = true;
  }

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort(function(a, b) { return a.name.localeCompare(b.name); })) {
      const full = path.join(dir, ent.name), rel = path.relative(cleanRoot, full).replace(/\\/g, '/');
      if (/[{}]/.test(rel) || rel.startsWith('../') || path.isAbsolute(rel)) {
        excluded.push({ rel: rel, reason: 'INVALID_PATH' });
        continue;
      }
      let real;
      try { real = fs.realpathSync(full); } catch (_) { excluded.push({ rel: rel, reason: 'UNRESOLVED' }); continue; }
      if (real !== cleanRoot && !real.startsWith(cleanRoot + path.sep)) { excluded.push({ rel: rel, reason: 'SYMLINK_ESCAPE' }); continue; }
      if (ent.isDirectory()) {
        const denied = rel.split('/').some(function(segment) { return TEXT_BUNDLE_DENIED_DIRECTORIES.has(segment.toLowerCase()); });
        if (denied && !targets.has(rel)) { excluded.push({ rel: rel, reason: 'GENERATED_DIRECTORY' }); continue; }
        walk(full);
        continue;
      }
      let st;
      try { st = fs.statSync(real); } catch (_) { continue; }
      if (!st.isFile()) { excluded.push({ rel: rel, reason: 'NON_REGULAR' }); continue; }
      const meta = { explicitTarget: targets.has(rel), errorReferenced: errors.has(rel), entryPoint: /(^|\/)(index|main|server|app)\.[^.]+$/i.test(rel), testForTarget: /test|spec/i.test(rel) };
      const classification = classifyWorkspaceFile(rel, meta), ext = path.extname(rel).toLowerCase();
      if (TEXT_BUNDLE_DENIED_EXTENSIONS.has(ext) || classification.binary) { excludedBinaryExtensionCount++; excluded.push({ rel: rel, reason: 'BINARY_EXTENSION' }); continue; }
      if (classification.generatedSignal && !meta.explicitTarget) { excluded.push({ rel: rel, reason: 'GENERATED' }); continue; }
      files.push({ full: real, rel: rel, size: st.size, meta: meta, classification: classification, score: scoreWorkspaceFile({ rel: rel, size: st.size, meta: meta, classification: classification }) });
    }
  }

  walk(cleanRoot);
  files.sort(function(a, b) { return b.score - a.score || a.rel.localeCompare(b.rel); });
  let out = ['=== BUDGETED WORKSPACE MANIFEST ===', 'mode=' + mode + ' budgetBytes=' + budget, 'tree=' + files.slice(0, 120).map(function(x) { return x.rel; }).join(' | '), ''].join(NL);
  const included = [], summarized = [], duplicates = [];

  for (const f of files) {
    let raw, content;
    try {
      raw = fs.readFileSync(f.full);
      const inspected = inspectTextBuffer(raw);
      if (!inspected.isText) {
        if (!inspected.utf8Valid) excludedInvalidUtf8Count++; else excludedBinaryContentCount++;
        excluded.push({ rel: f.rel, reason: inspected.utf8Valid ? 'BINARY_CONTENT' : 'INVALID_UTF8' });
        continue;
      }
      content = inspected.text;
    } catch (_) {
      excluded.push({ rel: f.rel, reason: 'READ_ERROR' });
      continue;
    }
    const h = crypto.createHash('sha256').update(raw).digest('hex');
    if (hashes.has(h)) {
      duplicates.push({ canonical: hashes.get(h), alias: f.rel });
      excluded.push({ rel: f.rel, reason: 'DUPLICATE' });
      continue;
    }
    hashes.set(h, f.rel);
    const remaining = budget - Buffer.byteLength(out) - 256;
    if (remaining < 256) {
      budgetReachedOnce();
      excluded.push({ rel: f.rel, reason: 'BUDGET' });
      continue;
    }
    const compact = compactWorkspaceContent(f.rel, content, Math.min(64 * 1024, remaining - 128), f.classification);
    const block = NL + '--- FILE: ' + f.rel + ' tier=' + f.classification.tier + ' score=' + f.score + (compact.summarized ? ' summarized=true' : '') + ' ---' + NL + compact.text + NL;
    if (Buffer.byteLength(out + block) > budget - 256) {
      excluded.push({ rel: f.rel, reason: 'BUDGET' });
      budgetReachedOnce();
      continue;
    }
    out += block;
    included.push(f.rel);
    if (compact.summarized) summarized.push(f.rel);
  }

  const footer = NL + '=== EXCLUSION SUMMARY ===' + NL + Object.entries(excluded.reduce(function(a, x) { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {})).map(function(x) { return x[0] + '=' + x[1]; }).join(' ') + NL + 'duplicates=' + duplicates.length;
  out += Buffer.byteLength(out + footer) <= budget ? footer : '';
  if (Buffer.byteLength(out) > budget || Buffer.byteLength(out) > 512 * 1024) throw new Error('PACK_BUDGET_INVARIANT_FAILED');
  validateFinalTextArtifact(out, mode);
  const missing = Array.from(targets).filter(function(x) { return !included.includes(x); });
  const receipt = {
    mode: mode,
    budgetBytes: budget,
    outputBytes: Buffer.byteLength(out),
    includedCount: included.length,
    excludedCount: excluded.length,
    summarizedCount: summarized.length,
    duplicateCount: duplicates.length,
    tiers: included.reduce(function(a, r) { const f = files.find(function(x) { return x.rel === r; }); a[f.classification.tier] = (a[f.classification.tier] || 0) + 1; return a; }, {}),
    topIncluded: included.slice(0, 20),
    topExcludedReasons: excluded.reduce(function(a, x) { a[x.reason] = (a[x.reason] || 0) + 1; return a; }, {}),
    targetsIncluded: Array.from(targets).filter(function(x) { return included.includes(x); }),
    targetsMissing: missing,
    manifestPath: 'project_bundle.txt',
    excludedBinaryExtensionCount: excludedBinaryExtensionCount,
    excludedBinaryContentCount: excludedBinaryContentCount,
    excludedInvalidUtf8Count: excludedInvalidUtf8Count,
    nulCount: 0,
    replacementCharacterCount: (out.match(/\ufffd/g) || []).length
  };
  return { content: out, receipt: receipt, files: included };
}

function packWorkspace(projectRoot, mode, opts) {
  opts = opts || {};
  const legacy = String(mode || 'FULL').toUpperCase();
  const mapped = PACK_MODES[mode] ? mode : (legacy === 'DELTA' ? PACK_MODES.CODING_FOCUSED : PACK_MODES.PLANNING_FULL);
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
  let targets = [], errorRefs = [];
  const plan = path.join(exchangeDir, 'plan.md'), err = path.join(exchangeDir, 'last_error.txt');
  if (fs.existsSync(plan)) {
    const txt = fs.readFileSync(plan, 'utf8');
    targets = Array.from(txt.matchAll(/^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)$/gmi)).map(function(m) { return m[1].trim().replace(/["'`*]/g, ''); });
  }
  if (fs.existsSync(err)) {
    const t = fs.readFileSync(err, 'utf8');
    errorRefs = Array.from(t.matchAll(/(?:^|\s)([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)(?::\d+)?/g)).map(function(m) { return m[1]; });
  }
  const built = buildBudgetedWorkspaceBundle(cleanRoot, { mode: mapped, explicitTargets: targets, errorReferenced: errorRefs });
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  validateFinalTextArtifact(built.content, mapped);
  fs.writeFileSync(txtPath, built.content, 'utf8');
  const zipPath = path.join(exchangeDir, 'project_bundle.zip');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');
  if (AdmZip) {
    try {
      const zip = new AdmZip();
      for (const rel of built.files) {
        try { zip.addFile(rel, fs.readFileSync(path.join(cleanRoot, rel))); } catch (_) {}
      }
      zip.writeZip(zipPath);
      fs.copyFileSync(zipPath, zipMdPath);
    } catch (_) {}
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(txtPath)).digest('hex');
  const routing = (opts.ensureProjectSetup ? opts.ensureProjectSetup(cleanRoot) : null) || {};
  return {
    bundlePath: routing.bundleFormat === 'zip.md' ? zipMdPath : txtPath,
    format: routing.bundleFormat || 'auto',
    fileCount: built.files.length,
    sha256: sha256,
    receipt: built.receipt
  };
}

function getBundleAttachmentAndNote(projectRoot, targetEngine, opts) {
  opts = opts || {};
  const routing = (opts.ensureProjectSetup ? opts.ensureProjectSetup(projectRoot) : null) || {};
  const exchangeDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'exchange');
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');

  const eng = String(targetEngine || '');
  const isGoogle = eng.startsWith('google_search_') || eng.startsWith('gemini');
  const useZipMd = !isGoogle && (eng.startsWith('web') || (routing.bundleFormat === 'zip.md'));

  if (useZipMd) {
    if (!fs.existsSync(zipMdPath)) packWorkspace(projectRoot, 'FULL', opts);
    const hash = fs.existsSync(zipMdPath) ? crypto.createHash('sha256').update(fs.readFileSync(zipMdPath)).digest('hex') : '';
    const note = NL + NL + 'UDHEZIM PER SKEDARIN (project_bundle.zip.md): Ky eshte arkiv binar real .zip (SHA-256: ' + hash + ') me prapashtesen .md per transport ne M365 Copilot Web. Hiq prapashtesen finale .md dhe hape si .zip normal.' + NL;
    return { path: zipMdPath, note: note };
  }

  if (!fs.existsSync(txtPath)) packWorkspace(projectRoot, 'FULL', opts);
  const txtNote = NL + NL + 'UDHEZIM: I gjithe kodi burimor i projektit eshte ne formatin tekst .txt (project_bundle.txt) i perfshire me poshte brenda ketij mesazhi.' + NL;
  return { path: txtPath, note: txtNote };
}

function normalizeBatchTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function inferRepositoryLanguage(rel) {
  const ext = path.extname(rel || '').toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (ext === '.py') return 'python';
  if (ext === '.json') return 'json';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  return ext ? ext.slice(1) : 'plain';
}

function extractRepositorySignals(rel, text) {
  const low = String(text || '').slice(0, 4096).toLowerCase();
  return {
    isServer: low.includes('express') || low.includes('fastify') || low.includes('createserver') || low.includes('flask') || low.includes('django'),
    isClient: low.includes('react') || low.includes('vue') || low.includes('angular') || low.includes('document.queryselector'),
    isTest: /test|spec|assert|describe|it\(/.test(low) || /test|spec/.test(rel.toLowerCase()),
    lines: (text.match(/\n/g) || []).length + 1
  };
}

function scanRepositoryUniversal(projectRoot) {
  const cleanRoot = fs.realpathSync(path.resolve(projectRoot));
  const files = [];
  const excluded = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(cleanRoot, full).replace(/\\/g, '/');
      if (/[{}]/.test(rel) || rel.startsWith('../') || path.isAbsolute(rel)) continue;
      let real;
      try { real = fs.realpathSync(full); } catch (_) { continue; }
      if (real !== cleanRoot && !real.startsWith(cleanRoot + path.sep)) continue;
      if (ent.isDirectory()) {
        const segs = rel.toLowerCase().split('/');
        if (segs.some(function(s) { return TEXT_BUNDLE_DENIED_DIRECTORIES.has(s); })) {
          excluded.push({ path: ent.name, rel: rel, reason: 'IGNORED_DIRECTORY' });
          continue;
        }
        walk(full);
        continue;
      }
      let st;
      try { st = fs.statSync(real); } catch (_) { continue; }
      if (!st.isFile()) continue;
      const ext = path.extname(rel).toLowerCase();
      if (TEXT_BUNDLE_DENIED_EXTENSIONS.has(ext)) {
        excluded.push({ path: ent.name, rel: rel, reason: 'DENIED_EXTENSION' });
        continue;
      }

      let raw;
      try { raw = fs.readFileSync(real); } catch (_) { continue; }
      const inspected = inspectTextBuffer(raw);
      if (!inspected.isText) {
        excluded.push({ path: ent.name, rel: rel, reason: 'BINARY_OR_INVALID_UTF8' });
        continue;
      }

      const classification = classifyWorkspaceFile(rel, {});
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      files.push({
        path: rel,
        bytes: st.size,
        hash: hash,
        language: inferRepositoryLanguage(rel),
        sourceScore: classification.sourceFile ? 1 : (classification.configFile ? 2 : 0),
        generatedScore: classification.generatedSignal ? 1 : 0
      });
    }
  }

  walk(cleanRoot);
  files.sort(function(a, b) { return a.path.localeCompare(b.path); });
  const repoFingerprint = crypto.createHash('sha256').update(
    files.map(function(f) { return f.path + ':' + f.hash; }).join(NL)
  ).digest('hex');

  return {
    projectRoot: cleanRoot,
    files: files,
    excluded: excluded,
    repoFingerprint: repoFingerprint
  };
}

function resolveDependencyPath(fromRel, importSpecifier, knownFiles) {
  if (!importSpecifier || typeof importSpecifier !== 'string') return null;
  if (!importSpecifier.startsWith('.')) return null;

  const fromDir = path.dirname(fromRel);
  const resolved = path.normalize(path.join(fromDir, importSpecifier)).replace(/\\/g, '/');
  const candidates = [
    resolved,
    resolved + '.js',
    resolved + '.ts',
    resolved + '.json',
    path.join(resolved, 'index.js').replace(/\\/g, '/'),
    path.join(resolved, 'index.ts').replace(/\\/g, '/')
  ];

  const knownSet = new Set(knownFiles);
  for (const c of candidates) {
    if (knownSet.has(c)) return c;
  }
  return null;
}

function buildDependencyGraph(scan) {
  const filesList = (scan && scan.files) || [];
  const knownFiles = filesList.map(function(f) { return f.path; });
  const knownSet = new Set(knownFiles);
  const nodes = Array.from(knownSet).sort();
  const edges = [];
  const unresolved = [];

  for (const f of filesList) {
    let imports = f.imports;
    if (!imports && f.sourceScore !== 0 && scan.projectRoot) {
      const full = path.join(scan.projectRoot, f.path);
      try {
        const text = fs.readFileSync(full, 'utf8');
        imports = [];
        const reqRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        let m;
        while ((m = reqRegex.exec(text)) !== null) imports.push(m[1]);
        const impRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
        while ((m = impRegex.exec(text)) !== null) imports.push(m[1]);
      } catch (_) { imports = []; }
    }
    imports = imports || [];

    for (const spec of imports) {
      if (spec.startsWith('.')) {
        const target = resolveDependencyPath(f.path, spec, knownFiles);
        if (target) {
          edges.push({ from: f.path, to: target });
        } else {
          unresolved.push({ from: f.path, specifier: spec });
        }
      } else {
        unresolved.push({ from: f.path, specifier: spec });
      }
    }
  }

  return {
    nodes: nodes,
    edges: edges,
    unresolved: unresolved
  };
}

function buildCompactRepoMap(scan, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const hardBudget = limits.repoMapHard || 64 * 1024;
  const files = (scan && scan.files) || [];
  const entryPoints = files.filter(function(f) { return f.entryPointSignals || /(^|\/)(index|main|server|app)\.[^.]+$/i.test(f.path); });

  const lines = [
    '=== PROJECT SUMMARY ===',
    'Total Files: ' + files.length + ', Total Bytes: ' + (scan.totalBytes || files.reduce(function(n, f) { return n + (f.bytes || 0); }, 0)),
    '',
    '=== ENTRY POINTS ===',
    entryPoints.map(function(e) { return e.path; }).join(', ') || 'None',
    '',
    '=== DEPENDENCY EDGES ==='
  ];

  for (const f of files) {
    if (f.imports && f.imports.length > 0) {
      for (const imp of f.imports) {
        if (imp.startsWith('.')) {
          const target = resolveDependencyPath(f.path, imp, files.map(function(x) { return x.path; }));
          if (target) lines.push(f.path + ' -> ' + target);
        }
      }
    }
  }

  lines.push('', '=== COMPACT REPOSITORY ARCHITECTURE MAP ===');
  for (const f of files) {
    const entry = f.path + ' (' + f.bytes + 'B, ' + f.language + ')';
    if (lines.join(NL).length + entry.length + 10 > hardBudget - 128) {
      lines.push('...[REMAINDER TRUNCATED UNDER REPO_MAP_HARD]');
      break;
    }
    lines.push(entry);
  }

  const text = lines.join(NL);
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  return {
    text: text,
    bytes: Buffer.byteLength(text),
    sha256: sha256
  };
}

function partitionAnalysisChunks(scan, graph, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const chunkSoft = limits.chunkSoft || 160 * 1024;
  const chunks = [];
  let current = { chunkId: 'CHUNK_1', files: [], bytes: 0 };

  for (const f of scan.files) {
    if (f.generatedScore > 0) continue;
    if (current.bytes + f.bytes > chunkSoft && current.files.length > 0) {
      chunks.push(current);
      current = { chunkId: 'CHUNK_' + (chunks.length + 1), files: [], bytes: 0 };
    }
    current.files.push(f.path);
    current.bytes += f.bytes;
  }
  if (current.files.length > 0) chunks.push(current);
  return chunks;
}

async function analyzeRepositoryChunks(chunks, opts) {
  return chunks.map(function(c) {
    return {
      chunkId: c.chunkId,
      text: 'SUMMARY ' + c.chunkId + ': ' + c.files.join(', '),
      bytes: 100
    };
  });
}

function scoreAnalysisChunkRelevance(chunk, scan, graph, userRequest) {
  let score = 0;
  const reqLow = String(userRequest || '').toLowerCase();
  for (const f of chunk.files) {
    const fLow = f.toLowerCase();
    if (reqLow.includes(path.basename(fLow, path.extname(fLow)))) score += 50;
    if (fLow.includes('server') || fLow.includes('index') || fLow.includes('main')) score += 30;
    if (fLow.includes('test') || fLow.includes('spec')) score += 10;
  }
  return score;
}

function buildLocalStructuralChunkSummary(chunk, scan) {
  return 'CHUNK_ID: ' + chunk.chunkId + NL + 'FILES: ' + chunk.files.join(', ');
}

function buildFinalPlanningContext(args) {
  const req = args.userRequest || '';
  const repoMap = args.repoMap ? args.repoMap.text : '';
  const critical = args.criticalWindows || '';
  const text = ['=== FINAL PLANNING CONTEXT ===', 'USER REQUEST:', req, '', repoMap, '', critical].join(NL);
  return {
    text: text,
    bytes: Buffer.byteLength(text)
  };
}

function parseAndValidatePlanBatches(planText, graph, scan) {
  if (typeof planText !== 'string' || planText.trim().length === 0) {
    throw new Error('PLANNING_FINAL_INVALID: Empty plan text');
  }

  const targets = [];
  const targetRegex = /^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)$/gmi;
  let m;
  while ((m = targetRegex.exec(planText)) !== null) {
    const target = normalizeBatchTarget(m[1].trim().replace(/["'`*]/g, ''));
    if (target) targets.push(target);
  }

  if (targets.length === 0) {
    throw new Error('PLANNING_FINAL_INVALID: No valid targets found in plan');
  }

  return partitionCodingBatches(targets, graph, CHUNK_ENGINE_LIMITS);
}

function partitionCodingBatches(targets, graph, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const maxFiles = limits.maxBatchFiles || 2;
  const testMax = limits.testMaxFiles || 1;

  const normTargets = Array.from(new Set(targets.map(normalizeBatchTarget)));
  const tests = [];
  const sources = [];

  for (const t of normTargets) {
    if (/test|spec/i.test(t)) tests.push(t);
    else sources.push(t);
  }

  const batches = [];
  let current = [];

  for (const s of sources) {
    current.push(s);
    if (current.length >= maxFiles) {
      batches.push({ batchId: 'BATCH_' + (batches.length + 1), targets: current });
      current = [];
    }
  }
  if (current.length > 0) {
    batches.push({ batchId: 'BATCH_' + (batches.length + 1), targets: current });
  }

  let testCurrent = [];
  for (const t of tests) {
    testCurrent.push(t);
    if (testCurrent.length >= testMax) {
      batches.push({ batchId: 'BATCH_' + (batches.length + 1), targets: testCurrent, isTestBatch: true });
      testCurrent = [];
    }
  }
  if (testCurrent.length > 0) {
    batches.push({ batchId: 'BATCH_' + (batches.length + 1), targets: testCurrent, isTestBatch: true });
  }

  return batches;
}

function buildBatchMiniMap(batch, state, limits) {
  const targets = (batch && batch.targets) || [];
  const edges = (state && state.graph && state.graph.edges) || [];
  const targetEdges = edges.filter(function(e) { return targets.includes(e.from); });
  const importsText = targetEdges.length > 0
    ? 'DIRECT IMPORTS:' + NL + targetEdges.map(function(e) { return e.from + ' -> ' + e.to; }).join(NL)
    : 'DIRECT IMPORTS: None';
  const text = '=== BATCH MINI MAP ===' + NL + 'BATCH: ' + (batch && batch.batchId) + NL + 'TARGETS: ' + targets.join(', ') + NL + importsText;
  return {
    text: text,
    bytes: Buffer.byteLength(text)
  };
}

function extractBatchPlanSlice(planText, batch) {
  if (typeof planText !== 'string') return '';
  const lines = planText.split(/\r?\n/);
  const targets = new Set(((batch && batch.targets) || []).map(normalizeBatchTarget));
  const slice = lines.filter(function(l) {
    return Array.from(targets).some(function(t) { return l.includes(t); });
  });
  return slice.length > 0 ? slice.join(NL) : planText;
}

function buildMinimalBatchContext(batch, state, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const miniMap = buildBatchMiniMap(batch, state, limits);
  const planSlice = extractBatchPlanSlice(state.planSlice || '', batch);
  const text = ['=== BATCH CONTEXT ===', 'BATCH: ' + batch.batchId, miniMap.text, 'PLAN SLICE:', planSlice].join(NL);
  const bytes = Buffer.byteLength(text);
  return {
    text: text,
    bytes: bytes,
    miniMapBytes: miniMap.bytes,
    planSliceBytes: Buffer.byteLength(planSlice)
  };
}

function selectCodingTransport(context, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const maxInlineBytes = limits.maxInlineBytes || 12 * 1024;
  const bytes = context.bytes || Buffer.byteLength(context.text || '');
  const transport = bytes <= maxInlineBytes ? 'INLINE' : 'ATTACHMENT';
  return {
    transport: transport,
    twoStepIngest: transport === 'ATTACHMENT',
    attachmentCount: transport === 'ATTACHMENT' ? 1 : 0
  };
}

function selectAdaptiveReasoningLevel(opts) {
  return 'high';
}

function buildBatchContext(batch, state, limits) {
  return buildMinimalBatchContext(batch, state, limits);
}

async function runCodingBatch(batch, context, engine, opts) {
  return {
    batchId: batch.batchId,
    targets: batch.targets,
    output: 'MOCK_OUTPUT'
  };
}

function halveBatchAdaptively(batch, costs, level) {
  const targets = (batch && batch.targets) || [];
  if (targets.length <= 1) return [batch];

  const mid = Math.ceil(targets.length / 2);
  const left = targets.slice(0, mid);
  const right = targets.slice(mid);

  return [
    { batchId: batch.batchId + '.a', targets: left, halvingLevel: (level || 0) + 1 },
    { batchId: batch.batchId + '.b', targets: right, halvingLevel: (level || 0) + 1 }
  ];
}

function normalizeFailureCode(err) {
  if (!err) return '';
  if (typeof err === 'object') {
    if (err.code) return String(err.code);
    if (err.failureCode) return String(err.failureCode);
  }
  const msg = String(err && err.message || err || '');
  const tokens = [
    'BATCH_OUTPUT_INCOMPLETE',
    'BATCH_TARGET_MISSING',
    'BATCH_SYNTAX_OR_QUICK_CHECK_FAILED',
    'BATCH_RESPONSE_BUDGET_EXCEEDED',
    'BATCH_PARSE_INCOMPLETE',
    'BATCH_OUTPUT_TRUNCATED',
    'GEMINI_HARD_CAP_TIMEOUT',
    'FINAL_APPLY_AND_TEST_FAILED'
  ];
  for (const t of tokens) {
    if (msg.includes(t)) return t;
  }
  return msg.slice(0, 40).replace(/[^A-Za-z0-9_]/g, '_');
}

function isAdaptiveHalvingFailure(err) {
  const code = normalizeFailureCode(err);
  return ADAPTIVE_HALVING_CODES.has(code);
}

function buildCrossBatchContractSummary(receipt, previous) {
  const prev = typeof previous === 'string' ? previous : (previous && previous.text ? previous.text : '');
  const added = 'BATCH: ' + (receipt.batchId || 'n/a') + ' WRITTEN: ' + (receipt.filesWritten || []).join(', ');
  const combined = prev ? prev + NL + added : added;
  return {
    text: combined,
    bytes: Buffer.byteLength(combined)
  };
}

function buildDiffFocusedReviewContext(args) {
  const plan = args.plan || '';
  const diff = args.diff || '';
  const changed = (args.changedFiles || []).join(', ');
  const text = ['=== REVIEW CONTEXT ===', 'PLAN:', plan, 'CHANGED: ' + changed, 'DIFF:', diff].join(NL);
  return {
    text: text,
    bytes: Buffer.byteLength(text),
    chunks: [text]
  };
}

function writeChunkContextFile(exchangeDir, chunk, scan, maxBytes) {
  const p = path.join(exchangeDir, 'chunk_' + chunk.chunkId.toLowerCase() + '.txt');
  const text = 'CHUNK ' + chunk.chunkId + NL + chunk.files.join(NL);
  fs.writeFileSync(p, text, 'utf8');
  return {
    path: p,
    bytes: Buffer.byteLength(text)
  };
}

function extractTargetsFromError(errorText, knownTargets) {
  const found = new Set();
  const text = String(errorText || '');
  for (const t of knownTargets) {
    if (text.includes(t) || text.includes(path.basename(t))) {
      found.add(t);
    }
  }
  return Array.from(found).sort();
}

function getFailoverEngines(primaryEngine, excludedSet, context) {
  const e = excludedSet instanceof Set ? excludedSet : new Set(excludedSet || []);
  const orders = {
    gemini2: ['gemini3', 'gemini1', 'web2'],
    gemini3: ['gemini2', 'gemini1', 'web2'],
    gemini1: ['gemini3', 'gemini2', 'web2'],
    web2: ['web1'],
    web1: ['web2'],
    google_search_1: ['google_search_2', 'google_search_3', 'web1'],
    google_search_2: ['google_search_3', 'google_search_1', 'web1'],
    google_search_3: ['google_search_1', 'google_search_2', 'web1']
  };
  const list = orders[primaryEngine] || [];
  return list.filter(function(engine) {
    if (e.has(engine) || engine === primaryEngine) return false;
    if (context && typeof context.isEngineAvailable === 'function') {
      return context.isEngineAvailable(engine);
    }
    return true;
  });
}

function isEngineFailoverEligible(code) {
  return /BATCH_RECOVERY_EXHAUSTED|GEMINI_CONVERSATION_RESET_AFTER_SEND|GEMINI_TURN_ROLLED_BACK_AFTER_SEND|GEMINI_SILENT_PREFLIGHT_TIMEOUT|GEMINI_THINKING_STALL|GEMINI_HARD_CAP_TIMEOUT|WEB_SERVICE_REFUSAL|SERVICE_REFUSAL|WEB_TRANSIENT_SERVICE_ERROR|WEB_PAYLOAD_REJECTED_OR_OVERSIZED|WEB_QUOTA_OR_LIMIT_ERROR|SEARCH_AI_RESPONSE_TIMEOUT|SEARCH_AI_CAPTCHA_REQUIRED|PLANNER_ESCALATION_FAILED|FORCED_CHAT_RESET_VERIFICATION_FAILED|CHAT_RESET_VERIFICATION_FAILED|MODEL_OPTION_NOT_FOUND|MODEL_TIER_NOT_FOUND|MODEL_MENU_TIMEOUT|MODEL_TRIGGER_TIMEOUT|MODEL_SELECTION_UNVERIFIED|FIRST_TOKEN_TIMEOUT|GEMINI_FIRST_TOKEN_TIMEOUT/.test(String(code || ''));
}

function resolveAndEmbedExternalFiles(userRequest) {
  if (!userRequest || typeof userRequest !== 'string') return '';
  let embedded = '';
  const quotedRegex = /["']([A-Za-z]:\\[^"'\r\n*?<>|]+|\/[^"'\r\n]+)["']/g;
  const extRegex = /(?:[A-Za-z]:\\[^"'\r\n\t*?<>|]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch)|\/[^"'\s\r\n\t]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch))\b/gi;

  const candidatePaths = [];
  let qMatch;
  while ((qMatch = quotedRegex.exec(userRequest)) !== null) {
    candidatePaths.push(qMatch[1]);
  }
  const extMatches = userRequest.match(extRegex) || [];
  candidatePaths.push(...extMatches);

  const readPaths = new Set();
  for (let rawPath of candidatePaths) {
    let clean = rawPath.trim().replace(/^["']|["']$/g, '').replace(/[.,;:]$/, '');
    if (readPaths.has(clean)) continue;
    try {
      if (fs.existsSync(clean) && fs.statSync(clean).isFile()) {
        readPaths.add(clean);
        const content = fs.readFileSync(clean, 'utf8');
        embedded += NL + NL + '=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: ' + path.basename(clean) + ' ===' + NL +
                    content + NL +
                    '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===';
      }
    } catch (_) {}
  }
  return embedded;
}

function createAutopilotEngine(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required');
  }

  const activeCycleJobs = runtimeContext.activeCycleJobs || {};
  let executor = runtimeContext.localExecutor;
  if (!executor) {
    try {
      executor = createLocalExecutor(runtimeContext);
    } catch (_) {
      executor = getDefaultLocalExecutor();
    }
  }

  const ensureProjectSetup = runtimeContext.ensureProjectSetup || function() { return { roles: { planner: 'web1', coder: 'web2', reviewer: 'web1' } }; };
  const readProjectState = runtimeContext.readProjectState || function() { return {}; };
  const writeProjectState = runtimeContext.writeProjectState || function() {};
  const validatePlanOutputFn = runtimeContext.validatePlanOutput || validatePlanOutput;
  const tabActiveModel = runtimeContext.tabActiveModel || {};
  const pluginRoot = runtimeContext.pluginRoot || path.resolve(__dirname, '..');
  const sleepFn = runtimeContext.sleepFn || (function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); });
  const spawnSyncFn = runtimeContext.spawnSync || spawnSync;

  function getActiveJob(cleanRoot) {
    const norm = path.resolve(cleanRoot);
    return activeCycleJobs[norm] || null;
  }

  function isCycleActive(cleanRoot) {
    const norm = path.resolve(cleanRoot);
    return Boolean(activeCycleJobs[norm] && activeCycleJobs[norm].running);
  }

  function cancelCycle(cleanRoot) {
    const norm = path.resolve(cleanRoot);
    const job = activeCycleJobs[norm];
    if (job && job.running) {
      job.running = false;
      job.phase = 'CANCELLED';
      job.cancelled = true;
      job.error = 'CYCLE_CANCELLED';
      return true;
    }
    return false;
  }

  async function waitJobSlice(cleanRoot, maxSliceMs) {
    if (!maxSliceMs) maxSliceMs = 22000;
    const norm = path.resolve(cleanRoot);
    const start = Date.now();
    while (Date.now() - start < maxSliceMs) {
      const job = activeCycleJobs[norm];
      if (!job) return { status: 'NO_ACTIVE_JOB' };
      if (!job.running) {
        if (job.error) throw new Error(job.error);
        return job.result;
      }
      await sleepFn(200);
    }
    const job = activeCycleJobs[norm];
    return {
      status: 'STILL_RUNNING_CALL_CHECK_PROGRESS',
      currentPhase: job ? job.phase : 'WORKING',
      phase: job ? job.phase : 'WORKING',
      completed: job && job.completed || 0,
      total: job && job.total || 0,
      currentBatchId: job && job.currentBatchId || null,
      currentTargets: job && job.currentTargets || [],
      bytesInContext: job && job.bytesInContext || 0,
      retriesUsed: job && job.retriesUsed || 0,
      halvingUsed: job && job.halvingUsed || 0,
      lastCheckStatus: job && job.lastCheckStatus || 'PENDING',
      transport: job && job.transport || null,
      reasoningLevel: job && job.reasoningLevel || null,
      attempt: job && job.attempt || 0,
      handshakeStatus: job && job.handshakeStatus || null,
      activeCoderEngine: job && job.activeCoderEngine || null,
      activeModelTier: job && job.activeModelTier || null,
      repoMapReceipt: job && job.repoMapReceipt || null,
      planningPath: job && job.planningPath || null,
      elapsedSeconds: job ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
      nextRequiredToolCall: 'check_cycle_progress',
      instruction: 'Puna po vazhdon normalisht ne sfond. Thirr MENJEHERE mjetin check_cycle_progress(projectRoot) PA ekzekutuar asnje komande terminali!'
    };
  }

  async function dispatchChunkedEngineTurn(engine, cleanRoot, prompt, attachment, opts) {
    if (typeof runtimeContext.dispatchChunkedEngineTurn === 'function') {
      return runtimeContext.dispatchChunkedEngineTurn(engine, cleanRoot, prompt, attachment, opts);
    }
    opts = opts || {};
    const common = {
      tabKey: engine,
      projectRoot: cleanRoot,
      promptText: prompt,
      attachmentPaths: [attachment],
      bundlePath: attachment,
      isPlanner: Boolean(opts.isPlanner),
      userRequest: opts.userRequest || '',
      forceFreshChat: opts.forceFreshChat !== false,
      useProvidedBundle: opts.useProvidedBundle === true,
      backoffMs: opts.backoffMs,
      sleepFn: opts.sleepFn || sleepFn,
      disableInternalRetry: opts.disableInternalRetry === true,
      reasoningLevel: 'high',
      modelTier: opts.modelTier || 'neon',
      hardCapMs: opts.hardCapMs
    };
    if (typeof runtimeContext.dispatchToWebTab === 'function') {
      return engine.startsWith('google_search_')
        ? runtimeContext.dispatchToGoogleSearchAiTab(common)
        : runtimeContext.dispatchToWebTab(common);
    }
    throw new Error('NO_DISPATCHER_CONFIGURED_FOR_ENGINE: ' + engine);
  }

  async function dispatchPlannerWithFailover(state, routing, cleanRoot, prompt, attachment, opts) {
    opts = opts || {};
    state.failedEngines = state.failedEngines || new Set();
    state.engineFailoverCount = 0;
    state.totalEngineFailoverCount = state.totalEngineFailoverCount || 0;
    state.activeGeminiModelTier = 'neon';
    const batchLocalFailedEngines = new Set();
    let engine = state.activePlannerEngine || routing.roles.planner;
    while (true) {
      try {
        const result = await dispatchChunkedEngineTurn(engine, cleanRoot, prompt, attachment, Object.assign({}, opts, {
          modelTier: engine.startsWith('gemini') ? state.activeGeminiModelTier : 'neon',
          disableInternalRetry: engine.startsWith('gemini') ? true : Boolean(opts.disableInternalRetry)
        }));
        state.activePlannerEngine = engine;
        return result;
      } catch (err) {
        const code = String(err && err.message || err);
        if (!isEngineFailoverEligible(code) || state.engineFailoverCount >= 3) throw err;
        batchLocalFailedEngines.add(engine);
        const next = getFailoverEngines(engine, batchLocalFailedEngines, runtimeContext)[0];
        if (!next) throw err;
        state.engineFailoverCount++;
        state.totalEngineFailoverCount++;
        engine = next;
        state.activePlannerEngine = next;
      }
    }
  }

  async function executeCodingLeaf(batch, state, routing, job, opts) {
    opts = opts || {};
    batch.targets = batch.targets.map(normalizeBatchTarget);
    state.routing = routing;
    const coderEngine = opts.coderEngine || state.activeCoderEngine || routing.roles.coder;
    state.activeCoderEngine = coderEngine;
    job.activeCoderEngine = coderEngine;
    state.activeGeminiModelTier = 'neon';
    const modelTier = opts.modelTier || state.activeGeminiModelTier;
    job.activeModelTier = modelTier;

    const context = buildMinimalBatchContext(batch, state, CHUNK_ENGINE_LIMITS);
    const transport = selectCodingTransport(context, CHUNK_ENGINE_LIMITS);
    const exchangeDir = path.join(state.scan.projectRoot, '.antigravity', 'bridge', 'exchange');
    const codePath = path.join(exchangeDir, 'code.md');
    const checkpointIdentity = computeCheckpointIdentity(state.scan.projectRoot, state.planSlice);
    const contextPath = path.join(exchangeDir, 'b_' + batch.batchId.replace(/^BATCH-?/i, '').replace(/^INTEGRATION-REPAIR-?/i, 'r').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) + '.txt');
    const rulesPath = path.join(pluginRoot, 'rules', 'coder_rules.md');
    const rules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
    const instruction = rules + NL + NL + 'Implemento VETEM target-et (' + batch.targets.join(', ') + '). Kthe VETEM blloqe ### FILE: path me permbajtje te plote.';

    job.currentBatchId = batch.batchId;
    job.currentTargets = batch.targets;
    job.bytesInContext = context.bytes;
    job.transport = transport.transport;
    job.reasoningLevel = opts.reasoningLevel || 'high';
    job.attempt = (opts.recoveryAttempt || 0) + 1;
    job.handshakeStatus = transport.twoStepIngest ? 'PENDING' : 'NOT_REQUIRED';

    const dispatch = function(prompt, attachment, forceFreshChat) {
      return dispatchChunkedEngineTurn(coderEngine, state.scan.projectRoot, prompt, attachment, {
        forceFreshChat: forceFreshChat,
        disableInternalRetry: true,
        reasoningLevel: 'high',
        modelTier: modelTier,
        backoffMs: opts.backoffMs,
        sleepFn: opts.sleepFn || sleepFn,
        useProvidedBundle: Boolean(attachment)
      });
    };

    let output;
    if (transport.transport === 'INLINE') {
      job.handshakeStatus = 'NOT_REQUIRED';
      output = await dispatch(instruction + NL + NL + context.text, null, true);
    } else {
      fs.writeFileSync(contextPath, context.text, 'utf8');
      if (coderEngine.startsWith('gemini')) {
        const handshakeFn = runtimeContext.runGeminiAttachmentIngestHandshake || defaultRunGeminiAttachmentIngestHandshake;
        await handshakeFn({
          tabKey: coderEngine,
          projectRoot: state.scan.projectRoot,
          attachmentPath: contextPath,
          batchId: batch.batchId,
          reasoningLevel: 'high',
          modelTier: modelTier,
          forceFreshChat: true
        });
        job.handshakeStatus = 'VERIFIED';
        output = await dispatch(instruction, null, false);
      } else {
        job.handshakeStatus = 'DIRECT_ATTACHMENT';
        output = await dispatch(instruction, contextPath, true);
      }
    }

    const expected = new Set(batch.targets);
    const parseExpected = function(text) {
      const all = parseCodeBlocksFromMarkdown(text, batch.targets).map(function(x) {
        return Object.assign({}, x, { relPath: normalizeBatchTarget(x.relPath) });
      });
      const received = new Set(all.map(function(x) { return x.relPath; }));
      const missing = batch.targets.filter(function(x) { return !received.has(x); });
      return {
        all: all,
        parsed: missing.length === 0 ? all.filter(function(x) { return expected.has(x.relPath); }) : all,
        missing: missing,
        extra: all.map(function(x) { return x.relPath; }).filter(function(x) { return !expected.has(x); })
      };
    };

    let formatRepairUsed = Boolean(opts.formatRepairUsed);
    const repairFormat = async function(failure) {
      if (formatRepairUsed) throw new Error(failure);
      formatRepairUsed = true;
      const repairPrompt = 'KORRIGJIM I VETEM FORMATI/SINTAKSE. ' + failure + NL + 'Kthe VETEM target-et e autorizuara: ' + batch.targets.join(', ') + NL + 'Per secilin perdor saktesisht ### FILE: path, pastaj nje code fence me permbajtjen e plote. Mos jep snippets ose skedare ekstra.';
      return dispatch(repairPrompt, null, false);
    };

    let parsedResult = parseExpected(output);
    if (parsedResult.missing.length) {
      const validParsed = parsedResult.parsed.filter(function(x) { return expected.has(x.relPath) && !parsedResult.missing.includes(x.relPath); });
      if (validParsed.length > 0) {
        try {
          const appliedPartial = executor.applyBatch({ projectRoot: state.scan.projectRoot, batch: { targets: validParsed.map(function(x) { return x.relPath; }) }, parsedFiles: validParsed });
          const quickPartial = executor.runBatchQuickChecks({ projectRoot: state.scan.projectRoot, writtenFiles: appliedPartial.filesWritten });
          if (quickPartial.status === 'CHECK_PASSED') {
            const partialReceipt = { batchId: batch.batchId + '.partial', filesWritten: appliedPartial.filesWritten, fileHashes: Object.fromEntries(appliedPartial.filesWritten.map(function(x) { return [x, crypto.createHash('sha256').update(fs.readFileSync(path.join(state.scan.projectRoot, x))).digest('hex')]; })), quickCheckResult: quickPartial, parsedFiles: validParsed };
            executor.persistCheckpointReceiptOnce(codePath, partialReceipt, validParsed, state.scan.projectRoot, checkpointIdentity);
          }
        } catch (_) {}
      }
      const detail = 'BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']';
      state.lastErrorReceipt = detail;
      output = await repairFormat(detail);
      parsedResult = parseExpected(output);
      if (parsedResult.missing.length) {
        throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']');
      }
    }

    let applied = executor.applyBatch({ projectRoot: state.scan.projectRoot, batch: batch, parsedFiles: parsedResult.parsed });
    let quick = executor.runBatchQuickChecks({ projectRoot: state.scan.projectRoot, writtenFiles: applied.filesWritten });
    if (quick.status !== 'CHECK_PASSED') {
      if (applied.backups) {
        for (const backup of applied.backups) {
          const abs = path.join(state.scan.projectRoot, backup.path);
          if (backup.exists) fs.writeFileSync(abs, backup.content);
          else if (fs.existsSync(abs)) fs.unlinkSync(abs);
        }
      }
      const detail = 'BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: ' + JSON.stringify(quick.receipts || []);
      state.lastErrorReceipt = detail;
      output = await repairFormat(detail);
      parsedResult = parseExpected(output);
      if (parsedResult.missing.length) throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']');
      applied = executor.applyBatch({ projectRoot: state.scan.projectRoot, batch: batch, parsedFiles: parsedResult.parsed });
      quick = executor.runBatchQuickChecks({ projectRoot: state.scan.projectRoot, writtenFiles: applied.filesWritten });
      if (quick.status !== 'CHECK_PASSED') throw new Error('BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: ' + JSON.stringify(quick.receipts || []));
    }

    return {
      batchId: batch.batchId,
      filesWritten: applied.filesWritten,
      fileHashes: Object.fromEntries(applied.filesWritten.map(function(x) { return [x, crypto.createHash('sha256').update(fs.readFileSync(path.join(state.scan.projectRoot, x))).digest('hex')]; })),
      quickCheckResult: quick,
      parsedFiles: parsedResult.parsed,
      contextBytes: context.bytes,
      transport: transport.transport,
      reasoningLevel: 'high',
      attempt: (opts.recoveryAttempt || 0) + 1,
      handshakeStatus: job.handshakeStatus
    };
  }

  async function executeBatchWithRecovery(batch, state, routing, job, opts) {
    opts = opts || {};
    state.failedEngines = state.failedEngines || new Set();
    state.engineFailoverCount = state.engineFailoverCount || 0;
    state.totalEngineFailoverCount = state.totalEngineFailoverCount || 0;
    const failoverScope = opts.failoverScope || { localFailoverCount: 0, batchLocalFailedEngines: new Set() };
    opts.failoverScope = failoverScope;
    const codePath = path.join(state.scan.projectRoot, '.antigravity', 'bridge', 'exchange', 'code.md');
    const auditIndex = parseCheckpointAudit(fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '');
    const checkpointIdentity = computeCheckpointIdentity(state.scan.projectRoot, state.planSlice);
    const unresolvedTargets = batch.targets.map(normalizeCheckpointTarget).filter(function(target) {
      return !isTargetVerifiedForCheckpoint(auditIndex, target, state.scan.projectRoot, checkpointIdentity);
    });

    if (!unresolvedTargets.length) {
      return [{
        batchId: batch.batchId,
        filesWritten: batch.targets.map(normalizeCheckpointTarget),
        fileHashes: {},
        quickCheckResult: { status: 'CHECK_PASSED' },
        parsedFiles: [],
        skippedFromCheckpoint: true
      }];
    }

    const activeBatch = Object.assign({}, batch, { targets: unresolvedTargets });
    const initialEngine = opts.coderEngine || state.activeCoderEngine || routing.roles.coder;
    const level = Number(opts.halvingLevel || 0);

    try {
      return [await executeCodingLeaf(activeBatch, state, routing, job, Object.assign({}, opts, { coderEngine: initialEngine, reasoningLevel: selectAdaptiveReasoningLevel(opts) }))];
    } catch (err) {
      const freshAuditText = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '';
      const freshAuditIndex = parseCheckpointAudit(freshAuditText);
      const unresolvedTargetsAfterCatch = activeBatch.targets.filter(function(target) {
        return !isTargetVerifiedForCheckpoint(freshAuditIndex, target, state.scan.projectRoot, checkpointIdentity);
      });
      if (!unresolvedTargetsAfterCatch.length) {
        return [{ batchId: activeBatch.batchId, filesWritten: activeBatch.targets, fileHashes: {}, quickCheckResult: { status: 'CHECK_PASSED' }, parsedFiles: [], skippedFromCheckpoint: true }];
      }

      const batchToHalve = Object.assign({}, activeBatch, { targets: unresolvedTargetsAfterCatch });
      if (batchToHalve.targets.length > 1 && level < CHUNK_ENGINE_LIMITS.maxHalvingLevel && isAdaptiveHalvingFailure(err)) {
        const batchCosts = opts.batchCosts || (state.scan && state.scan.files ? Object.fromEntries(state.scan.files.map(function(f) { return [normalizeCheckpointTarget(f.path), Number(f.bytes || 0)]; })) : null);
        const subBatches = halveBatchAdaptively(batchToHalve, batchCosts, level);
        if (subBatches.length > 1) {
          const results = [];
          for (const subBatch of subBatches) {
            const subReceipts = await executeBatchWithRecovery(subBatch, state, routing, job, Object.assign({}, opts, { coderEngine: initialEngine, halvingLevel: level + 1, batchCosts: batchCosts, failoverScope: { localFailoverCount: 0, batchLocalFailedEngines: new Set() } }));
            for (const r of subReceipts) {
              results.push(r);
              if (r.parsedFiles && r.parsedFiles.length && !r.skippedFromCheckpoint) {
                executor.persistCheckpointReceiptOnce(codePath, r, r.parsedFiles, state.scan.projectRoot, checkpointIdentity);
                r.checkpointPersisted = true;
              }
            }
          }
          return results;
        }
      }

      const exhausted = 'BATCH_RECOVERY_EXHAUSTED: ' + batchToHalve.batchId + ' ' + String(err && err.message || err);
      if (batchToHalve.targets.length > 1 || !isEngineFailoverEligible(exhausted) || failoverScope.localFailoverCount >= 2) throw new Error(exhausted);
      failoverScope.batchLocalFailedEngines.add(initialEngine);
      state.failedEngines.add(initialEngine);
      const nextEngine = getFailoverEngines(initialEngine, failoverScope.batchLocalFailedEngines, runtimeContext)[0];
      if (!nextEngine) throw new Error(exhausted);
      failoverScope.localFailoverCount++;
      state.engineFailoverCount = failoverScope.localFailoverCount;
      state.totalEngineFailoverCount++;
      state.activeCoderEngine = nextEngine;
      job.activeCoderEngine = nextEngine;
      return executeBatchWithRecovery(batchToHalve, state, routing, job, { coderEngine: nextEngine, recoveryAttempt: 0, reasoningLevel: 'high', backoffMs: opts.backoffMs, sleepFn: opts.sleepFn || sleepFn, failoverScope: failoverScope, halvingLevel: level, batchCosts: opts.batchCosts });
    }
  }

  async function runAutonomousPipeline(cleanRoot, userRequest, opts) {
    cleanRoot = path.resolve(cleanRoot);
    if (activeCycleJobs[cleanRoot] && activeCycleJobs[cleanRoot].running) {
      throw new Error('ACTION_REJECTED_CYCLE_IN_PROGRESS: Cikli autopilot eshte aktiv per [' + cleanRoot + '] ne fazen [' + activeCycleJobs[cleanRoot].phase + ']. Ndalohet kategorikisht thirrja e mjeteve anesore! Thirr vetem check_cycle_progress(projectRoot).');
    }

    const job = activeCycleJobs[cleanRoot] = {
      running: true,
      phase: 'DISCOVERY',
      startedAt: Date.now(),
      result: null,
      error: null,
      completed: 0,
      total: 0,
      currentBatchId: null,
      currentTargets: [],
      bytesInContext: 0,
      retriesUsed: 0,
      halvingUsed: 0,
      lastCheckStatus: 'PENDING'
    };

    try {
      const routing = ensureProjectSetup(cleanRoot);
      const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
      if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
      const planPath = path.join(exchangeDir, 'plan.md');
      const codePath = path.join(exchangeDir, 'code.md');
      const reviewPath = path.join(exchangeDir, 'review.md');
      const logPath = path.join(exchangeDir, 'build_test.log');

      const scan = scanRepositoryUniversal(cleanRoot);
      const graph = buildDependencyGraph(scan);
      const repoMap = buildCompactRepoMap(scan, CHUNK_ENGINE_LIMITS);
      const embeddedSpecs = resolveAndEmbedExternalFiles(userRequest);
      const totalRelevantSourceBytes = scan.files.filter(function(f) { return f.generatedScore === 0; }).reduce(function(n, f) { return n + f.bytes; }, 0) + Buffer.byteLength(embeddedSpecs);

      job.repoMapReceipt = { bytes: repoMap.bytes, sha256: repoMap.sha256, repoFingerprint: scan.repoFingerprint };

      const planningState = {
        activePlannerEngine: routing.roles.planner,
        failedEngines: new Set(),
        engineFailoverCount: 0,
        activeGeminiModelTier: 'neon'
      };

      let planText = '';
      if (fs.existsSync(planPath) && fs.statSync(planPath).size > 200) {
        planText = fs.readFileSync(planPath, 'utf8');
      } else if (totalRelevantSourceBytes <= CHUNK_ENGINE_LIMITS.planningSafe) {
        job.phase = 'PLANNING_SINGLE_PASS';
        const relevant = [];
        for (const f of scan.files.filter(function(x) { return x.generatedScore === 0; })) {
          const inspected = inspectTextBuffer(fs.readFileSync(path.join(cleanRoot, f.path)));
          if (inspected.isText) relevant.push('### FILE: ' + f.path + NL + inspected.text);
        }
        const planning = buildFinalPlanningContext({
          userRequest: userRequest,
          repoMap: repoMap,
          summaries: [],
          criticalWindows: relevant.join(NL + NL) + NL + embeddedSpecs,
          totalRelevantBytes: totalRelevantSourceBytes
        });
        const physical = path.join(exchangeDir, 'planning_context.txt');
        fs.writeFileSync(physical, planning.text, 'utf8');
        planText = await dispatchPlannerWithFailover(planningState, routing, cleanRoot, buildSearchAiCleanPrompt('plan'), physical, { isPlanner: true, useProvidedBundle: true, userRequest: userRequest, forceFreshChat: true });
      } else {
        const chunks = partitionAnalysisChunks(scan, graph, CHUNK_ENGINE_LIMITS);
        const ranked = chunks.map(function(chunk, index) {
          return { chunk: chunk, index: index, score: scoreAnalysisChunkRelevance(chunk, scan, graph, userRequest) };
        }).sort(function(a, b) { return b.score - a.score || a.index - b.index; });
        const webIds = new Set(ranked.slice(0, CHUNK_ENGINE_LIMITS.maxWebAnalysisChunks).map(function(x) { return x.chunk.chunkId; }));
        const webChunks = chunks.filter(function(chunk) { return webIds.has(chunk.chunkId); });
        const summaries = chunks.filter(function(chunk) { return !webIds.has(chunk.chunkId); }).map(function(chunk) {
          const text = buildLocalStructuralChunkSummary(chunk, scan);
          return { chunkId: chunk.chunkId, text: text, bytes: Buffer.byteLength(text) };
        });

        job.total = webChunks.length;
        for (let i = 0; i < webChunks.length; i++) {
          job.phase = 'PLANNING_CHUNK ' + (i + 1) + '/' + webChunks.length;
          job.completed = i;
          const chunk = webChunks[i];
          const physical = writeChunkContextFile(exchangeDir, chunk, scan, CHUNK_ENGINE_LIMITS.chunkHard);
          const prompt = 'Analizo vetem kete chunk. Kthe structured summary me CHUNK_ID: ' + chunk.chunkId + ' dhe seksionet MODULES, RESPONSIBILITIES, ENTRY_POINTS, PUBLIC_CONTRACTS, KEY_SYMBOLS, DEPENDENCIES_IN, DEPENDENCIES_OUT, DATA/SCHEMAS, SIDE_EFFECTS, RISKS, TESTS, RELEVANT_FILES, POSSIBLE_CHANGE_TARGETS, UNRESOLVED_QUESTIONS.';
          let text;
          try {
            text = await dispatchPlannerWithFailover(planningState, routing, cleanRoot, prompt, physical.path, { isPlanner: false, useProvidedBundle: true, forceFreshChat: true });
          } catch (_) {
            text = await dispatchPlannerWithFailover(planningState, routing, cleanRoot, prompt, physical.path, { isPlanner: false, useProvidedBundle: true, forceFreshChat: true });
          }
          text = truncateUtf8(text, CHUNK_ENGINE_LIMITS.summaryHard);
          if (!text.includes('CHUNK_ID: ' + chunk.chunkId)) text = 'CHUNK_ID: ' + chunk.chunkId + NL + text;
          summaries.push({ chunkId: chunk.chunkId, text: text, bytes: Buffer.byteLength(text) });
        }
        summaries.sort(function(a, b) { return a.chunkId.localeCompare(b.chunkId); });
        job.phase = 'PLANNING_FINAL';
        const finalContext = buildFinalPlanningContext({
          userRequest: userRequest,
          repoMap: repoMap,
          summaries: summaries,
          criticalWindows: embeddedSpecs,
          totalRelevantBytes: totalRelevantSourceBytes
        });
        const planningPath = path.join(exchangeDir, 'planning_context.txt');
        fs.writeFileSync(planningPath, finalContext.text, 'utf8');
        planText = await dispatchPlannerWithFailover(planningState, routing, cleanRoot, buildSearchAiCleanPrompt('plan'), planningPath, { isPlanner: true, useProvidedBundle: true, userRequest: userRequest, forceFreshChat: true });
      }

      const validated = validatePlanOutputFn(planText, { requiresFiles: false });
      if (!validated || !validated.ok) throw new Error('PLANNING_FINAL_INVALID');
      fs.writeFileSync(planPath, planText, 'utf8');

      let batches;
      try {
        batches = parseAndValidatePlanBatches(planText, graph, scan);
      } catch (_) {
        const fallback = scan.files.filter(function(f) { return f.sourceScore > 0 && f.generatedScore === 0; }).slice(0, 1).map(function(f) { return f.path; });
        if (!fallback.length) throw new Error('PLANNING_FINAL_INVALID');
        batches = partitionCodingBatches(fallback, graph, {});
      }

      job.total = batches.length;
      job.completed = 0;
      if (!fs.existsSync(codePath)) {
        fs.writeFileSync(codePath, '# CHUNKED ENGINE BATCH AUDIT' + NL, 'utf8');
      }

      const checkpointIdentity = computeCheckpointIdentity(cleanRoot, planText);
      executor.migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity);

      const state = {
        scan: scan,
        graph: graph,
        repoMap: repoMap,
        planSlice: planText,
        contractMemory: '',
        changedFiles: [],
        activeCoderEngine: routing.roles.coder,
        activePlannerEngine: routing.roles.planner,
        failedEngines: new Set(),
        engineFailoverCount: 0,
        activeGeminiModelTier: planningState.activeGeminiModelTier || 'neon'
      };

      const batchReceipts = [];
      const allWrittenFilesSet = new Set();

      for (let i = 0; i < batches.length; i++) {
        if (job.cancelled) throw new Error('CYCLE_CANCELLED');
        const existingAudit = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '';
        const auditIndex = parseCheckpointAudit(existingAudit);
        const normalizedTargets = batches[i].targets.map(normalizeCheckpointTarget);
        const verifiedTargets = normalizedTargets.filter(function(t) {
          return isTargetVerifiedForCheckpoint(auditIndex, t, cleanRoot, checkpointIdentity);
        });

        if (normalizedTargets.length > 0 && verifiedTargets.length === normalizedTargets.length) {
          verifiedTargets.forEach(function(t) { allWrittenFilesSet.add(t); });
          job.completed = i + 1;
          continue;
        }

        job.phase = 'CODING_BATCH ' + (i + 1) + '/' + batches.length;
        const receipts = await executeBatchWithRecovery(batches[i], state, routing, job, {});
        for (const receipt of receipts) {
          batchReceipts.push(receipt);
          (receipt.filesWritten || []).map(normalizeCheckpointTarget).forEach(function(t) { allWrittenFilesSet.add(t); });
          if (!receipt.checkpointPersisted && receipt.parsedFiles && receipt.parsedFiles.length && !receipt.skippedFromCheckpoint) {
            executor.persistCheckpointReceiptOnce(codePath, receipt, receipt.parsedFiles, cleanRoot, checkpointIdentity);
          }
          state.contractMemory = buildCrossBatchContractSummary(receipt, state.contractMemory).text;
          state.changedFiles.push(...(receipt.filesWritten || []));
        }
        job.completed = i + 1;
      }

      let allWrittenFiles = Array.from(allWrittenFilesSet).sort();
      job.phase = 'FINAL_APPLY_AND_TEST';
      let finalChecks = executor.runFinalBuildAndTests(cleanRoot, 180000);
      fs.writeFileSync(logPath, JSON.stringify(finalChecks, null, 2), 'utf8');

      for (let repairRound = 1; repairRound <= 2 && finalChecks.status !== 'CHECK_PASSED'; repairRound++) {
        const errorText = JSON.stringify(finalChecks);
        const knownTargets = Array.from(new Set([...allWrittenFiles, ...scan.files.map(function(f) { return f.path; })]));
        const mentioned = extractTargetsFromError(errorText, knownTargets);
        if (!mentioned.length) break;
        job.phase = 'INTEGRATION_REPAIR';
        state.lastErrorReceipt = 'FINAL_APPLY_AND_TEST_FAILED (round ' + repairRound + '):' + NL + truncateUtf8(errorText, 12000);
        const repairBatch = { batchId: 'INTEGRATION-REPAIR-' + repairRound, targets: mentioned.slice(0, 2), halvingLevel: 1 };
        const receipts = await executeBatchWithRecovery(repairBatch, state, routing, job, { compact: true, singleRetry: true });
        for (const receipt of receipts) {
          batchReceipts.push(receipt);
          (receipt.filesWritten || []).map(normalizeCheckpointTarget).forEach(function(t) { allWrittenFilesSet.add(t); });
          if (!receipt.checkpointPersisted && receipt.parsedFiles && receipt.parsedFiles.length && !receipt.skippedFromCheckpoint) {
            executor.persistCheckpointReceiptOnce(codePath, receipt, receipt.parsedFiles, cleanRoot, checkpointIdentity);
          }
        }
        allWrittenFiles = Array.from(allWrittenFilesSet).sort();
        finalChecks = executor.runFinalBuildAndTests(cleanRoot, 180000);
        fs.writeFileSync(logPath, JSON.stringify(finalChecks, null, 2), 'utf8');
        if (finalChecks.status === 'CHECK_PASSED') state.lastErrorReceipt = '';
      }

      if (finalChecks.status !== 'CHECK_PASSED') throw new Error('FINAL_APPLY_AND_TEST_FAILED');

      allWrittenFiles = Array.from(allWrittenFilesSet).sort();
      job.phase = 'REVIEWING';
      let diffStdout = '';
      try {
        const diffResult = spawnSyncFn('git', ['diff', '--', ...allWrittenFiles], { cwd: cleanRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        diffStdout = (diffResult && diffResult.stdout) || '';
      } catch (_) {}

      const review = buildDiffFocusedReviewContext({
        plan: planText,
        changedFiles: allWrittenFiles,
        diff: diffStdout,
        batchReceipts: batchReceipts,
        finalTests: fs.readFileSync(logPath, 'utf8'),
        knownRisks: []
      });

      const reviewPathContext = path.join(exchangeDir, 'rev_ctx.txt');
      fs.writeFileSync(reviewPathContext, review.chunks.join(NL + NL + '--- REVIEW CHUNK ---' + NL + NL), 'utf8');

      let reviewText = 'STATUS: PASSED\nSKIPPED: reviewer off';
      let reviewerEngine = routing.roles.reviewer || 'off';

      if (reviewerEngine !== 'off') {
        const reviewerRulesPath = path.join(pluginRoot, 'rules', 'reviewer_rules.md');
        const reviewerRules = fs.existsSync(reviewerRulesPath) ? fs.readFileSync(reviewerRulesPath, 'utf8') : '';
        const reviewInline = review.text.length <= CHUNK_ENGINE_LIMITS.maxInlineChars && review.bytes <= CHUNK_ENGINE_LIMITS.maxInlineBytes;
        const reviewSubject = reviewInline ? 'kontekstin e meposhtem' : path.basename(reviewPathContext) + ' te bashkengjitur';
        const baseReviewPrompt = reviewerRules + NL + NL + 'Rishiko vetem ' + reviewSubject + '. Kthe STATUS: PASSED ose STATUS: CHANGES_REQUIRED.';
        const reviewAttachment = reviewInline ? null : reviewPathContext;
        const reviewPrompt = reviewInline ? baseReviewPrompt + NL + NL + (review.text || review.chunks[0] || '') : baseReviewPrompt;

        const failedReviewEngines = new Set();
        let reviewAttempt = 0;
        while (reviewAttempt < 6) {
          reviewAttempt++;
          try {
            if (!reviewInline && reviewerEngine.startsWith('gemini')) {
              const reviewModelTier = state.activeGeminiModelTier || 'neon';
              const handshakeFn = runtimeContext.runGeminiAttachmentIngestHandshake || defaultRunGeminiAttachmentIngestHandshake;
              await handshakeFn({
                tabKey: reviewerEngine,
                projectRoot: cleanRoot,
                attachmentPath: reviewPathContext,
                batchId: 'REVIEW',
                reasoningLevel: 'high',
                modelTier: reviewModelTier,
                forceFreshChat: true
              });
              reviewText = await dispatchChunkedEngineTurn(reviewerEngine, cleanRoot, reviewPrompt, null, {
                forceFreshChat: false,
                useProvidedBundle: false,
                disableInternalRetry: true,
                reasoningLevel: 'high',
                modelTier: reviewModelTier
              });
            } else {
              reviewText = await dispatchChunkedEngineTurn(reviewerEngine, cleanRoot, reviewPrompt, reviewAttachment, {
                forceFreshChat: true,
                useProvidedBundle: !reviewInline,
                disableInternalRetry: reviewerEngine.startsWith('gemini'),
                reasoningLevel: 'high',
                modelTier: reviewerEngine.startsWith('gemini') ? (state.activeGeminiModelTier || 'neon') : 'neon'
              });
            }
            break;
          } catch (reviewError) {
            const reviewCode = String(reviewError && reviewError.message || reviewError);
            if (isEngineFailoverEligible(reviewCode) && failedReviewEngines.size < 3) {
              failedReviewEngines.add(reviewerEngine);
              const nextReviewer = getFailoverEngines(reviewerEngine, failedReviewEngines, runtimeContext)[0];
              if (nextReviewer) {
                reviewerEngine = nextReviewer;
                continue;
              }
            }
            throw reviewError;
          }
        }
      }

      fs.writeFileSync(reviewPath, reviewText, 'utf8');
      const reviewVerdicts = String(reviewText || '').split(/\r?\n/).map(function(line) {
        return line.replace(/[*#]/g, '').trim();
      }).map(function(line) {
        return line.match(/^STATUS:\s*(APPROVED|PASSED|CHANGES_REQUIRED|FAILED|REJECTED)\b/i);
      }).filter(Boolean).map(function(match) { return match[1].toUpperCase(); });

      const approved = reviewVerdicts.some(function(verdict) { return verdict === 'APPROVED' || verdict === 'PASSED'; }) &&
                       !reviewVerdicts.some(function(verdict) { return verdict === 'CHANGES_REQUIRED' || verdict === 'FAILED' || verdict === 'REJECTED'; });

      job.running = false;
      job.phase = approved ? 'COMPLETED' : 'FAILED_REVIEW';
      job.result = {
        status: approved ? 'CYCLE_COMPLETED' : 'REVIEW_FAILED',
        verdict: approved ? 'APPROVED' : 'CHANGES_REQUIRED',
        plannerModel: tabActiveModel[routing.roles.planner] || routing.roles.planner,
        coderModel: tabActiveModel[routing.roles.coder] || routing.roles.coder,
        reviewerEngine: reviewerEngine,
        writtenFiles: Array.from(new Set(allWrittenFiles)),
        commandsExecuted: (finalChecks.receipts || []).map(function(x) { return x.command; }),
        batchReceipts: batchReceipts,
        finalChecks: finalChecks
      };

      return job.result;
    } catch (err) {
      job.running = false;
      job.phase = job.cancelled ? 'CANCELLED' : 'FAILED';
      job.error = err.message || String(err);
      job.result = null;
      throw err;
    }
  }

  async function runFullCycle(projectRoot, userRequest, opts) {
    const cleanRoot = path.resolve(projectRoot);
    if (!activeCycleJobs[cleanRoot] || !activeCycleJobs[cleanRoot].running) {
      runAutonomousPipeline(cleanRoot, userRequest || '', opts).catch(function(_) {});
    }
    const maxSlice = (opts && opts.maxSliceMs) || 22000;
    return await waitJobSlice(cleanRoot, maxSlice);
  }

  async function checkCycleProgress(projectRoot, maxSliceMs) {
    return await waitJobSlice(projectRoot, maxSliceMs || 22000);
  }

  return {
    CHUNK_ENGINE_LIMITS,
    PACK_MODES,
    activeCycleJobs,
    isCycleActive,
    cancelCycle,
    getActiveJob,
    waitJobSlice,
    packWorkspace: function(root, mode) { return packWorkspace(root, mode, { ensureProjectSetup: ensureProjectSetup }); },
    getBundleAttachmentAndNote: function(root, engine) { return getBundleAttachmentAndNote(root, engine, { ensureProjectSetup: ensureProjectSetup }); },
    runAutonomousPipeline,
    runFullCycle,
    checkCycleProgress,
    dispatchChunkedEngineTurn,
    dispatchPlannerWithFailover,
    executeCodingLeaf,
    executeBatchWithRecovery,
    scanRepositoryUniversal,
    buildDependencyGraph,
    buildCompactRepoMap,
    partitionAnalysisChunks,
    analyzeRepositoryChunks,
    scoreAnalysisChunkRelevance,
    buildLocalStructuralChunkSummary,
    buildFinalPlanningContext,
    parseAndValidatePlanBatches,
    partitionCodingBatches,
    buildBatchMiniMap,
    extractBatchPlanSlice,
    buildMinimalBatchContext,
    selectCodingTransport,
    selectAdaptiveReasoningLevel,
    buildBatchContext,
    runCodingBatch,
    halveBatchAdaptively,
    normalizeFailureCode,
    isAdaptiveHalvingFailure,
    buildCrossBatchContractSummary,
    buildDiffFocusedReviewContext,
    writeChunkContextFile,
    extractTargetsFromError,
    getFailoverEngines,
    isEngineFailoverEligible,
    parseCodeBlocksFromMarkdown,
    persistCheckpointReceiptOnce,
    classifyAttachmentHandshakeStrict
  };
}

module.exports = {
  createAutopilotEngine,
  PACK_MODES,
  CHUNK_ENGINE_LIMITS,
  scanRepositoryUniversal,
  buildDependencyGraph,
  buildCompactRepoMap,
  partitionAnalysisChunks,
  partitionCodingBatches,
  buildMinimalBatchContext,
  selectCodingTransport,
  halveBatchAdaptively,
  normalizeFailureCode,
  isAdaptiveHalvingFailure,
  getFailoverEngines,
  analyzeRepositoryChunks,
  buildFinalPlanningContext,
  parseAndValidatePlanBatches,
  buildBatchContext,
  runCodingBatch,
  buildCrossBatchContractSummary,
  buildDiffFocusedReviewContext,
  writeChunkContextFile,
  extractTargetsFromError,
  scoreAnalysisChunkRelevance,
  buildLocalStructuralChunkSummary,
  buildBatchMiniMap,
  extractBatchPlanSlice,
  selectAdaptiveReasoningLevel,
  classifyAttachmentHandshakeStrict,
  parseCodeBlocksFromMarkdown,
  persistCheckpointReceiptOnce,
  packWorkspace,
  getBundleAttachmentAndNote,
  resolveAndEmbedExternalFiles,
  buildBudgetedWorkspaceBundle
};
