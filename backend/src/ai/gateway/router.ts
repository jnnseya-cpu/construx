/**
 * The CONSTRUX AI Gateway — model router (spec §9, §10).
 *
 * Given a task profile and the live availability of each provider, it produces an
 * ordered **route plan** — the primary, then the task-specific fallbacks — keeping
 * only providers that are wired, healthy and cleared for the data. It is where the
 * spec's two routing rules live:
 *
 *   - **No silent fallback** (P08): every provider that is skipped is recorded with
 *     a reason, so the admin route record explains the whole chain.
 *   - **Fail closed** (P07): if nothing in the chain is eligible, the plan is empty
 *     and the caller must stop and refer to a human — never fabricate an answer
 *     (spec AT-04, AT-05).
 *
 * The provider identity never leaves this layer toward the user (P03). Pure:
 * availability is injected, so there is no I/O and the matrix is fully testable.
 */
import type { GatewayProvider, TaskProfile } from './contract.ts';
import { providerIsWired } from './contract.ts';
import { POLICY_VERSION, ROUTE_POLICY, routeChain } from './taxonomy.ts';

/** What the gateway knows about one provider right now (spec §10). */
export type ProviderStatus = {
  /** A runtime adapter exists for it (Vertex is not wired yet). */
  wired: boolean;
  /** The circuit breaker is closed / the provider is answering. */
  healthy: boolean;
  /** Cleared to receive this request's data classification and region (spec §13). */
  cleared: boolean;
};
export type ProviderAvailability = (provider: GatewayProvider) => ProviderStatus;

export type RoutePlan = {
  taskProfile: TaskProfile;
  policyVersion: string;
  /** The providers to try, in order — all wired, healthy and cleared. Empty = fail closed. */
  plan: GatewayProvider[];
  /** Why each other provider in the chain was not used (spec P08, §15.4). */
  skipped: Array<{ provider: GatewayProvider; reason: 'NOT_WIRED' | 'UNHEALTHY' | 'NOT_CLEARED' }>;
  primaryRole: string;
};

/**
 * Build the route plan for a task. Walks the policy chain primary-first, keeping
 * eligible providers and recording why the rest were dropped. An empty `plan`
 * means the gateway must fail closed and refer the task to a human.
 */
export function selectRoute(taskProfile: TaskProfile, avail: ProviderAvailability): RoutePlan {
  const chain = routeChain(taskProfile);
  const plan: GatewayProvider[] = [];
  const skipped: RoutePlan['skipped'] = [];

  for (const provider of chain) {
    const status = avail(provider);
    if (!providerIsWired(provider) || !status.wired) {
      skipped.push({ provider, reason: 'NOT_WIRED' });
      continue;
    }
    if (!status.cleared) {
      skipped.push({ provider, reason: 'NOT_CLEARED' });
      continue;
    }
    if (!status.healthy) {
      skipped.push({ provider, reason: 'UNHEALTHY' });
      continue;
    }
    plan.push(provider);
  }

  return {
    taskProfile,
    policyVersion: POLICY_VERSION,
    plan,
    skipped,
    primaryRole: ROUTE_POLICY[taskProfile].riskTier,
  };
}

/** Whether a route plan can proceed, or the gateway must stop and escalate (spec P07). */
export function routeIsEligible(plan: RoutePlan): boolean {
  return plan.plan.length > 0;
}
