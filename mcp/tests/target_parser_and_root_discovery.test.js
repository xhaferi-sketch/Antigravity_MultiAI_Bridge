'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeTargetPath,
  normalizeTargetKey,
  isValidCleanRelativePath,
  resolveProjectRoot,
  extractPlanTargets
} = require('../pipeline/target_path_utils');

test('DoD-1: Target Sanitizer Torture Tests', async (t) => {
  await t.test('Sanitizes annotated target with file size and Albanian comment', () => {
    const raw = 'FILE_TARGET: .gitignore (169B, plain — lexim dhe zgjerim i rregullave të injorimit pas verifikimit)';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, '.gitignore');
  });

  await t.test('Sanitizes Markdown list prefix, bold, backticks', () => {
    const raw = '- **FILE_TARGET:** `src/components/Header.tsx` (updated component)';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, 'src/components/Header.tsx');
  });

  await t.test('Sanitizes Windows backslashes to canonical POSIX', () => {
    const raw = 'FILE_TARGET: src\\services\\RevitMepService.cs: implementation of MEP sync';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, 'src/services/RevitMepService.cs');
  });

  await t.test('Sanitizes trailing colon description', () => {
    const raw = 'FILE_TARGET: config/settings.json: updated database configuration';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, 'config/settings.json');
  });

  await t.test('Sanitizes leading ./ and multiple slashes', () => {
    const raw = 'FILE_TARGET: .//src///utils//helper.js';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, 'src/utils/helper.js');
  });

  await t.test('Rejects path traversal (..)', () => {
    const raw = 'FILE_TARGET: ../../secret.env';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, null);
    assert.equal(res.rejectedReason, 'PATH_TRAVERSAL_REJECTED');
  });

  await t.test('Rejects illegal Windows characters (< > : " | ? *)', () => {
    const raw = 'FILE_TARGET: src/invalid<name>.js';
    const res = sanitizeTargetPath(raw);
    assert.equal(res.path, null);
    assert.equal(res.rejectedReason, 'ILLEGAL_PATH_CHARACTERS');
  });

  await t.test('Rejects empty or whitespace only', () => {
    const res1 = sanitizeTargetPath('');
    assert.equal(res1.path, null);
    const res2 = sanitizeTargetPath('   ');
    assert.equal(res2.path, null);
  });

  await t.test('Canonical normalizeTargetKey matches across case and slashes on Windows', () => {
    const expectedRaw = 'FILE_TARGET: src\\Services\\Logger.cs (size 1KB)';
    const actualCoder = 'src/services/logger.cs';

    const keyExpected = normalizeTargetKey(expectedRaw);
    const keyActual = normalizeTargetKey(actualCoder);

    if (process.platform === 'win32') {
      assert.equal(keyExpected, 'src/services/logger.cs');
      assert.equal(keyActual, 'src/services/logger.cs');
      assert.equal(keyExpected, keyActual);
    } else {
      assert.equal(normalizeTargetKey('src/services/Logger.cs'), 'src/services/Logger.cs');
    }
  });

  await t.test('Preserves valid clean relative path', () => {
    assert.equal(isValidCleanRelativePath('.gitignore'), true);
    assert.equal(isValidCleanRelativePath('src/main.py'), true);
    assert.equal(isValidCleanRelativePath('../escaped.py'), false);
    assert.equal(isValidCleanRelativePath(''), false);
  });
});

