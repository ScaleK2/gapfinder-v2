const fs = require("fs");
const path = require("path");

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function stripWww(hostname) {
  return String(hostname || "").replace(/^www\./i, "");
}

function cleanScopePath(pathname) {
  let p = String(pathname || "/");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/g, "");
  if (!p || p === "/") return "";
  return p;
}

function auditKeyFromParts(hostname, scopePath = "") {
  const host = stripWww(hostname);
  const scope = cleanScopePath(scopePath);
  if (!scope) return host;

  const suffix = scope
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("__");

  return suffix ? `${host}__${suffix}` : host;
}

function parseAuditInput(input, opts = {}) {
  if (!input) return null;

  try {
    const raw = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const u = new URL(raw);
    const host = stripWww(u.hostname);

    const cliScope = opts.scopePath !== undefined ? opts.scopePath : null;
    const inferredScope = opts.global ? "" : cleanScopePath(u.pathname);
    const scopePath = cleanScopePath(cliScope !== null ? cliScope : inferredScope);
    const scopeMode = scopePath ? (opts.scopeMode || "soft") : "global";

    return {
      input,
      origin: u.origin,
      host,
      hostname: u.hostname,
      scopePath,
      scopeMode,
      auditKey: auditKeyFromParts(u.hostname, scopePath),
      homeUrl: new URL(scopePath || "/", u.origin).toString().replace(/\/$/, scopePath ? "" : "/"),
    };
  } catch {
    return null;
  }
}

function getFlagValue(args, name) {
  const eqPrefix = `${name}=`;
  const eq = args.find((arg) => arg.startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);

  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];

  return null;
}

function parseScopeOptions(args) {
  const explicitScope = getFlagValue(args, "--scope-path");
  const explicitMode = getFlagValue(args, "--scope-mode");
  const strict = args.includes("--scope-strict") || explicitMode === "strict";
  const global = args.includes("--global") || explicitMode === "global" || explicitMode === "none";

  return {
    scopePath: explicitScope !== null ? explicitScope : undefined,
    scopeMode: strict ? "strict" : "soft",
    global,
  };
}

function dataDirForInput(rootDir, input, opts = {}) {
  const parsed = parseAuditInput(input, opts);
  if (!parsed) return null;
  return path.join(rootDir, "data", parsed.auditKey);
}

module.exports = {
  auditKeyFromParts,
  cleanScopePath,
  dataDirForInput,
  getFlagValue,
  loadDotEnv,
  parseAuditInput,
  parseScopeOptions,
  stripWww,
};
