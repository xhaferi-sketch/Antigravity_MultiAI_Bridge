# MANUALI I PLOTE OPERATIV DHE I MIREMBAJTJES — ANTIGRAVITY MULTI-AI BRIDGE (V3.5)

Ky manual permban cdo detaj per **perdorimin e perditshem**, **strukturen e skedareve te shkembimit**, **zgjerimin e sistemit ne te ardhmen** dhe **zgjidhjen e problemeve** pa analizuar kodin nga e para.

---

## 1. Identiteti i Sistemit dhe Garancia e Izolimit

| Parametri | Vlera Ekzakte |
| :--- | :--- |
| **Folderi Kryesor i Punes** | `C:\Vladi_project\Antigravity_MultiAI_Bridge` |
| **Lidhja ne Antigravity (Junction)** | `%USERPROFILE%\.gemini\config\plugins\multi-ai-orchestrator-bridge` |
| **Konfigurimi Auto-Start MCP** | `%USERPROFILE%\.gemini\config\mcp_config.json` -> `multi-ai-relay` |
| **Dashboard & Singleton Proxy** | `http://127.0.0.1:4321` (ose `http://localhost:4321`) |
| **5 Fletet ne Pool (Mutex Locked)** | `web1`, `web2` (`.profiles/m365`) dhe `gemini1`, `gemini2`, `gemini3` (`.profiles/gemini1..3`) |
| **Komanda Kryesore ne Chat** | `/run-cycle <kerkesa jote>` |
| **Izolimi Fizik** | Nuk prek kurre portat `15550`, `15555`, `15556`, `18000`, `19000`, `19005` apo `%LOCALAPPDATA%\HermesWebBridge`. |

---

## 2. Si Funksionon Auto-Start dhe Singleton Lock (Porta 4321)

- **Ndezja Automatike:** Sapo hap **Google Antigravity**, ai lexon `%USERPROFILE%\.gemini\config\mcp_config.json` dhe nis ne sfond pa dritare `node mcp/server.js`. Ne te njejtin cast aktivizohet edhe `http://localhost:4321`.
- **Puna me Shume Dritare Antigravity Njehesh:** Dritarja e pare e Antigravity-t merr porten `4321` (`isPrimaryInstance = true`). Cdo dritare e dyte ose e trete zbulon porten `4321` aktive (`EADDRINUSE`) dhe kalon vete ne **Singleton Proxy Mode** permes `/api/mcp-proxy`. Keshtu profilet e Chrome-it nuk bllokohen kurre!
- **Hapja Manuale kur Antigravity eshte Mbyllur:** Kliko dy here mbi `1_HAP_DASHBOARD_4321.bat` kur deshiron te besh Login ose te ndryshosh rolet pa hapur Antigravity-n.

---

## 3. Rrjedha e Perditshme e Punes me nje Projekt (Hapi pas Hapi)

1. **Hap Projektin ne Antigravity:** Zgjidh ne chat nje model te lehte ekonomik (p.sh. `Flash`), sepse gjithe arsyetimin arkitekturor dhe kodimin do ta kryejne motoret e jashtem ne `Thinking / Think Deeper`.
2. **Konfiguro Projektin ne `http://localhost:4321`:**
   - Ngjit rrugen e projektit te **Regjistro Projekt te Ri** (p.sh. `C:/Vladi_project/Projekti_Im`) dhe kliko **Shto Projektin**.
   - Cakto rolet me Dropdown:
     - **Planner:** p.sh. `gemini1` ose `web1` (analizon kodin, gjen Root Cause dhe cakton `ALLOWED_FILES`).
     - **Coder:** p.sh. `gemini2` ose `web2` (shkruan kodin e plote te prodhimit me etiketen `### FILE:`).
     - **Reviewer (Release Gate):** p.sh. `gemini3` ose `web1` (auditon kodin + log-et dhe jep `STATUS: PASSED`), ose `Off` per ndryshime shume te vogla.
