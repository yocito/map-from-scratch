# Catalog of the owner's open data, one section per dataset

Surveyed 2026-10-26. Every count, row group figure, codec and PMTiles header
value below was read from the file itself (local copy, or the Parquet footer
over HTTP for the few files with no matching local copy). Sentences marked
"(README)" are taken from the dataset's own README and were not re-measured.

Conventions:

- Local: path on yuisekin-z. For Hugging Face datasets, the local copy is the
  working repository of the dataset; its `data/` directory mirrors the Hub
  layout (files whose size equals the Hub's were used for this survey).
- URL: `z:` means `https://z.yuiseki.net/static/`; `hf:` means
  `https://huggingface.co/datasets/yuiseki/<dataset>/resolve/main/`.
- RG = Parquet row group. "Median RG bbox" is the median area of a row
  group's bounding box (from column statistics) as a share of the whole
  file's extent: under 1% means a viewport query skips almost every row group,
  50-100% means it skips none.
- Range rating A / B / C as defined in SKILL.md. Files over 512 MB on
  z.yuiseki.net get a 200 with the whole body on the first Range request.

Contents: 1. z.yuiseki.net/static (PMTiles, rasters, Parquet, other) ·
2. Hugging Face datasets (Japan vector, Japan grids, world) · 3. Country
tables · 4. Skipped.

---

## 1. z.yuiseki.net/static

Local root `/sata_hdd_24tb/www/html/static/`. Directories `maps/` (MapLibre
styles, glyphs, sprites), `tmp/` (one-off demo pages), `wikimedia/` (Wikidata
dumps, Nominatim's wikimedia-importance.csv.gz) and `openstreetmap/wiki/`,
`openstreetmap/names/` are not datasets for a renderer; see the end of this
part.

### openstreetmap/planet/planet.pmtiles (OpenMapTiles planet)

- What: the OpenMapTiles schema built by planetiler 0.9.2-SNAPSHOT from the
  OSM planet: 15 layers (aerodrome_label, aeroway, boundary, building z13-14,
  housenumber z14, landcover, landuse, mountain_peak, park, place, poi z11+,
  transportation, transportation_name, water, water_name, waterway).
- Extent: world, z0-14. Data date `planetiler:osm:osmosisreplicationtime`
  2025-11-24 (the 2025-07-02 in the metadata is the jar's build date).
- Format: PMTiles v3, MVT gzip, clustered, 275,142,148 addressed tiles,
  44,626,561 unique contents, root directory 16 KB, leaf directories 94 MB in
  total (fetched one at a time).
- Size: 82,984,871,716 bytes.
- Licence: ODbL, "© OpenMapTiles © OpenStreetMap contributors".
- Local: `openstreetmap/planet/planet.pmtiles`. URL: z:openstreetmap/planet/planet.pmtiles.
  The owner's styles in `maps/styles/` (osm-bright, osm-fiord,
  toner-epaper-4color) point at it.
- Range: B. Ideal layout, but over 512 MB: the first Range request returns
  200 (measured). Abort and retry, then every tile is one 206.
- Requests: "I want to show my e-paper badge the streets around the venue in
  four colours, so make me a map" (decode only transportation and water at
  z14 for one tile). "I want a world map that names only capitals and rivers
  for a quiz" (place + water_name at z3-6).

### taroverture/2026-09-23.0/*.pmtiles (Overture Maps themes)

- What: six theme tilesets of Overture Maps built with planetiler 0.10.2
  ("tiles.version=dev"); directory name says release 2026-09-23.0.
  - addresses.pmtiles: layer `address` at z14 only; 32.8 GB.
  - base.pmtiles: bathymetry, infrastructure (z13), land, land_cover,
    land_use (z6+), water; z0-13; 186.0 GB.
  - buildings.pmtiles: building (z5-14), building_part (z8-14) with height,
    facade colour and material; 180.7 GB.
  - divisions.pmtiles: division (points), division_area, division_boundary,
    with admin_level and names; z0-12; 19.9 GB.
  - places.pmtiles: place at z14 only with category, brand, confidence; 18.4 GB.
  - transportation.pmtiles: segment (z4-14), connector (z13-14); 133.7 GB.
- Extent: world.
- Format: PMTiles v3, MVT gzip, clustered.
- Licence: Overture per theme (docs.overturemaps.org/attribution): OSM-derived
  themes ODbL (base, buildings, transportation, divisions), places CDLA
  Permissive 2.0, addresses per source. Credit "© OpenStreetMap © Overture
  Maps Foundation".
- Local / URL: `taroverture/2026-09-23.0/<theme>.pmtiles`, z:taroverture/2026-09-23.0/<theme>.pmtiles.
- Range: B (all over 512 MB, first request 200).
- Requests: "I want to see which buildings in my ward are taller than 30 m,
  extruded, on a phone" (buildings z14, height only). "I want every admin
  boundary of Japan down to municipality, no basemap" (divisions
  division_boundary).

### overture/overture.pmtiles (older Overture build)

- What: layers building (z13-14, height, facade), transportation (z4-14),
  water (z0-14). planetiler 0.8.3 jar from 2024-11; file dated 2025-09-20.
  Overture release not recorded in the metadata.
- Format: PMTiles v3, MVT gzip, 246,613,266 addressed tiles. Size 60.3 GB.
- Licence: as taroverture. Range: B (>512 MB).
- Requests: superseded by taroverture for anything new; useful as a fixed older
  snapshot for before/after comparisons.
- Note: `overture/divisions_country_region.parquet` next to it is 0 bytes.

### mapterhorn/2026-01-06/planet.pmtiles (global terrain)

- What: Mapterhorn global elevation tiles. Decoded tile 10/909/403 (eastern
  Tokyo) as Terrarium: elevation = R*256 + G + B/256 - 32768 gives -2.8 to
  69.8 m, median 3.3 m. Mapbox Terrain-RGB decoding gives nonsense, so the
  encoding is Terrarium.
- Extent: world, z0-12, 13,532,395 addressed tiles.
- Format: PMTiles v3, WebP lossless 512x512 px, no tile compression, clustered.
- Size: 663,868,393,... bytes (664 GB).
- Licence: attribution "© Mapterhorn" linking to mapterhorn.com/attribution,
  which lists the underlying DEM sources and their terms; read it before
  publishing.
- Local / URL: `mapterhorn/2026-01-06/planet.pmtiles`.
- Range: B (>512 MB). Otherwise A: one tile is 250 KB at z10.
- Requests: "I want a hillshade of the Japanese Alps that I can tilt, for a
  hiking page" (z9-12 tiles, shade in a fragment shader). "I want contour
  lines every 100 m around Mt. Fuji drawn crisply at any zoom" (marching
  squares on decoded tiles).

### gsi/seamlessphoto/ (GSI aerial photo mosaic of Japan)

- What: 国土地理院 シームレス空中写真, all of Japan.
  - seamlessphoto512.pmtiles: re-tiled to 512 px, z1-17; 9,772,357 addressed
    tiles; 767,579,254,057 bytes.
  - z18.pmtiles: 256 px z18 only; 424,950,358,986 bytes.
  - z2-z17.pmtiles: 256 px z2-17; 146,942,991,995 bytes.
  - z18.mbtiles, z2-z17.mbtiles, z2-z18.mbtiles: the same as MBTiles (SQLite,
    page size 4096, tiles table with tile_index). Not for Range reading.
  - torrents, SHA256SUMS, compare.html (256 vs 512 comparison page).
- Extent: bounds 122.92-153.99°E, 20.41-45.54°N.
- Format: PMTiles v3, JPEG (512 px confirmed by decoding tile 5/28/12), clustered.
- Licence: CC BY 4.0, "国土地理院 シームレス空中写真".
- Range: B (>512 MB).
- Requests: "I want to compare the 1:25000 hazard map with what the ground
  looks like from the air, swiping between them" (z15-17 tiles). "I want a
  photo map of one school district printed at A3" (fixed z17 tile set).

### planetarble/ (satellite basemaps from the owner's planetarble pipeline)

Built by `/Workspaces/repos/__yuiseki/planetarble` (HLS v2 + Landsat fill,
ETOPO 2022 oceans; legacy BMNG / MODIS / Copernicus workflow). All PMTiles v3,
clustered, raster without tile compression.

