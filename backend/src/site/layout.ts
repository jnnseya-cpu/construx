import { esc } from '../messaging/render.ts';
import { config } from '../config.ts';
import { analyticsScriptTag, consentBanner } from './analytics.ts';
import { businessDetails, contactColumn, emailLink, organisationJsonLd, phoneLink, telHref } from './business.ts';

/**
 * The public site's chrome.
 *
 * Server-rendered rather than client-rendered, and that is a deliberate
 * departure from the console. The application is a signed-in tool where a
 * blank first paint costs nothing; these pages are read by people deciding
 * whether to trust the product, by search crawlers, and by link previews in
 * messages — all of which see markup, not a script that would have produced it.
 *
 * It reuses `esc` from the mail renderer rather than declaring a second
 * escaping function. There is one correct answer to "how do we escape this"
 * and no reason for the site to hold its own.
 *
 * The palette is the application's, taken from `frontend/app.css` and repeated
 * here as literals because this markup is served before any stylesheet loads
 * and a marketing page that flashes white before painting black looks broken.
 */

export type NavLink = { href: string; label: string };

/** Every page the public site serves. One list, used by the nav, the footer and the router. */
export const SITE_PAGES = [
  { path: '/about', label: 'About', group: 'Company' },
  { path: '/how-it-works', label: 'How it works', group: 'Product' },
  { path: '/exposure', label: 'What one missed notice is worth', group: 'Product' },
  { path: '/industries', label: 'Industries', group: 'Product' },
  { path: '/blog', label: 'Blog', group: 'Company' },
  { path: '/developers', label: 'Developers', group: 'Product' },
  { path: '/contact', label: 'Contact', group: 'Company' },
  { path: '/get-started', label: 'Get started', group: 'Product' },
  { path: '/demo', label: 'Try it', group: 'Product' },
  { path: '/growth', label: 'Growth & Influencers', group: 'Company' },
  { path: '/terms', label: 'Terms of Service', group: 'Legal' },
  { path: '/privacy', label: 'Privacy Policy', group: 'Legal' },
  { path: '/policies', label: 'All policies', group: 'Legal' },
  { path: '/status', label: 'Platform status', group: 'Legal' },
] as const;

/** The primary nav — a subset, because twelve items in a header is not a header. */
const PRIMARY: NavLink[] = [
  // First, deliberately. The strongest thing this company owns is a programme
  // somebody can walk through, and it was the one page with no way to reach it.
  { href: '/demo', label: 'Try it' },
  { href: '/how-it-works', label: 'How it works' },
  // Second, because it is the only page on the site that argues with the
  // reader's own numbers rather than with ours.
  { href: '/exposure', label: 'What it costs you' },
  { href: '/industries', label: 'Industries' },
  { href: '/developers', label: 'Developers' },
  { href: '/about', label: 'About' },
  { href: '/blog', label: 'Blog' },
];

export type PageMeta = {
  title: string;
  description: string;
  /** Canonical path, used for the link tag and to mark the nav. */
  path: string;
  /**
   * `article` for a blog post, `website` for everything else. Open Graph reads
   * this to decide what kind of card to draw, and a post presented as a website
   * loses its date and its author in every preview.
   */
  type?: 'website' | 'article';
  /** Publication date, ISO `YYYY-MM-DD`. Articles only. */
  published?: string;
  /** Structured data for this page, already serialised. */
  jsonLd?: string;
};

/**
 * The site-wide preview image.
 *
 * `twitter:card` was already declaring `summary_large_image` — a promise of a
 * large picture — with no image tag anywhere on the page. Every share of every
 * page therefore rendered as a bare grey card, which is the worst of both: the
 * space is reserved and nothing fills it.
 */
const PREVIEW_IMAGE = '/landing-hero.png';

/**
 * Absolute, because relative does not work for any of the three things that
 * read these.
 *
 * A canonical link is a statement about which URL is the real one, and Google's
 * own guidance is to make it absolute — a relative one is resolved against
 * whatever host served the page, which is exactly the ambiguity the tag exists
 * to remove. Open Graph and Twitter are stricter still: a crawler fetching a
 * preview has no base to resolve against and simply drops a relative image.
 */
