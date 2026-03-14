// World Map Partitioning — Interactive Canvas
// Port of world_partition.py to browser JS

const DEFAULT_CONFIG = {
  numCurves: 4,
  numLoops: 2,
  curvature: 12,
  maxSteps: 600,
  minRegions: 2,
};

// Set2-inspired pastel palette (8 colors)
// Classic atlas ocean: muted mid-blue
const OCEAN_COLOR = [115, 165, 200];

// Generate N perceptually-spread map colours using golden-ratio hue steps.
// Saturation and lightness are tuned for a classic cartographic look.
function generateMapColors(n) {
  const colors = [];
  const goldenAngle = 137.508;
  // Start hue offset chosen so the first few colours read as warm earth tones
  const startHue = 42;
  for (let i = 0; i < n; i++) {
    const h = (startHue + i * goldenAngle) % 360;
    // Alternate slightly between two lightness levels to add variety
    const l = i % 2 === 0 ? 72 : 78;
    const s = 38;
    colors.push(hslToRgb(h, s, l));
  }
  return colors;
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255);
  return [f(0), f(8), f(4)];
}

// ── app state ────────────────────────────────────────────────────────────────

const state = {
  config: { ...DEFAULT_CONFIG },
  worldData: null,
  projection: null,
  geoPath: null,
  landMask: null,   // Uint8Array  (1 = land, 0 = ocean)
  labels: null,     // Int32Array  (region id per pixel, -1 = border)
  numRegions: 0,
  regionColors: null,  // array of [r,g,b] per region
  regionLabels: null,  // array of string labels per region
  W: 900,
  H: 550,
  dpr: window.devicePixelRatio || 1,
  offscreen: null,     // offscreen canvas for compositing at logical resolution
  curves: [],
  blobs: [],
  countryWeights: null, // Float32Array — population density per pixel
  usePopDensity: true,
  clickedDot: null,    // {x, y} canvas pixel of last sampled land point
};

// ── population density (people / km²) keyed by ISO 3166-1 numeric ────────────
// Source: World Bank 2020 estimates, rounded to nearest integer.
// Countries not listed fall back to a regional default of 50.
const POP_DENSITY = {
    4:  55,   8: 105,  12:  18,  24:  25,  32:  16,  36:   3,  40: 107,
   50:1101,  56: 380,  64:  20,  68:  10,  76:  25, 100:  65, 104:  80,
  116:  90, 120:  50, 124:   4, 140:   7, 144: 335, 152:  24, 156: 148,
  170:  43, 180:  38, 188:  97, 191: 116, 192: 111, 203: 137, 204:  97,
  208: 135, 214: 223, 218:  68, 222: 305, 231: 113, 232:  50, 233:  28,
  246:  18, 250: 120, 266:   8, 276: 233, 288: 130, 300:  83, 320: 160,
  332: 400, 340:  87, 344: 6800,348: 108, 356: 450, 360: 145, 364:  49,
  368:  88, 372:  70, 376: 400, 380: 200, 388: 270, 392: 347, 398:   7,
  400: 110, 404:  90, 408: 213, 410: 527, 418:  30, 422: 667, 426:  68,
  430:  50, 434:   4, 440:  45, 442: 242, 450:  46, 454:  46, 458:  99,
  466:  15, 484:  64, 496:   2, 504:  82, 508:  38, 516:   3, 524: 200,
  528: 507, 540:  15, 562:  18, 566: 220, 578:  14, 586: 287, 591:  55,
  598:  18, 600:  17, 604:  25, 608: 360, 616: 124, 620: 112, 630: 393,
  634: 248, 642:  84, 643:   9, 646: 500, 682:  16, 686:  82, 694: 100,
  703: 113, 706:  25, 710:  47, 716:  38, 724:  94, 729:  24, 736:  24,
  752:  24, 756: 214, 760: 100, 764: 135, 768: 130, 780: 275, 788:  74,
  792: 105, 800: 230, 804:  77, 818: 100, 826: 275, 834:  65, 840:  35,
  858:  20, 860:  75, 862:  35, 704: 310, 887:  55, 894:  22,
};

