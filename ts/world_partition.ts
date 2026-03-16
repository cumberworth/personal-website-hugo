// World Map Partitioning — Interactive Canvas
// TypeScript source; compiled to static/js/world_partition.js via tsc.

/** Canvas pixel coordinate. */
type Point = [number, number];

/** sRGB colour triple, each component 0–255. */
type Rgb = [number, number, number];

/** User-controllable generation parameters. */
interface Config {
  /** Number of edge-to-edge curves to draw. */
  numCurves: number;
  /** Number of closed blob loops to draw. */
  numLoops: number;
  /** Max angular drift per step, in degrees. Higher = more serpentine curves. */
  curvature: number;
  /** Maximum walk steps before a curve is forced to terminate. */
  maxSteps: number;
  /** Minimum acceptable region count; generation retries until met. */
  minRegions: number;
}

/** Singleton mutable application state. */
interface AppState {
  config: Config;
  worldData: GeoJSON.FeatureCollection | null;
  projection: d3.GeoProjection | null;
  geoPath: d3.GeoPath | null;
  /** 1 = land pixel, 0 = ocean pixel. Length W*H. */
  landMask: Uint8Array | null;
  /** Region id per pixel, or -1 for borders/ocean. Length W*H. */
  labels: Int32Array | null;
  numRegions: number;
  regionColors: ReadonlyArray<Rgb>;
  regionLabels: ReadonlyArray<string>;
  /** Logical canvas width in CSS pixels. */
  readonly W: number;
  /** Logical canvas height in CSS pixels. */
  readonly H: number;
  /** Device pixel ratio for HiDPI rendering. */
  readonly dpr: number;
  /** Offscreen canvas used for compositing before blitting to the visible canvas. */
  offscreen: HTMLCanvasElement | null;
  curves: Point[][];
  blobs: Point[][];
  /** Population-density weight per land pixel, or null when disabled. Length W*H. */
  popWeights: Float32Array | null;
  usePopDensity: boolean;
  /** When true, land pixels are coloured by population density instead of region colour. */
  showPopDensity: boolean;
  /** Canvas pixel position of the most recently sampled land point. */
  clickedDot: { x: number; y: number } | null;
}

/** Starting position and direction for a randomly generated curve. */
interface EdgeStart {
  startX: number;
  startY: number;
  /** Initial heading in radians. */
  angle: number;
}

/** Output of one partition attempt. */
interface GenerationResult {
  curves: Point[][];
  blobs: Point[][];
  labels: Int32Array;
  numRegions: number;
}

/** Output of the BFS region-detection pipeline. */
interface RegionDetectionResult {
  labels: Int32Array;
  numRegions: number;
  pixelCounts: number[];
}

/** Resolved address parts from a reverse-geocode lookup, ordered specific → general. */
interface GeocodeResult {
  parts: string[];
}

/** A randomly sampled land pixel together with its geographic coordinates. */
interface LandPoint {
  /** [longitude, latitude] in degrees. */
  lonlat: [number, number];
  x: number;
  y: number;
}

/** Descriptor for wiring a range slider to a Config key. */
interface SliderConfig {
  id: string;
  key: keyof Config;
  displayId: string;
}

const DEFAULT_CONFIG: Config = {
  numCurves: 4,
  numLoops: 2,
  curvature: 12,
  maxSteps: 600,
  minRegions: 2,
};

/** Deep atlas blue used for ocean pixels. */
const OCEAN_COLOR: Rgb = [90, 160, 210];

const state: AppState = {
  config: { ...DEFAULT_CONFIG },
  worldData: null,
  projection: null,
  geoPath: null,
  landMask: null,
  labels: null,
  numRegions: 0,
  regionColors: [],
  regionLabels: [],
  W: 900,
  H: 550,
  dpr: window.devicePixelRatio || 1,
  offscreen: null,
  curves: [],
  blobs: [],
  popWeights: null,
  usePopDensity: true,
  showPopDensity: false,
  clickedDot: null,
};

/**
 * Fetches the pre-projected population-density raster from static/data/pop_weights.bin.
 * Returns null if the file is unavailable, in which case sampling falls back to uniform weighting.
 */
async function fetchPopWeights(): Promise<Float32Array | null> {
  try {
    const resp = await fetch('/data/pop_weights.bin');
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();
    return new Float32Array(buffer);
  } catch {
    return null;
  }
}

/**
 * Warm vintage atlas palette — earthy yellows, sage greens, dusty pinks and powder blues
 * inspired by classic political maps.
 */
const MAP_PALETTE: ReadonlyArray<Rgb> = [
  [244, 213, 141],  // golden yellow
  [168, 210, 180],  // mint green
  [210, 160, 185],  // dusty pink
  [140, 185, 215],  // powder blue
  [220, 175, 130],  // warm peach
  [175, 205, 160],  // sage green
  [190, 155, 200],  // soft purple
  [215, 195, 155],  // warm beige
];

