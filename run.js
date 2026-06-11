#!/usr/bin/env node
/**
 * Friendly GapFinder orchestrator menu.
 * Wraps scripts/run-gapfinder.js so users do not need to remember CLI flags.
 */

const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { loadDotEnv, parseAuditInput } = require("./scripts/audit-utils");

const ROOT = __dirname;
loadDotEnv(ROOT);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function yes(answer) {
  return /^(y|yes)$/i.test(answer || "");
}

function runPipeline(args) {
  const res = spawnSync("node", ["scripts/run-gapfinder.js", ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  process.exit(res.status || 0);
}

async function main() {
  console.log("\nGapFinder v2\n");
  console.log("1. Standard audit");
  console.log("2. Audit with attribution probe");
  console.log("3. Full PSI audit");
  console.log("4. Region-scoped audit");
  console.log("5. Force re-run audit");
  console.log("6. Exit\n");

  const choice = await ask("Choose an option [1]: ");
  if (choice === "6") {
    rl.close();
    return;
  }

  const url = await ask("Website URL or domain: ");
  const audit = parseAuditInput(url);
  if (!audit) {
    console.error("Invalid URL/domain.");
    rl.close();
    process.exit(1);
  }

  const args = [url];

  if (choice === "2") args.push("--probe");
  if (choice === "3") args.push("--full");
  if (choice === "5") args.push("--force");

  if (choice === "4" || audit.scopePath) {
    console.log("\nDetected audit target:");
    console.log(`- Host: ${audit.host}`);
    console.log(`- Region path: ${audit.scopePath || "none"}`);

    if (audit.scopePath) {
      const useScope = await ask("Use this region path as the audit scope? [Y/n]: ");
      if (!useScope || yes(useScope)) {
        const strict = await ask("Strictly block global fallback pages? [y/N]: ");
        args.push(strict && yes(strict) ? "--scope-strict" : "--scope-mode=soft");
      } else {
        args.push("--global");
      }
    } else if (choice === "4") {
      const scope = await ask("Enter region path (example: /au): ");
      if (scope) args.push("--scope-path", scope, "--scope-mode=soft");
    }
  }

  const addManual = await ask("Add known category/PDP URL overrides? [y/N]: ");
  if (yes(addManual)) {
    const category = await ask("Known category/collection URL (blank to skip): ");
    if (category) args.push("--category", category);

    const pdp = await ask("Known product/PDP URL (blank to skip): ");
    if (pdp) args.push("--pdp", pdp);
  }

  if (choice !== "3") {
    const full = await ask("Run full PSI on home + category + PDP? [y/N]: ");
    if (yes(full)) args.push("--full");
  }

  if (choice !== "2") {
    const probe = await ask("Run attribution probe mode? [y/N]: ");
    if (yes(probe)) args.push("--probe");
  }

  if (choice !== "5") {
    const force = await ask("Force recapture/rebuild? [y/N]: ");
    if (yes(force)) args.push("--force");
  }

  rl.close();
  console.log(`\nRunning: node scripts/run-gapfinder.js ${args.join(" ")}\n`);
  runPipeline(args);
}

main();
