import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, exact as money, html, humanise, notice, raw, render, table } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';
import { bindConsentExtras, consentCards, consentCommands } from './planningconsent.js';
import { agentCommands, agentsCard, bindAgentExtras, loadAgents } from './planningagents.js';

/**
 * CONSTRUX Planning — the appraisal half of the first release.
 *
 * The red line and its measured area, the facts recorded about the site, each
 * scenario with its rule findings, the standard planning fee and the planning
 * costs with the liabilities kept apart, and the rule versions the company has
 * published. Everything shown is read from `GET /planning`; the closed lists
 * the forms offer come from the same response, so this screen holds no rule of
 * its own.
 */

const STATUS_TONE = { applies: 'warn', does_not_apply: 'ok', review_required: 'bad', unavailable: 'neutral' };
const STATUS_WORDS = { applies: 'applies', does_not_apply: 'does not apply', review_required: 'review required', unavailable: 'unavailable' };
const RULE_TONE = { PUBLISHED: 'ok', PREPARED: 'info', RETURNED: 'warn', UNPUBLISHED: 'neutral', CHANGED_SINCE_PUBLISHED: 'bad' };
const RULE_WORDS = {
  PUBLISHED: 'published',
  PREPARED: 'checked — awaiting a second person',
  RETURNED: 'returned to the editor',
  UNPUBLISHED: 'not yet checked',
  CHANGED_SINCE_PUBLISHED: 'changed since published',
};
const FEE_ROUTE_WORDS = {
  full: 'Full application',
  outline: 'Outline application',
  reserved_matters: 'Reserved matters',
  condition_details: 'Condition details request',
  section_73_major: 'Section 73, major',
  section_96a_non_householder: 'Section 96A, non-householder',
};

const ha = (m2) => `${(Number(m2) / 10_000).toFixed(4)} ha`;
const m2 = (value) => `${Number(value).toLocaleString('en-GB', { maximumFractionDigits: 2 })} m²`;
const range = (low, high) => (low === null || high === null ? 'unknown' : low === high ? money(low) : `${money(low)} – ${money(high)}`);

