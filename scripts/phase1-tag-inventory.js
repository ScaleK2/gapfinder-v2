/**
 * phase1-tag-inventory.js
 *
 * Phase 1: Extract tag inventory + event inventory from HAR files.
 *
 * Usage:
 *   node scripts/phase1-tag-inventory.js example.com
 *   node scripts/phase1-tag-inventory.js example.com --probe
 *   node scripts/phase1-tag-inventory.js example.com --force
 *   node scripts/phase1-tag-inventory.js example.com --probe --force
 */

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const XLSX = require("xlsx");
const { loadDotEnv, parseAuditInput, parseScopeOptions } = require("./audit-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

loadDotEnv(ROOT);

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid"];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normaliseInputToDomain(input, args = []) {
  const audit = parseAuditInput(input, parseScopeOptions(args));
  return audit ? audit.auditKey : null;
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function safeCsv(s) {
  const str = String(s ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function getParam(u, key) {
  try {
    return new URL(u).searchParams.get(key);
  } catch {
    return null;
  }
}

function newestMtimeMs(filePaths) {
  let newest = 0;
  for (const p of filePaths) {
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > newest) newest = m;
    } catch {}
  }
  return newest;
}

function summariseExample(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "").slice(0, 200);
  }
}

function inferPageTypeFromHarFilename(filenameLower) {
  if (filenameLower.includes("home")) return "home";
  if (filenameLower.includes("collection") || filenameLower.includes("collections") || filenameLower.includes("category")) return "category";
  if (filenameLower.includes("product") || filenameLower.includes("products") || filenameLower.includes("pdp")) return "pdp";
  if (filenameLower.includes("cart")) return "cart";
  if (filenameLower.includes("checkout")) return "checkout";
  if (filenameLower.includes("privacy") || filenameLower.includes("policy")) return "privacy";
  if (filenameLower.includes("blog") || filenameLower.includes("news") || filenameLower.includes("article")) return "blog";
  return "other";
}

function isGoogleAdsCcmCollect(url, host) {
  const h = host || hostOf(url);
  if (h !== "www.google.com" && h !== "www.google.com.au") return false;

  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();

    if (p !== "/ccm/collect") return false;

    const tid = u.searchParams.get("tid") || "";
    const tids = u.searchParams.get("tids") || "";

    return tid.startsWith("AW-") || tids.split(",").some((x) => x.trim().startsWith("AW-"));
  } catch {
    return false;
  }
}

function isGoogleAdsRmktCollect(url, host) {
  const h = host || hostOf(url);
  if (h !== "www.google.com" && h !== "www.google.com.au") return false;

  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return p.includes("/rmkt/collect/");
  } catch {
    return false;
  }
}

function isGoogleAdsViewthroughConversion(url, host) {
  const h = host || hostOf(url);

  if (
    h !== "googleads.g.doubleclick.net" &&
    h !== "www.googleadservices.com" &&
    h !== "www.google.com" &&
    h !== "www.google.com.au"
  ) {
    return false;
  }

  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().includes("/pagead/viewthroughconversion/");
  } catch {
    return false;
  }
}

function isGoogleAdsConversion(url, host) {
  const h = host || hostOf(url);

  if (
    h !== "googleads.g.doubleclick.net" &&
    h !== "www.googleadservices.com" &&
    h !== "www.google.com" &&
    h !== "www.google.com.au"
  ) {
    return false;
  }

  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return p.includes("/pagead/conversion/") || p.includes("/conversion/");
  } catch {
    return false;
  }
}

function extractGoogleAdsRmktId(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\/rmkt\/collect\/(\d+)\//i);
    if (m) return `AW-${m[1]}`;
  } catch {}

  return "";
}

function extractGoogleAdsViewthroughId(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\/pagead\/viewthroughconversion\/(\d+)\//i);
    if (m) return `AW-${m[1]}`;
  } catch {}

  return "";
}

