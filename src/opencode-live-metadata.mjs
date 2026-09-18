import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

// This is generated state, not registry source. It deliberately lives beside
// the other router-owned state files and is never written under config/.
export const OPENCODE_LIVE_CATALOG_PATH =
  process.env.MODEL_ROUTER_OPENCODE_LIVE_CATALOG ||
  path.join(STATE_DIR, "opencode-live-catalog.json");
export const OPENCODE_LIVE_CATALOG_PREVIOUS_PATH =
  process.env.MODEL_ROUTER_OPENCODE_LIVE_CATALOG_PREVIOUS ||
  `${OPENCODE_LIVE_CATALOG_PATH}.previous`;

const ROUTE_DESCRIPTORS = Object.freeze({
  chat: Object.freeze({
    name: "Chat Completions",
    providerSuffix: "",
    providerProtocol: "openai",
    endpoint: "chat/completions",
  }),
  messages: Object.freeze({
    name: "Messages",
    providerSuffix: "-messages",
    providerProtocol: "anthropic",
    endpoint: "messages",
  }),
  responses: Object.freeze({
    name: "Responses",
    providerSuffix: "-responses",
    providerProtocol: "openai-responses",
    endpoint: "responses",
  }),
});

const GO_EXACT_ROUTES = Object.freeze({
  "grok-4.5": "responses",
  "grok-4.6": "responses",
  "gpt-5.6-luna": "responses",
  "muse-spark-1.2-contributor": "responses",
  "muse-spark-1.3-contributor": "responses",
  "minimax-m2.5": "messages",
  "minimax-m2.7": "messages",
  "minimax-m3": "messages",
  "qwen3.6-plus": "messages",
  "qwen3.7-max": "messages",
  "qwen3.7-plus": "messages",
  "qwen3.8-flash": "messages",
  "qwen3.8-max": "messages",
  // qwen3.5-plus is an older Go Chat Completions route; later Qwen ids in
  // the endpoint table moved to Messages, so it must stay an exact override
  // instead of inheriting the newer family rule below.
  "qwen3.5-plus": "chat",
  "union-alpha": "messages",
});

const ZEN_EXACT_ROUTES = Object.freeze({
  "big-pickle": "chat",
  "union-alpha": "messages",
  "muse-spark-1.2-contributor-free": "responses",
  "muse-spark-1.3-contributor-free": "responses",
  "x-preview-f-free": "chat",
  "deepseek-v4-flash-free": "chat",
  "hy3-free": "chat",
  "laguna-s-2.1-free": "chat",
  "mimo-v2.5-free": "chat",
  "ling-3.0-flash-fin-free": "chat",
  "nemotron-3-ultra-free": "chat",
  "nemotron-3.5-lightning-free": "chat",
});

// OpenCode publishes ids but not the protocol in /models. These family rules
// mirror the endpoint tables in OpenCode's Go and Zen documentation. They are
// intentionally narrower than "guess Chat for everything": a future id that
// does not belong to a documented family is quarantined until its endpoint is
// explicitly understood.
const GO_FAMILY_ROUTES = Object.freeze([
  { matches: (id) => id.startsWith("grok-"), route: "responses" },
  { matches: (id) => id.startsWith("gpt-"), route: "responses" },
  {
    matches: (id) => id.startsWith("muse-spark-") && id.endsWith("-contributor"),
    route: "responses",
  },
  { matches: (id) => id.startsWith("minimax-"), route: "messages" },
  { matches: (id) => id.startsWith("qwen"), route: "messages" },
  { matches: (id) => id.startsWith("deepseek-"), route: "chat" },
  { matches: (id) => id.startsWith("glm-"), route: "chat" },
  { matches: (id) => id === "hy3" || id.startsWith("hy4-"), route: "chat" },
  { matches: (id) => id.startsWith("kimi-"), route: "chat" },
  { matches: (id) => id.startsWith("longcat-"), route: "chat" },
  { matches: (id) => id.startsWith("mimo-"), route: "chat" },
]);