/**
 * Builds a region adjacency list by scanning up to MAX_BORDER pixels away in each
 * axis-aligned direction. The wider scan is necessary because partition lines are
 * several pixels thick, so no two regions share a direct 1-pixel boundary.
 */
function buildAdjacency(labels: Int32Array, W: number, H: number, numRegions: number): Set<number>[] {
  const adj: Set<number>[] = Array.from({ length: numRegions }, () => new Set<number>());
  const MAX_BORDER = 8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = labels[y * W + x] ?? -1;
      if (r < 0) continue;
      for (let d = 1; d <= MAX_BORDER; d++) {
        if (x + d < W) {
          const nr = labels[y * W + x + d] ?? -1;
          if (nr >= 0 && nr !== r) { adj[r]!.add(nr); adj[nr]!.add(r); }
        }
        if (y + d < H) {
          const nr = labels[(y + d) * W + x] ?? -1;
          if (nr >= 0 && nr !== r) { adj[r]!.add(nr); adj[nr]!.add(r); }
        }
      }
    }
  }
  return adj;
}

/** Assigns palette colours greedily so no two adjacent regions share the same colour. */
function greedyColorAssign(numRegions: number, adj: Set<number>[], palette: ReadonlyArray<Rgb>): Rgb[] {
  const assigned = new Int32Array(numRegions).fill(-1);
  for (let r = 0; r < numRegions; r++) {
    const used = new Set<number>();
    for (const n of adj[r]!) {
      if ((assigned[n] ?? -1) >= 0) used.add(assigned[n]!);
    }
    let c = 0;
    while (used.has(c)) c++;
    assigned[r] = c % palette.length;
  }
  return Array.from(assigned, c => palette[c >= 0 ? c : 0]!);
}

/** Fetches the world-atlas TopoJSON and converts it to a GeoJSON FeatureCollection. */
async function loadWorldData(): Promise<GeoJSON.FeatureCollection> {
  const url = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
  const resp = await fetch(url);
  const topo = await resp.json();
  return topojson.feature(topo, topo.objects.countries) as GeoJSON.FeatureCollection;
}

/**
 * Creates a Natural Earth projection fitted to the canvas with a small padding,
 * using the sphere outline rather than country extents so the globe sits centrally.
 */
function setupProjection(
  W: number,
  H: number,
): { proj: d3.GeoProjection; path: d3.GeoPath } {
  const pad = 4;
  const proj = d3.geoNaturalEarth1().fitExtent(
    [[pad, pad], [W - pad, H - pad]],
    { type: 'Sphere' },
  );
  const path = d3.geoPath(proj);
  return { proj, path };
}

/**
 * Renders all country polygons onto an offscreen canvas and reads back pixels
 * to build a binary land mask (1 = land, 0 = ocean).
 */
function buildLandMask(
  W: number,
  H: number,
  proj: d3.GeoProjection,
  countries: GeoJSON.FeatureCollection,
): Uint8Array {
  const offscreen = document.createElement('canvas');
  offscreen.width = W;
  offscreen.height = H;
  const ctx = offscreen.getContext('2d')!;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const path = d3.geoPath(proj, ctx);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  path(countries);
  ctx.fill();

  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    mask[i] = (data[i * 4] ?? 0) > 128 ? 1 : 0;
  }
  return mask;
}


/**
 * Applies a 1-D Gaussian blur to a polyline, preserving the original
 * first and last points so the curve still touches its start/end boundary.
 * @param sigma - Standard deviation in points.
 */
function gaussianSmooth(points: Point[], sigma = 3): Point[] {
  const n = points.length;
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= ksum;

  const result: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = Math.min(Math.max(i + k - radius, 0), n - 1);
      sx += (points[j]![0]) * kernel[k]!;
      sy += (points[j]![1]) * kernel[k]!;
    }
    result[i] = [sx, sy];
  }
  return result;
}

/**
 * Densifies a polyline using Catmull-Rom interpolation, inserting `factor`
 * sub-points per input segment for smooth, visually continuous curves.
 * @param factor - Number of interpolated points per segment.
 * @param closed - Whether to treat the polyline as a closed loop.
 */
function catmullRomDensify(points: Point[], factor = 8, closed = false): Point[] {
  const n = points.length;
  if (n < 2) return points;

  const result: Point[] = [];

  const getPoint = (i: number): Point => {
    if (closed) return points[((i % n) + n) % n]!;
    return points[Math.min(Math.max(i, 0), n - 1)]!;
  };

  const segments = closed ? n : n - 1;

  for (let i = 0; i < segments; i++) {
    const p0 = getPoint(i - 1);
    const p1 = getPoint(i);
    const p2 = getPoint(i + 1);
    const p3 = getPoint(i + 2);

    for (let j = 0; j < factor; j++) {
      const t = j / factor;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      result.push([x, y]);
    }
  }

  if (!closed) result.push(points[n - 1]!);
  return result;
}

