/**
 * run-gapfinder.js
 *
 * Holistic runner: crawl → har → phase1 inventory → PSI → scorecard → DOCX/PDF
 *
 * Usage:
 *   node scripts/run-gapfinder.js latexmattress.com.au
 *   node scripts/run-gapfinder.js latexmattress.com.au --probe
 *   node scripts/run-gapfinder.js latexmattress.com.au --force
 *   node scripts/run-gapfinder.js https://example.com/au --scope-mode=soft
 *   node scripts/run-gapfinder.js https://example.com/au --scope-strict --full
 *
 * Notes:
 * - Each underlying script handles its own idempotent skip behaviour (where implemented).
 * - PSI requires PAGESPEED_API_KEY or PSI_API_KEY, either in .env or the shell environment.
 */

const path = require("path");
const { spawnSync } = require("child_process");
const { loadDotEnv } = require("./audit-utils");

const ROOT = path.resolve(__dirname, "..");

loadDotEnv(ROOT);

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: true });
  if (res.status !== 0) process.exit(res.status || 1);
}

function findPython() {
  for (const cmd of ["python3", "python"]) {
    const res = spawnSync(cmd, ["--version"], { cwd: ROOT, shell: true, stdio: "ignore" });
    if (res.status === 0) return cmd;
  }
  console.error("Unable to find python3 or python on PATH. Install Python 3.10+ and try again.");
  process.exit(1);
}

function passthroughArgs(flags) {
  const pass = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (
      flag === "--global" ||
      flag === "--scope-strict" ||
      flag.startsWith("--scope-mode=") ||
      flag.startsWith("--scope-path=") ||
      flag.startsWith("--home=") ||
      flag.startsWith("--category=") ||
      flag.startsWith("--pdp=") ||
      flag.startsWith("--privacy=") ||
      flag.startsWith("--blog=") ||
      flag === "--no-pdf" ||
      flag === "--require-pdf"
    ) {
      pass.push(flag);
      continue;
    }

    if ((flag === "--scope-mode" || flag === "--scope-path" || flag === "--home" || flag === "--category" || flag === "--pdp" || flag === "--privacy" || flag === "--blog") && flags[i + 1]) {
      pass.push(flag, flags[i + 1]);
      i++;
    }
  }
  return pass;
}

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: node scripts/run-gapfinder.js <domain-or-url> [--probe] [--force] [--full] [--scope-path /au] [--scope-mode soft|strict] [--global] [--no-pdf]");
  process.exit(1);
}

const flags = process.argv.slice(3);
const hasProbe = flags.includes("--probe");
const hasForce = flags.includes("--force");
const hasFull = flags.includes("--full");
const passthrough = passthroughArgs(flags);
const pythonCmd = findPython();

// 1) crawl URLs
run("node", ["scripts/domain-crawl-to-urls.js", domain, ...(hasProbe ? ["--probe"] : []), ...(hasForce ? ["--force"] : []), ...passthrough]);

// 2) capture HARs
run("node", ["scripts/har-capture.js", domain, ...(hasProbe ? ["--probe"] : []), ...(hasForce ? ["--force"] : []), ...passthrough]);

// 3) build phase1 inventory (xlsx + unknown vendors, etc.)
run("node", ["scripts/phase1-tag-inventory.js", domain, ...(hasProbe ? ["--probe"] : []), ...(hasForce ? ["--force"] : []), ...passthrough]);

// 4) fetch PSI (writes data/<audit-key>/analysis/psi.json)
run("node", ["scripts/psi-fetch.js", domain, ...(hasFull ? ["--full"] : []), ...passthrough]);

// 5) scorecard generation (commercial signal scoring)
run("node", ["scripts/score-gapfinder.js", domain, ...passthrough]);

// 6) generate DOCX + PDF
run(pythonCmd, ["scripts/generate-gapfinder-docx-v2.py", domain, ...passthrough]);

console.log("\n[OK] GapFinder run complete.\n");
