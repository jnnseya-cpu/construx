import { html, table, raw } from './ui.js';

/**
 * Pre-construction site-visit methodology — the discipline behind the walk the
 * Field Modules page records.
 *
 * This is reference content, not project data. It sits beside "Record a site
 * visit" / "Raise a finding" so the person conducting the walk has the method
 * in front of them: what to establish before arriving, what to inspect on each
 * kind of site, how to write a finding that can actually be designed and priced
 * against, and how to turn the walk into a targeted survey programme and an
 * engineered site layout.
 *
 * It is a Great Britain construction framework. The engineering approach
 * applies more widely, but the statutory and environmental points are
 * England-specific and are flagged where they need local verification — the
 * platform states that limit rather than implying the guidance is universal.
 *
 * Collapsed by default (one `<details>`, with the three site-type checklists as
 * nested ones) so it informs without dominating the register above it. Every
 * table and list below is the source methodology, structured — nothing is
 * invented and nothing is presented as this project's own facts.
 */

const SITE_TYPES = [
  [
    'Greenfield',
    'Creating access, working ground, drainage and utilities where little infrastructure exists',
    '“It is an empty field, so mobilisation will be straightforward”',
    'Establish whether the land can support construction activities and what enabling infrastructure is needed',
  ],
  [
    'Brownfield',
    'Discovering and managing previous development and land use',
    '“The buildings are gone, therefore the site is clear”',
    'Identify buried obstructions, contamination, redundant and live services, and the condition of retained assets',
  ],
  [
    'Live operational site',
    'Constructing while protecting an existing business, public service or occupied facility',
    '“Operations will accommodate construction when we arrive”',
    'Agree physical separation, service continuity, access, shutdowns, interfaces and controlled handback',
  ],
];

const DESK_STUDY = [
  ['Project scope, concept layout and equipment schedule', 'Footprint, loads, delivery requirements and construction interfaces'],
  ['Ownership, lease, boundary and access information', 'Where you may work, store materials, cross land and establish compounds'],
  ['Planning permission and conditions', 'Restrictions affecting commencement, working hours, access, drainage and environmental controls'],
  ['Topographical and ground investigation reports', 'Levels, ground model, groundwater and design uncertainties'],
  ['Utility records and previous detection surveys', 'Known routes, ownership and areas requiring investigation'],
  ['Historic maps, previous site uses and demolition records', 'Possible tanks, foundations, pits, landfill and contamination'],
  ['Existing drawings, structural calculations and health and safety file', 'Retained asset configuration and known residual risks'],
  ['Asbestos information', 'Known materials, surveyed areas and inaccessible areas'],
  ['Drainage records and flood information', 'Outfalls, capacity, flood exposure and potential pollution routes'],
  ['Operational procedures and maintenance records', 'Critical services, failures, shutdown constraints and operational dependencies'],
  ['Ecology, trees, archaeology and neighbouring asset information', 'Areas and activities that may constrain layout or timing'],
];

const PRE_VISIT_DECISIONS = [
  'Can the proposed access accommodate the largest delivery?',
  'Is the compound location genuinely available throughout the programme?',
  'Can the work proceed without interrupting the existing power supply?',
  'What investigations are required before foundation design is finalised?',
  'Which permissions could control the start date?',
];

const GREENFIELD = [
  {
    heading: 'A. Access from the public road to the actual workface',
    lead: 'Do not stop at the proposed gate. Follow the entire route.',
    checks: [
      'Junction geometry, visibility and vehicle waiting space.',
      'Narrow lanes, bridges, culverts, steep gradients and weak verges.',
      'Overhead lines, trees, height restrictions and third-party access.',
      'Whether an articulated vehicle can enter, turn, unload and leave.',
      'Whether emergency vehicles can reach the workface during the wettest phase.',
      'Whether construction traffic conflicts with farms, residents or public routes.',
    ],
    record: 'Measured pinch points, gradients, photographs, route sketches and the vehicle assumptions requiring swept-path verification.',
    consequence:
      'Gate relocation, road widening, temporary crossings, off-site holding areas, smaller delivery vehicles or alternative erection methods. A transformer or modular building might fit through the gate but still be impossible to manoeuvre into position.',
  },
  {
    heading: 'B. Ground and earthworks',
    lead: 'Look for:',
    checks: [
      'Soft or waterlogged areas, rutting and standing water.',
      'Changes in vegetation, ground level or soil exposure.',
      'Ditches, ponds, springs, embankments and possible historic filling.',
      'Slopes affecting excavation stability or plant movement.',
      'Areas needed for topsoil storage and material segregation.',
    ],
    record: 'Location and extent of observations, weather, recent rainfall and areas inaccessible during the visit.',
    consequence:
      'Investigate ground properties for foundations, haul roads, compounds, crane pads and piling platforms — not only the permanent footprint. An investigation sufficient for foundation design may say little about a crane position 80 m away.',
  },
  {
    heading: 'C. Water management',
    lead: 'Trace where water comes from, where it crosses the site and where it would go after stripping vegetation or installing temporary roads. Plan separately for:',
    checks: [
      'Clean upstream runoff.',
      'Silty construction runoff.',
      'Excavation water.',
      'Concrete washout.',
      'Foul drainage.',
    ],
    record: 'The destination of each water type, and whether that destination is an authorised discharge point.',
    consequence:
      'Do not assume a nearby ditch is an authorised discharge destination. In England, discharge permissions and conditions must be established; temporary dewatering is not a blanket exemption from permitting.',
  },
  {
    heading: 'D. Ecology and seasonal constraints',
    lead: 'Identify trees, hedgerows, watercourses and potential protected habitats for specialist assessment — including the compound, access road and temporary utility routes, not just the permanent development.',
    checks: [],
    record: 'Features seen, and the areas beyond the permanent works that still need an ecological view.',
    consequence:
      'Ecological survey windows can determine programme feasibility. Government guidance sets species-specific survey timing; a missed window can affect when a reliable assessment is available.',
  },
  {
    heading: 'E. Temporary service availability',
    lead: 'A nearby pole or water main is only evidence of infrastructure nearby. Confirm:',
    checks: [
      'Available capacity and connection location.',
      'Connection lead time and commercial terms.',
      'Land rights for connection routes.',
      'Water pressure, flow and potable suitability.',
      'Foul drainage options.',
      'Communications coverage and resilience.',
    ],
    record: 'Confirmed capacities, lead times and the land rights still to secure.',
    consequence: 'Connection lead time and land rights frequently control the mobilisation date more than the building itself does.',
  },
];

