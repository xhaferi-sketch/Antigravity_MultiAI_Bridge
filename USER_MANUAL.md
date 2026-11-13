# MANUALI I PLOTE OPERATIV DHE I MIREMBAJTJES — ANTIGRAVITY MULTI-AI BRIDGE (V3.2)

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
   - **Paketimi:** Zgjidh `project_bundle.txt` per shumicen e rasteve, ose `project_bundle.zip.md` per projekte te medha kur perdor M365 Copilot (`web1` / `web2`).
   - **Komandat Build dhe Test (0-Token):** Vendos komandat e projektit (p.sh. `npm run build` dhe `npm test`, ose `pytest`) dhe kliko **Ruaj Konfigurimin**.
3. **Ekzekuto ne Chat-in e Antigravity:**
   - Shkruaj: `/run-cycle <pershkruaj qarte detyren ose funksionin qe do te shtosh/rregullosh>`.
4. **Cfare Ndodh Vete pas Kuintave (Zero Kredi IDE):**
   - `pack_workspace` -> krijon paketen e paster te kodit me rruge `/`.
   - `run_planner` -> zgjedh modelin me me shume pike ne Headless dhe ruan `exchange/plan.md`.
   - `run_coder` -> gjeneron skedaret e plote ne `exchange/code.md` (dhe refuzon automatikisht cdo shkurtim `TODO` ose `... rest of code`).
   - `apply_and_test` -> Node.js shkruan skedaret direkt ne disk me **0 tokena AI** dhe ekzekuton Build/Test. Nese del gabim ne terminal, kryen vete deri ne **2 cikle Auto-Heal (`FIX_ERROR`)**.
   - `run_reviewer` -> kontrollon planin + kodin + `build_test.log` dhe mbyll fazen vetem me `STATUS: PASSED`.

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