function extractGoogleAdsConversionId(url) {
  try {
    const p = new URL(url).pathname;

    let m = p.match(/\/pagead\/conversion\/(\d+)\//i);
    if (m) return `AW-${m[1]}`;

    m = p.match(/\/conversion\/(\d+)\//i);
    if (m) return `AW-${m[1]}`;
  } catch {}

  return "";
}

const RULES = [
  {
    vendor: "Google Tag Manager",
    category: "Tag Manager",
    match: (u, h) => h === "www.googletagmanager.com" && u.includes("gtm.js"),
    id: (u) => getParam(u, "id") || "",
  },
  {
    vendor: "Google tag (gtag.js)",
    category: "Tag Manager / Google Tag",
    match: (u, h) => h === "www.googletagmanager.com" && u.includes("/gtag/js"),
    id: (u) => getParam(u, "id") || "",
  },
  {
    vendor: "Google Ads Destination",
    category: "Ads",
    match: (u, h) => h === "www.googletagmanager.com" && u.includes("/gtag/destination"),
    id: (u) => getParam(u, "id") || "",
  },
  {
    vendor: "Google Analytics (GA4)",
    category: "Analytics",
    match: (u, h) =>
      (h.endsWith("google-analytics.com") && (u.includes("/g/collect") || u.includes("/collect"))) ||
      h === "www.google-analytics.com" ||
      h === "analytics.google.com",
    id: (u) => getParam(u, "tid") || getParam(u, "measurement_id") || "",
  },
  {
    vendor: "Google Ads Viewthrough Conversion",
    category: "Ads",
    match: (u, h) => isGoogleAdsViewthroughConversion(u, h),
    id: (u) => extractGoogleAdsViewthroughId(u),
  },
  {
    vendor: "Google Ads Remarketing",
    category: "Ads",
    match: (u, h) => isGoogleAdsRmktCollect(u, h),
    id: (u) => extractGoogleAdsRmktId(u),
  },
  {
    vendor: "Google Ads",
    category: "Ads",
    match: (u, h) =>
      isGoogleAdsConversion(u, h) ||
      h === "www.googleadservices.com" ||
      h === "googleads.g.doubleclick.net" ||
      h === "stats.g.doubleclick.net" ||
      h === "static.doubleclick.net" ||
      u.includes("pagead/") ||
      u.includes("conversion/"),
    id: (u) => getParam(u, "id") || getParam(u, "label") || extractGoogleAdsConversionId(u),
  },
  {
    vendor: "Google Ads",
    category: "Ads",
    match: (u, h) => isGoogleAdsCcmCollect(u, h),
    id: (u) => getParam(u, "tid") || getParam(u, "tids") || "",
  },
  {
    vendor: "Google Merchant Center / Shopping",
    category: "Google Services",
    match: (_u, h) =>
      h === "www.merchant-center-analytics.goog" ||
      h === "jnn-pa.googleapis.com" ||
      h === "www.google.com" ||
      h === "www.google.com.au" ||
      h === "www.gstatic.com",
    id: () => "",
  },
  {
    vendor: "Meta Pixel",
    category: "Ads",
    match: (u, h) => h === "connect.facebook.net" || (h === "www.facebook.com" && u.includes("/tr/")),
    id: (u) => getParam(u, "id") || "",
  },
  {
    vendor: "TikTok Pixel",
    category: "Ads",
    match: (u, h) =>
      h.includes("analytics.tiktok.com") ||
      h.includes("ads.tiktok.com") ||
      (u.toLowerCase().includes("tiktok") && u.toLowerCase().includes("pixel")),
    id: (u) => getParam(u, "pixel_code") || getParam(u, "pixel_id") || "",
  },
  {
    vendor: "Pinterest Tag",
    category: "Ads",
    match: (u, h) => h.endsWith("pinterest.com") && (u.includes("/v3/") || u.includes("ct.pinterest.com")),
    id: (u) => getParam(u, "tid") || "",
  },
  {
    vendor: "Microsoft Ads (UET)",
    category: "Ads",
    match: (_u, h) => h.includes("bat.bing.com") || h === "c.bing.com",
    id: (u) => getParam(u, "ti") || "",
  },
  {
    vendor: "LocaliQ / ReachLocal Tracking",
    category: "Lead Capture / Marketing Tracking",
    match: (_u, h) =>
      h === "capture-api.reachlocalservices.com" ||
      h === "cdn.rlets.com" ||
      h.endsWith(".rlets.com"),
    id: () => "",
  },
  {
    vendor: "WordPress / Jetpack Stats",
    category: "Analytics",
    match: (_u, h) => h === "stats.wp.com" || h === "pixel.wp.com",
    id: () => "",
  },
  {
    vendor: "Stripe",
    category: "Payments",
    match: (_u, h) =>
      h === "js.stripe.com" ||
      h === "api.stripe.com" ||
      h === "r.stripe.com" ||
      h === "m.stripe.network" ||
      h === "b.stripecdn.com" ||
      h === "merchant-ui-api.stripe.com",
    id: () => "",
  },
  {
    vendor: "Mailchimp",
    category: "Email/SMS",
    match: (_u, h) =>
      h === "chimpstatic.com" ||
      h === "downloads.mailchimp.com" ||
      h === "s3.amazonaws.com",
    id: () => "",
  },
  {
    vendor: "hCaptcha",
    category: "Bot Protection / CAPTCHA",
    match: (_u, h) => h === "hcaptcha.com" || h.endsWith(".hcaptcha.com"),
    id: () => "",
  },
  {
    vendor: "Shopify CDN",
    category: "Ecommerce Platform",
    match: (_u, h) => h === "cdn.shopify.com",
    id: () => "",
  },
  {
    vendor: "Shopify Services",
    category: "Ecommerce Platform",
    match: (_u, h) =>
      h === "monorail-edge.shopifysvc.com" ||
      h === "otlp-http-production.shopifysvc.com" ||
      h === "error-analytics-sessions-production.shopifysvc.com" ||
      h.endsWith(".shopifysvc.com"),
    id: () => "",
  },
  {
    vendor: "Shop Pay / Shop App",
    category: "Ecommerce Platform",
    match: (_u, h) => h === "shop.app",
    id: () => "",
  },
  {
    vendor: "Tolstoy",
    category: "Shoppable Video / UGC",
    match: (_u, h) =>
      h === "widget.gotolstoy.com" ||
      h === "play.gotolstoy.com" ||
      h === "cf-apilb.gotolstoy.com" ||
      h.endsWith(".gotolstoy.com"),
    id: () => "",
  },
  {
    vendor: "Searchanise",
    category: "Onsite Search",
    match: (_u, h) =>
      h === "athena.searchserverapi1.com" ||
      h.endsWith(".searchserverapi1.com") ||
      h.includes("searchanise") ||
      h.endsWith(".kxcdn.com"),
    id: () => "",
  },
  {
    vendor: "Yotpo",
    category: "Reviews/UGC",
    match: (_u, h) =>
      h === "cdn-widgetsrepository.yotpo.com" ||
      h === "staticw2.yotpo.com" ||
      h.endsWith(".yotpo.com"),
    id: () => "",
  },
  {
    vendor: "Swym",
    category: "Wishlist / Retention",
    match: (_u, h) =>
      h === "swymstore-v3free-01.swymrelay.com" ||
      h.endsWith(".swymrelay.com") ||
      h.includes("swym"),
    id: () => "",
  },
  {
    vendor: "Gorgias",
    category: "Support/Chat",
    match: (_u, h) =>
      h === "config.gorgias.chat" ||
      h === "config.gorgias.help" ||
      h.endsWith(".gorgias.chat") ||
      h.endsWith(".gorgias.help"),
    id: () => "",
  },
  {
    vendor: "Shogun",
    category: "Page Builder",
    match: (_u, h) => h === "na.shgcdn3.com" || h.endsWith(".shgcdn3.com"),
    id: () => "",
  },
  {
    vendor: "Adobe Fonts (Typekit)",
    category: "Fonts",
    match: (_u, h) => h === "use.typekit.net" || h === "p.typekit.net" || h.endsWith(".typekit.net"),
    id: () => "",
  },
  {
    vendor: "Microsoft ASP.NET CDN",
    category: "CDN",
    match: (_u, h) => h === "ajax.aspnetcdn.com" || h.endsWith(".aspnetcdn.com"),
    id: () => "",
  },
  {
    vendor: "9gtb (Unclassified)",
    category: "Widget / Unknown App",
    match: (_u, h) => h === "content.9gtb.com" || h === "cdn.9gtb.com" || h.endsWith(".9gtb.com"),
    id: () => "",
  },
  {
    vendor: "NFCube / Instafeed",
    category: "Social Feed",
    match: (_u, h) => h === "cdn.nfcube.com" || h === "instafeed.nfcube.com" || h.endsWith(".nfcube.com"),
    id: () => "",
  },
  {
    vendor: "Google Fonts",
    category: "Fonts",
    match: (_u, h) => h === "fonts.googleapis.com" || h === "fonts.gstatic.com",
    id: () => "",
  },
  {
    vendor: "jQuery CDN",
    category: "CDN",
    match: (_u, h) => h === "code.jquery.com",
    id: () => "",
  },
  {
    vendor: "Google Hosted Libraries",
    category: "CDN",
    match: (_u, h) => h === "ajax.googleapis.com",
    id: () => "",
  },
  {
    vendor: "cdnjs",
    category: "CDN",
    match: (_u, h) => h === "cdnjs.cloudflare.com",
    id: () => "",
  },
  {
    vendor: "jsDelivr",
    category: "CDN",
    match: (_u, h) => h === "cdn.jsdelivr.net",
    id: () => "",
  },
  {
    vendor: "GitHub Raw",
    category: "CDN",
    match: (_u, h) => h === "raw.githubusercontent.com",
    id: () => "",
  },
  {
    vendor: "YouTube",
    category: "Video/CDN",
    match: (_u, h) => h === "www.youtube.com" || h === "i.ytimg.com" || h === "yt3.ggpht.com",
    id: () => "",
  },
  {
    vendor: "Zoho PageSense",
    category: "CRO / Experience Analytics",
    match: (_u, h) =>
      h === "pagesense-collect.zoho.com" ||
      h === "cdn.pagesense.io" ||
      h === "static.zohocdn.com" ||
      h.endsWith(".zohocdn.com"),
    id: () => "",
  },
  {
    vendor: "LaunchDarkly",
    category: "Feature Flags / Experimentation",
    match: (_u, h) => h === "app.launchdarkly.com" || h === "events.launchdarkly.com" || h.endsWith(".launchdarkly.com"),
    id: () => "",
  },
  {
    vendor: "Stape",
    category: "Server-side Tagging / Proxy",
    match: (_u, h) => h === "ap.stape.info" || h.endsWith(".stape.io") || h.endsWith(".stape.info"),
    id: () => "",
  },
  {
    vendor: "Judge.me",
    category: "Reviews/UGC",
    match: (_u, h) => h === "cdnwidget.judge.me" || h.endsWith(".judge.me"),
    id: () => "",
  },
  {
    vendor: "Podium",
    category: "Support/Chat / Lead Capture",
    match: (_u, h) =>
      h === "connect.podium.com" ||
      h === "mind-flayer.podium.com" ||
      h === "assets.podium.com" ||
      h.endsWith(".podium.com"),
    id: () => "",
  },
  {
    vendor: "Preezie",
    category: "Guided Selling / Product Discovery",
    match: (_u, h) => h === "widget-cdn.preezie.com" || h.endsWith(".preezie.com"),
    id: () => "",
  },
  {
    vendor: "impact.com",
    category: "Affiliate / Partner Tracking",
    match: (_u, h) => h === "trkapi.impact.com" || h.endsWith(".impact.com"),
    id: () => "",
  },
  {
    vendor: "Afterpay",
    category: "Payments",
    match: (_u, h) => h === "static.afterpay.com" || h.endsWith(".afterpay.com"),
    id: () => "",
  },
  {
    vendor: "Square",
    category: "Payments",
    match: (_u, h) => h === "js.squarecdn.com" || h.endsWith(".squarecdn.com"),
    id: () => "",
  },
  {
    vendor: "Shopify Apps (Forms)",
    category: "Ecommerce Platform",
    match: (_u, h) => h === "forms.shopifyapps.com" || h.endsWith(".shopifyapps.com"),
    id: () => "",
  },
  {
    vendor: "Microsoft Clarity",
    category: "Session Replay",
    match: (_u, h) => h.includes("clarity.ms"),
    id: () => "",
  },
  {
    vendor: "Hotjar",
    category: "Session Replay",
    match: (_u, h) => h.includes("hotjar.com"),
    id: (u) => getParam(u, "hjid") || "",
  },
  {
    vendor: "FullStory",
    category: "Session Replay",
    match: (_u, h) => h.includes("fullstory.com") || h.includes("fs-api.com"),
    id: () => "",
  },
  {
    vendor: "Optimizely",
    category: "A/B Testing",
    match: (_u, h) => h.includes("optimizely.com"),
    id: () => "",
  },
  {
    vendor: "VWO",
    category: "A/B Testing",
    match: (_u, h) => h.includes("visualwebsiteoptimizer.com") || h.includes("vwo.com"),
    id: () => "",
  },
  {
    vendor: "AB Tasty",
    category: "A/B Testing",
    match: (_u, h) => h.includes("abtasty.com"),
    id: () => "",
  },
  {
    vendor: "Cookiebot",
    category: "Consent/CMP",
    match: (_u, h) => h.includes("cookiebot.com"),
    id: () => "",
  },
  {
    vendor: "OneTrust",
    category: "Consent/CMP",
    match: (u, h) => h.includes("onetrust.com") || u.includes("otSDKStub.js"),
    id: () => "",
  },
  {
    vendor: "Klaviyo",
    category: "Email/SMS",
    match: (_u, h) => h.includes("klaviyo.com") || h.includes("static.klaviyo.com"),
    id: () => "",
  },
];

function classify(url, firstPartyDomain) {
  const h = hostOf(url);
  const isFirstParty = h === firstPartyDomain || h.endsWith(`.${firstPartyDomain}`);

  for (const r of RULES) {
    if (r.match(url, h)) {
      const identifier = (r.id && r.id(url)) || "";
      return {
        vendor: r.vendor,
        category: r.category,
        identifier,
        host: h,
        firstParty: isFirstParty,
      };
    }
  }

  return {
    vendor: isFirstParty ? "First-party (unknown tool/proxy)" : "Unknown third-party",
    category: isFirstParty ? "First-party" : "Unknown",
    identifier: "",
    host: h,
    firstParty: isFirstParty,
  };
}

function parseHarFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  return json?.log?.entries || [];
}

function flattenJsonShallow(obj, map, prefix = "") {
  if (obj === null || obj === undefined) return;

  if (Array.isArray(obj)) {
    map.set(prefix || "[]", "[array]");
    return;
  }

  if (typeof obj !== "object") return;

  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;

    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      map.set(key, String(v));
    } else if (Array.isArray(v)) {
      map.set(key, "[array]");
    } else if (typeof v === "object") {
      map.set(key, "[object]");
    }
  }
}

