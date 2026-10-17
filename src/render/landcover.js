/* =====================================================================
   Land cover: forests, farmland, rock, tundra. Shared by terrain
   colouring and vegetation placement.
   ===================================================================== */
import { clamp, lerp, smoothstep, fbm, noiseA, noiseB, noiseC, noiseD, hash2i } from '../core/math.js';
import { cityMask } from '../world/geo.js';

const gauss = (e, n, ce, cn, s) => Math.exp(-((e - ce) ** 2 + (n - cn) ** 2) / (2 * s * s));

let extraFields = [];
let villageList = [];
export function setLandcoverExtras(world) {
  extraFields = world.fields || [];
  villageList = world.villages || [];
}

// Farmland intensity 0..1
export function fieldMask(x, z) {
  const e = x / 1000, n = -z / 1000;
  let bias = -0.25;
  bias += 0.55 * smoothstep(-13.5, -16.0, n); // Skåne
  bias += 0.45 * Math.max(gauss(e, n, -8.0, -6.8, 1.6), gauss(e, n, -3.0, 1.2, 2.2), gauss(e, n, -12.6, -4.6, 1.6), gauss(e, n, -0.4, 6.0, 1.4), gauss(e, n, -9.0, -1.2, 1.2));
  bias -= 0.45 * smoothstep(9, 14, n); // Norrland: little farmland
  for (const v of villageList) {
    const d = Math.hypot(x - v.x, z - v.z);
    if (d < 1100) bias += 0.35 * (1 - d / 1100);
  }
  for (const f of extraFields) {
    const d = Math.hypot(x - f.x, z - f.z);
    if (d < f.r * 1.6) bias += 0.8 * (1 - smoothstep(f.r * 0.7, f.r * 1.6, d));
  }
  const v = fbm(noiseC, x / 1100, z / 1100, 3) + bias;
  return smoothstep(0.02, 0.16, v) * (1 - cityMask(x, z));
}

// Parcel id & crop type (0 grass/ley, 1 wheat, 2 rapeseed, 3 potatoes/ploughed)
export function cropAt(x, z) {
  const cx = Math.floor(x / 140 + 0.3 * noiseA(x / 300, z / 300)), cz = Math.floor(z / 210 + 0.3 * noiseB(x / 300, z / 300));
  const h = hash2i(cx, cz, 99);
  return h < 0.35 ? 0 : h < 0.7 ? 1 : h < 0.82 ? 2 : 3;
}

export function forestDensity(x, z, h) {
  const e = x / 1000, n = -z / 1000;
  let bias = 0.12;
  bias -= 0.35 * smoothstep(-13.5, -16.5, n); // Skåne
  bias += 0.18 * smoothstep(6, 14, n);
  const f = fbm(noiseD, x / 620, z / 620, 3) + bias;
  let d = smoothstep(-0.22, 0.18, f);
  // treeline in the north
  const tl = n > 18 ? lerp(520, 420, smoothstep(22, 27, n)) : 900;
  if (h != null) d *= 1 - smoothstep(tl - 60, tl, h);
  d *= 1 - cityMask(x, z) * 0.95;
  return d * (1 - fieldMask(x, z));
}

// Species mix: returns weights {spruce, pine, birch, broadleaf}
export function speciesMix(x, z, h) {
  const e = x / 1000, n = -z / 1000;
  const south = smoothstep(-11, -16, n); // Skåne/Halland: beech & oak
  const north = smoothstep(4, 14, n);
  const mountain = h != null ? smoothstep(330, 430, h) * smoothstep(18, 24, n) : 0;
  const nz = noiseB(x / 400, z / 400);
  return {
    spruce: (0.45 + 0.2 * nz) * (1 - south * 0.7) * (1 - mountain),
    pine: (0.3 - 0.15 * nz + 0.2 * north) * (1 - mountain * 0.8),
    birch: 0.2 + 0.15 * north + 0.8 * mountain,
    broad: 0.08 + 0.6 * south * (1 - north),
  };
}

