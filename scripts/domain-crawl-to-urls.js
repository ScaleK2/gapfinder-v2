/**
 * domain-crawl-to-urls.js
 *
 * Generates MVDS URLs for capability audit.
 *
 * Output:
 *   data/<domain>/urls.txt
 *   data/<domain>/urls_probe.txt   (only when --probe)
 *   data/<domain>/analysis/probe_targets.json
 *
 * MVDS:
 * - Homepage
 * - 3 x category/collection pages (Shopify + Woo + generic)
 * - 3 x product pages (Shopify + Woo + generic)
 * - /cart (if exists)
 * - /checkout (if exists)  -> ALWAYS /checkout, never /checkouts/*
 * - 1 x privacy page (best available)
 * - optional: 1 blog URL (if exists)
 *
 * Notes:
 * - Sitemap discovery uses robots.txt Sitemap: lines (best), then common sitemap paths.
 * - Supports Shopify + WooCommerce strongly; adds generic ecommerce heuristics for other CMS (Wix, Squarespace, Webflow, etc.)
 * - Prints a low-confidence warning if no product/category templates detected.
 *
 * Usage:
 *   node scripts/domain-crawl-to-urls.js https://example.com
 *   node scripts/domain-crawl-to-urls.js https://example.com --probe
 *   node scripts/domain-crawl-to-urls.js https://example.com --force
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const MAX_CATEGORIES = 3;
const MAX_PRODUCTS = 3;

const PROBE_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const CRITICAL_PATHS = ["/cart", "/checkout"];

// Synthetic attribution probe params (only appended when --probe is set)
const PROBE_PARAMS = {
  utm_source: "gapfinder",
  utm_medium: "diagnostic",
  utm_campaign: "visibility_probe",
  utm_content: "entry",
  utm_term: "path",
  gf_probe: "1"
};

// Privacy preference order (pick ONE best available)
const PRIVACY_CANDIDATES = [
  "/policies/privacy-policy",
  "/pages/privacy-policy",
  "/privacy-policy",
  "/privacy",
  "/legal/privacy-policy"
];

// Optional HTML sitemap fallback pages (some CMS use these)
const HTML_SITEMAP_CANDIDATES = ["/sitemap/", "/sitemap", "/site-map/", "/site-map"];

// Generic ecommerce URL heuristics
const CATEGORY_HINTS = [
  "/collections/",
  "/collection/",
  "/product-category/",
  "/category/",
  "/categories/",
  "/shop",
  "/shop/",
  "/store",
  "/store/",
  "/catalog",
  "/catalog/",
  "/c/",
  "/collections/all"
];

const PRODUCT_HINTS = [
  "/products/",
  "/product/",
  "/p/",
  "/item/",
  "/items/",
  "/shop/p/",
  "/store/p/",
  "/store/product",
  "/product-page/",
  "/buy/",
  "/dp/" // sometimes used in custom builds
];

const BLOG_HINTS = ["/blogs/", "/blog/", "/news/"];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function domainKey(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function normaliseUrl(raw, origin) {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return null;

    // never include Shopify session checkout URLs
    if (u.pathname.toLowerCase().startsWith("/checkouts/")) return null;

    // strip hash/query for determinism
    u.hash = "";
    u.search = "";

    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return null;
  }
}

function withQueryParams(rawUrl, params) {
  try {
    const u = new URL(rawUrl);
    for (const [k, v] of Object.entries(params || {})) {
      // do not overwrite existing keys
      if (!u.searchParams.has(k)) u.searchParams.set(k, String(v));
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function appendParams(url, params) {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
}

function isUrlset(xml) {
  return /<urlset/i.test(xml);
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return await res.text();
}

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

  if (!url.endsWith(".gz")) return await res.text();

  const buf = Buffer.from(await res.arrayBuffer());
  return zlib.gunzipSync(buf).toString("utf8");
}

/**
 * Sitemap discovery priority:
 * 1) robots.txt Sitemap: lines
 * 2) common sitemap paths
 */