/**
 * Picks a random point on one of the four canvas edges and an inward-facing
 * angle with up to ±60° of jitter from the perpendicular.
 */
function pickEdgeStart(W: number, H: number): EdgeStart {
  const edge = Math.floor(Math.random() * 4);
  const jitter = (Math.random() - 0.5) * 2 * 60; // ±60°
  let startX: number, startY: number, baseAngle: number;

  if (edge === 0) {
    startX = Math.random() * W; startY = 0; baseAngle = 90;
  } else if (edge === 1) {
    startX = Math.random() * W; startY = H; baseAngle = 270;
  } else if (edge === 2) {
    startX = 0; startY = Math.random() * H; baseAngle = 0;
  } else {
    startX = W; startY = Math.random() * H; baseAngle = 180;
  }

  return { startX, startY, angle: ((baseAngle + jitter) * Math.PI) / 180 };
}

/**
 * Walks a random angular-drift path from `start` until it either exits the
 * canvas bounds or comes within 1.5 step-lengths of an earlier point
 * (self-intersection termination).
 */
function walkPath(
  start: EdgeStart,
  W: number,
  H: number,
  curvature: number,
  maxSteps: number,
): Point[] {
  const stepSize = W / 120;
  let angle = start.angle;
  const coords: Point[] = [[start.startX, start.startY]];

  for (let step = 0; step < maxSteps; step++) {
    angle +=
      (((Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2) *
        (curvature * Math.PI)) /
      180;

    const [px, py] = coords[coords.length - 1]!;
    const nx = px + stepSize * Math.cos(angle);
    const ny = py + stepSize * Math.sin(angle);

    if (nx < 0 || nx > W || ny < 0 || ny > H) {
      coords.push([Math.min(Math.max(nx, 0), W), Math.min(Math.max(ny, 0), H)]);
      break;
    }

    // self-intersection check
    let selfHit = false;
    if (coords.length > 10) {
      for (let k = 0; k < coords.length - 5; k++) {
        const dx = nx - coords[k]![0];
        const dy = ny - coords[k]![1];
        if (dx * dx + dy * dy < (stepSize * 1.5) ** 2) {
          coords.push([coords[k]![0], coords[k]![1]]);
          selfHit = true;
          break;
        }
      }
    }
    if (selfHit) break;

    coords.push([nx, ny]);
  }

  return coords;
}

/**
 * Generates a single partition curve: picks an edge start, walks a random
 * path, then smooths and densifies the result.
 * @returns The densified polyline, or null if the walk was too short.
 */
function generateCurve(W: number, H: number, curvature: number, maxSteps: number): Point[] | null {
  const start = pickEdgeStart(W, H);
  const rawStart: Point = [start.startX, start.startY];
  const coords = walkPath(start, W, H, curvature, maxSteps);

  if (coords.length < 4) return null;

  const rawEnd = coords[coords.length - 1]!;

  const smoothed = gaussianSmooth(coords, 3);
  smoothed[0] = rawStart;
  smoothed[smoothed.length - 1] = rawEnd;

  const dense = catmullRomDensify(smoothed, 8, false);
  for (const p of dense) {
    p[0] = Math.min(Math.max(p[0], 0), W);
    p[1] = Math.min(Math.max(p[1], 0), H);
  }
  dense[0] = rawStart;
  dense[dense.length - 1] = rawEnd;

  return dense;
}

/**
 * Generates a closed blob shape centred in the middle half of the canvas.
 * Control points are perturbed ellipse samples; the result is rejected if
 * any point is too close to the canvas edge.
 * @returns A closed densified polyline, or null if the blob was rejected.
 */
function generateBlob(W: number, H: number): Point[] | null {
  const margin = 20;
  const minX = W * 0.25;
  const maxX = W * 0.75;
  const minY = H * 0.25;
  const maxY = H * 0.75;

  const cx = minX + Math.random() * (maxX - minX);
  const cy = minY + Math.random() * (maxY - minY);

  const N = 10;
  const baseRx = W * (0.05 + Math.random() * 0.12);
  const baseRy = H * (0.05 + Math.random() * 0.1);
  const rotAngle = Math.random() * Math.PI * 2;

  const control: Point[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * 2 * Math.PI;
    const perturbR = 0.7 + Math.random() * 0.6;
    const rx = baseRx * perturbR;
    const ry = baseRy * perturbR;
    control.push([cx + rx * Math.cos(theta + rotAngle), cy + ry * Math.sin(theta + rotAngle)]);
  }

  for (const [px, py] of control) {
    if (px < margin || px > W - margin || py < margin || py > H - margin) return null;
  }

  const dense = catmullRomDensify(control, 10, true);
  if (dense.length < 3) return null;

  dense.push(dense[0]!); // close the loop
  return dense;
}

/**
 * Renders curves and blobs onto an offscreen canvas for BFS hit-testing.
 * The sphere boundary is also stroked and used as a compositing mask so that
 * the flood fill is naturally contained within the globe outline.
 */
function buildRegionHitCanvas(
  W: number,
  H: number,
  projection: d3.GeoProjection,
  curves: Point[][],
  blobs: Point[][],
): HTMLCanvasElement {
  const hitCanvas = document.createElement('canvas');
  hitCanvas.width = W;
  hitCanvas.height = H;
  const ctx = hitCanvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const pathRenderer = d3.geoPath(projection, ctx);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.stroke();

  // black out pixels outside the sphere so flood fill stays inside
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const curve of curves) {
    if (!curve || curve.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(curve[0]![0], curve[0]![1]);
    for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i]![0], curve[i]![1]);
    ctx.stroke();
  }

  for (const blob of blobs) {
    if (!blob || blob.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(blob[0]![0], blob[0]![1]);
    for (let i = 1; i < blob.length; i++) ctx.lineTo(blob[i]![0], blob[i]![1]);
    ctx.closePath();
    ctx.stroke();
  }

  return hitCanvas;
}

