import { account } from './account.js';
import { permissions } from './permissions.js';
import { admin } from './admin.js';
import { aiengine } from './aiengine.js';
import { alerts } from './alerts.js';
import { audit } from './audit.js';
import { auditlogs } from './auditlogs.js';
import { autopilot } from './autopilot.js';
import { billing } from './billing.js';
import { bookings } from './bookings.js';
import { blog } from './blog.js';
import { blueprint } from './blueprint.js';
import { centre } from './centre.js';
import { commands } from './commands.js';
import { commercial } from './commercial.js';
import { company } from './company.js';
import { concept } from './concept.js';
import { communications } from './communications.js';
import { contracts } from './contracts.js';
import { construction } from './construction.js';
import { control } from './control.js';
import { copilot } from './copilot.js';
import { economy } from './economy.js';
import { design } from './design.js';
import { developer } from './developer.js';
import { documents } from './documents.js';
import { enterprise } from './enterprise.js';
import { eventstore } from './eventstore.js';
import { field } from './field.js';
import { handover } from './handover.js';
import { influencers } from './influencers.js';
import { intel } from './intel.js';
import { invoices } from './invoices.js';
import { login } from './login.js';
import { newsletter } from './newsletter.js';
import { onboarding } from './onboarding.js';
import { operations } from './operations.js';
import { overview } from './overview.js';
import { partners } from './partners.js';
import { performance } from './performance.js';
import { pipeline } from './pipeline.js';
import { procurement } from './procurement.js';
import { programme } from './programme.js';
import { reports } from './reports.js';
import { risk } from './risk.js';
import { siteservices } from './siteservices.js';
import { settings } from './settings.js';
import { signup } from './signup.js';
import { support } from './support.js';
import { system } from './system.js';
import { tenants } from './tenants.js';
import { value } from './value.js';

/** Route id → view. Ids match the navigation model in app.js. */
export const PAGES = {
  login,
  centre,
  developer,
  // Reached without a session, like login. The public site's pricing buttons
  // link straight here with the package in the query string.
  signup,
  account,
  permissions,
  overview,
  copilot,
  autopilot,
  enterprise,
  pipeline,
  programme,
  field,
  construction,
  concept,
  design,
  // ETABLIX. Registered like any other page; the navigation is what makes it
  // absent for a tenancy without the module, and the routes behind it refuse
  // one regardless.
  siteservices,
  documents,
  commercial,
  commands,
  procurement,
  contracts,
  control,
  risk,
  handover,
  audit,
  billing,
  admin,
  operations,
  blog,
  communications,

  // The platform operator's console. Twenty-five screens under the six groups
  // in OPERATOR_NAV — none of them reachable by a customer account, because
  // every read behind them is `operatorOnly` on the server and the operator
  // navigation is not the one a customer is given.
  performance,
  value,
  intel,
  tenants,
  onboarding,
  // Reachable by every signed-in identity, not only the operator: a support
  // request belongs to the tenancy that raised it, and the customer has to be
  // able to read back what they were told.
  support,
  // Somebody who wanted twenty minutes and a person rather than a sandbox.
  bookings,
  aiengine,
  economy,
  invoices,
  alerts,
  system,
  auditlogs,
  eventstore,
  reports,
  blueprint,
  partners,
  influencers,
  company,
  settings,
  // Reachable by every signed-in user through the link in the email footer,
  // not only by the operators who see it in the sidebar.
  newsletter,
};
