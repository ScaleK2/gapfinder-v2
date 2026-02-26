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
- Node.js (LTS)
- Python 3.10+
- npm

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
pip install python-docx reportlab pandas openpyxl
```

---

## 🔑 Environment Setup

Set PSI API key:

### Windows
```powershell
setx PSI_API_KEY "your_key_here"
```

### Mac
```bash
export PSI_API_KEY=your_key_here
```

Restart terminal after setting.

---

## ▶ Running the Pipeline

Homepage only (default):

```bash
node scripts/run-gapfinder.js https://example.com
```

Full crawl mode:

```bash
node scripts/run-gapfinder.js https://example.com --full
```

Outputs are stored in:

```
data/{domain}/
```

---

## 🧠 Architecture

1. Crawl domain  
2. Capture HAR  
3. Extract tags & events  
4. Analyse payload completeness  
5. Run PSI  
6. Generate DOCX  
7. Export PDF  

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