/**
 * BFS flood fill over a pixel buffer.
 * Pixels whose red channel is below 128 are treated as borders and skipped.
 * @returns Per-pixel region labels (-1 = border) and per-region pixel counts.
 */
function bfsFloodFill(
  W: number,
  H: number,
  pixels: Uint8ClampedArray,
): { labels: Int32Array; pixelCounts: number[] } {
  const isBorder = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    isBorder[i] = (pixels[i * 4] ?? 255) < 128 ? 1 : 0;
  }

  const labels = new Int32Array(W * H).fill(-1);
  let numRegions = 0;
  const pixelCounts: number[] = [];
  const queue: number[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (isBorder[idx] || (labels[idx] ?? -1) >= 0) continue;

      const regionId = numRegions++;
      pixelCounts.push(0);
      queue.length = 0;
      queue.push(idx);
      labels[idx] = regionId;

      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++]!;
        pixelCounts[regionId]!++;
        const cx = cur % W;
        const cy = (cur / W) | 0;

        const neighbors = [
          cy > 0 ? cur - W : -1,
          cy < H - 1 ? cur + W : -1,
          cx > 0 ? cur - 1 : -1,
          cx < W - 1 ? cur + 1 : -1,
        ];

        for (const n of neighbors) {
          if (n < 0 || isBorder[n] || (labels[n] ?? -1) >= 0) continue;
          labels[n] = regionId;
          queue.push(n);
        }
      }
    }
  }

  return { labels, pixelCounts };
}

/**
 * Removes regions smaller than 500 pixels (slivers from near-parallel curves)
 * and remaps the remaining region IDs to a contiguous 0-based sequence.
 */
function filterAndRemapRegions(
  labels: Int32Array,
  pixelCounts: number[],
  W: number,
  H: number,
): RegionDetectionResult {
  const numRegions = pixelCounts.length;
  const MIN_PIXELS = 500;
  const validRegions = new Set<number>();
  for (let r = 0; r < numRegions; r++) {
    if ((pixelCounts[r] ?? 0) >= MIN_PIXELS) validRegions.add(r);
  }

  const remap = new Int32Array(numRegions).fill(-1);
  let newId = 0;
  for (let r = 0; r < numRegions; r++) {
    if (validRegions.has(r)) remap[r] = newId++;
  }

  for (let i = 0; i < W * H; i++) {
    if ((labels[i] ?? -1) >= 0) labels[i] = remap[labels[i]!]!;
  }

  const finalCounts = new Array<number>(newId).fill(0);
  for (let i = 0; i < W * H; i++) {
    if ((labels[i] ?? -1) >= 0) finalCounts[labels[i]!]!++;
  }

  return { labels, numRegions: newId, pixelCounts: finalCounts };
}

/**
 * Detects connected regions by rendering the partition geometry onto a
 * hit-test canvas and running a BFS flood fill over the result.
 */
function detectRegions(
  W: number,
  H: number,
  projection: d3.GeoProjection,
  curves: Point[][],
  blobs: Point[][],
): RegionDetectionResult {
  const hitCanvas = buildRegionHitCanvas(W, H, projection, curves, blobs);
  const ctx = hitCanvas.getContext('2d')!;
  const pixels = ctx.getImageData(0, 0, W, H).data;
  const { labels, pixelCounts } = bfsFloodFill(W, H, pixels);
  return filterAndRemapRegions(labels, pixelCounts, W, H);
}