test('DoD-2: Universal Project Root Discovery Tests', async (t) => {
  const tmpBase = path.join(os.tmpdir(), 'ag-root-test-' + Date.now());
  fs.mkdirSync(tmpBase, { recursive: true });

  t.after(() => {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  });

  await t.test('Stop-at-Self: dir named "scripts" with package.json returns itself', () => {
    const scriptsDir = path.join(tmpBase, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{}');

    const res = resolveProjectRoot(scriptsDir);
    assert.equal(res.root.toLowerCase(), scriptsDir.toLowerCase());
    assert.equal(res.resolutionMode, 'EXACT_MARKER');
    assert.equal(res.matchedMarker, 'package.json');
  });

  await t.test('Ancestor Walk-Up: subdirectory without marker resolves to parent with .git', () => {
    const repoRoot = path.join(tmpBase, 'my-repo');
    const deepSub = path.join(repoRoot, 'src', 'domain', 'core');
    fs.mkdirSync(deepSub, { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

    const res = resolveProjectRoot(deepSub);
    assert.equal(res.root.toLowerCase(), repoRoot.toLowerCase());
    assert.equal(res.resolutionMode, 'ANCESTOR_MARKER');
    assert.equal(res.matchedMarker, '.git');
  });

  await t.test('Revit MEP Ecosystem: directory with *.addin or *.csproj resolves as EXACT_MARKER', () => {
    const revitDir = path.join(tmpBase, 'RevitMepAddin');
    fs.mkdirSync(revitDir, { recursive: true });
    fs.writeFileSync(path.join(revitDir, 'RevitMepPlugin.addin'), '<RevitAddIns></RevitAddIns>');

    const res = resolveProjectRoot(revitDir);
    assert.equal(res.root.toLowerCase(), revitDir.toLowerCase());
    assert.equal(res.resolutionMode, 'EXACT_MARKER');
    assert.equal(res.matchedMarker, 'RevitMepPlugin.addin');
  });

  await t.test('Fallback: empty directory without marker returns itself', () => {
    const emptyDir = path.join(tmpBase, 'empty-folder');
    fs.mkdirSync(emptyDir, { recursive: true });

    const res = resolveProjectRoot(emptyDir);
    assert.equal(res.root.toLowerCase(), emptyDir.toLowerCase());
    assert.equal(res.resolutionMode, 'EXACT_FALLBACK');
  });
});

test('DoD-3: Universal Plan Target Parser Hardening — Heading Interference', async (t) => {
  await t.test('Extracts FILE_TARGET / TARGET directives written as Markdown headings or standalone bold', () => {
    const plan = [
      '# PLANI ARKITEKTUROR',
      '### FILE_TARGET: src/Services/Router.cs',
      '#### TARGET: src/Domain/Contract.cs',
      '### 4.1 FILE_TARGET: src/Core/Engine.cs',
      '**FILE_TARGET: src/Utils/Helper.cs**'
    ].join('\n');

    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'src/Services/Router.cs',
      'src/Domain/Contract.cs',
      'src/Core/Engine.cs',
      'src/Utils/Helper.cs'
    ]);
    assert.equal(res.rejected.length, 0);
  });

  await t.test('Preserves ALLOWED section across deeper sub-headings and closes on sibling heading', () => {
    const plan = [
      '## 3. ALLOWED_FILES',
      '### Services',
      '- src/Services/Alpha.cs',
      '#### Models',
      '- src/Models/Beta.cs',
      '**Tests**',
      '- tests/Gamma.test.js',
      '## 4. SPECIFIKIMI',
      '- src/ShouldNotBePicked.cs'
    ].join('\n');

    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'src/Services/Alpha.cs',
      'src/Models/Beta.cs',
      'tests/Gamma.test.js'
    ]);
  });

  await t.test('Preserves FORBIDDEN section across deeper sub-headings and blocks nested directives', () => {
    const plan = [
      '## 3. ALLOWED_FILES & FORBIDDEN_FILES',
      '### ALLOWED FILES',
      '- src/Allowed.cs',
      '- src/LegacyNested.cs',
      '- src/LegacyHeading.cs',
      '### FORBIDDEN_FILES',
      '#### Legacy',
      'FILE_TARGET: src/LegacyNested.cs',
      '#### FILE_TARGET: src/LegacyHeading.cs',
      '### FILE_TARGET: src/SiblingAfterForbidden.cs'
    ].join('\n');

    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'src/SiblingAfterForbidden.cs',
      'src/Allowed.cs'
    ]);
    assert.ok(res.rejected.some((r) => r.reason === 'FORBIDDEN_TARGET' && r.raw.includes('LegacyNested.cs')));
    assert.ok(res.rejected.some((r) => r.reason === 'FORBIDDEN_TARGET' && r.raw.includes('LegacyHeading.cs')));
  });
});

