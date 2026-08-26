import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_ROLES,
  OPERATOR_ONLY_ROLES,
  PERMISSION_MATRIX,
  ROLE_ACCOUNT_LAYER,
  TENANT_GRANTABLE_ROLES,
  rolesAllow,
  type CapabilityArea,
  type Role,
} from '../src/identity/roles.ts';
import { UNCHARGED_ROLES, seatForRole } from '../src/billing/seats.ts';

/**
 * The authority vocabulary.
 *
 * The specification repeatedly names holders the platform's roles could not
 * express — an Executive approves the Go/No-Go gate, a Project Director
 * authorises a reverse lifecycle transition, a Development Manager writes the
 * business case somebody else signs, a Commercial Manager receives the exception
 * when the data chain breaks, and a Principal Designer discharges a statutory
 * CDM 2015 duty. Every gate in the specification names one of them, so writing
 * the gates before the holders existed would have meant writing them twice.
 *
 * Three of the five are deliberately incomplete, and the incompleteness is the
 * design: the Development Manager approves nothing, the Executive creates
 * nothing, and the Commercial Manager does not author in the four areas it signs
 * off. That models the two-person split the specification describes — one person
 * writes the investment paper, another signs it.
 *
 * What this is *not* is the platform's general separation-of-duties mechanism.
 * The matrix grants capability to a role; twenty-six existing roles hold both
 * create and approve in the same area, deliberately, because separation is a rule
 * about **two acts by one person** and a capability area cannot express it. It is
 * enforced per act — `lifecycle/stages.ts` refuses a gate decision from whoever
 * submitted it. The asymmetry below is modelling, not enforcement, and claiming
 * otherwise would overstate what the matrix does.
 */

const holds = (role: Role, area: CapabilityArea, code: string): boolean =>
  (PERMISSION_MATRIX[role][area] ?? []).includes(code as never);