/** Computes the pixel centroid of each region by averaging the coordinates of all its pixels. */
function computeCentroids(labels: Int32Array, W: number, H: number, numRegions: number): Point[] {
  const sumX = new Float64Array(numRegions);
  const sumY = new Float64Array(numRegions);
  const count = new Int32Array(numRegions);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = labels[y * W + x] ?? -1;
      if (r < 0) continue;
      sumX[r]! += x;
      sumY[r]! += y;
      count[r]!++;
    }
  }

  const centroids: Point[] = [];
  for (let r = 0; r < numRegions; r++) {
    if ((count[r] ?? 0) > 0) {
      centroids.push([sumX[r]! / count[r]!, sumY[r]! / count[r]!]);
    } else {
      centroids.push([0, 0]);
    }
  }
  return centroids;
}

/**
 * Assigns letter labels (A–Z, then numeric) to regions sorted top-to-bottom,
 * left-to-right by centroid position.
 */
function assignLabels(centroids: Point[]): string[] {
  const indexed = centroids.map((c, i) => ({ i, c }));
  indexed.sort((a, b) => a.c[1] - b.c[1] || a.c[0] - b.c[0]);
  const labels: string[] = new Array(centroids.length);
  indexed.forEach(({ i }, rank) => {
    labels[i] = rank < 26 ? String.fromCharCode(65 + rank) : String(rank + 1);
  });
  return labels;
}

/**
 * Samples a random land pixel within the given region, weighted by population
 * density when `popWeights` is provided, and returns its canvas position
 * and the corresponding geographic coordinates.
 * @returns A land point, or null if the region contains no land pixels.
 */
function sampleLandPoint(
  regionId: number,
  labels: Int32Array,
  landMask: Uint8Array,
  popWeights: Float32Array | null,
  W: number,
  H: number,
  proj: d3.GeoProjection,
): LandPoint | null {
  let totalWeight = 0;
  const candidates: number[] = []; // interleaved [idx, weight, ...]
  for (let i = 0; i < W * H; i++) {
    if (labels[i] !== regionId || landMask[i] !== 1) continue;
    if (popWeights) {
      const w = popWeights[i] ?? 0;
      if (w <= 0) continue; // skip unpopulated pixels; fall back to uniform below if needed
      candidates.push(i, w);
      totalWeight += w;
    } else {
      candidates.push(i, 1);
      totalWeight += 1;
    }
  }
  // If the raster has no population for this region (e.g. uninhabited island), sample uniformly.
  if (candidates.length === 0 && popWeights) {
    for (let i = 0; i < W * H; i++) {
      if (labels[i] !== regionId || landMask[i] !== 1) continue;
      candidates.push(i, 1);
      totalWeight += 1;
    }
  }
  if (candidates.length === 0) return null;

  let r = Math.random() * totalWeight;
  let chosen = candidates[candidates.length - 2]!; // last idx as fallback
  for (let k = 0; k < candidates.length; k += 2) {
    r -= candidates[k + 1]!;
    if (r <= 0) {
      chosen = candidates[k]!;
      break;
    }
  }

  const x = (chosen % W) + Math.random() - 0.5;
  const y = ((chosen / W) | 0) + Math.random() - 0.5;
  const lonlat = proj.invert!([x, y]) as [number, number];
  return { lonlat, x, y };
}

/**
 * Creates an ImageData with ocean colour for every pixel, overwriting land
 * pixels with their assigned region colour.
 */
function buildRegionImageData(
  W: number,
  H: number,
  labels: Int32Array,
  landMask: Uint8Array,
  regionColors: ReadonlyArray<Rgb>,
  ctx: CanvasRenderingContext2D,
): ImageData {
  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;
  const [or, og, ob] = OCEAN_COLOR;

  for (let i = 0; i < W * H; i++) {
    const r = labels[i] ?? -1;
    if (r >= 0 && landMask[i] === 1) {
      const col = regionColors[r]!;
      data[i * 4] = col[0];
      data[i * 4 + 1] = col[1];
      data[i * 4 + 2] = col[2];
    } else {
      data[i * 4] = or;
      data[i * 4 + 1] = og;
      data[i * 4 + 2] = ob;
    }
    data[i * 4 + 3] = 255;
  }
  return imgData;
}

/**
 * Maps a population density value to an RGB colour using a log scale.
 * 0 (uninhabited) → muted grey-green; ~10 000+ → deep red.
 */
function popDensityColor(density: number): Rgb {
  if (density <= 0) return [160, 180, 155]; // uninhabited land
  const t = Math.min(Math.log10(density) / Math.log10(10000), 1);
  // Interpolate: light yellow [255, 252, 210] → deep red [160, 20, 20]
  return [
    Math.round(255 + t * (160 - 255)),
    Math.round(252 + t * (20 - 252)),
    Math.round(210 + t * (20 - 210)),
  ];
}

/**
 * Creates an ImageData with each land pixel coloured by its population density
 * from the pre-baked raster, using a log colour scale.
 */
