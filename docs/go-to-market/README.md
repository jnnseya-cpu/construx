# Go-to-market

The commercial plan for CONSTRUX: Greater Manchester launch, a 90-day gated
programme, and the route to the first 100 customers.

**`go-to-market.html` is the source. Everything else is generated from it.**

`GO-TO-MARKET.md` is built from the HTML by `tools/gtm/build-markdown.mjs`, and
the Word and PDF editions are built from the HTML too. Edit the HTML and
regenerate; an edit made to the Markdown is overwritten the next time anybody
runs the build.

This used to read "GO-TO-MARKET.md is the readable source of record" while the
build command underneath said `HTML → GO-TO-MARKET.md`, and the two drifted in
opposite directions: the HTML was corrected to a 4× markup and the Markdown was
never regenerated, so it went on quoting 5× and a superseded set of bundle
figures. `gtm.test.ts` now regenerates the Markdown and fails if the committed
file differs, so the two cannot disagree again.

## Why it lives in the repository

The plan quotes the platform's own pricing, packaging and capability claims.
Those come from `backend/src/billing/seats.ts` and `docs/STATE.md`, and they change. A
plan kept somewhere else drifts away from the product silently; kept here, a
pricing change and the document that quotes it are one commit.

Kept here *and checked*: `gtm.test.ts` reads every package price, bundle credit
and markup figure out of this document and asserts each one against
`billing/seats.ts` and `config.ts`. The code is the source of truth for what a
thing costs; this document is allowed to quote it and not to disagree with it.

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
