---
name: run-cycle
description: Orkestron automatikisht ciklin e plotë Multi-AI përmes MCP `multi-ai-relay` mbi projektin aktiv në Dashboard (4321) ose `root <path>`, me zero hardcoding dhe zero timer manual.
---

# Rregulli Universal për /run-cycle (Zero Pyetje, Zero Hardcoding)

Kur përdoruesi jep `/run-cycle` me çfarëdo argumenti (tekst i thjeshtë, rrugë skedari `.md`/`.txt`, ose `root <RrugaEProjektit> ...`):

1. **Mos pyet kurrë për `projectRoot` ose konfirmime — nis menjëherë:**
   - Nëse përdoruesi ka shkruar **`root <PATH>`** në kërkesë, kalo `projectRoot: "<PATH>"` dhe pjesën tjetër të mesazhit si `userRequest`.
   - Nëse përdoruesi **NUK** ka shkruar `root <PATH>` (p.sh. dha vetëm tekstin e kërkesës ose një rrugë skedari si `"C:\...\spec.md"`), **mos shpik rrugë projekti**: thirr `mcp__multi_ai_relay__run_full_cycle` me `projectRoot: ""` (bosh) dhe tekstin/rrugën e përdoruesit në `userRequest`. Ura (`127.0.0.1:4321`) zgjidh automatikisht **projektin aktiv të konfiguruar në Dashboard**, rolet (`web1`/`web2`/`gemini1..3`), komandat build/test, dhe lexon vetë skedarin e specifikimeve.

2. **Pritja me 0 Kredite (Zero Timer Manual / Zero Polling për Web 1, Web 2, Web 3 & `/run-cycle`):**
   - **NDALOHET KATEGORIKISHT** përdorimi i `schedule` timer-ave (p.sh. çdo 30s/45s) apo zgjimi i LLM-së me raporte të ndërmjetme për të pritur **Web 1 (`run_planner`)**, **Web 2 (`run_coder`)**, **Web 3 (`run_reviewer`)** ose `/run-cycle`.
   - Për ekzekutim me **1 njoftim të vetëm** pa u zgjuar çdo 45s, thirr `POST http://127.0.0.1:4321/api/mcp-proxy` në sfond me timeout të gjatë (për `run_planner`, `run_coder`, `run_reviewer`, ose `check_cycle_progress` me `blocking: true` / `waitMs: 3600000`), ose thirr `mcp__multi_ai_relay__check_cycle_progress` me `waitMs` të zgjatur brenda limitit MCP (ose `blocking: true` mbi HTTP) derisa statusi të jetë terminal (`CYCLE_COMPLETED`, `PASSED`, `FAILED`, `SUPPORT_REQUIRED_STOP_IMMEDIATELY`, ose `QUOTA_LIMIT_STOP`).

3. **Raporti Përfundimtar (Vetëm në fund):**
   - **Statusi:** `PASSED | FAILED | BLOCKED`
   - **Projekti & Modelet:** Emri/rruga e projektit + modelet e verifikuara Web 1 / Web 2 / Web 3
   - **Skedarët & Testet:** Dëshmitë reale nga disku.
