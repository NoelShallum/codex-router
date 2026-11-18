import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  findCodexBinary,
  linuxDesktopAppBundledCodex,
  runCodex,
} from "./codex-binary.mjs";

// MODEL_ROUTER_CODEX_AUTOUPDATE=0 skips the pass (e.g. air-gapped boots or a
// pinned CLI the operator manages by hand).
export function codexAutoUpdateSkipped(env = process.env) {
  return env.MODEL_ROUTER_CODEX_AUTOUPDATE === "0";
}

const CODEX_UPDATE_TIMEOUT_MS = 300_000;
const CODEX_VERSION_TIMEOUT_MS = 10_000;

// The backend gates the native model list on the caller's client_version: an
// older Codex asks with an old version and is answered poorly (new natives
// missing from the picker), while the desktop app's bundled CLI already
// qualifies. Compare numeric triples only; a prerelease suffix never widens
// the model list, and an unparseable value compares equal so it can never
// trigger an update on its own.
// `codex --version` prints a prefixed line ("codex-cli 0.165.0"), so the
// triple is searched, not anchored.
export function clientVersionTriple(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

export function compareClientVersions(left, right) {
  const a = clientVersionTriple(left);
  const b = clientVersionTriple(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function readCliVersion(binary, runVersion) {
  if (!binary) return undefined;
  try {
    const output = runVersion(binary);
    return String(output || "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultRunVersion(binary) {
  const output = runCodex(["--version"], {
    encoding: "utf8",
    timeout: CODEX_VERSION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return String(output || "").trim();
}

function defaultFindBundled(platform) {
  if (platform === "linux") return linuxDesktopAppBundledCodex({ platform });
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ].find((candidate) => {
      try {
        return realpathSync(candidate);
      } catch {
        return undefined;
      }
    });
  }
  // The Windows candidates live under %LOCALAPPDATA%/Programs; the resolver
  // already scans them, so reuse it instead of duplicating the layout here.
  return undefined;
}

// The resolved CLI versus the desktop app's bundled copy. `stale` is true
// only when both sides report parseable versions, the bundled copy is newer,
// and they are different files (a versioned reinstall at the same path is an
// update already applied, not drift).
export function codexRuntimeFreshness({
  findBinary = findCodexBinary,
  findBundled = defaultFindBundled,
  runVersion = defaultRunVersion,
  platform = process.platform,
} = {}) {
  const resolvedPath = findBinary();
  const bundledPath = findBundled(platform);
  const resolved = {
    path: resolvedPath,
    version: readCliVersion(resolvedPath, runVersion),
  };
  const bundled = bundledPath
    ? { path: bundledPath, version: readCliVersion(bundledPath, runVersion) }
    : undefined;
  const stale = Boolean(
    bundled &&
      resolved.path &&
      bundled.path &&
      bundled.path !== resolved.path &&
      compareClientVersions(bundled.version, resolved.version) > 0,
  );
  return { resolved, bundled, stale };
}

// An npm global install is the one layout the router may upgrade itself: the
// prefix is user-writable by design, and `npm i -g @openai/codex@latest` is
// OpenAI's own update path for the standalone CLI. Anything else (a .deb, a
// .pkg, a hand-placed binary) belongs to another manager, so report it.
export function npmManagedCodexPath(resolvedPath, realpath = realpathSync) {
  if (!resolvedPath) return false;
  try {
    const physical = realpath(resolvedPath);
    const parts = String(physical).split(path.sep);
    const nodeModules = parts.lastIndexOf("node_modules");
    return (
      nodeModules !== -1 &&
      parts[nodeModules + 1] === "@openai" &&
      parts[nodeModules + 2] === "codex"
    );
  } catch {
    return false;
  }
}

function updateStepError(result) {
  if (result?.error) return result.error.message || String(result.error);
  if (result?.signal) return `terminated with ${result.signal}`;
  if (typeof result?.status === "number" && result.status !== 0) {
    const stderr = String(result?.stderr || "").trim().split("\n").filter(Boolean);
    const tail = stderr.slice(-2).join(" | ").slice(0, 300);
    return `exited with status ${result.status}${tail ? `: ${tail}` : ""}`;
  }
  return "failed";
}

// Best-effort runtime refresh before a service boot: when the resolved CLI is
// older than the desktop app's bundled copy and the resolved copy is
// npm-managed, upgrade it so the account catalog fetch that follows asks with
// a current client_version. Every step logs; none throws.
export function ensureFreshCodexRuntime({
  spawn = spawnSync,
  env = process.env,
  npmCommand = "npm",
  updateTimeoutMs = CODEX_UPDATE_TIMEOUT_MS,
  freshnessOptions,
  realpath = realpathSync,
} = {}) {
  if (codexAutoUpdateSkipped(env)) return { skipped: true };
  const freshness = codexRuntimeFreshness(freshnessOptions);
  const { resolved, bundled, stale } = freshness;
  if (!stale) return { skipped: false, stale: false, ...freshness };
  const from = resolved.version || "unknown version";
  const to = bundled.version || "unknown version";
  if (!npmManagedCodexPath(resolved.path, realpath)) {
    console.error(
      `[codex-router] Codex CLI ${from} at ${resolved.path} is older than the desktop app's bundled ${to} at ${bundled.path}; update it (the router only auto-updates npm-managed copies). New native models may be missing from the picker until then.`,
    );
    return { skipped: false, stale: true, updated: false, reason: "not-npm-managed", ...freshness };
  }
  console.error(
    `[codex-router] Codex CLI ${from} is older than the desktop app's bundled ${to}; updating the npm-managed copy (MODEL_ROUTER_CODEX_AUTOUPDATE=0 skips this).`,
  );
  let detail = "";
  let ok = false;
  try {
    const result = spawn(
      npmCommand,
      ["install", "-g", "@openai/codex@latest"],
      { encoding: "utf8", env, timeout: updateTimeoutMs },
    );
    ok = result?.status === 0;
    if (!ok) detail = updateStepError(result);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  if (!ok) {
    console.error(
      `[codex-router] Codex CLI auto-update skipped (${detail}); starting with ${from}. New native models may be missing from the picker until the CLI is updated.`,
    );
    return { skipped: false, stale: true, updated: false, reason: "update-failed", detail, ...freshness };
  }
  const after = readCliVersion(resolved.path, freshnessOptions?.runVersion || defaultRunVersion);
  console.error(
    `[codex-router] Codex CLI updated${after ? ` to ${after}` : ""}; the catalog refresh that follows uses the new client.`,
  );
  return { skipped: false, stale: true, updated: true, from, to: after, ...freshness };
}
