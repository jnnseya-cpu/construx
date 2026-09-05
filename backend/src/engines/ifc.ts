import { createHash } from 'node:crypto';
import { ZipError, zipEntries, zipEntryBytes } from '../evidence/zip.ts';

/**
 * Reading an IFC file: what it contains, and a geometry fingerprint per element.
 *
 * An IFC is a STEP physical file (ISO 10303-21): a header naming the schema and
 * the authoring application, then one instance per statement —
 * `#12=IFCWALL('2O2Fr$t4X7Zf8NOew3FLKI',#5,'W-01',$,$,#30,#40,$,.NOTDEFINED.);`
 * — where every `#n` is a reference to another instance. Until this existed
 * the platform recorded a model's element count as whatever the person typing
 * it in said, and declared unit and coordinate mismatches it could not check.
 *
 * What is read: the schema, the view definition, the application that wrote
 * the file, the project and its spatial structure (site, building, storeys with
 * their elevations), the length unit, every element with its GlobalId, class,
 * name and storey, and — the part that makes two revisions comparable — a
 * geometry hash per element.
 *
 * **The geometry hash is a Merkle hash of the element's placement and
 * representation subgraph with instance numbers removed.** Two exports of the
 * same model number their instances differently, so hashing the raw statements
 * would call every re-export a change. Replacing each `#n` with the hash of
 * what it points at, recursively, gives a fingerprint that is the same for the
 * same geometry however the file was numbered, and different where an element
 * moved or changed shape. A model's own hash is the hash of its elements' hashes
 * in GlobalId order.
 *
 * **What is not done.** No geometry is evaluated: this does not compute
 * volumes, intersections or bounding boxes, and clash detection still needs an
 * engine that does. A hash says *whether* an element's geometry changed, not by
 * how much. Property sets are counted, not interpreted. Zero dependencies, as
 * settled: the file is text and this is a scanner.
 *
 * An `.ifczip` is the same text inside a ZIP container, and is read by
 * expanding the one `.ifc` entry under a size cap (`evidence/zip.ts`). An
 * `.ifcxml` is a different encoding of the same schema and is not read here;
 * the refusal says so by name.
 */

export type IfcElement = {
  globalId: string;
  type: string;
  name?: string;
  storey?: string;
  /** Merkle hash of placement and representation, instance numbers removed. */
  geometryHash: string;
};

export type IfcStorey = { globalId: string; name: string; elevation?: number; elements: number };

export type IfcSummary = {
  schema: string;
  /** How the file arrived: a STEP physical file as it is, or one inside a ZIP container. */
  container: 'STEP' | 'IFCZIP';
  /** For a container: the entry that was read. */
  containerEntry?: string;
  viewDefinition?: string;
  authoringApplication?: string;
  timestamp?: string;
  projectName?: string;
  siteName?: string;
  buildingName?: string;
  /** As the project's length unit declares it: mm, m, cm, ft, in. */
  lengthUnit?: string;
  /** Every instance in the data section. */
  entityCount: number;
  /** Physical elements: walls, slabs, pipes, terminals — not spaces, openings, types or relationships. */
  elementCount: number;
  elementsByType: Record<string, number>;
  storeys: IfcStorey[];
  spaces: number;
  propertySets: number;
  /** Elements whose representation is a geometric model rather than none. */
  elementsWithGeometry: number;
  /** Of the whole model: the hash of every element's geometry hash, in GlobalId order. */
  geometryHash: string;
  elements: IfcElement[];
  warnings: string[];
};

export type IfcDiff = {
  added: Array<{ globalId: string; type: string; name?: string; storey?: string }>;
  removed: Array<{ globalId: string; type: string; name?: string; storey?: string }>;
  /** Same GlobalId, different placement or representation. */
  changed: Array<{ globalId: string; type: string; name?: string; storey?: string }>;
  renamed: Array<{ globalId: string; type: string; from?: string; to?: string }>;
  unchanged: number;
  byType: Record<string, { added: number; removed: number; changed: number }>;
  sameGeometry: boolean;
  summary: string;
};

export class IfcParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Instance = { type: string; attrs: string };

