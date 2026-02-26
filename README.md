GapFinder v2

GapFinder is a measurement readiness diagnostic engine.

It analyses ecommerce websites and marketing stacks by capturing observable runtime signals, normalising them into structured outputs, and generating executive-facing readiness reports.

It is not an audit tool.
It is a systems exposure tool.

Its purpose is to create commercial tension.

WHAT GAPFINDER DOES

GapFinder evaluates:

Tracking foundation (GTM / GA4 presence)

Vendor footprint (analytics, ads, CRO, support, payments)

Event visibility (journey depth)

Payload completeness (revenue signal quality)

Attribution hygiene signals

Page performance (PSI – mobile & desktop)

Unknown or unclassified vendors

It translates these signals into a founder-readable readiness report.

FOLDER STRUCTURE

GapFinder-v2/

scripts/
Executable logic only

data/
Domain-specific machine outputs (regeneratable)

templates/
DOCX report templates

config/
API keys and credentials (not committed)

README.txt

For each analysed domain:

data/<domain>/

urls.txt

har/

analysis/

phase1_inventory.xlsx

unknown_vendors.csv

psi.json

report/

GapFinder_Readiness_<domain>.docx

GapFinder_Readiness_<domain>.pdf

CURRENT WORKFLOW

Discover URLs
node scripts/domain-crawl-to-urls.js <domain>

Capture Runtime Activity (HAR)
node scripts/har-capture.js <domain>

Parse and Normalise Signals
node scripts/phase1-tag-inventory.js <domain>

Fetch PageSpeed Insights
Default (homepage only):
node scripts/psi-fetch.js <domain>

Optional full scan:
node scripts/psi-fetch.js <domain> --full

Generate Executive Report (DOCX + PDF)
python scripts/generate-gapfinder-docx-v2.py <domain>

Optional orchestration:
node scripts/run-gapfinder.js <domain>

PSI STRATEGY

Default behaviour:

Homepage only

Mobile + Desktop

Optional:

--full runs home + category + PDP

Failures are non-blocking

PSI output location:
data/<domain>/analysis/psi.json

DESIGN PRINCIPLES

Deterministic
Every script has defined inputs and outputs.

Regeneratable
Nothing in /data requires manual editing.

Commercially Focused
This is not a deep audit.
This is a readiness exposure tool.

Signal over Volume
If a feature does not improve:

Signal quality

Decision confidence

Commercial impact

It does not belong.

WHAT THIS IS NOT

Not an SEO crawler

Not a vanity scoring tool

Not a free audit gimmick

Not a full behavioural test harness

GapFinder surfaces:

Measurement depth

Signal quality

Structural friction

Governance risk

It creates the question:

"Are we actually set up to scale efficiently?"

CURRENT STATUS

Tracking inventory: Stable
Vendor classification: Stable
Unknown detection: Stable
PSI integration: Stable (home-only default)
DOCX generation: Stable
PDF auto-export: Stable
Full automation: Functional

Next evolution:

Narrative refinement

Commercial positioning

Conversion system integration

RULE OF ADDITION

Before adding anything new, ask:

Does this increase clarity, leverage, or commercial tension?

If not, remove it.