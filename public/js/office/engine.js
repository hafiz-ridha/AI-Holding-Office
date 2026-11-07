// Pixel office renderer (Canvas 2D only, no library). World coordinates are logical pixels (tile = 16 px);
// the camera maps them to screen pixels, so resizing never changes the world.
// Static layers (floors, walls, furniture) are pre-rendered once per scene; each frame blits only the visible part
// and draws only visible characters/ambient objects. Frame rate adapts to what is actually happening:
// 30 FPS while someone walks, 10 FPS for typing/celebrating/speech, 2 FPS ambient, 0 when hidden.
// Character states come ONLY from backend data (plus RESTING, derived from real inactivity by the page).
import { buildSheet, FW, FH } from './sprites.js';
import { T } from './scenes.js';

const SPEED = 44; // px/s, constant walking speed
const FLOOR = {
  wood: 'floor_wood', woodb: 'floor_wood_b', tile: 'floor_tile', carpet: 'floor_carpet',
  parquet: 'floor_parquet', dark: 'floor_dark', warm: 'floor_warm',
};
const ACTIVE = new Set(['working', 'thinking', 'meeting']);
const STATE_DOT = { idle: '#9aa4b2', resting: '#7dd3fc', pending: '#f0b354', thinking: '#8da4ff', working: '#3b82f6', meeting: '#8b5cf6', completed: '#30a46c', error: '#e5484d' };

export function dayPeriod(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 15) return 'afternoon';
  if (h >= 15 && h < 18.5) return 'evening';
  return 'night';
}

