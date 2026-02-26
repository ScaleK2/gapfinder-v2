/**
 * run-gapfinder.js
 *
 * Holistic runner: crawl → har → phase1 inventory → PSI → DOCX/PDF
 *
 * Usage:
 *   node scripts/run-gapfinder.js latexmattress.com.au
 *   node scripts/run-gapfinder.js latexmattress.com.au --probe
 *   node scripts/run-gapfinder.js latexmattress.com.au --force
 *
 * Notes:
 * - Each underlying script handles its own idempotent skip behaviour (where implemented).
 * - PSI requires env var: PAGESPEED_API_KEY
 */

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: true });
  if (res.status !== 0) process.exit(res.status || 1);
}

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: node scripts/run-gapfinder.js <domain> [--probe] [--force]");
  process.exit(1);
}

const flags = process.argv.slice(3);
const hasProbe = flags.includes("--probe");
const hasForce = flags.includes("--force");

// 1) crawl URLs
run("node", ["scripts/domain-crawl-to-urls.js", domain, ...(hasForce ? ["--force"] : [])]);

// 2) capture HARs
run("node", ["scripts/har-capture.js", domain, ...(hasProbe ? ["--probe"] : []), ...(hasForce ? ["--force"] : [])]);

// 3) build phase1 inventory (xlsx + unknown vendors, etc.)
run("node", ["scripts/phase1-tag-inventory.js", domain, ...(hasForce ? ["--force"] : [])]);

// 4) fetch PSI (writes data/<domain>/analysis/psi.json)
run("node", ["scripts/psi-fetch.js", domain]);

// 5) generate DOCX + PDF
run("python", ["scripts/generate-gapfinder-docx-v2.py", domain]);

console.log("\n[OK] GapFinder run complete.\n");