'use strict';
 
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
 
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');
 
const FUTURE_MODULES = [
  {
    path: 'mcp/engines/copilot_engine.js',
    exports: [
      'createCopilotEngine',
      'COPILOT_REQUIRED_MODEL',
      'COPILOT_OUTPUT_CONTRACT'
    ]
  },
  {
    path: 'mcp/engines/gemini_engine.js',
    exports: [
      'createGeminiEngine',
      'GEMINI_REQUIRED_MODEL'
    ]
  },
  {
    path: 'mcp/engines/google_search_engine.js',
    exports: [
      'createGoogleSearchEngine',
      'GOOGLE_SEARCH_AI_URL',
      'validatePlanOutput',
      'classifyAttachmentHandshake'
    ]
  },
  {
    path: 'mcp/pipeline/autopilot_engine.js',
    exports: [
      'createAutopilotEngine',
      'PACK_MODES',
      'CHUNK_ENGINE_LIMITS',
      'scanRepositoryUniversal',
      'buildDependencyGraph',
      'buildCompactRepoMap',
      'partitionAnalysisChunks',
      'partitionCodingBatches',
      'buildMinimalBatchContext',
      'selectCodingTransport',
      'halveBatchAdaptively',
      'normalizeFailureCode',
      'isAdaptiveHalvingFailure',
      'getFailoverEngines'
    ]
  },
  {
    path: 'mcp/pipeline/local_executor.js',
    exports: [
      'createLocalExecutor',
      'normalizeGeneratedSourceText',
      'findUnsafeGeneratedSourceCharacters',
      'parseCodeBlocksFromMarkdown',
      'validateGeneratedCodeMarkdown',
      'parseCheckpointAudit',
      'computeCheckpointIdentity',
      'isTargetVerifiedForCheckpoint'
    ]
  }
];
 
function readServerSource() {
  assert.ok(fs.existsSync(SERVER_PATH), `Missing baseline server: ${SERVER_PATH}`);
  return fs.readFileSync(SERVER_PATH, 'utf8');
}
 
function runIsolatedImport() {
  const childSource = String.raw`
    'use strict';
 
    const Module = require('node:module');
    const http = require('node:http');
 
    process.env.ANTIGRAVITY_TEST_EXPORT = '1';
 
    let httpListenCalls = 0;
    let mcpConnectCalls = 0;
    let browserLaunchCalls = 0;
 
    const originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function forbiddenListen() {
      httpListenCalls += 1;
      throw new Error('TEST_MODE_HTTP_LISTENER_STARTED');
    };
 
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === '@modelcontextprotocol/sdk/server/index.js') {
        return {
          Server: class FakeServer {
            constructor() {}
            setRequestHandler() {}
            connect() {
              mcpConnectCalls += 1;
              throw new Error('TEST_MODE_MCP_CONNECT_STARTED');
            }
          }
        };
      }
 
      if (request === '@modelcontextprotocol/sdk/server/stdio.js') {
        return {
          StdioServerTransport: class FakeStdioServerTransport {}
        };
      }
 
      if (request === '@modelcontextprotocol/sdk/types.js') {
        return {
          CallToolRequestSchema: Symbol('CallToolRequestSchema'),
          ListToolsRequestSchema: Symbol('ListToolsRequestSchema')
        };
      }
 
      if (request === 'playwright') {
        return {
          chromium: {
            launchPersistentContext() {
              browserLaunchCalls += 1;
              throw new Error('TEST_MODE_BROWSER_LAUNCH_STARTED');
            }
          }
        };
      }
 
      if (request === 'adm-zip') {
        return class FakeAdmZip {
          addFile() {}
          writeZip() {}
        };
      }
 
      return originalLoad.call(this, request, parent, isMain);
    };
 
    try {
      const exported = require(process.argv[1]);
      process.stdout.write(JSON.stringify({
        ok: true,
        exportNames: Object.keys(exported).sort(),
        httpListenCalls,
        mcpConnectCalls,
        browserLaunchCalls
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        message: error && error.message,
        stack: error && error.stack,
        httpListenCalls,
        mcpConnectCalls,
        browserLaunchCalls
      }));
      process.exitCode = 1;
    } finally {
      Module._load = originalLoad;
      http.Server.prototype.listen = originalListen;
    }
  `;
 
  const result = spawnSync(
    process.execPath,
    ['-e', childSource, SERVER_PATH],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTIGRAVITY_TEST_EXPORT: '1'
      },
      timeout: 15_000
    }
  );
 
  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    assert.fail(
      `Isolated import returned invalid JSON.\n` +
      `stdout:\n${result.stdout}\n` +
      `stderr:\n${result.stderr}\n` +
      `parse error: ${error.message}`
    );
  }
 
  return { result, payload };
}
 
test('baseline server is guarded by ANTIGRAVITY_TEST_EXPORT', () => {
  const source = readServerSource();
 
  assert.match(
    source,
    /process\.env\.ANTIGRAVITY_TEST_EXPORT\s*!==\s*['"]1['"]\s*\)\s*startDashboardAndSingletonServer\s*\(\s*\)/,
    'Dashboard startup must remain behind the test-export guard'
  );
 
  assert.match(
    source,
    /process\.env\.ANTIGRAVITY_TEST_EXPORT\s*!==\s*['"]1['"][\s\S]*!process\.stdin\.isTTY/,
    'MCP stdio startup must remain behind the test-export guard'
  );
});
 
test('mcp/server.js imports in an isolated process without listener, MCP, or browser startup', () => {
  const { result, payload } = runIsolatedImport();
 
  assert.equal(
    result.status,
    0,
    `Import failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.equal(payload.ok, true, payload.stack || payload.message);
  assert.equal(payload.httpListenCalls, 0);
  assert.equal(payload.mcpConnectCalls, 0);
  assert.equal(payload.browserLaunchCalls, 0);
 
  const expectedBaselineExports = [
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
 
  assert.deepEqual(payload.exportNames, expectedBaselineExports);
});
 
test('authorized modular production files expose their required contracts when present', () => {
  for (const specification of FUTURE_MODULES) {
    const absolutePath = path.join(PROJECT_ROOT, specification.path);
 
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
 
    delete require.cache[require.resolve(absolutePath)];
    const exported = require(absolutePath);
 
    for (const exportName of specification.exports) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(exported, exportName),
        `${specification.path} is missing export ${exportName}`
      );
    }
 
    const factoryName = specification.exports.find((name) =>
      /^create[A-Z]/.test(name)
    );
 
    if (factoryName) {
      assert.equal(typeof exported[factoryName], 'function');
 
      assert.throws(
        () => exported[factoryName](),
        /context|dependency|required|mandatory|runtime/i,
        `${factoryName} must reject missing mandatory dependencies deterministically`
      );
    }
  }
});