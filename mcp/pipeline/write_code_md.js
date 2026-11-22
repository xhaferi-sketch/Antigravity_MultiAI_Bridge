const fs = require('fs');
const path = require('path');

const root = 'C:/Vladi_project/Revit Personal ai/Personal AI Revit/App';
const exchange = path.join(root, '.antigravity', 'bridge', 'exchange');
const codePath = path.join(exchange, 'code.md');

const files = [
  '.antigravity/bridge/routing.json',
  'scripts/run_autonomous_cycle.mjs',
  'src/LocalPersonalAI.RevitPlugin/Selection/RevitRoomSpatialScanner.cs',
  'src/LocalPersonalAI.RevitPlugin/RealChat/VilaMepAutomation.cs',
  'src/LocalPersonalAI.RevitPlugin/ApprovedWorkingCopyService.cs',
  'scripts/RUN_VILA_MEP_ZERO_HUMAN_E2E.ps1',
  'scripts/VERIFY_VILA_MODEL_INTEGRITY.ps1',
  'scripts/GENERATE_VILA_MEP_PROOF_PACKAGE.ps1',
  'tests/bridge/run_autonomous_cycle.test.mjs'
];

let md = '<!-- CODE_PLAN_META planFingerprint=d4b520b351c8bf318a4efe560bd90dbf873fee4d3f851f1e07a865ec43b0a85e -->\n# CHUNKED ENGINE BATCH AUDIT\n\n';

for (const f of files) {
  const content = fs.readFileSync(path.join(root, f), 'utf8');
  const ext = path.extname(f).slice(1);
  const lang = ext === 'cs' ? 'csharp' : ext === 'mjs' || ext === 'js' ? 'javascript' : ext === 'ps1' ? 'powershell' : ext === 'json' ? 'json' : '';
  md += '### FILE: ' + f + '\n```' + lang + '\n' + content + '\n```\n\n';
}

fs.writeFileSync(codePath, md, 'utf8');
console.log('code.md written successfully, size:', Buffer.byteLength(md));