function addGoogleAdsDataParamsToMap(map) {
  const data = map.get("data");
  if (!data || typeof data !== "string") return;

  const chunks = String(data)
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const idx = chunk.indexOf("=");
    if (idx <= 0) continue;

    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();

    if (!key) continue;

    map.set(`data.${key}`, value);

    if (!map.has(key)) {
      map.set(key, value);
    }
  }
}

function toParamMapFromHarEntry(entry) {
  const map = new Map();
  const reqUrl = entry?.request?.url || "";

  try {
    const u = new URL(reqUrl);
    for (const [k, v] of u.searchParams.entries()) map.set(k, v);
  } catch {}

  const qs = entry?.request?.queryString || [];
  for (const kv of qs) {
    if (kv && typeof kv.name === "string") map.set(kv.name, String(kv.value ?? ""));
  }

  const postData = entry?.request?.postData;
  const mime = (postData?.mimeType || "").toLowerCase();
  const text = postData?.text;

  if (text && typeof text === "string") {
    if (mime.includes("application/x-www-form-urlencoded")) {
      try {
        const sp = new URLSearchParams(text);
        for (const [k, v] of sp.entries()) map.set(k, v);
      } catch {}
    }

    if (mime.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      try {
        const obj = JSON.parse(text);
        flattenJsonShallow(obj, map);
      } catch {}
    }
  }

  addGoogleAdsDataParamsToMap(map);

  return map;
}