async function discoverSitemapUrls(origin) {
  const sitemaps = [];

  // 1) robots.txt
  try {
    const robotsUrl = new URL("/robots.txt", origin).toString();
    const robotsTxt = await fetchText(robotsUrl);

    const matches = [...robotsTxt.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map(m => m[1]);
    for (const sm of matches) {
      try {
        const u = new URL(sm);
        if (u.origin === origin) sitemaps.push(sm);
      } catch {
        // ignore malformed
      }
    }
  } catch {
    // ignore
  }

  // 2) common sitemap paths
  const common = [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-index.xml",
    "/sitemap/sitemap.xml",
    "/sitemap1.xml"
  ].map(p => new URL(p, origin).toString());

  for (const sm of common) {
    if (!sitemaps.includes(sm)) sitemaps.push(sm);
  }

  return [...new Set(sitemaps)];
}

async function discoverUrlsFromSitemaps(origin) {
  const sitemapUrls = await discoverSitemapUrls(origin);
  const pages = new Set();

  for (const sm of sitemapUrls) {
    try {
      const xml = await fetchXml(sm);
      const locs = extractLocs(xml);

      if (isSitemapIndex(xml)) {
        for (const child of locs) {
          try {
            const childXml = await fetchXml(child);
            if (!isUrlset(childXml)) continue;

            for (const u of extractLocs(childXml)) {
              const n = normaliseUrl(u, origin);
              if (n) pages.add(n);
            }
          } catch {
            // ignore broken child sitemap
          }
        }
      } else if (isUrlset(xml)) {
        for (const u of locs) {
          const n = normaliseUrl(u, origin);
          if (n) pages.add(n);
        }
      }
    } catch {
      // ignore sitemap candidate if it fails
    }
  }

  return [...pages].sort();
}

async function crawlPageLinks(url, origin) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: USER_AGENT });
  const urls = new Set();

  try {
    await page.goto(url, { timeout: 35_000, waitUntil: "domcontentloaded" });
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    for (const h of links) {
      const n = normaliseUrl(h, origin);
      if (n) urls.add(n);
    }
  } catch {
    // ignore
  } finally {
    await browser.close();
  }

  return [...urls].sort();
}

async function crawlHomepage(origin) {
  return await crawlPageLinks(origin, origin);
}

function containsAny(pathnameLower, hints) {
  return hints.some(h => {
    // treat "/shop" as exact or prefix; others as substring matches
    if (h === "/shop" || h === "/store" || h === "/catalog") {
      return pathnameLower === h || pathnameLower.startsWith(`${h}/`);
    }
    return pathnameLower.includes(h);
  });
}

function pickTemplates(allUrls, origin) {
  const categories = [];
  const products = [];
  const blogs = [];

  for (const u of allUrls) {
    const p = new URL(u).pathname.toLowerCase();

    // Strong patterns first (Shopify + Woo)
    if (p.startsWith("/collections/") || p.startsWith("/product-category/")) categories.push(u);
    else if (p.startsWith("/products/") || p.startsWith("/product/")) products.push(u);

    // Then generic heuristics for other CMS
    else if (containsAny(p, PRODUCT_HINTS)) products.push(u);
    else if (containsAny(p, CATEGORY_HINTS)) categories.push(u);

    if (containsAny(p, BLOG_HINTS)) blogs.push(u);
  }

  const uniq = (arr) => [...new Set(arr)].sort();

  return {
    homepage: origin,
    categories: uniq(categories).slice(0, MAX_CATEGORIES),
    products: uniq(products).slice(0, MAX_PRODUCTS),
    blog: uniq(blogs)[0] || null
  };
}

async function probePaths(origin, paths) {
  const found = [];
  for (const p of paths) {
    const url = new URL(p, origin).toString();
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });

      const okish =
        (res.status >= 200 && res.status < 400) ||
        res.status === 401 ||
        res.status === 403;

      if (!okish) continue;

      const finalUrl = res.url || url;
      if (new URL(finalUrl).origin !== origin) continue;

      const n = normaliseUrl(finalUrl, origin);
      if (n) found.push(n);
    } catch {
      // ignore
    }
  }
  return [...new Set(found)].sort();
}

async function pickOnePrivacyUrl(origin) {
  const found = await probePaths(origin, PRIVACY_CANDIDATES);
  for (const candidate of PRIVACY_CANDIDATES) {
    const full = normaliseUrl(new URL(candidate, origin).toString(), origin);
    if (full && found.includes(full)) return full;
  }
  return null;
}

async function tryHtmlSitemapFallback(origin) {
  for (const p of HTML_SITEMAP_CANDIDATES) {
    const url = new URL(p, origin).toString();
    const links = await crawlPageLinks(url, origin);
    if (links.length) return links;
  }
  return [];
}

