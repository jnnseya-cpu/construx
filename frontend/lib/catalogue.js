import { api } from './api.js';
import { humanise } from './ui.js';

/**
 * Doors, generated from the platform's own schemas.
 *
 * Seventy-eight of the platform's write routes had no console entry point. The
 * capability existed and there was no way to reach it, which is the likeliest
 * reason a reviewer concludes there is nowhere to put information in — and
 * writing seventy-eight hand-made forms would have meant restating, in the
 * browser, a field list the API already owns. Settled decision 6 is that the
 * interface holds no rule the API does not publish, and a field list is a rule.
 *
 * So `GET /v1/commands` publishes each write route with its JSON schema and this
 * module turns one into the same `command()` spec a hand-written panel uses.
 * Curated panels are not replaced: a real dropdown of this project's drawings
 * beats a text box called "drawingId", and where one exists the generated door
 * defers to it. What changes is that a route without a curated panel now has a
 * door instead of nothing.
 *
 * ---
 *
 * **What a generated form cannot do, and says so.** It has no list of this
 * project's records, so a reference to one is a text field rather than a select.
 * It has no idea which of two fields is the important one. And a deeply nested
 * shape — the twenty cost heads of a tender estimate — is offered as JSON,
 * because a generated control cannot lay that out and pretending otherwise
 * would be worse than admitting it.
 *
 * What it no longer has to cope with is a route publishing no schema. Ninety-five
 * of them did when this was written, and a door onto a form with no fields is a
 * door onto a refusal; writing those schemas was the other half of the job.
 */

/** Every command the platform will accept, with the schema that governs it. */
export async function commandCatalogue() {
  return api.get('/v1/commands');
}

/**
 * Turn one JSON-schema property into a console field.
 *
 * The mapping is deliberately conservative. Where the schema says something
 * precise — an enum, an integer, a date pattern — the control says the same
 * thing. Where it does not, the field is text and the platform does the
 * refusing, which is the same division of labour every curated panel uses.
 */
function fieldFor(name, property, required) {
  const type = Array.isArray(property.type) ? property.type.find((t) => t !== 'null') : property.type;
  const base = { name, label: humanise(name), required };

  // A field the platform calls a hash is a file everywhere in this product: the
  // browser hashes it, the event records the hash, and the bytes follow the
  // command. Offering a text box would ask somebody to paste a SHA-256 by hand,
  // which is the sort of thing that makes a generated form feel generated.
  if (type === 'string' && /(^|[a-z])(Hash)$/.test(name)) {
    return { ...base, type: 'file', label: humanise(name.replace(/Hash$/, '')), hint: 'Hashed in your browser; the file follows the command.' };
  }

  if (Array.isArray(property.enum)) {
    return { ...base, type: 'select', options: property.enum.map((value) => ({ value, label: humanise(value) })) };
  }
  if (type === 'boolean') {
    // A select rather than a checkbox: an unchecked box and an absent field are
    // indistinguishable, and several of these routes treat the two differently.
    return { ...base, type: 'select', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] };
  }
  if (type === 'integer' || type === 'number') {
    const money = /Minor$/.test(name);
    return {
      ...base,
      type: 'number',
      // A field named in minor units is entered in major units and converted,
      // which is what the curated panels do and what people actually say.
      ...(money ? { money: true, label: humanise(name.replace(/Minor$/, '')) } : {}),
      ...(property.minimum !== undefined ? { min: money ? property.minimum / 100 : property.minimum } : {}),
      step: money ? '0.01' : type === 'integer' ? '1' : 'any',
    };
  }
  if (type === 'string' && property.pattern === '^\\d{4}-\\d{2}-\\d{2}$') {
    return { ...base, type: 'date' };
  }
  if (type === 'string' && (property.minLength ?? 0) >= 10) {
    return { ...base, type: 'textarea', rows: 4 };
  }
  if (type === 'array' || type === 'object') {
    // Honest rather than clever. A nested object or a list of them cannot be
    // filled in by a generated control, so the field takes the JSON the route
    // documents and the platform validates it — the same refusal a hand-written
    // panel would get, arriving in the same problem+json.
    return {
      ...base,
      type: 'textarea',
      rows: 4,
      hint: `JSON ${type}. This is the one shape a generated form cannot lay out; the platform checks it against the schema either way.`,
      json: true,
    };
  }
  return { ...base, type: 'text' };
}

/**
 * A `command()` spec for a published command.
 *
 * `projectId` is filled from the session because every project-scoped route
 * carries it and asking would be asking somebody to paste an id they are already
 * looking at. Every other path parameter names a record, and the form asks.
 */
export function specFor(command, { projectId, actorName }) {
  const schema = command.schema ?? {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const pathFields = command.params
    .filter((param) => param !== 'projectId')
    .map((param) => ({
      name: `path:${param}`,
      label: humanise(param),
      type: 'text',
      required: true,
      hint: 'The record this command acts on. Its id appears on the record’s own screen.',
    }));

  const bodyFields = Object.entries(properties).map(([name, property]) =>
    fieldFor(name, property ?? {}, required.has(name)),
  );

  // A name field is almost always the person running the command.
  for (const field of bodyFields) {
    if (/^(author|raisedBy|reportedBy|issuedBy|recordedBy|observedBy|inspectedBy|closedBy|approvedBy|signatoryName)$/.test(field.name)) {
      field.value = actorName;
    }
  }

  return {
    title: command.description,
    intent: command.schema
      ? `${command.method} ${command.path} — the fields below are the platform's own schema for this command, not a copy of it.`
      : `${command.method} ${command.path} — this route publishes no schema, so nothing here is checked before it is sent. The platform still refuses what it will not accept.`,
    path: (collected) => {
      let path = command.path.replace(':projectId', projectId);
      for (const param of command.params) {
        if (param === 'projectId') continue;
        path = path.replace(`:${param}`, encodeURIComponent(String(collected[`path:${param}`] ?? '')));
      }
      return path;
    },
    submitLabel: 'Run',
    aiCost: Boolean(command.ai),
    fields: [...pathFields, ...bodyFields],
    transform: (collected) => {
      const body = {};
      for (const [key, value] of Object.entries(collected)) {
        if (key.startsWith('path:')) continue;
        const field = bodyFields.find((f) => f.name === key);
        if (field?.json) {
          // Parsed here so a mistyped brace is a message about this field
          // rather than a 400 about the whole body.
          try {
            body[key] = JSON.parse(String(value));
          } catch {
            throw new Error(`${field.label} is not valid JSON`);
          }
          continue;
        }
        if (field?.type === 'select' && (value === 'true' || value === 'false')) {
          const property = properties[key];
          const type = Array.isArray(property?.type) ? property.type[0] : property?.type;
          body[key] = type === 'boolean' ? value === 'true' : value;
          continue;
        }
        body[key] = value;
      }
      return body;
    },
  };
}

/**
 * Group commands the way the console is laid out, so the catalogue reads as a
 * set of areas rather than as an alphabetical list of paths.
 */
export function groupCommands(commands) {
  const groups = new Map();
  for (const command of commands) {
    const segments = command.path.split('/').filter(Boolean);
    // /v1/projects/:projectId/<area>/... — the area is what a person recognises.
    const key = segments[1] === 'projects' ? (segments[3] ?? 'project') : (segments[1] ?? 'platform');
    const list = groups.get(key) ?? [];
    list.push(command);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([area, list]) => ({ area, commands: list.sort((a, b) => a.description.localeCompare(b.description)) }))
    .sort((a, b) => a.area.localeCompare(b.area));
}