const BROWNFIELD = [
  ['Old building footprints', 'Slab edges, plinths, patched surfaces and settlement', 'Compare historical layouts with new foundations and trenches'],
  ['Below-ground structures', 'Pits, basements, tanks, ducts and redundant chambers', 'Locate, investigate and determine removal, filling or retention'],
  ['Contamination indicators', 'Staining, odours, drums, unusual deposits and vegetation dieback', 'Competent contamination assessment and targeted investigation'],
  ['Existing hardstanding', 'Cracking, differential settlement and unknown construction', 'Assess suitability for the actual plant and imposed loads'],
  ['Services', 'Unlabelled chambers, abandoned cables and undocumented connections', 'Records review, detection, tracing and controlled verification'],
  ['Retained structures', 'Corrosion, cracking, distortion and previous alterations', 'Structural appraisal and investigation'],
  ['Previous remediation', 'Caps, membranes, monitoring wells and treatment areas', 'Obtain verification records and restrictions on disturbance'],
];

const LIVE_SYSTEMS = [
  'What it supplies.',
  'Who owns and controls it.',
  'Normal and standby arrangements.',
  'Isolation points and the verification required.',
  'Consequences of interruption.',
  'Maximum tolerable downtime, agreed by the operator.',
  'Restoration and acceptance requirements.',
];

const LIVE_ROUTES = [
  'Employees and visitors.',
  'Customers, patients or the public.',
  'Production deliveries.',
  'Forklifts and maintenance vehicles.',
  'Emergency responders.',
];

const LIVE_INTERFACE = [
  ['Construction boundary', 'Physical separation, controlled crossings and responsibility'],
  ['Shared roads', 'Priority, delivery windows and closure arrangements'],
  ['Live services', 'Isolation authority, verification and reconnection process'],
  ['Fire protection', 'Impairment approval, temporary precautions and reinstatement'],
  ['Dust / noise / vibration', 'Sensitive assets, agreed limits, monitoring and stop triggers'],
  ['Shutdowns', 'Approved window, prerequisites, contingency and recovery time'],
  ['Security', 'Access permissions, escorts and restricted information'],
  ['Completion', 'Testing, acceptance and formal return to operational control'],
];

const LIVE_TIEIN = [
  'Verified existing configuration.',
  'Approved method and isolation plan.',
  'Materials, tools and competent personnel ready.',
  'Defined tests before reconnection.',
  'A decision point beyond which further work would jeopardise restoration.',
  'A practicable rollback arrangement.',
  'Named operational acceptance authority.',
];

const RECORD_FIELDS = [
  ['Unique reference', 'ACC-007'],
  ['Exact location', 'Proposed north gate, marked on drawing'],
  ['Observation', 'Existing gate has restricted clear width'],
  ['Evidence', 'Photo P031 and measured dimension'],
  ['Information status', 'Measured on walkover; route beyond gate not surveyed'],
  ['Potential consequence', 'Proposed delivery vehicle may not negotiate entry'],
  ['Required action', 'Swept-path analysis using supplier’s vehicle details'],
  ['Owner', 'Logistics manager'],
  ['Required-by date', 'Before access design approval'],
  ['Closure evidence', 'Approved analysis and revised gate arrangement'],
];

