'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function notifyWhatsApp(msg) {
  try {
    if (process.env.ANTIGRAVITY_RUN_CYCLE_NOTIFY !== '1') {
      return;
    }
    if (process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || process.argv.some(a => String(a).includes('test'))) {
      return;
    }
    const text = String(msg || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    const child = spawn('hermes', ['send', '--to', 'whatsapp', text], {
      stdio: 'ignore',
      detached: false,
      shell: false,
      windowsHide: true
    });
    child.on('error', function() {});
    child.unref();
  } catch (_) {}
}

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (_) {
  AdmZip = null;
}

const localExecutorModule = require('./local_executor');
const {
  sanitizeTargetPath,
  normalizeTargetKey,
  isValidCleanRelativePath,
  normalizeFingerprintText,
  computeRequestFingerprint,
  stripPlanMetadataHeader,
  computePlanFingerprint,
  embedPlanMetadataHeader,
  extractPlanMetadataHeader,
  extractPlanTargets
} = require('./target_path_utils');
const {
  createLocalExecutor,
  computeCheckpointIdentity,
  parseCheckpointAudit,
  normalizeCheckpointTarget,
  isTargetVerifiedForCheckpoint
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

function parseCodeBlocksFromMarkdown(markdown, expectedTargets) {
  if (typeof localExecutorModule.parseCodeBlocksFromMarkdown === 'function') {
    return localExecutorModule.parseCodeBlocksFromMarkdown(markdown, expectedTargets);
  }
  return getDefaultLocalExecutor().parseCodeBlocksFromMarkdown(markdown, expectedTargets);
}

function applyBatch(args) {
  if (typeof localExecutorModule.applyBatch === 'function') {
    return localExecutorModule.applyBatch(args);
  }
  return getDefaultLocalExecutor().applyBatch(args);
}

function runBatchQuickChecks(args) {
  if (typeof localExecutorModule.runBatchQuickChecks === 'function') {
    return localExecutorModule.runBatchQuickChecks(args);
  }
  return getDefaultLocalExecutor().runBatchQuickChecks(args);
}

async function runFinalBuildAndTests(projectRoot, timeoutMs) {
  if (typeof localExecutorModule.runFinalBuildAndTests === 'function') {
    return await localExecutorModule.runFinalBuildAndTests(projectRoot, timeoutMs);
  }
  return await getDefaultLocalExecutor().runFinalBuildAndTests(projectRoot, timeoutMs);
}

function migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity) {
  if (typeof localExecutorModule.migrateLegacyCheckpointReceipts === 'function') {
    return localExecutorModule.migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity);
  }
  return getDefaultLocalExecutor().migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity);
}

function appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity) {
  if (typeof localExecutorModule.appendBatchAudit === 'function') {
    return localExecutorModule.appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity);
  }
  return getDefaultLocalExecutor().appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity);
}

function persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
  return getDefaultLocalExecutor().persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity);
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.' + process.pid + '.' + Date.now() + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

const RESUMABLE_PLANNED_PHASES = Object.freeze(new Set([
  'PLANNED',
  'CODED',
  'CODING',
  'CODING_BATCH',
  'APPLYING',
  'APPLYING_AND_TESTING',
  'FINAL_APPLY_AND_TEST',
  'INTEGRATION_REPAIR',
  'BUILD_FAILED',
  'APPLIED_AND_VERIFIED',
  'REVIEWING',
  'REVIEW_CHANGES_REQUESTED',
  'REVIEW_FIX'
]));

function isResumablePlannedPhase(phase) {
  if (typeof phase !== 'string' || !phase.trim()) return false;
  const p = phase.trim().toUpperCase();
  if (RESUMABLE_PLANNED_PHASES.has(p)) return true;
  if (p.startsWith('CODING_BATCH')) return true;
  if (p.startsWith('AUTO_HEAL_RETRY')) return true;
  return false;
}

function readDiskStateSafely(cleanRoot) {
  const statePath = path.join(path.resolve(cleanRoot), '.antigravity', 'bridge', 'state.json');
  if (!fs.existsSync(statePath)) {
    return { exists: false, corrupted: false, state: null };
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    if (!raw || !raw.trim()) {
      return { exists: true, corrupted: true, state: null, error: 'EMPTY_STATE_JSON' };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, corrupted: true, state: null, error: 'INVALID_STATE_OBJECT' };
    }
    return { exists: true, corrupted: false, state: parsed };
  } catch (err) {
    return { exists: true, corrupted: true, state: null, error: err.message };
  }
}

function evaluatePlanCache(cleanRoot, currentRequestFingerprint, state, options) {
  options = options || {};
  const resolvedRoot = path.resolve(cleanRoot);

  if (options.forceReplan === true) {
    return { reusable: false, reason: 'FORCE_REPLAN' };
  }

  let effectiveState = state;
  if (effectiveState === undefined) {
    const diskState = readDiskStateSafely(resolvedRoot);
    if (diskState.corrupted) {
      return { reusable: false, reason: 'STATE_CORRUPTED_STALE', detail: diskState.error };
    }
    effectiveState = diskState.state;
  } else if (effectiveState && effectiveState.__corrupted === true) {
    return { reusable: false, reason: 'STATE_CORRUPTED_STALE' };
  } else {
    const diskCheck = readDiskStateSafely(resolvedRoot);
    if (diskCheck.corrupted) {
      return { reusable: false, reason: 'STATE_CORRUPTED_STALE', detail: diskCheck.error };
    }
  }

  const planPath = path.join(resolvedRoot, '.antigravity', 'bridge', 'exchange', 'plan.md');
  if (!fs.existsSync(planPath)) {
    return { reusable: false, reason: 'PLAN_MISSING' };
  }

  let rawPlan = '';
  try {
    rawPlan = fs.readFileSync(planPath, 'utf8');
  } catch (err) {
    return { reusable: false, reason: 'PLAN_READ_ERROR', detail: err.message };
  }

  const strippedPlanBody = stripPlanMetadataHeader(rawPlan).trim();
  if (!strippedPlanBody || Buffer.byteLength(strippedPlanBody, 'utf8') <= 200) {
    return { reusable: false, reason: 'PLAN_TOO_SHORT' };
  }

  const planMeta = extractPlanMetadataHeader(rawPlan);
  if (!planMeta.requestFingerprint || !planMeta.planFingerprint) {
    return { reusable: false, reason: 'PLAN_META_MISSING' };
  }

  const computedPlanFp = computePlanFingerprint(rawPlan);
  if (planMeta.planFingerprint !== computedPlanFp) {
    return {
      reusable: false,
      reason: 'PLAN_FINGERPRINT_MISMATCH',
      expectedPlanFingerprint: computedPlanFp,
      foundPlanFingerprint: planMeta.planFingerprint
    };
  }

  const normalizedCurrentReqFp = typeof currentRequestFingerprint === 'string' && SHA256_HEX_RE.test(currentRequestFingerprint.trim())
    ? currentRequestFingerprint.trim().toLowerCase()
    : '';
  if (!normalizedCurrentReqFp || planMeta.requestFingerprint !== normalizedCurrentReqFp) {
    return {
      reusable: false,
      reason: 'REQUEST_FINGERPRINT_MISMATCH',
      expectedRequestFingerprint: normalizedCurrentReqFp,
      foundRequestFingerprint: planMeta.requestFingerprint
    };
  }

  if (!effectiveState || typeof effectiveState !== 'object') {
    return {
      reusable: false,
      reason: 'STATE_MISSING'
    };
  }

  if (!effectiveState.phase || !isResumablePlannedPhase(effectiveState.phase)) {
    return {
      reusable: false,
      reason: 'PHASE_NOT_RESUMABLE:' + String(effectiveState.phase || 'MISSING')
    };
  }

  if (!effectiveState.requestFingerprint || String(effectiveState.requestFingerprint).trim().toLowerCase() !== normalizedCurrentReqFp) {
    return {
      reusable: false,
      reason: 'STATE_REQUEST_FINGERPRINT_MISMATCH'
    };
  }

  if (!effectiveState.planFingerprint || String(effectiveState.planFingerprint).trim().toLowerCase() !== computedPlanFp) {
    return {
      reusable: false,
      reason: 'STATE_PLAN_FINGERPRINT_MISMATCH'
    };
  }

  return {
    reusable: true,
    reason: 'PLAN_CACHE_VALID',
    planText: rawPlan,
    planFingerprint: computedPlanFp,
    requestFingerprint: planMeta.requestFingerprint
  };
}

function invalidateStaleCycleArtifacts(cleanRoot, reason, currentRequestFingerprint, writeStateFn) {
  const resolvedRoot = path.resolve(cleanRoot);
  const bridgeDir = path.join(resolvedRoot, '.antigravity', 'bridge');
  const exchangeDir = path.join(bridgeDir, 'exchange');
  const artifactNames = [
    'plan.md',
    'code.md',
    'review.md',
    'build_test.log',
    'last_error.txt',
    'rev_ctx.txt',
    'planning_context.txt'
  ];

  const removedFiles = [];
  const ioErrors = [];

  for (const name of artifactNames) {
    const target = path.join(exchangeDir, name);
    try {
      fs.unlinkSync(target);
      removedFiles.push(name);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        ioErrors.push({ file: name, message: err.message });
      }
    }
  }

  const normalizedReason = String(reason || 'STALE_CACHE');
  const nextState = {
    phase: 'IDLE',
    retryCount: 0,
    lastStatus: 'CACHE_INVALIDATED',
    invalidationReason: normalizedReason,
    lastInvalidationReason: normalizedReason,
    requestFingerprint: typeof currentRequestFingerprint === 'string' && SHA256_HEX_RE.test(currentRequestFingerprint.trim())
      ? currentRequestFingerprint.trim().toLowerCase()
      : null,
    planFingerprint: null,
    verifiedBatches: {},
    checkpoints: {},
    updatedAt: new Date().toISOString()
  };

  if (ioErrors.length > 0) {
    nextState.invalidationErrors = ioErrors;
  }

  const statePath = path.join(bridgeDir, 'state.json');
  writeFileAtomic(statePath, JSON.stringify(nextState, null, 2));
  if (typeof writeStateFn === 'function') {
    try {
      writeStateFn(resolvedRoot, nextState);
    } catch (_) {}
  }

  console.error(
    '[PLAN_CACHE_INVALIDATED] project=' + resolvedRoot +
    ' reason=' + normalizedReason +
    ' newRequestFp=' + String(nextState.requestFingerprint || 'none')
  );

  return {
    invalidated: true,
    reason: normalizedReason,
    removedFiles: removedFiles,
    ioErrors: ioErrors,
    state: nextState
  };
}

function buildCodePlanMetaHeader(planFingerprint) {
  const fp = typeof planFingerprint === 'string' && SHA256_HEX_RE.test(planFingerprint.trim())
    ? planFingerprint.trim().toLowerCase()
    : '';
  return '<!-- CODE_PLAN_META planFingerprint=' + fp + ' -->';
}