3. **Rregullat e Paketimit dhe Formatet (`bundleFormat`):**
   - **`project_bundle.txt` (Për Gemini):** Skedarët bashkohen në një bllok të vetëm teksti me etiketa `--- FILE: rruga ---` dhe injektohen direkt me tastierë në kutinë e chat-it. Kjo bëhet sepse kur përdoruesi çaktivizon *Gemini Apps Activity = OFF* për privatësi, Google bllokon butonin fizik `+` të ngarkimit. Injektimi i tekstit është 100% imun dhe ka 0 sekonda vonesë ngarkimi.
   - **`project_bundle.zip.md` (Për M365 Copilot):** Copilot ka kufi të ngurtë në shkrim (~29,500 karaktere) dhe bllokon skedarët me prapashtesë `.zip`. Ura krijon arkiv real `.zip`, e riemërton në `.zip.md` me SHA-256 dhe e ngarkon si dokument Markdown të lejuar nga Microsoft-i.
4. **Butonat e Menaxhimit te Karta e Projektit:**
   - **🗑️ Fshi Projektin:** Heq regjistrimin e projektit nga Dashboard-i (pa prekur asnjë skedar të projektit në disk).
   - **🧹 Pastro Mbetjet e Shkëmbimit:** Pastron menjëherë skedarët e rëndë të paketimit dhe log-eve nga `.antigravity/bridge/exchange/`.
   - **💾 Ruaj Konfigurimin:** Ruan rolet, formatin e paketimit dhe komandat Build/Test.
5. **Ekzekuto ne Chat-in e Antigravity:**
   - Shkruaj: `/run-cycle <pershkruaj qarte detyren ose funksionin qe do te shtosh/rregullosh>`.
6. **Cfare Ndodh Vete pas Kuintave (Zero Kredi IDE & Autopilot 25s):**
   - `pack_workspace` -> krijon paketen e paster te kodit me rruge `/`.
   - `run_planner` -> zgjedh modelin me me shume pike ne Headless dhe ruan `exchange/plan.md`.
   - `run_coder` -> gjeneron skedaret e plote ne `exchange/code.md` (dhe refuzon automatikisht cdo shkurtim `TODO` ose `... rest of code`).
   - `apply_and_test` -> Node.js shkruan skedaret direkt ne disk me **0 tokena AI** dhe ekzekuton Build/Test. Nese del gabim ne terminal, kryen vete deri ne **2 cikle Auto-Heal (`FIX_ERROR`)**.
   - `run_reviewer` -> kontrollon planin + kodin + `build_test.log` dhe mbyll fazen vetem me `STATUS: PASSED`.
   - **Auto-Purge Automatike:** Sapo arrihet verdikti `STATUS: PASSED`, serveri pastron automatikisht skedarët e rëndë nga `exchange/` (`project_bundle.txt`, `.zip.md`, `last_error.txt`, screenshots) duke lënë projektin 100% të pastër.

---

## 4. Cfare Krijohet Brenda Cdo Projekti Target (`.antigravity/bridge/`)

Brenda cdo projekti ku punon, krijohet dosja lokale e izoluar `.antigravity/bridge/` (e cila perjashtohet vete nga paketimi):
- **`routing.json`**: Ruan rolet e zgjedhura ne Dashboard, formatin (`txt` / `zip.md`) dhe komandat `buildCmd` / `testCmd`.
- **`state.json`**: Ruan fazen aktuale (`PACKED`, `PLANNED`, `CODED`, `APPLIED_AND_VERIFIED`, `BUILD_FAILED`, `PASSED`) dhe numeruesin `retryCount` (`0..2`).
- **`exchange/project_bundle.txt`** (ose `.zip` + `.zip.md` me SHA-256 identik): Paketa qe iu ngarkua motorit ueb.
- **`exchange/plan.md`**: Plani arkitekturor nga Planner-i.
- **`exchange/code.md`**: Kodi i plote Markdown i pastruar nga blloku *Thinking*.
- **`exchange/build_test.log`**: Output-i i plote i ekzekutimit te komandave Build dhe Test.
- **`exchange/last_error.txt`**: Gabimi i kompresuar inteligjentisht (`10,000` karaktere fillimi + `10,000` karaktere fundi ku ndodhet Traceback-u) kur deshton terminali.
- **`exchange/review.md`**: Raporti dhe verdikti i Auditorit (`STATUS: PASSED` ose `STATUS: CHANGES_REQUIRED`).