describe('the roles the specification names now exist', () => {
  it('has all five, as tenant-user roles', () => {
    for (const role of ['EXECUTIVE', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER'] as const) {
      assert.ok(ALL_ROLES.includes(role), `${role} is not a role`);
      assert.equal(ROLE_ACCOUNT_LAYER[role], 'TENANT_USER', `${role} is in the wrong account layer`);
    }
  });

  it('lets a tenant administrator grant every one of them', () => {
    // These are delivery roles inside a customer's own organisation. Only the
    // platform operator and the regulator are withheld, and for reasons that do
    // not apply here.
    for (const role of ['EXECUTIVE', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER'] as const) {
      assert.ok(TENANT_GRANTABLE_ROLES.includes(role), `${role} cannot be granted by a tenant administrator`);
    }
  });

  it('prices every one of them, so each can actually be assigned', () => {
    // A role with no seat is a role nobody can be given. This is enumerated from
    // the role list rather than hand-written, so the next role added fails here
    // rather than failing when somebody first tries to use it.
    for (const role of ALL_ROLES) {
      if (OPERATOR_ONLY_ROLES.includes(role) || UNCHARGED_ROLES.includes(role)) continue;
      assert.ok(seatForRole(role), `${role} has no seat and therefore cannot be assigned`);
    }
  });
});

describe('the two-person split the specification describes', () => {
  it('gives the Executive approval everywhere and authorship nowhere', () => {
    // An executive who could write the business case would be approving their
    // own paper. Every 'C' and 'U' is absent on purpose.
    assert.ok(holds('EXECUTIVE', 'PROJECT_SETUP', 'A'), 'the Executive cannot approve the gate it exists to approve');
    assert.ok(holds('EXECUTIVE', 'BUDGET_COST', 'A'));

    for (const area of Object.keys(PERMISSION_MATRIX.EXECUTIVE) as CapabilityArea[]) {
      assert.ok(!holds('EXECUTIVE', area, 'C'), `the Executive can create in ${area}`);
      assert.ok(!holds('EXECUTIVE', area, 'U'), `the Executive can update in ${area}`);
    }
  });

  it('gives the Development Manager authorship everywhere and approval nowhere', () => {
    // The mirror image, and the reason both roles exist rather than one: the
    // specification has this role edit the investment paper and the Executive
    // approve it, which only means anything if the matrix agrees.
    assert.ok(holds('DEVELOPMENT_MANAGER', 'BUSINESS_DEVELOPMENT', 'C'));
    assert.ok(holds('DEVELOPMENT_MANAGER', 'PROJECT_SETUP', 'C'));

    for (const area of Object.keys(PERMISSION_MATRIX.DEVELOPMENT_MANAGER) as CapabilityArea[]) {
      assert.ok(!holds('DEVELOPMENT_MANAGER', area, 'A'), `the Development Manager can approve in ${area}`);
    }
  });

  it('keeps the Commercial Manager out of authorship in the areas it signs off', () => {
    // The QS authors the cost report, the application, the variation and the
    // claim. This role approves them. Mirroring the QS having no approve in
    // those areas is what makes the separation real in both directions.
    const commercial: CapabilityArea[] = ['BUDGET_COST', 'PAYMENT_APPLICATIONS', 'CHANGE_VARIATION', 'CONTRACTS_CLAIMS'];

    for (const area of commercial) {
      assert.ok(holds('COMMERCIAL_MANAGER', area, 'A'), `the Commercial Manager cannot approve ${area}`);
      assert.ok(!holds('COMMERCIAL_MANAGER', area, 'C'), `the Commercial Manager can author in ${area}, which it also approves`);
      assert.ok(!holds('QS', area, 'A'), `the QS can approve ${area}, which it authors`);
      assert.ok(holds('QS', area, 'C'), `the QS cannot author ${area}`);
    }
  });
});

describe('the Principal Designer is a statutory duty holder, not a job title', () => {
  it('is the role that can approve a design', () => {
    // The specification requires system-enforced approval before a design
    // approval, and names the Principal Designer among the personas who hold
    // that authority. It is the duty holder, so it must be able to give one.
    assert.ok(
      holds('PRINCIPAL_DESIGNER', 'DESIGN_INFORMATION', 'A'),
      'the Principal Designer cannot approve a design',
    );
  });

  it('joins the designer as an approver rather than replacing them', () => {
    // The prior model gave design approval to the DESIGNER, on the stated
    // reasoning that "approval of design content stays with the designer" — a
    // deliberate decision, recorded beside the BIM role that was excluded from
    // it. That is not overturned here.
    //
    // What changes is that a *statutory* approver now exists alongside it. The
    // two are different acts: a lead designer signing off design content, and
    // the CDM duty holder confirming design risk has been eliminated or reduced.
    // Whether a designer should continue to approve their own design is a
    // question for the product owner, and it is recorded in SPEC.md rather than
    // decided here.
    const approvers = ALL_ROLES.filter((role) => holds(role, 'DESIGN_INFORMATION', 'A'));

    assert.ok(approvers.includes('PRINCIPAL_DESIGNER'));
    assert.deepEqual(
      approvers.sort(),
      ['DESIGNER', 'PRINCIPAL_DESIGNER'],
      'design approval has spread beyond the designer and the statutory duty holder',
    );
  });

  it('carries the pre-construction safety duty it exists for', () => {
    // CDM 2015: plan, manage and monitor the pre-construction phase, and ensure
    // design risk is eliminated or reduced. That is discharged in the risk
    // register and in the RAMS, so it approves in both.
    assert.ok(holds('PRINCIPAL_DESIGNER', 'SAFETY_RAMS', 'A'));
    assert.ok(holds('PRINCIPAL_DESIGNER', 'RISK_REGISTER', 'A'));
  });

  it('is not the Principal Contractor, and holds no site authority', () => {
    // Two different statutory duty holders. The Principal Designer owns the
    // pre-construction phase; conflating it with site execution would be wrong
    // in law as well as in the product.
    assert.ok(!holds('PRINCIPAL_DESIGNER', 'FIELD_EXECUTION', 'A'));
    assert.equal(PERMISSION_MATRIX.PRINCIPAL_DESIGNER.FIELD_EXECUTION, undefined);
  });
});

describe('the Project Director holds the lifecycle authority the specification requires', () => {
  it('can approve on project setup, which is what a reverse transition is gated on', () => {
    assert.ok(rolesAllow(['PROJECT_DIRECTOR'], 'PROJECT_SETUP', 'A'));
  });

  it('does not thereby become a second Project Manager', () => {
    // Seniority within one authority, not a duplicate of the delivery role. It
    // approves what the team authors and creates almost nothing.
    assert.ok(!holds('PROJECT_DIRECTOR', 'WORKPACKAGES_TASKS', 'C'));
    assert.ok(!holds('PROJECT_DIRECTOR', 'FIELD_EXECUTION', 'C'));
    assert.ok(holds('PM', 'WORKPACKAGES_TASKS', 'C'), 'the PM lost the authorship this role must not take');
  });
});

describe('what the new roles must never reach', () => {
  it('gives none of them any platform administration', () => {
    // The account layer is the boundary the whole permission model rests on. A
    // customer-side role reaching platform administration would put the operator
    // surface inside a tenancy.
    for (const role of ['EXECUTIVE', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER'] as const) {
      assert.equal(
        PERMISSION_MATRIX[role].PLATFORM_ADMINISTRATION,
        undefined,
        `${role} reaches platform administration`,
      );
    }
  });

  it('gives none of them governance rights over the permission model itself', () => {
    for (const role of ['EXECUTIVE', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER'] as const) {
      for (const area of Object.keys(PERMISSION_MATRIX[role]) as CapabilityArea[]) {
        assert.ok(!holds(role, area, 'G'), `${role} holds governance on ${area}`);
      }
    }
  });

  it('lets none of them credit a wallet', () => {
    // Money in is the operator's act. A senior customer role that could credit
    // its own balance would defeat the prepaid model entirely.
    for (const role of ['EXECUTIVE', 'DEVELOPMENT_MANAGER', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'PRINCIPAL_DESIGNER'] as const) {
      assert.ok(!holds(role, 'BILLING_ACU', 'C'), `${role} can create a billing record`);
      assert.ok(!holds(role, 'BILLING_ACU', 'A'), `${role} can approve a billing record`);
    }
  });
});

describe('every role remains complete', () => {
  it('gives every role a matrix entry', () => {
    for (const role of ALL_ROLES) {
      assert.ok(PERMISSION_MATRIX[role], `${role} has no permission matrix`);
      assert.ok(Object.keys(PERMISSION_MATRIX[role]).length > 0, `${role} has an empty matrix, so it can do nothing`);
    }
  });

  it('gives every role an account layer', () => {
    for (const role of ALL_ROLES) {
      assert.ok(ROLE_ACCOUNT_LAYER[role], `${role} belongs to no account layer`);
    }
  });

  it('lets every role read the audit trail it is accountable to', () => {
    // Every role can be held to what it did, so every role can see the record.
    for (const role of ALL_ROLES) {
      assert.ok(holds(role, 'EVIDENCE_AUDIT', 'R'), `${role} cannot read the record of its own actions`);
    }
  });
});
