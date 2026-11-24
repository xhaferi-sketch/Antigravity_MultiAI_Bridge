# URDHËR PUNE: AKTIVIZIMI I TEMPORARY CHAT PËR GEMINI NË MULTI-AI DASHBOARD

## 1. QËLLIMI DHE KËRKESA
Të shtohet opsioni me checkbox dhe status real në kohë reale për "⚡ Aktivizo Temporary Chat" ekskluzivisht për instancat Gemini (`gemini1`, `gemini2`, `gemini3`) në Multi-AI Dashboard (`http://127.0.0.1:4321`):
1. **Dashboard UI (`mcp/dashboard.html`):**
   - Poshtë çdo karte Gemini shtohet kontrolli me checkbox: `[✓] ⚡ Aktivizo Temporary Chat`.
   - Shfaqet statusi real në kohë reale: badge `AKTIV` (jeshile) kur biseda e përkohshme është aktive në shfletues, dhe `JO AKTIV` (gri/e kuqe) kur nuk është aktive.
   - Ndryshimi i checkbox-it dërgon menjëherë kërkesë në `/api/toggle-temporary-chat` për ta ruajtur gjendjen.
2. **Backend & Persistence (`mcp/server.js`):**
   - Regjistrimi i endpoint-it `/api/toggle-temporary-chat` (dhe `/api/save-tab-config`).
   - Ruajtja e konfigurimit në `.antigravity/bridge/tab_config.json`.
   - Gjendja IDLE duhet të jetë e vërtetë (truthful): instancat e pambyllura ose të paverifikuara tregojnë `Modeli aktiv: -` dhe `connectionLabel: "E Shkëputur"`, dhe bëhen `4 Neon (High)` vetëm pas verifikimit fizik me dëshmi nga DOM.
   - Gjatë thirrjes së `dispatchToWebTab`, verifikohet dhe aplikohet `ensureGeminiTemporaryChat`.
3. **Motori Gemini Playwright (`mcp/engines/gemini_engine.js`):**
   - Funksioni `ensureGeminiTemporaryChat(targetFrame, tabKey, enabled)`: lexon gjendjen reale të DOM-it në `gemini.google.com` (butoni i temporary chat, placeholderi, banderola), klikon çelësin nëse nuk përputhet me gjendjen e kërkuar, dhe konfirmon faturën reale nga DOM.
4. **Testet e Verifikimit:**
   - Testet e plota të automatizuara në `mcp/tests/gemini_dashboard_temporary_chat.test.js` duhet të kalojnë 100%.

## 2. KUFIJTË DHE NDALIMET E RREPTA (ZERO-TOUCH)
- **EKSKLUZIVE PËR GEMINI:** Preken VETËM `gemini1`, `gemini2`, dhe `gemini3`.
- **NDALIM TOTAL (BLLOKIM I BLINDUAR):**
  - `web1` dhe `web2` (Copilot / M365) janë 100% TË PAPREKURA.
  - `google_search_1`, `google_search_2`, dhe `google_search_3` janë 100% TË PAPREKURA.