const INFO_STATUS = [
  ['Observed', 'Visible during the visit.'],
  ['Measured', 'Dimension or value obtained, with method recorded.'],
  ['Reported', 'Information supplied by someone else.'],
  ['Verified', 'Checked through suitable evidence.'],
  ['Unknown', 'Unresolved.'],
];

const SURVEYS = [
  ['Topographical survey', 'Levels, gradients, drainage and layout'],
  ['Ground investigation', 'Foundations, earthworks, excavation and temporary platform design'],
  ['Utility detection and verification', 'Excavation routes, diversions and protection'],
  ['Drainage survey / CCTV', 'Connectivity, condition and retention proposals'],
  ['Structural survey / opening-up', 'Capacity and alteration sequence'],
  ['Asbestos refurbishment / demolition survey', 'Safe scope of intrusive works'],
  ['Contamination investigation', 'Remediation, exposure controls and materials strategy'],
  ['Ecology / arboriculture', 'Work boundaries, protection and timing'],
  ['Delivery-route and swept-path assessment', 'Access geometry and delivery method'],
  ['Baseline monitoring', 'Existing movement, noise or vibration where relevant'],
];

const ESTABLISH_INPUTS = [
  'Permanent works footprint and construction sequence.',
  'Available land by phase.',
  'Peak workforce and shift overlap.',
  'Largest delivery and maximum plant loads.',
  'Crane positions, operating envelopes and assembly areas.',
  'Storage needs and delivery frequency.',
  'Temporary utility demand.',
  'Protected areas and operational exclusions.',
  'Emergency access and escape arrangements.',
];

const ESTABLISH = [
  {
    heading: 'A. Logistics and circulation',
    body:
      'Provide suitable access, turning and unloading, physically separated pedestrian routes where practicable, delivery booking and clear workface distribution. Check how materials travel after unloading — a delivery bay is ineffective if every load then crosses the main pedestrian route. HSE’s traffic guidance emphasises pedestrian–vehicle separation, suitable routes, visibility and minimising vehicle movements.',
  },
  {
    heading: 'B. Compounds and welfare',
    body:
      'Size facilities for actual occupancy and use: toilets, washing, changing, drying, eating, rest, offices, induction and first aid. Assess walking distance, accessibility, servicing, cleaning, sewage removal and seasonal conditions. Welfare must be available from the start and maintained throughout the work.',
  },
  {
    heading: 'C. Temporary utilities',
    body:
      'Prepare a demand schedule and distribution design: connected loads and realistic coincident demand; starting currents and sensitive loads; protection, earthing and inspection; water flow, storage and resilience; foul drainage capacity; lighting and communications; isolation and emergency arrangements. For a live facility, establish whether temporary construction demand can be supplied without reducing operational capacity or resilience.',
  },
  {
    heading: 'D. Temporary works',
    body:
      'Identify haul roads, crane and piling platforms, excavation support, propping, hoardings, scaffolds, temporary bridges and cabin foundations. For each, establish design responsibility, loading assumptions, checking, inspection, release for use and removal sequence. HSE expects temporary works to receive the same degree of care as permanent works.',
  },
  {
    heading: 'E. Environmental and emergency arrangements',
    body:
      'Show drainage controls, fuel and chemical storage, waste segregation, washout, spill response, fire access, muster points and task-specific rescue access. Around overhead electrical lines, obtain the asset owner’s input and clearances — do not select a generic clearance from memory; HSE directs consultation with the line owner and prioritises avoidance, diversion or isolation.',
  },
];

const PHASES = [
  ['Initial enabling', 'Safe access, initial welfare, segregation and environmental controls'],
  ['Earthworks / substructure', 'Haul routes, excavations, spoil management and piling areas'],
  ['Main construction', 'Lifting, unloading, laydown and workforce accommodation'],
  ['Fit-out / commissioning', 'Controlled access, protected completed areas and energised-system boundaries'],
  ['Handover / demobilisation', 'Operational access, removal routes and reinstatement'],
];

const COST_CATEGORIES = [
  ['Establishment', 'Access, fencing, platforms, cabins and connections'],
  ['Time-related running costs', 'Hire, security, cleaning, fuel and servicing'],
  ['Production constraints', 'Restricted hours, escorts, small deliveries and limited workfronts'],
  ['Investigations', 'Surveys, trial holes, testing and monitoring'],
  ['Defined risk allowances', 'Unresolved conditions with stated assumptions'],
  ['Demobilisation', 'Disconnections, removal, waste and reinstatement'],
];

const READINESS_CHECKS = [
  'The work area is available and legally accessible.',
  'Relevant permissions and conditions are satisfied.',
  'Information is adequate for that activity.',
  'Design and temporary works arrangements are sufficiently developed.',
  'Services and operational interfaces are controlled.',
  'Access, welfare and emergency arrangements are in place.',
  'Required competent people and equipment are available.',
  'Outstanding risks have named owners and acceptable controls.',
];