(async () => {
  const input = process.argv[2];
  const probe = process.argv.includes("--probe");
  const force = process.argv.includes("--force");

  if (!input) {
    console.error("Usage: node scripts/domain-crawl-to-urls.js <domain or url> [--probe] [--force]");
    process.exit(1);
  }

  // allow passing bare domain (e.g. example.com)
  let origin = "";
  try {
    const raw = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    origin = new URL(raw).origin;
  } catch {
    console.error("Invalid domain/url:", input);
    process.exit(1);
  }

  const domain = domainKey(origin);

  const domainDir = path.join(DATA_DIR, domain);
  ensureDir(domainDir);

  const analysisDir = path.join(domainDir, "analysis");
  ensureDir(analysisDir);

  const outputFile = path.join(domainDir, probe ? "urls_probe.txt" : "urls.txt");
  const probeTargetsFile = path.join(analysisDir, "probe_targets.json");

  console.log(`\n[GapFinder] MVDS URL set for ${origin}${probe ? " (probe mode)" : ""}`);
  console.log(`[Output]  ${outputFile}\n`);

  // 1) XML sitemaps via robots/common paths
  let urls = await discoverUrlsFromSitemaps(origin);

  // 2) HTML sitemap fallback if XML gave nothing
  if (!urls.length) {
    const htmlLinks = await tryHtmlSitemapFallback(origin);
    if (htmlLinks.length) urls = htmlLinks;
  }

  // 3) Fallback to homepage crawl
  if (!urls.length) {
    console.log("[Fallback] No sitemap URLs found. Crawling homepage links...\n");
    urls = await crawlHomepage(origin);
  }

  const t = pickTemplates(urls, origin);
  const critical = await probePaths(origin, CRITICAL_PATHS);
  const privacy = await pickOnePrivacyUrl(origin);

  const finalUrls = [
    t.homepage,
    ...t.categories,
    ...t.products,
    ...critical,
    privacy,
    t.blog
  ].filter(Boolean);

  // ---- Probe target persistence (homepage + 1 PDP) ----
  const existingTargets = !force ? readJsonIfExists(probeTargetsFile) : null;
  const candidatePdp = t.products[0] || null;

  let probeTargets = existingTargets && typeof existingTargets === "object" ? existingTargets : null;
  const isValidExisting =
    probeTargets &&
    typeof probeTargets.home === "string" &&
    probeTargets.home.startsWith(origin);

  if (!isValidExisting) {
    probeTargets = {
      home: t.homepage,
      pdp: candidatePdp
    };
  } else {
    // backfill pdp if missing and we can infer one
    if ((!probeTargets.pdp || typeof probeTargets.pdp !== "string") && candidatePdp) {
      probeTargets.pdp = candidatePdp;
    }
    // keep home aligned to origin
    probeTargets.home = t.homepage;
  }

  writeJson(probeTargetsFile, probeTargets);

  // ---- Apply probe UTMs to homepage + PDP only (probe mode) ----
  const uniqueFinal = [...new Set(finalUrls)];
  const outUrls = probe
    ? uniqueFinal.map(u => {
        if (u === probeTargets.home) return appendParams(u, PROBE_PARAMS);
        if (probeTargets.pdp && u === probeTargets.pdp) return appendParams(u, PROBE_PARAMS);
        return u;
      })
    : uniqueFinal;

  fs.writeFileSync(outputFile, outUrls.join("\n") + "\n", "utf8");

  const confidence =
    (t.categories.length > 0 ? 1 : 0) +
    (t.products.length > 0 ? 1 : 0) +
    (critical.some(u => new URL(u).pathname === "/checkout") ? 1 : 0) +
    (critical.some(u => new URL(u).pathname === "/cart") ? 1 : 0);

  console.log(`[Done] Wrote ${outUrls.length} URLs`);
  console.log(`[Probe Targets] ${probeTargetsFile}`);
  if (probe && (!probeTargets.pdp || typeof probeTargets.pdp !== "string")) {
    console.log("!! Probe mode enabled but no PDP target was detected. Only homepage will be probed.");
  }
  console.log(`[Confidence] ${confidence}/4 (categories/products/cart/checkout)\n`);

  if (!t.categories.length || !t.products.length) {
    console.log("!! Low confidence template detection.");
    if (!t.categories.length) console.log("   - No category/collection-like URLs detected.");
    if (!t.products.length) console.log("   - No product-like URLs detected.");
    console.log("   Likely causes: sitemap missing/blocked, JS-only routing, unusual URL patterns.");
    console.log("   Next move: provide 1 known product URL and 1 known category URL (manual override) OR we add a targeted pattern.\n");
  }
})();