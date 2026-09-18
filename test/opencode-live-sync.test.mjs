import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { protectPrivateFile } from "../src/file-security.mjs";
import {
  buildOpenCodeLiveModel,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
  persistOpenCodeLiveCatalog,
  readOpenCodeLiveCatalog,
  resolveOpenCodeModelRoute,
} from "../src/opencode-live-metadata.mjs";
import { refreshOpenCodeCatalogStrict } from "../src/opencode-live-sync.mjs";

function response(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return payload;
    },
  };
}

function testState() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-live-sync-"));
  return {
    directory,
    target: path.join(directory, "opencode-live-catalog.json"),
    previous: path.join(directory, "opencode-live-catalog.json.previous"),
  };
}

function fixturePersist(state) {
  return (snapshot) => persistOpenCodeLiveCatalog(snapshot, {
    target: state.target,
    previousTarget: state.previous,
  });
}

function fixtureRead(state) {
  return () => readOpenCodeLiveCatalog({ target: state.target });
}

function fakeCredential() {
  return { value: "test-secret-that-must-not-escape", source: "test", persistent: true };
}

test("route metadata resolves current Go and Zen protocol variants", () => {
  assert.equal(resolveOpenCodeModelRoute("go", "minimax-m3")?.providerId, "opencode-go-messages");
  assert.equal(resolveOpenCodeModelRoute("go", "grok-4.6")?.providerId, "opencode-go-responses");
  assert.equal(resolveOpenCodeModelRoute("go", "qwen3.5-plus")?.providerId, "opencode-go");
  assert.equal(resolveOpenCodeModelRoute("go", "qwen3.8-flash")?.providerId, "opencode-go-messages");
  assert.equal(resolveOpenCodeModelRoute("go", "mimo-v2-omni")?.providerId, "opencode-go");
  assert.equal(resolveOpenCodeModelRoute("zen", "big-pickle")?.providerId, "opencode-zen");
  assert.equal(resolveOpenCodeModelRoute("zen", "union-alpha")?.providerId, "opencode-zen-messages");
  assert.equal(
    resolveOpenCodeModelRoute("zen", "muse-spark-1.3-contributor-free")?.providerId,
    "opencode-zen-responses",
  );
  assert.equal(resolveOpenCodeModelRoute("go", "future-unknown-model"), undefined);
});