const DELIVERABLES = [
  'Site constraints drawing showing boundaries, services, exclusions and interfaces.',
  'Photographic and baseline condition record.',
  'Findings / action register with owners and deadlines.',
  'Survey and investigation schedule addressing specific uncertainties.',
  'Buildability and construction sequence review.',
  'Phased site establishment and logistics drawings.',
  'Temporary works register and design briefs.',
  'Temporary utilities demand and connection plan.',
  'Operational interface and shutdown plan, where applicable.',
  'Updated programme, estimate and mobilisation readiness record.',
];

// --- The principal contractor's delivery-readiness view ---------------------
// The same walk read from the party that has to take control of the site,
// organise the works, manage subcontractors and protect everyone affected —
// so every finding ends in a construction decision, a required piece of
// information, an assigned action, a programme allowance or a commercial
// qualification.

const PC_ASSESSMENTS = [
  ['Permanent works buildability', 'Can we construct the design safely and in a workable sequence?'],
  ['Temporary construction infrastructure', 'What access, platforms, temporary works, utilities, welfare and logistics do we need?'],
  ['Site control and interfaces', 'How will we control subcontractors, neighbouring activities, live operations and the public?'],
];

const PC_VISITS = [
  ['Tender visit', 'Test scope, access, methods, constraints and preliminary allowances', 'Tender queries, assumptions, exclusions and preliminary logistics plan'],
  ['Post-award validation', 'Reconcile the tender assumptions with actual requirements', 'Agreed actions, investigations and revised delivery strategy'],
  ['Pre-mobilisation inspection', 'Check whether establishment and enabling works can proceed', 'Readiness review and release of defined activities'],
  ['Specialist package visits', 'Validate piling, lifting, demolition, utilities and other package methods', 'Package-specific design inputs and interface agreements'],
  ['Before major phase changes', 'Confirm the site remains suitable as workfronts and risks change', 'Revised layout, access and control arrangements'],
];

const PC_SITE_PRIORITIES = [
  ['Greenfield', 'Whether plant can reach and work on the site throughout the planned season', 'Enabling works, road and platform design, drainage, temporary connections and mobilisation sequence'],
  ['Brownfield', 'Whether existing ground, assets and buried infrastructure match the available information', 'Investigation, clearance, remediation, excavation methods, temporary support and disposal strategy'],
  ['Live operational site', 'Whether construction can be separated from operations while maintaining essential services', 'Work boundaries, access, permits, isolations, shutdowns, sequencing and handback'],
];

const PC_INSPECTIONS = [
  ['Possession and boundaries', 'Available land, occupation, shared areas and third-party access', 'Phased possession plan and boundary responsibilities'],
  ['Delivery access', 'Full route, gate, turning, unloading and exit', 'Vehicle strategy, swept-path assessment and delivery controls'],
  ['Working ground', 'Surface condition, slopes, water, chambers and possible voids', 'Investigation and engineered requirements for roads / platforms'],
  ['Services', 'Visible assets, records discrepancies and affected connections', 'Verification, diversion, protection and isolation schedule'],
  ['Existing structures', 'Condition, alterations, structural interfaces and access limitations', 'Structural investigations and construction-stage support requirements'],
  ['Drainage', 'Flow routes, outfalls, flood exposure and receiving systems', 'Temporary drainage and water-management strategy'],
  ['Lifting', 'Delivery position, crane setup, lifting path and exclusion areas', 'Lift feasibility, platform design inputs and erection sequence'],
  ['Workfronts', 'Available space, access and interaction between trades', 'Work zoning, sequence and subcontractor interfaces'],
  ['Welfare and compounds', 'Location, servicing, safe access and future clashes', 'Phased establishment design and capacity schedule'],
  ['Neighbours / public', 'Sensitive receptors, shared routes and existing condition', 'Protection, monitoring and communication arrangements'],
  ['Emergency response', 'Access, escape, rescue constraints and existing arrangements', 'Site-specific emergency and rescue provisions'],
  ['Demobilisation', 'Removal routes and reinstatement requirements', 'Removal sequence, access reservations and cost allowance'],
];

const PC_ESTABLISH_PACKAGE = [
  'Site possession, fencing, hoarding and security.',
  'Access roads, crossings, turning and unloading areas.',
  'Ground preparation and cabin foundations.',
  'Welfare, offices, drying and induction facilities.',
  'Temporary electricity, water, drainage and communications.',
  'Lighting, fire arrangements and emergency access.',
  'Storage, waste, fuel and environmental controls.',
  'Maintenance, changes, demobilisation and reinstatement.',
];

const PC_LAYOUT_TESTS = [
  'Where does each major delivery arrive?',
  'How is it unloaded?',
  'Where is it stored?',
  'How does it reach its installation position?',
  'What plant and people movements does that create?',
  'Which other work must stop while that happens?',
  'Can emergency access remain available?',
];

