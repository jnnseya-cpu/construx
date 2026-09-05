import { esc } from '../messaging/render.ts';
import { absolute } from './layout.ts';

/**
 * How a post is set on the page.
 *
 * Everything that turns a post's *data* — a title, a tag, paragraphs, a date —
 * into the article a reader sees and shares: the byline with its reading time,
 * the share bar, the contextual links into the rest of the site, and the
 * section conventions a body may carry. It sits apart from `pages.ts` because
 * that file builds every page on the site, and the blog index, the post page
 * and (later) a syndication feed all need the same answer to "how long is this
 * to read" and "what does the LinkedIn link look like". One answer, here.
 *
 * Three rules hold throughout.
 *
 * **Nothing here writes.** A share link is a link to LinkedIn's own composer,
 * with the post's address in it. Whether anybody presses it is counted by the
 * page's script through `/v1/site/engagement`, as a request, and labelled that
 * way — the same discipline `views.ts` keeps for page requests.
 *
 * **Links go to pages that exist.** The glossary below maps a phrase to a path
 * on this site, and `discovery.test.ts` and the newsletter tests already hold
 * every public path against the router. A term is linked once per article, on
 * its first appearance, never inside `<code>` or an existing link, and never to
 * the page being read.
 *
 * **Markup is only ever produced here.** A stored post's paragraphs arrive
 * escaped; a compiled post's arrive as the trusted markup written into the
 * repository. Both pass through the same section conventions and the same
 * linker, and the linker only ever inserts an `<a>` whose href comes from the
 * glossary — so nothing a model or a form typed can become a tag.
 */

/** Words per minute a reader manages on technical prose. */
const WORDS_PER_MINUTE = 220;

/** Words in a body, counted the way a crawler would. */
export function wordsOf(body: readonly string[]): number {
  return body
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Minutes to read, never less than one. */
export function readMinutes(body: readonly string[]): number {
  return Math.max(1, Math.ceil(wordsOf(body) / WORDS_PER_MINUTE));
}

/**
 * Who set the words down, as the byline names it.
 *
 * Read from the record's authorship rather than written into the sentence, so
 * a post a model drafted says so on its face and one a person wrote does too.
 * The compiled engineering notes have no authorship field: they are the notes
 * this project's engineers actually wrote.
 */
export function engineName(authorship?: 'HUMAN' | 'AI_DRAFTED' | 'MARKETING_AGENT'): string {
  switch (authorship) {
    case 'AI_DRAFTED':
      return 'CONSTRUX AI Content Engine';
    case 'MARKETING_AGENT':
      return 'CONSTRUX Marketing Agent';
    case 'HUMAN':
      return 'CONSTRUX Editorial';
    default:
      return 'CONSTRUX Engineering';
  }
}

/**
 * The line under the headline: `Category · Engine · N min read · date`.
 *
 * The separator is a middle dot in text, not a list, so it reads the same in a
 * link preview that strips the markup.
 */
export function byline(input: { tag: string; authorship?: 'HUMAN' | 'AI_DRAFTED' | 'MARKETING_AGENT'; body: readonly string[]; date: string; longDate: string }): string {
  const minutes = readMinutes(input.body);
  return `<p class="post-byline">
      <span class="tag">${esc(input.tag)}</span>
      <span class="byline-sep" aria-hidden="true">·</span>
      <span class="byline-engine">${esc(engineName(input.authorship))}</span>
      <span class="byline-sep" aria-hidden="true">·</span>
      <span class="byline-read">${minutes} min read</span>
      <span class="byline-sep" aria-hidden="true">·</span>
      <time datetime="${esc(input.date)}">${esc(input.longDate)}</time>
    </p>`;
}

// --- Sharing ------------------------------------------------------------------

export type ShareChannel = 'copy' | 'linkedin' | 'x' | 'whatsapp' | 'email';

/** The channels a post can be shared to, in the order the bar shows them. */
export const SHARE_CHANNELS: ReadonlyArray<{ id: ShareChannel; label: string }> = [
  { id: 'copy', label: 'Copy link' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'email', label: 'Email' },
];

/**
 * Where each share link goes.
 *
 * Each is the network's own public composer with the post's absolute address
 * in it. No SDK, no tracking parameter, no script from the network: the link
 * is the whole integration, and it works with scripting off. The copy button
 * is the one control that needs the page's script, and it is rendered as a
 * button rather than a link so a reader without one is not handed a dead link.
 */
export function shareTargets(input: { url: string; title: string }): Record<Exclude<ShareChannel, 'copy'>, string> {
  const url = encodeURIComponent(input.url);
  const title = encodeURIComponent(input.title);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    x: `https://x.com/intent/post?text=${title}&url=${url}`,
    whatsapp: `https://wa.me/?text=${title}%20${url}`,
    email: `mailto:?subject=${title}&body=${title}%0A%0A${url}`,
  };
}