test("strict refresh fetches Go and Zen in parallel and publishes live-compatible models", async () => {
  const state = testState();
  const calls = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  try {
    const result = await refreshOpenCodeCatalogStrict({
      lock: false,
      credentialResolver: () => fakeCredential(),
      persist: fixturePersist(state),
      readPrevious: fixtureRead(state),
      now: () => new Date("2026-09-17T00:00:00.000Z"),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls.length === 2) releaseBoth();
        await bothStarted;
        active -= 1;
        if (url === OPENCODE_GO_MODELS_URL) {
          return response({ data: [
            { id: "glm-5.4-preview", object: "model", owned_by: "opencode" },
            { id: "deepseek-flash", object: "model", owned_by: "opencode" },
            { id: "omen-alpha", object: "model", owned_by: "opencode" },
          ] });
        }
        assert.equal(url, OPENCODE_ZEN_MODELS_URL);
        return response({ data: [
          { id: "big-pickle", object: "model", owned_by: "opencode" },
          { id: "union-alpha", object: "model", owned_by: "opencode" },
          { id: "mimo-v2.5-free", object: "model", owned_by: "opencode" },
          { id: "claude-opus-4-8", object: "model", owned_by: "opencode" },
          { id: "future-model-free", object: "model", owned_by: "opencode" },
        ] });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(maximumActive, 2);
    assert.deepEqual(calls.map(({ url }) => url).sort(), [
      OPENCODE_GO_MODELS_URL,
      OPENCODE_ZEN_MODELS_URL,
    ].sort());
    for (const { options } of calls) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, `Bearer ${fakeCredential().value}`);
      assert.match(options.headers["User-Agent"], /^codex-router\//);
      assert.equal(options.headers["x-opencode-session"], "codex-router-discovery");
    }
    assert.deepEqual(
      result.models.map((model) => model.slug),
      [
        "opencode-go/glm-5.4-preview",
        "opencode-go/deepseek-flash",
        "opencode-zen/big-pickle",
        "opencode-zen-messages/union-alpha",
        "opencode-zen/mimo-v2.5-free",
      ].sort(),
    );
    assert.ok(result.quarantined.some(({ id, reason }) => id === "omen-alpha" && reason === "unknown-protocol"));
    assert.ok(result.quarantined.some(({ id, reason }) => id === "claude-opus-4-8" && reason === "paid-zen-model"));
    assert.ok(result.quarantined.some(({ id, reason }) => id === "future-model-free" && reason === "unknown-protocol"));
    assert.doesNotMatch(JSON.stringify(result), /test-secret-that-must-not-escape/);

    const snapshot = JSON.parse(readFileSync(state.target, "utf8"));
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.generation, result.generation);
    assert.equal(snapshot.fetchedAt, "2026-09-17T00:00:00.000Z");
    assert.equal(snapshot.providers.go.status, "ok");
    assert.equal(snapshot.providers.zen.status, "ok");
    assert.equal(snapshot.providers.go.published, 2);
    assert.equal(snapshot.providers.zen.published, 3);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("strict refresh removes withdrawn models and retains the prior snapshot", async () => {
  const state = testState();
  const options = {
    lock: false,
    credentialResolver: () => fakeCredential(),
    persist: fixturePersist(state),
    readPrevious: fixtureRead(state),
    fetchImpl: async (url) => response({
      data: url === OPENCODE_GO_MODELS_URL
        ? [{ id: "glm-5.4-preview" }, { id: "deepseek-flash" }]
        : [{ id: "big-pickle" }],
    }),
  };
  try {
    const first = await refreshOpenCodeCatalogStrict(options);
    const firstContents = readFileSync(state.target, "utf8");
    assert.equal(first.ok, true);

    const second = await refreshOpenCodeCatalogStrict({
      ...options,
      fetchImpl: async (url) => response({
        data: url === OPENCODE_GO_MODELS_URL
          ? [{ id: "glm-5.4-preview" }]
          : [{ id: "big-pickle" }],
      }),
    });
    assert.equal(second.ok, true);
    assert.deepEqual(second.models.map((model) => model.slug), [
      "opencode-go/glm-5.4-preview",
      "opencode-zen/big-pickle",
    ]);
    assert.equal(readOpenCodeLiveCatalog({ target: state.target }).models.length, 2);
    assert.equal(readFileSync(state.previous, "utf8"), firstContents);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("strict refresh fails closed for a paid Zen id and unresolved protocol", async () => {
  const state = testState();
  try {
    const result = await refreshOpenCodeCatalogStrict({
      lock: false,
      credentialResolver: () => fakeCredential(),
      persist: fixturePersist(state),
      readPrevious: fixtureRead(state),
      fetchImpl: async (url) => response({
        data: url === OPENCODE_GO_MODELS_URL
          ? [{ id: "future-responses-only-model" }]
          : [{ id: "gpt-5.6-luna" }, { id: "paid-with-free-looking-name-free" }],
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, []);
    assert.deepEqual(
      result.quarantined.map(({ id, reason }) => `${id}:${reason}`).sort(),
      [
        "future-responses-only-model:unknown-protocol",
        "gpt-5.6-luna:paid-zen-model",
        "paid-with-free-looking-name-free:unknown-protocol",
      ].sort(),
    );
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("endpoint failure does not replace the last successful atomic snapshot", async () => {
  const state = testState();
  const base = {
    lock: false,
    credentialResolver: () => fakeCredential(),
    persist: fixturePersist(state),
    readPrevious: fixtureRead(state),
    fetchImpl: async (url) => response({
      data: url === OPENCODE_GO_MODELS_URL ? [{ id: "glm-5.4-preview" }] : [{ id: "big-pickle" }],
    }),
  };
  try {
    assert.equal((await refreshOpenCodeCatalogStrict(base)).ok, true);
    const before = readFileSync(state.target, "utf8");
    const failed = await refreshOpenCodeCatalogStrict({
      ...base,
      fetchImpl: async (url) => url === OPENCODE_GO_MODELS_URL
        ? response({ error: "unavailable" }, 503)
        : response({ data: [{ id: "big-pickle" }] }),
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /strict.*failed/i);
    assert.equal(readFileSync(state.target, "utf8"), before);
    assert.equal(failed.providers.go.status, "error");
    assert.equal(failed.providers.zen.status, "ok");
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("a failed target rename leaves the existing snapshot untouched", () => {
  const state = testState();
  try {
    const original = { version: 1, generation: "old", fetchedAt: "old", providers: {}, models: [], quarantined: [] };
    persistOpenCodeLiveCatalog(original, { target: state.target, previousTarget: state.previous });
    const before = readFileSync(state.target, "utf8");
    const failingFs = {
      exists: existsSync,
      mkdir: mkdirSync,
      read: readFileSync,
      write: writeFileSync,
      chmod: chmodSync,
      protect: protectPrivateFile,
      unlink: unlinkSync,
      rename(source, target) {
        if (target === state.target) throw new Error("simulated rename failure");
        renameSync(source, target);
      },
    };
    assert.throws(
      () => persistOpenCodeLiveCatalog(
        { ...original, generation: "new" },
        { target: state.target, previousTarget: state.previous, fs: failingFs },
      ),
      /simulated rename failure/,
    );
    // Windows omits POSIX bits (mode reports 0666 there); the 0600 guarantee
    // is a POSIX contract, so the byte-for-byte restore stays universal and
    // the mode check runs where POSIX modes exist.
    if (process.platform !== "win32") {
      assert.equal(readFileSync(state.target, "utf8"), before);
      assert.equal(statSync(state.target).mode & 0o777, 0o600);
    }
    assert.equal(existsSync(`${state.target}.tmp.${process.pid}`), false);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("a successful live snapshot feeds the fresh registry and LiteLLM config", () => {
  const state = testState();
  const model = buildOpenCodeLiveModel("go", { id: "deepseek-flash" });
  const {
    autoSynced,
    liveSource,
    liveProtocol,
    liveUpstream,
    ...curated
  } = model;
  void autoSynced;
  void liveSource;
  void liveProtocol;
  void liveUpstream;
  Object.assign(curated, {
    slug: "opencode-go/deepseek-flash-curated",
    gatewayModel: "opencode-go-deepseek-flash-curated",
    displayName: "Curated DeepSeek Flash",
    description: "Operator-curated presentation",
    compHash: "opencode-go-deepseek-flash-curated-v1",
  });
  const snapshot = {
    version: 1,
    generation: "integration-generation",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    providers: {
      go: { status: "ok" },
      zen: { status: "ok" },
    },
    models: [model],
    quarantined: [],
    aliases: {},
  };
  try {
    persistOpenCodeLiveCatalog(snapshot, { target: state.target, previousTarget: state.previous });
    writeFileSync(
      path.join(state.directory, "user-models.json"),
      JSON.stringify({ version: 1, models: [curated] }),
    );
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `
        // Windows ESM imports need file:// URLs; plain absolute paths are
        // parsed as drive-letter schemes there.
        const registry = await import(${JSON.stringify(pathToFileURL(path.resolve("src/model-registry.mjs")).href)});
        const lite = await import(${JSON.stringify(pathToFileURL(path.resolve("src/litellm-config.mjs")).href)});
        const catalog = await import(${JSON.stringify(pathToFileURL(path.resolve("src/catalog.mjs")).href)});
        const model = registry.MODEL_BY_SLUG.get("opencode-go/deepseek-flash-curated");
        const merged = catalog.buildMergedCatalog(
          { models: [{ slug: "gpt-5.5", visibility: "list", base_instructions: "native", model_messages: {} }] },
          registry.LISTED_MODELS,
        );
        console.log(JSON.stringify({
          model: model && {
            provider: model.provider,
            gatewayModel: model.gatewayModel,
            autoSynced: model.autoSynced,
          },
          inLiteLlm: lite.renderLiteLlmConfig().includes(model.gatewayModel),
          inMergedCatalog: merged.some((entry) => entry.slug === model.slug),
          mergedDisplayName: merged.find((entry) => entry.slug === model.slug)?.display_name,
          canonicalAbsent: !registry.MODEL_BY_SLUG.has("opencode-go/deepseek-flash"),
        }));
      `],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: state.directory,
          MODEL_ROUTER_USER_MODELS: path.join(state.directory, "user-models.json"),
        },
      },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.model, {
      provider: "opencode-go",
      gatewayModel: curated.gatewayModel,
      autoSynced: true,
    });
    assert.equal(result.inLiteLlm, true);
    assert.equal(result.inMergedCatalog, true);
    assert.equal(result.mergedDisplayName, curated.displayName);
    assert.equal(result.canonicalAbsent, true);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
