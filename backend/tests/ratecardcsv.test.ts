import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The shared rate-card reader is plain, dependency-free JS; import it directly so
// the parsing a real spreadsheet export goes through is guarded by the suite.
import { csvRateCardToLines, parseRateCardEntries } from '../../frontend/lib/ratecard.js';

/**
 * Reading a CSV exported straight from a spreadsheet.
 *
 * The defect this pins: Excel "Save As → CSV" keeps the sheet's title and
 * subtitle rows above the "Code,Description,Unit,…" header. Treating the first
 * row as the header mapped every column off a title and produced nothing, so a
 * real export imported as empty. The reader must find the header row — the first
 * row that names a description column and a unit-or-rate column — and skip the
 * prose above it, without mistaking a data row for a header.
 */

function validEntries(csv: string) {
  return parseRateCardEntries(csvRateCardToLines(csv)).filter(
    (e: any) => e.description && e.unit && e.rateMinor !== undefined,
  );
}

describe('a CSV exported from a spreadsheet, title rows and all', () => {
  it('finds the header beneath the title and subtitle rows', () => {
    const csv = [
      '37 measured items,,,,,',
      '"Supply and install allowances. Edit quantities and adopted rates. No VAT, overhead or profit.",,,,,',
      'Code,Description,Unit,Quantity,Adopted rate £,Inclusions and exclusions',
      'E20.001,"Foundation trench excavation, maximum depth 2m",m,13.63,80,"Assumes 600mm wide, machine dig. Excludes concrete."',
      'E20.007,Facing-brick outer leaf,m2,33.81,145,Standard facing brick and mortar.',
    ].join('\n');
    const rows = validEntries(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.code, 'E20.001');
    assert.equal(rows[0]!.description, 'Foundation trench excavation, maximum depth 2m');
    assert.equal(rows[0]!.unit, 'm');
    assert.equal(rows[0]!.rateMinor, 8000);
    // The comma inside the description is kept, not split into a phantom column.
    assert.ok(rows[0]!.note?.startsWith('Assumes 600mm wide'));
  });

  it('picks the adopted rate over a low/high band and ignores amount columns', () => {
    const csv = [
      'Code,Description,Unit,Low rate £,Adopted rate £,High rate £,Adopted amount £',
      'E20.002,MOT Type 1,m2,25,32,42,652.48',
    ].join('\n');
    const rows = validEntries(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rateMinor, 3200, 'should take the adopted rate (32), not a band or an amount');
  });

  it('skips a data row that merely reads like a header, finding the real one below', () => {
    // Mirrors the Cost heads sheet: a summary table with no description column
    // and data rows whose text contains "work"/"rate", then the resource header.
    const csv = [
      '20 cost heads,,,,',
      'Head no.,Cost head,Treatment,Additional amount £,Basis',
      '1,Direct works labour,Included elsewhere,0,Already in the composite rates',
      'Head no.,Resource / service,Rate unit,Adopted rate £,Scope',
      '1,General labourer,person-day,175,Budget charge rate not wages',
      '4,1.5t excavator,machine-week,230,Operator and fuel excluded',
    ].join('\n');
    const rows = validEntries(csv);
    assert.equal(rows.length, 2, 'the summary table and its data rows must not be read as rates');
    assert.equal(rows[0]!.description, 'General labourer');
    assert.equal(rows[0]!.unit, 'person-day');
    assert.equal(rows[0]!.rateMinor, 17500);
  });

  it('reads a headerless data-only CSV by position', () => {
    const csv = ['R10.004,Readymix GEN3,m3,148', 'F10.001,Blockwork inner leaf,m2,62'].join('\n');
    const rows = validEntries(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.rateMinor, 14800);
  });

  it('yields nothing from a sheet with no rate table (the wrong tab exported)', () => {
    const csv = [
      'Construction estimate and unit-rate schedules,,',
      'Editable control,Value,Basis',
      'Overhead recovery,0.08,Commercial assumption',
      'Profit rate,0.2,Commercial choice',
    ].join('\n');
    assert.equal(validEntries(csv).length, 0);
  });
});
