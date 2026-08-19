import { admin } from './admin.js';
import { audit } from './audit.js';
import { autopilot } from './autopilot.js';
import { billing } from './billing.js';
import { commercial } from './commercial.js';
import { contracts } from './contracts.js';
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

/** Route id → view. Ids match the navigation model in app.js. */
export const PAGES = {
  login,
  overview,
  copilot,
  autopilot,
  enterprise,
  pipeline,
  programme,
  field,
  design,
  commercial,
  procurement,
  contracts,
  risk,
  handover,
  audit,
  billing,
  admin,
  // Reachable by every signed-in user through the link in the email footer,
  // not only by the operators who see it in the sidebar.
  newsletter,
};