function hexA(hex, a) {
  const n = parseInt(String(hex || '#888888').slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Blend two #rrggbb colors (t = 0 -> a, 1 -> b); returns #rrggbb.
function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * Math.min(1, Math.max(0, t))).toString(16).padStart(2, '0')).join('')}`;
}

// Deterministic pseudo-random in [0, 1): same scene always looks the same, no stored particle state.
function rnd(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Filled pixel disc (sun, moon).
function disc(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.6));
    g.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

export class OfficeEngine {
  constructor(canvas, { atlas, onSelect, onHover }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.atlas = atlas;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.chars = new Map();
    this.seatAlloc = new Map();
    this.visitorAlloc = new Map();
    this.restAlloc = new Map();
    this.scene = null;
    this.zoomLevel = null; // null = fit
    this.cam = { x: 0, y: 0 };
    this.running = false;
    this.lastDraw = 0;
    this.selected = null;
    this.hovered = null;
    this.speech = new Map(); // employeeId -> { lines, until }: short bubbles for real chat messages
    this.ambientOn = true;
    this.period = dayPeriod();
    this.light = null;
    this.system = { level: 'ok' };
    this.minimap = null;
    this.weather = 'cerah'; // cerah | berawan | hujan | badai (set by the page: automatic or manual)
    this.sky = null;
    this.skyKey = '';
    this.bindInput();
  }

  setWeather(kind) {
    const k = ['cerah', 'berawan', 'hujan', 'badai'].includes(kind) ? kind : 'cerah';
    if (k === this.weather) return;
    this.weather = k;
    if (this.scene) this.light = this.renderLighting(this.scene, this.period);
    this.skyKey = '';
    this.draw(performance.now());
  }

  // Show what an agent just said in the chat above its character for a few seconds.
  say(employeeId, text, ms = 7000) {
    const clean = String(text || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const short = clean.length > 70 ? `${clean.slice(0, 68)}…` : clean;
    const lines = [''];
    for (const w of short.split(' ')) {
      const cur = lines[lines.length - 1];
      if ((cur + ' ' + w).trim().length > 28 && cur) {
        if (lines.length === 3) break;
        lines.push(w);
      } else lines[lines.length - 1] = (cur + ' ' + w).trim();
    }
    this.speech.set(employeeId, { lines, until: performance.now() + ms });
    this.draw(performance.now());
  }

  setAmbient(on) {
    this.ambientOn = Boolean(on);
    this.draw(performance.now());
  }

  // level: ok | paused | error — drives the Developer Lab status panel LEDs (real system state).
  setSystemStatus(s) {
    this.system = s || { level: 'ok' };
  }

  // ---------------- scene ----------------
  setScene(scene) {
    const changedScene = !this.scene || this.scene.id !== scene.id;
    this.scene = scene;
    this.bg = this.renderBackground(scene);
    this.light = this.renderLighting(scene, this.period);
    if (changedScene) {
      this.chars.clear();
      this.seatAlloc.clear();
      this.visitorAlloc.clear();
      this.restAlloc.clear();
      this.selected = null;
      this.hovered = null;
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
    this.minimapThumb = null;
    this.resize();
  }

  rug(g, r) {
    const A = this.atlas;
    const c = r.color || 'red';
    const w = Math.max(16, Math.round(r.w / 8) * 8);
    const h = Math.max(16, Math.round(r.h / 8) * 8);
    for (let y = 0; y < h; y += 8) {
      for (let x = 0; x < w; x += 8) {
        const v = y === 0 ? 't' : y + 8 >= h ? 'b' : '';
        const hz = x === 0 ? 'l' : x + 8 >= w ? 'r' : '';
        A.draw(g, `rug_${c}_${v + hz || 'c'}`, r.x + x, r.y + y);
      }
    }
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
    const yh = s.yard ? s.yard.h : 0;
    // Corridors & hallway: warm tiles with a runner rug (inside the building, below the front yard).
    for (let y = yh / T; y < s.mapH; y++) for (let x = 0; x < s.mapW; x++) A.draw(g, 'floor_warm', x * T, y * T);
    for (const cor of s.corridors) this.rug(g, { x: 2 * T + 4, y: cor.y * T + 8, w: (s.mapW - 2) * T - 8, h: 16, color: 'blue' });
    this.rug(g, { x: 8, y: yh + T, w: 16, h: (s.mapH - 1) * T - yh - T, color: 'blue' });
    if (s.yard) this.renderYard(g, s);
    // Room floors + identity tint.
    for (const r of s.rooms) {
      const f = FLOOR[r.floor] || 'floor_wood';
      for (let y = r.y + 2; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) A.draw(g, f, x * T, y * T);
      if (r.tint) {
        g.fillStyle = hexA(r.tint, r.floor === 'carpet' ? 0.34 : 0.07);
        g.fillRect(r.x * T, (r.y + 2) * T, r.w * T, (r.h - 2) * T);
      }
    }
    for (const rug of s.rugs) this.rug(g, rug);
    // Wallpaper per room, windows (with curtains) where nothing hangs, decorations, sign planks.
    s.windows = [];
    for (const w of s.walls) {
      const r = w.room;
      const covered = (x) => w.occ.some((d) => x * T + T > d.x - 2 && x * T < d.x + d.w + 2);
      for (let x = r.x; x < r.x + r.w; x++) {
        const win = (x - r.x) % 3 === 1 && !covered(x);
        A.draw(g, `${win ? 'wallwin' : 'wall'}_${r.wall}`, x * T, r.y * T);
        if (win) s.windows.push({ x: x * T, y: r.y * T, room: r });
      }
      for (const d of w.deco) A.draw(g, d.f, d.x, d.y);
      const sg = r.sign;
      if (sg) {
        g.fillStyle = '#5d3f26';
        g.fillRect(sg.x, sg.y, sg.w, sg.h);
        g.fillStyle = '#9a6b43';
        g.fillRect(sg.x + 1, sg.y + 1, sg.w - 2, sg.h - 2);
        g.fillStyle = '#b8885a';
        g.fillRect(sg.x + 1, sg.y + 1, sg.w - 2, 1);
        g.fillStyle = '#7a5233';
        g.fillRect(sg.x + 1, sg.y + sg.h - 2, sg.w - 2, 1);
        g.fillStyle = r.tint || '#c9a227';
        g.fillRect(sg.x + 2, sg.y + 3, 2, sg.h - 6);
      }
    }
    // Walls between rooms (thick, with a highlight) and bottom walls with a framed door + mat.
    for (const r of s.rooms) {
      const x0 = r.x * T;
      g.fillStyle = '#5d4636';
      g.fillRect(x0, r.y * T, 4, r.h * T);
      g.fillStyle = '#8a6a50';
      g.fillRect(x0 + 1, r.y * T + 32, 1, r.h * T - 32);
      if (r.x + r.w === s.mapW) {
        g.fillStyle = '#5d4636';
        g.fillRect((r.x + r.w) * T - 4, r.y * T, 4, r.h * T);
      }
      const by = (r.y + r.h) * T - 4;
      const doorL = r.door.x - T;
      g.fillStyle = '#5d4636';
      g.fillRect(x0, by, doorL - x0, 4);
      g.fillRect(doorL + 2 * T, by, (r.x + r.w) * T - doorL - 2 * T, 4);
      g.fillStyle = '#7a5b46';
      g.fillRect(doorL - 2, by - 6, 3, 10);
      g.fillRect(doorL + 2 * T - 1, by - 6, 3, 10);
      A.draw(g, 'doormat', doorL + 2, by - 2);
      // soft shadow under the top wall
      g.fillStyle = 'rgba(0,0,0,0.10)';
      g.fillRect(x0 + 4, (r.y + 2) * T, r.w * T - 4, 3);
    }
    // Static furniture sorted by depth (desks, monitors off, flags, props).
    const statics = s.props.map((p) => ({ ...p, z: p.y + p.h }));
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
    if (s.meeting) {
      const t = s.meeting.table;
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(t.x + 2, t.y + t.h, t.w - 4, 3);
      for (let y = 0; y < t.h; y += 8) {
        for (let x = 0; x < t.w; x += 8) {
          const v = y === 0 ? 't' : y + 8 >= t.h ? 'b' : '';
          const h = x === 0 ? 'l' : x + 8 >= t.w ? 'r' : '';
          A.draw(g, `tbl_${v + h || 'c'}`, t.x + x, t.y + y);
        }
      }
    }
    for (const e of s.extras) A.draw(g, e.f, e.x, e.y);
    if (s.logoImg) {
      const r = s.rooms.find((x) => x.key === 'manager');
      if (r) {
        const lx = r.sign ? r.sign.x + r.sign.w + 6 : r.x * T + 2 * T;
        g.fillStyle = '#5d3f26';
        g.fillRect(lx - 1, r.y * T + 7, 22, 22);
        g.drawImage(s.logoImg, lx, r.y * T + 8, 20, 20);
      }
    }
    return c;
  }

  // ---------------- front yard ----------------
  renderYard(g, s) {
    const A = this.atlas;
    const y = s.yard;
    const W = s.mapW * T;
    const tiles = (f, y0, h, x0 = 0, w = W) => {
      for (let ty = y0; ty < y0 + h; ty += T) for (let x = x0; x < x0 + w; x += T) A.draw(g, f, x, ty);
    };
    // Road with edge lines and dashed center line.
    tiles('asphalt', y.road.y, y.road.h);
    g.fillStyle = '#d9dcd5';
    g.fillRect(0, y.road.y + 1, W, 1);
    g.fillRect(0, y.road.y + y.road.h - 2, W, 1);
    g.fillStyle = '#e8cf6a';
    for (let x = 4; x < W; x += 20) g.fillRect(x, y.road.y + y.road.h / 2 - 1, 10, 2);
    // Sidewalk with curb.
    tiles('paving', y.walk.y, y.walk.h);
    g.fillStyle = '#8f8a81';
    g.fillRect(0, y.walk.y, W, 2);
    g.fillStyle = '#b4afa5';
    g.fillRect(0, y.walk.y, W, 1);
    // Driveway from the road into the lot (curb cut through the sidewalk).
    if (y.driveway) {
      tiles('asphalt', y.walk.y, y.walk.h, y.driveway.x, y.driveway.w);
      g.fillStyle = '#8f8a81';
      g.fillRect(y.driveway.x - 2, y.walk.y, 2, y.walk.h);
      g.fillRect(y.driveway.x + y.driveway.w, y.walk.y, 2, y.walk.h);
    }
    // Parking lot, walkway to the main entrance, lawn, painted lines.
    tiles('asphalt', y.lot.y, y.lot.h);
    tiles('paving', y.lot.y, y.lot.h, y.entry.x, y.entry.w);
    if (y.lawn) {
      const l = y.lawn;
      g.save();
      g.beginPath();
      g.rect(l.x, l.y, l.w, l.h);
      g.clip();
      for (let ty = l.y; ty < l.y + l.h; ty += T) for (let x = l.x; x < l.x + l.w; x += T) A.draw(g, 'grass', x, ty);
      g.restore();
      g.fillStyle = '#b4afa5';
      g.fillRect(l.x - 1, l.y - 1, l.w + 2, 1);
      g.fillRect(l.x - 1, l.y + l.h, l.w + 2, 1);
      g.fillRect(l.x - 1, l.y - 1, 1, l.h + 2);
      g.fillRect(l.x + l.w, l.y - 1, 1, l.h + 2);
    }
    g.fillStyle = '#e6e6e0';
    for (const p of y.paint) g.fillRect(p.x, p.y, p.w, p.h);
    for (const d of y.decals) if (d.under) A.draw(g, d.f, d.x, d.y);
    // Building edge with the main entrance (glass door frame, striped awning, doormat).
    g.fillStyle = '#5d4636';
    g.fillRect(y.entry.x + y.entry.w, y.h - 3, W - y.entry.w, 3);
    g.fillRect(y.entry.x, y.h - 8, 3, 14);
    g.fillRect(y.entry.x + y.entry.w - 3, y.h - 8, 3, 14);
    g.fillStyle = 'rgba(159,208,234,0.55)';
    g.fillRect(y.entry.x + 3, y.h - 2, y.entry.w - 6, 2);
    for (let i = 0; i < y.entry.w; i += 4) {
      g.fillStyle = (i / 4) % 2 ? '#f2eee4' : '#c2413a';
      g.fillRect(y.entry.x + i, y.h - 12, 4, 5);
    }
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(y.entry.x, y.h - 7, y.entry.w, 2);
    A.draw(g, 'doormat', y.entry.x + 2, y.h + 2);
    // Building name plank on two legs beside the walkway.
    const sg = y.sign;
    g.fillStyle = '#5d3f26';
    g.fillRect(sg.x + 6, sg.y + sg.h - 1, 2, 3);
    g.fillRect(sg.x + sg.w - 8, sg.y + sg.h - 1, 2, 3);
    g.fillRect(sg.x, sg.y, sg.w, sg.h);
    g.fillStyle = '#9a6b43';
    g.fillRect(sg.x + 1, sg.y + 1, sg.w - 2, sg.h - 2);
    g.fillStyle = '#b8885a';
    g.fillRect(sg.x + 1, sg.y + 1, sg.w - 2, 1);
    // Vehicles, lamp posts, parking sign, bushes (sorted by depth), then helmets on bikes.
    for (const o of [...y.objects].sort((a, b) => a.y + a.h - (b.y + b.h))) A.draw(g, o.f, o.x, o.y);
    for (const d of y.decals) if (!d.under) A.draw(g, d.f, d.x, d.y);
  }

  // Sky band: gradient by time of day and weather, sun/moon at its real position, stars, distant skyline.
  // Cached and re-rendered once a minute (or when the weather changes).
  renderSky(s, d) {
    const W = s.mapW * T;
    const H = s.yard.sky.h;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const p = dayPeriod(d);
    const night = p === 'night';
    const wx = this.weather;
    const base = { morning: ['#7ec8f0', '#fcd9a8'], afternoon: ['#5fb2ec', '#c4e6f8'], evening: ['#3b4f8a', '#f2a065'], night: ['#0b1330', '#22305e'] }[p];
    const veil = { cerah: null, berawan: ['#9aa5b1', 0.45], hujan: ['#5f6b78', 0.72], badai: ['#3f4652', 0.82] }[wx];
    const col = (hex) => (veil ? mixHex(hex, veil[0], night ? veil[1] * 0.45 : veil[1]) : hex);
    const top = col(base[0]);
    const bottom = col(base[1]);
    for (let y = 0; y < H; y += 4) {
      g.fillStyle = mixHex(top, bottom, y / H);
      g.fillRect(0, y, W, 4);
    }
    if (night && (wx === 'cerah' || wx === 'berawan')) {
      g.fillStyle = '#ffffff';
      const n = Math.round(W / (wx === 'cerah' ? 9 : 22));
      for (let i = 0; i < n; i++) {
        g.globalAlpha = 0.4 + rnd(i + 200) * 0.6;
        g.fillRect(Math.round(rnd(i + 100) * W), Math.round(rnd(i + 150) * (H - 18)), 1, 1);
      }
      g.globalAlpha = 1;
    }
    // Sun 06:00–18:00 and moon 18:00–06:00 move across the sky with the browser clock.
    const h = d.getHours() + d.getMinutes() / 60;
    const day = h >= 6 && h < 18;
    const t = day ? (h - 6) / 12 : ((h - 18 + 24) % 24) / 12;
    const cx = Math.round(14 + t * (W - 28));
    const cy = Math.round(H - 12 - Math.sin(Math.PI * t) * (H - 20));
    if (wx === 'cerah' || wx === 'berawan') {
      g.globalAlpha = wx === 'berawan' ? 0.55 : 1;
      if (day) {
        disc(g, cx, cy, 8, 'rgba(255,240,170,0.35)');
        disc(g, cx, cy, 5, '#ffe27a');
        disc(g, cx - 1, cy - 1, 2, '#fff6c8');
      } else {
        disc(g, cx, cy, 6, 'rgba(230,236,255,0.18)');
        disc(g, cx, cy, 4, '#f1f0e3');
        disc(g, cx + 2, cy - 1, 3, mixHex(top, bottom, cy / H));
      }
      g.globalAlpha = 1;
    }
    // Distant city skyline; windows light up in the evening/night.
    const sky = { morning: '#9fb3c8', afternoon: '#93a8bd', evening: '#5d5272', night: '#151a30' }[p];
    for (let x = 0, i = 0; x < W; i++) {
      const bw = 14 + Math.round(rnd(i + 300) * 18);
      const bh = 8 + Math.round(rnd(i + 350) * 14);
      g.fillStyle = col(sky);
      g.fillRect(x, H - bh, bw, bh);
      for (let wy = H - bh + 3; wy < H - 2; wy += 4) {
        for (let wxp = x + 2; wxp < x + bw - 2; wxp += 4) {
          const lit = rnd(i * 31 + wy * 7 + wxp) > (night ? 0.55 : p === 'evening' ? 0.75 : 2);
          g.fillStyle = lit ? '#f6d77a' : night ? '#20263f' : col('#b9c7d6');
          g.fillRect(wxp, wy, 2, 2);
        }
      }
      x += bw + 2;
    }
    return c;
  }

  drawClouds(ctx, s, sec) {
    const W = s.mapW * T;
    const H = s.yard.sky.h - 14;
    const n = { cerah: 3, berawan: 7, hujan: 10, badai: 11 }[this.weather];
    const base = { cerah: '#ffffff', berawan: '#e1e6ec', hujan: '#8f99a5', badai: '#5f6773' }[this.weather];
    ctx.fillStyle = this.period === 'night' ? mixHex(base, '#1b2240', 0.6) : this.period === 'evening' ? mixHex(base, '#f2a065', 0.25) : base;
    ctx.globalAlpha = this.weather === 'cerah' ? 0.85 : 0.95;
    const t = this.ambientOn ? sec : 0;
    for (let i = 0; i < n; i++) {
      const w = 22 + rnd(i + 10) * 24;
      const span = W + w + 20;
      const x = ((rnd(i + 20) * span + t * (2 + rnd(i + 30) * 3)) % span) - w - 10;
      const y = 2 + rnd(i + 40) * Math.max(4, H - 10);
      ctx.fillRect(Math.round(x), Math.round(y + 4), Math.round(w), 6);
      ctx.fillRect(Math.round(x + w * 0.18), Math.round(y + 1), Math.round(w * 0.45), 4);
      ctx.fillRect(Math.round(x + w * 0.5), Math.round(y + 2), Math.round(w * 0.32), 3);
    }
    ctx.globalAlpha = 1;
  }

  raining() {
    return this.weather === 'hujan' || this.weather === 'badai';
  }

  yardVisible() {
    return Boolean(this.scene?.yard) && this.cam.y < this.scene.yard.h;
  }

  drawPuddles(ctx, s) {
    for (const p of s.yard.puddles) {
      ctx.fillStyle = 'rgba(110,128,156,0.45)';
      ctx.fillRect(p.x + 2, p.y, p.w - 4, 4);
      ctx.fillRect(p.x, p.y + 1, p.w, 2);
      ctx.fillStyle = 'rgba(210,222,240,0.45)';
      ctx.fillRect(p.x + 3, p.y + 1, Math.round(p.w / 3), 1);
    }
  }

  // Rain streaks and splashes outdoors only (front yard); occasional lightning during a storm.
  drawRain(ctx, s, sec) {
    const W = s.mapW * T;
    const H = s.yard.h - 4;
    const t = this.ambientOn ? sec : 0;
    const n = this.weather === 'badai' ? 170 : 110;
    ctx.fillStyle = this.period === 'night' ? 'rgba(170,190,230,0.5)' : 'rgba(225,235,248,0.65)';
    for (let i = 0; i < n; i++) {
      const y = (rnd(i + 500) * H + t * (150 + rnd(i + 600) * 60)) % H;
      const x = Math.round(rnd(i + 700) * (W + 40) - y * 0.25);
      if (x < -4 || x > W + 4 || !this.isVisibleWorld(x, y, 8)) continue;
      ctx.fillRect(x, Math.round(y), 1, 4);
      ctx.fillRect(x - 1, Math.round(y) + 4, 1, 2);
    }
    ctx.fillStyle = 'rgba(225,235,248,0.55)';
    for (let i = 0; i < 28; i++) {
      const ph = (t * 2 + rnd(i + 800)) % 1;
      if (ph > 0.35) continue;
      const x = rnd(i + 900) * W;
      const y = s.yard.road.y + 4 + rnd(i + 950) * (s.yard.h - s.yard.road.y - 10);
      const r = 1 + Math.floor(ph * 6);
      ctx.fillRect(Math.round(x - r), Math.round(y), 2 * r, 1);
    }
    if (this.weather === 'badai' && this.ambientOn) {
      const ph = sec % 11;
      if (ph < 0.1 || (ph > 0.22 && ph < 0.3)) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(0, 0, W, s.yard.h);
      }
    }
  }

  // Day/night lighting overlay, cached per scene + period + weather (browser local time).
  renderLighting(s, period) {
    const wx = this.weather;
    if (period === 'afternoon' && !s.windows && wx === 'cerah') return null;
    const W = s.mapW * T;
    const H = s.mapH * T;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const skyH = s.yard ? s.yard.sky.h : 0; // the sky band has its own day/night colors
    const tint = { morning: 'rgba(255,196,120,0.07)', afternoon: null, evening: 'rgba(255,140,60,0.13)', night: 'rgba(18,26,60,0.46)' }[period];
    if (tint) {
      g.fillStyle = tint;
      g.fillRect(0, skyH, W, H - skyH);
    }
    if (s.yard && wx !== 'cerah') {
      // Clouds/rain darken the outdoors; the building keeps its lights.
      g.fillStyle = { berawan: 'rgba(70,80,95,0.10)', hujan: 'rgba(40,50,70,0.22)', badai: 'rgba(30,35,55,0.30)' }[wx];
      g.fillRect(0, skyH, W, s.yard.h - skyH);
    }
    const lampsOn = period === 'night' || period === 'evening' || wx === 'hujan' || wx === 'badai';
    if (s.yard && lampsOn) {
      for (const l of s.yard.lamps) {
        const pool = g.createRadialGradient(l.gx, l.gy, 2, l.gx, l.gy, 34);
        pool.addColorStop(0, period === 'night' ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.4)');
        pool.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = pool;
        g.fillRect(l.gx - 36, l.gy - 36, 72, 72);
        g.globalCompositeOperation = 'source-over';
        const warm = g.createRadialGradient(l.gx, l.gy, 2, l.gx, l.gy, 30);
        warm.addColorStop(0, 'rgba(255,214,140,0.22)');
        warm.addColorStop(1, 'rgba(255,214,140,0)');
        g.fillStyle = warm;
        g.fillRect(l.gx - 32, l.gy - 32, 64, 64);
        const halo = g.createRadialGradient(l.x, l.y, 1, l.x, l.y, 9);
        halo.addColorStop(0, 'rgba(255,236,170,0.8)');
        halo.addColorStop(1, 'rgba(255,236,170,0)');
        g.fillStyle = halo;
        g.fillRect(l.x - 10, l.y - 10, 20, 20);
        g.fillStyle = '#fff2b8';
        g.fillRect(l.x - 2, l.y - 1, 3, 2);
      }
    }
    if (period === 'night' || period === 'evening') {
      // Room lights switch on: carve warm pools out of the dark overlay.
      for (const r of s.rooms) {
        const cx = (r.x + r.w / 2) * T;
        const cy = (r.y + r.h / 2 + 1) * T;
        const rad = Math.max(r.w, r.h) * T * 0.55;
        const grad = g.createRadialGradient(cx, cy, 8, cx, cy, rad);
        grad.addColorStop(0, period === 'night' ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.5)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = grad;
        g.fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
        g.globalCompositeOperation = 'source-over';
        const warm = g.createRadialGradient(cx, cy, 4, cx, cy, rad * 0.8);
        warm.addColorStop(0, period === 'night' ? 'rgba(255,214,140,0.16)' : 'rgba(255,200,120,0.08)');
        warm.addColorStop(1, 'rgba(255,214,140,0)');
        g.fillStyle = warm;
        g.fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
      }
      for (const p of [...s.props, ...s.ambient]) {
        if (p.f !== 'lamp') continue;
        const grad = g.createRadialGradient(p.x + 5, p.y + 4, 2, p.x + 5, p.y + 4, 34);
        grad.addColorStop(0, 'rgba(255,220,150,0.35)');
        grad.addColorStop(1, 'rgba(255,220,150,0)');
        g.fillStyle = grad;
        g.fillRect(p.x - 30, p.y - 30, 70, 70);
      }
    }
    // Window light falling onto the floor during the day (weaker under clouds, none in rain); night windows glow faintly blue.
    for (const w of s.windows || []) {
      const fy = w.y + 32;
      if (period !== 'night' && (wx === 'hujan' || wx === 'badai')) continue;
      if (period !== 'night' && wx === 'berawan') g.globalAlpha = 0.5;
      if (period === 'night') {
        g.fillStyle = 'rgba(120,160,255,0.10)';
        g.fillRect(w.x + 2, w.y + 8, 12, 14);
        continue;
      }
      const col = { morning: 'rgba(255,236,180,0.20)', afternoon: 'rgba(255,255,235,0.14)', evening: 'rgba(255,170,90,0.16)' }[period];
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(w.x + 2, fy);
      g.lineTo(w.x + 14, fy);
      g.lineTo(w.x + 20, fy + 26);
      g.lineTo(w.x + 6, fy + 26);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
    return c;
  }

  // ---------------- state ----------------
  // opts.resting: Set of employee ids that are idle long enough to rest in the lounge (derived from real activity).
  setData(data, opts = {}) {
    if (!this.scene) return;
    const s = this.scene;
    const resting = opts.resting || new Set();
    const present = new Set();
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
          this.visitorAlloc.set(e.id, s.visitorDesks.findIndex((_, i) => !used.has(i)));
        }
        d = s.visitorDesks[this.visitorAlloc.get(e.id)] || null;
      }
      let state = STATE_DOT[e.state] && e.state !== 'resting' ? e.state : 'idle'; // unknown/missing state -> IDLE
      if (state === 'idle' && resting.has(e.id) && s.restSeats.length) {
        if (!this.restAlloc.has(e.id)) {
          const used = new Set(this.restAlloc.values());
          const free = s.restSeats.findIndex((_, i) => !used.has(i));
          if (free >= 0) this.restAlloc.set(e.id, free);
        }
        if (this.restAlloc.has(e.id)) state = 'resting';
      }
      if (state !== 'resting') this.restAlloc.delete(e.id);
      const meetingHere = state === 'meeting' && here(e.meeting);
      let target;
      let pose;
      let bubble = null;
      let chairFrame = 'chair';
      let note = null;
      let restSeat = null;
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
          bubble = 'bub_meet';
        }
      } else {
        this.seatAlloc.delete(e.id);
        if (!d) {
          const g = s.rooms.find((r) => r.key === 'guests') || s.rooms[0];
          d = { seat: { x: (g.x + g.w / 2) * T, y: (g.y + g.h - 2) * T }, stand: { x: (g.x + g.w / 2) * T, y: (g.y + g.h - 2) * T }, monitors: [] };
        }
        switch (state) {
          case 'working':
            target = d.seat; pose = 'sit_back'; bubble = 'gear';
            break;
          case 'thinking':
            target = d.seat; pose = 'sit_back'; bubble = 'think';
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
          case 'resting':
            restSeat = s.restSeats[this.restAlloc.get(e.id)];
            target = restSeat; pose = restSeat.pose; bubble = 'bub_rest';
            break;
          default:
            target = d.stand; pose = 'stand';
        }
      }
      let c = this.chars.get(e.id);
      if (!c) {
        const spawn = this.firstPlacement ? target : s.entrance;
        c = { id: e.id, x: spawn.x, y: spawn.y, path: [], flip: false, walkPose: 'walk_down', phase: Math.random() * 7 };
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
        if (!(this.firstPlacement && c.x === target.x && c.y === target.y)) c.path = this.route(c, { ...target, x: c.tx, y: c.ty });
      }
      Object.assign(c, {
        e, state, desk: d, pose, bubble, note, restSeat,
        chairFrame: target === d?.seat ? (d?.exec && chairFrame === 'chair' ? 'exec_chair' : chairFrame) : null,
        meetingSeat: meetingHere && target !== s.meeting.leader ? target : null,
      });
    }
    for (const id of [...this.chars.keys()]) {
      if (!present.has(id)) {
        this.chars.delete(id);
        this.visitorAlloc.delete(id);
        this.seatAlloc.delete(id);
        this.restAlloc.delete(id);
      }
    }
    this.firstPlacement = false;
    this.data = data;
    if (this.selected?.type === 'employee' && !this.chars.has(this.selected.id)) this.selected = null;
  }

  roomAt(p) {
    return this.scene.rooms.find((r) => p.x >= r.x * T && p.x < (r.x + r.w) * T && p.y >= r.y * T && p.y < (r.y + r.h) * T) || null;
  }

  // Grid-aligned paths: inside a room walk along the free lane above the bottom wall; between rooms use
  // doors, corridors and the left hallway. Only horizontal/vertical segments (4-direction walking).
  route(c, target) {
    // Lounge seats are reached via the aisle next to the seating group (never through sofas/tables).
    const pre = [];
    const post = [];
    const rs = this.scene.restSeats.find((r) => r.aisleX != null && Math.abs(r.x - c.x) < 1 && Math.abs(r.y - c.y) < 1);
    if (rs) pre.push({ x: rs.aisleX, y: rs.y });
    let to = target;
    if (target.aisleX != null) {
      to = { x: target.aisleX, y: target.y };
      post.push({ x: target.x, y: target.y });
    }
    return [...pre, ...this.routeGrid(pre[0] || c, to), ...post];
  }

  routeGrid(c, target) {
    const s = this.scene;
    const from = this.roomAt(c);
    const to = this.roomAt(target);
    if (from && to && from === to) {
      if (Math.abs(c.x - target.x) < 2 || Math.abs(c.y - target.y) < 2) return [{ x: target.x, y: target.y }];
      const lane = from.door.y - 4;
      return [{ x: c.x, y: lane }, { x: target.x, y: lane }, { x: target.x, y: target.y }];
    }
    const path = [];
    let corY;
    if (from) {
      path.push({ x: c.x, y: from.door.y - 4 }, { x: from.door.x, y: from.door.y - 4 }, { x: from.door.x, y: from.door.corridorY });
      corY = from.door.corridorY;
    } else {
      corY = c.y;
    }
    if (to) {
      if (to.door.corridorY !== corY) path.push({ x: s.hallX, y: corY }, { x: s.hallX, y: to.door.corridorY });
      path.push({ x: to.door.x, y: to.door.corridorY }, { x: to.door.x, y: to.door.y - 4 }, { x: target.x, y: to.door.y - 4 });
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
    // The page may provide the available height (e.g. to fill the space next to the chat column).
    const maxH = this.maxHeight?.() ?? Math.round(window.innerHeight * 0.72);
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
    this.focusOn(cx, cy);
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
      let interval = 500; // ambient / idle breathing: 2 FPS
      if (walking) interval = 1000 / 30;
      else if (this.ambientOn && this.raining() && this.yardVisible()) interval = 1000 / 15; // rain on screen
      else if (this.speech.size || this.anyVisible((c) => ['working', 'completed', 'thinking'].includes(c.state))) interval = 100;
      if (t - this.lastDraw >= interval) {
        this.lastDraw = t;
        const p = dayPeriod();
        if (p !== this.period) {
          this.period = p;
          this.light = this.renderLighting(this.scene, p);
        }
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

  // ---------------- drawing ----------------
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
    const sx = Math.max(0, Math.floor(this.cam.x));
    const sy = Math.max(0, Math.floor(this.cam.y));
    const sw = Math.min(this.bg.width - sx, Math.ceil(vw) + 2);
    const sh = Math.min(this.bg.height - sy, Math.ceil(vh) + 2);
    // Front yard sky (behind the transparent sky band of the background): real time of day + weather.
    const yard = this.scene.yard;
    const yardOn = this.yardVisible();
    if (yardOn) {
      const now = new Date();
      const key = `${this.scene.id}|${this.weather}|${now.getHours()}:${now.getMinutes()}`;
      if (key !== this.skyKey || !this.sky) {
        this.skyKey = key;
        this.sky = this.renderSky(this.scene, now);
        this.minimapThumb = null;
      }
      ctx.drawImage(this.sky, 0, 0);
      this.drawClouds(ctx, this.scene, sec);
    }
    if (sw > 0 && sh > 0) ctx.drawImage(this.bg, sx, sy, sw, sh, sx, sy, sw, sh);
    if (yardOn && this.raining()) this.drawPuddles(ctx, this.scene);

    const items = [];
    // Ambient objects (visible only): swaying plants, clock hands, blinking server/status LEDs.
    for (const a of this.scene.ambient) {
      if (!this.isVisibleWorld(a.x, a.y)) continue;
      if (a.type === 'plant') {
        const sway = this.ambientOn && Math.floor(sec / 1.6 + (a.x % 7)) % 2 === 1;
        items.push({ z: a.z, draw: () => A.draw(ctx, sway ? `${a.f}_b` : a.f, a.x, a.y) });
      } else if (a.type === 'clock') {
        items.push({ z: -1, draw: () => this.drawClock(ctx, a.x + 6, a.y + 6) });
      } else if (a.type === 'rack') {
        items.push({ z: -1, draw: () => this.drawRackLeds(ctx, a.x, a.y, sec) });
      } else if (a.type === 'panel') {
        items.push({ z: -1, draw: () => this.drawStatusPanel(ctx, a.x, a.y, sec) });
      }
    }
    for (const c of this.chars.values()) {
      if (!c.e || !this.isVisibleWorld(c.x, c.y)) continue;
      const seated = !c.path.length && (c.pose === 'sit_back' || c.pose === 'sit_front');
      const atDesk = c.desk?.seat && c.x === c.desk.seat.x && c.y === c.desk.seat.y;
      if (c.desk?.monitors && !c.path.length && atDesk && (c.state === 'working' || c.state === 'thinking')) {
        const dev = c.desk.frame === 'desk_dev';
        const frame = c.state === 'working' ? `${dev ? 'monitor_term' : 'monitor_on'}_${Math.floor(sec * 2) % 2}` : `${dev ? 'monitor_term' : 'monitor_on'}_0`;
        for (const m of c.desk.monitors) items.push({ z: c.desk.y + 2, draw: () => A.draw(ctx, frame, m.x, m.y) });
      }
      if (seated && c.meetingSeat?.chair) {
        const ch = c.meetingSeat.chair;
        items.push({ z: ch.f === 'chair' ? c.y + 1 : c.y - 30, draw: () => A.draw(ctx, ch.f, ch.x, ch.y) });
      } else if (seated && c.chairFrame && c.desk?.chair && atDesk) {
        const ch = c.desk.chair;
        const f = c.chairFrame;
        items.push({ z: f === 'chair_back_n' ? c.y - 30 : c.y + 1, draw: () => A.draw(ctx, f, ch.x, ch.y) });
      }
      items.push({ z: c.y, c });
    }
    // Empty chairs.
    for (const d of [...this.scene.desks, ...this.scene.visitorDesks]) {
      if (!this.isVisibleWorld(d.chair.x, d.chair.y)) continue;
      const occ = [...this.chars.values()].some((c) => c.desk === d && !c.path.length && (c.pose === 'sit_back' || c.pose === 'sit_front') && c.x === d.seat.x && c.y === d.seat.y);
      if (!occ) items.push({ z: d.chair.y + 14, draw: () => A.draw(ctx, d.exec ? 'exec_chair' : 'chair', d.chair.x, d.chair.y) });
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
    // Lighting (day/night) over the world, below the UI-like indicators.
    if (this.light) {
      const lw = Math.min(this.light.width - sx, sw);
      const lh = Math.min(this.light.height - sy, sh);
      if (lw > 0 && lh > 0) ctx.drawImage(this.light, sx, sy, lw, lh, sx, sy, lw, lh);
    }
    if (yardOn && yard && this.raining()) this.drawRain(ctx, this.scene, sec);
    // Activity indicators (small, above heads).
    for (const c of this.chars.values()) {
      if (!c.e || c.path.length || !c.bubble || !this.isVisibleWorld(c.x, c.y)) continue;
      const seated = c.pose === 'sit_back' || c.pose === 'sit_front';
      const by = c.y - FH - (seated ? 9 : 13) - (c.pose === 'jump' ? 3 : 0);
      if (c.bubble === 'gear') A.draw(ctx, `ico_gear_${Math.floor(sec * 4) % 2}`, c.x + 3, by + 1);
      else if (c.bubble === 'think') {
        A.draw(ctx, `bub_type_${Math.floor(sec * 3) % 3}`, c.x + 3, by);
        A.draw(ctx, 'ico_ai', c.x + 12, by - 4);
      } else if (c.bubble === 'bub_rest') {
        if (Math.floor((sec + c.phase) / 3) % 3 === 0) A.draw(ctx, c.bubble, c.x + 3, by);
      } else A.draw(ctx, c.bubble, c.x + 3, by);
      if (c.state === 'completed') A.draw(ctx, `sparkle_${Math.floor(sec * 3) % 2}`, c.x - 13, c.y - FH + 2);
    }
    if (this.selected || this.hovered) {
      ctx.lineWidth = 1.5 / this.scale;
      for (const [sel, color] of [[this.hovered, 'rgba(255,255,255,0.7)'], [this.selected, '#ffd34d']]) {
        if (!sel) continue;
        const r = this.rectOf(sel);
        if (!r) continue;
        ctx.strokeStyle = color;
        ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      }
    }
    // Screen-space text: room signs (+ live activity badge) and name tags, never overlapping.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const toScreen = (x, y) => [(x - this.cam.x) * this.scale, (y - this.cam.y) * this.scale];
    this.drawSigns(ctx, toScreen);
    this.drawNames(ctx, toScreen);
    this.drawSpeech(ctx, toScreen, t);
    this.updateMinimap(t);
  }

  drawClock(ctx, cx, cy) {
    const d = new Date();
    const hAng = ((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6) - Math.PI / 2;
    const mAng = d.getMinutes() * (Math.PI / 30) - Math.PI / 2;
    ctx.fillStyle = '#2e2a33';
    for (let i = 1; i <= 2; i++) ctx.fillRect(Math.round(cx + Math.cos(hAng) * i) - 0.5, Math.round(cy + Math.sin(hAng) * i) - 0.5, 1, 1);
    ctx.fillStyle = '#b5574a';
    for (let i = 1; i <= 4; i++) ctx.fillRect(Math.round(cx + Math.cos(mAng) * i) - 0.5, Math.round(cy + Math.sin(mAng) * i) - 0.5, 1, 1);
  }

  drawRackLeds(ctx, x, y, sec) {
    for (let k = 0; k < 5; k++) {
      const on = !this.ambientOn || (Math.floor(sec * 2 + k * 1.7 + x) % 3) !== 0;
      ctx.fillStyle = on ? '#86c46c' : '#2f4a2a';
      ctx.fillRect(x + 3, y + 3 + k * 5, 1, 1);
      ctx.fillStyle = (Math.floor(sec * 3 + k) % 4 === 0 && this.ambientOn) ? '#f2c14e' : '#86c46c';
      ctx.fillRect(x + 5, y + 3 + k * 5, 1, 1);
    }
  }

  // Developer Lab status panel mirrors the real system state (queue running / paused / provider errors).
  drawStatusPanel(ctx, x, y, sec) {
    const color = this.system.level === 'error' ? '#e5484d' : this.system.level === 'paused' ? '#f2c14e' : '#5dd39e';
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(x + 2 + i * 3, y + 3, 2, 2);
      const blink = this.ambientOn && Math.floor(sec * 2 + i) % 3 === 0;
      ctx.fillStyle = blink ? '#1f2329' : color;
      ctx.fillRect(x + 2 + i * 3, y + 7, 2, 2);
    }
  }

  drawChar(ctx, c, sec) {
    let pose = c.path.length ? c.walkPose : c.pose;
    let flip = c.flip;
    let fps = 1;
    let frame;
    if (c.path.length) fps = 8;
    else if (pose === 'sit_back') fps = c.state === 'working' ? 5 : 0;
    else if (pose === 'jump') fps = 3;
    else if (pose === 'sit_front') fps = 0.5;
    if (!c.path.length && pose === 'stand' && c.state === 'idle' && this.ambientOn) {
      // Idle: breathing, and now and then a short glance to one side.
      const cyc = (sec + c.phase) % 9;
      if (cyc > 7.6) {
        pose = 'walk_side';
        flip = Math.floor((sec + c.phase) / 9) % 2 === 0;
        frame = 0;
      }
    }
    if (frame === undefined) frame = fps ? Math.floor((sec + c.phase) * fps) : 0;
    const [sx, sy] = c.sheet.frame(pose, frame);
    const x = Math.round(c.x - FW / 2);
    const y = Math.round(c.y - FH);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(Math.round(c.x - 5), Math.round(c.y - 1), 10, 2);
    ctx.fillRect(Math.round(c.x - 4), Math.round(c.y), 8, 1);
    if (flip && pose === 'walk_side') {
      ctx.save();
      ctx.translate(x + FW, y);
      ctx.scale(-1, 1);
      ctx.drawImage(c.sheet.canvas, sx, sy, FW, FH + 2, 0, 0, FW, FH + 2);
      ctx.restore();
    } else ctx.drawImage(c.sheet.canvas, sx, sy, FW, FH + 2, x, y, FW, FH + 2);
    c.box = { x, y, w: FW, h: FH + 2 };
  }

  activeInRoom(room) {
    let n = 0;
    for (const c of this.chars.values()) {
      if (!c.e || !ACTIVE.has(c.state)) continue;
      const r = this.roomAt({ x: c.tx ?? c.x, y: c.ty ?? c.y });
      if (r === room) n++;
    }
    return n;
  }

  drawSigns(ctx, toScreen) {
    ctx.textBaseline = 'middle';
    const list = this.scene.rooms.map((r) => ({ sign: r.sign, name: r.name, room: r }));
    if (this.scene.yard) list.push({ sign: this.scene.yard.sign, name: this.scene.yard.sign.name, room: null });
    for (const r of list) {
      const sg = r.sign;
      if (!sg) continue;
      const [x, y] = toScreen(sg.x, sg.y);
      const w = sg.w * this.scale;
      const h = sg.h * this.scale;
      if (x > this.cssW || y > this.cssH || x + w < 0 || y + h < 0) continue;
      const badge = r.room ? this.activeInRoom(r.room) : 0;
      const room = badge ? h : 0;
      let fs = Math.max(7, Math.min(12, h * 0.62));
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      const avail = w - 10 * this.scale * 0.6 - room;
      let label = r.name;
      while (ctx.measureText(label).width > avail && fs > 7) {
        fs -= 0.5;
        ctx.font = `700 ${fs}px system-ui, sans-serif`;
      }
      if (ctx.measureText(label).width > avail) {
        while (label.length > 3 && ctx.measureText(`${label}…`).width > avail) label = label.slice(0, -1);
        label += '…';
      }
      ctx.fillStyle = '#fff6e0';
      ctx.fillText(label, Math.round(x + 6 * this.scale * 0.8 + 2), Math.round(y + h / 2 + 0.5));
      if (badge) {
        const bx = x + w - h / 2 - 1;
        const byy = y + h / 2;
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(bx, byy, h / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${Math.max(7, h * 0.55)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(badge), Math.round(bx), Math.round(byy + 0.5));
        ctx.textAlign = 'start';
      }
    }
  }

  // Names only when readable (zoom >= 1.25) or for hovered/selected characters; overlapping tags are skipped.
  drawNames(ctx, toScreen) {
    const showAll = this.scale >= 1.25;
    const placed = [];
    const nfs = Math.max(9, Math.min(12, 4.4 * this.scale));
    ctx.font = `600 ${nfs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const list = [...this.chars.values()].filter((c) => c.e && this.isVisibleWorld(c.x, c.y)).sort((a, b) => (this.isFocus(b) ? 1 : 0) - (this.isFocus(a) ? 1 : 0));
    for (const c of list) {
      if (!showAll && !this.isFocus(c)) continue;
      const [x, y] = toScreen(c.x, c.y + 6);
      const label = c.e.name.split(' ')[0];
      const w = ctx.measureText(label).width + 8;
      const r = { x: x - w / 2, y: y - nfs * 0.65, w, h: nfs * 1.3 };
      if (placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)) continue;
      placed.push(r);
      ctx.fillStyle = this.selected?.id === c.id ? 'rgba(31,95,191,0.92)' : 'rgba(46,33,24,0.78)';
      ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      ctx.fillStyle = STATE_DOT[c.state] || '#9aa4b2';
      ctx.fillRect(Math.round(r.x), Math.round(r.y), 2, Math.round(r.h));
      ctx.fillStyle = '#fff';
      ctx.fillText(label, Math.round(x + 1), Math.round(y));
    }
    ctx.textAlign = 'start';
  }

  isFocus(c) {
    return (this.selected?.type === 'employee' && this.selected.id === c.id) || (this.hovered?.type === 'employee' && this.hovered.id === c.id);
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
      const [cx, cy] = toScreen(c.x, c.y - FH - 16);
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

  // ---------------- minimap ----------------
  attachMinimap(canvas) {
    this.minimap = canvas;
    this.minimapThumb = null;
    const go = (e) => {
      const r = canvas.getBoundingClientRect();
      const wx = ((e.clientX - r.left) / r.width) * this.scene.mapW * T;
      const wy = ((e.clientY - r.top) / r.height) * this.scene.mapH * T;
      this.focusOn(wx, wy);
      this.draw(performance.now());
    };
    let down = false;
    canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); go(e); });
    canvas.addEventListener('pointermove', (e) => down && go(e));
    canvas.addEventListener('pointerup', () => (down = false));
  }

  updateMinimap(t) {
    const m = this.minimap;
    if (!m || !this.scene || m.hidden) return;
    if (this.lastMini && t - this.lastMini < 400 && !this.dragging) return;
    this.lastMini = t;
    const W = this.scene.mapW * T;
    const H = this.scene.mapH * T;
    const cssW = m.clientWidth || 150;
    const cssH = Math.round((cssW * H) / W);
    if (m.width !== cssW * this.dpr) {
      m.width = cssW * this.dpr;
      m.height = cssH * this.dpr;
      m.style.height = `${cssH}px`;
      this.minimapThumb = null;
    }
    const g = m.getContext('2d');
    if (!this.minimapThumb) {
      const th = document.createElement('canvas');
      th.width = m.width;
      th.height = m.height;
      const tg = th.getContext('2d');
      tg.imageSmoothingEnabled = true;
      if (this.sky) tg.drawImage(this.sky, 0, 0, th.width, (this.sky.height * th.width) / this.sky.width);
      tg.drawImage(this.bg, 0, 0, th.width, th.height);
      this.minimapThumb = th;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.minimapThumb, 0, 0);
    const k = m.width / W;
    for (const c of this.chars.values()) {
      if (!c.e) continue;
      g.fillStyle = STATE_DOT[c.state] || '#9aa4b2';
      g.fillRect(Math.round(c.x * k) - 2, Math.round((c.y - 8) * k) - 2, 4, 4);
    }
    g.strokeStyle = '#ffd34d';
    g.lineWidth = Math.max(1, this.dpr);
    g.strokeRect(this.cam.x * k, this.cam.y * k, (this.cssW / this.scale) * k, (this.cssH / this.scale) * k);
  }

  // ---------------- input ----------------
  rectOf(sel) {
    if (sel.type === 'employee') return this.chars.get(sel.id)?.box || null;
    if (sel.type === 'desk') return sel.desk.rect;
    if (sel.type === 'room') return { x: sel.room.x * T + 2, y: sel.room.y * T + 2, w: sel.room.w * T - 4, h: sel.room.h * T - 4 };
    return null;
  }

  worldAt(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: this.cam.x + (ev.clientX - rect.left) / this.scale, y: this.cam.y + (ev.clientY - rect.top) / this.scale, sx: ev.clientX - rect.left, sy: ev.clientY - rect.top };
  }

  hitTest(w) {
    const inside = (r, pad = 0) => r && w.x >= r.x - pad && w.x <= r.x + r.w + pad && w.y >= r.y - pad && w.y <= r.y + r.h + pad;
    let hit = null;
    for (const c of this.chars.values()) if (inside(c.box, 3)) hit = { type: 'employee', id: c.id, employee: c.e, state: c.state, char: c };
    if (hit) return hit;
    const d = [...this.scene.desks, ...this.scene.visitorDesks].find((x) => inside(x.rect));
    if (d) {
      const occupant = [...this.chars.values()].find((c) => c.desk === d);
      const ownerId = d.owner ?? occupant?.id ?? null;
      if (ownerId) return { type: 'desk', id: ownerId, desk: d };
    }
    const room = this.roomAt(w);
    if (room) return { type: 'room', key: room.key, room, scope: room === this.scene.meeting?.room ? this.scene.meeting.scope : null };
    if (this.scene.yard && w.y >= 0 && w.y < this.scene.yard.h) return { type: 'yard' };
    return null;
  }

  bindInput() {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (drag.moved) {
          this.dragging = true;
          this.cam.x = drag.cx - dx / this.scale;
          this.cam.y = drag.cy - dy / this.scale;
          this.clampCam();
          this.draw(performance.now());
        }
        return;
      }
      if (!this.scene || e.pointerType === 'touch') return;
      const w = this.worldAt(e);
      const h = this.hitTest(w);
      const key = h ? `${h.type}:${h.id ?? h.key}` : null;
      cv.style.cursor = h ? 'pointer' : 'grab';
      if (key !== this.hoverKey) {
        this.hoverKey = key;
        this.hovered = h && h.type !== 'room' ? h : null;
        this.draw(performance.now());
      }
      this.onHover?.(h && h.type === 'employee' ? { ...h, sx: w.sx, sy: w.sy } : null);
    });
    cv.addEventListener('pointerleave', () => {
      this.hovered = null;
      this.hoverKey = null;
      this.onHover?.(null);
      this.draw(performance.now());
    });
    cv.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.click(e);
      drag = null;
      this.dragging = false;
    });
    cv.addEventListener('pointercancel', () => {
      drag = null;
      this.dragging = false;
    });
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
      else if (e.key === '0') return this.fit();
      else return;
      e.preventDefault();
      this.clampCam();
      this.draw(performance.now());
    });
  }

  click(ev) {
    if (!this.scene) return;
    const w = this.worldAt(ev);
    const hit = this.hitTest(w);
    this.selected = hit;
    this.draw(performance.now());
    this.onSelect?.(hit ? { ...hit, sx: w.sx, sy: w.sy } : null);
  }
}
