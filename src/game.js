/* =====================================================================
   Game: owns the renderer, world streaming, player vehicle, cameras,
   traffic, weather, audio, navigation and UI, and runs the main loop.
   ===================================================================== */
import * as THREE from 'three';
import { Terrain } from './world/terrain.js';
import { CITY, latitudeAt, cityAt } from './world/geo.js';
import { ChunkManager } from './render/chunks.js';
import { Environment } from './render/env.js';
import { Water } from './render/water.js';
import { roadChunkJob } from './render/roadmesh.js';
import { setLandcoverExtras } from './render/landcover.js';
import { setMaxAnisotropy } from './render/textures.js';
import { envUniforms } from './render/terrainmesh.js';
import { buildingChunkJob, indexWorldContent, buildingEmissive } from './render/buildings.js';
import { vegetationChunkJob, indexParks } from './render/vegetation.js';
import { Props } from './render/props.js';
import { Traffic } from './traffic/traffic.js';
import { Weather } from './world/weather.js';
import { CollisionWorld } from './vehicle/collide.js';
import { PlayerCar } from './vehicle/playercar.js';
import { CameraRig } from './vehicle/cameras.js';
import { Cockpit } from './vehicle/cockpit.js';
import { Input } from './input/input.js';
import { settings, save, saveGame } from './core/settings.js';
import { clamp, lerp } from './core/math.js';

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: 0, ranges: [300, 650, 1300, 2300], budget: 4, antialias: false },
  medium: { pixelRatio: 1, shadows: 1, ranges: [380, 850, 1700, 3000], budget: 5, antialias: true },
  high: { pixelRatio: 1.25, shadows: 1, ranges: [420, 950, 1900, 3600], budget: 6, antialias: true },
  ultra: { pixelRatio: 1.5, shadows: 2, ranges: [480, 1100, 2300, 4200], budget: 8, antialias: true },
};