// Build a Float32Array(W*H) of population-density weights per land pixel.
// Each country is drawn in a unique colour so we can read back which country
// owns each pixel, then look up its density in POP_DENSITY.
function buildCountryWeights(W, H, proj, countries) {
  const oc = document.createElement('canvas');
  oc.width = W;
  oc.height = H;
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);  // transparent = no country

  const path = d3.geoPath(proj, ctx);
  const features = countries.features;

  // Encode feature index i as colour (i%256, i>>8, 0) — supports up to 65535 features.
  for (let i = 0; i < features.length; i++) {
    ctx.fillStyle = `rgb(${i & 0xFF},${(i >> 8) & 0xFF},0)`;
    ctx.beginPath();
    path(features[i]);
    ctx.fill();
  }

  const raw = ctx.getImageData(0, 0, W, H).data;
  const weights = new Float32Array(W * H);

  for (let i = 0; i < W * H; i++) {
    if (raw[i * 4 + 3] < 128) continue;          // transparent → ocean
    const fi = raw[i * 4] + raw[i * 4 + 1] * 256; // decode feature index
    if (fi >= features.length) continue;
    const isoId = Number(features[fi].id);
    weights[i] = POP_DENSITY[isoId] ?? 50;         // default 50 if unknown
  }

  // Heal anti-aliased border pixels: propagate valid weights into zero-weight rendered pixels.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < W * H; i++) {
      if (weights[i] > 0) continue;
      if (raw[i * 4 + 3] < 64) continue; // truly transparent (ocean) — skip
      const x = i % W, y = (i / W) | 0;
      const n = (x > 0 && weights[i - 1] > 0)   ? weights[i - 1]
              : (x < W-1 && weights[i + 1] > 0) ? weights[i + 1]
              : (y > 0 && weights[i - W] > 0)   ? weights[i - W]
              : (y < H-1 && weights[i + W] > 0) ? weights[i + W]
              : 0;
      if (n > 0) { weights[i] = n; changed = true; }
    }
    if (!changed) break;
  }

  return weights;
}

// ── data loading ─────────────────────────────────────────────────────────────

async function loadWorldData() {
  const url = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
  const resp = await fetch(url);
  const topo = await resp.json();
  return topojson.feature(topo, topo.objects.countries);
}

// ── projection ───────────────────────────────────────────────────────────────

function setupProjection(W, H, geoData) {
  // Fit to the sphere outline (not just the country extents) so the full
  // projection boundary sits comfortably inside the canvas.
  const pad = 4;
  const proj = d3.geoNaturalEarth1().fitExtent([[pad, pad], [W - pad, H - pad]], { type: 'Sphere' });
  const path = d3.geoPath(proj);
  return { proj, path };
}

// ── land mask ────────────────────────────────────────────────────────────────

function buildLandMask(W, H, proj, countries) {
  const offscreen = document.createElement('canvas');
  offscreen.width = W;
  offscreen.height = H;
  const ctx = offscreen.getContext('2d');

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
    mask[i] = data[i * 4] > 128 ? 1 : 0;
  }
  return mask;
}

// ── gaussian smooth ──────────────────────────────────────────────────────────

function gaussianSmooth(points, sigma = 3) {
  const n = points.length;
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = Math.min(Math.max(i + k - radius, 0), n - 1);
      sx += points[j][0] * kernel[k];
      sy += points[j][1] * kernel[k];
    }
    result[i] = [sx, sy];
  }
  return result;
}

// ── catmull-rom densify ──────────────────────────────────────────────────────

