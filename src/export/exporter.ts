import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import { replayProject, replayTimeline } from '../goldenthread/replay.ts';
import type { AuthContext } from '../identity/auth.ts';

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
  primaryColour: string;
  /** Registered office, company number, and any regulated-entity detail. */
  legalFooter: string;
  documentReferencePrefix: string;
};

export type ExportFormat = 'PDF' | 'JSON_BUNDLE' | 'CSV' | 'HTML';

export type ExportAudience = 'INTERNAL' | 'CLIENT' | 'SUPPLIER' | 'REGULATOR' | 'INSURER' | 'ADJUDICATOR' | 'COURT';

export type DocumentBlock =
  | { kind: 'HEADING'; level: 1 | 2 | 3; text: string }
  | { kind: 'PARAGRAPH'; text: string }
  | { kind: 'KEY_VALUES'; rows: Array<{ label: string; value: string }> }
  | { kind: 'TABLE'; caption?: string; headers: string[]; rows: string[][] }
  | { kind: 'LIST'; ordered: boolean; items: string[] }
  | { kind: 'ATTESTATION'; rootHash: string; chainHead: string; instructions: string };

export type ExportDocument = {
  id: string;
  reference: string;
  title: string;
  subtitle?: string;
  branding: ClientBranding;
  audience: ExportAudience;
  format: ExportFormat;
  generatedAt: string;
  generatedBy: string;
  projectId: string;
  blocks: DocumentBlock[];
  /** Hash over the branded content — this is what proves the document later. */
  contentHash: string;
  /** Anything withheld from this audience, stated on the document itself. */
  redactionNotice?: string;
};

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

export class ExportService {
  readonly #ledger: GoldenThreadLedger;
  readonly #brandingByTenant = new Map<string, ClientBranding>();
  readonly #entitlement: (tenantId: string, roles?: readonly string[]) => ExportEntitlement;
  #sequence = 0;

  constructor(ledger: GoldenThreadLedger, entitlement?: (tenantId: string, roles?: readonly string[]) => ExportEntitlement) {
    this.#ledger = ledger;
    // Default open. A caller that does not supply an entitlement check is a
    // test or a tool, not a tenant taking a document to a client.
    this.#entitlement = entitlement ?? (() => ({ permitted: true }));
  }

  setBranding(tenantId: string, branding: ClientBranding): void {
    this.#brandingByTenant.set(tenantId, branding);
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

  branding(tenantId: string): ClientBranding {
    const branding = this.#brandingByTenant.get(tenantId);
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
    },
  ): ExportDocument {
    // The backstop. Every route into a document passes through here, so a new
    // export method inherits the gate without anybody remembering to add it.
    this.#assertEntitled(auth);

    const branding = this.branding(auth.tenantId);
    this.#sequence += 1;

    const blocks = [...brandedHeader(branding, input.title, input.subtitle), ...input.blocks];
    if (input.redactionNotice) {
      blocks.push({ kind: 'PARAGRAPH', text: input.redactionNotice });
    }
    blocks.push({ kind: 'PARAGRAPH', text: branding.legalFooter });

    const id = ulid();
    const reference = `${branding.documentReferencePrefix}-${String(this.#sequence).padStart(5, '0')}`;

    const document: ExportDocument = {
      id,
      reference,
      title: input.title,
      subtitle: input.subtitle,
      branding,
      audience: input.audience,
      format: input.format,
      generatedAt: new Date().toISOString(),
      generatedBy: auth.actorId,
      projectId,
      blocks,
      contentHash: hashEvidence(JSON.stringify({ branding, blocks })),
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
        generatedAt: document.generatedAt,
        generatedBy: auth.actorId,
      },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: evidenceId }],
    });

    return document;
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

    // Commercial detail is withheld from audiences that have no entitlement to it.
    const commercialVisible = input.audience !== 'REGULATOR' && input.audience !== 'SUPPLIER';

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
            { label: 'Forecast final cost', value: cvr ? String(cvr.forecastFinalCostMinor) : '—' },
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
          return commercialVisible ? [...row, String(r.state.expectedCostMinor)] : row;
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
</footer>
</body></html>`;
  }
}