export async function planning(root) {
  const projectId = state.session.projectId;
  const base = `/v1/projects/${projectId}/planning`;
  let view;
  let reg;
  let agentsLoaded;
  try {
    [view, reg, agentsLoaded] = await Promise.all([api.get(base), api.get(`/v1/projects/${projectId}/planning/register`).catch((error) => ({ error })), loadAgents(projectId)]);
  } catch (error) {
    render(
      root,
      html`<div class="view-head"><div><h1>Planning</h1></div></div>
        ${notice(`Planning could not be read: ${error.message ?? String(error)}`, 'err')}`,
    );
    return;
  }

  const canCreate = can('PLANNING_CONSENT', 'C');
  const canUpdate = can('PLANNING_CONSENT', 'U');
  const canApprove = can('PLANNING_CONSENT', 'A');
  const vocab = view.vocabulary;
  const site = view.site;
  const sites = view.siteRevisions;
  const lead = view.scenarios.find((entry) => entry.evaluation) ?? view.scenarios[0];
  const quotedIds = new Set(view.lines.filter((line) => line.status === 'ACTIVE' && line.feeQuoteId).map((line) => line.feeQuoteId));
  const publishedFees = view.rules.filter((rule) => rule.kind === 'FEE_SCHEDULE' && rule.status === 'PUBLISHED').length;

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Planning</h1>
          <p>The red line, the proposal, the statutory rules with their sources, the planning fee and the planning costs. Unknowns are shown as unknown; nothing is inferred from silence.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              { id: 'pl-site', label: site ? 'Record a new site revision' : 'Record the site', tone: site ? '' : 'primary', permitted: canCreate, reason: blockedReason('PLANNING_CONSENT', 'C') },
              site ? { id: 'pl-proposal', label: 'Record a proposal', permitted: canCreate, reason: blockedReason('PLANNING_CONSENT', 'C') } : null,
              { id: 'pl-fee', label: 'Quote a fee', permitted: canCreate, reason: blockedReason('PLANNING_CONSENT', 'C') },
              { id: 'pl-cost', label: 'Add a cost line', permitted: canCreate, reason: blockedReason('PLANNING_CONSENT', 'C') },
            ]),
          )}
        </div>
      </div>

      <section class="card" style="margin-bottom:14px" aria-labelledby="pl-overview-h" data-planning-overview>
        <h2 id="pl-overview-h">Where it stands</h2>
        <div class="grid g4" style="margin-top:8px">
          <div>
            <h3>Site</h3>
            ${
              site
                ? html`<p style="margin:4px 0">${ha(site.confirmedAreaM2 ?? site.calculatedAreaM2)} ${badge(site.confirmedAreaM2 !== null ? 'confirmed area' : 'drawn area only', site.confirmedAreaM2 !== null ? 'ok' : 'warn')}</p>
                    <p class="metric-sub">Revision ${site.revision} of ${sites} · ${site.accepted ? 'accepted' : 'not yet accepted'}</p>`
                : html`<p class="metric-sub">No red line recorded.</p>`
            }
          </div>
          <div>
            <h3>Authority</h3>
            ${site ? html`<p style="margin:4px 0">${site.authority.name} ${badge(site.authority.confirmed ? 'confirmed' : 'to confirm', site.authority.confirmed ? 'ok' : 'warn')}</p>` : html`<p class="metric-sub">—</p>`}
          </div>
          <div>
            <h3>Major development</h3>
            ${
              lead?.evaluation
                ? html`<p style="margin:4px 0">${badge(humanise(lead.evaluation.major), lead.evaluation.major === 'UNRESOLVED' ? 'warn' : 'info')}</p><p class="metric-sub">${lead.proposal.scenarioName} v${lead.proposal.version}</p>`
                : html`<p class="metric-sub">Not evaluated.</p>`
            }
          </div>
          <div>
            <h3>Blocking</h3>
            <p style="margin:4px 0">${view.blockers.length === 0 ? (lead?.evaluation ? badge('nothing for review', 'ok') : '—') : badge(`${view.blockers.length} for review`, 'bad')}</p>
            <p class="metric-sub">${view.costs.known.lines === 0 ? 'No cost line yet' : `Known cost ${range(view.costs.known.lowMinor, view.costs.known.highMinor)}`}${view.costs.unresolved.length ? ` · ${view.costs.unresolved.length} unresolved liabilit${view.costs.unresolved.length === 1 ? 'y' : 'ies'}` : ''}</p>
          </div>
        </div>
        ${site?.divergence?.material ? notice(html`The drawn and confirmed areas need review: ${site.divergence.reasons.join(' ')}`, 'warn') : ''}
        ${
          view.blockers.length > 0
            ? html`<h3 style="margin-top:12px">What is blocking</h3>
                ${table({
                  headers: ['Scenario', 'Finding', 'Gate', 'Why', 'Evidence needed', 'Source'],
                  rows: view.blockers.map((finding) => [
                    finding.scenario,
                    finding.title,
                    finding.gate,
                    html`<span style="font-size:12.5px">${finding.reason}</span>`,
                    html`<span style="font-size:12px">${finding.evidenceNeeded.join('; ') || '—'}</span>`,
                    sourceLink(finding.source),
                  ]),
                })}`
            : ''
        }
      </section>

      ${agentsCard(agentsLoaded, reg, view, { canCreate, canUpdate })}
      ${siteCard(view, canUpdate)}
      ${scenariosCard(view, canCreate)}
      ${consentCards(reg, view, { canCreate, canUpdate, canApprove })}
      ${feesCard(view, quotedIds, canCreate, publishedFees)}
      ${costsCard(view, canCreate, canUpdate, reg)}
      ${rulesCard(view, canUpdate, canApprove)}
    `,
  );

  const facts = vocab.facts;
  const options = (values, words = {}) => values.map((value) => ({ value, label: words[value] ?? humanise(value) }));

  const COMMANDS = {
    'pl-site': () => ({
      title: 'Record the site',
      intent:
        'The site area — whatever its size — and, if you have it, the red-line boundary as GeoJSON (EPSG:4326), which is measured on the ' +
        'ellipsoid and held beside the stated area. Each recording is a new revision; earlier ones are kept.',
      path: `${base}/site-versions`,
      submitLabel: 'Record',
      fields: [
        { name: 'areaHa', label: 'Site area (hectares)', type: 'number', min: 0, step: 'any', required: false, hint: 'From the title, the survey or the particulars. 1 ha = 10,000 m².' },
        { name: 'geometryFile', label: 'Red-line boundary file (optional)', type: 'textfile', into: 'geometry', accept: '.geojson,.json,application/geo+json,application/json', required: false },
        { name: 'geometry', label: 'Or paste the GeoJSON (optional)', type: 'textarea', rows: 4, required: false, placeholder: '{"type":"Polygon","coordinates":[[[-1.5,52.2],…]]}' },
        { name: 'authorityName', label: 'Local planning authority', type: 'text', value: site?.authority.name ?? '' },
        { name: 'authorityConfirmed', label: 'The authority is confirmed for this site', type: 'checkbox', value: site?.authority.confirmed ?? false },
        { name: 'authoritySource', label: 'Confirmed from', type: 'text', required: false, value: site?.authority.source ?? '' },
        { name: 'boundarySource', label: 'Where the area or boundary came from', type: 'text', placeholder: 'Title plan WK123456; topographical survey rev B' },
      ],
      validate: (v) => {
        if (!v.geometry && (v.areaHa === undefined || v.areaHa === '')) return { field: 'areaHa', message: 'Give the site area, or a boundary to measure it from.' };
        if (!v.geometry) return undefined;
        try {
          JSON.parse(String(v.geometry));
          return undefined;
        } catch {
          return { field: 'geometry', message: 'This is not valid JSON.' };
        }
      },
      transform: (v) => ({
        ...(v.geometry ? { geometry: JSON.parse(v.geometry) } : {}),
        confirmedAreaM2: v.areaHa === undefined || v.areaHa === '' ? null : Math.round(Number(v.areaHa) * 10_000 * 100) / 100,
        authority: { name: v.authorityName, confirmed: Boolean(v.authorityConfirmed), ...(v.authoritySource ? { source: v.authoritySource } : {}) },
        boundarySource: v.boundarySource,
      }),
      report: (res) => ({
        title: `Site revision ${res.revision} recorded`,
        message: `${res.confirmedAreaM2 !== null ? `Stated ${ha(res.confirmedAreaM2)}. ` : ''}${res.calculatedAreaM2 !== null ? `Boundary measures ${m2(res.calculatedAreaM2)} (${ha(res.calculatedAreaM2)}).` : ''}${res.divergence.material ? ` For review: ${res.divergence.reasons.join(' ')}` : ''}`,
        tone: res.divergence.material ? 'warn' : 'ok',
      }),
    }),
    'pl-accept': (button) => ({
      title: `Accept red line revision ${button.dataset.revision}`,
      intent: 'Accepting a revision makes it the one fees and rules read. Say what it was checked against.',
      path: `${base}/site-versions/${button.dataset.site}/accept`,
      submitLabel: 'Accept',
      fields: [{ name: 'note', label: 'Checked against', type: 'text', placeholder: 'The title plan and the topographical survey' }],
    }),
    'pl-fact': (button) => {
      const key = button.dataset.key;
      return {
        title: facts[key].label,
        intent: 'A fact about the site the rules read. Give its source and date — a blank map response is not a fact.',
        path: `${base}/facts`,
        submitLabel: 'Record',
        fields: [
          { name: 'value', label: facts[key].label, type: 'select', options: options(facts[key].values), value: view.facts[key]?.value ?? '' },
          { name: 'source', label: 'Source', type: 'text', placeholder: 'Flood Map for Planning, 21 Nov 2026', value: '' },
          { name: 'note', label: 'Note', type: 'textarea', rows: 2, required: false },
        ],
        transform: (v) => ({ key, ...v }),
      };
    },
    'pl-proposal': (button) => {
      const previous = view.scenarios.find((entry) => entry.proposal.scenarioName === button?.dataset?.scenario)?.proposal;
      return {
        title: previous ? `New version of ${previous.scenarioName}` : 'Record a proposal',
        intent:
          'What is to be built on this site — housing, a school, a substation, temporary accommodation or anything else — and its numbers. ' +
          'Leave any number blank where it is not known: the rules treat it as unknown, not zero.',
        path: `${base}/proposals`,
        submitLabel: 'Record',
        fields: [
          { name: 'scenarioName', label: 'Scenario', type: 'text', value: previous?.scenarioName ?? '', placeholder: 'Full, primary school' },
          {
            name: 'category',
            label: 'Planning need',
            type: 'select',
            options: Object.entries(vocab.categories).map(([value, entry]) => ({ value, label: entry.label })),
            value: previous?.category ?? (previous?.use === 'HOUSING' ? 'RESIDENTIAL' : previous?.use) ?? 'RESIDENTIAL',
          },
          { name: 'description', label: 'The need in your own words', type: 'textarea', rows: 2, required: false, value: previous?.description ?? '', placeholder: '2-form-entry primary school with a nursery' },
          { name: 'route', label: 'Route', type: 'select', options: [{ value: 'full', label: 'Full application' }, { value: 'outline', label: 'Outline application' }], value: previous?.route ?? 'full' },
          { name: 'dwellingCount', label: 'Dwellings (housing or mixed use)', type: 'number', min: 1, step: '1', required: false, value: previous?.dwellings ?? '' },
          { name: 'createdGiaM2', label: 'Floorspace created (GIA, m²)', type: 'number', min: 0, required: false, value: previous?.createdGiaM2 ?? '' },
          { name: 'unitsCount', label: 'Capacity — bedspaces, pupils, beds…', type: 'number', min: 1, step: '1', required: false, value: previous?.capacityUnits?.count ?? '' },
          { name: 'unitsName', label: 'What the capacity counts', type: 'text', required: false, value: previous?.capacityUnits?.unit ?? '', placeholder: 'bedspaces' },
          { name: 'temporaryMonths', label: 'Needed for (months), if temporary', type: 'number', min: 1, step: '1', required: false, value: previous?.temporaryMonths ?? '' },
          { name: 'capacityMW', label: 'Generating or storage capacity (MW), if energy', type: 'number', min: 0, step: 'any', required: false, value: previous?.capacityMW ?? '' },
          { name: 'assumptions', label: 'Assumptions, one per line', type: 'textarea', rows: 3, required: false, value: (previous?.assumptions ?? []).join('\n') },
        ],
        transform: (v) => ({
          siteVersionId: site.id,
          scenarioName: v.scenarioName,
          route: v.route,
          category: v.category,
          ...(v.description ? { description: v.description } : {}),
          dwellingCount: v.dwellingCount === undefined ? null : Number(v.dwellingCount),
          createdGiaM2: v.createdGiaM2 === undefined ? null : Number(v.createdGiaM2),
          ...(v.unitsCount !== undefined && v.unitsName ? { capacityUnits: { count: Number(v.unitsCount), unit: v.unitsName } } : {}),
          ...(v.temporaryMonths !== undefined ? { temporaryMonths: Number(v.temporaryMonths) } : {}),
          ...(v.capacityMW !== undefined ? { capacityMW: Number(v.capacityMW) } : {}),
          assumptions: String(v.assumptions ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        }),
      };
    },
    'pl-evaluate': (button) => ({
      title: `Evaluate ${button.dataset.name}`,
      intent: 'Runs the rule pack against this proposal, the red line it sits on and the site facts as they stand now, and keeps the result as it stood.',
      path: `${base}/evaluations`,
      submitLabel: 'Evaluate',
      fields: [],
      transform: () => ({ proposalId: button.dataset.proposal }),
      report: (res) => ({
        title: 'Evaluated',
        message: `${res.findings.filter((finding) => finding.status === 'review_required').length} finding(s) for review; major development: ${humanise(res.major).toLowerCase()}.`,
        tone: 'ok',
      }),
    }),
    'pl-fee': () => ({
      title: 'Quote the planning fee',
      intent:
        'The standard national fee for the route and the date the application or request is made (Europe/London). Kept as a snapshot. ' +
        'No payable figure unless the schedule for that date has been checked and published in this company and the case is standard.',
      path: `${base}/fee-quotes`,
      submitLabel: 'Quote',
      fields: [
        { name: 'route', label: 'Route', type: 'select', options: options(vocab.feeRoutes, FEE_ROUTE_WORDS) },
        { name: 'madeOn', label: 'Made on', type: 'date' },
        { name: 'dateBasis', label: 'The date is', type: 'select', options: [{ value: 'ASSUMED', label: 'Assumed (planning ahead)' }, { value: 'EVIDENCED', label: 'Evidenced (filed)' }] },
        {
          name: 'proposalId',
          label: 'Proposal',
          type: 'select',
          required: false,
          placeholder: 'None — enter the dwellings below',
          options: view.scenarios.map((entry) => ({ value: entry.proposal.id, label: `${entry.proposal.scenarioName} v${entry.proposal.version}` })),
          value: lead?.proposal.id ?? '',
        },
        { name: 'dwellings', label: 'Dwellings, if not from the proposal', type: 'number', min: 1, step: '1', required: false },
        {
          name: 'reservedHistory',
          label: 'Reserved matters: qualifying payment history',
          type: 'select',
          required: false,
          options: [
            { value: 'unknown', label: 'Not verified' },
            { value: 'met', label: 'Threshold met — flat fee' },
            { value: 'not-met', label: 'Not met — full-application fee' },
          ],
          value: 'unknown',
        },
        { name: 'nonStandard', label: 'Anything non-standard (exemption, reduction, mixed category)', type: 'text', required: false },
      ],
      transform: (v) => ({
        route: v.route,
        madeOn: v.madeOn,
        dateBasis: v.dateBasis,
        ...(v.proposalId ? { proposalId: v.proposalId } : {}),
        ...(v.dwellings !== undefined ? { dwellings: Number(v.dwellings) } : {}),
        reservedHistoryThresholdMet: v.reservedHistory === 'met' ? true : v.reservedHistory === 'not-met' ? false : null,
        ...(v.nonStandard ? { nonStandard: v.nonStandard } : {}),
      }),
      report: (res) =>
        res.amountMinor === null
          ? { title: 'Review required', message: res.reviewReasons.join(' '), tone: 'warn' }
          : { title: `Fee ${money(res.amountMinor)}`, message: `${res.ruleVersion}, made ${res.madeOn} (${res.dateBasis.toLowerCase()}).`, tone: 'ok' },
    }),
    'pl-fee-cost': (button) => ({
      title: 'Add the fee as a cost line',
      intent: 'The quoted fee becomes a statutory fee line carrying the quote’s figure. Quote again for a different one.',
      path: `${base}/costs`,
      submitLabel: 'Add',
      fields: [
        { name: 'label', label: 'Label', type: 'text', value: button.dataset.label },
        { name: 'costCode', label: 'Cost code', type: 'text', value: 'PL-FEE' },
        { name: 'gate', label: 'Gate', type: 'select', options: options(vocab.gates), value: 'G2' },
        { name: 'vatBasis', label: 'VAT', type: 'select', options: options(vocab.vatBases), value: 'NOT_APPLICABLE' },
        { name: 'estimateDate', label: 'Estimate date', type: 'date', value: new Date().toISOString().slice(0, 10) },
        { name: 'cashTrigger', label: 'Paid', type: 'text', value: 'On submission' },
      ],
      transform: (v) => ({ ...v, confidence: 'HIGH', feeQuoteId: button.dataset.quote }),
    }),
    'pl-cost': () => ({
      title: 'Add a cost line',
      intent:
        'A planning cost: low, base and high, each left blank where it is not known — an unknown is never counted as zero. A liability or an in-kind ' +
        'obligation is kept out of the cash forecast.',
      path: `${base}/costs`,
      submitLabel: 'Add',
      fields: costFields(vocab, {}),
      transform: (v) => ({ ...v, ...(v.lowMinor === undefined ? { lowMinor: null } : {}), ...(v.baseMinor === undefined ? { baseMinor: null } : {}), ...(v.highMinor === undefined ? { highMinor: null } : {}) }),
    }),
    'pl-cost-revise': (button) => {
      const line = view.lines.find((entry) => entry.id === button.dataset.line);
      return {
        title: `Revise ${line.label}`,
        intent: 'A new version of the line. If somebody else has changed it since this screen loaded, the platform refuses and asks you to read it again.',
        path: `${base}/costs/${line.id}`,
        method: 'PATCH',
        ifMatch: line.version,
        submitLabel: 'Save',
        fields: [
          { name: 'label', label: 'Label', type: 'text', value: line.label },
          { name: 'source', label: 'Source', type: 'text', value: line.source },
          ...(line.feeQuoteId
            ? []
            : [
                { name: 'lowMinor', label: 'Low (£)', type: 'number', money: true, min: 0, required: false, value: line.lowMinor === null ? '' : line.lowMinor / 100 },
                { name: 'baseMinor', label: 'Base (£)', type: 'number', money: true, min: 0, required: false, value: line.baseMinor === null ? '' : line.baseMinor / 100 },
                { name: 'highMinor', label: 'High (£)', type: 'number', money: true, min: 0, required: false, value: line.highMinor === null ? '' : line.highMinor / 100 },
              ]),
          { name: 'confidence', label: 'Confidence', type: 'select', options: options(vocab.confidences), value: line.confidence },
          { name: 'estimateDate', label: 'Estimate date', type: 'date', value: line.estimateDate },
          { name: 'committedMinor', label: 'Committed (£) — ordered or appointed', type: 'number', money: true, min: 0, required: false, value: line.committedMinor == null ? '' : line.committedMinor / 100 },
          { name: 'actualMinor', label: 'Paid to date (£)', type: 'number', money: true, min: 0, required: false, value: line.actualMinor == null ? '' : line.actualMinor / 100 },
          { name: 'commitmentRef', label: 'Order or invoice reference', type: 'text', required: false, value: line.commitmentRef ?? '' },
        ],
      };
    },
    'pl-cost-withdraw': (button) => {
      const line = view.lines.find((entry) => entry.id === button.dataset.line);
      return {
        title: `Withdraw ${line.label}`,
        intent: 'The line stays on the record as withdrawn, with the reason, and leaves the totals.',
        path: `${base}/costs/${line.id}`,
        method: 'PATCH',
        ifMatch: line.version,
        submitLabel: 'Withdraw',
        fields: [{ name: 'reason', label: 'Why', type: 'text' }],
        transform: (v) => ({ withdraw: { reason: v.reason } }),
      };
    },
    'pl-budget': (button) => ({
      title: `Start ${button.dataset.reference}’s budget`,
      intent:
        'One line for planning and design, one for legal and pre-application work, and one for each study this application’s own need calls for — ' +
        'each named for it and left without a figure until it is priced from a quote or an estimate. Lines already there are not added twice.',
      path: `/v1/projects/${projectId}/planning/applications/${button.dataset.application}/budget`,
      submitLabel: 'Add the lines',
      fields: [],
      report: (res) => ({ title: 'Lines added', message: `${res.length} line${res.length === 1 ? '' : 's'} to price.`, tone: 'ok' }),
    }),
    'pl-rule-prepare': (button) => ({
      title: `Check ${button.dataset.version}`,
      intent:
        'Record that you checked this version against its published sources, figure by figure. A second person then publishes it; until then it gives no payable fee.',
      path: `${base}/rule-versions/${button.dataset.version}/prepare`,
      submitLabel: 'Record the check',
      fields: [{ name: 'checkNote', label: 'What you checked, against which source', type: 'textarea', rows: 4 }],
    }),
    'pl-rule-publish': (button) => ({
      title: `Publish ${button.dataset.version}`,
      intent: 'Publishing makes this version the one the company relies on. You cannot publish a version you checked yourself.',
      path: `${base}/rule-versions/${button.dataset.version}/publish`,
      submitLabel: 'Publish',
      brief: button.dataset.note ? html`<p style="font-size:13px"><b>The check recorded:</b> ${button.dataset.note}</p>` : undefined,
      fields: [{ name: 'note', label: 'What you reviewed', type: 'text' }],
    }),
    'pl-rule-return': (button) => ({
      title: `Return ${button.dataset.version}`,
      intent: 'Send it back to the editor with what is wrong.',
      path: `${base}/rule-versions/${button.dataset.version}/return`,
      submitLabel: 'Return',
      fields: [{ name: 'reason', label: 'What is wrong', type: 'text' }],
    }),
  };

  Object.assign(COMMANDS, consentCommands(reg, view, base));
  Object.assign(COMMANDS, agentCommands(agentsLoaded, reg, base));

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const make = COMMANDS[button.dataset.command];
    if (!make) return;
    if (await command(make(button, root))) await draw();
  });
  bindConsentExtras(root, base, draw);
  bindAgentExtras(root, agentsLoaded);
}

function costFields(vocab, line) {
  const options = (values) => values.map((value) => ({ value, label: humanise(value) }));
  return [
    { name: 'label', label: 'Label', type: 'text', value: line.label ?? '' },
    { name: 'costCode', label: 'Cost code', type: 'text', value: line.costCode ?? '' },
    { name: 'kind', label: 'Kind', type: 'select', options: options(vocab.costKinds), value: line.kind ?? 'ALLOWANCE' },
    { name: 'gate', label: 'Gate', type: 'select', options: options(vocab.gates), value: line.gate ?? 'G1' },
    { name: 'phase', label: 'Phase', type: 'text', required: false },
    { name: 'source', label: 'Source', type: 'text', placeholder: 'Quote from …, dated …' },
    { name: 'lowMinor', label: 'Low (£)', type: 'number', money: true, min: 0, required: false },
    { name: 'baseMinor', label: 'Base (£)', type: 'number', money: true, min: 0, required: false },
    { name: 'highMinor', label: 'High (£)', type: 'number', money: true, min: 0, required: false },
    { name: 'vatBasis', label: 'VAT', type: 'select', options: options(vocab.vatBases), value: 'EXCLUDED' },
    { name: 'confidence', label: 'Confidence', type: 'select', options: options(vocab.confidences), value: 'LOW' },
    { name: 'estimateDate', label: 'Estimate date', type: 'date', value: new Date().toISOString().slice(0, 10) },
    { name: 'cashTrigger', label: 'Paid when', type: 'text', placeholder: 'Appointment; submission; commencement' },
  ];
}

function sourceLink(source) {
  return source.url ? html`<a href="${source.url}" target="_blank" rel="noopener" style="font-size:12px">${source.title}</a>` : html`<span style="font-size:12px">${source.title}</span>`;
}

function siteCard(view, canUpdate) {
  const site = view.site;
  const facts = view.vocabulary.facts;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-site-h" data-planning-site>
    <h2 id="pl-site-h">Site</h2>
    ${
      site
        ? html`${table({
            headers: ['Revision', 'Measured from the boundary', 'Stated area', 'Authority', 'Boundary from', 'Status'],
            rows: [
              [
                `${site.revision}`,
                site.calculatedAreaM2 === null ? html`<span class="metric-sub">no boundary drawn</span>` : html`${m2(site.calculatedAreaM2)}<br><span class="metric-sub">${ha(site.calculatedAreaM2)}</span>`,
                site.confirmedAreaM2 === null ? html`<span class="metric-sub">not recorded</span>` : html`${m2(site.confirmedAreaM2)}<br><span class="metric-sub">${ha(site.confirmedAreaM2)}</span>`,
                html`${site.authority.name}${site.authority.code ? ` (${site.authority.code})` : ''}<br>${badge(site.authority.confirmed ? 'confirmed' : 'to confirm', site.authority.confirmed ? 'ok' : 'warn')}${site.authority.source ? html` <span class="metric-sub">${site.authority.source}</span>` : ''}`,
                html`<span style="font-size:12.5px">${site.boundarySource}</span>`,
                site.accepted
                  ? html`${badge('accepted', 'ok')}<br><span class="metric-sub">${date(site.accepted.at)}: ${site.accepted.note}</span>`
                  : canUpdate
                    ? html`${badge('not accepted', 'warn')} <button class="btn quiet sm" data-command="pl-accept" data-site="${site.id}" data-revision="${site.revision}">Accept</button>`
                    : badge('not accepted', 'warn'),
              ],
            ],
          })}
          <p class="metric-sub" style="margin-top:6px">Measured on the WGS84 ellipsoid from the boundary as drawn. The confirmed area is the legal one and is what the rules read where it is recorded. Spatial lookups (flood, designations, heritage) are not connected on this deployment, so each fact below is recorded by a person with its source.</p>`
        : html`<p class="metric-sub">No red line yet. Record it from a GeoJSON file or by pasting the GeoJSON.</p>`
    }
    <h3 style="margin-top:12px">Facts the rules read</h3>
    ${table({
      headers: ['Fact', 'Recorded', 'Source', ''],
      rows: Object.entries(facts).map(([key, definition]) => {
        const fact = view.facts[key];
        return [
          definition.label,
          fact ? badge(humanise(fact.value), 'info') : html`<span class="metric-sub">unknown</span>`,
          fact ? html`<span style="font-size:12px">${fact.source} · ${date(fact.recordedAt)}</span>` : '—',
          canUpdate ? html`<button class="btn quiet sm" data-command="pl-fact" data-key="${key}">${fact ? 'Change' : 'Record'}</button>` : '',
        ];
      }),
    })}
  </section>`;
}