| file | tiles | z | encoding (measured) | bytes | header bounds |
| --- | --- | --- | --- | --- | --- |
| world_2024_z8.pmtiles | 481 | 0-8 | JPEG | 2,027,982 | world |
| world_2024.pmtiles | 6,265 | 0-10 | JPEG 256 px | 28.7 MB | world |
| planet_2.pmtiles, planet_3.pmtiles | 4,226 | 0-10 | JPEG | 45.6 MB each | world |
| planet_copernicus.pmtiles | 6,267 | 0-10 | JPEG | 68.8 MB | world |
| planet_2024_8z.pmtiles | 21,827 | 0-7 | JPEG | 232.9 MB | world |
| planet_2024_10z.pmtiles | 344,812 | 0-9 | JPEG | 2.0 GB | world |
| planet_2024_12z.pmtiles | 5,279,786 | 0-11 | JPEG 512 px | 17.2 GB | world |
| planet.pmtiles = planet_bmng.pmtiles | 1,369,505 | 0-10 | JPEG 256 px | 4.94 GB each | world |
| planet_japan_sentinel-2.pmtiles | 52,600 | 0-14 | WebP 512 px | 617 MB | wrong (world) |
| planet_tokyo23_sentinel-2.pmtiles | 22,263 | 0-14 | WebP | 197.6 MB | wrong (world) |
| planet_tokyo23_hls.pmtiles | 21,867 | 0-12 | WebP 512 px | 187.3 MB | wrong (world) |
| planet_tokyo23_seamlessphoto.pmtiles | 87,900 | 2-18 | JPEG | 1.54 GB | 139.56-139.92°E, 35.53-35.82°N |
| planet_atami.pmtiles | 26,833 | 0-18 | WebP | 192.9 MB | wrong (world) |
| planet_gsi.pmtiles | 11 | 0-10 | JPEG | 9 KB | almost empty |

- Also `ETOPO_2022_15s_bed.tif`: NOAA ETOPO 2022 15 arc-second bedrock
  elevation, COG (86400x43200, Float32, 256 px blocks, LZW, 8 overviews),
  3.3 GB. NOAA, public domain.
- Licence: by source. BMNG and HLS/Landsat are NASA/USGS public domain, ETOPO
  NOAA public domain; Sentinel-2 and the Copernicus file need "contains
  modified Copernicus Sentinel data"; the seamlessphoto file is GSI CC BY 4.0.
  The provenance of planet_2024_*, world_2024*, planet_2/3 and planet_atami is
  not written in the files; check the planetarble repository's configs before
  publishing a renderer that uses them.
- Range: A for the files under 512 MB (world_2024*, planet_2024_8z,
  planet_2/3, copernicus, tokyo23_hls, tokyo23_sentinel-2, atami); B for the rest.
- Requests: "I want a spinning globe for the lobby display with a real-colour
  Earth, offline" (world_2024.pmtiles, 29 MB, z0-5 on a sphere). "I want to
  see Tokyo's 23 wards from Landsat-class imagery against the GSI photo at
  the same zoom" (tokyo23_hls vs tokyo23_seamlessphoto).

### worldpop/GIS/ (WorldPop Japan COGs)

- What: WorldPop R2025A v1 for Japan, 2015-2030 per year: total population at
  100 m and 1 km (constrained), 60 age-sex rasters per year at 1 km, Degree of
  Urbanisation grids L1/L2. 1,024 GeoTIFFs (README).
- Format: COG made with gdal_translate (512 px tiles, DEFLATE, predictor,
  overviews; nearest-neighbour overviews for DUG). Checked one 100 m file:
  37258x25773 Float32, EPSG:4326, nodata -99999, 7 overviews. Values equal the
  originals (README).
- Size: 100 m files 131-133 MB; 1 km 2.5 MB; DUG 83-141 KB; 4.3 GB in all.
- Licence: CC BY 4.0, cite each product's DOI (worldpop/LICENSE).
- Local / URL: `worldpop/GIS/<WorldPop's own path>`; also
  `manifest.json`. Same files on hf:worldpop-jp-2026-01 under `cog/`.
- Range: A (each file under 512 MB, tiled, with overviews).
- Requests: "I want to scrub 2015 to 2030 and watch where Japan empties out,
  at 1 km" (16 x 2.5 MB files, or bake differences). "I want the share of
  people over 65 in each 1 km cell of my prefecture" (age-sex rasters, window
  read by Range).

### ookla/parquet/ (Speedtest performance tiles)

- What: Ookla Speedtest open data, z16 web mercator tiles (~610 m at the
  equator) with average download/upload kbps, latency, tests, devices.
  mobile 2025Q4, 2026Q1, 2026Q2; fixed 2026Q2.
- Format: GeoParquet 1.0.0 rewritten by the owner: original columns plus
  `geometry` (WKB polygon) and `bbox` struct; sorted by quadkey; row groups of
  20,480 rows; zstd. Measured: mobile 2026Q2 3,381,216 rows / 166 RG, fixed
  6,435,895 rows / 315 RG; median RG bbox 0.06-0.17% of the world; footer
  0.4-0.8 MB. Hive path columns type/year/quarter.
- Size: 177.6, 185.2, 188.9 MB (mobile), 340.9 MB (fixed).
- Licence: **CC BY-NC-SA 4.0**, non-commercial only, share-alike. Citation
  text in ookla/README.md.
- Local / URL: `ookla/parquet/performance/type=<t>/year=<y>/quarter=<q>/<file>.parquet`.
- Range: A (quadkey order is spatial; small RGs; under 512 MB).
- Requests: "I want to see where my phone will get slow on the Tokaido line,
  as coloured squares along the track" (bbox filter, a few RGs). "I want to
  compare mobile download speed between two quarters for my city" (two files,
  same RGs).

### ksj/ (国土数値情報 for Tokyo, GeoParquet)

- What and size (measured):
  - A31a flood inundation (FY2025): `A31a-25_13_10` Tokyo planned-scale rivers,
    71,494 polygons, 7 RG, 16.2 MB; `A31a-25_13_20` Tokyo other rivers,
    224,984, 22 RG, 29.2 MB; `A31a-25_83_10-part0/part1` Kanto Regional
    Bureau (national rivers incl. Arakawa, Tama, Tone), 2,300,062 + 2,300,063
    polygons, 225 + 188 RG, 316.7 + 360.0 MB, part0 138.43-140.04°E,
    part1 139.60-140.86°E. Columns A31a_101.. (depth rank etc., by kind in
    `source_file`).
  - P04 hospitals 2020: 25,424 points, 1.7 MB. P29 schools 2023: 4,451, 0.3 MB.
  - mesh500r6: 500 m mesh future population (R6 estimate) 2025-2070,
    5,447 polygons, 345 columns, 7.3 MB.
- Format: GeoParquet 1.0.0, JGD2011 (EPSG:6668), `bbox` struct, sorted by
  Hilbert index of bbox centre, 10,240-row RG, zstd. Median RG bbox 0.2-0.4%
  for the Kanto parts. Footer 0.5 MB on the large parts.
- Licence: CC BY 4.0; credit 「出典: 国土数値情報 (洪水浸水想定区域データ) (国土交通省)」 etc.
- Local / URL: `ksj/<dataset>/<file>.parquet`. README records 0.5-0.7 s for a
  Taito-ward query after the split (README).
- Range: A.
- Requests: "I want to tap my address and see how deep the planned-scale flood
  would be there" (bbox query on 13_10 and part1). "I want the 23 wards
  coloured by worst flood depth, all rivers together, for a hazard workshop".

### mlit-1km-fromto/ (people present per 1 km mesh, MLIT)

- Same files as hf:mlit-1km-fromto-2022-01 (sizes and row counts equal); see
  its section in part 2.

### hdx-meta/ (Meta Data for Good on HDX)

- What: Movement Distribution 2026 (11,735,260 rows, 117 RG, sorted by
  gadm_id and country), Movement Range 2020/2021/2022 (53/53/17 RG), Business
  Activity Trends during 5 crises (1,888,011 rows, sorted by crisis), Commuting
  Zones (6,541 polygons, GeoParquet, 13.6 MB, 33 geometries NULL because the
  source WKT was cut at 32,759 characters).
