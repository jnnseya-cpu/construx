import type { ClientBranding, DocumentBlock } from '../export/exporter.ts';
import type { DocumentDefinition, Row } from './engine.ts';
import { people, place, shown, shownDate } from './engine.ts';

/**
 * The branded front matter every generated document carries.
 *
 * Branding on a construction document is not decoration, and treating it as
 * decoration is how a subcontractor ends up working to a method statement they
 * think came from somebody else. The front matter answers four questions a
 * reader asks before reading a word of the body:
 *
 * **Whose document is this?** The issuing entity — the contractor's own legal
 * name, which is not the same as the client's and is the party who carries the
 * duty. On a permit to work, this is the organisation that will be prosecuted.
 *
 * **Who is it for?** The client, by name, and the project by its own reference.
 *
 * **Which version am I holding?** Reference, revision and status. A revision
 * number with no status beside it is the commonest cause of somebody building
 * to a superseded drawing.
 *
 * **Who wrote it, who checked it, who approved it?** Three different questions
 * with three different answers, and a document that collapses them into one
 * "issued by" has thrown away the separation that makes it worth anything.
 *
 * ---
 *
 * **The logo is resolved from the evidence store by hash**, using the same
 * `PHOTOGRAPH` block a site photograph uses. That is not a convenience: the
 * store is content-addressed, so the document's own content hash commits to
 * exactly which mark was on the page. A logo swapped afterwards changes the
 * hash and the document stops verifying, which is the correct behaviour for a
 * branded instrument.
 */

export type DocumentControl = {
  reference: string;
  revision: string;
  /** Where the document is in its own life, not where the work is. */
  status: 'DRAFT' | 'FOR_REVIEW' | 'ISSUED' | 'SUPERSEDED';
  preparedBy: string;
  checkedBy?: string;
  approvedBy?: string;
  /** Who this issue goes to. A distribution nobody recorded is a document nobody can prove they sent. */
  distribution?: string[];
};

/**
 * Everything above the body.
 *
 * Returned as blocks rather than rendered here, so the same front matter is
 * correct in PDF, HTML and the JSON bundle without three implementations of it.
 */
export function frontMatter(input: {
  branding: ClientBranding;
  definition: DocumentDefinition;
  project: Row;
  control: DocumentControl;
  today: string;
  /** Resolves an actor id to the person it names. */
  who: (actorId: unknown) => string;
}): DocumentBlock[] {
  const { branding, definition, project, control, who } = input;
  const blocks: DocumentBlock[] = [];

  // The mark first, where a reader's eye goes before the title.
  if (branding.logoEvidenceHash) {
    blocks.push({
      kind: 'PHOTOGRAPH',
      caption: shown(branding.issuingEntity, branding.clientName),
      evidenceHash: branding.logoEvidenceHash,
    });
  }


  // No title here. The exporter's own branded header carries the title and the
  // subtitle for every document that leaves the platform, and repeating it
  // would put the same heading on the page twice.
  blocks.push({ kind: 'PARAGRAPH', text: definition.purpose });

  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      // The party carrying the duty, named before anybody else. On a safety
      // document this is the organisation a regulator writes to — and it is
      // deliberately not defaulted to the client. Printing the client as the
      // issuer of a permit to work would name the wrong organisation on the one
      // document where that matters most.
      {
        label: 'Issued by',
        value: shown(branding.issuingEntity, 'Not configured — set the issuing entity in the account settings'),
      },
      { label: 'Prepared for', value: shown(branding.clientName) },
      { label: 'Project', value: shown(project.name) },
      { label: 'Project reference', value: shown(project.reference ?? project.code ?? project.id) },
      { label: 'Site', value: place(project.siteAddress ?? project.location) },
      { label: 'Document reference', value: control.reference },
      { label: 'Revision', value: control.revision },
      { label: 'Status', value: control.status.replace(/_/g, ' ').toLowerCase() },
      { label: 'Date of issue', value: input.today },
    ],
  });

  // Three columns because they are three different acts. A document where all
  // three are the same person is legitimate on a small job and visible here,
  // which is the point of showing them separately rather than merging them.
  blocks.push({
    kind: 'TABLE',
    caption: 'Document control',
    headers: ['Prepared by', 'Checked by', 'Approved by'],
    rows: [[who(control.preparedBy), control.checkedBy ? who(control.checkedBy) : 'Not yet checked', control.approvedBy ? who(control.approvedBy) : 'Not yet approved']],
  });

  if (control.distribution && control.distribution.length > 0) {
    blocks.push({ kind: 'LIST', ordered: false, items: control.distribution.map((who) => `Issued to ${who}`) });
  }

  return blocks;
}

/**
 * The closing block: what this document is composed of, and how to prove it.
 *
 * Every generated document ends by naming the records behind it. That is what
 * separates a composed document from a written one — a reader who doubts a
 * figure can go to the record it came from, by reference, rather than asking
 * the person who ran the export what they typed.
 */
export function provenance(input: {
  definition: DocumentDefinition;
  counted: Array<{ refType: string; count: number; qualifier?: string }>;
  today: string;
}): DocumentBlock[] {
  return [
    { kind: 'HEADING', level: 2, text: 'What this document is composed from' },
    {
      kind: 'PARAGRAPH',
      text:
        'Every figure, date, name and reference above is taken from a record held on this project. Nothing on this document ' +
        'was written to fill a gap: where a record does not exist, the section says so rather than reading as though it does.',
    },
    {
      kind: 'TABLE',
      headers: ['Record', 'Included', 'Selected'],
      rows: input.counted.map((source) => [
        humanTitle(source.refType),
        String(source.count),
        source.qualifier ?? 'all on this project',
      ]),
    },
  ];
}

/** `SiteLogisticsPlan` → "Site logistics plan", for a table a client reads. */
export function humanTitle(refType: string): string {
  const spaced = refType.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * The next revision letter.
 *
 * Construction revisions run A, B, C — not 1, 2, 3 — until issue for
 * construction, and a platform that numbered them would produce documents that
 * do not sit alongside the drawings they accompany.
 */
export function nextRevision(previous: string | undefined): string {
  if (!previous) return 'A';
  const trimmed = previous.trim().toUpperCase();
  if (!/^[A-Z]$/.test(trimmed)) return 'A';
  return trimmed === 'Z' ? 'AA' : String.fromCharCode(trimmed.charCodeAt(0) + 1);
}

/** A document reference that identifies the issuing organisation and the type. */
export function documentReference(branding: ClientBranding, definition: DocumentDefinition, sequence: number, subjectReference?: string): string {
  // Where the subject already carries a reference the site knows it by — a
  // permit number, an RFI number — that reference is used rather than a second
  // one invented beside it. Two references for one thing is how a register and
  // a site file stop agreeing.
  if (subjectReference) return `${branding.documentReferencePrefix}-${subjectReference}`;
  return `${branding.documentReferencePrefix}-${shortCode(definition.code)}-${String(sequence).padStart(4, '0')}`;
}

function shortCode(code: string): string {
  return code
    .split('_')
    .map((part) => part[0])
    .join('');
}

export { shownDate };
