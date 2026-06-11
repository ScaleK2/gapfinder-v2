# GapFinder v2

Digital Tracking & Performance Readiness Audit Pipeline

---

## 🚀 Overview

GapFinder v2 audits:

- Tracking implementation
- Event payload completeness
- Vendor presence
- PageSpeed performance
- Reporting readiness

It generates a structured DOCX + PDF client report.

---

## 🛠 Requirements

- Git
- Node.js (LTS - not current; https://nodejs.org/en/download)
- Python 3.10+
- npm (included in node.js)

Verify:

```bash
git --version
node -v
npm -v
python --version
```

---

## 📦 Installation

Clone the repository:

```bash
git clone https://github.com/ScaleK2/gapfinder-v2.git
cd gapfinder-v2
```

Install Node dependencies:

```bash
npm install
npx playwright install
```

Install Python dependencies:

```bash
pip install python-docx reportlab pandas openpyxl docx2pdf
```

---

## 🔑 Environment Setup

Preferred: create a local `.env` file from the example template:

```bash
cp .env.example .env
```

Then edit `.env` and set:

```env
PAGESPEED_API_KEY=your_key_here
```

`PSI_API_KEY` is also supported as a fallback name. You can still export the key in your shell if you prefer:

```bash
export PAGESPEED_API_KEY=your_key_here
```

On Windows PowerShell:

```powershell
setx PAGESPEED_API_KEY "your_key_here"
```
---

## ▶ Running the Pipeline

Interactive menu (recommended):

```bash
node run.js
```

Homepage-only PSI / standard audit:

```bash
node scripts/run-gapfinder.js https://example.com
```

Region-scoped audit for stores that live under a path such as `/au`:

```bash
node scripts/run-gapfinder.js https://www.anker.com/au/ --scope-mode=soft
```

Use strict scope if you want to block global fallback pages such as `/privacy-policy`, `/cart`, or `/checkout`:

```bash
node scripts/run-gapfinder.js https://www.anker.com/au/ --scope-strict
```

If sitemap discovery cannot find the right regional templates, provide known URLs manually:

```bash
node scripts/run-gapfinder.js https://www.anker.com/au/ \
  --category https://www.anker.com/au/collections/charging \
  --pdp https://www.anker.com/au/products/example-product
```

Full PSI mode (home + category + PDP where detected):

```bash
node scripts/run-gapfinder.js https://example.com --full
```

Outputs are stored in:

```
data/{domain}/
```

For region-scoped audits, the path is included in the audit key to avoid overwriting another region. For example, `https://www.anker.com/au/` writes to:

```
data/anker.com__au/
```

Key analysis outputs include:
- `analysis/phase1_inventory.xlsx`
- `analysis/unknown_vendors.csv`
- `analysis/psi.json`
- `analysis/scorecard.json`
- `analysis/probe_targets.json` (includes scope metadata when a region path is used)

---

## 🧠 Architecture

1. Crawl domain  
2. Capture HAR  
3. Extract tags & events  
4. Analyse payload completeness  
5. Run PSI  
6. Score commercial signal quality (scorecard.json)  
7. Generate DOCX  
8. Export PDF  

---

## 📁 Repository Structure

```
scripts/
templates/
package.json
README.md
```

Not tracked:

```
data/
node_modules/
outputs/
```

---

## 🔄 Updating

After changes:

```bash
git add .
git commit -m "Update"
git push
```

On another machine:

```bash
git pull
```

---

## 🏗 Future Improvements

- Docker containerisation
- Version tagging
- CI validation
- Automated testing