function buildBatchCheckpointHeader(meta) {
  meta = meta || {};
  const fp = typeof meta.planFingerprint === 'string' && SHA256_HEX_RE.test(meta.planFingerprint.trim())
    ? meta.planFingerprint.trim().toLowerCase()
    : '';
  const batchIndex = Number.isInteger(meta.batchIndex) ? meta.batchIndex : Number(meta.batchIndex || 0);
  const targetKeys = Array.isArray(meta.targetKeys)
    ? meta.targetKeys.map(function(k) { return String(k || '').trim(); }).filter(Boolean).join(',')
    : '';
  return '<!-- CHECKPOINT_META planFingerprint=' + fp + ' batchIndex=' + batchIndex + ' targets=' + targetKeys + ' -->';
}

function extractCheckpointPlanFingerprint(codeMarkdown, batchTargets, batchIndex, projectRoot) {
  if (typeof codeMarkdown !== 'string' || !codeMarkdown.trim()) return null;

  const normalizedWanted = new Set(
    (Array.isArray(batchTargets) ? batchTargets : [])
      .map(function(t) { return normalizeTargetKey(t, projectRoot); })
      .filter(Boolean)
  );

  const metaRe = /<!--\s*(?:CHECKPOINT_META|CHECKPOINT_FILE_VERIFIED)\b([\s\S]*?)-->/gi;
  let match;
  let lastMatchingFp = null;
  let lastAnyFp = null;

  while ((match = metaRe.exec(codeMarkdown)) !== null) {
    const attrs = match[1] || '';
    const fpMatch = attrs.match(/\bplanFingerprint=([a-f0-9]{64})\b/i);
    if (!fpMatch) continue;
    const fp = fpMatch[1].toLowerCase();
    lastAnyFp = fp;

    const idxMatch = attrs.match(/\bbatchIndex=(\d+)\b/i);
    const targetsMatch = attrs.match(/\btargets=([^\s>]+)/i);
    const targetMatch = attrs.match(/\btarget=([^\s>]+)/i);
    const metaTargets = targetsMatch
      ? targetsMatch[1].split(',').map(function(t) { return normalizeTargetKey(t, projectRoot); }).filter(Boolean)
      : (targetMatch ? [normalizeTargetKey(targetMatch[1], projectRoot)].filter(Boolean) : []);

    const indexMatches = batchIndex !== undefined && batchIndex !== null && idxMatch && Number(idxMatch[1]) === Number(batchIndex);
    const targetsOverlap = normalizedWanted.size > 0 && metaTargets.some(function(t) { return normalizedWanted.has(t); });

    if (indexMatches || targetsOverlap || (!idxMatch && !targetsMatch && !targetMatch)) {
      lastMatchingFp = fp;
    }
  }

  if (lastMatchingFp) return lastMatchingFp;

  const globalMatch = codeMarkdown.match(/<!--\s*CODE_PLAN_META\b[^>]*\bplanFingerprint=([a-f0-9]{64})\b[^>]*-->/i);
  if (globalMatch) return globalMatch[1].toLowerCase();

  if (normalizedWanted.size === 0 && lastAnyFp) return lastAnyFp;
  return null;
}

function verifyBatchCheckpoint(args) {
  args = args || {};
  const codeMarkdown = typeof args.codeMarkdown === 'string' ? args.codeMarkdown : '';
  const state = args.state && typeof args.state === 'object' ? args.state : null;
  const currentPlanFingerprint = typeof args.currentPlanFingerprint === 'string' ? args.currentPlanFingerprint.trim().toLowerCase() : '';
  const batchIndex = args.batchIndex;
  const batchTargets = Array.isArray(args.batchTargets) ? args.batchTargets : [];
  const projectRoot = args.projectRoot;

  if (!SHA256_HEX_RE.test(currentPlanFingerprint)) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'INVALID_CURRENT_PLAN_FINGERPRINT',
      foundPlanFingerprint: null
    };
  }

  if (state && state.planFingerprint && String(state.planFingerprint).trim().toLowerCase() !== currentPlanFingerprint) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'STATE_PLAN_FINGERPRINT_MISMATCH',
      foundPlanFingerprint: String(state.planFingerprint).trim().toLowerCase()
    };
  }

  const foundPlanFp = extractCheckpointPlanFingerprint(codeMarkdown, batchTargets, batchIndex, projectRoot);
  if (!foundPlanFp) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'CHECKPOINT_PLAN_FINGERPRINT_MISSING',
      foundPlanFingerprint: null
    };
  }

  if (foundPlanFp !== currentPlanFingerprint) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'CHECKPOINT_PLAN_FINGERPRINT_MISMATCH',
      foundPlanFingerprint: foundPlanFp
    };
  }

  const normalizedTargets = batchTargets
    .map(function(t) { return normalizeTargetKey(t, projectRoot); })
    .filter(Boolean);

  if (normalizedTargets.length === 0) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'EMPTY_BATCH_TARGETS',
      foundPlanFingerprint: foundPlanFp
    };
  }

  const blockTargets = new Set();
  try {
    const rawParsedBlocks = parseCodeBlocksFromMarkdown(codeMarkdown);
    const parsedBlocks = Array.isArray(rawParsedBlocks)
      ? rawParsedBlocks
      : (rawParsedBlocks && Array.isArray(rawParsedBlocks.files) ? rawParsedBlocks.files : []);
    for (const blk of parsedBlocks) {
      const p = blk && (blk.relPath || blk.path || blk.file);
      const k = normalizeTargetKey(p, projectRoot);
      if (k) blockTargets.add(k);
    }
  } catch (_) {}

  const auditTargets = new Set();
  try {
    const auditIndex = parseCheckpointAudit(codeMarkdown);
    if (auditIndex && auditIndex.fileReceipts instanceof Map) {
      for (const [entry, rec] of auditIndex.fileReceipts.entries()) {
        if (rec && rec.status === 'VERIFIED' && (!rec.planFingerprint || String(rec.planFingerprint).toLowerCase() === currentPlanFingerprint)) {
          const k = normalizeTargetKey(entry, projectRoot);
          if (k) auditTargets.add(k);
        }
      }
    } else if (auditIndex instanceof Map) {
      for (const entry of auditIndex.keys()) {
        const k = normalizeTargetKey(entry, projectRoot);
        if (k) auditTargets.add(k);
      }
    }
  } catch (_) {}

  const stateBatchTargets = new Set();
  const batchKey = 'BATCH_' + (Number(batchIndex || 0) + 1);
  if (state && state.verifiedBatches && typeof state.verifiedBatches === 'object') {
    const rec = state.verifiedBatches[batchKey] || state.verifiedBatches[String(batchIndex)];
    if (rec && String(rec.planFingerprint || '').toLowerCase() === currentPlanFingerprint && Array.isArray(rec.targets)) {
      for (const t of rec.targets) {
        const k = normalizeTargetKey(t, projectRoot);
        if (k) stateBatchTargets.add(k);
      }
    }
  }

  const missingTargets = normalizedTargets.filter(function(key) {
    return !blockTargets.has(key) && !auditTargets.has(key) && !stateBatchTargets.has(key);
  });

  if (missingTargets.length > 0) {
    return {
      verified: false,
      reason: 'STALE_CHECKPOINT',
      detail: 'MISSING_VERIFIED_TARGETS:' + missingTargets.join(','),
      foundPlanFingerprint: foundPlanFp
    };
  }

  return {
    verified: true,
    reason: 'CHECKPOINT_MATCHED',
    planFingerprint: currentPlanFingerprint
  };
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
  const clean = stripPlanMetadataHeader(String(text || '')).replace(/\n?PLANI_PERFUNDOI_100\s*$/i, '').trim();
  if (clean.length < 250) return { ok: false, reason: 'TOO_SHORT', missing: ['minimum_length'] };
  const extraction = extractPlanTargets(clean, opts.projectRoot);
  const unsafeRejected = (extraction.rejected || []).some(function(item) {
    return item.reason === 'PATH_TRAVERSAL_REJECTED' ||
      item.reason === 'OUTSIDE_PROJECT_ROOT' ||
      item.reason === 'ABSOLUTE_WITHOUT_ROOT';
  });
  if (unsafeRejected) {
    return { ok: false, reason: 'UNSAFE_PATH', targets: extraction.targets };
  }
  return {
    ok: extraction.targets.length > 0,
    reason: extraction.targets.length > 0 ? '' : 'NO_TARGETS',
    targets: extraction.targets
  };
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

const BATCH_LIFECYCLE_PHASES = Object.freeze({
  COMMITTED: 'BATCH_N_COMMITTED',
  PREPARE: 'PREPARE_NEXT_BATCH_SESSION',
  READY: 'NEXT_BATCH_SESSION_READY',
  DISPATCH: 'BATCH_N+1_DISPATCH'
});

const LIFECYCLE_TRANSIENTS = Object.freeze(new Set([
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
  'TIMEOUT',
  'STREAM_STALL',
  'NETWORK_ERROR',
  'SERVICE_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'AUTH_EXPIRED',
  'EMPTY_RESPONSE',
  'MODEL_LOCK_FAILED',
  'TRANSIENT_FAILURE'
]));

function createRecoveryBudgets(opts) {
  opts = opts || {};
  return {
    lifecycleRecoveryBudget: Number.isFinite(opts.lifecycleRecoveryBudget) ? opts.lifecycleRecoveryBudget : 3,
    codingRecoveryBudget: Number.isFinite(opts.codingRecoveryBudget) ? opts.codingRecoveryBudget : 3,
    engineFailoverBudget: Number.isFinite(opts.engineFailoverBudget) ? opts.engineFailoverBudget : 3
  };
}

function classifyBatchLifecycleError(err) {
  const code = normalizeFailureCode(err);
  const message = String((err && err.message) || err || '');
  const combined = (code + ' ' + message).toUpperCase();

  const isTransient = /TRANSIENT|TIMEOUT|RATE_LIMIT|QUOTA|STALL|ECONNRESET|ETIMEDOUT|503|429/.test(combined);
  const isCoding = /PATCH|SYNTAX|QUICK_CHECK|PARSE|BATCH_TARGET_MISSING|BATCH_OUTPUT/.test(combined);
  const isModelTimeout = combined.includes('MODEL_TRIGGER_TIMEOUT');

  let budget = 'lifecycleRecoveryBudget';
  if (isCoding) {
    budget = 'codingRecoveryBudget';
  }

  return {
    code: code,
    message: message,
    transient: isTransient,
    fatal: isModelTimeout ? false : (!isTransient && !isCoding),
    budget: budget
  };
}

