# Defects

One record per defect. Severity: P0 catastrophic · P1 critical · P2 high ·
P3 medium · P4 low. Every defect below was **found and fixed in this audit
window**; each has a regression test and a commit.

---

## D-001 · Seven source files were binary, not text · P2 · FIXED

- **Area:** repository hygiene / toolchain integrity
- **Found:** a repo-wide `grep` answered for 363 of 366 files; three said
  `binary file matches` and scrolled past.
- **Root cause:** a raw NUL (and in four more files, `ESC`/`0x01`/ZIP-magic)
  byte written into a string literal where the escape (`\0`, `\x1b`) was meant.
- **Impact:** the files ran correctly but were invisible to `grep`/`sed`/`diff`
  **and to the source-scanning invariants in `backend/tests/`** — so three
  files had silently dropped out of every automated check built on a text scan.
  A reviewer could not see the byte at all.
- **Fix:** replaced each raw byte with its escape. Same bytes at runtime.
- **Regression test:** `backend/tests/sourcehygiene.test.ts` — no control
  chars outside tab/newline, no BOMs, no two files byte-identical, scan reads
  400+ files.
- **Commit:** `d72ec33`

## D-002 · Runtime floor declared but unenforced · P2 · FIXED

- **Area:** release integrity / supply chain
- **Found:** `engines.node` said `>=22.23.4`; the audit container ran v22.22.0
  — below the floor **and** below the October 2026 advisory the floor exists to
  clear — with every command running without a word.
- **Root cause:** no `engine-strict`, so `engines` was advisory.
- **Fix:** `.npmrc` sets `engine-strict=true` (install refuses a low runtime and
  names the version) and `save-exact=true`.
- **Regression test:** `sourcehygiene.test.ts` holds the three places that state
  the runtime (package.json floor ≥ advisory, CI on the line, image on the line)
  to one fact.
- **Commit:** `c20f1d8`

---

## Bid-On defects found and fixed earlier in this session

These were found by driving a real tender through the module and are recorded
in `docs/STATE.md` in full. Summarised here because several are the exact
classes this audit exists to catch.

| ID | Defect | Sev | Status | Commit |
|---|---|---|---|---|
| D-010 | `BID_ON_QUESTIONS_PARSED` emitted but never registered in the event catalogue | P1 | FIXED + catalogue invariant | earlier |
| D-011 | Confirm-questions route schema `minItems:1` made the domain's empty-list branch unreachable | P1 | FIXED | `8612974` |
| D-012 | Drafter never asked the model for the yes/no field → every yes/no question charged a vendor then refused on the last line | P1 | FIXED + end-to-end test | `64daa12` |
| D-013 | A gap (no draft) reported to the user as a successful “Recorded” | P2 | FIXED | `cc05594` |
| D-014 | Approve panel did not show the answer being signed (two-person check against a reference number) | P1 | FIXED | `2173e76` |
| D-015 | Revision loop marked its **own** rewrite and stopped at a self-reported green; the independent scorer then gave the same answers 36 | P1 | FIXED — loop now stops on the independent scorer’s mark | `15d5124` |
| D-016 | Evidence the pack needed was discovered by drafting (and charging) one question at a time, instead of asked for up front | P1 | FIXED — `planEvidenceNeeds` asks once, before any prose | `f1ad3b3` |

All Bid-On defects have end-to-end tests in `backend/tests/bidondraft.test.ts`
and `bidonfriction.test.ts` that run the full engine against a scripted
provider — the AI success path is no longer untested.