/**
 * The share bar, at the top and the foot of every post.
 *
 * `data-share` names the channel and `data-slug` the post, which is what the
 * page's script sends to `/v1/site/engagement` when a link is pressed. The
 * links are ordinary links first: a reader with scripting off shares through
 * them unchanged and simply is not counted.
 */
export function shareBar(input: { slug: string; url: string; title: string; position: 'top' | 'bottom' }): string {
  const targets = shareTargets(input);
  const links = SHARE_CHANNELS.map((channel) =>
    channel.id === 'copy'
      ? `<button type="button" class="share-link share-copy" data-share="copy" data-slug="${esc(input.slug)}" data-url="${esc(input.url)}">${esc(channel.label)}</button>`
      : `<a class="share-link" href="${esc(targets[channel.id])}" target="_blank" rel="noopener noreferrer" data-share="${channel.id}" data-slug="${esc(input.slug)}">${esc(channel.label)}</a>`,
  ).join('\n      ');
  return `<nav class="share-bar share-${input.position}" aria-label="Share this post">
      <span class="share-label">Share:</span>
      ${links}
    </nav>`;
}

// --- Contextual links --------------------------------------------------------

/**
 * Phrases that have a page on this site, and the page.
 *
 * Longer phrases first, so "pay less notice" links before "notice" would have
 * a chance to, and so a phrase inside another is never linked twice. Every
 * path here is a public page the router serves; a path that is not would fail
 * `discovery.test.ts` the moment it appeared in a rendered post.
 */
export const LINK_GLOSSARY: ReadonlyArray<{ term: string; path: string }> = [
  { term: 'what one missed notice is worth', path: '/exposure' },
  { term: 'demonstration environment', path: '/demo' },
  { term: 'demo environment', path: '/demo' },
  { term: 'golden thread', path: '/how-it-works' },
  { term: 'seven engines', path: '/how-it-works' },
  { term: 'seven ai engines', path: '/how-it-works' },
  { term: 'how it works', path: '/how-it-works' },
  { term: 'pay less notice', path: '/exposure' },
  { term: 'pay-less notice', path: '/exposure' },
  { term: 'payment notice', path: '/exposure' },
  { term: 'construction act', path: '/exposure' },
  // Phrases the engineering notes and the composed posts actually use, each
  // pointing at the page that genuinely covers it: the stage strip on How it
  // works names hold points and inspection and test plans and describes clause
  // extraction; the verify page is about the content hash; the industries page
  // holds currency per jurisdiction; the developers page describes the tokens.
  { term: 'inspection and test plan', path: '/how-it-works' },
  // The about page's whole argument is what adjudication teaches.
  { term: 'adjudication', path: '/about' },
  { term: 'adjudicator', path: '/about' },
  { term: 'demonstration project', path: '/demo' },
  { term: 'payment certificate', path: '/exposure' },
  { term: 'event catalogue', path: '/how-it-works' },
  { term: 'content hash', path: '/verify-document' },
  { term: 'access token', path: '/developers' },
  { term: 'hash-chained', path: '/how-it-works' },
  { term: 'hold point', path: '/how-it-works' },
  { term: 'specification', path: '/how-it-works' },
  { term: 'currency', path: '/industries' },
  { term: 'civil infrastructure', path: '/industries' },
  { term: 'water treatment', path: '/industries' },
  { term: 'industries', path: '/industries' },
  { term: 'verify a document', path: '/verify-document' },
  { term: 'developers', path: '/developers' },
  { term: 'the api', path: '/developers' },
  { term: 'pricing', path: '/get-started' },
  { term: 'get started', path: '/get-started' },
  { term: 'about construx', path: '/about' },
  { term: 'engineering notes', path: '/blog' },
  { term: 'the blog', path: '/blog' },
];

