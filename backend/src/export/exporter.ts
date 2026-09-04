import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import { issueTag } from '../evidence/envelope.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import { replayProject, replayTimeline } from '../goldenthread/replay.ts';
import type { AuthContext } from '../identity/auth.ts';
import { evaluateAccess } from '../identity/abac.ts';
import { formatMoney } from '../domain/locale.ts';
import { renderDocx } from './docx.ts';
import { renderPdf, type ImageResolver } from './pdf.ts';

/**
 * Export service.
 *
 * Two rules govern everything that leaves the platform:
 *
 *   1. **Every export carries the client's identity.** Documents that go to a
 *      client, an adjudicator or a regulator are the client's documents, not
 *      the platform's. Branding is applied by the exporter, not left to whoever
 *      is generating the file.
 *   2. **Every export is hashed and recorded.** A PDF handed to an adjudicator
 *      six months ago can be proven to be the PDF that was generated, and the
 *      export itself is an event in the Golden Thread.
 *
 * Content is produced as a structured document model. Rendering it to PDF is a
 * presentation concern handled downstream; what matters here is that the
 * content, its branding and its hash are fixed at the moment of export.
 */

export type ClientBranding = {
  clientName: string;
  /** Data URI or storage reference for the client's mark. */
  logoRef?: string;
  /**
   * The mark, in the evidence store, by its SHA-256.
   *
   * Separate from `logoRef` because it is a stronger thing: the store is
   * content-addressed, so a document's own content hash commits to exactly
   * which image was on the page. A logo swapped afterwards changes the hash and
   * the document stops verifying, which is correct behaviour for a branded
   * instrument. The PDF renderer resolves it through the same path a site
   * photograph takes.
   */
  logoEvidenceHash?: string;
  /**
   * A cover image, in the evidence store, by its SHA-256.
   *
   * Alongside the logo rather than instead of it, and resolved through the same
   * content-addressed path, so the document's own content hash commits to
   * exactly which image was on its cover. A cover swapped afterwards changes the
   * hash and the document stops verifying — which is right for an instrument
   * somebody may have to stand behind.
   *
   * Optional, and its absence is not a fault: a document with no cover image
   * gets a typographic cover rather than a blank page or a placeholder frame.
   * The cover page itself is not optional, because a branded document handed to
   * a client that opens straight into a table reads as a printout rather than
   * an issued document.
   */
  coverEvidenceHash?: string;
  /**
   * The organisation issuing the document, which is **not** the client.
   *
   * `clientName` is who a document is prepared for. This is who carries the
   * duty under it — the party a regulator writes to about a permit to work, and
   * the party named on a method statement a subcontractor works to. Collapsing
   * the two is how a subcontractor ends up believing a document came from
   * somebody else.
   */
  issuingEntity?: string;
  primaryColour: string;
  /** Registered office, company number, and any regulated-entity detail. */
  legalFooter: string;
  documentReferencePrefix: string;
  /**
   * Which version of the identity a document was built under. Counts up on
   * every change at that scope, so a document exported under version 3 stays
   * attributable to version 3 after the colour or the footer moves on. Set by
   * the platform, never by the caller.
   */
  profileVersion?: number;
};

/**
 * Whose document this is, for the file's own properties.
 *
 * The page was already the customer's — their mark, their colour, their legal
 * footer, and nothing of this platform's anywhere on it. The *file* was not. A
 * PDF carried `Producer: CONSTRUX` in its Info dictionary and named the client
 * as its Author, and a Word file carried no properties at all, so it opened
 * with a blank author where the customer's name should be.
 *
 * None of that is visible on the page and all of it is visible in Document
 * Properties, which is the first place anybody looks when they want to know
 * where a document came from — and on a document that is meant to be the
 * customer's own instrument, the honest answer there is the customer.
 *
 * `issuingEntity` first, because that is the party carrying the duty under the
 * document: the one a regulator writes to about a permit, the one named on a
 * method statement a subcontractor works to. `clientName` is who it was
 * prepared *for*, and is the fallback only because a tenancy that has not
 * separated the two still has to have a name on its files.
 *
 * One function, used by both renderers, so a Word file and a PDF of the same
 * document cannot disagree about who issued it.
 */
export function documentOrigin(branding: ClientBranding): string {
  return branding.issuingEntity?.trim() || branding.clientName;
}