> **Keshille per Git:** Shto `.antigravity/` ne skedarin `.gitignore` te projekteve te tua qe skedaret e perkohshem te mos futen ne komite.

---

## 5. Udhezues Mirembajtjeje: Si Modifikohet ose Zgjerohet Sistemi pa Analize nga e Para

### A. Shtimi i nje Modeli te Ri AI (p.sh. Gemini 4 Pro ose GPT-6 Sol)
- **Skedari qe preket:** `mcp/model_scores.json`.
- Veprimi: Shto fjalen kyce me shkronja te vogla te "positiveWeights" me pike te larta (p.sh. "4.0 pro": 170 ose "gpt-6": 175). Opsionet qe duhen shmangur shtohen te "negativeWeights" me -500.
- Restart? JO — lexohet live nga disku ne cdo kerkese!

### B. Forcimi ose Ndryshimi i Rregullave te Planner, Coder ose Reviewer
- Skedaret qe preken: rules/planner_rules.md, rules/coder_rules.md, rules/reviewer_rules.md.
- Restart? JO — lexohen live ne cdo thirrje! (Vetem nese ndryshon rules/AGENTS.md ose skills/run-cycle/SKILL.md, rihap Antigravity-n).

### C. Shtimi i Gjuheve te Reja te Programimit ne Paketues
- Skedari qe preket: mcp/server.js -> funksioni packWorkspace() -> konstanta allowedExts.
- Veprimi: Aktualisht pranohen .js, .mjs, .cjs, .ts, .jsx, .tsx, .py, .json, .md, .html, .css, .scss, .sql, .yaml, .yml, .sh, .ps1, .cs (skedare deri ne 500 KB). Shto prapashtesen e re (p.sh. '.vue', '.go', '.rs', '.java') dhe rihap Antigravity-n.

### D. Perditesimi i Selektoreve CSS nese Google/Microsoft ndryshojne UI-ne
- Skedari qe preket: mcp/server.js (vetem 4 funksione):
  1. ensureMaxReasoningMode() -> switcherSelectors (butoni i menuse se modeleve).
  2. resetChatIfNeeded() -> newChatSelectors (butoni New chat dhe konfirmimi i dialogut Leave temporary chat).
  3. waitAndExtractCleanResponse() -> containers (kontenjeri i pergjigjes dhe pastrimi i model-thoughts).
  4. dispatchToWebTab() -> box (fusha e shkrimit) dhe validSendBtn (butoni Send me PointerEvent).
- Verifikimi & Restart: Ekzekuto node --check mcp/server.js dhe rihap Antigravity-n.

### E. Shtimi i nje Flete te Gjashte (p.sh. gemini4 ose claude1)
- Ne mcp/server.js: shto celesin te tabs, tabAuthStatus, tabActiveModel, tabLocks dhe perditeso getProfileNameForTab() + getTargetUrl().
- Ne mcp/dashboard.html: shto butonin e Login-it dhe opsionin te lista const ENGINES = [...], pastaj rihap Antigravity-n.

---

## 6. Tabela e Zgjidhjes se Problemeve (Troubleshooting)

| Mesazhi ose Simptoma | Shkaku i Vertete | Zgjidhja e Menjehershme |
| :--- | :--- | :--- |
| AUTH_EXPIRED ne [tabKey] | Sesioni i Google ose Microsoft kerkon ri-identifikim. | Hap http://localhost:4321, kliko butonin Login te atij profili, identifikohu dhe mbylle dritaren me X. |
| BROWSER_UNAVAILABLE | Shkeputje interneti ose faqe e mbetur ne chromewebdata. | Kontrollo internetin dhe kliko Force New Chat ose Mbyll Fletet e Plugin-it ne Dashboard. |
| WEB_SERVICE_REFUSAL | Copilot/Gemini ktheu mesazh gabimi te sherbimit (Oops! Something happened). | Sistemi ben vete 1 retry automatik ne bisede te re; nese perseritet, kliko Force New Chat ose ndrro motorin ne Dropdown. |
| MAX_RETRIES_EXCEEDED | Build/Test ne terminal deshtoi mbi 2 here rresht gjate Auto-Heal. | Hap <Projekti>/.antigravity/bridge/exchange/last_error.txt per te pare gabimin; cdo /run-cycle i ri e sifron vete retryCount: 0. |
| DELEGATE_FALLBACK_EXECUTOR | Coder-i nuk vendosi etiketen ### FILE: ose la shkurtime ne kod. | Agjenti lokal executor e kryen vete si fallback, ose kliko Force New Chat te fleta e Coder-it. |
| Ndryshova server.js por nuk aplikohet | Procesi i vjeter node.exe qe mban porten 4321 eshte ende aktiv. | Mbyll Antigravity-n (dhe cdo dritare CMD te 4321) qe procesi node te mbyllet, pastaj rihap Antigravity-n. |