function absolute(path: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, '')}${path}`;
}

function head(meta: PageMeta): string {
  const title = `${esc(meta.title)} · CONSTRUX`;
  const url = absolute(meta.path);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${meta.type ?? 'website'}">
<meta property="og:site_name" content="CONSTRUX">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${esc(absolute(PREVIEW_IMAGE))}">
<meta property="og:image:width" content="2880">
<meta property="og:image:height" content="1800">
<meta property="og:image:alt" content="The CONSTRUX command centre">
${meta.published ? `<meta property="article:published_time" content="${esc(meta.published)}">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${esc(absolute(PREVIEW_IMAGE))}">
<meta name="theme-color" content="#090a0d">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
${meta.jsonLd ? `<script type="application/ld+json">${meta.jsonLd}</script>\n` : ''}<script type="application/ld+json">${jsonLd(organisationJsonLd(businessDetails(), config.publicBaseUrl))}</script>
</head>`;
}

/**
 * Structured data, serialised safely for embedding in a script element.
 *
 * `</script>` inside a JSON string would end the block early — the one escape
 * that matters here, and the reason this is not a bare `JSON.stringify`. The
 * `<` form is what every serialiser uses because it is valid JSON *and* inert
 * to an HTML parser.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The publisher, identical on every page that carries structured data. */
export function organisation(): Record<string, unknown> {
  // Nested inside another node, so without its own `@context`.
  const { '@context': _context, ...node } = organisationJsonLd(businessDetails(), config.publicBaseUrl);
  return node;
}

export { absolute };

function header(current: string): string {
  const links = PRIMARY.map(
    (link) =>
      `<a href="${esc(link.href)}"${link.href === current ? ' aria-current="page"' : ''}>${esc(link.label)}</a>`,
  ).join('');

  // The phone, where one is configured, sits in the header of every page as a
  // link a phone can dial. On a small screen the header actions collapse into
  // the menu, so the same number and the email are the menu's last two rows —
  // a contact route that is only there at desktop width is not there.
  const business = businessDetails();
  const phone = phoneLink(business);
  const mobileContact = `${
    business.phone ? `<a class="menu-contact" href="${esc(telHref(business.phone))}">Call ${esc(business.phone)}</a>` : ''
  }<a class="menu-contact" href="mailto:${esc(business.email)}">Email ${esc(business.email)}</a>`;

  return `<header class="site-head">
  <div class="wrap head-row">
    <a class="mark" href="/" aria-label="CONSTRUX home">
      <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><path fill="#6b727b" d="M12 14 L22 9 L22 40 L12 40 Z"/><path fill="#8b939d" d="M24 12 L31 8 L31 40 L24 40 Z"/><path fill="#6b727b" d="M30 30 L38 30 L45 40 L41 45 Z"/><path fill="#6b727b" d="M43 38 L50 38 L56 52 L47 52 Z"/><path fill="#ff6600" d="M45 30 L56 30 L41 52 L31 52 Z"/></svg>
      <span>CONSTRU<span class="x">X</span></span>
    </a>
    <nav class="site-nav" aria-label="Primary">${links}</nav>
    <div class="head-cta">
      ${phone}
      <a class="btn ghost" href="/app">Sign in</a>
      <a class="btn" href="/get-started">Get started</a>
    </div>
    <button class="nav-toggle" aria-expanded="false" aria-controls="mobile-nav" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
  </div>
  <nav class="mobile-nav" id="mobile-nav" hidden aria-label="Primary, mobile">
    ${SITE_PAGES.map((p) => `<a href="${esc(p.path)}">${esc(p.label)}</a>`).join('')}
    ${mobileContact}
  </nav>
</header>`;
}

function footer(): string {
  const groups = ['Product', 'Company', 'Legal'] as const;
  const columns = groups
    .map((group) => {
      const items = SITE_PAGES.filter((p) => p.group === group)
        .map((p) => `<li><a href="${esc(p.path)}">${esc(p.label)}</a></li>`)
        .join('');
      return `<div><h4>${group}</h4><ul>${items}</ul></div>`;
    })
    .join('');

  const business = businessDetails();
  return `<footer class="site-foot">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="mark" href="/" aria-label="CONSTRUX home"><span>CONSTRU<span class="x">X</span></span></a>
        <p>The record of how an asset came to exist — governed, evidenced and verifiable from concept to thirty-year operation.</p>
        <p class="foot-status"><a href="/status"><span class="dot"></span> All systems operational</a></p>
      </div>
      ${columns}
      ${contactColumn(business)}
    </div>
    <div class="foot-base">
      <span>&copy; ${new Date().getUTCFullYear()} ${esc(business.legalName)}${business.email ? ` · ${emailLink(business)}` : ''}</span>
      <span class="foot-links"><a href="/verify-document">Verify a document</a> <a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/policies">Policies</a></span>
    </div>
  </div>
</footer>
${consentBanner()}
<script src="/site.js" defer></script>
${analyticsScriptTag()}`;
}

/** Wrap page content in the site chrome. */
export function page(meta: PageMeta, content: string): string {
  return `${head(meta)}
<body class="site">
<a class="skip" href="#main">Skip to content</a>
${header(meta.path)}
<main id="main">
${content}
</main>
${footer()}
</body>
</html>`;
}

/** A standard page header: eyebrow, title, standfirst. */
export function pageHead(input: { eyebrow: string; title: string; standfirst: string }): string {
  return `<section class="page-head">
  <div class="wrap">
    <div class="eyebrow"><span class="dot"></span> ${esc(input.eyebrow)}</div>
    <h1>${esc(input.title)}</h1>
    <p class="standfirst">${esc(input.standfirst)}</p>
  </div>
</section>`;
}

/** A card grid. `body` is trusted markup produced by this module, never user input. */
export function cards(items: Array<{ title: string; body: string; tag?: string }>, columns = 3): string {
  return `<div class="cards g${columns}">
  ${items
    .map(
      (item) => `<article class="card">
    ${item.tag ? `<span class="tag">${esc(item.tag)}</span>` : ''}
    <h3>${esc(item.title)}</h3>
    <p>${item.body}</p>
  </article>`,
    )
    .join('\n  ')}
</div>`;
}

/** A closing call to action, identical on every page so it is never a surprise. */
export function cta(input: { title: string; body: string; primary: NavLink; secondary?: NavLink }): string {
  return `<section class="cta-band">
  <div class="wrap">
    <h2>${esc(input.title)}</h2>
    <p>${esc(input.body)}</p>
    <div class="cta-row">
      <a class="btn lg" href="${esc(input.primary.href)}">${esc(input.primary.label)}</a>
      ${input.secondary ? `<a class="btn lg ghost" href="${esc(input.secondary.href)}">${esc(input.secondary.label)}</a>` : ''}
    </div>
  </div>
</section>`;
}
