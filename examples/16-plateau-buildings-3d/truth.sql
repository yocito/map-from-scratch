-- Independent truth for one building GML (one 1 km mesh), with DuckDB only:
-- no XML parser, no earcut, none of the bake's TypeScript. PLATEAU writes
-- one element per line and a posList on one line, so the file is read as
-- lines; the bake checks the second assumption (posList open = close lines).
-- Variables (SET VARIABLE, from bake.ts): f, out, lat0, lon0, kx, ky, half, tile.
-- Output: one row per building whose lod1Solid mean lies in the area.
SET memory_limit = '2GB';
SET threads = 4;
LOAD spatial;

CREATE TEMP TABLE l AS
SELECT * FROM (
  SELECT row_number() OVER () AS rn, line
  FROM read_csv(getvariable('f'), columns = {'line': 'VARCHAR'}, delim = E'\x01', quote = '', escape = '',
                header = false, auto_detect = false, strict_mode = false)
)
WHERE line LIKE '%<gml:posList%' OR line LIKE '%</gml:posList>%' OR line LIKE '%<bldg:Building gml:id=%'
   OR line LIKE '%<gml:exterior>%' OR line LIKE '%<gml:interior>%' OR line LIKE '%<gml:Polygon%'
   OR line LIKE '%bldg:BuildingInstallation%'
   OR regexp_matches(line, '<bldg:(lod0RoofEdge|lod0FootPrint|lod1Solid|lod2MultiSurface|lod2Geometry|lod3MultiSurface|lod3Geometry)[ >]');

-- posList lines must hold their closing tag (one posList per line).
SELECT count(*) FILTER (WHERE line LIKE '%<gml:posList%') AS open_lines,
       count(*) FILTER (WHERE line LIKE '%</gml:posList>%') AS close_lines,
       count(*) FILTER (WHERE line LIKE '%<gml:posList%</gml:posList>%') AS both_lines
FROM l;

CREATE TEMP TABLE m AS
SELECT rn, line,
  sum((line LIKE '%<bldg:Building gml:id=%')::int) OVER w AS b,
  last_value(CASE WHEN regexp_matches(line, '<bldg:(lod0RoofEdge|lod0FootPrint|lod1Solid|lod2MultiSurface|lod2Geometry|lod3MultiSurface|lod3Geometry)[ >]')
                  THEN regexp_extract(line, '<bldg:(\w+)', 1) END IGNORE NULLS) OVER w AS sect,
  last_value(CASE WHEN line LIKE '%<gml:exterior>%' THEN 'e' WHEN line LIKE '%<gml:interior>%' THEN 'i' END IGNORE NULLS) OVER w AS ring,
  coalesce(last_value(CASE WHEN line LIKE '%<bldg:BuildingInstallation%' THEN 1 WHEN line LIKE '%</bldg:BuildingInstallation>%' THEN 0 END IGNORE NULLS) OVER w, 0) AS inst,
  sum((line LIKE '%<gml:Polygon%')::int) OVER w AS poly
FROM l WINDOW w AS (ORDER BY rn);

CREATE TEMP TABLE p AS
SELECT b, rn, sect, ring, inst, poly, regexp_split_to_array(trim(regexp_extract(line, '<gml:posList[^>]*>(.*)</gml:posList>', 1)), '\s+') AS s
FROM m WHERE line LIKE '%<gml:posList%' AND b > 0;

-- Per ring: projected coordinates and the triangle formula's term.
CREATE TEMP TABLE r AS
SELECT b, rn, sect, ring, poly,
  CASE WHEN sect = 'lod2MultiSurface' AND inst = 0 THEN 'L0' WHEN sect = 'lod2Geometry' OR (sect = 'lod2MultiSurface' AND inst = 1) THEN 'L1' ELSE sect END AS k,
  len(s) // 3 AS n,
  [(s[i]::double) FOR i IN range(1, len(s) + 1, 3)] AS lat,
  [(s[i + 1]::double) FOR i IN range(1, len(s) + 1, 3)] AS lon,
  [(s[i + 2]::double) FOR i IN range(1, len(s) + 1, 3)] AS z
FROM p;

