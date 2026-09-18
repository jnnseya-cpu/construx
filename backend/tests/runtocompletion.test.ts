import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ACUWallet, effectiveMultiplier } from '../src/billing/acu.ts';
import { config } from '../src/config.ts';

/**
 * AI work is not cut short by a clock or by a limit.
 *
 * The business rule, in one file, because it is enforced in four places that
 * have nothing else to do with each other and a reader asking "is this actually
 * true" should not have to find all four:
 *
 *   - **Time** — no deadline on a provider call (`ai/providers/*.ts`).
 *   - **Quality** — the output standard is corrected until it validates, not
 *     twice (`ai/outputstandard.ts`, asserted in `outputstandard.test.ts`).
 *   - **Limits** — a customer's cap is signalled and named on the entry rather
 *     than enforced against an AI run (`billing/acu.ts`).
 *   - **The screen** — a cap about to be passed is shown as a cost and the
 *     button stays live, because the platform will run it
 *     (`frontend/lib/command.js`).
 *
 * **The balance is not in scope and never was.** Sufficient ACUs have to be
 * available, and no ACUs means no AI. Nothing here runs a provider on credit,
 * so the platform never lays out money it cannot bill and a customer never
 * receives a charge they did not fund first. That boundary is asserted below,
 * because a rule stated without its limits is a rule somebody will apply where
 * it does not belong.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the rule is on, and says so in one place', () => {
  it('runs to completion by default, with no deadline and no attempt ceiling', () => {
    assert.equal(config.ai.runToCompletion, true, 'AI work is being cut short by default');
    assert.equal(config.ai.providerDeadlineMs, 0, 'a provider call carries a deadline');
    assert.equal(config.ai.maxCorrectionAttempts, 0, 'the correction loop has a ceiling');
    // The one bound, and it is not a cost or time cap: it is the point at which
    // the model has demonstrably stopped converging.
    assert.ok(config.ai.noProgressAttempts >= 2, 'the no-progress rule would stop a converging run');
  });

  it('attaches no abort signal to a provider call while the deadline is zero', () => {
    /*
     * Read out of the adapters rather than asserted about behaviour, because
     * the failure mode is a hardcoded number creeping back into a transport
     * file — which is exactly where the 120-second one was.
     *
     * **Comments are stripped first.** The first version of this failed on its
     * own explanation: the comment in `remote.ts` quotes the literal it exists
     * to warn about, and a scan that reads comments finds the thing it is
     * looking for in the sentence saying not to do it. The same mistake the
     * chart-call scanner made, and the same fix.
     */
    const code = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const file of ['ai/providers/remote.ts', 'ai/providers/embedding.ts']) {
      const source = code(readFileSync(join(REPO, 'backend', 'src', file), 'utf8'));
      assert.doesNotMatch(
        source,
        /AbortSignal\.timeout\(\s*\d/,
        `${file} hardcodes a provider deadline again`,
      );
      assert.match(source, /config\.ai\.providerDeadlineMs/, `${file} does not read the configured deadline`);
    }
  });

  it('would still catch a hardcoded deadline, so the comment stripping did not blind it', () => {
    // The guard on the guard: a scan that strips comments could equally strip
    // the code, and a check that can no longer fail is a check that is gone.
    const strip = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const withLiteral = 'const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });';
    assert.match(strip(withLiteral), /AbortSignal\.timeout\(\s*\d/);
    assert.doesNotMatch(strip('// AbortSignal.timeout(120_000) is what this replaced'), /AbortSignal\.timeout\(\s*\d/);
  });
});

