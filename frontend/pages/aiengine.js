import { api } from '../lib/api.js';
import { barChart, heatmap, pieChart } from '../lib/charts.js';
import { head, providerName, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * The AI engine.
 *
 * Two questions, and they are not the same one: **is a model reachable**, and
 * **is it doing what the platform depends on it doing**. Provider health answers
 * the first. The evaluation harness answers the second, and the console had it
 * buried three screens down a scroll.
 *
 * The harness is deliberately **not a score**. On the local engines the "model"
 * is a hash of its inputs, and grading that would produce a number nobody could
 * check. What it asserts is the properties the platform depends on — the
 * accounting a stage gate reads, the engine's arithmetic surviving the model,
 * the refusals, and that an instruction hidden in site text moves no governed
 * outcome. **Drift is the figure to read**: a case that used to pass and now
 * does not means the platform changed under a check somebody was relying on.
 */

export async function aiengine(root) {
  const [plane, evaluation, agents, ladder] = await Promise.all([
    api.get('/v1/ai/control-plane').catch((error) => ({ error })),
    api.get('/v1/admin/ai/evaluation').catch((error) => ({ error })),
    api.get('/v1/agents/fleet').catch(() => null),
    api.get('/v1/agents/ladder').catch(() => null),
  ]);

  if (plane.error) {
    render(root, html`${head({ title: 'AI engine' })}${refusal('The AI control plane', plane.error)}`);
    return;
  }

  const providers = plane.available ?? [];

  /** What a vendor keeps, short enough for a badge. */
  const retentionLabel = (retention) => {
    if (!retention) return 'retention unknown';
    if (retention.route === 'ZERO') return 'keeps nothing';
    if (retention.route === 'TRANSIENT') return retention.days ? `keeps ${retention.days}d` : 'keeps briefly';
    if (retention.route === 'RETAINED') return retention.days ? `retains ${retention.days}d` : 'retains';
    return 'retention undeclared';
  };
  const healthy = providers.filter((provider) => provider.healthy);
  const drift = evaluation.error ? [] : (evaluation.drift?.changed ?? []);
  const latest = evaluation.error ? null : evaluation.latest;

  render(
    root,
    html`
      ${head({
        title: 'AI engine',
        intent:
          'Which providers are reachable, what the platform routes to them, and whether the properties the platform ' +
          'depends on still hold. A provider appears here only when it is keyed.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Providers live</h2>
          <div class="metric ${raw(healthy.length === 0 ? 'bad' : plane.mode === 'local' ? 'info' : 'good')}">
            ${healthy.length} of ${providers.length}
          </div>
          <div class="metric-sub">mode: ${plane.mode ?? '—'}</div>
        </div>
        <div class="card">
          <h2>Reasoning</h2>
          <div class="metric ${raw(plane.reasoning?.healthy ? 'good' : 'bad')}">${providerName(plane.reasoning?.provider ?? '—')}</div>
          <div class="metric-sub">${plane.reasoning?.healthy ? 'answering' : 'not answering — traffic fails over'}</div>
        </div>
        <div class="card">
          <h2>Perception</h2>
          <div class="metric ${raw(plane.perception?.healthy ? 'good' : 'bad')}">${providerName(plane.perception?.provider ?? '—')}</div>
          <div class="metric-sub">drawings, title blocks and voice</div>
        </div>
        <div class="card">
          <h2>Checks changed</h2>
          <div class="metric ${raw(drift.length > 0 ? 'bad' : '')}">${evaluation.error ? '—' : drift.length}</div>
          <div class="metric-sub">
            ${evaluation.error ? 'the harness could not be read' : latest ? `since the run before, last run ${time(latest.ranAt)}` : 'the harness has never run'}
          </div>
        </div>
      </section>

      ${aiCharts(plane, evaluation, agents)}


      ${healthy.length === 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>No AI provider is answering.</b><br />
              The platform falls back to the local stand-in, which reasons about nothing and answers every request with
              the same sentence. Everything it produces is marked as synthetic, and anything that would publish
              synthetic prose under the company's name — a blog draft, a document narrative — is refused rather than
              dressed up. Set a provider key to change this.
            </div>
          </div>`
        : ''}

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h2>Providers</h2>
          <div class="split-list">
            ${providers.map(
              (provider) => html`<div class="row">
                <span class="lbl">${providerName(provider.provider)}</span>
                <span class="val">
                  ${badge(humanise(provider.role), provider.role === 'FAILOVER' ? 'info' : 'ai')}
                  ${badge(provider.healthy ? 'live' : 'unhealthy', provider.healthy ? 'ok' : 'bad')}
                  ${
                    // What happens to a customer's record once this vendor has
                    // it — §16.1. Beside the health badge because an operator
                    // reading this list is deciding which vendors to keep, and
                    // "reachable" was never the whole question.
                    provider.transmits === false
                      ? badge('stays here', 'ok')
                      : badge(retentionLabel(provider.retention), provider.retention?.route === 'NOT_DECLARED' ? 'warn' : 'info')
                  }
                  ${
                    // And what it may be *sent*, which is the half that decides
                    // whether work runs. This panel said "live" and stopped
                    // there, so a deployment whose vendors are all capped at
                    // ordinary project records read as fully working while
                    // writing a tender submission was refused before a provider
                    // was contacted. The control plane has carried `clearance`
                    // all along; nothing rendered it.
                    provider.transmits !== false && provider.clearance
                      ? badge(
                          `≤ ${humanise(provider.clearance).toLowerCase()}`,
                          provider.clearance === 'LEGAL_L4' ? 'ok' : 'warn',
                        )
                      : ''
                  }
                </span>
              </div>`,
            )}
          </div>
          ${
            (plane.undeclaredRetention ?? []).length > 0
              ? html`<div class="notice warn" style="margin-top:12px">
                  <div>
                    <b>${plane.undeclaredRetention.length} vendor${plane.undeclaredRetention.length === 1 ? '' : 's'}
                    can be sent customer records under terms nobody here has declared.</b><br />
                    ${plane.undeclaredRetention.join(', ')}. Every AI panel says so before the button, which is honest
                    and is not a substitute for reading the agreement. Set <code>AI_PROVIDER_RETENTION</code> once it is
                    known — it is a statement about a contract, so the platform cannot discover it.
                  </div>
                </div>`
              : ''
          }
          <div class="metric-sub" style="margin-top:12px">
            A <b>failover</b> engine is one nothing routes to until a primary fails. It is still a vendor the platform
            can spend money with, which is why it is listed rather than hidden — the bill arrives whether or not the
            routing table expected it.
          </div>
        </div>
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">What routes where</h2>
          <div class="metric-sub" style="padding:0 17px 10px">
            The configured matrix. Realised routing differs from this every time a provider is unhealthy, and the ACU
            economy screen shows the realised split.
          </div>
          ${table({
            headers: ['Capability', 'Goes to'],
            rows: Object.entries(plane.routingMatrix ?? {}).map(([capability, provider]) => [
              humanise(capability),
              providerName(provider),
            ]),
            empty: 'No routing is configured.',
          })}
        </div>
      </div>

      ${evaluation.error
        ? refusal('The AI evaluation harness', evaluation.error)
        : html`<div class="card" id="ai-evaluation" style="margin-bottom:14px">
            <h2>Evaluation harness</h2>
            <div class="metric-sub" style="margin:8px 0 14px">
              ${evaluation.cases.length} checks on the properties the platform depends on — not a score for the model's
              judgement, which on the local engines would be grading a hash. Includes a prompt-injection suite: the
              claim it makes is that the defences are structural, so an instruction hidden in site text cannot move a
              governed outcome.
            </div>

            <div class="split-list">
              <div class="row">
                <span class="lbl">Last run</span>
                <span class="val">${latest ? `${time(latest.ranAt)} · against ${latest.against}` : 'never'}</span>
              </div>
              <div class="row">
                <span class="lbl">Passing</span>
                <span class="val">${latest ? `${latest.passed} of ${latest.cases.length}` : '—'}</span>
              </div>
              <div class="row">
                <span class="lbl">Changed since the run before</span>
                <span class="val">${badge(String(drift.length), drift.length > 0 ? 'bad' : 'ok')}</span>
              </div>
            </div>

            ${drift.length > 0
              ? html`<div class="notice bad" style="margin-top:14px"><div>
                  ${drift.map((item) => html`<div><b>${item.id}</b> was ${item.was}, is now ${item.now}</div>`)}
                </div></div>`
              : ''}

            ${latest
              ? html`<div style="margin-top:14px">
                  ${table({
                    headers: ['Check', 'Kind', 'Result', 'What it observed'],
                    rows: latest.cases.map((item) => [
                      item.title,
                      humanise(item.kind),
                      badge(item.outcome, item.outcome === 'PASS' ? 'ok' : 'bad'),
                      item.detail,
                    ]),
                    empty: 'Nothing has been checked.',
                  })}
                </div>`
              : html`<div class="metric-sub" style="margin-top:12px">
                  ${evaluation.cases.map((item) => html`<div>${item.title}</div>`)}
                </div>`}

            <div class="actions" style="margin-top:14px">
              <button class="btn quiet sm" id="run-evaluation">Run the harness</button>
              <!--
                Asks each vendor directly, because the health flag cannot: it is
                a circuit breaker — a key is set and fewer than three calls have
                failed — so at boot it says yes, and a deployment where every
                reading came back Not read was reading healthy true on this very
                screen. No backticks in here: this comment sits inside a
                template literal, and one would end the string.
              -->
              <button class="btn quiet sm" id="probe-providers">Call each provider now</button>
            </div>
          </div>`}

      ${agents && !agents.error
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">The agent fleet</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Every agent, with the mandate it can never exceed. ${
                ladder && !ladder.error
                  ? `Four rungs: ${(ladder.rungs ?? []).map((rung) => rung.id).join(' → ')}. No agent's mandate reaches EXECUTE on a governed decision.`
                  : ''
              }
            </div>
            ${table({
              headers: ['Agent', 'Division', 'Mandate', 'What it may do'],
              rows: (agents.agents ?? agents.fleet ?? []).flatMap((entry) =>
                entry.agents
                  ? entry.agents.map((agent) => [agent.name, humanise(entry.division ?? ''), badge(agent.mandate, 'ai'), agent.purpose ?? '—'])
                  : [[entry.name, humanise(entry.division ?? ''), badge(entry.mandate ?? '—', 'ai'), entry.purpose ?? '—']],
              ),
              empty: 'No agent is registered.',
            })}
          </div>`
        : ''}
    `,
  );

  document.getElementById('probe-providers')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Calling…';
    try {
      const result = await api.post('/v1/admin/ai/probe', {});
      const providers = result.providers ?? [];
      const failed = providers.filter((entry) => !entry.ok);
      // Answering is half the question. A provider that answers and is cleared
      // for nothing above ordinary project records will still refuse every
      // tender, contract and claim — and the probe cannot discover that by
      // calling, because the probe carries no records of its own.
      const capped = providers.filter((entry) => (entry.refusedWork ?? []).length > 0);
      toast(
        failed.length > 0
          ? `${failed.length} of ${providers.length} could not answer`
          : capped.length > 0
            ? `Every provider answered — ${capped.length} cleared only for ordinary project records`
            : 'Every provider answered',
        providers
          .map((entry) =>
            `${entry.provider}: ${entry.ok ? 'answered' : entry.detail}` +
            ((entry.refusedWork ?? []).length > 0 ? ` — cannot be sent ${entry.refusedWork.join('; ')}` : ''),
          )
          .join(' · ') || `AI_MODE is ${result.mode} — no provider is called.`,
        failed.length > 0 ? 'err' : capped.length > 0 ? 'warn' : 'ok',
      );
    } catch (error) {
      toast('Could not probe', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Call each provider now';
  });

  document.getElementById('run-evaluation')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    // Said out loud: it builds a whole demonstration project so it never writes
    // into a real one, and that is not instant.
    button.textContent = 'Running on a fresh project…';
    try {
      const result = await api.post('/v1/admin/ai/evaluation', { against: 'local' });
      toast(
        'Evaluation complete',
        `${result.run.passed} of ${result.run.cases.length} passing` +
          (result.drift.changed.length > 0 ? ` — ${result.drift.changed.length} changed since the last run` : ''),
        result.run.failed > 0 || result.drift.changed.length > 0 ? 'warn' : 'ok',
      );
      await aiengine(root);
    } catch (error) {
      toast('Evaluation failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Run the harness';
    }
  });
}

