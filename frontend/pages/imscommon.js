import { humanise } from '../lib/ui.js';

/**
 * The lookups every part of the Management System screen shares, read from the
 * vocabulary `GET /v1/ims` publishes rather than restated here.
 */

export const clauseLabel = (view, id) => {
  const clause = view.vocabulary.clauses.find((entry) => entry.id === id);
  const standard = clause ? view.vocabulary.standards.find((entry) => entry.id === clause.standard) : null;
  return clause ? `${standard?.label ?? clause.standard} ${clause.clause} ${clause.title}` : id;
};
export const personOptions = (view) => view.people.map((person) => ({ value: person.id, label: `${person.name} (${person.roles.map((role) => humanise(role)).join(', ')})` }));
export const roleOptions = (view) => view.vocabulary.roles.map((role) => ({ value: role, label: humanise(role) }));
export const standardOptions = (view) => view.vocabulary.standards.map((standard) => ({ value: standard.id, label: `${standard.label} — ${standard.topic}` }));
export const clauseOptions = (view, standards) =>
  view.vocabulary.clauses.filter((clause) => !standards || standards.includes(clause.standard)).map((clause) => ({ value: clause.id, label: clauseLabel(view, clause.id) }));
export const nameOf = (view, id) => view.people.find((person) => person.id === id)?.name ?? id;
export const standardLabel = (view, id) => view.vocabulary.standards.find((entry) => entry.id === id)?.label ?? id;
export const plural = (n, one, many) => String(n) + ' ' + (n === 1 ? one : many);
