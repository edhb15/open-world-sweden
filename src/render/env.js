/* =====================================================================
   Environment: sun/moon lights, sky, fog, environment reflections.
   Driven by date, clock, latitude and weather.
   ===================================================================== */
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { Sky, sunDirection, moonDirection, moonPhase } from './sky.js';
import { envUniforms } from './terrainmesh.js';

export class Environment {
  constructor(renderer, scene, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = new Sky();
    scene.add(this.sky.mesh);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = quality.shadows > 0;
    const ss = quality.shadows > 1 ? 4096 : 2048;
    this.sun.shadow.mapSize.set(ss, ss);
    this.shadowExtent = quality.shadows > 1 ? 110 : 80;
    const sc = this.sun.shadow.camera;
    sc.left = -this.shadowExtent; sc.right = this.shadowExtent; sc.top = this.shadowExtent; sc.bottom = -this.shadowExtent;
    sc.near = 1; sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4436, 1.0);
    scene.add(this.hemi);
    this.fog = new THREE.FogExp2(0xa8b8c8, 0.00025);
    scene.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.mesh.scale.setScalar(100);
    this.envScene.add(this.envSky.mesh);
    this.envRT = null;
    this.envTimer = 0;
    this.lastEnvSun = new THREE.Vector3(0, -2, 0);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.lat = 59.3;
    this.day = 172;
    this.clock = 12;
    this.time = 0;
    this.weather = { cloud: 0.25, overcast: 0, fog: 0, rain: 0, snow: 0, storm: 0, wind: 0.3 };
    this.aurora = 0;
    this.night = 0;
    this.daylight = 1;
    this.fogColor = new THREE.Color();
  }
  update(dt, cam) {
    this.time += dt;
    this.sky.mesh.position.copy(cam);
    sunDirection(this.lat, this.day, this.clock, this.sunDir);
    moonDirection(this.lat, this.day, this.clock, this.moonDir);
    const W = this.weather;
    const sunE = this.sunDir.y;
    const day = smoothstep(-0.1, 0.18, sunE);
    this.daylight = day;
    this.night = 1 - smoothstep(-0.16, 0.02, sunE);
    const cloudDim = 1 - 0.72 * W.overcast - 0.25 * W.cloud * (1 - W.overcast);
    // sun colour: warm when low
    const warm = 1 - smoothstep(0.02, 0.35, sunE);
    const sunCol = new THREE.Color().setRGB(1, lerp(0.96, 0.62, warm), lerp(0.9, 0.38, warm));
    const moonUp = smoothstep(-0.02, 0.1, this.moonDir.y);
    const ph = moonPhase(this.day);
    const moonBright = moonUp * (0.25 + 0.75 * Math.abs(Math.cos(ph * Math.PI * 2))) * (1 - W.overcast * 0.85);
    let lightDir;
    if (sunE > -0.04) {
      lightDir = this.sunDir;
      this.sun.color.copy(sunCol);
      this.sun.intensity = 3.4 * smoothstep(-0.04, 0.12, sunE) * cloudDim;
    } else {
      lightDir = this.moonDir.y > 0 ? this.moonDir : this.sunDir;
      this.sun.color.setRGB(0.55, 0.65, 0.95);
      this.sun.intensity = 0.16 * moonBright;
    }
    // snow cover brightens nights
    const snowGround = envUniforms.uSnow.value;
    const skyC = this.sky.horizonColor(sunE, Math.max(W.overcast, W.cloud * 0.5), new THREE.Color());
    const zen = new THREE.Color().setRGB(lerp(0.02, 0.32, day), lerp(0.03, 0.5, day), lerp(0.06, 0.85, day));
    zen.lerp(new THREE.Color(0.55, 0.58, 0.62).multiplyScalar(day * 0.9 + 0.05), W.overcast * 0.85);
    this.hemi.color.copy(zen);
    this.hemi.groundColor.setRGB(lerp(0.04, 0.32, day) + snowGround * 0.2 * day, lerp(0.04, 0.29, day) + snowGround * 0.22 * day, lerp(0.05, 0.22, day) + snowGround * 0.26 * day);
    this.hemi.intensity = lerp(0.22 + snowGround * 0.25 + moonBright * 0.12, 1.15, day) * (1 - W.storm * 0.3) + (this.lightning || 0) * 4;
    // fog
    const fogC = skyC.clone();
    if (W.overcast > 0 || W.fog > 0) fogC.lerp(new THREE.Color(0.62, 0.65, 0.68).multiplyScalar(lerp(0.05, 1, day)), Math.max(W.overcast * 0.7, W.fog));
    this.fogColor.copy(fogC);
    this.fog.color.copy(fogC);
    const baseDensity = 0.00011 + W.cloud * 0.00003;
    const dens = baseDensity + W.overcast * 0.00018 + W.rain * 0.0011 + W.snow * 0.0019 + W.fog * W.fog * 0.011;
    this.fog.density = dens;
    // sky uniforms
    const U = this.sky.uniforms;
    U.uSun.value.copy(this.sunDir);
    U.uMoon.value.copy(this.moonDir);
    U.uTime.value = this.time;
    U.uCloud.value = W.cloud;
    U.uOvercast.value = W.overcast;
    U.uCloudDark.value = Math.max(W.storm, W.rain * 0.6, W.snow * 0.3);
    U.uAurora.value = this.aurora;
    U.uMoonPhase.value = ph;
    U.uFogColor.value.copy(fogC);
    U.uFogMix.value = clamp(dens * 900, 0.1, 1);
    // shadow camera follows the viewer, snapped to texels
    const ext = this.shadowExtent;
    const ld = lightDir.clone();
    if (ld.y < 0.08) ld.y = 0.08;
    ld.normalize();
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const cx = Math.round(cam.x / texel) * texel, cz = Math.round(cam.z / texel) * texel;
    this.sun.target.position.set(cx, cam.y, cz);
    this.sun.position.set(cx + ld.x * 400, cam.y + ld.y * 400, cz + ld.z * 400);
    this.sun.target.updateMatrixWorld();
    this.sun.castShadow = this.sun.intensity > 0.08 && this.shadowsEnabled !== false;
    // environment map refresh
    this.envTimer -= dt;
    if (this.envTimer <= 0 || this.lastEnvSun.distanceTo(this.sunDir) > 0.03) {
      this.refreshEnv();
      this.envTimer = 6;
    }
    envUniforms.uTime.value = this.time;
    envUniforms.uNight.value = this.night;
    // tone exposure: brighter at night so it isn't pitch black
    this.renderer.toneMappingExposure = lerp(1.55, 0.95, day) * (1 + W.overcast * 0.15);
  }
  refreshEnv() {
    const U = this.envSky.uniforms, S = this.sky.uniforms;
    for (const k in S) { if (S[k].value && S[k].value.copy) U[k].value.copy(S[k].value); else U[k].value = S[k].value; }
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = lerp(0.12, 0.9, this.daylight) * (1 - this.weather.overcast * 0.3);
    this.lastEnvSun.copy(this.sunDir);
  }
}
