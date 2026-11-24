# WORKSPACE GOVERNANCE & PROTECTED FILES

[RULE LOCK: ABSOLUTE | OVERRIDE: FORBIDDEN]

## PROTECTED FILES (READ-ONLY FOR AGENT)
The following files are strictly protected from all automated or agent edits:
- `**/.antigravity/bridge/routing.json`

### Enforcement:
1. The AI Agent is STRICTLY FORBIDDEN from calling `edit_file`, `write_file`, or terminal commands to modify `routing.json`.
2. All project roles (planner, coder, reviewer, executor) are managed EXCLUSIVELY by the user via the Multi-AI Dashboard at `http://localhost:4321`.
3. The AI Agent operates solely as an Orchestrator and must never act as a substitute coder without explicit user command.
4. Any change to code or configuration requires an explicit user report and confirmation.
