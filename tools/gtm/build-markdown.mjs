import { readFileSync, writeFileSync } from 'node:fs';

/**
 * HTML → Markdown for this one document.
 *
 * Not a general converter: it knows exactly the markup gtm.html uses, which is
 * why it can produce clean output instead of the soup a generic tool gives.
 */

const S = new URL('../../docs/go-to-market/', import.meta.url).pathname;
const html = readFileSync(`${S}/go-to-market.html`, 'utf8');

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—')
  .replace(/&middot;/g, '·').replace(/&rarr;/g, '→').replace(/&nbsp;/g, ' ');

/** Inline markup only — bold, em, code — everything else is dropped. */
const inline = (s) => decode(
  s.replace(/<(strong|b)>(.*?)<\/\1>/gis, '**$2**')
   .replace(/<(em|i)>(.*?)<\/\1>/gis, '*$2*')
   .replace(/<span class="mono">(.*?)<\/span>/gis, '`$1`')
   .replace(/<br\s*\/?>/gi, ' ')
   .replace(/<[^>]+>/g, ''),
).replace(/\s+/g, ' ').trim();

const out = [];
const body = html.slice(html.indexOf('<header class="titleblock">'));

// ── Front matter ───────────────────────────────────────────────────────────
out.push('# CONSTRUX.AI — GO-TO-MARKET', '');
out.push('**Greater Manchester launch · 90-day programme · first 100 customers**', '');
const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(body);
if (h1) out.push(`> ${inline(h1[1])}`, '');
const stand = /<p class="standfirst">([\s\S]*?)<\/p>/.exec(body);
if (stand) out.push(inline(stand[1]), '');

// At-a-glance cells become a definition list.
const cells = [...body.matchAll(/<div class="tb-cell"><span class="k">(.*?)<\/span><span class="v"[^>]*>(.*?)<small>(.*?)<\/small><\/span><\/div>/gs)];
if (cells.length) {
  out.push('| | |', '|---|---|');
  for (const c of cells) out.push(`| **${inline(c[1])}** | ${inline(c[2])} — ${inline(c[3])} |`);
  out.push('');
}

// ── Sections ───────────────────────────────────────────────────────────────
const sections = [...body.matchAll(/<section id="([^"]+)">([\s\S]*?)<\/section>/g)];