const ZEN_FAMILY_ROUTES = Object.freeze([
  { matches: (id) => id.startsWith("gpt-") || id.startsWith("grok-"), route: "responses" },
  { matches: (id) => id.startsWith("muse-spark-") && id.endsWith("-free"), route: "responses" },
  { matches: (id) => id.startsWith("claude-"), route: "messages" },
  { matches: (id) => id.startsWith("qwen"), route: "messages" },
  { matches: (id) => id.startsWith("union-alpha"), route: "messages" },
  {
    matches: (id) => /^(deepseek-|minimax-|glm-|kimi-|mimo-|ling-|nemotron-)/.test(id),
    route: "chat",
  },
]);

// These exact values are safe metadata overrides for routes already documented
// by OpenCode or already shipped by this repository. A live response normally
// contains no sizing/capability metadata, so every other model keeps the
// conservative defaults below.
const LIVE_METADATA_OVERRIDES = Object.freeze({
  "go/deepseek-v4-flash-vision-exp": Object.freeze({
    contextWindow: 1_048_576,
    autoCompact: 900_000,
    inputModalities: Object.freeze(["text", "image"]),
    reasoningLevels: Object.freeze(["low", "high", "max"]),
  }),
  "zen/muse-spark-1.3-contributor-free": Object.freeze({
    contextWindow: 1_048_576,
    autoCompact: 900_000,
    inputModalities: Object.freeze(["text", "image"]),
    reasoningLevels: Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
  }),
  "zen/union-alpha": Object.freeze({
    contextWindow: 262_144,
    autoCompact: 131_072,
    inputModalities: Object.freeze(["text", "image"]),
  }),
});

export const OPENCODE_ZEN_FREE_SPECIAL_IDS = Object.freeze([
  "big-pickle",
  "union-alpha",
]);

function familyName(family) {
  const value = String(family || "").trim();
  if (["go", "opencode-go"].includes(value)) return "go";
  if (["zen", "opencode-zen"].includes(value)) return "zen";
  return undefined;
}

function routeForName(name) {
  const descriptor = ROUTE_DESCRIPTORS[name];
  return descriptor ? { route: name, ...descriptor } : undefined;
}

/**
 * Resolve a live OpenCode model id to the provider variant that can carry it.
 * Undefined is a deliberate fail-closed answer, not a request to try Chat.
 */
export function resolveOpenCodeModelRoute(family, modelId) {
  const normalizedFamily = familyName(family);
  const id = String(modelId || "").trim();
  if (!normalizedFamily || !id) return undefined;

  const exact = normalizedFamily === "go" ? GO_EXACT_ROUTES : ZEN_EXACT_ROUTES;
  const familyRoutes = normalizedFamily === "go" ? GO_FAMILY_ROUTES : ZEN_FAMILY_ROUTES;
  const routeName = exact[id] || familyRoutes.find(({ matches }) => matches(id))?.route;
  if (!routeName) return undefined;

  const route = routeForName(routeName);
  return {
    ...route,
    providerId: `opencode-${normalizedFamily}${route.providerSuffix}`,
    family: normalizedFamily,
    upstreamModel: id,
  };
}

/**
 * Zen is intentionally allowlisted by naming policy. The endpoint's bare id
 * list is not enough evidence that a model is free, so paid ids are rejected
 * even when they have a known protocol route.
 */
export function isOpenCodeZenFreeModel(modelId) {
  const id = String(modelId || "").trim();
  return Boolean(
    id &&
    (id.endsWith("-free") || OPENCODE_ZEN_FREE_SPECIAL_IDS.includes(id)),
  );
}

