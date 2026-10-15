/* =====================================================================
   Weather, seasons and climate.
   - Climate by latitude & day of year (Malmö mild, Kiruna arctic).
   - Weather states with smooth transitions and optional dynamic changes.
   - Road wetness, snow and ice for tyre physics; frozen lakes up north.
   - GPU-animated rain & snow, lightning, aurora on clear winter nights.
   - Seasonal foliage and ground colours.
   ===================================================================== */
import * as THREE from 'three';
import { clamp, lerp, smoothstep, RNG } from '../core/math.js';
import { envUniforms } from '../render/terrainmesh.js';
import { vegUniforms } from '../render/vegetation.js';

export const PRESETS = {
  clear: { cloud: 0.12, overcast: 0, rain: 0, snow: 0, fog: 0, storm: 0, wind: 0.25 },
  cloudy: { cloud: 0.6, overcast: 0.15, rain: 0, snow: 0, fog: 0, storm: 0, wind: 0.4 },
  overcast: { cloud: 0.9, overcast: 0.85, rain: 0, snow: 0, fog: 0.05, storm: 0, wind: 0.45 },
  rain: { cloud: 1, overcast: 0.95, rain: 0.75, snow: 0, fog: 0.12, storm: 0, wind: 0.6 },
  storm: { cloud: 1, overcast: 1, rain: 1, snow: 0, fog: 0.15, storm: 1, wind: 1 },
  snow: { cloud: 1, overcast: 0.9, rain: 0, snow: 0.75, fog: 0.2, storm: 0, wind: 0.5 },
  fog: { cloud: 0.7, overcast: 0.6, rain: 0, snow: 0, fog: 0.9, storm: 0, wind: 0.05 },
};
const ORDER = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'snow', 'fog'];

// mean temperature at latitude & day (°C)
export function climateTemp(lat, day, clock = 14) {
  const t = clamp((lat - 55.6) / (67.9 - 55.6), 0, 1);
  const annual = lerp(8.8, -1.2, t);
  const amp = lerp(8.5, 13.5, t);
  const seasonal = -Math.cos((2 * Math.PI * (day - 20)) / 365) * amp;
  const daily = Math.sin(((clock - 9) / 24) * Math.PI * 2) * lerp(4, 3, t);
  return annual + seasonal + daily;
}
export function seasonOf(day, lat = 59.3) {
  // astronomical-ish seasons shifted for latitude (northern winters are longer)
  const north = clamp((lat - 59) / 9, 0, 1);
  const springStart = lerp(79, 125, north), summerStart = lerp(152, 165, north), autumnStart = lerp(244, 232, north), winterStart = lerp(320, 285, north);
  if (day >= springStart && day < summerStart) return 'spring';
  if (day >= summerStart && day < autumnStart) return 'summer';
  if (day >= autumnStart && day < winterStart) return 'autumn';
  return 'winter';
}

const rainVert = /* glsl */`
uniform float uTime, uSpeed, uBox; uniform vec3 uCam; uniform vec2 uWind; uniform float uLen;
attribute float aEnd;
varying float vA;
void main() {
  vec3 p = position;
  vec3 vel = vec3(uWind.x, -uSpeed, uWind.y);
  vec3 q = p + vel * uTime;
  q = mod(q - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  q -= normalize(vel) * uLen * aEnd;
  vA = 1.0 - aEnd * 0.8;
  gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
}`;
const rainFrag = /* glsl */`
uniform float uOpacity; uniform vec3 uColor; varying float vA;
void main() { gl_FragColor = vec4(uColor, uOpacity * vA); }`;
const snowVert = /* glsl */`
uniform float uTime, uBox, uSize; uniform vec3 uCam; uniform vec2 uWind;
attribute float aSeed;
void main() {
  vec3 p = position;
  vec3 q = p + vec3(uWind.x + sin(uTime * 0.8 + aSeed * 6.0) * 0.6, -1.3, uWind.y + cos(uTime * 0.7 + aSeed * 4.0) * 0.6) * uTime;
  q = mod(q - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  vec4 mv = viewMatrix * vec4(q, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aSeed * 0.8) / max(0.5, -mv.z);
}`;
const snowFrag = /* glsl */`
uniform float uOpacity;
void main() { vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.15, length(d)); gl_FragColor = vec4(vec3(0.95), a * uOpacity); }`;

