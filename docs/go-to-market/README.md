# Go-to-market

The commercial plan for CONSTRUX.AI: Greater Manchester launch, a 90-day gated
programme, and the route to the first 100 customers.

`GO-TO-MARKET.md` is the readable source of record. `go-to-market.html` is the
same document as a styled page, and is what the Word and PDF editions are
generated from.

## Why it lives in the repository

The plan quotes the platform's own pricing, packaging and capability claims.
Those come from `src/billing/seats.ts` and `docs/STATE.md`, and they change. A
plan kept somewhere else drifts away from the product silently; kept here, a
pricing change and the document that quotes it are one commit.

## Regenerating the editions

```bash
node tools/gtm/build-markdown.mjs     # HTML → GO-TO-MARKET.md
node tools/gtm/build-docx.js          # → GO-TO-MARKET.docx  (needs `npm i docx`)
node tools/gtm/embed-downloads.mjs    # embeds the editions in the page
```

`build-docx.js` is the only thing here that needs a package, and it is a
document generator rather than part of the platform — the zero-runtime-dependency
rule is about what ships, not about what writes a Word file. Install it on
demand; do not add it to `package.json`.

PDF generation is not scripted. LibreOffice cannot run in the development
container, so the PDF was produced by rendering `go-to-market.html` through a
headless browser's print pipeline. Anyone regenerating it should print the page
to A4 with backgrounds enabled rather than converting the `.docx`.

## What must be re-checked before this is used

Stated here so nobody circulates it assuming otherwise.

- **Modelled, not measured.** Conversion rates, CAC by motion, sales-cycle
  lengths, retention and cost-per-SQL are assumptions. They exist to be
  replaced by measurement at Gate 1 and Gate 2, and are not benchmarks.
- **`marketwaros.com` is unverified.** It could not be reached from the
  development environment. Section 08 gives a brief and contract terms rather
  than a recommendation, and the reference check is the first action.
- **Market figures carry a date.** HRB counts and remediation programme numbers
  were taken from GOV.UK releases current at the time of writing; re-check
  before quoting them externally.
- **Gate 0 is real.** The plan opens by stating the platform cannot be sold
  until the ledger is persistent. If that changes, this document changes.
