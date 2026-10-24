# Human action list

Everything a GO depends on that **only a person with access this audit does not
have** can do. Each item says what is needed, why it blocks, and what the audit
will do the moment it is supplied.

The single root cause of most of this list: **the audit ran against the platform
booted from source in a container. It had no access to the live deployment, its
database, its CI, its monitoring, or any vendor dashboard.** Code correctness is
provable from here; a running production system is not.

| # | Action | Why it blocks a GO | What the audit does once supplied |
|---|---|---|---|
| H-1 | Give the audit read access to the **live deployment** (URL, a test login, and ideally read access to its logs/metrics) | Every PASS so far is about *this build run here*, not about `construxvg.com`. A launch verdict on the live site needs the live site. | Re-run the whole Cycle-1 suite against production; confirm the deployed build’s commit matches the tested one. |
| H-2 | Confirm the **production secrets** are set and unique (`GATEWAY_JWT_SECRET`, `SESSION_SIGNING_KEY`, `LEDGER_SIGNING_KEY`, `EVIDENCE_ENCRYPTION_KEY`, `WEBHOOK_SIGNING_SECRET`) and that none is the published default | The boot gate refuses the published defaults (proven), but the audit cannot see which secrets the live host actually holds. | Verify via `/readyz` detail and a signed round-trip. |
| H-3 | Provision a **second customer tenancy** in a safe environment, or point the audit at staging with ≥2 customer tenancies | Cross-*customer* data isolation (T-052) was proven in mechanism but exercised against only one seeded tenancy. | Run the two-token cross-tenant read matrix to convert T-052 from PARTIAL to PASS. |
| H-4 | Decide and provide the **payments** posture: is Stripe (card-on-file) actually enabled in production, with sandbox keys for testing? | `docs/STATE.md` records payments collection as off by default; the audit cannot test money paths without sandbox keys, and must never touch real funds. | Run the full 6.12 payment/webhook/idempotency/reconciliation suite in sandbox. |
| H-5 | Confirm **SMTP** (and any SMS carrier) is configured in production | With no SMTP, production writes one-time sign-in codes to stderr (safe, but it means no human can receive a login email). Until mail is set, real users cannot sign in. | Verify a real sign-in email is delivered end to end. |
| H-6 | Run a **restore drill**: restore a real backup into isolation (`deploy/restore-drill.sh` exists) | An unrestored backup is not a backup; the audit cannot execute this without the production object store. | Record actual RPO/RTO against the targets in `docs/RUNBOOK.md`. |
| H-7 | Execute a **deploy → smoke → rollback → redeploy** on the real pipeline | Rollback is scripted (`deploy/autodeploy.sh` rolls back if `/readyz` never comes up) but theoretical until run on the real host. | Observe and time the rollback; confirm no data loss. |
| H-8 | **Load/soak test** against staging at the stated peak | No performance target can be certified from a single-process container run. | Run 6.16 workloads; publish p50/p95/p99, error rate, recovery time. |
| H-9 | **Legal/compliance sign-off** on the live public copy (terms, privacy, cookie consent, pricing/tax wording, AI disclosure, accessibility statement) | A lawyer’s judgement, not an engineering one. | N/A — records the sign-off; corrects any copy the audit drafted. |
| H-10 | Confirm **account ownership** — domain, DNS, cloud, object store, Stripe, email provider all owned by the organisation, not an individual | A single-point ownership risk is a business/continuity risk the audit cannot see from code. | N/A — records the confirmation. |
| H-11 | **Mobile device matrix** on real hardware (PWA install, offline, camera, touch) | The `mobile/` Expo client is explicitly uncompiled; PWA behaviour needs real devices and a throttled network the audit does not have. | Run 6.17 on the device set; give a GO/NO-GO on native packaging. |

Until H-1 is supplied, the honest verdict on the **live platform** is
**NO-GO (UNTESTED against production)** — not because a defect is known, but
because the thing to be launched was not the thing that could be reached.