function buildPopDensityImageData(
  W: number,
  H: number,
  landMask: Uint8Array,
  popWeights: Float32Array,
  ctx: CanvasRenderingContext2D,
): ImageData {
  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;
  const [or, og, ob] = OCEAN_COLOR;

  for (let i = 0; i < W * H; i++) {
    if (landMask[i] === 1) {
      const col = popDensityColor(popWeights[i] ?? 0);
      data[i * 4] = col[0];
      data[i * 4 + 1] = col[1];
      data[i * 4 + 2] = col[2];
    } else {
      data[i * 4] = or;
      data[i * 4 + 1] = og;
      data[i * 4 + 2] = ob;
    }
    data[i * 4 + 3] = 255;
  }
  return imgData;
}

/**
 * Uses destination-in compositing to clip the current canvas contents to the
 * Natural Earth sphere outline, discarding pixels outside the globe.
 */
function clipToSphere(ctx: CanvasRenderingContext2D, pathRenderer: d3.GeoPath): void {
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** Strokes country border lines in a muted dark colour. */
function renderCountryBorders(
  ctx: CanvasRenderingContext2D,
  worldData: GeoJSON.FeatureCollection,
  pathRenderer: d3.GeoPath,
  scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#4a4a3a';
  ctx.lineWidth = 1 / scale; // 1 physical offscreen pixel = 0.5 display pixel
  ctx.beginPath();
  pathRenderer(worldData);
  ctx.stroke();
  ctx.restore();
}

/** Strokes all partition curves and blob outlines. */
function renderPartitionGeometry(
  ctx: CanvasRenderingContext2D,
  curves: Point[][],
  blobs: Point[][],
  scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#1a2a3a';
  ctx.lineWidth = 4 / scale; // 2 display pixels
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const curve of curves) {
    if (!curve || curve.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(curve[0]![0], curve[0]![1]);
    for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i]![0], curve[i]![1]);
    ctx.stroke();
  }

  for (const blob of blobs) {
    if (!blob || blob.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(blob[0]![0], blob[0]![1]);
    for (let i = 1; i < blob.length; i++) ctx.lineTo(blob[i]![0], blob[i]![1]);
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draws a letter label at the centroid of each region, with a semi-transparent
 * white backing rectangle for legibility.
 */
function renderRegionLabels(
  ctx: CanvasRenderingContext2D,
  labels: Int32Array,
  W: number,
  H: number,
  numRegions: number,
  regionLabels: ReadonlyArray<string>,
): void {
  const centroids = computeCentroids(labels, W, H, numRegions);
  ctx.save();
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let r = 0; r < numRegions; r++) {
    const lbl = regionLabels[r] ?? '';
    const [cx, cy] = centroids[r]!;
    const metrics = ctx.measureText(lbl);
    const pad = 4;
    const bw = metrics.width + pad * 2;
    const bh = 20;

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.fillStyle = '#2c3e50';
    ctx.fillText(lbl, cx, cy);
  }

  ctx.restore();
}

/** Draws a small black dot with a white halo at the given canvas position. */
function renderClickedDot(ctx: CanvasRenderingContext2D, dot: { x: number; y: number }, scale: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / scale; // 1 display pixel
  ctx.stroke();
  ctx.restore();
}

/** Strokes the Natural Earth sphere outline on top of all other layers. */
function renderSphereOutline(ctx: CanvasRenderingContext2D, pathRenderer: d3.GeoPath, scale: number): void {
  ctx.save();
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.strokeStyle = '#2a4a6a';
  ctx.lineWidth = 2 / scale; // 1 display pixel
  ctx.stroke();
  ctx.restore();
}

/**
 * Main render function. Composites all visual layers onto an offscreen canvas
 * at at least 2× the logical size so CSS downscaling gives crisp lines even on
 * 1× displays, then blits to the visible canvas.
 */
function render(): void {
  const {
    W, H, dpr, labels, numRegions, regionColors, regionLabels,
    landMask, projection, curves, blobs, worldData,
  } = state;

  const canvas = document.getElementById('worldMap') as HTMLCanvasElement | null;
  if (!canvas || !labels || !landMask || !projection || !worldData) return;

  // Use at least 2× so vector layers are always drawn with supersampling headroom.
  const scale = Math.max(dpr, 2);

  if (!state.offscreen) {
    state.offscreen = document.createElement('canvas');
  }
  if (state.offscreen.width !== W * scale || state.offscreen.height !== H * scale) {
    state.offscreen.width = W * scale;
    state.offscreen.height = H * scale;
  }
  const oc = state.offscreen;
  const ctx = oc.getContext('2d')!;
  ctx.save();
  ctx.scale(scale, scale); // all subsequent drawing uses logical coordinates
  const pathRenderer = d3.geoPath(projection, ctx);

  // 1. Build pixel data at logical resolution on a scratch canvas, then scale up.
  // (putImageData ignores the transform, so we must go via drawImage.)
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const scratchCtx = scratch.getContext('2d')!;
  const imgData = state.showPopDensity && state.popWeights
    ? buildPopDensityImageData(W, H, landMask, state.popWeights, scratchCtx)
    : buildRegionImageData(W, H, labels, landMask, regionColors, scratchCtx);
  scratchCtx.putImageData(imgData, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(scratch, 0, 0);

  // 2. Clip to NE sphere outline
  clipToSphere(ctx, pathRenderer);

  // 3–6. Vector layers, clipped to sphere
  ctx.save();
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.clip();

  renderCountryBorders(ctx, worldData, pathRenderer, scale);
  renderPartitionGeometry(ctx, curves, blobs, scale);
  renderRegionLabels(ctx, labels, W, H, numRegions, regionLabels);

  if (state.clickedDot) {
    renderClickedDot(ctx, state.clickedDot, scale);
  }

  ctx.restore(); // remove sphere clip

  // 7. Sphere outline on top, unclipped
  renderSphereOutline(ctx, pathRenderer, scale);

  ctx.restore(); // remove dpr scale

  // 8. Scale-blit offscreen → visible canvas with high-quality downsampling
  const mainCtx = canvas.getContext('2d')!;
  mainCtx.imageSmoothingEnabled = true;
  mainCtx.imageSmoothingQuality = 'high';
  mainCtx.clearRect(0, 0, canvas.width, canvas.height);
  mainCtx.drawImage(oc, 0, 0, canvas.width, canvas.height);
}

/**
 * Returns true if segment p1→p2 and segment p3→p4 properly intersect
 * (i.e. they cross at interior points, not at shared endpoints).
 */
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;

  const dx = p3[0] - p1[0], dy = p3[1] - p1[1];
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** Returns true if any segment of polyline `a` intersects any segment of polyline `b`. */
function polylinesIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
    }
  }
  return false;
}