/**
 * `DOCX` sits beside `PDF` rather than replacing it, because the two answer
 * different questions. A PDF is what you *issue* — fixed, hashed, and the same
 * on every screen it opens on. A Word file is what you send when the next step
 * is somebody else's tracked changes: a quality plan the client comments on, a
 * contract a solicitor marks up, a method statement a subcontractor adds their
 * own sequence to. Offering only the first meant every one of those left the
 * platform as a PDF and came back as a retyped copy, and the retyped copy is
 * the one that goes out of step with the record.
 *
 * Both render from the same `ExportDocument`, so a Word file and a PDF of one
 * document carry the same `contentHash` and are the same instrument in two
 * forms.
 */
export type ExportFormat = 'PDF' | 'DOCX' | 'JSON_BUNDLE' | 'CSV' | 'HTML';

export type ExportAudience = 'INTERNAL' | 'CLIENT' | 'SUPPLIER' | 'REGULATOR' | 'INSURER' | 'ADJUDICATOR' | 'COURT';

export type DocumentBlock =
  | { kind: 'HEADING'; level: 1 | 2 | 3; text: string }
  | { kind: 'PARAGRAPH'; text: string }
  | { kind: 'KEY_VALUES'; rows: Array<{ label: string; value: string }> }
  | { kind: 'TABLE'; caption?: string; headers: string[]; rows: string[][] }
  | { kind: 'LIST'; ordered: boolean; items: string[] }
  | { kind: 'ATTESTATION'; rootHash: string; chainHead: string; instructions: string }
  /**
   * A photograph held in the evidence store, named by its hash rather than
   * carried as bytes.
   *
   * The bytes stay out of the document model on purpose. `ExportDocument` is
   * serialised to JSON, hashed to produce `contentHash`, and rendered to HTML —
   * none of which wants a megabyte of JPEG inside it. Naming the photograph by
   * its SHA-256 is also *stronger* than embedding it: the store is
   * content-addressed, so the hash in the block identifies exactly one set of
   * bytes, and the document's own content hash therefore commits to precisely
   * which image was on the page. The PDF renderer resolves the bytes; the JSON
   * and HTML forms state the hash, which is the honest thing they can show.
   */
  | { kind: 'PHOTOGRAPH'; caption: string; evidenceHash: string; takenOn?: string }
  /**
   * A scale drawing: the site, its zones, a north arrow and a scale bar.
   *
   * Coordinates stay in **site metres**, not page units. The renderer applies
   * the stated scale, so the drawing and the `1:200` printed beside it cannot
   * disagree — and the JSON and HTML forms of the document carry real
   * coordinates somebody can check rather than a picture they cannot.
   *
   * `scaleDenominator` is chosen by the caller from the ordinary drawing scales
   * and is what the sheet is plotted at. A drawing that fitted the page at some
   * arbitrary ratio would be a diagram; a drawing at 1:200 can be measured with
   * a scale rule.
   */
  | {
      kind: 'DRAWING';
      caption: string;
      scaleDenominator: number;
      /** The extent drawn, in site metres, so the renderer can centre it. */
      extent: { minX: number; minY: number; maxX: number; maxY: number };
      shapes: Array<{
        label: string;
        ring: Array<{ x: number; y: number }>;
        /** Hex, from the legend. */
        colour: string;
        /** Drawn as an outline only — an exclusion, a boundary, a corridor. */
        outlineOnly?: boolean;
      }>;
      legend: Array<{ label: string; colour: string }>;
    };

export type ExportDocument = {
  id: string;
  reference: string;
  title: string;
  subtitle?: string;
  branding: ClientBranding;
  /**
   * Who issued it and under which version of their profile. The company is
   * the tenancy the document was built in — never the person who pressed the
   * button, never the group above the company — and the version is the one
   * in force at that moment, so a later change to the profile leaves this
   * document exactly as issued.
   */
  issuer?: { companyId: string; profileVersion: number; documentType: 'report' };
  audience: ExportAudience;
  format: ExportFormat;
  generatedAt: string;
  generatedBy: string;
  projectId: string;
  blocks: DocumentBlock[];
  /** Hash over the branded content — this is what proves the document later. */
  contentHash: string;
  /**
   * The verification code printed on the document, and what a recipient does
   * with it.
   *
   * The content hash alone proves nothing to a recipient. It is a hash of the
   * document computed from the document, so anybody who alters a page can
   * recompute it and print the new value in the footer; a reader comparing the
   * two finds them agreeing on a forgery. That is not a defect in the hash —
   * it is what a hash is for, which is detecting accidental corruption of bytes
   * you already trust.
   *
   * What makes a document checkable by somebody with no access to the platform
   * is a tag only the platform can produce over the reference, the hash and the
   * issuing tenancy. `POST /v1/verify/document` is public and takes exactly the
   * three strings printed on the page. An altered document produces a different
   * hash, the tag no longer matches, and the endpoint says so.
   *
   * `CXV1:<issuer>:<tag>` — the scheme so a later one can be told apart, the
   * issuing tenancy so the endpoint knows whose key to check against without
   * having to search every customer, and the tag itself.
   */
  verification: string;
  /** Anything withheld from this audience, stated on the document itself. */
  redactionNotice?: string;
};