const PC_LAYOUT_PHASES = [
  ['Enabling works', 'Initial access, welfare, drainage and segregation'],
  ['Groundworks', 'Excavations, spoil, haul roads and piling platforms'],
  ['Structure', 'Crane positions, assembly and material laydown'],
  ['Fit-out', 'Loading areas, internal distribution and completed-area protection'],
  ['Commissioning', 'Energised systems, controlled access and operational interfaces'],
  ['Demobilisation', 'Removal routes and reinstatement'],
];

const PC_AUTHORITY = [
  'Who controls each area.',
  'Who authorises access and work.',
  'Who isolates and verifies existing systems.',
  'Who approves service interruptions.',
  'Who can stop work.',
  'Who accepts the completed installation back into operation.',
];

const PC_UNRESOLVED_QS = [
  'What information or decision is missing?',
  'Who is responsible for providing it?',
  'When is it required to avoid affecting the works?',
  'What happens to cost and programme if it is not resolved?',
];

const PC_CONSTRAINTS = [
  ['Temporary power connection date unconfirmed', 'Obtain confirmed connection programme', 'Assess generation, fuel, maintenance and changeover'],
  ['Ground conditions beneath haul road unknown', 'Investigate and complete design', 'Road construction and heavy deliveries depend on release'],
  ['Existing drain crosses new foundation', 'Verify route and agree diversion / protection', 'Foundation sequence may change'],
  ['Operational shutdown not approved', 'Agree window and acceptance criteria', 'Tie-in date remains conditional'],
];

const PC_READINESS = [
  'Adequate site information and suitable designs.',
  'Available work areas and controlled interfaces.',
  'Safe access, welfare and emergency arrangements.',
  'Suitable temporary works and plant arrangements.',
  'Competent supervision and subcontractor coordination.',
  'Necessary permissions and operational approvals.',
  'An appropriate construction phase plan.',
];

function list(items) {
  return items.length === 0 ? '' : html`<ul style="margin:6px 0 0;padding-left:18px">${items.map((item) => html`<li style="margin:3px 0">${item}</li>`)}</ul>`;
}

function greenfieldBlock(block) {
  return html`<div style="padding:10px 0;border-top:1px solid var(--line)">
    <b>${block.heading}</b>
    <div class="metric-sub" style="margin-top:4px">${block.lead}</div>
    ${list(block.checks)}
    <div class="metric-sub" style="margin-top:6px"><b>Record.</b> ${block.record}</div>
    <div class="metric-sub" style="margin-top:3px"><b>Design consequence.</b> ${block.consequence}</div>
  </div>`;
}

/**
 * The guidance card. Static — takes no project state, because the method is the
 * same whether or not a visit has been recorded yet, and is most useful before
 * the first one.
 */
