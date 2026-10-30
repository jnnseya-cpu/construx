/**
 * Reading a rate card, shared by every screen that imports one.
 *
 * A firm's price list arrives two ways: pasted (a few lines typed, or columns
 * copied from a spreadsheet) or chosen as a CSV file. Both end as the same list
 * of entries the import route takes. These helpers are the one place that
 * reading is defined, so the permanent library import (Tender & Procurement) and
 * the per-tender import (Bid-On) cannot drift apart.
 *
 * No dependency: the platform carries none, and a native .xlsx is a zip that
 * needs a parser it does not carry — CSV export is the bridge.
 */

/**
 * RFC 4180-ish CSV: fields split on commas, records on newlines, a double quote
 * escapes both, and "" inside a quoted field is one literal quote.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** One CSV record (a single pasted line) into its fields, quotes respected. */
export function splitCsvLine(line) {
  const rows = parseCsv(line);
  return rows.length > 0 ? rows[0] : [line];
}

/**
 * A CSV price list into the tab-joined lines the paste box reads.
 *
 * A real exported sheet has many columns in the firm's own order and a header
 * row. The five columns needed are mapped by their header names where there is a
 * header — code, description, unit, the adopted/used rate (never an extended
 * amount or a low/high band), and a note/inclusions column — or by position when
 * there is not. Tab-joined, so a description keeps its own commas and the person
 * can read and edit the result before importing.
 */
export function csvRateCardToLines(text) {
  const rows = parseCsv(text).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (rows.length === 0) return '';

  // Find the header row rather than assume it is the first. A real exported sheet
  // has a title and a subtitle above the column names ("37 measured items", then
  // a note, then "Code,Description,Unit,…"). The header is the first row that
  // names BOTH a description-like column AND a unit-or-rate column — a title or a
  // subtitle names at most one, so this skips them without guessing.
  const headerish = (cells) => {
    // Only short cells can be column labels; a long cell is a sentence (a
    // subtitle, or a data row's description/note), never a header. Then the
    // description token is anchored at the start of a cell so a data description
    // that happens to contain "work" or "rate" cannot pass as a header.
    const labels = cells.map((cell) => String(cell ?? '').trim().toLowerCase()).filter((h) => h.length > 0 && h.length <= 40);
    const hasDesc = labels.some((h) => /^(description|desc|item|work\s*item|resource|service|operation|activity)\b/.test(h));
    const hasUnit = labels.some((h) => /^(unit|rate\s*unit|uom)\b/.test(h));
    const hasRate = labels.some((h) => /\b(rate|price)\b/.test(h));
    return hasDesc && (hasUnit || hasRate);
  };
  const headerIdx = rows.findIndex(headerish);

  let idx = { code: 0, description: 1, unit: 2, rate: 3, note: 4 };
  let dataRows = rows;
  if (headerIdx >= 0) {
    const header = rows[headerIdx].map((cell) => String(cell ?? '').trim().toLowerCase());
    const find = (re) => header.findIndex((h) => re.test(h));
    const rateCols = header
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => /rate|price|cost/.test(h) && !/amount|total|unit|per /.test(h));
    const rateIdx = (rateCols.find(({ h }) => /adopt|used|chosen|unit rate/.test(h)) ?? rateCols[0])?.i ?? -1;
    idx = {
      code: find(/code|ref|head/),
      description: find(/descr|item|work|resource|service/),
      unit: find(/unit|uom/),
      rate: rateIdx,
      note: find(/note|inclusion|exclusion|scope|comment|remark/),
    };
    dataRows = rows.slice(headerIdx + 1);
  }

  const cell = (row, i) => (i >= 0 && i < row.length ? String(row[i] ?? '').trim() : '');
  const lines = [];
  for (const row of dataRows) {
    const code = cell(row, idx.code);
    const description = cell(row, idx.description);
    const unit = cell(row, idx.unit);
    const rate = cell(row, idx.rate);
    const note = cell(row, idx.note);
    if (!description && !rate) continue;
    const cols = [code, description, unit, rate];
    if (note) cols.push(note);
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}

/**
 * The paste box's text into the entries the import route takes.
 *
 * A line is split before it is trimmed, so a blank leading code column (a
 * resource line with a note but no code) keeps its columns. A tab means
 * spreadsheet columns; otherwise the comma form is read as CSV so a quoted
 * description with commas stays whole. Four or more fields means a code is
 * present; exactly three is the code-less form; fewer is sent as it stands so
 * the server names it rather than the browser hiding it.
 */
export function parseRateCardEntries(cardText) {
  return String(cardText ?? '')
    .split('\n')
    .map((original, index) => ({ original, line: index + 1 }))
    .filter((row) => row.original.trim().length > 0)
    .map((row) => {
      const parts = (row.original.includes('\t') ? row.original.split('\t') : splitCsvLine(row.original)).map((part) =>
        String(part ?? '').trim(),
      );
      const raw = row.original.trim();
      const hasCode = parts.length >= 4;
      const code = hasCode ? parts[0] : '';
      const description = hasCode ? parts[1] : parts[0];
      const unit = hasCode ? parts[2] : parts[1];
      const rateText = hasCode ? parts[3] : parts[2];
      const note = hasCode ? parts.slice(4).join(', ') : '';
      const rate = Number(rateText);
      const rateMinor = Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) : undefined;
      return {
        line: row.line,
        raw,
        ...(code ? { code } : {}),
        ...(description ? { description } : {}),
        ...(unit ? { unit } : {}),
        ...(rateMinor !== undefined ? { rateMinor } : {}),
        ...(note ? { note } : {}),
      };
    });
}

/**
 * The library key for an item, normalised exactly as the server's `rateKey`
 * does, so a measured line and a library rate for the same work on the same unit
 * match here the same way. Kept in step with `backend/src/domain/costintel.ts`.
 */
export function rateKeyFor(description, unit) {
  const normalised = String(description ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalised}::${String(unit ?? '').toLowerCase().trim()}`;
}

/**
 * The outcome line for a rate-card import result, shared so the permanent and
 * per-tender imports report the same way: how many imported, how many replaced,
 * and any line skipped with its reason. `heldNote` is the one-liner that differs
 * by scope (the permanent library vs this tender only).
 */
export function rateCardReport(res, heldNote) {
  const totals = res?.totals ?? {};
  const imported = Number(totals.imported ?? 0);
  const replaced = Number(totals.replaced ?? 0);
  const skipped = Array.isArray(res?.skipped) ? res.skipped : [];
  const reasons = skipped
    .slice(0, 3)
    .map((row) => `line ${row.line ?? '?'}: ${row.reason}`)
    .join('; ');
  const tail = skipped.length > 3 ? ` (+${skipped.length - 3} more)` : '';
  if (imported === 0) {
    return {
      title: 'Nothing imported',
      message: skipped.length ? `No line could be read. ${reasons}${tail}` : 'No valid rate lines were found.',
      tone: 'warn',
    };
  }
  const head = `${imported} rate${imported === 1 ? '' : 's'} imported${replaced ? ` (${replaced} replaced an existing rate)` : ''}`;
  if (skipped.length) {
    return { title: head, message: `${skipped.length} line(s) skipped — ${reasons}${tail}`, tone: 'warn' };
  }
  return { title: head, message: heldNote, tone: 'ok' };
}