function pick(map, keys) {
  for (const k of keys) {
    if (map.has(k)) {
      const v = map.get(k);
      if (v !== null && v !== undefined && String(v).length) return String(v);
    }
  }
  return "";
}

function hasAny(map, keys) {
  for (const k of keys) {
    if (map.has(k) && String(map.get(k) ?? "").length) return true;
  }
  return false;
}

function detectEndpointType(url, vendor) {
  const u = (url || "").toLowerCase();
  const h = hostOf(url);

  if (vendor === "Google Analytics (GA4)") return "ga4_collect";
  if (vendor === "Meta Pixel" && u.includes("/tr/")) return "meta_tr";
  if (vendor === "Google Ads Viewthrough Conversion" || isGoogleAdsViewthroughConversion(url, h)) return "googleads_viewthroughconversion";
  if (vendor === "Google Ads Remarketing" || isGoogleAdsRmktCollect(url, h)) return "googleads_rmkt_collect";
  if (vendor === "Google Ads" && isGoogleAdsCcmCollect(url, h)) return "google_ccm_collect";
  if (vendor === "Google Ads" && isGoogleAdsConversion(url, h)) return "googleads_conversion";
  if (vendor === "Google Ads" && (u.includes("conversion") || u.includes("pagead/"))) return "googleads_other";
  if (vendor === "TikTok Pixel") return "tiktok_events";
  if (vendor === "Pinterest Tag") return "pinterest_v3";
  if (vendor === "Microsoft Ads (UET)") return "bing_uet";

  if (h.includes("google-analytics.com")) return "ga4_collect";
  if (h.includes("facebook.com") && u.includes("/tr/")) return "meta_tr";

  return "other";
}

function valueOrBlank(map, key) {
  if (!map.has(key)) return "";
  const v = map.get(key);
  if (v === null || v === undefined) return "";
  return String(v);
}

function extractUtmAndClickValues({ params, url }) {
  const out = {};

  const dl = pick(params, ["dl", "page_location", "document_location", "url"]);
  let dlUrl = null;

  try {
    dlUrl = dl ? new URL(dl) : null;
  } catch {
    dlUrl = null;
  }

  for (const k of UTM_KEYS) {
    out[k] = valueOrBlank(params, k);
    if (!out[k] && dlUrl) out[k] = dlUrl.searchParams.get(k) || "";
    if (!out[k]) {
      try {
        const ru = new URL(url);
        out[k] = ru.searchParams.get(k) || "";
      } catch {}
    }
  }

  for (const k of CLICK_ID_KEYS) {
    out[k] = valueOrBlank(params, k);
    if (!out[k] && dlUrl) out[k] = dlUrl.searchParams.get(k) || "";
    if (!out[k]) {
      try {
        const ru = new URL(url);
        out[k] = ru.searchParams.get(k) || "";
      } catch {}
    }
  }

  return out;
}

function stringifyKeyValues(map, keys, maxPairs = 30, maxValueLen = 120) {
  const pairs = [];

  for (const k of keys) {
    if (!map.has(k)) continue;

    let v = String(map.get(k) ?? "");
    if (v.length > maxValueLen) v = v.slice(0, maxValueLen) + "…";

    pairs.push(`${k}=${v}`);

    if (pairs.length >= maxPairs) break;
  }

  return pairs.join(", ");
}