---

## 7. Backup & Restore (Para Formatimit te Windows-it)

1. Cfare duhet ruajtur ne Backup:
   - Folderi C:\Vladi_project\Antigravity_MultiAI_Bridge (mund te perjashtosh mcp/node_modules per madhesi te vogel).
   - Skedari %USERPROFILE%\.gemini\config\mcp_config.json.
2. Rikthimi pas Formatimit (30 sekonda):
   - Vendos folderin ne C:\Vladi_project\Antigravity_MultiAI_Bridge dhe ekzekuto cd C:\Vladi_project\Antigravity_MultiAI_Bridge\mcp && npm install.
   - Rikthe mcp_config.json te %USERPROFILE%\.gemini\config\ dhe krijo lidhjen Junction me:
     mklink /J "%USERPROFILE%\.gemini\config\plugins\multi-ai-orchestrator-bridge" "C:\Vladi_project\Antigravity_MultiAI_Bridge"
   - Hap http://localhost:4321 dhe kliko nje here Login per te 4 profilet (sepse Windows i ri gjeneron celes te ri enkriptimi DPAPI per Chrome).


---

## 8. Rrjedha Praktike e Përdoruesit (Human Flow & Shabllone të Gatshme)

Ky seksion tregon veprimet konkrete me dorë për çdo skenar pune ditor.

### Skenari A: Projekt Krejtësisht i Ri (Bëhet vetëm 1 herë në fillim)
1. **Përgatit Folderin:** Krijo folderin e projektit në PC (p.sh. `C:\Vladi_project\Projekti_Ri`).
   - *Kujdes:* Nëse folderi është 100% bosh, krijo të paktën 1 skedar bazë (p.sh. `index.js`, `main.py` ose `README.md`) që paketuesi të ketë pikë nisjeje.
2. **Hape në Antigravity:** Kliko `File -> Open Folder...` dhe zgjidh `C:\Vladi_project\Projekti_Ri`.
3. **Regjistroje në Dashboard (`http://localhost:4321`):**
   - Ngjit rrugën `C:/Vladi_project/Projekti_Ri` te **Regjistro Projekt të Ri** dhe kliko **Shto Projektin**.
   - Te karta e re zgjidh rolet (`Planner`, `Coder`, `Reviewer`), formatin (`txt` ose `zip.md`) dhe komandat `Build / Test` (ose lëri bosh në fillim).
   - Kliko **💾 Ruaj Konfigurimin**.
4. **Dërgo Kërkesën e Parë në Chat (Model i lehtë p.sh. Flash):**
   - Shkruaj:
     `Përdor multi-ai-relay (/run-cycle) për këtë kërkesë: Ndërto strukturën fillestare të projektit për [përshkruaj qëllimin].`

---

### Skenari B: Kërkesë e Re mbi të Njëjtin Projekt (Puna e Përditshme)
Kur projekti është tashmë i regjistruar në Dashboard, **nuk prek asgjë në `localhost:4321`**. Vetëm hap projektin në Antigravity dhe shkruaj kërkesën e radhës në chat:

- **Për të shtuar funksionalitet të ri:**
  `Përdor multi-ai-relay (/run-cycle): Shto funksionin [emri] te skedari [emri_skedarit] që kryen [logjika] dhe përditëso testet.`
- **Për të rregulluar një gabim (Bug Fix):**
  `Përdor multi-ai-relay (/run-cycle): Gjej shkakun pse [përshkruaj gabimin] dhe korrigjoje pa ndryshuar funksionet e tjera ekzistuese.`
