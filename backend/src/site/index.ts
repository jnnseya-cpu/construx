import type { RequestContext } from '../api/middleware.ts';
import { NotFoundError } from '../core/errors.ts';
import type { Platform } from '../platform.ts';
import { channelStatus } from '../notifications/notify.ts';
import { SITE_PAGES } from './layout.ts';
import { landing } from './landing.ts';
import { POST_PAGES } from './posts.ts';
import { publishedPost } from './blog.ts';
import { availability } from './booking.ts';
import { CLEAN_TENANCY, cleanWorkspaceSeats, seedCleanWorkspace } from '../cleanroom.ts';
import { demonstrationEnabled, isProduction } from '../config.ts';
import {
  about,
  blog,
  blogPost,
  contact,
  demo,
  type DemoInput,
  developers,
  exposure,
  getStarted,
  growth,
  howItWorks,
  industries,
  policies,
  privacy,
  status,
  terms,
} from './pages.ts';

/**
 * The public site's router.
 *
 * One map from path to renderer, so the route table, the navigation and the
 * footer all read from the same list and a page cannot exist in the nav without
 * existing as a route.
 */

export { SITE_PAGES } from './layout.ts';
export { POST_PAGES } from './posts.ts';

type Renderer = (platform: Platform, ctx: RequestContext) => string;

const RENDERERS: Record<string, Renderer> = {
  '/about': () => about(),
  '/how-it-works': () => howItWorks(),
  '/exposure': () => exposure(),
  '/industries': () => industries(),
  '/blog': (platform) => blog(platform),
  // One concrete route per post rather than a `:slug` pattern. It keeps the
  // "one map from path to renderer" shape that makes a page impossible to
  // reach without existing, and an unknown slug then 404s through the ordinary
  // not-found path instead of needing a lookup that can miss.
  ...Object.fromEntries(
    POST_PAGES.map((post) => [post.path, (platform: Platform) => blogPost(post.path.slice('/blog/'.length), platform)] as const),
  ),
  '/developers': () => developers(),
  '/contact': () => contact(),
  '/get-started': () => getStarted(),
  // The one page that reads live state on every request: which identities are
  // seeded, and which slots are still free. Both are synchronous reads off the
  // platform, so it fits this map — a booking is a POST and is handled on the
  // route table, where it can render this same page with the confirmation on it.
  '/demo': (platform) => demo(demoInput(platform)),
  '/growth': () => growth(),
  '/terms': () => terms(),
  '/privacy': () => privacy(),
  '/policies': () => policies(),
  // The only page that reads live state. Everything it reports comes from the
  // running process; there is no stored uptime figure to present.
  '/status': (platform) =>
    status({
      uptimeSeconds: Math.floor(process.uptime()),
      health: platform.health() as { status: string; checks?: Array<{ name: string; status: string; detail?: string }> },
      channels: channelStatus(),
    }),
};

/**
 * Everything the demonstration page needs, gathered in one place.
 *
 * Exported because the booking POST renders the same page with a confirmation
 * on it, and assembling this twice would be two chances for the two versions to
 * disagree about what is on offer.
 */
export function demoInput(
  platform: Platform,
  extra: { booked?: DemoInput['booked']; bookingError?: string } = {},
): DemoInput {
  // Same gate the identity list uses: outside production the demonstration is
  // always offered, because a development deployment *is* the fixture.
  const available = !isProduction() || demonstrationEnabled();

  // Seeded identities are read rather than created here. The route that serves
  // this page seeds the programme first — a whole lifecycle is not something to
  // build inside a page render — so an empty list at this point means the seed
  // did not complete, which is a different sentence from "switched off" and the
  // page says the right one.
  //
  // The empty workspace is created on the way past, which is cheap: three
  // identities and an opening credit, with no lifecycle behind it. Resolved once
  // rather than inside the filter, which called it per identity.
  const cleanId = available ? cleanTenantId(platform) : '';
  const seeded = available ? platform.demonstrationUsers().filter((user) => user.tenantId !== cleanId) : [];

  const clean = available
    ? cleanWorkspaceSeats().map((seat) => ({ name: seat.name, email: seat.email, roles: seat.roles, purpose: seat.purpose }))
    : [];

  return {
    available: available && seeded.length > 0,
    unavailableBecause: available ? 'NOT_SEEDED' : 'SWITCHED_OFF',
    seeded: seeded.map((user) => ({ name: user.name, email: user.email, roles: user.roles })),
    clean,
    programme: DEMO_PROGRAMME,
    availability: availability(platform),
    ...extra,
  };
}

/** The empty workspace's tenancy, created on first ask and adopted after. */
function cleanTenantId(platform: Platform): string {
  return seedCleanWorkspace(platform).tenantId;
}

/**
 * The seeded programme's name, for the page's own copy.
 *
 * Read from the tenancy rather than restated, so renaming the fixture renames
 * the sentence describing it.
 */
const DEMO_PROGRAMME = 'National Water Resilience Programme';

export function render(path: string, platform: Platform, ctx: RequestContext): string {
  const renderer = RENDERERS[path];
  if (renderer) return renderer(platform, ctx);

  // A post published through the console has no entry in the map above, because
  // the map is built at import time and the post did not exist then. This is
  // the one place a path is looked up rather than declared — and it is narrow
  // on purpose: only under `/blog/`, only against posts that are PUBLISHED, and
  // an unknown slug still falls through to the ordinary not-found path.
  if (path.startsWith('/blog/')) {
    const slug = path.slice('/blog/'.length);
    if (publishedPost(platform, slug)) return blogPost(slug, platform);
  }

  // Not found, not failed: a withdrawn post, a mistyped address or a crawler
  // probing for pages gets a 404. It answered 500 before, which told the
  // operator's watch that the site was failing and told the crawler to retry.
  throw new NotFoundError(`No public page for ${path}`);
}

/**
 * The demonstration page, with an optional booking outcome on it.
 *
 * The POST handler calls this rather than reaching into `RENDERERS`, so the
 * confirmed page and the offered page are assembled by the same code and cannot
 * disagree about what is available.
 */
export function renderDemo(
  platform: Platform,
  extra: { booked?: DemoInput['booked']; bookingError?: string } = {},
): string {
  return demo(demoInput(platform, extra));
}

/** The marketing front door. */
export function renderLanding(): string {
  return landing();
}

/** Every path the site serves, for the router and for the test that walks them. */
export const PATHS = SITE_PAGES.map((p) => p.path);
