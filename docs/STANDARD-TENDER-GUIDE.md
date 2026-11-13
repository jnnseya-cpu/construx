# CONSTRUX — Standard Tender: user guide

How to take a tender from the documents the buyer sent to a submission that will
go out, using the **standard Tenders section** (Pipeline & Bids and Tender &
Procurement). Worked against a real invitation — **SHDC 000189, Aids &
Adaptations, 96 Railway Lane South** — so every step names what you actually
press and what you should see after it.

The golden rule the platform holds everywhere: **the AI proposes, a person
confirms.** Nothing the AI reads or drafts reaches the record until you confirm
it, and confirming runs the same commands as doing it by hand.

Two screens do the work:
- **Pipeline & Bids** — the invitation, the compliance matrix, the evidence, the
  response pack, and the company's own facts.
- **Tender & Procurement** — pricing, the quotation, and the clarification
  register (raise / track / answer / issue).

---

## The workflow at a glance

| # | Stage | Screen | Does |
|---|---|---|---|
| 1 | File the documents | Pipeline & Bids | Upload the pack |
| 2 | Read with the AI | Pipeline & Bids | Compliance matrix, returns, commercial assessment |
| 3 | Measure the drawings | Pipeline & Bids | Take-off → the bill |
| 4 | Raise clarifications | Pipeline & Bids → Tender & Procurement | The AI's questions to the client, tracked |
| 5 | Add the evidence | Pipeline & Bids | Company facts (insurances, accreditations) + claims |
| 6 | Price it | Tender & Procurement | Price the bill → draw up the quotation (Annex 1) |
| 7 | Answer the questions | Pipeline & Bids | Response pack (quality, social value), red-team |
| 8 | Returns & submit | Pipeline & Bids | Assign the returns, issue the pack, send in In-Tend |

---

## 1 · File the documents
**Pipeline & Bids → "Read an invitation with AI" → Upload a tender document.**
Select the whole pack at once (ITT, pricing schedule, appendices, drawings,
Annex 1). Each file is hashed and filed as its own record. Nothing is read yet —
this only records that the file arrived.

## 2 · Read every document with the AI
In the filed-documents list, each file carries action buttons:
- **Read as an invitation** / **Read it with a model that can see** (for a scanned
  PDF) → produces the **compliance matrix**, the **return register** and the
  **commercial assessment**.
- It arrives as a **draft** — review it, then **confirm** it. (A reading is a
  draft until you confirm; confirming records it through the same commands as
  typing it in.)

**See it:** the matrix appears under **"Compliance matrices on file"**; the
mandatory returns appear under **"What has to go back"**.

> SHDC note: you will have several matrices if you also "read" the pricing
> schedule / Annex 1 as invitations. The one to work is the **26-requirement
> "South Holland District Council Invitation to Tender"**.

## 3 · Measure the drawings into the bill
For each file read as a **drawing**:
1. Press **Measure quantities** → the AI runs a take-off and returns a **draft**.
2. Review the draft → **Confirm take-off**.
3. The measured items land in the **bill** (SHDC: 43 measured items).

## 4 · Raise & track clarifications
**Where the AI's questions are:** open the SHDC matrix (press **Open** on its row
under *Compliance matrices on file*), scroll to the bottom — past *The buyer's
marking scheme* — to **"Questions for the buyer"**. These are the questions the
AI raised from the documents (e.g. the four insurance gaps).

**Raise them — one click:** press **"Raise these to the client"** on that list.
Every question goes onto the clarification register as a **TQ**, to the client,
with no retyping. Pressing it again is safe — anything already raised is skipped.

**Track them on Tender & Procurement:**
- **Check against the pack** — the AI checks whether the ITT already answers a
  TQ, citing the passage; if so, **Withdraw a clarification** (reason required).
- Send the open TQs through the buyer's portal (SHDC: **In-Tend**).
- **Record the client's answer** — paste their exact words + the date; the TQ
  closes. The register flags any TQ **overdue** or **due-soon**.
- (A question a *bidder* asked you is answered with **Issue the answer**, which
  goes to every entitled bidder.)

