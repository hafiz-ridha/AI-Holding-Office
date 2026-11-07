// Pixel office renderer (Canvas 2D only). Static layers are pre-rendered once per scene at logical resolution;
// each frame blits only the visible part and draws only visible characters. Frame rate adapts to what is
// actually happening (30 FPS while walking, ~10 FPS for typing/celebrating, 2 FPS when idle) and stops when hidden.
import { buildSheet, FW, FH } from './sprites.js';
import { T } from './scenes.js';

const SPEED = 44; // px/s
const FLOOR = { wood: 'floor_wood', woodb: 'floor_wood_b', tile: 'floor_tile', carpet: 'floor_carpet' };

function hexA(hex, a) {
  const n = parseInt(String(hex || '#888888').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class OfficeEngine {
  constructor(canvas, { atlas, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.atlas = atlas;
    this.onSelect = onSelect;
    this.chars = new Map();
    this.seatAlloc = new Map();
    this.visitorAlloc = new Map();
    this.scene = null;
    this.zoomLevel = null; // null = fit
    this.cam = { x: 0, y: 0 };
    this.running = false;
    this.visible = true;
    this.lastDraw = 0;
    this.selected = null;
    this.speech = new Map(); // employeeId -> { lines, until }: short speech bubbles for real chat messages
    this.bindInput();
  }

  // Show what an agent just said in the chat above its character for a few seconds.
  say(employeeId, text, ms = 7000) {
    const clean = String(text || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const short = clean.length > 70 ? `${clean.slice(0, 68)}…` : clean;
    const words = short.split(' ');
    const lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if ((cur + ' ' + w).trim().length > 28 && cur) {
        if (lines.length === 3) break;
        lines.push(w);
      } else lines[lines.length - 1] = (cur + ' ' + w).trim();
    }
    this.speech.set(employeeId, { lines, until: performance.now() + ms });
    this.draw(performance.now());
  }

  // ---------------- scene & data ----------------
  setScene(scene) {
    const changedScene = !this.scene || this.scene.id !== scene.id;
    this.scene = scene;
    this.bg = this.renderBackground(scene);
    if (changedScene) {
      this.chars.clear();
      this.seatAlloc.clear();
      this.visitorAlloc.clear();
      this.selected = null;
      this.zoomLevel = null;
      this.firstPlacement = true;
    }
    if (scene.business?.has_logo && !scene.logoImg) {
      const img = new Image();
      img.onload = () => {
        scene.logoImg = img;
        if (this.scene === scene) {
          this.bg = this.renderBackground(scene);
          this.draw(performance.now());
        }
      };
      img.src = `/api/businesses/${scene.business.id}/logo`;
    }
    this.resize();
  }

  renderBackground(s) {
    const W = s.mapW * T;
    const H = s.mapH * T;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const A = this.atlas;
    for (let y = 0; y < s.mapH; y++) for (let x = 0; x < s.mapW; x++) A.draw(g, 'floor_tile', x * T, y * T);
    for (const r of s.rooms) {
      const f = FLOOR[r.floor] || 'floor_wood';
      for (let y = r.y + 2; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) A.draw(g, f, x * T, y * T);
      if (r.tint) {
        g.fillStyle = hexA(r.tint, r.floor === 'carpet' ? 0.38 : 0.12);
        g.fillRect(r.x * T, (r.y + 2) * T, r.w * T, (r.h - 2) * T);
      }
    }
    // Rugs under desks rooms with a tint (identity color).
    for (const r of s.rooms) {
      if (!r.tint || r.kind !== 'desks' || r.floor === 'carpet') continue;
      g.fillStyle = hexA(r.tint, 0.22);
      g.fillRect(r.x * T + 8, (r.y + 4) * T - 8, r.w * T - 16, (r.h - 5) * T);
    }
    // Top walls with windows where no wall decoration hangs.
    for (const w of s.walls) {
      const r = w.room;
      const covered = (x) => w.deco.some((d) => x * T + T > d.x - 2 && x * T < d.x + A.size(d.f).w + 2);
      for (let x = r.x; x < r.x + r.w; x++) A.draw(g, (x - r.x) % 3 === 1 && !covered(x) ? 'wall_window' : 'wall', x * T, r.y * T);
      for (const d of w.deco) A.draw(g, d.f, d.x, d.y);
    }
    // Partitions + bottom walls with a door gap.
    g.fillStyle = '#6b5444';
    for (const r of s.rooms) {
      g.fillRect(r.x * T, r.y * T, 3, r.h * T);
      if (r.x + r.w === s.mapW) g.fillRect((r.x + r.w) * T - 3, r.y * T, 3, r.h * T);
      const by = (r.y + r.h) * T - 3;
      const doorL = r.door.x - T;
      g.fillRect(r.x * T, by, doorL - r.x * T, 3);
      g.fillRect(doorL + 2 * T, by, (r.x + r.w) * T - doorL - 2 * T, 3);
      g.fillStyle = '#8a6a50';
      g.fillRect(doorL, by + 1, 2 * T, 2);
      g.fillStyle = '#6b5444';
    }
    // Static props sorted by y.
    const statics = [...s.props.map((p) => ({ ...p, z: p.y + A.size(p.f).h }))];
    for (const d of [...s.desks, ...s.visitorDesks]) {
      statics.push({ f: d.frame, x: d.x, y: d.y, z: d.y + 20 });
      for (const m of d.monitors) statics.push({ f: 'monitor_off', x: m.x, y: m.y, z: d.y + 1 });
      if (d.flag) statics.push({ flag: d.flag, x: d.x - 6, y: d.y - 14, z: d.y });
    }
    statics.sort((a, b) => a.z - b.z);
    for (const p of statics) {
      if (p.flag) {
        A.draw(g, 'flag_pole', p.x, p.y);
        g.fillStyle = p.flag;
        g.fillRect(p.x + 2, p.y + 1, 7, 5);
      } else A.draw(g, p.f, p.x, p.y);
    }
    // Meeting table (9-slice).
    if (s.meeting) {
      const t = s.meeting.table;
      for (let y = 0; y < t.h; y += 8) {
        for (let x = 0; x < t.w; x += 8) {
          const v = y === 0 ? 't' : y + 8 >= t.h ? 'b' : '';
          const h = x === 0 ? 'l' : x + 8 >= t.w ? 'r' : '';
          A.draw(g, `tbl_${v + h || 'c'}`, t.x + x, t.y + y);
        }
      }
    }
    if (s.logoImg) {
      const r = s.rooms.find((x) => x.key === 'manager');
      if (r) {
        g.fillStyle = '#ffffff';
        g.fillRect(r.x * T + 2 * T - 1, r.y * T + 7, 22, 22);
        g.drawImage(s.logoImg, r.x * T + 2 * T, r.y * T + 8, 20, 20);
      }
    }
    return c;
  }

  // Map real state -> where the character should be and how it looks in THIS scene.
  setData(data) {
    if (!this.scene) return;
    const s = this.scene;
    const present = new Set();
    // Meeting seat allocation (stable while the meeting lasts).
    const ms = s.meeting.scope;
    const here = (m) => Boolean(m) && m.scope === ms.scope && (ms.scope === 'hq' || m.business_id === ms.business_id);
    for (const e of data.employees) {
      const desk = s.deskByOwner.get(e.id);
      const visitor = !desk && s.visitorFilter(e);
      if (!desk && !visitor) continue;
      if (e.state === 'off') continue;
      present.add(e.id);
      let d = desk;
      if (visitor) {
        if (!this.visitorAlloc.has(e.id)) {
          const used = new Set(this.visitorAlloc.values());
          const free = s.visitorDesks.findIndex((_, i) => !used.has(i));
          this.visitorAlloc.set(e.id, free);
        }
        d = s.visitorDesks[this.visitorAlloc.get(e.id)] || null;
      }
      const meetingHere = e.state === 'meeting' && here(e.meeting);
      let target;
      let pose;
      let bubble = null;
      let chairFrame = 'chair';
      let note = null;
      if (meetingHere) {
        if (e.meeting.leader) {
          target = s.meeting.leader;
          pose = 'stand';
          bubble = 'bub_meet';
        } else {
          if (!this.seatAlloc.has(e.id)) {
            const used = new Set(this.seatAlloc.values());
            this.seatAlloc.set(e.id, s.meeting.seats.findIndex((_, i) => !used.has(i)));
          }
          const seat = s.meeting.seats[this.seatAlloc.get(e.id)] || s.meeting.seats[0];
          target = seat;
          pose = seat.pose;
        }
      } else {
        this.seatAlloc.delete(e.id);
        if (!d) {
          const g = s.rooms.find((r) => r.key === 'guests') || s.rooms[0];
          d = { seat: { x: (g.x + g.w / 2) * T, y: (g.y + g.h - 2) * T }, stand: { x: (g.x + g.w / 2) * T, y: (g.y + g.h - 2) * T }, monitors: [] };
        }
        switch (e.state) {
          case 'working':
            target = d.seat; pose = 'sit_back'; bubble = 'type';
            break;
          case 'thinking':
            target = d.seat; pose = 'sit_back'; bubble = 'bub_think';
            break;
          case 'meeting':
            target = d.seat; pose = 'sit_back'; bubble = 'bub_meet';
            note = e.meeting?.scope === 'hq' ? 'Rapat di Kantor Pusat' : 'Rapat di kantor bisnis';
            break;
          case 'pending':
            target = d.seat; pose = 'sit_front'; bubble = 'bub_wait'; chairFrame = 'chair_back_n';
            break;
          case 'completed':
            target = d.stand; pose = 'jump'; bubble = 'bub_check';
            break;
          case 'error':
            target = d.stand; pose = 'stand'; bubble = 'bub_warn';
            break;
          default:
            target = d.stand; pose = 'stand';
        }
      }
      let c = this.chars.get(e.id);
      if (!c) {
        const spawn = this.firstPlacement ? target : s.entrance;
        c = { id: e.id, x: spawn.x, y: spawn.y, path: [], flip: false, walkPose: 'walk_down', phase: Math.random() * 3, room: this.roomAt(spawn) };
        this.chars.set(e.id, c);
        if (!this.firstPlacement) c.path = this.route(c, target);
      }
      const avKey = JSON.stringify(e.avatar);
      if (c.avKey !== avKey) {
        c.avKey = avKey;
        c.sheet = buildSheet(e.avatar);
      }
      if (c.tx !== Math.round(target.x) || c.ty !== Math.round(target.y)) {
        c.tx = Math.round(target.x);
        c.ty = Math.round(target.y);
        if (!(this.firstPlacement && c.x === target.x && c.y === target.y)) c.path = this.route(c, { x: c.tx, y: c.ty });
      }
      Object.assign(c, { e, desk: d, pose, bubble, chairFrame: target === d?.seat ? chairFrame : null, note, meetingSeat: meetingHere && target !== s.meeting.leader ? target : null });
    }
    for (const id of [...this.chars.keys()]) {
      if (!present.has(id)) {
        this.chars.delete(id);
        this.visitorAlloc.delete(id);
        this.seatAlloc.delete(id);
      }
    }
    this.firstPlacement = false;
    this.data = data;
    if (this.selected?.type === 'employee' && !this.chars.has(this.selected.id)) this.selected = null;
  }

  roomAt(p) {
    return this.scene.rooms.find((r) => p.x >= r.x * T && p.x < (r.x + r.w) * T && p.y >= r.y * T && p.y < (r.y + r.h) * T) || null;
  }

  route(c, target) {
    const s = this.scene;
    const from = this.roomAt(c);
    const to = this.roomAt(target);
    if (from && to && from === to) return [{ x: target.x, y: target.y }];
    const path = [];
    let corY;
    if (from) {
      path.push({ x: from.door.x, y: from.door.y }, { x: from.door.x, y: from.door.corridorY });
      corY = from.door.corridorY;
    } else {
      corY = c.y;
    }
    if (to) {
      if (to.door.corridorY !== corY) path.push({ x: s.hallX, y: corY }, { x: s.hallX, y: to.door.corridorY });
      path.push({ x: to.door.x, y: to.door.corridorY }, { x: to.door.x, y: to.door.y });
    }
    path.push({ x: target.x, y: target.y });
    return path;
  }

  // ---------------- camera ----------------
  resize() {
    if (!this.scene) return;
    const wrap = this.canvas.parentElement;
    const cssW = wrap.clientWidth || 640;
    const worldW = this.scene.mapW * T;
    const worldH = this.scene.mapH * T;
    const fit = cssW / worldW;
    const minScale = Math.max(0.5, Math.min(1, fit));
    this.scale = this.zoomLevel ?? Math.max(fit, window.innerWidth < 700 ? 1 : fit);
    this.scale = Math.min(4, Math.max(minScale, this.scale));
    const maxH = Math.round(window.innerHeight * 0.72);
    const cssH = Math.min(Math.round(worldH * this.scale), maxH);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.clampCam();
    this.draw(performance.now());
  }

  clampCam() {
    const vw = this.cssW / this.scale;
    const vh = this.cssH / this.scale;
    const W = this.scene.mapW * T;
    const H = this.scene.mapH * T;
    this.cam.x = vw >= W ? (W - vw) / 2 : Math.min(Math.max(0, this.cam.x), W - vw);
    this.cam.y = vh >= H ? (H - vh) / 2 : Math.min(Math.max(0, this.cam.y), H - vh);
  }

  zoom(factor) {
    if (!this.scene) return;
    const cx = this.cam.x + this.cssW / this.scale / 2;
    const cy = this.cam.y + this.cssH / this.scale / 2;
    this.zoomLevel = Math.min(4, Math.max(0.5, (this.zoomLevel ?? this.scale) * factor));
    this.resize();
    this.cam.x = cx - this.cssW / this.scale / 2;
    this.cam.y = cy - this.cssH / this.scale / 2;
    this.clampCam();
    this.draw(performance.now());
  }

  fit() {
    this.zoomLevel = null;
    this.cam = { x: 0, y: 0 };
    this.resize();
  }

  focusOn(x, y) {
    this.cam.x = x - this.cssW / this.scale / 2;
    this.cam.y = y - this.cssH / this.scale / 2;
    this.clampCam();
  }

  // ---------------- loop ----------------
  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const walking = this.update(dt);
      let interval = 500; // idle: 2 FPS (breathing)
      if (walking) interval = 1000 / 30;
      else if (this.anyVisible((c) => ['working', 'completed'].includes(c.e.state))) interval = 100;
      else if (this.speech.size) interval = 250;
      if (t - this.lastDraw >= interval) {
        this.lastDraw = t;
        this.draw(t);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  isVisibleWorld(x, y, m = 32) {
    const vw = this.cssW / this.scale;
    const vh = this.cssH / this.scale;
    return x > this.cam.x - m && x < this.cam.x + vw + m && y > this.cam.y - m && y < this.cam.y + vh + m;
  }

  anyVisible(fn) {
    for (const c of this.chars.values()) if (c.e && fn(c) && this.isVisibleWorld(c.x, c.y)) return true;
    return false;
  }

  update(dt) {
    let moving = false;
    for (const c of this.chars.values()) {
      if (!c.path.length) continue;
      const wp = c.path[0];
      const dx = wp.x - c.x;
      const dy = wp.y - c.y;
      const d = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (d <= step) {
        c.x = wp.x;
        c.y = wp.y;
        c.path.shift();
        if (!c.path.length) c.room = this.roomAt(c);
      } else {
        c.x += (dx / d) * step;
        c.y += (dy / d) * step;
      }
      if (Math.abs(dx) > Math.abs(dy)) {
        c.walkPose = 'walk_side';
        c.flip = dx < 0;
      } else c.walkPose = dy < 0 ? 'walk_up' : 'walk_down';
      if (this.isVisibleWorld(c.x, c.y)) moving = true;
    }
    return moving;
  }

  draw(t) {
    if (!this.scene || !this.bg) return;
    const ctx = this.ctx;
    const A = this.atlas;
    const S = this.scale * this.dpr;
    const sec = t / 1000;
    const vw = this.cssW / this.scale;
    const vh = this.cssH / this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2a2a35';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(S, 0, 0, S, -this.cam.x * S, -this.cam.y * S);
    ctx.imageSmoothingEnabled = false;
    // Visible part of the pre-rendered background only.
    const sx = Math.max(0, Math.floor(this.cam.x));
    const sy = Math.max(0, Math.floor(this.cam.y));
    const sw = Math.min(this.bg.width - sx, Math.ceil(vw) + 2);
    const sh = Math.min(this.bg.height - sy, Math.ceil(vh) + 2);
    if (sw > 0 && sh > 0) ctx.drawImage(this.bg, sx, sy, sw, sh, sx, sy, sw, sh);

    // Dynamic layer: monitors, chairs, characters (z-sorted), visible ones only.
    const items = [];
    for (const c of this.chars.values()) {
      if (!c.e || !this.isVisibleWorld(c.x, c.y)) continue;
      const seated = !c.path.length && (c.pose === 'sit_back' || c.pose === 'sit_front');
      if (c.desk?.monitors && !c.path.length && (c.e.state === 'working' || c.e.state === 'thinking') && c.desk.seat && c.x === c.desk.seat.x) {
        for (const m of c.desk.monitors) items.push({ z: c.desk.y + 2, draw: () => A.draw(ctx, c.e.state === 'working' ? `monitor_on_${Math.floor(sec * 2) % 2}` : 'monitor_on_0', m.x, m.y) });
      }
      if (seated && c.meetingSeat?.chair) {
        const ch = c.meetingSeat.chair;
        items.push({ z: ch.f === 'chair' ? c.y + 1 : c.y - 30, draw: () => A.draw(ctx, ch.f, ch.x, ch.y) });
      } else if (seated && c.chairFrame && c.desk?.chair) {
        const ch = c.desk.chair;
        items.push({ z: c.chairFrame === 'chair' ? c.y + 1 : c.y - 30, draw: () => A.draw(ctx, c.chairFrame, ch.x, ch.y) });
      }
      items.push({ z: c.y, c });
    }
    // Empty chairs (desks whose owner is not seated) are part of the scene too.
    for (const d of [...this.scene.desks, ...this.scene.visitorDesks]) {
      if (!this.isVisibleWorld(d.chair.x, d.chair.y)) continue;
      const occ = [...this.chars.values()].some((c) => c.desk === d && !c.path.length && (c.pose === 'sit_back' || c.pose === 'sit_front') && c.x === d.seat.x);
      if (!occ) items.push({ z: d.chair.y + 14, draw: () => A.draw(ctx, 'chair', d.chair.x, d.chair.y) });
    }
    for (const seat of this.scene.meeting?.seats || []) {
      const occ = [...this.chars.values()].some((c) => c.meetingSeat === seat && !c.path.length);
      if (!occ && this.isVisibleWorld(seat.x, seat.y)) items.push({ z: seat.chair.f === 'chair' ? seat.chair.y + 14 : seat.chair.y, draw: () => A.draw(ctx, seat.chair.f, seat.chair.x, seat.chair.y) });
    }
    items.sort((a, b) => a.z - b.z);
    for (const it of items) {
      if (it.draw) it.draw();
      else this.drawChar(ctx, it.c, sec);
    }
    // Bubbles on top.
    for (const c of this.chars.values()) {
      if (!c.e || c.path.length || !c.bubble || !this.isVisibleWorld(c.x, c.y)) continue;
      const name = c.bubble === 'type' ? `bub_type_${Math.floor(sec * 3) % 3}` : c.bubble;
      const by = c.y - FH - (c.pose === 'sit_back' || c.pose === 'sit_front' ? 9 : 13) - (c.pose === 'jump' ? 3 : 0);
      A.draw(ctx, name, c.x + 3, by);
      if (c.e.state === 'completed') A.draw(ctx, `sparkle_${Math.floor(sec * 3) % 2}`, c.x - 13, c.y - FH + 2);
    }
    // Selection outline.
    if (this.selected) {
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 1.5 / this.scale;
      const r = this.selectedRect();
      if (r) ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    }
    // Screen-space text: room signs and names (crisp at any zoom).
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const toScreen = (x, y) => [(x - this.cam.x) * this.scale, (y - this.cam.y) * this.scale];
    const fs = Math.max(10, Math.min(13, 5.2 * this.scale));
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const r of this.scene.rooms) {
      const [x, y] = toScreen(r.x * T + 6, (r.y + 2) * T + 7);
      if (x > this.cssW || y > this.cssH || y < -20) continue;
      const w = ctx.measureText(r.name).width + 12;
      ctx.fillStyle = 'rgba(30,26,34,0.78)';
      ctx.fillRect(x, y - fs * 0.75, w, fs * 1.5);
      ctx.fillStyle = r.tint || '#e8d9b8';
      ctx.fillRect(x, y - fs * 0.75, 3, fs * 1.5);
      ctx.fillStyle = '#fff';
      ctx.fillText(r.name, x + 7, y);
    }
    if (this.scale >= 0.9) {
      ctx.textAlign = 'center';
      const nfs = Math.max(9, Math.min(12, 4.4 * this.scale));
      ctx.font = `600 ${nfs}px system-ui, sans-serif`;
      for (const c of this.chars.values()) {
        if (!c.e || !this.isVisibleWorld(c.x, c.y)) continue;
        const [x, y] = toScreen(c.x, c.y + 6);
        const label = c.e.name.split(' ')[0];
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = this.selected?.type === 'employee' && this.selected.id === c.id ? 'rgba(31,95,191,0.92)' : 'rgba(20,22,30,0.66)';
        ctx.fillRect(Math.round(x - w / 2), Math.round(y - nfs * 0.65), Math.round(w), Math.round(nfs * 1.3));
        ctx.fillStyle = '#fff';
        ctx.fillText(label, Math.round(x), Math.round(y));
      }
      ctx.textAlign = 'start';
    }
    this.drawSpeech(ctx, toScreen, t);
  }

  drawSpeech(ctx, toScreen, t) {
    if (!this.speech.size) return;
    const fs = Math.max(10, Math.min(12, 4.6 * this.scale));
    ctx.font = `500 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (const [id, sp] of this.speech) {
      if (sp.until < t) {
        this.speech.delete(id);
        continue;
      }
      const c = this.chars.get(id);
      if (!c || !this.isVisibleWorld(c.x, c.y)) continue;
      const lh = fs * 1.25;
      const w = Math.max(...sp.lines.map((l) => ctx.measureText(l).width)) + 14;
      const hgt = sp.lines.length * lh + 10;
      const [cx, cy] = toScreen(c.x, c.y - FH - 14);
      const x = Math.round(Math.min(Math.max(4, cx - w / 2), this.cssW - w - 4));
      const y = Math.round(Math.max(4, cy - hgt));
      ctx.fillStyle = 'rgba(46,42,51,0.9)';
      ctx.fillRect(x - 1, y - 1, w + 2, hgt + 2);
      ctx.fillStyle = '#fffdf5';
      ctx.fillRect(x, y, w, hgt);
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) - 5, y + hgt);
      ctx.lineTo(Math.round(cx) + 5, y + hgt);
      ctx.lineTo(Math.round(cx), y + hgt + 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1f2937';
      sp.lines.forEach((l, i) => ctx.fillText(l, x + 7, y + 5 + i * lh));
    }
    ctx.textBaseline = 'middle';
  }

  drawChar(ctx, c, sec) {
    let pose = c.path.length ? c.walkPose : c.pose;
    let fps = 1;
    if (c.path.length) fps = 8;
    else if (pose === 'sit_back') fps = c.e.state === 'working' ? 5 : 0;
    else if (pose === 'jump') fps = 3;
    else if (pose === 'sit_front') fps = 0.5;
    const frame = fps ? Math.floor((sec + c.phase) * fps) : 0;
    const [sx, sy] = c.sheet.frame(pose, frame);
    const x = Math.round(c.x - FW / 2);
    const y = Math.round(c.y - FH);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(Math.round(c.x - 5), Math.round(c.y - 1), 10, 2);
    if (c.flip && pose === 'walk_side') {
      ctx.save();
      ctx.translate(x + FW, y);
      ctx.scale(-1, 1);
      ctx.drawImage(c.sheet.canvas, sx, sy, FW, FH + 2, 0, 0, FW, FH + 2);
      ctx.restore();
    } else ctx.drawImage(c.sheet.canvas, sx, sy, FW, FH + 2, x, y, FW, FH + 2);
    c.box = { x, y, w: FW, h: FH + 2 };
  }

  selectedRect() {
    const s = this.selected;
    if (s.type === 'employee') return this.chars.get(s.id)?.box || null;
    if (s.type === 'desk') return s.desk.rect;
    if (s.type === 'meeting') return this.scene.meeting.rect;
    return null;
  }

  // ---------------- input ----------------
  bindInput() {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (drag.moved) {
        this.cam.x = drag.cx - dx / this.scale;
        this.cam.y = drag.cy - dy / this.scale;
        this.clampCam();
        this.draw(performance.now());
      }
    });
    cv.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.click(e);
      drag = null;
    });
    cv.addEventListener('pointercancel', () => (drag = null));
    cv.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return; // plain wheel keeps scrolling the page
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    cv.addEventListener('keydown', (e) => {
      const step = 32;
      if (e.key === 'ArrowLeft') this.cam.x -= step;
      else if (e.key === 'ArrowRight') this.cam.x += step;
      else if (e.key === 'ArrowUp') this.cam.y -= step;
      else if (e.key === 'ArrowDown') this.cam.y += step;
      else if (e.key === '+' || e.key === '=') return this.zoom(1.25);
      else if (e.key === '-') return this.zoom(0.8);
      else return;
      e.preventDefault();
      this.clampCam();
      this.draw(performance.now());
    });
  }

  click(ev) {
    if (!this.scene) return;
    const rect = this.canvas.getBoundingClientRect();
    const wx = this.cam.x + (ev.clientX - rect.left) / this.scale;
    const wy = this.cam.y + (ev.clientY - rect.top) / this.scale;
    const inside = (r, pad = 0) => r && wx >= r.x - pad && wx <= r.x + r.w + pad && wy >= r.y - pad && wy <= r.y + r.h + pad;
    let hit = null;
    for (const c of this.chars.values()) if (inside(c.box, 3)) hit = { type: 'employee', id: c.id, employee: c.e };
    if (!hit) {
      const d = [...this.scene.desks, ...this.scene.visitorDesks].find((x) => inside(x.rect));
      if (d) {
        const occupant = [...this.chars.values()].find((c) => c.desk === d);
        const ownerId = d.owner ?? occupant?.id ?? null;
        if (ownerId) hit = { type: 'desk', id: ownerId, desk: d };
      }
    }
    if (!hit && this.scene.meeting && inside(this.scene.meeting.rect)) hit = { type: 'meeting', scope: this.scene.meeting.scope };
    this.selected = hit;
    this.draw(performance.now());
    this.onSelect?.(hit);
  }
}