/** The scheme prefix on every verification code this build issues. */
export const VERIFICATION_SCHEME = 'CXV1';

/**
 * Split a printed verification code back into its parts.
 *
 * Returns `undefined` rather than throwing on anything malformed, because the
 * public endpoint's job is to answer "is this document genuine" with a plain
 * no, not to distinguish for a caller which of their guesses was better formed.
 */
export function parseVerification(code: string): { issuer: string; tag: string } | undefined {
  const parts = code.trim().split(':');
  if (parts.length !== 3) return undefined;
  const [scheme, issuer, tag] = parts as [string, string, string];
  if (scheme !== VERIFICATION_SCHEME || !issuer || !tag) return undefined;
  return { issuer, tag };
}

function brandedHeader(branding: ClientBranding, title: string, subtitle?: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [{ kind: 'HEADING', level: 1, text: title }];
  if (subtitle) blocks.push({ kind: 'PARAGRAPH', text: subtitle });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Prepared for', value: branding.clientName },
      { label: 'Generated', value: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    ],
  });
  return blocks;
}

/**
 * Whether a tenant may take a document out of the platform at all.
 *
 * Supplied rather than imported so the exporter stays free of the billing
 * model: this file's job is to build an evidenced, branded, correctly redacted
 * document, and it should not also know what a package costs.
 */
export type ExportEntitlement = { permitted: boolean; reason?: string };

/** The issuing company's profile, as the platform provides it to the exporter. */
export type IssuerProfiles = {
  profileVersionOf: (tenantId: string) => number;
  allocateReference: (auth: AuthContext, documentType: string) => string | undefined;
};

export class ExportService {
  readonly #ledger: GoldenThreadLedger;
  /**
   * The tenancy's own identity, used where no project says otherwise.
   *
   * This is the contractor's own brand — the one on a document that is not
   * prepared for any particular client.
   */
  readonly #brandingByTenant = new Map<string, ClientBranding>();

  /**
   * Branding per project, which is what a client-facing document actually needs.
   *
   * Storing one branding per tenancy was wrong in a way that only shows up on a
   * real estate: a contractor running three projects for three different clients
   * had one slot for all of them, so every export carried whichever client had
   * been configured last. The header prints "Prepared for: {clientName}"
   * verbatim, so a report for Northgate went out saying it was prepared for
   * Meridian — the right document, the wrong company's name, logo and colour on
   * the front of it.
   *
   * Keyed by tenancy *and* project, never by project alone: a project id from
   * one tenancy must not be able to read another's branding, and a map keyed on
   * a bare id would allow exactly that.
   */
  readonly #brandingByProject = new Map<string, ClientBranding>();
  readonly #entitlement: (tenantId: string, roles?: readonly string[]) => ExportEntitlement;
  #sequence = 0;
  /**
   * The issuing company's profile, where the platform provides one: the
   * version a document pins, and the number its numbering rule allocates.
   * Absent in a service built bare, which numbers documents as it always did.
   */
  #issuerProfiles: IssuerProfiles | null = null;

  useIssuerProfiles(profiles: IssuerProfiles): void {
    this.#issuerProfiles = profiles;
  }

  constructor(ledger: GoldenThreadLedger, entitlement?: (tenantId: string, roles?: readonly string[]) => ExportEntitlement) {
    this.#ledger = ledger;
    // Default open. A caller that does not supply an entitlement check is a
    // test or a tool, not a tenant taking a document to a client.
    this.#entitlement = entitlement ?? (() => ({ permitted: true }));
  }