export class Weather {
  constructor(game) {
    this.game = game;
    this.mode = 'auto'; // auto (dynamic) or fixed preset key
    this.state = { ...PRESETS.clear };
    this.target = { ...PRESETS.clear };
    this.current = 'clear';
    this.changeT = 600;
    this.rng = new RNG(Date.now() & 0xffff);
    this.wet = 0; this.roadSnow = 0; this.snowGround = 0;
    this.lightning = 0; this.flashT = 4;
    this.auroraNight = 0.5;
    this.lastDay = -1;
    this.build();
  }
  build() {
    const box = 60;
    // rain: line segments
    const N = 5000;
    const pos = new Float32Array(N * 2 * 3), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * box, y = Math.random() * box, z = Math.random() * box;
      pos.set([x, y, z, x, y, z], i * 6); end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.rainU = { uTime: { value: 0 }, uSpeed: { value: 9 }, uBox: { value: box }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(1, 0.5) }, uLen: { value: 0.55 }, uOpacity: { value: 0.35 }, uColor: { value: new THREE.Color(0.75, 0.8, 0.88) } };
    this.rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({ vertexShader: rainVert, fragmentShader: rainFrag, uniforms: this.rainU, transparent: true, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.game.scene.add(this.rain);
    // snow: points
    const M = 7000;
    const sp = new Float32Array(M * 3), seed = new Float32Array(M);
    for (let i = 0; i < M; i++) { sp[i * 3] = Math.random() * box; sp[i * 3 + 1] = Math.random() * box; sp[i * 3 + 2] = Math.random() * box; seed[i] = Math.random(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.snowU = { uTime: { value: 0 }, uBox: { value: box }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(1, 0.5) }, uSize: { value: 40 }, uOpacity: { value: 0.9 } };
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({ vertexShader: snowVert, fragmentShader: snowFrag, uniforms: this.snowU, transparent: true, depthWrite: false }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.game.scene.add(this.snow);
  }

  // mode: 'auto' | preset key
  set(mode, day) {
    const env = this.game.env;
    this.mode = mode;
    const lat = env.lat;
    if (mode === 'auto') {
      // plausible weather for the season
      const T = climateTemp(lat, day ?? env.day, env.clock);
      const pick = this.rng.weighted(['clear', 'cloudy', 'overcast', 'rain', 'fog'], [35, 30, 15, 15, 5]);
      this.current = pick === 'rain' && T < 1 ? 'snow' : pick;
    } else this.current = mode;
    Object.assign(this.target, PRESETS[this.current]);
    Object.assign(this.state, PRESETS[this.current]);
    // start with roads already wet / snowy if appropriate
    this.wet = this.state.rain > 0 ? 0.9 : 0;
    this.changeT = this.rng.float(500, 1500);
    this.applyToEnv(0, true);
  }

  update(dt, game) {
    const env = game.env;
    const simDt = dt * (game.timeScale || 1);
    const W = this.state;
    // dynamic changes
    if (this.mode === 'auto') {
      this.changeT -= simDt * (game.clockScale ?? 1);
      if (this.changeT <= 0) {
        const i = ORDER.indexOf(this.current);
        const T = game.conditions.temp;
        let next = this.rng.weighted(['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'], [i <= 1 ? 30 : 15, 30, 20, 15, env.day > 150 && env.day < 250 ? 4 : 0.5, env.clock < 9 ? 6 : 1]);
        if ((next === 'rain' || next === 'storm') && T < 0.5) next = 'snow';
        this.current = next;
        Object.assign(this.target, PRESETS[next]);
        this.changeT = this.rng.float(600, 1800);
      }
    }
    // smooth transition
    const k = 1 - Math.exp(-simDt / 40);
    for (const key in this.target) W[key] = lerp(W[key], this.target[key], k);
    // temperature and road state
    const lat = env.lat;
    const T = climateTemp(lat, env.day, env.clock) - W.overcast * 1.5 * (env.daylight) + (1 - W.overcast) * (env.daylight > 0.5 ? 1.5 : -2);
    game.conditions.temp = T;
    // precipitation type follows temperature
    if (W.rain > 0.05 && T < 0.3) { W.snow = Math.max(W.snow, W.rain); W.rain *= 0.9; }
    if (W.snow > 0.05 && T > 2.5) { W.rain = Math.max(W.rain, W.snow); W.snow *= 0.9; }
    // wetness
    const dry = T > 0 ? (0.0012 + 0.0015 * env.daylight * (1 - W.overcast)) : 0.0002;
    this.wet = clamp(this.wet + (W.rain * 0.012 - dry * (1 - W.rain)) * simDt, 0, 1);
    // seasonal snow on the ground (climate) + fresh snowfall
    const Tm = climateTemp(lat, env.day, 13);
    const climSnow = smoothstep(1.5, -2.5, Tm);
    this.snowGround = clamp(Math.max(climSnow, this.snowGround + W.snow * 0.004 * simDt - (T > 2 ? 0.0006 * simDt : 0)), 0, 1);
    if (climSnow < 0.05 && T > 4) this.snowGround = Math.max(0, this.snowGround - 0.002 * simDt);
    this.roadSnow = clamp(this.snowGround * 0.55 + W.snow * 0.6, 0, 1);
    const ice = T < 1.5 && T > -12 ? clamp((this.wet * 0.7 + this.roadSnow * 0.4) * smoothstep(1.5, -1.5, T), 0, 1) : 0;
    const C = game.conditions;
    C.wet = this.roadSnow > 0.4 ? this.wet * 0.4 : this.wet;
    C.snow = this.roadSnow;
    C.snowGround = this.snowGround;
    C.ice = ice;
    C.frozen = Tm < -4 ? (this.snowGround > 0.5 ? 2 : 1) : 0;
    // season visuals
    const season = seasonOf(env.day, lat);
    if (season !== game.season) { game.season = season; game.emit('season', season); }
    this.applySeason(env.day, lat);
    this.applyToEnv(dt);
    // lightning
    if (W.storm > 0.5) {
      this.flashT -= dt;
      if (this.flashT <= 0) {
        this.flashT = this.rng.float(4, 14);
        this.lightning = 1;
        game.emit('lightning', this.rng.float(0.5, 4)); // seconds until thunder (distance)
      }
    }
    if (this.lightning > 0) this.lightning = Math.max(0, this.lightning - dt * 3.5);
    // aurora: clear winter nights in the north
    if (Math.floor(env.day) !== this.lastDay) { this.lastDay = Math.floor(env.day); this.auroraNight = this.rng.float(0.2, 1); }
    const north = smoothstep(61, 66, lat);
    const dark = env.night;
    const months = env.day < 105 || env.day > 245 ? 1 : 0.15;
    env.aurora = north * dark * months * this.auroraNight * (1 - W.overcast) * (1 - W.cloud * 0.6);
    // precipitation particles follow the camera
    const cam = game.camera.position;
    this.rainU.uCam.value.copy(cam); this.snowU.uCam.value.copy(cam);
    this.rainU.uTime.value += dt; this.snowU.uTime.value += dt;
    const wind = W.wind * 4;
    this.rainU.uWind.value.set(wind, wind * 0.4); this.snowU.uWind.value.set(wind * 0.5, wind * 0.25);
    this.rain.visible = W.rain > 0.03;
    this.rainU.uOpacity.value = 0.12 + W.rain * 0.32;
    this.rain.geometry.setDrawRange(0, Math.floor(10000 * clamp(W.rain, 0.1, 1)));
    this.snow.visible = W.snow > 0.03;
    this.snow.geometry.setDrawRange(0, Math.floor(7000 * clamp(W.snow, 0.1, 1)));
    this.snowU.uSize.value = 34 * (game.renderer.getPixelRatio());
    // frozen water visuals
    const frozen = C.frozen;
    if (frozen !== this.frozenVis) { this.frozenVis = frozen; game.water.setFrozen(frozen, frozen && lat > 63.5); }
  }

  applyToEnv(dt, instant = false) {
    const env = this.game.env, W = this.state;
    Object.assign(env.weather, { cloud: W.cloud, overcast: W.overcast, rain: W.rain, snow: W.snow, fog: W.fog, storm: W.storm, wind: W.wind });
    envUniforms.uWet.value = this.game.conditions.wet;
    envUniforms.uSnow.value = this.snowGround;
    envUniforms.uWind.value = 0.25 + W.wind * 1.2;
    env.lightning = this.lightning;
  }

  applySeason(day, lat) {
    // foliage: leaf-out in May (later up north), autumn colours in September/October
    const north = clamp((lat - 56) / 12, 0, 1);
    const leafOut = lerp(115, 150, north), leafFull = leafOut + 20;
    const turn = lerp(275, 245, north), fall = turn + 25;
    let leaf;
    if (day < leafOut || day > fall) leaf = 0;
    else if (day < leafFull) leaf = (day - leafOut) / (leafFull - leafOut);
    else if (day > turn) leaf = 1 - (day - turn) / (fall - turn) * 0.6;
    else leaf = 1;
    vegUniforms.uLeaf.value = clamp(leaf, 0, 1);
    const autumn = clamp((day - (turn - 15)) / 30, 0, 1) * (day < fall + 20 ? 1 : 0);
    const spring = day > leafOut - 25 && day < leafFull + 25 ? 1 - Math.abs(day - leafOut - 5) / 35 : 0;
    envUniforms.uAutumn.value = clamp(autumn, 0, 1);
    envUniforms.uSpring.value = clamp(spring, 0, 1);
    const summerB = new THREE.Color(0.2, 0.36, 0.08), springB = new THREE.Color(0.32, 0.5, 0.1), autumnB = new THREE.Color(0.78, 0.6, 0.08);
    const summerL = new THREE.Color(0.14, 0.28, 0.06), autumnL = new THREE.Color(0.66, 0.26, 0.05);
    vegUniforms.uBirchCol.value.copy(summerB).lerp(springB, clamp(spring, 0, 1)).lerp(autumnB, clamp(autumn * 1.2, 0, 1));
    vegUniforms.uBroadCol.value.copy(summerL).lerp(springB, clamp(spring * 0.8, 0, 1)).lerp(autumnL, clamp(autumn * 1.1, 0, 1));
  }
}
