# Antigravity Multi-AI Orchestrator Bridge (V3.5 Standalone)

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
| **Sesionet Web & Regjistri** | `.profiles/` (`m365`, `gemini1..3`, `google_search_1..3`)<br>`projects_registry.json` | Profilet e izoluara Chromium me cookies e Login-it dhe regjistri i projekteve aktive. |
| **Rregullat e Aktoreve (Lexohen Live)** | `rules/AGENTS.md` & `agents/orchestrator.md`<br>`rules/planner_rules.md`<br>`rules/coder_rules.md`<br>`rules/reviewer_rules.md`<br>`agents/executor.md` | Kontratat strikte per Orchestrator (Control Plane), Planner (Architect), Coder (Worker), Reviewer (Release Gate) dhe Fallback Executor. |
| **Procedura `/run-cycle`** | `skills/run-cycle/SKILL.md` | Rradha lineare e detyrueshme e 5 mjeteve MCP deri ne verdiktin `STATUS: PASSED`. |
| **Nisesi Manual i Dashboard-it** | `1_HAP_DASHBOARD_4321.bat` | Hap manualisht serverin dhe Dashboard-in kur Antigravity eshte i mbyllur. |

---

## 2. Te 7 Mjetet MCP te Serverit `multi-ai-relay` (Autopilot Zero-Timer & Zero-Token)

1. **`run_full_cycle(projectRoot, userRequest)`**: **Mjeti Kryesor Autopilot** — nis në Node.js të gjithë ciklin (`pack` -> `planner` -> `coder` -> `apply_and_test` -> `reviewer`) pa djegur asnjë kredi AI në IDE. Ekzekutohet në mënyrë reaktive sipas ngjarjeve (`await job.promise`) pa asnjë timer arbitrar dhe kthen raportin e certifikuar final me 0 babysitting. Nëse `projectRoot` ose `userRequest` mungojnë, zgjidhen 100% automatikisht nga regjistri dhe urdhrat e punës në disk.
2. **`check_cycle_progress(projectRoot)`**: Monitoron dhe pret ecurinë e ciklit aktiv në mënyrë deterministe derisa cikli autonom të përfundojë plotësisht me `CYCLE_COMPLETED`.
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

---

## 6. Auditimi i Integritetit dhe Statusi i Rregullimeve të Siguruara (V3.3 Milestone)

Të gjitha rregullimet themelore janë testuar, integruar dhe verifikuar:
1. **Model Lock Elitar (Score $\ge 800$):** Vetëm `Code & analysis` dhe `4 Argon` / `Thinking`. Refuzim i menjëhershëm me gabim kritik për Flash/Lite/Auto/Default pa fallback të fshehur.
2. **Copilot Smart Attachment:** Skedarët e mëdhenj të specifikimeve (>25k karaktere) bashkëngjiten si skedarë fizikë në `exchange/spec_*.md`, duke eliminuar shkurtimin me `[COMPACTED]`.
3. **Transparenca në Dashboard:** `/api/state` dhe `dashboard.html` pasqyrojnë listën reale të modeleve të zbuluara në ueb (`discoveredModels`).
4. **Universal Workspace Packing:** Mbrojtje e plotë me `try/catch` dhe përjashtim i profileve/cache-it për të eliminuar përplasjet e lejeve `EPERM` në Windows.
5. **Autopilot Deadlock Resolution:** Ekzekutimi i hapave të brendshëm me `{ _internal: true }` për të parandaluar vetë-bllokimin ndaj `CYCLE_EXCLUSIVE_LOCK`.
6. **External Spec Files Ingestion:** Lexim dhe injektim i plotë i skedarëve të jashtëm të specifikimeve (si `agjent marketingu shitjesh free.txt`) te Planner dhe Coder.

---

## 7. Protokolli Urdhërues me 3 Nivele & Google Search AI (V3.4 Milestone)

