/**
 * psi-fetch.js
 *
 * Fetch PageSpeed Insights and store a distilled JSON for DOCX/PDF templating.
 *
 * Default behaviour (commercially lean):
 *   - Runs PSI on HOME only
 *
 * Optional:
 *   --full  => runs HOME + CATEGORY + PDP (best-effort; failures are non-blocking)
 *
 * Usage:
 *   node scripts/psi-fetch.js edibleblooms.com.au
 *   node scripts/psi-fetch.js https://edibleblooms.com.au
 *   node scripts/psi-fetch.js edibleblooms.com.au --full
 *
 * Requires:
 *   env var PAGESPEED_API_KEY
 *
 * Reads (preferred then fallback):
 *   data/<domain>/analysis/probe_targets.json
 *   data/<domain>/urls.txt
 *
 * Writes:
 *   data/<domain>/analysis/psi.json
 */

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normaliseInputToDomain(input) {
  if (!input) return null;
  try {
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    const u = new URL(input);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readUrlsTxtIfExists(p) {
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pickCategoryUrl(urls) {
  const candidates = urls.filter((u) => {
    try {
      const p = new URL(u).pathname.toLowerCase();
      return (
        p.startsWith("/collections/") ||
        p.includes("/collection") ||
        p.includes("/category") ||
        p.includes("/product-category") ||
        p === "/shop" ||
        p.startsWith("/shop/")
      );
    } catch {
      return false;
    }
  });
  return candidates[0] || null;
}

function pickPdpUrl(urls) {
  const candidates = urls.filter((u) => {
    try {
      const p = new URL(u).pathname.toLowerCase();
      return p.includes("/products/") || p.includes("/product/");
    } catch {
      return false;
    }
  });
  return candidates[0] || null;
}

function pickTargets(domainDir, full) {
  const analysisDir = path.join(domainDir, "analysis");
  const probeTargetsPath = path.join(analysisDir, "probe_targets.json");
  const urlsPath = path.join(domainDir, "urls.txt");

  const probeTargets = readJsonIfExists(probeTargetsPath);
  const urls = readUrlsTxtIfExists(urlsPath);

  const home =
    probeTargets?.home ||
    urls[0] ||
    `https://${path.basename(domainDir)}/`;

  if (!full) {
    return [{ label: "home", url: home }];
  }

  const category = probeTargets?.category || pickCategoryUrl(urls);
  const pdp = probeTargets?.pdp || pickPdpUrl(urls);

  return [
    { label: "home", url: home },
    { label: "category", url: category },
    { label: "pdp", url: pdp },
  ].filter((x) => x.url);
}

function getAudit(json, key) {
  return json?.lighthouseResult?.audits?.[key];
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Distil PSI to the exact set your DOCX table needs.
 */
function distilPsi(json) {
  const cls = num(getAudit(json, "cumulative-layout-shift")?.numericValue); // unitless
  const lcpMs = num(getAudit(json, "largest-contentful-paint")?.numericValue); // ms
  const fcpMs = num(getAudit(json, "first-contentful-paint")?.numericValue); // ms
  const ttiMs = num(getAudit(json, "interactive")?.numericValue); // ms
  const tbtMs = num(getAudit(json, "total-blocking-time")?.numericValue); // ms
  const perf = num(json?.lighthouseResult?.categories?.performance?.score); // 0..1

  return {
    cls,
    lcp_s: lcpMs !== null ? +(lcpMs / 1000).toFixed(2) : null,
    fcp_s: fcpMs !== null ? +(fcpMs / 1000).toFixed(2) : null,
    tti_s: ttiMs !== null ? +(ttiMs / 1000).toFixed(2) : null,
    tbt_ms: tbtMs !== null ? Math.round(tbtMs) : null,
    performance: perf !== null ? Math.round(perf * 100) : null,
  };
}

async function fetchPsi(url, strategy, apiKey) {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy); // mobile | desktop
  endpoint.searchParams.set("category", "performance");
  endpoint.searchParams.set("key", apiKey);

  const res = await fetch(endpoint.toString(), { redirect: "follow" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PSI ${strategy} failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return await res.json();
}

(async () => {
  const input = process.argv[2];
  const domain = normaliseInputToDomain(input);
  const full = process.argv.includes("--full");

  if (!domain) {
    console.error("Usage: node scripts/psi-fetch.js <domain or url> [--full]");
    process.exit(1);
  }

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    console.error("Missing env var: PAGESPEED_API_KEY");
    process.exit(1);
  }

  const domainDir = path.join(DATA_DIR, domain);
  const analysisDir = path.join(domainDir, "analysis");
  ensureDir(analysisDir);

  const targets = pickTargets(domainDir, full);
  if (!targets.length) {
    console.error("No targets found. Ensure urls.txt exists (run domain-crawl-to-urls.js first).");
    process.exit(1);
  }

  const outPath = path.join(analysisDir, "psi.json");

  const out = {
    domain,
    mode: full ? "full" : "home-only",
    generatedAt: new Date().toISOString(),
    targets: {},
    summary: {
      requestedTargets: targets.map((t) => t.label),
      succeeded: [],
      failed: [],
    },
  };

  for (const t of targets) {
    console.log(`[PSI] ${t.label}: ${t.url}`);

    try {
      const mobileJson = await fetchPsi(t.url, "mobile", apiKey);
      const desktopJson = await fetchPsi(t.url, "desktop", apiKey);

      out.targets[t.label] = {
        url: t.url,
        mobile: distilPsi(mobileJson),
        desktop: distilPsi(desktopJson),
      };

      out.summary.succeeded.push(t.label);
    } catch (e) {
      out.targets[t.label] = { url: t.url, error: String(e?.message || e) };
      out.summary.failed.push(t.label);
      console.warn(`[WARN] PSI failed for ${t.label}: ${e?.message || e}`);
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  const ok = out.summary.succeeded.length;
  const bad = out.summary.failed.length;

  if (bad === 0) {
    console.log(`[OK] PSI complete (${ok}/${ok}). Wrote: ${outPath}`);
  } else {
    console.log(`[OK] PSI partial (${ok}/${ok + bad}). Wrote: ${outPath}`);
  }
})();