function consumeRecoveryBudget(budgets, classificationOrKey) {
  if (!budgets || typeof budgets !== 'object') {
    throw new Error('EXHAUSTED: Missing budgets');
  }
  const key = typeof classificationOrKey === 'string'
    ? classificationOrKey
    : ((classificationOrKey && classificationOrKey.budget) || 'lifecycleRecoveryBudget');

  const current = Number(budgets[key] != null ? budgets[key] : 0);
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error('EXHAUSTED: Budget ' + key + ' is exhausted');
  }
  return Object.assign({}, budgets, { [key]: current - 1 });
}

function firstUnverifiedBatch(batches, receipts) {
  if (!Array.isArray(batches) || batches.length === 0) return null;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let verified = false;
    if (typeof receipts === 'function') {
      verified = Boolean(receipts(batch));
    } else if (receipts && typeof receipts === 'object') {
      const entry = receipts[batch.batchId];
      verified = Boolean(entry && (entry.verified === true || entry === true));
    }
    if (!verified) return batch;
  }
  return null;
}

async function prepareNextBatchSession(args) {
  if (args && typeof args === 'object' && args.engineAdapter) {
    if (typeof args.persistCheckpoint === 'function') {
      await args.persistCheckpoint();
    }
    if (args.engineAdapter && typeof args.engineAdapter.resetConversation === 'function') {
      await args.engineAdapter.resetConversation();
    }
    if (args.engineAdapter && typeof args.engineAdapter.waitForSessionReady === 'function') {
      await args.engineAdapter.waitForSessionReady();
    }
    if (args.engineAdapter && typeof args.engineAdapter.ensureGeminiNeonModel === 'function') {
      await args.engineAdapter.ensureGeminiNeonModel();
    }
    return { status: 'READY' };
  }
  return {
    batchId: (args && args.batchId) || 'BATCH_1',
    targets: (args && Array.isArray(args.targets)) ? args.targets.slice() : [],
    forceFreshChat: true,
    resetPolicy: {
      strategy: 'SOFT_FIRST',
      preserveVerifiedModel: true,
      requireFreshConversation: true,
      allowRouteReopen: true,
      allowHardReload: true
    }
  };
}

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
  const budget = Math.min(512 * 1024, Math.max(4096, Number(opts.budgetBytes || (mode === PACK_MODES.CODING_FOCUSED ? 448 * 1024 : 256 * 1024))));
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
    const maxFileBytes = (f.meta && f.meta.explicitTarget) ? Math.max(64 * 1024, remaining - 128) : Math.min(64 * 1024, remaining - 128);
    const compact = compactWorkspaceContent(f.rel, content, maxFileBytes, f.classification);
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
    targets = extractPlanTargets(txt, cleanRoot).targets;
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

