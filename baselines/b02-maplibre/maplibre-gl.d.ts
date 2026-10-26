// The part of MapLibre GL JS 5.24.0 this page uses. The library is the UMD
// bundle loaded by a classic <script> in index.html, which sets the global
// maplibregl; its own typings are not used, so the page needs no package.
declare namespace maplibregl {
  type LngLat = [lon: number, lat: number];
  interface Point { x: number; y: number }
  type PointLike = Point | [x: number, y: number];
  // A style expression or literal: ['step', ['get', 'pop'], '#fff7ec', 1e5, ...]
  type Expression = string | number | boolean | Expression[];

  interface LayerSpecification {
    id: string;
    type: 'background' | 'fill' | 'line';
    source?: string;
    paint?: Record<string, Expression>;
  }
  interface StyleSpecification {
    version: 8;
    sources: Record<string, { type: 'geojson'; data: string }>;
    layers: LayerSpecification[];
  }
  interface CameraOptions { center: LngLat; zoom: number }
  interface MapOptions extends CameraOptions {
    container: string | HTMLElement;
    style: StyleSpecification;
    minZoom: number;
    maxZoom: number;
    renderWorldCopies: boolean;
    attributionControl: false;
    fadeDuration: number;
  }
  interface MapMouseEvent { point: Point }
  // P is the shape of the source's feature properties, which the page knows
  // because it baked them.
  interface MapGeoJSONFeature<P> { properties: P }

  class Map {
    constructor(options: MapOptions);
    on(type: 'click', listener: (e: MapMouseEvent) => void): this;
    once(type: 'idle', listener: (e: object) => void): this;
    queryRenderedFeatures<P extends object>(point: PointLike, options: { layers: string[] }): MapGeoJSONFeature<P>[];
    project(lnglat: LngLat): Point;
    jumpTo(options: CameraOptions): this;
    redraw(): this;
    getCanvas(): HTMLCanvasElement;
  }

  function getVersion(): string;
}
