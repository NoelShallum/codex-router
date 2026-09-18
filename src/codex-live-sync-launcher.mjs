// The executable-side adapter for strict OpenCode live sync.
//
// `opencode-live-sync.mjs` owns discovery, compatibility resolution, and
// catalog publication. This module intentionally does not know how those
// operations work: it calls the catalog worker's exported strict preflight (or
// its non-interactive CLI entry), then makes the service and authenticated
// router health the final launch gate.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCallerSecret,
  callerBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { installShim, shimReport } from "./codex-shim.mjs";
import {
  CALLER_SECRET_PATH,
  PORTS,
  SOURCE_ROOT,
} from "./paths.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const SELF = fileURLToPath(import.meta.url);
const LIVE_SYNC_MODULE_NAME = "opencode-live-sync.mjs";
const LIVE_SYNC_MODULE_PATH = path.join(SOURCE_ROOT, "src", LIVE_SYNC_MODULE_NAME);
const SERVICE_MODULE_PATH = path.join(SOURCE_ROOT, "src", "service.mjs");
const CATALOG_MODULE_PATH = path.join(SOURCE_ROOT, "src", "catalog.mjs");

// The catalog worker has a stable responsibility, not a required symbol name
// in this adapter's public surface. Keep the compatibility list small and
// explicit so a spelling change is visible here rather than silently falling
// through to a duplicated implementation.
const LIVE_SYNC_EXPORTS = Object.freeze([
  "refreshOpenCodeCatalogStrict",
  "strictPreflight",
  "runStrictPreflight",
  "preflightOpenCodeLiveSync",
  "strictOpenCodeLiveSync",
  "refreshOpenCodeLiveSync",
  "refreshOpenCodeCatalog",
  "runOpenCodeLiveSync",
]);

const FAILURE_STATUSES = new Set(["error", "failed", "failure", "blocked"]);

export class CodexLiveSyncError extends Error {
  constructor(message, { stage, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexLiveSyncError";
    this.code = "codex_live_sync_failed";
    if (stage) this.stage = stage;
  }
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map(errorMessage).filter(Boolean);
    return error.message + (nested.length ? `: ${nested.join("; ")}` : "");
  }
  return error instanceof Error ? error.message : String(error);
}

// Preflight diagnostics are allowed to cross a shell boundary. Keep the
// caller capability and common credential-bearing fields out even when a
// lower layer accidentally includes them in an error string.
export function redactDiagnostic(value) {
  return redactCallerUrl(String(value))
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',}]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_KEY]");
}

function redactedError(error) {
  return redactDiagnostic(errorMessage(error));
}

function fail(stage, error) {
  if (error instanceof CodexLiveSyncError && error.stage === stage) return error;
  return new CodexLiveSyncError(
    `Strict live-sync ${stage} failed: ${redactedError(error)}`,
    { stage, cause: error },
  );
}

function commandFailure(result, command, args) {
  if (result?.error) {
    throw result.error;
  }
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || "").trim();
    throw new Error(
      detail || `${command} ${args.join(" ")} exited with status ${result?.status ?? "unknown"}.`,
    );
  }
  return result;
}

export function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A CLI entry may print one human-readable line before its final JSON
    // result. Parse only complete lines; never attempt to repair arbitrary
    // output into a status object.
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Keep looking for the final machine-readable line.
      }
    }
    return undefined;
  }
}

function coreStatusFailed(status) {
  if (status === false) return true;
  if (!status || typeof status !== "object") return false;
  if (status.ok === false || status.success === false || status.failed === true) return true;
  return typeof status.status === "string" && FAILURE_STATUSES.has(status.status.toLowerCase());
}

function coreStatusError(status) {
  if (!status || typeof status !== "object") return "the catalog worker returned a failed status";
  return status.error || status.message || status.reason || `status=${status.status}`;
}