/**
 * What the AI layer is allowed to do, and what has been proved about it.
 *
 * The routing matrix is the centre of this screen and was a nested list. Drawn
 * as a grid of engine against capability, the question an operator has — which
 * engines depend on a provider that is currently unhealthy — is one read rather
 * than a scroll.
 *
 * The evaluation cases are the other half. They are not a test count: each case
 * names the property it protects, and the mix by kind says what the platform
 * has actually bothered to prove. Accounting cases outnumbering boundary cases
 * would be a platform that can bill correctly and cannot say what it refused.
 */
function aiCharts(plane, evaluation, agents) {
  const providers = (plane?.error ? [] : plane?.available ?? []).map((provider) => ({
    label: `${humanise(String(provider.provider))} · ${humanise(String(provider.role))}`,
    value: 1,
    tone: provider.healthy ? 'ok' : 'bad',
  }));

  const cases = Object.entries(
    (evaluation?.error ? [] : evaluation?.cases ?? []).reduce((counts, entry) => {
      const kind = humanise(String(entry.kind ?? 'OTHER'));
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {}),
  )
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  // Engines down the side, the two capability kinds across. The cell is how
  // many named capabilities that engine draws from that kind of model.
  const matrix = plane?.error ? {} : plane?.routingMatrix ?? {};
  const engines = Object.keys(matrix);
  const columns = ['Perception', 'Reasoning'];
  const values = engines.map((engine) => [
    (matrix[engine]?.perception ?? []).length,
    (matrix[engine]?.reasoning ?? []).length,
  ]);

  if (providers.length === 0 && cases.length === 0 && engines.length === 0) return '';

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Which engines depend on which kind of model</h2>
      ${raw(
        heatmap({
          title: 'Named capabilities by engine and model kind',
          rows: engines.map((engine) => humanise(engine)),
          columns,
          values,
          format: (value) => `${value} capabilit${value === 1 ? 'y' : 'ies'}`,
          empty: 'No routing matrix is published.',
          footnote:
            `Reasoning runs on ${plane?.reasoning?.provider ? humanise(String(plane.reasoning.provider)) : 'no provider'}` +
            `${plane?.reasoning && plane.reasoning.healthy === false ? ', which is unhealthy' : ''}; perception on ` +
            `${plane?.perception?.provider ? humanise(String(plane.perception.provider)) : 'no provider'}` +
            `${plane?.perception && plane.perception.healthy === false ? ', which is unhealthy' : ''}. ` +
            'A dark row is an engine that stops when that provider does.',
        }),
      )}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What the platform has proved about its own AI</h2>
        ${raw(
          pieChart({
            title: 'Evaluation cases by kind',
            data: cases,
            centreLabel: String((evaluation?.error ? [] : evaluation?.cases ?? []).length),
            format: (value) => `${value} case${value === 1 ? '' : 's'}`,
            empty: 'No evaluation case is published.',
            footnote:
              'Each case names the property it protects, not a feature it tests. The mix is what the platform has ' +
              'bothered to prove — accounting cases far outnumbering boundary cases would be a platform that bills ' +
              'correctly and cannot say what it refused.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Which providers are answering</h2>
        ${raw(
          barChart({
            title: 'Providers by role and health',
            horizontal: true,
            data: providers,
            format: () => 'available',
            empty: 'No provider is configured, so nothing is called and nothing is charged.',
            footnote:
              `Mode ${humanise(String(plane?.mode ?? 'unknown'))}. ` +
              'The orchestrator routes to a healthy provider and falls back; on an empty wallet it refuses to call one ' +
              'at all, so no charge can exist without a ledger write.',
          }),
        )}
      </div>
    </div>
  `;
}
