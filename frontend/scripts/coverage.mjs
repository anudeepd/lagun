import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import coverage from "istanbul-lib-coverage";
import report from "istanbul-lib-report";
import reports from "istanbul-reports";

const { createCoverageMap } = coverage;
const { createContext } = report;

const frontendRoot = process.cwd();
const repoRoot = path.resolve(frontendRoot, "..");
const outputRoot = path.join(repoRoot, "coverage", "frontend");
const vitest = path.join(frontendRoot, "node_modules", ".bin", "vitest");

const coreUi = [
  "src/components/ui/CommandPalette.tsx",
  "src/components/ui/Input.tsx",
  "src/components/ui/LimitSelect.tsx",
  "src/components/ui/Modal.tsx",
  "src/components/ui/Select.tsx",
  "src/components/ui/ToastViewport.tsx",
  "src/components/ui/Tooltip.tsx",
  "src/components/ui/useToastQueue.ts",
];
const extraUi = [
  "src/components/ui/AuthRedirectOverlay.tsx",
  "src/components/ui/Button.tsx",
  "src/components/ui/ConfirmDialog.tsx",
  "src/components/ui/Label.tsx",
  "src/components/ui/Logo.tsx",
  "src/components/ui/Progress.tsx",
  "src/components/ui/RefreshIcon.tsx",
  "src/components/ui/ShortcutHelpDialog.tsx",
  "src/components/ui/Spinner.tsx",
  "src/components/ui/TransitionVeil.tsx",
];
const coreUtils = [
  "src/utils/clipboard.ts",
  "src/utils/focusModality.ts",
  "src/utils/platform.ts",
  "src/utils/rowIdentity.ts",
  "src/utils/scrollbarFallback.ts",
];
const extraUtils = [
  "src/constants/sql.ts",
  "src/utils/clampToViewport.ts",
  "src/utils/formatRows.ts",
  "src/utils/keyboard.ts",
  "src/utils/shortcuts.ts",
  "src/utils/toast.ts",
];
const isolatedAuthUtils = [
  "src/utils/authIdleTimer.ts",
  "src/utils/authRedirect.ts",
  "src/utils/filterHistory.ts",
  "src/utils/randomId.ts",
];

const clusters = [
  {
    name: "editor",
    tests: [
      "src/__tests__/coverage-editor",
      "src/__tests__/components/bulkExecute.test.tsx",
      "src/__tests__/components/GridContextMenu.clamp.test.tsx",
      "src/__tests__/components/GridSearchBar.test.tsx",
      "src/__tests__/components/QueryEditor.autocomplete.test.ts",
      "src/__tests__/components/QueryErrorState.test.tsx",
      "src/__tests__/components/ResultGrid.cellEditorStyle.test.tsx",
      "src/__tests__/components/ResultGrid.inlineEditor.test.ts",
      "src/__tests__/components/ResultGrid.search.test.tsx",
      "src/__tests__/components/ResultGrid.selectionCell.test.tsx",
      "src/__tests__/components/TabContent.handlers.test.tsx",
      "src/__tests__/components/TabContent.optimistic.test.ts",
    ],
    include: ["src/components/editor/**"],
  },
  {
    name: "layout",
    tests: ["src/__tests__/coverage-layout"],
    include: [
      "src/components/layout/**",
      "src/components/schema/**",
      "src/components/sessions/**",
    ],
  },
  {
    name: "table",
    tests: ["src/__tests__/coverage-table"],
    include: [
      "src/components/table/**",
      "src/components/admin/**",
    ],
  },
  {
    name: "presence",
    tests: ["src/__tests__/coverage-table/PresenceReporter.test.tsx"],
    include: ["src/components/presence/**"],
  },
  {
    name: "core",
    tests: [
      "src/__tests__/coverage-core",
      "src/api/client.errors.test.ts",
      "src/api/client.test.ts",
      "src/__tests__/components/CommandPalette.test.tsx",
      "src/__tests__/components/LimitSelect.test.tsx",
      "src/__tests__/components/MenuKeyboard.tab.test.tsx",
      "src/__tests__/components/Modal.test.tsx",
      "src/__tests__/components/Select.test.tsx",
      "src/__tests__/components/ToastViewport.test.tsx",
      "src/__tests__/components/Tooltip.test.tsx",
      "src/__tests__/components/useToastQueue.test.ts",
      "src/__tests__/components/clipboard.test.ts",
      "src/__tests__/store/schemaStore.test.ts",
      "src/__tests__/store/sessionStore.test.ts",
      "src/__tests__/utils/authIdleTimer.test.ts",
      "src/__tests__/utils/authRedirect.test.ts",
      "src/__tests__/utils/filterHistory.test.ts",
      "src/__tests__/utils/randomId.test.ts",
      "src/__tests__/utils/scrollbarFallback.test.ts",
    ],
    include: [
      "src/api/**",
      "src/hooks/**",
      "src/motion/**",
      "src/store/**",
      "src/App.tsx",
      "src/main.tsx",
      ...coreUi,
      ...coreUtils,
    ],
  },
  {
    name: "utils-auth",
    tests: [
      "src/__tests__/coverage-core/authRedirect.extra.test.ts",
      "src/__tests__/coverage-core/utils-core.test.ts",
      "src/utils/authIdleTimer.test.ts",
      "src/utils/authRedirect.test.ts",
      "src/utils/filterHistory.test.ts",
      "src/utils/randomId.test.ts",
    ],
    include: isolatedAuthUtils,
  },
  {
    name: "ui-extra",
    tests: [
      "src/__tests__/components",
      "src/__tests__/utils",
      "src/__tests__/coverage-unassigned",
    ],
    include: [...extraUi, ...extraUtils],
  },
];

