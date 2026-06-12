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
const { loadDotEnv, parseAuditInput, parseScopeOptions } = require("./audit-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

loadDotEnv(ROOT);

const PAGE_TIMEOUT_MS = Number(process.env.GAPFINDER_PAGE_TIMEOUT_MS || 35_000);
const NETWORK_IDLE_MS = Number(process.env.GAPFINDER_NETWORK_IDLE_MS || 1_200);
const CONTEXT_CLOSE_TIMEOUT_MS = Number(process.env.GAPFINDER_CONTEXT_CLOSE_TIMEOUT_MS || 8_000);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function toHarHeaders(headersObj) {
  return Object.entries(headersObj || {}).map(([name, value]) => ({ name, value: String(value ?? "") }));
}

function toHarQueryString(rawUrl) {
  try {
    return [...new URL(rawUrl).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function requestPostData(request) {
  const text = request.postData();
  if (!text) return undefined;

  const headers = request.headers();
  return {
    mimeType: headers["content-type"] || "application/octet-stream",
    text,
  };
}

function blankResponse() {
  return {
    status: 0,
    statusText: "",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    content: { size: 0, mimeType: "" },
    redirectURL: "",
    headersSize: -1,
    bodySize: -1,
  };
}

function buildHarEntry(request) {
  const started = new Date();
  const postData = requestPostData(request);

  const entry = {
    startedDateTime: started.toISOString(),
    time: -1,
    request: {
      method: request.method(),
      url: request.url(),
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: toHarHeaders(request.headers()),
      queryString: toHarQueryString(request.url()),
      headersSize: -1,
      bodySize: postData?.text ? Buffer.byteLength(postData.text, "utf8") : 0,
      ...(postData ? { postData } : {}),
    },
    response: blankResponse(),
    cache: {},
    timings: { send: 0, wait: -1, receive: 0 },
    _startedMs: started.getTime(),
  };

  return entry;
}

function applyResponse(entry, response) {
  const headers = response.headers();
  const contentType = headers["content-type"] || "";

  entry.response = {
    status: response.status(),
    statusText: response.statusText(),
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: toHarHeaders(headers),
    content: { size: 0, mimeType: contentType.split(";")[0] || contentType },
    redirectURL: headers.location || "",
    headersSize: -1,
    bodySize: -1,
  };
}

function finaliseEntry(entry, statusText) {
  if (entry.time < 0) entry.time = Math.max(0, Date.now() - entry._startedMs);
  if (statusText && entry.response.status === 0) entry.response.statusText = statusText;
  delete entry._startedMs;
}

function writeHarFile(filePath, pageUrl, entries) {
  const cleanEntries = entries.map((entry) => {
    finaliseEntry(entry);
    return entry;
  });

  const har = {
    log: {
      version: "1.2",
      creator: { name: "GapFinder", version: "2" },
      pages: [
        {
          startedDateTime: new Date().toISOString(),
          id: "page_1",
          title: pageUrl,
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries: cleanEntries,
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(har, null, 2) + "\n", "utf8");
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeBrowser(browser) {
  try {
    await withTimeout(browser.close(), CONTEXT_CLOSE_TIMEOUT_MS, "Browser close");
  } catch (e) {
    console.warn(`  !! Browser close warning: ${e?.message || e}`);
    try {
      if (typeof browser.process === "function") browser.process()?.kill("SIGKILL");
    } catch {}
  }
}

async function captureUrl(browser, url, harPath) {
  const entries = [];
  const entryByRequest = new Map();
  let context = null;

  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      serviceWorkers: "block",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);

    page.on("request", (request) => {
      const entry = buildHarEntry(request);
      entryByRequest.set(request, entry);
      entries.push(entry);
    });

    page.on("response", (response) => {
      const entry = entryByRequest.get(response.request());
      if (entry) applyResponse(entry, response);
    });

    page.on("requestfinished", (request) => {
      const entry = entryByRequest.get(request);
      if (entry) finaliseEntry(entry);
    });

    page.on("requestfailed", (request) => {
      const entry = entryByRequest.get(request);
      if (entry) finaliseEntry(entry, request.failure()?.errorText || "requestfailed");
    });

    await page.goto(url, {
      timeout: PAGE_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    await page.waitForTimeout(NETWORK_IDLE_MS);
  } catch (err) {
    console.warn(`  !! Failed to fully load: ${url}`);
    console.warn(`     ${err?.message || err}`);
  } finally {
    writeHarFile(harPath, url, entries);

    if (context) {
      try {
        await withTimeout(context.close(), CONTEXT_CLOSE_TIMEOUT_MS, "Context close");
      } catch (e) {
        console.warn(`  !! Context close warning: ${e?.message || e}`);
        return { restartBrowser: true, entryCount: entries.length };
      }
    }
  }

  return { restartBrowser: false, entryCount: entries.length };
}

(async () => {
  const rawInput = process.argv[2];
  const args = process.argv.slice(3);
  const probe = args.includes("--probe");
  const force = args.includes("--force");
  const audit = parseAuditInput(rawInput, parseScopeOptions(args));

  if (!rawInput) {
    console.error("Usage: node scripts/har-capture.js <domain or url> [--probe] [--force] [--scope-path /au] [--global]");
    process.exit(1);
  }

  if (!audit) {
    console.error("Invalid domain or URL provided.");
    process.exit(1);
  }

  const origin = audit.homeUrl;
  const domain = audit.auditKey;

  const domainDir = path.join(DATA_DIR, domain);

  const urlsFile = path.join(domainDir, probe ? "urls_probe.txt" : "urls.txt");
  const harDir = path.join(domainDir, probe ? "har_probe" : "har");

  if (!fs.existsSync(urlsFile)) {
    console.error(`Missing URL list: ${urlsFile}`);
    console.error(`Run: node scripts/domain-crawl-to-urls.js ${rawInput}${probe ? " --probe" : ""}`);
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
  if (audit.scopePath) console.log(`[Scope]  ${audit.scopePath} (${audit.scopeMode}) -> data/${domain}`);
  console.log(`[Input]  ${urlsFile}`);
  console.log(`[Output] ${harDir}`);
  console.log(`[Mode]   Manual HAR writer (avoids Playwright recordHar close hangs)`);
  if (probe) {
    console.log("!! Probe mode: URLs may include synthetic UTMs (e.g. utm_source=gapfinder).");
  }
  if (!force) {
    console.log("Tip: Use --force to re-capture even if HAR files look up-to-date.\n");
  } else {
    console.log("!! Force mode enabled: re-capturing all URLs.\n");
  }

  let browser = await chromium.launch({ headless: true });

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

    const result = await captureUrl(browser, url, harPath);
    console.log(`  -> wrote ${path.basename(harPath)} (${result.entryCount} requests)`);

    if (result.restartBrowser && i < urls.length - 1) {
      console.log("  -> restarting browser after close warning");
      await closeBrowser(browser);
      browser = await chromium.launch({ headless: true });
    }
  }

  await closeBrowser(browser);

  console.log(`\n[Done] HAR capture complete.\n`);
})();
