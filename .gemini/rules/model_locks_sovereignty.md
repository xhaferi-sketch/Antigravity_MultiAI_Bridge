# SOVRANITETI I MODELEVE TË KYÇURA NGA PËRDORUESI (`model_locks.json`)

[RULE LOCK: ACTIVE | USER_MODEL_CHOICE_SOVEREIGN]

1. **Prioritet Absoluti i `.antigravity/bridge/model_locks.json`:**
   - Zgjedhjet e kyçura manualisht nga përdoruesi përmes `SELEKTO_AI_MODEL.bat` (me `lockedByUser: true` në `.antigravity/bridge/model_locks.json`, p.sh. `4 Neon (Medium)`, `4 Carbon`, `Think deeper`, apo çdo model tjetër i selektuar me vullnetin e përdoruesit) kanë **prioritet absolut** mbi default-et `4 Neon (High)` dhe `GPT-5.6 Sol Think`.
   - Agjenti dhe Orchestratori **NDALOHEN** të bllokojnë, refuzojnë, ose të imponojnë `4 Neon (High)` / `GPT-5.6 Sol Think` kur përdoruesi ka kyçur vetë një model tjetër në `model_locks.json`.
2. **Kur zbatohet Anti-Downgrade:**
   - Ndalimi i downgrade-it në `Auto`/`Flash`/`Low`/`Quick` vlen **ekskluzivisht** kur **NUK** ekziston lock manual nga përdoruesi në `model_locks.json` (pra kundër uljes automatike të paautorizuar nga shfletuesi/motorët).