function catmullRomDensify(points, factor = 8, closed = false) {
  const n = points.length;
  if (n < 2) return points;

  const result = [];

  const getPoint = (i) => {
    if (closed) return points[((i % n) + n) % n];
    return points[Math.min(Math.max(i, 0), n - 1)];
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

  if (!closed) result.push(points[n - 1]);
  return result;
}

// ── curve generation ─────────────────────────────────────────────────────────

function generateCurve(W, H, curvature, maxSteps) {
  const stepSize = W / 120;

  // pick random boundary point + inward angle
  const edge = Math.floor(Math.random() * 4);
  const jitter = ((Math.random() - 0.5) * 2) * 60; // ±60°
  let startX, startY, baseAngle;

  if (edge === 0) { // top
    startX = Math.random() * W;
    startY = 0;
    baseAngle = 90;
  } else if (edge === 1) { // bottom
    startX = Math.random() * W;
    startY = H;
    baseAngle = 270;
  } else if (edge === 2) { // left
    startX = 0;
    startY = Math.random() * H;
    baseAngle = 0;
  } else { // right
    startX = W;
    startY = Math.random() * H;
    baseAngle = 180;
  }

  let angle = ((baseAngle + jitter) * Math.PI) / 180;
  const coords = [[startX, startY]];

  for (let step = 0; step < maxSteps; step++) {
    // drift angle by gaussian sample
    angle += ((Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2)
      * (curvature * Math.PI) / 180;

    const [px, py] = coords[coords.length - 1];
    const nx = px + stepSize * Math.cos(angle);
    const ny = py + stepSize * Math.sin(angle);

    // hit boundary?
    if (nx < 0 || nx > W || ny < 0 || ny > H) {
      // clip to boundary
      const cx = Math.min(Math.max(nx, 0), W);
      const cy = Math.min(Math.max(ny, 0), H);
      coords.push([cx, cy]);
      break;
    }

    // self-intersection check: stop if we come near an earlier point
    let selfHit = false;
    if (coords.length > 10) {
      for (let k = 0; k < coords.length - 5; k++) {
        const dx = nx - coords[k][0];
        const dy = ny - coords[k][1];
        if (dx * dx + dy * dy < (stepSize * 1.5) ** 2) {
          coords.push([coords[k][0], coords[k][1]]);
          selfHit = true;
          break;
        }
      }
    }
    if (selfHit) break;

    coords.push([nx, ny]);
  }

  if (coords.length < 4) return null;

  const rawStart = coords[0];
  const rawEnd = coords[coords.length - 1];

  const smoothed = gaussianSmooth(coords, 3);
  smoothed[0] = rawStart;
  smoothed[smoothed.length - 1] = rawEnd;

  const dense = catmullRomDensify(smoothed, 8, false);
  // clamp to canvas
  for (const p of dense) {
    p[0] = Math.min(Math.max(p[0], 0), W);
    p[1] = Math.min(Math.max(p[1], 0), H);
  }
  dense[0] = rawStart;
  dense[dense.length - 1] = rawEnd;

  return dense;
}

// ── blob generation ──────────────────────────────────────────────────────────

function generateBlob(W, H) {
  const margin = 20;
  const minX = W * 0.25;
  const maxX = W * 0.75;
  const minY = H * 0.25;
  const maxY = H * 0.75;

  const cx = minX + Math.random() * (maxX - minX);
  const cy = minY + Math.random() * (maxY - minY);

  const N = 10;
  const baseRx = W * (0.05 + Math.random() * 0.12);
  const baseRy = H * (0.05 + Math.random() * 0.10);
  const rotAngle = Math.random() * Math.PI * 2;

  const control = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * 2 * Math.PI;
    const perturbR = 0.7 + Math.random() * 0.6;
    const rx = baseRx * perturbR;
    const ry = baseRy * perturbR;
    const lx = cx + rx * Math.cos(theta + rotAngle);
    const ly = cy + ry * Math.sin(theta + rotAngle);
    control.push([lx, ly]);
  }

  // reject if any control point too close to edge
  for (const [px, py] of control) {
    if (px < margin || px > W - margin || py < margin || py > H - margin) {
      return null;
    }
  }

  const dense = catmullRomDensify(control, 10, true);
  if (dense.length < 3) return null;

  // close the loop
  dense.push(dense[0]);
  return dense;
}

// ── region detection (BFS flood fill) ────────────────────────────────────────

function detectRegions(W, H, projection, curves, blobs) {
  const hitCanvas = document.createElement('canvas');
  hitCanvas.width = W;
  hitCanvas.height = H;
  const ctx = hitCanvas.getContext('2d');

  // white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // draw NE sphere outline as the boundary (instead of the canvas rectangle)
  const pathRenderer = d3.geoPath(projection, ctx);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.stroke();

  // also black out pixels outside the sphere so flood fill stays inside
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // re-fill the exterior black so flood fill treats it as border
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';

  // draw curves
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const curve of curves) {
    if (!curve || curve.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(curve[0][0], curve[0][1]);
    for (let i = 1; i < curve.length; i++) {
      ctx.lineTo(curve[i][0], curve[i][1]);
    }
    ctx.stroke();
  }

  for (const blob of blobs) {
    if (!blob || blob.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(blob[0][0], blob[0][1]);
    for (let i = 1; i < blob.length; i++) {
      ctx.lineTo(blob[i][0], blob[i][1]);
    }
    ctx.closePath();
    ctx.stroke();
  }

  const imgData = ctx.getImageData(0, 0, W, H);
  const pixels = imgData.data;

  // determine which pixels are "border" (black = R < 128)
  const isBorder = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    isBorder[i] = pixels[i * 4] < 128 ? 1 : 0;
  }

  // BFS flood fill
  const labels = new Int32Array(W * H).fill(-1);
  let numRegions = 0;
  const pixelCounts = [];
  const queue = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (isBorder[idx] || labels[idx] >= 0) continue;

      const regionId = numRegions++;
      pixelCounts.push(0);
      queue.length = 0;
      queue.push(idx);
      labels[idx] = regionId;

      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        pixelCounts[regionId]++;
        const cx2 = cur % W;
        const cy2 = (cur / W) | 0;

        const neighbors = [
          cy2 > 0 ? cur - W : -1,
          cy2 < H - 1 ? cur + W : -1,
          cx2 > 0 ? cur - 1 : -1,
          cx2 < W - 1 ? cur + 1 : -1,
        ];

        for (const n of neighbors) {
          if (n < 0 || isBorder[n] || labels[n] >= 0) continue;
          labels[n] = regionId;
          queue.push(n);
        }
      }
    }
  }

  // filter slivers: mark small regions as -2
  const MIN_PIXELS = 500;
  const validRegions = new Set();
  for (let r = 0; r < numRegions; r++) {
    if (pixelCounts[r] >= MIN_PIXELS) validRegions.add(r);
  }

  // remap region IDs
  const remap = new Int32Array(numRegions).fill(-1);
  let newId = 0;
  for (let r = 0; r < numRegions; r++) {
    if (validRegions.has(r)) remap[r] = newId++;
  }

  for (let i = 0; i < W * H; i++) {
    if (labels[i] >= 0) labels[i] = remap[labels[i]];
  }

  const finalCounts = new Array(newId).fill(0);
  for (let i = 0; i < W * H; i++) {
    if (labels[i] >= 0) finalCounts[labels[i]]++;
  }

  return { labels, numRegions: newId, pixelCounts: finalCounts };
}