Ky version sjell kontroll të plotë mbi sjelljen dhe disiplinën e AI-së:
1. **Google Search AI Mode (4 Carbon - Most Complex Work):**
   - Integrim i profileve `google_search_1..3` në `https://www.google.com/ai` me dritare normale të dukshme (zero bllokime nga modaliteti headless).
   - Aktivizim automatik i modelit me arsyetim të thellë `4 Carbon`.
2. **Ngarkim Fizik i Skedarëve me Butonin `[+]`:**
   - Kapërcen kufirin e ngurtë `maxlength="8192"` të fushës së shkrimit duke ngarkuar `project_bundle.txt` dhe skedarët e specifikimeve fizikisht si bashkëngjitje (`setInputFiles`).
3. **Plani me 2 Faza të Kontrolluara:**
   - **Faza 1:** Vetëm Objektivat, Root Cause dhe `ALLOWED_FILES` me mbyllje `[FAZA_1_PERFUNDOI]`.
   - **Faza 2:** Vetëm Specifikimi Skedar më Skedar, Hardening dhe `DoD MATRIX` me mbyllje `[PLANI_PERFUNDOI_100%]`.
4. **Motori i Përshkallëzimit me 3 Nivele Urdhëruese:**
   - **Niveli 1:** Urdhri Operativ Fillestar.
   - **Niveli 2:** Vërejtje Agresive Disiplinore (bllokim i plotë i yapping/chitchat, kërkim i rreptë i strukturës).
   - **Niveli 3:** Urdhër Ultimativ me Format të Ngurtë (skelet i kyçur).
5. **Pastrimi i Bisedës së Helmuar (Clean Chat Reset):**
   - Nëse modeli refuzon ose devijon pas 3 niveleve, kryhet pastrim i plotë i kontekstit (`page.goto('https://www.google.com/ai')`) dhe rinisje e bisedës nga e para me kontekst të freskët.

---

## 8. Smart Blueprint, Handshake & Slicing Anti-Timeout (V3.5 Milestone)

Ky version eliminon bllokimet e shfletuesit, shkëputjet e serverit dhe djegien e krediteve gjatë planifikimit:
1. **Harta Smart Arkitekturore Universale (`generateSmartArchitectureMap`):**
   - Nxjerr pemën e skedarëve, manifestet, konfigurimet dhe nënshkrimet e moduleve në tekst të ngjeshur (10–25 KB).
   - Shmang ngarkimin e skedarëve të rëndë 350 KB në Google Search AI.
2. **Protokolli Handshake (Hapi 1):**
   - Dërgon arkitekturën me urdhrin e hekurt për konfirmim me fjalët ekzakte: *"OK e lexova, vazhdojmë me hapin e radhës."* (konfirmim brenda 3 sekondave).
3. **Ndarja e Specifikimeve me Faza (`sliceSpecification` < 70 KB input):**
   - Ndarje automatike e specifikimeve voluminoze në faza sekuenciale nën 45–50 KB, duke parandaluar ngrirjen e DOM-it të shfletuesit.
4. **Buxheti i Hekurt i Output-it (Anti-Timeout 120–180 Rreshta / Max 8–10 KB):**
   - Modeli urdhërohet të prodhojë përgjigje midis 120 dhe 180 rreshtave tekst/kod, duke shmangur timeout-in 60–90 sekondësh të Google-it (*Something went wrong*).
   - Të gjitha fazat bashkohen automatikisht në një skedar të vetëm: `plan.md`.
5. **Optimizimi i DOM-it dhe Kursimi i Krediteve:**
   - Hequr kurthi i `role="progressbar"`; ekstraktimi bazohet në zhdukjen e butonit `Ndalo`/`Stop` dhe qëndrueshmëri teksti për 4 sekonda.
   - `waitJobSlice` u zgjat në 22 sekonda për të parandaluar thirrjet e shpeshta që konsumonin kreditet e chat-it.

---

## 9. Lock në Gemini Neon High, Deep Thinking Timeout & Universal Multi-Pro Failover (V3.6 Milestone)

Ky version forcon strukturën e urës në nivel kodi me garanci absolute për të eliminuar çdo ulje inteligjence dhe çdo ndërprerje gjatë gjenerimeve komplekse:

1. **Lock me Selektorë dhe CDP në `4 Neon (High)` (Zero Neon Low / Zero Copilot):**
   - Ndalimi i rreptë në kod i çdo rënieje në `Neon Low`, `Auto` apo modele të lehta.
   - `gemini_engine.js`: Përmirësimi i selektorëve të kontrollit të modelit (`button[aria-label*="mode" i]`, `button[aria-haspopup="true"]`, `.input-area-switch`) dhe futja e një polling wait loop deri në 15 sekonda për `findTrigger()` gjatë hidratimit të ngadaltë të Angular-it pas navigimit.
2. **Deep Thinking Silent Deadline (Zgjeruar në 10 Minuta / 600,000ms):**
   - Rritja e `silentDeadlineMs` nga 300 sekonda në **600 sekonda (10 minuta)** në `mcp/server.js` dhe `mcp/pipeline/autopilot_engine.js`.
   - Eliminon plotësisht dështimet false-positive `GEMINI_RESET_RECOVERY_EXHAUSTED` kur Gemini Pro është duke menduar thellë dhe duke prodhuar përgjigje të mëdha kodi.
3. **Pajtueshmëri Universale e Motorit (`isEngineAvailable`):**
   - Përditësimi i logjikës në `mcp/server.js` që verifikon dhe pranon menjëherë instancat `gemini1`, `gemini2` dhe `gemini3` pa u bllokuar në kontrollin e tab-eve të papërgatitura.
4. **Multi-Pro Account Failover:**
   - Në rast ezaurimi të kuotës së një llogarie Gemini Pro, ura bën kalim automatik te llogaria pasardhëse (`gemini1 -> gemini2 -> gemini3`), gjithmonë e kyçur ekskluzivisht në `Neon High`.
5. **Certifikimi i Testbed-it:**
   - Suita e testeve të urës: **173 / 173 teste PASSED (100% green në 4.3s)**.





---

## 10. Universal Keyboard Dispatch Fallback, Defensive Schema Routing & Fail-Closed Closed-Loop Autopilot (V3.7 Milestone)

Ky version solli rregullime thelbësore dhe certifikimin në mjedis real prodhimi të orkestrimit të plotë autonom closed-loop:

1. **Universal DOM Enter Keypress Fallback:**
   - Zgjidhi gabimin `SEND_BUTTON_NOT_FOUND` në `mcp/server.js` kur butoni i dërgimit merr përkohësisht `aria-disabled="true"` gjatë ngarkimit të skedarëve duke injektuar direkt `Enter` sintetike në `composer.locator`.
2. **Defensive Schema 2.0 / Roles Compatibility:**
   - Shmangu gabimin `Cannot read properties of undefined (reading 'reviewer')` duke mbështetur si skemën 2.0 (`targets`) ashtu edhe fushën e nivelit të lartë `roles` në `routing.json`.
3. **Harmonizim Kontratash C# (Fail-Closed):**
   - Ruan të paprekur 100% kodin ekzistues të plugin-it (`RevitVilaMepCommand.cs` me 0 diff, ndërfaqet e vjetra për dockable pane), duke shtuar metodat e nevojshme për verifikimin autonom të Revit Villa MEP.
4. **Verifikim me Sukses të Plotë në Revit 2025 Villa MEP:**
   - Cikli u drejtua nga Hermes AI (`local-a7b4d9dc274fb4767bfe7680365bc942c496912a09e325ad5f362ac9dbe5ffef`) me Web 1 dhe Web 2 të kyçur në Google Gemini Neon High (`gemini1`, `gemini2`).
   - Të 14 portat RVT-0 deri RVT-13 u miratuan me `STATUS: PASSED`, kompilim me 0 gabime, certifikatë Authenticode e vlefshme, paketim `LOCALPERSONALAI_REVIT2025_DEPLOY=PASS`, dhe 17/17 teste të kaluara në `Phase4MultiOperationIntegrationTests`.