function scenariosCard(view, canCreate) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-scen-h" data-planning-scenarios>
    <h2 id="pl-scen-h">Proposals and rule findings</h2>
    ${
      view.scenarios.length === 0
        ? html`<p class="metric-sub">${view.site ? 'No proposal recorded. Record one to evaluate it against the rules.' : 'Record the site first.'}</p>`
        : view.scenarios.map(({ proposal, evaluation, stale }) => {
            const counts = evaluation
              ? ['review_required', 'applies', 'does_not_apply', 'unavailable'].map((status) => [status, evaluation.findings.filter((finding) => finding.status === status).length])
              : [];
            return html`<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
              <h3 style="margin:0">${proposal.scenarioName} <span class="metric-sub">v${proposal.version} · ${proposal.route} · ${(view.vocabulary.categories[proposal.category ?? (proposal.use === 'HOUSING' ? 'RESIDENTIAL' : proposal.use)]?.label ?? humanise(proposal.use)).toLowerCase()}${
                proposal.capacityUnits ? ` · ${proposal.capacityUnits.count} ${proposal.capacityUnits.unit}` : ''
              }${proposal.temporaryMonths ? ` · ${proposal.temporaryMonths} months` : ''}${proposal.capacityMW ? ` · ${proposal.capacityMW} MW` : ''}${
                ['RESIDENTIAL', 'MIXED'].includes(proposal.category ?? 'RESIDENTIAL') || proposal.use ? ` · ${proposal.dwellings === null ? 'dwellings unknown' : String(proposal.dwellings) + ' dwellings'}` : ''
              } · ${proposal.createdGiaM2 === null ? 'floorspace unknown' : m2(proposal.createdGiaM2)}</span></h3>
              ${proposal.description ? html`<p style="margin:4px 0;font-size:13px">${proposal.description}</p>` : ''}
              ${proposal.assumptions.length ? html`<p class="metric-sub" style="margin:4px 0">Assumptions: ${proposal.assumptions.join('; ')}</p>` : ''}
              <p style="margin:6px 0">
                ${
                  evaluation
                    ? html`${counts.map(([status, count]) => (count ? html`${badge(`${count} ${STATUS_WORDS[status]}`, STATUS_TONE[status])} ` : ''))}
                        <span class="metric-sub">evaluated ${date(evaluation.evaluatedAt)} against ${evaluation.ruleVersion}${evaluation.rulePackPublished ? '' : ' (not yet published in this company)'}</span>`
                    : badge('not evaluated', 'warn')
                }
                ${canCreate ? html` <button class="btn quiet sm" data-command="pl-evaluate" data-proposal="${proposal.id}" data-name="${proposal.scenarioName} v${proposal.version}">${evaluation ? 'Evaluate again' : 'Evaluate'}</button>` : ''}
                ${canCreate && view.site ? html` <button class="btn quiet sm" data-command="pl-proposal" data-scenario="${proposal.scenarioName}">New version</button>` : ''}
              </p>
              ${stale.length ? notice(html`This evaluation is stale: ${stale.join(' ')} Evaluate again to read the project as it is.`, 'warn') : ''}
              ${
                evaluation
                  ? html`<details><summary style="cursor:pointer;font-size:13px">All ${evaluation.findings.length} findings</summary>
                      ${table({
                        headers: ['Finding', 'Status', 'Gate', 'Reason', 'Evidence needed', 'Source'],
                        rows: evaluation.findings.map((finding) => [
                          html`${finding.title}<br><span class="metric-sub">${finding.code}</span>`,
                          badge(STATUS_WORDS[finding.status], STATUS_TONE[finding.status]),
                          finding.gate,
                          html`<span style="font-size:12.5px">${finding.reason}</span>`,
                          html`<span style="font-size:12px">${finding.evidenceNeeded.join('; ') || '—'}</span>`,
                          sourceLink(finding.source),
                        ]),
                      })}
                    </details>`
                  : ''
              }
            </div>`;
          })
    }
  </section>`;
}

function feesCard(view, quotedIds, canCreate, publishedFees) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-fee-h" data-planning-fees>
    <h2 id="pl-fee-h">Planning fees</h2>
    ${
      publishedFees === 0
        ? notice('No fee schedule is published in this company yet, so every quote shows what it would come to but nothing payable. A planning rule approver publishes the schedules under Rule versions, below.', 'info')
        : ''
    }
    ${table({
      headers: ['Route', 'Made on', 'Fee', 'Schedule', 'Breakdown', ''],
      empty: 'No fee quoted yet',
      emptyDetail: 'Quote the national fee for a route and a made date.',
      rows: view.quotes.map((quote) => [
        FEE_ROUTE_WORDS[quote.route] ?? quote.route,
        html`${quote.madeOn}<br><span class="metric-sub">${quote.dateBasis.toLowerCase()}</span>`,
        quote.amountMinor === null
          ? html`${badge('review required', 'warn')}<br><span style="font-size:12px">${quote.reviewReasons.join(' ')}</span>`
          : html`<b>${money(quote.amountMinor)}</b>`,
        quote.ruleVersion ? html`<a href="${quote.sourceUrl}" target="_blank" rel="noopener" style="font-size:12px">${quote.ruleVersion}</a>` : '—',
        html`<span style="font-size:12px">${quote.breakdown.map((line) => `${line.description}: ${line.quantity} × ${money(line.unitMinor)} = ${money(line.amountMinor)}`).join('; ') || '—'}${
          quote.amountMinor === null && quote.breakdown.length ? ' (not payable until published)' : ''
        }</span>`,
        quote.amountMinor !== null && canCreate && !quotedIds.has(quote.id)
          ? html`<button class="btn quiet sm" data-command="pl-fee-cost" data-quote="${quote.id}" data-label="${FEE_ROUTE_WORDS[quote.route] ?? quote.route} fee">Add as cost</button>`
          : quotedIds.has(quote.id)
            ? badge('costed', 'ok')
            : '',
      ]),
    })}
  </section>`;
}