- **Për të vazhduar me Fazën tjetër:**
  `Përdor multi-ai-relay (/run-cycle): Zbato Fazën 2 duke shtuar [detajet e fazës].`

*(Shënim: Formati "Përdor multi-ai-relay (/run-cycle): ..." e çon agjentin e Antigravity-t direkt te mjeti `pack_workspace` në sekondën e parë, pa humbur kohë duke kërkuar skedarë komandash në disk).*

---

### Skenari C: Ndërrimi nga Projekti 1 te Projekti 2
1. Në Antigravity kliko `File -> Open Folder...` dhe hap projektin tjetër.
2. Shkruaj direkt kërkesën në chat.
   - Serveri e dallon vetë ndërrimin e `projectRoot` dhe hap automatikisht **New Chat** në fletët e Gemini / M365 Copilot që konteksti i dy projekteve të mos përzihet kurrë.

---

### Skenari D: Kur Cikli Ndalet (`BLOCKED` ose `MAX_RETRIES_EXCEEDED`)
- **Nëse del `AUTH_EXPIRED`:** Hap `http://localhost:4321`, kliko **Login** për atë llogari, prit të hapet chat-i, mbylle me `X`, dhe shkruaj në Antigravity: `Vazhdo ciklin nga hapi ku mbeti.`
- **Nëse del `MAX_RETRIES_EXCEEDED` (pas 2 dështimeve në Build/Test):** Hap skedarin `<Projekti>/.antigravity/bridge/exchange/last_error.txt` për të parë gabimin e terminalit, ose ndërro motorin e `Coder`-it në Dashboard (p.sh. nga `gemini2` në `web2`), kliko **Ruaj Konfigurimin** dhe nis një kërkesë të re.

---

## 9. Suita e Testeve Stresuese të Hermes Bridge (`tests/hermes_bridge/`)

Për të garantuar që sistemi punon pa asnjë race condition, me latencë minimale, me kapje të menjëhershme të refuzimeve dhe me 0 kosto tokenash në IDE, në root të projektit ndodhet suita e plotë me 8 teste automatike:

### Struktura e Testeve:
- **`tests/hermes_bridge/scripts/test_linear_flow.py`**: Verifikon ekzekutimin e rreptë linear të kërkesave pa mbivendosje procesesh.
- **`tests/hermes_bridge/scripts/test_attachments_patch.py`**: Verifikon bashkëngjitjet dhe aplikimin e saktë të file diff `.patch`.
- **`tests/hermes_bridge/scripts/test_plugin_usage.py`**: Verifikon thirrjet e mjeteve MCP dhe integrimin në output.
- **`tests/hermes_bridge/scripts/test_report_generator.py`**: Verifikon prodhimin fizik të raporteve JSON në disk.
- **`tests/hermes_bridge/scripts/test_zero_token_verification.py`**: Verifikon kursimin 100% të kredive të IDE-së (0 tokens në Antigravity).
- **`tests/hermes_bridge/scripts/test_latency_benchmark.py`**: Mat latencën e përgjigjes së parë (TTFT < 150ms).
- **`tests/hermes_bridge/scripts/test_failover_resilience.py`**: Teston rimëkëmbjen automatike kur një fletë bie ose ndërrohet llogaria.
- **`tests/hermes_bridge/scripts/test_service_refusal_catch.py`**: Verifikon kapjen e menjëhershme (Fail-Fast) të refuzimeve të Google Gemini ("having a hard time fulfilling your request", "i encountered an error") dhe bllokimin e rënies në modele të dobëta (Flash-Lite / Auto).

### Ekzekutimi nga Terminali:
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
Raportet fizike të suksesshme ruhen automatikisht në:
`tests/hermes_bridge/reports/report_<test_name>_<timestamp>.json`

---

## 10. Auditimi i Integritetit dhe Rregullimet e Siguruara (Versioni 3.3 Milestone)

Të gjitha rregullimet themelore janë testuar dhe verifikuar fizikisht në kod:

1. **Pragu i Modelit Elitar (Score $\ge 800$):**
   - Vetëm `Code & analysis`, `4 Argon`, `Thinking`, `Think Deeper` lejohen për ekzekutim.
   - Çdo tentativë për kalim në `Flash`, `Lite`, `Auto`, `Default` refuzohet menjëherë me gabim kritik (`CRITICAL_MODEL_LOCK_REJECTED`).
   - U hoq çdo `.catch` i fshehur; nuk lejohet asnjë rënie e heshtur në modele të dobëta.

2. **Smart Attachment për Copilot (Eliminimi i `[COMPACTED]`):**
   - Kur motori është Copilot (`!isGemini`) dhe kërkesa përmban specifikime mbi 25,000 karaktere, ato ruhen automatikisht si skedar fizik në `.antigravity/bridge/exchange/spec_<name>.md`.
   - Skedari i bashkëngjitet fletës si attachment fizik përmes `attachFilesSafely`, ndërsa teksti i promptit mbetet i shkurtër pa u prerë me `[COMPACTED]`.

3. **Transparenca e Zbulimit të Modeleve në Dashboard:**
   - Endpoint-i `/api/state` dhe paneli grafik në portën 4321 shfaqin në kohë reale fushën `Modelet në ueb: <lista>` për çdo fletë aktive.

4. **Universal Workspace Packing & Mbrojtja nga `EPERM`:**
   - Paketuesi i projektit përjashton automatikisht të gjitha dosjet e profileve dhe cache-it të shfletuesve (`Default`, `GPUCache`, `IndexedDB`, `Local State`, `.profiles`, etj.).
   - Çdo operacion në disk mbrohet me `try/catch` për të parandaluar ndërprerjen e serverit nga lejet e Windows.

5. **Zgjidhja e Deadlock-ut në Autopilot:**
   - Fazat e brendshme të tubacionit autonom thërriten me `{ _internal: true }`, duke eliminuar vetë-bllokimin ndaj `CYCLE_EXCLUSIVE_LOCK`.

6. **Inxhinimi i Dokumenteve të Jashtme të Specifikimeve:**
   - Funksioni `resolveAndEmbedExternalFiles` zbulon dhe lexon automatikisht skedarët e mëdhenj të specifikimeve nga disku i PC dhe i injekton të plota te Planner-i dhe Coder-i.

---

## 11. Protokolli Urdhërues me 3 Nivele & Google Search AI (Versioni 3.4 Milestone)

Ky version i jep përdoruesit dhe orkestruesit kontroll të plotë mbi sjelljen e AI-së, duke shmangur helmimin e kontekstit dhe ndërprerjet e gjata:

1. **Mbështetja e Google Search AI (4 Carbon - Most Complex Work):**
   - Profilet `google_search_1`, `google_search_2`, `google_search_3` hapen direkt në `https://www.google.com/ai`.
   - Funksioni `ensureGoogleSearchAi4CarbonMode` kontrollon menynë dhe siguron kalimin në modelin më të fuqishëm me arsyetim `4 Carbon`.
   - Shfletuesi ekzekutohet me dritare të dukshme normale (`headless: false`, `--start-maximized`), duke shmangur bllokimin *"AI Mode is not available on your device"*.

2. **Zgjidhja e Kufirit të Shfletuesit (`maxlength="8192"`):**
   - Fusha e shkrimit e Google AI kufizon tekstin në 8,192 karaktere.
   - Paketa e kodit të projektit (`project_bundle.txt`) dhe skedarët e mëdhenj të specifikimeve ngarkohen fizikisht si bashkëngjitje përmes butonit `[+]` (`input[type="file"]`), duke garantuar që kodi të shkojë 100% i plotë pa asnjë shkurtim.

3. **Plani me 2 Faza të Kontrolluara:**
   - **Faza 1:** AI urdhërohet të prodhojë VETËM Seksionet 1, 2 dhe 3 (`OBJEKTIVAT`, `ENTRY POINT & ROOT CAUSE` dhe `ALLOWED_FILES`) dhe të ndalojë te etiketa `[FAZA_1_PERFUNDOI]`.
   - **Faza 2:** Pas miratimit, urdhërohet të japë Seksionet 4, 5 dhe 6 (`SPECIFIKIMI SKEDAR MË SKEDAR`, `HARDENING` dhe `DoD MATRIX`) me etiketën `[PLANI_PERFUNDOI_100%]`.