function resolveAndEmbedExternalFiles(userRequest) {
  if (!userRequest || typeof userRequest !== 'string') return '';
  let embedded = '';
  const quotedRegex = /["']([A-Za-z]:[\\/][^"'\r\n*?<>|]+|\/[^"'\r\n]+)["']/g;
  const extRegex = /(?:[A-Za-z]:[\\/][^"'\r\n\t*?<>|]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch)|\/[^"'\s\r\n\t]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch))\b/gi;

  const candidatePaths = [];
  let qMatch;
  while ((qMatch = quotedRegex.exec(userRequest)) !== null) {
    candidatePaths.push(qMatch[1]);
  }
  const extMatches = userRequest.match(extRegex) || [];
  candidatePaths.push(...extMatches);

  const readPaths = new Set();
  for (const rawPath of candidatePaths) {
    const clean = rawPath.trim().replace(/^["']|["']$/g, '').replace(/[.,;:]$/, '');
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

function normalizeBatchTarget(value, projectRoot) {
  const safeRoot = typeof projectRoot === 'string' && projectRoot.trim() ? projectRoot : null;
  const sanitized = sanitizeTargetPath(value, safeRoot);
  return sanitized.path || String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
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
  const summariesText = Array.isArray(args.summaries) && args.summaries.length > 0
    ? ['=== CHUNK SUMMARIES ==='].concat(args.summaries.map(function(s) { return s.text || ''; })).join(NL + NL)
    : '';
  const parts = ['=== FINAL PLANNING CONTEXT ===', 'USER REQUEST:', req, '', repoMap];
  if (summariesText) parts.push('', summariesText);
  if (critical) parts.push('', critical);
  const text = parts.join(NL);
  return {
    text: text,
    bytes: Buffer.byteLength(text)
  };
}

function parseAndValidatePlanBatches(planText, graph, scan, projectRoot) {
  const resolvedRoot = projectRoot || (scan && scan.projectRoot) || undefined;
  const extraction = extractPlanTargets(planText, resolvedRoot);

  if (!extraction.targets || extraction.targets.length === 0) {
    const rejectedCount = (extraction.rejected || []).length;
    const summary = rejectedCount > 0
      ? ' (rejectedCount=' + rejectedCount + ': ' + extraction.rejected.slice(0, 5).map(function(r) { return r.reason; }).join(', ') + ')'
      : '';
    const err = new Error('PLANNING_FINAL_INVALID: PLAN_NO_VALID_TARGETS: Plani arkitekturor nuk përmban asnjë FILE_TARGET ose skedar të vlefshëm në ALLOWED_FILES' + summary);
    err.code = 'PLAN_NO_VALID_TARGETS';
    err.rejected = extraction.rejected || [];
    throw err;
  }

  return partitionCodingBatches(extraction.targets, graph, CHUNK_ENGINE_LIMITS);
}

function partitionCodingBatches(targets, graph, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const maxFiles = limits.maxBatchFiles || 2;
  const testMax = limits.testMaxFiles || 1;

  const normTargets = Array.from(new Set(targets.map(function(t) { return normalizeBatchTarget(t); })));
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
  limits = limits || CHUNK_ENGINE_LIMITS;
  const softLimit = limits.batchMiniMapSoft || CHUNK_ENGINE_LIMITS.batchMiniMapSoft;
  const targets = (batch && batch.targets) || [];
  const edges = (state && state.graph && state.graph.edges) || [];
  const targetEdges = edges.filter(function(e) { return targets.includes(e.from); });
  const importsText = targetEdges.length > 0
    ? 'DIRECT IMPORTS:' + NL + targetEdges.map(function(e) { return e.from + ' -> ' + e.to; }).join(NL)
    : 'DIRECT IMPORTS: None';
  const raw = ['=== BATCH MINI MAP ===', 'TARGETS: ' + targets.join(', '), importsText].join(NL);
  const text = truncateUtf8(raw, softLimit);
  return { text: text, bytes: Buffer.byteLength(text) };
}

function extractBatchPlanSlice(planText, batch) {
  const full = stripPlanMetadataHeader(String(planText || '')).trim();
  if (!full) return '';
  const targets = (batch && Array.isArray(batch.targets)) ? batch.targets : [];
  if (targets.length === 0 || full.length <= 16000) return full;

  const sections = full.split(/\n(?=##\s)/);
  const matched = sections.filter(function(sec, idx) {
    if (idx === 0) return true;
    const low = sec.toLowerCase();
    return targets.some(function(t) {
      const clean = String(t || '').toLowerCase();
      return low.includes(clean) || low.includes(path.basename(clean));
    });
  });
  return matched.length > 0 ? matched.join(NL + NL) : truncateUtf8(full, 16000);
}

function extractTargetedSourceForBatch(fullText, maxBytes, planSlice, userRequest) {
  const source = String(fullText || '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  const lines = source.split(/\r?\n/);
  const hintText = String(planSlice || '') + '\n' + String(userRequest || '');
  const anchorLines = new Set();

  // Line number hints (e.g., "~1270", "rreshti 1270", "line 1270")
  const lineRe = /(?:rreshti|line|L)\s*[~:#]?\s*(\d{2,6})\b|~(\d{2,6})\b/gi;
  let lm;
  while ((lm = lineRe.exec(hintText)) !== null) {
    const ln = parseInt(lm[1] || lm[2], 10);
    if (ln >= 1 && ln <= lines.length) anchorLines.add(ln - 1);
  }

  // Meaningful identifier hints mentioned in plan/request
  const stopWords = new Set(['FILE_TARGET', 'ALLOWED_FILES', 'FORBIDDEN_FILES', 'OBJEKTIVAT', 'ENTRY', 'ROOT', 'CAUSE', 'HARDENING', 'DEFINITION', 'Revit', 'Snowdon', 'Towers', 'Problemi', 'Skedari', 'Gabimi', 'Shkaku', 'Metoda', 'Skriptet', 'Orchestrator', 'expected', 'string', 'public', 'private', 'internal', 'static', 'return']);
  const symMatches = hintText.match(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g) || [];
  const symbols = Array.from(new Set(symMatches.filter(function(s) { return !stopWords.has(s); }))).slice(0, 24);
  if (symbols.length) {
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (symbols.some(function(sym) { return line.includes(sym); })) {
        anchorLines.add(idx);
      }
    }
  }

  if (!anchorLines.size) return truncateUtf8(source, maxBytes);

  const windows = [[0, Math.min(lines.length - 1, 39)]];
  const sortedAnchors = Array.from(anchorLines).sort(function(a, b) { return a - b; });
  for (const a of sortedAnchors) {
    windows.push([Math.max(0, a - 55), Math.min(lines.length - 1, a + 75)]);
  }
  windows.sort(function(a, b) { return a[0] - b[0]; });
  const merged = [];
  for (const w of windows) {
    if (!merged.length || w[0] > merged[merged.length - 1][1] + 5) {
      merged.push([w[0], w[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], w[1]);
    }
  }

  const outParts = [];
  let usedBytes = 0;
  for (const seg of merged) {
    const header = '// [EXCERPT_LINES ' + (seg[0] + 1) + '-' + (seg[1] + 1) + ' of ' + lines.length + ']';
    const body = lines.slice(seg[0], seg[1] + 1).join(NL);
    const chunk = header + NL + body + NL;
    const cb = Buffer.byteLength(chunk, 'utf8');
    if (usedBytes + cb > maxBytes && outParts.length > 0) break;
    outParts.push(usedBytes + cb > maxBytes ? truncateUtf8(chunk, Math.max(1024, maxBytes - usedBytes)) : chunk);
    usedBytes += cb;
  }
  return outParts.join(NL);
}

function buildMinimalBatchContext(batch, state, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const hardBudget = limits.batchHard || CHUNK_ENGINE_LIMITS.batchHard;
  const configuredTargetBytes = limits.maxBatchTargetSourceBytes || CHUNK_ENGINE_LIMITS.maxBatchTargetSourceBytes;
  const targets = (batch && Array.isArray(batch.targets)) ? batch.targets : [];
  const maxTargetBytes = (limits === CHUNK_ENGINE_LIMITS && targets.length <= 2)
    ? Math.max(configuredTargetBytes, 24 * 1024)
    : configuredTargetBytes;
  const projectRoot = state && state.scan && state.scan.projectRoot ? state.scan.projectRoot : null;

  const miniMap = buildBatchMiniMap(batch, state, limits);
  const planSlice = extractBatchPlanSlice(state && state.planSlice ? state.planSlice : '', batch);

  const blocks = [
    '=== CODING BATCH CONTEXT ===',
    'BATCH_ID: ' + (batch && batch.batchId ? batch.batchId : 'BATCH_1'),
    'TARGETS: ' + targets.join(', '),
    '',
    miniMap.text,
    '',
    '=== PLAN SLICE ===',
    truncateUtf8(planSlice, 24 * 1024)
  ];

  if (state && state.contractMemory) {
    blocks.push('', '=== CROSS-BATCH CONTRACTS ===', truncateUtf8(state.contractMemory, limits.contractCumulative || CHUNK_ENGINE_LIMITS.contractCumulative));
  }
  if (state && state.lastErrorReceipt) {
    blocks.push('', '=== LAST ERROR RECEIPT ===', truncateUtf8(state.lastErrorReceipt, 12 * 1024));
  }

  for (const rel of targets) {
    if (!projectRoot) continue;
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) {
      try {
        const raw = fs.readFileSync(abs);
        const inspected = inspectTextBuffer(raw);
        if (inspected.isText) {
          blocks.push('', '--- FILE: ' + rel + ' ---', extractTargetedSourceForBatch(inspected.text, maxTargetBytes, planSlice, state && state.userRequest));
        }
      } catch (_) {}
    }
  }

  const text = truncateUtf8(blocks.join(NL), hardBudget);
  return {
    text: text,
    bytes: Buffer.byteLength(text),
    targets: targets.slice(),
    miniMap: miniMap.text,
    planSlice: planSlice
  };
}

function buildBatchContext(batch, state, limits) {
  return buildMinimalBatchContext(batch, state, limits);
}

function selectCodingTransport(context, limits) {
  limits = limits || CHUNK_ENGINE_LIMITS;
  const text = typeof context === 'string' ? context : String((context && context.text) || '');
  const bytes = context && Number.isFinite(context.bytes) ? context.bytes : Buffer.byteLength(text);
  const maxChars = limits.maxInlineChars || CHUNK_ENGINE_LIMITS.maxInlineChars;
  const maxBytes = limits.maxInlineBytes || CHUNK_ENGINE_LIMITS.maxInlineBytes;
  const inline = text.length <= maxChars && bytes <= maxBytes;
  return {
    transport: inline ? 'INLINE' : 'ATTACHMENT',
    inline: inline,
    attachmentCount: inline ? 0 : 1,
    twoStepIngest: !inline,
    chars: text.length,
    bytes: bytes
  };
}

function selectAdaptiveReasoningLevel(ctx) {
  return 'high';
}

async function runCodingBatch(batch, context, engine, opts) {
  opts = opts || {};
  const dispatchFn = opts.dispatchChunkedEngineTurn || opts.dispatchFn;
  if (typeof dispatchFn !== 'function') {
    throw new Error('CODER_DISPATCH_UNAVAILABLE: Missing dispatchChunkedEngineTurn');
  }
  const projectRoot = opts.projectRoot || (opts.state && opts.state.scan && opts.state.scan.projectRoot) || process.cwd();
  const prompt = opts.prompt || (typeof context === 'string' ? context : (context && context.text) || '');
  const attachment = opts.attachment || null;
  return await dispatchFn(engine, projectRoot, prompt, attachment, Object.assign({
    forceFreshChat: true,
    useProvidedBundle: Boolean(attachment),
    reasoningLevel: selectAdaptiveReasoningLevel(opts),
    modelTier: opts.modelTier || 'neon'
  }, opts));
}

function halveBatchAdaptively(batch, costs, level) {
  const targets = (batch && Array.isArray(batch.targets)) ? batch.targets.slice() : [];
  if (targets.length <= 1) return [batch];

  const nextLevel = Number(level || 0) + 1;
  let left = [];
  let right = [];

  if (costs && typeof costs === 'object') {
    const sorted = targets.slice().sort(function(a, b) {
      return Number(costs[b] || 0) - Number(costs[a] || 0) || a.localeCompare(b);
    });
    let leftCost = 0;
    let rightCost = 0;
    for (const t of sorted) {
      const c = Number(costs[t] || 1);
      if (leftCost <= rightCost) {
        left.push(t);
        leftCost += c;
      } else {
        right.push(t);
        rightCost += c;
      }
    }
    if (left.length === 0 || right.length === 0) {
      const mid = Math.ceil(targets.length / 2);
      left = targets.slice(0, mid);
      right = targets.slice(mid);
    }
  } else {
    const mid = Math.ceil(targets.length / 2);
    left = targets.slice(0, mid);
    right = targets.slice(mid);
  }

  return [
    Object.assign({}, batch, { batchId: (batch.batchId || 'BATCH') + '.a', targets: left, halvingLevel: nextLevel }),
    Object.assign({}, batch, { batchId: (batch.batchId || 'BATCH') + '.b', targets: right, halvingLevel: nextLevel })
  ];
}

function normalizeFailureCode(err) {
  if (!err) return '';
  if (typeof err === 'object') {
    if (err.failureCode && typeof err.failureCode === 'string') {
      return err.failureCode.trim().toUpperCase();
    }
    if (err.code && typeof err.code === 'string') {
      return err.code.trim().toUpperCase();
    }
  }
  const msg = String(typeof err === 'string' ? err : (err.message || err));
  const codeMatch = msg.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  return codeMatch ? codeMatch[1] : '';
}

function isAdaptiveHalvingFailure(err) {
  const code = normalizeFailureCode(err);
  if (ADAPTIVE_HALVING_CODES.has(code)) return true;
  const msg = String((err && err.message) || err || '');
  for (const c of ADAPTIVE_HALVING_CODES) {
    if (msg.includes(c)) return true;
  }
  return false;
}

function buildCrossBatchContractSummary(receipt, previous) {
  const prev = String(previous || '').trim();
  const files = (receipt && Array.isArray(receipt.filesWritten)) ? receipt.filesWritten : [];
  const hashes = (receipt && receipt.fileHashes && typeof receipt.fileHashes === 'object') ? receipt.fileHashes : {};
  const entryLines = [
    'BATCH: ' + ((receipt && receipt.batchId) || 'UNKNOWN'),
    'FILES: ' + (files.length ? files.join(', ') : 'None')
  ];
  for (const f of files) {
    if (hashes[f]) entryLines.push('  - ' + f + ' sha256=' + String(hashes[f]).slice(0, 12));
  }
  const entry = truncateUtf8(entryLines.join(NL), CHUNK_ENGINE_LIMITS.contractPerBatch);
  const combined = prev ? (prev + NL + NL + entry) : entry;
  const text = truncateUtf8(combined, CHUNK_ENGINE_LIMITS.contractCumulative);
  return { text: text, bytes: Buffer.byteLength(text) };
}

function buildDiffFocusedReviewContext(args) {
  args = args || {};
  const plan = truncateUtf8(String(args.plan || ''), 32 * 1024);
  const changedFiles = Array.isArray(args.changedFiles) ? args.changedFiles : [];
  const diff = String(args.diff || '');
  const finalTests = truncateUtf8(String(args.finalTests || ''), 16 * 1024);
  const knownRisks = Array.isArray(args.knownRisks) ? args.knownRisks : [];

  const header = [
    '=== REVIEW CONTEXT ===',
    'CHANGED_FILES: ' + (changedFiles.join(', ') || 'None'),
    '',
    '=== PLAN ===',
    plan,
    '',
    '=== FINAL TESTS ===',
    finalTests,
    knownRisks.length ? (NL + '=== KNOWN RISKS ===' + NL + knownRisks.join(NL)) : '',
    '',
    '=== DIFF ==='
  ].join(NL);

  const hardLimit = CHUNK_ENGINE_LIMITS.reviewHard;
  const fullText = header + NL + diff;
  if (Buffer.byteLength(fullText) <= hardLimit) {
    return {
      text: fullText,
      bytes: Buffer.byteLength(fullText),
      chunks: [fullText]
    };
  }

  const maxDiffPerChunk = Math.max(4096, hardLimit - Buffer.byteLength(header) - 512);
  const diffLines = diff.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of diffLines) {
    const next = cur ? (cur + '\n' + line) : line;
    if (Buffer.byteLength(next) > maxDiffPerChunk && cur) {
      chunks.push(header + NL + cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur || chunks.length === 0) {
    chunks.push(header + NL + cur);
  }

  const boundedText = truncateUtf8(chunks[0], hardLimit);
  return {
    text: boundedText,
    bytes: Buffer.byteLength(boundedText),
    chunks: chunks
  };
}

function writeChunkContextFile(exchangeDir, chunk, scan, maxBytes) {
  const limit = Number(maxBytes || CHUNK_ENGINE_LIMITS.chunkHard);
  if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
  const parts = ['=== ANALYSIS CHUNK: ' + chunk.chunkId + ' ==='];
  const projectRoot = scan && scan.projectRoot ? scan.projectRoot : process.cwd();

  for (const rel of (chunk.files || [])) {
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const inspected = inspectTextBuffer(fs.readFileSync(abs));
      if (!inspected.isText) continue;
      const block = NL + '--- FILE: ' + rel + ' ---' + NL + inspected.text;
      if (Buffer.byteLength(parts.join(NL) + block) > limit) break;
      parts.push(block);
    } catch (_) {}
  }

  const text = truncateUtf8(parts.join(NL), limit);
  const outPath = path.join(exchangeDir, String(chunk.chunkId || 'CHUNK') + '_context.txt');
  fs.writeFileSync(outPath, text, 'utf8');
  return {
    path: outPath,
    bytes: Buffer.byteLength(text),
    chunkId: chunk.chunkId
  };
}

function extractTargetsFromError(text, known) {
  const raw = String(text || '');
  const list = Array.isArray(known) ? known : [];
  const matched = [];
  const seen = new Set();

  for (const target of list) {
    const norm = String(target || '').replace(/\\/g, '/');
    if (!norm) continue;
    const base = path.posix.basename(norm);
    if (raw.includes(norm) || raw.includes(norm.replace(/\//g, '\\')) || (base && raw.includes(base))) {
      const key = normalizeTargetKey(norm);
      if (key && !seen.has(key)) {
        seen.add(key);
        matched.push(norm);
      }
    }
  }
  return matched;
}

function getFailoverEngines(primaryEngine, excludedSet, runtimeContext) {
  const excluded = excludedSet instanceof Set ? excludedSet : new Set(Array.isArray(excludedSet) ? excludedSet : []);
  const primary = String(primaryEngine || '').trim();
  const isAvailable = runtimeContext && typeof runtimeContext.isEngineAvailable === 'function'
    ? runtimeContext.isEngineAvailable
    : null;

  let pool = [];
  if (primary === 'gemini2') {
    pool = ['gemini3', 'gemini1', 'web2'];
  } else if (primary === 'gemini1') {
    pool = ['gemini2', 'gemini3', 'web2'];
  } else if (primary === 'gemini3') {
    pool = ['gemini1', 'gemini2', 'web2'];
  } else if (primary === 'web1') {
    pool = ['web2'];
  } else if (primary === 'web2') {
    pool = ['web1'];
  } else {
    pool = ['gemini1', 'gemini2', 'gemini3', 'web2'];
  }

  return pool.filter(function(eng) {
    if (!eng || eng === primary) return false;
    if (excluded.has(eng)) return false;
    if (isAvailable && !isAvailable(eng)) return false;
    return true;
  });
}

function isEngineFailoverEligible(code) {
  const text = String(code || '');
  if (!text) return false;
  if (/CYCLE_CANCELLED|PLAN_NO_VALID_TARGETS|BATCH_SYNTAX_OR_QUICK_CHECK_FAILED/i.test(text)) {
    return false;
  }
  return /RATE_LIMIT|QUOTA|TIMEOUT|STALL|AUTH_EXPIRED|MODEL_LOCK|CRITICAL_MODEL|SERVICE_ERROR|REFUSED|EMPTY_RESPONSE|UNAVAILABLE|DISPATCH|429|503|502|ECONNRESET|ETIMEDOUT|TARGET_CLOSED|BROWSER/i.test(text);
}

function createAutopilotEngine(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required for createAutopilotEngine');
  }
  const runtimeContext = deps;
  const activeCycleJobs = runtimeContext.activeCycleJobs || {};
  const tabActiveModel = runtimeContext.tabActiveModel || {};
  const pluginRoot = runtimeContext.pluginRoot || path.resolve(__dirname, '..', '..');
  const sleepFn = runtimeContext.sleepFn || function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  const spawnSyncFn = runtimeContext.spawnSync || spawnSync;
  const validatePlanOutputFn = runtimeContext.validatePlanOutput || validatePlanOutput;
  const buildSearchAiCleanPromptFn = runtimeContext.buildSearchAiCleanPrompt || buildSearchAiCleanPrompt;

  const ensureProjectSetup = runtimeContext.ensureProjectSetup || function(root) {
    const cleanRoot = path.resolve(root);
    const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
    if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
    return {
      projectRoot: cleanRoot,
      roles: { planner: 'gemini1', coder: 'gemini2', reviewer: 'off' }
    };
  };

  const readProjectState = runtimeContext.readProjectState || function(root) {
    const disk = readDiskStateSafely(root);
    if (disk.corrupted) return { __corrupted: true, phase: 'CORRUPTED' };
    return disk.state || { phase: 'IDLE', retryCount: 0, lastStatus: 'READY' };
  };

  const writeProjectState = runtimeContext.writeProjectState || function(root, patch) {
    const resolvedRoot = path.resolve(root);
    const bridgeDir = path.join(resolvedRoot, '.antigravity', 'bridge');
    const statePath = path.join(bridgeDir, 'state.json');
    const disk = readDiskStateSafely(resolvedRoot);
    const base = (!disk.corrupted && disk.state) ? disk.state : {};
    const merged = Object.assign({}, base, patch || {}, { updatedAt: new Date().toISOString() });
    writeFileAtomic(statePath, JSON.stringify(merged, null, 2));
    return merged;
  };

  const executor = {
    applyBatch: function(args) {
      const fn = runtimeContext.applyBatch || (runtimeContext.localExecutor && runtimeContext.localExecutor.applyBatch) || applyBatch;
      return fn(args);
    },
    runBatchQuickChecks: function(args) {
      const fn = runtimeContext.runBatchQuickChecks || (runtimeContext.localExecutor && runtimeContext.localExecutor.runBatchQuickChecks) || runBatchQuickChecks;
      return fn(args);
    },
    runFinalBuildAndTests: async function(projectRoot, timeoutMs) {
      const fn = runtimeContext.runFinalBuildAndTests || (runtimeContext.localExecutor && runtimeContext.localExecutor.runFinalBuildAndTests) || runFinalBuildAndTests;
      return await fn(projectRoot, timeoutMs);
    },
    persistCheckpointReceiptOnce: function(cp, r, pf, cr, id) {
      const fn = runtimeContext.persistCheckpointReceiptOnce || (runtimeContext.localExecutor && runtimeContext.localExecutor.persistCheckpointReceiptOnce) || function(a, b, c, d, e) {
        return getDefaultLocalExecutor().persistCheckpointReceiptOnce(a, b, c, d, e);
      };
      return fn(cp, r, pf, cr, id);
    },
    migrateLegacyCheckpointReceipts: function(cp, cr, id) {
      const fn = runtimeContext.migrateLegacyCheckpointReceipts || (runtimeContext.localExecutor && runtimeContext.localExecutor.migrateLegacyCheckpointReceipts) || function(a, b, c) {
        return getDefaultLocalExecutor().migrateLegacyCheckpointReceipts(a, b, c);
      };
      return fn(cp, cr, id);
    }
  };

  const dispatchChunkedEngineTurn = async function(engine, root, prompt, attachment, opts) {
    const fn = runtimeContext.dispatchChunkedEngineTurn;
    if (typeof fn !== 'function') {
      throw new Error('DISPATCH_TURN_NOT_CONFIGURED');
    }
    return await fn(engine, root, prompt, attachment, opts);
  };

  function isCycleActive(projectRoot) {
    const key = path.resolve(projectRoot);
    return Boolean(activeCycleJobs[key] && activeCycleJobs[key].running);
  }

  function cancelCycle(projectRoot) {
    const key = path.resolve(projectRoot);
    if (activeCycleJobs[key]) {
      activeCycleJobs[key].cancelled = true;
      activeCycleJobs[key].running = false;
      activeCycleJobs[key].phase = 'CANCELLED';
      return true;
    }
    return false;
  }

  function getActiveJob(projectRoot) {
    return activeCycleJobs[path.resolve(projectRoot)] || null;
  }

  async function waitJobSlice(cleanRoot, maxSliceMs) {
    const resolved = path.resolve(cleanRoot);
    const limit = Number(maxSliceMs || 22000);
    const start = Date.now();
    while (Date.now() - start < limit) {
      const job = activeCycleJobs[resolved];
      if (!job) return { status: 'NO_ACTIVE_JOB' };
      if (!job.running) {
        if (job.error) throw new Error(job.error);
        return job.result;
      }
      await sleepFn(200);
    }
    const job = activeCycleJobs[resolved];
    return {
      status: 'STILL_RUNNING_CALL_CHECK_PROGRESS',
      currentPhase: job ? job.phase : 'WORKING',
      elapsedSeconds: job ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
      nextRequiredToolCall: 'check_cycle_progress'
    };
  }

  async function dispatchPlannerWithFailover(state, routing, cleanRoot, prompt, attachment, opts) {
    opts = opts || {};
    if (typeof runtimeContext.dispatchPlannerWithFailover === 'function' && !opts._internalPlannerDispatch) {
      return await runtimeContext.dispatchPlannerWithFailover(state, routing, cleanRoot, prompt, attachment, Object.assign({}, opts, { _internalPlannerDispatch: true }));
    }
    state.failedEngines = state.failedEngines || new Set();
    let engine = state.activePlannerEngine || (routing && routing.roles && routing.roles.planner) || 'gemini1';
    let attempts = 0;

    while (attempts < 4) {
      attempts++;
      try {
        return await dispatchChunkedEngineTurn(engine, cleanRoot, prompt, attachment, Object.assign({
          isPlanner: true,
          forceFreshChat: true,
          reasoningLevel: 'high',
          modelTier: state.activeGeminiModelTier || 'neon'
        }, opts));
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (!isEngineFailoverEligible(msg)) throw err;
        state.failedEngines.add(engine);
        const next = getFailoverEngines(engine, state.failedEngines, runtimeContext)[0];
        if (!next) throw err;
        state.engineFailoverCount = (state.engineFailoverCount || 0) + 1;
        state.activePlannerEngine = next;
        engine = next;
      }
    }
    throw new Error('PLANNER_FAILOVER_EXHAUSTED');
  }

  async function executeCodingLeaf(batch, state, routing, job, opts) {
    opts = opts || {};
    const engine = opts.coderEngine || state.activeCoderEngine || (routing && routing.roles && routing.roles.coder) || 'gemini2';
    const context = buildBatchContext(batch, state, CHUNK_ENGINE_LIMITS);
    const transport = selectCodingTransport(context, CHUNK_ENGINE_LIMITS);
    const exchangeDir = path.join(state.scan.projectRoot, '.antigravity', 'bridge', 'exchange');
    if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });

    const expectedTargets = batch.targets.map(normalizeCheckpointTarget);
    const coderRulesPath = path.join(pluginRoot, 'rules', 'coder_rules.md');
    const coderRules = fs.existsSync(coderRulesPath) ? fs.readFileSync(coderRulesPath, 'utf8') : '';

    let attachmentPath = null;
    let prompt = '';
    if (transport.transport === 'INLINE') {
      prompt = [coderRules, 'TARGETS: ' + expectedTargets.join(', '), context.text].filter(Boolean).join(NL + NL);
    } else {
      attachmentPath = path.join(exchangeDir, 'batch_' + String(batch.batchId || '1').replace(/[^a-zA-Z0-9_-]/g, '_') + '_ctx.txt');
      fs.writeFileSync(attachmentPath, context.text, 'utf8');
      prompt = [coderRules, 'Zbato vetem skedaret e kerkuar nga konteksti i bashkengjitur: ' + expectedTargets.join(', ')].filter(Boolean).join(NL + NL);
    }

    job.currentBatchId = batch.batchId;
    job.currentTargets = expectedTargets.slice();
    job.bytesInContext = context.bytes;

    if (!transport.inline && engine.startsWith('gemini')) {
      const handshakeFn = runtimeContext.runGeminiAttachmentIngestHandshake || defaultRunGeminiAttachmentIngestHandshake;
      const hs = await handshakeFn({
        tabKey: engine,
        projectRoot: state.scan.projectRoot,
        attachmentPath: attachmentPath,
        batchId: batch.batchId,
        reasoningLevel: 'high',
        modelTier: state.activeGeminiModelTier || 'neon',
        forceFreshChat: true
      });
      job.handshakeStatus = (hs && hs.status) || 'VERIFIED';
    } else {
      job.handshakeStatus = 'INLINE_SKIPPED';
    }

    let output = await dispatchChunkedEngineTurn(engine, state.scan.projectRoot, prompt, transport.inline ? null : attachmentPath, {
      forceFreshChat: transport.inline || !engine.startsWith('gemini'),
      useProvidedBundle: !transport.inline,
      disableInternalRetry: engine.startsWith('gemini'),
      reasoningLevel: 'high',
      modelTier: state.activeGeminiModelTier || 'neon'
    });

    const extractDiffTargetKeys = function(rawOutput) {
      const keys = new Set();
      const diffRe = /^diff --git a\/([^\r\n]+) b\/([^\r\n]+)$/gm;
      let m;
      while ((m = diffRe.exec(String(rawOutput || ''))) !== null) {
        const oldKey = normalizeTargetKey(m[1], state.scan.projectRoot);
        const newKey = normalizeTargetKey(m[2], state.scan.projectRoot);
        if (oldKey && oldKey === newKey) keys.add(newKey);
      }
      return keys;
    };

    const parseExpected = function(rawOutput) {
      const rawParsed = parseCodeBlocksFromMarkdown(String(rawOutput || ''), expectedTargets);
      const parsed = Array.isArray(rawParsed)
        ? rawParsed
        : (rawParsed && Array.isArray(rawParsed.files) ? rawParsed.files : []);
      const foundKeys = new Set(parsed.map(function(p) { return normalizeTargetKey(p.relPath || p.path || p.file, state.scan.projectRoot); }).filter(Boolean));
      const diffKeys = extractDiffTargetKeys(rawOutput);
      for (const dk of diffKeys) foundKeys.add(dk);
      const expectedKeyMap = new Map(expectedTargets.map(function(t) { return [normalizeTargetKey(t, state.scan.projectRoot), t]; }));
      const missing = [];
      for (const [k, orig] of expectedKeyMap.entries()) {
        if (!foundKeys.has(k)) missing.push(orig);
      }
      const extra = [];
      for (const k of foundKeys) {
        if (!expectedKeyMap.has(k)) extra.push(k);
      }
      return { parsed: parsed, missing: missing, extra: extra };
    };

    const repairFormat = async function(detail, targetsOverride) {
      job.retriesUsed = (job.retriesUsed || 0) + 1;
      const retryTargets = (Array.isArray(targetsOverride) && targetsOverride.length) ? targetsOverride : expectedTargets;
      const corrPrompt = [
        'KORRIGJIM FORMATI I DETYRUESHEM: ' + detail,
        'Kthe patch-in e plote diff --git (ose ### FILE: vetem per skedar te ri) per keto objektiva: ' + retryTargets.join(', ')
      ].join(NL);
      return await dispatchChunkedEngineTurn(engine, state.scan.projectRoot, corrPrompt, null, {
        forceFreshChat: false,
        useProvidedBundle: false,
        disableInternalRetry: engine.startsWith('gemini'),
        reasoningLevel: 'high',
        modelTier: state.activeGeminiModelTier || 'neon'
      });
    };

    let parsedResult = parseExpected(output);

    if (parsedResult.missing.length) {
      const detail = 'BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']';
      state.lastErrorReceipt = detail;
      output = await repairFormat(detail);
      parsedResult = parseExpected(output);
      if (parsedResult.missing.length) {
        throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']');
      }
    }

    const restoreAppliedBackups = function(appliedBatch) {
      for (let i = (appliedBatch.backups || []).length - 1; i >= 0; i--) {
        const backup = appliedBatch.backups[i];
        const abs = path.join(state.scan.projectRoot, backup.path);
        if (backup.exists) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, backup.content);
        } else if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
        }
      }
    };
    let applied = executor.applyBatch({ projectRoot: state.scan.projectRoot, batch: batch, parsedFiles: parsedResult.parsed, batchOutput: output });
    let quick = executor.runBatchQuickChecks({ projectRoot: state.scan.projectRoot, writtenFiles: applied.filesWritten });
    if (quick.status !== 'CHECK_PASSED') {
      restoreAppliedBackups(applied);
      const detail = 'BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: ' + JSON.stringify(quick.receipts || []);
      state.lastErrorReceipt = detail;
      output = await repairFormat(detail);
      parsedResult = parseExpected(output);
      if (parsedResult.missing.length) throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=[' + parsedResult.missing.join(',') + '] extra=[' + parsedResult.extra.join(',') + ']');
      applied = executor.applyBatch({ projectRoot: state.scan.projectRoot, batch: batch, parsedFiles: parsedResult.parsed, batchOutput: output });
      quick = executor.runBatchQuickChecks({ projectRoot: state.scan.projectRoot, writtenFiles: applied.filesWritten });
      if (quick.status !== 'CHECK_PASSED') {
        restoreAppliedBackups(applied);
        throw new Error('BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: ' + JSON.stringify(quick.receipts || []));
      }
    }

    return {
      batchId: batch.batchId,
      filesWritten: applied.filesWritten,
      fileHashes: Object.fromEntries(applied.filesWritten.map(function(x) {
        const abs = path.join(state.scan.projectRoot, x);
        return [x, fs.existsSync(abs) ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : ''];
      })),
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
    const existingCodeMd = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '';
    const auditIndex = parseCheckpointAudit(existingCodeMd);
    const baseCheckpointIdentity = computeCheckpointIdentity(state.scan.projectRoot, state.planSlice);
    const checkpointIdentity = state.planFingerprint
      ? Object.assign({}, baseCheckpointIdentity, { planFingerprint: String(state.planFingerprint).trim().toLowerCase() })
      : baseCheckpointIdentity;

    const checkpointPlanFpValid = !state.planFingerprint || (
      extractCheckpointPlanFingerprint(existingCodeMd, batch.targets, opts.batchIndex, state.scan.projectRoot) === String(state.planFingerprint).toLowerCase()
    );

    const unresolvedTargets = batch.targets.map(normalizeCheckpointTarget).filter(function(target) {
      if (!checkpointPlanFpValid) return true;
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
      const freshFpValid = !state.planFingerprint || (
        extractCheckpointPlanFingerprint(freshAuditText, activeBatch.targets, opts.batchIndex, state.scan.projectRoot) === String(state.planFingerprint).toLowerCase()
      );
      const unresolvedTargetsAfterCatch = activeBatch.targets.filter(function(target) {
        if (!freshFpValid) return true;
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
              const cpEntries = (r.parsedFiles && r.parsedFiles.length)
                ? r.parsedFiles
                : (r.filesWritten || []).map(function(rel) {
                    return { relPath: rel, inputSha256: (r.fileHashes && r.fileHashes[rel]) || '' };
                  });
              if (cpEntries.length && !r.skippedFromCheckpoint) {
                executor.persistCheckpointReceiptOnce(codePath, r, cpEntries, state.scan.projectRoot, checkpointIdentity);
                r.checkpointPersisted = true;
              }
            }
          }
          return results;
        }
      }

      const exhausted = 'BATCH_RECOVERY_EXHAUSTED: ' + batchToHalve.batchId + ' ' + String(err && err.message || err);
      if (!isEngineFailoverEligible(exhausted) || failoverScope.localFailoverCount >= 2) throw new Error(exhausted);
      failoverScope.batchLocalFailedEngines.add(initialEngine);
      state.failedEngines.add(initialEngine);
      const nextEngine = getFailoverEngines(initialEngine, failoverScope.batchLocalFailedEngines, runtimeContext)[0];
      if (!nextEngine) throw new Error(exhausted);
      failoverScope.localFailoverCount++;
      state.engineFailoverCount = failoverScope.localFailoverCount;
      state.totalEngineFailoverCount++;
      state.activeCoderEngine = nextEngine;
      job.activeCoderEngine = nextEngine;
      return executeBatchWithRecovery(batchToHalve, state, routing, job, { coderEngine: nextEngine, recoveryAttempt: 0, reasoningLevel: 'high', backoffMs: opts.backoffMs, sleepFn: opts.sleepFn || sleepFn, failoverScope: failoverScope, halvingLevel: level, batchCosts: opts.batchCosts, batchIndex: opts.batchIndex });
    }
  }

  async function runAutonomousPipeline(cleanRoot, userRequest, opts) {
    opts = opts || {};
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
      if (!routing.roles) {
        routing.roles = {
          planner: routing.targets?.web1?.accountPool?.[0] || 'gemini1',
          coder: routing.targets?.web2?.accountPool?.[0] || 'gemini2',
          reviewer: routing.targets?.web1?.accountPool?.[0] || 'gemini1'
        };
      }
      const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
      if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
      const planPath = path.join(exchangeDir, 'plan.md');
      const codePath = path.join(exchangeDir, 'code.md');
      const reviewPath = path.join(exchangeDir, 'review.md');
      const logPath = path.join(exchangeDir, 'build_test.log');
      const errorPath = path.join(exchangeDir, 'last_error.txt');

      const scan = scanRepositoryUniversal(cleanRoot);
      const graph = buildDependencyGraph(scan);
      const repoMap = buildCompactRepoMap(scan, CHUNK_ENGINE_LIMITS);
      const embeddedSpecs = resolveAndEmbedExternalFiles(userRequest);
      const currentRequestFingerprint = computeRequestFingerprint(userRequest, embeddedSpecs);
      const totalRelevantSourceBytes = scan.files.filter(function(f) { return f.generatedScore === 0; }).reduce(function(n, f) { return n + f.bytes; }, 0) + Buffer.byteLength(embeddedSpecs);

      job.repoMapReceipt = { bytes: repoMap.bytes, sha256: repoMap.sha256, repoFingerprint: scan.repoFingerprint };
      job.requestFingerprint = currentRequestFingerprint;

      const planningState = {
        activePlannerEngine: routing.roles.planner,
        failedEngines: new Set(),
        engineFailoverCount: 0,
        activeGeminiModelTier: 'neon'
      };

      const persistedState = readProjectState(cleanRoot);
      const cacheCheck = evaluatePlanCache(cleanRoot, currentRequestFingerprint, persistedState, {
        forceReplan: opts.forceReplan === true
      });

      const generatePlanFromPlanner = async function(extraCorrectionDirective) {
        const promptBase = buildSearchAiCleanPromptFn('plan');
        const effectivePrompt = extraCorrectionDirective
          ? (promptBase + NL + NL + extraCorrectionDirective)
          : promptBase;

        if (totalRelevantSourceBytes <= CHUNK_ENGINE_LIMITS.planningSafe) {
          job.phase = 'PLANNING_SINGLE_PASS';
          const relevant = [];
          for (const f of scan.files.filter(function(x) { return x.generatedScore === 0; })) {
            const absPath = path.join(cleanRoot, f.path);
            if (!fs.existsSync(absPath)) continue;
            const inspected = inspectTextBuffer(fs.readFileSync(absPath));
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
          writeFileAtomic(physical, planning.text);
          return await dispatchPlannerWithFailover(planningState, routing, cleanRoot, effectivePrompt, physical, {
            isPlanner: true,
            useProvidedBundle: true,
            userRequest: userRequest,
            forceFreshChat: true,
            requestFingerprint: currentRequestFingerprint
          });
        }

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
        writeFileAtomic(planningPath, finalContext.text);
        return await dispatchPlannerWithFailover(planningState, routing, cleanRoot, effectivePrompt, planningPath, {
          isPlanner: true,
          useProvidedBundle: true,
          userRequest: userRequest,
          forceFreshChat: true,
          requestFingerprint: currentRequestFingerprint
        });
      };

      let planText = '';
      let currentPlanFingerprint = '';
      let reusedCachedPlan = false;

      if (cacheCheck.reusable) {
        planText = cacheCheck.planText;
        currentPlanFingerprint = cacheCheck.planFingerprint;
        reusedCachedPlan = true;
      } else {
        if (cacheCheck.reason !== 'PLAN_MISSING') {
          invalidateStaleCycleArtifacts(cleanRoot, cacheCheck.reason, currentRequestFingerprint, writeProjectState);
        } else {
          for (const downstream of ['review.md', 'build_test.log', 'last_error.txt', 'rev_ctx.txt', 'planning_context.txt']) {
            try { fs.unlinkSync(path.join(exchangeDir, downstream)); } catch (_) {}
          }
        }
        planText = await generatePlanFromPlanner('');
      }

      const persistFreshPlan = function(rawPlanText) {
        const planFp = computePlanFingerprint(rawPlanText);
        const wrapped = embedPlanMetadataHeader(rawPlanText, {
          requestFingerprint: currentRequestFingerprint,
          planFingerprint: planFp,
          generatedAt: new Date().toISOString()
        });
        writeFileAtomic(planPath, wrapped);
        for (const staleDownstream of [reviewPath, logPath, errorPath]) {
          try { fs.unlinkSync(staleDownstream); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
        }
        writeProjectState(cleanRoot, {
          phase: 'PLANNED',
          retryCount: 0,
          lastStatus: 'PLAN_READY',
          requestFingerprint: currentRequestFingerprint,
          planFingerprint: planFp,
          verifiedBatches: {},
          checkpoints: {}
        });
        return { wrapped: wrapped, planFingerprint: planFp };
      };

      // Defekti II: Fail-closed target parsing with zero scan.files fallback and max 1 bounded planner regeneration
      const maxPlanRegenAttempts = opts.allowPlanRegeneration === false
        ? 0
        : (Number.isInteger(opts.maxPlanRegenAttempts) ? opts.maxPlanRegenAttempts : 1);

      let batches = null;
      let planRegenAttempt = 0;

      while (true) {
        const validated = validatePlanOutputFn(planText, { requiresFiles: false, projectRoot: cleanRoot });
        if (validated && !validated.ok && validated.reason && validated.reason !== 'NO_TARGETS' && validated.reason !== 'TOO_SHORT') {
          writeProjectState(cleanRoot, {
            phase: 'PLAN_FAILED',
            lastStatus: 'PLANNING_FINAL_INVALID',
            lastError: 'PLANNING_FINAL_INVALID: ' + validated.reason,
            requestFingerprint: currentRequestFingerprint,
            planFingerprint: null
          });
          throw new Error('PLANNING_FINAL_INVALID: ' + validated.reason);
        }

        try {
          batches = parseAndValidatePlanBatches(planText, graph, scan, cleanRoot);
          break;
        } catch (parseErr) {
          if (parseErr && parseErr.code === 'PLAN_NO_VALID_TARGETS' && planRegenAttempt < maxPlanRegenAttempts) {
            planRegenAttempt++;
            try { fs.unlinkSync(planPath); } catch (_) {}
            reusedCachedPlan = false;
            planText = await generatePlanFromPlanner(
              'KORRIGJIM FORMATI I DETYRUESHEM: Plani i meparshem u refuzua me PLAN_NO_VALID_TARGETS. Shto te pakten nje rresht FILE_TARGET: <rruga/relative/e/skedarit> ose listen ### ALLOWED_FILES me rruge te vlefshme relative.'
            );
            continue;
          }
          if (parseErr && parseErr.code === 'PLAN_NO_VALID_TARGETS') {
            try { fs.unlinkSync(planPath); } catch (_) {}
            writeProjectState(cleanRoot, {
              phase: 'PLAN_FAILED',
              lastStatus: 'PLAN_NO_VALID_TARGETS',
              lastError: parseErr.message,
              requestFingerprint: currentRequestFingerprint,
              planFingerprint: null
            });
          }
          throw parseErr;
        }
      }

      if (!reusedCachedPlan) {
        const saved = persistFreshPlan(planText);
        planText = saved.wrapped;
        currentPlanFingerprint = saved.planFingerprint;
      }

      job.planFingerprint = currentPlanFingerprint;
      job.total = batches.length;
      job.completed = 0;

      // Defekti III: Bind code.md checkpoints strictly to currentPlanFingerprint
      const codeHeaderLine = buildCodePlanMetaHeader(currentPlanFingerprint);
      let existingCodeContent = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '';
      const existingCodePlanFp = extractCheckpointPlanFingerprint(existingCodeContent, [], null, cleanRoot);

      if (!existingCodeContent || existingCodePlanFp !== currentPlanFingerprint) {
        if (existingCodeContent) {
          console.error(
            '[CHECKPOINT_STALE] batch=ALL expectedPlanFp=' + currentPlanFingerprint +
            ' foundPlanFp=' + String(existingCodePlanFp || 'NONE')
          );
        }
        writeFileAtomic(codePath, codeHeaderLine + NL + '# CHUNKED ENGINE BATCH AUDIT' + NL);
        writeProjectState(cleanRoot, {
          phase: 'PLANNED',
          requestFingerprint: currentRequestFingerprint,
          planFingerprint: currentPlanFingerprint,
          verifiedBatches: {},
          checkpoints: {}
        });
      }

      const baseCheckpointIdentity = computeCheckpointIdentity(cleanRoot, planText);
      const checkpointIdentity = Object.assign({}, baseCheckpointIdentity, {
        planFingerprint: currentPlanFingerprint
      });
      executor.migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity);

      const state = {
        scan: scan,
        graph: graph,
        repoMap: repoMap,
        planSlice: planText,
        planFingerprint: currentPlanFingerprint,
        requestFingerprint: currentRequestFingerprint,
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
        const latestDiskState = readProjectState(cleanRoot);
        const normalizedTargets = batches[i].targets.map(normalizeCheckpointTarget);

        const cpCheck = verifyBatchCheckpoint({
          codeMarkdown: existingAudit,
          state: latestDiskState,
          currentPlanFingerprint: currentPlanFingerprint,
          batchIndex: i,
          batchTargets: normalizedTargets,
          projectRoot: cleanRoot
        });

        const auditIndex = parseCheckpointAudit(existingAudit);
        const verifiedTargets = normalizedTargets.filter(function(t) {
          return isTargetVerifiedForCheckpoint(auditIndex, t, cleanRoot, checkpointIdentity);
        });

        if (cpCheck.verified && normalizedTargets.length > 0 && verifiedTargets.length === normalizedTargets.length) {
          verifiedTargets.forEach(function(t) { allWrittenFilesSet.add(t); });
          job.completed = i + 1;
          continue;
        }

        if (!cpCheck.verified && existingAudit && cpCheck.foundPlanFingerprint && cpCheck.foundPlanFingerprint !== currentPlanFingerprint) {
          console.error(
            '[CHECKPOINT_STALE] batch=' + (i + 1) +
            ' expectedPlanFp=' + currentPlanFingerprint +
            ' foundPlanFp=' + String(cpCheck.foundPlanFingerprint || 'NONE') +
            ' detail=' + String(cpCheck.detail || '')
          );
          writeFileAtomic(codePath, codeHeaderLine + NL + '# CHUNKED ENGINE BATCH AUDIT' + NL);
        }

        job.phase = 'CODING_BATCH ' + (i + 1) + '/' + batches.length;
        const receipts = await executeBatchWithRecovery(batches[i], state, routing, job, { batchIndex: i });
        for (const receipt of receipts) {
          batchReceipts.push(receipt);
          const writtenNorm = (receipt.filesWritten || []).map(normalizeCheckpointTarget);
          writtenNorm.forEach(function(t) { allWrittenFilesSet.add(t); });
          const cpEntries = (receipt.parsedFiles && receipt.parsedFiles.length)
            ? receipt.parsedFiles
            : writtenNorm.map(function(rel) {
                return { relPath: rel, inputSha256: (receipt.fileHashes && receipt.fileHashes[rel]) || '' };
              });
          if (!receipt.checkpointPersisted && cpEntries.length && !receipt.skippedFromCheckpoint) {
            executor.persistCheckpointReceiptOnce(codePath, receipt, cpEntries, cleanRoot, checkpointIdentity);
          }
          const cpHeader = buildBatchCheckpointHeader({
            planFingerprint: currentPlanFingerprint,
            batchIndex: i,
            targetKeys: writtenNorm.map(function(t) { return normalizeTargetKey(t, cleanRoot); })
          });
          const curCode = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : (codeHeaderLine + NL);
          const nextCode = (curCode.includes('CODE_PLAN_META') ? curCode : (codeHeaderLine + NL + curCode)) + NL + cpHeader + NL;
          writeFileAtomic(codePath, nextCode);

          const curState = readProjectState(cleanRoot);
          const verifiedBatches = Object.assign({}, (curState && curState.verifiedBatches) || {});
          const checkpoints = Object.assign({}, (curState && curState.checkpoints) || {});
          const batchKey = batches[i].batchId || ('BATCH_' + (i + 1));
          const prevRec = verifiedBatches[batchKey];
          const prevTargets = (prevRec && String(prevRec.planFingerprint || '').toLowerCase() === currentPlanFingerprint && Array.isArray(prevRec.targets))
            ? prevRec.targets
            : [];
          const mergedTargets = Array.from(new Set(prevTargets.concat(writtenNorm)));
          const cpRecord = {
            batchId: batchKey,
            batchIndex: i,
            planFingerprint: currentPlanFingerprint,
            targets: mergedTargets,
            verifiedAt: new Date().toISOString()
          };
          verifiedBatches[batchKey] = cpRecord;
          checkpoints[batchKey] = cpRecord;
          writeProjectState(cleanRoot, {
            phase: 'CODED',
            lastStatus: 'BATCH_VERIFIED',
            requestFingerprint: currentRequestFingerprint,
            planFingerprint: currentPlanFingerprint,
            verifiedBatches: verifiedBatches,
            checkpoints: checkpoints
          });

          state.contractMemory = buildCrossBatchContractSummary(receipt, state.contractMemory).text;
          state.changedFiles.push(...(receipt.filesWritten || []));
        }
        job.completed = i + 1;
      }

      let allWrittenFiles = Array.from(allWrittenFilesSet).sort();
      job.phase = 'FINAL_APPLY_AND_TEST';
      let finalChecks = await executor.runFinalBuildAndTests(cleanRoot);
      writeFileAtomic(logPath, JSON.stringify(finalChecks, null, 2));

      const isEnvironmentToolingError = function(text) {
        const raw = String(text || '');
        return /No \.NET SDKs were found|dotnet\/sdk-not-found|MSB\d{4}:.*(?:SDK|reference assemblies)|is not recognized as an internal or external command|command not found|ENOENT|EACCES|EPERM/i.test(raw);
      };
      const isArchiveOrIgnoredTarget = function(relPath) {
        return /^(?:artifacts|archive|archives|backup|backups|snapshots|packages|obj|bin|\.localpersonalai|\.antigravity|node_modules)\//i.test(String(relPath || '').replace(/\\/g, '/'));
      };
      const allowedPlanTargets = new Set(batches.flatMap(function(b) { return (b && Array.isArray(b.targets)) ? b.targets.map(normalizeCheckpointTarget) : []; }));

      let environmentErrorDetected = null;
      if (finalChecks.status !== 'CHECK_PASSED' && isEnvironmentToolingError(JSON.stringify(finalChecks))) {
        environmentErrorDetected = (finalChecks.repairEvidence && finalChecks.repairEvidence.errorExcerpt) || 'ENVIRONMENT_TOOLING_FAILED';
      }

      for (let repairRound = 1; repairRound <= 2 && finalChecks.status !== 'CHECK_PASSED' && !environmentErrorDetected; repairRound++) {
        const errorText = JSON.stringify(finalChecks);
        const nonArchiveFiles = scan.files.map(function(f) { return f.path; }).filter(function(p) {
          return !isArchiveOrIgnoredTarget(p) || allowedPlanTargets.has(normalizeCheckpointTarget(p));
        });
        const knownTargets = Array.from(new Set([...allWrittenFiles, ...nonArchiveFiles]));
        const mentioned = extractTargetsFromError(errorText, knownTargets);
        if (!mentioned.length) break;
        job.phase = 'INTEGRATION_REPAIR';
        state.lastErrorReceipt = 'FINAL_APPLY_AND_TEST_FAILED (round ' + repairRound + '):' + NL + truncateUtf8(errorText, 12000);
        const repairBatch = { batchId: 'INTEGRATION-REPAIR-' + repairRound, targets: mentioned.slice(0, 2), halvingLevel: 1 };
        const receipts = await executeBatchWithRecovery(repairBatch, state, routing, job, { compact: true, singleRetry: true });
        for (const receipt of receipts) {
          batchReceipts.push(receipt);
          (receipt.filesWritten || []).map(normalizeCheckpointTarget).forEach(function(t) { allWrittenFilesSet.add(t); });
          const cpEntries = (receipt.parsedFiles && receipt.parsedFiles.length)
            ? receipt.parsedFiles
            : writtenNorm.map(function(rel) {
                return { relPath: rel, inputSha256: (receipt.fileHashes && receipt.fileHashes[rel]) || '' };
              });
          if (!receipt.checkpointPersisted && cpEntries.length && !receipt.skippedFromCheckpoint) {
            executor.persistCheckpointReceiptOnce(codePath, receipt, cpEntries, cleanRoot, checkpointIdentity);
          }
        }
        allWrittenFiles = Array.from(allWrittenFilesSet).sort();
        finalChecks = await executor.runFinalBuildAndTests(cleanRoot);
        writeFileAtomic(logPath, JSON.stringify(finalChecks, null, 2));
        if (finalChecks.status === 'CHECK_PASSED') state.lastErrorReceipt = '';
        else if (isEnvironmentToolingError(JSON.stringify(finalChecks))) {
          environmentErrorDetected = (finalChecks.repairEvidence && finalChecks.repairEvidence.errorExcerpt) || 'ENVIRONMENT_TOOLING_FAILED';
          break;
        }
      }

      if (finalChecks.status !== 'CHECK_PASSED') {
        writeProjectState(cleanRoot, {
          phase: 'BUILD_FAILED',
          lastStatus: environmentErrorDetected ? 'ENVIRONMENT_TOOLING_FAILED' : 'FINAL_APPLY_AND_TEST_FAILED',
          lastError: environmentErrorDetected ? truncateUtf8(environmentErrorDetected, 1000) : undefined,
          requestFingerprint: currentRequestFingerprint,
          planFingerprint: currentPlanFingerprint
        });
        throw new Error(environmentErrorDetected ? ('ENVIRONMENT_TOOLING_FAILED: ' + truncateUtf8(environmentErrorDetected, 400)) : 'FINAL_APPLY_AND_TEST_FAILED');
      }
      allWrittenFiles = Array.from(allWrittenFilesSet).sort();
      job.phase = 'REVIEWING';
      let diffStdout = '';
      try {
        const diffResult = spawnSyncFn('git', ['diff', '--', ...allWrittenFiles], { cwd: cleanRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        diffStdout = (diffResult && diffResult.stdout) || '';
      } catch (_) {}

      if (!diffStdout || diffStdout.trim().length === 0) {
        const diffChunks = [];
        for (const rel of allWrittenFiles) {
          const abs = path.join(cleanRoot, rel);
          if (fs.existsSync(abs)) {
            const fileLines = fs.readFileSync(abs, 'utf8').split('\n');
            diffChunks.push('--- /dev/null\n+++ b/' + rel + '\n@@ -0,0 +1,' + fileLines.length + ' @@\n' + fileLines.map(function(l) { return '+' + l; }).join('\n'));
          }
        }
        diffStdout = diffChunks.join('\n');
      }

      const review = buildDiffFocusedReviewContext({
        plan: planText,
        changedFiles: allWrittenFiles,
        diff: diffStdout,
        batchReceipts: batchReceipts,
        finalTests: fs.readFileSync(logPath, 'utf8'),
        knownRisks: []
      });

      const reviewPathContext = path.join(exchangeDir, 'rev_ctx.txt');
      writeFileAtomic(reviewPathContext, review.chunks.join(NL + NL + '--- REVIEW CHUNK ---' + NL + NL));

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

      writeFileAtomic(reviewPath, reviewText);
      const reviewVerdicts = String(reviewText || '').split(/\r?\n/).map(function(line) {
        return line.replace(/[*#]/g, '').trim();
      }).map(function(line) {
        return line.match(/^STATUS:\s*(APPROVED|PASSED|CHANGES_REQUIRED|FAILED|REJECTED)\b/i);
      }).filter(Boolean).map(function(match) { return match[1].toUpperCase(); });

      const approved = reviewVerdicts.some(function(verdict) { return verdict === 'APPROVED' || verdict === 'PASSED'; }) &&
                       !reviewVerdicts.some(function(verdict) { return verdict === 'CHANGES_REQUIRED' || verdict === 'FAILED' || verdict === 'REJECTED'; });

      writeProjectState(cleanRoot, {
        phase: approved ? 'COMPLETED' : 'REVIEW_FAILED',
        lastStatus: approved ? 'CYCLE_COMPLETED' : 'REVIEW_FAILED',
        requestFingerprint: currentRequestFingerprint,
        planFingerprint: currentPlanFingerprint
      });

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
      job.phase = job.cancelled ? 'CANCELLED' : (err && err.code === 'PLAN_NO_VALID_TARGETS' ? 'PLAN_FAILED' : 'FAILED');
      job.error = err.message || String(err);
      job.result = null;
      throw err;
    }
  }

  async function runFullCycle(projectRoot, userRequest, opts) {
    const cleanRoot = path.resolve(projectRoot);
    let job = activeCycleJobs[cleanRoot];
    if (!job || !job.running) {
      const p = runAutonomousPipeline(cleanRoot, userRequest || '', opts);
      job = activeCycleJobs[cleanRoot];
      if (job) {
        job.promise = p;
        p.catch(function(err) {
          if (job) {
            job.running = false;
            job.error = err.message || String(err);
            job.result = { status: 'FAILED', error: job.error };
          }
        });
      }
    }
    if (opts && opts.blocking === false) {
      return await waitJobSlice(cleanRoot, opts.maxSliceMs || 22000);
    }
    if (job && job.promise) {
      try {
        return await job.promise;
      } catch (err) {
        if (job && job.result) return job.result;
        throw err;
      }
    }
    while (job && job.running) {
      await sleepFn(200);
    }
    if (job && job.error) throw new Error(job.error);
    return job ? job.result : { status: 'NO_ACTIVE_JOB' };
  }

  async function checkCycleProgress(projectRoot, maxSliceMs) {
    const cleanRoot = path.resolve(projectRoot);
    const job = activeCycleJobs[cleanRoot];
    if (!job) return { status: 'NO_ACTIVE_JOB' };
    if (!job.running) {
      if (job.error) throw new Error(job.error);
      return job.result;
    }
    if (!maxSliceMs && job.promise) {
      try {
        return await job.promise;
      } catch (err) {
        if (job.result) return job.result;
        throw err;
      }
    }
    return await waitJobSlice(cleanRoot, maxSliceMs || 180000);
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
    migrateLegacyCheckpointReceipts,
    appendBatchAudit,
    classifyAttachmentHandshakeStrict,
    dispatchAdmittedBatch,
    isResumablePlannedPhase,
    evaluatePlanCache,
    invalidateStaleCycleArtifacts,
    buildBatchCheckpointHeader,
    extractCheckpointPlanFingerprint,
    verifyBatchCheckpoint,
    writeFileAtomic
  };
}

function dispatchAdmittedBatch(batch, dispatchFn) {
  const raw = batch && (batch.patchLines != null ? batch.patchLines : (batch.estimatedPatchLines != null ? batch.estimatedPatchLines : batch.patchLineEstimate));
  const numeric = Number(raw || 0);
  const patchLines = Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : 0;
  if (patchLines > 800) throw new Error('PATCH_EXCEEDS_SIZE_LIMIT: ' + patchLines + ' lines exceeds maximum 800');
  if (patchLines > 500 && !(batch && batch.allowExtendedPatch === true)) throw new Error('PATCH_REQUIRES_EXTENDED_ALLOWANCE: ' + patchLines + ' lines requires explicit extended allowance');
  return dispatchFn();
}

module.exports = {
  createAutopilotEngine,
  BATCH_LIFECYCLE_PHASES,
  LIFECYCLE_TRANSIENTS,
  createRecoveryBudgets,
  classifyBatchLifecycleError,
  consumeRecoveryBudget,
  firstUnverifiedBatch,
  prepareNextBatchSession,
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
  isEngineFailoverEligible,
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
  migrateLegacyCheckpointReceipts,
  appendBatchAudit,
  dispatchAdmittedBatch,
  packWorkspace,
  getBundleAttachmentAndNote,
  resolveAndEmbedExternalFiles,
  buildBudgetedWorkspaceBundle,
  inferRepositoryLanguage,
  extractRepositorySignals,
  resolveDependencyPath,
  ADAPTIVE_HALVING_CODES,
  RESUMABLE_PLANNED_PHASES,
  isResumablePlannedPhase,
  evaluatePlanCache,
  invalidateStaleCycleArtifacts,
  buildCodePlanMetaHeader,
  buildBatchCheckpointHeader,
  extractCheckpointPlanFingerprint,
  verifyBatchCheckpoint,
  writeFileAtomic
};
