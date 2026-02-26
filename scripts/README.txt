# GapFinder Scripts

This folder contains **all executable logic** for the GapFinder system.

Scripts are single-responsibility, deterministic, and write outputs
only to defined locations in the parent directory.

No script should contain business narrative or client-facing language.

---

## Script Contracts

Each script must define:
- Inputs (what it reads)
- Outputs (what it writes)
- Side effects (if any)

Scripts must never:
- write data into the scripts folder
- create ad-hoc files
- duplicate functionality of another script

---

## Current Scripts

### crawl-domain.js
**Purpose**
- Discover internal, same-origin URLs for a given domain

**Inputs**
- Domain URL (CLI argument)

**Outputs**
- `data/urls.txt`

**Notes**
- Sitemap-first, browser crawl fallback
- Strict limits on depth and volume
- Strips query strings and fragments by default

---

### capture-har.js
**Purpose**
- Capture runtime network activity for each URL

**Inputs**
- `data/urls.txt`

**Outputs**
- `data/har/*.har`

**Notes**
- Uses Playwright + Chromium
- Hardened for stability and repeatability
- One HAR per URL
- Skips URLs already captured

---

### parse-har.js (planned)
**Purpose**
- Extract tracking, measurement, and infrastructure signals from HAR files

**Inputs**
- `data/har/*.har`

**Outputs**
- `data/parsed/signals.json`
- or structured rows for Google Sheets

**Notes**
- No scoring
- No judgement
- Pure signal extraction

---

### push-to-gsheet.js (planned)
**Purpose**
- Send parsed signals to Google Sheets

**Inputs**
- Parsed signal data

**Outputs**
- Rows in a defined Google Sheet

**Notes**
- Sheet is the system of record
- No calculations or opinions in this step

---

## Deprecated Scripts

Deprecated scripts must be moved to:
scripts/deprecated/


They should never be edited again.

If something needs to change, create a **new responsibility**, not a new version.

---

## Design Rule (Non-Negotiable)

If you feel the urge to create:
- `*-stable.js`
- `*-v2.js`
- `*-final.js`

Stop.

Fix the existing script or delete it.

This folder should be boring, predictable, and trustworthy.