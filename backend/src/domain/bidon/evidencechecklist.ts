import { EVIDENCE_TYPE, type EvidenceType, type EvidenceSummary } from './evidence.ts';

/**
 * What a bidder is asked for, said at the start instead of discovered at the end.
 *
 * ## The problem this closes
 *
 * The library was a bag you filled and then found out, one low-scoring answer at
 * a time, what it was missing. A question wanted a method statement, the drafter
 * had nothing to cite, the answer scored forty, and only then — after a paid
 * draft — did anybody learn the document was needed. On a tender week that is
 * the most expensive order to learn things in.
 *
 * A tender does not ask for surprising things. A construction or assessment
 * business is asked for the same two dozen documents by every buyer it ever
 * bids to: the insurances, the accreditations, the policies, a few case studies,
 * the people's qualifications, the accounts. That set is knowable on the day the
 * workspace is opened, before a single question is read. So it is stated here,
 * and the library screen measures the customer's holdings against it from the
 * start — what to put in, and where, so retrieval has the right material to pick
 * up when the drafting begins.
 *
 * ## This is the standing set; `planEvidenceNeeds` is the per-tender one
 *
 * Two passes, deliberately. This is the fixed checklist every bidder works to,
 * needs no model and no questionnaire, and is the first thing a new workspace
 * shows. `engine.ts`'s `planEvidenceNeeds` is the second: it reads one tender's
 * confirmed questions and names what *that* questionnaire specifically asks for
 * beyond the standing set. The standing list stops the obvious gaps; the
 * per-tender pass catches the particular ones.
 *
 * ## Coverage is a transparent guess, never a claim
 *
 * An item is marked "held" when a current filed document's title matches its
 * keywords — stated as "likely EVD-0003", never as a settled fact, because a
 * title is what somebody typed and the precise check (does this document
 * actually evidence professional indemnity at the required limit) is the
 * retriever's job at drafting time. A coarse match that over-claimed coverage
 * would be the library screen lying about readiness, which is the one thing it
 * exists not to do.
 */

export type ChecklistImportance = 'ESSENTIAL' | 'COMMON' | 'SOMETIMES';

export type ChecklistItem = {
  /** Stable key, for the UI and for tests. */
  key: string;
  /** What a person calls it. */
  label: string;
  /** The evidence type it is filed under, so the File action pre-selects it. */
  type: EvidenceType;
  /** How often a tender asks for it, which orders the list and sets the badge. */
  importance: ChecklistImportance;
  /** What it is for, in the words of somebody deciding whether to go and find it. */
  why: string;
  /**
   * Fragments matched as whole words against a document's title and its opening
   * line. Deliberately specific — "professional indemnity" not "insurance" — so
   * three different insurances do not all satisfy one row, and matched on word
   * boundaries so the abbreviations earn their place: "PI" matches the word *PI*
   * in a title like "PI and PL" without also matching "pipe" or "shipping".
   */
  match: string[];
};

/**
 * The standing set. A reference table, like the rubric weights and the volume
 * bands: domain knowledge that belongs in code and is extended here, in one
 * place, rather than re-derived per deployment.
 *
 * Ordered essential-first within the file; the UI re-groups by importance.
 */
