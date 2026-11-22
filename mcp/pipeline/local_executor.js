'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const { execSync: nodeExecSync, spawnSync: nodeSpawnSync, spawn: nodeSpawn } = require('node:child_process');
let targetPathUtilsModule = null;
function getTargetPathUtils() {
  if (!targetPathUtilsModule) {
    try {
      const modName = ['./', 'target_path_utils'].join('');
      targetPathUtilsModule = module.require(modName);
    } catch (_) {
      targetPathUtilsModule = {};
    }
  }
  return targetPathUtilsModule;
}
function sanitizeTargetPath(rawEntry, projectRoot) {
  const mod = getTargetPathUtils();
  return typeof mod.sanitizeTargetPath === 'function'
    ? mod.sanitizeTargetPath(rawEntry, projectRoot)
    : { path: String(rawEntry || '').replace(/\\/g, '/').replace(/^\.\//, '') };
}
function normalizeTargetKey(val, projectRoot) {
  const mod = getTargetPathUtils();
  return typeof mod.normalizeTargetKey === 'function'
    ? mod.normalizeTargetKey(val, projectRoot)
    : String(val || '').toLowerCase().replace(/\\/g, '/');
}
function isValidCleanRelativePath(val) {
  const mod = getTargetPathUtils();
  return typeof mod.isValidCleanRelativePath === 'function'
    ? mod.isValidCleanRelativePath(val)
    : Boolean(val && !val.startsWith('..') && !val.startsWith('/'));
}

const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);

function normalizeGeneratedSourceText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function findUnsafeGeneratedSourceCharacters(value) {
  const matches = [];
  const pattern = /[\u2007\u202f\ufeff]/g;
  let match;
  while ((match = pattern.exec(String(value ?? ''))) !== null) {
    matches.push({
      index: match.index,
      codePoint: 'U+' + match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    });
  }
  return matches;
}

function detectUnpairedSurrogates(text) {
  text = String(text ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= text.length || text.charCodeAt(i + 1) < 0xdc00 || text.charCodeAt(i + 1) > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function truncateUtf8(text, maxBytes) {
  text = String(text ?? '');
  maxBytes = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && text.charCodeAt(lo - 1) >= 0xd800 && text.charCodeAt(lo - 1) <= 0xdbff) lo--;
  return text.slice(0, lo);
}

function normalizeCheckpointTarget(target) {
  const sanitized = sanitizeTargetPath(target);
  return sanitized.path || String(target || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function checkpointTargetAbsolute(cleanRoot, target) {
  if (!cleanRoot) return null;
  const normalized = normalizeCheckpointTarget(target);
  const rootAbs = nodePath.resolve(cleanRoot);
  const targetAbs = nodePath.resolve(rootAbs, normalized);
  if (!normalized || nodePath.isAbsolute(normalized) || (targetAbs !== rootAbs && !targetAbs.startsWith(rootAbs + nodePath.sep))) return null;
  return targetAbs;
}

function computeRepositoryFingerprint(cleanRoot, execSyncFn) {
  const execSync = execSyncFn || nodeExecSync;
  const canonicalRoot = nodePath.resolve(cleanRoot).toLowerCase();
  let gitHead = null, branch = null;
  try { gitHead = execSync('git -C "' + cleanRoot + '" rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) {}
  try { branch = execSync('git -C "' + cleanRoot + '" rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) {}
  return nodeCrypto.createHash('sha256').update(JSON.stringify({ canonicalRoot: canonicalRoot, gitHead: gitHead, branch: branch })).digest('hex');
}

function computeCheckpointIdentity(cleanRoot, planText, execSyncFn) {
  const repoFp = computeRepositoryFingerprint(cleanRoot, execSyncFn);
  const cleanPlan = String(planText || '').replace(/^\uFEFF?\s*<!--\s*ANTIGRAVITY_PLAN_META\b[\s\S]*?-->\s*/i, '').trim();
  const planFp = nodeCrypto.createHash('sha256').update(cleanPlan).digest('hex');
  return { repositoryFingerprint: repoFp, planFingerprint: planFp };
}

function fileReceiptFingerprint(r) {
  return nodeCrypto.createHash('sha256').update(JSON.stringify({
    target: r.target, inputSha256: r.inputSha256, outputSha256: r.outputSha256,
    repositoryFingerprint: r.repositoryFingerprint, planFingerprint: r.planFingerprint,
    parserMode: r.parserMode || null, verificationBasis: r.verificationBasis || null,
    migrationSource: r.migrationSource || null, historicalOutputProvenance: r.historicalOutputProvenance || null,
    syntax: r.syntax, quickCheck: r.quickCheck, status: r.status
  })).digest('hex');
}

function parseCheckpointAudit(auditText) {
  const fileReceipts = new Map(), conflicts = new Set();
  const pattern = /<!--\s*CHECKPOINT_FILE_VERIFIED\s+([\s\S]*?)-->/g;
  let match;
  while ((match = pattern.exec(String(auditText || ''))) !== null) {
    const attr = {}, re = /([A-Za-z][A-Za-z0-9_]*)=([^\s>]+)/g;
    let m;
    while ((m = re.exec(match[1])) !== null) attr[m[1]] = m[2];
    const target = normalizeCheckpointTarget(attr.target);
    if (!target) continue;
    const r = {
      target: target,
      inputSha256: String(attr.inputSha256 || '').toLowerCase(),
      outputSha256: String(attr.outputSha256 || '').toLowerCase(),
      repositoryFingerprint: String(attr.repositoryFingerprint || '').toLowerCase(),
      planFingerprint: String(attr.planFingerprint || '').toLowerCase(),
      parserMode: String(attr.parserMode || ''),
      verificationBasis: String(attr.verificationBasis || ''),
      migrationSource: String(attr.migrationSource || ''),
      historicalOutputProvenance: String(attr.historicalOutputProvenance || ''),
      syntax: String(attr.syntax || ''),
      quickCheck: String(attr.quickCheck || ''),
      status: String(attr.status || '')
    };
    fileReceipts.set(target, r);
  }
  return { fileReceipts: fileReceipts, conflicts: conflicts };
}

function isTargetVerifiedForCheckpoint(auditIndex, target, cleanRoot, checkpointIdentity, fsModule) {
  const fs = fsModule || nodeFs;
  const normalized = normalizeCheckpointTarget(target);
  const receipt = auditIndex && auditIndex.fileReceipts ? auditIndex.fileReceipts.get(normalized) : null;
  if (!receipt || !checkpointIdentity || receipt.status !== 'VERIFIED' || receipt.syntax !== 'PASS' || receipt.quickCheck !== 'PASS' || !/^[a-f0-9]{64}$/.test(receipt.inputSha256) || !/^[a-f0-9]{64}$/.test(receipt.outputSha256)) return false;
  if (receipt.repositoryFingerprint !== checkpointIdentity.repositoryFingerprint || receipt.planFingerprint !== checkpointIdentity.planFingerprint) return false;
  if (auditIndex && auditIndex.conflicts && auditIndex.conflicts.has(normalized)) return false;
  const targetAbs = checkpointTargetAbsolute(cleanRoot, normalized);
  if (!targetAbs || !fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) return false;
  const actualSha256 = nodeCrypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
  return actualSha256 === receipt.outputSha256;
}

function checkpointSyntaxQuickCheck(targetAbs, spawnSyncFn, fsModule) {
  const fs = fsModule || nodeFs;
  const spawnSync = spawnSyncFn || nodeSpawnSync;
  const extension = nodePath.extname(targetAbs).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    const syntaxResult = spawnSync(process.execPath, ['--check', targetAbs], { encoding: 'utf8' });
    return !syntaxResult.error && syntaxResult.status === 0;
  }
  if (extension === '.py') {
    const pyResult = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', targetAbs], { encoding: 'utf8' });
    return !pyResult.error && pyResult.status === 0;
  }
  return fs.statSync(targetAbs).size > 0;
}

function parseCodeBlocksFromMarkdown(markdown, expectedTargets, projectRoot) {
  const source = String(markdown || '');
  const results = [];
  const expectedMap = new Map();
  (expectedTargets || []).forEach(function(x) {
    const k = normalizeTargetKey(x, projectRoot);
    const clean = sanitizeTargetPath(x, projectRoot).path || String(x).replace(/\\/g, '/').replace(/^\.\//, '');
    if (k && clean) expectedMap.set(k, clean);
  });
  const accept = function(relPath, code) {
    const sanitized = sanitizeTargetPath(relPath, projectRoot);
    const clean = sanitized.path;
    const k = normalizeTargetKey(relPath, projectRoot);
    if (!clean || !String(code || '').trim()) return;
    if (expectedMap.size && !expectedMap.has(k)) return;
    const finalRelPath = expectedMap.get(k) || clean;
    const normalizedCode = normalizeGeneratedSourceText(code);
    const unsafeChars = findUnsafeGeneratedSourceCharacters(normalizedCode);
    if (unsafeChars.length > 0) {
      throw new Error('GENERATED_SOURCE_UNSAFE_UNICODE: ' + finalRelPath + ' ' + JSON.stringify(unsafeChars));
    }
    results.push({ relPath: finalRelPath, code: normalizedCode });
  };
  // Nxjerrje universale e mbrojtur nga mbetjet e DOM-it te Gemini (p.sh. "Gemini said")
  const dynamicFencePattern = new RegExp("(?:(?:###\\s*)?(?:Gemini said\\s*)?FILE:\\s*([^\\r\\n`]+)\\r?\\n\\s*)?(`{3,})([a-zA-Z0-9_+-]*)\\r?\\n([\\s\\S]*?)\\r?\\n\\2(?:\\r?\\n|$)", "g");
  let match;
  let fenceIndex = 0;
  while ((match = dynamicFencePattern.exec(source)) !== null) {
    const declaredTarget = match[1];
    const code = match[4];
    if (declaredTarget) {
      accept(declaredTarget, code);
    } else {
      const target = Array.from(expectedMap.values())[fenceIndex++];
      if (target) accept(target, code);
    }
  }
  if (results.length) return results;
  const markers = [];
  const marker = /^\s*(?:###\s*)?(?:Gemini said\s*)?FILE\s*:\s*([^\r\n]+)$/gmi;
  while ((match = marker.exec(source)) !== null) markers.push({ index: match.index, end: marker.lastIndex, line: match[1] });
  const PYTHON_STARTERS = [/^import\s+/, /^from\s+\S+\s+import\s+/, /^def\s+[A-Za-z_]\w*\s*\(/, /^async\s+def\s+[A-Za-z_]\w*\s*\(/, /^class\s+[A-Za-z_]\w*/, /^#/, /^@/, /^#!/, /^if\s+__name__\s*==/, /^try\s*:/, /^with\s+.+:/, /^pass(?:\s|$)/, /^[A-Za-z_]\w*(?:\s*:\s*[^=]+)?\s*=/, /^(?:(?:r|u|f|fr|rf)?(?:"""|'''))/i];
  const JS_STARTERS = [/^(?:import|export)\b/, /^(?:const|let|var)\s+[A-Za-z_$]/, /^function\b/, /^async\s+function\b/, /^class\b/, /^\/\//, /^\/\*/, /^module\.exports\b/, /^require\s*\(/, /^['"]use strict['"];?/, /^(?:describe|test|it)\s*\(/];
  function matchesAnyStarter(text, patterns) { return patterns.some(function(p) { return p.test(text); }); }
  const starters = { cs: /^(?:using|namespace|public|internal|private|protected|class|record|interface|enum|\/\/|#)/, json: /^[{[]/, html: /^(?:<!doctype|<html|<div|<template|<!--)/i, css: /^(?:@|:root|\.|#|[a-z-]+\s*{)/i, sh: /^(?:#!|set\s+-|[a-zA-Z_][a-zA-Z0-9_]*=|function\s+)/ };
  markers.forEach(function(item, i) {
    const tail = source.slice(item.end, i + 1 < markers.length ? markers[i + 1].index : source.length);
    let target = '';
    const candidates = Array.from(expectedMap.values()).map(normalizeCheckpointTarget).sort(function(a, b) { return b.length - a.length; });
    const lowerLine = item.line.toLowerCase();
    target = candidates.find(function(c) {
      const lowerC = c.toLowerCase();
      if (!lowerLine.startsWith(lowerC)) return false;
      const next = item.line.slice(c.length, c.length + 1);
      return next === '' || /\s/.test(next);
    }) || '';
    if (!target) { const token = item.line.trim().split(/\s+/)[0]; target = sanitizeTargetPath(token).path || ''; }
    const targetKey = normalizeTargetKey(target);
    if (!target || (expectedMap.size && !expectedMap.has(targetKey))) return;
    let code = (item.line.slice(target.length) + tail).trim();
    code = code.replace(/^(?:python|javascript|typescript|csharp|json|html|css|bash|shell)\s*/i, '');
    const ext = nodePath.extname(target).slice(1).toLowerCase();
    let kind = '';
    if (ext === 'py') kind = 'py';
    else if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) kind = 'js';
    else if (ext === 'cs') kind = 'cs';
    else if (ext === 'json') kind = 'json';
    else if (['html', 'htm'].includes(ext)) kind = 'html';
    else if (ext === 'css') kind = 'css';
    else if (['sh', 'bash'].includes(ext)) kind = 'sh';
    let lexical = false;
    if (kind === 'py') lexical = matchesAnyStarter(code, PYTHON_STARTERS);
    else if (kind === 'js') lexical = matchesAnyStarter(code, JS_STARTERS);
    else if (starters[kind]) lexical = starters[kind].test(code);
    if (!lexical) return;
    accept(target, code);
    const resolvedTarget = expectedMap.get(targetKey) || target;
    if (results.some(function(x) { return x.relPath === resolvedTarget; })) console.error('[UNFENCED_OUTPUT_RECOVERED] target=' + resolvedTarget + ' parserMode=UNFENCED_FILE_FALLBACK');
  });
  return results;
}

function validateGeneratedCodeMarkdown(markdown, projectRoot) {
  const hasDiffPatch = /^(?:diff --git a\/[^\r\n]+ b\/[^\r\n]+|--- a\/[^\r\n]+\r?\n\+\+\+ b\/[^\r\n]+)/m.test(markdown);
  if (hasDiffPatch) {
    return { valid: true, isPatch: true, fileBlocks: [] };
  }
  const fileBlocks = parseCodeBlocksFromMarkdown(markdown, null, projectRoot);
  if (fileBlocks.length === 0) {
    return { valid: false, reason: 'Mungojne blloqet e kodit (kerkohet diff --git ose ### FILE:).' };
  }
  const forbiddenPatterns = [
    /\/\/\s*\.\.\.\s*(rest of|existing|previous|other)/i,
    /\/\*\s*\.\.\.\s*(rest of|existing)/i,
    /#\s*\.\.\.\s*(rest of|existing)/i,
    /\/\/\s*TODO:\s*implement/i
  ];
  for (const b of fileBlocks) {
    for (const pat of forbiddenPatterns) {
      if (pat.test(b.code)) {
        return { valid: false, reason: 'Placeholder i ndaluar u gjet ne skedarin ' + b.relPath + '. Kerkohet kod 100% i plote.' };
      }
    }
  }
  return { valid: true, fileBlocks: fileBlocks };
}

function atomicWriteValidated(targetPath, content, fsModule, cryptoModule) {
  const fs = fsModule || nodeFs;
  const crypto = cryptoModule || nodeCrypto;
  const dir = nodePath.dirname(targetPath);
  const temp = nodePath.join(dir, '.' + nodePath.basename(targetPath) + '.antigravity-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(temp, content, 'utf8');
  if (!fs.statSync(temp).size) {
    fs.unlinkSync(temp);
    throw new Error('ATOMIC_WRITE_EMPTY: ' + targetPath);
  }
  try {
    fs.renameSync(temp, targetPath);
  } catch (error) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw error;
  }
}

function redactDiagnosticSecrets(value) {
  return String(value || '')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|cookie|password|secret)\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]');
}

function boundedDiagnosticExcerpt(value, maxBytes) {
  const clean = redactDiagnosticSecrets(value);
  const limit = maxBytes || 24000;
  if (Buffer.byteLength(clean, 'utf8') <= limit) return { text: clean, truncated: false };
  const blocks = (clean.match(/(?:Traceback[\s\S]*?(?=\n\S|$)|(?:error|exception|failed)[^\n]*(?:\n[ \t]+[^\n]*){0,12})/ig) || []).join(NL);
  return {
    text: truncateUtf8(clean, 7200) + NL + '...[DIAGNOSTIC_TRUNCATED]...' + NL + truncateUtf8(blocks, 3600) + NL + truncateUtf8(clean.slice(-14000), 13200),
    truncated: true
  };
}

function freshProjectErrorLog(projectRoot, startedMs, fsModule) {
  const fs = fsModule || nodeFs;
  const candidate = nodePath.resolve(projectRoot, 'errors.log');
  const root = nodePath.resolve(projectRoot) + nodePath.sep;
  try {
    const real = fs.realpathSync(candidate);
    const stat = fs.lstatSync(candidate);
    if (!real.startsWith(root) || stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024 || stat.mtimeMs < startedMs) return null;
    return fs.readFileSync(real, 'utf8');
  } catch (_) {
    return null;
  }
}

function tryExtractFileFromAllAdditions(patchText, relPath) {
  const fileHeader = 'diff --git a/' + relPath + ' b/' + relPath;
  const match = patchText.indexOf(fileHeader);
  if (match < 0) return null;
  const tail = patchText.slice(match);
  const nextDiffIndex = tail.slice(fileHeader.length).search(/^diff --git /m);
  const fileDiff = nextDiffIndex >= 0 ? tail.slice(0, fileHeader.length + nextDiffIndex) : tail;
  
  const hunkStart = fileDiff.search(/^@@ /m);
  if (hunkStart < 0) return null;
  const lines = fileDiff.slice(hunkStart).split(/\r?\n/);
  const contentLines = [];
  let inHunk = false;
  let hasPlus = false;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      contentLines.push(line.slice(1));
      hasPlus = true;
    } else if (line.startsWith('-') || line.startsWith(' ')) {
      return null;
    } else if (line.startsWith('\\ No newline')) {
      continue;
    } else if (!line.trim()) {
      contentLines.push('');
    } else {
      return null;
    }
  }
  return hasPlus ? contentLines.join('\n') : null;
}

function applyHunksToText(originalText, fileDiff) {
  const hunkPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const hunkMatches = [];
  let m;
  while ((m = hunkPattern.exec(fileDiff)) !== null) {
    hunkMatches.push({
      index: m.index,
      oldStart: parseInt(m[1], 10),
      oldLen: m[2] !== undefined ? parseInt(m[2], 10) : 1,
      newStart: parseInt(m[3], 10),
      newLen: m[4] !== undefined ? parseInt(m[4], 10) : 1,
      headerLength: m[0].length
    });
  }
  if (!hunkMatches.length) return null;

  let origLines = originalText.split(/\r?\n/);
  let lineOffset = 0;

  for (let i = 0; i < hunkMatches.length; i++) {
    const cur = hunkMatches[i];
    const hunkStart = cur.index + cur.headerLength;
    const hunkEnd = i + 1 < hunkMatches.length ? hunkMatches[i + 1].index : fileDiff.length;
    const hunkBody = fileDiff.slice(hunkStart, hunkEnd);
    const hunkLines = hunkBody.split(/\r?\n/).filter((l, idx, arr) => {
      if (idx === arr.length - 1 && l === '') return false;
      return true;
    });

    const expectedOld = [];
    const replacementNew = [];

    for (const hl of hunkLines) {
      if (hl.startsWith('+')) {
        replacementNew.push(hl.slice(1));
      } else if (hl.startsWith('-')) {
        expectedOld.push(hl.slice(1));
      } else if (hl.startsWith(' ')) {
        expectedOld.push(hl.slice(1));
        replacementNew.push(hl.slice(1));
      } else if (hl.startsWith('\\ No newline')) {
        continue;
      }
    }

    if (!expectedOld.length && !replacementNew.length) continue;

    let searchStart = Math.max(0, cur.oldStart - 1 + lineOffset);
    let matchIdx = -1;

    const matchesAt = (pos) => {
      if (pos + expectedOld.length > origLines.length) return false;
      for (let k = 0; k < expectedOld.length; k++) {
        if (origLines[pos + k].trimEnd() !== expectedOld[k].trimEnd()) return false;
      }
      return true;
    };

    if (matchesAt(searchStart)) {
      matchIdx = searchStart;
    } else {
      for (let delta = 1; delta <= 50; delta++) {
        if (searchStart - delta >= 0 && matchesAt(searchStart - delta)) {
          matchIdx = searchStart - delta;
          break;
        }
        if (searchStart + delta < origLines.length && matchesAt(searchStart + delta)) {
          matchIdx = searchStart + delta;
          break;
        }
      }
    }

    if (matchIdx < 0) {
      return null;
    }

    origLines.splice(matchIdx, expectedOld.length, ...replacementNew);
    lineOffset += replacementNew.length - expectedOld.length;
  }

  return origLines.join('\n');
}

function createLocalExecutor(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required for createLocalExecutor');
  }
  const ctx = runtimeContext;
  const fs = ctx.fs || nodeFs;
  const path = ctx.path || nodePath;
  const crypto = ctx.crypto || nodeCrypto;
  const execSync = ctx.execSync || nodeExecSync;
  const spawnSync = ctx.spawnSync || nodeSpawnSync;
  const ensureProjectSetup = ctx.ensureProjectSetup || function(pRoot) {
    try {
      const rp = path.join(pRoot, '.antigravity', 'bridge', 'routing.json');
      if (fs.existsSync(rp)) return JSON.parse(fs.readFileSync(rp, 'utf8'));
    } catch (_) {}
    return {};
  };

  function applyBatch(args) {
    const root = fs.realpathSync(path.resolve(args.projectRoot));

    const absoluteTarget = function(rel) {
      if (!rel || typeof rel !== 'string') throw new Error('SECURITY_BLOCK: ' + rel);
      const hasTraversal = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rel);
      if (hasTraversal) throw new Error('SECURITY_BLOCK: ' + rel);
      const abs = path.resolve(root, rel);
      if (path.isAbsolute(rel) || (abs !== root && !abs.startsWith(root + path.sep))) {
        throw new Error('SECURITY_BLOCK: ' + rel);
      }
      const parentReal = fs.existsSync(path.dirname(abs)) ? fs.realpathSync(path.dirname(abs)) : null;
      if (parentReal && parentReal !== root && !parentReal.startsWith(root + path.sep)) {
        throw new Error('SECURITY_BLOCK: symlink escape ' + rel);
      }
      return abs;
    };

    const expectedMap = new Map();
    (args.batch && args.batch.targets ? args.batch.targets : []).forEach(function(t) {
      absoluteTarget(t);
      const sanitized = sanitizeTargetPath(t, root);
      const clean = sanitized.path || normalizeCheckpointTarget(t);
      const k = normalizeTargetKey(t, root);
      if (k && clean) expectedMap.set(k, clean);
    });
    const targets = Array.from(expectedMap.values());
    const parsedFiles = (args.parsedFiles || []).map(function(item) {
      absoluteTarget(item.relPath);
      const sanitized = sanitizeTargetPath(item.relPath, root);
      return Object.assign({}, item, { relPath: sanitized.path || normalizeCheckpointTarget(item.relPath) });
    });
    const expected = new Set(targets);
    const seen = new Set();
    const backups = [];
    const backedUp = new Set();
    const temporaryFiles = [];
    let gitIndexBackup = null;
    let gitIndexPath = null;
    const backupOnce = function(rel) {
      if (backedUp.has(rel)) return;
      const abs = absoluteTarget(rel);
      backups.push({ path: rel, exists: fs.existsSync(abs), content: fs.existsSync(abs) ? fs.readFileSync(abs) : null });
      backedUp.add(rel);
    };
    const restoreAll = function() {
      for (let i = backups.length - 1; i >= 0; i--) {
        const backup = backups[i];
        const abs = absoluteTarget(backup.path);
        if (backup.exists) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, backup.content);
        } else if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
        }
        const tmp = abs + '.antigravity-tmp';
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      }
      if (gitIndexBackup && gitIndexPath) fs.writeFileSync(gitIndexPath, gitIndexBackup);
    };

    try {
      const batchOutput = String(args.batchOutput || args.rawOutput || '');
      const patchStart = batchOutput.search(/^diff --git a\/[^\r\n]+ b\/[^\r\n]+/m);
      if (patchStart >= 0) {
        const patchTail = batchOutput.slice(patchStart);
        const fileBlockStart = patchTail.search(/^### FILE:/m);
        let rawPatch = (fileBlockStart >= 0 ? patchTail.slice(0, fileBlockStart) : patchTail).trimEnd();
        rawPatch = rawPatch.replace(/\r?\n```[a-zA-Z0-9_-]*\s*$/g, '').trimEnd();
        const patchText = rawPatch + NL;
        const patchLines = patchText.split('\n').length;
        if (patchLines > 800) {
          throw new Error('PATCH_EXCEEDS_SIZE_LIMIT: ' + patchLines + ' lines exceeds maximum 800');
        }
        if (patchLines > 500 && args.allowExtendedPatch !== true && !(args.batch && args.batch.allowExtendedPatch === true)) {
          throw new Error('PATCH_REQUIRES_EXTENDED_ALLOWANCE: ' + patchLines + ' lines requires explicit extended allowance');
        }

        const patchPaths = [];
        const patchPathPattern = /^diff --git a\/([^\r\n]+) b\/([^\r\n]+)$/gm;
        let match;
        while ((match = patchPathPattern.exec(patchText)) !== null) {
          const oldPath = normalizeCheckpointTarget(match[1]);
          const newPath = normalizeCheckpointTarget(match[2]);
          absoluteTarget(oldPath);
          absoluteTarget(newPath);
          const patchKey = normalizeTargetKey(newPath, root);
          if (oldPath !== newPath || !expectedMap.has(patchKey) || patchPaths.includes(newPath)) {
            throw new Error('PATCH_TARGET_UNAUTHORIZED: ' + newPath);
          }
          patchPaths.push(newPath);
        }
        if (!patchPaths.length) throw new Error('PATCH_PARSE_FAILED');
        const baseSha256 = args.baseSha256 || (args.batch && args.batch.baseSha256);
        if (baseSha256) {
          for (const rel of patchPaths) {
            const abs = absoluteTarget(rel);
            const expectedBase = typeof baseSha256 === 'object' ? baseSha256[rel] : baseSha256;
            const currentBase = fs.existsSync(abs) ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : null;
            if (!expectedBase || String(expectedBase).toLowerCase() !== currentBase) {
              throw new Error('PATCH_BASE_MISMATCH: ' + rel);
            }
          }
        }
        patchPaths.forEach(backupOnce);

        const patchFile = path.join(root, '.antigravity-patch-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.patch');
        temporaryFiles.push(patchFile);
        fs.writeFileSync(patchFile, patchText, 'utf8');
        let check = spawnSync('git', ['apply', '--check', '--recount', '--whitespace=error-all', patchFile], { cwd: root, encoding: 'utf8' });
        let applyArgs = ['apply', '--recount', '--whitespace=error-all', patchFile];
        if (check.error || check.status !== 0) {
          const gitDirResult = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' });
          if (gitDirResult.error || gitDirResult.status !== 0) throw new Error('GIT_THREE_WAY_REQUIRES_REPOSITORY');
          gitIndexPath = path.join(path.resolve(root, String(gitDirResult.stdout || '').trim()), 'index');
          gitIndexBackup = fs.existsSync(gitIndexPath) ? fs.readFileSync(gitIndexPath) : null;
          for (const rel of patchPaths) {
            const identity = spawnSync('git', ['ls-files', '--stage', '--', rel], { cwd: root, encoding: 'utf8' });
            const rows = String(identity.stdout || '').trim().split(/\r?\n/).filter(Boolean);
            if (identity.error || identity.status !== 0 || rows.length !== 1 || !/^100[0-7]{3} [0-9a-f]{40,64} 0\t/.test(rows[0])) {
              throw new Error('GIT_THREE_WAY_BLOB_IDENTITY_MISSING: ' + rel);
            }
          }
          check = spawnSync('git', ['apply', '--check', '--3way', '--recount', '--whitespace=error-all', patchFile], { cwd: root, encoding: 'utf8' });
          applyArgs = ['apply', '--3way', '--recount', '--whitespace=error-all', patchFile];
        }
        let gitApplySuccess = false;
        if (check.error || check.status !== 0) {
          let fallbackSuccess = true;
          for (const rel of patchPaths) {
            const abs = absoluteTarget(rel);
            const extractedAllAdd = tryExtractFileFromAllAdditions(patchText, rel);
            if (extractedAllAdd !== null) {
              backupOnce(rel);
              const tmp = abs + '.antigravity-tmp';
              fs.writeFileSync(tmp, extractedAllAdd, 'utf8');
              fs.renameSync(tmp, abs);
              continue;
            }
            if (fs.existsSync(abs)) {
              const origText = fs.readFileSync(abs, 'utf8');
              const fileHeader = 'diff --git a/' + rel + ' b/' + rel;
              const fStart = patchText.indexOf(fileHeader);
              const fTail = fStart >= 0 ? patchText.slice(fStart) : patchText;
              const nextDiffIdx = fTail.slice(fileHeader.length).search(/^diff --git /m);
              const fileDiff = nextDiffIdx >= 0 ? fTail.slice(0, fileHeader.length + nextDiffIdx) : fTail;
              const patched = applyHunksToText(origText, fileDiff);
              if (patched !== null) {
                backupOnce(rel);
                const tmp = abs + '.antigravity-tmp';
                fs.writeFileSync(tmp, patched, 'utf8');
                fs.renameSync(tmp, abs);
                continue;
              }
            }
            fallbackSuccess = false;
            break;
          }
          if (fallbackSuccess) {
            gitApplySuccess = true;
          } else {
            throw new Error('GIT_APPLY_CHECK_FAILED: ' + truncateUtf8((check.stderr || '') + (check.stdout || ''), 4000));
          }
        }
        if (!gitApplySuccess) {
          const applied = spawnSync('git', applyArgs, { cwd: root, encoding: 'utf8' });
          if (applied.error || applied.status !== 0) {
            throw new Error('GIT_APPLY_FAILED: ' + truncateUtf8((applied.stderr || '') + (applied.stdout || ''), 4000));
          }
          if (applyArgs.includes('--3way')) {
            const unmerged = spawnSync('git', ['ls-files', '--unmerged'], { cwd: root, encoding: 'utf8' });
            if (unmerged.error || unmerged.status !== 0 || String(unmerged.stdout || '').trim()) throw new Error('GIT_APPLY_THREE_WAY_CONFLICT');
          }
        }
        patchPaths.forEach(function(rel) { seen.add(rel); });
      }

      for (const file of parsedFiles) {
        const fileKey = normalizeTargetKey(file.relPath, root);
        if (seen.has(file.relPath) || !expectedMap.has(fileKey)) throw new Error('BATCH_OUTPUT_INCOMPLETE');
        const canonicalRel = expectedMap.get(fileKey) || file.relPath;
        const abs = absoluteTarget(canonicalRel);
        if (detectUnpairedSurrogates(file.code) || Buffer.from(file.code).includes(0)) throw new Error('BUNDLE_INVALID_UNICODE');
        if (fs.existsSync(abs)) {
          const existingStat = fs.statSync(abs);
          if (existingStat.size > 5000 && Buffer.byteLength(file.code, 'utf8') < existingStat.size * 0.25 && file.code.split('\n').length < 30) {
            throw new Error('BATCH_OUTPUT_COLLAPSED_STUB: ' + canonicalRel + ' shrunk from ' + existingStat.size + ' bytes to ' + Buffer.byteLength(file.code, 'utf8') + ' bytes');
          }
        }
        backupOnce(canonicalRel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = abs + '.antigravity-tmp';
        fs.writeFileSync(tmp, file.code, 'utf8');
        fs.renameSync(tmp, abs);
        seen.add(canonicalRel);
      }

      if (seen.size !== expectedMap.size) throw new Error('BATCH_OUTPUT_INCOMPLETE');
      return { status: 'BATCH_APPLIED', filesWritten: Array.from(seen), backups: backups };
    } catch (error) {
      restoreAll();
      throw error;
    } finally {
      for (const file of temporaryFiles) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
    }
  }
  function runBatchQuickChecks(args) {
    const receipts = [];
    for (const rel of args.writtenFiles || []) {
      const full = path.join(args.projectRoot, rel);
      const ext = path.extname(rel).toLowerCase();
      let run = { status: 0, stdout: '', stderr: '' };
      if (['.js', '.mjs', '.cjs'].includes(ext)) {
        run = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      } else if (ext === '.py') {
        run = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', full], { encoding: 'utf8' });
      } else if (ext === '.json') {
        try {
          JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (err) {
          run = { status: 1, stdout: '', stderr: err.message };
        }
      }
      receipts.push({ command: 'syntax ' + rel, status: run.status, output: truncateUtf8((run.stdout || '') + (run.stderr || ''), 12000) });
      if (run.status !== 0) return { status: 'CHECK_FAILED', receipts: receipts };
    }
    return { status: 'CHECK_PASSED', receipts: receipts };
  }

  function executeProcessWithIdleWatchdog(command, cwd, idleTimeoutMs) {
    idleTimeoutMs = idleTimeoutMs || 300000;
    return new Promise(function(resolve) {
      let stdout = '';
      let stderr = '';
      let lastActivityTs = Date.now();
      let timedOut = false;
      let proc;
      try {
        proc = nodeSpawn(command, { cwd: cwd, shell: true });
      } catch (err) {
        return resolve({
          status: 1, signal: null, stdout: '', stderr: String(err && err.message), timedOut: false
        });
      }

      if (proc.stdout) {
        proc.stdout.on('data', function(chunk) {
          lastActivityTs = Date.now();
          stdout += chunk.toString('utf8');
          if (stdout.length > 64 * 1024 * 1024) stdout = stdout.slice(-32 * 1024 * 1024);
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', function(chunk) {
          lastActivityTs = Date.now();
          stderr += chunk.toString('utf8');
          if (stderr.length > 64 * 1024 * 1024) stderr = stderr.slice(-32 * 1024 * 1024);
        });
      }

      const interval = setInterval(function() {
        const idleTime = Date.now() - lastActivityTs;
        if (idleTime >= idleTimeoutMs) {
          timedOut = true;
          clearInterval(interval);
          try {
            if (process.platform === 'win32' && proc.pid) {
              nodeSpawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
            } else if (proc.pid) {
              process.kill(-proc.pid, 'SIGKILL');
            }
          } catch (_) {}
        }
      }, 2000);

      proc.on('close', function(code, signal) {
        clearInterval(interval);
        resolve({
          status: timedOut ? 1 : (code ?? 0),
          signal: signal || null,
          stdout: stdout,
          stderr: stderr,
          timedOut: timedOut
        });
      });

      proc.on('error', function(err) {
        clearInterval(interval);
        resolve({
          status: 1,
          signal: null,
          stdout: stdout,
          stderr: stderr + '\n' + String(err && err.message),
          timedOut: false
        });
      });
    });
  }

  async function runFinalBuildAndTests(projectRoot, optionsOrIdleMs) {
    const routing = ensureProjectSetup(projectRoot);
    const commands = [routing.buildCmd, routing.testCmd].filter(Boolean);
    const receipts = [];
    const logDir = path.join(projectRoot, '.localpersonalai', 'run-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const idleTimeoutMs = (typeof optionsOrIdleMs === 'number' && optionsOrIdleMs > 0)
      ? optionsOrIdleMs
      : (optionsOrIdleMs && optionsOrIdleMs.idleTimeoutMs) || 300000;

    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const startedMs = Date.now();
      const started = process.hrtime.bigint();
      const run = await executeProcessWithIdleWatchdog(command, projectRoot, idleTimeoutMs);
      const stdout = String(run.stdout || '');
      const stderr = String(run.stderr || '');
      const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const full = stderr + (stderr && stdout ? NL : '') + stdout;
      const logPath = path.join(logDir, 'command-' + startedMs + '-' + i + '.log');
      fs.writeFileSync(logPath, redactDiagnosticSecrets(full), 'utf8');
      const fresh = freshProjectErrorLog(projectRoot, startedMs, fs);
      const source = stderr ? 'captured_stderr' : stdout ? 'captured_stdout' : full ? 'run_scoped_command_log' : fresh ? 'fresh_project_errors_log' : 'NONZERO_EXIT_WITHOUT_DIAGNOSTICS';
      const evidence = stderr || stdout || full || fresh || 'NONZERO_EXIT_WITHOUT_DIAGNOSTICS';
      const excerpt = boundedDiagnosticExcerpt(evidence);
      const se = boundedDiagnosticExcerpt(stderr);
      const so = boundedDiagnosticExcerpt(stdout);
      const receipt = {
        command: command, cwd: '.', status: run.status, exitCode: run.status, signal: run.signal || null,
        timedOut: Boolean(run.timedOut), durationMs: durationMs,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        stdoutTruncated: so.truncated, stderrTruncated: se.truncated, logSource: source,
        logPath: path.relative(projectRoot, logPath).replace(/\\/g, '/'),
        logSha256: crypto.createHash('sha256').update(redactDiagnosticSecrets(full)).digest('hex'),
        errorExcerpt: excerpt.text
      };
      receipts.push(receipt);
      if (run.status !== 0) return { status: 'CHECK_FAILED', receipts: receipts, repairEvidence: receipt };
    }
    return { status: 'CHECK_PASSED', receipts: receipts };
  }

  async function applyAndTestDeterministically(projectRoot) {
    const resumeBatchId = 'BATCH-001';
    console.error('[CHECKPOINT_RESUME] resumeBatchId=' + resumeBatchId + ' destructiveReset=false');
    const routing = ensureProjectSetup(projectRoot);
    const cleanRoot = path.resolve(projectRoot);
    const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
    const codePath = path.join(exchangeDir, 'code.md');
    const logPath = path.join(exchangeDir, 'build_test.log');
    const errorPath = path.join(exchangeDir, 'last_error.txt');

    if (!fs.existsSync(codePath)) {
      throw new Error('Skedari exchange/code.md nuk ekziston ende.');
    }

    const rawMarkdown = fs.readFileSync(codePath, 'utf8');
    const check = validateGeneratedCodeMarkdown(rawMarkdown, cleanRoot);
    if (!check.valid) {
      return { status: 'DELEGATE_FALLBACK_EXECUTOR', reason: check.reason, codeFile: codePath };
    }

    const writtenFiles = [];
    if (check.isPatch) {
      const patchStart = rawMarkdown.search(/^(?:diff --git a\/[^\r\n]+ b\/[^\r\n]+|--- a\/[^\r\n]+\r?\n\+\+\+ b\/[^\r\n]+)/m);
      if (patchStart >= 0) {
        let rawPatch = rawMarkdown.slice(patchStart);
        const codeFenceEnd = rawPatch.search(/\r?\n```/);
        if (codeFenceEnd >= 0) rawPatch = rawPatch.slice(0, codeFenceEnd);
        rawPatch = rawPatch.trimEnd() + NL;

        const patchFile = path.join(cleanRoot, '.antigravity-patch-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.patch');
        fs.writeFileSync(patchFile, rawPatch, 'utf8');

        let gitDirArg = [];
        try {
          const revParse = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: cleanRoot, encoding: 'utf8' });
          if (revParse.status === 0 && revParse.stdout) {
            const gitTop = path.resolve(revParse.stdout.trim());
            const absClean = path.resolve(cleanRoot);
            if (gitTop !== absClean && absClean.startsWith(gitTop)) {
              const relSub = path.relative(gitTop, absClean).replace(/\\/g, '/');
              if (relSub) gitDirArg = ['--directory=' + relSub];
            }
          }
        } catch (_) {}

        let gitArgs = ['apply', '--3way', '--recount', '--whitespace=nowarn'].concat(gitDirArg).concat([patchFile]);
        let applyResult = spawnSync('git', gitArgs, { cwd: cleanRoot, encoding: 'utf8' });
        try { fs.unlinkSync(patchFile); } catch (_) {}

        const outText = (applyResult.stdout || '') + (applyResult.stderr || '');
        if (applyResult.error || applyResult.status !== 0 || outText.includes('Skipped patch')) {
          throw new Error('GIT_APPLY_FAILED: ' + (outText || (applyResult.error ? applyResult.error.message : 'Unknown git apply error')));
        }

        const pathMatches = Array.from(rawPatch.matchAll(/^(?:diff --git a\/([^\r\n]+) b\/([^\r\n]+)|--- a\/([^\r\n]+))/gm));
        pathMatches.forEach(function(m) {
          const p = m[2] || m[1] || m[3];
          if (p && !writtenFiles.includes(p)) writtenFiles.push(p);
        });
      }
    } else {
      for (const item of check.fileBlocks) {
        const cleanRel = sanitizeTargetPath(item.relPath, cleanRoot).path || item.relPath;
        const targetAbs = path.resolve(cleanRoot, cleanRel);
        if (!targetAbs.startsWith(cleanRoot + path.sep) && targetAbs !== cleanRoot) {
          throw new Error('SECURITY_BLOCK: Tentative shkrimi jashte projectRoot: ' + item.relPath);
        }
        const parentDir = path.dirname(targetAbs);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        atomicWriteValidated(targetAbs, item.code, fs, crypto);
        writtenFiles.push(item.relPath);
      }
    }

    const commands = [routing.buildCmd, routing.testCmd].map(function(c) { return (c || '').trim(); }).filter(Boolean);
    let combinedLogs = '=== DETERMINISTIC APPLY COMPLETED (' + writtenFiles.length + ' files) ===' + NL + 'Files: ' + writtenFiles.join(', ') + NL;

    for (const cmd of commands) {
      combinedLogs += NL + '$ ' + cmd + NL;
      const run = await executeProcessWithIdleWatchdog(cmd, cleanRoot, 300000);
      const out = (run.stdout || '') + NL + (run.stderr || '');
      combinedLogs += out;

      if (run.status !== 0) {
        const compactErrorLog = ctx.compactErrorLog || function(x) { return x; };
        const compacted = compactErrorLog('COMMAND FAILED: ' + cmd + NL + 'EXIT_CODE: ' + run.status + NL + NL + out);
        fs.writeFileSync(errorPath, compacted, 'utf8');
        fs.writeFileSync(logPath, combinedLogs, 'utf8');
        const readProjectState = ctx.readProjectState || function() { return {}; };
        const writeProjectState = ctx.writeProjectState || function() {};
        const st = readProjectState(cleanRoot);
        const nextRetry = (st.retryCount || 0) + 1;
        writeProjectState(cleanRoot, { phase: 'BUILD_FAILED', retryCount: nextRetry, lastStatus: 'ERROR' });
        return {
          status: 'BUILD_OR_TEST_FAILED',
          failedCommand: cmd,
          exitCode: run.status,
          retryCount: nextRetry,
          maxRetriesReached: nextRetry > (st.maxRetries || 2),
          errorFile: errorPath
        };
      }
    }
    fs.writeFileSync(logPath, combinedLogs, 'utf8');
    const writeProjectState = ctx.writeProjectState || function() {};
    writeProjectState(cleanRoot, { phase: 'APPLIED_AND_VERIFIED', lastStatus: 'BUILD_OK' });
    return { status: 'APPLIED_AND_GREEN', writtenFiles: writtenFiles, commandsExecuted: commands, logFile: logPath };
  }

  function migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity) {
    if (!fs.existsSync(codePath)) return;
    const auditText = fs.readFileSync(codePath, 'utf8');
    const auditIndex = parseCheckpointAudit(auditText);
    const legacyPattern = /^### FILE:\s*(.+?)\s*$/gm;
    const migrated = [], seen = new Set();
    let match;
    while ((match = legacyPattern.exec(auditText)) !== null) {
      const target = normalizeCheckpointTarget(match[1]);
      if (!target || seen.has(target) || (auditIndex.fileReceipts && auditIndex.fileReceipts.has(target))) continue;
      seen.add(target);
      const targetAbs = checkpointTargetAbsolute(cleanRoot, target);
      if (!targetAbs || !fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile() || !checkpointSyntaxQuickCheck(targetAbs, spawnSync, fs)) continue;
      const outputSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
      migrated.push('<!-- CHECKPOINT_FILE_VERIFIED target=' + target + ' inputSha256=' + outputSha256 + ' outputSha256=' + outputSha256 + ' repositoryFingerprint=' + checkpointIdentity.repositoryFingerprint + ' planFingerprint=' + checkpointIdentity.planFingerprint + ' parserMode=LEGACY_VERIFIED_MIGRATION verificationBasis=CURRENT_STATE_MIGRATION migrationSource=LEGACY_FILE_HEADER historicalOutputProvenance=UNPROVEN syntax=PASS quickCheck=PASS status=VERIFIED -->');
    }
    if (migrated.length > 0) fs.appendFileSync(codePath, NL + NL + migrated.join(NL) + NL, 'utf8');
  }

  function appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity) {
    if (!cleanRoot) cleanRoot = path.resolve(path.dirname(codePath), '..', '..');
    if (!checkpointIdentity) checkpointIdentity = computeCheckpointIdentity(cleanRoot, '', execSync);
    const targetSetSha256 = crypto.createHash('sha256').update(JSON.stringify(parsed.map(x => normalizeCheckpointTarget(x.relPath)).sort())).digest('hex');
    const header = NL + NL + '<!-- CHECKPOINT_BATCH_VERIFIED batchId=' + receipt.batchId + ' targetSetSha256=' + targetSetSha256 + ' repositoryFingerprint=' + (checkpointIdentity ? checkpointIdentity.repositoryFingerprint : '') + ' planFingerprint=' + (checkpointIdentity ? checkpointIdentity.planFingerprint : '') + ' status=VERIFIED -->' + NL + '<!-- ' + receipt.batchId + ' -->' + NL;
    const entries = parsed.map(function(x) {
      const target = normalizeCheckpointTarget(x.relPath), targetAbs = checkpointTargetAbsolute(cleanRoot, target);
      if (!targetAbs || !fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) throw new Error('CHECKPOINT_TARGET_NOT_FOUND: ' + target);
      const outputSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
      const inputSha256 = /^[a-f0-9]{64}$/i.test(String(x.inputSha256 || '')) ? String(x.inputSha256).toLowerCase() : outputSha256;
      return '<!-- CHECKPOINT_FILE_VERIFIED target=' + target + ' inputSha256=' + inputSha256 + ' outputSha256=' + outputSha256 + ' repositoryFingerprint=' + (checkpointIdentity ? checkpointIdentity.repositoryFingerprint : '') + ' planFingerprint=' + (checkpointIdentity ? checkpointIdentity.planFingerprint : '') + ' parserMode=FENCED verificationBasis=BATCH_APPLY migrationSource=NEW_APPLY historicalOutputProvenance=VERIFIED syntax=PASS quickCheck=PASS status=VERIFIED -->' + NL + '### FILE: ' + target + NL + FENCE3 + path.extname(target).slice(1) + NL + x.code + NL + FENCE3;
    });
    fs.appendFileSync(codePath, header + entries.join(NL + NL), 'utf8');
  }

  function persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
    const auditText = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : '';
    const auditIndex = parseCheckpointAudit(auditText);
    const unpersisted = parsedFiles.filter(function(item) {
      const target = normalizeCheckpointTarget(item.relPath);
      return !isTargetVerifiedForCheckpoint(auditIndex, target, cleanRoot, checkpointIdentity, fs);
    });
    if (unpersisted.length > 0) {
      appendBatchAudit(codePath, receipt, unpersisted, cleanRoot, checkpointIdentity);
    }
  }

  return {
    applyBatch,
    runBatchQuickChecks,
    runFinalBuildAndTests,
    applyAndTestDeterministically,
    migrateLegacyCheckpointReceipts,
    appendBatchAudit,
    persistCheckpointReceiptOnce
  };
}

let defaultLocalExecutorInstance = null;
function getDefaultLocalExecutor() {
  if (!defaultLocalExecutorInstance) {
    defaultLocalExecutorInstance = createLocalExecutor({});
  }
  return defaultLocalExecutorInstance;
}

function applyBatch(args) {
  return getDefaultLocalExecutor().applyBatch(args);
}

function runBatchQuickChecks(args) {
  return getDefaultLocalExecutor().runBatchQuickChecks(args);
}

async function repairBatchOnce(args) {
  if (args && args.repairsUsed >= 1) throw new Error('BATCH_REPAIR_EXHAUSTED');
  return Object.assign({}, args, { repairsUsed: 1 });
}

function persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
  return getDefaultLocalExecutor().persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity);
}

module.exports = {
  createLocalExecutor,
  applyBatch,
  runBatchQuickChecks,
  repairBatchOnce,
  persistCheckpointReceiptOnce,
  normalizeGeneratedSourceText,
  findUnsafeGeneratedSourceCharacters,
  detectUnpairedSurrogates,
  parseCodeBlocksFromMarkdown,
  validateGeneratedCodeMarkdown,
  atomicWriteValidated,
  parseCheckpointAudit,
  computeCheckpointIdentity,
  computeRepositoryFingerprint,
  isTargetVerifiedForCheckpoint,
  checkpointSyntaxQuickCheck,
  checkpointTargetAbsolute,
  normalizeCheckpointTarget,
  redactDiagnosticSecrets,
  boundedDiagnosticExcerpt,
  freshProjectErrorLog
};