function costsCard(view, canCreate, canUpdate, reg) {
  const budgetable = reg.error ? [] : reg.applications.filter((application) => reg.studies.some((study) => study.applicationId === application.id));
  const costs = view.costs;
  const active = view.lines.filter((line) => line.status === 'ACTIVE');
  const withdrawn = view.lines.filter((line) => line.status === 'WITHDRAWN');
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-cost-h" data-planning-costs>
    <h2 id="pl-cost-h">Planning costs ${canCreate ? budgetable.map((application) => html`<button class="btn quiet sm" data-command="pl-budget" data-application="${application.id}" data-reference="${application.reference}">Start ${application.reference}’s budget</button> `) : ''}</h2>
    <div class="grid g4" style="margin-top:8px">
      <div><h3>Known subtotal</h3>${
        costs.known.lines === 0
          ? html`<p class="metric-sub">No cost line yet.</p>`
          : html`<p style="margin:4px 0"><b>${range(costs.known.lowMinor, costs.known.highMinor)}</b></p>
              <p class="metric-sub">${costs.known.baseMinor === null ? `Base not set on ${costs.known.baseMissing} line(s)` : `Base ${money(costs.known.baseMinor)}`}</p>`
      }</div>
      <div><h3>Unknown amounts</h3><p style="margin:4px 0">${costs.unknownCashLines.length ? badge(`${costs.unknownCashLines.length} line(s)`, 'warn') : badge('none', 'ok')}</p>
        <p class="metric-sub">${costs.unknownCashLines.map((line) => line.label).join(', ') || 'Every cash line has a range.'}</p></div>
      <div><h3>Forecast outturn</h3><p style="margin:4px 0"><b>${money(costs.outturn.minor)}</b></p>
        <p class="metric-sub">Paid ${money(costs.outturn.actualMinor)} · committed, unpaid ${money(costs.outturn.committedMinor)} · uncommitted base ${money(costs.outturn.uncommittedMinor)}${
          costs.outturn.unforecast ? ` · ${costs.outturn.unforecast} line(s) with no base cannot be forecast` : ''
        }</p></div>
      <div><h3>Unresolved liabilities</h3><p style="margin:4px 0">${costs.unresolved.length ? badge(`${costs.unresolved.length}`, 'bad') : badge('none', 'ok')}</p>
        <p class="metric-sub">${costs.unresolved.join(' ')}</p></div>
    </div>
    <p class="metric-sub">Excludes ${costs.excludes.join(', ')}. Liabilities and in-kind obligations are listed apart and never added into the cash figure.</p>
    ${table({
      headers: ['Line', 'Kind', 'Gate', 'Low – high', 'Base', 'VAT', 'Confidence', 'Source', ''],
      empty: 'No cost line yet',
      emptyDetail: 'Add a line, add a calculated fee, or start an application’s budget once its studies are planned.',
      rows: active.map((line) => [
        html`${line.label}<br><span class="metric-sub">${line.costCode}${line.phase ? ` · ${line.phase}` : ''} · ${line.cashTrigger}</span>`,
        humanise(line.kind),
        line.gate,
        range(line.lowMinor, line.highMinor),
        line.baseMinor === null ? html`<span class="metric-sub">not set</span>` : money(line.baseMinor),
        humanise(line.vatBasis),
        humanise(line.confidence),
        html`<span style="font-size:12px">${line.source} · ${line.estimateDate}</span>`,
        canUpdate
          ? html`<button class="btn quiet sm" data-command="pl-cost-revise" data-line="${line.id}">Revise</button> <button class="btn quiet sm" data-command="pl-cost-withdraw" data-line="${line.id}">Withdraw</button>`
          : '',
      ]),
    })}
    ${withdrawn.length ? html`<p class="metric-sub">${withdrawn.length} withdrawn line(s) kept on the record: ${withdrawn.map((line) => `${line.label} (${line.withdrawnReason})`).join('; ')}.</p>` : ''}
  </section>`;
}

function rulesCard(view, canUpdate, canApprove) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-rule-h" data-planning-rules>
    <h2 id="pl-rule-h">Rule versions</h2>
    <p class="metric-sub">The rule pack and each fee schedule are relied on only once somebody has checked them against their published sources and a second person has published them. The figures were transcribed from the CONSTRUX Planning specification; this deployment cannot reach the sources to check them itself.</p>
    ${table({
      headers: ['Version', 'What it is', 'In force', 'Status', 'Sources', ''],
      rows: view.rules.map((rule) => {
        const record = rule.record;
        const actions = [];
        if (canUpdate && rule.status !== 'PUBLISHED' && rule.status !== 'PREPARED') {
          actions.push(html`<button class="btn quiet sm" data-command="pl-rule-prepare" data-version="${rule.version}">Record the check</button>`);
        }
        if (rule.status === 'PREPARED' && canApprove) {
          actions.push(
            rule.preparedByYou
              ? html`<button class="btn quiet sm" disabled title="You checked it; a second person publishes it">Publish 🔒</button>`
              : html`<button class="btn quiet sm" data-command="pl-rule-publish" data-version="${rule.version}" data-note="${record.checkNote}">Publish</button>`,
          );
          actions.push(html`<button class="btn quiet sm" data-command="pl-rule-return" data-version="${rule.version}">Return</button>`);
        }
        return [
          html`<code>${rule.version}</code>`,
          html`<span style="font-size:12.5px">${rule.title}</span>`,
          rule.effective ?? '—',
          html`${badge(RULE_WORDS[rule.status] ?? rule.status, RULE_TONE[rule.status] ?? 'neutral')}${
            record?.status === 'PUBLISHED' ? html`<br><span class="metric-sub">${date(record.publishedAt)}</span>` : ''
          }${record?.status === 'RETURNED' ? html`<br><span class="metric-sub">${record.returnReason}</span>` : ''}${
            record?.status === 'PREPARED' ? html`<br><span class="metric-sub">${record.checkNote}</span>` : ''
          }`,
          html`${rule.sources.map((url) => html`<a href="${url}" target="_blank" rel="noopener" style="font-size:12px;display:block">${url.replace(/^https:\/\/(www\.)?/, '').slice(0, 48)}…</a>`)}`,
          html`${actions.length ? html`${actions}` : ''} <button class="btn quiet sm" data-rule-detail="${rule.version}">Differences and impact</button><div data-rule-detail-for="${rule.version}"></div>`,
        ];
      }),
    })}
  </section>`;
}
