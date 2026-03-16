// Usage: node scripts/bake_population.mjs path/to/ppp_2020_1km_Aggregated.tif
import { geoNaturalEarth1 } from 'd3-geo';
import { fromFile } from 'geotiff';
import { writeFileSync } from 'fs';

const W = 900, H = 550, PAD = 4;
const proj = geoNaturalEarth1().fitExtent([[PAD, PAD], [W - PAD, H - PAD]], { type: 'Sphere' });

const tiff = await fromFile(process.argv[2]);
const image = await tiff.getImage();
const [west, south, east, north] = image.getBoundingBox(); // should be [-180,-90,180,90]
const tiffW = image.getWidth();
const tiffH = image.getHeight();
const [raster] = await image.readRasters();           // flat Float32/Int32 array

const output = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const lonlat = proj.invert([x, y]);
    if (!lonlat) continue;                             // outside projection
    const [lon, lat] = lonlat;
    const col = Math.floor((lon - west) / (east - west) * tiffW);
    const row = Math.floor((north - lat) / (north - south) * tiffH);
    if (col < 0 || col >= tiffW || row < 0 || row >= tiffH) continue;
    const val = raster[row * tiffW + col];
    output[y * W + x] = val > 0 ? val : 0;            // clamp negatives & NoData
  }
}

writeFileSync('static/data/pop_weights.bin', Buffer.from(output.buffer));
console.log(`Written ${output.length} values (${(output.buffer.byteLength / 1e6).toFixed(1)} MB)`);