function normaliseTagId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  const aw = s
    .split(",")
    .map((x) => x.trim())
    .find((x) => x.startsWith("AW-"));

  return aw || s;
}

function normaliseProductIds(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(",");
}

function countProductIds(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;

  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean).length;
}

function extractGoogleAdsCommerceFields(params) {
  const googleBusinessVertical = pick(params, [
    "google_business_vertical",
    "data.google_business_vertical",
    "ecomm_pagetype",
    "data.ecomm_pagetype",
  ]);

  const productIdsRaw = pick(params, [
    "id",
    "data.id",
    "ecomm_prodid",
    "data.ecomm_prodid",
    "items",
    "ep.items",
    "ep.ecomm_prodid",
  ]);

  return {
    googleBusinessVertical,
    productIds: normaliseProductIds(productIdsRaw),
    productIdCount: countProductIds(productIdsRaw),
  };
}

function extractEventRow({ entry, vendorMeta, pageType, harFile, mode, continuityState }) {
  const url = entry?.request?.url || "";
  const params = toParamMapFromHarEntry(entry);
  const endpointType = detectEndpointType(url, vendorMeta.vendor);
  const utmAndClicks = extractUtmAndClickValues({ params, url });
  const commerce = extractGoogleAdsCommerceFields(params);

  let eventName = "";
  let tagId = "";
  let conversionLabel = "";

  let hasValue = false;
  let hasCurrency = false;
  let hasItems = false;
  let hasTransactionId = false;
  let hasEventId = false;

  if (endpointType === "ga4_collect") {
    eventName = pick(params, ["en", "event_name"]);
    tagId = pick(params, ["tid", "measurement_id"]);

    hasValue = hasAny(params, ["value", "ep.value", "epn.value", "ev"]);
    hasCurrency = hasAny(params, ["currency", "ep.currency"]);
    hasTransactionId = hasAny(params, ["transaction_id", "ep.transaction_id", "ep.transactionid"]);
    hasItems = hasAny(params, ["items", "ep.items", "ep.items[]", "ep.ecomm_prodid", "ep.ecomm_pagetype", "ep.ecomm_category"]);
    hasEventId = hasAny(params, ["event_id", "ep.event_id", "eid"]);

    if (mode === "probe") {
      const hasAnyUtmNow = UTM_KEYS.some((k) => (utmAndClicks[k] || "").length);

      if (!continuityState.seenFirstPageView && eventName === "page_view") {
        continuityState.seenFirstPageView = true;
        continuityState.firstPageViewHasUtm = hasAnyUtmNow;
      } else if (continuityState.seenFirstPageView && continuityState.firstPageViewHasUtm && eventName === "page_view") {
        if (!hasAnyUtmNow && !continuityState.utmLost) {
          continuityState.utmLost = true;
          continuityState.utmLossEvidence = { eventName, pageType, harFile };
        }
      }
    }
  } else if (endpointType === "meta_tr") {
    eventName = pick(params, ["ev"]);
    tagId = pick(params, ["id"]);

    hasValue = hasAny(params, ["cd[value]", "value"]);
    hasCurrency = hasAny(params, ["cd[currency]", "currency"]);
    hasItems = hasAny(params, ["cd[content_ids]", "cd[contents]", "content_ids", "contents"]);
    hasTransactionId = hasAny(params, ["cd[order_id]", "cd[transaction_id]", "order_id", "transaction_id"]);
    hasEventId = hasAny(params, ["eid", "event_id", "cd[event_id]"]);
  } else if (endpointType === "googleads_conversion") {
    conversionLabel = pick(params, ["label"]);
    tagId = pick(params, ["id"]) || extractGoogleAdsConversionId(url);

    eventName = pick(params, ["en", "event_name", "data.event"]) || "conversion";
    hasValue = hasAny(params, ["value"]);
    hasCurrency = hasAny(params, ["currency_code", "currency"]);
    hasTransactionId = hasAny(params, ["transaction_id", "oid", "order_id"]);
    hasEventId = hasAny(params, ["event_id", "eid"]);
    hasItems = hasAny(params, ["id", "data.id", "ecomm_prodid", "data.ecomm_prodid"]);
  } else if (endpointType === "googleads_viewthroughconversion") {
    conversionLabel = pick(params, ["label"]);
    tagId = extractGoogleAdsViewthroughId(url) || pick(params, ["id"]);

    eventName = pick(params, ["en", "event_name", "data.event"]) || "viewthrough_conversion";
    hasValue = hasAny(params, ["value", "data.value", "ep.value", "epn.value", "ev"]);
    hasCurrency = hasAny(params, ["currency", "currency_code", "data.currency", "ep.currency"]);
    hasTransactionId = hasAny(params, ["transaction_id", "data.transaction_id", "oid", "order_id"]);
    hasItems = hasAny(params, ["id", "data.id", "ecomm_prodid", "data.ecomm_prodid"]);
    hasEventId = hasAny(params, ["event_id", "ep.event_id", "eid"]);
  } else if (endpointType === "google_ccm_collect") {
    eventName = pick(params, ["en", "event_name", "data.event"]);
    tagId = normaliseTagId(pick(params, ["tid", "tids"]));

    hasValue = hasAny(params, ["value", "data.value", "ep.value", "epn.value", "ev"]);
    hasCurrency = hasAny(params, ["currency", "currency_code", "data.currency", "ep.currency"]);
    hasTransactionId = hasAny(params, ["transaction_id", "data.transaction_id", "ep.transaction_id", "oid", "order_id"]);
    hasItems = hasAny(params, ["id", "data.id", "items", "ep.items", "ep.items[]", "ep.ecomm_prodid", "ep.ecomm_pagetype", "ep.ecomm_category"]);
    hasEventId = hasAny(params, ["event_id", "ep.event_id", "eid"]);
  } else if (endpointType === "googleads_rmkt_collect") {
    eventName = pick(params, ["en", "event_name", "data.event"]) || "remarketing";
    tagId = vendorMeta.identifier || extractGoogleAdsRmktId(url) || normaliseTagId(pick(params, ["tid", "tids", "id"]));

    hasValue = hasAny(params, ["value", "data.value", "ep.value", "epn.value", "ev"]);
    hasCurrency = hasAny(params, ["currency", "currency_code", "data.currency", "ep.currency"]);
    hasTransactionId = hasAny(params, ["transaction_id", "data.transaction_id", "ep.transaction_id", "oid", "order_id"]);
    hasItems = hasAny(params, ["id", "data.id", "items", "ep.items", "ep.items[]", "ecomm_prodid", "ecomm_pagetype", "ecomm_category"]);
    hasEventId = hasAny(params, ["event_id", "ep.event_id", "eid"]);
  } else if (endpointType === "tiktok_events") {
    eventName = pick(params, ["event", "event_name", "evt"]);
    tagId = pick(params, ["pixel_code", "pixel_id"]);

    hasValue = hasAny(params, ["value"]);
    hasCurrency = hasAny(params, ["currency"]);
    hasItems = hasAny(params, ["content_id", "content_ids", "contents", "items"]);
    hasTransactionId = hasAny(params, ["order_id", "transaction_id"]);
    hasEventId = hasAny(params, ["event_id", "eid"]);
  } else if (endpointType === "pinterest_v3") {
    eventName = pick(params, ["event", "ev"]);
    tagId = pick(params, ["tid"]);

    hasValue = hasAny(params, ["value"]);
    hasCurrency = hasAny(params, ["currency"]);
    hasItems = hasAny(params, ["item_ids", "product_ids", "items", "content_ids"]);
    hasTransactionId = hasAny(params, ["order_id", "transaction_id"]);
    hasEventId = hasAny(params, ["event_id", "eid"]);
  } else if (endpointType === "bing_uet") {
    eventName = pick(params, ["evt", "event", "ea"]);
    tagId = pick(params, ["ti"]);

    hasValue = hasAny(params, ["gv", "value"]);
    hasCurrency = hasAny(params, ["gc", "currency"]);
    hasItems = hasAny(params, ["items", "content_ids", "product_ids"]);
    hasTransactionId = hasAny(params, ["order_id", "transaction_id"]);
    hasEventId = hasAny(params, ["event_id", "eid"]);
  }

  const shouldKeep =
    Boolean(eventName) ||
    endpointType === "ga4_collect" ||
    endpointType === "meta_tr" ||
    endpointType === "googleads_conversion" ||
    endpointType === "googleads_viewthroughconversion" ||
    endpointType === "google_ccm_collect" ||
    endpointType === "googleads_rmkt_collect";

  if (!shouldKeep) return null;

  const keys = [...params.keys()];

  const importantKeys = [
    "en",
    "event_name",
    "data.event",
    "tid",
    "tids",
    "id",
    "data.id",
    "measurement_id",
    "dl",
    "page_location",
    "dt",
    "currency",
    "currency_code",
    "value",
    "transaction_id",
    "event_id",
    "gcd",
    "gcs",
    "gtm",
    "google_business_vertical",
    "data.google_business_vertical",
    "ecomm_prodid",
    "data.ecomm_prodid",
    "ecomm_pagetype",
    "data.ecomm_pagetype",
    "ecomm_category",
    "data.ecomm_category",
    "data",
    ...UTM_KEYS,
    ...CLICK_ID_KEYS,
  ];

  const epKeys = keys.filter((k) => k.startsWith("ep.") || k.startsWith("epn.") || k.includes("ecomm") || k.startsWith("data."));
  const orderedKeys = [...new Set([...importantKeys, ...epKeys, ...keys])];

  const paramKeysCsv = orderedKeys.filter((k) => params.has(k)).slice(0, 80).join(", ");
  const paramSample = stringifyKeyValues(params, orderedKeys, 50, 160);

  const isProbeVisit = mode === "probe" ? "Y" : "N";

  let utmContinuityStatus = "";
  if (mode === "probe" && continuityState.seenFirstPageView) {
    if (!continuityState.firstPageViewHasUtm) utmContinuityStatus = "NOT_OBSERVED";
    else utmContinuityStatus = continuityState.utmLost ? "LOST_AFTER_FIRST_PAGEVIEW" : "OK";
  }

  return {
    Vendor: vendorMeta.vendor,
    EndpointType: endpointType,
    EventName: eventName || "",
    TagId: tagId || vendorMeta.identifier || "",
    ConversionLabel: conversionLabel || "",
    GoogleBusinessVertical: commerce.googleBusinessVertical || "",
    ProductIds: commerce.productIds || "",
    ProductIdCount: commerce.productIdCount || 0,
    PageType: pageType,
    SourceHarFile: harFile,

    HasValue: hasValue ? "Y" : "N",
    HasCurrency: hasCurrency ? "Y" : "N",
    HasItems: hasItems ? "Y" : "N",
    HasTransactionId: hasTransactionId ? "Y" : "N",
    HasEventId: hasEventId ? "Y" : "N",

    IsProbeVisit: isProbeVisit,
    UtmSource: utmAndClicks.utm_source || "",
    UtmMedium: utmAndClicks.utm_medium || "",
    UtmCampaign: utmAndClicks.utm_campaign || "",
    UtmContent: utmAndClicks.utm_content || "",
    UtmTerm: utmAndClicks.utm_term || "",
    Gclid: utmAndClicks.gclid || "",
    Gbraid: utmAndClicks.gbraid || "",
    Wbraid: utmAndClicks.wbraid || "",
    Fbclid: utmAndClicks.fbclid || "",
    Ttclid: utmAndClicks.ttclid || "",
    UtmContinuityStatus: utmContinuityStatus,

    ObservedParamKeys: paramKeysCsv,
    ObservedParamSample: paramSample,
  };
}

