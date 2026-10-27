// Raw data shared by the examples, converted once into data/raw/.
// Each source names a local copy (used when present, e.g. on yuisekin-z) and
// where the same file comes from otherwise. Bake steps call source(name).
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, openSync, readSync, fstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'data/raw');
const NE = '/sata_hdd_24tb/hf_data/__published/ne-admin0-10m/v5.1.1/shapefile';

interface Source { out: string; local: string; remote?: string; ogr?: string[]; copy?: boolean }

const SOURCES: Record<string, Source> = {
  // Kontur Population 2023-11-01, H3 resolution 4, CC BY.
  'kontur-population-r4': {
    out: 'kontur_population_20231101_r4.parquet',
    local: '/sata_hdd_24tb/hf_data/kontur-population-2023-11-01-22km/data/parquet/kontur_population_20231101_r4.parquet',
    remote: 'https://huggingface.co/datasets/yuiseki/kontur-population-2023-11-01-22km/resolve/main/parquet/kontur_population_20231101_r4.parquet',
    copy: true,
  },
  // UCDP Georeferenced Event Dataset 26.1, CC BY 4.0 with publication citations.
  'ucdp-ged-26.1': {
    out: 'ucdp_ged_26.1.parquet',
    local: '/sata_hdd_24tb/hf_data/__published/ucdp-ged/data/parquet/26.1/ged.parquet',
    remote: 'https://huggingface.co/datasets/yuiseki/ucdp-ged/resolve/main/parquet/26.1/ged.parquet',
    copy: true,
  },
  // Natural Earth 10m admin 0, v5.1.1. Public domain.
  'ne-countries': {
    out: 'ne_10m_admin_0_countries.geojson',
    local: `${NE}/ne_10m_admin_0_countries.shp`,
    remote: '/vsizip//vsicurl/https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip',
    ogr: ['-select', 'ADM0_A3,NAME,NAME_JA,POP_EST,CONTINENT'],
  },
  // Natural Earth 10m admin 0 land boundary lines, v5.1.0. Public domain.
  'ne-boundary-lines': {
    out: 'ne_10m_admin_0_boundary_lines_land.geojson',
    local: `${NE}/ne_10m_admin_0_boundary_lines_land.shp`,
    remote: '/vsizip//vsicurl/https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_boundary_lines_land.zip',
    ogr: ['-select', 'FEATURECLA'],
  },
  // Natural Earth 10m admin 1, Japan only (47 prefectures). Public domain.
  'ne-japan-prefectures': {
    out: 'ne_10m_japan_prefectures.geojson',
    local: `${NE}/ne_10m_admin_1_states_provinces.shp`,
    remote: '/vsizip//vsicurl/https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip',
    ogr: ['-where', "adm0_a3 = 'JPN'", '-select', 'iso_3166_2,name,name_ja,region'],
  },
  // Natural Earth 10m populated places, v5.1.2 (7,342 places). Public domain.
  'ne-populated-places': {
    out: 'ne_10m_populated_places.geojson',
    local: '/sata_hdd_24tb/yuisekinai-data/gazetteer/ne_pp/ne_10m_populated_places.shp',
    remote: '/vsizip//vsicurl/https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip',
    ogr: ['-select', 'NAME,NAME_JA,ADM0NAME,ADM0_A3,POP_MAX'],
  },
  // USGS ComCat, 2025, M4.5+. Public domain (US Government work).
  'usgs-quakes-2025': {
    out: 'usgs_2025_m45.geojson',
    local: '/sata_hdd_24tb/hf_data/usgs-earthquake-catalog-2025-m45/data/raw/2026-10-25/comcat-2025-m45-us-net.geojson',
    remote: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2025-01-01&endtime=2026-01-01&minmagnitude=4.5&eventtype=earthquake',
    copy: true,
  },
  // Akita prefecture kumadas wildlife sightings (bear, boar, deer) 2022-2026. CC BY 4.0.
  'akita-kumadas': {
    out: 'akita_kumadas.csv',
    local: '/sata_hdd_24tb/hf_data/akita-kumadas-wildlife-sighting/data/raw/2026-10-26/kumadas.csv',
    remote: 'https://huggingface.co/datasets/yuiseki/akita-kumadas-wildlife-sighting/resolve/main/raw/2026-10-26/kumadas.csv',
    copy: true,
  },
  // OpenStreetMap, Tokyo 23 wards, 2026-08-31. ODbL. Only a local copy:
  // elsewhere, cut it from a Japan extract with osmium extract.
  'osm-tokyo23': {
    out: 'tokyo23-260831.osm.pbf',
    local: '/sata_hdd_24tb/hf_data/__published/osm-tokyo23-src-2026-08/data/tokyo23-260831.osm.pbf',
    copy: true,
  },
};