// ── centroids + labels ────────────────────────────────────────────────────────

function computeCentroids(labels, W, H, numRegions) {
  const sumX = new Float64Array(numRegions);
  const sumY = new Float64Array(numRegions);
  const count = new Int32Array(numRegions);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = labels[y * W + x];
      if (r < 0) continue;
      sumX[r] += x;
      sumY[r] += y;
      count[r]++;
    }
  }

  const centroids = [];
  for (let r = 0; r < numRegions; r++) {
    if (count[r] > 0) {
      centroids.push([sumX[r] / count[r], sumY[r] / count[r]]);
    } else {
      centroids.push([0, 0]);
    }
  }
  return centroids;
}

function assignLabels(centroids) {
  const indexed = centroids.map((c, i) => ({ i, c }));
  // sort top→bottom, left→right (by y first, then x)
  indexed.sort((a, b) => a.c[1] - b.c[1] || a.c[0] - b.c[0]);
  const labels = new Array(centroids.length);
  indexed.forEach(({ i }, rank) => {
    labels[i] = rank < 26 ? String.fromCharCode(65 + rank) : String(rank + 1);
  });
  return labels;
}

// ── land point sampling ───────────────────────────────────────────────────────

function sampleLandPoint(regionId, labels, landMask, countryWeights, W, H, proj) {
  // Collect land pixels for this region along with their population-density weight.
  let totalWeight = 0;
  const candidates = [];
  for (let i = 0; i < W * H; i++) {
    if (labels[i] !== regionId || landMask[i] !== 1) continue;
    const w = (countryWeights && countryWeights[i] > 0) ? countryWeights[i] : 1;
    candidates.push(i, w);   // interleaved [idx, weight, idx, weight, ...]
    totalWeight += w;
  }
  if (candidates.length === 0) return null;

  // Weighted reservoir pick (linear scan — fast enough for ≤~100 K candidates).
  let r = Math.random() * totalWeight;
  let chosen = candidates[candidates.length - 2]; // last idx as fallback
  for (let k = 0; k < candidates.length; k += 2) {
    r -= candidates[k + 1];
    if (r <= 0) { chosen = candidates[k]; break; }
  }

  const x = chosen % W;
  const y = (chosen / W) | 0;
  return { lonlat: proj.invert([x, y]), x, y };
}