- Format: Parquet zstd, 100k-row RG; all files under 512 MB by design. Only
  commuting zones carry geometry; the rest join to GADM ids.
- Licence: CC BY 4.0; credit "Data for Good at Meta, <dataset>, Humanitarian
  Data Exchange (<url>)".
- Local / URL: `hdx-meta/<dataset>/...` (+ `original/` CSVs and zips).
  Same Parquet as hf:meta-move-dist and hf:meta-range-maps-2022-05.
- Range: B (by country, then region; geometry must come from elsewhere: GADM
  is not on either shelf).
- Requests: "I want to see, day by day, how far people in each Japanese
  prefecture travelled during Obon 2026" (needs prefecture polygons from
  jp-admin and a gadm_id mapping). "I want the commuting zones of Japan drawn
  over a dark basemap, sized by roads".

### geonames/2026-10-01/ (GeoNames snapshot)

- Same Parquet as hf:geonames (see part 2) plus the raw dump files.
  `geoname/part-00..03.parquet` 102-169 MB each, sorted by country_code.

### ourairports/2026-10-01/

- OurAirports at commit b6268327 (2026-10-01): airports.parquet 86,154 rows,
  runways 48,278, navaids 11,008, frequencies, comments, regions, countries,
  plus csv/. Newer than hf:ourairports-2026-08 (86,002 airports). Format and
  licence as in part 2.

### natural-earth/ (three trimmed Natural Earth layers) and gpkg/natural_earth_vector.gpkg

- natural-earth/: `ne_10m_admin_1_states_provinces.parquet` (4,596 rows,
  17 columns incl. name_ja, 19.2 MB), `ne_50m_admin_0_countries.parquet`
  (242, 1.0 MB), `ne_110m_admin_0_countries.parquet` (177, 0.2 MB).
  GeoParquet 1.0.0, WGS 84, snappy, one RG. Public domain.
- gpkg/natural_earth_vector.gpkg: the whole Natural Earth vector package as
  GeoPackage: 183 feature tables (10m and 50m, cultural and physical, all
  point-of-view country variants), every table with an R-tree, page size
  4096, EPSG:4326, 885,293,056 bytes. Public domain.
- Range: B for the Parquet (fetch whole, they are small). The GeoPackage
  could be read page by page through an HTTP SQLite VFS using the R-tree,
  but it is over 512 MB: C as is.
- Requests: "I want a tiny world map in a blog post where hovering a country
  shows its Japanese name" (110m countries, 0.2 MB, fetch whole). "I want
  the prefectures of Japan and the provinces of Korea side by side".

### kontur/kontur_population_20231101.gpkg

- What: Kontur Population 2023-11-01, H3 resolution 8 hexagons (about 400 m),
  32,957,699 rows, single table `population`, geometry type GEOMETRY,
  EPSG:3857.
- Format: GeoPackage, page size 4096, **no R-tree**; 6,711,951,360 bytes
  (plus the .gz as downloaded).
- Licence: CC BY (HDX: Kontur Population dataset).
- Range: C (no spatial index; over 512 MB). Bake by H3 parent or tile.
- Requests: "I want every inhabited hexagon of Japan glowing by population,
  zoomable from country to street" (bake to a per-z tiled point grid).

### openstreetmap/layercake/ and layercake-gpio/

- What: OSM "layercake" GeoParquet: all buildings of the planet
  (689,237,307 rows) and boundaries (814,633 rows). `layercake-gpio/
  buildings-hilbert.parquet` is the buildings re-sorted by Hilbert curve with
  GeoParquet 2.0 metadata and bbox covering.
- Measured: buildings.parquet 43.8 GB, 5,610 RG of 122,880 rows, footer
  16.6 MB; buildings-hilbert.parquet 59.7 GB, 22,437 RG of 30,720 rows, median
  RG bbox 0.00012% of the world, **footer 61.9 MB**; boundaries.parquet 2.0 GB,
  7 RG (median RG bbox 60%), footer 0.02 MB. `layercake-buildings.parquet` is a
  symlink to `layercake/buildings.parquet`.
- Licence: ODbL.
- Range: C. The Hilbert file is beautifully ordered, but a reader must fetch
  a 62 MB footer before the first row, and the host gives 200 on the first
  request. A renderer that wants it should bake its own small index (RG id ->
  bbox) once, or cut a region.
- Requests: "I want every building of a city on Earth, chosen at run time,
  without a tile server" (bake a per-city extract from the Hilbert file).

### openstreetmap/region/ and openstreetmap/planet/*.osm.pbf

- OSM PBF extracts: japan (2025-12-31, 2026-04-23), kanto (2026-04-23),
  andorra, monaco, niue (several dates); planet 2026-06-01, 06-03?, 08-03,
  08-17, 08-31 (90 GB each, with .md5 and .torrent). ODbL.
- Range: C (PBF has no index). Bake with osmium in the container. For Tokyo
  and Japan prefer the frozen GeoParquet on Hugging Face (osm-*-src-2026-08).

### cesg/tokyo/ (POI search and routing kit for the 23 wards)

- overture-places.parquet: Overture places 2026-04-15.0 in a 139.56-139.92°E,
  35.52-35.82°N box; 450,302 points, 29 RG (~16k rows), median RG bbox 2.4%,
  GeoParquet 1.1 with covering, snappy, 84.7 MB.
- poi-documents.parquet: 450,295 rows, one RG, lon/lat + normalised names and
  categories for search, 135.7 MB. poi-search.duckdb (407 MB): the DuckDB FTS
  index (lindera tokeniser, 2-3 grams).
- valhalla_tiles.tar (818 MB) + valhalla.json: Valhalla routing graph for Tokyo.
- Licence: Overture places CDLA Permissive 2.0; Valhalla tiles derive from OSM
  (ODbL).
- Range: overture-places A; poi-documents C (one RG); duckdb file readable
  by DuckDB over HTTP; Valhalla tar is for a server.
- Requests: "I want to type a shop name and see it light up on the map of
  Tokyo, no server" (overture-places by bbox, names from the struct).

### tokyo-ckan-files/ (23 wards facility CSVs)

- What: 183 CSVs of the 23 wards on the Tokyo open data catalogue (public
  facilities, AED, toilets, shelters, cultural properties, Wi-Fi, polling
  places, parks, libraries...), unchanged. Encodings utf-8, cp932, utf-16;
  11 could not be fetched (README). 8.9 MB.
- Licence: CC BY 4.0, credit per dataset in tokyo-ckan-files/LICENSE.
- Range: C (CSV, heterogeneous columns). Bake per category.
- Requests: "I want every public toilet and AED in my ward on one phone map
  for a disaster drill".

### gtfs/ (Tokyo bus GTFS-JP)

- Toei Bus (feed 20260928_030815, valid to 2029-09-27, 7.6 MB) and the
  community buses of Taito (Megurin), Suginami, Arakawa, Katsushika. Zips as
  served. CC BY 4.0. Range: C. No block_id; some feeds have unpadded hours.
- Requests: "I want to animate every Toei bus moving through a weekday
  morning" (bake shapes + stop_times into per-minute positions).

### geojson/, csv/, ucdp/, worldbank/

- geojson/cable-geo.json: 681 submarine cables (MultiLineString, name,
  colour). TeleGeography submarine cable map data; licence not recorded here
  (believed CC BY-NC-SA 3.0, verify).
- geojson/tectonicplates_GeoJSON_PB2002_boundaries.json: 241 plate boundary
  lines (Bird 2003, via the fraxen/tectonicplates repository, ODC-By; verify).
- geojson/usgs_m45_month.geojson: 601 USGS M4.5+ quakes of one month around
  2025-09; public domain.
- geojson/conflicts.json: not data, a MapLibre style ("UCDP Conflicts").
- csv/Geo_PKO_v2_3_location_map.csv: Geo-PKO v2.3, UN peacekeeping
  deployments by location and year with lat/lon (11.9 MB). Licence not
  recorded here; check the Geo-PKO terms.
- ucdp/: UCDP GED 25.1 and 26.1 as CSV and zip; the typed GeoParquet is on
  hf:ucdp-ged.
- worldbank/: `wdi_basic_annual.parquet` (102,623 rows: iso3, year,
  indicator, value) and `wdi_indicators.parquet`. CC BY 4.0.
