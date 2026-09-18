import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import {
  buildOpenCodeLiveModel,
  isOpenCodeZenFreeModel,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
  persistOpenCodeLiveCatalog,
  readOpenCodeLiveCatalog,
  resolveOpenCodeModelRoute,
} from "./opencode-live-metadata.mjs";
import {
  applyOpenCodeSessionHeaders,
  OPENCODE_SESSION_FALLBACKS,
} from "./opencode-session.mjs";
import { VERSION } from "./version.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";

const SELF = fileURLToPath(import.meta.url);
const FETCH_TIMEOUT_MS = 30_000;

function errorText(error, secret) {
  const raw = error instanceof Error ? error.message : String(error);
  return secret && raw.includes(secret) ? raw.replaceAll(secret, "<redacted>") : raw;
}

function providerStatus({ endpoint, state, advertised = 0, published = 0, quarantined = 0, fetchedAt }) {
  return {
    endpoint,
    status: state,
    ...(fetchedAt ? { fetchedAt } : {}),
    advertised,
    published,
    quarantined,
  };
}

function invalidResult(message, providers = {}) {
  return {
    ok: false,
    strict: true,
    error: message,
    providers,
    models: [],
    quarantined: [],
    generation: null,
    fetchedAt: null,
  };
}

function responseStatus(response) {
  const status = Number(response?.status);
  if (Number.isInteger(status) && status > 0) return status;
  return response?.ok === true ? 200 : 0;
}

function payloadItems(payload) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data)) {
    throw new Error("The OpenCode model endpoint returned an invalid model list.");
  }
  return data;
}

function requestHeaders(provider, credential) {
  const headers = {
    Accept: "application/json",
    "User-Agent": `codex-router/${VERSION}`,
    Authorization: `Bearer ${credential.value}`,
  };
  applyOpenCodeSessionHeaders(headers, {
    provider,
    fallback: OPENCODE_SESSION_FALLBACKS.discovery,
  });
  return headers;
}

async function fetchProviderModels({
  family,
  provider,
  credential,
  endpoint,
  fetchImpl,
  secret,
}) {
  try {
    const signal = typeof AbortSignal?.timeout === "function"
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: requestHeaders(provider, credential),
      ...(signal ? { signal } : {}),
    });
    const status = responseStatus(response);
    if (!(status >= 200 && status < 300)) {
      // Do not copy provider response bodies into the result: they can contain
      // account or credential material and status is sufficient for launch UI.
      throw new Error(`OpenCode ${family} model endpoint returned HTTP ${status || "unknown"}.`);
    }
    const payload = await response.json();
    return { ok: true, items: payloadItems(payload) };
  } catch (error) {
    return { ok: false, error: errorText(error, secret) };
  }
}

function modelId(item) {
  const id = typeof item?.id === "string" ? item.id.trim() : "";
  return id || undefined;
}

