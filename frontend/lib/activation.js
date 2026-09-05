import { api } from './api.js';
import { exact, html, raw, render } from './ui.js';

/**
 * The activation popup a paying account sees once subscribed.
 *
 * Two steps. *Activate <company>'s subscription*: the plan, its price, the
 * first month due today and the renewal each month until cancelled. Then *How
 * will you pay, going forward?*: Direct Debit or a recurring card, and the
 * authorisation sentence the person ticks. The authorisation is recorded on the
 * platform word for word; the popup then hands the first month to whichever
 * rail the deployment can actually take — card checkout where Stripe is
 * configured, a bank transfer against the reference otherwise — and says so
 * rather than implying a collection that cannot yet happen.
 *
 * Shown to somebody who can act on billing, on an account with a paid package
 * and no authorised method; a company covered by its group, a package granted
 * free and a cancelled subscription never see it. "Later" puts it away for the
 * session; it comes back at the next sign-in until a method is authorised.
 */

const DISMISSED = 'construx.activation.dismissed';

function dismissed() {
  try {
    return sessionStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    sessionStorage.setItem(DISMISSED, '1');
  } catch {
    // Nothing to remember with; it comes back on the next draw, which is the safer failure.
  }
}

export async function maybeShowActivation({ can }) {
  if (!can('BILLING_ACU', 'U') || dismissed()) return null;
  const position = await api.get('/v1/billing/mandate').catch(() => null);
  if (!position || !position.required || position.mandate) return null;
  return showActivation(position);
}