function sheetFromJson(rows) {
  return XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{ Note: "No rows" }], { skipHeader: false });
}

function upsertSheet(wb, sheetName, ws) {
  if (wb.SheetNames.includes(sheetName)) {
    delete wb.Sheets[sheetName];
    wb.SheetNames = wb.SheetNames.filter((n) => n !== sheetName);
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

function readWorkbookIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return XLSX.utils.book_new();
    return XLSX.readFile(filePath);
  } catch {
    return XLSX.utils.book_new();
  }
}

function writeWorkbook(filePath, wb) {
  XLSX.writeFile(wb, filePath, { bookType: "xlsx" });
}

function extractLandingUrlClickIds(entries) {
  for (const e of entries) {
    const u = e?.request?.url;
    if (!u) continue;

    const mime = (e?.response?.content?.mimeType || "").toLowerCase();
    if (mime && !mime.includes("text/html") && !mime.includes("application/xhtml")) continue;

    try {
      const U = new URL(u);
      const hit = {};
      let any = false;

      for (const k of CLICK_ID_KEYS) {
        const v = U.searchParams.get(k) || "";
        hit[k] = v;
        if (v) any = true;
      }

      if (any) return hit;
    } catch {}
  }

  for (const e of entries) {
    const u = e?.request?.url;
    if (!u) continue;

    try {
      const U = new URL(u);
      const hit = {};
      let any = false;

      for (const k of CLICK_ID_KEYS) {
        const v = U.searchParams.get(k) || "";
        hit[k] = v;
        if (v) any = true;
      }

      if (any) return hit;
    } catch {}
  }

  return Object.fromEntries(CLICK_ID_KEYS.map((k) => [k, ""]));
}

