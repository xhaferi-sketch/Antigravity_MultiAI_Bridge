'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Universal Target Path Utilities for Antigravity MultiAI Bridge & Hermes Orchestrator
 * Single source of truth for parsing, sanitizing, normalizing file targets,
 * and computing deterministic request/plan cryptographic fingerprints.
 */

const KNOWN_EXTENSIONLESS_FILES = new Set([
  'makefile',
  'dockerfile',
  'jenkinsfile',
  'vagrantfile',
  'procfile',
  'gemfile',
  'rakefile',
  'brewfile',
  'justfile',
  'taskfile',
  'caddyfile',
  'codeowners',
  'license',
  'readme',
  'changelog',
  'notice',
  'authors'
]);

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function isSafeRelativeChild(rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (rel === '..' || rel.startsWith('../')) return false;
  if (path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) return false;
  return true;
}

function unwrapMarkdownLink(rawText) {
  if (typeof rawText !== 'string') {
    return { matched: false, candidate: null };
  }

  const trimmed = rawText.trim();
  const match = trimmed.match(/^(?:\*\*|__)?\[([^\]]+)\]\(((?:\([^()]*\)|[^()])+)\)(?:\*\*|__)?(.*)$/);
  if (!match) {
    return { matched: false, candidate: null };
  }

  const label = String(match[1] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
  let href = String(match[2] || '').trim();

  // Strip optional <...> wrapper and optional link title ("title" or 'title')
  const angleMatch = href.match(/^<([^>]+)>(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/);
  if (angleMatch) {
    href = angleMatch[1].trim();
  } else {
    href = href.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim();
    href = href.replace(/^<|>$/g, '').trim();
  }

  // Fail-closed traversal check on raw href (never fall back to label on traversal)
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(href)) {
    return { matched: true, candidate: null, rejectedReason: 'PATH_TRAVERSAL_REJECTED' };
  }

  // Handle file:// URIs
  if (/^file:\/\//i.test(href)) {
    let filePath = href.replace(/^file:\/\//i, '').replace(/#.*$/, '');
    if (/^localhost\//i.test(filePath)) {
      filePath = filePath.slice('localhost'.length);
    }
    if (/^\/+[A-Za-z]:[\\/]/.test(filePath)) {
      filePath = filePath.replace(/^\/+/, '');
    }
    try {
      filePath = decodeURIComponent(filePath);
    } catch (_) {}
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filePath)) {
      return { matched: true, candidate: null, rejectedReason: 'PATH_TRAVERSAL_REJECTED' };
    }
    return { matched: true, candidate: filePath };
  }

  // External URLs, anchors, placeholders, or empty href -> use label
  if (!href || /^(?:https?:\/\/|mailto:)/i.test(href) || href.startsWith('#') || /^\.{3,}$/.test(href)) {
    if (!label || /^(?:https?:\/\/|mailto:)/i.test(label)) {
      return { matched: true, candidate: null, rejectedReason: 'EXTERNAL_LINK_NON_FILE' };
    }
    return { matched: true, candidate: label };
  }

  // Local / relative path href
  let localHref = href.replace(/#.*$/, '').trim();
  try {
    localHref = decodeURIComponent(localHref);
  } catch (_) {}

  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(localHref)) {
    return { matched: true, candidate: null, rejectedReason: 'PATH_TRAVERSAL_REJECTED' };
  }

  if (!localHref) {
    if (!label || /^(?:https?:\/\/|mailto:)/i.test(label)) {
      return { matched: true, candidate: null, rejectedReason: 'EXTERNAL_LINK_NON_FILE' };
    }
    return { matched: true, candidate: label };
  }

  return { matched: true, candidate: localHref };
}

function stripInlineColonComment(segment) {
  let s = String(segment || '').replace(/:\s+.*$/, '');
  const idx = s.indexOf(':');
  if (idx === -1) return s;

  const lhs = s.slice(0, idx);
  const rhs = s.slice(idx + 1);
  if (!lhs || /[\\/]$/.test(lhs)) return s;

  const base = path.posix.basename(lhs.replace(/\\/g, '/'));
  const lhsHasExt = (/\.[a-zA-Z0-9]{1,16}$/.test(base) && base.length > 1) ||
    KNOWN_EXTENSIONLESS_FILES.has(base.toLowerCase());

  if (!lhsHasExt) return s;
  if (!rhs.length) return s;
  if (rhs.startsWith('$') || /:\$/.test(rhs)) return s;
  if (/^zone\.identifier(?::|$)/i.test(rhs)) return s;
  if (!/\s/.test(rhs) && /\.[a-zA-Z0-9]{1,16}$/.test(rhs)) return s;

  return lhs;
}

function stripNoSpaceTrailingAnnotations(text) {
  let out = text;

  // No-space parentheses after file extension or known extensionless file: e.g. "file.cs(I RI)"
  out = out.replace(/(\.[a-zA-Z0-9]{1,16})\([^)]*\).*$/, '$1');
  const parenMatch = out.match(/^(.+?)\([^)]*\).*$/);
  if (parenMatch && !/[\\/]$/.test(parenMatch[1])) {
    const candidateBase = path.posix.basename(parenMatch[1].replace(/\\/g, '/'));
    if (KNOWN_EXTENSIONLESS_FILES.has(candidateBase.toLowerCase())) {
      out = parenMatch[1];
    }
  }

  return out;
}