test('DoD-4: Plural & Comma/Semicolon-Separated Directives', async (t) => {
  await t.test('Splits plural TARGETS and FILE_TARGETS directives on commas and semicolons', () => {
    const plan = [
      'TARGETS: src/A.cs, src/B.cs',
      'FILE_TARGETS: `src/C.cs`, `src/D.cs`; `src/E.cs`',
      '### TARGETS: src/F.cs (I RI), src/G.cs[NEW]'
    ].join('\n');

    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'src/A.cs',
      'src/B.cs',
      'src/C.cs',
      'src/D.cs',
      'src/E.cs',
      'src/F.cs',
      'src/G.cs'
    ]);
    assert.equal(res.rejected.length, 0);
  });

  await t.test('Does not split commas inside trailing comments or parenthetical annotations', () => {
    const plan = [
      'FILE_TARGET: src/H.cs — shton A, B, dhe C',
      'FILE_TARGET: src/I.cs (169B, plain)',
      'FILE_TARGET: src/J.cs:përshkrim me, presje'
    ].join('\n');

    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'src/H.cs',
      'src/I.cs',
      'src/J.cs'
    ]);
    assert.equal(res.rejected.length, 0);
  });

  await t.test('Rejects traversal sibling while preserving valid sibling in comma-separated list', () => {
    const plan = 'TARGETS: ../secret.js, src/ok.js';
    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, ['src/ok.js']);
    assert.equal(res.rejected.length, 1);
    assert.equal(res.rejected[0].reason, 'PATH_TRAVERSAL_REJECTED');
  });
});

test('DoD-5: Inline Colon Comments vs. NTFS ADS Fail-Closed Security', async (t) => {
  await t.test('Accepts inline no-space colon comments and line numbers after valid file identities', () => {
    assert.equal(sanitizeTargetPath('file.cs:përshkrim').path, 'file.cs');
    assert.equal(sanitizeTargetPath('src/Router.cs:përshkrim me hapësira dhe pikë.').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('src/Router.cs:42').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('src/Router.cs:42:10').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('C:\\repo\\src\\Router.cs:përshkrim', 'C:\\repo').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('Makefile:build').path, 'Makefile');
  });

  await t.test('Rejects NTFS Alternate Data Streams fail-closed with ILLEGAL_PATH_CHARACTERS', () => {
    const adsInputs = [
      'src/file:ads.js',
      'src/file.txt:$DATA',
      'src/file.txt:Zone.Identifier',
      'src/file.txt:hidden.exe',
      'app/authors/:ads.js'
    ];

    for (const input of adsInputs) {
      const res = sanitizeTargetPath(input);
      assert.equal(res.path, null, 'Expected null path for ' + input);
      assert.equal(res.rejectedReason, 'ILLEGAL_PATH_CHARACTERS', 'Expected ILLEGAL_PATH_CHARACTERS for ' + input);
    }

    const plan = adsInputs.map((x) => 'FILE_TARGET: ' + x).join('\n');
    const extracted = extractPlanTargets(plan);
    assert.deepEqual(extracted.targets, []);
    assert.equal(extracted.rejected.length, adsInputs.length);
    for (const rej of extracted.rejected) {
      assert.equal(rej.reason, 'ILLEGAL_PATH_CHARACTERS');
    }
  });
});