- Range: B (fetch whole) for the GeoJSON; C for the CSVs.
- Requests: "I want the internet's undersea cables glowing on a dark globe"
  (cable-geo, 0.7 MB). "I want a map where plates and this month's quakes
  line up" (plates + usgs month).

### Not datasets: maps/, tmp/, wikimedia/, openstreetmap/wiki, openstreetmap/names

- maps/: MapLibre styles (osm-bright, osm-fiord, toner-epaper-4color, all on
  planet.pmtiles), 84 glyph font stacks as SDF PBF ranges (Noto Sans, Open
  Sans, Metropolis and combinations, 460 MB), sprites, vendored maplibre-gl.
  Useful as a reference for glyph PBF ranges when a renderer draws labels.
- tmp/: past demo pages (radio-map, okapi-map, cng-japan-2026 slides).
- wikimedia/: Wikidata JSON dump 2026-08-31 and Nominatim's
  wikimedia-importance.csv.gz (language, type, title, importance, wikidata_id).
- openstreetmap/names/wikidata_names.json (460 MB, names per Wikidata id) and
  openstreetmap/wiki/ (OSM wiki dump): text, not geometry.

---

## 2. Hugging Face datasets of yuiseki

Hub URL `https://huggingface.co/datasets/yuiseki/<name>`; file URL
`hf:<name>/<path>` = `https://huggingface.co/datasets/yuiseki/<name>/resolve/main/<path>`.

### 2a. Japan, vector

#### osm-japan-src-2026-08

- What: a frozen cut of OSM for all of Japan from the 2026-08-31 planet, with
  the osm2pgsql tables as GeoParquet: planet_osm_point 3,720,141 rows (14 RG),
  planet_osm_line 12,259,617 (91 RG), planet_osm_polygon 33,281,956 (204 RG),
  planet_osm_roads 762,255 (14 RG); 71 tag columns + `way` + `bbox`. Also the
  2.8 GB PBF, the boundary GeoJSON, md5s and provenance.
- Format: GeoParquet 1.1, `way` WKB in **EPSG:3857 metres**, bbox covering,
  each file sorted along a Hilbert curve; zstd. Median RG bbox 0.06% (line,
  polygon), 0.9% (point), 1.7% (roads). Footer 0.1-1.5 MB.
- Size: polygon 4,191.6 MB, line 1,853.4 MB, roads 209.1 MB, point 202.2 MB.
- Licence: ODbL ("© OpenStreetMap contributors").
- Local: `/sata_hdd_24tb/hf_data/__published/osm-japan-src-2026-08/data/parquet/`.
  URL: hf:osm-japan-src-2026-08/parquet/planet_osm_<kind>.parquet.
- Range: A (HF CDN answers 206 even for the 4 GB file). RGs are 135k-276k
  rows, so one RG is several MB: fine for a city, coarse for a block.
- Requests: "I want all the railway lines of Japan glowing on a night map,
  read straight from the Hub" (line where railway is not null, few columns).
  "I want the coastline-to-coastline road network of Kyushu at 144 Hz on the
  desktop" (roads by bbox, baked to 05's format).

#### osm-tokyo23-src-2026-08

- Same as above for the 23 wards: point 306,642 (12 RG), line 347,735 (19),
  polygon 1,437,105 (71 RG of 20,480), roads 33,113 (6); 17.1 / 34.2 / 151.1 /
  5.4 MB; PBF 87 MB (the source of examples 04-06). Median RG bbox: polygon
  1.6% of the wards, line 0.08% of the file extent. EPSG:3857, Hilbert, bbox.
- Licence: ODbL. Local: `/sata_hdd_24tb/hf_data/__published/osm-tokyo23-src-2026-08/data/`.
- Range: A.
- Requests: "I want every building in Shibuya drawn as footprints on a tablet,
  instantly" (polygon where building is not null, bbox). "I want convenience
  stores of the 23 wards as dots coloured by brand" (point + brand).

#### jp-admin-2026-09

- What: 47 prefectures and 1,918 municipalities with codes, names (kanji,
  kana, romaji), population and households, and polygons (README: from
  e-Stat boundaries and the address registry).
- Format: GeoParquet 1.1, JGD2000 (EPSG:4612), bbox covering; **one row
  group per prefecture** in both files (47 RG), sorted by pref_code then
  lg_code; zstd. Polygons at full resolution: prefectures 80.0 MB for 47 rows,
  municipalities 148.6 MB (largest RG Nagasaki, 11 MB, README).
- Licence: CC BY 4.0 (credit e-Stat / Digital Agency as in its LICENSE).
- Local: `/sata_hdd_24tb/hf_data/__published/jp-admin-2026-09/data/`.
- Range: A by prefecture code (row group statistics on pref_code, code5,
  lg_code). The polygons need simplification before drawing.
- Requests: "I want a municipality choropleth of Hokkaido for the
  ageing-population article" (one RG). "I want a Japan prefecture picker
  that also names municipalities on hover" (simplify at bake).

#### estat-boundary-2020

- What: every 町丁・字 small area of the 2020 census, 232,019 polygons, with
  population (JINKO) and households (SETAI), one file per prefecture
  (r2ka01..47), plus the original shapefile zips.
- Format: Parquet with WKB `geometry` but **no GeoParquet metadata**;
  JGD2000 longitude/latitude (README); every attribute a string; one RG per
  file; 2.7-18.1 MB per prefecture.
- Licence: CC BY 4.0, 出典「令和2年国勢調査 小地域（町丁・字等別）境界データ」.
- Local: `/sata_hdd_24tb/hf_data/__published/estat-boundary-2020/data/parquet/r2kaNN.parquet`.
- Range: B (fetch one prefecture whole).
- Requests: "I want the population density of every neighbourhood in Osaka,
  tap for the name" (r2ka27). "I want to find the emptiest 町丁 next to the
  busiest one" (two-colour diverging map of one city).

#### estat-census-mesh-2020, estat-census-mesh-500m-2020, estat-census-mesh-250m-2020

- What: the 2020 census tabulated by grid square: 1 km (2,134,320 rows),
  500 m, 250 m (13,975,584 rows); 12 tables each (T0011xx: population by sex
  and age, households, etc.), 47 prefectures. Two geodetic datums, two sets
  of tables (README).
- Format: Parquet, **no geometry**: `KEY_CODE` is the JIS mesh code, so the
  cell rectangle is computed from the code. Every value column is a string
  (asterisks for suppressed values). 1 km: one RG per table (e.g. T001181
  177,859 rows, 19 MB). 500 m and 250 m: 47 RG, one per prefecture
  (`prefecture` column sorted), e.g. 250 m T001187 1,164,622 rows, 87.4 MB,
  footer 0.55 MB.
- Licence: CC BY 4.0, 出典 政府統計の総合窓口(e-Stat)「令和2年国勢調査」(総務省統計局), mark as processed.
- Local: `/sata_hdd_24tb/hf_data/__published/estat-census-mesh-<res>-2020/data/parquet/T0011NN.parquet`.
- Range: 1 km B (fetch a table whole, 3-19 MB); 500 m / 250 m A by prefecture.
- Requests: "I want a 250 m population grid of Tokyo as 3D bars that I can
  orbit" (one RG, geometry from codes on the GPU). "I want to show where
  people over 75 live alone in my prefecture, 500 m cells".

#### mlit-1km-fromto-2022-01 (also z:mlit-1km-fromto/)

- What: 全国の人流オープンデータ: average people present per 1 km mesh per month
  2019-01..2021-12, weekday/holiday, daytime/late night (38,079,507 rows); by
  municipality and origin (2,340,980); mesh attribute polygons (775,000);
  masters. 10 or fewer people suppressed.
- Format: Parquet zstd, 100k-row RG; mesh table sorted by prefcode, year,
  month, dayflag, timezone, mesh1kmid (380 RG, footer 0.23 MB); all codes are
  strings, population INT32. attribute_mesh1km is GeoParquet with the cell
  polygons and string lon/lat bounds. Bloom filters on some columns (README).
- Size: 104.1 MB (mesh), 5.5 MB (city), 7.0 MB (attributes).
- Licence: CC BY 4.0 via 政府標準利用規約 2.0, credit 「全国の人流オープンデータ」（国土交通省）.
- Local: `/sata_hdd_24tb/hf_data/__published/mlit-1km-fromto-2022-01/data/parquet/`,
  same bytes at `/sata_hdd_24tb/www/html/static/mlit-1km-fromto/`.
