import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  invokeCoreLiveSync,
  liveSyncStatus,
  redactDiagnostic,
  runLiveSyncCommand,
  runStrictCodexPreflight,
} from "../src/codex-live-sync-launcher.mjs";
import {
  STRICT_SHIM_MARKER,
  installShim,
  isStrictShimFile,
  renderShim,
  shimStatus,
} from "../src/codex-shim.mjs";

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "codex-live-sync-launcher-"));
}

function executable(target, contents) {
  writeFileSync(target, contents, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}

function shimFixture({ strictResult = "ok" } = {}) {
  const root = scratch();
  const realDir = path.join(root, "real");
  const shimDir = path.join(root, "shim");
  const checkout = path.join(root, "checkout");
  mkdirSync(realDir, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(path.join(checkout, "src"), { recursive: true });
  const log = path.join(root, "events.log");
  const real = executable(
    path.join(realDir, "codex"),
    `#!/bin/sh
echo "real:$*" >> ${JSON.stringify(log)}
printf 'real %s\\n' "$*"
`,
  );
  executable(
    path.join(checkout, "src", "codex-live-sync-launcher.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "preflight\\n");
${strictResult === "fail" ? "console.error(\"fixture preflight failed\"); process.exit(23);" : ""}
`,
  );
  const environment = {
    PATH: [shimDir, realDir].join(path.delimiter),
    MODEL_ROUTER_SHIM_WAIT: "1",
  };
  const shim = path.join(shimDir, "codex");
  return { root, real, shim, checkout, log, environment };
}

test("strict preflight runs live sync, refreshes the router, and waits for authenticated health in order", async () => {
  const events = [];
  const result = await runStrictCodexPreflight({
    liveSync: async (options) => {
      events.push(["live", options.strict, options.refresh, options.nonInteractive]);
      return { ok: true, generation: "test-generation" };
    },
    catalogCommand: async () => {
      events.push(["catalog"]);
      return { completed: true };
    },
    serviceStatus: async () => {
      events.push(["status"]);
      return { installed: true, loaded: true };
    },
    serviceCommand: async (action) => {
      events.push([action]);
      return { action, completed: true };
    },
    waitHealth: async () => {
      events.push(["health"]);
      return { ok: true, payload: { version: "test" } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    ["live", true, true, true],
    ["catalog"],
    ["status"],
    ["restart"],
    ["health"],
  ]);
});

test("strict preflight publishes the fresh Codex catalog before restarting the router", async () => {
  const events = [];
  await runStrictCodexPreflight({
    liveSync: async () => {
      events.push("live");
      return { ok: true };
    },
    catalogCommand: async () => {
      events.push("catalog");
      return { generation: "catalog-generation" };
    },
    serviceStatus: async () => {
      events.push("status");
      return { installed: true };
    },
    serviceCommand: async () => {
      events.push("restart");
      return { completed: true };
    },
    waitHealth: async () => {
      events.push("health");
      return { ok: true };
    },
  });
  assert.deepEqual(events, ["live", "catalog", "status", "restart", "health"]);
});

test("a strict preflight failure stops before service restart or health", async () => {
  const events = [];
  await assert.rejects(
    () => runStrictCodexPreflight({
      liveSync: async () => {
        events.push("live");
        return { ok: false, error: "provider refresh failed" };
      },
      catalogCommand: async () => events.push("catalog"),
      serviceStatus: async () => {
        events.push("status");
        return { installed: true };
      },
      serviceCommand: async () => events.push("restart"),
      waitHealth: async () => events.push("health"),
    }),
    (error) => {
      assert.match(error.message, /Strict live-sync catalog refresh failed/);
      assert.match(error.message, /provider refresh failed/);
      return true;
    },
  );
  assert.deepEqual(events, ["live"]);
});

test("the adapter calls the catalog worker export and preserves its structured result", async () => {
  const root = scratch();
  try {
    const worker = path.join(root, "opencode-live-sync.mjs");
    const seen = path.join(root, "options.json");
    writeFileSync(
      worker,
      `import { writeFileSync } from "node:fs";
export async function strictPreflight(options) {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify(options));
  return { ok: true, generation: "worker-generation" };
}
`,
    );
    const result = await invokeCoreLiveSync({
      modulePath: worker,
      nodeBinary: process.execPath,
    });
    assert.equal(result.ok, true);
    assert.equal(result.generation, "worker-generation");
    const options = JSON.parse(readFileSync(seen, "utf8"));
    assert.deepEqual(options, {
      strict: true,
      refresh: true,
      publish: true,
      nonInteractive: true,
      quiet: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a strict shim executes the real Codex only after a successful preflight", { skip: process.platform === "win32" }, () => {
  const fixture = shimFixture();
  try {
    writeFileSync(
      fixture.shim,
      renderShim({
        realCodex: fixture.real,
        checkout: fixture.checkout,
        port: 1,
        strict: true,
        nodeBin: process.execPath,
      }),
      { mode: 0o755 },
    );
    chmodSync(fixture.shim, 0o755);
    assert.equal(isStrictShimFile(fixture.shim), true);
    const output = execFileSync(fixture.shim, ["hello", "world"], {
      env: { ...process.env, ...fixture.environment },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output.trim(), "real hello world");
    assert.equal(readFileSync(fixture.log, "utf8"), "preflight\nreal:hello world\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a strict shim blocks the real Codex when preflight fails", { skip: process.platform === "win32" }, () => {
  const fixture = shimFixture({ strictResult: "fail" });
  try {
    writeFileSync(
      fixture.shim,
      renderShim({
        realCodex: fixture.real,
        checkout: fixture.checkout,
        port: 1,
        strict: true,
        nodeBin: process.execPath,
      }),
      { mode: 0o755 },
    );
    chmodSync(fixture.shim, 0o755);
    assert.throws(
      () => execFileSync(fixture.shim, ["must-not-run"], {
        env: { ...process.env, ...fixture.environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      (error) => {
        assert.equal(error.status, 23);
        assert.match(String(error.stderr), /strict live-sync preflight failed/);
        return true;
      },
    );
    assert.equal(readFileSync(fixture.log, "utf8"), "preflight\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("disabling live sync rewrites an existing strict shim into legacy mode", () => {
  const root = scratch();
  try {
    const realDir = path.join(root, "real");
    const shimDir = path.join(root, "shim");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    const real = executable(path.join(realDir, "codex"), "#!/bin/sh\nexit 0\n");
    const environment = { PATH: [shimDir, realDir].join(path.delimiter) };
    const strict = installShim({
      environment,
      platform: "darwin",
      home: root,
      checkout: root,
      strict: true,
      nodeBin: process.execPath,
    });
    assert.equal(strict.strict, true);
    const legacy = installShim({
      environment,
      platform: "darwin",
      home: root,
      checkout: root,
      strict: false,
      nodeBin: process.execPath,
    });
    assert.equal(legacy.strict, false);
    assert.equal(isStrictShimFile(legacy.shim), false);
    assert.doesNotMatch(readFileSync(legacy.shim, "utf8"), new RegExp(STRICT_SHIM_MARKER));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict status is redacted and reports the effective mode", () => {
  const root = scratch();
  try {
    const realDir = path.join(root, "real");
    const shimDir = path.join(root, "shim");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    const real = executable(path.join(realDir, "codex"), "#!/bin/sh\nexit 0\n");
    const environment = {
      PATH: [shimDir, realDir].join(path.delimiter),
      MODEL_ROUTER_LIVE_SYNC_BYPASS: "1",
    };
    installShim({ environment, platform: "darwin", home: root, checkout: root, strict: true });
    const status = liveSyncStatus({ environment });
    assert.equal(status.strict_enabled, true);
    assert.equal(status.emergency_bypass_active, true);
    assert.equal(status.shim.real_codex, real);
    assert.equal(shimStatus(environment).strict, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live-sync command disable keeps a legacy shim and does not call preflight", async () => {
  const events = [];
  const result = await runLiveSyncCommand("disable", {
    getStatus: () => ({ shim: { installed: true }, strict_enabled: true }),
    install: ({ strict }) => {
      events.push(["install", strict]);
      return { strict: false };
    },
    preflight: async () => {
      events.push(["preflight"]);
      return { ok: true };
    },
  });
  assert.equal(result.disabled, true);
  assert.deepEqual(events, [["install", false]]);
});

test("live-sync command enable installs strict mode before its initial preflight", async () => {
  const events = [];
  const result = await runLiveSyncCommand("enable", {
    install: ({ strict }) => {
      events.push(["install", strict]);
      return { strict: true };
    },
    preflight: async () => {
      events.push(["preflight"]);
      return { ok: true, generation: "initial" };
    },
  });
  assert.deepEqual(events, [["install", true], ["preflight"]]);
  assert.equal(result.preflight.generation, "initial");
});

test("live-sync enable refuses an inactive fallback shim before preflight", async () => {
  const events = [];
  await assert.rejects(
    () => runLiveSyncCommand("enable", {
      install: ({ strict }) => {
        events.push(["install", strict]);
        return { strict: true, effective: false, needs_path_entry: "/tmp/codex-router-bin" };
      },
      preflight: async () => {
        events.push(["preflight"]);
        return { ok: true };
      },
    }),
    /not active on PATH.*\/tmp\/codex-router-bin/,
  );
  assert.deepEqual(events, [["install", true]]);
});

test("strict diagnostics redact caller capabilities and query credentials", () => {
  const diagnostic = redactDiagnostic(
    "http://127.0.0.1:49999/_codex-router/caller-secret-12345678901234567890123456789012/v1/health?api_key=top-secret authorization: Bearer abc123",
  );
  assert.doesNotMatch(diagnostic, /caller-secret/);
  assert.doesNotMatch(diagnostic, /top-secret/);
  assert.doesNotMatch(diagnostic, /abc123/);
  assert.match(diagnostic, /\[REDACTED\]/);
});

test("strict shim output still resolves the real binary rather than itself", { skip: process.platform === "win32" }, () => {
  const root = scratch();
  try {
    const realDir = path.join(root, "real");
    const shimDir = path.join(root, "shim");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    const real = executable(path.join(realDir, "codex"), "#!/bin/sh\nexit 0\n");
    const environment = { PATH: [shimDir, realDir].join(path.delimiter) };
    const installed = installShim({
      environment,
      platform: "darwin",
      home: root,
      checkout: root,
      strict: true,
    });
    assert.equal(installed.real_codex, real);
    assert.equal(installed.wraps, real);
    assert.notEqual(installed.shim, installed.real_codex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI dispatcher exposes live-sync help without importing the catalog worker", () => {
  // Windows has no shebang execution: spawning "./bin/model-router" directly
  // cannot resolve the dispatcher there, and cmd.exe shim generation is
  // deliberately out of scope for this feature (see installShim's win32
  // refusal). Run the dispatcher through its interpreter on Windows so the
  // same help text is exercised on every platform in CI.
  const isWindows = process.platform === "win32";
  const output = execFileSync(
    isWindows ? "sh" : "./bin/model-router",
    isWindows
      ? ["bin/model-router", "codex", "live-sync", "--help"]
      : ["codex", "live-sync", "--help"],
    {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.match(output, /enable.*strict live-sync/);
  assert.match(output, /MODEL_ROUTER_LIVE_SYNC_BYPASS=1/);
});

test("the authenticated health helper is injectable and does not make a network call here", async () => {
  const root = scratch();
  const secretPath = path.join(root, "caller-secret");
  const secret = "a".repeat(48);
  writeFileSync(secretPath, `${secret}\n`);
  const calls = [];
  try {
    const { waitForAuthenticatedRouterHealth } = await import(
      "../src/codex-live-sync-launcher.mjs"
    );
    const result = await waitForAuthenticatedRouterHealth({
      callerSecretPath: secretPath,
      port: 49999,
      wait: async ({ url, fetchImpl }) => {
        calls.push({ url, fetchImpl });
        return { ok: true, payload: { version: "test" } };
      },
      fetchImpl: async () => {
        throw new Error("network must not be called");
      },
    });
    assert.equal(result.ok, true);
    assert.match(calls[0].url, /127\.0\.0\.1:49999\/\_codex-router\//);
    assert.equal(typeof calls[0].fetchImpl, "function");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
