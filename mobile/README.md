# CONSTRUX Field — native Android and iOS

Built to *CONSTRUX Site Field Android/iOS Developer Specification v1.0* and the
*Field Mobile Apps Build Specification*.

---

## Read this before anything else

**None of this code has been compiled, run, or tested.** It was written in a
Linux container with no Xcode, no Android SDK, no simulator, no device. Nothing
here has been through a build.

That is not a disclaimer to skim. Dependency versions are a considered starting
point, not a resolved lockfile. No native module has been exercised. The API
surface is written against the CONSTRUX gateway in this repository — that part
*is* verified, because the server has 6,261 passing tests — but this client's
behaviour against it is not.

The design is the deliverable. Read it, disagree where you disagree, get it
building.

## Building iOS with no Mac

**This is the reason the project is Expo rather than bare React Native CLI.**

EAS Build compiles, signs and submits the iOS binary on Apple hardware in the
cloud. An iOS release needs an Apple Developer account and nothing else — no
Mac, no Xcode, no local simulator. Bare RN would have required all three.

This is still React Native, which is what §A3 specifies. Expo is the toolchain
around it, not a different framework, and every native capability §A3 names —
camera, speech, secure storage, biometrics, background work, SQLCipher — is
present as a config plugin instead of an Xcode project edit.

```bash
npm install -g eas-cli
eas login                       # your Apple Developer credentials are used at build time
eas init                        # creates the EAS project, writes the project id

# First iOS build. EAS creates and manages the signing certificate and
# provisioning profile against your account — you will be asked to confirm.
eas build --platform ios --profile development

# Android, same machine, no Mac involved either way.
eas build --platform android --profile development
```

`eas submit --platform ios --latest` uploads to App Store Connect. Fill the
three `REPLACE_WITH_` values in `eas.json` first: your Apple ID, the App Store
Connect app id, and your team id.

**Alternative if you would rather not use Expo's service:** Codemagic gives the
same thing — macOS build machines, signing, direct store submission — and works
with bare React Native. The scaffold would need `expo prebuild` first. EAS is
the shorter path from here.

### What the cloud does not solve

**Testing.** A build compiled in a data centre is not a build somebody has held
in the rain. §F2's field-condition suite — gloves, wet screen, direct sunlight,
one-handed reach — needs a physical device, and so does most of §17.1's matrix:
low storage, background suspension, biometric unavailable, vendor background
restrictions.

You need at least one real iPhone and one real Android handset. A used iPhone SE
is adequate and cheap; TestFlight installs onto it without a Mac. Cloud device
farms (BrowserStack App Live, AWS Device Farm) cover the functional matrix but
cannot tell you whether a gloved thumb can hit the capture button.

For a product whose §A2 RULE F6 is "ten seconds from pocket to saved record",
that is not a formality — it is the acceptance criterion.

## What is here, and why these parts first

The order was chosen so the hard, load-bearing decisions get reviewed before
forty screens are written on top of them.

| Path | What it is | Specification |
|---|---|---|
| `app.config.ts` | Bundle ids, permission strings, SQLCipher, iOS 15 / Android 10 floors | §A3, §16.6 |
| `eas.json` | Build profiles and store submission, no Mac required | §17.5 |
| `src/db/schema.ts` | Append-only outbox plus materialised read models | §A4, §13.2 |
| `src/sync/state.ts` | Eight sync states, legal transitions, what each means to a person | §14.3, Appendix A |
| `src/sync/conflicts.ts` | Conflict classification, and which classes a machine may resolve | §14.5 |
| `src/api/client.ts` | Idempotent requests, 409 as data, timeout as *unknown* | §15.1 |

Four decisions worth arguing with before building on them, because each has a
plausible alternative that is wrong only on a bad connection:

**A timeout is `AWAITING_RECEIPT`, not `REJECTED`.** The request may have been
applied. Calling it a failure either duplicates the record on retry or tells a
supervisor their work is lost when the platform has it.

**The idempotency key belongs to the command, not the request.** Minted once,
stored in the outbox, reused on every attempt. A client that mints one per
request has no idempotency at all.

**Materiality decides who resolves a conflict, not the field's datatype.** Two
people editing a snag description is an ordinary edit. Two people editing its
severity changes what happens on site. §14.5 forbids last-write-wins on
quantities, progress, safety and test results.

**No background location permission is requested, on either platform.** §16.6
prohibits inferring attendance from continuous GPS, and asking for a permission
the product must not use turns a Play review into a policy argument.

## What is not here yet

Named plainly, so nobody mistakes an absence for an oversight:

- The forty-screen route catalogue of §3. Navigation graph not written.
- Today and its role variants (§B3, §B4).
- Every capture flow: photo-snag, diary, observation, inspection, permit,
  delivery, incident (§C2–§C15).
- The voice engine (§C1) and on-device ASR.
- Auth: OIDC, device enrolment, biometric unlock.
- The evidence pipeline and resumable upload (§C6) — the server half is also
  still to build.
- Cert pinning, jailbreak detection, MDM configuration (§F1).
- Any test at all.

## Getting it building

```bash
cd mobile
npm install                 # expect to resolve version conflicts on the first run
npm run typecheck           # the first milestone that can pass without a device
eas build --platform android --profile development
```

`npm run typecheck` is the honest first target. It is the one check that can be
made to pass with no device and no cloud build, and until it does, nothing else
means much.

## The server it talks to

The CONSTRUX gateway in this repository.

- `GET /v1/projects/:projectId/work/:module` — module workspace: stage, context,
  pack freshness, current shift, home indicators, six tab counts.
- `GET /v1/projects/:projectId/work/:module/:tab` — one tab, filtered
  server-side by status, owner, location or due date.
- `POST /v1/projects/:projectId/offline-packs/estimate` — what a pack would cost
  to download, before committing.
- `POST /v1/projects/:projectId/offline-packs` — cut and sign a pack.
- `GET /v1/projects/:projectId/offline-packs/:packId/manifest` — the signed
  manifest, a hash per entity and per file.
- `POST /v1/projects/:projectId/offline-packs/:packId/receipt` — what this
  device verified, and whether it activated.
- `POST /v1/projects/:projectId/sync/push` and `/sync/pull` — batch protocol,
  capped at 500 operations, per-project cursors.

**Optimistic concurrency is live.** Send `If-Match: <entityVersion>` on a
material write. A stale one returns 409 with `currentVersion`,
`expectedVersion`, the entity and `permittedResolutions` — which is what the
conflict screen renders, rather than the word "conflict".

**On the manifest signature.** It is an HMAC, so this client *cannot* verify it
and must not pretend to. TLS proves the pack came from the platform. The
signature lets the platform recognise its own manifest when a device hands one
back. What this client verifies is the **hashes** — every entity's state hash and
every file's content hash — and that needs no key. That verification is the step
that must pass before activation.

## Rules carried over from the platform

`../CLAUDE.md` governs this directory, with one deliberate exception: the
backend's zero-runtime-dependency rule does not apply here, because §A3 fixes
the stack and React Native and its native modules are requirements.

Every other rule stands. No placeholder data, no dead controls, no fake success.
A feature is not done until it works offline, meets the ten-second capture
budget, and behaves identically on both platforms.
