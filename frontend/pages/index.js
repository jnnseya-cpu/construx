import { account } from './account.js';
import { admin } from './admin.js';
import { audit } from './audit.js';
import { autopilot } from './autopilot.js';
import { billing } from './billing.js';
import { commands } from './commands.js';
import { commercial } from './commercial.js';
import { communications } from './communications.js';
import { contracts } from './contracts.js';
import { control } from './control.js';
import { copilot } from './copilot.js';
import { design } from './design.js';
import { enterprise } from './enterprise.js';
import { field } from './field.js';
import { handover } from './handover.js';
import { login } from './login.js';
import { newsletter } from './newsletter.js';
import { overview } from './overview.js';
import { pipeline } from './pipeline.js';
import { procurement } from './procurement.js';
import { programme } from './programme.js';
import { risk } from './risk.js';
import { signup } from './signup.js';

/** Route id → view. Ids match the navigation model in app.js. */
export const PAGES = {
  login,
  // Reached without a session, like login. The public site's pricing buttons
  // link straight here with the package in the query string.
  signup,
  account,
  overview,
  copilot,
  autopilot,
  enterprise,
  pipeline,
  programme,
  field,
  design,
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
  communications,
  // Reachable by every signed-in user through the link in the email footer,
  // not only by the operators who see it in the sidebar.
  newsletter,
};
