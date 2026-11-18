import assert from "node:assert/strict";
import test from "node:test";

import {
  clientVersionTriple,
  codexAutoUpdateSkipped,
  codexRuntimeFreshness,
  compareClientVersions,
  ensureFreshCodexRuntime,
  npmManagedCodexPath,
} from "../src/codex-runtime-freshness.mjs";

function silenceConsoleError() {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  return { errors, restore: () => { console.error = originalError; } };
}

function freshnessStubs({
  resolvedPath = "/home/user/.local/bin/codex",
  resolvedVersion = "0.165.0",
  bundledPath = "/usr/lib/chatgpt/resources/codex",
  bundledVersion = "0.169.0",
} = {}) {
  const versions = new Map([
    [resolvedPath, resolvedVersion],
    ...(bundledPath ? [[bundledPath, bundledVersion]] : []),
  ]);
  return {
    findBinary: () => resolvedPath,
    findBundled: () => bundledPath || undefined,
    runVersion: (binary) => {
      if (!versions.has(binary)) throw new Error(`no stub version for ${binary}`);
      return versions.get(binary);
    },
  };
}

test("client version triples ignore prerelease suffixes and reject garbage", () => {
  assert.deepEqual(clientVersionTriple("0.169.0-alpha.11.1"), [0, 169, 0]);
  assert.deepEqual(clientVersionTriple("codex-cli 0.165.0"), [0, 165, 0]);
  assert.deepEqual(clientVersionTriple(""), undefined);
  assert.equal(compareClientVersions("0.165.0", "0.169.0"), -1);
  assert.equal(compareClientVersions("0.169.0-alpha.11.1", "0.169.0"), 0);
  assert.equal(compareClientVersions("0.170.0", "0.169.9"), 1);
  assert.equal(compareClientVersions("bogus", "0.169.0"), 0);
});

test("a bundled copy newer than the resolved CLI reads as stale", () => {
  const freshness = codexRuntimeFreshness(freshnessStubs());
  assert.equal(freshness.stale, true);
  assert.equal(freshness.resolved.version, "0.165.0");
  assert.equal(freshness.bundled.version, "0.169.0");
});

test("equal versions, a newer resolved CLI, and a missing bundled copy are fresh", () => {
  assert.equal(
    codexRuntimeFreshness(freshnessStubs({ resolvedVersion: "0.169.0" })).stale,
    false,
  );
  assert.equal(
    codexRuntimeFreshness(freshnessStubs({ resolvedVersion: "0.170.0" })).stale,
    false,
  );
  assert.equal(
    codexRuntimeFreshness(freshnessStubs({ bundledPath: null })).stale,
    false,
  );
});

test("the same file at both ends is an update already applied, not drift", () => {
  const stubs = freshnessStubs({
    resolvedPath: "/usr/lib/chatgpt/resources/codex",
    bundledPath: "/usr/lib/chatgpt/resources/codex",
    resolvedVersion: "0.169.0",
    bundledVersion: "0.169.0",
  });
  assert.equal(codexRuntimeFreshness(stubs).stale, false);
});

test("only node_modules/@openai/codex layouts count as npm-managed", () => {
  const realpath = (p) => p;
  assert.equal(
    npmManagedCodexPath("/home/user/.local/lib/node_modules/@openai/codex/bin/codex.js", realpath),
    true,
  );
  assert.equal(
    npmManagedCodexPath("/usr/lib/chatgpt/resources/codex", realpath),
    false,
  );
  assert.equal(npmManagedCodexPath(undefined, realpath), false);
  assert.equal(
    npmManagedCodexPath("/usr/local/bin/codex", () => { throw new Error("ENOENT"); }),
    false,
  );
});

test("MODEL_ROUTER_CODEX_AUTOUPDATE=0 skips the pass without spawning", () => {
  const calls = [];
  const result = ensureFreshCodexRuntime({
    spawn: (...args) => { calls.push(args); return { status: 0 }; },
    env: { MODEL_ROUTER_CODEX_AUTOUPDATE: "0" },
    freshnessOptions: freshnessStubs(),
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(calls, []);
});

test("a fresh runtime performs no update", () => {
  const { restore } = silenceConsoleError();
  try {
    const calls = [];
    const result = ensureFreshCodexRuntime({
      spawn: (...args) => { calls.push(args); return { status: 0 }; },
      env: {},
      freshnessOptions: freshnessStubs({ resolvedVersion: "0.169.0" }),
    });
    assert.equal(result.stale, false);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test("a stale npm-managed CLI is updated and announces itself on stderr", () => {
  const { errors, restore } = silenceConsoleError();
  try {
    const calls = [];
    const versions = { resolved: "0.165.0" };
    const result = ensureFreshCodexRuntime({
      spawn: (binary, args) => {
        calls.push([binary, args]);
        versions.resolved = "0.170.0";
        return { status: 0, stdout: "", stderr: "" };
      },
      env: {},
      freshnessOptions: {
        ...freshnessStubs(),
        runVersion: (binary) => binary === "/home/user/.local/bin/codex"
          ? versions.resolved
          : "0.169.0",
      },
      realpath: (p) => `/home/user/.local/lib/node_modules/@openai/codex/bin/${p.split("/").pop()}`,
    });
    assert.equal(result.updated, true);
    assert.deepEqual(calls, [["npm", ["install", "-g", "@openai/codex@latest"]]]);
    assert.ok(errors.some((line) => line.includes("updating the npm-managed copy")));
    assert.ok(errors.some((line) => line.includes("MODEL_ROUTER_CODEX_AUTOUPDATE=0")));
  } finally {
    restore();
  }
});

test("a stale copy outside npm management is reported, never touched", () => {
  const { errors, restore } = silenceConsoleError();
  try {
    const calls = [];
    const result = ensureFreshCodexRuntime({
      spawn: (...args) => { calls.push(args); return { status: 0 }; },
      env: {},
      freshnessOptions: freshnessStubs({
        resolvedPath: "/opt/handmade/codex",
        resolvedVersion: "0.150.0",
      }),
      realpath: (p) => p,
    });
    assert.equal(result.updated, false);
    assert.equal(result.reason, "not-npm-managed");
    assert.deepEqual(calls, []);
    assert.ok(errors.some((line) => line.includes("only auto-updates npm-managed copies")));
  } finally {
    restore();
  }
});

test("a failed npm update never throws and names the cause", () => {
  const { errors, restore } = silenceConsoleError();
  try {
    const result = ensureFreshCodexRuntime({
      spawn: () => { throw new Error("network down"); },
      env: {},
      freshnessOptions: freshnessStubs(),
      realpath: (p) => `/x/lib/node_modules/@openai/codex/bin/${p.split("/").pop()}`,
    });
    assert.equal(result.updated, false);
    assert.equal(result.reason, "update-failed");
    assert.ok(errors.some((line) => line.includes("network down")));
  } finally {
    restore();
  }
});
