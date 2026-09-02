import type { CDMDocumentType, DocumentSection } from '../domain/cdm.ts';

/**
 * The CDM duty set for the demonstration project, written out.
 *
 * ## Why this file exists at all
 *
 * The platform declares sixteen CDM document types with their approvers, the
 * sections each must contain and whether it gates construction. Fifteen of
 * those had no record behind them, which made the duty set on the Construction
 * screen a list of things that did not exist — and made the document catalogue
 * report "waiting on a record" for eight of the fifteen site documents.
 *
 * Drafting them empty would have been worse than leaving them absent.
 * `draftDocument` fills what project state can truthfully answer and reports the
 * rest as gaps; `approveDocument` refuses while any gap remains; and
 * `principalContractorPosition` reports an unfilled section as a **named
 * breach**. Fifteen skeleton documents would therefore have produced ninety-three
 * breaches on a project whose paperwork was supposed to be in order — an
 * accurate report of a demonstration that had been set up badly.
 *
 * So every section a record cannot answer is written here, and each is specific
 * to this site: the historic culvert of unknown location, the live plant
 * interface, the inlet chamber, the clarifier base. That specificity is the
 * point. A COSHH assessment that says "wear appropriate PPE" is the thing this
 * platform exists to stop being produced, and one seeded into the demonstration
 * would be teaching exactly that.
 *
 * ## What this is not
 *
 * It is not a template library and must not become one. These are the fixtures
 * of one project, held apart from `seed.ts` because ninety-three paragraphs
 * inside the seed would bury the sequence the seed is actually there to
 * demonstrate. A customer's own documents are drafted through the same command
 * against their own state; nothing here is offered to them.
 */

