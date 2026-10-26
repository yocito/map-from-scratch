// UCDP GED 26.1 -> one compact point file per year, plus a small land path.
// Keeping years separate makes the first view a single short request.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { source } from '../../tools/sources.ts';
import { mercator, polygonsOf, simplify } from '../../tools/geo.ts';

const OUT = 'data/baked/20-ucdp-ged-timeline';
const START = 1989, END = 2025, SIZE = 18;
const input = source('ucdp-ged-26.1');
mkdirSync(OUT, { recursive: true });
const query = (sql: string) => execFileSync('duckdb', ['-noheader', '-csv', '-c', sql], { encoding: 'utf8', maxBuffer: 80 << 20 }).trimEnd();
const years: Record<number, { events: number[]; deaths: number[] }> = {};
const blocks = new Map<number, Buffer[]>();
for (let year = START; year <= END; year++) { years[year] = { events: [0, 0, 0], deaths: [0, 0, 0] }; blocks.set(year, []); }
const sql = `SELECT year,longitude,latitude,best,id,type_of_violence,where_prec,country_id,date_diff('day',make_date(year,1,1),date_start) FROM read_parquet('${input}') ORDER BY year,id;`;
const rows = query(sql).split('\n');
let totalDeaths = 0;
for (const line of rows) {
  const [year, lon, lat, deaths, id, type, precision, country, day] = line.split(',').map(Number);
  if (!Number.isInteger(year) || year < START || year > END || !Number.isFinite(lon) || !Number.isFinite(lat)
      || !Number.isInteger(deaths) || deaths < 0 || !Number.isInteger(id) || ![1, 2, 3].includes(type)) throw new Error(`Invalid GED row: ${line}`);
  const [x, y] = mercator([lon, lat]);
  const b = Buffer.allocUnsafe(SIZE);
  b.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(x * 65535))), 0);
  b.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(y * 65535))), 2);
  b.writeUInt32LE(deaths, 4);
  b.writeUInt32LE(id, 8);
  b.writeUInt16LE(day, 12);
  b.writeUInt8(type, 14);
  b.writeUInt8(precision, 15);
  b.writeUInt16LE(country, 16);
  blocks.get(year)!.push(b);
  years[year].events[type - 1]++;
  years[year].deaths[type - 1] += deaths;
  totalDeaths += deaths;
}
if (rows.length !== 417968 || totalDeaths !== 4257891) throw new Error(`Unexpected GED source: ${rows.length} events, ${totalDeaths} deaths`);
for (let year = START; year <= END; year++) {
  const records = blocks.get(year)!;
  const header = Buffer.alloc(8);
  header.write('GED1'); header.writeUInt32LE(records.length, 4);
  writeFileSync(join(OUT, `${year}.bin`), Buffer.concat([header, ...records]));
}
const countryRows = query(`SELECT country_id,hex(encode(min(country))) FROM read_parquet('${input}') GROUP BY country_id ORDER BY country_id;`)
  .split('\n').map((line) => { const [id, hex] = line.split(','); return [Number(id), Buffer.from(hex, 'hex').toString('utf8')] as const; });
const countries = Object.fromEntries(countryRows);
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ release: '26.1', start: START, end: END, years, countries }));

// A muted coastline provides location context without downloading a map engine.
type Feature = { properties: { ADM0_A3: string }; geometry: { type: string; coordinates: unknown } | null };
const ne: { features: Feature[] } = JSON.parse(readFileSync(source('ne-countries'), 'utf8'));
const path: string[] = [];
for (const feature of ne.features) {
  if (feature.properties.ADM0_A3 === 'ATA') continue;
  for (const poly of polygonsOf(feature.geometry)) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const points = simplify(outer.slice(0, -1).map(mercator), 0.00035);
    if (points.length < 3) continue;
    const xy = points.map(([x, y]) => [Math.round(x * 65535), Math.round(y * 65535)]);
    path.push(`M${xy[0][0]} ${xy[0][1]}${xy.slice(1).map(([x, y]) => `L${x} ${y}`).join('')}Z`);
  }
}
writeFileSync(join(OUT, 'land.json'), JSON.stringify(path.join('')));
console.log(`${rows.length} events in ${END - START + 1} year files; ${totalDeaths} estimated deaths; ${countryRows.length} countries`);