/** Classes that are physical elements and do not end in a word the heuristic below catches. */
const ELEMENT_TYPES = new Set([
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE', 'IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE',
  'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE', 'IFCDOOR', 'IFCDOORSTANDARDCASE',
  'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCROOF', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT',
  'IFCRAILING', 'IFCCOVERING', 'IFCFOOTING', 'IFCPILE', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE', 'IFCPLATE',
  'IFCPLATESTANDARDCASE', 'IFCCURTAINWALL', 'IFCCHIMNEY', 'IFCSHADINGDEVICE', 'IFCREINFORCINGBAR',
  'IFCREINFORCINGMESH', 'IFCTENDON', 'IFCTENDONANCHOR', 'IFCTENDONCONDUIT', 'IFCFASTENER', 'IFCMECHANICALFASTENER',
  'IFCDISCRETEACCESSORY', 'IFCVIBRATIONISOLATOR', 'IFCTRANSPORTELEMENT', 'IFCGEOGRAPHICELEMENT', 'IFCCIVILELEMENT',
  'IFCFURNITURE', 'IFCSYSTEMFURNITUREELEMENT', 'IFCBUILDINGELEMENTPROXY', 'IFCBUILDINGELEMENTPART', 'IFCPAVEMENT',
  'IFCKERB', 'IFCCOURSE', 'IFCRAIL', 'IFCTRACKELEMENT', 'IFCBEARING', 'IFCDEEPFOUNDATION', 'IFCCAISSONFOUNDATION',
  'IFCEARTHWORKSELEMENT', 'IFCEARTHWORKSCUT', 'IFCEARTHWORKSFILL', 'IFCREINFORCEDSOIL', 'IFCMOORINGDEVICE',
  'IFCNAVIGATIONELEMENT', 'IFCSIGN', 'IFCSIGNAL', 'IFCCONVEYORSEGMENT', 'IFCIMPACTPROTECTIONDEVICE',
  'IFCELECTRICFLOWTREATMENTDEVICE',
]);

/** Classes whose names end like elements but which are not physical things to count. */
const NOT_ELEMENTS = new Set([
  'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCSPATIALELEMENT', 'IFCSPATIALSTRUCTUREELEMENT', 'IFCFEATUREELEMENT',
  'IFCFEATUREELEMENTADDITION', 'IFCFEATUREELEMENTSUBTRACTION', 'IFCPROJECTIONELEMENT', 'IFCVOIDINGFEATURE',
  'IFCSURFACEFEATURE', 'IFCELEMENT', 'IFCBUILDINGELEMENT', 'IFCBUILTELEMENT', 'IFCDISTRIBUTIONELEMENT',
  'IFCDISTRIBUTIONFLOWELEMENT', 'IFCDISTRIBUTIONCONTROLELEMENT', 'IFCELEMENTCOMPONENT', 'IFCELEMENTASSEMBLY',
  'IFCFURNISHINGELEMENT', 'IFCVIRTUALELEMENT', 'IFCGRID', 'IFCANNOTATION', 'IFCPORT', 'IFCDISTRIBUTIONPORT',
]);

const ELEMENT_SUFFIX = /(ELEMENT|SEGMENT|FITTING|TERMINAL|DEVICE|EQUIPMENT|ACCESSORY|CONTROLLER|SENSOR|ACTUATOR|ALARM|UNITARY|CHAMBER|ASSEMBLY|PROXY|FURNITURE|BOILER|CHILLER|PUMP|FAN|VALVE|DAMPER|FILTER|COIL|TANK|DUCT|PIPE|CABLE|LAMP|LIGHTFIXTURE|OUTLET|SWITCHINGDEVICE|TRANSFORMER|GENERATOR|MOTOR|COMPRESSOR|CONDENSER|EVAPORATOR|HUMIDIFIER|COOLINGTOWER|HEATEXCHANGER|BURNER|ENGINE|INTERCEPTOR|STACKTERMINAL|WASTETERMINAL|SANITARYTERMINAL|FIRESUPPRESSIONTERMINAL|SPACEHEATER|TUBEBUNDLE|SOLARDEVICE|ELECTRICAPPLIANCE|JUNCTIONBOX|PROTECTIVEDEVICE|AUDIOVISUALAPPLIANCE|COMMUNICATIONSAPPLIANCE|MEDICALDEVICE|FLOWMETER|FLOWINSTRUMENT|EVAPORATIVECOOLER|AIRTOAIRHEATRECOVERY|AIRTERMINALBOX|DISTRIBUTIONCHAMBERELEMENT|DISTRIBUTIONBOARD|ELECTRICDISTRIBUTIONBOARD|ELECTRICMOTOR|ELECTRICTIMECONTROL|ELECTRICGENERATOR)$/;