- Range: A by prefecture (then month).
- Requests: "I want to see Tokyo empty out in April 2020, month by month, at
  1 km, daytime vs night" (one prefecture, 36 months). "I want each
  municipality coloured by how many visitors came from other regions".

#### ksj-a31a-flood-tokyo23

- What: A31a flood inundation polygons (FY2025) that touch the 23 wards,
  227,651 polygons in five categories: planned (50,124), maximum (136,671),
  duration (40,374), collapse_flow (301), collapse_erosion (181); river,
  manager, class code. Also the raw shapefile zips (1.2 GB).
- Format: GeoParquet 1.1, EPSG:6668, **no bbox column and no spatial order**;
  flood_area 5 RG of 50,000 rows, 106.6 MB; per-category files 1-3 RG.
- Licence: CC BY 4.0, 出典「国土数値情報（洪水浸水想定区域データ（河川単位））」（国土交通省）を加工して作成.
- Local: `/sata_hdd_24tb/hf_data/ksj-a31a-flood-tokyo23/data/parquet/`.
- Range: C (a viewport query reads the whole category). The z:ksj/A31a files
  (Hilbert + bbox, wider area) are the better run-time source; use this one
  for its cleaned category split at bake time.
- Requests: "I want the 23 wards shaded by maximum-scale flood depth, with a
  toggle for how long the water stays" (maximum + duration, baked to a
  depth-class raster). "I want to pick a river and see only its flood area".

#### tokyo-flood-record-jp

- What: Tokyo's recorded floods 1974-2019 (浸水実績図): 5,845 flooded areas as
  polygons and 121 as points, with the date, river, municipality, damage
  counts and the nearest gauge's rainfall. 43 yearly zips.
- Format: GeoParquet 1.1, JGD2000 (EPSG:4612), one RG; 1.1 MB.
- Licence: CC BY 4.0, 出典：東京都「水害リスク情報システム 浸水実績図データ」を加工して作成.
- Local: `/sata_hdd_24tb/hf_data/tokyo-flood-record-jp/data/parquet/`.
- Range: B (fetch whole).
- Requests: "I want to scrub through 45 years of Tokyo floods and see the
  same streets go under again" (time slider, polygons). "I want recorded
  floods overlaid on the A31a predicted areas to see where they disagree".

#### mlit-toshi-keikaku-jp

- What: urban planning decision GIS data, FY2025 national edition, ~1,400
  municipalities, 26 layers: use districts (youto, 102,159 polygons with FAR
  and BCR), planned roads (douro, 191,584 lines), parks, district plans,
  location normalisation (ritteki), area division (senbiki), tokei...
  424,335 rows in all (README).
- Format: GeoParquet 1.0.0, EPSG:6668; rows in source shapefile order (city
  by city); **1-2 RGs per file** (youto 134.5 MB in 2 RG); footer tiny.
- Licence: CC BY 4.0 (PDL1.0). Reference data, not legal record (README).
- Local: `/sata_hdd_24tb/hf_data/__published/mlit-toshi-keikaku-jp/data/parquet/fy2025/`.
- Range: C. Bake per city.
- Requests: "I want to see which parcels around my station allow buildings of
  floor-area ratio 600% or more" (youto, one city). "I want planned but unbuilt
  roads of Tokyo in red over the OSM roads".

#### nfgis-2024

- What: national forest GIS 2024 (林野庁): small compartments 975,666
  polygons, compartments 58,293, forest roads 57,912 lines, with volume,
  species, age etc. One file per layer and plane-rectangular zone.
- Format: GeoParquet 1.1 in the zone's own CRS (EPSG:2443..2461), bbox
  covering, 10,240-row RG, rows in source-file order (by forest office);
  median RG bbox 9-17% of the zone. 1.26 GB in all; shouhan_zone10 214.9 MB.
- Licence: CC BY 4.0 (PDL1.0), 林野庁.
- Local: `/sata_hdd_24tb/hf_data/__published/nfgis-2024/data/parquet/2024/`.
- Range: B (bbox skips some RGs; reproject at bake).
- Requests: "I want to see the age of the national forest around Shirakami,
  stand by stand" (shouhan, one zone). "I want forest roads for an offline
  map on a field tablet".

#### ksj-n07-bus-route-jp, ksj-n07-bus-route-greater-tokyo

- What: bus route lines, KSJ N07 2022 edition: 354,208 lines nationwide
  (58,823 in Saitama, Chiba, Tokyo, Kanagawa), with operator; no route name or
  timetable in this edition.
- Format: GeoParquet 1.1, EPSG:6668, **one RG per file**; national 74.9 MB;
  per-prefecture files 0.5-3.6 MB.
- Licence: CC BY 4.0, 出典「国土数値情報（バスルートデータ）」（国土交通省）を加工して作成.
- Local: `/sata_hdd_24tb/hf_data/ksj-n07-bus-route-jp/data/parquet/` (and -greater-tokyo).
- Range: B (fetch one prefecture file).
- Requests: "I want every bus line of Kanagawa coloured by operator" (one file).

#### ksj-p11-bus-stop-jp, ksj-p11-bus-stop-greater-tokyo

- What: bus stops, KSJ P11 2022: 278,515 stops (44,101 in the four
  prefectures), with name, operator, list of routes and kinds, n_routes.
- Format: GeoParquet 1.1, EPSG:6668, one RG per file; national 7.3 MB.
- Licence: CC BY 4.0 (KSJ P11 credit).
- Local: `/sata_hdd_24tb/hf_data/ksj-p11-bus-stop-jp/data/parquet/`.
- Range: B (fetch whole; 7 MB for Japan).
- Requests: "I want bus stops sized by how many routes stop there, all of
  Japan, on a phone" (278k points, like example 07). "Tap a stop, see its routes".

#### ksj-l01-land-price

- What: official land prices (地価公示) 2019-2026: about 25,500-26,000 standard
  lots per year, 207,087 lot-years, price_yen, change_pct, use, zoning and
  ~150 more KSJ columns; lon/lat.
- Format: Parquet (not GeoParquet: lon/lat columns), one file per year,
  **47 RG, one per prefecture**, sorted by prefecture and municipality code;
  median RG bbox 0.23% of Japan; 5.6-6.4 MB per year.
- Licence: CC BY 4.0, 出典「国土数値情報（地価公示データ）」（国土交通省）を加工して作成.
- Local: `/sata_hdd_24tb/hf_data/__published/ksj-l01-land-price/data/parquet/<year>.parquet`.
- Range: A by prefecture.
- Requests: "I want land price as glowing pins over Tokyo, with a slider for
  2019 to 2026" (8 RGs of one prefecture). "I want to see where prices fell".

#### npa-traffic-accidents

- What: every injury road accident recorded by the police, 2019-2025, about
  300,000 a year (381,237 in 2019, 307,930 in 2023): date and hour, place,
  road, weather, light, parties, dead within 24 h, injured. Main table
  (honhyo) plus supplementary and expressway tables.
- Format: GeoParquet 1.0.0 points per year and table; 61-71 columns, mostly
  Japanese-named strings; 3-4 RG of 100k rows sorted by 資料区分 and
  都道府県コード (median RG bbox 11-30%); 15-18 MB per year.
- Licence: CC BY 4.0 (PDL1.0), 出典：警察庁ウェブサイト, with the modification note.
- Local: `/sata_hdd_24tb/hf_data/__published/npa-traffic-accidents/data/parquet/<year>/honhyo.parquet`.
- Range: B (by prefecture, coarse RGs).
- Requests: "I want to play back a year of accidents in Japan hour by hour,
  like the quake timeline" (300k points, time on the GPU). "I want the
  intersections near my child's school with the most pedestrian accidents".

#### gsi-evacuation-sites-jp

- What: designated emergency evacuation sites (115,872, with flags for flood,
  landslide, storm surge, earthquake, tsunami, large fire, inland flooding,
  volcano) and designated shelters (83,391), as registered with GSI, fetched
  2026-10-05.
- Format: GeoParquet 1.0.0 points, no crs (CRS84); sites 2 RG, shelters 1 RG;
  5.7 and 4.1 MB.