test('DoD-6: Markdown Links, No-Space Annotations, and Dynamic Route Paths', async (t) => {
  await t.test('Unwraps Markdown links, leading status tags, task checkboxes, and no-space annotations', () => {
    assert.equal(sanitizeTargetPath('[src/Router.cs](src/Router.cs)').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('[Router.cs](src/Services/Router.cs)').path, 'src/Services/Router.cs');
    assert.equal(sanitizeTargetPath('[src/Router.cs](./src/Router.cs) — shpjegim').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('[src/Router.cs](https://example.com/blob/Router.cs)').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('[page.tsx](app/(marketing)/page.tsx) (I RI)').path, 'app/(marketing)/page.tsx');
    assert.equal(sanitizeTargetPath('src/Router.cs[NEW]').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('src/Router.cs(I RI)').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('[NEW] src/Router.cs').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('- [x] src/Router.cs').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('`src/Router.cs`:përshkrim').path, 'src/Router.cs');
    assert.equal(sanitizeTargetPath('`src/Router.cs`[NEW]').path, 'src/Router.cs');
  });

  await t.test('Preserves legitimate dynamic paths containing brackets or parentheses', () => {
    assert.equal(sanitizeTargetPath('app/users/[id].tsx').path, 'app/users/[id].tsx');
    assert.equal(sanitizeTargetPath('app/(marketing)/page.tsx').path, 'app/(marketing)/page.tsx');
    assert.equal(sanitizeTargetPath('app/authors/[id]/page.tsx').path, 'app/authors/[id]/page.tsx');
    assert.equal(sanitizeTargetPath('app/changelog/(v2)/page.tsx').path, 'app/changelog/(v2)/page.tsx');

    const plan = [
      '### ALLOWED_FILES',
      '- [x] app/users/[id].tsx',
      '- [NEW] app/(marketing)/page.tsx',
      '- app/authors/[id]/page.tsx',
      '- app/changelog/(v2)/page.tsx',
      '[Router.cs](src/Services/Router.cs)',
      '[page.tsx](app/(group)/page.tsx)'
    ].join('\n');
    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, [
      'app/users/[id].tsx',
      'app/(marketing)/page.tsx',
      'app/authors/[id]/page.tsx',
      'app/changelog/(v2)/page.tsx',
      'src/Services/Router.cs',
      'app/(group)/page.tsx'
    ]);
  });

  await t.test('Rejects traversal links and non-file external links fail-closed', () => {
    const trav = sanitizeTargetPath('[safe.cs](../../etc/passwd)');
    assert.equal(trav.path, null);
    assert.equal(trav.rejectedReason, 'PATH_TRAVERSAL_REJECTED');

    const extUrlLabel = sanitizeTargetPath('[https://example.com](https://example.com)');
    assert.equal(extUrlLabel.path, null);
    assert.equal(extUrlLabel.rejectedReason, 'EXTERNAL_LINK_NON_FILE');

    const plan = [
      'FILE_TARGET: [safe.cs](../../etc/passwd)',
      'FILE_TARGET: [Docs](https://example.com)'
    ].join('\n');
    const res = extractPlanTargets(plan);
    assert.deepEqual(res.targets, []);
    assert.equal(res.rejected.length, 2);
    assert.equal(res.rejected[0].reason, 'PATH_TRAVERSAL_REJECTED');
    assert.equal(res.rejected[1].reason, 'PROSE_OR_NON_FILE_REJECTED');
  });
});

test('DoD-7: Fail-Closed Zero-Fallback, Code Fences, Unicode & Disk-First Edge Cases', async (t) => {
  const tmpBase = path.join(os.tmpdir(), 'ag-parser-edge-' + Date.now());
  fs.mkdirSync(path.join(tmpBase, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, '.editorconfig'), 'root = true\n');
  fs.writeFileSync(path.join(tmpBase, 'docs', 'a, b.md'), '# Comma File\n');
  fs.writeFileSync(path.join(tmpBase, 'docs', 'rruga me hapësira.md'), '# Unicode Spaces\n');

  t.after(() => {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (_) {}
  });

  await t.test('Returns empty targets on prose-only plan with zero fallback to workspace files', () => {
    const prosePlan = [
      '# Plan Arkitekturor',
      '## 1. Objektivi',
      'Ky plan përshkruan vetëm hapat konceptualë pa asnjë direktivë skedari.',
      '```markdown',
      '### FILE_TARGET: src/FakeInsideFence.cs',
      '```',
      '~~~text',
      'TARGETS: src/FakeInsideTilde.cs',
      '~~~',
      '<!-- FILE_TARGET: src/FakeInsideComment.cs -->'
    ].join('\n');

    const res = extractPlanTargets(prosePlan, tmpBase);
    assert.deepEqual(res.targets, []);
    assert.deepEqual(res.rejected, []);
  });

  await t.test('Handles null, undefined, empty, BOM, CRLF/CR, malformed URI percent-encoding, and disk-first comma/Unicode paths', () => {
    assert.deepEqual(sanitizeTargetPath(null), { path: null, rejectedReason: 'EMPTY' });
    assert.deepEqual(sanitizeTargetPath(undefined), { path: null, rejectedReason: 'EMPTY' });
    assert.deepEqual(extractPlanTargets(null), { targets: [], rejected: [], forbiddenPatterns: [] });
    assert.deepEqual(extractPlanTargets('<!-- only comment -->'), { targets: [], rejected: [], forbiddenPatterns: [] });

    const plan = '\uFEFF### FILE_TARGET: docs/a, b.md\r\nFILE_TARGET: docs/rruga me hapësira.md\rFILE_TARGET: [broken](src/file%E0%A4%A.cs)\r\n';
    const res = extractPlanTargets(plan, tmpBase);
    assert.deepEqual(res.targets, [
      'docs/a, b.md',
      'docs/rruga me hapësira.md',
      'src/file%E0%A4%A.cs'
    ]);
  });
});