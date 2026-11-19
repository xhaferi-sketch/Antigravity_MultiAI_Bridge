'use strict';
 
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
 
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');
 
const EXPECTED_TEST_MODE_EXPORTS = [
  'CHUNK_ENGINE_LIMITS',
  'analyzeRepositoryChunks',
  'applyBatch',
  'buildBatchContext',
  'buildBatchMiniMap',
  'buildCompactRepoMap',
  'buildCrossBatchContractSummary',
  'buildDependencyGraph',
  'buildDiffFocusedReviewContext',
  'buildFinalPlanningContext',
  'buildLocalStructuralChunkSummary',
  'buildMinimalBatchContext',
  'classifyAttachmentHandshakeStrict',
  'extractBatchPlanSlice',
  'extractTargetsFromError',
  'getFailoverEngines',
  'halveBatchAdaptively',
  'isAdaptiveHalvingFailure',
  'normalizeFailureCode',
  'parseAndValidatePlanBatches',
  'parseCodeBlocksFromMarkdown',
  'partitionAnalysisChunks',
  'partitionCodingBatches',
  'persistCheckpointReceiptOnce',
  'repairBatchOnce',
  'runBatchQuickChecks',
  'runCodingBatch',
  'scanRepositoryUniversal',
  'scoreAnalysisChunkRelevance',
  'selectAdaptiveReasoningLevel',
  'selectCodingTransport',
  'writeChunkContextFile'
].sort();
 
function readSource() {
  assert.ok(fs.existsSync(SERVER_PATH), `Missing ${SERVER_PATH}`);
  return fs.readFileSync(SERVER_PATH, 'utf8');
}
 
function maskCommentsAndStrings(source) {
  let output = '';
  let state = 'code';
  let quote = '';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        output += '\n';
        state = 'code';
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'regex') {
      if (escaped) {
        output += ' ';
        escaped = false;
        continue;
      }
      if (char === '\\') {
        output += ' ';
        escaped = true;
        continue;
      }
      if (char === '/') {
        output += ' ';
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'string') {
      if (escaped) {
        output += char === '\n' ? '\n' : ' ';
        escaped = false;
        continue;
      }

      if (char === '\\') {
        output += ' ';
        escaped = true;
        continue;
      }

      if (char === quote) {
        output += ' ';
        state = 'code';
        quote = '';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      output += ' ';
      quote = char;
      state = 'string';
      continue;
    }

    if (char === '/') {
      // Check if this slash starts a regex literal (preceded by operator, bracket, colon, etc.)
      const prevNonWhitespace = output.trimEnd().slice(-1);
      if ('=([:,!&|?~;{\n'.includes(prevNonWhitespace) || output.trimEnd().endsWith('return') || output.trimEnd().endsWith('throw')) {
        output += ' ';
        state = 'regex';
        continue;
      }
    }

    output += char;
  }

  return output;
}
 
function topLevelInventory(source) {
  const masked = maskCommentsAndStrings(source);
  const lines = masked.split(/\r?\n/);
  const symbols = [];
  let depth = 0;
 
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
 
    if (depth === 0) {
      const functionMatch = line.match(
        /^\s*(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/
      );
 
      if (functionMatch) {
        symbols.push({
          symbolName: functionMatch[2],
          symbolKind: functionMatch[1] ? 'async-function' : 'function',
          baselineLocation: `mcp/server.js:${lineIndex + 1}`
        });
      }
 
      const declarationMatch = line.match(/^\s*(const|let|var)\s+(.+)$/);
      if (declarationMatch) {
        const declaration = declarationMatch[2];
        const firstEquals = declaration.indexOf('=');
        const namesPart =
          firstEquals === -1 ? declaration : declaration.slice(0, firstEquals);
 
        const names = namesPart
          .split(',')
          .map((part) => part.trim())
          .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
 
        for (const symbolName of names) {
          symbols.push({
            symbolName,
            symbolKind: declarationMatch[1],
            baselineLocation: `mcp/server.js:${lineIndex + 1}`
          });
        }
      }
    }
 
    for (const char of line) {
      if (char === '{') depth += 1;
      if (char === '}') depth = Math.max(0, depth - 1);
    }
  }
 
  return symbols;
}
 
function extractTestModeExports(source) {
  const marker = source.indexOf(
    "if(process.env.ANTIGRAVITY_TEST_EXPORT==='1')"
  );
  assert.notEqual(marker, -1, 'Missing ANTIGRAVITY_TEST_EXPORT export block');
 
  const exportStart = source.indexOf('module.exports', marker);
  assert.notEqual(exportStart, -1, 'Missing module.exports in test block');
 
  const objectStart = source.indexOf('{', exportStart);
  assert.notEqual(objectStart, -1, 'Missing module.exports object');
 
  let depth = 0;
  let objectEnd = -1;
 
  for (let index = objectStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        objectEnd = index;
        break;
      }
    }
  }
 
  assert.notEqual(objectEnd, -1, 'Unterminated module.exports object');
 
  return source
    .slice(objectStart + 1, objectEnd)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(':')[0].trim())
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry))
    .sort();
}
 
test('baseline top-level symbol inventory is non-empty and duplicate-free', () => {
  const inventory = topLevelInventory(readSource());
 
  assert.ok(
    inventory.length >= 100,
    `Unexpectedly small monolith inventory: ${inventory.length}`
  );
 
  const counts = new Map();
  for (const symbol of inventory) {
    counts.set(
      symbol.symbolName,
      (counts.get(symbol.symbolName) || 0) + 1
    );
  }
 
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([name, count]) => ({ name, count }));
 
  assert.deepEqual(duplicates, []);
});
 
test('baseline test-mode export inventory is frozen', () => {
  const actual = extractTestModeExports(readSource());
  assert.deepEqual(actual, EXPECTED_TEST_MODE_EXPORTS);
});
 
test('important baseline constants and entry points remain inventoried', () => {
  const inventory = topLevelInventory(readSource());
  const names = new Set(inventory.map((item) => item.symbolName));
 
  const required = [
    'PORT',
    'HOST',
    'PLUGIN_ROOT',
    'PROFILES_DIR',
    'REGISTRY_PATH',
    'COPILOT_REQUIRED_MODEL',
    'COPILOT_OUTPUT_CONTRACT',
    'GEMINI_APP_URL',
    'GEMINI_REQUIRED_MODEL',
    'GOOGLE_SEARCH_AI_URL',
    'PACK_MODES',
    'CHUNK_ENGINE_LIMITS',
    'startDashboardAndSingletonServer',
    'dispatchActionSingleton',
    'executeCoreAction',
    'runAutonomousPipeline',
    'applyAndTestDeterministically',
    'parseCodeBlocksFromMarkdown',
    'persistCheckpointReceiptOnce'
  ];
 
  const missing = required.filter((name) => !names.has(name));
  assert.deepEqual(missing, []);
});