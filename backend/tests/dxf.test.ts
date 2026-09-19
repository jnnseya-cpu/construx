import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractText } from '../src/evidence/ingest.ts';
import { looksLikeDxf, readDxf } from '../src/evidence/dxf.ts';

/**
 * Reading a 2D CAD drawing.
 *
 * Stated as a requirement: a bid arrives as a mix of Word, PDF, Excel, CAD
 * drawings and BIM models, and the platform has to read all of it. Word, Excel
 * and PDF were read; IFC was read; DWG, RVT and NWD are proprietary binaries
 * that nothing opens without a licence, and the platform says so and asks for
 * an export. DXF is what those tools export to, and it was the gap.
 *
 * **It was worse than unread.** A DXF is ASCII, so the type sniff called it
 * `text/plain` and the whole file went to a model as prose: coordinate pairs,
 * one number per line, inside which it was asked to find tender requirements.
 */

/** A small drawing with a title block, a general note, and some geometry. */
function drawing(): Buffer {
  const pairs: Array<[number, string]> = [
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1027'],
    [9, '$EXTMIN'],
    [10, '0.0'],
    [20, '0.0'],
    [9, '$EXTMAX'],
    [10, '420.0'],
    [20, '297.0'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    // The title block.
    [0, 'TEXT'],
    [8, 'TITLE-BLOCK'],
    [1, '25133-TDC-FN-ZZ-DR-S-1600'],
    [0, 'TEXT'],
    [8, 'TITLE-BLOCK'],
    [1, 'WALL FOUNDATION DETAIL'],
    // A general note, as MTEXT with the formatting a CAD application writes.
    [0, 'MTEXT'],
    [8, 'NOTES'],
    [1, '{\\fArial|b1;NOTES:}\\P1. All dimensions in mm unless noted.\\P2. Concrete to be C32/40 to BS 8500.'],
    // Geometry, which must be counted and never transcribed.
    [0, 'LINE'],
    [8, 'STRUCTURE'],
    [10, '12.5'],
    [20, '30.25'],
    [0, 'LINE'],
    [8, 'STRUCTURE'],
    [10, '98.125'],
    [20, '4.5'],
    [0, 'ARC'],
    [8, 'STRUCTURE'],
    [10, '50.0'],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ];
  return Buffer.from(pairs.map(([code, value]) => `${code}\n${value}`).join('\n'), 'utf8');
}

describe('reading a 2D CAD drawing', () => {
  it('recognises a DXF by its opening group pair, not its extension', () => {
    assert.equal(looksLikeDxf(drawing()), true);
    assert.equal(looksLikeDxf(Buffer.from('Dear Sir,\n\nFurther to your letter of 3 March.\n')), false);
  });

  it('reads the drawing’s own words, with the layer each sits on', () => {
    const read = readDxf(drawing());
    assert.equal(read.kind, 'DXF');
    if (read.kind !== 'DXF') return;

    const values = read.annotations.map((a) => a.value);
    assert.ok(values.includes('25133-TDC-FN-ZZ-DR-S-1600'), 'the drawing number was not read');
    assert.ok(values.includes('WALL FOUNDATION DETAIL'), 'the drawing title was not read');
    assert.equal(read.annotations.find((a) => a.value.includes('C32/40'))?.layer, 'NOTES');
  });

  it('strips the CAD markup so a note reads as the note', () => {
    const read = readDxf(drawing());
    if (read.kind !== 'DXF') return assert.fail('not read');
    const note = read.annotations.find((a) => a.value.includes('C32/40'))!.value;

    assert.ok(note.startsWith('NOTES:'), `the font markup was left in: ${note}`);
    assert.ok(!note.includes('\\P') && !note.includes('\\f') && !note.includes('{'), `markup survived: ${note}`);
    assert.match(note, /1\. All dimensions in mm/);
  });

  it('counts the geometry and transcribes none of it', () => {
    const read = readDxf(drawing());
    if (read.kind !== 'DXF') return assert.fail('not read');

    assert.deepEqual(
      read.entities.filter((e) => e.type === 'LINE' || e.type === 'ARC'),
      [{ type: 'LINE', count: 2 }, { type: 'ARC', count: 1 }],
    );
    // The whole point. A coordinate list in front of a model is what this
    // module exists to stop.
    for (const coordinate of ['12.5', '98.125', '30.25', '4.5']) {
      assert.ok(!read.text.includes(coordinate), `the coordinate ${coordinate} was transcribed into the text`);
    }
  });

  it('carries the layers, the extents and the version, which is how a reader tells a detail from a layout', () => {
    const read = readDxf(drawing());
    if (read.kind !== 'DXF') return assert.fail('not read');
    assert.deepEqual(read.layers.sort(), ['NOTES', 'STRUCTURE', 'TITLE-BLOCK']);
    assert.deepEqual(read.extents, { min: [0, 0], max: [420, 297] });
    assert.equal(read.version, 'AC1027');
  });

  it('refuses a binary DXF rather than guessing at it', () => {
    const binary = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\u001a\u0000', 'latin1'), Buffer.alloc(64)]);
    const read = readDxf(binary);
    assert.equal(read.kind, 'UNREADABLE');
    if (read.kind !== 'UNREADABLE') return;
    assert.match(read.reason, /ASCII DXF/, 'the remedy does not say what to export instead');
  });

  it('is reached from ingestion instead of the file being handed over as prose', () => {
    // The regression: a DXF sniffs as text, and `extractText` used to return
    // the raw group codes.
    const extracted = extractText(drawing(), 'text/plain');
    assert.equal(extracted.method, 'NATIVE');
    assert.ok(extracted.text?.includes('WALL FOUNDATION DETAIL'), 'the drawing was not read as a drawing');
    assert.ok(!extracted.text?.includes('98.125'), 'the raw coordinates came through');
    assert.match(String(extracted.note), /geometry is counted/);
  });

  it('says so when a drawing carries no text at all', () => {
    const blank = Buffer.from(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'X', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
    const read = readDxf(blank);
    if (read.kind !== 'DXF') return assert.fail('not read');
    assert.equal(read.annotations.length, 0);
    assert.match(String(read.note), /no text at all/);
  });
});
