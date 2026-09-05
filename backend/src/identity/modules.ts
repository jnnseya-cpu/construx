import { DomainError, ForbiddenError } from '../core/errors.ts';

/**
 * Private modules, and which tenancies hold them.
 *
 * CONSTRUX is one product every customer gets. A **module** is the exception:
 * a body of capability that exists in the same codebase, runs against the same
 * ledger and the same permission matrix, and is visible only to the tenancies a
 * platform operator has explicitly granted it to.
 *
 * ---
 *
 * ## Why this is not a package tier
 *
 * `billing/seats.ts` already has FREE_TRIAL through ENTERPRISE, and the obvious
 * move is a sixth tier. It is the wrong shape twice over.
 *
 * A tier is something a customer **buys** — it appears on the pricing page, it
 * is self-serve, and its whole purpose is to be chosen. A module grant is
 * something an operator **decides**, off the price list, for a named company.
 * Putting it in the tier ladder would put it in the shop window.
 *
 * And a tier is exclusive: a tenancy is on exactly one. A module is additive —
 * the grant sits *beside* whatever package the tenancy pays for, and everything
 * else about that tenancy carries on unchanged. That is the requirement stated
 * plainly: for a granted company the module "will work with all other CONSTRUX
 * modules, functions and features as normal".
 *
 * ## Why this is not `TenancyStanding` either
 *
 * `billing/entitlement.ts` answers "what may this tenancy do *right now*", and
 * every one of its answers is derived from whether they are paying. A module
 * grant is derived from nothing — it is an act, by a named operator, with a
 * stated reason, on a date. Deriving it would mean inventing a rule; recording
 * it means the question "who gave this company access, and when, and why" has
 * an answer, which is the question this platform exists to be able to answer.
 *
 * So the two are resolved side by side onto the context and neither is
 * expressed in terms of the other. A granted tenancy that stops paying loses
 * the platform, not the grant; reactivating restores what they had rather than
 * silently dropping a module nobody remembered to re-add.
 *
 * ## The operator's own tenancy is not special
 *
 * ETABLIX holds the ETABLIX module by the same grant, written by the same
 * command, visible in the same register. The alternative — a tenant id in a
 * constant somewhere — makes revocation a deployment, leaves no record of who
 * decided it, and creates exactly one code path that the tests for every other
 * tenancy never cover.
 */

/**
 * The modules that exist.
 *
 * A closed catalogue, for the same reason the event catalogue is closed: a
 * module id that can be any string is a grant that can be written for a module
 * nobody built, and it would be indistinguishable on the register from one that
 * matters.
 */
export const MODULES = {
  ETABLIX: {
    name: 'ETABLIX AI Site Services',
    /**
     * What the module is, in the words somebody deciding whether to grant it
     * needs. An operator granting capability to a company should not have to
     * read a specification to know what they are handing over.
     */
    summary:
      'The operating system for temporary infrastructure and the living environment — welfare, accommodation, ' +
      'temporary MEP, enabling civils, FM, security and logistics — from customer brief through mobilisation and ' +
      'live operations to reinstatement.',
    /**
     * Why it is not on general release.
     *
     * Recorded so that "why can this company see something mine cannot" has an
     * answer that is not "ask somebody".
     */
    restricted:
      'Built for ETABLIX and the companies delivering site services with them. It is not part of the CONSTRUX ' +
      'subscription and is not offered for sale on the pricing page.',
    /**
     * The registry entry, in the shape the enterprise specification (§7) asks
     * a module to be published in. The key is what an entitlement claim and a
     * subscription item carry; the policy says the only way in is an explicit
     * grant to a tenant id — never a company name, a group, an email domain or
     * a flag a client could set.
     */
    registry: {
      moduleKey: 'construx.etablix.integrated_site_services',
      productCode: 'construx',
      visibility: 'restricted',
      requires: ['construx.core'],
      eligibilityPolicy: 'explicit_tenant_grant',
      customerSelfActivation: false,
    },
  },
} as const;

export type ModuleId = keyof typeof MODULES;

export function isModuleId(value: string): value is ModuleId {
  return value in MODULES;
}

/**
 * A module grant, as the ledger holds it.
 *
 * Kept on the platform tenancy rather than the customer's: the grant is the
 * operator's decision about a customer, not the customer's record about
 * themselves, and a tenancy that could read its own grant could eventually
 * write it.
 */
export type ModuleGrant = {
  moduleId: ModuleId;
  tenantId: string;
  /** ACTIVE or REVOKED. Revocation is a new state on the same record, never a delete. */
  status: 'ACTIVE' | 'REVOKED';
  /**
   * The entitlement's own dates (Enterprise / Group v1.0 §7: scheduled →
   * active → expired). Absent means from the grant, for ever. A grant is
   * `SCHEDULED` before `validFrom`, `EXPIRED` from `validTo`, and holds
   * nothing in either state; the gate reads these on every request.
   */
  validFrom?: string;
  validTo?: string;
  grantedBy: string;
  grantedAt: string;
  /** Why, in the operator's own words. Mandatory: a grant with no stated reason is unreviewable. */
  reason: string;
  revokedBy?: string;
  revokedAt?: string;
  revokedReason?: string;
};

/** Where a grant is in its life, read against the clock rather than stored. */
export type GrantLifecycle = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export function grantLifecycle(grant: ModuleGrant, now = new Date().toISOString()): GrantLifecycle {
  if (grant.status === 'REVOKED') return 'REVOKED';
  if (grant.validFrom && grant.validFrom > now) return 'SCHEDULED';
  if (grant.validTo && grant.validTo <= now) return 'EXPIRED';
  return 'ACTIVE';
}

/** The refId a grant is stored under. One per tenancy per module, by construction. */
export function grantRef(moduleId: ModuleId, tenantId: string): string {
  return `${moduleId}:${tenantId}`;
}

/**
 * Refuse unless this tenancy holds the module.
 *
 * Called at the top of every module command and every module read, beside
 * `authorise` rather than instead of it. The two ask different questions and
 * both have to pass: this one asks whether the *company* has the module at all,
 * and `authorise` asks whether this *person* may do this thing within it.
 *
 * Fails closed on an unknown module id. A typo in a module name is a route that
 * would otherwise be open to everybody, which is the worst possible direction
 * for a mistake in an access check to fail.
 */
export function requireModule(granted: readonly ModuleId[], moduleId: ModuleId): void {
  if (!isModuleId(moduleId)) {
    throw new DomainError('MODULE_UNKNOWN', `${moduleId} is not a module this platform has.`, 404);
  }
  if (!granted.includes(moduleId)) {
    // Deliberately the same shape as any other authorisation refusal, and
    // deliberately not a 404. Pretending the route does not exist would be
    // security through obscurity against somebody who can already read the
    // route list, and it would make a genuine misconfiguration — a company that
    // should hold the module and does not — indistinguishable from a typo.
    throw new ForbiddenError(
      `This tenancy does not hold the ${MODULES[moduleId].name} module. ${MODULES[moduleId].restricted}`,
      'MODULE_NOT_GRANTED',
    );
  }
}