- Licence: CC BY 4.0 (PDL1.0), 出典：国土地理院ウェブサイト.
- Local: `/sata_hdd_24tb/hf_data/__published/gsi-evacuation-sites-jp/data/parquet/`.
- Range: B (fetch whole).
- Requests: "I want the nearest tsunami evacuation site from where I stand,
  offline, on a phone" (filter tsunami, KD-tree at bake). "I want all
  shelters of Japan as a dot map for a disaster-prep talk".

#### ekidata-jp

- What: 駅データ.jp free CSVs: 10,962 stations (in each dated file), lines,
  companies, adjacency (join), prefecture master; many dated snapshots
  2026-04 to 2026-07.
- Format: GeoParquet 1.0.0 points (stations), one RG, 0.6 MB per snapshot.
- Licence: **ekidata.jp terms**, not open: use and modification allowed;
  redistributing unmodified data only free of charge; no attribution required.
- Local: `/sata_hdd_24tb/hf_data/__published/ekidata-jp/data/parquet/2026-10-05/`.
- Range: B (fetch whole).
- Requests: "I want a schematic of every railway line in Kansai drawn from
  station adjacency" (join table + stations). "I want the station nearest to
  each school".

#### abr-src-2026-09

- What: Address Base Registry (Digital Agency) 2026-09: 47 prefectures,
  1,918 municipalities, 727,429 町字 with readings and romanisation;
  representative points for 337,641 towns (mt_town_pos_all).
- Format: Parquet, one RG per file, **coordinates as strings** (rep_lon,
  rep_lat) with SRID column; no geometry. 22 MB of Parquet.
- Licence: CC BY 4.0 (PDL1.0), 出典：「アドレス・ベース・レジストリ」（デジタル庁）.
- Local: `/sata_hdd_24tb/hf_data/__published/abr-src-2026-09/data/parquet/`.
- Range: B (fetch whole, 3.8 MB for town points).
- Requests: "I want a search box that flies to any 町字 in Japan, without a
  geocoding server" (names + points, baked into a prefix index).

#### gsi-global-map-jp

- What: Global Map Japan 1:1,000,000 (GSI, ISCGM spec) versions 2.0, 2.1, 2.2:
  boundaries, coast, drainage, population centres, roads (roadl 31,642
  lines), railways, airports; rasters only as zips.
- Format: GeoParquet 1.0.0 per version and layer, one RG; CRS ITRF94
  (EPSG:8994) for most layers, JGD2000 for a few (README table). 25 MB total.
- Licence: CC BY 4.0 (PDL1.0), credit GSI.
- Local: `/sata_hdd_24tb/hf_data/__published/gsi-global-map-jp/data/parquet/vector-2.2/`.
- Range: B (fetch whole).
- Requests: "I want a light Japan basemap for a microcontroller: coast,
  prefecture lines, expressways, nothing else" (1:1M is just right for 06-style).

#### mlit-underpass

- What: 3,841 road underpass points of MLIT's national underpass map
  (structurally low sections, not a danger ranking).
- Format: GeoParquet 1.1, CRS84; national file 0.2 MB + 47 prefecture files.
- Licence: CC BY 4.0 (PDL1.0), 出典「全国のアンダーパス箇所マップ」（国土交通省）をもとに作成.
- Local: `/sata_hdd_24tb/hf_data/mlit-underpass/data/parquet/`.
- Range: B (fetch whole).
- Requests: "I want to warn drivers of underpasses inside today's heavy-rain
  area" (with the flood data).

#### microsoft-building-footprints-kanto-2026-08-13

- What: Microsoft Global ML Building Footprints, two z9 QuadKeys
  (133002112, 133002113) covering 139.22-140.62°E, 35.46-36.03°N: 5,781,554
  machine-detected polygons with height and confidence (index 2026-08-13).
- Format: GeoParquet 1.0.0, WGS 84, 10,240-row RG (392 + 173); `quadkey` is
  the file's z9 key, constant; no bbox column, order as in the source.
  273.2 + 117.3 MB.
- Licence: CDLA-Permissive-2.0 (supply the licence text when sharing).
- Local: `/sata_hdd_24tb/hf_data/microsoft-building-footprints-kanto-2026-08-13/data/parquet/`.
- Range: C (no statistics to skip by). Bake with a Hilbert sort.
- Requests: "I want to compare OSM buildings with ML-detected ones in eastern
  Tokyo, in two colours" (with osm-tokyo23-src).

#### jma-rain-tokyo

- What: rainfall at 31 JMA stations in Tokyo (incl. Izu and Ogasawara),
  1974-2025: daily (588,783 station-days: total, max 1 h, max 10 min) and
  hourly (8,660,976 station-hours), with JMA quality flags; stations table
  with lat, lon, elevation.
- Format: Parquet; hourly 9 RG of ~1M rows sorted by station_id, 28.8 MB;
  daily one RG, 1.7 MB; stations 31 rows.
