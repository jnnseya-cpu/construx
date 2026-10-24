# Running a real tender through Bid-On

Worked end to end against **RFX1000209 — Platform Housing Group, EPC
Assessments**, because an instruction written against a made-up tender is one
nobody can follow on the day.

| | |
|---|---|
| Buyer | Platform Housing Group |
| Their reference | RFX1000209 |
| What it is | EPC assessments across the retained stock |
| Buyer contact | Harry O'Neill |
| Returns | **2 November 2026, 14:00** |
| Contract | 1 January 2027 → 31 December 2030 |
| Documents | Invitation to Tender, plus Appendices 1–8 |

Every screen, button and field below is named as it appears. Where the platform
will refuse you, it says so and why — and each refusal is listed in
[What it will refuse, and what to do](#what-it-will-refuse-and-what-to-do) with
the way through it.

> **What changed after the first run of this document.** Nothing that names a
> *document* asks you to copy an identifier any more: every such field is a
> chooser. A document longer than one model request is read in parts rather than
> refused. A question waiting on the customer can be drafted anyway, as your
> decision, recorded on the answer. A pack that is not ready to send can be
> read as a review copy. Semantic search uses the vendor key you already have.
> The refusals those changes removed are gone from the table at the end; the one
> real control — two people on an answer — is still there, with the three ways
> through it.

---

## Who does what, and why it is more than one person

Bid-On is built around a **two-person check**. The bid writer authors and
scores; somebody else approves. This is not advisory: the writer is never shown
the approval control at all, and the platform refuses `BID_ON_SELF_APPROVAL`
behind it.

| Role | Does |
|---|---|
| **Platform operator** | Allocates the module, credits the wallet, sets the vendor keys and terms. Once. |
| **Director** (holds `G` and `A` on `BID_SERVICES`) | Service catalogue, customer workspaces, engagements, approvals, the export |
| **Bid writer** | Evidence, question list, answers, scoring. No approvals. |

If you are doing all of it yourself, sign in as the director for everything
except writing and scoring, and as the writer for those two. A single identity
cannot approve its own answer, and that is deliberate.

---

## Part 0 — Before you start (platform operator, once)

### 0.1 Allocate the module

Bid-On is a private module. It is not in any subscription and nobody without the
grant is told it exists.

1. **Platform Admin → Tenants & Users**
2. Find your company's row, press **Modules**
3. Fill in:
   - **Module** → `CONSTRUX Bid-On`
   - **Decision** → `Grant — the module becomes available to this tenancy`
   - **Reason** → in your own words, e.g. *"Bid services signed 23 October 2026"*
   - **Agreement** → **required for this module.** The signed contract or order
     reference it is allocated under, e.g. `BS-2026-014`
4. **Apply**

> Leaving **Agreement** blank gives you `MODULE_AGREEMENT_REQUIRED`. That is the
> module refusing to exist on a handshake — the grant and the agreement it was
> made under both go on the register.

### 0.2 Credit the wallet

AI work is prepaid. With an empty wallet every agent refuses before it calls
anybody, which is correct and is not a fault.

**Platform Admin → ACU & Billing →** credit the tenancy.

You can run the whole of this walkthrough without touching the wallet if you do
the reading by hand — see [Part 5](#part-5--the-question-list). The wallet is
only spent by the four AI commands, and each quotes its price before you commit.

### 0.3 Set the vendor key

**AI Engine → Keys → Set a key**

- **Which** → `OPENAI_API_KEY`
- **The key** → paste it whole, no quotes. A vendor shows a secret once; there
  is nothing to copy from their list afterwards.
- **Why** → recorded against the decision

Nothing anywhere reads a key back. The row shows eight hex characters of its
SHA-256, which tells one key from another and is not a key.

**If the row also says *and in .env*** — a superseded key is still in the file on
the host. Press **Retire the file copy**: the platform will not read it again,
so clearing the store later leaves the capability off and says so instead of
falling back to a revoked key.

Two jobs are then still yours, and the row gives you the command:

```
sed -i '/^OPENAI_API_KEY=/d' .env     # on the host
```

then **recreate the container** — the environment is read once, when the process
starts, so a deleted line still shows on this screen until it restarts. And
revoke that key at the vendor.

When both are done press **Confirm the old key is gone**, and the row stops
asking. The platform can see neither your host's file nor the vendor's console,
so that confirmation is your word — and the chain records whose, which is a
better answer at an access review than a warning everybody learned to ignore.

### 0.4 Clear the vendor for commercial material

A tender, a price and a bid response are Commercial-L3. A vendor that is not
cleared for that is refused with `AI_CLEARANCE_REQUIRED`.

One line in `.env` on the host, then recreate the container:

```
AI_PROVIDER_CLEARANCE=OPENAI:COMMERCIAL_L3
```

Add `,ANTHROPIC:COMMERCIAL_L3` for a second vendor. `AI_PROVIDER_RETENTION` is
optional and is disclosure only — it is the sentence shown before the button
saying what the vendor does with what it is sent, e.g.
`OPENAI:TRANSIENT:30:eu-west:no-training`. Left unset it reads *"nobody has
declared what OPENAI does with it"*, which blocks nothing.

**You do not have to do this to run the tender.** Without it, every AI command
refuses by name and everything in this walkthrough still works by hand.

---

## Part 1 — The standing set-up (director, once)

### 1.1 Define the service you are selling

**Bid-On → Service catalogue → Define a service**

- **Service** → `Tender quality submission`
- **Engagement type** → `One off — One or more bids, then it closes. Billed as a fixed fee.`
- **Billing basis** → `Fixed fee`
- **Starting price** → `3500` (whole pounds; it is a starting point, every
  engagement is priced per customer)
- **Currency** → `GBP`
- **What the customer gets** → one line each:
  ```
  Question list confirmed against the source
  Answers drafted, scored and signed off
  Returnables tracked to the deadline
  Submission pack exported with its evidence
  ```

> Skip this and the engagement in 2.1 refuses `BID_ON_TERMS_INCOMPLETE`. An
> engagement priced from nothing is the commonest first failure on this module.

### 1.2 Open the customer workspace

If you are bidding your **own** work, the customer is your own company.

**Bid-On → Customers → Open a customer workspace**

- **Legal name** → the exact registered name
- **Company number**, **Headcount**, **Turnover band**, **SIC codes**,
  **Sectors it bids in**, **Regions it works in** — all optional, all worth
  filling: they are the standing facts an answer is drafted from, so a blank one
  is a question you will answer by hand later.

### 1.3 Give the bid writer access

A workspace is visible to whoever opened it and to nobody else. This is
restrictive by design and it is the step people skip.

**Bid-On → Customers → Assign staff**

- **Customer** → the one you just opened
- **Give access to** → the writer's user id

> Miss this and the writer signs in to an empty Bid-On screen. Nothing is
> broken; they simply cannot see a workspace nobody gave them.

---

## Part 2 — The engagement

### 2.1 Open it

**Bid-On → Engagements → Open an engagement**

- **Customer** → yours
- **Name** → `Platform Housing EPC assessments — RFX1000209`
- **Service** → the one from 1.1. **Do not leave this on its default.**
- **Type** → `ONE_OFF`

### 2.2 Activate it

**Bid-On → Engagements → Activate** → pick it.

A draft engagement takes no bids. Activation is what opens it.

---

## Part 3 — The bid

**Bid-On → Bids → Open a bid**

- **Engagement** → the one you just activated
- **Buyer** → `Platform Housing Group` — it frames every answer, so write it as
  the buyer writes it
- **Scheme** → `ITT — a full invitation`
- **Stage** → `One stage — a registration, an open ITT, a dynamic market`
  (choose `ITT — the tender stage` only if you came through a PQQ, and then name
  it in **The PQQ it follows**)
- **Questions to the buyer close** → the ITT's clarification deadline
- **Return deadline** → `2026-11-02`
- **Buyer's reference** → `RFX1000209`

> **The 14:00 is not in the date field.** The return deadline here is a date.
> The hour matters enormously and the module does not hold it, so put
> *"Returns 14:00 — portal closes on their clock"* in the engagement name or on
> a clarification, and work to the **internal** date in Part 6 instead. That is
> the date that actually binds.

> **From today, 23 October, you have ten days.** Everything below is ordered so
> the things with lead times — a signature, a certificate, a priced cost model —
> surface first.

---

## Part 4 — The evidence library

Eight appendices and an ITT. File each one. A document can be filed and
attached without anything being read out of it — a certificate is proof whether
or not a model can read the scan.

### 4.1 File each document

**Bid-On → Evidence library → File an evidence item**, once per document:

- **Customer** → yours
- **Kind** → `Something else` for the ITT and the appendices; `Certificate` and
  `Insurance` **need an expiry**, and the platform asks for it
- **Title** → as a reviewer looking for it would describe it, e.g.
  `RFX1000209 Appendix 6 — EPC Specification`
- **The file** → pick the actual PDF, Word file, spreadsheet or scan. It is
  hashed in your browser, the record is filed first and the bytes follow — a
  dropped connection leaves a record naming a document, never bytes nothing
  names.
- **Valid from** / **Current until** → for anything that lapses
- **Data subject** / **How consent was obtained** → for a CV

Do all nine before you go on. The question list and the amendments reading both
take a document.

### 4.2 Open the library

**Bid-On → Evidence library → Whose library?** → pick your customer →
**Open the library**. It defaults to the oldest customer, and reading the wrong
library is how a run files its work against somebody else's document.

**You no longer copy an id from anywhere.** Every command that acts on a
document offers a **chooser**: your filed documents, grouped by customer, each
one labelled with its reference and title and saying whether anything has been
read out of it yet. The library screen is for *reading* the library — what has
lapsed, what nothing has been read out of — not for harvesting identifiers.

The row still carries the id and the hash, and both still copy when pressed, for
anybody driving the API directly. Where a field does take a typed value, **all
three work**: the id, the reference (`EVD-0003`) and the document hash.

> Two refusals you can still meet, and what they mean now.
> `BID_ON_EVIDENCE_AMBIGUOUS` — the same document is filed for two customers, so
> a hash does not identify one record; pick the one you mean from the chooser.
> `BID_ON_CUSTOMER_NOT_ASSIGNED` — that document belongs to a customer you are
> not assigned to, which is a denial rather than a lookup failure.

### 4.3 Get the passages out of each document

Two ways, and the manual one always works.

**With AI — Evidence library → Read it for me**

- **The document** → choose it from the list

It reads what the platform actually holds: a text-bearing PDF, a Word file or a
spreadsheet is read directly; a scan or a photograph goes to a model that can
see. On a deployment with no cleared vendor it refuses by name
(`NO_READING_PROVIDER` or `AI_CLEARANCE_REQUIRED`) and costs nothing.

**A document longer than one model request is read in parts**, one request per
part, each its own charge — so a two-hundred-page appendix costs what two
hundred pages cost rather than being refused. The result says how many parts it
took. The model is not asked to re-type text the platform already extracted; it
transcribes only a scan, where its reading is the only text of that document
anybody will ever have.

**By hand — Evidence → Type the passages myself**

- **The document** → choose it from the list
- **The passages** → one per line, optionally `page 4 | the passage`:
  ```
  page 3 | The Contractor shall complete each assessment within ten working days of instruction.
  page 4 | The certificate shall be lodged on the central register within five working days.
  page 11 | Lone working arrangements shall be evidenced for all domestic visits.
  ```

Each passage is what a citation will open to. A passage too short to mean
anything is dropped rather than indexed.

### 4.4 Optional — make the library searchable by meaning

**Evidence library → Make an item searchable by meaning** → choose a document
that has been read.

Without this, retrieval ranks on shared words, which finds a passage that uses
the buyer's vocabulary and misses the one that says the same thing differently.
With it, a question is matched against the *meaning* of your passages. A one-off
cost per item, quoted before it runs, refused if the same model has already done
it.

It uses whichever vendor you have configured — the same key that answers every
other AI call. `AI_EMBEDDING_PROVIDER` is only for pinning it to a particular
vendor, or setting `off`. Items are never compared across models: a cosine
between two models' vectors is not a weaker score, it is a number with no
meaning.

Skip it if you like. The drafter works either way and tells you which method it
used.

---

## Part 5 — The question list

The buyer's own numbering, because the export has to match the source.

**With AI — Bids → Read the questionnaire**

- **Bid** → yours
- **The questionnaire, as a filed document** → choose it from the list, **or**
- **Or paste it out of the portal** → for a portal that shows the questions on
  screen with nothing to download

One of those two, and the panel says so on the field if you press Read with both
empty rather than sending it and refusing. A long questionnaire reads in parts,
each part its own charge, and each part is told which part it is so it does not
renumber anything to look complete.

**By hand — Bids → Confirm the question list**

- **Bid** → yours (only a bid with no confirmed list; a questionnaire that
  genuinely changed is a *resync*)
- **The questions** → one per line as
  `section | number | question | type | limit | weight | M or O | PF`:
  ```
  Quality | 4.1 | Describe your EPC assessment process from instruction to lodgement | text | 500 | 25 | M |
  Health and safety | 4.2 | Set out your lone-working arrangements for domestic visits | text | 400 | 15 | M |
  Commercial | 4.3 | Confirm your rates hold for the full term | text | 300 | 20 | M |
  ```
  Type is `text`, `yes_no`, `numeric`, `upload` or `table`. Limit and weight may
  be blank. `M` is mandatory, `O` optional, `PF` pass/fail.

---

## Part 6 — What has to go back

**This is the half that disqualifies bids.** Not marked down — rejected,
because one appendix was missing from the upload.

**Bid-On → Bids → Record what has to be returned**

One per press, in fields — the register appends, because these are found across
nine documents over an afternoon rather than listed in one place.

- **Bid** → yours
- **Its reference** → the buyer's own, so the register maps onto what you
  upload: `APP3`, or a portal slot like `2.01`
- **What it is** → as somebody checking the submission would name it —
  *"Order form, completed and signed"*
- **Mandatory** → ticked by default. It **gates the export**: the pack will not
  go out with one outstanding
- **Who produces it** → *the customer* (their rates, their signature, their
  certificate — it goes into the request you send them) or *us*
- **Needs signing** → a lead time rather than a task. A document needing a
  director's signature on the 30th cannot be started on the 30th
- **Our own date** → earlier than the buyer's. With a 14:00 close, ours is the
  only date that binds
- **Format**, **Page limit**, **Size limit** → optional

For a tender with nine of them, **Record several at once** takes the same
register as one block.

A worked set for this ITT:

| Reference | What it is | Mandatory | Who | Signing | Our date |
|---|---|---|---|---|---|
| APP2 | Order form, completed and signed | yes | customer | yes | 2026-10-29 |
| APP3 | Schedule of amendments, accepted or qualified | yes | us | yes | 2026-10-29 |
| APP5 | EPC cost model, fully priced | yes | customer | — | 2026-10-30 |
| APP6 | Method statement against the specification | yes | us | — | 2026-10-30 |

---

## Part 7 — Answering

### 7.1 Open the pack and work from the rows

**Bid-On → Bids →** press **Open** on your bid's row. Press the row's own
button, not the row: the first table on this screen is *Import from Tender &
Procurement*, and opening a row there reads an empty panel.

Every question row carries a **Next** column: the one act that moves that row,
opening the command already filled in. You do not copy an id to answer a
question.

| What the row shows | What **Next** offers |
|---|---|
| nothing written | **Draft** · **Write it** |
| nothing written, a gap open | **Draft over it** · **Close the gap** |
| a draft, unscored | **Score it** · **By hand** |
| scored, unapproved | **Approve** · **Reject** |
| rejected | **Draft again** |
| approved | `signed` |

The ids are still printed on each row — `Q …`, `A …`, and the returnable and
clarification ids beside theirs — and still copy when pressed, for the panels
reached from the row of doors at the top.

### 7.2 Write the answer

**With AI — the row's own Draft**

- **Anything the drafter should know** → optional
- **Draft it even though the customer has not come back** → already ticked
  where you came from **Draft over it**

The panel quotes what the pass will cost before you commit, and will not submit
until the price is on screen.

Retrieval runs first, against this customer's evidence only. Then one of two
things happens, and the console says which:

- **Drafted** — a version is written and cited, waiting to be scored.
- **No draft — a gap was raised.** Nothing on file could be cited, so nothing
  was written and no model was called: a model asked to answer a question its
  evidence cannot support writes exactly the uncited claim that gets a
  submission thrown out. The gap is on the bid with the request to send the
  customer.

Where the library has not been embedded (4.4), the message adds that this was a
**word search** and how many passages were not compared. That changes what to do
next: a gap after a word search often means *not found*, not *not held*, and
making the library searchable by meaning is worth doing before deciding a
document is missing.

**A question that asks for a fact about the company** — a registration number, a
share code, an insurance limit — will always raise a gap, because no document in
the library evidences it. That is what **Write it** is for. A hand-written
answer goes through the same citation check, versioning and approval as an
agent's, and no hard rule fires on an uncited one; it scores lower on Evidence,
which for a registration number is correct and unavoidable. Then **Close the
gap** on that row with the note that says what closed it.

A question already waiting on the customer is refused *unless* you tick the box.
Then the model is told what is outstanding and told not to write as though it
were in hand, and the answer records that it was drafted over the gap — so
whoever reviews it reads the draft and the open question together. Two days
before a return that is usually the right call, and it is yours to make.

**By hand — Bids → Write an answer**

- **Bid** → yours
- **Question id** → from the pack
- **The answer** → e.g.

  > We complete each assessment within ten working days of instruction and lodge
  > the certificate on the central register within five working days of
  > completion, in line with Appendix 6, clause 3.

Sign in **as the bid writer** for this. An answer written by the person who will
approve it defeats the check in 8.2.

---

## Part 8 — Scoring and the second person

### 8.1 Score it (writer)

**The row's own Score it** runs the same rubric as an adversarial read, with a
cleared vendor, and is deliberately not shown the retrieval — a scorer that saw
it would be marking the drafter's homework against the drafter's own notes.

**By hand** on the same row opens the five criteria:

- **Compliance (30%)** + **Why** → *"Answers every part of 4.1 in the order asked"*
- **Evidence (25%)** + **Why** → *"Cites the lodgement passage from Appendix 6"*
- **Buyer relevance (20%)** + **Why** → *"Uses the buyer's own response-time language"*
- **Specificity (15%)** + **Why** → *"Names the ten and five working-day commitments"*
- **Clarity and limits (10%)** + **Why** → *"Inside the 500-word limit"*

Every score carries a reason. A number with no sentence behind it is an opinion
with a decimal point on it.

### 8.2 Approve it (director)

Sign back in as the director. The scored row now offers **Approve** and
**Reject**.

- **Note** → *"Read against 4.1; citations check out; inside the word limit"*

> As the writer you will not find this button. It is not disabled — it is not
> there, because the screen does not offer an act that identity could never
> complete.

If you are testing on your own and meet `BID_ON_SELF_APPROVAL`, there are three
ways on and the refusal names all of them. The one worth knowing: the rule
applies to an answer a **person** wrote, so an agent's draft that you review and
sign **is** the two-person check and is allowed. Draft it with the AI, read it
properly, and approve that.

**Reject with instructions** sends it back with what to change.

---

## Part 9 — Questions to the buyer

Most of these are already there. Reading the limits, the returnables register
and the schedule of amendments each raises questions of its own — a schedule of
amendments against JCT MTC 2024 raised **thirty-seven** on one tender — and
they are all in the opened pack under **Questions for the buyer**, worst first,
with the count by severity in the heading.

Add the ones only a reader finds:

**Bid-On → Bids → Raise a question for the buyer**

- **How much it matters** → `Critical — we cannot price or insure it as it stands`
- **Subject** → `Rate schedule and third-floor walk-ups`
- **The question, as you would ask it** → written to send, not summarised

### Sending them

They go as **one message**, not one at a time. A procurement portal takes a
single clarification message with the questions numbered inside it, and the
buyer answers the lot in one response issued to every bidder.

So in the **Questions for the buyer** panel:

- **Copy the N critical** — the ones that cannot be left unasked, as a message
  ready to paste. Use this when the window is nearly shut and you have to
  choose.
- **Copy all N to send** — every question not yet asked, worst first.
- **Download it** — the same message as a `.txt`, for a portal that takes an
  attachment and for your own record of what went.

The message names the tender, numbers each question and carries **our**
reference against it, so the buyer's answer leads back to one row. It does
**not** carry the severity: *"critical — we cannot price or insure it as it
stands"* is written for a colleague, and a buyer reading it learns exactly where
you are soft.

Sending is done in the buyer's portal. The platform does not email a buyer and
will not: a clarification goes under a named account in an audited procurement.

### Recording that they went

**Questions for the buyer → Record that they went**

- **What went** → pre-ticked with everything outstanding, worst first. Untick
  anything you held back.
- **The day it went** → blank is today. Put the real date if you are recording
  it after the fact.
- **Their reference** → the buyer's own number for the message.

One message, one date, one reference, one entry on the thread. Recorded as all
of them or none — a set with one id the bid does not hold is refused whole,
rather than leaving nobody able to say which ones went.

A date after the clarification deadline is **recorded, not refused**. It is a
fact, and a buyer may or may not answer a late question; the standing says
plainly that it went late.

**Record that we asked it** is still there for one question sent on its own.

Then **Record the buyer's answer** when they reply, verbatim. Their answer is
part of the tender documents from the moment they give it, so a paraphrase is a
new claim with nobody's name on it. What the answer *changes* — a stated limit,
a waived returnable, a moved date — is a separate act on the record it changes.

**Withdraw a question** for one that will not be asked, with the reason. The
reason is what stops the module raising the same subject again next time a
register is added to.

---

## Part 10 — The site visit, if the ITT has one

The walk is part of the tender, and what it finds has to reach the price.

**Field Execution → Record a site visit**

- **Purpose** → `Bid` — refused once the project is past tender, because a bid
  walk on a job under construction is a mislabelled progress walk
- **Walked on** → the day it was walked, not the day it was written up
- **Who was there** → including the buyer's representative

Then, on the same screen, **Raise a site finding** for anything that costs money:

- **What was found**, **Where**, **How it is known** (observed on site needs a
  photograph; anything else names its source)
- **What it obliges** → `Prices`
- **Discharged by** → **`Tender return`**

That last one is the only deadline on the register that cannot move, and it is
shown in red above everything else. A cost found on the walk and left to close
at mobilisation is one you have already agreed to carry for nothing.

---

## Part 11 — The pack, and the export

### 11.1 Read it before it is finished

**Bids → Open** on your bid's row. At the foot of the pack are three buttons —
**Word**, **Spreadsheet**, **Copy-ready text** — and they work whether or not
the pack is ready to send.

While anything is outstanding they say **"review copy"**, and that is what comes
out: the file is named `REVIEW-…`, its first page (or first sheet, or first block
of text) says `REVIEW COPY — NOT FOR SUBMISSION` and lists exactly what is
outstanding. It is the pack, in the buyer's own structure, in source order —
reviewing it is how it gets finished, and waiting until it was finished to read
it was backwards.

A file that ends up on somebody's desktop cannot be mistaken for the submission,
which is the condition on this working at all.

### 11.2 Export it

**Bids → Export the pack** → pick the bid by its own reference, `BON-nnnn`.

This is the act with the gate on it, and it refuses while a mandatory answer is
unapproved or a mandatory returnable is outstanding —
`BID_ON_NOT_EXPORTABLE — … 1 mandatory returnable is outstanding`, naming every
blocking item rather than the first. That is the gate doing its job the day
before the return rather than the buyer doing it after.

For each one that is done: **Bids → Mark a returnable done** with the returnable
id from the pack, a note, and the filed document that is it — a chooser, not a
hash to type.
**Waive a returnable** where the buyer has agreed it does not apply — and the
waiver goes on the record with it.

Then export again. After the gate passes, the same three buttons produce the
real file: no REVIEW in the name, no outstanding list on the front.

---

## Part 12 — Afterwards

**Bid-On → Bids → Record the outcome.** Won or lost, the marks the buyer gave,
the winning price where they disclosed it, and **what the evaluator actually
said, in their words**.

This is not admin. It is the only thing the next tender is priced from: the
calibration reads settled bids for where your price sits against the market,
what a win-probability score has been worth, and where the estimate runs low.
Without it the business loses the same money twice.

---

## What it will refuse, and what to do

| Refusal | What it means | What to do |
|---|---|---|
| `MODULE_AGREEMENT_REQUIRED` | Bid-On is allocated only under a signed agreement | Operator: fill in **Agreement** on the module grant (0.1) |
| `BID_ON_TERMS_INCOMPLETE` | The engagement has no priced service behind it | Define a service (1.1), then pick it on the engagement — do not leave the chooser on its default |
| An empty Bid-On screen for the writer | A workspace is visible to whoever opened it | **Assign staff** (1.3) |
| `AI_CLEARANCE_REQUIRED` | No vendor is cleared for Commercial-L3 | Declare the vendor's terms (0.4), or do the reading by hand |
| `NO_READING_PROVIDER` / `NO_REASONING_PROVIDER` | This deployment is on the local stand-in | Set a key (0.3) and clear the vendor (0.4), or use the manual twin of the command |
| `AI_PROVIDER_ERROR — 401` | The key is wrong, truncated or revoked | Re-set it whole (0.3); if the row says *and in .env*, retire the file copy |
| Wallet refusals | AI is prepaid and the wallet is empty | Credit it (0.2). No charge is ever taken without a ledger entry |
| `BID_ON_EVIDENCE_NOT_FOUND` | Nothing in the library is that value | Use the chooser. Typed, an id, a reference (`EVD-0003`) and a document hash all work |
| `BID_ON_EVIDENCE_AMBIGUOUS` | The same document is filed for two customers, so a hash names two records | Pick the one you mean from the chooser |
| `BID_ON_CUSTOMER_NOT_ASSIGNED` | That document belongs to a customer you are not assigned to | **Assign staff** (1.3), or work on the right customer |
| `BID_ON_NOTHING_TO_PARSE` | Neither a document nor pasted text reached the parser | Choose the filed questionnaire, or paste the questions. The panel now says so on the field |
| `BID_ON_NOTHING_READ` | The document is filed and nothing has been read out of it | **Read it for me**, or **Type the passages myself** (4.3) |
| `BID_ON_FORMAT_UNREADABLE` | A scan with no text layer and no vision model | Clear a vendor with perception, or type the passages |
| `BID_ON_GAP_OPEN` | That question is waiting on the customer | Close the gap, or tick **Draft it even though the customer has not come back** (7.2) |
| `BID_ON_SELF_APPROVAL` | One identity wrote and approved | Approve as the director (8.2) — or let the drafter write it and sign that, which is the two-person check |
| `BID_ON_NOT_EXPORTABLE` | A mandatory answer or returnable is outstanding | Mark it done or waive it (11.2). To *read* the pack now, take a review copy (11.1) |
| `AI_EMBEDDING_NOT_CONFIGURED` | No vendor with an embedding endpoint has a key | Set a vendor key (0.3). Blank `AI_EMBEDDING_PROVIDER` now means "whichever is configured", not "off" |
| `AI_INPUT_TOO_LARGE` | More than any cleared vendor's context window holds in one request | Nothing was sent or charged. The readers split a document themselves; this is for a payload that cannot be split |
| `EVIDENCE_TOO_LARGE_TO_READ` | The file is held, and too large to hold in memory to inspect | It still downloads and streams. Raise `EVIDENCE_ANALYSE_MAX_BYTES`, or work from a smaller copy |

---

## Where each value comes from

Nothing asks you to invent one, and nothing that names a **document** asks you
to type one at all.

| Value | Where it is |
|---|---|
| **A document** | A chooser on every panel that acts on one, grouped by customer, each option saying whether anything has been read out of it |
| **Question id** | Bids → **Open** on the bid's row → beside each question. Press to copy. |
| **Answer id** | The opened pack → beside each answer, once one exists |
| **Returnable id** | The opened pack → beside each returnable |
| **Gap id** | The opened pack → beside each open gap |
| **Bid reference** (`BON-nnnn`) | The opened pack. The export picker names a bid by this and carries no buyer name. |
| **Evidence id / document hash** | Still on the library row, still copyable, for anybody driving the API directly |

---

## Proof this path works

`tools/bidon-walk.mjs` drives all of it in a real browser — twenty-five steps
from allocating the module to exporting the pack — and runs on `AI_MODE=local`,
where every agent refuses by name. So the manual route is the one that is
continuously tested, and the AI commands are separately asserted to **open and
refuse by name** rather than hang, which is where an unreachable command hides.

It is a development tool and it writes real records with development sign-in
codes. Do not point it at a live deployment.