function stripNoSpaceTrailingBrackets(text) {
  let out = text;

  // No-space brackets after file extension or known extensionless file: e.g. "file.cs[NEW]"
  out = out.replace(/(\.[a-zA-Z0-9]{1,16})\[[^\]]*\].*$/, '$1');
  const bracketMatch = out.match(/^(.+?)\[[^\]]*\].*$/);
  if (bracketMatch && !/[\\/]$/.test(bracketMatch[1])) {
    const candidateBase = path.posix.basename(bracketMatch[1].replace(/\\/g, '/'));
    if (KNOWN_EXTENSIONLESS_FILES.has(candidateBase.toLowerCase())) {
      out = bracketMatch[1];
    }
  }

  return out;
}

function unwrapBalancedEmphasis(text) {
  if (/^\*\*([^*]+)\*\*$/.test(text)) {
    const inner = text.slice(2, -2).trim();
    if (inner && !inner.startsWith('/') && !inner.endsWith('/')) {
      return inner;
    }
  }
  if (/^__([^_]+)__$/.test(text)) {
    const inner = text.slice(2, -2).trim();
    if (inner && !inner.startsWith('/') && !inner.endsWith('/')) {
      return inner;
    }
  }
  return text;
}

function sanitizeTargetPath(rawEntry, projectRoot) {
  if (typeof rawEntry !== 'string' || !rawEntry.replace(/^\uFEFF/, '').trim()) {
    return { path: null, rejectedReason: 'EMPTY' };
  }

  let text = rawEntry.replace(/^\uFEFF/, '').trim();

  // 1. Remove markdown prefixes: blockquotes (>), headings (#), bullet lists (- , * , + ), numbering (1. ), task checkboxes ([x] )
  // Require whitespace after list bullets so globs like "*.cs" are NOT stripped into ".cs".
  text = text.replace(/^(?:>\s*)+/, '');
  text = text.replace(/^#{1,6}\s+/, '');
  text = text.replace(/^(?:[-*+]\s+)+/, '');
  text = text.replace(/^\d+\.\s+/, '');
  text = text.replace(/^\[[ xX]\]\s+/, '');
  text = text.replace(/^\+\s+/, '');
  text = unwrapBalancedEmphasis(text);

  // 2. Remove FILE_TARGET(S): or TARGET(S): prefix (case-insensitive), including bold wrappers (** or __)
  text = text.replace(/^(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*:\s*(?:\*\*|__)\s*/i, '');
  text = text.replace(/^(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*(?:\*\*|__)\s*:\s*/i, '');
  text = text.replace(/^\*+\s*(?:FILE_TARGETS?|TARGETS?)\s*:\s*\*+\s*/i, '');
  text = text.replace(/^(?:FILE_TARGETS?|TARGETS?)\s*:\s*/i, '');
  text = unwrapBalancedEmphasis(text);

  // 2.5 Markdown links, leading status tags ([NEW] ), and leading backticked tokens with annotations
  let linkInfo = unwrapMarkdownLink(text);
  if (linkInfo.matched) {
    if (linkInfo.rejectedReason) {
      return { path: null, rejectedReason: linkInfo.rejectedReason };
    }
    text = String(linkInfo.candidate || '').trim();
  }

  const leadingTagMatch = text.match(/^\[[^\]]{1,32}\]\s+(.+)$/);
  if (leadingTagMatch) {
    text = leadingTagMatch[1].trim();
    linkInfo = unwrapMarkdownLink(text);
    if (linkInfo.matched) {
      if (linkInfo.rejectedReason) {
        return { path: null, rejectedReason: linkInfo.rejectedReason };
      }
      text = String(linkInfo.candidate || '').trim();
    }
  }

  const backtickTokenMatch = text.match(/^(?:\*\*|__)?`([^`]+)`(?:\*\*|__)?(?:\s*(?:—|–|-|:|\(|\[|$).*|\s+.*)$/);
  if (backtickTokenMatch) {
    text = backtickTokenMatch[1].trim();
  }

  // 3. Remove enclosing quotes or backticks
  text = text.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();

  if (!text) {
    return { path: null, rejectedReason: 'EMPTY_AFTER_PREFIX' };
  }

  const hasTraversalSegment = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(text);

  // 4. Disk-First Check: If projectRoot is provided, test if the raw candidate exists on disk
  // Skip Disk-First Check for any explicit traversal segment (..) so traversal is always fail-closed.
  const isSafeProjectRoot = typeof projectRoot === 'string' && projectRoot.trim().length > 0;
  if (isSafeProjectRoot && !hasTraversalSegment && !/[<>"|?*]/.test(text)) {
    try {
      const directResolved = path.resolve(projectRoot, text);
      if (fs.existsSync(directResolved)) {
        const rel = path.relative(projectRoot, directResolved).replace(/\\/g, '/');
        if (isSafeRelativeChild(rel) && !/[<>:"|?*]/.test(rel)) {
          return { path: rel };
        }
      }
    } catch (_) {
      // Continue to regex-based cleaning
    }
  }

  // 5. Clean explanatory comments and annotations
  // If there is an opening parenthesis for annotations (e.g. " (169B, plain — ...") or no-space "file.cs(I RI)"
  text = text.replace(/\s+\(.*$/, '');
  text = stripNoSpaceTrailingAnnotations(text);

  // Remove trailing em-dash / en-dash / spaced-hyphen comments: e.g. " — lexim dhe zgjerim..."
  text = text.replace(/\s+[—–]\s*.*$/, '');
  text = text.replace(/\s+-\s+.*$/, '');

  // Remove trailing colon comments: e.g. "path/to/file.ext: description" or "file.ext:përshkrim"
  // Preserve Windows drive letters ("C:/..." or "C:\...") and stay fail-closed against NTFS ADS
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    const drivePrefix = text.slice(0, 3);
    const rest = stripInlineColonComment(text.slice(3));
    text = drivePrefix + rest;
  } else {
    text = stripInlineColonComment(text);
  }

  // Strip trailing metadata brackets like " [size]" or no-space "file.cs[NEW]"
  text = text.replace(/\s+\[[^\]]*\](?:\s*.*)?$/, '').trim();
  text = stripNoSpaceTrailingBrackets(text);

  // Strip remaining enclosing quotes/backticks and balanced markdown bold wrappers,
  // but NEVER strip wildcard '*' characters so globs like "*.cs" or "src/**" are caught fail-closed.
  text = text.replace(/[`"']/g, '').replace(/^_+|_+$/g, '').trim();
  text = unwrapBalancedEmphasis(text);

  // Repeat trailing bracket cleanup in case brackets were enclosed inside quotes/bold
  text = text.replace(/\s+\[[^\]]*\](?:\s*.*)?$/, '').trim();
  text = stripNoSpaceTrailingBrackets(text).trim();

  // Fail-closed check for illegal Windows characters and globs before canonical normalization
  if (/[<>"|?*]/.test(text)) {
    return { path: null, rejectedReason: 'ILLEGAL_PATH_CHARACTERS' };
  }

  // 6. Canonical Normalization
  let normalized = text.replace(/\\/g, '/');
  // Collapse multiple slashes and strip leading ./ or .//
  normalized = normalized.replace(/\/+/g, '/');
  normalized = normalized.replace(/^\.\//, '');
  normalized = normalized.replace(/\/$/, '');

  // Reject explicit traversal segments before converting absolute paths
  const preAbsSegments = normalized.split('/').filter(Boolean);
  if (preAbsSegments.includes('..')) {
    return { path: null, rejectedReason: 'PATH_TRAVERSAL_REJECTED' };
  }

  // If absolute path provided, convert to relative to projectRoot if possible
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    if (isSafeProjectRoot) {
      const bothWinDrive = /^[A-Za-z]:\//.test(normalized) && /^[A-Za-z]:[\\/]/.test(projectRoot);
      const rel = (bothWinDrive
        ? path.win32.relative(projectRoot, normalized)
        : path.relative(projectRoot, normalized)
      ).replace(/\\/g, '/');
      if (isSafeRelativeChild(rel)) {
        normalized = rel;
      } else {
        return { path: null, rejectedReason: 'OUTSIDE_PROJECT_ROOT' };
      }
    } else {
      return { path: null, rejectedReason: 'ABSOLUTE_WITHOUT_ROOT' };
    }
  }

  // If relative path starts with projectRoot basename (e.g. "App/scripts/..." when projectRoot is ".../App"),
  // strip the redundant leading folder name so targets resolve deterministically within projectRoot.
  if (projectRoot && !path.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized)) {
    const rootBase = path.basename(projectRoot).toLowerCase();
    const firstSlash = normalized.indexOf('/');
    if (firstSlash !== -1 && normalized.slice(0, firstSlash).toLowerCase() === rootBase) {
      const stripped = normalized.slice(firstSlash + 1);
      if (stripped.length > 0 && isSafeRelativeChild(stripped)) {
        normalized = stripped;
      }
    }
  }

  // 7. Fail-Closed Validation
  if (!normalized) {
    return { path: null, rejectedReason: 'EMPTY_NORMALIZED' };
  }

  // Path traversal check
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) {
    return { path: null, rejectedReason: 'PATH_TRAVERSAL_REJECTED' };
  }

  // Control characters or metadata markers check
  if (/[\x00-\x1f\n\r—–]/.test(normalized)) {
    return { path: null, rejectedReason: 'METADATA_MARKERS_REMAINING' };
  }

  // Illegal Windows characters check (including ':' since drive letters are already normalized out)
  if (/[<>:"|?*]/.test(normalized)) {
    return { path: null, rejectedReason: 'ILLEGAL_PATH_CHARACTERS' };
  }

  return { path: normalized };
}