4. **Motori i Përshkallëzimit me 3 Nivele Urdhëruese:**
   - **Niveli 1 (Operativ Normal):** Kërkesa fillestare me kufijtë e fazës.
   - **Niveli 2 (Agresiv Disiplinor):** Nëse modeli devijon ose flet kot (yapping), i ndalohet çdo fjalë hyrëse dhe urdhërohet të japë vetëm listën teknike të kërkuar.
   - **Niveli 3 (Ultimativ Format Lock):** Paralajmërim skualifikimi me format të ngurtë skeletor.

5. **Pastrimi i Bisedës së Helmuar (Clean Chat Reset):**
   - Nëse modeli refuzon ose nuk bindet as pas Nivelit 3, sesioni shpallet i helmuar (*Context Poisoned*).
   - Shfletuesi kryen automatikisht navigim të pastër te `https://www.google.com/ai`, ri-bashkëngjit skedarët dhe e nis ciklin nga e para me një bisedë të re.

6. **Monitorimi i Butonit dhe Ekstraktimi i Saktë:**
   - Butoni "Dërgo" monitorohet derisa të jetë aktiv (`disabled !== true` dhe `aria-disabled !== true`), pa shtypur kurrë Enter të verbër.
   - Përgjigja nxirret me saktësi nga `section.bzXtMb` pas shënuesit zyrtar `Përgjigjja e "Modalitetit të IA-së" për `, duke pastruar butonat ndihmës të shfletuesit (`Kalo te kërkesa e mëparshme`).

---

## 12. Arkitektura Universale e Planifikimit: Smart Blueprint, Handshake & Slicing Anti-Timeout (Versioni 3.5 Milestone)

Ky version zgjidh përfundimisht kufizimet fizike të Google AI dhe mbron bisedat nga bllokimet dhe djegia e krediteve:

1. **Smart Architecture Blueprint (`generateSmartArchitectureMap`):**
   - Skanon në mënyrë universale çdo projekt pa ngarkuar skedarë të rëndë 350 KB.
   - Përjashton mbetjet (`node_modules`, `profiles`, `.venv`, `03_Workspaces`).
   - Nxjerr pemën e skedarëve, manifestet (`package.json`, `requirements.txt`), konfigurimet YAML dhe nënshkrimet e klasave/funksioneve brenda vetëm 10–25 KB.

2. **Protokolli Handshake (Hapi 1):**
   - Dërgon fillimisht vetëm Hartën Arkitekturore me urdhrin e hekurt:
     *"Përgjigju TANI VETËM me fjalët ekzakte: OK e lexova, vazhdojmë me hapin e radhës."*
   - Modeli konfirmon në 3 sekonda pa u mbingarkuar.

3. **Ndarja e Specifikimeve me Faza (`sliceSpecification` < 70 KB input):**
   - Kërkesat dhe specifikimet e gjata (deri në 100+ KB) ndahen automatikisht në faza sekuenciale nën 45–50 KB secila, duke garantuar 0 ngrirje të shfletuesit.

4. **Buxheti i Hekurt i Output-it (Anti-Timeout 120–180 Rreshta / Max 8–10 KB):**
   - Zbulimi live provoi se nëse modeli shkruan mbi 250–300 rreshta, serveri i Google bën timeout pas 60–90 sekondash dhe shfaq *"Something went wrong"*.
   - U vendos kufizimi i prerë në prompt: përgjigja e modelit për çdo fazë duhet të jetë midis 120 dhe 180 rreshtave (8–10 KB), duke përfunduar brenda 15–22 sekondash.
   - Të gjitha fazat bashkohen automatikisht në `plan.md`.

5. **Zgjidhja e Bllokimit në DOM dhe Ruajtja e Krediteve të Chat-it:**
   - U eliminua kurthi i elementit statik `role="progressbar"`.
   - Nxjerrja e përgjigjes kryhet me zhdukjen e butonit `Ndalo`/`Stop` dhe 4 sekonda qëndrueshmëri teksti.
   - `waitJobSlice` u zgjat në 22 sekonda, duke reduktuar me >75% thirrjet e përsëritura `check_cycle_progress`.