/** Open the popup on demand — from ACU & Billing, to change the method. */
export function showActivation(position) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'modal-host';
    document.body.appendChild(host);
    const close = (value) => {
      host.remove();
      resolve(value);
    };
    const monthly = exact(position.monthlyPriceMinor, position.currency);
    const company = position.companyName;

    const stepOne = () => {
      render(
        host,
        html`<div class="modal" role="dialog" aria-labelledby="activation-title">
          <header>
            <div>
              <h3 id="activation-title">Activate ${company}’s subscription</h3>
              <div class="metric-sub">
                Your enterprise is live. To start using CONSTRUX, pay your first month upfront — then your subscription
                renews automatically each month until you cancel.
              </div>
            </div>
            <button type="button" data-later aria-label="Close">×</button>
          </header>
          <div class="body">
            <div class="card" style="margin-bottom:12px">
              <h2>${position.packageLabel} plan</h2>
              <div class="metric">${monthly}<span class="metric-sub">/month</span></div>
              <div class="metric-sub">
                First month due today · then ${monthly} every month · cancel any time.
                ${position.firstCharge ? html`<br />Payment reference for a transfer: <code>${position.firstCharge.paymentReference}</code>` : ''}
              </div>
            </div>
          </div>
          <div class="foot">
            <button type="button" class="btn quiet" data-later>Later</button>
            <button type="button" class="btn primary" data-next>Choose how to pay</button>
          </div>
        </div>`,
      );
      host.querySelectorAll('[data-later]').forEach((el) => el.addEventListener('click', () => { dismiss(); close(null); }));
      host.querySelector('[data-next]').addEventListener('click', stepTwo);
    };

    const stepTwo = () => {
      let method = 'DIRECT_DEBIT';
      const draw = () => {
        render(
          host,
          html`<div class="modal" role="dialog" aria-labelledby="activation-title">
            <header>
              <div>
                <h3 id="activation-title">How will you pay, going forward?</h3>
                <div class="metric-sub">Choose how CONSTRUX collects ${monthly} today and each month from now on.</div>
              </div>
              <button type="button" data-later aria-label="Close">×</button>
            </header>
            <div class="body">
              <div class="split-list" style="margin-bottom:12px">
                <label class="row" style="cursor:pointer;align-items:flex-start;gap:12px">
                  <input type="radio" name="activation-method" value="DIRECT_DEBIT" ${raw(method === 'DIRECT_DEBIT' ? 'checked' : '')} style="margin-top:4px" />
                  <span class="lbl" style="flex:1">
                    <b>Direct Debit (BACS)</b> <span class="badge ok">Recommended</span><br />
                    <span class="metric-sub">CONSTRUX collects from your bank account each month.</span>
                  </span>
                </label>
                <label class="row" style="cursor:pointer;align-items:flex-start;gap:12px">
                  <input type="radio" name="activation-method" value="RECURRING_CARD" ${raw(method === 'RECURRING_CARD' ? 'checked' : '')} style="margin-top:4px" />
                  <span class="lbl" style="flex:1">
                    <b>Recurring card</b><br />
                    <span class="metric-sub">Your card is charged automatically each month.</span>
                  </span>
                </label>
              </div>
              <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:13px;line-height:1.5">
                <input type="checkbox" data-authorise style="margin-top:4px;flex:none" />
                <span>${position.wording[method]}</span>
              </label>
              <div class="cmd-error" hidden></div>
            </div>
            <div class="foot">
              <button type="button" class="btn quiet" data-back>Back</button>
              <button type="button" class="btn primary" data-submit disabled>Authorise and continue</button>
            </div>
          </div>`,
        );
        host.querySelectorAll('[data-later]').forEach((el) => el.addEventListener('click', () => { dismiss(); close(null); }));
        host.querySelector('[data-back]').addEventListener('click', stepOne);
        host.querySelectorAll('input[name="activation-method"]').forEach((input) =>
          input.addEventListener('change', () => {
            method = input.value;
            draw();
          }),
        );
        const tick = host.querySelector('[data-authorise]');
        const submit = host.querySelector('[data-submit]');
        tick.addEventListener('change', () => {
          submit.disabled = !tick.checked;
        });
        submit.addEventListener('click', async () => {
          submit.disabled = true;
          const errorBox = host.querySelector('.cmd-error');
          try {
            const result = await api.post('/v1/billing/mandate', { method, authorised: tick.checked, companyName: company });
            await stepThree(result.mandate);
          } catch (error) {
            errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
            errorBox.hidden = false;
            submit.disabled = false;
          }
        });
      };
      draw();
    };

    const stepThree = async (mandate) => {
      const charge = position.firstCharge;
      // A card, on a deployment that can take one: straight to checkout for the
      // first month. The webhook settles the charge and opens the tenancy.
      if (mandate.method === 'RECURRING_CARD' && position.rails.card && charge) {
        const chargeId = charge.id;
        try {
          const checkout = await api.post(`/v1/billing/charges/${chargeId}/checkout`, {});
          window.location.assign(checkout.checkoutUrl);
          return;
        } catch (error) {
          // Fall through to the honest page: the authorisation is recorded and
          // the transfer route always works.
          console.warn('checkout could not be opened', error.message);
        }
      }
      const rail = mandate.method === 'DIRECT_DEBIT' ? 'Direct Debit' : 'recurring card';
      render(
        host,
        html`<div class="modal" role="dialog" aria-labelledby="activation-title">
          <header>
            <div>
              <h3 id="activation-title">Payment method authorised</h3>
              <div class="metric-sub">${mandate.wording}</div>
            </div>
            <button type="button" data-done aria-label="Close">×</button>
          </header>
          <div class="body">
            <div class="notice ${raw(charge ? 'warn' : 'ok')}">
              <div>
                ${charge
                  ? html`<b>Your first month, ${exact(charge.amountMinor, position.currency)}, is due today.</b><br />
                      ${rail} collection is not yet connected on this deployment, so the first month is paid by bank transfer
                      quoting <code>${charge.paymentReference}</code>. The platform opens the moment the operator records it,
                      and your ${rail} authorisation is on the record for collection from the day the rail is live.`
                  : html`<b>Nothing is owed today.</b> Your ${rail} authorisation is on the record for each month's collection.`}
              </div>
            </div>
          </div>
          <div class="foot">
            <button type="button" class="btn primary" data-done>Done</button>
          </div>
        </div>`,
      );
      host.querySelectorAll('[data-done]').forEach((el) => el.addEventListener('click', () => close(mandate)));
    };

    stepOne();
  });
}
