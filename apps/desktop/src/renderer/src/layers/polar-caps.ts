import * as Cesium from 'cesium';

/**
 * Fills the two polar caps a Web Mercator basemap cannot reach.
 *
 * ## The hole this closes
 *
 * Web Mercator is undefined at the poles, so every tile pyramid built on it
 * stops at **±85.0511°**. Above that a basemap simply has no pixels, and what
 * shows through is `Globe.baseColor` — which Cesium defaults to
 * `Color(0, 0, 0.5)`, gamma-corrected by the globe shader to roughly `#0000ba`.
 * A saturated navy disc at each pole, on every Mercator basemap, reading as a
 * rendering fault rather than as the edge of the projection. It had been there
 * since the first basemap shipped; nothing ever set `baseColor`.
 *
 * Each cap is 0.19% of the globe's surface — small, and unmissable, because it
 * sits exactly where the eye goes when you spin the globe.
 *
 * ## Why a flat fill rather than real polar imagery
 *
 * OSM cannot be fixed at source: there are no tiles above the cut-off and there
 * is no polar OSM pyramid to point at. GIBS *does* publish an EPSG:4326
 * endpoint that covers the poles, but its `500m` tile matrix set steps
 * 2→3→5→10 tiles wide against Cesium's 2→4→8→16, so the two pyramids do not
 * line up at any level; the only Cesium-compatible route is GIBS' WMS, which
 * trades a CDN read for an on-demand render (measured 0.4–1.1 s per tile)
 * across the whole basemap to gain 0.4% of it.
 *
 * A flat fill costs nothing and is very close to exact, because the imagery at
 * these latitudes is close to flat. Measured against the live services:
 *
 * | | mean | per-channel sd |
 * |---|---|---|
 * | OSM at +85° (Arctic Ocean) | `#aad3df` | **0** |
 * | OSM at −85° (Antarctic ice) | `#f2efe9` | **0** |
 * | Blue Marble cap, +85–90° | `#0a1c40` | 8–22 |
 * | Blue Marble cap, −85–90° | `#eeeeee` | 18 |
 *
 * OSM's are literally uniform — it draws open water and ice sheet with no
 * features up there — so the fill is indistinguishable from the map continuing.
 *
 * ## The caps are not map data, and the layer guides say so
 *
 * This paints over an absence; it does not measure one. The north cap being
 * ocean-blue on OSM and near-black on relief is a fact about how each source
 * renders the Arctic, not about the Arctic. Both basemaps' guides carry the
 * limitation.
 *
 * ## Why per-pole, which rules out `Globe.baseColor` as the fix
 *
 * `baseColor` is one scene-wide value and the two poles are not one colour.
 * On relief they are `#0a1c40` and `#eeeeee` — opposite ends of the lightness
 * range — so any single choice puts a black disc in the Antarctic ice or a
 * white one in the Arctic Ocean. Two imagery layers, one per cap, is the
 * smallest thing that can be right at both ends.
 */

/** The colours a basemap's imagery reaches at the Mercator cut-off. */
export interface PolarCapColors {
  /** Fill for +85.05° to the north pole. */
  north: string;
  /** Fill for −85.05° to the south pole. */
  south: string;
}

/**
 * Per-basemap fills, sampled from the live services at the cut-off itself.
 *
 * `seafloor` is deliberately absent. GEBCO is served over WMS, which Cesium
 * tiles geographically rather than in Mercator, so that basemap already covers
 * ±90° — verified by rendering both caps directly (`#3e85b2` Arctic water,
 * `#ffffff` Antarctic ice, both real imagery rather than blank). Giving it a
 * fill would paint over map it actually has.
 */
export const POLAR_CAP_COLORS = {
  osm: { north: '#aad3df', south: '#f2efe9' },
  relief: { north: '#0a1c40', south: '#eeeeee' },
} as const satisfies Record<string, PolarCapColors>;

/**
 * Where Web Mercator stops, taken from Cesium rather than written down.
 *
 * The fill has to meet the imagery exactly, and the imagery's edge is wherever
 * Cesium's own tiling scheme puts it. A hard-coded 85.0511 would be a second
 * copy of that number, free to drift from the one that matters.
 */
export const MERCATOR_LIMIT_RADIANS = new Cesium.WebMercatorTilingScheme().rectangle.north;

/**
 * How far each cap reaches back *under* the basemap.
 *
 * The two edges are computed from the same constant, so in principle they meet.
 * In practice they are compared after a trip through tile bounds and texture
 * coordinates, and a half-pixel disagreement draws as a hairline ring around
 * the pole. The caps sit below the basemap in the imagery stack, so overlap is
 * free — the basemap covers it — while a gap is not.
 */
const OVERLAP_RADIANS = Cesium.Math.toRadians(0.05);

/**
 * Small rather than 1×1: a solid fill needs no detail, but a degenerate
 * texture is a needless thing to hand a driver. Four is a power of two, so
 * mipmapping stays on the ordinary path.
 */
const FILL_TEXTURE_SIZE = 4;

/** A solid colour as a data URL, since the provider takes a URL. */
function solidFillUrl(cssColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = FILL_TEXTURE_SIZE;
  canvas.height = FILL_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = cssColor;
    context.fillRect(0, 0, FILL_TEXTURE_SIZE, FILL_TEXTURE_SIZE);
  }
  return canvas.toDataURL('image/png');
}

/** The rectangle each cap covers, overlapping the basemap's last row. */
export function capRectangles(): { north: Cesium.Rectangle; south: Cesium.Rectangle } {
  const edge = MERCATOR_LIMIT_RADIANS - OVERLAP_RADIANS;
  return {
    north: new Cesium.Rectangle(-Math.PI, edge, Math.PI, Cesium.Math.PI_OVER_TWO),
    south: new Cesium.Rectangle(-Math.PI, -Cesium.Math.PI_OVER_TWO, Math.PI, -edge),
  };
}

export interface PolarCaps {
  setVisible(visible: boolean): void;
  detach(): void;
}

/**
 * Attaches both caps beneath everything already in the imagery stack.
 *
 * Call *after* the basemap has been lowered to the bottom: each cap is added
 * and then lowered in turn, so it ends up under the basemap, which is what
 * makes the overlap above harmless.
 *
 * Unlike the data rasters, this builds its provider synchronously — the image
 * is a data URL with nothing to fetch, and `SingleTileImageryProvider`'s
 * constructor loads lazily where `fromUrl` preloads. So there is no window in
 * which the cap is attached but empty, and no swap ordering to get wrong.
 */
export function attachPolarCaps(viewer: Cesium.Viewer, colors: PolarCapColors): PolarCaps {
  const rectangles = capRectangles();

  const layers = (
    [
      ['north', colors.north, rectangles.north],
      ['south', colors.south, rectangles.south],
    ] as const
  ).map(([, color, rectangle]) => {
    const provider = new Cesium.SingleTileImageryProvider({
      url: solidFillUrl(color),
      tileWidth: FILL_TEXTURE_SIZE,
      tileHeight: FILL_TEXTURE_SIZE,
      rectangle,
    });
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    viewer.imageryLayers.lowerToBottom(layer);
    return layer;
  });

  return {
    setVisible(visible) {
      for (const layer of layers) layer.show = visible;
    },
    detach() {
      // Same guard as every layer's `unmount`: a destroyed viewer has already
      // taken these with it, and touching it throws.
      if (viewer.isDestroyed()) return;
      for (const layer of layers) viewer.imageryLayers.remove(layer, true);
    },
  };
}