// ── rendering ────────────────────────────────────────────────────────────────

function render() {
  const { W, H, dpr, labels, numRegions, regionColors, regionLabels, landMask,
          projection, curves, blobs, worldData } = state;

  const canvas = document.getElementById('worldMap');
  if (!canvas) return;

  // All drawing happens on an offscreen canvas at logical (W×H) resolution.
  // The offscreen canvas is then scaled up to physical pixels on the visible canvas.
  if (!state.offscreen) {
    state.offscreen = document.createElement('canvas');
    state.offscreen.width = W;
    state.offscreen.height = H;
  }
  const oc = state.offscreen;
  const ctx = oc.getContext('2d');
  const pathRenderer = d3.geoPath(projection, ctx);

  // 1. Build pixel data: ocean everywhere, land region colours where landMask=1.
  //    putImageData ignores clip paths, so we use destination-in compositing
  //    afterwards to trim it to the NE sphere outline.
  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;
  const [or, og, ob] = OCEAN_COLOR;

  for (let i = 0; i < W * H; i++) {
    const r = labels[i];
    if (r >= 0 && landMask[i] === 1) {
      const col = regionColors[r];
      data[i * 4]     = col[0];
      data[i * 4 + 1] = col[1];
      data[i * 4 + 2] = col[2];
    } else {
      data[i * 4]     = or;
      data[i * 4 + 1] = og;
      data[i * 4 + 2] = ob;
    }
    data[i * 4 + 3] = 255;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(imgData, 0, 0);

  // 2. Clip pixel data to the NE sphere outline.
  //    destination-in keeps existing pixels only where the new shape is drawn.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // 3–6. Vector layers — all clipped to the sphere outline.
  ctx.save();
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.clip();

  // 3. Country borders
  ctx.save();
  ctx.strokeStyle = '#4a6a4a';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  pathRenderer(worldData);
  ctx.stroke();
  ctx.restore();

  // 4. Partition curves and blobs
  ctx.save();
  ctx.strokeStyle = '#2c3e50';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const curve of curves) {
    if (!curve || curve.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(curve[0][0], curve[0][1]);
    for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i][0], curve[i][1]);
    ctx.stroke();
  }

  for (const blob of blobs) {
    if (!blob || blob.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(blob[0][0], blob[0][1]);
    for (let i = 1; i < blob.length; i++) ctx.lineTo(blob[i][0], blob[i][1]);
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();

  // 5. Region labels
  const centroids = computeCentroids(labels, W, H, numRegions);
  ctx.save();
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let r = 0; r < numRegions; r++) {
    const lbl = regionLabels[r];
    const [cx, cy] = centroids[r];
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

  // 6. Clicked dot
  if (state.clickedDot) {
    const { x, y } = state.clickedDot;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore(); // remove sphere clip

  // 7. NE sphere outline drawn on top, unclipped
  ctx.save();
  ctx.beginPath();
  pathRenderer({ type: 'Sphere' });
  ctx.strokeStyle = '#3a5878';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // 8. Scale-blit offscreen canvas → visible canvas at physical resolution
  const mainCtx = canvas.getContext('2d');
  mainCtx.clearRect(0, 0, canvas.width, canvas.height);
  mainCtx.drawImage(oc, 0, 0, W * dpr, H * dpr);
}

// ── intersection helpers ──────────────────────────────────────────────────────

// Returns true if segment (p1→p2) and segment (p3→p4) properly intersect.
function segmentsIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel

  const dx = p3[0] - p1[0], dy = p3[1] - p1[1];
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

// Returns true if any segment of polyline `a` intersects any segment of polyline `b`.
function polylinesIntersect(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

// ── generate ─────────────────────────────────────────────────────────────────

async function generate() {
  const btn = document.getElementById('generateBtn');
  const status = document.getElementById('statusMsg');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Generating...';
  state.clickedDot = null;

  // yield to browser to update UI
  await new Promise(r => setTimeout(r, 10));

  const { W, H, config, projection, landMask, worldData } = state;

  let bestResult = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const blobs = [];
    for (let i = 0; i < config.numLoops; i++) {
      for (let tries = 0; tries < 8; tries++) {
        const b = generateBlob(W, H);
        if (!b) continue;
        // reject if it crosses any already-accepted blob
        if (blobs.some(existing => polylinesIntersect(b, existing))) continue;
        blobs.push(b);
        break;
      }
    }

    const curves = [];
    for (let i = 0; i < config.numCurves; i++) {
      for (let tries = 0; tries < 8; tries++) {
        const c = generateCurve(W, H, config.curvature, config.maxSteps);
        if (!c) continue;
        // reject if it crosses any blob
        if (blobs.some(b => polylinesIntersect(c, b))) continue;
        curves.push(c);
        break;
      }
    }

    const { labels, numRegions, pixelCounts } = detectRegions(W, H, projection, curves, blobs);

    if (numRegions >= config.minRegions) {
      bestResult = { curves, blobs, labels, numRegions };
      break;
    }

    if (!bestResult || numRegions > bestResult.numRegions) {
      bestResult = { curves, blobs, labels, numRegions };
    }
  }

  const { curves, blobs, labels, numRegions } = bestResult;

  const regionColors = generateMapColors(numRegions);

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

// ── UI setup ─────────────────────────────────────────────────────────────────

function setupUI() {
  const canvas = document.getElementById('worldMap');
  const coordDisplay = document.getElementById('coordDisplay');

  // slider wiring
  const sliders = [
    { id: 'numCurves', key: 'numCurves', displayId: 'numCurvesVal' },
    { id: 'numLoops', key: 'numLoops', displayId: 'numLoopsVal' },
    { id: 'curvature', key: 'curvature', displayId: 'curvatureVal' },
  ];

  for (const { id, key, displayId } of sliders) {
    const slider = document.getElementById(id);
    const display = document.getElementById(displayId);
    if (!slider) continue;
    slider.value = state.config[key];
    if (display) display.textContent = state.config[key];
    slider.addEventListener('input', () => {
      state.config[key] = parseInt(slider.value, 10);
      if (display) display.textContent = slider.value;
    });
  }

  const densityCheck = document.getElementById('usePopDensity');
  if (densityCheck) {
    densityCheck.addEventListener('change', () => {
      state.usePopDensity = densityCheck.checked;
    });
  }

  // generate button
  const btn = document.getElementById('generateBtn');
  if (btn) btn.addEventListener('click', generate);

  // click handler for region info
  if (canvas) {
    canvas.addEventListener('click', async (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = state.W / rect.width;
      const scaleY = state.H / rect.height;
      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      if (x < 0 || x >= state.W || y < 0 || y >= state.H) return;

      const regionId = state.labels[y * state.W + x];
      if (regionId < 0) {
        if (coordDisplay) coordDisplay.textContent = 'Click a land region...';
        return;
      }

      const lbl = state.regionLabels[regionId];
      const weights = state.usePopDensity ? state.countryWeights : null;
      const result = sampleLandPoint(regionId, state.labels, state.landMask, weights, state.W, state.H, state.projection);

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
          ? `You were born in ${geo.place}, ${geo.country}`
          : `You were born somewhere in region ${lbl}`;
      }
    });
  }
}

// ── reverse geocoding ─────────────────────────────────────────────────────────

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const addr = data.address ?? {};
  const place = addr.village ?? addr.hamlet ?? addr.town ?? addr.suburb
             ?? addr.city_district ?? addr.city ?? addr.county ?? addr.state ?? null;
  const country = addr.country ?? null;
  return place && country ? { place, country } : null;
}

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  const status = document.getElementById('statusMsg');
  if (status) status.textContent = 'Loading world data...';

  try {
    // Scale the visible canvas to physical pixels for sharp rendering on HiDPI screens.
    const canvas = document.getElementById('worldMap');
    const { W, H, dpr } = state;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const worldData = await loadWorldData();
    state.worldData = worldData;

    const { proj, path } = setupProjection(W, H, worldData);
    state.projection = proj;
    state.geoPath = path;

    state.landMask = buildLandMask(W, H, proj, worldData);
    state.countryWeights = buildCountryWeights(W, H, proj, worldData);

    setupUI();

    await generate();
  } catch (err) {
    console.error('Init failed:', err);
    if (status) status.textContent = 'Error loading data. Check console.';
  }
}

document.addEventListener('DOMContentLoaded', init);
