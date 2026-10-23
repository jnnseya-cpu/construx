import { api } from '../lib/api.js';
import { barChart, heatmap, pieChart } from '../lib/charts.js';
import { head, providerName, refusal } from '../lib/estate.js';
import { command, commandBar } from '../lib/command.js';
import { blockedReason, can } from '../app.js';
import { badge, date, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

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
  const [plane, evaluation, agents, ladder, credentials] = await Promise.all([
    api.get('/v1/ai/control-plane').catch((error) => ({ error })),
    api.get('/v1/admin/ai/evaluation').catch((error) => ({ error })),
    api.get('/v1/agents/fleet').catch(() => null),
    api.get('/v1/agents/ladder').catch(() => null),
    // Which keys this deployment holds. Never a value — the route has none to
    // return, which is the property the whole store exists to have.
    api.get('/v1/admin/platform-credentials').catch((error) => ({ error })),
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
          <h2 style="padding:15px 17px 0">Keys</h2>
          <div class="metric-sub" style="padding:0 17px 10px">
            <!--
              The panel that ends the SSH session. What is deliberately absent
              is any way to read a key back: the route has no value to return,
              because the platform needs one and nobody else does — including
              the operator who typed it. The key id is eight hex characters of
              its SHA-256, which tells one key from another and confirms a
              rotation landed without being a key.
            -->
            Set from here rather than from a shell. The value is encrypted into a store beside the journal and never
            enters the ledger — that chain is append-only and is copied into every backup, so a key written there
            could not be rotated out by anybody. What the chain records is that you set it, when and why.
          </div>
          ${credentials?.error
            ? html`<div style="padding:0 17px 14px">${refusal('The credential register', credentials.error)}</div>`
            : html`
                <div style="padding:0 17px 11px">
                  ${raw(commandBar([
                    { id: 'set-credential', label: 'Set a key',
                      permitted: can('PLATFORM_ADMINISTRATION', 'U'), reason: blockedReason('PLATFORM_ADMINISTRATION', 'U') },
                    { id: 'clear-credential', label: 'Clear one', tone: 'quiet',
                      permitted: can('PLATFORM_ADMINISTRATION', 'U'), reason: blockedReason('PLATFORM_ADMINISTRATION', 'U') },
                    // The platform's half of retiring a superseded key. Offered
                    // only where there is actually a file copy to retire, or
                    // one already retired to put back — otherwise it is a
                    // control about a situation this deployment is not in.
                    { id: 'confirm-gone', label: 'Confirm the old key is gone', tone: 'quiet',
                      permitted:
                        can('PLATFORM_ADMINISTRATION', 'U') &&
                        (credentials?.credentials ?? []).some((entry) => (entry.outstanding ?? []).length > 0),
                      reason: blockedReason('PLATFORM_ADMINISTRATION', 'U')
                        ?? 'Nothing is outstanding. This clears the two jobs the platform cannot see, once a retired key is actually gone.' },
                    { id: 'retire-environment', label: 'Retire the file copy', tone: 'quiet',
                      permitted:
                        can('PLATFORM_ADMINISTRATION', 'U') &&
                        (credentials?.credentials ?? []).some((entry) => entry.fromEnvironment || entry.environmentRetired),
                      reason: blockedReason('PLATFORM_ADMINISTRATION', 'U')
                        ?? 'Nothing is supplied from the environment on this deployment, so there is no file copy to take out of service.' },
                  ]))}
                </div>
                ${table({
                  headers: ['Credential', 'Where from', 'Key', 'Set', 'What stops without it'],
                  rows: (credentials?.credentials ?? []).map((entry) => [
                    html`${entry.label}<div class="metric-sub"><code>${entry.name}</code></div>`,
                    // Both, where both hold one.
                    //
                    // A single badge read "this store" and said nothing about
                    // the environment still carrying a key — which is exactly
                    // the key nobody is tracking: superseded, unused, often
                    // revoked at the vendor, and still sitting in a file on the
                    // host. The operator who set one from here is the person
                    // who needs to be told to go and remove the other.
                    entry.stored
                      ? html`${badge('this store', 'ok')}${
                          entry.environmentRetired
                            ? html`${badge('file copy retired', 'ok')}
                                ${
                                  /*
                                   * The two jobs the platform cannot do, and
                                   * cannot see — until somebody says they are
                                   * done. This stated both for ever, so an
                                   * operator who had already run the command
                                   * and revoked the key was told to do it
                                   * again on every visit, and a warning
                                   * nobody can clear is one everybody stops
                                   * reading. It clears on an attestation,
                                   * with the name against it on the chain.
                                   */
                                  (entry.outstanding ?? []).length === 0
                                    ? html`<div class="metric-sub" style="margin-top:4px">
                                        Out of <code>.env</code> and revoked at the vendor, confirmed
                                        ${entry.retired?.revokedAt ? date(entry.retired.revokedAt) : ''}.
                                      </div>`
                                    : html`<div class="metric-sub" style="margin-top:4px">
                                        What is in <code>.env</code> is inert — the platform will not read it again.
                                        Housekeeping, whenever you get to it: take the line out of the file and revoke
                                        the key at the vendor, then press <b>Confirm the old key is gone</b> if you
                                        want that on the record. Nothing here is waiting on it.
                                      </div>`
                                }`
                            : entry.fromEnvironment
                              ? html`${badge('and in .env', 'warn')}
                                  <div class="metric-sub" style="margin-top:4px">
                                    The environment also holds one and it is not being used — but clearing this store
                                    would fall straight back to it, and it is usually the key that was just revoked.
                                    Press <b>Retire the file copy</b> to stop the platform reading it at all.
                                  </div>`
                              : ''
                        }`
                      : entry.fromEnvironment && !entry.environmentRetired
                        ? badge('environment', '')
                        : entry.environmentRetired
                          ? html`${badge('not set', 'bad')}${badge('file copy retired', '')}`
                          : badge('not set', 'bad'),
                    // The id, never the key. Shown for the stored one only:
                    // the platform does not hash what the environment holds,
                    // because that would mean reading it to describe it.
                    entry.keyId ? html`<code style="font-size:11px">${entry.keyId}</code>` : '—',
                    entry.setAt
                      ? html`${date(entry.setAt)}<div class="metric-sub">${entry.reason ?? ''}</div>`
                      : '—',
                    html`<span style="font-size:12.5px;color:var(--text-3)">${entry.unlocks}</span>`,
                  ]),
                  empty: 'No credential is configurable on this deployment.',
                })}
                ${credentials?.note
                  ? html`<div class="metric-sub" style="padding:10px 17px 14px">${credentials.note}</div>`
                  : ''}
              `}
        </div>
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">What each engine asks of each kind of model</h2>
          <div class="metric-sub" style="padding:0 17px 10px">
            <!--
              This read "Capability / Goes to" and put each row through
              providerName, which rendered [object Object] in every row of a
              live deployment. ROUTING_MATRIX does not map an engine to a
              vendor: it names, per engine, the work that needs a model which
              reads and the work that needs one which reasons. Which vendor
              serves each of those two kinds is the pair of cards above, and it
              is a different question - one is the platform's design, the other
              is this deployment's configuration.
            -->
            The platform's own design, not this deployment's configuration: which work needs a model that reads and
            which needs one that reasons. Which vendor serves each kind is above, and the ACU economy screen shows
            where the spend actually went.
          </div>
          ${table({
            headers: ['Engine', 'Needs a model that reads', 'Needs a model that reasons'],
            rows: Object.entries(plane.routingMatrix ?? {}).map(([engine, kinds]) => [
              humanise(engine),
              (kinds?.perception ?? []).join(' · ') || '—',
              (kinds?.reasoning ?? []).join(' · ') || '—',
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

  /*
   * Setting a key, and clearing one.
   *
   * The value field is ordinary text rather than a password input on purpose:
   * an operator pasting a 164-character key needs to be able to see that it
   * arrived whole, and the commonest failure on this box was a truncated
   * paste. It is never rendered back, so there is nothing to conceal on a
   * second visit.
   */
  for (const button of root.querySelectorAll('[data-command="set-credential"]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: 'Set a key',
        intent:
          'Encrypted into a store beside the journal, never into the ledger — that chain is append-only and copied ' +
          'into every backup, so a key written there could not be rotated out. The chain records that you set it, ' +
          'when and why. Nothing here, and no route anywhere, reads a key back.',
        path: (values) => `/v1/admin/platform-credentials/${values.name}`,
        submitLabel: 'Set it',
        fields: [
          { name: 'name', label: 'Which', type: 'select',
            options: (credentials?.credentials ?? []).map((entry) => ({
              value: entry.name,
              label: `${entry.label}${entry.stored ? ' — replacing the one stored' : entry.fromEnvironment ? ' — overriding the environment' : ''}`,
            })) },
          { name: 'value', label: 'The key', type: 'text',
            hint: 'Paste it whole, with no quotes. A vendor shows a secret once, at creation — there is nothing to copy from their list afterwards.' },
          { name: 'reason', label: 'Why', type: 'text',
            hint: 'Recorded against the decision. "Rotated after the old one was revoked."' },
        ],
        transform: ({ name: _n, ...rest }) => rest,
      });
      if (result) {
        toast('Set', result.effect, 'ok');
        aiengine(root);
      }
    });
  }

  /*
   * Retiring the copy in `.env`, which is the platform's half of a rotation.
   *
   * Reported from a live deployment: a key was rotated from this screen and the
   * superseded one stayed in the file on the host. Nothing here can delete it —
   * that file is the deployment's configuration rather than this application's
   * data, and an application that rewrites its own configuration is one nobody
   * can reason about after an incident. What the platform can do is refuse to
   * read it again, and say plainly which two things are still somebody's job.
   */
  for (const button of root.querySelectorAll('[data-command="confirm-gone"]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: 'Confirm the old key is gone',
        intent:
          'The platform cannot see your host\u2019s .env and cannot see the vendor\u2019s console, so it cannot check ' +
          'either of these. It records that you did them, with your name and the date, and stops asking. That is a ' +
          'better answer for an access review than a warning everybody learned to ignore.',
        path: (values) => `/v1/admin/platform-credentials/${values.name}/confirm-gone`,
        submitLabel: 'Confirm',
        fields: [
          { name: 'name', label: 'Which', type: 'select',
            options: (credentials?.credentials ?? [])
              .filter((entry) => (entry.outstanding ?? []).length > 0)
              .map((entry) => ({
                value: entry.name,
                label: `${entry.label} — outstanding: ${(entry.outstanding ?? [])
                  .map((item) => (item === 'FILE' ? 'the .env line' : 'revoking at the vendor'))
                  .join(' and ')}`,
              })) },
          { name: 'fileRemoved', label: 'The line is out of .env on the host', type: 'checkbox', value: true },
          { name: 'revokedAtVendor', label: 'The key is revoked at the vendor', type: 'checkbox', value: true },
        ],
        transform: ({ name: _n, ...rest }) => rest,
      });
      if (result) {
        toast('Recorded', result.effect, result.outstanding?.length === 0 ? 'ok' : 'warn');
        aiengine(root);
      }
    });
  }

  for (const button of root.querySelectorAll('[data-command="retire-environment"]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: 'Retire the copy in the environment',
        intent:
          'The platform stops reading this credential from the environment, for good — so a superseded key sitting ' +
          'in .env on the host becomes inert, and clearing the store later leaves the capability off and says so ' +
          'rather than quietly falling back to a key somebody already revoked. It does not delete the file and it ' +
          'cannot revoke anything at the vendor; both of those are still yours, and the row says so afterwards.',
        path: (values) => `/v1/admin/platform-credentials/${values.name}/environment`,
        submitLabel: 'Apply',
        fields: [
          { name: 'name', label: 'Which', type: 'select',
            options: (credentials?.credentials ?? [])
              .filter((entry) => entry.fromEnvironment || entry.environmentRetired)
              .map((entry) => ({
                value: entry.name,
                label: `${entry.label}${entry.environmentRetired ? ' — already retired' : entry.stored ? ' — superseded by the store' : ' — in use from the environment'}`,
              })) },
          { name: 'retired', label: 'Stop reading it', type: 'checkbox', value: true,
            hint: 'Unticked, the platform reads the environment again — the way back for one retired by mistake.' },
          { name: 'reason', label: 'Why', type: 'text',
            hint: 'Recorded against the decision. "Rotated on 23 October; the old key is revoked at the vendor."' },
        ],
        transform: ({ name: _n, ...rest }) => rest,
      });
      if (result) {
        toast(result.environmentRetired ? 'Retired' : 'Restored', result.effect, 'ok');
        aiengine(root);
      }
    });
  }

  for (const button of root.querySelectorAll('[data-command="clear-credential"]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: 'Clear a key',
        intent:
          'Takes the override out of the store. Not the same as setting an empty one: the platform falls back to ' +
          'whatever the environment holds, which may be nothing — and where it is nothing, what that key unlocks ' +
          'stops.',
        path: (values) => `/v1/admin/platform-credentials/${values.name}/clear`,
        submitLabel: 'Clear it',
        fields: [
          { name: 'name', label: 'Which', type: 'select',
            options: (credentials?.credentials ?? [])
              .filter((entry) => entry.stored)
              .map((entry) => ({
                value: entry.name,
                label: `${entry.label}${entry.fromEnvironment ? ' — falls back to the environment' : ' — nothing else supplies it'}`,
              })) },
          { name: 'reason', label: 'Why', type: 'text' },
        ],
        transform: ({ name: _n, ...rest }) => rest,
      });
      if (result) {
        toast('Cleared', result.effect, result.fromEnvironment ? 'ok' : 'warn');
        aiengine(root);
      }
    });
  }

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
