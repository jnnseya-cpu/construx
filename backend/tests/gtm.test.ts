import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { subscriptionAcuAllocationMinor } from '../src/billing/acu.ts';
import { ACU_BUNDLES, PACKAGES } from '../src/billing/seats.ts';
import { config } from '../src/config.ts';

/**
 * The commercial plan quotes the platform's prices. It is not allowed to
 * disagree with them.
 *
 * ## What happened
 *
 * `docs/go-to-market/` holds one document in four forms: an HTML source, a
 * Markdown edition generated from it, and Word and PDF editions generated from
 * that. Its own README said the *Markdown* was the source of record while the
 * build command three lines below said `HTML → GO-TO-MARKET.md`.
 *
 * So both were edited, in opposite directions, and neither was regenerated. The
 * HTML was corrected to a 4× markup; the Markdown went on quoting 5× and a
 * superseded set of bundle figures for months. Meanwhile the HTML quoted
 * "Starter £300 (7,500 ACUs)" — the *provider cost* a bundle funds, labelled as
 * the credit — which is a mistake `billing/seats.ts` had already found and
 * fixed in code, where a £300 bundle credits 30,000.
 *
 * Three copies of one fact, each wrong in a different way, and nothing failed.
 *
 * ## What this checks
 *
 * Two things, and the second is the one that matters.
 *
 * **The generated editions match their source.** The Markdown is rebuilt in a
 * temporary file and compared with the committed one, so an edit to either
 * without a regeneration fails here rather than in a customer's inbox.
 *
 * **Every price the document quotes is the price the code charges.** Package
 * monthly prices, monthly AI allowances, bundle credits and the markup are read
 * out of the prose and asserted against `seats.ts` and `config.ts`. The code is
 * the source of truth for what a thing costs; the plan may quote it and may not
 * contradict it.
 *
 * It is deliberately not a Markdown parser. It looks for the handful of shapes
 * the document actually uses to state money, and every one of them is asserted
 * to have been *found* — a scan that silently matched nothing would be worse
 * than no scan, because it would read as a passing check.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GTM = join(REPO, 'docs', 'go-to-market');
const markdown = readFileSync(join(GTM, 'GO-TO-MARKET.md'), 'utf8');
const html = readFileSync(join(GTM, 'go-to-market.html'), 'utf8');

/** `£6,500` → 650000 minor units. */
function minorFromPounds(pounds: string): number {
  return Math.round(Number(pounds.replace(/,/g, '')) * 100);
}

describe('the generated editions match their source', () => {
  it('rebuilds the Markdown from the HTML and finds no difference', () => {
    /*
     * Rebuilt into the real path and compared against what git has, rather than
     * into a temporary file: the builder writes to a fixed location and giving
     * it another one would mean forking the builder for the test, which is a
     * second implementation of the thing being checked.
     *
     * The file is restored either way, so a failing run leaves the tree as it
     * found it.
     */
    const before = markdown;
    try {
      execFileSync('node', [join(REPO, 'tools', 'gtm', 'build-markdown.mjs')], { cwd: REPO, stdio: 'pipe' });
      const after = readFileSync(join(GTM, 'GO-TO-MARKET.md'), 'utf8');
      assert.equal(
        after,
        before,
        'GO-TO-MARKET.md is not what go-to-market.html generates. Edit the HTML and run tools/gtm/build-markdown.mjs.',
      );
    } finally {
      execFileSync('node', ['-e', `require('fs').writeFileSync(process.argv[1], process.argv[2])`, join(GTM, 'GO-TO-MARKET.md'), before], { cwd: REPO });
    }
  });

  it('names the HTML as the source, so nobody edits the generated copy', () => {
    const readme = readFileSync(join(GTM, 'README.md'), 'utf8');
    assert.match(readme, /go-to-market\.html.*is the source/i, 'the README no longer says which file to edit');
  });
});

