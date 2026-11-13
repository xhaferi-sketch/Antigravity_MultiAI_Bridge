Protokolli Zero-Token ndalon rreptësisht ngarkimin e skedarëve të shkëmbimit (.antigravity/bridge/exchange/*) në kontekstin e chat-it të Antigravity-t kur hapat ekzekutohen nga 5 fletët e jashtme (web1, web2, gemini1, gemini2, gemini3) dhe nga ekzekutuesi deterministik Node.js (apply_and_test). Komunikimi mes aktorëve kryhet ekskluzivisht përmes rrugëve fizike të skedarëve në disk.

---

## 7. PROCEDURA E SKILL-IT TË CIKLIT TË MBYLLUR (skills/run-cycle/SKILL.md)

--- SKEDARI 10: skills/run-cycle/SKILL.md ---
---
name: run-cycle
description: Ekzekuton ciklin e mbyllur Zero-Token mes Orchestrator-it, 5 fletëve Web/Gemini (Thinking/Think Deeper), 0-Token Node.js Executor dhe Release Gate në 127.0.0.1:4321.
---

# Procedura e Ciklit të Mbyllur (/run-cycle)

Kur përdoruesi kërkon një ndryshim ose thërret /run-cycle, ndiq këtë rrjedhë lineare pa lexuar skedarët e ndërmjetëm në chat:
1. Paketimi: Thirr pack_workspace(projectRoot, "FULL") (ose "DELTA" nëse projekti është paketuar më parë dhe ka Git).
2. Planifikimi (Thinking / Think Deeper): Thirr run_planner(projectRoot, userRequest).
3. Kodimi i Plotë: Thirr run_coder(projectRoot, "IMPLEMENT"). Serveri verifikon vetë që nuk ka placeholder-a.
4. Ekzekutimi & Testimi 0-Token: Thirr apply_and_test(projectRoot).
   - Nëse kthen BUILD_OR_TEST_FAILED dhe maxRetriesReached: false, thirr run_coder(projectRoot, "FIX_ERROR") dhe më pas përsëri apply_and_test(projectRoot) (deri në 2 riprova).
   - Vetëm nëse kthen DELEGATE_FALLBACK_EXECUTOR, aktivizo agjentin executor.
5. Release Gate (PASSED): Sapo apply_and_test kthen APPLIED_AND_GREEN, thirr run_reviewer(projectRoot).
   - Nëse kthen verdict PASSED ose status SKIPPED, raporto suksesin përfundimtar te përdoruesi me listën e skedarëve të përditësuar.

---
