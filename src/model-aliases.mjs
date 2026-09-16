// Model slugs are part of Codex's persisted settings, so removing a model
// from the checked-in registry must not turn an already-selected model into
// native ChatGPT traffic. Keep compatibility aliases separate from the
// registry: they are accepted by the request path, but only the canonical
// Responses model is published for new picker selections.
const LEGACY_MODEL_ALIASES = Object.freeze({
  "opencode-go/muse-spark-1.2-contributor":
    "opencode-go-responses/muse-spark-1.2-contributor",
  "opencode-go/muse-spark-1.3-contributor":
    "opencode-go-responses/muse-spark-1.3-contributor",
});

export function routedModelAlias(slug) {
  const value = String(slug || "");
  return LEGACY_MODEL_ALIASES[value] || value;
}

export function hasRoutedModelAlias(slug) {
  const value = String(slug || "");
  return Object.prototype.hasOwnProperty.call(LEGACY_MODEL_ALIASES, value);
}
