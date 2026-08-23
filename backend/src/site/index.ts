import type { RequestContext } from '../api/middleware.ts';
import type { Platform } from '../platform.ts';
import { channelStatus } from '../notifications/notify.ts';
import { SITE_PAGES } from './layout.ts';
import { landing } from './landing.ts';
import { POST_PAGES } from './posts.ts';
import {
  about,
  blog,
  blogPost,
  contact,
  developers,
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
  '/industries': () => industries(),
  '/blog': () => blog(),
  // One concrete route per post rather than a `:slug` pattern. It keeps the
  // "one map from path to renderer" shape that makes a page impossible to
  // reach without existing, and an unknown slug then 404s through the ordinary
  // not-found path instead of needing a lookup that can miss.
  ...Object.fromEntries(
    POST_PAGES.map((post) => [post.path, () => blogPost(post.path.slice('/blog/'.length))] as const),
  ),
  '/developers': () => developers(),
  '/contact': () => contact(),
  '/get-started': () => getStarted(),
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

export function render(path: string, platform: Platform, ctx: RequestContext): string {
  const renderer = RENDERERS[path];
  if (!renderer) throw new Error(`No public page for ${path}`);
  return renderer(platform, ctx);
}

/** The marketing front door. */
export function renderLanding(): string {
  return landing();
}

/** Every path the site serves, for the router and for the test that walks them. */
export const PATHS = SITE_PAGES.map((p) => p.path);
