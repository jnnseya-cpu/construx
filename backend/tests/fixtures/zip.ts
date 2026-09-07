import { deflateRawSync } from 'node:zlib';

/**
 * A ZIP written by hand: local headers, a central directory and the end record,
 * so the reader's preferred path is exercised. `descriptor` writes zero sizes
 * into the local header the way an archiver streaming its output does, leaving
 * the central directory as the only place the sizes are stated.
 *
 * Two suites build containers — the IFC reader's, and the Office reader's —
 * and the format is one format.
 */
export function zipOf(
  entries: Array<{ name: string; data: Buffer; stored?: boolean }>,
  options: { descriptor?: boolean } = {},
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = entry.stored ? entry.data : deflateRawSync(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.descriptor ? 8 : 0, 6);
    local.writeUInt16LE(entry.stored ? 0 : 8, 8);
    local.writeUInt32LE(options.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(options.descriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.stored ? 0 : 8, 10);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** A minimal but real `.docx`: the parts a reader looks at, and nothing else. */
export function docxOf(bodyXml: string): Buffer {
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/></Types>',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          bodyXml +
          '</w:body></w:document>',
      ),
    },
  ]);
}

/** A Word paragraph of one run, as Word writes it. */
export function paragraph(text: string): string {
  return `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** A Word table: one `<w:tr>` per row, one `<w:tc>` per cell. */
export function wordTable(rows: string[][]): string {
  const cells = (row: string[]): string => row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('');
  return `<w:tbl>${rows.map((row) => `<w:tr>${cells(row)}</w:tr>`).join('')}</w:tbl>`;
}

/**
 * A minimal but real `.xlsx`, with the shared string table Excel actually
 * writes: every text cell is an index into it, so a reader that ignores it
 * reads a spreadsheet of integers.
 */
export function xlsxOf(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const strings: string[] = [];
  const indexOf = (value: string): number => {
    const at = strings.indexOf(value);
    if (at !== -1) return at;
    strings.push(value);
    return strings.length - 1;
  };

  const column = (index: number): string => {
    let letters = '';
    let n = index;
    do {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return letters;
  };

  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sheetParts = sheets.map((sheet, index) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, cellIndex) => {
            const reference = `${column(cellIndex)}${rowIndex + 1}`;
            if (cell === '') return `<c r="${reference}"/>`;
            // A number stays a number; everything else goes through the table.
            if (/^-?\d+(\.\d+)?$/.test(cell)) return `<c r="${reference}"><v>${cell}</v></c>`;
            return `<c r="${reference}" t="s"><v>${indexOf(cell)}</v></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    return {
      part: `xl/worksheets/sheet${index + 1}.xml`,
      id: `rId${index + 1}`,
      name: sheet.name,
      xml: `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  const workbook =
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheetParts.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="${sheet.id}"/>`).join('') +
    '</sheets></workbook>';

  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetParts
      .map((sheet) => `<Relationship Id="${sheet.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.part.replace(/^xl\//, '')}"/>`)
      .join('') +
    '</Relationships>';

  const sharedStrings =
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((value) => `<si><t>${escape(value)}</t></si>`).join('') +
    '</sst>';

  return zipOf([
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings) },
    ...sheetParts.map((sheet) => ({ name: sheet.part, data: Buffer.from(sheet.xml) })),
  ]);
}
