# Launch audit — MASTER PROMPT v2

Working artefacts for the full-stack launch audit. **Default verdict is NO-GO**
until every mandatory gate is earned with reproducible evidence.

| Artefact | What it holds |
|---|---|
| `evidence-ledger.md` | Every test: ID, command, status, evidence |
| `defects.md` | One record per defect, with root cause and fix |
| `truth-audit.md` | Every public claim: REAL / PARTIAL / STUBBED / ABSENT / BROKEN |
| `novice-walkthrough.md` | Mind 2's friction log, per journey |
| `human-actions.md` | What only a person can do, and why it blocks |
| `cycle-reports/` | What each cycle fixed, broke and left |
| `evidence/` | Logs, captures, outputs — redacted |

## The environment this audit actually ran in

Stated first because it bounds every verdict below it.

| | |
|---|---|
| **Repository** | `jnnseya-cpu/construx`, branch `claude/ai-agent-construction-os-999410` |
| **Runtime under test** | the platform booted from source in this container, `PORT=8099` |
| **Access held** | repository, terminal, local runtime, a real Chromium via Playwright |
| **Access NOT held** | the live deployment, its database, its CI, its monitoring, its cloud or DNS console, any vendor dashboard |
| **Consequence** | every PASS below applies to **this build, run here**. Nothing in this audit is evidence about `construxvg.com` unless it says so explicitly. |

A verdict on the live site requires access to the live site. Where that is the
only thing missing, the item goes to `human-actions.md` rather than being
guessed at.