// Summer ground colour + masks. out: [r,g,b, forest, field, rock, crop]
export function groundInfo(x, z, h, ny, waterLevel, roadW, out) {
  const e = x / 1000, n = -z / 1000;
  const cm = cityMask(x, z);
  const forest = forestDensity(x, z, h);
  const field = fieldMask(x, z);
  const steep = 1 - smoothstep(0.72, 0.9, ny);
  const nz = noiseA(x / 37, z / 37) * 0.5 + noiseB(x / 11, z / 11) * 0.25;
  // grass
  const dry = noiseD(x / 140, z / 140) * 0.5 + 0.5;
  let r = 0.3 + 0.05 * nz + 0.06 * dry, g = 0.35 + 0.04 * nz + 0.015 * dry, b = 0.16 + 0.02 * dry;
  // forest floor
  r = lerp(r, 0.19, forest * 0.9); g = lerp(g, 0.23, forest * 0.9); b = lerp(b, 0.12, forest * 0.9);
  // fields
  let crop = 0;
  if (field > 0.02) {
    crop = cropAt(x, z);
    const CR = [[0.36, 0.47, 0.19], [0.55, 0.5, 0.26], [0.42, 0.5, 0.2], [0.36, 0.29, 0.19]][crop];
    // parcel edges stay grassy
    const ex = Math.abs(((x / 140 + 0.3 * noiseA(x / 300, z / 300)) % 1 + 1) % 1 - 0.5), ez = Math.abs(((z / 210 + 0.3 * noiseB(x / 300, z / 300)) % 1 + 1) % 1 - 0.5);
    const edge = smoothstep(0.47, 0.495, Math.max(ex, ez));
    const f = field * (1 - edge);
    // ploughing stripes
    const stripe = 0.04 * Math.sin((x * 0.7 + z * 0.3) * 1.6);
    r = lerp(r, CR[0] + stripe, f); g = lerp(g, CR[1] + stripe, f); b = lerp(b, CR[2], f);
  }
  // north: heath & lichen tint, tundra above treeline
  const north = smoothstep(14, 24, n);
  r = lerp(r, r * 1.08 + 0.02, north); g = lerp(g, g * 0.95, north);
  const tundra = smoothstep(430, 520, h) * smoothstep(18, 24, n);
  r = lerp(r, 0.42, tundra); g = lerp(g, 0.4, tundra); b = lerp(b, 0.27, tundra);
  // rock on steep slopes & knolls
  const knoll = smoothstep(0.55, 0.85, noiseC(x / 55, z / 55)) * 0.6 * (1 - field) * (1 - cm);
  const rock = clamp(Math.max(steep, knoll), 0, 1);
  r = lerp(r, 0.46 + 0.04 * nz, rock); g = lerp(g, 0.43 + 0.04 * nz, rock); b = lerp(b, 0.40 + 0.03 * nz, rock);
  // city lawn / paving
  if (cm > 0) {
    r = lerp(r, 0.3 + 0.04 * nz, cm * 0.5); g = lerp(g, 0.37 + 0.04 * nz, cm * 0.5); b = lerp(b, 0.18, cm * 0.5);
  }
  // shore: sand & mud
  if (waterLevel > -1e8) {
    const above = h - waterLevel;
    const sand = 1 - smoothstep(0.4, 2.2, above);
    r = lerp(r, 0.62, sand); g = lerp(g, 0.56, sand); b = lerp(b, 0.43, sand);
    if (above < 0) { r = lerp(r, 0.3, 0.6); g = lerp(g, 0.28, 0.6); b = lerp(b, 0.2, 0.6); }
  }
  // road shoulders: gravel / worn grass
  if (roadW > 0) {
    r = lerp(r, 0.4, roadW * 0.55); g = lerp(g, 0.37, roadW * 0.55); b = lerp(b, 0.31, roadW * 0.55);
  }
  out[0] = r; out[1] = g; out[2] = b;
  out[3] = forest; out[4] = field; out[5] = rock; out[6] = crop;
  return out;
}