export function siteVisitGuide() {
  return html`
    <div class="card" style="margin-bottom:14px">
      <div class="metric-sub" style="margin-bottom:10px">
        Two readings of the same walk — the project-wide method, and the principal contractor’s delivery-readiness
        checklist. Open whichever fits the job in front of you.
      </div>
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:15px">
          Pre-construction site visit — how to make the walk count
        </summary>

        <div style="margin-top:10px">
          <div class="notice">
            <div>
              A pre-construction site visit establishes <b>whether the project can be built, how it will be built, and what
              must be resolved before people, plant and materials arrive.</b> Its value is in changing decisions — foundation
              design, access, sequence, temporary works, site establishment, price and programme. The question to hold
              throughout: <i>what could prevent us delivering the works safely, in the intended sequence, at the planned
              production rate — and what evidence do we need to resolve it?</i>
            </div>
          </div>
          <div class="metric-sub" style="margin-top:8px">
            A Great Britain construction framework. The engineering applies more widely; the statutory and environmental
            points are England-specific and need local verification. Everything below is method — fill the register above
            with what <i>this</i> site actually shows.
          </div>

          <h3 style="margin-top:16px">1. Three kinds of site, three different problems</h3>
          <div class="metric-sub">A live operational site is often also brownfield; the categories overlap. The distinction that matters is the constraint each introduces. Years of operation do not prove a structure or service can take new loads or interruptions — and a greenfield appearance does not prove clean ground or the absence of buried infrastructure.</div>
          ${table({ headers: ['Site type', 'Principal challenge', 'Dangerous assumption', 'Main purpose of the visit'], rows: SITE_TYPES })}

          <h3 style="margin-top:16px">2. Do the desk study before the walkover</h3>
          <div class="metric-sub">Walking on without reviewing the information produces observations without context. Request the following, recording each document’s revision, coverage and limitations — and put unverified drawings in an “information to confirm” category so an old drawing does not silently become a construction assumption.</div>
          ${table({ headers: ['Information', 'What it helps establish'], rows: DESK_STUDY })}
          <div class="metric-sub" style="margin-top:8px"><b>Before visiting, issue the decisions the visit must support:</b></div>
          ${list(PRE_VISIT_DECISIONS)}

          <h3 style="margin-top:16px">3. Organise the visit around the right people and conditions</h3>
          <div class="metric-sub">For a substantial project: construction lead, civil/structural designer, surveyor and client representative, adding ground, environmental, logistics and temporary-works specialists by risk. For an operational site, add facilities/maintenance staff, the operations manager and whoever is responsible for isolations or permits — they know the undocumented modifications, the recurrent flooding and the services that cannot be interrupted.</div>
          <div class="metric-sub" style="margin-top:8px"><b>Structure the visit in four parts:</b></div>
          ${list([
            'Opening briefing: scope, site rules, known hazards, access restrictions and decisions required.',
            'External approach and perimeter: delivery route, neighbours, boundaries, drainage and emergency access.',
            'Systematic internal walkover: ground, assets, services, working areas and operational interfaces.',
            'Close-out meeting: findings, uncertainties, required investigations, owners and deadlines.',
          ])}
          <div class="metric-sub" style="margin-top:8px">Visit during the conditions that reveal the problem — delivery peak, shift change, production — and revisit after rainfall or in darkness where drainage or lighting justify it. A walkover is not uncontrolled intrusive investigation: opening chambers, entering confined spaces, disturbing materials and exposing services need their own arrangements.</div>

          <h3 style="margin-top:16px">4. Inspecting a greenfield site</h3>
          ${GREENFIELD.map(greenfieldBlock)}

          <details style="margin-top:12px">
            <summary style="cursor:pointer;font-weight:600">5. Inspecting a brownfield site</summary>
            <div class="metric-sub" style="margin-top:8px">The central question: what remains from previous uses, and how will it affect the proposed works? Do not assume “redundant” means isolated — a cable serving a demolished building may still be live upstream, a drain beneath a cleared plot may serve another property. HSE warns that utility plans indicate locations rather than prove exact positions. For contamination, work <b>source → pathway → receptor</b> (e.g. contaminated soil → dust → workers); the Environment Agency’s LCRM starts with desk study and walkover, then lets the findings drive investigation. Check that any asbestos information covers the actual intrusive work area — a management survey assumes normal occupation, so refurbishment or demolition may need destructive investigation, and inaccessible areas remain unresolved. Examine the sequence too: removing a slab, wall or frame may remove support a retained element still needs.</div>
            ${table({ headers: ['Inspect', 'Look for', 'Required follow-up'], rows: BROWNFIELD })}
          </details>

          <details style="margin-top:12px">
            <summary style="cursor:pointer;font-weight:600">6. Inspecting a live operational site</summary>
            <div class="metric-sub" style="margin-top:8px">Understand what the existing operation depends on — including dependencies outside the construction boundary. Excavating outside a facility can still cut a fibre controlling equipment inside it.</div>
            <div style="padding:10px 0;border-top:1px solid var(--line)">
              <b>A. Trace critical systems</b>
              <div class="metric-sub" style="margin-top:4px">For each affected system (electricity, water, drainage, fire, communications, controls, ventilation, process), establish:</div>
              ${list(LIVE_SYSTEMS)}
            </div>
            <div style="padding:10px 0;border-top:1px solid var(--line)">
              <b>B. Observe the operation</b>
              <div class="metric-sub" style="margin-top:4px">Walk the routes used by — and the servicing space and emergency access that must stay available. An apparently unused yard may be the only place for an emergency generator or maintenance crane.</div>
              ${list(LIVE_ROUTES)}
            </div>
            <div style="padding:10px 0;border-top:1px solid var(--line)">
              <b>C. Agree a construction–operations interface plan</b>
              <div class="metric-sub" style="margin:4px 0 6px">Each interface needs a decision before the affected work. A permit identifies the task, location, validity and precautions — it supports the risk assessment, it does not replace it.</div>
              ${table({ headers: ['Interface', 'Decision required before the affected work'], rows: LIVE_INTERFACE })}
            </div>
            <div style="padding:10px 0;border-top:1px solid var(--line)">
              <b>D. Plan the tie-in and the rollback together</b>
              <div class="metric-sub" style="margin-top:4px">For a connection to an existing system, require:</div>
              ${list(LIVE_TIEIN)}
              <div class="metric-sub" style="margin-top:6px">A six-hour shutdown is not six hours of installation — isolation, verification, testing and restoration all consume part of the window.</div>
            </div>
          </details>

          <h3 style="margin-top:16px">7. What to record — and how to make it useful</h3>
          <div class="metric-sub">A folder of photographs is evidence, not a managed assessment. Each observation should carry:</div>
          ${table({ headers: ['Field', 'Example'], rows: RECORD_FIELDS })}
          <div class="metric-sub" style="margin-top:8px"><b>Mark the information status of every line</b> — this is the discipline behind the “How it is known” basis recorded against every site finding:</div>
          ${table({ headers: ['Status', 'Means'], rows: INFO_STATUS })}
          <div class="metric-sub" style="margin-top:8px">For photographs, record location, direction, date and subject; take an overview, a context view and detail, and link them to the marked-up plan. Obtain a baseline condition record of roads, boundaries, neighbouring assets and retained structures where damage could later be disputed, and record inaccessible areas explicitly.</div>
          <div class="notice" style="margin-top:8px">
            <div>
              A useful finding: <i>“Ponding observed along the proposed compound’s western edge. Cause and seasonal extent
              unknown. Civil designer to assess drainage and platform levels before compound design release.”</i>
              — “Site wet, allow drainage” is too vague to design, programme or price.
            </div>
          </div>

          <h3 style="margin-top:16px">8. Turn findings into a targeted survey programme</h3>
          <div class="metric-sub">Commission investigations to answer decisions, not to buy a standard package. Every scope should state coverage, accuracy, deliverables, exclusions and intended use — a survey that excludes the access or compound can leave the mobilisation design unresolved.</div>
          ${table({ headers: ['Investigation', 'Decision it should support'], rows: SURVEYS })}

          <h3 style="margin-top:16px">9. Design the construction site as an engineered system</h3>
          <div class="metric-sub">The layout follows the construction method and programme — drawing cabins into a convenient corner is not site establishment. Start from:</div>
          ${list(ESTABLISH_INPUTS)}
          ${ESTABLISH.map(
            (block) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
              <b>${block.heading}</b>
              <div class="metric-sub" style="margin-top:4px">${block.body}</div>
            </div>`,
          )}

          <h3 style="margin-top:16px">10. Produce layouts for the changing phases</h3>
          <div class="metric-sub">One layout rarely serves a significant project throughout. Check every temporary installation against future works — a compound over a future drainage corridor may create an avoidable second mobilisation — and verify the crane used to install the cabins can return to remove them once the permanent works are complete.</div>
          ${table({ headers: ['Phase', 'Main layout requirement'], rows: PHASES })}

          <h3 style="margin-top:16px">11. Build the programme and estimate from the constraints</h3>
          <div class="metric-sub">The programme should carry investigations, approvals and enabling works as real activities with dependencies — not as assumptions sitting behind the bars.</div>
          <div class="notice" style="margin-top:8px"><div><b>A typical dependency chain:</b><br>Ground investigation → interpretation → platform design → procurement → construction → inspection/release → crane mobilisation.</div></div>
          <div class="notice" style="margin-top:8px"><div><b>And on a live site:</b><br>Existing-system verification → tie-in design → operational approval → outage booking → readiness review → isolation → installation → testing → handback.</div></div>
          <div class="metric-sub" style="margin-top:10px">The estimate should keep these cost categories distinct rather than burying them in rates:</div>
          ${table({ headers: ['Cost category', 'Examples'], rows: COST_CATEGORIES })}
          <div class="metric-sub" style="margin-top:8px">Link every uncertainty to a specific assumption and a named owner. “Ground risk included” is not a commercial position — state the ground model assumed, what remains unknown, and how the contract allocates the risk.</div>

          <h3 style="margin-top:16px">12. Use readiness gates before releasing work</h3>
          <div class="metric-sub">Release enabling works, main construction and high-risk operational interfaces separately. Before releasing an activity, confirm:</div>
          ${list(READINESS_CHECKS)}
          <div class="metric-sub" style="margin-top:8px">Under CDM, the construction phase plan must be prepared before construction begins, and must reflect the project’s actual risks and arrangements rather than reproduce a generic company document.</div>

          <h3 style="margin-top:16px">13. What the completed assessment should deliver</h3>
          <div class="metric-sub">For a substantial project, the visit and its follow-up investigations should produce:</div>
          ${raw(`<ol style="margin:6px 0 0;padding-left:20px">${DELIVERABLES.map((item) => `<li style="margin:3px 0">${item}</li>`).join('')}</ol>`)}
          <div class="notice" style="margin-top:10px">
            <div>
              <b>For ETABLIX’s site-services scope this is where the value lands.</b> It converts a client’s request for
              cabins, roads and utilities into a defined, phased operating requirement — with the quantities, capacities,
              responsibilities and removal obligations that can actually be priced and delivered.
            </div>
          </div>
        </div>
      </details>

      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-weight:600;font-size:15px">
          As principal contractor — the delivery-readiness view
        </summary>

        <div style="margin-top:10px">
          <div class="notice">
            <div>
              For a principal contractor the visit is a <b>delivery-readiness assessment</b>: how you will take control of
              the site, organise the works, manage subcontractors and protect everyone affected. Every finding should lead
              to a construction decision, required information, an assigned action, a programme allowance or a commercial
              qualification. The question becomes: <i>can we deliver the proposed design using our intended methods, within
              the available land, access, time and operational restrictions — and what must be resolved before we start?</i>
            </div>
          </div>

          <h3 style="margin-top:16px">1. Define what you are assessing</h3>
          <div class="metric-sub">Three connected things. The client and design team must supply the information, but you must identify the gaps that affect your delivery plan and pursue them — a site visit transfers no unknown condition to you, and missing information never justifies an unsafe assumption. Where more than one contractor is involved, HSE puts planning, managing, monitoring and coordinating health and safety during construction on the principal contractor.</div>
          ${table({ headers: ['Assessment', 'Principal contractor’s question'], rows: PC_ASSESSMENTS })}

          <h3 style="margin-top:16px">2. Visit while decisions can still change</h3>
          <div class="metric-sub">Recommended delivery stages, not a prescribed statutory number. Attending the tender visit is not proof that every condition was discoverable — record what you could inspect, what was inaccessible and what information was unavailable.</div>
          ${table({ headers: ['Visit', 'Purpose', 'Required output'], rows: PC_VISITS })}

          <h3 style="margin-top:16px">3. Priorities differ by site</h3>
          ${table({ headers: ['Site', 'What you must establish', 'What it changes in your delivery plan'], rows: PC_SITE_PRIORITIES })}

          <h3 style="margin-top:16px">4. What the site team inspects — and must decide</h3>
          <div class="metric-sub">For underground services, drawings alone are insufficient — HSE combines planning, locating and identifying services with safe excavation.</div>
          ${table({ headers: ['Inspection area', 'Check on the ground', 'Principal contractor’s decision / output'], rows: PC_INSPECTIONS })}

          <h3 style="margin-top:16px">5. Treat site setup as a construction package</h3>
          <div class="metric-sub">Manage establishment with the same discipline as foundations or steelwork — scope, design inputs, responsibilities, procurement, inspections, programme and acceptance criteria. The package should cover:</div>
          ${list(PC_ESTABLISH_PACKAGE)}
          <div class="metric-sub" style="margin-top:6px">The first workers installing the compound need welfare and safe arrangements too. Plan the initial establishment stage explicitly — do not assume the finished compound solves conditions during its own installation. Welfare is required from the start of construction.</div>

          <h3 style="margin-top:16px">6. Design the layout around production</h3>
          <div class="metric-sub">Before approving a compound or logistics layout, test it against the actual construction sequence:</div>
          ${list(PC_LAYOUT_TESTS)}
          <div class="metric-sub" style="margin-top:6px">Steel laydown beside the entrance may look convenient yet force repeated transport across excavations to reach the crane; a different location or delivery sequence can remove the handling entirely. Approve phase-specific layouts showing at least:</div>
          ${table({ headers: ['Phase', 'Critical layout consideration'], rows: PC_LAYOUT_PHASES })}

          <h3 style="margin-top:16px">7. On a live site, agree authority before dates</h3>
          <div class="metric-sub">The principal contractor needs a clear agreement with the operator covering:</div>
          ${list(PC_AUTHORITY)}
          <div class="metric-sub" style="margin-top:6px">The construction boundary does not contain the consequences of the work — dust, vibration, drainage changes, fire-system impairments and service interruptions reach the wider facility. Before a shutdown, hold a readiness review covering design, materials, personnel, isolation, installation, testing, restoration and rollback. A permit supports those arrangements; it does not replace the risk assessment.</div>

          <h3 style="margin-top:16px">8. Record findings so they can control delivery</h3>
          <div class="notice"><div>Reference → location → evidence → uncertainty → consequence → action → owner → deadline → closure evidence.</div></div>
          <div class="notice" style="margin-top:8px">
            <div>
              <i>LOG-014: Proposed crane standing area includes an existing underground chamber. Chamber construction and
              load capacity unknown. Current crane arrangement cannot be released. Temporary works lead to coordinate
              investigation and revised platform design before crane mobilisation.</i>
            </div>
          </div>
          <div class="metric-sub" style="margin-top:8px">That entry drives design, procurement and programme decisions; “check crane area” cannot. Keep observed conditions, reported information and verified facts distinct, record drawing revisions, and name inspection limitations.</div>

          <h3 style="margin-top:16px">9. Turn unresolved issues into programme and commercial items</h3>
          <div class="metric-sub">Each unresolved constraint needs an answer to four questions:</div>
          ${raw(`<ol style="margin:6px 0 0;padding-left:20px">${PC_UNRESOLVED_QS.map((item) => `<li style="margin:3px 0">${item}</li>`).join('')}</ol>`)}
          ${table({ headers: ['Constraint', 'Required action', 'Delivery implication'], rows: PC_CONSTRAINTS })}
          <div class="metric-sub" style="margin-top:8px">Allocate contractual responsibility using the actual contract — do not assume every survey, diversion or unforeseen condition automatically belongs to either party.</div>

          <h3 style="margin-top:16px">10. The decision before mobilisation</h3>
          <div class="metric-sub">Require a documented readiness review confirming that the specific activities being released have:</div>
          ${list(PC_READINESS)}
          <div class="metric-sub" style="margin-top:6px">HSE requires the construction phase plan before construction begins, and temporary works need the same care as permanent works. The report should end with a decision: <b>what can proceed, what remains restricted, and what evidence is needed to release the next activity.</b></div>
        </div>
      </details>
    </div>
  `;
}
