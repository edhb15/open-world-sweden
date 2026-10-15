/* =====================================================================
   Chunk streaming with LOD rings and a time-sliced job queue.
   Each chunk owns a terrain mesh (rebuilt when its LOD changes) and any
   number of content layers (roads, buildings, vegetation, props).
   ===================================================================== */
import * as THREE from 'three';
import { CHUNK } from '../world/terrain.js';
import { terrainChunkJob, terrainMaterial } from './terrainmesh.js';

const now = () => performance.now();

export class ChunkManager {
  constructor({ scene, world, terrain, layers = [], ranges }) {
    this.scene = scene;
    this.world = world;
    this.terrain = terrain;
    this.layers = layers;
    this.ranges = ranges || [420, 950, 1900, 3600];
    this.chunks = new Map();
    this.queue = [];
    this.active = null;
    this.mat = terrainMaterial();
    this.budget = 6; // ms per frame
    this.stats = { jobs: 0, chunks: 0 };
    this.onChunkReady = null;
  }
  key(cx, cz) { return cx * 100003 + cz; }
  chunkDist(cx, cz, p) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const dx = Math.max(x0 - p.x, 0, p.x - (x0 + CHUNK));
    const dz = Math.max(z0 - p.z, 0, p.z - (z0 + CHUNK));
    return Math.hypot(dx, dz);
  }
  wantLod(d, cur) {
    const R = this.ranges;
    const hy = 30;
    for (let L = 0; L < R.length; L++) {
      const lim = R[L] + (cur >= 0 && cur <= L ? hy : -hy * 0);
      if (d < lim) return L;
    }
    return -1;
  }
  update(p, focus = null) {
    const R = this.ranges[this.ranges.length - 1];
    const c0x = Math.floor((p.x - R) / CHUNK), c1x = Math.floor((p.x + R) / CHUNK);
    const c0z = Math.floor((p.z - R) / CHUNK), c1z = Math.floor((p.z + R) / CHUNK);
    const seen = new Set();
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const d = this.chunkDist(cx, cz, p);
      const k = this.key(cx, cz);
      let ch = this.chunks.get(k);
      const want = this.wantLod(d, ch ? ch.lod : -1);
      if (want < 0) continue;
      seen.add(k);
      if (!ch) {
        ch = { cx, cz, lod: -1, want, group: new THREE.Group(), terrainMesh: null, layers: {}, pend: {}, d };
        ch.group.position.set(cx * CHUNK, 0, cz * CHUNK);
        ch.group.updateMatrixWorld(true);
        ch.group.matrixAutoUpdate = false;
        this.scene.add(ch.group);
        this.chunks.set(k, ch);
      }
      ch.want = want; ch.d = d;
      if (ch.lod !== want && !ch.pend.terrain) this.enqueue(ch, 'terrain', want, d);
      for (const L of this.layers) {
        const st = ch.layers[L.name];
        const need = want <= L.maxLod;
        const lodWanted = L.lodOf ? L.lodOf(want) : 0;
        if (need && (!st || st.lod !== lodWanted) && !ch.pend[L.name]) this.enqueue(ch, L.name, lodWanted, d, L);
        if (!need && st && want > L.maxLod) { L.detach(ch, st); delete ch.layers[L.name]; }
      }
    }
    for (const [k, ch] of this.chunks) {
      if (seen.has(k)) continue;
      this.disposeChunk(ch);
      this.chunks.delete(k);
    }
    this.queue.sort((a, b) => a.prio - b.prio);
    this.runJobs(this.budget);
    this.stats.chunks = this.chunks.size;
  }
  enqueue(ch, kind, lod, d, layer = null) {
    const prio = d + (kind === 'terrain' ? 0 : 60) + lod * 120 + (kind === 'terrain' && ch.lod < 0 ? -200 : 0);
    const job = { ch, kind, lod, prio, layer, gen: null, result: {} };
    ch.pend[kind] = job;
    this.queue.push(job);
  }
  runJobs(budget) {
    const t0 = now();
    while (now() - t0 < budget) {
      const job = this.active || this.queue.shift();
      if (!job) break;
      this.active = job;
      const ch = job.ch;
      if (!this.chunks.has(this.key(ch.cx, ch.cz))) { this.active = null; continue; }
      if (!job.gen) {
        if (job.kind === 'terrain') job.gen = terrainChunkJob(this.terrain, ch.cx, ch.cz, job.lod, job.result);
        else job.gen = job.layer.job(ch, job.lod, job.result);
      }
      let done = false;
      while (now() - t0 < budget) {
        const r = job.gen.next();
        if (r.done) { done = true; break; }
      }
      if (!done) break;
      this.active = null;
      this.stats.jobs++;
      delete ch.pend[job.kind];
      if (job.kind === 'terrain') this.applyTerrain(ch, job);
      else {
        const old = ch.layers[job.kind];
        if (old) job.layer.detach(ch, old);
        ch.layers[job.kind] = { lod: job.lod, ...job.result };
        job.layer.attach(ch, ch.layers[job.kind]);
      }
      if (this.onChunkReady) this.onChunkReady(ch, job.kind);
    }
  }
  applyTerrain(ch, job) {
    if (ch.terrainMesh) {
      ch.group.remove(ch.terrainMesh);
      ch.terrainMesh.geometry.dispose();
    }
    const m = new THREE.Mesh(job.result.geometry, this.mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    ch.group.add(m);
    ch.group.updateMatrixWorld(true);
    ch.terrainMesh = m;
    if (ch.lod === 0 && job.lod !== 0) this.terrain.dropField(ch.cx, ch.cz);
    ch.lod = job.lod;
    if (job.result.field) this.terrain.setField(ch.cx, ch.cz, job.result.field);
    ch.minY = job.result.minY; ch.maxY = job.result.maxY;
  }
  disposeChunk(ch) {
    for (const L of this.layers) { const st = ch.layers[L.name]; if (st) L.detach(ch, st); }
    if (ch.terrainMesh) ch.terrainMesh.geometry.dispose();
    if (ch.lod === 0) this.terrain.dropField(ch.cx, ch.cz);
    this.scene.remove(ch.group);
    for (const k in ch.pend) { const j = ch.pend[k]; const i = this.queue.indexOf(j); if (i >= 0) this.queue.splice(i, 1); }
  }
  // Synchronously build everything near p (loading screen)
  async preload(p, radius, onProgress) {
    const saved = this.ranges.slice();
    this.update(p);
    let guard = 0;
    for (;;) {
      const pending = this.queue.filter((j) => j.ch.d < radius).length + (this.active && this.active.ch.d < radius ? 1 : 0);
      if (!pending || guard++ > 4000) break;
      this.runJobs(40);
      this.queue.sort((a, b) => a.prio - b.prio);
      if (onProgress) onProgress(pending);
      await new Promise((r) => setTimeout(r, 0));
      this.update(p);
    }
    this.ranges = saved;
  }
  isReady(p, radius) {
    for (const j of this.queue) if (j.ch.d < radius) return false;
    if (this.active && this.active.ch.d < radius) return false;
    return true;
  }
  clearAll() {
    for (const ch of this.chunks.values()) this.disposeChunk(ch);
    this.chunks.clear();
    this.queue.length = 0;
    this.active = null;
  }
}
