#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_TARGETS,
  BridgeError,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_MAX_CONSECUTIVE_TRANSIENT_ERRORS,
  DEFAULT_MAX_CYCLE_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_ROUTING_PATH,
  EXIT_CODES,
  REQUIRED_MODEL,
  STATUS_FAILED_MARKER,
  STATUS_PASSED_MARKER,
  appendAuditRecord,
  assertNeonHighModel,
  buildOrderedAccountRotation,
  extractJobId,
  extractObservedModel,
  extractOutputText,
  extractPhase,
  httpJsonRequest,
  inspectCdpForDowngrade,
  isForbiddenDowngradeModel,
  isQuotaOrRotationError,
  isStillRunningResponse,
  isTerminalFailureResponse,
  loadAndValidateRouting,
  parsePositiveInteger,
  pollJobUntilTerminal,
  readRotationCursor,
  requireCliValue,
  resolvePathWithinRepo,
  writeFileAtomic,
  writeOutputArtifact,
  writeRotationCursor
} from "./hermes_bridge.mjs";

const __filename = fileURLToPath(import.meta.url);

export function parseAutonomousCliArgs(argv) {
  const args = argv.slice(2);
  const options = {
    projectDir: null,
    target: "web1",
    promptPath: null,
    promptText: null,
    outputPath: null,
    resumeJobId: null,
    routingPath: DEFAULT_ROUTING_PATH,
    maxCycleMs: null,
    pollIntervalMs: null,
    longPollMs: null,
    heartbeatMs: null,
    maxTransientErrors: null,
    port: null,
    cdpPort: null
  };

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    switch (flag) {
      case "--project-dir":
        options.projectDir = requireCliValue(flag, next);
        i += 1;
        break;
      case "--target":
        options.target = requireCliValue(flag, next);
        i += 1;
        break;
      case "--prompt":
        options.promptPath = requireCliValue(flag, next);
        i += 1;
        break;
      case "--prompt-text":
        options.promptText = requireCliValue(flag, next);
        i += 1;
        break;
      case "--output":
        options.outputPath = requireCliValue(flag, next);
        i += 1;
        break;
      case "--resume-job-id":
      case "--job-id":
        options.resumeJobId = requireCliValue(flag, next);
        i += 1;
        break;
      case "--routing":
        options.routingPath = path.resolve(requireCliValue(flag, next));
        i += 1;
        break;
      case "--max-cycle-ms":
      case "--timeout-ms":
        options.maxCycleMs = parsePositiveInteger(flag, next);
        i += 1;
        break;
      case "--poll-ms":
      case "--poll-interval-ms":
        options.pollIntervalMs = parsePositiveInteger(flag, next);
        i += 1;
        break;
      case "--long-poll-ms":
        options.longPollMs = parsePositiveInteger(flag, next);
        i += 1;
        break;
      case "--heartbeat-ms":
        options.heartbeatMs = parsePositiveInteger(flag, next);
        i += 1;
        break;
      case "--max-transient-errors":
        options.maxTransientErrors = parsePositiveInteger(flag, next, 1000);
        i += 1;
        break;
      case "--port":
        options.port = parsePositiveInteger(flag, next, 65535);
        i += 1;
        break;
      case "--cdp-port":
        options.cdpPort = parsePositiveInteger(flag, next, 65535);
        i += 1;
        break;
      default:
        throw new BridgeError(EXIT_CODES.CLI_ERROR, "CLI_UNKNOWN_FLAG", `Unknown argument: ${flag}`);
    }
  }

  return options;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function sameNormalizedPath(a, b) {
  if (!a || !b) {
    return false;
  }
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  return process.platform === "win32" ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

async function acquireCycleLock(lockPath, projectDir) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const lockToken = crypto.randomUUID();
  const lockPayload = {
    pid: process.pid,
    token: lockToken,
    projectDir: path.resolve(projectDir),
    startedAtUtc: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
      return lockToken;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }

      let existing = null;
      try {
        const raw = await fsp.readFile(lockPath, "utf8");
        existing = JSON.parse(raw);
      } catch {
        existing = null;
      }

      if (existing && isProcessAlive(existing.pid)) {
        if (sameNormalizedPath(existing.projectDir, projectDir)) {
          throw new BridgeError(
            EXIT_CODES.BRIDGE_ERROR,
            "CYCLE_ALREADY_RUNNING",
            `An autonomous cycle is already active for project "${path.resolve(projectDir)}" (PID=${existing.pid}, started=${existing.startedAtUtc ?? "unknown"}).`,
            { activePid: existing.pid, projectDir: path.resolve(projectDir), lockPath }
          );
        }
      }

      process.stderr.write(
        `[LOCK_RECOVERY] Recovering stale or non-conflicting cycle lock at ${lockPath} (previous PID=${existing?.pid ?? "unknown"}).\n`
      );
      try {
        await fsp.unlink(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") {
          throw unlinkErr;
        }
      }
    }
  }

  await writeFileAtomic(lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`);
  return lockToken;
}

async function releaseCycleLock(lockPath, lockToken) {
  try {
    const raw = await fsp.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.token === lockToken && parsed?.pid === process.pid) {
      await fsp.unlink(lockPath);
    }
  } catch {
    // Ignore missing or already-replaced lock files.
  }
}

async function persistActiveCycleState(activeCycleStatePath, state) {
  await writeFileAtomic(activeCycleStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function removeActiveCycleState(activeCycleStatePath) {
  try {
    await fsp.unlink(activeCycleStatePath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

async function resolvePromptMaterial(options, jobsDir) {
  if (options.resumeJobId) {
    return { promptFile: null, promptText: null };
  }

  if (options.promptPath) {
    const resolved = path.resolve(options.promptPath);
    if (!fs.existsSync(resolved)) {
      throw new BridgeError(EXIT_CODES.CLI_ERROR, "PROMPT_FILE_NOT_FOUND", `Prompt file not found: ${resolved}`);
    }
    const text = await fsp.readFile(resolved, "utf8");
    if (text.trim().length === 0) {
      throw new BridgeError(EXIT_CODES.CLI_ERROR, "PROMPT_FILE_EMPTY", `Prompt file is empty: ${resolved}`);
    }
    return { promptFile: resolved, promptText: text };
  }

  if (options.promptText) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const promptFile = path.join(jobsDir, `prompt_${stamp}_${crypto.randomUUID().slice(0, 8)}.txt`);
    await writeFileAtomic(promptFile, options.promptText);
    return { promptFile, promptText: options.promptText };
  }

  throw new BridgeError(
    EXIT_CODES.CLI_ERROR,
    "CLI_MISSING_PROMPT",
    "Either --prompt <file>, --prompt-text <string>, or --resume-job-id <id> must be provided."
  );
}

export async function runAutonomousCycle(rawOptions) {
  const options = {
    projectDir: rawOptions.projectDir ?? null,
    target: rawOptions.target ?? "web1",
    promptPath: rawOptions.promptPath ?? null,
    promptText: rawOptions.promptText ?? null,
    outputPath: rawOptions.outputPath ?? null,
    resumeJobId: rawOptions.resumeJobId ?? null,
    routingPath: rawOptions.routingPath ?? DEFAULT_ROUTING_PATH,
    maxCycleMs: rawOptions.maxCycleMs ?? null,
    pollIntervalMs: rawOptions.pollIntervalMs ?? null,
    longPollMs: rawOptions.longPollMs ?? null,
    heartbeatMs: rawOptions.heartbeatMs ?? null,
    maxTransientErrors: rawOptions.maxTransientErrors ?? null,
    port: rawOptions.port ?? null,
    cdpPort: rawOptions.cdpPort ?? null
  };

  if (!ALLOWED_TARGETS.includes(options.target)) {
    throw new BridgeError(
      EXIT_CODES.CLI_ERROR,
      "CLI_INVALID_TARGET",
      `--target must be one of ${ALLOWED_TARGETS.join(", ")} (received: ${options.target}).`
    );
  }
  if (!options.projectDir || !options.outputPath) {
    throw new BridgeError(
      EXIT_CODES.CLI_ERROR,
      "CLI_MISSING_REQUIRED_ARGS",
      "run_autonomous_cycle requires --project-dir <dir> and --output <file>."
    );
  }

  const routing = await loadAndValidateRouting(options.routingPath);
  const targetConfig = routing.targets[options.target];

  const host = routing.bridge.host ?? DEFAULT_BRIDGE_HOST;
  const port = options.port ?? routing.bridge.port ?? DEFAULT_BRIDGE_PORT;
  const cdpHost = routing.bridge.cdpHost ?? DEFAULT_CDP_HOST;
  const cdpPort = options.cdpPort ?? routing.bridge.cdpPort ?? DEFAULT_CDP_PORT;
  const maxCycleMs = options.maxCycleMs ?? routing.bridge.maxCycleTimeoutMs ?? DEFAULT_MAX_CYCLE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? routing.bridge.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const longPollTimeoutMs = options.longPollMs ?? routing.bridge.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatMs ?? routing.bridge.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxConsecutiveTransientErrors =
    options.maxTransientErrors ??
    routing.bridge.maxConsecutiveTransientErrors ??
    DEFAULT_MAX_CONSECUTIVE_TRANSIENT_ERRORS;

  const statePath = resolvePathWithinRepo(
    routing.bridge.statePath ?? ".antigravity/bridge/rotation_state.json",
    "routing.bridge.statePath"
  );
  const auditPath = resolvePathWithinRepo(
    routing.bridge.auditLogPath ?? ".antigravity/bridge/bridge_audit.jsonl",
    "routing.bridge.auditLogPath"
  );
  const activeCycleStatePath = resolvePathWithinRepo(
    routing.bridge.activeCycleStatePath ?? ".antigravity/bridge/active_cycle.json",
    "routing.bridge.activeCycleStatePath"
  );
  const lockPath = resolvePathWithinRepo(
    routing.bridge.cycleLockPath ?? ".antigravity/bridge/cycle.lock",
    "routing.bridge.cycleLockPath"
  );
  const jobsDir = resolvePathWithinRepo(
    routing.bridge.jobsDir ?? ".antigravity/bridge/jobs",
    "routing.bridge.jobsDir"
  );

  const { promptFile, promptText } = await resolvePromptMaterial(options, jobsDir);

  const resolvedProjectDir = path.resolve(options.projectDir);
  const resolvedOutputPath = path.resolve(options.outputPath);
  const lockToken = await acquireCycleLock(lockPath, resolvedProjectDir);

  const startedAt = Date.now();
  const deadlineMs = startedAt + maxCycleMs;
  const requestId = crypto.randomUUID();
  const abortController = new AbortController();

  let activeJobId = options.resumeJobId ?? null;
  let activeAccount = null;
  let activePhase = options.resumeJobId ? "RESUMED" : "INIT";
  let interruptedSignal = null;

  const handleTerminationSignal = (sig) => {
    if (interruptedSignal) {
      return;
    }
    interruptedSignal = sig;
    abortController.abort();
  };

  process.on("SIGINT", handleTerminationSignal);
  process.on("SIGTERM", handleTerminationSignal);

  try {
    let immediateResult = null;

    if (!activeJobId) {
      const accounts = targetConfig.accountPool;
      const startCursor = await readRotationCursor(statePath, accounts);
      const orderedAccounts = buildOrderedAccountRotation(accounts, startCursor);
      const attemptLog = [];

      for (const accountId of orderedAccounts) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          throw new BridgeError(
            EXIT_CODES.TIMEOUT,
            "CYCLE_TIMEOUT",
            `Autonomous cycle exceeded ${maxCycleMs}ms budget during dispatch.`,
            { requestId, attempts: attemptLog }
          );
        }

        await inspectCdpForDowngrade(cdpHost, cdpPort, options.target, accountId, routing);

        const dispatchBody = {
          requestId,
          command: "run_cycle",
          projectDir: resolvedProjectDir,
          target: options.target,
          account: accountId,
          requiredModel: REQUIRED_MODEL,
          allowAutoMode: false,
          allowNeonLow: false,
          allowFallback: false,
          failClosed: true,
          blocking: false,
          timeoutMs: Math.min(longPollTimeoutMs + 5_000, remainingMs),
          maxCycleTimeoutMs: maxCycleMs,
          cdpPort,
          promptPath: promptFile,
          outputPath: resolvedOutputPath,
          prompt: promptText,
          clientId: "autonomous_cli_runner"
        };

        let response = await httpJsonRequest({
          host,
          port,
          method: "POST",
          requestPath: "/run_cycle",
          body: dispatchBody,
          timeoutMs: Math.min(longPollTimeoutMs + 5_000, remainingMs),
          signal: abortController.signal
        });

        if (response.statusCode === 404 || response.statusCode === 405 || response.statusCode === 501) {
          response = await httpJsonRequest({
            host,
            port,
            method: "POST",
            requestPath: "/roundtrip",
            body: { ...dispatchBody, command: "roundtrip" },
            timeoutMs: Math.min(longPollTimeoutMs + 5_000, Math.max(50, deadlineMs - Date.now())),
            signal: abortController.signal
          });
        }

        const observedModel = extractObservedModel(response);
        if (observedModel && isForbiddenDowngradeModel(observedModel, routing)) {
          await appendAuditRecord(auditPath, {
            timestampUtc: new Date().toISOString(),
            requestId,
            target: options.target,
            account: accountId,
            observedModel,
            requiredModel: REQUIRED_MODEL,
            downgradesDetected: 1,
            outcome: "REJECTED_MODEL_DOWNGRADE"
          });
          assertNeonHighModel(observedModel, routing, `dispatch/${options.target}/${accountId}`);
        }

        if (isQuotaOrRotationError(response)) {
          attemptLog.push({
            account: accountId,
            statusCode: response.statusCode,
            reason: "QUOTA_OR_NEON_HIGH_UNAVAILABLE_ROTATING"
          });
          await appendAuditRecord(auditPath, {
            timestampUtc: new Date().toISOString(),
            requestId,
            target: options.target,
            account: accountId,
            observedModel,
            requiredModel: REQUIRED_MODEL,
            downgradesDetected: 0,
            outcome: "FAILOVER_NEXT_ACCOUNT",
            httpStatus: response.statusCode
          });
          continue;
        }

        if (isStillRunningResponse(response)) {
          if (observedModel) {
            try {
              assertNeonHighModel(observedModel, routing, `dispatch/${options.target}/${accountId}/async`);
            } catch (err) {
              await appendAuditRecord(auditPath, {
                timestampUtc: new Date().toISOString(),
                requestId,
                target: options.target,
                account: accountId,
                observedModel,
                requiredModel: REQUIRED_MODEL,
                downgradesDetected: 1,
                outcome: "REJECTED_MODEL_DOWNGRADE"
              });
              throw err;
            }
          }

          activeJobId = extractJobId(response, requestId);
          activeAccount = accountId;
          activePhase = extractPhase(response, "DISPATCHED");
          await writeRotationCursor(statePath, accountId, options.target);
          await persistActiveCycleState(activeCycleStatePath, {
            jobId: activeJobId,
            requestId,
            status: "RUNNING",
            phase: activePhase,
            target: options.target,
            account: activeAccount,
            projectDir: resolvedProjectDir,
            outputPath: resolvedOutputPath,
            startedAtUtc: new Date(startedAt).toISOString(),
            updatedAtUtc: new Date().toISOString()
          });
          break;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new BridgeError(
            EXIT_CODES.BRIDGE_ERROR,
            "BRIDGE_HTTP_FAILURE",
            `Bridge returned HTTP ${response.statusCode} during dispatch for ${options.target}/${accountId}: ${response.rawText.slice(0, 300)}`,
            { requestId, accountId, statusCode: response.statusCode }
          );
        }

        if (response.jsonParseError || (response.body === null && response.rawText.trim().length === 0)) {
          throw new BridgeError(
            EXIT_CODES.BRIDGE_ERROR,
            "BRIDGE_CORRUPT_RESPONSE",
            `Bridge returned corrupt or empty payload on HTTP ${response.statusCode} during dispatch.`,
            { requestId, accountId, statusCode: response.statusCode }
          );
        }

        const outputText = extractOutputText(response);
        activeJobId = extractJobId(response, requestId);
        activeAccount = accountId;
        activePhase = extractPhase(response, "COMPLETED");

        if (isTerminalFailureResponse(response, outputText)) {
          immediateResult = {
            passed: false,
            status: STATUS_FAILED_MARKER,
            jobId: activeJobId,
            phase: activePhase,
            model: observedModel,
            account: activeAccount,
            outputText,
            summary: response.body?.summary ?? response.body?.message ?? outputText.slice(0, 300),
            pollsExecuted: 0,
            durationMs: Date.now() - startedAt
          };
          break;
        }

        try {
          assertNeonHighModel(observedModel, routing, `dispatch/${options.target}/${accountId}/terminal`);
        } catch (err) {
          await appendAuditRecord(auditPath, {
            timestampUtc: new Date().toISOString(),
            requestId,
            jobId: activeJobId,
            target: options.target,
            account: accountId,
            observedModel,
            requiredModel: REQUIRED_MODEL,
            downgradesDetected: 1,
            outcome: "REJECTED_MODEL_DOWNGRADE"
          });
          throw err;
        }

        await writeRotationCursor(statePath, accountId, options.target);
        immediateResult = {
          passed: true,
          status: STATUS_PASSED_MARKER,
          jobId: activeJobId,
          phase: activePhase,
          model: observedModel,
          account: activeAccount,
          outputText,
          summary: response.body?.summary ?? outputText.slice(0, 300),
          pollsExecuted: 0,
          durationMs: Date.now() - startedAt
        };
        break;
      }

      if (!activeJobId && !immediateResult) {
        await appendAuditRecord(auditPath, {
          timestampUtc: new Date().toISOString(),
          requestId,
          target: options.target,
          attemptedAccounts: orderedAccounts,
          requiredModel: REQUIRED_MODEL,
          downgradesDetected: 0,
          outcome: "FAIL_CLOSED_POOL_EXHAUSTED"
        });
        throw new BridgeError(
          EXIT_CODES.POOL_EXHAUSTED,
          "NEON_HIGH_POOL_EXHAUSTED",
          `Fail-closed abort: no account in [${orderedAccounts.join(", ")}] has "${REQUIRED_MODEL}" available.`,
          { requestId, attempts: attemptLog }
        );
      }
    } else {
      await persistActiveCycleState(activeCycleStatePath, {
        jobId: activeJobId,
        requestId,
        status: "RESUMED",
        phase: activePhase,
        target: options.target,
        account: activeAccount,
        projectDir: resolvedProjectDir,
        outputPath: resolvedOutputPath,
        startedAtUtc: new Date(startedAt).toISOString(),
        updatedAtUtc: new Date().toISOString()
      });
    }

    const finalResult =
      immediateResult ??
      (await pollJobUntilTerminal({
        jobId: activeJobId,
        routing,
        host,
        port,
        maxCycleMs,
        pollIntervalMs,
        longPollTimeoutMs,
        heartbeatIntervalMs,
        maxConsecutiveTransientErrors,
        auditPath,
        startedAt,
        initialPhase: activePhase,
        signal: abortController.signal,
        onProgress: async (progress) => {
          const phaseChanged = progress.phase !== activePhase;
          activePhase = progress.phase;
          if (progress.account) {
            activeAccount = progress.account;
          }
          if (phaseChanged || progress.pollSeq === 1) {
            await persistActiveCycleState(activeCycleStatePath, {
              jobId: activeJobId,
              requestId,
              status: "RUNNING",
              phase: activePhase,
              target: options.target,
              account: activeAccount,
              pollSeq: progress.pollSeq,
              projectDir: resolvedProjectDir,
              outputPath: resolvedOutputPath,
              startedAtUtc: new Date(startedAt).toISOString(),
              updatedAtUtc: new Date().toISOString()
            });
          }
        }
      }));

    await writeOutputArtifact(resolvedOutputPath, finalResult.outputText);
    await appendAuditRecord(auditPath, {
      timestampUtc: new Date().toISOString(),
      requestId,
      jobId: finalResult.jobId,
      target: options.target,
      account: finalResult.account ?? activeAccount,
      verifiedModel: finalResult.model,
      phase: finalResult.phase,
      downgradesDetected: 0,
      durationMs: finalResult.durationMs,
      pollsExecuted: finalResult.pollsExecuted,
      outcome: finalResult.status
    });
    await removeActiveCycleState(activeCycleStatePath);

    return {
      status: finalResult.status,
      jobId: finalResult.jobId,
      phase: finalResult.phase,
      model: finalResult.model,
      account: finalResult.account ?? activeAccount,
      durationMs: finalResult.durationMs,
      pollsExecuted: finalResult.pollsExecuted,
      outputPath: resolvedOutputPath,
      summary: finalResult.summary
    };
  } catch (err) {
    if (interruptedSignal && activeJobId) {
      await persistActiveCycleState(activeCycleStatePath, {
        jobId: activeJobId,
        requestId,
        status: "INTERRUPTED_RESUMABLE",
        signal: interruptedSignal,
        phase: activePhase,
        target: options.target,
        account: activeAccount,
        projectDir: resolvedProjectDir,
        outputPath: resolvedOutputPath,
        startedAtUtc: new Date(startedAt).toISOString(),
        updatedAtUtc: new Date().toISOString()
      });
      await appendAuditRecord(auditPath, {
        timestampUtc: new Date().toISOString(),
        requestId,
        jobId: activeJobId,
        signal: interruptedSignal,
        phase: activePhase,
        downgradesDetected: 0,
        outcome: "INTERRUPTED_RESUMABLE"
      });
      process.stderr.write(`INTERRUPTED_RESUMABLE JOB_ID=${activeJobId} SIGNAL=${interruptedSignal}\n`);
      const sigExit = interruptedSignal === "SIGINT" ? 130 : 143;
      throw new BridgeError(
        sigExit,
        "INTERRUPTED_RESUMABLE",
        `Cycle interrupted by ${interruptedSignal}; resume with --resume-job-id ${activeJobId}.`,
        { jobId: activeJobId, signal: interruptedSignal, phase: activePhase }
      );
    }

    if (err instanceof BridgeError && err.exitCode === EXIT_CODES.TIMEOUT && activeJobId) {
      await persistActiveCycleState(activeCycleStatePath, {
        jobId: activeJobId,
        requestId,
        status: "TIMEOUT_RESUMABLE",
        phase: activePhase,
        target: options.target,
        account: activeAccount,
        projectDir: resolvedProjectDir,
        outputPath: resolvedOutputPath,
        startedAtUtc: new Date(startedAt).toISOString(),
        updatedAtUtc: new Date().toISOString()
      });
      await appendAuditRecord(auditPath, {
        timestampUtc: new Date().toISOString(),
        requestId,
        jobId: activeJobId,
        phase: activePhase,
        downgradesDetected: 0,
        outcome: "TIMEOUT_RESUMABLE"
      });
    }

    throw err;
  } finally {
    process.off("SIGINT", handleTerminationSignal);
    process.off("SIGTERM", handleTerminationSignal);
    await releaseCycleLock(lockPath, lockToken);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    const current = fs.realpathSync(__filename);
    return process.platform === "win32"
      ? invoked.toLowerCase() === current.toLowerCase()
      : invoked === current;
  } catch {
    const invoked = path.resolve(process.argv[1]);
    const current = path.resolve(__filename);
    return process.platform === "win32"
      ? invoked.toLowerCase() === current.toLowerCase()
      : invoked === current;
  }
}

if (isDirectExecution()) {
  (async () => {
    const options = parseAutonomousCliArgs(process.argv);
    const result = await runAutonomousCycle(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== STATUS_PASSED_MARKER) {
      process.exit(EXIT_CODES.BRIDGE_ERROR);
    }
  })().catch((err) => {
    if (err instanceof BridgeError) {
      process.stderr.write(
        JSON.stringify({
          status: STATUS_FAILED_MARKER,
          code: err.code,
          message: err.message,
          details: err.details
        }) + "\n"
      );
      process.exit(err.exitCode);
    }
    process.stderr.write(
      JSON.stringify({
        status: STATUS_FAILED_MARKER,
        code: "UNHANDLED_AUTONOMOUS_CYCLE_ERROR",
        message: err?.message ?? String(err)
      }) + "\n"
    );
    process.exit(EXIT_CODES.BRIDGE_ERROR);
  });
}