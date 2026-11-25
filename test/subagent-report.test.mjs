import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reportPath = fileURLToPath(
  new URL("../.claude/skills/codex-subagents/subagent-report.mjs", import.meta.url),
);

test("subagent report shows the configured effort for the exact published route", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "subagent-report-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const route = "opencode-go/deepseek-v4.1-flash";
  const otherRoute = "deepseek/deepseek-v4.1-flash";
  const unselectedRoute = "opencode-go/glm-5.2";

  writeFileSync(
    join(stateDir, "multi-agent-settings.json"),
    JSON.stringify({ mode: "selected", efforts: { [route]: "max", [unselectedRoute]: "high" } }),
  );
  writeFileSync(
    join(stateDir, "merged-models.json"),
    JSON.stringify({
      models: [
        { slug: otherRoute, priority: 30, multi_agent_version: "v2" },
        { slug: route, priority: 15, multi_agent_version: "v2" },
        { slug: unselectedRoute, priority: 5, multi_agent_version: "v1" },
      ],
    }),
  );

  const report = execFileSync(process.execPath, [reportPath], {
    encoding: "utf8",
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
  });
  assert.match(report, /3 models, 2 published as v2/);
  const rows = report.split("\n").filter((line) => /^\s*\d+\. prio\s+\d/.test(line));
  assert.deepEqual(
    rows.map((line) => line.trim().replace(/\s+/g, " ")),
    [
      `1. prio 15 ${route} [configured effort max]`,
      `2. prio 30 ${otherRoute}`,
    ],
  );
});