describe('every price the plan quotes is the price the platform charges', () => {
  it('quotes the markup the platform actually applies', () => {
    /*
     * The price is a range now, so the plan quotes two numbers rather than one
     * and this has to accept both — but only those two. A plan quoting a third
     * figure, or one end of a range the platform no longer charges, is the
     * drift this check exists for: the go-to-market documents once advertised
     * 3× while billing ran at 4×, and nothing caught it.
     */
    const stated = [
      ...markdown.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(?:×|x)(?:\s*(?:and|–|-|to)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:×|x))?\s*markup/gi),
      ...markdown.matchAll(/charged at between ([0-9]+(?:\.[0-9]+)?)\s*(?:×|x) and ([0-9]+(?:\.[0-9]+)?)\s*(?:×|x)/gi),
    ].flatMap((match) => [match[1], match[2]].filter(Boolean).map(Number));
    assert.ok(stated.length > 0, 'the plan states no markup at all — this check matched nothing');
    const ends = [config.billing.markupMultiplier, config.billing.maxMarkupMultiplier];
    for (const value of stated) {
      assert.ok(ends.includes(value), `the plan quotes a ${value}× markup, which is neither end of the ${ends.join('–')}× range`);
    }
    assert.ok(stated.includes(config.billing.maxMarkupMultiplier), 'the plan quotes only the bottom of the range');
  });

  it('quotes package prices that exist, at the price they cost', () => {
    /*
     * `**Solo £100**`, `**Enterprise £6,500**` — the form the plan uses to name
     * a package and its price in the same breath.
     *
     * **A bundle is excluded by the bracket that follows it.** "Solo" is both a
     * £100 package and a £50 top-up bundle, and the first version of this
     * matched the bundle against the package and reported the platform as
     * mispriced. The document already disambiguates them — a bundle is always
     * written with the credit it buys in brackets — so that is what is read.
     */
    const named = [...markdown.matchAll(/\*\*([A-Z][A-Za-z ]+?) £([0-9,]+)\*\*(\s*\()?/g)];
    const packages = named.filter((match) => match[3] === undefined);
    assert.ok(packages.length >= 2, 'the plan names no package with a price — this check matched nothing');

    const byLabel = new Map(Object.values(PACKAGES).map((p) => [p.label.toLowerCase(), p.monthlyPriceMinor]));
    let checked = 0;
    for (const [, label, pounds] of packages) {
      const price = byLabel.get(String(label).trim().toLowerCase());
      if (price === undefined) continue; // a heading or a figure that is not a package
      checked += 1;
      assert.equal(
        minorFromPounds(String(pounds)),
        price,
        `the plan prices ${label} at £${pounds}; the platform charges ${price} minor units`,
      );
    }
    assert.ok(checked > 0, 'no package price was matched against the catalogue');
  });

  it('quotes monthly AI allowances that match what a package actually credits', () => {
    // `£100 buys 2,000 ACUs, £950 buys 19,000, £6,500 buys 130,000` — matched
    // globally rather than as a head and a tail, because a head-and-tail regex
    // quietly found two of the three and the assertion on the count was the
    // only thing that noticed.
    const pairs = [...markdown.matchAll(/£([0-9,]+) buys ([0-9,]+)/g)];
    assert.ok(pairs.length >= 3, `the plan states ${pairs.length} package AI allowances; expected at least three`);

    for (const [, pounds, acus] of pairs) {
      const price = minorFromPounds(String(pounds));
      assert.equal(
        Number(String(acus).replace(/,/g, '')),
        subscriptionAcuAllocationMinor(price),
        `the plan says £${pounds} buys ${acus} ACUs a month`,
      );
    }
  });

  it('quotes bundle credits that match what a bundle actually credits', () => {
    /*
     * The failure this exists for. A bundle credits its *price* — £300 credits
     * 30,000 ACUs — and what that credit funds in provider work is a different
     * number, £75 at the current rate. The plan quoted the second under the
     * name of the first, which is the same confusion `seats.ts` documents
     * having found and fixed in the catalogue itself.
     */
    const named = [...markdown.matchAll(/\*\*([A-Za-z]+) £([0-9,]+)\*\* \(([0-9,]+)(?: ACUs)?\)/g)];
    const trailing = [...markdown.matchAll(/\*\*([A-Za-z]+) £([0-9,]+)\*\* \(([0-9,]+)\)/g)];
    const all = [...named, ...trailing];
    assert.ok(all.length > 0, 'the plan names no bundle with a credit — this check matched nothing');

    const byName = new Map(Object.values(ACU_BUNDLES).map((b) => [b.bundle.toLowerCase(), b]));
    let checked = 0;
    for (const [, name, pounds, acus] of all) {
      const bundle = byName.get(String(name).toLowerCase());
      if (!bundle) continue;
      checked += 1;
      assert.equal(minorFromPounds(String(pounds)), bundle.priceMinor, `${name} is priced at £${pounds} in the plan`);
      assert.equal(
        Number(String(acus).replace(/,/g, '')),
        bundle.usableAcus,
        `the plan says the ${name} bundle credits ${acus} ACUs; it credits ${bundle.usableAcus}. ` +
          `(${bundle.providerCostMinor} is what that credit funds in provider work — a different number.)`,
      );
    }
    assert.ok(checked >= 3, `only ${checked} bundles were matched against the catalogue`);
  });

  it('states no figure in the HTML that the Markdown check would not see', () => {
    // The guard on the guard. Every assertion above reads the Markdown, which
    // is generated — so a money figure living only in HTML markup the builder
    // drops would be unchecked. The builder keeps `<strong>` and plain text,
    // which is everything the document uses for money; this pins that.
    const bundlesInHtml = [...html.matchAll(/<strong>([A-Za-z]+) £([0-9,]+)<\/strong>\s*\(([0-9,]+)/g)];
    const bundlesInMarkdown = [...markdown.matchAll(/\*\*([A-Za-z]+) £([0-9,]+)\*\* \(([0-9,]+)/g)];
    assert.equal(
      bundlesInHtml.length,
      bundlesInMarkdown.length,
      'the HTML states a bundle figure the Markdown does not carry, so it is never checked',
    );
  });
});
