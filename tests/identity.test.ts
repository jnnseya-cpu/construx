import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { evaluateAccess, assertAccess, type AccessAttributes } from '../src/identity/abac.ts';
import type { AuthContext } from '../src/identity/auth.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { ENTITY_ACCESS, classifyEntity } from '../src/identity/entityAccess.ts';
import { accountLayerFor, PERMISSION_MATRIX, rolesAllow, type Role } from '../src/identity/roles.ts';
import { scopesForRoles } from '../src/identity/scopes.ts';
import { Platform, PLATFORM_TENANT_ID } from '../src/platform.ts';

const TENANT = 'tenant-1';
const ON = { rbacEnabled: true, scopesEnabled: true, abacEnabled: true };

function actor(roles: Role[], overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    actorId: 'actor-1',
    tenantId: TENANT,
    roles,
    scopes: scopesForRoles(roles),
    tokenId: 'token-1',
    mfaSatisfied: true,
    regulatorAiEnabled: false,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const attrs = (extra: Partial<AccessAttributes> = {}): AccessAttributes => ({ tenantId: TENANT, ...extra });

describe('separation of duties', () => {
  it('lets the quantity surveyor price work but not baseline the budget', () => {
    assert.equal(rolesAllow(['QS'], 'BUDGET_COST', 'C'), true);
    assert.equal(rolesAllow(['QS'], 'BUDGET_COST', 'A'), false);
    assert.equal(rolesAllow(['OWNER'], 'BUDGET_COST', 'A'), true);
  });

  it('keeps award approval away from whoever scored the bids', () => {
    assert.equal(rolesAllow(['QS'], 'PROCUREMENT_AWARD', 'A'), false);
    assert.equal(rolesAllow(['PM'], 'PROCUREMENT_AWARD', 'A'), true);
  });

  it('reserves handover acceptance for the asset owner', () => {
    assert.equal(rolesAllow(['PM'], 'HANDOVER_OM', 'A'), false);
    assert.equal(rolesAllow(['OWNER'], 'HANDOVER_OM', 'A'), true);
  });

  it('is an allow-list — an absent entry is no access at all', () => {
    assert.equal(PERMISSION_MATRIX.SUPPLIER.BUDGET_COST, undefined);
    assert.equal(rolesAllow(['SUPPLIER'], 'BUDGET_COST', 'R'), false);
  });
});

describe('account layers', () => {
  it('classifies each layer from the roles alone', () => {
    assert.equal(accountLayerFor(['PLATFORM_ADMIN']), 'PLATFORM_ADMIN');
    assert.equal(accountLayerFor(['ENTERPRISE_ADMIN']), 'ENTERPRISE_ADMIN');
    assert.equal(accountLayerFor(['PM']), 'TENANT_USER');
  });

  it('bars platform operators from customer delivery data', () => {
    const decision = evaluateAccess(actor(['PLATFORM_ADMIN']), 'FIELD_EXECUTION', 'R', attrs(), ON);
    assert.equal(decision.decision, 'DENY');
  });

  it('bars them in ABAC too, so the matrix is not the only thing standing in the way', () => {
    // With RBAC and scopes switched off the account-layer rule is the only
    // remaining control — it must still deny on its own.
    const abacOnly = { rbacEnabled: false, scopesEnabled: false, abacEnabled: true };
    const decision = evaluateAccess(actor(['PLATFORM_ADMIN']), 'FIELD_EXECUTION', 'R', attrs(), abacOnly);
    assert.equal(decision.decision, 'DENY');
    assert.match(decision.reason ?? '', /barred from customer delivery data/);
  });

  it('still lets platform operators run billing and tenancy', () => {
    assert.equal(evaluateAccess(actor(['PLATFORM_ADMIN']), 'BILLING_ACU', 'U', attrs(), ON).decision, 'ALLOW');
    assert.equal(evaluateAccess(actor(['PLATFORM_ADMIN']), 'PLATFORM_ADMINISTRATION', 'G', attrs(), ON).decision, 'ALLOW');
  });

  it('hides platform administration from every customer account', () => {
    for (const role of ['ENTERPRISE_ADMIN', 'OWNER', 'PM'] as Role[]) {
      const decision = evaluateAccess(actor([role]), 'PLATFORM_ADMINISTRATION', 'R', attrs(), ON);
      assert.equal(decision.decision, 'DENY', `${role} must not reach platform administration`);
    }
  });

  it('never permits cross-tenant access, whatever the role', () => {
    const decision = evaluateAccess(actor(['ENTERPRISE_ADMIN']), 'PROJECT_SETUP', 'R', attrs({ tenantId: 'tenant-2' }), ON);
    assert.equal(decision.decision, 'DENY');
    assert.match(decision.reason ?? '', /Cross-tenant/);
  });
});

describe('regulator access', () => {
  it('is read-only', () => {
    assert.equal(evaluateAccess(actor(['REGULATOR']), 'EVIDENCE_AUDIT', 'R', attrs(), ON).decision, 'ALLOW');
    assert.equal(evaluateAccess(actor(['REGULATOR']), 'EVIDENCE_AUDIT', 'U', attrs(), ON).decision, 'DENY');

    // …and read-only again in ABAC alone, with the matrix taken out of the way.
    const abacOnly = { rbacEnabled: false, scopesEnabled: false, abacEnabled: true };
    const write = evaluateAccess(actor(['REGULATOR']), 'RISK_REGISTER', 'U', attrs(), abacOnly);
    assert.equal(write.decision, 'DENY');
    assert.match(write.reason ?? '', /read-only/);
  });

  it('may still take a Golden Thread export, which is the point of the access', () => {
    assert.equal(evaluateAccess(actor(['REGULATOR']), 'EVIDENCE_AUDIT', 'I', attrs(), ON).decision, 'ALLOW');
  });

  it('sees published records only', () => {
    const decision = evaluateAccess(actor(['REGULATOR']), 'EVIDENCE_AUDIT', 'R', attrs({ published: false }), ON);
    assert.equal(decision.decision, 'DENY');
  });

  it('cannot spend the owner’s AI credit unless the owner enabled it', () => {
    // The matrix grants no regulator role 'X', so RBAC is taken out of the way
    // to show the owner's switch is what governs it.
    const abacOnly = { rbacEnabled: false, scopesEnabled: false, abacEnabled: true };
    assert.equal(evaluateAccess(actor(['REGULATOR']), 'EVIDENCE_AUDIT', 'X', attrs(), abacOnly).decision, 'DENY');
    const enabled = actor(['REGULATOR'], { regulatorAiEnabled: true });
    assert.equal(evaluateAccess(enabled, 'EVIDENCE_AUDIT', 'X', attrs(), abacOnly).decision, 'ALLOW');
  });
});

describe('supplier confinement', () => {
  it('keeps a supplier inside its own tender lane', () => {
    const supplier = actor(['SUPPLIER'], { partyId: 'party-a' });
    assert.equal(evaluateAccess(supplier, 'SUPPLIER_SUBMISSION', 'C', attrs(), ON).decision, 'ALLOW');
    const other = evaluateAccess(supplier, 'SUPPLIER_SUBMISSION', 'R', attrs({ ownerPartyId: 'party-b' }), ON);
    assert.equal(other.decision, 'DENY');
  });
});

describe('data sensitivity', () => {
  it('redacts commercial content from roles without clearance rather than denying the whole read', () => {
    const decision = evaluateAccess(actor(['SAFETY']), 'EVIDENCE_AUDIT', 'R', attrs({ dataSensitivity: 'COMMERCIAL_L3' }), ON);
    assert.equal(decision.decision, 'REDACT');
  });

  it('treats a redaction as a denial when the caller is writing', () => {
    throwsCode(
      () => assertAccess(actor(['SAFETY']), 'FIELD_EXECUTION', 'U', attrs({ dataSensitivity: 'LEGAL_L4' }), ON),
      'ACCESS_DENIED',
    );
  });
});

describe('phase gating', () => {
  it('refuses field execution writes before the project is in construction', () => {
    const decision = evaluateAccess(actor(['PM']), 'FIELD_EXECUTION', 'C', attrs({ lifecyclePhase: 'DESIGN' }), ON);
    assert.equal(decision.decision, 'DENY');
    assert.match(decision.reason ?? '', /cannot be written during the DESIGN phase/);
  });

  it('allows the same write once construction has started', () => {
    assert.equal(
      evaluateAccess(actor(['PM']), 'FIELD_EXECUTION', 'C', attrs({ lifecyclePhase: 'CONSTRUCTION' }), ON).decision,
      'ALLOW',
    );
  });

  it('does not gate reads by phase', () => {
    assert.equal(
      evaluateAccess(actor(['PM']), 'FIELD_EXECUTION', 'R', attrs({ lifecyclePhase: 'CONCEPT' }), ON).decision,
      'ALLOW',
    );
  });
});

describe('scopes are enforced independently of roles', () => {
  it('denies a token that holds the role but not the scope', () => {
    const stripped = actor(['PM'], { scopes: [] });
    const decision = evaluateAccess(stripped, 'PROGRAMME_BASELINES', 'R', attrs(), ON);
    assert.equal(decision.decision, 'DENY');
    assert.match(decision.reason ?? '', /missing scope/);
  });
});

describe('entity classification', () => {
  it('classifies every entity type the event catalogue can produce', () => {
    // The generic entity read consults this map, and an unmapped type is
    // refused. Deriving the expectation from the catalogue means a new event
    // type cannot ship an unreachable entity by omission.
    const produced = new Set(Object.values(EVENT_TYPES).map((definition) => definition.entity));
    const unclassified = [...produced].filter((entity) => !ENTITY_ACCESS[entity]).sort();

    assert.deepEqual(unclassified, [], `unclassified entity types: ${unclassified.join(', ')}`);
    assert.equal(classifyEntity('NotAThing'), undefined);
  });

  it('puts commercial and legal records behind the right sensitivity', () => {
    assert.equal(classifyEntity('CVR')?.sensitivity, 'COMMERCIAL_L3');
    assert.equal(classifyEntity('Estimate')?.sensitivity, 'COMMERCIAL_L3');
    assert.equal(classifyEntity('Contract')?.sensitivity, 'LEGAL_L4');
    assert.equal(classifyEntity('Claim')?.sensitivity, 'LEGAL_L4');
    assert.equal(classifyEntity('Task')?.sensitivity, undefined);
  });

  it('stops a role reading through the generic endpoint what it cannot read directly', () => {
    const read = (roles: Role[], refType: string) => {
      const classification = classifyEntity(refType);
      assert.ok(classification, `${refType} is unclassified`);
      return evaluateAccess(actor(roles), classification.area, 'R', attrs({ dataSensitivity: classification.sensitivity }), ON)
        .decision;
    };

    // Safety runs the risk register and has no business in the cost book.
    assert.equal(read(['SAFETY'], 'RiskRegisterItem'), 'ALLOW');
    assert.notEqual(read(['SAFETY'], 'CVR'), 'ALLOW');
    assert.notEqual(read(['SAFETY'], 'Estimate'), 'ALLOW');

    // The regulator sees safety and quality, not margins.
    assert.equal(read(['REGULATOR'], 'CommissioningTest'), 'ALLOW');
    assert.notEqual(read(['REGULATOR'], 'CVR'), 'ALLOW');
    assert.notEqual(read(['REGULATOR'], 'BidEvaluation'), 'ALLOW');

    // The QS owns the commercial record.
    assert.equal(read(['QS'], 'CVR'), 'ALLOW');
    assert.equal(read(['QS'], 'Estimate'), 'ALLOW');
  });
});

describe('platform operator accounts', () => {
  it('belongs to no customer tenant and consumes no subscription seat', () => {
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Platform Operator', email: 'operator@construx.example' });

    assert.equal(operator.tenantId, PLATFORM_TENANT_ID);
    assert.deepEqual(operator.roles, ['PLATFORM_ADMIN']);

    const { tenant, subscription } = platform.createTenant({
      legalName: 'Meridian Infrastructure Group Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      enterpriseName: 'Meridian Infrastructure Group',
    });

    assert.equal(subscription.assignedIdentities.length, 0);
    assert.deepEqual(platform.users(tenant.id), []);
    assert.deepEqual(
      platform.operators().map((u) => u.email),
      ['operator@construx.example'],
    );
  });

  it('can sign in and receives operator scopes only', () => {
    const platform = new Platform();
    platform.createOperator({ name: 'Platform Operator', email: 'operator@construx.example' });
    const { user, tokens } = platform.login('operator@construx.example');

    assert.deepEqual(user.roles, ['PLATFORM_ADMIN']);
    assert.ok(tokens.accessToken.length > 0);
    assert.ok(!scopesForRoles(user.roles).some((scope) => scope.startsWith('field:')));
  });
});