function isElement(type: string): boolean {
  if (NOT_ELEMENTS.has(type)) return false;
  if (ELEMENT_TYPES.has(type)) return true;
  if (!type.startsWith('IFC') || type.startsWith('IFCREL') || type.endsWith('TYPE') || type.endsWith('STYLE')) return false;
  return ELEMENT_SUFFIX.test(type);
}

/** Top-level attribute split: commas outside strings and nested parentheses. */
function splitAttrs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "'") {
        if (text[index + 1] === "'") index += 1;
        else inString = false;
      }
      continue;
    }
    if (char === "'") inString = true;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      out.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A STEP string attribute, unquoted; undefined for `$` or anything else. */
function stringAttr(token: string | undefined): string | undefined {
  if (!token || !token.startsWith("'")) return undefined;
  return decodeStepString(token.slice(1, token.endsWith("'") ? -1 : undefined));
}

/** `''` is a quote; `\X2\....\X0\` is UTF-16 hex; `\S\x` is Latin-1 upper half. */
function decodeStepString(raw: string): string {
  return raw
    .replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      let out = '';
      for (let index = 0; index + 3 < hex.length; index += 4) out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
      return out;
    })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      let out = '';
      for (let index = 0; index + 7 < hex.length; index += 8) out += String.fromCodePoint(Number.parseInt(hex.slice(index, index + 8), 16));
      return out;
    })
    .replace(/\\S\\(.)/g, (_match, char: string) => String.fromCharCode(char.charCodeAt(0) + 128))
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function refAttr(token: string | undefined): number | undefined {
  const match = token ? /^#(\d+)$/.exec(token) : null;
  return match ? Number(match[1]) : undefined;
}