export class Game {
  constructor(world, opts = {}) {
    this.world = world;
    this.opts = opts;
    this.net = world.net;
    this.time = 0;
    this.paused = false;
    this.listeners = {};
    // quality
    let q = settings.quality;
    if (q === 'auto') q = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'low' : 'high';
    this.quality = QUALITY[q] || QUALITY.high;
    this.qualityName = q;
    const renderer = new THREE.WebGLRenderer({ antialias: this.quality.antialias, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio * (window.devicePixelRatio > 1 ? 1.25 : 1)));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = this.quality.shadows > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('app').appendChild(renderer.domElement);
    setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 12000);
    this.scene.add(this.camera);
    setLandcoverExtras(world);
    indexWorldContent(world);
    indexParks(world);
    this.terrain = new Terrain(world.net);
    world.terrain = this.terrain;
    this.env = new Environment(renderer, this.scene, { shadows: this.quality.shadows });
    this.water = new Water(this.scene);
    this.collision = new CollisionWorld();
    this.conditions = { wet: 0, snow: 0, snowGround: 0, ice: 0, frozen: 0, temp: 15 };
    const grp = (ch, st, name) => {
      ch.group.add(st.group); st.group.updateMatrixWorld(true);
      if (st.colliders && (name !== 'trees' || st.lod === 0)) this.collision.add(name + ':' + ch.cx + ':' + ch.cz, st.colliders);
      if (name === 'buildings' && this.parked) this.parked.addSpots(ch, st.carSpots || []);
    };
    const ungrp = (ch, st, name) => {
      ch.group.remove(st.group);
      st.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); else if (o.geometry && !o.userData.shared) o.geometry.dispose(); });
      this.collision.remove(name + ':' + ch.cx + ':' + ch.cz);
      if (name === 'buildings' && this.parked) this.parked.removeSpots(ch);
    };
    this.layers = [
      { name: 'roads', maxLod: 2, lodOf: (l) => (l <= 1 ? 1 : 0), job: (ch, lod, res) => roadChunkJob(world, ch.cx, ch.cz, lod, res), attach: (c, s) => grp(c, s, 'roads'), detach: (c, s) => ungrp(c, s, 'roads') },
      { name: 'buildings', maxLod: 2, lodOf: (l) => (l === 0 ? 0 : 1), job: (ch, lod, res) => buildingChunkJob(world, ch.cx, ch.cz, lod, res), attach: (c, s) => grp(c, s, 'buildings'), detach: (c, s) => ungrp(c, s, 'buildings') },
      { name: 'trees', maxLod: 2, lodOf: (l) => Math.min(l, 2), job: (ch, lod, res) => vegetationChunkJob(world, ch.cx, ch.cz, lod, res), attach: (c, s) => grp(c, s, 'trees'), detach: (c, s) => ungrp(c, s, 'trees') },
    ];
    this.props = new Props(this);
    this.layers.push({ name: 'props', maxLod: 1, lodOf: () => 0, job: (ch, lod, res) => this.props.job(ch, lod, res), attach: (c, s) => grp(c, s, 'props'), detach: (c, s) => ungrp(c, s, 'props') });
    this.chunks = new ChunkManager({ scene: this.scene, world, terrain: this.terrain, layers: this.layers, ranges: this.quality.ranges });
    this.chunks.budget = this.quality.budget;
    this.input = new Input(settings);
    this.rig = new CameraRig(this.camera);
    this.rig.fovBase = settings.fov;
    this.rig.setMode(settings.camera || 'cockpit');
    this.modules = []; // things with update(dt) hooks (traffic, audio, weather, hud...)
    this.weather = this.addModule(new Weather(this));
    this.traffic = this.addModule(new Traffic(this));
    this.season = 'summer';
    this.placeT = 0;
    this.clock = new THREE.Clock();
    this.fps = 60;
    this.frameMs = 16;
    addEventListener('resize', () => this.resize());
    this.mouseSetup();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { for (const f of this.listeners[ev] || []) f(...a); }
  addModule(m) { this.modules.push(m); return m; }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.emit('resize');
  }
  mouseSetup() {
    const el = this.renderer.domElement;
    let drag = false, lx = 0, ly = 0;
    el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && (e.button === 0 || e.button === 2)) { drag = true; lx = e.clientX; ly = e.clientY; this.rig.lookHeld = true; } });
    addEventListener('pointerup', () => { drag = false; this.rig.lookHeld = false; });
    addEventListener('pointermove', (e) => {
      if (!drag || this.paused) return;
      const s = 0.004 * settings.mouseSens;
      this.rig.look.yaw = clamp(this.rig.look.yaw - (e.clientX - lx) * s, -2.6, 2.6);
      this.rig.look.pitch = clamp(this.rig.look.pitch - (e.clientY - ly) * s * (settings.invertY ? -1 : 1), -0.9, 0.7);
      lx = e.clientX; ly = e.clientY;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { this.rig.fovBase = clamp(this.rig.fovBase + Math.sign(e.deltaY) * 2, 40, 90); }, { passive: true });
  }

  /* --------------------------- session setup --------------------------- */
  setDateTime(day, clock) { this.env.day = day; this.env.clock = clock; }
  spawnPlayer(carCfg, start) {
    if (this.player) this.player.dispose();
    this.player = new PlayerCar(this, carCfg);
    this.player.cockpit = new Cockpit(this.player, this);
    const pos = this.startPosition(start);
    this.player.place(pos.x, pos.z, pos.yaw, pos.y);
    this.emit('player', this.player);
    return this.player;
  }
  startPosition(start) {
    const r = start.road;
    const xs = r.xs;
    const d = xs.parkR > 0 ? xs.travelR + xs.parkR * 0.5 : xs.edgeR - 1.15;
    const p = this.net.pointAt(r, start.s, d);
    const i = Math.min(r.n - 2, Math.max(0, Math.round(start.s / 4)));
    const yaw = Math.atan2(-r.TX[i], -r.TZ[i]);
    return { x: p[0], z: p[2], y: p[1], yaw };
  }
  async preloadAround(x, z, onProgress) {
    const p = new THREE.Vector3(x, 0, z);
    this.water.update(p, 0, 0);
    await this.chunks.preload(p, 520, onProgress);
  }

  /* ------------------------------ loop ------------------------------ */
  start() {
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const t0 = performance.now();
      const dt = Math.min(0.1, this.clock.getDelta());
      this.frame(dt);
      this.frameMs = lerp(this.frameMs, performance.now() - t0, 0.05);
      this.fps = lerp(this.fps, 1 / Math.max(dt, 1e-3), 0.05);
    };
    requestAnimationFrame(loop);
  }
  frame(dt) {
    const input = this.input;
    input.update(dt);
    const A = input.actions, S = input.state;
    if (A.pause) this.emit('pause-toggle');
    if (A.map) this.emit('map-toggle');
    if (A.help) this.emit('help');
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const simDt = dt * (this.timeScale || 1);
    this.time += dt;
    this.env.clock = (this.env.clock + simDt * (this.clockScale ?? 1) / 3600) % 24;
    if (this.env.clock < 0) this.env.clock += 24;
    const P = this.player;
    if (P) {
      this.handleActions(A, S);
      const inp = {
        throttle: S.throttle, brake: S.brake, steer: S.steer, handbrake: S.handbrake, clutch: S.clutch,
        ignition: A.ignition, shiftUp: A.shiftUp, shiftDown: A.shiftDown, select: A.park ? 'P' : A.reverse ? 'R' : A.neutral ? 'N' : A.drive ? 'D' : null,
        steerAssist: settings.steerAssist && S.steerAssist, directSteer: S.directSteer, arcadePedals: !S.directSteer && settings.trans !== 'manual-sim',
      };
      if (this.inputOverride) Object.assign(inp, this.inputOverride(dt, this));
      P.horn = S.horn;
      P.update(dt, inp);
      this.rig.lookBack = S.lookBack;
      if (S.lookKey) { this.rig.lookHeld = true; this.rig.look.yaw = clamp(this.rig.look.yaw + -S.lookKey * dt * 3, -1.6, 1.6); }
      else if (!this.mouseDrag) this.rig.lookHeld = false;
      if (S.padLook) { this.rig.lookHeld = true; this.rig.look.yaw = -S.padLook[0] * 1.8; this.rig.look.pitch = -S.padLook[1] * 0.6; }
      if (this.rig.fixedView) {
        const v = this.rig.fixedView, P0 = P.phys.p;
        this.camera.position.set(P0[0] + v[0], P0[1] + v[1], P0[2] + v[2]);
        this.camera.rotation.set(v[4] * Math.PI / 180, v[3] * Math.PI / 180, 0, 'YXZ');
      } else if (this.rig.orbitMode) {
        const c = P.mesh.group.position;
        this.rig.orbitAround(dt, { x: c.x, y: c.y, z: c.z }, this.rig.orbitAuto !== false);
      } else this.rig.update(dt, P, this);
      const inside = this.rig.mode === 'cockpit' && !this.rig.orbitMode && !this.rig.fixedView;
      P.cockpit.setVisible(inside);
      if (inside) P.cockpit.update(dt, this);
      // latitude follows the player for sun position & daylight
      this.env.lat = latitudeAt(P.phys.p[0], P.phys.p[2]);
      this.placeT -= dt;
      if (this.placeT <= 0) { this.placeT = 1; this.updatePlace(); }
    }
    for (const m of this.modules) if (m.update) m.update(dt, this);
    this.props.update(dt, this);
    for (const sg of this.world.signals) sg.update(simDt);
    const cp = this.camera.position;
    this.env.update(simDt, cp);
    buildingEmissive.value = clamp(this.env.night * 1.4 + (1 - this.env.daylight) * 0.6, 0, 1.4);
    this.water.update(cp, dt, this.env.time);
    this.chunks.update(cp);
    this.render();
  }
  render() {
    if (this.noRender) return;
    for (const m of this.modules) if (m.beforeRender) m.beforeRender(this);
    const P = this.player;
    if (P && P.cockpit && P.cockpit.group.visible && this.qualityName !== 'low') P.cockpit.renderMirrors(this.renderer, this.scene);
    this.renderer.render(this.scene, this.camera);
  }

  handleActions(A, S) {
    const P = this.player;
    if (A.camera) { this.rig.cycle(); settings.camera = this.rig.mode; this.emit('camera', this.rig.mode); }
    if (A.cam1) this.rig.setMode('cockpit'); if (A.cam2) this.rig.setMode('hood'); if (A.cam3) this.rig.setMode('chase'); if (A.cam4) this.rig.setMode('cinematic');
    if (A.indLeft) P.indicator = P.indicator === -1 ? 0 : -1, P.indSteerPeak = 0, this.emit('indicator', P.indicator);
    if (A.indRight) P.indicator = P.indicator === 1 ? 0 : 1, P.indSteerPeak = 0, this.emit('indicator', P.indicator);
    if (A.hazard) P.indicator = P.indicator === 2 ? 0 : 2, this.emit('indicator', P.indicator);
    if (A.lights) { const order = ['auto', 'low', 'off']; P.lightMode = order[(order.indexOf(P.lightMode === 'high' ? 'low' : P.lightMode) + 1) % order.length]; this.emit('lights', P.lightMode); }
    if (A.highBeam) { P.lightMode = P.lightMode === 'high' ? 'low' : 'high'; this.emit('lights', P.lightMode); }
    if (A.wipers) { P.wiper = (P.wiper + 1) % 4; this.emit('wipers', P.wiper); }
    if (A.cruise) {
      if (P.cruise != null) P.cruise = null;
      else if (P.phys.fwdSpeed > 8) { P.cruise = P.phys.fwdSpeed; P.cruiseI = 0; }
      this.emit('cruise', P.cruise);
    }
    if (A.reset) this.emit('reset-request');
    if (A.interact) this.emit('interact');
    if (A.gps) this.emit('gps');
  }

  updatePlace() {
    const p = this.player.phys.p;
    const c = cityAt(p[0], p[2], 150);
    let name = null, kind = 'rural';
    if (c) { name = c.name; kind = 'city'; }
    else {
      let best = null, bd = 900;
      for (const pl of this.world.places) {
        if (pl.kind === 'city') continue;
        const d = Math.hypot(pl.x - p[0], pl.z - p[2]);
        if (d < bd) { bd = d; best = pl; }
      }
      if (best) { name = best.name; kind = bd < 450 ? 'village' : 'rural'; }
    }
    if (name !== this.placeName) { const prev = this.placeName; this.placeName = name; this.placeKind = kind; if (name && prev !== undefined) this.emit('place', name, kind); }
    this.placeKind = kind;
  }
  resetToRoad(target) {
    const P = this.player;
    const p = target || P.phys.p;
    // nearest road lane
    let best = null, bd = Infinity;
    const r0 = 300;
    for (const r of this.net.roads) {
      if (r.lanePathsF.length === 0 && r.lanePathsB.length === 0) continue;
      if (Math.abs(r.X[0] - p[0]) > 3000 && Math.abs(r.X[r.n - 1] - p[0]) > 3000) continue;
      for (let i = 0; i < r.n; i += 3) {
        const d = Math.hypot(r.X[i] - p[0], r.Z[i] - p[2]);
        if (d < bd && r.S[i] > r.trimA + 5 && r.S[i] < r.len - r.trimB - 5) { bd = d; best = { r, i }; }
      }
    }
    if (!best) return;
    const r = best.r;
    const lane = r.lanePathsF[r.lanePathsF.length - 1] ? r.xs.lanesOffF[r.xs.lanesF - 1] : r.xs.lanesOffB[0];
    const fwdLane = r.xs.lanesF > 0;
    const pt = this.net.pointAt(r, r.S[best.i], lane);
    let yaw = Math.atan2(-r.TX[best.i], -r.TZ[best.i]);
    if (!fwdLane) yaw += Math.PI;
    P.place(pt[0], pt[2], yaw, pt[1]);
    P.cruise = null;
    this.emit('reset');
  }
}
