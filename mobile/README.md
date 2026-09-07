# CONSTRUX Field — native Android and iOS

Built to *CONSTRUX Site Field Android/iOS Developer Specification v1.0* and the
*Field Mobile Apps Build Specification*.

---

## Read this before anything else

**None of this code has been compiled, run, or tested.** It was written in a
Linux container with no Xcode, no Android SDK, no simulator, no device and no
store account. Nothing here has been through a build.

That is not a disclaimer to skim. It means:

- Dependency versions in `package.json` are a considered starting point, not a
  resolved lockfile. Expect to adjust them on first install.
- No native module has been linked. Camera, speech, biometrics, background
  scheduling and secure storage all need their platform wiring.
- The API surface is written against the CONSTRUX gateway as it exists in
  `backend/src/api/routes.ts` in this repository — that part *is* verified,
  because the server side has 6,253 passing tests. What is unverified is this
  client's behaviour against it.

The design is the deliverable. Treat it as a colleague's detailed pull request
that has not yet run: read it, disagree where you disagree, and get it building.

## What is here, and why these parts first

The order was chosen so that a mobile developer can get the hard, load-bearing
decisions reviewed before writing forty screens on top of them.

| Path | What it is | Specification |
|---|---|---|
| `src/db/schema.ts` | The local store: append-only outbox plus materialised read models | §A4, §13.2 |
| `src/sync/state.ts` | The eight sync states, their legal transitions and what each means to a person | §14.3, Appendix A |
| `src/sync/conflicts.ts` | Conflict classification, and which classes a machine may resolve | §14.5 |
| `src/api/client.ts` | Idempotent requests, 409 as data, timeout as *unknown* rather than failure | §15.1 |

Three decisions in there are worth arguing with before you build on them,
because each has a plausible alternative that is wrong in a way that only shows
up on a bad connection:

**A timeout is `AWAITING_RECEIPT`, not `REJECTED`.** The request may have been
applied. Calling it a failure either duplicates the record on retry or tells a
supervisor their work is lost when the platform has it.

**The idempotency key belongs to the command, not the request.** It is minted
once, stored in the outbox, and reused on every attempt. A client that mints one
per request has no idempotency at all.

**Materiality decides who resolves a conflict, not the field's datatype.** Two
people editing a snag description is an ordinary edit. Two people editing its
severity changes what happens on site. §14.5 forbids last-write-wins on
quantities, progress, safety and test results, and `conflicts.ts` encodes that
as a table rather than as conditionals in the engine.

## What is not here yet

Named plainly, so nobody mistakes an absence for an oversight:

- The forty-screen route catalogue of §3. Navigation graph not written.
- The Today screen and its role variants (§B3, §B4).
- Every capture flow: photo-snag, diary, observation, inspection, permit,
  delivery, incident (§C2–§C15).
- The voice engine (§C1) and on-device ASR.
- Auth: OIDC, device enrolment, biometric unlock (§A3).
- The evidence pipeline and resumable upload (§C6) — the server side of this is
  also still to build.
- Native modules, MDM configuration, cert pinning, jailbreak detection (§F1).
- Any test at all.

## Getting it building

You will need macOS with Xcode for iOS, and Android Studio with an SDK for
Android. Neither was available where this was written.

```bash
cd mobile
npm install                 # expect to resolve version conflicts on the first run
npx pod-install ios         # macOS only
npm run typecheck           # this should be the first thing that passes
npm run android             # or: npm run ios
```

`npm run typecheck` is the honest first milestone. It is the one check that can
be made to pass without a device, and until it does, nothing else is meaningful.

## The server it talks to

The CONSTRUX gateway in this repository. Relevant to this client today:

- `GET /v1/projects/:projectId/work/:module` — the module workspace: stage,
  context, pack freshness, current shift, home indicators, six tab counts.
- `GET /v1/projects/:projectId/work/:module/:tab` — one tab, filtered
  server-side by status, owner, location or due date.
- `POST /v1/projects/:projectId/offline-packs/estimate` — what a pack would
  cost to download, before committing to it.
- `POST /v1/projects/:projectId/offline-packs` — cut and sign a pack for a
  device.
- `GET /v1/projects/:projectId/offline-packs/:packId/manifest` — the signed
  manifest, with a hash per entity and per file.
- `POST /v1/projects/:projectId/offline-packs/:packId/receipt` — what this
  device verified, and whether it activated.
- `POST /v1/projects/:projectId/sync/push` and `/sync/pull` — the batch
  protocol, capped at 500 operations, with per-project cursors.

**On the manifest signature.** It is an HMAC, so this client *cannot* verify it
and must not pretend to. TLS is what proves the pack came from the platform. The
signature lets the platform recognise its own manifest when the device hands one
back. What this client verifies is the **hashes** — every entity's state hash and
every file's content hash — and that needs no key. That is the verification step
before activation, and it is the one that must actually be implemented.

## Contributing rules that carry over from the platform

`../CLAUDE.md` governs this directory too, with one deliberate exception.

The backend's zero-runtime-dependency rule does **not** apply here: §A3 fixes
the stack, and React Native, WatermelonDB and the native modules are
requirements rather than conveniences. Every other rule stands — no placeholder
data, no dead controls, no fake success, and a feature is not done until it
works offline, meets the ten-second capture budget, and behaves identically on
both platforms.
