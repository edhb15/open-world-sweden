/* =====================================================================
   Sky dome: analytic atmosphere, sun & moon, clouds, stars and aurora.
   Also computes the real sun position for a latitude, date and time.
   ===================================================================== */
import * as THREE from 'three';
import { clamp, smoothstep, lerp, DEG } from '../core/math.js';

/* Sun position. dayOfYear 1..365, clock in local Swedish time (hours).
   Returns unit vector in world space (x east, y up, -z north). */
export function sunDirection(lat, dayOfYear, clock, out = new THREE.Vector3()) {
  const dst = dayOfYear > 86 && dayOfYear < 303; // CEST roughly late March - late October
  const solar = clock - (dst ? 2 : 1) + 16 / 15 - eqTime(dayOfYear) / 60;
  const decl = -23.44 * DEG * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const H = (solar - 12) * 15 * DEG;
  const phi = lat * DEG;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI; // from north, clockwise
  out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  return out;
}
function eqTime(N) {
  const B = (2 * Math.PI * (N - 81)) / 364;
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}
export function moonDirection(lat, dayOfYear, clock, out = new THREE.Vector3()) {
  // crude: the moon trails the sun by its phase angle (29.5 day cycle)
  const phase = ((dayOfYear % 29.53) / 29.53);
  const lag = phase * 24.84;
  sunDirection(lat, dayOfYear, clock - lag, out);
  out.y = out.y * 0.9 + 0.05;
  return out.normalize();
}
export function moonPhase(dayOfYear) { return (dayOfYear % 29.53) / 29.53; }

