# Antigravity Multi-AI Orchestrator Bridge (V3.2 Standalone)

**Folderi Kryesor (Source of Truth):** `C:\Vladi_project\Antigravity_MultiAI_Bridge`  
**Izolim 100% Fizik:** Punon ekskluzivisht ne `http://127.0.0.1:4321` dhe me profilet lokale ne `.profiles/`. Nuk prek kurre portat e sistemit Hermes (`15550`, `15555`, `15556`, `18000`, `19000`, `19005`) dhe as `%LOCALAPPDATA%\HermesWebBridge`.

---

## 1. Harta e Plote e Skedareve (Zero Analize nga e Para)

| Cfare kerkon te shohesh ose ndryshosh? | Skedari / Rruga ekzakte | Roli dhe kur preket |
| :--- | :--- | :--- |
| **Manuali i Plote Operativ** | `USER_MANUAL.md` | Udhezuesi hap-pas-hapi, skedaret e brendshem te projektit, mirembajtja, shtimi i modeleve dhe troubleshooting. |
| **Specifikimi Teknik & Kushtetuta** | `docs/SPECIFIKIMI_BAZE_V3_2.md`<br>`docs/HERMES_GOVERNANCE_REFERENCE.txt` | Kodi baze arkitekturor V3.2 dhe referenca kanonike e rregullave Enterprise (4 Aktoret). |
| **Lidhja Auto-Start me Antigravity** | `plugin.json` & `mcp_config.json`<br>`%USERPROFILE%\.gemini\config\mcp_config.json`<br>`%USERPROFILE%\.gemini\config\plugins\multi-ai-orchestrator-bridge` | Lidhja Junction dhe regjistrimi Global MCP qe ndez vete `mcp/server.js` sapo hapet Antigravity. |
| **Motori Qendror (MCP + HTTP + 0-Token)** | `mcp/server.js` | Singleton server ne `http://127.0.0.1:4321`, 5-Tab Pool me Mutex, ngarkimi i skedareve dhe **0-Token Executor (`apply_and_test`)**. |
| **Piket e Modeleve (Thinking / Pro)** | `mcp/model_scores.json` | Peshat qe detyrojne `3.1 Pro / Thinking / GPT-5.6 Sol Think Deeper` dhe bllokojne `Auto`, `Flash`, `Deep Research` dhe opsionet `disabled`. |
| **Nderfaqja Grafike (Web UI)** | `mcp/dashboard.html` | Paneli grafik ne `http://localhost:4321` per Login-et, statusin live te 5 fleteve dhe rolet/komandat per cdo projekt. |
| **Sesionet Web & Regjistri** | `.profiles/` (`m365`, `gemini1..3`)<br>`projects_registry.json` | 4 profilet e izoluara Chromium me cookies e Login-it dhe regjistri i projekteve aktive. |
| **Rregullat e Aktoreve (Lexohen Live)** | `rules/AGENTS.md` & `agents/orchestrator.md`<br>`rules/planner_rules.md`<br>`rules/coder_rules.md`<br>`rules/reviewer_rules.md`<br>`agents/executor.md` | Kontratat strikte per Orchestrator (Control Plane), Planner (Architect), Coder (Worker), Reviewer (Release Gate) dhe Fallback Executor. |
| **Procedura `/run-cycle`** | `skills/run-cycle/SKILL.md` | Rradha lineare e detyrueshme e 5 mjeteve MCP deri ne verdiktin `STATUS: PASSED`. |
| **Nisesi Manual i Dashboard-it** | `1_HAP_DASHBOARD_4321.bat` | Hap manualisht serverin dhe Dashboard-in kur Antigravity eshte i mbyllur. |

---

## 2. Te 5 Mjetet MCP te Serverit `multi-ai-relay`

1. **`pack_workspace(projectRoot, mode)`**: Paketon projektin (`FULL` ose `DELTA` me Git) me rruge `/` ne `.antigravity/bridge/exchange/project_bundle.txt` (ose `.zip.md` me SHA-256 per M365).
2. **`run_planner(projectRoot, userRequest)`**: Dergon paketen te fleta e Planner-it ne modalitetin Thinking/Think Deeper dhe ruan `exchange/plan.md`.
3. **`run_coder(projectRoot, mode)`**: Gjeneron kodin 100% te plote ne `exchange/code.md` (`IMPLEMENT` ose `FIX_ERROR`) me kontroll automatik kunder placeholder-ave (`TODO`, `... rest of code`).
4. **`apply_and_test(projectRoot)`**: **0-Token Node.js Executor** — zberthen blloqet `### FILE: path/to/file.ext`, kontrollon path-traversal, shkruan skedaret ne disk dhe ekzekuton `buildCmd` + `testCmd`. Ne deshtim ruan log-un e kompresuar (10k head + 10k tail) te `last_error.txt`.
5. **`run_reviewer(projectRoot)`**: **Release Gate** — krahason `plan.md` + `code.md` + `build_test.log` dhe kthen `PASSED` ose `CHANGES_REQUIRED`.

---

## 3. Verifikimi Sintaksor pas cdo Modifikimi ne `server.js`

```cmd
node --check "C:\Vladi_project\Antigravity_MultiAI_Bridge\mcp\server.js"
```