/** At most this many contextual links in one paragraph, so prose stays prose. */
const LINKS_PER_PARAGRAPH = 2;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Link the first appearance of each glossary phrase across an article.
 *
 * Works on HTML, paragraph by paragraph, and only touches text: tags are
 * skipped, and text inside `<a>` or `<code>` is left alone — a link inside a
 * link is invalid markup and a phrase inside a code span is code. A phrase is
 * linked once per article; `exclude` names the page being read so an article
 * about the blog does not link to the blog.
 *
 * `used` is threaded through so the caller can see which pages the article
 * now points at — that is what the internal-linking check on the SEO screen
 * reads, and it reads the same function rather than re-deriving the rule.
 */
export function hyperlink(
  paragraphs: readonly string[],
  options: { exclude?: string } = {},
): { paragraphs: string[]; linked: Array<{ term: string; path: string }> } {
  const linked: Array<{ term: string; path: string }> = [];
  const seenTerms = new Set<string>();

  const out = paragraphs.map((paragraph) => {
    let inParagraph = 0;
    // Split into tags and text. Tags pass through; text is searched.
    const parts = paragraph.split(/(<[^>]+>)/g);
    let depthSkip = 0; // inside <a> or <code>
    return parts
      .map((part) => {
        if (part.startsWith('<')) {
          if (/^<(a|code)\b/i.test(part)) depthSkip += 1;
          else if (/^<\/(a|code)\b/i.test(part)) depthSkip = Math.max(0, depthSkip - 1);
          return part;
        }
        if (depthSkip > 0 || part.trim() === '') return part;

        let text = part;
        for (const entry of LINK_GLOSSARY) {
          if (inParagraph >= LINKS_PER_PARAGRAPH) break;
          if (seenTerms.has(entry.term) || entry.path === options.exclude) continue;
          // Already linked to this page from an earlier phrase: one link per
          // destination reads as a reference; three read as an advertisement.
          if (linked.some((item) => item.path === entry.path)) continue;
          const pattern = new RegExp(`(^|[^\\w])(${escapeRegExp(entry.term)})(?![\\w])`, 'i');
          const match = pattern.exec(text);
          if (!match || match.index === undefined) continue;
          const start = match.index + match[1]!.length;
          const found = match[2]!;
          text = `${text.slice(0, start)}<a href="${esc(entry.path)}">${found}</a>${text.slice(start + found.length)}`;
          seenTerms.add(entry.term);
          linked.push({ term: entry.term, path: entry.path });
          inParagraph += 1;
        }
        return text;
      })
      .join('');
  });

  return { paragraphs: out, linked };
}

// --- Sections ------------------------------------------------------------------

/**
 * The conventions a body may carry, so a post can have sections without the
 * body becoming markup somebody typed.
 *
 * A paragraph beginning `## ` is a section heading. One beginning `> ` is a
 * pull-quote. Everything else is a paragraph. That is the whole grammar: two
 * prefixes on the plain paragraphs the record already holds, so a post written
 * before this existed renders exactly as it did, and a model asked for
 * sections has two characters to learn rather than a markup language.
 *
 * The text arrives already escaped (a stored post) or already trusted (a
 * compiled one); this function decides the element and nothing else.
 */
export function setBody(paragraphs: readonly string[]): string {
  return paragraphs
    .map((paragraph) => {
      if (paragraph.startsWith('## ')) return `<h2>${paragraph.slice(3).trim()}</h2>`;
      if (paragraph.startsWith('&gt; ')) return `<blockquote class="pullquote"><p>${paragraph.slice(5).trim()}</p></blockquote>`;
      if (paragraph.startsWith('> ')) return `<blockquote class="pullquote"><p>${paragraph.slice(2).trim()}</p></blockquote>`;
      return `<p>${paragraph}</p>`;
    })
    .join('\n    ');
}

/** The section headings an article carries, for the structure check. */
export function headingsOf(paragraphs: readonly string[]): string[] {
  return paragraphs.filter((paragraph) => paragraph.startsWith('## ')).map((paragraph) => paragraph.slice(3).trim());
}

/**
 * The closing call to action every post ends on.
 *
 * One destination, the demonstration, because it is the only page on the site
 * where a reader can do the thing the article described rather than read about
 * it. `data-share="demo"` lets the page's script count the press as a click.
 */
export function articleCta(slug: string): string {
  return `<div class="post-cta">
      <p>See the record being made rather than described.</p>
      <a class="btn lg" href="/demo" data-share="demo" data-slug="${esc(slug)}">Launch the demo environment</a>
    </div>`;
}

/** The absolute address of a post, for canonical links, cards and the share bar. */
export function postUrl(slug: string): string {
  return absolute(`/blog/${slug}`);
}