const vert = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const frag = /* glsl */`
uniform vec3 uSun, uMoon;
uniform float uTime, uCloud, uCloudDark, uAurora, uMoonPhase, uFogMix, uStorm, uOvercast;
uniform vec3 uFogColor;
uniform vec2 uWind;
varying vec3 vDir;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
vec3 skyColor(vec3 d, float sunE) {
  float day = smoothstep(-0.12, 0.22, sunE);
  float twi = smoothstep(-0.22, -0.02, sunE) * (1.0 - smoothstep(0.02, 0.32, sunE));
  vec3 zen = mix(vec3(0.004, 0.007, 0.018), vec3(0.16, 0.36, 0.74), day);
  vec3 hor = mix(vec3(0.015, 0.025, 0.05), vec3(0.62, 0.76, 0.92), day);
  // twilight: deep blue zenith, warm horizon toward the sun
  float toward = 0.5 + 0.5 * dot(normalize(d.xz + 1e-4), normalize(uSun.xz + 1e-4));
  hor = mix(hor, mix(vec3(0.35, 0.3, 0.42), vec3(1.0, 0.52, 0.24), toward), twi * 0.9);
  zen = mix(zen, vec3(0.1, 0.13, 0.3), twi * 0.6);
  float h = 1.0 - clamp(d.y, 0.0, 1.0);
  vec3 c = mix(zen, hor, pow(h, 3.0));
  // mie glow around the sun
  float cs = max(dot(d, uSun), 0.0);
  vec3 glowCol = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.9, 0.75), smoothstep(0.0, 0.35, sunE));
  c += glowCol * (pow(cs, 6.0) * 0.28 + pow(cs, 60.0) * 0.6) * smoothstep(-0.18, 0.02, sunE);
  return c;
}
void main() {
  vec3 d = normalize(vDir);
  float sunE = uSun.y;
  vec3 c = skyColor(d, sunE);
  float night = 1.0 - smoothstep(-0.2, 0.0, sunE);
  // stars
  if (d.y > 0.0 && night > 0.01) {
    vec3 sd = d * 300.0;
    vec2 cell = floor(sd.xz / (sd.y * 0.002 + 0.6));
    float st = h2(cell + floor(sd.y));
    float star = step(0.9965, st) * smoothstep(0.0, 0.15, d.y);
    float tw = 0.7 + 0.3 * sin(uTime * 3.0 + st * 100.0);
    c += vec3(0.9, 0.93, 1.0) * star * tw * night * (1.0 - uOvercast) * 1.2;
    // milky way band
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, -0.8))) * 3.2, 2.0));
    c += vec3(0.05, 0.055, 0.07) * band * fbm(d.xz * 9.0) * night * (1.0 - uOvercast);
  }
  // aurora borealis (towards north = -z)
  if (uAurora > 0.001 && d.y > 0.02) {
    float north = smoothstep(-0.2, 0.6, -d.z);
    vec2 ap = d.xz / (d.y + 0.25);
    float curtain = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float wave = sin(ap.x * (1.6 + fi * 0.7) + uTime * (0.07 + fi * 0.03) + fbm(ap * 0.8 + uTime * 0.02 + fi) * 3.0);
      float band = exp(-pow((ap.y + 1.1 + fi * 0.35 + wave * 0.25) * 3.0, 2.0));
      curtain += band * (0.6 + 0.4 * fbm(vec2(ap.x * 6.0, uTime * 0.3 + fi)));
    }
    float heightFade = smoothstep(0.02, 0.18, d.y) * (1.0 - smoothstep(0.55, 0.95, d.y));
    vec3 aur = mix(vec3(0.1, 1.0, 0.45), vec3(0.6, 0.25, 0.9), smoothstep(0.25, 0.75, d.y));
    c += aur * curtain * north * heightFade * uAurora * night * (1.0 - uOvercast) * 0.7;
  }
  // sun disk
  float cs = dot(d, uSun);
  float disk = smoothstep(0.9993, 0.99965, cs);
  c += vec3(1.0, 0.92, 0.8) * disk * 14.0 * smoothstep(-0.03, 0.02, sunE) * (1.0 - uOvercast * 0.97);
  // moon
  float cm = dot(d, uMoon);
  float moon = smoothstep(0.99955, 0.9998, cm);
  vec3 mcol = vec3(0.85, 0.87, 0.92) * (0.35 + 0.65 * abs(cos(uMoonPhase * 6.2831)));
  c = mix(c, mcol * 1.4, moon * (1.0 - uOvercast * 0.9) * smoothstep(-0.05, 0.05, uMoon.y));
  c += vec3(0.6, 0.65, 0.8) * pow(max(cm, 0.0), 300.0) * 0.12 * night;
  // clouds on a plane
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.08) * 0.9 + uWind * uTime * 0.004;
    float base = fbm(uv * 0.9);
    float detail = fbm(uv * 3.1 + 5.0);
    float cov = mix(0.72, 0.18, uCloud);
    float dens = smoothstep(cov, cov + 0.25, base * 0.75 + detail * 0.35);
    dens = max(dens, uOvercast * (0.75 + 0.25 * detail));
    float day = smoothstep(-0.12, 0.25, sunE);
    vec3 lit = mix(vec3(0.05, 0.06, 0.08), vec3(0.95, 0.96, 0.98), day);
    lit = mix(lit, vec3(1.0, 0.65, 0.4), smoothstep(-0.15, 0.0, sunE) * (1.0 - smoothstep(0.0, 0.25, sunE)) * 0.8);
    vec3 shade = lit * mix(0.62, 0.32, uCloudDark) * (0.75 + 0.25 * detail);
    vec3 cc = mix(lit, shade, smoothstep(0.3, 0.9, dens + uCloudDark * 0.4));
    float silver = pow(max(dot(d, uSun), 0.0), 12.0) * (1.0 - dens) * 0.6;
    cc += vec3(1.0, 0.9, 0.75) * silver * day;
    float fade = smoothstep(0.0, 0.12, d.y);
    c = mix(c, cc, dens * fade * 0.97);
  }
  // overcast tint + below-horizon ground haze
  c = mix(c, uFogColor, uFogMix * (1.0 - smoothstep(0.0, 0.35, d.y)));
  if (d.y < 0.0) c = mix(c, uFogColor, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  constructor() {
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uMoon: { value: new THREE.Vector3(0, -1, 0) },
      uTime: { value: 0 },
      uCloud: { value: 0.3 },
      uCloudDark: { value: 0 },
      uAurora: { value: 0 },
      uMoonPhase: { value: 0.5 },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogMix: { value: 0.2 },
      uStorm: { value: 0 },
      uOvercast: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0.3) },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.scale.setScalar(9000);
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
  }
  // Approximate colour of the sky in a direction (CPU copy for fog & lights)
  horizonColor(sunE, cloud, out = new THREE.Color()) {
    const day = smoothstep(-0.12, 0.22, sunE);
    const twi = smoothstep(-0.22, -0.02, sunE) * (1 - smoothstep(0.02, 0.32, sunE));
    out.setRGB(lerp(0.015, 0.62, day), lerp(0.025, 0.76, day), lerp(0.05, 0.92, day));
    out.r = lerp(out.r, 0.75, twi * 0.5); out.g = lerp(out.g, 0.5, twi * 0.45); out.b = lerp(out.b, 0.45, twi * 0.4);
    const gray = (out.r + out.g + out.b) / 3;
    out.r = lerp(out.r, gray * 0.95, cloud * 0.8); out.g = lerp(out.g, gray * 0.98, cloud * 0.8); out.b = lerp(out.b, gray * 1.05, cloud * 0.8);
    return out;
  }
}