function buildSummary({ domain, mode, harCount, tagRows, eventRows, unknownCount, continuityState }) {
  const summary = [];

  summary.push({ Metric: "Domain", Value: domain });
  summary.push({ Metric: "Mode", Value: mode });
  summary.push({ Metric: "HAR files parsed", Value: String(harCount) });
  summary.push({ Metric: "Unique tags detected", Value: String(tagRows.length) });
  summary.push({ Metric: "Event rows detected", Value: String(eventRows.length) });
  summary.push({ Metric: "Unknown third-party hosts (current run)", Value: String(unknownCount) });

  if (mode === "probe") {
    const utmEntry = continuityState.seenFirstPageView
      ? continuityState.firstPageViewHasUtm
        ? "Yes"
        : "No (not observed on first GA4 page_view)"
      : "No (no GA4 page_view observed)";

    summary.push({ Metric: "UTMs observed on first GA4 page_view", Value: utmEntry });

    const utmLoss =
      continuityState.seenFirstPageView && continuityState.firstPageViewHasUtm
        ? continuityState.utmLost
          ? "Yes"
          : "No"
        : "N/A";

    summary.push({ Metric: "UTMs lost after first page_view", Value: utmLoss });

    if (continuityState.utmLost && continuityState.utmLossEvidence) {
      summary.push({
        Metric: "First UTM loss evidence",
        Value: `${continuityState.utmLossEvidence.eventName} @ ${continuityState.utmLossEvidence.pageType} (${continuityState.utmLossEvidence.harFile})`,
      });
    }
  }

  return summary;
}

function computeDeltaSummary(wb) {
  if (!wb.SheetNames.includes("baseline_event_inventory")) return null;
  if (!wb.SheetNames.includes("probe_event_inventory")) return null;

  const base = XLSX.utils.sheet_to_json(wb.Sheets["baseline_event_inventory"], { defval: "" });
  const probe = XLSX.utils.sheet_to_json(wb.Sheets["probe_event_inventory"], { defval: "" });

  const probeUtmContinuity = (() => {
    const any = probe.find((r) => r.UtmContinuityStatus);
    return any ? any.UtmContinuityStatus : "";
  })();

  const utmEntryObserved = probe.some((r) => r.UtmSource || r.UtmMedium || r.UtmCampaign || r.UtmContent || r.UtmTerm);
  const utmLost = probeUtmContinuity === "LOST_AFTER_FIRST_PAGEVIEW";

  const baseEvents = new Set(base.map((r) => [r.Vendor, r.EndpointType, r.EventName, r.PageType].join("|")));
  const probeEvents = new Set(probe.map((r) => [r.Vendor, r.EndpointType, r.EventName, r.PageType].join("|")));

  let onlyInProbe = 0;
  for (const k of probeEvents) {
    if (!baseEvents.has(k)) onlyInProbe++;
  }

  return [
    { Insight: "UTMs observed in probe events", Value: utmEntryObserved ? "Yes" : "No" },
    { Insight: "UTM continuity status (probe)", Value: probeUtmContinuity || "N/A" },
    { Insight: "UTMs lost after first page_view (probe)", Value: utmLost ? "Yes" : "No" },
    { Insight: "Event signatures only seen in probe", Value: String(onlyInProbe) },
  ];
}

function writeUnknownCsv(filePath, rows) {
  const headers = ["Category", "Identifier", "Host", "RequestCount", "ExampleURL"];

  const csv =
    headers.map(safeCsv).join(",") +
    "\n" +
    rows.map((r) => headers.map((h) => safeCsv(r[h] ?? "")).join(",")).join("\n") +
    "\n";

  fs.writeFileSync(filePath, csv, "utf8");
}

