import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshServiceCatalogs,
  serviceCatalogRefreshSkipped,
  serviceIsRunning,
} from "../src/service.mjs";

function okSpawn(calls) {
  return (binary, args, options) => {
    calls.push({ binary, args, options });
    return { status: 0, stdout: "{}\n", stderr: "" };
  };
}

test("service catalog refresh is skipped with MODEL_ROUTER_SERVICE_REFRESH=0", () => {
  assert.equal(
    serviceCatalogRefreshSkipped({ MODEL_ROUTER_SERVICE_REFRESH: "0" }),
    true,
  );
  assert.equal(serviceCatalogRefreshSkipped({}), false);
  const calls = [];
  const result = refreshServiceCatalogs({
    spawn: okSpawn(calls),
    env: { MODEL_ROUTER_SERVICE_REFRESH: "0" },
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.steps, []);
  assert.deepEqual(calls, []);
});

test("service refresh runs opencode-live before catalog publication", () => {
  const calls = [];
  const result = refreshServiceCatalogs({
    spawn: okSpawn(calls),
    env: {},
    sourceRoot: "/repo",
    nodeBinary: "/node",
  });
  assert.equal(result.skipped, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].binary, "/node");
  assert.ok(calls[0].args[0].endsWith("src/opencode-live-sync.mjs"));
  assert.ok(calls[1].args[0].endsWith("src/catalog.mjs"));
  for (const call of calls) {
    assert.equal(call.options.env.MODEL_ROUTER_TARGET, "codex");
  }
  assert.deepEqual(
    result.steps.map((step) => [step.step, step.ok]),
    [["opencode-live", true], ["catalog", true]],
  );
});

test("a failed opencode refresh still publishes the catalog and never throws", () => {
  const calls = [];
  const spawn = (binary, args) => {
    calls.push(args[0]);
    return args[0].includes("opencode-live")
      ? { status: 1, stdout: "", stderr: "Strict OpenCode live refresh failed (go: boom).\n" }
      : { status: 0, stdout: "{}\n", stderr: "" };
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = refreshServiceCatalogs({
      spawn,
      env: {},
      sourceRoot: "/repo",
      nodeBinary: "/node",
    });
    assert.equal(result.skipped, false);
    assert.equal(result.steps[0].ok, false);
    assert.match(result.steps[0].detail, /status 1/);
    assert.equal(result.steps[1].ok, true);
    assert.equal(calls.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /opencode-live refresh skipped/);
  } finally {
    console.error = originalError;
  }
});

test("a spawning transport failure is tolerated without throwing", () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = refreshServiceCatalogs({
      spawn: () => {
        throw new Error("ETIMEDOUT");
      },
      env: {},
    });
    assert.equal(result.skipped, false);
    assert.ok(result.steps.every((step) => step.ok === false));
    assert.equal(errors.length, 2);
  } finally {
    console.error = originalError;
  }
});

test("serviceIsRunning reads the platform status document", () => {
  const running = (stdout, status = 0) => serviceIsRunning({
    spawn: () => ({ status, stdout, stderr: "" }),
    env: {},
    sourceRoot: "/repo",
    nodeBinary: "/node",
    scriptName: "service-linux.mjs",
  });
  assert.equal(running(JSON.stringify({ loaded: true, state: "stopped" })), true);
  assert.equal(running(JSON.stringify({ loaded: false, state: "active" })), true);
  assert.equal(running(JSON.stringify({ loaded: false, state: "Running" })), true);
  assert.equal(running(JSON.stringify({ loaded: false, state: "running" })), true);
  assert.equal(running(JSON.stringify({ loaded: false, state: "stopped" })), false);
  assert.equal(running("not-json"), false);
  assert.equal(running("{}", 1), false);
  assert.equal(
    serviceIsRunning({ spawn: () => { throw new Error("down"); }, env: {} }),
    false,
  );
});