function refList(token: string | undefined): number[] {
  if (!token || !token.startsWith('(')) return [];
  return [...token.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

/**
 * Statements of a section, each ended by `;` outside a string. Comments
 * (`/* … *​/`) are skipped. A statement may span lines; a string may contain
 * `;`, `(` and `)`.
 */
function statements(section: string): string[] {
  const out: string[] = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!;
    if (inString) {
      if (char === "'") {
        if (section[index + 1] === "'") index += 1;
        else inString = false;
      }
      continue;
    }
    if (char === "'") inString = true;
    else if (char === '/' && section[index + 1] === '*') {
      const close = section.indexOf('*/', index + 2);
      index = close < 0 ? section.length : close + 1;
      start = index + 1;
    } else if (char === ';') {
      const statement = section.slice(start, index).trim();
      if (statement !== '') out.push(statement);
      start = index + 1;
    }
  }
  return out;
}

/** Numbers written `1.` and `1.0` and `1.0E0` are one number. */
function canonicalNumbers(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_#$'])-?\d+(?:\.\d*)?(?:E[+-]?\d+)?(?![A-Za-z0-9_'])/g, (match) => {
    const value = Number(match);
    return Number.isFinite(value) ? String(value) : match;
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** An expanded IFC may not exceed this. A model of this size has left the realm of anything this scanner should hold in memory. */
const MAX_IFC_BYTES = 512 * 1024 * 1024;

/** Read an IFC-SPF file, as it is or inside an `.ifczip`. Throws `IfcParseError` where the bytes are neither. */
export function parseIfc(bytes: Buffer): IfcSummary {
  let container: IfcSummary['container'] = 'STEP';
  let containerEntry: string | undefined;
  // A container begins with a local header, or — holding nothing — with the
  // end record alone. Both are the container's, neither is STEP.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))) {
    const entries = zipEntries(bytes);
    const entry = entries.find((candidate) => /\.ifc$/i.test(candidate.name)) ?? entries.find((candidate) => !candidate.name.endsWith('/'));
    if (!entry) throw new IfcParseError('IFC_ZIP_EMPTY', 'The ZIP container holds no entry to read.');
    if (entries.some((candidate) => /\.ifcxml$/i.test(candidate.name)) && !/\.ifc$/i.test(entry.name)) {
      throw new IfcParseError('IFC_XML_NOT_READ', `${entry.name} is ifcXML, a different encoding of the schema, and is not read here. Export the model as IFC-SPF.`);
    }
    try {
      bytes = zipEntryBytes(bytes, entry, MAX_IFC_BYTES);
    } catch (error) {
      if (error instanceof ZipError) throw new IfcParseError(error.code, error.message);
      throw error;
    }
    container = 'IFCZIP';
    containerEntry = entry.name;
  }
  const text = bytes.toString('latin1').replace(/^﻿/, '').replace(/^ï»¿/, '');
  if (!/^\s*ISO-10303-21;/.test(text)) {
    throw new IfcParseError(
      /^\s*<\?xml/i.test(text) ? 'IFC_XML_NOT_READ' : 'IFC_NOT_STEP',
      /^\s*<\?xml/i.test(text)
        ? 'The file is ifcXML, a different encoding of the schema, and is not read here. Export the model as IFC-SPF, plain or zipped.'
        : `The ${container === 'IFCZIP' ? `entry ${containerEntry} ` : 'file '}does not begin with ISO-10303-21, so it is not an IFC in STEP physical file form. An .ifcXML is not read here.`,
    );
  }
  const warnings: string[] = [];

  // Header.
  const headerStart = text.indexOf('HEADER;');
  const headerEnd = text.indexOf('ENDSEC;', headerStart);
  const header = headerStart >= 0 && headerEnd > headerStart ? text.slice(headerStart + 7, headerEnd) : '';
  let schema = '';
  let viewDefinition: string | undefined;
  let authoringApplication: string | undefined;
  let timestamp: string | undefined;
  for (const statement of statements(header)) {
    const match = /^([A-Z_]+)\s*\(([\s\S]*)\)$/.exec(statement);
    if (!match) continue;
    const attrs = splitAttrs(match[2]!);
    if (match[1] === 'FILE_SCHEMA') schema = (/'([^']+)'/.exec(attrs[0] ?? '')?.[1] ?? '').toUpperCase();
    else if (match[1] === 'FILE_DESCRIPTION') {
      const description = [...(attrs[0] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((entry) => decodeStepString(entry[1]!)).join(' ');
      const view = /ViewDefinition\s*\[([^\]]+)\]/i.exec(description);
      viewDefinition = view ? view[1]!.trim() : description || undefined;
    } else if (match[1] === 'FILE_NAME') {
      timestamp = stringAttr(attrs[1]);
      const originating = stringAttr(attrs[5]);
      const preprocessor = stringAttr(attrs[4]);
      authoringApplication = originating?.trim() || preprocessor?.trim() || undefined;
    }
  }
  if (schema === '') {
    warnings.push('The header names no FILE_SCHEMA; the file is read as IFC4 syntax, which every schema shares.');
    schema = 'UNKNOWN';
  }

  // Data.
  const dataStart = text.indexOf('DATA;', headerEnd < 0 ? 0 : headerEnd);
  if (dataStart < 0) throw new IfcParseError('IFC_NO_DATA', 'The file has a header and no DATA section, so it describes nothing.');
  const dataEnd = text.lastIndexOf('ENDSEC;');
  const data = text.slice(dataStart + 5, dataEnd > dataStart ? dataEnd : undefined);

  const instances = new Map<number, Instance>();
  let malformed = 0;
  for (const statement of statements(data)) {
    const match = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/.exec(statement);
    if (!match) {
      malformed += 1;
      continue;
    }
    instances.set(Number(match[1]), { type: match[2]!, attrs: match[3]! });
  }
  if (malformed > 0) warnings.push(`${malformed} statement${malformed === 1 ? '' : 's'} in the data section could not be read as an instance and were skipped.`);
  if (instances.size === 0) throw new IfcParseError('IFC_EMPTY', 'The data section carries no instances.');

  // Spatial structure and containment.
  const storeyById = new Map<number, IfcStorey>();
  const containedIn = new Map<number, number>();
  let projectName: string | undefined;
  let siteName: string | undefined;
  let buildingName: string | undefined;
  let spaces = 0;
  let propertySets = 0;
  let lengthUnit: string | undefined;
  for (const [id, instance] of instances) {
    switch (instance.type) {
      case 'IFCPROJECT':
        projectName = stringAttr(splitAttrs(instance.attrs)[2]);
        break;
      case 'IFCSITE':
        siteName = stringAttr(splitAttrs(instance.attrs)[2]);
        break;
      case 'IFCBUILDING':
        buildingName = stringAttr(splitAttrs(instance.attrs)[2]);
        break;
      case 'IFCBUILDINGSTOREY': {
        const attrs = splitAttrs(instance.attrs);
        const elevation = Number(attrs[9]);
        storeyById.set(id, {
          globalId: stringAttr(attrs[0]) ?? '',
          name: stringAttr(attrs[2]) ?? stringAttr(attrs[7]) ?? `Storey #${id}`,
          ...(Number.isFinite(elevation) && attrs[9] !== '$' ? { elevation } : {}),
          elements: 0,
        });
        break;
      }
      case 'IFCSPACE':
        spaces += 1;
        break;
      case 'IFCPROPERTYSET':
      case 'IFCELEMENTQUANTITY':
        propertySets += 1;
        break;
      case 'IFCRELCONTAINEDINSPATIALSTRUCTURE': {
        const attrs = splitAttrs(instance.attrs);
        const structure = refAttr(attrs[5]);
        if (structure !== undefined) for (const element of refList(attrs[4])) containedIn.set(element, structure);
        break;
      }
      case 'IFCSIUNIT': {
        const attrs = splitAttrs(instance.attrs);
        if (attrs[1] === '.LENGTHUNIT.' && lengthUnit === undefined) {
          const prefix = attrs[2] ?? '$';
          lengthUnit = prefix === '.MILLI.' ? 'mm' : prefix === '.CENTI.' ? 'cm' : prefix === '.KILO.' ? 'km' : prefix === '$' ? 'm' : `${prefix.replace(/\./g, '').toLowerCase()}m`;
        }
        break;
      }
      case 'IFCCONVERSIONBASEDUNIT': {
        const attrs = splitAttrs(instance.attrs);
        if (attrs[1] === '.LENGTHUNIT.' && lengthUnit === undefined) {
          const name = (stringAttr(attrs[2]) ?? '').toUpperCase();
          lengthUnit = name.includes('FOOT') || name.includes('FEET') ? 'ft' : name.includes('INCH') ? 'in' : name.toLowerCase() || undefined;
        }
        break;
      }
      default:
        break;
    }
  }

  // Geometry hashes, Merkle over the reference graph with instance numbers removed.
  const hashes = new Map<number, string>();
  const visiting = new Set<number>();
  const hashOf = (id: number, depth: number): string => {
    const known = hashes.get(id);
    if (known !== undefined) return known;
    const instance = instances.get(id);
    if (!instance) return 'missing';
    if (visiting.has(id) || depth > 96) return 'cycle';
    visiting.add(id);
    const canonical = `${instance.type}(${canonicalNumbers(instance.attrs).replace(/#(\d+)/g, (_match, ref: string) => `<${hashOf(Number(ref), depth + 1)}>`)})`;
    visiting.delete(id);
    const digest = sha256(canonical).slice(0, 32);
    hashes.set(id, digest);
    return digest;
  };

  const elements: IfcElement[] = [];
  const elementsByType: Record<string, number> = {};
  let elementsWithGeometry = 0;
  for (const [id, instance] of instances) {
    if (!isElement(instance.type)) continue;
    const attrs = splitAttrs(instance.attrs);
    const globalId = stringAttr(attrs[0]) ?? `#${id}`;
    const placement = refAttr(attrs[5]);
    const representation = refAttr(attrs[6]);
    if (representation !== undefined) elementsWithGeometry += 1;
    const geometryHash = sha256(
      `${instance.type}|${placement === undefined ? '$' : hashOf(placement, 0)}|${representation === undefined ? '$' : hashOf(representation, 0)}`,
    ).slice(0, 32);
    const storeyRef = containedIn.get(id);
    const storey = storeyRef === undefined ? undefined : storeyById.get(storeyRef);
    if (storey) storey.elements += 1;
    const name = stringAttr(attrs[2]);
    elements.push({ globalId, type: instance.type, ...(name ? { name } : {}), ...(storey ? { storey: storey.name } : {}), geometryHash });
    elementsByType[instance.type] = (elementsByType[instance.type] ?? 0) + 1;
  }
  elements.sort((a, b) => a.globalId.localeCompare(b.globalId));

  const duplicates = elements.length - new Set(elements.map((element) => element.globalId)).size;
  if (duplicates > 0) warnings.push(`${duplicates} element${duplicates === 1 ? '' : 's'} share a GlobalId with another; a revision comparison cannot tell those apart.`);

  return {
    schema,
    container,
    ...(containerEntry ? { containerEntry } : {}),
    ...(viewDefinition ? { viewDefinition } : {}),
    ...(authoringApplication ? { authoringApplication } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(projectName ? { projectName } : {}),
    ...(siteName ? { siteName } : {}),
    ...(buildingName ? { buildingName } : {}),
    ...(lengthUnit ? { lengthUnit } : {}),
    entityCount: instances.size,
    elementCount: elements.length,
    elementsByType,
    storeys: [...storeyById.values()].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0)),
    spaces,
    propertySets,
    elementsWithGeometry,
    geometryHash: sha256(elements.map((element) => `${element.globalId}:${element.geometryHash}`).join('\n')),
    elements,
    warnings,
  };
}