(async () => {
  const arg = process.argv[2];
  const probe = process.argv.includes("--probe");
  const force = process.argv.includes("--force");

  const domain = normaliseInputToDomain(arg, process.argv.slice(3));

  if (!domain) {
    console.error("Usage: node scripts/phase1-tag-inventory.js <domain or url> [--probe] [--force]");
    process.exit(1);
  }

  const mode = probe ? "probe" : "baseline";

  const domainDir = path.join(DATA_DIR, domain);
  const harDir = path.join(domainDir, probe ? "har_probe" : "har");
  const analysisDir = path.join(domainDir, "analysis");

  ensureDir(analysisDir);

  if (!fs.existsSync(harDir)) {
    console.error(`HAR folder not found: ${harDir}`);
    process.exit(1);
  }

  const harFiles = fs.readdirSync(harDir).filter((f) => f.toLowerCase().endsWith(".har")).sort();

  if (!harFiles.length) {
    console.error(`No .har files found in: ${harDir}`);
    process.exit(1);
  }

  const harPaths = harFiles.map((f) => path.join(harDir, f));
  const newestHar = newestMtimeMs(harPaths);

  const xlsxPath = path.join(analysisDir, "phase1_inventory.xlsx");
  const unknownCsvPath = path.join(analysisDir, "unknown_vendors.csv");

  if (!force && fs.existsSync(xlsxPath)) {
    try {
      const wbM = fs.statSync(xlsxPath).mtimeMs;

      if (wbM >= newestHar) {
        console.log(`\n[Skip] phase1_inventory.xlsx looks up-to-date for ${domain} (${mode}). Use --force to re-run.\n`);
        process.exit(0);
      }
    } catch {}
  }

  const tagAgg = new Map();
  const unknownAgg = new Map();
  const eventRows = [];

  const continuityState = {
    seenFirstPageView: false,
    firstPageViewHasUtm: false,
    utmLost: false,
    utmLossEvidence: null,
  };

  for (const f of harFiles) {
    const p = path.join(harDir, f);

    let entries = [];

    try {
      entries = parseHarFile(p);
    } catch {
      console.warn(`Skipping unreadable HAR: ${f}`);
      continue;
    }

    if (probe) extractLandingUrlClickIds(entries);

    const pageType = inferPageTypeFromHarFilename(f.toLowerCase());

    for (const entry of entries) {
      const reqUrl = entry?.request?.url;
      if (!reqUrl) continue;

      const meta = classify(reqUrl, domain);

      const tagKey = [meta.vendor, meta.category, meta.identifier, meta.host].join("|");

      if (!tagAgg.has(tagKey)) {
        tagAgg.set(tagKey, {
          Vendor: meta.vendor,
          Category: meta.category,
          Identifier: meta.identifier,
          Host: meta.host,
          FirstParty: meta.firstParty ? "Yes" : "No",
          RequestCount: 0,
          PagesSeenOn: new Set(),
          ExampleURL: summariseExample(reqUrl),
        });
      }

      const t = tagAgg.get(tagKey);
      t.RequestCount += 1;
      t.PagesSeenOn.add(f);

      if (meta.vendor === "Unknown third-party" && meta.category === "Unknown") {
        const h = meta.host || "";

        if (h) {
          if (!unknownAgg.has(h)) {
            unknownAgg.set(h, {
              Category: "Unknown",
              Identifier: "",
              Host: h,
              RequestCount: 0,
              ExampleURL: summariseExample(reqUrl),
            });
          }

          unknownAgg.get(h).RequestCount += 1;
        }
      }

      const ev = extractEventRow({
        entry,
        vendorMeta: meta,
        pageType,
        harFile: f,
        mode,
        continuityState,
      });

      if (ev) eventRows.push(ev);
    }
  }

  const tagRows = [...tagAgg.values()]
    .map((r) => ({
      Vendor: r.Vendor,
      Category: r.Category,
      Identifier: r.Identifier,
      Host: r.Host,
      FirstParty: r.FirstParty,
      RequestCount: r.RequestCount,
      PagesSeenOn: [...r.PagesSeenOn].join("; "),
      ExampleURL: r.ExampleURL,
    }))
    .sort((a, b) => {
      const ak = a.Vendor.startsWith("Unknown") ? 2 : a.Vendor.startsWith("First-party") ? 1 : 0;
      const bk = b.Vendor.startsWith("Unknown") ? 2 : b.Vendor.startsWith("First-party") ? 1 : 0;

      if (ak !== bk) return ak - bk;

      return Number(b.RequestCount) - Number(a.RequestCount);
    });

  const seenEventKeys = new Set();
  const dedupedEvents = [];

  for (const r of eventRows) {
    const k = [
      r.Vendor,
      r.EndpointType,
      r.EventName,
      r.TagId,
      r.ConversionLabel,
      r.GoogleBusinessVertical,
      r.ProductIds,
      r.ProductIdCount,
      r.PageType,
      r.SourceHarFile,
      r.HasValue,
      r.HasCurrency,
      r.HasItems,
      r.HasTransactionId,
      r.HasEventId,
      r.UtmSource,
      r.UtmMedium,
      r.UtmCampaign,
      r.UtmContent,
      r.UtmTerm,
      r.Gclid,
      r.Gbraid,
      r.Wbraid,
      r.Fbclid,
      r.Ttclid,
    ].join("|");

    if (seenEventKeys.has(k)) continue;

    seenEventKeys.add(k);
    dedupedEvents.push(r);
  }

  const unknownRows = [...unknownAgg.values()].sort((a, b) => (b.RequestCount || 0) - (a.RequestCount || 0));

  writeUnknownCsv(unknownCsvPath, unknownRows);

  const wb = readWorkbookIfExists(xlsxPath);

  const summaryRows = buildSummary({
    domain,
    mode,
    harCount: harFiles.length,
    tagRows,
    eventRows: dedupedEvents,
    unknownCount: unknownRows.length,
    continuityState,
  });

  const prefix = probe ? "probe" : "baseline";

  upsertSheet(wb, `${prefix}_summary`, sheetFromJson(summaryRows));
  upsertSheet(wb, `${prefix}_tag_inventory`, sheetFromJson(tagRows));
  upsertSheet(wb, `${prefix}_event_inventory`, sheetFromJson(dedupedEvents));
  upsertSheet(wb, "unknown_vendors", sheetFromJson(unknownRows));

  const delta = computeDeltaSummary(wb);
  if (delta) upsertSheet(wb, "delta_summary", sheetFromJson(delta));

  writeWorkbook(xlsxPath, wb);

  console.log(`\n[OK] Parsed ${harFiles.length} HAR files for ${domain} (${mode})`);
  console.log(`[OUT] ${xlsxPath}`);
  console.log(`[OUT] ${unknownCsvPath}\n`);
})();