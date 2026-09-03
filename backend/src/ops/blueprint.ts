import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../agents/registry.ts';
import { EVENT_TYPES } from '../goldenthread/eventTypes.ts';
import { ENTITY_ACCESS } from '../identity/entityAccess.ts';
import type { Platform } from '../platform.ts';

/**
 * The blueprint, checked against the build.
 *
 * `docs/ai-os-blueprint.md` is a long document making claims about what this
 * platform is and what stage each part of it has reached, marked `[BUILT]`,
 * `[EXTEND]` or `[NEW]`. A document like that goes stale the week after it is
 * written, and the way it goes stale is always the same: the claims stay and
 * the build moves.
 *
 * So this does not serve the document. It reads the roadmap and the status
 * markers out of it, and publishes them **beside figures counted from the
 * running process** — routes on the gateway, codes in the event catalogue,
 * entity types classified, agents registered, events actually written. An
 * operator reading this can see the claim and the count on the same screen, and
 * a claim that has drifted from the count is visible rather than believed.
 *
 * The file is read from disk on each request rather than imported. It is a
 * document, it is edited by people, and caching it would mean the console
 * showed the version that existed when the process booted.
 */

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');

export type BlueprintSection = { number: string; title: string; status?: string };
export type RoadmapPhase = { phase: string; scope: string; status: string };

export type BlueprintPosition = {
  /** Whether the document could be read at all. A deployment may not ship docs. */
  available: boolean;
  title: string;
  sections: BlueprintSection[];
  roadmap: RoadmapPhase[];
  claims: { built: number; extend: number; planned: number };
  /** Counted from this process, not from the document. */
  measured: {
    routes: number;
    eventTypes: number;
    eventTypesEverWritten: number;
    entityTypes: number;
    agents: number;
    tenancies: number;
    eventsWritten: number;
  };
  note: string;
};

function readDoc(name: string): string | null {
  try {
    return readFileSync(join(DOCS, name), 'utf8');
  } catch {
    return null;
  }
}

/** `## 14. Admin super control centre `[EXTEND]`` → number, title, status. */
function sectionsOf(source: string): BlueprintSection[] {
  const sections: BlueprintSection[] = [];
  for (const line of source.split('\n')) {
    const match = /^##\s+(\d+)\.\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const rest = match[2] ?? '';
    const status = /\[(BUILT|EXTEND|NEW)[^\]]*\]/.exec(rest);
    sections.push({
      number: match[1] ?? '',
      title: rest.replace(/`?\[[^\]]*\]`?/g, '').trim(),
      status: status ? (status[1] as string) : undefined,
    });
  }
  return sections;
}

/**
 * The roadmap table.
 *
 * Parsed from the markdown rather than restated here, so the roadmap on the
 * console is the roadmap in the document and cannot quietly become a second,
 * more flattering one.
 */
function roadmapOf(source: string): RoadmapPhase[] {
  const start = source.indexOf('## 15. Build roadmap');
  if (start === -1) return [];
  const block = source.slice(start, source.indexOf('\n## ', start + 10));
  const phases: RoadmapPhase[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell, index, all) => index > 0 && index < all.length - 1);
    if (cells.length < 3) continue;
    const [phase = '', scope = '', status = ''] = cells;
    if (/^-+$/.test(phase) || phase.toLowerCase() === 'phase') continue;
    phases.push({
      phase: phase.replace(/\*\*/g, ''),
      scope,
      status: status.replace(/[`*]/g, '').trim(),
    });
  }
  return phases;
}

export function blueprintPosition(platform: Platform, routeCount: number): BlueprintPosition {
  const source = readDoc('ai-os-blueprint.md');

  const measured = {
    routes: routeCount,
    eventTypes: EVENT_TYPES.length,
    eventTypesEverWritten: new Set(platform.ledger.events().map((event) => event.eventType)).size,
    entityTypes: Object.keys(ENTITY_ACCESS).length,
    agents: AGENTS.length,
    tenancies: platform.customerTenants().length,
    eventsWritten: platform.ledger.events().length,
  };

  if (!source) {
    return {
      available: false,
      title: 'The blueprint is not on this deployment',
      sections: [],
      roadmap: [],
      claims: { built: 0, extend: 0, planned: 0 },
      measured,
      note:
        'docs/ai-os-blueprint.md was not found next to this process. The image may have been built without the docs ' +
        'directory. The measured figures below are counted from the running platform and are unaffected.',
    };
  }

  const sections = sectionsOf(source);
  const claims = {
    built: (source.match(/\[BUILT/g) ?? []).length,
    extend: (source.match(/\[EXTEND/g) ?? []).length,
    planned: (source.match(/\[NEW/g) ?? []).length,
  };

  return {
    available: true,
    title: (source.split('\n')[0] ?? '').replace(/^#\s*/, ''),
    sections,
    roadmap: roadmapOf(source),
    claims,
    measured,
    note:
      'The claims are read from the document; the measurements are counted from this running process. Where a claim ' +
      'and a count disagree, the count is the one that is true — the document is a statement of intent and the ' +
      'platform is what exists.',
  };
}