CREATE TEMP TABLE head AS
SELECT b, regexp_extract(line, 'gml:id="([^"]+)"', 1) AS id FROM m WHERE line LIKE '%<bldg:Building gml:id=%';

-- Per building: the lod1Solid mean (the tile rule), whether it has LOD2 shells.
CREATE TEMP TABLE c AS
SELECT b,
  (sum(list_sum(lon)) FILTER (WHERE k = 'lod1Solid') / sum(n) FILTER (WHERE k = 'lod1Solid') - getvariable('lon0')) * getvariable('kx') AS x,
  (sum(list_sum(lat)) FILTER (WHERE k = 'lod1Solid') / sum(n) FILTER (WHERE k = 'lod1Solid') - getvariable('lat0')) * getvariable('ky') AS y,
  bool_or(k = 'L0') AS has2
FROM r WHERE k IN ('lod1Solid', 'L0') GROUP BY b;

-- The rings that are drawn: L0 (or lod1Solid without LOD2) and L1.
CREATE TEMP TABLE d AS
SELECT r.b, CASE WHEN r.k = 'L1' THEN 1 ELSE 0 END AS lv, r.n, r.ring,
  list_min([(v - getvariable('lon0')) * getvariable('kx') FOR v IN lon]) AS x0, list_max([(v - getvariable('lon0')) * getvariable('kx') FOR v IN lon]) AS x1,
  list_min([(v - getvariable('lat0')) * getvariable('ky') FOR v IN lat]) AS y0, list_max([(v - getvariable('lat0')) * getvariable('ky') FOR v IN lat]) AS y1,
  list_min(z) AS z0, list_max(z) AS z1
FROM r JOIN c USING (b)
WHERE r.k = 'L1' OR r.k = 'L0' OR (r.k = 'lod1Solid' AND NOT c.has2);

-- lod0RoofEdge footprint: the largest polygon, its PointOnSurface and area.
CREATE TEMP TABLE f0 AS
SELECT b, poly, ST_GeomFromText('POLYGON(' || string_agg('(' || array_to_string(
    [((lon[i] - getvariable('lon0')) * getvariable('kx'))::varchar || ' ' || ((lat[i] - getvariable('lat0')) * getvariable('ky'))::varchar FOR i IN range(1, n + 1)], ', ') || ')',
    ', ' ORDER BY rn) || ')') AS g
FROM r WHERE sect = 'lod0RoofEdge' GROUP BY b, poly;
CREATE TEMP TABLE f1 AS
SELECT b, arg_max(ST_PointOnSurface(g), ST_Area(g)) AS pt, max(ST_Area(g)) AS area FROM f0 GROUP BY b;

COPY (
  SELECT getvariable('mesh') AS mesh, head.id, c.x, c.y,
    floor((c.x + getvariable('half')) / getvariable('tile'))::int AS tx, floor((c.y + getvariable('half')) / getvariable('tile'))::int AS ty,
    c.has2::int AS has2,
    sum(CASE WHEN lv = 0 THEN n - 1 + (CASE WHEN ring = 'i' THEN 2 ELSE -2 END) ELSE 0 END) AS tri0,
    sum(CASE WHEN lv = 1 THEN n - 1 + (CASE WHEN ring = 'i' THEN 2 ELSE -2 END) ELSE 0 END) AS tri1,
    count(*) FILTER (WHERE lv = 0) AS rings0, count(*) FILTER (WHERE lv = 1) AS rings1,
    min(x0) AS minx, min(y0) AS miny, min(z0) AS minz, max(x1) AS maxx, max(y1) AS maxy, max(z1) AS maxz,
    any_value(ST_X(f1.pt)) AS px, any_value(ST_Y(f1.pt)) AS py, any_value(f1.area) AS area
  FROM c JOIN head USING (b) JOIN d USING (b) LEFT JOIN f1 USING (b)
  WHERE c.x >= -getvariable('half') AND c.x < getvariable('half') AND c.y >= -getvariable('half') AND c.y < getvariable('half')
  GROUP BY ALL ORDER BY head.id
) TO (getvariable('out')) (HEADER, DELIMITER ',');
