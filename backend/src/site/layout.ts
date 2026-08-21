import { esc } from '../messaging/render.ts';

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
  { path: '/industries', label: 'Industries', group: 'Product' },
  { path: '/blog', label: 'Blog', group: 'Company' },
  { path: '/developers', label: 'Developers', group: 'Product' },
  { path: '/contact', label: 'Contact', group: 'Company' },
  { path: '/get-started', label: 'Get started', group: 'Product' },
  { path: '/growth', label: 'Growth & Influencers', group: 'Company' },
  { path: '/terms', label: 'Terms of Service', group: 'Legal' },
  { path: '/privacy', label: 'Privacy Policy', group: 'Legal' },
  { path: '/policies', label: 'All policies', group: 'Legal' },
  { path: '/status', label: 'Platform status', group: 'Legal' },
] as const;

/** The primary nav — a subset, because twelve items in a header is not a header. */
const PRIMARY: NavLink[] = [
  { href: '/how-it-works', label: 'How it works' },
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
};

function head(meta: PageMeta): string {
  const title = `${esc(meta.title)} · CONSTRUX.AI`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(meta.path)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(meta.description)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0c0c0e">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
</head>`;
}

function header(current: string): string {
  const links = PRIMARY.map(
    (link) =>
      `<a href="${esc(link.href)}"${link.href === current ? ' aria-current="page"' : ''}>${esc(link.label)}</a>`,
  ).join('');

  return `<header class="site-head">
  <div class="wrap head-row">
    <a class="mark" href="/" aria-label="CONSTRUX.AI home">
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v7H3zM11 3h7v7h-7zM3 11h7v7H3z" fill="#ff6600"/><path d="M11 11h7v7h-7z" fill="#f5f7fa"/></svg>
      <span>CONSTRU<span class="x">X</span></span>
    </a>
    <nav class="site-nav" aria-label="Primary">${links}</nav>
    <div class="head-cta">
      <a class="btn ghost" href="/app">Sign in</a>
      <a class="btn" href="/get-started">Get started</a>
    </div>
    <button class="nav-toggle" aria-expanded="false" aria-controls="mobile-nav" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
  </div>
  <nav class="mobile-nav" id="mobile-nav" hidden aria-label="Primary, mobile">
    ${SITE_PAGES.map((p) => `<a href="${esc(p.path)}">${esc(p.label)}</a>`).join('')}
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

  return `<footer class="site-foot">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <div class="mark"><span>CONSTRU<span class="x">X</span></span></div>
        <p>The record of how an asset came to exist — governed, evidenced and verifiable from concept to thirty-year operation.</p>
        <p class="foot-status"><a href="/status"><span class="dot"></span> All systems operational</a></p>
      </div>
      ${columns}
    </div>
    <div class="foot-base">
      <span>&copy; ${new Date().getUTCFullYear()} CONSTRUX.AI</span>
      <span class="foot-links"><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/policies">Policies</a></span>
    </div>
  </div>
</footer>
<script src="/site.js" defer></script>`;
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