  /**
   * Record the identity documents go out under.
   *
   * **Committed to the ledger, not held in a map.** It was a map, and that was
   * a defect of exactly the shape the landing-page pictures had: configure a
   * client's name, mark and colour, redeploy, and every document silently
   * reverts to `BRANDING_NOT_CONFIGURED` — or worse, to whatever a different
   * process still had. Branding decides what a client-facing instrument says
   * about who issued it, which makes setting it a governance act, and a
   * governance act belongs in the record with everybody else's.
   *
   * The maps below stay as the read path and are kept in step with the commit,
   * so a running process answers from memory and a restarted one answers from
   * the chain. `rehydrateBranding` is what closes that loop at boot.
   *
   * A tenancy-level identity is written to the governance chain; a project's
   * own client identity is written to that project, where the rest of its
   * record is.
   */
  setBranding(tenantId: string, input: ClientBranding, projectId?: string, actorId?: string): void {
    const previous = projectId ? this.#brandingByProject.get(`${tenantId}:${projectId}`) : this.#brandingByTenant.get(tenantId);
    const branding: ClientBranding = { ...input, profileVersion: (previous?.profileVersion ?? 0) + 1 };
    if (projectId) this.#brandingByProject.set(`${tenantId}:${projectId}`, branding);
    else this.#brandingByTenant.set(tenantId, branding);

    // Without an actor there is nobody to record as having done it, which is
    // the case in a test or a tool constructing a service directly. The
    // in-memory answer still stands; nothing is written under a name that does
    // not exist.
    if (!actorId) return;

    this.#ledger.commit({
      tenantId,
      projectId: projectId ?? `${tenantId}-governance`,
      actor: { refType: 'User', refId: actorId },
      source: 'SYSTEM',
      correlationId: `branding:${tenantId}:${projectId ?? 'tenant'}`,
      eventType: 'CLIENT_BRANDING_SET',
      entity: { refType: 'ClientBrandingRecord', refId: projectId ? `${tenantId}:${projectId}` : tenantId },
      nextState: { tenantId, projectId, ...branding } as unknown as Record<string, unknown>,
    });
  }

  /**
   * Rebuild the branding maps from the chain.
   *
   * Called once at boot, beside the other rehydrations. Without it a restarted
   * process holds a complete record and cannot brand a single document from it.
   */
  rehydrateBranding(): number {
    let restored = 0;
    for (const record of this.#ledger.entitiesOfType('ClientBrandingRecord')) {
      const state = record.state as unknown as ClientBranding & { tenantId: string; projectId?: string };
      const { tenantId, projectId, ...branding } = state;
      if (projectId) this.#brandingByProject.set(`${tenantId}:${projectId}`, branding);
      else this.#brandingByTenant.set(tenantId, branding);
      restored += 1;
    }
    return restored;
  }

  /** Whether this project has its own client identity, distinct from the tenancy's. */
  projectBranding(tenantId: string, projectId: string): ClientBranding | undefined {
    return this.#brandingByProject.get(`${tenantId}:${projectId}`);
  }

  /**
   * May this tenant take a document out of the platform?
   *
   * Called at the top of each export and again where the document is built.
   * The early call is what makes the message useful — a trial account asking
   * for a report should be told it is not on the plan, not that the project
   * was not found or that a logo needs configuring first. The later call is
   * what makes it hard to bypass.
   */
  #assertEntitled(auth: AuthContext): void {
    const entitlement = this.#entitlement(auth.tenantId, auth.roles);
    if (!entitlement.permitted) {
      throw new DomainError(
        'EXPORT_NOT_ENTITLED',
        entitlement.reason ?? 'This subscription does not include exporting or printing',
      );
    }
  }

  /**
   * The tenancy's branding, or nothing, without refusing.
   *
   * For the messages the platform sends *about an account* rather than
   * documents it produces *for a client*: a verification code, a confirmation
   * that a tenancy is set up. Those go out before anybody could have configured
   * branding — a tenancy is minutes old at that point — and the platform
   * tenancy can never have client branding at all, because it has no client.
   *
   * `branding` below stays strict, and must. An unbranded document reaching a
   * client is worse than no document, and that refusal is the thing stopping
   * it. This is a different question with a different answer, not a way round
   * the same one.
   */
  brandingIfConfigured(tenantId: string, projectId?: string): ClientBranding | undefined {
    return (projectId ? this.#brandingByProject.get(`${tenantId}:${projectId}`) : undefined)
      ?? this.#brandingByTenant.get(tenantId);
  }

  /**
   * The identity to put on a document.
   *
   * The project's own client branding wins; the tenancy's is the fallback for a
   * document that belongs to no particular client. The order is the whole fix —
   * reading the tenancy first would put the wrong client on every project that
   * had bothered to configure its own.
   */
  branding(tenantId: string, projectId?: string): ClientBranding {
    const branding = (projectId ? this.#brandingByProject.get(`${tenantId}:${projectId}`) : undefined)
      ?? this.#brandingByTenant.get(tenantId);
    if (!branding) {
      // Refusing here is deliberate: an unbranded export sent to a client is
      // worse than no export, and silently substituting a default hides it.
      throw new DomainError(
        'BRANDING_NOT_CONFIGURED',
        'Client branding must be configured before documents can be exported',
      );
    }
    return branding;
  }

  /** Build, hash and record an export. Returns the document model. */
  #finalise(
    auth: AuthContext,
    projectId: string,
    input: {
      title: string;
      subtitle?: string;
      audience: ExportAudience;
      format: ExportFormat;
      blocks: DocumentBlock[];
      redactionNotice?: string;
      correlationId: string;
      suppressHeader?: boolean;
    },
  ): ExportDocument {
    // The backstop. Every route into a document passes through here, so a new
    // export method inherits the gate without anybody remembering to add it.
    this.#assertEntitled(auth);

    const branding = this.branding(auth.tenantId, projectId);
    this.#sequence += 1;

    const blocks = input.suppressHeader
      ? [...input.blocks]
      : [...brandedHeader(branding, input.title, input.subtitle), ...input.blocks];
    if (input.redactionNotice) {
      blocks.push({ kind: 'PARAGRAPH', text: input.redactionNotice });
    }
    blocks.push({ kind: 'PARAGRAPH', text: branding.legalFooter });

    const id = ulid();
    const allocated = this.#issuerProfiles?.allocateReference(auth, 'report');
    const reference = allocated ?? `${branding.documentReferencePrefix}-${String(this.#sequence).padStart(5, '0')}`;
    const issuer = { companyId: auth.tenantId, profileVersion: this.#issuerProfiles?.profileVersionOf(auth.tenantId) ?? 0, documentType: 'report' as const };
    const contentHash = hashEvidence(JSON.stringify({ branding, issuer, blocks }));

    const document: ExportDocument = {
      id,
      reference,
      title: input.title,
      subtitle: input.subtitle,
      branding,
      issuer,
      audience: input.audience,
      format: input.format,
      generatedAt: new Date().toISOString(),
      generatedBy: auth.actorId,
      projectId,
      blocks,
      contentHash,
      verification: `${VERIFICATION_SCHEME}:${auth.tenantId}:${issueTag({ contentHash, reference, tenantId: auth.tenantId })}`,
      redactionNotice: input.redactionNotice,
    };

    const evidenceId = ulid();
    this.#ledger.commit({
      tenantId: auth.tenantId,
      projectId,
      actor: { refType: 'User', refId: auth.actorId },
      source: 'SYSTEM',
      correlationId: input.correlationId,
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: evidenceId },
      nextState: {
        id: evidenceId,
        type: 'EXPORTED_DOCUMENT',
        hash: document.contentHash,
        description: `${input.title} (${reference}) exported for ${input.audience}`,
        capturedAt: document.generatedAt,
        capturedBy: auth.actorId,
        linkedEntities: [],
      },
    });

    this.#ledger.commit({
      tenantId: auth.tenantId,
      projectId,
      actor: { refType: 'User', refId: auth.actorId },
      source: 'SYSTEM',
      correlationId: input.correlationId,
      eventType: 'EXPORT_GENERATED',
      entity: { refType: 'Export', refId: id },
      nextState: {
        id,
        reference,
        projectId,
        title: input.title,
        audience: input.audience,
        format: input.format,
        contentHash: document.contentHash,
        clientName: branding.clientName,
        // Who issued it and under which profile version — on the record, so
        // the answer survives any later change to the profile.
        issuer,
        generatedAt: document.generatedAt,
        generatedBy: auth.actorId,
      },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: evidenceId }],
    });

    return document;
  }

  /**
   * Brand, hash and record a document whose blocks the caller has built.
   *
   * `projectReport` and `auditExport` below read the ledger and assemble their
   * own blocks, which is right for documents this file owns. A site visit
   * report is assembled by the engine that knows what a finding is, and giving
   * the exporter a second opinion about site findings would put that knowledge
   * in two places. This is the seam: the domain builds the blocks, the exporter
   * does what only it should — branding, redaction, the content hash and the
   * two ledger events that make the document provable.
   */
  document(
    auth: AuthContext,
    projectId: string,
    input: {
      title: string;
      subtitle?: string;
      blocks: DocumentBlock[];
      audience: ExportAudience;
      format?: ExportFormat;
      correlationId: string;
      /**
       * Set by a caller that has already built its own branded front matter.
       *
       * The minimal header this class prepends — title, subtitle, prepared-for,
       * generated-at — is right for a report assembled here. A generated site
       * document carries a full document-control block instead, and printing
       * both put "Prepared for" on the page twice.
       */
      suppressHeader?: boolean;
    },
  ): ExportDocument {
    return this.#finalise(auth, projectId, {
      title: input.title,
      subtitle: input.subtitle,
      audience: input.audience,
      format: input.format ?? 'PDF',
      blocks: input.blocks,
      correlationId: input.correlationId,
      suppressHeader: input.suppressHeader,
    });
  }

  /** Project status report — the routine client-facing document. */
  projectReport(
    auth: AuthContext,
    projectId: string,
    input: { audience: ExportAudience; format?: ExportFormat; correlationId: string },
  ): ExportDocument {
    this.#assertEntitled(auth);
    const project = this.#ledger.require({ refType: 'Project', refId: projectId });

    const evms = this.#ledger.list(projectId, 'EarnedValueSnapshot');
    const evm = evms[evms.length - 1]?.state;
    const cvrs = this.#ledger.list(projectId, 'CVR');
    const cvr = cvrs[cvrs.length - 1]?.state;
    const baselines = this.#ledger.list(projectId, 'ProgrammeBaseline').filter((b) => b.state.status === 'APPROVED');
    const baseline = baselines[baselines.length - 1]?.state;
    const delays = this.#ledger.list(projectId, 'DelayRiskSnapshot');
    const delay = delays[delays.length - 1]?.state;
    const risks = this.#ledger.list(projectId, 'RiskRegisterItem').filter((r) => r.state.status === 'OPEN');

    // Commercial detail is withheld on two independent grounds, and it needs
    // both. This is a defect that shipped and was found by crossing a read
    // route with an export rather than by testing either alone.
    //
    // The audience rule was here already: a regulator and a supplier have no
    // entitlement to the contractor's commercial position, so those bundles
    // never carry it.
    //
    // What was missing is the *caller*. Nothing checked whether the person
    // asking may see commercial detail at all — so a site supervisor, who is
    // refused `/v1/projects/:id/commercial-control` with 403 ACCESS_DENIED,
    // obtained CPI, SPI and the cost position by asking for the same report
    // addressed to a court. The audience decided the redaction; the identity
    // decided nothing. That is broken function-level authorisation: one door
    // enforcing a capability and another beside it that does not.
    //
    // Checked through `evaluateAccess`, which is the same call every other
    // read makes, so an export and a read cannot disagree about who may see a
    // budget.
    const mayReadCommercial =
      evaluateAccess(
        auth,
        'BUDGET_COST',
        'R',
        {
          tenantId: auth.tenantId,
          projectId,
          dataSensitivity: 'COMMERCIAL_L3',
        },
        {
          rbacEnabled: config.authz.rbac,
          scopesEnabled: config.authz.scopes,
          abacEnabled: config.authz.abac,
        },
      ).decision === 'ALLOW';

    const audiencePermits = input.audience !== 'REGULATOR' && input.audience !== 'SUPPLIER';
    const commercialVisible = audiencePermits && mayReadCommercial;

    // The project's own currency, not the platform's default. A report on a
    // Gulf or Japanese job showing sterling would be wrong in a way nobody
    // would spot until somebody paid against it.
    const currency = String(project.state.currency ?? 'GBP');

    const blocks: DocumentBlock[] = [
      { kind: 'HEADING', level: 2, text: 'Project' },
      {
        kind: 'KEY_VALUES',
        rows: [
          { label: 'Project', value: String(project.state.name) },
          { label: 'Lifecycle phase', value: String(project.state.phase) },
          { label: 'Sector', value: String(project.state.sectorType) },
          { label: 'Location', value: `${String((project.state.location as { city?: string }).city ?? '')}` },
        ],
      },
      { kind: 'HEADING', level: 2, text: 'Programme' },
      {
        kind: 'KEY_VALUES',
        rows: [
          { label: 'Approved baseline', value: baseline ? String(baseline.version) : 'none approved' },
          { label: 'Baseline duration', value: baseline ? `${String(baseline.durationDays)} days` : '—' },
          { label: 'Forecast delay', value: delay ? `${String(delay.expectedDelayDays)} days (${String(delay.severity)})` : 'not forecast' },
        ],
      },
    ];

    if (commercialVisible) {
      blocks.push(
        { kind: 'HEADING', level: 2, text: 'Commercial' },
        {
          kind: 'KEY_VALUES',
          rows: [
            { label: 'CPI / SPI', value: evm ? `${String(evm.costPerformanceIndex)} / ${String(evm.schedulePerformanceIndex)}` : '—' },
            // In the reader's currency, not in minor units. This document goes
            // to an adjudicator or a court, and "1793000000" is not a figure
            // anybody can act on — it reads as a hundred times the truth to
            // whoever does not know the convention.
            {
              label: 'Forecast final cost',
              value: cvr ? formatMoney(Number(cvr.forecastFinalCostMinor), currency) : '—',
            },
            { label: 'Forecast margin', value: cvr ? `${String(cvr.forecastMarginPercent)}%` : '—' },
          ],
        },
      );
      if (cvr && Array.isArray(cvr.alerts) && cvr.alerts.length > 0) {
        blocks.push({ kind: 'LIST', ordered: false, items: cvr.alerts as string[] });
      }
    }

    // The risk register itself is not commercial — a regulator should see what
    // is open on the project. Its priced exposure is, and it used to survive
    // into a copy stamped "pricing detail has been withheld". A document that
    // carries a false assurance is worse than one that withholds nothing.
    blocks.push(
      { kind: 'HEADING', level: 2, text: 'Risk' },
      {
        kind: 'TABLE',
        caption: commercialVisible
          ? `${risks.length} open risk(s)`
          : `${risks.length} open risk(s) — priced exposure withheld`,
        headers: commercialVisible
          ? ['Risk', 'Category', 'Severity', 'Expected cost']
          : ['Risk', 'Category', 'Severity'],
        rows: risks.slice(0, 20).map((r) => {
          const row = [String(r.state.title), String(r.state.category), String(r.state.severity)];
          return commercialVisible ? [...row, formatMoney(Number(r.state.expectedCostMinor ?? 0), currency)] : row;
        }),
      },
    );

    return this.#finalise(auth, projectId, {
      title: 'Project status report',
      subtitle: String(project.state.name),
      audience: input.audience,
      format: input.format ?? 'PDF',
      blocks,
      redactionNotice: commercialVisible
        ? undefined
        : 'Commercial and pricing detail has been withheld from this copy in accordance with the recipient’s access entitlement.',
      correlationId: input.correlationId,
    });
  }

  /**
   * Verifiable audit export. Includes the state root hash and instructions for
   * recomputing it, so the recipient can check the record rather than trust it.
   */
  auditExport(
    auth: AuthContext,
    projectId: string,
    input: { audience: ExportAudience; from: string; to: string; format?: ExportFormat; correlationId: string },
  ): ExportDocument {
    this.#assertEntitled(auth);

    const replayAudience =
      input.audience === 'REGULATOR' || input.audience === 'INSURER' || input.audience === 'COURT'
        ? input.audience
        : 'INTERNAL';

    const report = replayProject(this.#ledger, auth.tenantId, projectId, input.to, { audience: replayAudience });
    const timeline = replayTimeline(this.#ledger, auth.tenantId, projectId, input.from, input.to);

    const blocks: DocumentBlock[] = [
      { kind: 'HEADING', level: 2, text: 'Verification summary' },
      {
        kind: 'KEY_VALUES',
        rows: [
          { label: 'Events replayed', value: String(report.eventsReplayed) },
          { label: 'Verification status', value: report.verificationStatus },
          { label: 'Integrity failures', value: String(report.failures.length) },
          { label: 'Entities reconstructed', value: String(report.entities.length) },
        ],
      },
      {
        kind: 'ATTESTATION',
        rootHash: report.rootHash,
        chainHead: report.chainHead,
        instructions:
          'Each event in the chronology carries its event id and chain hash. Recompute the chain from the first event forward: any insertion, deletion or alteration produces a different chain head and a different state root.',
      },
      { kind: 'HEADING', level: 2, text: 'Chronology' },
      {
        kind: 'TABLE',
        headers: ['Time', 'Event', 'Entity', 'Actor', 'Chain hash'],
        rows: timeline
          .slice(0, 500)
          .map((e) => [
            e.timestamp,
            e.eventType,
            `${e.entity.refType} ${e.entity.refId}`,
            e.actor,
            (e.chainHash ?? '').slice(0, 24),
          ]),
      },
      { kind: 'HEADING', level: 2, text: 'Evidence register' },
      {
        kind: 'TABLE',
        headers: ['Reference', 'First seen', 'Linked events'],
        rows: report.evidenceIndex
          .slice(0, 200)
          .map((e) => [`${e.refType} ${e.refId}`, e.firstSeen, String(e.linkedEvents.length)]),
      },
    ];

    if (report.failures.length > 0) {
      blocks.push({
        kind: 'TABLE',
        caption: 'Integrity failures',
        headers: ['Event', 'Type', 'Status', 'Detail'],
        rows: report.failures.map((f) => [f.eventId, f.eventType, f.status, f.detail ?? '']),
      });
    }

    return this.#finalise(auth, projectId, {
      title: 'Golden Thread audit export',
      subtitle: `${input.from.slice(0, 10)} to ${input.to.slice(0, 10)}`,
      audience: input.audience,
      format: input.format ?? 'JSON_BUNDLE',
      blocks,
      redactionNotice:
        report.redactionLog.length > 0
          ? `${report.redactionLog.length} record(s) were withheld from this copy under the recipient’s access policy. The state root hash covers the complete record, not the redacted view.`
          : undefined,
      correlationId: input.correlationId,
    });
  }

  /** Render a document model to self-contained HTML, branded. */
  /**
   * Render to PDF.
   *
   * The format an adjudicator, an insurer or a court asks for. Rendered from
   * the same document model the HTML comes from and hashed before either — what
   * a reader holds is the content that was attested, rather than whatever a
   * browser's print pipeline made of it.
   */
  toPdf(document: ExportDocument, resolveImage?: ImageResolver): Uint8Array {
    return renderPdf(document, resolveImage);
  }

  /** The same document, editable, with the same branding and the same hash. */
  toDocx(document: ExportDocument, resolveImage?: ImageResolver): Uint8Array {
    return renderDocx(document, resolveImage);
  }

  toHtml(document: ExportDocument): string {
    const escape = (text: string): string =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const body = document.blocks
      .map((block) => {
        switch (block.kind) {
          case 'HEADING':
            return `<h${block.level}>${escape(block.text)}</h${block.level}>`;
          case 'PARAGRAPH':
            return `<p>${escape(block.text)}</p>`;
          case 'KEY_VALUES':
            return `<dl>${block.rows.map((r) => `<dt>${escape(r.label)}</dt><dd>${escape(r.value)}</dd>`).join('')}</dl>`;
          case 'LIST':
            return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map((i) => `<li>${escape(i)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
          case 'TABLE':
            return (
              `<table>${block.caption ? `<caption>${escape(block.caption)}</caption>` : ''}` +
              `<thead><tr>${block.headers.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead>` +
              `<tbody>${block.rows.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
            );
          case 'PHOTOGRAPH':
            // The hash, not the image. This renderer produces a self-contained
            // string with no way to serve bytes, and an `<img>` pointing at an
            // endpoint the reader may not be able to reach would be a broken
            // picture where a plain statement of what was photographed works.
            return (
              `<figure class="photograph"><figcaption>${escape(block.caption)}` +
              `${block.takenOn ? ` — ${escape(block.takenOn)}` : ''}</figcaption>` +
              `<p><code>${escape(block.evidenceHash)}</code></p></figure>`
            );
          case 'ATTESTATION':
            return (
              `<section class="attestation"><h3>Attestation</h3>` +
              `<p><strong>State root:</strong> <code>${escape(block.rootHash)}</code></p>` +
              `<p><strong>Chain head:</strong> <code>${escape(block.chainHead)}</code></p>` +
              `<p>${escape(block.instructions)}</p></section>`
            );
        }
      })
      .join('\n');

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escape(document.title)} — ${escape(document.branding.clientName)}</title>
<style>
  body { font: 13px/1.6 system-ui, sans-serif; color: #1a1a1a; max-width: 900px; margin: 40px auto; padding: 0 24px; }
  header { border-bottom: 3px solid ${document.branding.primaryColour}; padding-bottom: 12px; margin-bottom: 24px;
           display: flex; align-items: center; gap: 16px; }
  header img { max-height: 48px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  dl { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; }
  dt { color: #666; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12px; }
  th { background: #f4f4f5; text-align: left; padding: 6px 8px; }
  td { border-top: 1px solid #e5e5e5; padding: 6px 8px; }
  code { font-size: 11px; word-break: break-all; }
  .attestation { background: #f9f9fb; border-left: 3px solid ${document.branding.primaryColour}; padding: 12px 16px; margin: 20px 0; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #ddd; color: #666; font-size: 11px; }
</style></head>
<body>
<header>
  ${document.branding.logoRef ? `<img src="${escape(document.branding.logoRef)}" alt="${escape(document.branding.clientName)}">` : ''}
  <div><h1>${escape(document.branding.clientName)}</h1><div>${escape(document.title)}</div></div>
</header>
${body}
<footer>
  <div>${escape(document.reference)} · generated ${escape(document.generatedAt)} · audience ${escape(document.audience)}</div>
  <div>Content hash <code>${escape(document.contentHash)}</code></div>
  <div>Verification <code>${escape(document.verification)}</code> — check this document at ${escape(config.publicBaseUrl)}/verify-document</div>
</footer>
</body></html>`;
  }
}