/**
 * Performs a single partition attempt: generates blobs and curves (rejecting
 * any that cross existing geometry), then runs region detection.
 */
function attemptPartition(
  W: number,
  H: number,
  config: Config,
  projection: d3.GeoProjection,
): GenerationResult {
  const blobs: Point[][] = [];
  for (let i = 0; i < config.numLoops; i++) {
    for (let tries = 0; tries < 8; tries++) {
      const b = generateBlob(W, H);
      if (!b) continue;
      if (blobs.some((existing) => polylinesIntersect(b, existing))) continue;
      blobs.push(b);
      break;
    }
  }

  const curves: Point[][] = [];
  for (let i = 0; i < config.numCurves; i++) {
    for (let tries = 0; tries < 8; tries++) {
      const c = generateCurve(W, H, config.curvature, config.maxSteps);
      if (!c) continue;
      if (blobs.some((b) => polylinesIntersect(c, b))) continue;
      curves.push(c);
      break;
    }
  }

  const { labels, numRegions } = detectRegions(W, H, projection, curves, blobs);
  return { curves, blobs, labels, numRegions };
}

/**
 * Runs up to 10 partition attempts, keeping the best result (most regions).
 * Stops early once `config.minRegions` is reached. Updates global state and
 * triggers a render when done.
 */
async function generate(): Promise<void> {
  const btn = document.getElementById('generateBtn') as HTMLButtonElement | null;
  const status = document.getElementById('statusMsg');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Generating...';
  state.clickedDot = null;

  await new Promise<void>((r) => setTimeout(r, 10));

  const { W, H, config, projection } = state;
  if (!projection) return;

  let bestResult: GenerationResult | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const result = attemptPartition(W, H, config, projection);

    if (result.numRegions >= config.minRegions) {
      bestResult = result;
      break;
    }
    if (!bestResult || result.numRegions > bestResult.numRegions) {
      bestResult = result;
    }
  }

  const { curves, blobs, labels, numRegions } = bestResult!;
  const adj = buildAdjacency(labels, W, H, numRegions);
  const regionColors = greedyColorAssign(numRegions, adj, MAP_PALETTE);
  const centroids = computeCentroids(labels, W, H, numRegions);
  const regionLabels = assignLabels(centroids);

  state.curves = curves;
  state.blobs = blobs;
  state.labels = labels;
  state.numRegions = numRegions;
  state.regionColors = regionColors;
  state.regionLabels = regionLabels;

  render();

  if (status) status.textContent = `${numRegions} regions`;
  if (btn) btn.disabled = false;
}