function advertisedContext(item) {
  for (const value of [
    item?.context_length,
    item?.context_window,
    item?.top_provider?.context_length,
  ]) {
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function prettyModelId(id) {
  return id
    .replaceAll("_", "-")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function gatewaySafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function metadataFor(family, id, item, route) {
  const override = LIVE_METADATA_OVERRIDES[`${family}/${id}`] || {};
  const contextWindow =
    override.contextWindow || advertisedContext(item) || 131_072;
  const autoCompact = Math.min(
    override.autoCompact || 110_000,
    contextWindow,
  );
  const reasoningLevels = override.reasoningLevels || ["high"];
  const inputModalities = override.inputModalities || ["text"];
  return {
    contextWindow,
    autoCompact,
    reasoningLevels: reasoningLevels.map((effort) => ({
      effort,
      description: effort === "high" ? "Deep reasoning" : `${effort} reasoning`,
    })),
    defaultEffort: reasoningLevels.includes("high") ? "high" : reasoningLevels[0],
    inputModalities: [...inputModalities],
    displayName: `${prettyModelId(id)} (OpenCode ${family === "go" ? "Go" : "Zen"})`,
    description:
      `${prettyModelId(id)} through OpenCode ${family === "go" ? "Go" : "Zen"} using the ` +
      `${route.name} API route. The model is live-listed and uses conservative ` +
      "router metadata when OpenCode does not publish sizing or capability details.",
  };
}

/** Build a registry-shaped, generated model definition from one live id. */
export function buildOpenCodeLiveModel(family, itemOrId, route = undefined) {
  const item = typeof itemOrId === "string" ? { id: itemOrId } : itemOrId || {};
  const id = String(item.id || "").trim();
  const resolved = route || resolveOpenCodeModelRoute(family, id);
  if (!id || !resolved) return undefined;
  const metadata = metadataFor(resolved.family, id, item, resolved);
  const gatewayModel = `${gatewaySafe(resolved.providerId)}-${gatewaySafe(id)}`;
  return {
    slug: `${resolved.providerId}/${id}`,
    gatewayModel,
    upstreamModel: id,
    provider: resolved.providerId,
    listed: true,
    ...metadata,
    priority: 1_000,
    compHash: `${gatewayModel}-live-v1`,
    ...(resolved.family === "zen" ? { isFree: true } : {}),
    // Registry/catalog consumers use this marker to distinguish generated
    // routes from checked-in and user-curated routes. It does not grant any
    // native collaboration capability.
    autoSynced: true,
    liveSource: `opencode-${resolved.family}`,
    liveProtocol: resolved.route,
    liveUpstream: id,
  };
}

function emptyCatalog() {
  return {
    version: 1,
    generation: null,
    fetchedAt: null,
    providers: {},
    models: [],
    quarantined: [],
    aliases: {},
  };
}

/** Read the last successful live snapshot; malformed state is ignored. */
export function readOpenCodeLiveCatalog({ target = OPENCODE_LIVE_CATALOG_PATH } = {}) {
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.models) ||
      !Array.isArray(parsed.quarantined) ||
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) return null;
    return {
      ...emptyCatalog(),
      ...parsed,
      aliases:
        parsed.aliases && typeof parsed.aliases === "object" && !Array.isArray(parsed.aliases)
          ? parsed.aliases
          : {},
    };
  } catch {
    return null;
  }
}

function defaultFs() {
  return {
    exists: existsSync,
    mkdir: mkdirSync,
    read: readFileSync,
    rename: renameSync,
    unlink: unlinkSync,
    write: writeFileSync,
    chmod: chmodSync,
    protect: protectPrivateFile,
  };
}

function atomicWrite(target, contents, fs) {
  fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmod(path.dirname(target), 0o700);
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    fs.write(temporary, contents, { encoding: "utf8", mode: 0o600 });
    fs.chmod(temporary, 0o600);
    fs.protect(temporary);
    fs.rename(temporary, target);
    fs.chmod(target, 0o600);
    fs.protect(target);
  } catch (error) {
    if (fs.exists(temporary)) fs.unlink(temporary);
    throw error;
  }
}

/**
 * Persist one complete snapshot and retain the prior successful snapshot.
 * A failed temporary write or rename leaves the target byte-for-byte intact.
 */
export function persistOpenCodeLiveCatalog(
  snapshot,
  {
    target = OPENCODE_LIVE_CATALOG_PATH,
    previousTarget = OPENCODE_LIVE_CATALOG_PREVIOUS_PATH,
    fs = defaultFs(),
  } = {},
) {
  const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
  const previousContents = fs.exists(target) ? fs.read(target, "utf8") : undefined;
  if (previousContents !== undefined && previousTarget !== target) {
    atomicWrite(previousTarget, previousContents, fs);
  }
  atomicWrite(target, contents, fs);
  return {
    path: target,
    previousPath: previousTarget,
    previousRetained: previousContents !== undefined,
  };
}
