import { SENSITIVITY_ORDER } from '../ai/sensitivity.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { issuerProfile, legalReadiness } from '../group/profile.ts';
import type { Platform } from '../platform.ts';

/**
 * What has to be in place before a tender starts, checked at once.
 *
 * Each of these was met as a refusal halfway through a tender, one after
 * another, on the return date: no company facts, so no compliance matrix; no
 * brand, so no download; no registered details, then no numbering rule, so the
 * quotation would not issue; no provider cleared for commercial material, so
 * no answer could be drafted. Each is the same test the refusing command
 * applies, read here before the work starts, with the screen that fixes it.
 *
 * Nothing here blocks anything. A tender can be read without a brand; what
 * this does is say, before an afternoon is spent, which refusal is waiting.
 */

export type ReadinessItem = {
  id: 'COMPANY_FACTS' | 'BRANDING' | 'REGISTERED_DETAILS' | 'NUMBERING' | 'AI_CLEARANCE';
  title: string;
  ready: boolean;
  /** What is in place, or exactly what is missing and what it will stop. */
  detail: string;
  /** Where it is fixed: the console screen and what to press there. */
  fix: { screen: string; label: string };
};

export type TenderReadiness = { items: ReadinessItem[]; ready: boolean; summary: string };

/** The document a tender's price goes out as, and so the one that must be numberable. */
const PRICED_OFFER = 'quotation';

export function tenderReadiness(platform: Platform, ctx: EngineContext): TenderReadiness {
  authorise(ctx, 'ESTIMATE_TENDER', 'R');

  const items: ReadinessItem[] = [];

  const hasFacts = Boolean(ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` }));
  items.push({
    id: 'COMPANY_FACTS',
    title: "The company's facts",
    ready: hasFacts,
    detail: hasFacts
      ? 'On file: every requirement in a compliance matrix is set against them.'
      : 'Nothing is recorded about the business, so a reading cannot be confirmed into a compliance matrix.',
    fix: { screen: 'pipeline', label: "Record the company's facts" },
  });

  const branded = platform.exports.brandingIfConfigured(ctx.tenantId) !== undefined;
  items.push({
    id: 'BRANDING',
    title: 'How documents are branded',
    ready: branded,
    detail: branded
      ? 'Set: quotations, submissions and programmes can be downloaded.'
      : 'Not set, so no quotation, submission or programme can be downloaded — every export refuses until it is.',
    fix: { screen: 'enterprise', label: 'Company brand' },
  });

  const profile = issuerProfile(platform, ctx.tenantId);
  const legal = legalReadiness(profile);
  items.push({
    id: 'REGISTERED_DETAILS',
    title: 'Registered company details',
    ready: legal.complete,
    detail: legal.complete
      ? 'Complete: they print on every issued document.'
      : `Missing ${legal.missingLabels.join(', ')}. Nothing is issued until they are entered.`,
    fix: { screen: 'documents', label: 'Set the issuer details' },
  });

  const numbered = Boolean(profile.numberingRules[PRICED_OFFER]);
  items.push({
    id: 'NUMBERING',
    title: 'A numbering rule for quotations',
    ready: numbered,
    detail: numbered
      ? 'Set: a quotation is given its number when it is issued.'
      : 'None set, so the quotation that carries the tender price cannot be issued.',
    fix: { screen: 'documents', label: 'Set a numbering rule' },
  });

  const providers = ctx.orchestrator.transmittingProviders();
  const commercial = SENSITIVITY_ORDER.indexOf('COMMERCIAL_L3');
  const cleared = providers.filter(
    (provider) => SENSITIVITY_ORDER.indexOf(ctx.orchestrator.clearanceOf(provider, ctx.tenantId)) >= commercial,
  );
  items.push({
    id: 'AI_CLEARANCE',
    title: 'An AI provider cleared for commercial material',
    ready: cleared.length > 0,
    detail:
      cleared.length > 0
        ? `${cleared.join(', ')} may receive tender answers, pricing and the bill.`
        : providers.length === 0
          ? 'No AI provider is configured on this platform, so the reading and the answers are done by hand.'
          : `${providers.join(', ')} ${providers.length === 1 ? 'is' : 'are'} not cleared for commercial material, so no answer can be drafted. ` +
            'The company owner clears a provider once its terms permit it.',
    fix: { screen: 'billing', label: 'What each AI provider may receive' },
  });

  const missing = items.filter((item) => !item.ready);
  return {
    items,
    ready: missing.length === 0,
    summary:
      missing.length === 0
        ? 'Ready to tender: all five are in place.'
        : `${missing.length} of five to put in place before a tender: ${missing.map((item) => item.title.toLowerCase()).join('; ')}.`,
  };
}