function normalizePaths(data) {
  const normalized = {};
  for (const [key, fileCoverage] of Object.entries(data)) {
    const rawPath = String(fileCoverage.path || key).replaceAll("\\", "/");
    const sourceIndex = rawPath.indexOf("frontend/src/");
    if (sourceIndex < 0) continue;
    const relativePath = rawPath.slice(sourceIndex);
    normalized[relativePath] = { ...fileCoverage, path: relativePath };
  }
  return normalized;
}

function listRuntimeSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...listRuntimeSources(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    if (entry.endsWith(".d.ts")) continue;
    const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
    if (relative === "frontend/src/types/index.ts") continue;
    files.push(relative);
  }
  return files;
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const merged = createCoverageMap({});
for (const cluster of clusters) {
  const clusterOutput = path.join(outputRoot, "clusters", cluster.name);
  const args = [
    "run",
    ...cluster.tests,
    "--coverage",
    "--coverage.provider=v8",
    ...cluster.include.map((pattern) => `--coverage.include=${pattern}`),
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${clusterOutput}`,
    "--fileParallelism=false",
    "--silent",
  ];
  const result = spawnSync(vitest, args, {
    cwd: frontendRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cluster.name} tests or coverage collection failed`);
  }

  const reportPath = path.join(clusterOutput, "coverage-final.json");
  if (!existsSync(reportPath)) {
    throw new Error(`${cluster.name} did not emit ${reportPath}`);
  }
  merged.merge(normalizePaths(JSON.parse(readFileSync(reportPath, "utf8"))));
}

const expected = listRuntimeSources(path.join(frontendRoot, "src"));
const missing = expected.filter((file) => !merged.files().includes(file));
const failures = merged
  .files()
  .map((file) => {
    const summary = merged.fileCoverageFor(file).toSummary().toJSON();
    return {
      file,
      lineMiss: summary.lines.total - summary.lines.covered,
      branchMiss: summary.branches.total - summary.branches.covered,
    };
  })
  .filter(({ lineMiss, branchMiss }) => lineMiss > 0 || branchMiss > 0)
  .sort(
    (left, right) =>
      right.lineMiss - left.lineMiss ||
      right.branchMiss - left.branchMiss ||
      left.file.localeCompare(right.file),
  );

const context = createContext({ dir: outputRoot, coverageMap: merged });
reports.create("lcovonly", { file: "lcov.info" }).execute(context);
reports.create("text-summary").execute(context);
writeFileSync(
  path.join(outputRoot, "coverage-final.json"),
  JSON.stringify(merged.toJSON(), null, 2),
);

if (missing.length) {
  console.error(`Frontend sources missing from coverage: ${missing.join(", ")}`);
}
if (failures.length) {
  console.error("Frontend coverage is below 100%:");
  for (const failure of failures) {
    console.error(
      `- ${failure.file}: ${failure.lineMiss} lines and ${failure.branchMiss} branches uncovered`,
    );
  }
}
if (missing.length || failures.length) process.exitCode = 1;
