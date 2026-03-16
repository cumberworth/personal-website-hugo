/// <reference types="d3" />
/// <reference types="geojson" />

import type { Topology, GeometryCollection, GeometryObject } from 'topojson-specification';

declare global {
  // Ambient declaration for the CDN-loaded topojson global.
  const topojson: {
    feature<P extends GeoJSON.GeoJsonProperties = GeoJSON.GeoJsonProperties>(
      topology: Topology,
      object: GeometryCollection<P>,
    ): GeoJSON.FeatureCollection<GeoJSON.GeometryObject, P>;
    feature<P extends GeoJSON.GeoJsonProperties = GeoJSON.GeoJsonProperties>(
      topology: Topology,
      object: GeometryObject<P>,
    ): GeoJSON.Feature<GeoJSON.GeometryObject, P> | GeoJSON.FeatureCollection<GeoJSON.GeometryObject, P>;
  };
}
