# The adversarial probe harness

The evidence behind `docs/LAUNCH_VERDICT.md`. Every figure in that document came
from one of these scripts run against a live server; this directory exists so
somebody else can run them and get the same answers, or a different one.

**These are not tests.** They do not belong in `npm test` and they are not run
by CI. A test asserts a property the platform is expected to keep. A probe
attacks a running deployment and reports what happened, including "nothing
happened" and "I could not reach this". That difference is the point: a probe
that finds a defect earns a *test*, and three of them did this pass — the
`htmlPolicy` invariant in `consoleforms.test.ts`, the probe-exemption test in
`api.test.ts`, and the production-posture test in `configsafety.test.ts`.

## Running them

Start a server, then point the harness at it:

```sh
node --experimental-strip-types backend/src/main.ts &
node audit/a-authn.mjs        # authentication, tokens, headers
node audit/b-authz.mjs        # authorisation, IDOR, injection, malformed input
node audit/c-domain.mjs       # ledger, change feed, posture
node audit/d-money.mjs        # settlements, fees, concurrency, reconciliation
node audit/e-rest.mjs         # uploads, indirect injection, load, failure injection
```

`PROBE_BASE` overrides the target (default `http://127.0.0.1:8080`).

`f-recovery.mjs` and `g-after.mjs` are the two halves of the recovery exercise
and need a server started with `LEDGER_JOURNAL_PATH` set. Write records with
`f-recovery.mjs` (it snapshots the journal), `SIGKILL` the process, restore the
journal from `<path>.backup`, start a fresh process, then run `g-after.mjs` with
the `MARKER` it printed. Expect the replacement to refuse to start until the
dead writer's heartbeat ages out — that is correct, and it is the floor under
the recovery time.

## Reading the output

Each line is `[id] STATUS title :: evidence`. The statuses are used strictly and
the two that matter most are the ones it would be easy to fudge:

| Status | Means |
|---|---|
| `HELD` | An attack was made and repelled |
| `PASS` | A property was checked and holds |
| `PARTIAL` | Something is true but incompletely, or only under the conditions tested |
| `FAIL` | A defect, with a severity |
| `BLOCKED` | The probe could not run — usually a payload the route refused, so it proves nothing |
| `NOT TESTED` | The thing being probed is absent from this environment |

**`BLOCKED` and `NOT TESTED` are never promoted to `PASS`.** Several results in
this directory are one of those two, and they are recorded that way in the
verdict as well.

## Things learnt writing these that are worth not relearning

- A probe that answers `401` when you expected `403` has tested nothing. Two
  whole batteries ran unauthenticated because the MFA verify payload took
  `actorId`, not `email`, and every result came back "held" for the wrong
  reason.
- The rate limiter will contaminate a run. Restart the server between batteries,
  or a `429` will be recorded as a refusal the platform made on purpose.
- A payload built from a guess at the schema produces a `400` that looks like a
  security control. Read the route's declared schema and build from it.
- Do not embed raw control characters in a payload literal. It makes the file
  binary to git, invisible in review, and is exactly the class of bug that made
  every genuine document verify as a forgery earlier in this project. Write
  `‮`, not the character.