function normalizeCoreStatus(status, source) {
  if (coreStatusFailed(status)) {
    throw new CodexLiveSyncError(
      `The catalog worker did not complete successfully: ${redactDiagnostic(coreStatusError(status))}`,
      { stage: "catalog" },
    );
  }
  if (status && typeof status === "object") return { ok: true, source, ...status };
  return { ok: true, source, result: status ?? "completed" };
}

async function importLiveSyncModule(modulePath, importModule) {
  if (!existsSync(modulePath)) {
    throw new Error(
      `The catalog worker module is missing at ${modulePath}. Merge src/${LIVE_SYNC_MODULE_NAME} before enabling strict live sync.`,
    );
  }
  if (importModule) return importModule(modulePath);
  return import(pathToFileURL(modulePath).href);
}

/**
 * Call the catalog worker without duplicating its model discovery or routing.
 * The function form is preferred because it preserves a structured result;
 * the CLI form is the compatibility fallback promised by the worker contract.
 */
export async function invokeCoreLiveSync({
  modulePath = LIVE_SYNC_MODULE_PATH,
  importModule,
  run = defaultRun,
  nodeBinary = process.execPath,
  environment = process.env,
} = {}) {
  const moduleExists = existsSync(modulePath);
  if (moduleExists || importModule) {
    const worker = await importLiveSyncModule(modulePath, importModule);
    const candidates = LIVE_SYNC_EXPORTS
      .map((name) => [name, worker?.[name]])
      .filter(([, value]) => typeof value === "function");
    if (typeof worker?.default === "function") candidates.push(["default", worker.default]);

    if (candidates.length) {
      const [name, operation] = candidates[0];
      const result = await operation({
        strict: true,
        refresh: true,
        publish: true,
        nonInteractive: true,
        quiet: true,
      });
      return normalizeCoreStatus(result, `export:${name}`);
    }
  } else {
    // Keep the same actionable message whether the caller uses the export or
    // CLI compatibility path. It is especially useful for a stale checkout
    // whose shim survived an update that did not include the worker file.
    throw new Error(
      `The catalog worker module is missing at ${modulePath}. Merge src/${LIVE_SYNC_MODULE_NAME} before enabling strict live sync.`,
    );
  }

  const result = commandFailure(
    run(nodeBinary, [modulePath, "--strict", "--json"], {
      cwd: SOURCE_ROOT,
      env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeBinary,
    [modulePath, "--strict", "--json"],
  );
  return normalizeCoreStatus(parseJsonOutput(result.stdout), "cli");
}

export function readRouterServiceStatus({
  run = defaultRun,
  nodeBinary = process.execPath,
  serviceModule = SERVICE_MODULE_PATH,
  sourceRoot = SOURCE_ROOT,
  environment = process.env,
} = {}) {
  const result = commandFailure(
    run(nodeBinary, [serviceModule, "status"], {
      cwd: sourceRoot,
      env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeBinary,
    [serviceModule, "status"],
  );
  const parsed = parseJsonOutput(result.stdout);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("the router service returned an invalid status document");
  }
  return parsed;
}

export function runRouterServiceCommand(action, {
  run = defaultRun,
  nodeBinary = process.execPath,
  serviceModule = SERVICE_MODULE_PATH,
  sourceRoot = SOURCE_ROOT,
  environment = process.env,
} = {}) {
  if (!["start", "restart"].includes(action)) {
    throw new Error(`Unsupported router service action: ${action}`);
  }
  const result = commandFailure(
    run(nodeBinary, [serviceModule, action], {
      cwd: sourceRoot,
      env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeBinary,
    [serviceModule, action],
  );
  return parseJsonOutput(result.stdout) || { action, completed: true };
}

export function runCodexCatalogCommand({
  run = defaultRun,
  nodeBinary = process.execPath,
  catalogModule = CATALOG_MODULE_PATH,
  sourceRoot = SOURCE_ROOT,
  environment = process.env,
} = {}) {
  const result = commandFailure(
    run(nodeBinary, [catalogModule], {
      cwd: sourceRoot,
      env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    nodeBinary,
    [catalogModule],
  );
  return parseJsonOutput(result.stdout) || { completed: true };
}

export async function waitForAuthenticatedRouterHealth({
  wait = waitForRouterHealth,
  fetchImpl = fetch,
  callerSecretPath = CALLER_SECRET_PATH,
  port = PORTS.router,
  timeoutMs = 30_000,
} = {}) {
  let secret;
  try {
    secret = assertCallerSecret(readFileSync(callerSecretPath, "utf8").trim());
  } catch (error) {
    throw new Error(
      `the local router caller capability is unavailable (${redactedError(error)}); run ./bin/install`,
    );
  }

  // callerBaseUrl is Codex's `/v1` base, while the health resource is one
  // path segment below it. Passing the base itself would correctly reach the
  // router capability but receive a 404 because no `/v1` document exists.
  const url = `${callerBaseUrl(port, secret)}/health`;
  const health = await wait({
    url,
    timeoutMs,
    fetchImpl: (requestUrl, init = {}) => fetchImpl(requestUrl, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Accept: "application/json",
      },
    }),
  });
  if (!health?.ok) {
    throw new Error(
      health?.error
        ? `authenticated router health failed: ${redactDiagnostic(health.error)}`
        : "authenticated router health failed",
    );
  }
  return health;
}

/**
 * The only launch gate used by a strict shim. It is intentionally injectable
 * so unit tests can prove ordering and failure behavior without network calls,
 * provider credentials, or a service-manager mutation.
 */
export async function runStrictCodexPreflight({
  liveSync = invokeCoreLiveSync,
  catalogCommand = runCodexCatalogCommand,
  serviceStatus = readRouterServiceStatus,
  serviceCommand = runRouterServiceCommand,
  waitHealth = waitForAuthenticatedRouterHealth,
  run = defaultRun,
  nodeBinary = process.execPath,
  serviceModule = SERVICE_MODULE_PATH,
  catalogModule = CATALOG_MODULE_PATH,
  sourceRoot = SOURCE_ROOT,
  environment = process.env,
  timeoutMs = 30_000,
} = {}) {
  let live;
  try {
    live = await liveSync({
      strict: true,
      refresh: true,
      publish: true,
      nonInteractive: true,
    });
    if (coreStatusFailed(live)) {
      throw new Error(coreStatusError(live));
    }
  } catch (error) {
    throw fail("catalog refresh", error);
  }

  let catalog;
  try {
    // The worker persists the live snapshot, while catalog.mjs reads the
    // registry (and therefore that snapshot) in a fresh process. Keep this
    // publication step here so Codex's startup-only model_catalog_json and
    // the router's next service process consume the same generation.
    catalog = await catalogCommand({
      run,
      nodeBinary,
      catalogModule,
      sourceRoot,
      environment,
    });
  } catch (error) {
    throw fail("Codex catalog publication", error);
  }

  let currentService;
  try {
    currentService = await serviceStatus({
      run,
      nodeBinary,
      serviceModule,
      sourceRoot,
      environment,
    });
  } catch (error) {
    throw fail("router status", error);
  }

  const action = currentService?.installed === true || currentService?.loaded === true
    ? "restart"
    : "start";
  let service;
  try {
    service = await serviceCommand(action, {
      run,
      nodeBinary,
      serviceModule,
      sourceRoot,
      environment,
    });
  } catch (error) {
    throw fail(`router ${action}`, error);
  }

  let health;
  try {
    health = await waitHealth({ timeoutMs });
  } catch (error) {
    throw fail("authenticated health", error);
  }

  return {
    ok: true,
    strict: true,
    live_sync: live || { ok: true },
    catalog: catalog || { ok: true },
    router: {
      action,
      before: currentService,
      command: service,
    },
    health: {
      ok: true,
      ...(health?.payload?.version ? { version: health.payload.version } : {}),
    },
  };
}

function redactValue(value, key = "") {
  if (value === null || value === undefined) return value;
  if (/(?:api[_-]?key|authorization|password|secret|token)/iu.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

export function liveSyncStatus({ environment = process.env } = {}) {
  const shim = shimReport(environment);
  const bypass = environment.MODEL_ROUTER_LIVE_SYNC_BYPASS === "1" ||
    environment.MODEL_ROUTER_SHIM_LIVE_SYNC_BYPASS === "1";
  return {
    feature: "opencode-live-sync",
    strict_enabled: shim.strict === true && shim.effective === true,
    emergency_bypass_active: bypass,
    shim,
    note: "Strict mode refreshes OpenCode Go and free Zen before each managed Codex launch. The bypass deliberately permits a stale catalog.",
  };
}

function usage() {
  return `Usage: model-router codex live-sync ACTION [--json]

Actions:
  enable   install/activate the POSIX codex shim in strict live-sync mode
  disable  turn strict mode off while preserving the legacy shim behavior
  status   show redacted shim and strict-mode status
  refresh  refresh live catalogs, publish Codex's catalog, restart the router,
           and wait for authenticated health without starting Codex

Strict managed launches block when any preflight step fails. For emergency
troubleshooting only, set MODEL_ROUTER_LIVE_SYNC_BYPASS=1; this explicitly
permits Codex to start with a possibly stale catalog.
`;
}

export function parseLiveSyncArgs(args = []) {
  const values = [];
  let json = false;
  let quiet = false;
  let strict = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else if (argument === "--quiet") quiet = true;
    else if (argument === "--strict") strict = true;
    else if (argument === "--help" || argument === "-h") values.push("help");
    else values.push(argument);
  }
  return {
    action: values[0] || "status",
    json,
    quiet,
    strict,
  };
}

export async function runLiveSyncCommand(action, {
  install = installShim,
  getStatus = liveSyncStatus,
  preflight = runStrictCodexPreflight,
} = {}) {
  if (action === "status") return getStatus();
  if (action === "enable") {
    const shim = install({ strict: true });
    if (shim?.effective === false) {
      const pathHint = shim.needs_path_entry
        ? ` Add ${shim.needs_path_entry} before the real Codex directory on PATH, then retry.`
        : " Put the shim directory before the real Codex directory on PATH, then retry.";
      throw new Error(`Strict live sync was installed but is not active on PATH.${pathHint}`);
    }
    const preflightResult = await preflight();
    return { action, shim, preflight: preflightResult };
  }
  if (action === "disable") {
    const before = getStatus();
    if (!before.shim.installed) return { action, shim: before.shim, disabled: true };
    const shim = install({ strict: false });
    return { action, shim, disabled: true };
  }
  if (action === "refresh" || action === "preflight") {
    return preflight();
  }
  throw new Error(`Unknown live-sync action: ${action}. Use enable, disable, status, or refresh.`);
}

function humanResult(action, result) {
  if (action === "status") {
    const state = result.strict_enabled ? "enabled" : "disabled";
    return `OpenCode strict live sync is ${state}. Shim: ${result.shim.shim || "not installed"}.`;
  }
  if (action === "disable") return "OpenCode strict live sync disabled; any existing codex shim remains in legacy best-effort mode.";
  if (action === "enable") return "OpenCode strict live sync enabled and the initial preflight completed. Every managed codex launch will refresh first.";
  return "Strict OpenCode live-sync preflight completed; Codex was not started.";
}

export async function main(args = process.argv.slice(2), {
  write = (value) => process.stdout.write(value),
} = {}) {
  const parsed = parseLiveSyncArgs(args);
  if (parsed.action === "help") {
    write(usage());
    return { help: true };
  }
  if (parsed.action === "preflight" && !parsed.strict) {
    throw new Error("The internal preflight action requires --strict.");
  }
  const result = await runLiveSyncCommand(parsed.action);
  const safe = redactValue(result);
  if (!parsed.quiet) {
    if (parsed.json) write(`${JSON.stringify(safe, null, 2)}\n`);
    else write(`${humanResult(parsed.action, safe)}\n`);
  }
  return safe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    process.stderr.write(`${redactedError(error)}\n`);
    process.exit(1);
  });
}
