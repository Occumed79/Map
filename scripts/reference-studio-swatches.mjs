// Exact sRGB swatches measured from the supplied Mapbox Studio screenshots.
//
// The PNGs use an embedded Display-P3 profile. These values are the profile-
// converted sRGB colors that belong in a MapLibre style, grouped by the paint
// property that displays the swatch. A group can contain several layers because
// the Studio style intentionally reuses a color within a structural family.
//
// Pattern previews and rows that show an ellipsis instead of a solid chip are
// deliberately absent: those layers keep their exported expressions/patterns.
export const REFERENCE_STUDIO_SWATCH_GROUPS = Object.freeze([
  {
    property: 'fill-color',
    color: '#A5CAD6',
    layers: ['wetland-pattern', 'wetland']
  },
  {
    property: 'fill-color',
    color: '#79BCEC',
    layers: ['water']
  },
  {
    property: 'line-color',
    color: '#79BCEC',
    layers: ['waterway']
  },
  {
    property: 'fill-color',
    color: '#7293EE',
    layers: ['water-shadow']
  },
  {
    property: 'line-color',
    color: '#7293EE',
    layers: ['waterway-shadow']
  },
  {
    property: 'line-color',
    color: '#A9DB70',
    layers: ['pitch-outline']
  },
  {
    property: 'line-color',
    color: '#A5CC8E',
    layers: ['national-park_tint-band']
  },
  {
    property: 'fill-color',
    color: '#A5CC8E',
    layers: ['national-park']
  },
  {
    property: 'fill-color',
    color: '#E0E0D1',
    layers: ['occumed-land-surface']
  },
  {
    property: 'line-color',
    color: '#95958E',
    layers: [
      'tunnel-street-case',
      'tunnel-minor-case',
      'tunnel-primary-case',
      'tunnel-secondary-tertiary-case'
    ]
  },
  {
    property: 'fill-color',
    color: '#D1C1F1',
    layers: ['building-underground']
  },
  {
    property: 'fill-color',
    color: '#C8C6B6',
    layers: ['building']
  },
  {
    property: 'line-color',
    color: '#A4ADD5',
    layers: ['aeroway-line']
  },
  {
    property: 'fill-color',
    color: '#A4ADD5',
    layers: ['aeroway-polygon']
  },
  {
    property: 'line-color',
    color: '#E0E0D1',
    layers: ['land-structure-line']
  },
  {
    property: 'fill-color',
    color: '#E0E0D1',
    layers: ['land-structure-polygon', 'road-pedestrian-polygon-fill']
  },
  {
    property: 'line-color',
    color: '#F2F2F2',
    layers: [
      'tunnel-minor-link',
      'tunnel-pedestrian',
      'tunnel-major-link-case',
      'tunnel-primary',
      'tunnel-secondary-tertiary',
      'tunnel-street-low',
      'road-primary',
      'road-secondary-tertiary',
      'road-street-low',
      'road-minor-link',
      'road-minor',
      'road-construction',
      'road-pedestrian',
      'road-steps',
      'road-path',
      'road-path-cycleway-piste',
      'road-path-trail',
      'bridge-primary',
      'bridge-secondary-tertiary',
      'bridge-street-low',
      'bridge-minor-link',
      'bridge-minor',
      'bridge-pedestrian',
      'bridge-steps',
      'bridge-path',
      'bridge-path-cycleway-piste',
      'bridge-path-trail'
    ]
  },
  {
    property: 'circle-color',
    color: '#F2F2F2',
    layers: ['turning-feature-outline', 'turning-feature']
  },
  {
    property: 'fill-color',
    color: '#F2F2F2',
    layers: ['road-polygon']
  },
  {
    property: 'line-color',
    color: '#EEEEDD',
    layers: [
      'tunnel-steps',
      'tunnel-path',
      'tunnel-path-cycleway-piste',
      'tunnel-path-trail'
    ]
  },
  {
    property: 'line-color',
    color: '#D6D6CD',
    layers: [
      'tunnel-motorway-trunk-case',
      'road-motorway-trunk-case',
      'road-major-link-case',
      'bridge-motorway-trunk-2-case',
      'bridge-major-link-2-case',
      'bridge-motorway-trunk-case',
      'bridge-major-link-case'
    ]
  },
  {
    property: 'line-color',
    color: '#BABAAB',
    layers: [
      'tunnel-construction',
      'tunnel-minor-link-case',
      'road-secondary-tertiary-case',
      'road-minor-link-case',
      'road-street-case',
      'road-pedestrian-case',
      'road-primary-case',
      'bridge-construction',
      'bridge-pedestrian-case',
      'bridge-primary-case',
      'bridge-secondary-tertiary-case',
      'bridge-minor-link-case'
    ]
  },
  {
    property: 'line-color',
    color: '#86AC72',
    layers: ['golf-hole-line']
  },
  {
    property: 'line-color',
    color: '#DC8B18',
    layers: ['road-steps-bg', 'bridge-steps-bg']
  },
  {
    property: 'line-color',
    color: '#A65966',
    layers: ['admin-0-boundary-disputed', 'admin-0-boundary']
  },
  {
    property: 'line-color',
    color: '#AF6A75',
    layers: ['admin-1-boundary']
  },
  {
    property: 'line-color',
    color: '#FCC5CE',
    layers: ['admin-0-boundary-bg', 'admin-1-boundary-bg']
  },
  {
    property: 'line-color',
    color: '#6676CC',
    layers: ['aerialway']
  }
]);

// These chips show the color resolved at the Studio screenshot's active zoom,
// while the exported layer must retain its zoom expression.
export const REFERENCE_STUDIO_EXPRESSION_SWATCHES = Object.freeze([
  {
    property: 'line-color',
    color: '#6098E1',
    layers: ['ferry-auto', 'ferry']
  },
  {
    property: 'line-color',
    color: '#B8C299',
    layers: ['bridge-rail-tracks', 'bridge-rail']
  }
]);

export const REFERENCE_STUDIO_UNAVAILABLE_SWATCHES = Object.freeze([
  {
    referenceLayer: 'contour-line',
    property: 'line-color',
    color: '#626250',
    reason: 'The virtual OpenMapTiles schema has no contour vector layer.'
  }
]);