describe('money: the balance binds, and a cap does not', () => {
  const rate = effectiveMultiplier(0, false);

  it('refuses an empty balance for AI exactly as for anything else', () => {
    // Prepaid means prepaid. No ACUs means no AI, and the AI path is not an
    // exception to it — nothing runs a provider on credit.
    const wallet = new ACUWallet('run-to-completion');
    for (const runToCompletion of [false, true]) {
      assert.throws(
        () => wallet.reserve({ aiRequestId: 'r', estimatedRawCostMinor: 10, runToCompletion }),
        (error: { code?: string }) => error.code === 'ACU_EXHAUSTED',
        `an empty wallet reserved with runToCompletion=${runToCompletion}`,
      );
    }
    assert.equal(wallet.snapshot().balanceMinor, 0);
    assert.equal(wallet.snapshot().aiHalted, true);
  });

  it('passes a cap for AI, refuses it for everything else, and never goes negative', () => {
    const wallet = new ACUWallet('capped');
    wallet.topUp(100 * rate);
    wallet.setCaps({ monthlyMinor: 1 });

    // A document render or a spatial compute: a fixed job priced up front.
    assert.throws(
      () => wallet.reserve({ aiRequestId: 'render', estimatedRawCostMinor: 10 }),
      (error: { code?: string }) => error.code === 'ACU_EXHAUSTED',
    );

    // An AI run: it finishes, because a ceiling does not cut a task in half.
    const hold = wallet.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 10, runToCompletion: true });
    assert.match(String(hold.authorisedOverrun), /cap/i);
    const entry = wallet.settle(hold.holdId, 10, 'OPENAI');

    // Charged against the funded balance as normal. Nothing given away, and
    // nothing owed: the arithmetic is exactly what it was before the rule.
    assert.equal(entry.billedMinor, 10 * rate);
    assert.equal(wallet.snapshot().balanceMinor, 100 * rate - 10 * rate);
    assert.ok(wallet.snapshot().balanceMinor > 0, 'a cap breach took the balance negative');
    // And the balance is still the sum of its entries.
    const summed = wallet.entries().reduce(
      (total, e) => total + (e.type === 'DEBIT' ? -e.billedMinor : e.type === 'HOLD' || e.type === 'RELEASE' ? 0 : e.billedMinor),
      0,
    );
    assert.equal(summed, wallet.snapshot().balanceMinor);
  });

  it('says on the entry that it passed a cap, so the invoice line does too', () => {
    const wallet = new ACUWallet('disclosed');
    wallet.topUp(100 * rate);
    wallet.setCaps({ monthlyMinor: 1 });
    const hold = wallet.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 10, runToCompletion: true });
    const entry = wallet.settle(hold.holdId, 10, 'OPENAI');
    assert.ok(entry.note, 'a charge past a cap carried no explanation');
    assert.match(String(entry.note), /cap/i);
  });

  it('charges the same multiple of provider cost it always did', () => {
    // Stated here as well as in `economics.test.ts`, because this is the file a
    // reader opens to find out what the run-to-completion rule changed — and
    // the answer about the price is "nothing".
    const wallet = new ACUWallet('price');
    wallet.topUp(1_000_000);
    const hold = wallet.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 250, runToCompletion: true });
    const entry = wallet.settle(hold.holdId, 250, 'OPENAI');
    assert.equal(entry.effectiveMultiplier, effectiveMultiplier(0, false));
    assert.equal(entry.billedMinor, 250 * effectiveMultiplier(0, false));
  });
});

describe('what the rule deliberately does not override', () => {
  it('the balance, because prepaid means prepaid', () => {
    const wallet = new ACUWallet('short');
    wallet.topUp(10);
    assert.throws(
      () => wallet.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 100, runToCompletion: true }),
      (error: { code?: string }) => error.code === 'ACU_EXHAUSTED',
    );
    assert.equal(wallet.snapshot().balanceMinor, 10, 'a refused reservation moved the balance');
  });

  it('a wallet frozen by a payment dispute', () => {
    const wallet = new ACUWallet('frozen');
    wallet.topUp(1_000_000);
    wallet.freeze('Chargeback raised on the last card payment');
    assert.throws(
      () => wallet.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 1, runToCompletion: true }),
      (error: { code?: string }) => error.code === 'WALLET_FROZEN',
    );
  });

  it('a sponsorship limit, because that is a third party’s money', () => {
    // Asserted where it lives — `crossorg.test.ts` drives the refusal end to
    // end. Pinned here as a statement of scope: one organisation approving a
    // spend limit for another organisation's person is consent, not a budget,
    // and `overageAllowed` is the sponsor's own control for lifting it.
    const source = readFileSync(join(REPO, 'backend', 'src', 'engines', 'context.ts'), 'utf8');
    assert.match(source, /ACU_LIMIT_EXCEEDED/, 'the sponsorship ceiling stopped refusing');
    assert.match(source, /overageAllowed/, 'the sponsor lost the control that lifts it');
  });
});

describe('the screen tells the truth about what the button will do', () => {
  const command = readFileSync(join(REPO, 'frontend', 'lib', 'command.js'), 'utf8');

  it('shows a cap about to be passed as a cost rather than as a block', () => {
    assert.match(command, /quoteOverrunText/, 'the console never words a cap it is about to pass');
    assert.match(command, /overrunReason/, 'the console never reads what the platform published');
    // And an empty balance is still rendered as the refusal it is.
    assert.match(command, /quoteBlockedText/);
  });

  it('leaves the button live, because the platform will run it', () => {
    // `affordable` is false only where the quote actually refuses, and under
    // the rule an overrun does not. A screen that disabled the button here
    // would be telling somebody a live control is dead.
    assert.match(command, /submit\.disabled = !quote\.affordable/);
    const source = readFileSync(join(REPO, 'backend', 'src', 'ai', 'orchestrator.ts'), 'utf8');
    assert.match(source, /affordable: priced\.blockedReason === undefined/);
  });
});