/** What changed between two revisions, element by element, by GlobalId. */
export function diffIfc(before: IfcSummary, after: IfcSummary): IfcDiff {
  const previous = new Map(before.elements.map((element) => [element.globalId, element]));
  const next = new Map(after.elements.map((element) => [element.globalId, element]));
  const diff: IfcDiff = { added: [], removed: [], changed: [], renamed: [], unchanged: 0, byType: {}, sameGeometry: before.geometryHash === after.geometryHash, summary: '' };
  const bucket = (type: string): { added: number; removed: number; changed: number } => (diff.byType[type] ??= { added: 0, removed: 0, changed: 0 });
  const brief = (element: IfcElement): { globalId: string; type: string; name?: string; storey?: string } => ({
    globalId: element.globalId,
    type: element.type,
    ...(element.name ? { name: element.name } : {}),
    ...(element.storey ? { storey: element.storey } : {}),
  });

  for (const element of after.elements) {
    const was = previous.get(element.globalId);
    if (!was) {
      diff.added.push(brief(element));
      bucket(element.type).added += 1;
      continue;
    }
    if (was.geometryHash !== element.geometryHash) {
      diff.changed.push(brief(element));
      bucket(element.type).changed += 1;
    } else diff.unchanged += 1;
    if ((was.name ?? '') !== (element.name ?? '')) {
      diff.renamed.push({ globalId: element.globalId, type: element.type, ...(was.name ? { from: was.name } : {}), ...(element.name ? { to: element.name } : {}) });
    }
  }
  for (const element of before.elements) {
    if (!next.has(element.globalId)) {
      diff.removed.push(brief(element));
      bucket(element.type).removed += 1;
    }
  }

  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  diff.summary =
    diff.sameGeometry && diff.added.length === 0 && diff.removed.length === 0
      ? `Same geometry: ${count(diff.unchanged, 'element')} unchanged${diff.renamed.length > 0 ? `, ${count(diff.renamed.length, 'element')} renamed` : ''}.`
      : `${count(diff.added.length, 'element')} added, ${count(diff.removed.length, 'element')} removed, ${count(diff.changed.length, 'element')} moved or reshaped, ${diff.unchanged} unchanged${
          diff.renamed.length > 0 ? `, ${count(diff.renamed.length, 'element')} renamed` : ''
        }.`;
  return diff;
}