function previousAliases(previous, models) {
  const current = new Map(
    models.map((model) => [
      `${model.liveSource || ""}\0${model.upstreamModel || ""}`,
      model.slug,
    ]),
  );
  const aliases = {};
  for (const model of previous?.models || []) {
    const key = `${model?.liveSource || ""}\0${model?.upstreamModel || ""}`;
    const target = current.get(key);
    if (
      typeof model?.slug === "string" &&
      typeof target === "string" &&
      model.slug &&
      model.slug !== target
    ) {
      aliases[model.slug] = target;
    }
  }
  return Object.fromEntries(
    Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function classifyModels(family, items) {
  const models = [];
  const quarantined = [];
  const seen = new Set();

  for (const item of items) {
    const id = modelId(item);
    if (!id) {
      quarantined.push({
        provider: `opencode-${family}`,
        id: null,
        reason: "invalid-model-record",
      });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    if (family === "zen" && !isOpenCodeZenFreeModel(id)) {
      quarantined.push({
        provider: "opencode-zen",
        id,
        reason: "paid-zen-model",
      });
      continue;
    }

    const route = resolveOpenCodeModelRoute(family, id);
    if (!route) {
      quarantined.push({
        provider: `opencode-${family}`,
        id,
        reason: "unknown-protocol",
      });
      continue;
    }
    models.push(buildOpenCodeLiveModel(family, item, route));
  }

  models.sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  quarantined.sort((left, right) =>
    String(left.provider).localeCompare(String(right.provider)) ||
    String(left.id).localeCompare(String(right.id)) ||
    String(left.reason).localeCompare(String(right.reason)),
  );
  return { models, quarantined };
}

function configuredProviders(providers) {
  return {
    go: providers.get("opencode-go"),
    zen: providers.get("opencode-zen"),
  };
}

async function refreshUnlocked({
  fetchImpl = globalThis.fetch,
  providers = PROVIDERS,
  credentialResolver = resolveProviderCredential,
  persist = persistOpenCodeLiveCatalog,
  readPrevious = readOpenCodeLiveCatalog,
  now = () => new Date(),
  endpoints = {
    go: OPENCODE_GO_MODELS_URL,
    zen: OPENCODE_ZEN_MODELS_URL,
  },
} = {}) {
  if (typeof fetchImpl !== "function") {
    return invalidResult("No fetch implementation is available for the OpenCode model endpoints.");
  }

  const { go, zen } = configuredProviders(providers);
  if (!go || !zen) {
    return invalidResult(
      "The registry must define opencode-go and opencode-zen before live synchronization can run.",
      {
        go: providerStatus({ endpoint: endpoints.go, state: "missing-provider" }),
        zen: providerStatus({ endpoint: endpoints.zen, state: "missing-provider" }),
      },
    );
  }

  let credential;
  try {
    credential = credentialResolver(go);
  } catch (error) {
    return invalidResult(`Could not resolve the OpenCode credential: ${errorText(error)}`);
  }
  if (!credential?.value) {
    const providersStatus = {
      go: providerStatus({ endpoint: endpoints.go, state: "missing-credential" }),
      zen: providerStatus({ endpoint: endpoints.zen, state: "missing-credential" }),
    };
    return invalidResult("No persistent OpenCode API key is configured.", providersStatus);
  }

  const secret = String(credential.value);
  // Both requests are deliberately started before either result is inspected.
  // Strict refresh must observe one live generation of both catalogs and must
  // never fall back to the existing 24-hour discovery cache.
  const [goResult, zenResult] = await Promise.all([
    fetchProviderModels({
      family: "Go",
      provider: go,
      credential,
      endpoint: endpoints.go,
      fetchImpl,
      secret,
    }),
    fetchProviderModels({
      family: "Zen",
      provider: zen,
      credential,
      endpoint: endpoints.zen,
      fetchImpl,
      secret,
    }),
  ]);

  const providerResults = { go: goResult, zen: zenResult };
  const statuses = {
    go: providerStatus({
      endpoint: endpoints.go,
      state: goResult.ok ? "ok" : "error",
      advertised: goResult.ok ? goResult.items.length : 0,
    }),
    zen: providerStatus({
      endpoint: endpoints.zen,
      state: zenResult.ok ? "ok" : "error",
      advertised: zenResult.ok ? zenResult.items.length : 0,
    }),
  };
  if (!goResult.ok || !zenResult.ok) {
    const failures = Object.entries(providerResults)
      .filter(([, result]) => !result.ok)
      .map(([name, result]) => `${name}: ${result.error}`)
      .join("; ");
    return invalidResult(`Strict OpenCode live refresh failed (${failures}).`, statuses);
  }

  const goClassified = classifyModels("go", goResult.items);
  const zenClassified = classifyModels("zen", zenResult.items);
  const models = [...goClassified.models, ...zenClassified.models]
    .filter(Boolean)
    .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  const quarantined = [...goClassified.quarantined, ...zenClassified.quarantined]
    .sort((left, right) =>
      String(left.provider).localeCompare(String(right.provider)) ||
      String(left.id).localeCompare(String(right.id)) ||
      String(left.reason).localeCompare(String(right.reason)),
    );
  const fetchedAt = now().toISOString();
  const previous = readPrevious();
  const snapshot = {
    version: 1,
    generation: randomUUID(),
    fetchedAt,
    providers: {
      go: {
        ...statuses.go,
        fetchedAt,
        published: goClassified.models.length,
        quarantined: goClassified.quarantined.length,
      },
      zen: {
        ...statuses.zen,
        fetchedAt,
        published: zenClassified.models.length,
        quarantined: zenClassified.quarantined.length,
      },
    },
    models,
    quarantined,
    aliases: previousAliases(previous, models),
  };

  try {
    const persisted = persist(snapshot);
    return {
      ok: true,
      strict: true,
      generation: snapshot.generation,
      fetchedAt,
      providers: snapshot.providers,
      models: snapshot.models,
      quarantined: snapshot.quarantined,
      aliases: snapshot.aliases,
      persisted,
    };
  } catch (error) {
    return {
      ok: false,
      strict: true,
      error: `Could not persist the OpenCode live catalog: ${errorText(error)}`,
      providers: snapshot.providers,
      models: [],
      quarantined: snapshot.quarantined,
      generation: null,
      fetchedAt: null,
    };
  }
}

/**
 * Launcher contract: fetch both OpenCode catalogs and publish one complete
 * generation, returning JSON-safe success/failure instead of throwing.
 *
 * `lock: false` is intended only for isolated tests. Production callers use
 * the shared model-overlay lock so a catalog refresh cannot race curation or
 * another publisher.
 */
export async function refreshOpenCodeCatalogStrict(options = {}) {
  const operation = () => refreshUnlocked(options);
  try {
    return options.lock === false
      ? await operation()
      : await withModelOverlayLock(operation);
  } catch (error) {
    return invalidResult(`Strict OpenCode live refresh could not start: ${errorText(error)}`);
  }
}

export const refreshOpenCodeCatalog = refreshOpenCodeCatalogStrict;

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      `Usage: node ${path.basename(SELF)} [--strict]\n\n` +
      "Fetches the current OpenCode Go and Zen /models catalogs in parallel. " +
      "The command is strict: a failed endpoint does not replace the last snapshot.\n",
    );
    return;
  }
  const result = await refreshOpenCodeCatalogStrict();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  await main();
}
