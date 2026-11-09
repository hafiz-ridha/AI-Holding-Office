// Pixel office renderer (Canvas 2D only, no library). World coordinates are logical pixels (tile = 16 px);
// the camera maps them to screen pixels, so resizing never changes the world.
// Static layers (floors, walls, furniture) are pre-rendered once per scene; each frame blits only the visible part
// and draws only visible characters/ambient objects. Frame rate adapts to what is actually happening:
// 30 FPS while someone walks, 10 FPS for typing/celebrating/speech, 2 FPS ambient, 0 when hidden.
// Character states come ONLY from backend data (plus RESTING, derived from real inactivity by the page).
import { buildSheet, FW, FH } from './sprites.js';
import { T } from './scenes.js';

const SPEED = 44; // px/s, constant walking speed
const SWIM = 0.55; // swimming is slower than walking
const FLOOR = {
  wood: 'floor_wood', woodb: 'floor_wood_b', tile: 'floor_tile', carpet: 'floor_carpet',
  parquet: 'floor_parquet', dark: 'floor_dark', warm: 'floor_warm',
  concrete: 'floor_concrete', deck: 'floor_deck', terrazzo: 'floor_terrazzo',
};
// Manual time of day: a representative hour per period (sun/moon position, wall clocks, lighting).
const PERIOD_HOUR = { morning: [7, 30], afternoon: [12, 30], evening: [17, 15], night: [21, 30] };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Small talk between idle colleagues: shown as bubbles only, never stored or sent anywhere (no AI involved).
// {w} = weather, {p} = time of day; filled in when spoken.
const SMALL_TALK = [
  ['Udah ngopi belum?', 'Belum nih, nanti ke coffee corner yuk.'],
  ['Main ping-pong yuk, mumpung santai.', 'Ayo! Yang kalah traktir kopi ya.'],
  ['Cuacanya {w} ya hari ini.', 'Iya, enaknya sambil ngopi.'],
  ['Selamat {p}! Lagi santai?', 'Iya, nunggu tugas berikutnya.'],
  ['Kolam renangnya seger banget kayaknya.', 'Habis ini aku mau renang sebentar.'],
  ['Skor arcade-mu berapa kemarin?', 'Rekor baru dong, 12 ribu!'],
  ['Laporan kemarin rapi banget.', 'Makasih! Tim kompak sih.'],
  ['Weekend ke mana?', 'Di rumah aja, maraton series.'],
  ['Wifi hari ini kencang ya.', 'Iya, server lagi adem.'],
  ['Makan siang di mana nanti?', 'Coba warung baru depan kantor.'],
  ['Kopi susunya enak hari ini.', 'Pak Ujang lagi semangat bikinnya.'],
  ['Habis ini ada tugas apa?', 'Belum tahu, tunggu arahan CEO.'],
  ['Foosball lagi kosong tuh.', 'Gas! Aku jadi kiper.'],
  ['Target bulan ini aman?', 'Aman, tinggal dirapikan.'],
  ['Tanamannya makin subur ya.', 'Rajin disiram office boy.'],
  ['Kemarin rapatnya lama juga.', 'Tapi hasilnya jelas, worth it.'],
];
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
    this.timeMode = 'auto'; // auto (browser clock) | morning | afternoon | evening | night (manual)
    this.period = dayPeriod(this.clock());
    this.sky = null;
    this.skyKey = '';
    this.npcs = new Map(); // office boys: decorative NPCs, not employees (no data, no AI)
    this.games = new Map(); // running ping-pong / foosball games: key -> { players, kind, table }
    this.spotUse = new Map(); // leisure spot key -> character id (one person per stool/sofa seat/arcade)
    this.bindInput();
  }

  // Scene time: the browser clock, or a fixed hour of the manually chosen period.
  clock() {
    const d = new Date();
    const hm = PERIOD_HOUR[this.timeMode];
    if (hm) d.setHours(hm[0], hm[1], 0, 0);
    return d;
  }

  setTimeMode(mode) {
    const m = PERIOD_HOUR[mode] ? mode : 'auto';
    if (m === this.timeMode) return;
    this.timeMode = m;
    this.period = dayPeriod(this.clock());
    if (this.scene) this.light = this.renderLighting(this.scene, this.period);
    this.skyKey = '';
    this.draw(performance.now());
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
    // Another office, or the same office laid out to a new size (window resized): place everyone directly.
    const changedScene = !this.scene || this.scene.id !== scene.id || this.scene.mapW !== scene.mapW || this.scene.mapH !== scene.mapH;
    this.scene = scene;
    this.grids = new Map(); // walk grids are per scene
    this.sky = null;
    this.bg = this.renderBackground(scene);
    this.light = this.renderLighting(scene, this.period);
    this.games.clear();
    this.spotUse.clear();
    this.leisureCache = null;
    if (changedScene) {
      this.chars.clear();
      this.seatAlloc.clear();
      this.visitorAlloc.clear();
      this.selected = null;
      this.hovered = null;
      this.zoomLevel = null;
      this.firstPlacement = true;
      this.spawnNpcs();
    } else {
      // Same office rebuilt (roster changed): everyone on a break heads back; office boys pick a new job.
      for (const c of this.chars.values()) if (c.outing) this.endOuting(c, performance.now());
      for (const n of this.npcs.values()) Object.assign(n, { path: [], plan: [], step: null, acting: false, until: 0 });
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

  // Swimming pool basin: stone coping, tiled water, deep end, lane line, inner shadow. Moving highlights are ambient.
  drawPoolBase(g, p) {
    g.fillStyle = '#c9c0ad';
    g.fillRect(p.x - 4, p.y - 4, p.w + 8, p.h + 8);
    g.fillStyle = '#f4f1ea';
    g.fillRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);
    g.fillStyle = '#ffffff';
    g.fillRect(p.x - 3, p.y - 3, p.w + 6, 1);
    g.save();
    g.beginPath();
    g.rect(p.x, p.y, p.w, p.h);
    g.clip();
    for (let y = p.y; y < p.y + p.h; y += T) for (let x = p.x; x < p.x + p.w; x += T) this.atlas.draw(g, 'pool_water', x, y);
    g.fillStyle = 'rgba(10,60,120,0.18)';
    g.fillRect(p.x + Math.round((p.w * 2) / 3), p.y, Math.ceil(p.w / 3), p.h);
    g.fillStyle = 'rgba(20,50,130,0.30)';
    g.fillRect(p.x + 14, p.y + Math.round(p.h / 2) - 1, p.w - 28, 2);
    g.fillStyle = 'rgba(0,30,60,0.22)';
    g.fillRect(p.x, p.y, p.w, 3);
    g.fillRect(p.x, p.y, 3, p.h);
    g.restore();
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
    if (s.pool) this.drawPoolBase(g, s.pool);
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
      // Glowing things after dark: underwater pool lights, the neon sign, arcade screens.
      const glow = (x, y, r, rgb, a) => {
        const gr = g.createRadialGradient(x, y, 2, x, y, r);
        gr.addColorStop(0, `rgba(${rgb},${a})`);
        gr.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      };
      if (s.pool) {
        const p = s.pool;
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = period === 'night' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.3)';
        g.fillRect(p.x, p.y, p.w, p.h);
        g.globalCompositeOperation = 'source-over';
        for (let x = p.x + 24; x < p.x + p.w; x += 64) glow(x, p.y + p.h / 2, 40, '90,210,255', period === 'night' ? 0.28 : 0.14);
      }
      for (const w of s.walls) for (const d of w.deco) if (d.f === 'neon_sign') glow(d.x + 20, d.y + 7, 30, '255,106,213', 0.3);
      for (const a of s.ambient) if (a.type === 'arcade') glow(a.x + 9, a.y + 12, 18, '94,200,240', 0.22);
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
  // opts.resting: Set of employee ids without a task whose last real activity is old (derived by the page).
  // IDLE employees stroll around their own room; RESTING employees sit relaxed at their own desk and stretch their
  // legs now and then. Neither ever leaves its room unless a real task/meeting calls them elsewhere.
  setData(data, opts = {}) {
    if (!this.scene) return;
    const s = this.scene;
    const resting = opts.resting || new Set();
    const now = performance.now();
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
      if (state === 'idle' && resting.has(e.id)) state = 'resting';
      const meetingHere = state === 'meeting' && here(e.meeting);
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
            target = d.seat; pose = 'sit_front'; bubble = 'bub_rest'; chairFrame = 'chair_back_n';
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
      // IDLE/RESTING employees roam their own room or take a break (lounge, pool, small talk; see leisure());
      // the 2 s data refresh must not pull them back. A real task ends the break at once.
      const roaming = state === 'idle' || state === 'resting';
      const keepRoaming = roaming && c.state === state && c.home;
      if (c.outing && !keepRoaming) this.endOuting(c, now, { quiet: true });
      if (!keepRoaming && (c.tx !== Math.round(target.x) || c.ty !== Math.round(target.y) || c.state !== state)) {
        c.tx = Math.round(target.x);
        c.ty = Math.round(target.y);
        if (!(this.firstPlacement && c.x === target.x && c.y === target.y)) c.path = this.routeFrom(c, { ...target, x: c.tx, y: c.ty });
      }
      // Resting employees first sit a while; idle ones start strolling after a few seconds (staggered).
      if (roaming && !keepRoaming) c.wanderNext = now + (state === 'resting' ? 20000 + Math.random() * 25000 : 1500 + Math.random() * 4000);
      Object.assign(c, {
        e, state, desk: d, pose, bubble, note,
        home: roaming ? target : null,
        chairFrame: target === d?.seat ? (d?.exec && chairFrame === 'chair' ? 'exec_chair' : chairFrame) : null,
        meetingSeat: meetingHere && target !== s.meeting.leader ? target : null,
      });
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

  // Paths with only horizontal/vertical segments (4-direction walking). Inside a room: shortest path on a walk grid
  // that avoids desks, furniture and the meeting table. Between rooms: room door, corridor, left hallway, door.
  route(c, target) {
    const s = this.scene;
    const from = this.roomAt(c);
    const to = this.roomAt(target);
    if (from && to && from === to) return this.roomPath(from, c, target);
    const path = [];
    let corY;
    if (from) {
      path.push(...this.roomPath(from, c, { x: from.door.x, y: from.door.y - 4 }), { x: from.door.x, y: from.door.corridorY });
      corY = from.door.corridorY;
    } else {
      // Outside the rooms (corridor, hallway, a door opening, the entrance): first step onto the centre line of
      // the nearest corridor, so the walk never slides along a wall.
      const lines = s.corridors.map((k) => (k.y + k.h / 2) * T);
      corY = lines.reduce((best, y) => (Math.abs(y - c.y) < Math.abs(best - c.y) ? y : best), lines[0] ?? c.y);
      if (Math.abs(corY - c.y) > 0.5) path.push({ x: c.x, y: corY });
    }
    if (to) {
      if (to.door.corridorY !== corY) path.push({ x: s.hallX, y: corY }, { x: s.hallX, y: to.door.corridorY });
      // Straight up through the door opening, then inside the room (never diagonally through the wall).
      const inside = { x: to.door.x, y: to.door.y - 4 };
      path.push({ x: to.door.x, y: to.door.corridorY }, inside, ...this.roomPath(to, inside, target));
    } else path.push({ x: target.x, y: target.y });
    return path;
  }

  // Walk grid of a room (8 px cells). A cell is blocked when a character's feet would touch a piece of furniture's
  // sprite (+ small margin). Standing north of an object is fine: the body is drawn upward from the feet.
  gridFor(room) {
    this.grids ||= new Map();
    if (this.grids.get(room)) return this.grids.get(room);
    const s = this.scene;
    const C = 8;
    const x0 = room.x * T + 8;
    const y0 = (room.y + 2) * T + 6;
    const cols = Math.max(1, Math.floor(((room.x + room.w) * T - 8 - x0) / C));
    const rows = Math.max(1, Math.floor(((room.y + room.h) * T - 8 - y0) / C));
    const obs = [];
    const add = (x, y, w, h) => obs.push({ x: x - 3, y: y - 4, w: w + 6, h: h + 7 });
    const inRoom = (x, y, w, h) => x < (room.x + room.w) * T && x + w > room.x * T && y < (room.y + room.h) * T && y + h > room.y * T;
    for (const p of s.props) if (inRoom(p.x, p.y, p.w, p.h)) add(p.x, p.y, p.w, p.h);
    for (const a of s.ambient) {
      if (a.type !== 'plant') continue;
      const z = this.atlas.size(a.f);
      if (inRoom(a.x, a.y, a.w ?? z.w, a.h ?? z.h)) add(a.x, a.y, a.w ?? z.w, a.h ?? z.h);
    }
    for (const e of s.extras) {
      const z = this.atlas.size(e.f);
      if (inRoom(e.x, e.y, z.w, z.h)) add(e.x, e.y, z.w, z.h);
    }
    for (const d of [...s.desks, ...s.visitorDesks]) if (d.room === room) add(d.rect.x, d.rect.y, d.rect.w, d.rect.h);
    if (s.meeting?.room === room) {
      const t = s.meeting.table;
      add(t.x - 10, t.y - 24, t.w + 20, t.h + 46);
    }
    if (s.pool && s.pool.room === room) add(s.pool.x - 2, s.pool.y - 2, s.pool.w + 4, s.pool.h + 4);
    const blocked = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const fx = x0 + i * C + C / 2 - 5;
        const fy = y0 + j * C + C / 2 - 3;
        if (obs.some((o) => fx < o.x + o.w && fx + 10 > o.x && fy < o.y + o.h && fy + 5 > o.y)) blocked[j * cols + i] = 1;
      }
    }
    const g = { x0, y0, cols, rows, C, blocked };
    this.grids.set(room, g);
    return g;
  }

  cellOf(g, p) {
    const i = Math.min(g.cols - 1, Math.max(0, Math.floor((p.x - g.x0) / g.C)));
    const j = Math.min(g.rows - 1, Math.max(0, Math.floor((p.y - g.y0) / g.C)));
    return j * g.cols + i;
  }

  cellCenter(g, n) {
    return { x: g.x0 + (n % g.cols) * g.C + g.C / 2, y: g.y0 + Math.floor(n / g.cols) * g.C + g.C / 2 };
  }

  // Breadth-first search over free cells (start/goal may be blocked, e.g. a desk seat). Returns prev[] links.
  bfs(g, start, goal = -1) {
    const prev = new Int32Array(g.cols * g.rows).fill(-1);
    prev[start] = start;
    const q = [start];
    for (let k = 0; k < q.length; k++) {
      const cur = q[k];
      if (cur === goal) break;
      const ci = cur % g.cols;
      const cj = Math.floor(cur / g.cols);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= g.cols || nj >= g.rows) continue;
        const n = nj * g.cols + ni;
        if (prev[n] !== -1 || (g.blocked[n] && n !== goal)) continue;
        prev[n] = cur;
        q.push(n);
      }
    }
    return prev;
  }

  roomPath(room, from, to) {
    const g = this.gridFor(room);
    let start = this.cellOf(g, from);
    const goal = this.cellOf(g, to);
    const pts = [];
    let px = from.x;
    let py = from.y;
    const step = (x, y) => {
      if (Math.abs(x - px) < 0.5 && Math.abs(y - py) < 0.5) return;
      if (Math.abs(x - px) >= 0.5 && Math.abs(y - py) >= 0.5) pts.push({ x, y: py }); // keep it orthogonal
      pts.push({ x, y });
      px = x;
      py = y;
    };
    if (g.blocked[start] && start !== goal) {
      // Sitting on furniture (desk chair, bar stool, bean bag): get up onto the nearest free floor first.
      const reach = this.reachOf(room);
      let best = -1;
      let bd = Infinity;
      for (let n = 0; n < reach.length; n++) {
        if (reach[n] === -1 || g.blocked[n]) continue;
        const c = this.cellCenter(g, n);
        const d = Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      if (best !== -1 && bd <= 24) {
        const c = this.cellCenter(g, best);
        step(c.x, c.y);
        start = best;
      }
    }
    let hop = true; // final short step from the last free cell onto the target (a seat, a stool, a desk chair)
    if (start !== goal) {
      const prev = this.bfs(g, start, goal);
      let end = goal;
      if (prev[goal] === -1) {
        // Target not reachable on free floor: stop at the reachable free cell nearest to it. Never cut through
        // furniture or walls; sit down only when the target is right next to that cell.
        let bd = Infinity;
        for (let n = 0; n < prev.length; n++) {
          if (prev[n] === -1 || g.blocked[n]) continue;
          const c = this.cellCenter(g, n);
          const d = Math.abs(c.x - to.x) + Math.abs(c.y - to.y);
          if (d < bd) {
            bd = d;
            end = n;
          }
        }
        if (end === goal) return [];
        hop = bd <= 20;
      }
      const cells = [];
      for (let n = end; n !== start; n = prev[n]) cells.push(n);
      cells.reverse();
      for (const n of end === goal ? cells.slice(0, -1) : cells) {
        const p = this.cellCenter(g, n);
        step(p.x, p.y);
      }
    }
    if (hop) step(to.x, to.y);
    // Drop intermediate points on straight lines.
    return pts.filter((p, i) => {
      const a = i ? pts[i - 1] : { x: from.x, y: from.y };
      const b = pts[i + 1];
      return !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
    });
  }

  // Idle stroll: pick a random reachable free spot in the employee's own room, walk there, pause, glance around.
  wander(c, now) {
    const room = c.desk?.room || this.roomAt(c);
    if (!room || this.roomAt(c) !== room) {
      // Somewhere else (e.g. after a break that was cut short): walk back to the desk first.
      if (room && c.home) {
        c.path = this.routeFrom(c, c.home);
        c.tx = Math.round(c.home.x);
        c.ty = Math.round(c.home.y);
      }
      c.wanderNext = now + 5000;
      return;
    }
    const atHome = c.home && Math.abs(c.x - c.home.x) < 1 && Math.abs(c.y - c.home.y) < 1;
    let target = null;
    if (c.state === 'resting' && !atHome) target = c.home; // back to the chair after a short stroll
    else if (c.state === 'idle' && !atHome && Math.random() < 0.2) target = c.home;
    else {
      const g = this.gridFor(room);
      const start = this.cellOf(g, c);
      const prev = this.bfs(g, start);
      const options = [];
      for (let n = 0; n < prev.length; n++) {
        if (prev[n] === -1 || n === start || g.blocked[n]) continue;
        const p = this.cellCenter(g, n);
        const dist = Math.abs(p.x - c.x) + Math.abs(p.y - c.y);
        if (dist >= 24 && dist <= 150) options.push(p);
      }
      if (options.length) target = options[Math.floor(Math.random() * options.length)];
    }
    if (!target) {
      c.wanderNext = now + 4000;
      return;
    }
    c.path = this.roomPath(room, c, target);
    c.tx = Math.round(target.x);
    c.ty = Math.round(target.y);
    let len = 0;
    let q = c;
    for (const p of c.path) {
      len += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      q = p;
    }
    const pause = c.state === 'resting'
      ? (target === c.home ? 20000 + Math.random() * 25000 : 2500 + Math.random() * 3500)
      : 3000 + Math.random() * 6000;
    c.wanderNext = now + (len / SPEED) * 1000 + pause;
  }

  // ---------------- free spots & the pool ----------------
  inPool(p) {
    const q = this.scene?.pool;
    return Boolean(q) && p.x > q.x && p.x < q.x + q.w && p.y > q.y && p.y < q.y + q.h + 2;
  }

  // Cells of a room reachable from its door (cached with the walk grid).
  reachOf(room) {
    const g = this.gridFor(room);
    if (!g.reach) g.reach = this.bfs(g, this.cellOf(g, { x: room.door.x, y: room.door.y - 4 }));
    return g.reach;
  }

  // Nearest free, reachable cell centre to a point (null outside the rooms). `avoid`: cells already taken.
  snap(p, avoid = null) {
    const room = this.roomAt(p);
    if (!room) return null;
    const g = this.gridFor(room);
    const reach = this.reachOf(room);
    let best = null;
    let bd = Infinity;
    for (let n = 0; n < reach.length; n++) {
      if (reach[n] === -1 || g.blocked[n]) continue;
      const c = this.cellCenter(g, n);
      if (avoid && avoid.some((a) => Math.abs(a.x - c.x) < 8 && Math.abs(a.y - c.y) < 8)) continue;
      const d = Math.abs(c.x - p.x) + Math.abs(c.y - p.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  randomFree(room) {
    if (!room) return null;
    const g = this.gridFor(room);
    const reach = this.reachOf(room);
    const opts = [];
    for (let n = 0; n < reach.length; n++) if (reach[n] !== -1 && !g.blocked[n]) opts.push(this.cellCenter(g, n));
    return opts.length ? pick(opts) : null;
  }

  // Deck spot above the pool, next to the ladder: swimmers get in and out here (straight down into the water).
  poolExit() {
    return this.leisureSpots().poolEntry;
  }

  // A target someone sits/stands on (stool, sofa seat, end of a table) is usable only when free floor reachable
  // from the door lies right next to it, so nobody has to walk through furniture to get there.
  reachableNear(p, max = 20) {
    const room = this.roomAt(p);
    if (!room) return false;
    const g = this.gridFor(room);
    const reach = this.reachOf(room);
    for (let n = 0; n < reach.length; n++) {
      if (reach[n] === -1 || g.blocked[n]) continue;
      const c = this.cellCenter(g, n);
      if (Math.abs(c.x - p.x) + Math.abs(c.y - p.y) <= max) return true;
    }
    return false;
  }

  // Like route(), but someone in the pool first swims to the ladder and climbs out.
  routeFrom(c, target) {
    const q = this.scene?.pool;
    const ex = q && this.inPool(c) ? this.poolExit() : null;
    if (ex) return [{ x: ex.x, y: c.y }, { x: ex.x, y: q.y + 3 }, { x: ex.x, y: ex.y }, ...this.route(ex, target)];
    return this.route(c, target);
  }

  swimLaps(c) {
    const q = this.scene.pool;
    const m = 9;
    const rx = () => Math.round(q.x + m + Math.random() * (q.w - 2 * m));
    const ry = () => Math.round(q.y + m + Math.random() * (q.h - 2 * m));
    const a = { x: rx(), y: Math.round(Math.min(Math.max(c.y, q.y + m), q.y + q.h - m)) };
    const b = { x: a.x, y: ry() };
    const d = { x: rx(), y: b.y };
    const e = { x: d.x, y: ry() };
    return [{ x: c.x, y: a.y }, a, b, d, e];
  }

  pathTime(c) {
    let len = 0;
    let q = c;
    for (const p of c.path) {
      len += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      q = p;
    }
    return (len / SPEED) * 1000;
  }

  // ---------------- breaks for employees without a task ----------------
  // IDLE / RESTING employees now and then take a break: small talk with a colleague (bubbles only, never stored or
  // sent anywhere), coffee at the bar, the sofa, arcade, ping-pong / foosball together, or a swim. The state shown is
  // still the real one (IDLE / RESTING); as soon as a real task or meeting arrives, setData() ends the break.
  leisureSpots() {
    if (this.leisureCache) return this.leisureCache;
    const s = this.scene;
    const L = { stools: [], arcades: [], tables: [], sofas: [], pool: null, poolEntry: null, lounge: s.rooms.find((r) => r.key === 'lounge') || null };
    this.leisureCache = L;
    const ok = (p) => this.reachableNear(p);
    for (const p of s.props) {
      if (p.f === 'bar_stool') L.stools.push({ key: `stool:${p.x},${p.y}`, x: p.x + 5, y: p.y + 10, pose: 'sit_back' });
      else if (p.f === 'arcade') L.arcades.push({ key: `arcade:${p.x},${p.y}`, x: p.x + 9, y: p.y + p.h + 8, pose: 'walk_up' });
      else if (p.f === 'pingpong' || p.f === 'foosball') {
        const mid = p.y + Math.round(p.h / 2) + 4;
        const ends = [{ x: p.x - 9, y: mid, flip: false }, { x: p.x + p.w + 9, y: mid, flip: true }];
        if (ends.every(ok)) L.tables.push({ key: `${p.f}:${p.x},${p.y}`, kind: p.f, table: p, ends });
      }
    }
    for (const seat of s.restSeats) L.sofas.push({ key: `sofa:${seat.x},${seat.y}`, x: seat.x, y: seat.y, pose: seat.pose });
    L.stools = L.stools.filter(ok);
    L.arcades = L.arcades.filter(ok);
    L.sofas = L.sofas.filter(ok);
    // Pool entry: free deck cell straight above the water, as close to the ladder as possible.
    const q = s.pool;
    if (q) {
      const g = this.gridFor(q.room);
      const reach = this.reachOf(q.room);
      const ladderX = q.x + q.w - 20;
      let bd = Infinity;
      for (let n = 0; n < reach.length; n++) {
        if (reach[n] === -1 || g.blocked[n]) continue;
        const c = this.cellCenter(g, n);
        if (c.x < q.x + 8 || c.x > q.x + q.w - 8 || c.y > q.y - 2 || c.y < q.y - 24) continue;
        const d = Math.abs(c.x - ladderX) + Math.abs(c.y - (q.y - 8));
        if (d < bd) {
          bd = d;
          L.poolEntry = c;
        }
      }
      if (L.poolEntry) L.pool = q;
    }
    return L;
  }

  swimmerCount() {
    let n = 0;
    for (const c of this.chars.values()) if (c.outing?.kind === 'swim') n++;
    return n;
  }

  smallTalk() {
    const w = { cerah: 'cerah', berawan: 'berawan', hujan: 'hujan', badai: 'lagi badai' }[this.weather] || 'cerah';
    const p = { morning: 'pagi', afternoon: 'siang', evening: 'sore', night: 'malam' }[this.period] || 'siang';
    const fill = (t) => t.replace('{w}', w).replace('{p}', p);
    const first = pick(SMALL_TALK);
    const lines = first.map(fill);
    if (Math.random() < 0.4) lines.push(...pick(SMALL_TALK.filter((x) => x !== first)).map(fill));
    return lines;
  }

  leisure(c, now) {
    const L = this.leisureSpots();
    const idle = [...this.chars.values()].filter((x) => x.e && x.home && (x.state === 'idle' || x.state === 'resting'));
    const onBreak = idle.filter((x) => x.outing).length;
    if (onBreak >= Math.ceil(idle.length * 0.6) || Math.random() > (c.state === 'resting' ? 0.55 : 0.3)) return this.wander(c, now);
    const mates = idle.filter((x) => x !== c && !x.outing && !x.path.length);
    const free = (sp) => !this.spotUse.has(sp.key);
    const table = L.tables.find((t) => !this.games.has(t.key));
    const opts = [];
    if (mates.length) opts.push(['chat', 3]);
    if (mates.length && table) opts.push(['game', 2]);
    if (L.stools.some(free)) opts.push(['coffee', 2]);
    if (L.sofas.some(free)) opts.push(['sofa', c.state === 'resting' ? 3 : 1]);
    if (L.arcades.some(free)) opts.push(['arcade', 1.5]);
    if (L.pool && this.swimmerCount() < 3) opts.push(['swim', c.state === 'resting' ? 2.5 : 1.2]);
    let r = Math.random() * opts.reduce((n, o) => n + o[1], 0);
    const kind = opts.find((o) => (r -= o[1]) < 0)?.[0];
    if (!kind) return this.wander(c, now);
    const go = (who, spot, o) => {
      who.outing = { kind, until: now + 45000, ...o };
      who.path = this.routeFrom(who, spot);
      who.tx = Math.round(spot.x);
      who.ty = Math.round(spot.y);
    };
    if (kind === 'chat') {
      const mate = pick(mates);
      const room = L.lounge && Math.random() < 0.5 ? L.lounge : c.desk?.room || L.lounge;
      const a = this.randomFree(room);
      const b = a && this.snap({ x: a.x + 16, y: a.y }, [a]);
      if (!a || !b || Math.abs(b.y - a.y) > 8 || Math.abs(b.x - a.x) > 24) return this.wander(c, now);
      const [left, right] = a.x <= b.x ? [a, b] : [b, a];
      go(c, left, { partner: mate.id, flip: false, pose: 'walk_side', lines: this.smallTalk(), leader: true });
      go(mate, right, { partner: c.id, flip: true, pose: 'walk_side' });
    } else if (kind === 'game') {
      const mate = pick(mates);
      this.games.set(table.key, { key: table.key, kind: table.kind, table: table.table, players: [c.id, mate.id], since: 0 });
      go(c, table.ends[0], { key: table.key, game: true, flip: table.ends[0].flip, pose: 'walk_side' });
      go(mate, table.ends[1], { key: table.key, game: true, flip: table.ends[1].flip, pose: 'walk_side' });
    } else if (kind === 'swim') {
      const ex = this.poolExit();
      c.outing = { kind, until: now + 60000, pose: 'walk_down' };
      c.path = [...this.routeFrom(c, ex), { x: ex.x, y: L.pool.y + 6 }];
    } else {
      const list = kind === 'coffee' ? L.stools : kind === 'sofa' ? L.sofas : L.arcades;
      const sp = pick(list.filter(free));
      this.spotUse.set(sp.key, c.id);
      go(c, sp, { key: sp.key, pose: sp.pose });
    }
  }

  tickOuting(c, now) {
    const o = c.outing;
    if (!o.arrived) {
      o.arrived = now;
      const [lo, hi] = { coffee: [15, 30], sofa: [25, 50], arcade: [15, 30], swim: [30, 55], chat: [40, 40], game: [40, 40] }[o.kind] || [15, 30];
      o.until = now + (lo + Math.random() * (hi - lo)) * 1000; // chat/game: waiting for the partner (safety limit)
      if (o.kind === 'swim') {
        c.path = this.swimLaps(c);
        o.nextLap = now + 8000 + Math.random() * 8000;
        return;
      }
      if (o.kind === 'coffee' && Math.random() < 0.35) this.say(c.id, pick(['Kopinya enak hari ini.', 'Ah, segarnya.', 'Pas banget buat santai.']), 3500);
      if (o.kind === 'arcade' && Math.random() < 0.3) this.say(c.id, pick(['Rekor baru, nih!', 'Satu level lagi…', 'Yes! Menang!']), 3000);
    }
    if (o.kind === 'chat') {
      const p = this.chars.get(o.partner);
      if (!p || p.outing?.partner !== c.id) return this.endOuting(c, now);
      if (o.leader && p.outing.arrived && !p.path.length && !o.script) {
        o.script = o.lines.map((text, i) => ({ at: now + 300 + i * 3300, who: i % 2 ? p.id : c.id, text }));
        o.until = now + 300 + o.lines.length * 3300 + 1200;
        p.outing.until = o.until + 300;
      }
      while (o.script?.length && now >= o.script[0].at) {
        const l = o.script.shift();
        this.say(l.who, l.text, 3500);
      }
    } else if (o.kind === 'game') {
      const g = this.games.get(o.key);
      if (!g) return this.endOuting(c, now);
      if (!g.since && g.players.every((id) => this.chars.get(id)?.outing?.arrived && !this.chars.get(id).path.length)) {
        g.since = now;
        const end = now + (25 + Math.random() * 15) * 1000;
        for (const id of g.players) this.chars.get(id).outing.until = end;
        if (Math.random() < 0.5) this.say(c.id, pick(['Siap? Servis!', 'Ayo, kali ini aku menang.', 'Best of three ya!']), 3000);
      }
    } else if (o.kind === 'swim' && now >= o.nextLap && now < o.until - 6000) {
      c.path = this.swimLaps(c);
      o.nextLap = now + 8000 + Math.random() * 8000;
      return;
    }
    if (now >= o.until) this.endOuting(c, now);
  }

  // End a break and walk back to the desk. quiet: the caller sets the new route (a real task arrived).
  endOuting(c, now, { quiet = false } = {}) {
    const o = c.outing;
    if (!o) return;
    c.outing = null;
    if (o.key && this.spotUse.get(o.key) === c.id) this.spotUse.delete(o.key);
    if (o.game) {
      const g = this.games.get(o.key);
      this.games.delete(o.key);
      for (const id of g?.players || []) {
        const p = this.chars.get(id);
        if (p && p !== c && p.outing?.key === o.key) this.endOuting(p, now);
      }
    }
    if (o.kind === 'chat') {
      const p = this.chars.get(o.partner);
      if (p?.outing?.partner === c.id) this.endOuting(p, now);
    }
    if (quiet || !c.home) return;
    c.path = this.routeFrom(c, c.home);
    c.tx = Math.round(c.home.x);
    c.ty = Math.round(c.home.y);
    c.wanderNext = now + this.pathTime(c) + (c.state === 'resting' ? 15000 : 4000) + Math.random() * 6000;
  }

  // ---------------- office boys (decorative NPCs) ----------------
  // Not AI employees: no data, no state, never stored. They make coffee at the coffee corner and bring it to someone
  // who is really working right now (otherwise to anyone at a desk), mop floors, skim the pool and water the plants,
  // walking between rooms through the doors, corridors and hallway like everyone else.
  spawnNpcs() {
    this.npcs = new Map();
    const s = this.scene;
    const taken = [];
    (s.npcs || []).forEach((n, i) => {
      const base = s.spots?.station || s.spots?.coffee;
      const at = (base && this.snap({ x: base.x + i * 16, y: base.y + (i % 2) * 8 }, taken)) || this.randomFree(s.rooms.find((r) => r.key === 'lounge') || s.rooms[0]);
      if (!at) return;
      taken.push(at);
      this.npcs.set(n.id, {
        id: n.id, npc: true, name: n.name, avatar: n.avatar, sheet: buildSheet(n.avatar), x: at.x, y: at.y, path: [], flip: false, walkPose: 'walk_down',
        phase: Math.random() * 7, plan: [], step: null, acting: false, until: performance.now() + 1500 + i * 2500, note: 'Siaga di pantry', item: null, job: null,
      });
    });
  }

  npcJob(n) {
    const s = this.scene;
    const station = s.spots?.station;
    const coffee = s.spots?.coffee;
    const people = [...this.chars.values()].filter((c) => c.e && c.desk?.stand && c.desk.room && !c.outing);
    const busy = people.filter((c) => ACTIVE.has(c.state));
    const others = [...this.npcs.values()].filter((x) => x !== n);
    const plants = s.ambient.filter((a) => a.type === 'plant' && this.roomAt({ x: a.x + 4, y: a.y + (a.h || 14) }));
    const opts = [];
    if (coffee && people.length) opts.push(['coffee', busy.length ? 4 : 2]);
    opts.push(['mop', 2.5]);
    if (s.spots?.pool?.length && !others.some((o) => o.job === 'pool')) opts.push(['pool', 1.5]);
    if (plants.length) opts.push(['plants', 1.5]);
    if (station) opts.push(['rest', 1]);
    let r = Math.random() * opts.reduce((k, o) => k + o[1], 0);
    const job = opts.find((o) => (r -= o[1]) < 0)?.[0] || 'mop';
    n.job = job;
    if (job === 'coffee') {
      const who = pick(busy.length ? busy : people);
      const name = who.e.name.split(' ')[0];
      return [
        { to: coffee, act: 'brew', dur: 3500 + Math.random() * 2500, note: 'Membuat kopi di coffee corner' },
        { to: who.desk.stand, carry: 'tray', walkNote: `Mengantar kopi untuk ${who.e.name}`, act: 'serve', dur: 2500, item: 'tray', note: `Menyajikan kopi untuk ${who.e.name}`, say: pick([`Kopinya, ${name}!`, 'Kopi panas datang!', 'Semangat kerjanya!']) },
        ...(station ? [{ to: station, act: 'idle', dur: 4000 + Math.random() * 6000, note: 'Kembali ke pantry' }] : []),
      ];
    }
    if (job === 'pool') {
      const sp = pick(s.spots.pool);
      return [{ to: sp, carry: 'net', walkNote: 'Menuju kolam renang', act: 'skim', dur: 7000 + Math.random() * 4000, item: 'net', note: 'Membersihkan kolam renang', faceLeft: sp.x > s.pool.x + s.pool.w / 2 }];
    }
    if (job === 'plants') {
      const pl = pick(plants);
      const spot = this.snap({ x: pl.x + (pl.w || 12) + 8, y: pl.y + (pl.h || 14) });
      if (spot) return [{ to: spot, carry: 'can', walkNote: 'Mengambil penyiram tanaman', act: 'water', dur: 3500, item: 'can', note: 'Menyiram tanaman', faceLeft: spot.x > pl.x + (pl.w || 12) / 2 }];
    }
    if (job === 'rest' && station) return [{ to: station, act: 'idle', dur: 6000 + Math.random() * 8000, note: 'Istirahat sejenak di pantry' }];
    const rooms = s.rooms.filter((rm) => rm.key !== 'pool');
    const rm = pick(rooms);
    const spot = this.randomFree(rm);
    return spot ? [{ to: spot, carry: 'mop', walkNote: `Menuju ${rm.name}`, act: 'mop', dur: 7000 + Math.random() * 5000, item: 'mop', note: `Mengepel lantai ${rm.name}` }] : [];
  }

  npcThink(n, now) {
    if (n.path.length) return;
    if (n.step && !n.acting) {
      // Arrived: do the job for a while.
      n.acting = true;
      n.until = now + n.step.dur;
      n.note = n.step.note;
      n.item = n.step.item ?? null;
      if (n.step.say) this.say(n.id, n.step.say, 3000);
      return;
    }
    if (now < n.until) return;
    n.acting = false;
    if (!n.plan.length) n.plan = this.npcJob(n);
    n.step = n.plan.shift() || null;
    if (!n.step) {
      n.until = now + 3000;
      return;
    }
    const to = this.snap(n.step.to) || n.step.to;
    n.item = n.step.carry ?? null;
    if (n.step.walkNote) n.note = n.step.walkNote;
    n.path = this.routeFrom(n, to);
  }

  // ---------------- camera ----------------
  resize() {
    if (!this.scene) return;
    const wrap = this.canvas.parentElement;
    const cssW = wrap.clientWidth || 640;
    const worldW = this.scene.mapW * T;
    const worldH = this.scene.mapH * T;
    // The page may provide the available height (e.g. to fill the space next to the chat column).
    const maxH = this.maxHeight?.() ?? Math.round(window.innerHeight * 0.72);
    const phone = window.innerWidth < 700;
    // "Pas" (fit) shows the whole office — front yard and every room — inside the canvas (width and height).
    // Phones keep a readable 1:1 scale and pan instead.
    const fitAll = Math.min(cssW / worldW, maxH / worldH);
    const minScale = Math.max(0.25, Math.min(1, fitAll));
    this.scale = this.zoomLevel ?? (phone ? Math.max(cssW / worldW, 1) : fitAll);
    this.scale = Math.min(4, Math.max(minScale, this.scale));
    // Desktop: the canvas always fills the available height (aligned with the side column); the map is centred.
    const cssH = phone ? Math.min(Math.round(worldH * this.scale), maxH) : maxH;
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
    this.zoomLevel = Math.min(4, Math.max(0.25, (this.zoomLevel ?? this.scale) * factor));
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
      else if (this.npcMoving) interval = 1000 / 20; // only office boys walking
      else if (this.ambientOn && this.raining() && this.yardVisible()) interval = 1000 / 15; // rain on screen
      else if (this.speech.size || this.anyVisible((c) => ['working', 'completed', 'thinking'].includes(c.state) || Boolean(c.outing?.arrived))) interval = 100;
      if (t - this.lastDraw >= interval) {
        this.lastDraw = t;
        const p = dayPeriod(this.clock());
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
    let npcMoving = false;
    const now = performance.now();
    for (const c of this.chars.values()) {
      if (c.outing) {
        if (!c.path.length) this.tickOuting(c, now);
      } else if (!c.path.length && this.ambientOn && c.home && (c.state === 'idle' || c.state === 'resting') && now >= (c.wanderNext || 0)) {
        this.leisure(c, now);
      }
      if (this.stepAlong(c, dt)) moving = true;
    }
    for (const n of this.npcs.values()) {
      if (this.ambientOn) this.npcThink(n, now);
      if (this.stepAlong(n, dt)) npcMoving = true;
    }
    this.npcMoving = npcMoving;
    return moving;
  }

  // Move one character along its path at constant speed (slower in the pool). True when it moved on screen.
  stepAlong(c, dt) {
    if (!c.path.length) return false;
    const wp = c.path[0];
    const dx = wp.x - c.x;
    const dy = wp.y - c.y;
    const d = Math.hypot(dx, dy);
    const step = SPEED * (this.inPool(c) ? SWIM : 1) * dt;
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
    return this.isVisibleWorld(c.x, c.y);
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
      const now = this.clock();
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
      } else if (a.type === 'pool') {
        items.push({ z: -2, draw: () => this.drawPoolShimmer(ctx, a, sec) });
      } else if (a.type === 'float') {
        const t = this.ambientOn ? sec : 0;
        items.push({ z: -1, draw: () => A.draw(ctx, 'float_ring', a.x + Math.round(Math.sin(t * 0.35) * 8), a.y + Math.round(Math.sin(t * 1.1) * 1.5)) });
      } else if (a.type === 'steam') {
        if (this.ambientOn) items.push({ z: a.y + 30, draw: () => this.drawSteam(ctx, a.x, a.y, sec) });
      } else if (a.type === 'arcade') {
        items.push({ z: -1, draw: () => this.drawArcadeScreen(ctx, a.x, a.y, sec) });
      }
    }
    // Office boys (+ the wet-floor sign while mopping).
    for (const n of this.npcs.values()) {
      if (!this.isVisibleWorld(n.x, n.y)) continue;
      if (n.acting && n.step?.act === 'mop') items.push({ z: n.y + 2, draw: () => A.draw(ctx, 'wet_sign', Math.round(n.x + 10), Math.round(n.y - 12)) });
      items.push({ z: n.y, npc: n });
    }
    // Ball of a running ping-pong / foosball game (two idle colleagues playing).
    for (const g of this.games.values()) {
      if (!g.since || !this.isVisibleWorld(g.table.x, g.table.y)) continue;
      items.push({ z: g.table.y + g.table.h + 1, draw: () => this.drawBall(ctx, g, sec) });
    }
    for (const c of this.chars.values()) {
      if (!c.e || !this.isVisibleWorld(c.x, c.y)) continue;
      const pose0 = this.livePose(c);
      const seated = !c.path.length && (pose0 === 'sit_back' || pose0 === 'sit_front');
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
      else if (it.npc) this.drawNpc(ctx, it.npc, sec);
      else this.drawChar(ctx, it.c, sec);
    }
    // Lighting (day/night) over the world, below the UI-like indicators.
    if (this.light) {
      const lw = Math.min(this.light.width - sx, sw);
      const lh = Math.min(this.light.height - sy, sh);
      if (lw > 0 && lh > 0) ctx.drawImage(this.light, sx, sy, lw, lh, sx, sy, lw, lh);
    }
    if (yardOn && yard && this.raining()) this.drawRain(ctx, this.scene, sec);
    // Activity indicators (small, above heads). Nobody shows one while swimming or playing.
    for (const c of this.chars.values()) {
      if (!c.e || c.path.length || !c.bubble || !this.isVisibleWorld(c.x, c.y) || this.inPool(c) || (c.outing?.arrived && c.outing.kind !== 'sofa')) continue;
      const seated = this.livePose(c) === 'sit_back' || this.livePose(c) === 'sit_front';
      const by = c.y - FH - (seated ? 9 : 13) - (c.pose === 'jump' ? 3 : 0);
      if (c.bubble === 'gear') A.draw(ctx, `ico_gear_${Math.floor(sec * 4) % 2}`, c.x + 3, by + 1);
      else if (c.bubble === 'think') {
        A.draw(ctx, `bub_type_${Math.floor(sec * 3) % 3}`, c.x + 3, by);
        A.draw(ctx, 'ico_ai', c.x + 12, by - 4);
      } else if (c.bubble === 'bub_rest') {
        if (seated && Math.floor((sec + c.phase) / 3) % 3 === 0) A.draw(ctx, c.bubble, c.x + 3, by);
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
    const d = this.clock();
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

  // A resting employee only sits while at its own chair; strolling around the room it stands. On a break the pose
  // comes from the break (stool, sofa, arcade, facing a colleague or the table).
  livePose(c) {
    if (c.outing?.arrived && !c.path.length && c.outing.pose) return c.outing.pose;
    if (c.state !== 'resting') return c.pose;
    const s = c.desk?.seat;
    return s && Math.abs(c.x - s.x) < 1 && Math.abs(c.y - s.y) < 1 ? c.pose : 'stand';
  }

  drawChar(ctx, c, sec) {
    let pose = c.path.length ? c.walkPose : this.livePose(c);
    let flip = c.flip;
    let fps = 1;
    let frame;
    if (c.path.length) fps = 8;
    else if (pose === 'sit_back') fps = c.state === 'working' ? 5 : 0;
    else if (pose === 'jump') fps = 3;
    else if (pose === 'sit_front') fps = 0.5;
    const o = !c.path.length && c.outing?.arrived ? c.outing : null;
    if (o && pose === 'walk_side') {
      flip = Boolean(o.flip);
      // Playing: swing the bat now and then; talking: mostly still.
      frame = o.game && this.games.get(o.key)?.since ? (Math.floor((sec + c.phase) * 2.5) % 2 ? 1 : 0) : 0;
    } else if (o && pose === 'walk_up') frame = Math.floor((sec + c.phase) * 3) % 2 ? 1 : 0; // arcade: buttons
    if (!o && !c.path.length && pose === 'stand' && (c.state === 'idle' || c.state === 'resting') && this.ambientOn) {
      // Idle: breathing, and now and then a short glance to one side.
      const cyc = (sec + c.phase) % 9;
      if (cyc > 7.6) {
        pose = 'walk_side';
        flip = Math.floor((sec + c.phase) / 9) % 2 === 0;
        frame = 0;
      }
    }
    if (frame === undefined) frame = fps ? Math.floor((sec + c.phase) * fps) : 0;
    if (this.inPool(c)) {
      pose = c.path.length ? c.walkPose : 'walk_down';
      frame = Math.floor((sec + c.phase) * (c.path.length ? 5 : 1.5));
    }
    this.blitChar(ctx, c, pose, frame, flip, sec);
  }

  // Draw a character sprite with its feet at (c.x, c.y). In the pool only head and shoulders show above the water.
  blitChar(ctx, c, pose, frame, flip, sec = 0) {
    const [sx, sy] = c.sheet.frame(pose, frame);
    const x = Math.round(c.x - FW / 2);
    const swim = this.inPool(c);
    const hgt = swim ? 15 : FH + 2;
    const y = Math.round(swim ? c.y - 15 : c.y - FH);
    if (!swim) {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(Math.round(c.x - 5), Math.round(c.y - 1), 10, 2);
      ctx.fillRect(Math.round(c.x - 4), Math.round(c.y), 8, 1);
    }
    if (flip && pose === 'walk_side') {
      ctx.save();
      ctx.translate(x + FW, y);
      ctx.scale(-1, 1);
      ctx.drawImage(c.sheet.canvas, sx, sy, FW, hgt, 0, 0, FW, hgt);
      ctx.restore();
    } else ctx.drawImage(c.sheet.canvas, sx, sy, FW, hgt, x, y, FW, hgt);
    if (swim) {
      // Water line with ripples around the swimmer.
      const k = Math.floor((sec + c.phase) * 3) % 2;
      ctx.fillStyle = 'rgba(69,174,214,0.85)';
      ctx.fillRect(x + 1, Math.round(c.y - 2), FW - 2, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x - 2 + k, Math.round(c.y - 2), 3, 1);
      ctx.fillRect(x + FW - 1 - k, Math.round(c.y - 2), 3, 1);
      if (c.path.length) ctx.fillRect(x + 4 - k * 2, Math.round(c.y), 8, 1);
    }
    c.box = { x, y, w: FW, h: hgt };
  }

  // ---------------- office boy drawing ----------------
  drawNpc(ctx, n, sec) {
    let pose = 'stand';
    let flip = n.flip;
    let frame;
    const act = n.acting ? n.step?.act : null;
    if (n.path.length) pose = n.walkPose;
    else if (act === 'mop') {
      pose = 'walk_side';
      flip = Math.floor((sec + n.phase) * 1.4) % 2 === 0;
      frame = 0;
    } else if (act === 'brew') pose = 'walk_up';
    else if (act === 'skim' || act === 'water') {
      pose = 'walk_side';
      flip = Boolean(n.step.faceLeft);
      frame = 0;
    }
    if (frame === undefined) frame = n.path.length ? Math.floor((sec + n.phase) * 8) : Math.floor(sec + n.phase) % 2;
    const behind = n.item && pose === 'walk_up';
    if (behind) this.drawItem(ctx, n, flip, sec, act);
    this.blitChar(ctx, n, pose, frame, flip, sec);
    if (n.item && !behind) this.drawItem(ctx, n, flip, sec, act);
  }

  drawItem(ctx, n, flip, sec, act) {
    const A = this.atlas;
    const x = Math.round(n.x);
    const y = Math.round(n.y);
    if (n.item === 'tray') A.draw(ctx, 'ob_tray', x - 5, y - 16);
    else if (n.item === 'mop') {
      const sw = act === 'mop' && this.ambientOn ? Math.round(Math.sin((sec + n.phase) * 6) * 3) : 0;
      A.draw(ctx, 'ob_mop', (flip ? x - 12 : x + 4) + sw, y - 19);
    } else if (n.item === 'net') {
      if (act === 'skim') A.draw(ctx, 'ob_net', flip ? x - 15 : x + 9, y - 21 + Math.round(Math.sin((sec + n.phase) * 2) * 2));
      else A.draw(ctx, 'ob_net', x + 5, y - 25);
    } else if (n.item === 'can') A.draw(ctx, 'ob_can', flip ? x - 12 : x + 3, y - 14);
  }

  // ---------------- small animated details ----------------
  drawPoolShimmer(ctx, a, sec) {
    const t = this.ambientOn ? sec : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const n = Math.max(6, Math.round((a.w * a.h) / 300));
    for (let i = 0; i < n; i++) {
      const len = 3 + Math.floor(rnd(i + 7) * 4);
      const x = a.x + 2 + ((rnd(i + 40) * a.w + t * (2 + rnd(i) * 4)) % (a.w - len - 4));
      const y = a.y + 4 + rnd(i + 90) * (a.h - 8) + Math.sin(t * 1.3 + i) * 1.5;
      ctx.fillRect(Math.round(x), Math.round(y), len, 1);
    }
  }

  drawSteam(ctx, x, y, sec) {
    for (let k = 0; k < 3; k++) {
      const ph = (sec * 0.8 + k / 3) % 1;
      ctx.fillStyle = `rgba(255,255,255,${(0.7 * (1 - ph)).toFixed(2)})`;
      ctx.fillRect(Math.round(x + k * 2 + Math.sin(sec * 3 + k) * 1.5), Math.round(y - 1 - ph * 10), 2, 2);
    }
  }

  // Arcade "attract mode": two paddles and a bouncing ball.
  drawArcadeScreen(ctx, x, y, sec) {
    const t = this.ambientOn ? sec : 0;
    const sx = x + 4;
    const sy = y + 8;
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(sx, sy, 10, 8);
    ctx.fillStyle = '#5ec8f0';
    ctx.fillRect(sx + 1, sy + 1 + Math.round((Math.sin(t * 2.1) + 1) * 2), 1, 3);
    ctx.fillStyle = '#ff6ad5';
    ctx.fillRect(sx + 8, sy + 1 + Math.round((Math.cos(t * 1.7) + 1) * 2), 1, 3);
    const u = (t * 0.9) % 2;
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(sx + 2 + Math.round((u < 1 ? u : 2 - u) * 5), sy + 1 + Math.round(Math.abs(Math.sin(t * 2.6)) * 5), 1, 1);
  }

  drawBall(ctx, g, sec) {
    const t = this.ambientOn ? sec - g.since / 1000 : 0;
    const p = g.table;
    ctx.fillStyle = '#ffffff';
    if (g.kind === 'pingpong') {
      const u = (t / 0.9) % 2;
      const k = u < 1 ? u : 2 - u;
      const x = p.x + 4 + k * (p.w - 8);
      const y = p.y + 10 + Math.sin(t * 2.3) * 4 - Math.abs(Math.sin(k * Math.PI)) * 5;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(Math.round(x), Math.round(p.y + 12 + Math.sin(t * 2.3) * 4), 2, 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    } else {
      const x = p.x + 4 + ((Math.sin(t * 2.3) + 1) / 2) * (p.w - 10);
      const y = p.y + 5 + ((Math.cos(t * 1.7) + 1) / 2) * (p.h - 12);
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
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
    // Office boys: grey tag "OB name", only when zoomed in or pointed at.
    for (const n of this.npcs.values()) {
      if (!this.isVisibleWorld(n.x, n.y) || (!showAll && !this.isFocus(n))) continue;
      const [x, y] = toScreen(n.x, n.y + 6);
      const label = `OB ${n.name}`;
      const w = ctx.measureText(label).width + 8;
      const r = { x: x - w / 2, y: y - nfs * 0.65, w, h: nfs * 1.3 };
      if (placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y)) continue;
      placed.push(r);
      ctx.fillStyle = this.selected?.id === n.id ? 'rgba(31,95,191,0.92)' : 'rgba(71,85,105,0.85)';
      ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      ctx.fillStyle = '#7cc0e8';
      ctx.fillRect(Math.round(r.x), Math.round(r.y), 2, Math.round(r.h));
      ctx.fillStyle = '#fff';
      ctx.fillText(label, Math.round(x + 1), Math.round(y));
    }
    ctx.textAlign = 'start';
  }

  isFocus(c) {
    const t = c.npc ? 'npc' : 'employee';
    return (this.selected?.type === t && this.selected.id === c.id) || (this.hovered?.type === t && this.hovered.id === c.id);
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
      const c = this.chars.get(id) || this.npcs.get(id);
      if (!c || !this.isVisibleWorld(c.x, c.y)) continue;
      const lh = fs * 1.25;
      const w = Math.max(...sp.lines.map((l) => ctx.measureText(l).width)) + 14;
      const hgt = sp.lines.length * lh + 10;
      const [cx, cy] = toScreen(c.x, c.y - (this.inPool(c) ? 15 : FH) - 16);
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
    g.fillStyle = '#e2e8f0';
    for (const n of this.npcs.values()) g.fillRect(Math.round(n.x * k) - 1, Math.round((n.y - 8) * k) - 1, 3, 3);
    g.strokeStyle = '#ffd34d';
    g.lineWidth = Math.max(1, this.dpr);
    g.strokeRect(this.cam.x * k, this.cam.y * k, (this.cssW / this.scale) * k, (this.cssH / this.scale) * k);
  }

  // ---------------- input ----------------
  rectOf(sel) {
    if (sel.type === 'employee') return this.chars.get(sel.id)?.box || null;
    if (sel.type === 'npc') return this.npcs.get(sel.id)?.box || null;
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
    for (const n of this.npcs.values()) if (inside(n.box, 3)) hit = { type: 'npc', id: n.id, npc: n };
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
      this.onHover?.(h && (h.type === 'employee' || h.type === 'npc') ? { ...h, sx: w.sx, sy: w.sy } : null);
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