export const EVIDENCE_CHECKLIST: readonly ChecklistItem[] = [
  // --- The ones a mandatory returnable or a pass/fail question turns on -------
  {
    key: 'professional-indemnity',
    label: 'Professional indemnity insurance',
    type: 'INSURANCE',
    importance: 'ESSENTIAL',
    why: 'Almost every professional-services tender states a minimum PI limit and fails a bidder who cannot show it. The certificate also carries the renewal date, which a hard rule checks against the return.',
    match: ['professional indemnity', 'pi insurance', 'pi cover', 'pi', 'pii'],
  },
  {
    key: 'public-liability',
    label: 'Public liability insurance',
    type: 'INSURANCE',
    importance: 'ESSENTIAL',
    why: 'A stated minimum on any tender involving work on or around a site or the public.',
    match: ['public liability', 'pl insurance', 'pl'],
  },
  {
    key: 'employers-liability',
    label: "Employer's liability insurance",
    type: 'INSURANCE',
    importance: 'ESSENTIAL',
    why: 'A legal requirement for a business with employees, and a document buyers ask to see rather than assume.',
    match: ["employer's liability", 'employers liability', 'el insurance', 'el'],
  },
  {
    key: 'health-safety-policy',
    label: 'Health & safety policy',
    type: 'POLICY',
    importance: 'ESSENTIAL',
    why: 'Asked for on essentially every construction tender, usually as a mandatory returnable with a signature and a review date.',
    match: ['health and safety', 'health & safety', 'h&s', 'hse policy'],
  },
  {
    key: 'accreditations',
    label: 'Accreditations & scheme memberships',
    type: 'CERTIFICATE',
    importance: 'ESSENTIAL',
    why: 'The scheme cards a buyer screens on — for EPC work, the assessor accreditation and the certification-body membership. Often a pass/fail gate.',
    match: ['accreditation', 'accredited', 'elmhurst', 'stroma', 'quidos', 'epc assessor', 'chas', 'constructionline', 'safecontractor'],
  },
  // --- Asked for on most tenders ---------------------------------------------
  {
    key: 'quality-management',
    label: 'Quality management system (ISO 9001 or equivalent)',
    type: 'CERTIFICATE',
    importance: 'COMMON',
    why: 'A quality question or a certificate request appears on most framework tenders; the certificate or the written QA procedure answers it.',
    match: ['iso 9001', 'quality management', 'quality assurance', 'qa procedure', 'quality policy'],
  },
  {
    key: 'environmental',
    label: 'Environmental management (ISO 14001 or policy)',
    type: 'CERTIFICATE',
    importance: 'COMMON',
    why: 'Social-value and environmental sections ask how the business manages its own impact; the certificate or policy is the evidence.',
    match: ['iso 14001', 'environmental management', 'environmental policy', 'carbon', 'net zero'],
  },
  {
    key: 'case-studies',
    label: 'Case studies / past performance',
    type: 'CASE_STUDY',
    importance: 'COMMON',
    why: 'Quality and experience questions are scored on named, comparable projects. Two or three relevant case studies are what turns a generic answer into a specific one.',
    match: ['case study', 'case studies', 'past performance', 'reference project', 'track record'],
  },
  {
    key: 'key-staff-cvs',
    label: 'Key staff CVs & qualifications',
    type: 'CV',
    importance: 'COMMON',
    why: 'Resourcing and competency questions ask who does the work and what they hold. CVs with consent carry the qualifications a drafter cites.',
    match: ['cv', 'curriculum vitae', 'qualification', 'competency', 'resume'],
  },
  {
    key: 'financial-standing',
    label: 'Financial standing / recent accounts',
    type: 'STATS',
    importance: 'COMMON',
    why: 'A turnover threshold or an accounts request is a common gate. The figures also answer the economic-standing section directly.',
    match: ['accounts', 'turnover', 'financial', 'balance sheet', 'annual report'],
  },
  // --- Asked for on many public-sector and framework tenders ------------------
  {
    key: 'equality-diversity',
    label: 'Equality, diversity & inclusion policy',
    type: 'POLICY',
    importance: 'SOMETIMES',
    why: 'A standard public-sector policy request; the written policy answers it.',
    match: ['equality', 'diversity', 'inclusion', 'edi policy'],
  },
  {
    key: 'modern-slavery',
    label: 'Modern slavery & anti-bribery policy',
    type: 'POLICY',
    importance: 'SOMETIMES',
    why: 'Compliance sections ask for the statement or policy by name.',
    match: ['modern slavery', 'anti-bribery', 'anti bribery', 'bribery', 'ethics policy'],
  },
  {
    key: 'data-protection',
    label: 'Data protection / GDPR policy',
    type: 'POLICY',
    importance: 'SOMETIMES',
    why: 'Any tender handling personal data asks how the bidder complies; the policy is the evidence.',
    match: ['data protection', 'gdpr', 'privacy policy', 'information security', 'iso 27001'],
  },
] as const;

