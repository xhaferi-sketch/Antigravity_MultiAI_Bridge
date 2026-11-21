---
name: run-cycle
description: Ekzekuton ciklin e plotë autonom Multi-AI (pack -> planner -> coder -> apply -> reviewer) mbi projektin aktiv duke përdorur Google Gemini Neon High dhe M365 Copilot me zero kredi IDE dhe zero babysitting.
---

# Rregulli Suprem për /run-cycle dhe Autopilot (Zero-Babysitting Closed Loop)

Kur përdoruesi jep komandën `/run_cycle`, `/run-cycle`, ose kërkon ekzekutim të ciklit mbi një projekt:

1. **Ekzekutimi Kryesor Determinist (Zero Babysitting & Zero LLM Quota):**
   - Agjenti (Hermes) ekzekuton menjëherë runner-in determinist autonom:
     ```powershell
     node scripts/run_autonomous_cycle.mjs --project-dir "<PROJECT_ROOT>" --prompt-text "<USER_REQUEST>" --output ".antigravity/bridge/exchange/final_verdict.json"
     ```
   - **Pse përdoret ky runner?**
     Ky runner merr përsipër të gjithë pritjen dhe polling-un në Node.js (0 tokenë LLM të djegur gjatë pritjes, 0 lekë kosto, 0 ndërhyrje njerëzore).
     Ai bën polling me heartbeat në stderr çdo 10s, përballon të gjitha fazat (Planning chunks, Coding, Apply, Test, Review), dhe del vetëm kur cikli përfundon plotësisht me `STATUS: PASSED` ose `STATUS: FAILED`.

2. **Ekzekutimi Alternativ me MCP Tool (Nëse nuk përdoret CLI):**
   - Nëse thirret mjeti MCP `run_full_cycle`, dhe serveri kthen `STILL_RUNNING_CALL_CHECK_PROGRESS`:
   - Agjentit i **NDALOHET KATEGORIKISHT** t'i shkruajë përdoruesit në chat.
   - Agjenti thërret menjëherë në unazë të mbyllur `check_cycle_progress` (me `poll_seq`) derisa statusi të jetë `CYCLE_COMPLETED` ose `PASSED`.

3. **Formati i Raportit Përfundimtar drejt Përdoruesit (Vetëm në përfundim):**
   - Përdoruesit i raportohet **VETËM NJË HERË NË FUND**:
     * **Statusi:** PASSED | FAILED
     * **Modelet:** Google Gemini Neon High (Lock 100%)
     * **Testet:** Rezultati i testbed-it dhe faturat fizike.