function normalizeTargetKey(filePath, projectRoot) {
  const result = sanitizeTargetPath(filePath, projectRoot);
  if (!result.path) return '';
  const cleanPath = result.path;
  if (process.platform === 'win32') {
    return cleanPath.toLowerCase();
  }
  return cleanPath;
}

function isValidCleanRelativePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const res = sanitizeTargetPath(p);
  return !!res.path && !res.path.startsWith('..') && res.path.length <= 260;
}

function resolveProjectRoot(rawPath) {
  if (!rawPath) return { root: process.cwd(), matchedMarker: null, resolutionMode: 'EXACT_FALLBACK' };
  let current = path.resolve(rawPath);
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch (_) {}

  const TIER1A_MARKERS = ['.git', '.hg', '.svn'];
  const TIER1B_EXACT_MARKERS = [
    'package.json', 'pnpm-workspace.yaml', 'tsconfig.json',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'CMakeLists.txt', 'Makefile', 'Directory.Build.props', '.hermes'
  ];
  const TIER1B_EXTENSIONS = ['.sln', '.csproj', '.vbproj', '.addin'];

  function hasMarker(dir) {
    for (const m of TIER1A_MARKERS) {
      if (fs.existsSync(path.join(dir, m))) return m;
    }
    for (const m of TIER1B_EXACT_MARKERS) {
      if (fs.existsSync(path.join(dir, m))) return m;
    }
    try {
      const files = fs.readdirSync(dir);
      const match = files.find(f => TIER1B_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
      if (match) return match;
    } catch (_) {}
    return null;
  }

  // Priority 1: Stop-at-Self Rule
  const selfMarker = hasMarker(current);
  if (selfMarker) {
    return { root: current, matchedMarker: selfMarker, resolutionMode: 'EXACT_MARKER' };
  }

  // Priority 2: Bounded Ancestor Walk-Up (up to 6 levels, stop at home, temp, or container dirs)
  const home = os.homedir().toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  const SYSTEM_CONTAINERS = ['projects', 'temp', 'tmp', 'appdata'];

  let candidate = current;
  for (let depth = 0; depth < 6; depth++) {
    const parent = path.dirname(candidate);
    if (!parent || parent === candidate) break;
    const parentLower = parent.toLowerCase();
    if (parentLower === home || parentLower === tmp) break;

    // Container guard: do not walk up past container dirs like 'projects', 'temp', etc.
    const parentBase = path.basename(parent).toLowerCase();
    if (SYSTEM_CONTAINERS.includes(parentBase)) break;

    const ancestorMarker = hasMarker(parent);
    if (ancestorMarker) {
      return { root: parent, matchedMarker: ancestorMarker, resolutionMode: 'ANCESTOR_MARKER' };
    }
    candidate = parent;
  }

  // Priority 3: Fallback Determinist
  return { root: current, matchedMarker: null, resolutionMode: 'EXACT_FALLBACK' };
}

function normalizeFingerprintText(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function (line) {
      return line.replace(/[ \t]+/g, ' ').trim();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function computeRequestFingerprint(userRequest, embeddedSpecs) {
  if (embeddedSpecs === undefined) embeddedSpecs = '';
  const canonicalPayload = JSON.stringify({
    v: 1,
    request: normalizeFingerprintText(userRequest),
    specs: normalizeFingerprintText(embeddedSpecs)
  });
  return crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

function stripPlanMetadataHeader(planText) {
  let text = String(planText ?? '');
  const metaHeaderRegex = /^\uFEFF?\s*<!--\s*ANTIGRAVITY_PLAN_META\b[\s\S]*?-->\s*/i;
  while (metaHeaderRegex.test(text)) {
    text = text.replace(metaHeaderRegex, '');
  }
  return text;
}

function computePlanFingerprint(planText) {
  const normalizedBody = normalizeFingerprintText(stripPlanMetadataHeader(planText));
  return crypto.createHash('sha256').update(normalizedBody, 'utf8').digest('hex');
}

function embedPlanMetadataHeader(planText, meta) {
  meta = meta || {};
  const cleanBody = stripPlanMetadataHeader(planText);
  const reqFp = typeof meta.requestFingerprint === 'string' && SHA256_HEX_RE.test(meta.requestFingerprint.trim())
    ? meta.requestFingerprint.trim().toLowerCase()
    : '';
  const planFp = typeof meta.planFingerprint === 'string' && SHA256_HEX_RE.test(meta.planFingerprint.trim())
    ? meta.planFingerprint.trim().toLowerCase()
    : computePlanFingerprint(cleanBody);
  const generatedAt = typeof meta.generatedAt === 'string' && meta.generatedAt.trim()
    ? meta.generatedAt.trim()
    : new Date().toISOString();

  const header = [
    '<!-- ANTIGRAVITY_PLAN_META',
    'requestFingerprint: ' + reqFp,
    'planFingerprint: ' + planFp,
    'generatedAt: ' + generatedAt,
    '-->'
  ].join('\n');

  return cleanBody ? (header + '\n' + cleanBody) : (header + '\n');
}

function extractPlanMetadataHeader(planText) {
  const empty = { requestFingerprint: null, planFingerprint: null, generatedAt: null };
  if (typeof planText !== 'string' || !planText) return empty;

  const match = planText.match(/^\uFEFF?\s*<!--\s*ANTIGRAVITY_PLAN_META\b([\s\S]*?)-->/i);
  if (!match) return empty;

  const block = match[1];
  const reqMatch = block.match(/^\s*requestFingerprint\s*:\s*([^\r\n]+)$/mi);
  const planMatch = block.match(/^\s*planFingerprint\s*:\s*([^\r\n]+)$/mi);
  const genMatch = block.match(/^\s*generatedAt\s*:\s*([^\r\n]+)$/mi);

  const rawReq = reqMatch ? reqMatch[1].trim() : '';
  const rawPlan = planMatch ? planMatch[1].trim() : '';
  const rawGen = genMatch ? genMatch[1].trim() : '';

  return {
    requestFingerprint: SHA256_HEX_RE.test(rawReq) ? rawReq.toLowerCase() : null,
    planFingerprint: SHA256_HEX_RE.test(rawPlan) ? rawPlan.toLowerCase() : null,
    generatedAt: rawGen || null
  };
}

function classifyPlanSectionHeading(headingText) {
  const upper = String(headingText || '').normalize('NFKC').toUpperCase();
  const hasAllowed = /\bALLOWED[_ ]FILES\b/.test(upper);
  const hasGoals = /\b(OBJEKTIV|OBJEKTIVI|GOAL|GOALS)\b/.test(upper);
  const hasForbidden = /\b(FORBIDDEN[_ ]FILES|FORBIDDEN|NON-GOALS|NON_GOALS|ZERO-DIFF|ZERO_DIFF|READ-ONLY|READ_ONLY|OUT OF SCOPE)\b/.test(upper);

  // Combined parent heading like "## 3. ALLOWED_FILES & FORBIDDEN_FILES" or "## 1. OBJEKTIVI & NON-GOALS" stays NEUTRAL until subheadings appear
  if (hasAllowed && hasForbidden) return 'NEUTRAL';
  if (hasGoals && hasForbidden) return 'NEUTRAL';
  if (hasForbidden) return 'FORBIDDEN';
  if (hasAllowed) return 'ALLOWED';
  return 'NEUTRAL';
}

function cleanForbiddenToken(rawToken) {
  let token = String(rawToken || '').trim();
  token = token.replace(/^(?:>\s*)+/, '');
  token = token.replace(/^#{1,6}\s+/, '');
  token = token.replace(/^(?:[-*+]\s+)+/, '');
  token = token.replace(/^\d+\.\s+/, '');
  token = token.replace(/^\[[ xX]\]\s+/, '');
  token = token.replace(/^\+\s+/, '');
  token = unwrapBalancedEmphasis(token);
  token = token.replace(/^(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*:\s*(?:\*\*|__)\s*/i, '');
  token = token.replace(/^(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*(?:\*\*|__)\s*:\s*/i, '');
  token = token.replace(/^(?:FILE_TARGETS?|TARGETS?)\s*:\s*/i, '');

  const linkInfo = unwrapMarkdownLink(token);
  if (linkInfo.matched && linkInfo.candidate) {
    token = linkInfo.candidate.trim();
  }

  const leadingBacktick = token.match(/^(?:\*\*|__)?`([^`]+)`(?:\*\*|__)?/);
  if (leadingBacktick) {
    token = leadingBacktick[1].trim();
  } else {
    token = token.replace(/\s+\(.*$/, '');
    token = token.replace(/\s+[—–]\s*.*$/, '');
    token = token.replace(/\s+-\s+.*$/, '');
    token = token.replace(/:\s+.*$/, '');
    // Preserve '*' so glob patterns like ".hermes/**" stay intact
    token = token.replace(/[`"']/g, '').replace(/^_+|_+$/g, '').trim();
    token = unwrapBalancedEmphasis(token);
  }

  const hadTrailingSlash = /[/\\]\s*$/.test(token);
  token = token.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '').trim();
  if (hadTrailingSlash && token && !token.endsWith('/**')) {
    token = token + '/**';
  }
  return token;
}

function extractForbiddenTokensFromLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return [];

  const strippedList = trimmed
    .replace(/^(?:>\s*)+/, '')
    .replace(/^(?:[-*+]\s+)+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^\+\s+/, '')
    .replace(/\s+\([^)]*\)\s*$/, '')
    .trim();

  if (!strippedList) return [];

  // Support both single-entry lines and comma-separated entries (e.g., "package.json, package-lock.json")
  const rawParts = strippedList.includes(',')
    ? strippedList.split(',').map(function (p) { return p.trim(); }).filter(Boolean)
    : [strippedList];

  const results = [];
  for (const part of rawParts) {
    const cleaned = cleanForbiddenToken(part);
    if (!cleaned) continue;
    // Ignore pure multi-word prose sentences (e.g., "Çdo skedar jashtë listës ALLOWED_FILES")
    if ((cleaned.match(/\s+/g) || []).length >= 2 && !cleaned.includes('/') && !cleaned.includes('*')) {
      continue;
    }
    if (!results.includes(cleaned)) results.push(cleaned);
  }
  return results;
}

function isLikelyFilePath(cleanPath, isFileOnDisk) {
  if (isFileOnDisk) return true;
  if (!cleanPath) return false;

  const spaceGroups = cleanPath.match(/\s+/g) || [];
  if (spaceGroups.length >= 2) return false;

  const base = path.posix.basename(cleanPath);
  const hasSlash = cleanPath.includes('/');
  const hasExt = /\.[a-zA-Z0-9]{1,16}$/.test(base) && base.length > 1;
  const isKnownExtensionless = KNOWN_EXTENSIONLESS_FILES.has(base.toLowerCase());

  if (spaceGroups.length > 0 && !hasExt) return false;

  return hasSlash || hasExt || isKnownExtensionless;
}

function scanDepthZeroParts(text) {
  const parts = [];
  let current = '';
  let inBacktick = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      current += ch;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      current += ch;
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      current += ch;
      continue;
    }

    if (ch === '`') {
      inBacktick = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + 1 < text.length ? text[i + 1] : '';
      if (!(/[a-zA-Z0-9]/.test(prev) && /[a-zA-Z0-9]/.test(next))) {
        inSingleQuote = true;
      }
      current += ch;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      current += ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      current += ch;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      current += ch;
      continue;
    }

    if ((ch === ',' || ch === ';') && parenDepth === 0 && bracketDepth === 0) {
      const trimmedPart = current.trim();
      if (trimmedPart) parts.push(trimmedPart);
      current = '';
      continue;
    }

    current += ch;
  }

  const lastPart = current.trim();
  if (lastPart) parts.push(lastPart);
  return parts;
}