export type ChecklistStatus = 'CURRENT' | 'LAPSED' | 'MISSING';

export type ChecklistResult = {
  key: string;
  label: string;
  type: EvidenceType;
  importance: ChecklistImportance;
  why: string;
  status: ChecklistStatus;
  /** The filed document taken to cover it, where one matched. Never asserted as certain. */
  coveredBy?: { reference: string; title: string };
};

export type ChecklistCoverage = {
  items: ChecklistResult[];
  /** Essentials held and current, over essentials total — the headline figure. */
  essentialsCovered: number;
  essentialsTotal: number;
  /** Everything held and current, over everything on the list. */
  covered: number;
  total: number;
  summary: string;
};

/** A fragment escaped and anchored on word boundaries, matched case-insensitively. */
function fragmentRegex(fragment: string): RegExp {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * A document matches an item when its title or its opening line contains one of
 * the item's fragments as a whole word.
 *
 * The opening line is read as well as the title because a certificate is often
 * filed under an abbreviation — "PI and PL" — while its body spells out
 * "Professional Indemnity" and "Public Liability". The document has already been
 * read, so its first words cost nothing to consult and catch exactly the case a
 * title alone misses.
 */
function matchFor(item: ChecklistItem, documents: EvidenceSummary[]): EvidenceSummary | undefined {
  const patterns = item.match.map(fragmentRegex);
  return documents.find((doc) => {
    const haystack = `${doc.title} ${doc.opens ?? ''}`;
    return patterns.some((pattern) => pattern.test(haystack));
  });
}

/**
 * The checklist measured against one customer's library.
 *
 * `documents` is the library's own summaries. A document counts for an item only
 * where it is current: a lapsed certificate is worse than a missing one, because
 * citing it is a hard red, so it is surfaced as LAPSED rather than hidden.
 */
export function checklistCoverage(documents: readonly EvidenceSummary[]): ChecklistCoverage {
  const live = documents.filter((doc) => doc.withdrawnAt === undefined);
  const current = live.filter((doc) => doc.currentNow);
  const lapsed = live.filter((doc) => !doc.currentNow);

  const items: ChecklistResult[] = EVIDENCE_CHECKLIST.map((item) => {
    const hit = matchFor(item, current);
    if (hit) {
      return {
        key: item.key,
        label: item.label,
        type: item.type,
        importance: item.importance,
        why: item.why,
        status: 'CURRENT' as const,
        coveredBy: { reference: hit.reference, title: hit.title },
      };
    }
    const stale = matchFor(item, lapsed);
    return {
      key: item.key,
      label: item.label,
      type: item.type,
      importance: item.importance,
      why: item.why,
      status: stale ? ('LAPSED' as const) : ('MISSING' as const),
      ...(stale ? { coveredBy: { reference: stale.reference, title: stale.title } } : {}),
    };
  });

  const essentials = items.filter((item) => item.importance === 'ESSENTIAL');
  const essentialsCovered = essentials.filter((item) => item.status === 'CURRENT').length;
  const covered = items.filter((item) => item.status === 'CURRENT').length;
  const missingEssentials = essentials.filter((item) => item.status !== 'CURRENT');

  return {
    items,
    essentialsCovered,
    essentialsTotal: essentials.length,
    covered,
    total: items.length,
    summary:
      missingEssentials.length === 0
        ? `Every essential document is on file and current (${covered} of ${items.length} of the full set). The library ` +
          'is ready for the questions a tender will ask.'
        : `${missingEssentials.length} essential document(s) are not on file: ${missingEssentials
            .map((item) => item.label)
            .join(', ')}. These are asked for on almost every tender, so filing them now is what lets an answer cite ` +
          'them later — before a question is read, not after a draft scores low for want of them.',
  };
}

/** Used by a test and by the type-index invariant: every item files under a real type. */
export function checklistTypesAreReal(): boolean {
  return EVIDENCE_CHECKLIST.every((item) => (EVIDENCE_TYPE as readonly string[]).includes(item.type));
}
