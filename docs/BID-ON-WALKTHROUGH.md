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
will refuse you, it says so and why — those refusals are the point of the
module, not obstacles in it, and each one is listed in
[What it will refuse, and what to do](#what-it-will-refuse-and-what-to-do).

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
falling back to a revoked key. Two things are still yours afterwards, and the
row gives you the command: delete the line from `.env` on the host, and revoke
that key at the vendor.

### 0.4 Declare what the vendor's agreement says

**This is the step that decides whether the agents will touch your tender at
all.** A tender, a price and a bid response are Commercial-L3; a vendor nobody
has cleared for that is refused, and you will see
`AI_CLEARANCE_REQUIRED`.

**AI Engine → What the agreement with each vendor says → Record a vendor's terms**

- **Vendor** → `OPENAI`
- **May be handed, at most** → `Commercial l3`
- **What it does with it** → whichever your agreement says
- **For how many days** → their figure, where it keeps it for a period
- **Processed in** → e.g. `eu-west`
- **Excluded from model training** → tick **only** if the agreement says so in
  writing
- **Which agreement** → what somebody would have to go and read, e.g.
  *"Enterprise agreement, zero-retention addendum, 14 Oct 2026"*
- **Why now** → recorded against the decision

It will refuse you if the agreement, the region or the training answer is
missing, and it names all of them at once. That refusal is the point: above
*internal* the platform is being told it may send a third party your commercial
material, and a reassurance on a screen with no contract behind it is worse than
the refusal it replaces.

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

### 4.2 Open the library and read the ids off it

Several commands below take an **evidence id** and one takes a **document
hash**. Both are on the row, and both copy to the clipboard when you press them.

1. **Bid-On → Evidence library**
2. **Whose library?** → **pick your customer.** It defaults to the oldest one,
   and reading the wrong library is how a run files its work against somebody
   else's document.
3. **Open the library**
4. In the **ids** column press the short underlined code to copy the **evidence
   id**; press **Copy hash** beneath it for the **document hash**

> `BID_ON_EVIDENCE_NOT_FOUND — No evidence sha256:…` means you pasted the hash
> where the id was asked for. They are different things and the refusal now says
> so: the id is the short underlined code on the row, the hash is behind **Copy
> hash**.

### 4.3 Get the passages out of each document

Two ways, and the manual one always works.

**With AI — Evidence library → Read it for me**

- **Evidence id** → from 4.2

It reads what the platform actually holds: a text-bearing PDF, a Word file or a
spreadsheet is read directly; a scan or a photograph goes to a model that can
see. On a deployment with no cleared vendor it refuses by name
(`NO_READING_PROVIDER` or `AI_CLEARANCE_REQUIRED`) and costs nothing.

**By hand — Evidence → Type the passages myself**

- **Evidence id** → from 4.2
- **The passages** → one per line, optionally `page 4 | the passage`:
  ```
  page 3 | The Contractor shall complete each assessment within ten working days of instruction.
  page 4 | The certificate shall be lodged on the central register within five working days.
  page 11 | Lone working arrangements shall be evidenced for all domestic visits.
  ```

Each passage is what a citation will open to. A passage too short to mean
anything is dropped rather than indexed.

---

## Part 5 — The question list

The buyer's own numbering, because the export has to match the source.

**With AI — Bids → Read the questionnaire**

- **Bid** → yours
- **Pasted from the portal** → paste the question set, **or**
- **Or a document hash** → the hash from 4.2

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

- **Bid** → yours
- **The returnables** → one per line as
  `ref | what it is | M or O | PROVIDER or CUSTOMER | format | pages | MB | SIG | our date`:
  ```
  APP2 | Order form, completed and signed | M | CUSTOMER | PDF | | | SIG | 2026-10-29
  APP3 | Schedule of amendments, accepted or qualified | M | PROVIDER | PDF | | | SIG | 2026-10-29
  APP5 | EPC cost model, fully priced | M | CUSTOMER | XLSX | | | | 2026-10-30
  APP6 | Method statement against the specification | M | PROVIDER | PDF | 10 | | | 2026-10-30
  ```

Only the first four matter; the rest may be blank.

- **`M`** gates the export. The pack will not go out with one outstanding.
- **`CUSTOMER`** means only they can produce it — their rates, their signature —
  and it goes into the request you send them.
- **`SIG`** means it needs signing, which is a lead time rather than a task.
- **our date** is *your* internal date, earlier than the buyer's. It is the one
  that actually binds, and with a 14:00 close it is the only date that does.

---

## Part 7 — Answering

### 7.1 Open the pack and take the ids

**Bid-On → Bids →** press **Open** on your bid's row. Press the row's own
button, not the row: the first table on this screen is *Import from Tender &
Procurement*, and opening a row there reads an empty panel.

The opened pack carries, each copyable by pressing it:

- the bid's own reference, `BON-nnnn` — the export picker names a bid by this
  and not by the buyer
- a **question id** per question
- a **returnable id** per returnable
- an **answer id** per answer, once one exists

### 7.2 Write the answer

**With AI — Bids → Draft an answer**

- **Bid** → yours
- **Question id** → from the pack
- **Anything the drafter should know** → optional

The panel quotes what the pass will cost before you commit, and will not submit
until the price is on screen.

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

**Bid-On → Bids → Score an answer**

- **Bid** → yours, **Answer id** → from the pack
- **Compliance (30%)** + **Why** → *"Answers every part of 4.1 in the order asked"*
- **Evidence (25%)** + **Why** → *"Cites the lodgement passage from Appendix 6"*
- **Buyer relevance (20%)** + **Why** → *"Uses the buyer's own response-time language"*
- **Specificity (15%)** + **Why** → *"Names the ten and five working-day commitments"*
- **Clarity and limits (10%)** + **Why** → *"Inside the 500-word limit"*

Every score carries a reason. A number with no sentence behind it is an opinion
with a decimal point on it.

**Bids → Score it as the buyer would** runs the same rubric as an adversarial
read, if you have a cleared vendor.

### 8.2 Approve it (director)

Sign back in as the director.

**Bid-On → Bids → Approve an answer**

- **Bid** → yours, **Answer id** → from the pack
- **Note** → *"Read against 4.1; citations check out; inside the word limit"*

> As the writer you will not find this button. It is not disabled — it is not
> there, because the screen does not offer an act that identity could never
> complete.

**Reject with instructions** sends it back with what to change.

---

## Part 9 — Questions to the buyer

Anything you cannot price or insure as it stands.

**Bid-On → Bids → Raise a question for the buyer**

- **How much it matters** → `Critical — we cannot price or insure it as it stands`
- **Subject** → `Rate schedule and third-floor walk-ups`
- **The question, as you would ask it** → written to send, not summarised

Then **Record that we asked it** with the day it went and the buyer's reference,
and **Record the buyer's answer** when Harry O'Neill replies. The answer becomes
part of the record the submission is built on.

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

## Part 11 — The export

**Bid-On → Bids → Export the pack** → pick the bid by its own reference,
`BON-nnnn`.

It will refuse while a mandatory returnable is outstanding —
`BID_ON_NOT_EXPORTABLE — BON-0001 cannot be exported. 1 mandatory returnable is
outstanding`. That is the gate doing its job the day before the return rather
than the buyer doing it after.

For each one that is done: **Bids → Mark a returnable done** with the returnable
id from the pack and a note. **Waive a returnable** where the buyer has agreed
it does not apply — and the waiver goes on the record with it.

Then export again.

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
| `BID_ON_EVIDENCE_NOT_FOUND — No evidence sha256:…` | A document hash where an evidence id was asked for | The short underlined code on the library row, not **Copy hash** |
| `BID_ON_NOTHING_READ` | The document is filed and nothing has been read out of it | **Read it for me**, or **Type the passages myself** (4.3) |
| `BID_ON_FORMAT_UNREADABLE` | A scan with no text layer and no vision model | Clear a vendor with perception, or type the passages |
| `BID_ON_SELF_APPROVAL` | One identity wrote and approved | Approve as the director (8.2). The writer is never shown the control |
| `BID_ON_NOT_EXPORTABLE` | A mandatory returnable is outstanding | Mark it done or waive it (11) |

---

## Where each id comes from

Nothing asks you to invent one.

| Id | Where it is |
|---|---|
| **Evidence id** | Evidence library → **Whose library?** → **Open the library** → the short underlined code in the **ids** column. Press to copy. |
| **Document hash** | The same row → **Copy hash** |
| **Question id** | Bids → **Open** on the bid's row → beside each question. Press to copy. |
| **Answer id** | The opened pack → beside each answer, once one exists |
| **Returnable id** | The opened pack → beside each returnable |
| **Bid reference** (`BON-nnnn`) | The opened pack. The export picker names a bid by this and carries no buyer name. |

---

## Proof this path works

`tools/bidon-walk.mjs` drives all of it in a real browser — twenty-five steps
from allocating the module to exporting the pack — and runs on `AI_MODE=local`,
where every agent refuses by name. So the manual route is the one that is
continuously tested, and the AI commands are separately asserted to **open and
refuse by name** rather than hang, which is where an unreachable command hides.

It is a development tool and it writes real records with development sign-in
codes. Do not point it at a live deployment.