/** Sections a record cannot answer, by document type. */
export const DUTY_SECTIONS: Partial<Record<CDMDocumentType, DocumentSection[]>> = {
  COSHH_ASSESSMENT: [
    {
      heading: 'Substance and supplier',
      body:
        'Sika Rugasol C surface retarder, supplied by Sika Ltd, used on the clarifier base construction joints. Safety data ' +
        'sheet revision 4.2 dated 12 March 2026 held on site and in the project record.',
    },
    {
      heading: 'Hazard classification',
      body:
        'Skin irritant category 2 and serious eye damage category 1 under CLP. Not classified as flammable, not a carcinogen, ' +
        'and no workplace exposure limit is assigned to any component.',
    },
    {
      heading: 'Exposure routes and duration',
      body:
        'Skin and eye contact during application by brush and roller, typically two operatives for ninety minutes per pour ' +
        'face, at most three times a week. No spraying, so inhalation of mist is not an exposure route on this site. Contact ' +
        'with the retarded surface during formwork strike is the second exposure and is brief.',
    },
    {
      heading: 'Control measures',
      body:
        'Applied in the open air on the laydown area, never in the inlet chamber or any other confined space. Decanted into ' +
        'a lidded application pot rather than worked from the drum. Drums kept on the bunded pallet in the container store ' +
        'and returned to it at the end of every shift. Substitution was considered: no non-irritant retarder achieves the ' +
        'exposed aggregate finish the specification calls for at E10 clause 3.3.',
    },
    {
      heading: 'Personal protective equipment',
      body:
        'Nitrile gauntlets to EN 374 (not the standard site glove, which is permeable to this product), close-fitting goggles ' +
        'to EN 166, and coveralls. Gloves are single-shift and binned, not reused. PPE is the last control here and not the ' +
        'first: the application method above is what does most of the work.',
    },
    {
      heading: 'First aid and spillage response',
      body:
        'Skin contact: wash with soap and water for fifteen minutes. Eye contact: irrigate at the eyewash station in the ' +
        'welfare unit for fifteen minutes and attend Calderdale Royal Hospital — do not wait to see whether it settles. ' +
        'Spillage: contain with the absorbent granules held beside the bunded pallet, bag as hazardous waste, and never wash ' +
        'to the surface water drain, which discharges to the Ashworth brook.',
    },
    {
      heading: 'Health surveillance',
      body:
        'No health surveillance is required for this substance at this exposure. Skin condition is asked about at induction ' +
        'and any dermatitis reported to the site manager is referred to occupational health, which is the trigger for ' +
        'reassessing this document rather than for a surveillance programme.',
    },
  ],

  TEMPORARY_WORKS_DESIGN_BRIEF: [
    {
      heading: 'Design brief and loadings',
      body:
        'Trench support to the clarifier base excavation, benched to formation at 4.2m below existing ground level in ' +
        'zone 2. Design loadings: soil surcharge from the spoil heap set back 3m from the crest, 20kN/m² plant surcharge for ' +
        'the 30t excavator working from the bench, and groundwater at 2.8m recorded in the ground investigation.',
    },
    {
      heading: 'Temporary works coordinator',
      body:
        'The site manager holds the temporary works coordinator role on this project and is named in the Construction Phase ' +
        'Plan. No temporary works are loaded without a permit to load signed by that person; the role is not delegated to ' +
        'the gang carrying out the erection.',
    },
    {
      heading: 'Design check category',
      body:
        'Category 2 under BS 5975. Independent check by an engineer not involved in the design, within the same ' +
        'organisation. Category 3 was considered and rejected: the support is a proprietary system used within its published ' +
        'range, not a bespoke design.',
    },
    {
      heading: 'Erection and dismantling sequence',
      body:
        'Erected top-down from outside the excavation, no operative entering an unsupported face at any point. Dismantled ' +
        'bottom-up in reverse only after the base slab has reached the striking strength recorded on the cube results, and ' +
        'never while the excavation is open below the last remaining frame.',
    },
    {
      heading: 'Inspection regime',
      body:
        'Inspected by a competent person before first use, at the start of every shift, after any event likely to have ' +
        'affected stability, and at least every seven days. Recorded on the platform against the excavation, not on a sheet ' +
        'in the site office.',
    },
    {
      heading: 'Permit to load and permit to strike',
      body:
        'No load is applied until the temporary works coordinator has signed the permit to load against the completed ' +
        'independent check. Nothing is struck until the permit to strike is signed against the cube results. Both permits ' +
        'name the person, not the organisation.',
    },
  ],

  LIFTING_PLAN: [
    {
      heading: 'Load and lifting equipment',
      body:
        'Reinforcement cages for the clarifier base, heaviest 4.1t, lifted by the 45t crawler crane on tracked mats. ' +
        'Two-leg chain sling, 8t working load limit at the slinging angle used, with certificates held against the equipment ' +
        'register.',
    },
    {
      heading: 'Appointed person',
      body:
        'The site manager is the appointed person for lifting operations under LOLER and BS 7121, and plans each lift ' +
        'before it is scheduled rather than at the point of lifting. The crane supervisor and the slinger-signaller are ' +
        'named on the lift record for each lift.',
    },
    {
      heading: 'Ground conditions and outrigger loads',
      body:
        'Crane standing on the compacted haul road, bearing capacity confirmed at 150kN/m² by plate test on 3 August 2026. ' +
        'Track loads spread through timber mats. The crane does not stand within 3m of the excavation crest at any point in ' +
        'the sequence — the standing positions are marked on the logistics plan for that reason.',
    },
    {
      heading: 'Exclusion zones',
      body:
        'Barriered exclusion zone at the full working radius, cleared and confirmed by the slinger before every lift. No ' +
        'lift passes over the welfare compound, the pedestrian route or the live plant boundary. Where a load must travel ' +
        'toward the boundary the crane slews away and re-approaches rather than crossing it.',
    },
    {
      heading: 'Slinging arrangement',
      body:
        'Cages lifted on four points at the marked lifting eyes, spreader beam where the cage exceeds 6m, and tag lines on ' +
        'every lift. No lift from the reinforcement bundles as delivered; cages are made up on the laydown area first.',
    },
    {
      heading: 'Weather limits',
      body:
        'Lifting stops at a mean wind speed of 20mph at the jib head, measured at the crane rather than forecast for the ' +
        'district, and immediately in lightning or where visibility falls below the working radius. The stop is the crane ' +
        'supervisor’s call alone and is not overruled by programme pressure.',
    },
    {
      heading: 'Communication and signalling',
      body:
        'Dedicated radio channel between crane operator and slinger-signaller, with hand signals to BS 7121 as the fallback ' +
        'if radio contact is lost. Loss of communication stops the lift and the load is set down at the nearest safe ' +
        'position, not held.',
    },
  ],

  WORKING_AT_HEIGHT_PLAN: [
    {
      heading: 'Hierarchy of control applied',
      body:
        'Avoided first: the inlet chamber access frame is assembled at ground level on the laydown area and lifted in as one ' +
        'piece, which removes most of the work at height that the original sequence carried. Where height cannot be avoided ' +
        'the work is from a MEWP, and fall arrest is the last resort rather than the plan.',
    },
    {
      heading: 'Access and egress',
      body:
        'Scaffold access towers to the clarifier walls with double guardrail and toeboard, handed over on a Scafftag and ' +
        'not used before it is green. MEWP access to the chamber roof frame. No ladders for anything but access, and none ' +
        'over 3m.',
    },
    {
      heading: 'Edge protection',
      body:
        'Double guardrail and toeboard to every open edge above 2m, including the excavation crest where the ground falls ' +
        'away on the north side. Covers to every penetration in the base slab, fixed and marked, and never removed without ' +
        'the site manager knowing.',
    },
    {
      heading: 'Fall arrest and rescue plan',
      body:
        'Harness and twin lanyard in the MEWP, anchored to the designated point in the basket. A recovery plan exists ' +
        'before anybody goes up: the second MEWP is kept available on site whenever the first is in use, because suspension ' +
        'trauma is measured in minutes and calling the fire service is not a rescue plan.',
    },
    {
      heading: 'Inspection regime',
      body:
        'Scaffold inspected before first use, every seven days, and after anything likely to have affected it. MEWPs ' +
        'inspected daily by the operator and thoroughly examined every six months, with the certificate on the equipment ' +
        'register. Harnesses inspected before every use and formally every six months.',
    },
    {
      heading: 'Competence of operatives',
      body:
        'IPAF 3a and 3b for MEWP operators, PASMA for anybody erecting a mobile tower, and a current harness and rescue ' +
        'ticket for work in the basket. Checked and recorded at induction against the person, and re-checked against the ' +
        'expiry date rather than against the day the permit is issued.',
    },
  ],

  FIRE_SAFETY_PLAN: [
    {
      heading: 'Fire risk assessment',
      body:
        'The significant sources are hot work on the inlet chamber access frame, the fuel bowser on the compound, and the ' +
        'timber formwork stack on the laydown area. The site is otherwise a concrete and steel structure in the open air ' +
        'with a low fire load. The fuel bowser is bunded and sited 15m from the welfare unit for this reason.',
    },
    {
      heading: 'Hot works permit regime',
      body:
        'No hot work without a permit issued against an approved method statement. Combustibles cleared to 10m or ' +
        'protected with fire blankets, extinguisher at the workface, and a one-hour fire watch after the work finishes — the ' +
        'fire watch is the control most often dropped and it is the one that matters, because ignition is usually found ' +
        'after everybody has gone home. No hot work in the final hour of the shift.',
    },
    {
      heading: 'Means of escape and signage',
      body:
        'Two routes off site at all times: the main gate G1 and the emergency egress G2 to the north lane, both signed and ' +
        'both kept clear — G2 is not a storage area and is checked on the closing walk. Routes are lit during the winter ' +
        'programme.',
    },
    {
      heading: 'Fire points and extinguishers',
      body:
        'Fire points at the welfare unit, the site office, the container store and the fuel bowser, each with water and CO2 ' +
        'and a break-glass call point. Additional powder extinguisher carried to every hot work location as part of the ' +
        'permit. Inspected monthly and serviced annually.',
    },
    {
      heading: 'Alarm and detection',
      body:
        'Manual break-glass call points sounding a continuous alarm across the site, tested weekly at a published time so ' +
        'that an untested alarm is noticed. Automatic detection in the site office and welfare unit only; the open site ' +
        'relies on people, which is why the alarm test is not allowed to lapse.',
    },
    {
      heading: 'Assembly points',
      body:
        'Primary assembly point at the main gate G1, outside the working area and clear of the crane radius. Secondary ' +
        'assembly on the north lane beyond G2 for use when the incident is at or near the compound.',
    },
    {
      heading: 'Fire marshals',
      body:
        'Two trained fire marshals on site at all times, named on the notice board and re-named when either is on leave. ' +
        'They sweep the welfare unit and the office, take the roll call against the induction register, and report to the ' +
        'site manager at the assembly point.',
    },
  ],

  EMERGENCY_ARRANGEMENTS: [
    {
      heading: 'Emergency scenarios',
      body:
        'Planned for: excavation collapse or a person trapped below ground; a strike on a buried service, particularly the ' +
        'culvert of unknown construction across zone 3; fire; a fall from height in the MEWP; and a release to the Ashworth ' +
        'brook. Each has a named first action rather than a general instruction to raise the alarm.',
    },
    {
      heading: 'Raising the alarm',
      body:
        'Break-glass call point or radio to the site office, which holds the single point of contact with the emergency ' +
        'services. One caller, so the services receive one consistent account of what has happened and where.',
    },
    {
      heading: 'Assembly and roll call',
      body:
        'Assembly at G1, roll call taken against the induction register and the daily signing-in sheet together — the ' +
        'register alone would miss a visitor and the sheet alone would miss anybody who signed in on somebody else’s ' +
        'behalf. Nobody re-enters until the site manager says so.',
    },
    {
      heading: 'First aid provision',
      body:
        'Two first aiders on site at all times, named on the notice board. First aid room in the welfare unit, eyewash ' +
        'station at the entrance to it and a second beside the retarder store. Defibrillator in the site office, checked ' +
        'monthly.',
    },
    {
      heading: 'Emergency services access',
      body:
        'Emergency vehicles enter through G1, which is 4.5m wide with 4.8m headroom and takes an appliance. G2 is the ' +
        'alternative if G1 is the incident. The haul road is kept clear of stored material for this reason and it is on the ' +
        'closing walk.',
    },
    {
      heading: 'Nearest A&E and rescue arrangements',
      body:
        'Calderdale Royal Hospital, eleven minutes by road. West Yorkshire Fire and Rescue attend confined space and ' +
        'trapped-person incidents; they have been notified of the deep excavation and the chamber works. Site rescue from ' +
        'the inlet chamber is by the standby team with tripod and winch — the emergency services cannot effect a chamber ' +
        'rescue inside the exposure window, so waiting for them is not the plan.',
    },
    {
      heading: 'Out-of-hours contacts',
      body:
        'Site manager and project manager, both on the notice board and both answering out of hours. The water undertaker ' +
        'has a twenty-four-hour control room number for anything touching the live plant, and that number is on the same ' +
        'board rather than in somebody’s phone.',
    },
  ],

  ENVIRONMENTAL_CONTROL_PLAN: [
    {
      heading: 'Consents and permits',
      body:
        'Discharge consent variation applied for and outstanding — the risk register carries it, and no dewatering ' +
        'discharge is made to the brook until it is granted. Section 61 prior consent for the working hours agreed with the ' +
        'local authority. Waste carrier registration held for every haulier on the gate list.',
    },
    {
      heading: 'Dust and air quality',
      body:
        'Damping down on the haul road and at the crusher, wheel wash on the exit leg of G1, and sheeted loads leaving ' +
        'site. Visual monitoring at the boundary each shift and a dust deposit gauge at the nearest residential receptor. ' +
        'Cutting is wet-cut or on-tool extracted, which is a health control as much as an environmental one.',
    },
    {
      heading: 'Noise and vibration limits',
      body:
        'Working hours 07:30 to 18:00 Monday to Friday and 08:00 to 13:00 Saturday, per the section 61 consent. No ' +
        'percussive breaking before 08:00. Vibration monitored at the nearest structure during any breaking within 15m of ' +
        'the live plant, against a limit of 5mm/s peak particle velocity.',
    },
    {
      heading: 'Water and pollution prevention',
      body:
        'The site drains to the Ashworth brook, which is why nothing is washed to a surface water drain anywhere on this ' +
        'site. Silt-laden water from the excavation is settled and treated before any consented discharge. Concrete washout ' +
        'in the lined washout pit only, never on the ground.',
    },
    {
      heading: 'Waste and duty of care',
      body:
        'Segregated skips for inert, timber, metal and general waste, with hazardous waste stored separately on the bunded ' +
        'pallet. Waste transfer notes held for every movement and reconciled monthly against the skip register — a duty of ' +
        'care breach is usually a missing note rather than a wrong destination.',
    },
    {
      heading: 'Ecology and protected species',
      body:
        'A pre-commencement ecology survey found no bat roosts and no badger setts within the working area. The brook ' +
        'corridor is fenced as an exclusion zone and is not a storage area. Vegetation clearance outside the bird nesting ' +
        'season, or under a checking survey immediately before if it cannot be.',
    },
    {
      heading: 'Spill response',
      body:
        'Spill kits at the fuel bowser, the plant parking area and the container store, and their locations are covered at ' +
        'induction rather than assumed. Any spill reaching or threatening the brook is reported to the Environment Agency ' +
        'incident hotline the same day, by the site manager, whether or not it has been contained.',
    },
  ],

  TRAFFIC_MANAGEMENT_PLAN: [
    {
      heading: 'Vehicle and pedestrian segregation',
      body:
        'A physically segregated pedestrian route runs from the car park to the welfare unit and the site office without ' +
        'crossing a haul road — this is why the welfare unit sits where it does on the logistics plan. Where a crossing is ' +
        'unavoidable at the laydown area it is a marked, barriered crossing point with priority to the pedestrian.',
    },
    {
      heading: 'Site access and egress points',
      body:
        'G1 on Ashworth Road is the only delivery entrance, banksman controlled during working hours, with the wheel wash ' +
        'on the exit leg. G2 to the north lane is emergency egress only and is kept clear at all times.',
    },
    {
      heading: 'Internal haul routes and one-way system',
      body:
        'One-way from G1 along the haul road to the laydown area, then round the compound and back to G1 — no reversing on ' +
        'the main circuit at all, which is the single most effective control available on a site of this size. The haul ' +
        'road is 5.5m wide and takes the 44t articulated flatbed the reinforcement arrives on.',
    },
    {
      heading: 'Speed limits and enforcement',
      body:
        '5mph across the whole site, signed at both gates and at the compound. Enforced by the site manager, and a second ' +
        'breach removes the driver from the gate list rather than producing another warning.',
    },
    {
      heading: 'Reversing, banksman and marshalling arrangements',
      body:
        'Reversing only within the marked laydown area and only under a trained banksman in a distinct hi-vis colour, in ' +
        'radio contact with the driver. The banksman never stands between the vehicle and a fixed object. Reversing alarms ' +
        'and cameras on every vehicle on the gate list.',
    },
    {
      heading: 'Delivery booking and holding areas',
      body:
        'All deliveries booked through the site office to a slot. No deliveries between 08:15 and 08:45 because the school ' +
        'route passes the gate. A two-vehicle holding area inside the gate line means nothing waits on Ashworth Road.',
    },
    {
      heading: 'Public highway interface and permissions',
      body:
        'Section 50 street works licence granted for the Bacup Road connection after a fourteen-day wait — the constraint ' +
        'that held the works and the reason the licence is applied for early on the next phase. Highway kept clean by road ' +
        'sweeper on call, and the wheel wash is not treated as sufficient on its own.',
    },
    {
      heading: 'Signage, barriers and lighting',
      body:
        'Chapter 8 signage at both gates, speed and pedestrian signage at every decision point, and heras fencing to the ' +
        'segregated route. Haul road and pedestrian route lit through the winter programme, because the segregation is only ' +
        'a control while people can see it.',
    },
    {
      heading: 'Emergency vehicle access',
      body:
        'G1 takes a fire appliance at 4.5m wide and 4.8m headroom, with G2 as the alternative. The haul road is kept clear ' +
        'of stored material at all times and this is checked on the closing walk rather than assumed.',
    },
  ],

  SITE_LOGISTICS_PLAN: [
    {
      heading: 'Site setup and compound layout',
      body:
        'Compound at the north end: site office, 40-person welfare unit, drying room and secure container store, all inside ' +
        'the segregated pedestrian route and clear of the crane working radius. Hoarded perimeter to the full boundary with ' +
        'the two controlled gates.',
    },
    {
      heading: 'Material storage and laydown areas',
      body:
        'Hard-standing laydown for reinforcement and formwork adjacent to the haul road, so no material is double-handled ' +
        'across the working area. Cement and admixtures in the container store. Nothing stored within 3m of the excavation ' +
        'crest — the surcharge is a design assumption in the temporary works brief, not a preference.',
    },
    {
      heading: 'Craneage and hoisting arrangements',
      body:
        '45t crawler crane on tracked mats, standing on the compacted haul road at the positions marked on the plan. The ' +
        'positions were chosen so that no lift passes over the welfare compound, the pedestrian route or the live plant ' +
        'boundary, and so that the crane never stands within 3m of the excavation crest.',
    },
    {
      heading: 'Waste and skip management',
      body:
        'Segregated skips at the compound edge, on the haul road circuit so no skip wagon reverses to reach them. Exchanged ' +
        'on booked slots like any other delivery. Hazardous waste on the bunded pallet in the container store, never in a ' +
        'skip.',
    },
    {
      heading: 'Welfare and parking provision',
      body:
        '40-person welfare unit sized against the peak labour histogram rather than against the average, which is how a ' +
        'welfare unit ends up undersized in the busiest month. Car parking outside the working area with the segregated ' +
        'route in; nobody walks a haul road to get to their car.',
    },
    {
      heading: 'Utilities and temporary supplies',
      body:
        'Temporary power from the compound distribution board, 110V for all portable tools, RCD protected and inspected on ' +
        'the equipment register. Water from the metered standpipe at the compound. No temporary supply crosses the haul ' +
        'road at ground level.',
    },
    {
      heading: 'Neighbour and stakeholder constraints',
      body:
        'The site adjoins a live operational treatment works, a public footpath and a school route. The school run drives ' +
        'the 08:15 to 08:45 delivery embargo; the live plant drives the vibration limit and the twenty-four-hour control ' +
        'room contact; the footpath drives the requirement to cover or fence every excavation at the end of each shift.',
    },
  ],

  UNDERGROUND_SERVICES_PLAN: [
    {
      heading: 'Utility records obtained and their date',
      body:
        'Statutory undertakers’ records requested and received in June 2026 — electricity, gas, water, telecoms — and held ' +
        'in the project record with their issue dates. The records show no service across zone 3, which is precisely the ' +
        'problem: the ground investigation found a culvert of unknown construction that appears on nobody’s records.',
    },
    {
      heading: 'Survey and detection method',
      body:
        'CAT and Genny sweep of the full working area before any breaking of ground, plus ground-penetrating radar over ' +
        'zone 3 to trace the culvert. The site-specific culvert survey is a condition on the approved RAMS and the works ' +
        'do not proceed in zone 3 without it.',
    },
    {
      heading: 'Marking on the ground',
      body:
        'Services marked in the standard colours and re-marked whenever the marks are worn or the ground is disturbed — a ' +
        'faded mark reads exactly like no service at all. Marks photographed and filed against the excavation before work ' +
        'starts.',
    },
    {
      heading: 'Safe digging practice and tool restrictions',
      body:
        'No mechanical excavation within 500mm of a marked service. Insulated hand tools only inside that zone, and no ' +
        'picks or forks used as levers near a marked cable. The CAT is re-swept as the dig progresses rather than once at ' +
        'the start, because the first sweep only proves what was above the first 300mm.',
    },
    {
      heading: 'Trial holes and hand-dig zones',
      body:
        'Trial holes by hand or vacuum excavation to prove the position and depth of every service crossing the works, ' +
        'including the culvert once traced. Zone 3 is a hand-dig zone in its entirety until the culvert is proved.',
    },
    {
      heading: 'Service diversions and isolations',
      body:
        'No diversion or isolation is carried out by this contractor. Any live service requiring diversion is referred to ' +
        'its undertaker and the works are re-sequenced around it. Written confirmation of isolation is held before any work ' +
        'on a de-energised service, and a permit is issued against that confirmation.',
    },
    {
      heading: 'Emergency procedure on a strike',
      body:
        'Stop, withdraw everybody to a safe distance, do not attempt to make safe. Raise the alarm through the site office. ' +
        'Electricity: treat as live and call the network operator’s emergency number. Gas: evacuate upwind, no ignition ' +
        'sources, call the National Gas Emergency Service. Water on this site means the live treatment works, so the ' +
        'undertaker’s twenty-four-hour control room is called immediately and not after the site has tried to assess it.',
    },
  ],

  EXCAVATION_PLAN: [
    {
      heading: 'Excavation extent and depth',
      body:
        'Clarifier base excavation in zone 2, 55m by 28m, to formation at 4.2m below existing ground level. Benched in two ' +
        'stages with a 2m berm at mid-height. Zone 3 is excluded from this plan until the culvert is traced and proved.',
    },
    {
      heading: 'Ground conditions and groundwater',
      body:
        'Made ground over glacial till, with groundwater struck at 2.8m in the ground investigation. Obstructions in the ' +
        'made ground exceeding the allowance are on the risk register. Dewatering by sump pumping to the settlement tanks; ' +
        'no discharge to the brook until the consent variation is granted.',
    },
    {
      heading: 'Support system and design check',
      body:
        'Proprietary trench support to the deep sections, designed and independently checked as category 2 under BS 5975, ' +
        'against the loadings in the temporary works design brief. The benched faces above are unsupported and are battered ' +
        'to the angle the design assumes, which is why the spoil set-back is enforced.',
    },
    {
      heading: 'Edge protection and access',
      body:
        'Double guardrail and toeboard to the full crest, plus heras beyond it on the north side where the ground falls ' +
        'away. Access by ladder in a purpose-made access bay, not over the face. Every excavation covered or fenced at the ' +
        'end of every shift — the site adjoins a public footpath and a school route.',
    },
    {
      heading: 'Spoil placement and surcharge',
      body:
        'Spoil heap set back a minimum of 3m from the crest and no higher than 2m, which is the surcharge the support ' +
        'design assumes. Marked on the ground so the set-back is a line somebody can see rather than a number in a ' +
        'document. Plant does not track between the heap and the crest.',
    },
    {
      heading: 'Adjacent structures and services',
      body:
        'The live treatment works boundary is 18m from the nearest face, outside any credible zone of influence, and ' +
        'vibration is monitored during breaking within 15m of it. The culvert of unknown location is the significant ' +
        'unknown and is the reason zone 3 is excluded from this plan.',
    },
    {
      heading: 'Inspection regime and permit to enter',
      body:
        'Inspected by a competent person before the first entry of every shift, after any event likely to have affected ' +
        'stability, and at least every seven days, recorded against the excavation on the platform. No entry to any ' +
        'supported excavation without a permit, and the permit names the operatives and checks their tickets against the ' +
        'permit’s own end date rather than the day it was issued.',
    },
  ],

  WORK_EQUIPMENT_REGISTER: [
    {
      heading: 'Equipment and identification',
      body:
        '45t crawler crane (CR-01), 30t tracked excavator (EX-01), two 13t excavators (EX-02, EX-03), two MEWPs (MW-01, ' +
        'MW-02), the compound distribution board and its 110V transformers, and the proprietary trench support sets. Each ' +
        'carries a unique identifier on the machine, not only on the register — a register nobody can tie to a machine in ' +
        'front of them is a filing exercise.',
    },
    {
      heading: 'Statutory inspection dates',
      body:
        'Lifting equipment thoroughly examined every twelve months, and every six months for anything lifting people. ' +
        'Portable appliance and 110V transformer inspection quarterly. Trench support inspected before first use and every ' +
        'seven days in service. Dates held against the equipment, and the register is the thing that is checked before a ' +
        'machine is released to work.',
    },
    {
      heading: 'Thorough examination certificates',
      body:
        'LOLER reports for CR-01, MW-01 and MW-02, and PUWER records for the excavators, held in the project record and ' +
        'produced on request. Any machine whose certificate has lapsed is taken off the register and out of service the ' +
        'same day, whatever it is in the middle of.',
    },
    {
      heading: 'Operator competence',
      body:
        'CPCS or NPORS for every plant operator, IPAF 3a and 3b for MEWP operators, and a slinger-signaller ticket for ' +
        'anybody attaching a load. Checked and recorded at induction against the person, and checked again against the ' +
        'expiry date whenever a permit names them.',
    },
    {
      heading: 'Defect reporting',
      body:
        'Defects reported to the site manager the same shift, on the platform against the machine rather than verbally. A ' +
        'machine with a safety-critical defect is locked off and tagged out immediately, and the tag is removed by the ' +
        'person who fitted it and nobody else.',
    },
  ],

  SITE_INDUCTION: [
    {
      heading: 'Project and duty holders',
      body:
        'Ashworth Water Treatment Works Phase 2 for Meridian Infrastructure Group, who are also Principal Designer and ' +
        'Principal Contractor. The site manager runs the site day to day and can stop any activity. The safety lead ' +
        'approves every document in this set. Everybody is named on the notice board, not merely on paper.',
    },
    {
      heading: 'Site rules and PPE',
      body:
        'Hard hat, boots, hi-vis and gloves outside the welfare compound. Eye and hearing protection in the plant exclusion ' +
        'zones. 5mph across the site. No lone working after 18:00 and none in any chamber at any time. Anybody may stop ' +
        'work on safety grounds without justifying it first.',
    },
    {
      heading: 'Significant risks on this site',
      body:
        'A historic culvert of unknown construction across zone 3, which is why zone 3 is a hand-dig zone. A live ' +
        'operational treatment works 18m away. Deep excavation to 4.2m. Confined space entry to the inlet chamber, from ' +
        'which the emergency services cannot effect a rescue inside the exposure window — the standby team and the tripod ' +
        'are the rescue plan.',
    },
    {
      heading: 'Welfare and first aid',
      body:
        '40-person welfare unit at the compound: drying room, mess room and WCs, reached by the segregated pedestrian route ' +
        'without crossing a haul road. Two first aiders on site at all times and named on the board. Eyewash at the welfare ' +
        'entrance and beside the retarder store; defibrillator in the site office.',
    },
    {
      heading: 'Fire and emergency',
      body:
        'Continuous alarm from the break-glass points. Assemble at G1, or on the north lane beyond G2 if the incident is at ' +
        'the compound. Roll call against this induction register and the signing-in sheet together. Nearest A&E is ' +
        'Calderdale Royal, eleven minutes.',
    },
    {
      heading: 'Reporting incidents and near misses',
      body:
        'Every incident and every near miss reported to the site manager the same day, and recorded on the platform rather ' +
        'than in a book in a drawer. A near miss reported is the one that does not become the next incident, and nobody is ' +
        'disciplined for reporting one.',
    },
    {
      heading: 'Consultation arrangements',
      body:
        'Weekly point-of-work briefing at the start of each shift and a monthly safety meeting open to every operative on ' +
        'site, subcontractors included. Anything raised at a daily briefing and not closed is a standing item at the ' +
        'monthly meeting until it is.',
    },
  ],

  TOOLBOX_TALK: [
    { heading: 'Subject', body: 'Working near the deep excavation in zone 2, and the spoil set-back that keeps its faces standing.' },
    {
      heading: 'Key points',
      body:
        'The support design assumes a 3m set-back and a 2m spoil height. Nothing is stored inside that line and no plant ' +
        'tracks between the heap and the crest. Access is by the ladder in the access bay, never over the face. Report any ' +
        'movement, water ingress or crack at the crest to the site manager immediately — the inspection is every shift, but ' +
        'the person who sees it first is whoever is standing there.',
    },
    {
      heading: 'Site-specific application',
      body:
        'The set-back line is marked on the ground on the north side, where the ground falls away and the temptation to ' +
        'push the heap closer is greatest. Zone 3 is not covered by this talk: it is a hand-dig zone until the culvert is ' +
        'traced, and nobody excavates there mechanically on the strength of this briefing.',
    },
    {
      heading: 'Questions raised',
      body:
        'Asked whether the set-back applies to the reinforcement bundles as well as to spoil. It does — it is a surcharge ' +
        'limit, not a spoil rule, and a bundle of reinforcement is heavier than the spoil it would displace. The laydown ' +
        'area is where they go.',
    },
    { heading: 'Attendance', body: 'Recorded against each person on the platform at the point of delivery, not signed for afterwards.' },
  ],
};