function hasTopLevelCommentDelimiter(segment) {
  let outsideAll = '';
  let outsideBrackets = '';
  let inBacktick = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inBacktick) {
      if (ch === '`') {
        inBacktick = false;
      } else if (parenDepth === 0 && bracketDepth === 0) {
        outsideBrackets += ch;
      }
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--;
      continue;
    }
    if (parenDepth === 0 && bracketDepth === 0) {
      outsideAll += ch;
      outsideBrackets += ch;
    }
  }

  if (/\s+[—–]\s*|\s+-\s+|:\s+/.test(outsideAll)) {
    return true;
  }

  const checkColon = outsideBrackets.trim();
  const withoutDrive = /^[A-Za-z]:[\\/]/.test(checkColon) ? checkColon.slice(3) : checkColon;
  if (withoutDrive.includes(':') && stripInlineColonComment(withoutDrive) !== withoutDrive) {
    return true;
  }

  return false;
}

function splitTargetCandidates(rawBody, projectRoot) {
  const trimmed = String(rawBody || '').trim();
  if (!trimmed) return [];

  // Disk-First Safety: preserve existing files on disk whose names contain commas or semicolons
  if (projectRoot) {
    const unquoted = trimmed.replace(/^[`'"]+|[`'"]+$/g, '').trim();
    if (unquoted && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(unquoted) && !/[<>"|?*]/.test(unquoted)) {
      try {
        const directResolved = path.resolve(projectRoot, unquoted);
        if (fs.existsSync(directResolved) && fs.statSync(directResolved).isFile()) {
          return [trimmed];
        }
      } catch (_) {}
    }
  }

  const parts = scanDepthZeroParts(trimmed);
  if (parts.length <= 1) {
    return [trimmed];
  }

  // Guard against commas inside trailing explanatory comments
  if (hasTopLevelCommentDelimiter(parts[0])) {
    const hasValidFollowup = parts.slice(1).some(function (seg) {
      const sanitized = sanitizeTargetPath(seg, projectRoot);
      if (!sanitized.path) return false;
      let isFileOnDisk = false;
      if (projectRoot) {
        try {
          const abs = path.resolve(projectRoot, sanitized.path);
          isFileOnDisk = fs.existsSync(abs) && fs.statSync(abs).isFile();
        } catch (_) {}
      }
      return isLikelyFilePath(sanitized.path, isFileOnDisk);
    });
    if (!hasValidFollowup) {
      return [trimmed];
    }
  }

  return parts;
}

function extractPlanTargets(planText, projectRoot) {
  if (typeof planText !== 'string' || !planText.replace(/^\uFEFF/, '').trim()) {
    return { targets: [], rejected: [], forbiddenPatterns: [] };
  }

  // Strip BOM and HTML comments (including ANTIGRAVITY_PLAN_META) before line scanning
  const uncommented = planText.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = uncommented.replace(/\r\n?/g, '\n').split('\n');

  const fileTargetCandidates = [];
  const allowedListCandidates = [];
  const forbiddenPatterns = [];
  const forbiddenPatternSet = new Set();

  let inFencedCode = false;
  let fenceChar = '';
  let fenceLen = 0;
  let sectionMode = 'NEUTRAL';
  let sectionLevel = 0;

  const directiveInHeadingRe = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*:\s*(?:\*\*|__)|(?:\*\*|__)?\s*(?:FILE_TARGETS?|TARGETS?)\s*(?:\*\*|__)?\s*:)\s*(.+)$/i;
  const fileTargetLineRe = /^\s*(?:[-*+>]\s*|\+\s+|\d+\.\s+|\[[ xX]\]\s+)*(?:(?:\*\*|__)\s*(?:FILE_TARGETS?|TARGETS?)\s*:\s*(?:\*\*|__)|(?:\*\*|__)?\s*(?:FILE_TARGETS?|TARGETS?)\s*(?:\*\*|__)?\s*:)\s*(.+)$/i;
  const listItemLineRe = /^\s*(?:[-*+]\s+|\d+\.\s+)(?:\[[ xX]\]\s+)?(.+)$/;
  const standaloneBacktickLineRe = /^\s*(?:\*\*|__)?`([^`]+)`(?:\*\*|__)?(?:\s*(?:—|–|-|:|\(|\[|,|;).*)?\s*$/;
  const standaloneLinkLineRe = /^\s*(?:\*\*|__)?\[([^\]]+)\]\(((?:\([^()]*\)|[^()])+)\)(?:\*\*|__)?.*$/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Track fenced code blocks (``` or ~~~)
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const currentChar = fenceMatch[1][0];
      const currentLen = fenceMatch[1].length;
      if (!inFencedCode) {
        inFencedCode = true;
        fenceChar = currentChar;
        fenceLen = currentLen;
      } else if (currentChar === fenceChar && currentLen >= fenceLen && /^(`{3,}|~{3,})\s*$/.test(trimmed)) {
        inFencedCode = false;
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    if (inFencedCode) continue;
    if (!trimmed) continue;

    // Standalone directive line without markdown heading (e.g. "ALLOWED_FILES:" or "**ALLOWED_FILES:**" or "FORBIDDEN_FILES:")
    const standaloneSectionMatch = trimmed.match(/^(?:\*\*|__)?\s*(ALLOWED[_ ]FILES|FORBIDDEN[_ ]FILES)\s*:?\s*(?:\*\*|__)?\s*$/i);
    if (standaloneSectionMatch) {
      const norm = standaloneSectionMatch[1].toUpperCase().replace(/\s+/g, '_');
      sectionMode = norm === 'ALLOWED_FILES' ? 'ALLOWED' : 'FORBIDDEN';
      sectionLevel = 99;
      continue;
    }

    // Detect Markdown headings or standalone bold headings (excluding bold-wrapped code/link tokens)
    const mdHeadingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    let boldHeadingMatch = !mdHeadingMatch ? trimmed.match(/^\*\*([^*]+)\*\*\s*$/) : null;
    if (boldHeadingMatch) {
      const boldInner = boldHeadingMatch[1].trim();
      if (/^`[^`]+`$/.test(boldInner) || /^\[[^\]]+\]\((?:\([^()]*\)|[^()])+\)$/.test(boldInner)) {
        boldHeadingMatch = null;
      }
    }

    if (mdHeadingMatch || boldHeadingMatch) {
      const headingLevel = mdHeadingMatch ? mdHeadingMatch[1].length : 7;
      const innerText = (mdHeadingMatch ? mdHeadingMatch[2] : boldHeadingMatch[1]).trim();
      const unwrappedInner = unwrapBalancedEmphasis(innerText);

      // Case 1: Heading containing an explicit FILE_TARGET(S): / TARGET(S): directive
      const headingDirectiveMatch = unwrappedInner.match(directiveInHeadingRe);
      if (headingDirectiveMatch) {
        if (sectionMode === 'FORBIDDEN' && headingLevel > sectionLevel) {
          const tokens = extractForbiddenTokensFromLine(unwrappedInner);
          for (const tok of tokens) {
            const key = process.platform === 'win32' ? tok.toLowerCase() : tok;
            if (!forbiddenPatternSet.has(key)) {
              forbiddenPatternSet.add(key);
              forbiddenPatterns.push(tok);
            }
          }
          continue;
        }
        if (sectionMode !== 'NEUTRAL' && headingLevel <= sectionLevel) {
          sectionMode = 'NEUTRAL';
          sectionLevel = 0;
        }
        const candidates = splitTargetCandidates(headingDirectiveMatch[1], projectRoot);
        for (const cand of candidates) {
          fileTargetCandidates.push({
            raw: trimmed,
            candidate: cand,
            source: 'FILE_TARGET'
          });
        }
        continue;
      }

      // Case 2: Normal section heading with hierarchical sectionLevel tracking
      const classified = classifyPlanSectionHeading(unwrappedInner);
      if (classified !== 'NEUTRAL') {
        sectionMode = classified;
        sectionLevel = headingLevel;
      } else if (sectionMode === 'NEUTRAL' || headingLevel <= sectionLevel) {
        sectionMode = 'NEUTRAL';
        sectionLevel = 0;
      }
      continue;
    }

    if (sectionMode === 'FORBIDDEN') {
      const tokens = extractForbiddenTokensFromLine(trimmed);
      for (const tok of tokens) {
        const key = process.platform === 'win32' ? tok.toLowerCase() : tok;
        if (!forbiddenPatternSet.has(key)) {
          forbiddenPatternSet.add(key);
          forbiddenPatterns.push(tok);
        }
      }
      continue;
    }

    // Explicit FILE_TARGET(S): / TARGET(S): directive (allowed in any non-FORBIDDEN section)
    const ftMatch = rawLine.match(fileTargetLineRe);
    if (ftMatch) {
      const candidates = splitTargetCandidates(ftMatch[1], projectRoot);
      for (const cand of candidates) {
        fileTargetCandidates.push({
          raw: trimmed,
          candidate: cand,
          source: 'FILE_TARGET'
        });
      }
      continue;
    }

    // Markdown list items, standalone backticked paths, or standalone Markdown links under ALLOWED_FILES
    if (sectionMode === 'ALLOWED') {
      const listMatch = rawLine.match(listItemLineRe);
      if (listMatch) {
        const candidates = splitTargetCandidates(listMatch[1], projectRoot);
        for (const cand of candidates) {
          allowedListCandidates.push({
            raw: trimmed,
            candidate: cand,
            source: 'ALLOWED_FILES'
          });
        }
        continue;
      }

      const btLineMatch = rawLine.match(standaloneBacktickLineRe);
      if (btLineMatch) {
        const candidates = splitTargetCandidates(trimmed, projectRoot);
        for (const cand of candidates) {
          allowedListCandidates.push({
            raw: trimmed,
            candidate: cand,
            source: 'ALLOWED_FILES'
          });
        }
        continue;
      }

      const linkLineMatch = rawLine.match(standaloneLinkLineRe);
      if (linkLineMatch) {
        const candidates = splitTargetCandidates(trimmed, projectRoot);
        for (const cand of candidates) {
          allowedListCandidates.push({
            raw: trimmed,
            candidate: cand,
            source: 'ALLOWED_FILES'
          });
        }
        continue;
      }

      // Direct relative path without list marker (e.g. "src/LocalPersonalAI...cs")
      if (/^[a-zA-Z0-9_.-]+[\\/][a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+(?:\s.*)?$/.test(trimmed)) {
        const candidates = splitTargetCandidates(trimmed, projectRoot);
        for (const cand of candidates) {
          allowedListCandidates.push({
            raw: trimmed,
            candidate: cand,
            source: 'ALLOWED_FILES'
          });
        }
        continue;
      }
    }
  }

  // Build normalized forbidden lookup structures
  const forbiddenExactKeys = new Set();
  const forbiddenGlobPrefixes = [];
  for (const pat of forbiddenPatterns) {
    const normPat = pat.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (normPat.endsWith('/**')) {
      const prefix = normPat.slice(0, -2); // keep trailing '/'
      forbiddenGlobPrefixes.push(process.platform === 'win32' ? prefix.toLowerCase() : prefix);
    } else if (normPat === '**') {
      continue;
    } else {
      const fKey = normalizeTargetKey(normPat, projectRoot);
      if (fKey) forbiddenExactKeys.add(fKey);
    }
  }

  const targets = [];
  const seenKeys = new Set();
  const rejected = [];

  // Process FILE_TARGET candidates first, then additional ALLOWED_FILES candidates
  const orderedCandidates = fileTargetCandidates.concat(allowedListCandidates);

  for (const item of orderedCandidates) {
    const sanitized = sanitizeTargetPath(item.candidate, projectRoot);
    if (!sanitized.path) {
      rejected.push({
        raw: item.raw,
        reason: sanitized.rejectedReason || 'INVALID_PATH',
        source: item.source
      });
      continue;
    }

    const cleanPath = sanitized.path;

    // .git metadata security guard
    const pathSegments = cleanPath.split('/');
    if (pathSegments.some(function (seg) { return seg.toLowerCase() === '.git'; })) {
      rejected.push({
        raw: item.raw,
        reason: 'GIT_METADATA_FORBIDDEN',
        source: item.source
      });
      continue;
    }

    // Disk checks when projectRoot is supplied
    let isFileOnDisk = false;
    let isDirOnDisk = false;
    if (projectRoot) {
      try {
        const abs = path.resolve(projectRoot, cleanPath);
        if (fs.existsSync(abs)) {
          const stat = fs.statSync(abs);
          isFileOnDisk = stat.isFile();
          isDirOnDisk = stat.isDirectory();
        }
      } catch (_) {}
    }

    if (isDirOnDisk) {
      rejected.push({
        raw: item.raw,
        reason: 'TARGET_IS_DIRECTORY',
        source: item.source
      });
      continue;
    }

    // Anti-prose guard (zero hardcoding)
    if (!isLikelyFilePath(cleanPath, isFileOnDisk)) {
      rejected.push({
        raw: item.raw,
        reason: 'PROSE_OR_NON_FILE_REJECTED',
        source: item.source
      });
      continue;
    }

    // FORBIDDEN_FILES guard
    const key = normalizeTargetKey(cleanPath, projectRoot);
    const comparePath = process.platform === 'win32' ? cleanPath.toLowerCase() : cleanPath;
    const isForbiddenExact = key && forbiddenExactKeys.has(key);
    const isForbiddenByPrefix = forbiddenGlobPrefixes.some(function (prefix) {
      return comparePath.startsWith(prefix);
    });
    if (isForbiddenExact || isForbiddenByPrefix) {
      rejected.push({
        raw: item.raw,
        reason: 'FORBIDDEN_TARGET',
        source: item.source
      });
      continue;
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      targets.push(cleanPath);
    }
  }

  return {
    targets: targets,
    rejected: rejected,
    forbiddenPatterns: forbiddenPatterns
  };
}

module.exports = {
  sanitizeTargetPath,
  normalizeTargetKey,
  isValidCleanRelativePath,
  resolveProjectRoot,
  normalizeFingerprintText,
  computeRequestFingerprint,
  stripPlanMetadataHeader,
  computePlanFingerprint,
  embedPlanMetadataHeader,
  extractPlanMetadataHeader,
  extractPlanTargets
};