for (const [, id, sec] of sections) {
  const num = /<div class="sec-num">(\d+)<\/div>/.exec(sec);
  const title = /<h2>([\s\S]*?)<\/h2>/.exec(sec);
  out.push('', '---', '', `## ${num ? num[1] + ' · ' : ''}${title ? inline(title[1]) : id}`, '');
  const sub = /<p class="sub">([\s\S]*?)<\/p>/.exec(sec);
  if (sub) out.push(`*${inline(sub[1])}*`, '');

  // Walk the section in document order so nothing is reordered.
  const re = /<h3>([\s\S]*?)<\/h3>|<h4>([\s\S]*?)<\/h4>|<div class="flag([^"]*)">([\s\S]*?)<\/div>\s*(?=<|$)|<div class="panel">([\s\S]*?)<\/div>\s*(?=<)|<table>([\s\S]*?)<\/table>|<p class="col"[^>]*>([\s\S]*?)<\/p>|<p(?: class="[^"]*")?>([\s\S]*?)<\/p>|<ul class="col">([\s\S]*?)<\/ul>|<ol class="col">([\s\S]*?)<\/ol>|<div class="gate-bar">([\s\S]*?)<\/div>/g;

  let m;
  while ((m = re.exec(sec)) !== null) {
    const [, h3, h4, flagCls, flagBody, panel, tbl, pcol, pplain, ul, ol, gate] = m;

    if (h3) { out.push('', `### ${inline(h3)}`, ''); continue; }
    if (h4 && !flagBody) { out.push('', `**${inline(h4)}**`, ''); continue; }

    if (gate) {
      const gid = /<span class="g-id">(.*?)<\/span>/.exec(gate);
      const gname = /<span class="g-name">(.*?)<\/span>/.exec(gate);
      const gwhen = /<span class="g-when">(.*?)<\/span>/.exec(gate);
      out.push('', `### ${gid ? inline(gid[1]) : ''} — ${gname ? inline(gname[1]) : ''}`, '',
        gwhen ? `\`${inline(gwhen[1])}\`` : '', '');
      continue;
    }

    if (flagBody !== undefined) {
      const ftitle = /<h4>([\s\S]*?)<\/h4>/.exec(flagBody);
      const mark = flagCls.includes('stop') ? '🛑' : flagCls.includes('check') ? '✅' : '▶';
      out.push('', `> ${mark} **${ftitle ? inline(ftitle[1]) : 'Note'}**`, '>');
      for (const li of [...flagBody.matchAll(/<li>([\s\S]*?)<\/li>/g)]) out.push(`> - ${inline(li[1])}`);
      for (const pp of [...flagBody.matchAll(/<p class="col"[^>]*>([\s\S]*?)<\/p>/g)]) out.push(`> ${inline(pp[1])}`, '>');
      out.push('');
      continue;
    }

    if (panel !== undefined) {
      for (const pp of [...panel.matchAll(/<p class="col"[^>]*>([\s\S]*?)<\/p>/g)]) out.push('', `> ${inline(pp[1])}`, '');
      for (const li of [...panel.matchAll(/<li>([\s\S]*?)<\/li>/g)]) out.push(`> - ${inline(li[1])}`);
      continue;
    }

    if (tbl) {
      const heads = [...tbl.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => inline(x[1]) || ' ');
      if (!heads.length) continue;
      out.push('', `| ${heads.join(' | ')} |`, `|${heads.map(() => '---').join('|')}|`);
      const bodyPart = tbl.slice(tbl.indexOf('</thead>') + 8);
      for (const tr of [...bodyPart.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]) {
        const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map((x) => inline(x[1]).replace(/\|/g, '\\|') || ' ');
        if (tds.length) out.push(`| ${tds.join(' | ')} |`);
      }
      out.push('');
      continue;
    }

    if (ul) { for (const li of [...ul.matchAll(/<li>([\s\S]*?)<\/li>/g)]) out.push(`- ${inline(li[1])}`); out.push(''); continue; }
    if (ol) { let n = 1; for (const li of [...ol.matchAll(/<li>([\s\S]*?)<\/li>/g)]) out.push(`${n++}. ${inline(li[1])}`); out.push(''); continue; }

    // The section subtitle is already emitted above; the generic paragraph
    // pattern would otherwise repeat it verbatim.
    if (m[0].includes('class="sub"')) continue;
    const text = pcol ?? pplain;
    if (text) { const s2 = inline(text); if (s2) out.push(s2, ''); }
  }
}

// ── Footer ─────────────────────────────────────────────────────────────────
const foot = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(body);
if (foot) {
  out.push('', '---', '', '## Sources and honesty notes', '');
  for (const pp of [...foot[1].matchAll(/<p>([\s\S]*?)<\/p>/g)]) out.push(inline(pp[1]), '');
}

const md = out.join('\n')
  .replace(/^>\s*$\n(?=\n|$)/gm, '')   // trailing empty quote lines
  .replace(/\n{3,}/g, '\n\n')
  .trim() + '\n';
writeFileSync(`${S}/GO-TO-MARKET.md`, md);
console.log('GO-TO-MARKET.md —', (md.length / 1024).toFixed(1), 'kB,', md.split('\n').length, 'lines');
console.log('sections:', (md.match(/^## /gm) || []).length, '| tables:', (md.match(/^\|---/gm) || []).length);
for (const probe of ['Greater Manchester', '162,750', 'High Rise Task Force', 'Deansgate', 'Kill criteria', 'marketwaros'])
  console.log((md.includes(probe) ? '  ok  ' : '  MISSING  ') + probe);
