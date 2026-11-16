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

## 2. Te 7 Mjetet MCP te Serverit `multi-ai-relay` (Autopilot 25s & Zero-Token)

1. **`run_full_cycle(projectRoot, userRequest)`**: **Mjeti Kryesor Autopilot** — nis në Node.js të gjithë ciklin (`pack` -> `planner` -> `coder` -> `apply_and_test` -> `reviewer`) pa djegur asnjë kredi AI në IDE. Kthen rezultatin ose `STILL_RUNNING_CALL_CHECK_PROGRESS` pas 25 sekondash për të evituar timeout-in e Antigravity-t.
2. **`check_cycle_progress(projectRoot)`**: Monitoron dhe pret në blloqe adaptive 25-sekondëshe derisa cikli autonom të përfundojë plotësisht me `CYCLE_COMPLETED`.
3. **`pack_workspace(projectRoot, mode)`**: Paketon projektin (`FULL` ose `DELTA` me Git) në `.antigravity/bridge/exchange/project_bundle.txt` (për Gemini) ose `.zip.md` (me SHA-256 për M365 Copilot).
4. **`run_planner(projectRoot, userRequest)`**: Dërgon paketën te fleta e zgjedhur e Planner-it në modalitetin Thinking/Think Deeper dhe ruan `exchange/plan.md`.
5. **`run_coder(projectRoot, mode)`**: Gjeneron kodin 100% të plotë në `exchange/code.md` (`IMPLEMENT`, `FIX_ERROR`, ose `REVIEW_FIX`) me kontroll të rreptë anti-placeholder (`TODO`, `... rest of code`).
6. **`apply_and_test(projectRoot)`**: **0-Token Node.js Deterministic Executor** — zbërthen blloqet `### FILE: path/to/file.ext`, kontrollon path-traversal, shkruan skedarët në disk dhe ekzekuton `buildCmd` + `testCmd`. Në dështim ruan log-un e kompresuar (10k fillim + 10k fund) te `last_error.txt`.
7. **`run_reviewer(projectRoot)`**: **Release Gate** — krahason `plan.md` + `code.md` + `build_test.log` dhe kthen verdiktin `PASSED` ose `CHANGES_REQUIRED`. Në rast suksesi (`PASSED`), ekzekuton menjëherë **Auto-Purge** mbi mbetjet e rënda të shkëmbimit.

---

## 3. Menaxhimi i Projekteve në Dashboard (`http://127.0.0.1:4321`)

Paneli grafik në portën 4321 përmban veçori të avancuara të menaxhimit:
- **🗑️ Fshi Projektin (`DELETE /api/delete-project`):** Fshin regjistrimin e projektit nga lista e Dashboard-it me dialog konfirmimi të sigurt (pa prekur asnjë skedar të projektit në disk).
- **🧹 Pastro Mbetjet e Shkëmbimit (`POST /api/purge-exchange`):** Fshin menjëherë skedarët e rëndë të përkohshëm (`project_bundle.txt`, `.zip.md`, `last_error.txt`, screenshots) për të mbajtur diskun të pastër.
- **Auto-Purge Automatike:** Sapo Reviewer-i jep verdiktin `STATUS: PASSED`, serveri pastron automatikisht skedarët e shkëmbimit pa kërkuar ndërhyrje me dorë.
- **Zgjedhja e Formatit të Paketimit (`bundleFormat`):** Mundësi zgjedhjeje mes `project_bundle.txt` (për Gemini) dhe `project_bundle.zip.md` (për M365 Copilot).

---

## 4. Verifikimi Sintaksor pas cdo Modifikimi ne `server.js`

```cmd
node --check "C:\Vladi_project\Antigravity_MultiAI_Bridge\mcp\server.js"
```

---

## 5. Ekzekutimi i Testeve Stresuese të Hermes Bridge (Suita Universale)

Kjo suitë testimi ndodhet në root të projektit dhe përdoret për të verifikuar në mënyrë 100% lineare qëndrueshmërinë, mungesën e race conditions, transferimin e attachments, gjenerimin e patch-eve dhe përdorimin e veglave (plugins).

### Struktura e Dosjeve (Suita e Plotë me 8 Teste):
- `tests/hermes_bridge/scripts/`: Përmban skriptet ekzekutive të testimit.
  - `test_linear_flow.py`: Verifikimi i ekzekutimit të rreptë linear të kërkesave pa mbivendosje procesesh.
  - `test_attachments_patch.py`: Verifikimi i menaxhimit të bashkëngjitjeve dhe gjenerimit të saktë të file diff .patch.
  - `test_plugin_usage.py`: Verifikimi i thirrjes së suksesshme të veglave/plugins dhe integrimit të tyre në output.
  - `test_report_generator.py`: Verifikimi i prodhimit fizik të raporteve të strukturuara JSON në disk.
  - `test_zero_token_verification.py`: Verifikimi i ekzekutimit 100% 0-Token dhe delegimit lokal pa djegur kredi IDE.
  - `test_latency_benchmark.py`: Matja e latencës së rrugëtimit dhe shpejtësisë së përgjigjes (TTFT).
  - `test_failover_resilience.py`: Verifikimi i kalimit automatik (Failover) dhe qëndrueshmërisë së sesioneve.
  - `test_service_refusal_catch.py`: Verifikimi i kapjes automatike (Fail-Fast) të refuzimeve të Google Gemini dhe bllokimi i rënies në modele të dobëta (Flash-Lite / Auto).
- `tests/hermes_bridge/reports/`: Dosja e raporteve fizike JSON të prodhuara nga çdo ekzekutim testimi për analizë nga Orchestratori dhe Web 1.

### Ekzekutimi i Testeve me Interpretuesin Lokal të Python:
Nga root-i i projektit ekzekutohen një nga një:
```powershell
python tests/hermes_bridge/scripts/test_linear_flow.py
python tests/hermes_bridge/scripts/test_attachments_patch.py
python tests/hermes_bridge/scripts/test_plugin_usage.py
python tests/hermes_bridge/scripts/test_report_generator.py
python tests/hermes_bridge/scripts/test_zero_token_verification.py
python tests/hermes_bridge/scripts/test_latency_benchmark.py
python tests/hermes_bridge/scripts/test_failover_resilience.py
python tests/hermes_bridge/scripts/test_service_refusal_catch.py
```
Raportet fizike të çdo testi regjistrohen automatikisht në `tests/hermes_bridge/reports/report_<test_name>_<timestamp>.json`.