/** Wires up the three range sliders to their corresponding {@link Config} keys. */
function setupSliders(): void {
  const sliders: SliderConfig[] = [
    { id: 'numCurves', key: 'numCurves', displayId: 'numCurvesVal' },
    { id: 'numLoops', key: 'numLoops', displayId: 'numLoopsVal' },
    { id: 'curvature', key: 'curvature', displayId: 'curvatureVal' },
  ];

  for (const { id, key, displayId } of sliders) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    const display = document.getElementById(displayId);
    if (!slider) continue;
    slider.value = String(state.config[key]);
    if (display) display.textContent = String(state.config[key]);
    slider.addEventListener('input', () => {
      state.config[key] = parseInt(slider.value, 10);
      if (display) display.textContent = slider.value;
    });
  }
}

/** Wires up the population-density checkbox to {@link AppState.usePopDensity}. */
function setupDensityCheckbox(): void {
  const densityCheck = document.getElementById('usePopDensity') as HTMLInputElement | null;
  if (densityCheck) {
    densityCheck.addEventListener('change', () => {
      state.usePopDensity = densityCheck.checked;
    });
  }
}

/** Wires up the show-population-density checkbox to {@link AppState.showPopDensity}. */
function setupShowPopDensityCheckbox(): void {
  const check = document.getElementById('showPopDensity') as HTMLInputElement | null;
  if (check) {
    check.addEventListener('change', () => {
      state.showPopDensity = check.checked;
      render();
    });
  }
}

/**
 * Attaches a click handler to the canvas. On click, maps the CSS pixel
 * position back to a logical canvas coordinate, samples a weighted land
 * point in the clicked region, and fires a reverse-geocode request.
 */
function setupCanvasClickHandler(canvas: HTMLCanvasElement): void {
  const coordDisplay = document.getElementById('coordDisplay');

  canvas.addEventListener('click', async (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = state.W / rect.width;
    const scaleY = state.H / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x < 0 || x >= state.W || y < 0 || y >= state.H) return;
    if (!state.labels || !state.projection) return;

    const regionId = state.labels[y * state.W + x] ?? -1;
    if (regionId < 0) {
      if (coordDisplay) coordDisplay.textContent = 'Click a land region...';
      return;
    }

    const lbl = state.regionLabels[regionId] ?? '';
    const weights = state.usePopDensity ? state.popWeights : null;
    const result = sampleLandPoint(
      regionId,
      state.labels,
      state.landMask!,
      weights,
      state.W,
      state.H,
      state.projection,
    );

    if (!result) {
      state.clickedDot = null;
      if (coordDisplay) coordDisplay.textContent = `Region ${lbl}: No land in this region`;
      render();
      return;
    }

    const { lonlat, x: dotX, y: dotY } = result;
    const [lon, lat] = lonlat;

    state.clickedDot = { x: dotX, y: dotY };
    render();
    if (coordDisplay) coordDisplay.textContent = 'Looking up location…';

    const geo = await reverseGeocode(lat, lon);
    if (coordDisplay) {
      coordDisplay.textContent = geo
        ? `You were born in ${geo.parts.join(', ')}`
        : `You were born somewhere in region ${lbl}`;
    }
  });
}

/** Wires up all interactive controls: sliders, density checkbox, generate button, and canvas click. */
function setupUI(): void {
  const canvas = document.getElementById('worldMap') as HTMLCanvasElement | null;

  setupSliders();
  setupDensityCheckbox();
  setupShowPopDensityCheckbox();

  const btn = document.getElementById('generateBtn');
  if (btn) btn.addEventListener('click', generate);

  if (canvas) setupCanvasClickHandler(canvas);
}

/**
 * Reverse-geocodes a lat/lon coordinate via the Nominatim API.
 * @returns A place name and country, or null if the lookup fails or returns no address.
 */
async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const addr = (data.address ?? {}) as Record<string, string>;
  const keys = ['road', 'hamlet', 'village', 'town', 'suburb', 'city_district', 'city', 'county', 'state', 'postcode', 'country'];
  const parts = keys
    .map(k => addr[k])
    .filter((v): v is string => !!v)
    .filter((v, i, a) => a.indexOf(v) === i); // deduplicate adjacent-level repeats
  return parts.length > 0 ? { parts } : null;
}

/**
 * Entry point. Loads world data, sets up the projection and masks,
 * wires up the UI, and runs the first generation.
 */
async function init(): Promise<void> {
  const status = document.getElementById('statusMsg');
  if (status) status.textContent = 'Loading world data...';

  try {
    const canvas = document.getElementById('worldMap') as HTMLCanvasElement;
    const { W, H, dpr } = state;
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const worldData = await loadWorldData();
    state.worldData = worldData;

    const { proj } = setupProjection(W, H);
    state.projection = proj;
    state.geoPath = d3.geoPath(proj);

    state.landMask = buildLandMask(W, H, proj, worldData);
    state.popWeights = await fetchPopWeights();

    setupUI();
    await generate();
  } catch (err) {
    console.error('Init failed:', err);
    if (status) status.textContent = 'Error loading data. Check console.';
  }
}

document.addEventListener('DOMContentLoaded', init);
