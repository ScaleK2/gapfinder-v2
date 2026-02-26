/**
 * har-capture.js
 *
 * Captures HAR files for each URL in:
 *   - data/<domain>/urls.txt        (baseline)
 *   - data/<domain>/urls_probe.txt  (when --probe)
 *
 * Writes HAR files to:
 *   - data/<domain>/har/            (baseline)
 *   - data/<domain>/har_probe/      (when --probe)
 *
 * Idempotent behaviour (incremental build):
 * - For each URL, if its HAR file already exists AND is newer than the URL list file, skip it (unless --force).
 *
 * Usage:
 *   node scripts/har-capture.js https://example.com
 *   node scripts/har-capture.js example.com
 *   node scripts/har-capture.js example.com --probe
 *   node scripts/har-capture.js example.com --probe --force
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const PAGE_TIMEOUT_MS = 35_000;
const NETWORK_IDLE_MS = 1_200;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normaliseInputUrl(input) {
  try {
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    return new URL(input);
  } catch {
    return null;
  }
}

function domainKey(urlObj) {
  return urlObj.hostname.replace(/^www\./, "");
}

function safeStatMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function slugFromUrl(rawUrl) {
  // slug is based on pathname only (queries stripped) so baseline/probe remain comparable
  const u = new URL(rawUrl);
  const p = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!p) return "home";

  return p
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

(async () => {
  const rawInput = process.argv[2];
  const probe = process.argv.includes("--probe");
  const force = process.argv.includes("--force");

  if (!rawInput) {
    console.error("Usage: node scripts/har-capture.js <domain or url> [--probe] [--force]");
    process.exit(1);
  }

  const inputUrl = normaliseInputUrl(rawInput);
  if (!inputUrl) {
    console.error("Invalid domain or URL provided.");
    process.exit(1);
  }

  const origin = inputUrl.origin;
  const domain = domainKey(inputUrl);

  const domainDir = path.join(DATA_DIR, domain);

  const urlsFile = path.join(domainDir, probe ? "urls_probe.txt" : "urls.txt");
  const harDir = path.join(domainDir, probe ? "har_probe" : "har");

  if (!fs.existsSync(urlsFile)) {
    console.error(`Missing URL list: ${urlsFile}`);
    console.error(`Run: node scripts/domain-crawl-to-urls.js ${domain}${probe ? " --probe" : ""}`);
    process.exit(1);
  }

  ensureDir(harDir);

  const urls = fs
    .readFileSync(urlsFile, "utf8")
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);

  if (!urls.length) {
    console.error(`${path.basename(urlsFile)} is empty. Nothing to capture.`);
    process.exit(1);
  }

  const urlsFileMtime = safeStatMtimeMs(urlsFile);

  console.log(`\n[HAR] Capturing ${urls.length} pages for ${origin}${probe ? " (probe mode)" : ""}`);
  console.log(`[Input]  ${urlsFile}`);
  console.log(`[Output] ${harDir}`);
  if (probe) {
    console.log("!! Probe mode: URLs may include synthetic UTMs (e.g. utm_source=gapfinder).");
  }
  if (!force) {
    console.log("Tip: Use --force to re-capture even if HAR files look up-to-date.\n");
  } else {
    console.log("!! Force mode enabled: re-capturing all URLs.\n");
  }

  const browser = await chromium.launch({ headless: true });

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const index = String(i + 1).padStart(2, "0");
    const slug = slugFromUrl(url);
    const harPath = path.join(harDir, `${index}_${slug}.har`);

    // Per-URL incremental build / idempotency
    if (!force && fs.existsSync(harPath)) {
      const harMtime = safeStatMtimeMs(harPath);
      if (harMtime >= urlsFileMtime) {
        console.log(`[${index}/${urls.length}] (skip) ${url}`);
        continue;
      }
    }

    console.log(`[${index}/${urls.length}] ${url}`);

    const context = await browser.newContext({
      recordHar: {
        path: harPath,
        content: "embed"
      },
      userAgent: USER_AGENT
    });

    const page = await context.newPage();

    try {
      await page.goto(url, {
        timeout: PAGE_TIMEOUT_MS,
        waitUntil: "domcontentloaded"
      });

      await page.waitForTimeout(NETWORK_IDLE_MS);
    } catch (err) {
      console.warn(`  !! Failed to load: ${url}`);
    } finally {
      await context.close();
    }
  }

  await browser.close();

  console.log(`\n[Done] HAR capture complete.\n`);
})();