export function source(name: string): string {
  const s = SOURCES[name];
  if (!s) throw new Error(`unknown source ${name}`);
  const out = join(rawDir, s.out);
  // The conversion settings are kept next to the output; when they change
  // (another -select, a new remote) the file is converted again.
  const stamp = `${out}.source.json`;
  const settings = JSON.stringify({ local: s.local, remote: s.remote, ogr: s.ogr, copy: s.copy });
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === settings) return out;
  mkdirSync(rawDir, { recursive: true });
  const from = existsSync(s.local) ? s.local : s.remote;
  if (!from) throw new Error(`${name}: no local copy at ${s.local} and no remote`);
  console.log(`source ${name} <- ${from}`);
  rmSync(out, { force: true });
  if (s.copy && from === s.local) {
    copyFileSync(from, out);
  } else if (s.copy) {
    execFileSync('curl', ['-fsSL', '-o', out, from], { stdio: 'inherit' });
  } else {
    execFileSync('ogr2ogr', ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-lco', 'COORDINATE_PRECISION=6', ...(s.ogr ?? []), out, from], { stdio: 'inherit' });
  }
  writeFileSync(stamp, settings);
  return out;
}

// Large files read in part, by byte range: the local copy when present,
// otherwise HTTP Range requests whose answers are cached under data/raw/, so
// a bake that needs a few row groups of a 151 MB Parquet file fetches a few MB
// once and nothing afterwards.
const OSM23 = '/sata_hdd_24tb/hf_data/__published/osm-tokyo23-src-2026-08/data/parquet';
const OSM23_HF = 'https://huggingface.co/datasets/yuiseki/osm-tokyo23-src-2026-08/resolve/main/parquet';
const RANGED: Record<string, { local: string; remote: string }> = Object.fromEntries(
  ['point', 'line', 'polygon', 'roads'].map((t) => [`osm-tokyo23-${t}`, {
    local: `${OSM23}/planet_osm_${t}.parquet`, remote: `${OSM23_HF}/planet_osm_${t}.parquet`,
  }]));

export interface Ranged { size: number; range: (offset: number, length: number) => Promise<Uint8Array>; fetched: () => number }

export async function rangedSource(name: string): Promise<Ranged> {
  const s = RANGED[name];
  if (!s) throw new Error(`unknown ranged source ${name}`);
  if (existsSync(s.local)) {
    const fd = openSync(s.local, 'r');
    return {
      size: fstatSync(fd).size, fetched: () => 0,
      range: async (o, n) => { const b = new Uint8Array(n); readSync(fd, b, 0, n, o); return b; },
    };
  }
  const dir = join(rawDir, `${name}.ranges`);
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  const get = async (o: number, n: number): Promise<{ b: Uint8Array; total: number }> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(s.remote, { headers: { range: `bytes=${o}-${o + n - 1}` } });
        if (r.status !== 206) throw new Error(`${name}: HTTP ${r.status} for a range request`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== n) throw new Error(`${name}: got ${b.length} bytes, asked for ${n}`);
        fetched += n;
        return { b, total: Number(r.headers.get('content-range')?.split('/')[1]) };
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((res) => setTimeout(res, 2000 << attempt));
      }
    }
  };
  const sizeFile = join(dir, 'size');
  let size = existsSync(sizeFile) ? Number(readFileSync(sizeFile, 'utf8')) : 0;
  if (!size) { size = (await get(0, 4)).total; writeFileSync(sizeFile, String(size)); }
  return {
    size, fetched: () => fetched,
    range: async (o, n) => {
      const f = join(dir, `${o}-${n}`);
      if (existsSync(f)) return new Uint8Array(readFileSync(f));
      const { b } = await get(o, n);
      writeFileSync(f, b);
      return b;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SOURCES)) {
    console.log(source(name));
  }
}
