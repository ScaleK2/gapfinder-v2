/**
 * score-gapfinder.js
 *
 * Produces deterministic commercial signal scorecard with:
 * - non-overlap metric ownership
 * - not-observable denominator logic
 * - confidence/caps
 * - evidence-backed critical issue ranking
 *
 * Inputs:
 *  data/<domain>/analysis/phase1_inventory.xlsx
 *  data/<domain>/analysis/psi.json (optional)
 *
 * Output:
 *  data/<domain>/analysis/scorecard.json
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { loadDotEnv, parseAuditInput, parseScopeOptions } = require("./audit-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

loadDotEnv(ROOT);

const CATEGORIES = {
  tracking_foundation: { weight: 15 },
  event_signal_integrity: { weight: 25 },
  ecommerce_signal_quality: { weight: 25 },
  behavioural_observability: { weight: 15 },
  platform_signal_alignment: { weight: 10 },
  performance_friction: { weight: 10 },
};

function normaliseInputToDomain(input, args = []) {
  const audit = parseAuditInput(input, parseScopeOptions(args));
  return audit ? audit.auditKey : null;
}

function readXlsxRows(file, sheetName) {
  if (!fs.existsSync(file)) return [];
  const wb = XLSX.readFile(file);
  if (!wb.Sheets[sheetName]) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function toBoolYes(v) {
  return String(v || "").toLowerCase() === "yes";
}

function countWhere(rows, fn) {
  let n = 0;
  for (const r of rows) if (fn(r)) n++;
  return n;
}

function categoryScore(rules, confidenceCap = 100) {
  const observable = rules.filter((r) => r.state !== "not_observable");
  const denom = observable.reduce((s, r) => s + r.points, 0);
  const numer = observable.reduce((s, r) => s + (r.state === "pass" ? r.points : 0), 0);

  const raw = denom > 0 ? (numer / denom) * 100 : 0;
  return {
    rules,
    denominator_points: denom,
    numerator_points: numer,
    raw_score: +raw.toFixed(2),
    capped_score: +Math.min(raw, confidenceCap).toFixed(2),
    observability: denom > 0 ? "observable" : "insufficient_evidence",
  };
}

function confidenceFromEvidence(evidenceCount, thresholds) {
  if (evidenceCount >= thresholds.high) return "high";
  if (evidenceCount >= thresholds.medium) return "medium";
  return "low";
}

function capForConfidence(level) {
  if (level === "high") return 100;
  if (level === "medium") return 85;
  return 70;
}

function build(domain) {
  const analysisDir = path.join(DATA_DIR, domain, "analysis");
  const xlsxPath = path.join(analysisDir, "phase1_inventory.xlsx");
  const psiPath = path.join(analysisDir, "psi.json");

  const tagRows = readXlsxRows(xlsxPath, "baseline_tag_inventory");
  const eventRows = readXlsxRows(xlsxPath, "baseline_event_inventory");
  const psi = readJsonIfExists(psiPath);

  const vendors = new Set(tagRows.map((r) => String(r.Vendor || "")).filter(Boolean));
  const cats = new Set(tagRows.map((r) => String(r.Category || "")).filter(Boolean));

  const hasGtm = [...vendors].some((v) => v.includes("Google Tag Manager"));
  const hasAnalytics = [...cats].some((c) => /analytics/i.test(c)) || [...vendors].some((v) => /Google Analytics|GA4/i.test(v));
  const hasPaidSignals = [...cats].some((c) => /ads/i.test(c)) || [...vendors].some((v) => /Google Ads|Meta|TikTok|Microsoft Ads|Pinterest/i.test(v));

  const tracking = categoryScore([
    { metric: "analytics_present", points: 5, owner: "tracking_foundation", state: hasAnalytics ? "pass" : "fail" },
    { metric: "tag_manager_present", points: 5, owner: "tracking_foundation", state: hasGtm ? "pass" : "fail" },
    { metric: "paid_platform_signals_present", points: 5, owner: "tracking_foundation", state: hasPaidSignals ? "pass" : "fail" },
  ], 100);

  const normalizedEvents = eventRows.map((r) => String(r.EventName || "").trim()).filter(Boolean);
  const duplicateRate = normalizedEvents.length ? 1 - new Set(normalizedEvents).size / normalizedEvents.length : 0;
  const pollutedCount = countWhere(eventRows, (r) => String(r.EventName || "").toLowerCase() === "undefined" || String(r.EventName || "").trim() === "");
  const pdpEvents = eventRows.filter((r) => String(r.PageType || "").toLowerCase() === "pdp");
  const hasPdpSignal = pdpEvents.length > 0;

  const integrityEvidence = eventRows.length;
  const integrityConfidence = confidenceFromEvidence(integrityEvidence, { high: 30, medium: 10 });
  const integrity = categoryScore([
    { metric: "event_naming_present", points: 8, owner: "event_signal_integrity", state: normalizedEvents.length ? "pass" : "fail" },
    { metric: "low_duplicate_pressure", points: 8, owner: "event_signal_integrity", state: duplicateRate <= 0.4 ? "pass" : "fail", evidence: { duplicateRate: +duplicateRate.toFixed(3) } },
    { metric: "low_signal_pollution", points: 4, owner: "event_signal_integrity", state: pollutedCount <= 2 ? "pass" : "fail", evidence: { pollutedCount } },
    { metric: "pdp_behavior_logic_observed", points: 5, owner: "event_signal_integrity", state: hasPdpSignal ? "pass" : "not_observable" },
  ], capForConfidence(integrityConfidence));

  const ecommerceRows = eventRows.filter((r) => String(r.ProductIdCount || "") !== "" || toBoolYes(r.HasItems) || toBoolYes(r.HasValue));
  const valueRows = countWhere(eventRows, (r) => toBoolYes(r.HasValue));
  const currencyRows = countWhere(eventRows, (r) => toBoolYes(r.HasCurrency));
  const itemRows = countWhere(eventRows, (r) => toBoolYes(r.HasItems));
  const txnRows = countWhere(eventRows, (r) => toBoolYes(r.HasTransactionId));

  const ecommerceConfidence = confidenceFromEvidence(ecommerceRows.length, { high: 15, medium: 5 });
  const ecommerce = categoryScore([
    { metric: "product_identity_present", points: 8, owner: "ecommerce_signal_quality", state: ecommerceRows.length ? "pass" : "fail" },
    { metric: "value_signal_present", points: 6, owner: "ecommerce_signal_quality", state: valueRows > 0 ? "pass" : "not_observable" },
    { metric: "currency_signal_present", points: 4, owner: "ecommerce_signal_quality", state: currencyRows > 0 ? "pass" : "not_observable" },
    { metric: "items_payload_present", points: 4, owner: "ecommerce_signal_quality", state: itemRows > 0 ? "pass" : "not_observable" },
    { metric: "transaction_integrity_observed", points: 3, owner: "ecommerce_signal_quality", state: txnRows > 0 ? "pass" : "not_observable" },
  ], capForConfidence(ecommerceConfidence));

  const uniquePageTypes = new Set(eventRows.map((r) => String(r.PageType || "").toLowerCase()).filter(Boolean));
  const hasProgression = ["category", "pdp", "cart", "checkout"].some((p) => uniquePageTypes.has(p));
  const observabilityConfidence = confidenceFromEvidence(uniquePageTypes.size, { high: 4, medium: 2 });
  const observability = categoryScore([
    { metric: "page_level_behavior_visible", points: 5, owner: "behavioural_observability", state: uniquePageTypes.size > 0 ? "pass" : "fail" },
    { metric: "product_level_behavior_visible", points: 5, owner: "behavioural_observability", state: uniquePageTypes.has("pdp") ? "pass" : "fail" },
    { metric: "progression_signals_visible", points: 5, owner: "behavioural_observability", state: hasProgression ? "pass" : "fail" },
  ], capForConfidence(observabilityConfidence));

  const gaLike = countWhere(eventRows, (r) => /ga4|google analytics/i.test(String(r.Vendor || "")));
  const adsLike = countWhere(eventRows, (r) => /google ads|meta|tiktok|microsoft ads|pinterest/i.test(String(r.Vendor || "")));
  const productIdRows = countWhere(eventRows, (r) => String(r.ProductIds || "").trim() !== "");
  const alignmentConfidence = confidenceFromEvidence(gaLike + adsLike, { high: 20, medium: 8 });
  const alignment = categoryScore([
    { metric: "analytics_intent_visible", points: 4, owner: "platform_signal_alignment", state: gaLike > 0 ? "pass" : "fail" },
    { metric: "ads_intent_visible", points: 3, owner: "platform_signal_alignment", state: adsLike > 0 ? "pass" : "fail" },
    { metric: "shared_product_identity_observed", points: 3, owner: "platform_signal_alignment", state: productIdRows > 0 ? "pass" : "not_observable" },
  ], capForConfidence(alignmentConfidence));

  const homePsi = psi?.targets?.home;
  const mobile = homePsi?.mobile || null;
  const desktop = homePsi?.desktop || null;

  const perfConfidence = homePsi ? "high" : "low";
  const performance = categoryScore([
    { metric: "psi_mobile_perf", points: 4, owner: "performance_friction", state: mobile?.performance >= 50 ? "pass" : homePsi ? "fail" : "not_observable" },
    { metric: "psi_desktop_perf", points: 3, owner: "performance_friction", state: desktop?.performance >= 70 ? "pass" : homePsi ? "fail" : "not_observable" },
    { metric: "lcp_within_target", points: 2, owner: "performance_friction", state: mobile?.lcp_s !== null && mobile?.lcp_s <= 4 ? "pass" : homePsi ? "fail" : "not_observable" },
    { metric: "cls_within_target", points: 1, owner: "performance_friction", state: mobile?.cls !== null && mobile?.cls <= 0.25 ? "pass" : homePsi ? "fail" : "not_observable" },
  ], capForConfidence(perfConfidence));

  const scored = {
    tracking_foundation: { ...tracking, confidence: "high" },
    event_signal_integrity: { ...integrity, confidence: integrityConfidence },
    ecommerce_signal_quality: { ...ecommerce, confidence: ecommerceConfidence },
    behavioural_observability: { ...observability, confidence: observabilityConfidence },
    platform_signal_alignment: { ...alignment, confidence: alignmentConfidence },
    performance_friction: { ...performance, confidence: perfConfidence },
  };

  let overall = 0;
  for (const [k, meta] of Object.entries(CATEGORIES)) {
    overall += (scored[k].capped_score / 100) * meta.weight;
  }

  const issues = [];
  function addIssue(code, severity, impact, confidence, effort, evidence, recommendation) {
    const sev = { critical: 5, high: 4, medium: 3, low: 2 }[severity] || 1;
    const imp = { extreme: 5, high: 4, medium: 3, low: 2 }[impact] || 1;
    const conf = { high: 3, medium: 2, low: 1 }[confidence] || 1;
    const eff = { s: 1, m: 2, l: 3 }[effort] || 2;
    const priority_score = +(sev * imp * conf / eff).toFixed(2);
    issues.push({ code, severity, impact, confidence, effort, priority_score, evidence, recommendation });
  }

  if (!hasAnalytics) addIssue("FOUNDATION_ANALYTICS_MISSING", "critical", "extreme", "high", "m", { categories: [...cats] }, "Implement GA4 baseline instrumentation via GTM.");
  if (!hasGtm) addIssue("FOUNDATION_TAG_MANAGER_MISSING", "high", "high", "high", "s", { vendors: [...vendors] }, "Deploy GTM (or equivalent TMS) to centralize signal management.");
  if (duplicateRate > 0.4) addIssue("EVENT_DUPLICATION_PRESSURE", "high", "high", integrityConfidence, "m", { duplicateRate: +duplicateRate.toFixed(3), eventRows: eventRows.length }, "Reduce duplicate/conflicting event emissions and standardize naming.");
  if (ecommerceRows.length === 0) addIssue("ECOMMERCE_IDENTITY_WEAK", "high", "high", ecommerceConfidence, "m", { eventRows: eventRows.length }, "Ensure product/item identity fields are emitted in observable events.");
  if (homePsi && mobile?.performance < 50) addIssue("PERFORMANCE_MOBILE_FRICTION", "medium", "medium", "high", "m", { mobilePerformance: mobile?.performance, lcp_s: mobile?.lcp_s, cls: mobile?.cls }, "Prioritize LCP/TBT improvements on mobile landing and product pages.");

  issues.sort((a, b) => b.priority_score - a.priority_score);

  return {
    domain,
    generatedAt: new Date().toISOString(),
    modelVersion: "2026-05-13.1",
    scoringPrinciples: {
      nonOverlapMetricOwnership: true,
      notObservableDenominatorLogic: true,
      confidenceCaps: { high: 100, medium: 85, low: 70 },
      deterministicRuleFormulas: true,
      evidenceBackedCriticalIssueRanking: true,
    },
    categoryWeights: CATEGORIES,
    categories: scored,
    categoryScores: Object.fromEntries(Object.entries(scored).map(([k, v]) => [k, v.capped_score])),
    overallScore: +overall.toFixed(2),
    criticalIssues: issues,
    focusFirst: issues.slice(0, 3).map((x) => ({ code: x.code, recommendation: x.recommendation })),
    observabilityNotes: {
      checkoutAndPurchaseCanBeNotObservable: true,
      utmPersistenceNotDirectlyMeasured: true,
    },
  };
}

(function main() {
  const arg = process.argv[2];
  const domain = normaliseInputToDomain(arg, process.argv.slice(3));
  if (!domain) {
    console.error("Usage: node scripts/score-gapfinder.js <domain or url>");
    process.exit(1);
  }

  const out = build(domain);
  const analysisDir = path.join(DATA_DIR, domain, "analysis");
  fs.mkdirSync(analysisDir, { recursive: true });
  const outPath = path.join(analysisDir, "scorecard.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`[OUT] ${outPath}`);
})();
