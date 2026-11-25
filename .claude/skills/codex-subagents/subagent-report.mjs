#!/usr/bin/env node
// Readiness report for Codex subagent spawning.
//
// Inspect the published v2 routes and their configured effort overrides.
// `control subagents status` describes the operator's settings. Codex reads
// the merged catalog at startup, so an old catalog or cached session can
// still advertise a different list.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const STATE_DIR =
  process.env.MODEL_ROUTER_STATE_DIR ||
  path.join(process.env.HOME || "", ".codex", "codex-router");

const CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
const SETTINGS_PATH = path.join(STATE_DIR, "multi-agent-settings.json");

// Codex advertises only a small priority-ordered subset of spawn-model
// overrides. The exact cut is the client's, not ours, so this is a reporting
// threshold for "you are probably past what Codex will show", not a promise.
const LIKELY_VISIBLE = 8;

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const bad = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (!existsSync(CATALOG_PATH)) {
  bad(
    `No merged catalog at ${CATALOG_PATH}.\n` +
      "Run ./bin/model-router codex doctor first, or reinstall — the router has not built a catalog yet.",
  );
}

const catalog = json(CATALOG_PATH);
const models = Array.isArray(catalog) ? catalog : catalog.models || [];

// The registry uses camelCase; the merged catalog is Codex's wire format and
// uses snake_case. Reading the wrong one reports zero capable models on a
// perfectly healthy install, which looks exactly like a real fault.
const capable = models
  .filter((model) => model.multi_agent_version === "v2")
  .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

const settings = existsSync(SETTINGS_PATH)
  ? json(SETTINGS_PATH)
  : { mode: "proven", enabled: [], disabled: [] };

const out = [];
out.push(`Mode:     ${settings.mode}`);
out.push(`Catalog:  ${models.length} models, ${capable.length} published as v2`);
if (settings.disabled?.length) {
  out.push(`Disabled: ${settings.disabled.length} model(s) held back by an explicit off`);
}
out.push("");

if (capable.length === 0) {
  out.push("No v2 routes in the merged catalog.");
  out.push("");
  out.push("  Most likely: the catalog predates your settings. Rebuild it:");
  out.push("    node src/catalog.mjs");
  out.push("  Then fully quit and reopen Codex.");
} else {
  out.push("Published v2 routes in catalog priority order:");
  out.push("");
  capable.forEach((model, index) => {
    const rank = String(index + 1).padStart(2);
    const priority = String(model.priority ?? "-").padStart(4);
    const hidden = model.visibility === "hide" ? "  [hidden in picker]" : "";
    const effort = settings.efforts?.[model.slug];
    const effortLabel = typeof effort === "string" && effort ? `  [configured effort ${effort}]` : "";
    const marker = index === LIKELY_VISIBLE ? "  <- Codex likely stops advertising here" : "";
    out.push(`  ${rank}. prio ${priority}  ${model.slug}${effortLabel}${hidden}${marker}`);
  });
  if (capable.length > LIKELY_VISIBLE) {
    out.push("");
    out.push(
      `  ${capable.length} models carry v2, but Codex advertises only a small priority-ordered`,
    );
    out.push("  subset. To bring routed models forward, change the picker order:");
    out.push("    ./bin/model-router codex picker-order routed-first");
    out.push("  To remove an individual route from the list:");
    out.push("    ./bin/control subagents set <slug> off");
  }
}

// A catalog older than the settings that shape it is the single most common
// reason a subagent change appears to do nothing.
if (existsSync(SETTINGS_PATH)) {
  const settingsAge = statSync(SETTINGS_PATH).mtimeMs;
  const catalogAge = statSync(CATALOG_PATH).mtimeMs;
  if (settingsAge > catalogAge) {
    out.push("");
    out.push("STALE: subagent settings changed after the catalog was built.");
    out.push("  Codex is reading an older list than the one you configured. Rebuild:");
    out.push("    node src/catalog.mjs");
    out.push("  Then fully quit and reopen Codex.");
  }
}

process.stdout.write(`${out.join("\n")}\n`);
