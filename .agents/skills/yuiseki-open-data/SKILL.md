---
name: yuiseki-open-data
description: Catalog of the geospatial data the owner publishes on z.yuiseki.net/static and on Hugging Face (yuiseki/*), with format, layout, size, licence, local path, public URL and how well each reads by HTTP Range as is. Load it when choosing data for a new map-from-scratch request ("I want to ..., so make me a map"), before writing spec.yaml datasets or bake.ts, or when asked what data is available for a renderer.
---

# yuiseki-open-data: what data there is, and how it reads

The owner keeps two public shelves of data. Most of what a map-from-scratch
request needs is already on one of them, in a layout chosen for HTTP Range
reading. This skill says what is there, where the bytes are on this machine,
the public URL, the licence, and whether a renderer can read it as is or
must bake it first.

- One section per dataset: [references/catalog.md](references/catalog.md).
- Surveyed 2026-10-26 from the local copies (`/sata_hdd_24tb/www/html/static/`
  and `/sata_hdd_24tb/hf_data/`), the Hugging Face API (96 datasets) and the
  files' own headers (PMTiles header and metadata, Parquet footers through
  DuckDB 1.5.5 in `mfs-base`, SQLite pragmas). Counts below are measured, not
  copied from READMEs, unless marked.

## How to use it

1. Read the request for: area, time span, what is drawn (points, lines,
   polygons, grid, raster), what the user touches (time slider, hover, tap),
   and the device. Then scan the overview table below for area and kind.
2. Open the dataset's section in references/catalog.md. Check the licence
   first: Ookla is CC BY-NC-SA, ekidata.jp forbids paid redistribution of
   unmodified data, OSM-derived data (and timezones, geo-triples, brand
   tables) is ODbL share-alike, OpenCelliD is CC BY-SA. Put the credit line
   into the renderer's page and `spec.yaml`.
3. Bake from the local path (`tools/sources.ts` takes a local path and a
   remote fallback). Use the public URL only when the renderer itself reads
   the data at run time, and then measure it under `benchmarks.network`.
4. The rating says what reading it at run time costs:
   - **A**: one or a few Range requests fetch what one view needs (clustered
     PMTiles, COG, Parquet ordered by space or by the request's key with small
     row groups and a small footer), and the host answers 206 at once.
   - **B**: works with care: small enough to fetch whole, or split per region
     or per year, or ordered by a key (country, prefecture, station, time) that
     matches only some requests, or hosted above the 512 MB Cloudflare limit
     (see below).
   - **C**: bake first: one huge row group, no useful order, a footer of tens
     of MB, or a container with no index for Range (CSV, zip, OSM PBF, a
     GeoPackage without R-tree).
   A rating A source is still not the renderer's format. The map-from-scratch
   rule stands: lay the bytes out for exactly what is drawn. These sources are
   the input to `bake.ts`, or the "original format" to measure against.

## Hosts and Range: measured facts

- `https://z.yuiseki.net/static/<path>` serves `/sata_hdd_24tb/www/html/static/<path>`
  through Cloudflare, with `access-control-allow-origin: *`.
  - Files under 512 MB: the first `Range: bytes=0-126` already returns 206
    (`cf-cache-status: MISS`, then `HIT`).
  - Files over 512 MB are not cached (`cf-cache-status: BYPASS`). The first
    Range request for such a file returns **200 with the whole file**
    (`content-length` = file size); the second returns 206. Measured
    2026-10-26 on planet.pmtiles (83 GB) and seamlessphoto512.pmtiles (768 GB).
    A browser renderer must check `status === 206`, abort the body on 200
    (AbortController) and retry, or warm the URL once. The ksj README records
    67 to 97 s for a query when this was not handled.
  - Several owner-built files are deliberately split under 512 MB for this
    reason (ksj A31a part0/part1, hdx-meta, geonames parts).
- `https://huggingface.co/datasets/yuiseki/<name>/resolve/main/<path>` answers
  302 to a CDN (`*.cdn.hf.co`), which answers Range with 206 and
  `access-control-allow-origin: *`, `access-control-expose-headers: *`. First
  byte took about 1.2 s including the redirect (one probe). The redirect
  target is signed and expires; resolve it again rather than storing it. The
  Hugging Face API tree listing pages at 1,000 entries (follow the `Link`
  header).
- Do not call public OpenStreetMap servers (tiles, Overpass, Nominatim). The
  OSM data here is a local copy; Overpass, if needed, is the owner's own on
  yuiseki.net.
- Keep any probe under 60 s and pass `--max-filesize` with `curl -r`, so a 200
  cannot start an 80 GB download.

## Overview

Ratings are for reading at run time as is. "z:" is a path under
z.yuiseki.net/static, "hf:" a dataset under huggingface.co/datasets/yuiseki.
Sizes are the data files (Parquet, PMTiles, TIFF), not the raw archives.

### Base maps, imagery and terrain (PMTiles, COG)

| Dataset | What | Area / time | Format | Size | Licence | Range |
| --- | --- | --- | --- | --- | --- | --- |
| z:openstreetmap/planet/planet.pmtiles | OpenMapTiles vector tiles | world, OSM 2025-11-24 | MVT gzip z0-14 | 83 GB | ODbL | B (>512 MB) |
| z:taroverture/2026-09-23.0/*.pmtiles | Overture themes, 6 files | world | MVT gzip z0-12/13/14 | 18-186 GB each | ODbL / CDLA mix | B (>512 MB) |
| z:overture/overture.pmtiles | Overture building, transportation, water | world | MVT gzip z0-14 | 60 GB | ODbL / CDLA mix | B (>512 MB) |
| z:mapterhorn/2026-01-06/planet.pmtiles | terrain, Terrarium RGB | world | WebP lossless 512 px z0-12 | 664 GB | see Mapterhorn attribution | B (>512 MB) |
| z:gsi/seamlessphoto/seamlessphoto512.pmtiles | GSI aerial photo mosaic | Japan | JPEG 512 px z1-17 | 768 GB | CC BY 4.0 (GSI) | B (>512 MB) |
| z:gsi/seamlessphoto/z18.pmtiles, z2-z17.pmtiles | same, 256 px | Japan | JPEG | 425 / 147 GB | CC BY 4.0 | B (>512 MB) |
| z:planetarble/*.pmtiles | satellite basemaps (BMNG, HLS, Sentinel-2, 2024 mosaics) | world, Japan, Tokyo, Atami | JPEG / WebP, z0-7 to z0-18 | 2 MB to 17 GB | mixed, see catalog | A (<512 MB) / B |
| z:planetarble/ETOPO_2022_15s_bed.tif | bedrock elevation COG | world | Float32 COG 256 px, LZW | 3.3 GB | NOAA, public domain | B (>512 MB) |
| z:worldpop/GIS/** | population, age-sex, urbanisation COGs | Japan 2015-2030 | Float32/Byte COG 512 px, DEFLATE | 2.5-133 MB each, 1,024 files | CC BY 4.0 | A |
| hf:worldpop-jp-2026-01 | same COGs plus originals | Japan 2015-2030 | COG + original TIFF | 8.4 GB | CC BY 4.0 | A (cog/) |

### Japan, vector GeoParquet

| Dataset | What | Area / time | Format | Size | Licence | Range |
| --- | --- | --- | --- | --- | --- | --- |
| hf:osm-japan-src-2026-08 | OSM osm2pgsql tables, Hilbert-sorted, bbox | Japan, 2026-08-31 | GeoParquet 1.1, EPSG:3857 | 6.5 GB (4 files) | ODbL | A |
| hf:osm-tokyo23-src-2026-08 | same, 23 wards | Tokyo 23 wards | GeoParquet 1.1, EPSG:3857 | 208 MB | ODbL | A |
| hf:jp-admin-2026-09 | 47 prefectures, 1,918 municipalities, population | Japan | GeoParquet, 1 RG per prefecture | 229 MB | CC BY 4.0 | A (by prefecture) |
| hf:estat-boundary-2020 | 232,019 census small areas with population | Japan, 2020 | Parquet WKB, 1 file per prefecture | 372 MB | CC BY 4.0 | B |
| hf:estat-census-mesh-2020 / -500m- / -250m- | census by grid square, no geometry | Japan, 2020 | Parquet, mesh code key | 145 / 335 / 686 MB | CC BY 4.0 | B (1km) / A (by prefecture) |
| hf:mlit-1km-fromto-2022-01 (= z:mlit-1km-fromto) | people present per 1 km mesh per month | Japan, 2019-2021 | Parquet, sorted by prefecture | 117 MB | CC BY 4.0 | A (by prefecture) |
| hf:ksj-a31a-flood-tokyo23 | flood inundation polygons touching 23 wards | Tokyo, FY2025 | GeoParquet, EPSG:6668 | 213 MB | CC BY 4.0 | C (no order) |
| z:ksj/A31a/*.parquet | flood inundation, Tokyo + Kanto bureau | Kanto, FY2025 | GeoParquet, Hilbert, bbox, 10k-row RG | 16-360 MB | CC BY 4.0 | A |
| z:ksj/P04, P29, mesh500r6 | hospitals, schools, 500 m population forecast | Tokyo | GeoParquet, Hilbert, bbox | 0.3-7 MB | CC BY 4.0 | A |
| hf:tokyo-flood-record-jp | 5,845 flooded areas 1974-2019 | Tokyo | GeoParquet, EPSG:4612 | 1.1 MB | CC BY 4.0 | B (fetch whole) |
| hf:mlit-toshi-keikaku-jp | city planning zones, roads, parks | Japan, FY2025 | GeoParquet, EPSG:6668, 1-2 RG | 626 MB | CC BY 4.0 | C |
| hf:nfgis-2024 | national forest compartments and roads | Japan, 2024 | GeoParquet per plane zone, bbox | 1.26 GB | CC BY 4.0 | B |
| hf:ksj-n07-bus-route-jp / -greater-tokyo | bus route lines | Japan / Kanto 4 prefs, 2022 | GeoParquet, 1 RG, per prefecture | 150 / 16 MB | CC BY 4.0 | B (per prefecture file) |
| hf:ksj-p11-bus-stop-jp / -greater-tokyo | bus stops with routes | Japan / Kanto 4, 2022 | GeoParquet, 1 RG, per prefecture | 15 / 2.5 MB | CC BY 4.0 | B |
| hf:ksj-l01-land-price | official land price points | Japan, 2019-2026 | Parquet lon/lat, 1 RG per prefecture | 48 MB | CC BY 4.0 | A (by prefecture) |
| hf:npa-traffic-accidents | every injury road accident | Japan, 2019-2025 | GeoParquet points, sorted by prefecture | 110 MB | CC BY 4.0 | B |
| hf:gsi-evacuation-sites-jp | evacuation sites and shelters | Japan, 2026-10 | GeoParquet points | 9.8 MB | CC BY 4.0 (PDL1.0) | B (fetch whole) |
| hf:ekidata-jp | railway stations, lines, adjacency | Japan, 2026 snapshots | GeoParquet points | 4 MB | ekidata.jp terms (not open) | B |
| hf:abr-src-2026-09 | address registry, town representative points | Japan, 2026-09 | Parquet, coordinates as strings | 22 MB | CC BY 4.0 (PDL1.0) | B |
| hf:gsi-global-map-jp | Global Map Japan 1:1M vectors | Japan, v2.0-2.2 | GeoParquet per layer | 25 MB | CC BY 4.0 (PDL1.0) | B (fetch whole) |
| hf:mlit-underpass | 3,841 road underpass points | Japan, 2025 | GeoParquet points | 0.2 MB | CC BY 4.0 (PDL1.0) | B (fetch whole) |
| hf:microsoft-building-footprints-kanto-2026-08-13 | 5.8 M ML building polygons | Tokyo + east Kanto | GeoParquet, 10k-row RG, one z9 quadkey per file | 391 MB | CDLA-Permissive-2.0 | C (no bbox column) |
| hf:jma-rain-tokyo | rain at 31 JMA stations, daily and hourly | Tokyo, 1974-2025 | Parquet, sorted by station | 31 MB | CC BY 4.0 | B |
| hf:akita-/ishikawa-/kyoto-/gifu-/nagaoka-/kamisunagawa- bear | bear sightings | 6 areas, 2009-2026 | GeoParquet points | 0.01-2.1 MB | CC BY 4.0 | B (fetch whole) |
| z:tokyo-ckan-files | 23 wards facility CSVs | Tokyo 23 wards | CSV (mixed encodings) | 9 MB | CC BY 4.0 | C |
| z:gtfs | Toei and 4 community bus GTFS-JP | Tokyo | GTFS zip | 7.6 MB | CC BY 4.0 | C |
| z:cesg/tokyo | Overture places, POI docs, Valhalla tiles | Tokyo 23 wards | GeoParquet, DuckDB, tar | 1.5 GB | CDLA / ODbL | B |

### Japan and East Asia, grids as GeoParquet

| Dataset | What | Area / time | Format | Size | Licence | Range |
| --- | --- | --- | --- | --- | --- | --- |
| hf:agera5-japan-monthly-temperature-1979-2026 | monthly tmax/tmin, 0.1° points | 122-154°E 20-46°N, 1979-2026-07 | GeoParquet per year, 1 RG per month | 84 MB | CC BY 4.0 | A (by month) |
| hf:ghsl-japan-core-2020-30arcsec | GHS population and built-up, every cell | 120-150°E 29-49°N, 2020 | GeoParquet cell polygons, per 10° tile | 154 MB | CC BY 4.0 | B |
| hf:koppen-geiger-east-asia-1991-2020 | climate classes as polygons | 122-154°E 20-48°N | GeoParquet | 1 MB | CC BY 4.0 | B (fetch whole) |
| hf:esa-worldcover-tokyo-2021-100m | land cover class counts per ~100 m | 139.5-140°E 35.5-36°N, 2021 | GeoParquet | 4.8 MB | CC BY 4.0 | B (fetch whole) |
| hf:gsi-dem-fuji-z14-100m-2026-10-25 | elevation per ~100 m around Fuji | Fuji area | GeoParquet, EPSG:3857 | 1.7 MB | CC BY 4.0 (PDL1.0) | B (fetch whole) |
| hf:gebco / ctrees / forty / gpw / gfw ...-hokkaido-east | bathymetry, biomass, forest type, grassland, carbon flux | east Hokkaido | GeoParquet | 2-37 MB | various open | B |
| hf:worldpop-kor-... / worldpop-idn-... | population 2015-2030, 1 km | Korea / Indonesia | GeoParquet, wide years | 13 / 94 MB | ODbL (derived) + CC BY 4.0 source | B |

### World

| Dataset | What | Area / time | Format | Size | Licence | Range |
| --- | --- | --- | --- | --- | --- | --- |
| z:ookla/parquet/** | network speed per z16 tile, mobile and fixed | world, 2025Q4-2026Q2 | GeoParquet, quadkey-sorted, bbox, 20k-row RG | 178-341 MB each | **CC BY-NC-SA 4.0** | A |
| z:openstreetmap/layercake-gpio/buildings-hilbert.parquet | all OSM buildings, Hilbert | world | GeoParquet 2.0, 22,437 RG | 60 GB, footer 62 MB | ODbL | C (footer) |
| z:openstreetmap/layercake/buildings, boundaries | OSM buildings, boundaries | world | GeoParquet | 44 GB / 2 GB | ODbL | C |
| hf:geonames (= z:geonames) | 13.5 M place names, points | world, 2026-10-01 | GeoParquet, sorted by country | 753 MB | CC BY 4.0 | B (by country) |
| hf:wikidata-gazetteer | 12.2 M places, 62.5 M names | world, 2026-08-31 | Parquet lat/lon, 500k-row RG | 863 MB | CC0 | C |
| hf:wikipedia-geotagged / wikivoyage-geotagged | geotagged articles with text | world, 2026-09-01 | Parquet lat/lon + text | 2.2 GB / 102 MB | CC BY-SA 4.0 | C |
| hf:ourairports-2026-08 (z:ourairports) | 86k airports, runways, navaids | world | GeoParquet, 1 RG | 8.6 MB | public domain | B (fetch whole) |
| hf:ucdp-ged (z:ucdp CSV) | organised violence events | world, 1989-2025 | GeoParquet per release, by country | 10-36 MB each | CC BY 4.0 | B |
| hf:ibtracs-v04r01 | tropical cyclone track points | world, 1980-2026 | GeoParquet, sorted by storm | 8.8 MB | NOAA terms (open) | B (fetch whole) |
| hf:usgs-comcat-2025-m45 | 8,502 M4.5+ earthquakes | world, 2025 | GeoParquet | 0.6 MB | public domain | B (fetch whole) |
| hf:opencellid | 5.5 M cell towers | world, 2026-10-06 | GeoParquet, sorted by mcc/net/area | 127 MB | CC BY-SA 4.0 | B (by country) |
| hf:timezone-boundary-builder-2026d | time zone polygons, 3 variants | world | GeoParquet, 1 RG | 43-90 MB | ODbL | C |
| hf:natural-earth / ne-admin0-10m, z:natural-earth, z:gpkg | Natural Earth, all layers | world | GeoParquet per layer; GPKG with R-tree | 450 MB (215 files) / 885 MB gpkg | public domain | B |
| hf:kontur-population-2023-11-01-22km | population on H3 r4 | world | GeoParquet, EPSG:3857 | 3.5 MB | CC BY | B (fetch whole) |
| z:kontur/kontur_population_20231101.gpkg | population on H3 r8 (400 m) | world | GPKG, no R-tree, EPSG:3857 | 6.7 GB | CC BY | C |
| hf:forest-typology-validation-2020 | 9,100 forest validation sites | world | GeoParquet points | 0.7 MB | CC BY 4.0 | B (fetch whole) |
| hf:meta-move-dist / meta-range-maps-2022-05 (= z:hdx-meta) | mobility per GADM region per day | world | Parquet, by country and region, no geometry | 89 MB each | CC BY 4.0 | B (join to boundaries) |
| z:hdx-meta commuting_zones | 6,541 commuting zone polygons | world, 2023 | GeoParquet | 13.6 MB | CC BY 4.0 | B |
| z:geojson/* | submarine cables, plate boundaries, a month of USGS quakes | world | GeoJSON | 0.2-0.7 MB | see catalog | B (fetch whole) |
| country tables (worldbank-wdi, undp-hdr, pwt, maddison, un-wpp, unhcr, faostat, ilostat, edgar, undata, un-statistical-yearbook) | indicators per country and year | world | Parquet / zip | see catalog | mostly CC BY 4.0 | B (join to NE countries) |

Skipped as non-spatial text or QA corpora, one line each, at the end of the
catalog: un-docs, egov-laws-jp, gsj-reports, nilim-disaster-reports,
moni1000-reports, mlit-river-basin-overviews, rinya-forest-inventory, osm-wiki,
osm-tag-corpus, text2geoql, osm-tokyo23-questions, osm-tokyo23-qa-2026-08,
onomatopoeia-ja(-flat), sake_qa, scp-jp-plain, g-uc, open2ch-livejupiter-qa.

## Pitfalls seen while surveying

- PMTiles `planetiler:buildtime` is the build date of the planetiler jar, not
  of the data. The OSM planet.pmtiles data date is
  `planetiler:osm:osmosisreplicationtime` (2025-11-24).
- Several planetarble PMTiles (atami, japan_sentinel-2, tokyo23_hls,
  tokyo23_sentinel-2) carry world bounds (-180..180) in the header although
  they cover a small area; do not trust header bounds to place the camera.
- Coordinate systems are not uniform: OSM src files are EPSG:3857 metres;
  KSJ and MLIT files are JGD2011 (EPSG:6668) or JGD2000 (EPSG:4612); nfgis is
  in 19 plane-rectangular zones; forty is UTM 55N; kontur EPSG:3857. Read the
  GeoParquet `geo` metadata, and where it is missing (estat-boundary,
  ne-admin0-10m, Parquet with lon/lat columns) read the README.
- estat-census-mesh tables have no geometry: the mesh code (`KEY_CODE`) is the
  geometry, and every value column is a string. That is a gift for a GPU grid
  renderer, not a defect.
- A file with one row group cannot be read in part by Range. Prefer the
  per-prefecture or per-category files when the request is regional.
- An empty file exists: z:overture/divisions_country_region.parquet is 0 bytes.
- Quick inspection commands (the same ones used for this survey):

  ```sh
  docker run --rm -v /sata_hdd_24tb:/sata_hdd_24tb:ro mfs-base duckdb -c \
    "select row_group_id, row_group_num_rows, path_in_schema, stats_min_value, stats_max_value, compression
     from parquet_metadata('/sata_hdd_24tb/...parquet') where path_in_schema like 'bbox%'"
  docker run --rm -v /sata_hdd_24tb:/sata_hdd_24tb:ro mfs-base duckdb -c \
    "select decode(key), decode(value) from parquet_kv_metadata('/sata_hdd_24tb/...parquet') where decode(key)='geo'"
  docker run --rm -v /sata_hdd_24tb:/sata_hdd_24tb:ro mfs-base gdalinfo /sata_hdd_24tb/www/html/static/worldpop/...tif
  ```

  PMTiles header: the first 127 bytes (spec v3); the metadata JSON is at
  `metadata_offset` and gzip-compressed when `internal_compression` is 2.