*Manual alternatives, if you ever need them:* **Raise a clarification** (one, with
a subject, the question and at least one link) or **Raise several clarifications**
(a reviewed set, one per line as `subject | question | reference`).

## 5 · Add the required evidence
The opened matrix tells you exactly what to add, in two lists:
- **"Add these to your library before you submit"** — the pass/fail evidence
  gates (insurances, accreditations, DBS, policies, references), mandatory first.
- **"Attach these when you submit"** — the documents you already hold that answer
  the matrix.

**Company facts — Pipeline & Bids → "Update the company's facts"** (bottom of the
screen): enter **Insurances** (one per line: `cover | limit in £ | renews on`,
e.g. `Employers Liability | 10000000 | 2027-03-31`), **Accreditations**
(Constructionline…), turnover and capacity. Entering the insurances flips SHDC's
four insurance **Gaps → Satisfied**.

**Document-backed claims — "Assert a claim"** (under *Claims the submission can
make*): choose the **Kind**, write **the sentence it proves**, and point it at the
**document hash**. A **second person** then runs **Verify a claim** (the asserter
cannot verify their own).

## 6 · Price it (commercial, 35% / Annex 1)
**Tender & Procurement:**
1. **Price the bill** — price every outstanding cost head or state it as an
   **exclusion** in writing (a nought is neither, and blocks).
2. **Draw up the quotation** — composes the priced offer from the estimate; this
   is the commercial content for **Annex 1**.

## 7 · Answer the ITT questions (quality 60% / social value 5%)
**Pipeline & Bids → "Bid response packs":**
1. **Plan a response pack** → choose the SHDC matrix → creates **BID-nnnn** with
   one section per deliverable that needs prose (the six Quality Questions,
   Social Value, methodology).
2. **Write the next section** (AI) — press until every section is written (the
   agent drafts; you confirm; needs your AI provider configured).
3. **Capture an answer → Approve for reuse** (second person) banks good answers
   in the library for the next bid.
4. **Attack the pack** (red team) → **Set the quality floor** → **Record a
   decision on a finding**: scored answers below the floor block; criticals are
   hard blocks.

## 8 · Returns & submit
- **Assign a return** — on *What has to go back*, give each mandatory return
  (Quality Questions, Commercial Questionnaire/Annex 1, FOI response,
  Non-Collusion certificate) an **Owner**, the **Source** (its page/annex) and an
  **internal date**. This clears the "blocks the bid" items.
- **Issue the pack** — refused, naming every outstanding item, unless every
  deliverable is answered and every deadline dated.
- Send the complete submission through **In-Tend** before the deadline
  (SHDC: **2026-11-20 12:00**).

---

## Where things are — quick map

| You want to… | Go to |
|---|---|
| Upload the pack | Pipeline & Bids → Read an invitation with AI → Upload |
| Turn documents into a matrix | Pipeline & Bids → the file's **Read as an invitation** |
| Measure a drawing | Pipeline & Bids → the file's **Measure quantities** → Confirm take-off |
| See the AI's buyer questions | Open the matrix → bottom → **Questions for the buyer** |
| Raise those questions in one click | **Raise these to the client** on that list |
| Track / answer / issue a clarification | Tender & Procurement → clarification register |
| Record insurances & accreditations | Pipeline & Bids → **Update the company's facts** |
| Add a document-backed claim | Pipeline & Bids → **Assert a claim** / **Verify a claim** |
| Price the bill / quotation | Tender & Procurement → **Price the bill** / **Draw up the quotation** |
| Write the submission | Pipeline & Bids → Bid response packs → **Plan a response pack** / **Write the next section** |
| Red-team the submission | Pipeline & Bids → The red team → **Attack the pack** |
| Assign a mandatory return | Pipeline & Bids → What has to go back → **Assign a return** |
| Programme to the submission deadline | Pipeline & Bids → **Build tender programme** (back-plans the submission timeline from the return date) |

---

*Scope note: this guide covers the standard Tenders workflow. The ETABLIX
site-services module and the Bid-On add-on each have their own screens and are
not covered here.*
