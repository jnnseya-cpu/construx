# Brand collateral

Two things a person can use today, and the script that builds one of them.
Everything here is sales material; nothing in this directory is imported by the
platform, and none of it is a project dependency.

| File | What it is |
|---|---|
| `email-signature.html` | The signature for first contact. Introduces the company and asks for the demo |
| `email-signature-compact.html` | The signature for replies and forwards |
| `CONSTRUX-sales-deck.pptx` | Eleven slides, with speaker notes on every one |
| `build-deck.mjs` | The script that generates the deck. Edit this, not the `.pptx` |

---

## The signatures

Open the file in a browser, select all, copy, and paste into the signature
editor. **Do not paste the HTML source** — mail clients want the rendered
result, not the markup.

Set the full one as the *new message* signature and the compact one as the
*reply and forward* signature. Outlook and Gmail both support that split, and it
is the reason there are two: the ninth message of a thread does not need the
company introduced again, and repeating it is what makes people switch
signatures off.

**Fill in every `[SQUARE BRACKET]` before use.** An unfilled bracket in a
signature reads as a company that does not check its own outbound mail.

Then **send one to yourself and read it on a phone** before it goes to a
customer. The files are built for mail clients rather than browsers — tables,
inline styles, web-safe faces, one image that nothing depends on — and the
comments in each explain why each of those is not a matter of taste, but the
comments cannot tell you how it looks on your own device.

---

## The deck

Eleven slides in the product's own palette, in this order:

1. **Cover** — the record that cannot be argued with
2. **The problem, in money** — three symptoms every buyer recognises
3. **Why now** — the Building Safety Act, and the specification of our
   architecture published by somebody else
4. **The difference** — version history against an immutable record
5. **The demo, in order** — the three things nobody else can do on stage
6. **The AI, governed** — agents propose, a named human decides
7. **The second wedge** — compliance opens the door, cashflow closes the deal
8. **What is actually built** — not a roadmap
9. **Pricing** — start on one project
10. **The two objections you will always be asked**
11. **The close** — fifteen minutes, your project, your record

**Read the speaker notes.** They carry the sales instruction, not a summary of
the slide: which objection each slide answers, what to demo live, and — on
slide 10 — what not to bluff.

### Rebuilding it

```
mkdir -p /tmp/deckdeps && cd /tmp/deckdeps && npm init -y && npm install pptxgenjs
cd /path/to/construx
NODE_PATH=/tmp/deckdeps/node_modules node docs/go-to-market/brand/build-deck.mjs
```

`pptxgenjs` is installed outside the repository on purpose. Zero runtime
dependencies is a settled decision and the dev set is TypeScript and
`@types/node` only; this is a marketing build script, so it asks for the package
when it needs one — the arrangement `tools/walk.mjs` already uses for its
browser driver.

### The rule that matters most

**Every figure in the deck is read off the codebase, not written for effect.**
Prices come from `backend/src/billing/seats.ts`; the platform counts from the
`ROUTES`, `EVENT_TYPES`, `ENTITY_ACCESS` and `AGENTS` tables; the test count
from `npm test`; the market figure and the competitive comparison from
`../GO-TO-MARKET.md`.

Keep it that way. A sales deck that overstates is a deck the first technical
buyer takes apart in the room, and this product's whole argument is that it does
not overstate. When the platform's numbers move, rerun the script rather than
editing the slides — and check the figures still match before a big meeting.