- Licence: CC BY 4.0 (PDL1.0), 出典：気象庁ホームページ「過去の気象データ・ダウンロード」を加工して作成.
- Local: not on disk; read from hf:jma-rain-tokyo/parquet/*.parquet (footers
  read over HTTP for this survey).
- Range: B (station = RG span; whole daily file is 1.7 MB).
- Requests: "I want rain gauges of Tokyo as pulsing circles, replaying
  Typhoon Hagibis hour by hour" (hourly, 2019-10-12). "I want the wettest
  hour each station ever had, on a map".

#### Bear sighting datasets (six)

| dataset | records | span | notes |
| --- | --- | --- | --- |
| akita-kumadas-wildlife-sighting | 24,757 | 2022-04 to 2026-09 | bear, boar, deer; sightings, traces, injuries; observed_at timestamp |
| ishikawa-bear-incident | 3,901 in 6 tables | FY2019-2025 | per cause (forest, river, attractants, young bears, 2020 mass outbreak) + 2025 sightings |
| kyoto-bear-sighting | 10,225 | 2009-04 to 2018-12 | adults/juveniles, environment, action |
| gifu-bear-sighting | 6,946 in 12 tables | FY2014-2025 | one table per year, columns differ; R2-R7 reprojected from plane CS VII |
| nagaoka-bear-sighting | 166 | 2014-2016 | |
| kamisunagawa-higuma-sighting | 105 | 2024-05 to 2026-08 | brown bear, Hokkaido |

- Format: GeoParquet 1.1 points, CRS84, one RG per file, 0.01-2.1 MB.
- Licence: CC BY 4.0 each, credit the prefecture or town as in each README.
- Local: `/sata_hdd_24tb/hf_data/<dataset>/data/parquet/`.
- Range: B (fetch whole).
- Requests: "I want to watch bear sightings in Akita creep toward towns month
  by month in autumn 2025" (time slider, 25k points). "I want one map of all
  bear sightings in Japan the open data allows, coloured by source".

### 2b. Japan and East Asia, grids stored as GeoParquet

These keep a raster's cells as rows (polygon footprints or centre points).
For a renderer the geometry column is mostly redundant: the grid row/column
(or mesh code) gives the position, and a bake to a typed array or texture is
far smaller.

#### agera5-japan-monthly-temperature-1979-2026

- What: AgERA5 v2.0 monthly mean of daily max and min 2 m temperature (K),
  0.1° grid, 122-154°E, 20-46°N (land and sea), January 1979 to July 2026,
  571 months.
- Format: GeoParquet 1.1 points (cell centres, CRS84), hive `year=YYYY/`
  partitions, **one RG per month** (83,200 cells), sorted by month; 1.76 MB
  per year, 84 MB total. NoData as NULL.
- Licence: CC BY 4.0 (Copernicus C3S AgERA5; credit as README).
- Local: `/sata_hdd_24tb/hf_data/agera5-japan-monthly-temperature-1979-2026/data/`.
- Range: A (one month = one RG of ~150 KB).
- Requests: "I want to watch 47 summers of Japan warm up, month by month, as
  a heat texture" (one RG per frame, or bake all months to one texture
  array). "I want this month's anomaly against the 1991-2020 mean".

#### ghsl-japan-core-2020-30arcsec

- What: GHSL R2023A epoch 2020 at 30 arc seconds: GHS-POP residential
  population and GHS-BUILT-S built-up surface, five whole 10° tiles
  (about 120-150°E, 29-49°N), every cell including zeros: 7,200,000 cells per
  product.
- Format: GeoParquet 1.0.0, cell polygons, WGS 84; one file per tile and
  product (1,440,000 rows, 15 RG sorted by cell_row, ~16 MB).
- Licence: CC BY 4.0 (JRC, cite the products).
- Local: `/sata_hdd_24tb/hf_data/ghsl-japan-core-2020-30arcsec/data/parquet/`.
- Range: B (latitude bands via cell_row).
- Requests: "I want a population spike map of Japan and Korea as 3D columns".

#### koppen-geiger-east-asia-1991-2020

- Köppen-Geiger classes 1991-2020 (Beck et al. 2023, v2), 1 km cells merged
  into 13,480 polygons, 122-154°E, 20-48°N. GeoParquet, WGS 84, 3 RG, 1.0 MB.
  CC BY 4.0. Local `/sata_hdd_24tb/hf_data/koppen-geiger-east-asia-1991-2020/data/parquet/`.
  Range B (fetch whole).
- Request: "I want a climate-zone map of Japan for a geography class, tap a
  zone for its description".

#### esa-worldcover-tokyo-2021-100m

- ESA WorldCover 2021 v200, 139.5-140.0°E, 35.5-36.0°N, aggregated to
  10x10-pixel blocks (~93x76 m): 360,000 cells with counts of all 11 classes
  and the dominant class. GeoParquet, 8 RG, 4.8 MB. CC BY 4.0 (© ESA
  WorldCover project 2021). Range B (fetch whole).
- Request: "I want Tokyo's green share per 100 m block, so I can find the
  greenest walk home".

#### gsi-dem-fuji-z14-100m-2026-10-25

- GSI DEM10B z14 tiles (10x10 tiles around Mt. Fuji) aggregated to ~95.55 m
  Web Mercator cells: 65,536 cells with mean/min/max elevation. GeoParquet
  1.1, EPSG:3857, one RG, 1.7 MB; the 100 source text tiles included.
  PDL1.0 / CC BY 4.0-compatible, GSI credit. Range B.
- Request: "I want a small 3D Fuji on the microcontroller display".

#### East Hokkaido extracts

| dataset | what | grid / rows | size | licence |
| --- | --- | --- | --- | --- |
| gebco-2026-hokkaido-east-15as | GEBCO 2026 elevation and bathymetry, 143-146°E 42-45°N | 518,400 pixel polygons, 17 RG | 3.9 MB | OGL v3 / GEBCO terms |
| ctrees-agb-hokkaido-east-100m | CTrees aboveground biomass 2010 and 2025 (+ uncertainty), 143-147°E 42-46°N | 43,550 ~1 km blocks | 2.1 MB | CC BY 4.0 |
| forty-hokkaido-east-2020 | ForTy forest typology 2020, 6 classes, 10 m source | 63,630 polygons, UTM 55N | 12.8 MB | CC BY 4.0 |
| gpw-grasslands-hokkaido-east-2018-2020-250m | Global Pasture Watch grassland classes 2018-2020 | 313,489 blocks of 10x10 30 m px | 4.8 MB | CC BY 4.0 |
| gfw-forest-carbon-net-flux-hokkaido-east-2001-2023-v1-3-2 | GFW forest carbon net flux 2001-2023, cumulative | 34,516,630 points, 47 RG | 36.9 MB | CC0 |

- Format: GeoParquet (1.0 or 1.1), mostly WGS 84; local
  `/sata_hdd_24tb/hf_data/<dataset>/data/`.
- Range: B (fetch whole), gfw B (47 RGs, no bbox).
- Requests: "I want the Shiretoko peninsula from seafloor to summit in one
  colour ramp" (gebco). "I want to see where east Hokkaido's forests gained
  or lost biomass between 2010 and 2025" (ctrees).

#### worldpop-kor-population-2015-2030-1km-r2025a, worldpop-idn-population-2015-2030-1km-r2025a

- WorldPop R2025A constrained population 2015-2030 at 1 km, one row per cell
  with 16 year columns (wide), cell polygons, WGS 84. Korea 130,927 cells,
  11 RG, 12.9 MB; Indonesia 948,911 cells, 33 RG, 94.3 MB; sorted by grid_row.
- Licence: frontmatter says ODbL for the derived table, source CC BY 4.0
  (read each LICENSE).
- Range: B (latitude bands by grid_row).
- Request: "I want Jakarta's population growth 2015-2030 as a pulsing grid".

### 2c. World

#### geonames (also z:geonames/2026-10-01/)

- What: GeoNames dump 2026-10-01: 13,472,217 places (points with feature
  class/code, population, elevation, admin codes, timezone), 19,219,062
  alternate names, hierarchy, admin code 5.
- Format: GeoParquet 1.0.0 points, sorted by country_code then geonameid, in
  four parts under 512 MB (part-00..03, 102-177 MB), 100k-row RG; median RG
  bbox 2.6-20%. alternate_names sorted by geonameid (192 RG).
- Licence: CC BY 4.0, "GeoNames (https://www.geonames.org/), CC BY 4.0".
- Local: `/sata_hdd_24tb/hf_data/__published/geonames/data/parquet/20261001/`;
  z:geonames/2026-10-01/geoname/part-NN.parquet (manifest.json says which
  countries are in which part).
- Range: B (by country code; within a country no spatial order).
- Requests: "I want every mountain peak of Nepal labelled with its height"
  (one country, feature_code PK). "I want a map of all places called 'Sakura'
  in the world".

#### wikidata-gazetteer

- What: every Wikidata item with coordinates: 12,205,328 places (lat, lon,
  country, parent, instance_of, population, area, sitelinks) and 62,506,107
  names in 552 languages; dump 2026-08-31.
- Format: Parquet (no geometry column), 500k-row RG, no spatial order (median
  RG bbox 40%); places 355 MB, names 508 MB. Some coordinates are out of
  range (lon up to 360, lat up to 351): items on other globes or bad values;
  filter at bake.
- Licence: CC0.
- Local: `/sata_hdd_24tb/hf_data/__published/wikidata-gazetteer/data/`.
- Range: C.
- Requests: "I want place labels in Ainu, Japanese and English side by side
  for Hokkaido" (names by language). "I want every place sized by how many
  Wikipedias write about it" (sitelinks).

#### wikipedia-geotagged, wikivoyage-geotagged

- Geotagged Wikipedia articles with full text: en 1,374,056 articles, ja
  218,496 (dump 2026-09-01); Wikivoyage en 29,505. Columns id, url, title,
  text, qid, lat, lon, geotag type/dim/country/region. Parquet, 5,000-row RG,
  sorted by id; no spatial order; 2.2 GB / 102 MB. CC BY-SA 4.0.
- Range: C (text-heavy; bake a points-and-titles file).
- Request: "I want to wander a city and see which Wikipedia articles are
  within 200 m, titles only, offline".

#### ourairports-2026-08

- OurAirports at the last commit of August 2026: 86,002 airports, heliports
  and fields; runways, navaids (11,008), frequencies, comments, countries,
  regions. airports and navaids are GeoParquet 1.0.0 points, one RG; 5.0 MB.
  Public domain (credit asked: "Data from OurAirports"). Newer snapshot at
  z:ourairports/2026-10-01/. Range B (fetch whole).
- Requests: "I want every airport with scheduled service as dots, runways
  drawn true to heading when zoomed" (airports + runways ends). "I want the
  helipads of Tokyo".

#### ucdp-ged

- UCDP Georeferenced Event Dataset, releases 19.1 to 26.1 (26.1: 417,968
  events of organised violence since 1989, with date range, sides, deaths,
  precision). GeoParquet 1.0.0 points per release, 51,200-row RG sorted by
  country_id; 9.7-35.6 MB. CC BY 4.0 with UCDP's citation condition. Raw CSV
  also at z:ucdp/. Range B (by country).
- Requests: "I want 35 years of conflict deaths in Africa as a time-lapse of
  fading circles" (time on the GPU, like 03). "I want one country's events
  by type of violence".

#### ibtracs-v04r01

- IBTrACS v04r01 since 1980: 311,935 track points of tropical cyclones from
  all agencies (175 columns: SID, season, basin, name, ISO time, lat/lon,
  winds, pressures per agency). GeoParquet 1.0.0 points, 7 RG sorted by SID
  and season; 8.8 MB. NOAA/NCEI terms (open, credit as LICENSE).
  Range B (fetch whole).
- Requests: "I want every typhoon that hit Japan since 1980 as tracks coloured
  by strength, with a year slider". "I want this season's storms over the
  last 45 years' density".

#### usgs-comcat-2025-m45

- 8,502 M4.5+ earthquakes of 2025 (preferred network us), GeoParquet points,
  5 RG, 0.6 MB; the source of example 03. Public domain (credit USGS ComCat).
  Range B (fetch whole). Local `/sata_hdd_24tb/hf_data/usgs-earthquake-catalog-2025-m45/data/`.
- Request: "I want the Pacific ring of fire to light up quake by quake".

#### opencellid

- OpenCelliD world export 2026-10-06: 5,502,843 cells (GSM, UMTS, LTE, NR,
  CDMA) with estimated position, range, samples. GeoParquet 1.0.0, 45 RG of
  ~123k rows sorted by mcc, net, area (Japan mcc 440/441 in 7 RGs, README);
  126.5 MB. **CC BY-SA 4.0** ("Cell tower data from OpenCellID"). Range B
  (by country code).
- Requests: "I want 5G vs LTE cells in Japan as two colours of dust".
  "I want the coverage radius of cells along my commute".

#### timezone-boundary-builder-2026d

- Time zone polygons, release 2026d: all zones (419), same since 1970 (301),
  same now (65). GeoParquet 1.0.0, WGS 84, **one RG**, 43-90 MB (detailed
  coastlines). ODbL. Range C (simplify at bake).
- Request: "I want a world clock where the map shades each zone by its local
  hour" (simplified timezones-now).

#### natural-earth, ne-admin0-10m

- natural-earth: every Natural Earth vector layer at 1:10m, 1:50m, 1:110m,
  cultural and physical, v5.1.2: 215 GeoParquet files (one per layer, WGS 84,
  one RG each, with source URL and sha256 in key-value metadata), 450 MB,
  plus the publisher's zips. ne-admin0-10m: v5.1.1 admin 0, 1, 2 at 1:10m
  (258 / 4,596 / 3,224 features) as Parquet with WKB geometry **without
  GeoParquet metadata**; the source of examples 01, 02, 07.
- Licence: public domain (credit appreciated).
- Local: `/sata_hdd_24tb/hf_data/__published/natural-earth/data/parquet/v5.1.2/`,
  `/sata_hdd_24tb/hf_data/__published/ne-admin0-10m/v5.1.1/`.
- Range: B (fetch the one layer needed).
- Requests: "I want a minimalist poster map: coastlines, rivers and lakes of
  the world, no borders" (three 110m/50m layers). "I want ports and
  shipping lanes of East Asia".

#### kontur-population-2023-11-01-22km

- Kontur Population 2023-11-01 on H3 resolution 4 (~22 km): 71,283 cells,
  total 8,031,924,024 people. GeoParquet 1.0.0, EPSG:3857 hexagon polygons,
  7 RG, 3.5 MB. CC BY (HDX). Range B (fetch whole). The 400 m version is the
  6.7 GB GeoPackage on z:kontur/.
- Request: "I want a hexagon population globe that fits in 4 MB".

#### forest-typology-validation-2020

- GVFT 2020 v0.6: 9,100 global forest validation sites (8,190 resolved) with
  two annotators' labels and model scores. GeoParquet points, 0.3 MB each.
  CC BY 4.0 (credit Neumann et al.). Range B.
- Request: "I want to see where experts and the model disagree on forest type".

#### meta-move-dist, meta-range-maps-2022-05

- Same Parquet as z:hdx-meta (part 1): Movement Distribution 2026-06 onward
  (217 countries, by GADM region and day; kept beyond HDX's 90 days) and
  Movement Range Maps 2020-03 to 2022-05 (19,142 regions, 153 countries).
  No geometry. CC BY 4.0. Range B (by country).
- Request: "I want the 2020 lockdown in Italy as a day-by-day choropleth"
  (needs GADM polygons, which are not on either shelf).

---

## 3. Country tables (map-relevant through a join)

All are per country (and year) tables with ISO codes; draw them by joining to
Natural Earth countries (`ADM0_A3` / `ISO_A3`; watch the -99 codes of France,
Norway and Kosovo in NE). None has geometry. Range B: fetch the one indicator
or table needed.

| dataset | content | parquet | licence |
| --- | --- | --- | --- |
| worldbank-wdi | World Development Indicators, several releases 2024-05 to 2026-10 (74 indicators excluded, see README) | 370 MB | CC BY 4.0 (WB terms incl. arbitration clause) |
| undp-hdr | Human Development Report 2025 composite indices, time series | 2.6 MB | other (UNDP terms) |
| unhcr-refugee-stats | refugee population, demographics, asylum applications and decisions, 2026-10-04 | 2.6 MB | CC BY 4.0 |
| maddison-project | Maddison Project GDP per capita and population, 2018/2020/2023 releases | 0.6 MB | CC BY 4.0 |
| pwt | Penn World Table 8.0 to 11.0 | 41 MB | CC BY 4.0 |
| un-wpp | World Population Prospects 2019/2022/2024 incl. life tables | 3.2 GB | other (UN terms) |
| un-statistical-yearbook | UN Statistical Yearbook 68 tables | 0.4 MB | other (UN terms) |
| undata-sdmx | UNdata SDMX dataflows (SEEA energy etc.) | 16 MB | other |
| edgar-ghg-countries | EDGAR 2026 GHG by country and sector (CH4, N2O, F-gases, biogenic CO2 only; fossil CO2 is NC-ND and excluded) | zips only | CC BY 4.0 |
| faostat | FAOSTAT bulk downloads (trade, food balance, emissions...) | zips only | CC BY 4.0 |
| ilostat | ILOSTAT indicators (2,219 files) | CSV/gz only | CC BY 4.0 |
| estat-jumin-idou | Japan internal migration report, 471 e-Stat tables, 214 M values, by prefecture and municipality code | 458 MB (472 files) | e-Stat terms (CC BY 4.0 compatible) |

- Local: `/sata_hdd_24tb/hf_data/__published/<dataset>/data/`.
- estat-jumin-idou joins to jp-admin by municipality code instead of to
  Natural Earth.
- Requests: "I want life expectancy per country as a slider from 1950 to
  2100" (un-wpp + NE 110m). "I want arrows of net migration between Japanese
  prefectures" (estat-jumin-idou + jp-admin centroids).

Other tables that are map-adjacent but not drawn as such: env-redlist-jp
(Red List of Japan by taxon; species lists without locations, CC BY 4.0),
osm-wikidata-brand-jp / -tokyo23 (brand names per Wikidata id; ODbL),
geo-triples-japan / -tokyo23 / -jp-gov (spatial relation triples between
named features, for QA and LLM training; ODbL or CC BY 4.0).

---

## 4. Skipped: non-spatial text and QA datasets

- un-docs: UN documents text (409 MB).
- egov-laws-jp: Japanese laws from e-Gov (555 MB).
- gsj-reports: Geological Survey of Japan report texts (JSONL).
- nilim-disaster-reports: NILIM disaster report texts (JSONL).
- moni1000-reports: Monitoring Sites 1000 report texts (JSONL).
- mlit-river-basin-overviews: MLIT river basin overview texts (JSONL).
- rinya-forest-inventory: Forestry Agency inventory documents, 0.02 MB (JSONL).
- osm-wiki: OSM wiki pages (159 MB).
- osm-tag-corpus: OSM tag descriptions corpus.
- text2geoql: natural language to Overpass QL pairs.
- osm-tokyo23-questions, osm-tokyo23-qa-2026-08: question and answer sets
  over the frozen Tokyo OSM snapshot (evaluation data, not map data).
- onomatopoeia-ja, onomatopoeia-ja-flat, sake_qa, scp-jp-plain, g-uc,
  open2ch-livejupiter-qa: Japanese text corpora from 2024.

Not published on the Hub (local work in progress, not surveyed):
`/sata_hdd_24tb/hf_data/{edgar-ghg-grids, ksj-a31a-flood-greater-tokyo,
ksj-a45-2019, moj-chizu, plateau-citygml-jp, tokyo23-bus-gtfs, ...}`.
