// Generates the office sprite sheet: public/assets/office-atlas.png + the frame map as
// public/assets/office-atlas.json and public/js/office/atlas-data.js (the ES module the app actually loads, so the
// frame map always ships with the same code version; the PNG URL carries the content hash).
// Original pixel art drawn with simple primitives, encoded as a compressed PNG using only Node built-ins (zlib).
// Run: node scripts/build-office-atlas.mjs   (you may replace the PNG with your own art using the same frame names)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

// ---------------- tiny RGBA raster ----------------
function hex(c) {
  if (!c) return [0, 0, 0, 0];
  const m = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}
class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = Buffer.alloc(w * h * 4);
  }
  px(x, y, c) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b, a] = hex(c);
    const i = (y * this.w + x) * 4;
    if (a === 255) {
      this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = 255;
    } else {
      const k = a / 255;
      this.d[i] = Math.round(r * k + this.d[i] * (1 - k));
      this.d[i + 1] = Math.round(g * k + this.d[i + 1] * (1 - k));
      this.d[i + 2] = Math.round(b * k + this.d[i + 2] * (1 - k));
      this.d[i + 3] = Math.max(this.d[i + 3], a);
    }
  }
  r(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }
  box(x, y, w, h, fill, line) {
    this.r(x, y, w, h, line);
    this.r(x + 1, y + 1, w - 2, h - 2, fill);
  }
  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) src.d.copy(this.d, ((oy + y) * this.w + ox) * 4, y * src.w * 4, (y + 1) * src.w * 4);
  }
}

// ---------------- palette (muted, cozy) ----------------
const P = {
  ol: '#2e2a33', wood: '#b07a4f', woodL: '#c99466', woodD: '#8a5a37', woodDD: '#6b4428',
  floorA: '#d9b98f', floorB: '#cfae83', floorLine: '#b8946a', tileA: '#e8e2d6', tileB: '#ddd5c6', tileLine: '#c9bfae',
  carpet: '#c8ccd4', carpetD: '#b8bdc7', wall: '#efe6d8', wallD: '#ddd1bf', wallCap: '#6b5444', wallCapL: '#82674f', base: '#a07f63',
  glass: '#9fd0ea', glassL: '#cdeaf7', metal: '#8a93a3', metalD: '#5d6573', metalDD: '#3d434e', screen: '#38404f', screenOn: '#5ab8f0',
  green: '#5f9e54', greenD: '#3f7639', greenL: '#86c46c', pot: '#b9653d', potD: '#924c2c', white: '#f7f5f0', paper: '#f2eee4',
  red: '#d65a4a', yellow: '#f2c14e', blue: '#5b7fbf', blueD: '#46659b', teal: '#4f9a92', tealD: '#3c7a74', purple: '#8a6fb0',
  sofaB: '#5f7fb3', sofaBD: '#4a6593', sofaG: '#6f9a68', sofaGD: '#557a50', sofaR: '#b5675a', sofaRD: '#904f44', gold: '#d9a93a',
};

const sprites = {};
function def(name, w, h, draw) {
  sprites[name] = { w, h, draw };
}

// ---------------- floors & walls (16x16 / 16x32) ----------------
def('floor_wood', 16, 16, (g) => {
  g.r(0, 0, 16, 16, P.floorA);
  for (const y of [3, 7, 11, 15]) g.r(0, y, 16, 1, P.floorLine);
  g.r(5, 0, 1, 3, P.floorLine); g.r(12, 4, 1, 3, P.floorLine); g.r(3, 8, 1, 3, P.floorLine); g.r(9, 12, 1, 3, P.floorLine);
  g.r(1, 1, 3, 1, '#e2c49c'); g.r(8, 9, 3, 1, '#e2c49c');
});
def('floor_wood_b', 16, 16, (g) => {
  g.r(0, 0, 16, 16, P.floorB);
  for (const y of [3, 7, 11, 15]) g.r(0, y, 16, 1, P.floorLine);
  g.r(9, 0, 1, 3, P.floorLine); g.r(2, 4, 1, 3, P.floorLine); g.r(13, 8, 1, 3, P.floorLine); g.r(6, 12, 1, 3, P.floorLine);
});
def('floor_tile', 16, 16, (g) => {
  g.r(0, 0, 16, 16, P.tileA);
  g.r(0, 0, 8, 8, P.tileB); g.r(8, 8, 8, 8, P.tileB);
  g.r(0, 15, 16, 1, P.tileLine); g.r(15, 0, 1, 16, P.tileLine);
});
def('floor_carpet', 16, 16, (g) => {
  g.r(0, 0, 16, 16, P.carpet);
  for (let y = 0; y < 16; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < 16; x += 4) g.px(x, y, P.carpetD);
});
def('wall', 16, 32, (g) => {
  g.r(0, 0, 16, 6, P.wallCap); g.r(0, 0, 16, 1, P.wallCapL); g.r(0, 5, 16, 1, '#4e3d31');
  g.r(0, 6, 16, 23, P.wall); g.r(0, 6, 16, 2, P.wallD);
  g.r(0, 29, 16, 3, P.base); g.r(0, 29, 16, 1, '#b8987a');
});
def('wall_window', 16, 32, (g) => {
  g.r(0, 0, 16, 6, P.wallCap); g.r(0, 0, 16, 1, P.wallCapL); g.r(0, 5, 16, 1, '#4e3d31');
  g.r(0, 6, 16, 23, P.wall); g.r(0, 6, 16, 2, P.wallD);
  g.box(2, 9, 12, 14, P.glass, P.woodD); g.r(3, 10, 4, 5, P.glassL); g.r(7, 10, 1, 12, P.woodD); g.r(3, 16, 10, 1, P.woodD);
  g.r(1, 23, 14, 2, P.woodL);
  g.r(0, 29, 16, 3, P.base); g.r(0, 29, 16, 1, '#b8987a');
});

// 9-slice wood table pieces (8x8)
const TAB = { top: P.woodL, mid: P.wood, edge: P.woodD };
function tablePiece(name, l, t, rr, b) {
  def(name, 8, 8, (g) => {
    g.r(0, 0, 8, 8, TAB.mid);
    g.r(0, 0, 8, 2, t ? TAB.top : TAB.mid);
    if (t) g.r(0, 0, 8, 1, P.ol);
    if (b) { g.r(0, 5, 8, 3, TAB.edge); g.r(0, 7, 8, 1, P.ol); }
    if (l) g.r(0, 0, 1, 8, P.ol);
    if (rr) g.r(7, 0, 1, 8, P.ol);
    if (!t && !b) for (let x = 1; x < 7; x += 3) g.px(x, 3, '#b98458');
  });
}
tablePiece('tbl_tl', 1, 1, 0, 0); tablePiece('tbl_t', 0, 1, 0, 0); tablePiece('tbl_tr', 0, 1, 1, 0);
tablePiece('tbl_l', 1, 0, 0, 0); tablePiece('tbl_c', 0, 0, 0, 0); tablePiece('tbl_r', 0, 0, 1, 0);
tablePiece('tbl_bl', 1, 0, 0, 1); tablePiece('tbl_b', 0, 0, 0, 1); tablePiece('tbl_br', 0, 0, 1, 1);

// ---------------- furniture ----------------
def('desk', 32, 20, (g) => {
  g.box(0, 2, 32, 12, P.wood, P.ol);
  g.r(1, 3, 30, 3, P.woodL);
  g.r(1, 13, 30, 4, P.woodD); g.r(0, 13, 32, 1, P.ol); g.r(0, 17, 32, 1, P.ol);
  g.r(1, 17, 3, 3, P.woodDD); g.r(28, 17, 3, 3, P.woodDD);
  g.r(10, 9, 12, 3, '#d8dbe0'); g.r(10, 9, 12, 1, '#c3c7ce'); // keyboard
  g.r(25, 6, 4, 4, P.white); g.r(25, 6, 4, 1, '#d3cfc6'); g.px(29, 7, P.white); // mug
  g.r(3, 7, 5, 4, P.paper); g.r(4, 8, 3, 1, '#c8c2b4');
});
def('exec_desk', 48, 22, (g) => {
  g.box(0, 2, 48, 14, P.woodD, P.ol);
  g.r(1, 3, 46, 4, P.wood); g.r(2, 4, 44, 1, P.woodL);
  g.r(1, 15, 46, 5, P.woodDD); g.r(0, 15, 48, 1, P.ol); g.r(0, 20, 48, 1, P.ol);
  g.r(6, 16, 10, 3, P.woodD); g.r(32, 16, 10, 3, P.woodD); g.px(11, 17, P.gold); g.px(37, 17, P.gold);
  g.r(18, 10, 12, 3, '#d8dbe0');
  g.r(4, 8, 6, 5, P.paper); g.r(38, 7, 5, 6, P.green); g.r(39, 11, 3, 2, P.pot);
});
def('reception', 64, 22, (g) => {
  g.box(0, 0, 64, 16, P.white, P.ol); g.r(1, 1, 62, 3, '#e4e0d6');
  g.r(1, 15, 62, 6, P.teal); g.r(0, 15, 64, 1, P.ol); g.r(0, 21, 64, 1, P.ol); g.r(1, 16, 62, 1, '#6db5ac');
  for (let x = 6; x < 60; x += 12) g.r(x, 17, 6, 3, P.tealD);
  g.r(8, 6, 8, 5, P.paper); g.r(46, 5, 10, 7, '#d8dbe0'); g.r(47, 6, 8, 2, '#9aa2ae');
});
def('monitor_off', 14, 11, (g) => {
  g.box(0, 0, 14, 9, P.screen, P.ol); g.r(2, 2, 3, 1, '#4a5366');
  g.r(6, 9, 2, 1, P.metalDD); g.r(4, 10, 6, 1, P.metalDD);
});
for (const [i, rows] of [[0, [9, 6, 8]], [1, [7, 9, 5]]]) {
  def(`monitor_on_${i}`, 14, 11, (g) => {
    g.box(0, 0, 14, 9, P.screenOn, P.ol); g.r(1, 1, 12, 1, '#8fd3fb');
    rows.forEach((w, k) => g.r(2, 3 + k * 2, w, 1, k === 1 ? P.yellow : P.white));
    g.r(6, 9, 2, 1, P.metalDD); g.r(4, 10, 6, 1, P.metalDD);
  });
}
def('chair', 14, 14, (g) => {
  g.box(1, 0, 12, 9, '#4f5a6e', P.ol); g.r(2, 1, 10, 2, '#66718a'); // seat
  g.box(0, 8, 14, 5, '#3d4656', P.ol); // backrest (south)
  g.r(6, 13, 2, 1, P.metalDD);
});
def('chair_back_n', 14, 14, (g) => {
  g.box(0, 0, 14, 5, '#3d4656', P.ol); // backrest (north) for seats that face the viewer
  g.box(1, 4, 12, 9, '#4f5a6e', P.ol); g.r(2, 5, 10, 2, '#66718a');
});
def('bookshelf', 32, 32, (g) => {
  g.box(0, 0, 32, 32, P.woodD, P.ol);
  const colors = [P.red, P.blue, P.yellow, P.green, P.purple, P.teal, P.white, '#c27c4a'];
  for (let s = 0; s < 3; s++) {
    const y = 3 + s * 10;
    g.r(2, y, 28, 8, P.woodDD);
    let x = 3;
    let k = s * 3;
    while (x < 28) {
      const w = 2 + (k % 3 === 0 ? 1 : 0);
      const h = 5 + (k % 2);
      g.r(x, y + 8 - h, w, h, colors[k % colors.length]);
      x += w + (k % 4 === 3 ? 2 : 0);
      k++;
    }
    g.r(1, y + 8, 30, 1, P.woodL);
  }
});
def('cabinet', 16, 24, (g) => {
  g.box(0, 0, 16, 24, P.metal, P.ol); g.r(1, 1, 14, 2, '#a3abb9');
  for (const y of [4, 11, 18]) { g.r(2, y, 12, 5, P.metalD); g.r(6, y + 2, 4, 1, '#c9ced6'); }
});
def('safe', 16, 16, (g) => {
  g.box(0, 0, 16, 16, P.metalDD, P.ol); g.r(2, 2, 12, 12, '#4a515d'); g.box(5, 5, 6, 6, P.metal, P.ol); g.px(8, 8, P.gold); g.r(12, 6, 1, 4, P.gold);
});
def('plant_small', 12, 14, (g) => {
  g.r(2, 1, 8, 6, P.green); g.r(0, 3, 4, 3, P.greenD); g.r(8, 2, 4, 3, P.greenD); g.r(4, 0, 4, 2, P.greenL); g.r(3, 3, 2, 1, P.greenL);
  g.box(2, 7, 8, 7, P.pot, P.ol); g.r(3, 8, 6, 1, '#d07d52');
});
def('plant_big', 16, 28, (g) => {
  g.r(3, 2, 10, 14, P.green); g.r(0, 6, 5, 6, P.greenD); g.r(11, 4, 5, 7, P.greenD); g.r(5, 0, 6, 4, P.greenL);
  g.r(6, 5, 3, 2, P.greenL); g.r(9, 9, 3, 2, P.greenL); g.r(2, 13, 4, 3, P.greenD); g.r(7, 16, 2, 3, P.woodD);
  g.box(3, 18, 10, 10, P.pot, P.ol); g.r(4, 19, 8, 1, '#d07d52'); g.r(4, 26, 8, 1, P.potD);
});
for (const [name, c, d] of [['sofa_blue', P.sofaB, P.sofaBD], ['sofa_green', P.sofaG, P.sofaGD], ['sofa_red', P.sofaR, P.sofaRD]]) {
  def(name, 48, 22, (g) => {
    g.box(0, 0, 48, 8, d, P.ol); // back (north)
    g.box(0, 6, 6, 15, d, P.ol); g.box(42, 6, 6, 15, d, P.ol); // arms
    g.box(5, 7, 38, 13, c, P.ol); g.r(24, 8, 1, 11, d); g.r(6, 8, 18, 2, '#ffffff33'); g.r(25, 8, 17, 2, '#ffffff33');
    g.r(4, 20, 40, 2, '#00000033');
  });
}
def('armchair', 20, 20, (g) => {
  g.box(0, 0, 20, 7, P.sofaRD, P.ol); g.box(0, 5, 5, 14, P.sofaRD, P.ol); g.box(15, 5, 5, 14, P.sofaRD, P.ol);
  g.box(4, 6, 12, 12, P.sofaR, P.ol); g.r(5, 7, 10, 2, '#ffffff33');
});
def('coffee_table', 24, 14, (g) => {
  g.box(0, 0, 24, 10, P.woodL, P.ol); g.r(1, 1, 22, 2, '#dcae80'); g.r(0, 9, 24, 4, P.woodD); g.r(0, 13, 24, 1, P.ol);
  g.r(4, 3, 5, 4, P.white); g.r(14, 3, 6, 4, P.blue);
});
def('coffee_machine', 14, 22, (g) => {
  g.box(0, 0, 14, 22, '#40454f', P.ol); g.r(1, 1, 12, 4, '#5a606c'); g.r(3, 7, 8, 6, '#2a2e35'); g.r(5, 13, 4, 1, '#6b7280');
  g.r(5, 14, 4, 4, P.white); g.px(10, 3, P.red); g.px(11, 3, P.greenL); g.r(1, 19, 12, 2, '#2d3138');
});
def('water_cooler', 12, 26, (g) => {
  g.box(2, 0, 8, 10, '#9fd6f2', P.ol); g.r(3, 1, 3, 7, '#c9ecfb');
  g.box(0, 9, 12, 17, P.white, P.ol); g.r(2, 12, 2, 2, P.blue); g.r(8, 12, 2, 2, P.red); g.r(1, 23, 10, 2, '#d7d2c7');
});
def('whiteboard', 48, 26, (g) => {
  g.box(0, 0, 48, 22, P.white, P.metalD); g.r(1, 1, 46, 2, '#ffffff');
  g.r(5, 6, 16, 1, P.blue); g.r(5, 9, 22, 1, P.blue); g.r(5, 12, 12, 1, P.red);
  g.r(30, 6, 12, 10, '#fff2b8'); g.r(32, 8, 8, 1, '#c9a646'); g.r(32, 11, 6, 1, '#c9a646');
  g.r(4, 22, 40, 2, P.metal); g.r(8, 21, 4, 1, P.red); g.r(14, 21, 4, 1, P.blue);
  g.r(4, 24, 2, 2, P.metalD); g.r(42, 24, 2, 2, P.metalD);
});
def('tv', 40, 24, (g) => {
  g.box(0, 0, 40, 22, '#20242b', P.ol); g.r(2, 2, 36, 18, '#2f4a6b');
  g.r(5, 14, 4, 4, P.greenL); g.r(11, 10, 4, 8, P.yellow); g.r(17, 6, 4, 12, P.screenOn); g.r(24, 9, 12, 1, P.white); g.r(24, 12, 9, 1, P.white);
  g.r(18, 22, 4, 2, P.metalDD);
});
def('round_table', 32, 32, (g) => {
  for (let y = 0; y < 30; y++) for (let x = 0; x < 32; x++) {
    const dx = x - 15.5, dy = y - 13.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 14.5) g.px(x, y, d > 13.4 ? P.ol : dy > 8 ? P.woodD : dy < -8 ? P.woodL : P.wood);
  }
  g.r(13, 27, 6, 4, P.woodDD); g.r(12, 31, 8, 1, P.ol);
  g.r(10, 9, 6, 4, P.paper); g.r(18, 14, 4, 4, P.white);
});
def('server_rack', 16, 30, (g) => {
  g.box(0, 0, 16, 30, '#2b2f37', P.ol);
  for (let y = 2; y < 27; y += 5) {
    g.r(2, y, 12, 4, '#3b414c'); g.px(3, y + 1, P.greenL); g.px(5, y + 1, (y / 5) % 2 ? P.yellow : P.greenL); g.r(8, y + 2, 5, 1, '#1f2329');
  }
});
def('printer', 18, 14, (g) => {
  g.box(0, 3, 18, 10, '#d9d6cf', P.ol); g.r(3, 0, 12, 4, P.paper); g.r(2, 6, 14, 2, '#4b505a'); g.px(14, 10, P.greenL); g.r(3, 12, 12, 2, P.paper);
});
def('globe', 14, 18, (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const d = Math.hypot(x - 5.5, y - 5.5);
    if (d < 6) g.px(x + 1, y, d > 5.2 ? P.ol : (x + y) % 5 < 2 ? P.green : P.blue);
  }
  g.r(6, 12, 2, 3, P.woodD); g.r(3, 15, 8, 3, P.woodDD);
});
def('trophy', 10, 12, (g) => {
  g.r(1, 0, 8, 5, P.gold); g.r(0, 1, 1, 3, P.gold); g.r(9, 1, 1, 3, P.gold); g.r(2, 1, 2, 2, '#f5d77a');
  g.r(4, 5, 2, 3, P.gold); g.r(2, 8, 6, 4, P.woodDD);
});
def('clock', 12, 12, (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const d = Math.hypot(x - 5.5, y - 5.5);
    if (d < 6) g.px(x, y, d > 5 ? P.woodD : P.white);
  }
  g.r(5, 2, 1, 4, P.ol); g.r(6, 5, 3, 1, P.ol);
});
def('painting', 24, 16, (g) => {
  g.box(0, 0, 24, 16, '#9fd0ea', P.woodD); g.r(1, 9, 22, 6, P.greenL); g.r(1, 12, 22, 3, P.green); g.r(15, 3, 4, 4, P.yellow);
  g.r(4, 6, 6, 4, P.greenD); g.r(6, 4, 2, 2, P.greenD);
});
def('lamp', 10, 28, (g) => {
  g.box(0, 0, 10, 8, '#f3d58a', P.ol); g.r(1, 1, 8, 2, '#fbe6a8'); g.r(4, 8, 2, 16, P.metalD); g.r(1, 24, 8, 4, P.metalDD);
});
def('rug_pattern', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#ffffff00');
  for (let i = 0; i < 16; i += 8) { g.r(i + 3, 3, 2, 2, '#ffffff40'); g.r(i + 3, 11, 2, 2, '#ffffff40'); }
});
def('notice_board', 32, 20, (g) => {
  g.box(0, 0, 32, 20, '#c89b6a', P.woodD);
  g.r(3, 3, 8, 6, P.paper); g.r(13, 4, 7, 8, '#fff2b8'); g.r(22, 3, 7, 6, '#cfe7ff'); g.r(5, 11, 9, 6, '#ffd6d6');
  for (const [x, y] of [[7, 3], [16, 4], [25, 3], [9, 11]]) g.px(x, y, P.red);
});
def('vending', 20, 30, (g) => {
  g.box(0, 0, 20, 30, P.red, P.ol); g.r(2, 2, 12, 20, '#2b2f37');
  for (let y = 4; y < 20; y += 5) for (let x = 3; x < 13; x += 4) g.r(x, y, 3, 3, [P.yellow, P.blue, P.greenL][(x + y) % 3]);
  g.r(15, 4, 3, 6, '#3b414c'); g.r(3, 24, 10, 3, '#1f2329');
});

// ---------------- icons / bubbles (12x12) ----------------
function bubble(name, fill, drawIcon) {
  def(name, 12, 12, (g) => {
    g.r(1, 0, 10, 10, P.ol); g.r(0, 1, 12, 8, P.ol); g.r(1, 1, 10, 8, fill); g.r(4, 10, 3, 1, P.ol); g.r(5, 9, 1, 1, fill); g.px(5, 11, P.ol);
    drawIcon(g);
  });
}
bubble('bub_think', P.white, (g) => { g.r(3, 4, 2, 2, '#7a8396'); g.r(5, 3, 2, 2, '#7a8396'); g.r(7, 4, 2, 2, '#7a8396'); g.r(4, 6, 4, 1, '#a8b0bf'); });
bubble('bub_check', '#3ea66b', (g) => { g.px(3, 5, P.white); g.px(4, 6, P.white); g.px(5, 7, P.white); g.px(6, 6, P.white); g.px(7, 5, P.white); g.px(8, 4, P.white); g.px(9, 3, P.white); g.px(4, 5, P.white); g.px(5, 6, P.white); });
bubble('bub_warn', '#e5484d', (g) => { g.r(5, 2, 2, 4, P.white); g.r(5, 7, 2, 1, P.white); });
bubble('bub_wait', '#ffe8a3', (g) => { g.r(3, 2, 6, 1, '#7a5b00'); g.r(3, 7, 6, 1, '#7a5b00'); g.r(4, 3, 4, 1, '#c99a2e'); g.r(5, 4, 2, 2, '#c99a2e'); g.r(4, 6, 4, 1, '#c99a2e'); });
bubble('bub_meet', '#d9ccf2', (g) => { g.r(2, 3, 5, 3, P.purple); g.r(5, 5, 5, 3, '#6b55a0'); g.px(3, 6, P.purple); g.px(8, 8, '#6b55a0'); });
for (let i = 0; i < 3; i++) {
  bubble(`bub_type_${i}`, P.white, (g) => { for (let k = 0; k <= i; k++) g.r(2 + k * 3, 4, 2, 2, '#1f2937'); });
}
def('sparkle_0', 8, 8, (g) => { g.r(3, 0, 2, 8, P.yellow); g.r(0, 3, 8, 2, P.yellow); g.r(3, 3, 2, 2, P.white); });
def('sparkle_1', 8, 8, (g) => { g.px(1, 1, P.yellow); g.px(6, 1, P.yellow); g.px(1, 6, P.yellow); g.px(6, 6, P.yellow); g.r(3, 2, 2, 4, P.yellow); g.r(2, 3, 4, 2, P.yellow); });
def('flag_pole', 6, 16, (g) => { g.r(0, 0, 2, 16, P.metalD); g.r(0, 15, 4, 1, P.metalDD); });

// =====================================================================================
// v2: richer office set (room identity, wall styles, rugs, boards, screens, ambient frames)
// Later definitions with the same name replace the v1 sprite (desk, exec_desk, chair, …).
// =====================================================================================

// tiny 3x5 pixel font for signs
const FONT = {
  A: ['010', '101', '111', '101', '101'], C: ['011', '100', '100', '100', '011'], E: ['111', '100', '110', '100', '111'],
  K: ['101', '110', '100', '110', '101'], L: ['100', '100', '100', '100', '111'], M: ['101', '111', '111', '101', '101'],
  O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'], I: ['111', '010', '010', '010', '111'],
  W: ['101', '101', '111', '111', '101'], S: ['011', '100', '010', '001', '110'], N: ['101', '111', '111', '111', '101'],
  U: ['101', '101', '101', '101', '111'], F: ['111', '100', '110', '100', '100'], T: ['111', '010', '010', '010', '010'],
  H: ['101', '101', '111', '101', '101'], R: ['110', '101', '110', '101', '101'], D: ['110', '101', '101', '101', '110'],
  B: ['110', '101', '110', '101', '110'], G: ['011', '100', '101', '101', '011'], Y: ['101', '101', '010', '010', '010'],
};
function text(g, s, x, y, c) {
  let cx = x;
  for (const ch of s) {
    const glyph = FONT[ch];
    if (glyph) glyph.forEach((row, j) => [...row].forEach((b, i) => b === '1' && g.px(cx + i, y + j, c)));
    cx += 4;
  }
}

// ---- wall styles: wallpaper per room identity ----
const WALLS = {
  cream: ['#efe6d8', '#ddd1bf', null],
  sage: ['#dfe8d6', '#c8d6bc', 'stripe'],
  sky: ['#dde8f0', '#c5d5e2', 'dots'],
  rose: ['#f1e0dc', '#e0c8c2', 'stripe'],
  slate: ['#cfd5dd', '#b7bfca', 'grid'],
  wood: ['#c99a6c', '#b4865a', 'panel'],
  lav: ['#e6e0f0', '#d1c8e3', 'dots'],
  peach: ['#f5e2cf', '#e7cdb2', 'stripe'],
  // v5 startup office: exposed brick, raw concrete, glass partition, pool tiles
  brick: ['#b9694d', '#9c553d', 'brick'],
  concrete: ['#d3d2cc', '#bebcb5', 'concrete'],
  glass: ['#d7ecf4', '#b5d6e4', 'glass'],
  pooltile: ['#e3f3f8', '#bfe0ea', 'grid'],
};
function wallBase(g, face, faceD, pattern) {
  g.r(0, 0, 16, 6, P.wallCap); g.r(0, 0, 16, 1, P.wallCapL); g.r(0, 5, 16, 1, '#4e3d31');
  g.r(0, 6, 16, 23, face); g.r(0, 6, 16, 2, faceD);
  if (pattern === 'stripe') for (let x = 2; x < 16; x += 5) g.r(x, 8, 1, 14, faceD);
  if (pattern === 'dots') for (let y = 10; y < 22; y += 5) for (let x = (y % 2) + 2; x < 16; x += 6) g.px(x, y, faceD);
  if (pattern === 'grid') { for (let x = 0; x < 16; x += 8) g.r(x, 8, 1, 14, faceD); g.r(0, 15, 16, 1, faceD); }
  if (pattern === 'panel') { g.r(0, 8, 16, 1, '#a87a50'); g.r(7, 8, 1, 14, '#a87a50'); g.r(15, 8, 1, 14, '#a87a50'); g.r(1, 9, 5, 1, '#d8ab7d'); }
  if (pattern === 'brick') {
    for (let y = 8, row = 0; y < 22; y += 3, row++) {
      g.r(0, y + 2, 16, 1, '#e3c9b4');
      for (let x = row % 2 ? 4 : 0; x < 16; x += 8) g.r(x, y, 1, 2, '#e3c9b4');
      g.r(row % 2 ? 6 : 2, y, 2, 1, '#c97b5e');
    }
  }
  if (pattern === 'concrete') { for (const [x, y] of [[3, 10], [11, 13], [6, 18], [13, 9], [1, 16], [9, 20]]) g.px(x, y, faceD); g.r(0, 14, 16, 1, '#c8c6bf'); g.px(4, 14, '#9e9c95'); g.px(12, 14, '#9e9c95'); }
  if (pattern === 'glass') { g.r(0, 8, 16, 14, '#cbe6f1'); g.r(0, 8, 1, 14, '#8fb9cc'); g.r(15, 8, 1, 14, '#8fb9cc'); g.r(3, 9, 3, 6, '#eef8fc'); g.r(9, 12, 2, 4, '#eef8fc'); g.r(0, 15, 16, 1, '#a9cfe0'); }
  g.r(0, 22, 16, 1, '#b8987a'); // chair rail
  g.r(0, 23, 16, 6, faceD);
  g.r(0, 29, 16, 3, P.base); g.r(0, 29, 16, 1, '#b8987a');
}
for (const [name, [face, faceD, pattern]] of Object.entries(WALLS)) {
  def(`wall_${name}`, 16, 32, (g) => wallBase(g, face, faceD, pattern));
  def(`wallwin_${name}`, 16, 32, (g) => {
    wallBase(g, face, faceD, pattern);
    g.box(2, 8, 12, 14, P.glass, P.woodD); g.r(3, 9, 4, 5, P.glassL); g.r(7, 9, 1, 12, P.woodD); g.r(3, 15, 10, 1, P.woodD);
    g.r(1, 7, 14, 1, '#7a5b46'); g.r(1, 7, 3, 9, '#c86f6f'); g.r(12, 7, 3, 9, '#c86f6f'); g.r(2, 8, 1, 7, '#e09191'); g.r(13, 8, 1, 7, '#e09191');
    g.r(1, 22, 14, 2, P.woodL); g.r(1, 23, 14, 1, P.woodD);
  });
}

// ---- floors ----
def('floor_parquet', 16, 16, (g) => {
  for (let y = 0; y < 16; y += 4) {
    const off = (y / 4) % 2 ? 4 : 0;
    for (let x = -8; x < 16; x += 8) {
      g.r(x + off, y, 8, 4, ((x + 8) / 8 + y / 4) % 2 ? '#cfa77a' : '#c49b6e');
      g.r(x + off, y, 1, 4, '#b08458');
    }
  }
  for (let y = 3; y < 16; y += 4) g.r(0, y, 16, 1, '#b08458');
  g.r(3, 1, 2, 1, '#dcb88c'); g.r(11, 9, 2, 1, '#dcb88c');
});
def('floor_dark', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#5b6270'); g.r(0, 0, 8, 8, '#555c69'); g.r(8, 8, 8, 8, '#555c69');
  g.r(0, 15, 16, 1, '#474d58'); g.r(15, 0, 1, 16, '#474d58'); g.px(4, 4, '#6a7180'); g.px(12, 12, '#6a7180');
});
def('floor_warm', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#ead8bd'); g.r(0, 0, 8, 8, '#e2cdb0'); g.r(8, 8, 8, 8, '#e2cdb0'); g.r(0, 15, 16, 1, '#d2bb9a'); g.r(15, 0, 1, 16, '#d2bb9a');
});

// ---- rugs (9-slice 8x8, three colorways) ----
const RUGS = { red: ['#b5574a', '#8f3f36', '#e6c36a'], blue: ['#4f6f9e', '#3b557c', '#e6d7a3'], green: ['#5e8f5a', '#466d43', '#efe1b0'] };
for (const [c, [base, dark, trim]] of Object.entries(RUGS)) {
  const piece = (k, top, left, right, bottom) => def(`rug_${c}_${k}`, 8, 8, (g) => {
    g.r(0, 0, 8, 8, base);
    for (let i = 0; i < 8; i += 4) g.px(i + 2, 3, dark), g.px(i, 6, dark);
    if (top) { g.r(0, 0, 8, 2, dark); g.r(0, 1, 8, 1, trim); }
    if (bottom) { g.r(0, 6, 8, 2, dark); g.r(0, 6, 8, 1, trim); }
    if (left) { g.r(0, 0, 2, 8, dark); g.r(1, 0, 1, 8, trim); }
    if (right) { g.r(6, 0, 2, 8, dark); g.r(6, 0, 1, 8, trim); }
    if (!top && !bottom && !left && !right) { g.px(3, 3, trim); g.px(4, 4, trim); g.px(3, 4, dark); g.px(4, 3, dark); }
  });
  piece('tl', 1, 1, 0, 0); piece('t', 1, 0, 0, 0); piece('tr', 1, 0, 1, 0);
  piece('l', 0, 1, 0, 0); piece('c', 0, 0, 0, 0); piece('r', 0, 0, 1, 0);
  piece('bl', 0, 1, 0, 1); piece('b', 0, 0, 0, 1); piece('br', 0, 0, 1, 1);
}

// ---- desks with room-specific items (same footprint as v1: positions unchanged) ----
function deskBase(g) {
  g.r(1, 18, 30, 2, '#00000022');
  g.box(0, 2, 32, 12, P.wood, P.ol);
  g.r(1, 3, 30, 3, P.woodL); g.r(2, 7, 28, 1, '#a46f45');
  g.r(1, 13, 30, 4, P.woodD); g.r(0, 13, 32, 1, P.ol); g.r(0, 17, 32, 1, P.ol);
  g.r(14, 14, 4, 1, '#c8a27a');
  g.r(1, 17, 3, 3, P.woodDD); g.r(28, 17, 3, 3, P.woodDD);
}
const kb = (g, x = 10) => { g.r(x, 9, 12, 3, '#d8dbe0'); g.r(x, 9, 12, 1, '#c3c7ce'); for (let i = 1; i < 11; i += 2) g.px(x + i, 10, '#aeb3bb'); };
const mug = (g, x, y, c = P.white) => { g.r(x, y, 4, 4, c); g.r(x, y, 4, 1, '#00000022'); g.px(x + 4, y + 1, c); };
const papers = (g, x, y) => { g.r(x, y, 6, 5, P.paper); g.r(x + 1, y + 1, 4, 1, '#c8c2b4'); g.r(x + 1, y + 3, 3, 1, '#c8c2b4'); };
def('desk', 32, 20, (g) => { deskBase(g); kb(g); mug(g, 25, 6); papers(g, 3, 6); });
def('desk_bm', 32, 20, (g) => { deskBase(g); kb(g); g.box(25, 5, 5, 5, '#f4e3b5', P.woodDD); g.r(26, 6, 3, 2, '#7fb3d5'); g.r(2, 6, 4, 4, P.pot); g.r(2, 4, 4, 3, P.greenL); papers(g, 7, 7); });
def('desk_fin', 32, 20, (g) => { deskBase(g); kb(g); g.box(24, 5, 6, 7, '#3d434e', P.ol); g.r(25, 6, 4, 2, '#9fe0a8'); g.px(25, 9, P.white); g.px(27, 9, P.white); g.px(25, 10, P.white); g.px(27, 10, P.white); papers(g, 2, 5); papers(g, 3, 7); });
def('desk_rec', 32, 20, (g) => { deskBase(g); kb(g); g.r(24, 6, 6, 4, '#3d434e'); g.r(24, 5, 3, 2, '#3d434e'); g.px(28, 7, P.red); g.r(2, 6, 6, 5, '#f7f2e6'); g.r(2, 6, 6, 1, P.red); g.px(4, 8, '#7a8396'); g.px(6, 9, '#7a8396'); });
def('desk_res', 32, 20, (g) => { deskBase(g); kb(g); g.r(23, 5, 8, 6, P.paper); g.r(26, 5, 1, 6, '#c8c2b4'); g.r(24, 6, 2, 1, '#99aaaa'); g.r(28, 7, 2, 1, '#99aaaa'); g.r(2, 5, 5, 2, P.blue); g.r(2, 7, 5, 2, P.red); g.r(2, 9, 5, 2, P.green); });
def('desk_dev', 32, 20, (g) => { deskBase(g); kb(g); mug(g, 26, 6, '#2b2f37'); g.r(2, 6, 5, 3, '#2b2f37'); g.px(3, 7, P.greenL); g.px(5, 7, P.greenL); });
def('desk_hr', 32, 20, (g) => { deskBase(g); kb(g); g.r(23, 4, 7, 3, P.yellow); g.r(23, 7, 7, 3, P.blue); g.r(23, 10, 7, 2, P.red); papers(g, 2, 6); });
def('desk_mkt', 32, 20, (g) => { deskBase(g); kb(g); g.box(23, 5, 8, 6, '#2b2f37', P.ol); g.r(24, 6, 6, 4, '#ffd6a5'); g.r(2, 5, 3, 6, '#e07a2f'); g.r(3, 4, 1, 2, P.red); g.r(5, 6, 2, 5, P.blue); g.r(5, 5, 1, 2, P.yellow); });
def('exec_desk', 48, 22, (g) => {
  g.r(1, 20, 46, 2, '#00000022');
  g.box(0, 2, 48, 14, P.woodDD, P.ol);
  g.r(1, 3, 46, 4, '#7c4f2f'); g.r(2, 4, 44, 1, '#9a6a44'); g.r(2, 9, 44, 1, '#6b4428');
  g.r(1, 15, 46, 5, '#5a381f'); g.r(0, 15, 48, 1, P.ol); g.r(0, 20, 48, 1, P.ol);
  g.r(6, 16, 10, 3, '#6b4428'); g.r(32, 16, 10, 3, '#6b4428'); g.px(11, 17, P.gold); g.px(37, 17, P.gold);
  kb(g, 18);
  g.r(3, 7, 7, 6, P.paper); g.r(4, 6, 7, 6, '#f7f2e6'); g.r(5, 8, 4, 1, '#c8c2b4'); // documents
  g.r(12, 8, 4, 4, '#2b2f37'); g.r(13, 6, 1, 2, P.gold); g.r(14, 6, 1, 3, P.red); // pen holder
  g.r(32, 10, 12, 3, P.gold); g.r(33, 11, 10, 1, '#7c5a12'); // nameplate
  g.r(40, 4, 4, 4, '#3a3f4b'); g.r(41, 3, 2, 2, '#f3d58a'); // desk lamp
});
def('exec_chair', 14, 16, (g) => {
  g.box(1, 0, 12, 9, '#5a2f22', P.ol); g.r(2, 1, 10, 2, '#7a4434');
  g.box(0, 7, 14, 8, '#4a261b', P.ol); g.r(2, 8, 10, 1, '#6b3a2b'); g.r(6, 15, 2, 1, P.metalDD);
});
def('chair', 14, 14, (g) => {
  g.r(1, 12, 12, 2, '#00000022');
  g.box(1, 0, 12, 9, '#4f5a6e', P.ol); g.r(2, 1, 10, 2, '#66718a');
  g.box(0, 8, 14, 5, '#3d4656', P.ol); g.r(2, 9, 10, 1, '#55607a');
  g.r(6, 13, 2, 1, P.metalDD);
});
def('chair_visit', 12, 12, (g) => { g.box(0, 0, 12, 5, '#8a5a37', P.ol); g.box(1, 4, 10, 7, '#c9844f', P.ol); g.r(2, 5, 8, 1, '#e0a06a'); });
for (const [k, c] of [['term_0', ['#7CFC9A', '#3ad06a']], ['term_1', ['#3ad06a', '#7CFC9A']]]) {
  def(`monitor_${k}`, 14, 11, (g) => {
    g.box(0, 0, 14, 9, '#0f1a14', P.ol);
    g.r(2, 2, 7, 1, c[0]); g.r(2, 4, 9, 1, c[1]); g.r(2, 6, 5, 1, c[0]); g.r(8, 6, 2, 1, P.white);
    g.r(6, 9, 2, 1, P.metalDD); g.r(4, 10, 6, 1, P.metalDD);
  });
}

// ---- wall boards & screens ----
function board(name, w, h, frame, bg, content) {
  def(name, w, h, (g) => { g.box(0, 0, w, h, bg, frame); g.r(1, 1, w - 2, 1, '#ffffff55'); content(g); });
}
function screenProp(name, w, h, content) {
  def(name, w, h, (g) => { g.box(0, 0, w, h - 2, '#1e2a3a', '#20242b'); g.r(1, 1, w - 2, 1, '#2f4a6b'); content(g); g.r(w / 2 - 2, h - 2, 4, 2, P.metalDD); });
}
board('kpi_board', 40, 24, P.woodD, '#fbf7ee', (g) => {
  g.r(3, 3, 14, 1, P.ol); [[4, 6], [7, 9], [10, 5], [13, 11]].forEach(([x, hh]) => g.r(x, 20 - hh, 2, hh, x % 2 ? P.green : P.blue));
  g.r(3, 20, 15, 1, '#7a8396');
  for (let i = 0; i < 16; i++) g.px(21 + i, 16 - Math.round(i * 0.6 + (i % 3)), P.red);
  g.r(21, 4, 6, 2, P.green); g.r(29, 4, 7, 2, P.gold);
});
board('agenda_board', 32, 24, P.metalD, P.white, (g) => {
  g.r(3, 3, 12, 1, P.ol);
  for (let i = 0; i < 4; i++) { g.r(3, 7 + i * 4, 2, 2, i < 2 ? P.green : '#c8ccd4'); g.r(7, 7 + i * 4, 10 + (i % 3) * 4, 1, '#7a8396'); }
  g.r(25, 3, 4, 4, P.red);
});
def('present_screen', 48, 26, (g) => {
  g.r(0, 0, 48, 3, '#3a3f4b'); g.r(2, 3, 44, 20, '#f7f7f3'); g.r(2, 22, 44, 1, '#c8ccd4');
  g.r(6, 6, 16, 2, P.blue); g.r(6, 10, 22, 1, '#7a8396'); g.r(6, 13, 18, 1, '#7a8396');
  [[30, 6], [34, 9], [38, 4]].forEach(([x, hh]) => g.r(x, 19 - hh, 3, hh, P.teal));
  g.r(23, 23, 2, 3, '#3a3f4b');
});
def('projector', 14, 8, (g) => { g.box(0, 1, 14, 7, '#e2e2e2', P.ol); g.r(9, 2, 4, 4, '#2b2f37'); g.r(10, 3, 2, 2, '#9fd0ea'); g.px(3, 3, P.greenL); });
def('laptop', 10, 7, (g) => { g.box(0, 0, 10, 5, '#2b2f37', P.ol); g.r(1, 1, 8, 3, '#5ab8f0'); g.r(0, 5, 10, 2, '#9aa2ae'); });
def('water_bottle', 3, 6, (g) => { g.r(0, 1, 3, 5, '#bfe6f7'); g.r(1, 0, 1, 1, P.blue); });
board('perf_board', 40, 24, P.woodD, '#fbf7ee', (g) => {
  g.r(3, 3, 16, 1, P.ol);
  [[P.green, 12], ['#92400e', 9], [P.blue, 14], [P.purple, 6]].forEach(([c, hh], i) => g.r(5 + i * 8, 20 - hh, 5, hh, c));
  g.r(3, 20, 34, 1, '#7a8396');
});
board('finance_board', 32, 24, P.woodD, '#fbf7ee', (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const dx = x - 5.5, dy = y - 5.5;
    if (dx * dx + dy * dy < 30) g.px(4 + x, 6 + y, Math.atan2(dy, dx) > 1 ? P.gold : Math.atan2(dy, dx) > -1 ? P.green : P.blue);
  }
  g.r(19, 6, 9, 1, P.ol); g.r(19, 9, 7, 1, '#7a8396'); g.r(19, 12, 8, 1, '#7a8396'); g.r(19, 15, 6, 1, P.green);
});
screenProp('dash_screen', 32, 22, (g) => {
  g.r(3, 3, 8, 6, '#24364d'); g.r(4, 4, 6, 1, P.greenL); g.r(4, 6, 4, 1, P.white);
  for (let i = 0; i < 16; i++) g.px(13 + i, 12 - Math.round(Math.sin(i / 2) * 3 + i * 0.25), '#ffd166');
  [[4, 4], [8, 7], [12, 5], [16, 9], [20, 6]].forEach(([x, hh]) => g.r(x + 2, 18 - hh, 2, hh, P.screenOn));
});
board('calendar_board', 24, 22, P.red, P.white, (g) => {
  g.r(1, 1, 22, 4, P.red); g.px(6, 0, P.metalD); g.px(17, 0, P.metalD);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) g.r(3 + x * 4, 7 + y * 3, 2, 2, (x + y) % 4 === 0 ? P.yellow : '#c8ccd4');
});
def('welcome_sign', 36, 11, (g) => { g.box(0, 0, 36, 11, '#3f6f5a', '#2b4d3e'); g.r(1, 1, 34, 1, '#5d9178'); text(g, 'WELCOME', 4, 3, '#f7f2e6'); });
def('doc_shelf', 32, 30, (g) => {
  g.r(1, 28, 30, 2, '#00000022');
  g.box(0, 0, 32, 28, P.woodD, P.ol);
  const bc = [P.blue, P.red, P.yellow, P.green, P.teal, P.purple];
  for (let s = 0; s < 3; s++) {
    const y = 2 + s * 9;
    g.r(2, y, 28, 7, P.woodDD);
    for (let i = 0; i < 6; i++) { g.r(3 + i * 4.5, y + 1, 3, 6, bc[(i + s) % 6]); g.px(4 + i * 4.5, y + 3, P.white); }
    g.r(1, y + 7, 30, 1, P.woodL);
  }
});
def('bookshelf_tall', 32, 40, (g) => {
  g.r(1, 38, 30, 2, '#00000022');
  g.box(0, 0, 32, 38, '#6b4428', P.ol); g.r(1, 1, 30, 2, '#8a5a37');
  const colors = [P.red, P.blue, P.yellow, P.green, P.purple, P.teal, '#c27c4a', P.white, '#7a4434'];
  for (let s = 0; s < 4; s++) {
    const y = 4 + s * 8.5;
    g.r(2, y, 28, 7, '#4a2d18');
    let x = 3, k = s * 5;
    while (x < 28) {
      const w = 2 + ((k * 7) % 3 === 0 ? 1 : 0);
      const hh = 5 + (k % 3 === 0 ? 1 : 0);
      if (k % 7 === 4) { g.r(x, y + 7 - 3, 4, 3, colors[k % 9]); x += 5; } // lying book
      else { g.r(x, y + 7 - hh, w, hh, colors[k % 9]); g.px(x, y + 7 - hh + 1, '#ffffff55'); x += w; }
      k++;
    }
    g.r(1, y + 7, 30, 1, '#9a6a44');
  }
});
def('research_table', 40, 22, (g) => {
  g.r(1, 20, 38, 2, '#00000022');
  g.box(0, 0, 40, 14, P.woodL, P.ol); g.r(1, 1, 38, 2, '#dcae80'); g.r(0, 13, 40, 5, P.woodD); g.r(0, 18, 40, 1, P.ol);
  g.r(2, 18, 3, 4, P.woodDD); g.r(35, 18, 3, 4, P.woodDD);
  g.r(4, 4, 12, 7, P.paper); g.r(10, 4, 1, 7, '#c8c2b4'); g.r(5, 6, 4, 1, '#9aa2ae'); g.r(12, 7, 3, 1, '#9aa2ae'); // open book
  g.r(20, 3, 6, 3, P.blue); g.r(20, 6, 6, 3, P.red); g.r(21, 9, 5, 2, P.green); // stack
  g.r(30, 5, 6, 6, '#e8e2d0'); g.r(31, 6, 3, 1, '#9aa2ae'); g.r(31, 8, 4, 1, '#9aa2ae'); // notes
});
board('research_board', 32, 24, '#8a5a37', '#c89b6a', (g) => {
  g.r(3, 3, 7, 6, P.paper); g.r(13, 4, 7, 5, '#fff2b8'); g.r(23, 3, 6, 7, '#cfe7ff'); g.r(6, 13, 8, 7, P.white); g.r(19, 14, 9, 6, '#ffd6d6');
  for (let i = 0; i < 10; i++) g.px(9 + i, 9 + Math.round(i * 0.5), P.red);
  for (let i = 0; i < 8; i++) g.px(22 - i, 10 + Math.round(i * 0.5), P.red);
  for (const [x, y] of [[6, 3], [16, 4], [25, 3], [9, 13], [23, 14]]) g.px(x, y, P.red);
});
def('book_stack', 12, 10, (g) => { g.r(0, 6, 12, 4, P.blue); g.r(1, 3, 10, 3, P.red); g.r(2, 0, 8, 3, P.green); g.r(1, 7, 10, 1, '#ffffff66'); });
board('network_board', 40, 24, P.metalD, P.white, (g) => {
  const nodes = [[8, 6], [20, 5], [32, 7], [12, 16], [27, 17]];
  const line = (a, b) => { for (let t = 0; t <= 1; t += 0.05) g.px(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), '#7a8396'); };
  line(nodes[0], nodes[1]); line(nodes[1], nodes[2]); line(nodes[1], nodes[3]); line(nodes[1], nodes[4]); line(nodes[3], nodes[4]);
  nodes.forEach(([x, y], i) => { g.r(x - 2, y - 2, 4, 4, i === 1 ? P.blue : P.teal); g.px(x - 1, y - 1, P.white); });
});
def('status_panel', 16, 12, (g) => { g.box(0, 0, 16, 12, '#2b2f37', P.ol); for (let i = 0; i < 4; i++) { g.r(2 + i * 3, 3, 2, 2, '#1f2329'); g.r(2 + i * 3, 7, 2, 2, '#1f2329'); } });
def('cabinet_tall', 16, 30, (g) => {
  g.r(1, 28, 14, 2, '#00000022');
  g.box(0, 0, 16, 28, '#7d8796', P.ol); g.r(1, 1, 14, 2, '#a3abb9');
  for (const y of [4, 12, 20]) { g.r(2, y, 12, 6, P.metalD); g.r(4, y + 1, 8, 2, P.paper); g.r(6, y + 4, 4, 1, '#c9ced6'); }
});
board('recruit_board', 32, 24, '#8a5a37', '#c89b6a', (g) => {
  for (let i = 0; i < 3; i++) { const x = 3 + i * 10; g.r(x, 4, 8, 11, P.white); g.r(x + 2, 5, 4, 3, '#e0ac69'); g.r(x + 1, 9, 6, 1, '#9aa2ae'); g.r(x + 1, 11, 5, 1, '#9aa2ae'); g.px(x + 4, 4, P.red); }
  g.r(3, 18, 12, 2, P.green); g.r(17, 18, 8, 2, P.yellow);
});
board('hr_board', 32, 24, P.woodD, '#fbf7ee', (g) => {
  for (let r = 0; r < 4; r++) { g.r(3, 4 + r * 4, 8, 2, '#7a8396'); for (let s = 0; s < 5; s++) g.r(14 + s * 3, 4 + r * 4, 2, 2, s < 4 - (r % 3) ? P.gold : '#d6d0c2'); }
});
def('side_table', 20, 14, (g) => { g.r(1, 12, 18, 2, '#00000022'); g.box(0, 0, 20, 10, P.woodL, P.ol); g.r(1, 1, 18, 2, '#dcae80'); g.r(0, 9, 20, 3, P.woodD); g.r(6, 3, 6, 4, P.paper); g.r(14, 3, 3, 3, P.white); });
def('binder_shelf', 24, 24, (g) => {
  g.r(1, 22, 22, 2, '#00000022');
  g.box(0, 0, 24, 22, P.woodD, P.ol);
  for (let s = 0; s < 2; s++) { const y = 2 + s * 10; g.r(2, y, 20, 8, P.woodDD); for (let i = 0; i < 5; i++) { g.r(3 + i * 4, y + 1, 3, 7, [P.blue, P.red, P.green, P.yellow, P.teal][(i + s) % 5]); g.r(3 + i * 4, y + 4, 3, 1, P.white); } g.r(1, y + 8, 22, 1, P.woodL); }
});
board('campaign_board', 40, 24, '#2b2f37', '#ffe8cc', (g) => {
  g.r(3, 3, 16, 18, '#e07a2f'); g.r(5, 5, 12, 8, '#ffd166'); g.r(6, 15, 10, 1, P.white); g.r(6, 17, 7, 1, P.white);
  g.r(22, 3, 15, 8, '#5f7fb3'); g.r(24, 5, 6, 1, P.white); g.r(22, 13, 15, 8, '#b5446e'); g.r(24, 15, 9, 1, P.white);
});
board('moodboard', 32, 24, '#8a5a37', '#f3ead8', (g) => {
  const sw = ['#e07a2f', '#ffd166', '#5dd39e', '#5f7fb3', '#b5446e', '#8a6fb0'];
  sw.forEach((c, i) => g.r(3 + (i % 3) * 9, 3 + Math.floor(i / 3) * 9, 7, 7, c));
  g.r(4, 4, 2, 1, '#ffffff88'); g.r(22, 14, 4, 3, '#ffffff88');
});
board('content_calendar', 32, 24, '#3a3f4b', P.white, (g) => {
  g.r(1, 1, 30, 4, '#5f7fb3');
  const c = ['#e07a2f', '#5dd39e', '#b5446e', '#ffd166', null];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) { g.r(2 + x * 5, 7 + y * 5, 4, 4, '#eef0f3'); const k = c[(x * 3 + y) % 5]; if (k) g.r(3 + x * 5, 8 + y * 5, 2, 2, k); }
});
screenProp('analytics_screen', 40, 24, (g) => {
  g.r(3, 3, 3, 3, '#ff6b8b'); g.px(2, 3, '#ff6b8b'); g.r(8, 4, 8, 1, P.white);
  [[4, 5], [9, 9], [14, 7], [19, 12], [24, 10], [29, 15]].forEach(([x, hh]) => g.r(x, 20 - hh, 3, hh, x % 2 ? '#ff6b8b' : P.screenOn));
  g.r(34, 4, 3, 3, P.greenL); g.r(34, 9, 3, 3, P.yellow);
});
def('art_cart', 16, 20, (g) => {
  g.r(1, 18, 14, 2, '#00000022');
  g.box(0, 6, 16, 12, '#d65a4a', P.ol); g.r(1, 11, 14, 1, '#a8443a');
  g.r(2, 1, 2, 6, P.yellow); g.r(5, 0, 2, 7, P.blue); g.r(8, 2, 2, 5, P.green); g.r(11, 1, 3, 6, P.paper); g.px(3, 0, '#7a5b00');
});
def('easel', 16, 26, (g) => {
  g.r(1, 0, 14, 16, P.white); g.box(1, 0, 14, 16, P.white, P.woodD); g.r(3, 3, 10, 5, '#9fd0ea'); g.r(3, 8, 10, 5, P.greenL); g.r(9, 4, 3, 3, P.yellow);
  g.r(3, 16, 2, 10, P.woodD); g.r(11, 16, 2, 10, P.woodD); g.r(7, 16, 2, 8, P.woodDD); g.r(2, 16, 12, 1, P.woodD);
});
def('archive_shelf', 32, 28, (g) => {
  g.r(1, 26, 30, 2, '#00000022');
  g.box(0, 0, 32, 26, P.metal, P.ol);
  for (let s = 0; s < 2; s++) { const y = 2 + s * 12; g.r(2, y, 28, 10, P.metalD); for (let i = 0; i < 3; i++) { g.box(3 + i * 9, y + 2, 8, 8, '#c9a271', '#8a6a44'); g.r(5 + i * 9, y + 5, 4, 2, P.paper); } }
});
def('copier', 20, 18, (g) => { g.r(1, 16, 18, 2, '#00000022'); g.box(0, 3, 20, 13, '#dcd8cf', P.ol); g.r(2, 0, 16, 4, '#c3bfb6'); g.r(3, 6, 10, 2, '#4b505a'); g.r(15, 6, 3, 3, '#2b2f37'); g.px(16, 7, P.greenL); g.r(2, 12, 16, 2, P.paper); });
board('kanban_board', 40, 24, P.metalD, P.white, (g) => {
  for (let c = 0; c < 3; c++) { g.r(2 + c * 12 + 11, 2, 1, 20, '#c8ccd4'); g.r(3 + c * 12, 3, 9, 2, ['#7a8396', P.blue, P.green][c]); }
  const notes = [[0, 0, '#fff2b8'], [0, 1, '#ffd6d6'], [0, 2, '#cfe7ff'], [1, 0, '#fff2b8'], [1, 1, '#d9f2d0'], [2, 0, '#d9f2d0']];
  for (const [c, r, col] of notes) g.r(4 + c * 12, 7 + r * 5, 7, 4, col);
});
for (const [name, c, d] of [['sofa_blue_up', P.sofaB, P.sofaBD], ['sofa_green_up', P.sofaG, P.sofaGD]]) {
  def(name, 48, 22, (g) => {
    g.r(4, 20, 40, 2, '#00000033');
    g.box(5, 0, 38, 13, c, P.ol); g.r(24, 1, 1, 11, d); // seat (north side)
    g.box(0, 0, 6, 15, d, P.ol); g.box(42, 0, 6, 15, d, P.ol);
    g.box(0, 12, 48, 8, d, P.ol); // back (south)
  });
}
def('bean_bag', 16, 14, (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const dx = (x - 7.5) / 8, dy = (y - 6.5) / 6;
    const d = dx * dx + dy * dy;
    if (d < 1) g.px(x, y, d > 0.8 ? P.ol : dy < -0.2 ? '#f0b45a' : '#d9963b');
  }
  g.r(2, 12, 12, 2, '#00000022');
});
def('bean_bag_b', 16, 14, (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const dx = (x - 7.5) / 8, dy = (y - 6.5) / 6;
    const d = dx * dx + dy * dy;
    if (d < 1) g.px(x, y, d > 0.8 ? P.ol : dy < -0.2 ? '#8fb3e0' : '#6d90c2');
  }
  g.r(2, 12, 12, 2, '#00000022');
});
def('trophy_cabinet', 24, 30, (g) => {
  g.r(1, 28, 22, 2, '#00000022');
  g.box(0, 0, 24, 28, P.woodD, P.ol); g.r(2, 2, 20, 22, '#cfe8f2'); g.r(3, 3, 2, 18, '#ffffffaa');
  g.r(2, 12, 20, 1, P.woodD);
  g.r(6, 6, 5, 4, P.gold); g.r(8, 10, 1, 1, P.gold); g.r(14, 5, 4, 5, '#c0c0c0'); g.r(15, 10, 2, 1, '#c0c0c0');
  g.r(5, 16, 6, 5, P.gold); g.r(7, 21, 2, 2, P.woodDD); g.r(14, 17, 5, 5, '#cd7f32');
  g.r(2, 24, 20, 3, P.woodDD);
});
def('plaque', 12, 10, (g) => { g.box(0, 0, 12, 10, '#6b4428', P.ol); g.r(2, 2, 8, 6, P.gold); g.r(3, 4, 6, 1, '#7c5a12'); g.r(3, 6, 4, 1, '#7c5a12'); });
def('certificate', 14, 10, (g) => { g.box(0, 0, 14, 10, P.woodD, P.ol); g.r(1, 1, 12, 8, '#fbf7ee'); g.r(3, 3, 8, 1, '#7a8396'); g.r(3, 5, 6, 1, '#c8c2b4'); g.r(9, 6, 3, 3, P.red); });
def('folders', 12, 9, (g) => { g.r(0, 4, 12, 5, P.yellow); g.r(1, 2, 10, 3, P.blue); g.r(0, 6, 12, 1, '#c99a2e'); g.r(2, 0, 8, 3, P.red); });
def('clock_face', 12, 12, (g) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) { const d = Math.hypot(x - 5.5, y - 5.5); if (d < 6) g.px(x, y, d > 5 ? P.woodD : P.white); }
  g.px(5, 1, '#7a8396'); g.px(10, 5, '#7a8396'); g.px(5, 10, '#7a8396'); g.px(1, 5, '#7a8396');
});
// sway variants for ambient plant animation
def('plant_small_b', 12, 14, (g) => {
  g.r(3, 1, 8, 6, P.green); g.r(1, 3, 4, 3, P.greenD); g.r(9, 2, 3, 3, P.greenD); g.r(5, 0, 4, 2, P.greenL); g.r(4, 3, 2, 1, P.greenL);
  g.box(2, 7, 8, 7, P.pot, P.ol); g.r(3, 8, 6, 1, '#d07d52');
});
def('plant_big_b', 16, 28, (g) => {
  g.r(4, 2, 10, 14, P.green); g.r(1, 7, 5, 6, P.greenD); g.r(12, 3, 4, 7, P.greenD); g.r(6, 0, 6, 4, P.greenL);
  g.r(7, 5, 3, 2, P.greenL); g.r(10, 9, 3, 2, P.greenL); g.r(3, 12, 4, 3, P.greenD); g.r(7, 16, 2, 3, P.woodD);
  g.box(3, 18, 10, 10, P.pot, P.ol); g.r(4, 19, 8, 1, '#d07d52'); g.r(4, 26, 8, 1, P.potD);
});
// activity indicators
def('ico_gear_0', 11, 11, (g) => {
  g.r(1, 1, 9, 9, P.ol); g.r(2, 2, 7, 7, '#c9ced6'); g.r(4, 0, 3, 11, P.ol); g.r(0, 4, 11, 3, P.ol); g.r(5, 1, 1, 9, '#c9ced6'); g.r(1, 5, 9, 1, '#c9ced6'); g.r(4, 4, 3, 3, '#6b7280'); g.px(5, 5, P.ol);
});
def('ico_gear_1', 11, 11, (g) => {
  g.r(1, 1, 9, 9, P.ol); g.r(2, 2, 7, 7, '#c9ced6');
  for (const [x, y] of [[1, 1], [8, 1], [1, 8], [8, 8]]) g.r(x - 1, y - 1, 3, 3, P.ol), g.px(x, y, '#c9ced6');
  g.r(4, 4, 3, 3, '#6b7280'); g.px(5, 5, P.ol);
});
def('ico_ai', 7, 7, (g) => { g.r(3, 0, 1, 7, '#8da4ff'); g.r(0, 3, 7, 1, '#8da4ff'); g.r(2, 2, 3, 3, '#c7d2ff'); g.px(3, 3, P.white); });
bubble('bub_rest', '#e6f0ff', (g) => { g.r(3, 2, 4, 1, '#5b6b8c'); g.px(6, 3, '#5b6b8c'); g.px(5, 4, '#5b6b8c'); g.r(3, 5, 4, 1, '#5b6b8c'); g.r(7, 5, 2, 1, '#8a9bbf'); g.px(8, 6, '#8a9bbf'); g.r(7, 7, 2, 1, '#8a9bbf'); });
def('doormat', 28, 6, (g) => { g.box(0, 0, 28, 6, '#8a6a50', '#5d4636'); for (let x = 2; x < 26; x += 3) g.r(x, 2, 1, 2, '#a8876a'); });
def('sign_plank', 8, 13, (g) => { g.box(0, 0, 8, 13, '#9a6b43', '#5d3f26'); g.r(1, 1, 6, 1, '#b8885a'); g.r(1, 11, 6, 1, '#7a5233'); });

// ---------------- front yard (v4): ground, vehicles, street furniture ----------------
def('asphalt', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#4a4f57');
  for (const [x, y] of [[2, 3], [9, 1], [13, 7], [5, 10], [11, 13], [1, 14], [7, 6], [14, 2]]) g.px(x, y, '#585e67');
  for (const [x, y] of [[4, 5], [12, 11], [8, 14], [0, 8]]) g.px(x, y, '#41454c');
});
def('paving', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#cbc5ba');
  g.r(0, 7, 16, 1, '#ada79b'); g.r(0, 15, 16, 1, '#ada79b'); g.r(7, 0, 1, 7, '#ada79b'); g.r(15, 8, 1, 7, '#ada79b');
  g.r(0, 0, 7, 1, '#dad5cc'); g.r(0, 8, 15, 1, '#dad5cc');
});
// Scooters parked perpendicular to the aisle (3/4 top-down view), as in an Indonesian office motor park:
// motor_r_* = seen from behind (tail light, black plate), motor_f_* = seen from the front (headlight, apron).
const MOTOR_COLORS = [['red', '#c2413a', '#8f2e29'], ['blue', '#3f6fb5', '#2e5288'], ['black', '#3a3d44', '#24262b'], ['white', '#e6e4de', '#b9b6ae'], ['yellow', '#e0b03c', '#ab8327']];
for (const [n, c, d] of MOTOR_COLORS) {
  def(`motor_r_${n}`, 12, 22, (g) => {
    g.r(2, 20, 8, 2, '#00000035');
    g.r(0, 1, 12, 1, '#2b2b30'); g.r(0, 0, 2, 1, '#9aa0a8'); g.r(10, 0, 2, 1, '#9aa0a8'); // handlebar + mirrors
    g.box(4, 1, 4, 3, c, P.ol); // front shield top
    g.r(3, 4, 6, 6, '#2b2b30'); g.r(4, 5, 4, 1, '#45474f'); // seat
    g.box(2, 9, 8, 7, c, P.ol); g.r(3, 10, 6, 1, '#ffffff38'); g.r(3, 14, 6, 1, d); // rear body
    g.r(3, 12, 6, 1, '#d33a2c'); g.px(2, 12, '#f2a33a'); g.px(9, 12, '#f2a33a'); // tail light + signals
    g.r(3, 15, 6, 2, '#1d1f23'); g.px(4, 16, P.white); g.px(6, 16, P.white); g.px(7, 15, P.white); // plate
    g.r(4, 17, 4, 4, '#1d1f23'); g.r(5, 17, 1, 4, '#3a3d44'); // rear tire
  });
  def(`motor_f_${n}`, 12, 22, (g) => {
    g.r(2, 20, 8, 2, '#00000035');
    g.r(3, 0, 6, 3, '#2b2b30'); // seat (behind)
    g.r(0, 4, 12, 1, '#2b2b30'); g.r(0, 2, 2, 2, '#9aa0a8'); g.r(10, 2, 2, 2, '#9aa0a8'); // handlebar + mirrors
    g.box(2, 5, 8, 9, c, P.ol); g.r(3, 6, 6, 1, '#ffffff40'); g.r(3, 12, 6, 1, d); // apron
    g.r(4, 7, 4, 2, '#fff2b8'); g.px(2, 8, '#f2a33a'); g.px(9, 8, '#f2a33a'); // headlight + signals
    g.box(4, 13, 4, 3, c, P.ol); // front fender
    g.r(4, 16, 4, 5, '#1d1f23'); g.r(5, 16, 1, 5, '#3a3d44'); // front tire
  });
}
def('helmet', 6, 5, (g) => { g.r(1, 0, 4, 1, '#3a3d44'); g.r(0, 1, 6, 3, '#3a3d44'); g.r(1, 1, 3, 1, '#6b7078'); g.r(1, 4, 4, 1, '#1d1f23'); });
def('helmet_w', 6, 5, (g) => { g.r(1, 0, 4, 1, '#e6e4de'); g.r(0, 1, 6, 3, '#e6e4de'); g.r(1, 1, 3, 1, P.white); g.r(1, 4, 4, 1, '#3a3d44'); });
// Lifted off-road double-cabin pickup (yellow), 3/4 front-left view as in the owner's reference: black mesh grille,
// dark headlights, black bumper with silver skid plate and red tow hook, black fender flares, four doors, short bed,
// big all-terrain tires with grey rims, visible chassis under the raised body. Original pixel art, no brand logo.
function fillPoly(g, pts, c) {
  const ys = pts.map((p) => p[1]);
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const yc = y + 0.5;
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) g.px(x, y, c);
  }
}
function ell(g, cx, cy, rx, ry, fn) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (d <= 1) fn(x, y, d);
    }
  }
}
function offroadWheel(g, cx, cy, face) {
  // tread ring with knobby checker, then the rim seen at an angle (shifted to the visible side)
  ell(g, cx, cy, 6.2, 6.8, (x, y, d) => g.px(x, y, d > 0.72 ? ((x + y) % 2 ? '#111111' : '#3a3a3a') : '#1a1a1a'));
  if (!face) return;
  ell(g, cx + 1.5, cy, 2.6, 4.6, (x, y, d) => g.px(x, y, d > 0.6 ? '#8a8a8a' : (x + y) % 3 ? '#cfcfcf' : '#6b6b6b'));
  g.px(Math.round(cx + 1.5), Math.round(cy), '#4a4a4a');
}
def('raptor', 64, 34, (g) => {
  const Y = '#f2d23c', YL = '#f6e96a', YM = '#dcb52a', YD = '#b58a1c', O = '#111111', K = '#1b1b1d', KG = '#2e3035';
  // shadow
  for (let x = 3; x < 62; x++) { g.px(x, 32, '#00000040'); if (x > 6 && x < 59) g.px(x, 33, '#00000028'); }
  // far front wheel (under the nose), chassis and suspension under the raised body
  offroadWheel(g, 7, 25, false);
  g.r(24, 21, 30, 3, K); g.r(26, 24, 26, 1, KG); g.r(36, 22, 6, 4, KG); g.r(44, 23, 3, 3, '#3a3d44');
  // side body: doors (front 35..42, rear 43..50), lower crease, sill
  fillPoly(g, [[27, 8], [51, 8], [51, 21], [27, 21]], Y);
  g.r(27, 9, 24, 1, YL); g.r(27, 15, 24, 2, YM); g.r(27, 19, 24, 2, YD); g.r(27, 21, 24, 1, O);
  g.r(42, 8, 1, 13, YD); g.r(35, 8, 1, 12, YD); // door shut lines
  g.r(38, 11, 2, 1, YD); g.r(46, 11, 2, 1, YD); // handles
  // short bed with tail light
  fillPoly(g, [[50, 9], [61, 9], [61, 17], [50, 17]], Y); g.r(50, 9, 11, 1, YL); g.r(50, 8, 11, 1, O); g.r(61, 9, 1, 9, O);
  g.r(60, 10, 1, 3, '#b8282a'); g.r(50, 15, 11, 2, YM);
  // black fender flares (front and rear arches)
  ell(g, 31, 17, 6.5, 6, (x, y) => { if (y <= 18) g.px(x, y, (y === 11 || y === 12) ? KG : K); });
  ell(g, 56, 17, 6, 6, (x, y) => { if (y <= 18) g.px(x, y, (y === 11 || y === 12) ? KG : K); });
  // cab: roof edge, windshield (sloped), side windows, B-pillar, mirror with amber marker
  g.r(23, 0, 26, 1, O); g.r(23, 1, 26, 1, YL);
  fillPoly(g, [[16, 8], [23, 1], [25, 1], [18, 8]], YL); // A-pillar
  fillPoly(g, [[18, 7], [25, 2], [35, 2], [35, 7]], '#c9c9c9');
  fillPoly(g, [[20, 6], [26, 2], [34, 2], [34, 4], [24, 5]], '#e3e3e3');
  g.r(18, 7, 17, 1, '#8f8f8f');
  g.r(35, 1, 1, 8, Y); // windshield / door pillar
  g.r(36, 2, 6, 6, '#a9a9a9'); g.r(36, 2, 6, 2, '#c9c9c9');
  g.r(42, 1, 2, 8, O); // B-pillar
  g.r(44, 2, 5, 6, '#a9a9a9'); g.r(44, 2, 5, 2, '#c9c9c9');
  fillPoly(g, [[49, 1], [50, 1], [52, 8], [50, 8]], Y); // C-pillar down to the bed
  g.r(35, 4, 4, 3, O); g.r(36, 5, 2, 1, KG); g.px(37, 6, '#e2701b'); // mirror
  // hood (slightly rising toward the windshield) and front fender top
  fillPoly(g, [[3, 9], [9, 7], [26, 6], [28, 8], [27, 10], [3, 11]], Y);
  g.r(6, 8, 18, 1, YL); g.r(10, 7, 12, 1, YL);
  g.r(3, 9, 1, 3, O); g.r(3, 8, 6, 1, O); g.r(9, 6, 16, 1, O);
  // front face: mesh grille with a horizontal bar, dark headlight with amber side marker
  fillPoly(g, [[2, 10], [27, 10], [27, 16], [2, 16]], Y);
  g.r(4, 11, 16, 5, K);
  for (let x = 4; x < 20; x++) for (let y = 11; y < 16; y++) if ((x + y) % 2 === 0) g.px(x, y, '#4a4d54');
  g.r(4, 13, 16, 1, KG); for (const x of [6, 10, 14]) g.r(x, 13, 2, 1, '#5d6068');
  g.r(20, 11, 6, 3, KG); g.r(21, 12, 3, 1, '#bfc5cc'); g.px(25, 12, '#e2701b'); g.r(20, 14, 6, 1, '#4a4d54');
  g.r(2, 10, 1, 7, O); g.r(2, 16, 26, 1, YD);
  // big black bumper, fog lights, silver skid plate, red tow hook
  fillPoly(g, [[1, 17], [28, 17], [27, 22], [3, 22]], K);
  g.r(2, 17, 25, 1, KG); g.r(5, 18, 4, 1, '#3a3d44'); g.r(12, 18, 6, 1, '#3a3d44'); g.r(20, 18, 4, 1, '#3a3d44');
  g.r(5, 20, 14, 2, '#d0d0d0'); g.r(6, 21, 12, 1, '#a9a9a9'); g.r(8, 20, 1, 1, '#6b6b6b'); g.r(12, 20, 1, 1, '#6b6b6b'); g.r(16, 20, 1, 1, '#6b6b6b');
  g.r(10, 22, 2, 2, '#b8282a');
  // near-side wheels (rims visible)
  offroadWheel(g, 31, 25, true);
  offroadWheel(g, 56, 25, true);
});
def('grass', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#6aa55c');
  for (const [x, y] of [[2, 2], [9, 1], [13, 6], [5, 9], [11, 12], [1, 13], [7, 5], [14, 14]]) { g.px(x, y, '#83bd6f'); g.px(x, y + 1, '#5a9450'); }
});
def('bush', 14, 10, (g) => {
  g.r(2, 8, 10, 2, '#00000030');
  for (let y = 0; y < 9; y++) for (let x = 0; x < 14; x++) {
    const ex = (x - 6.5) / 7, ey = (y - 4.5) / 4.6;
    const d = ex * ex + ey * ey;
    if (d < 1) g.px(x, y, d > 0.75 ? '#2f5a2b' : ey < -0.2 ? '#7cb865' : '#4c8a45');
  }
});
def('lamp_post', 10, 44, (g) => {
  g.r(1, 42, 8, 2, '#00000033');
  g.r(4, 6, 2, 36, '#3d434e'); g.r(4, 6, 1, 36, '#5d6573');
  g.r(2, 39, 6, 4, '#3d434e');
  g.r(5, 3, 4, 2, '#3d434e');
  g.box(6, 2, 4, 4, '#d9dde3', '#3d434e');
});
for (const [name, dx] of [['tree', 0], ['tree_b', 1]]) {
  def(name, 26, 36, (g) => {
    g.r(5, 33, 16, 3, '#00000030');
    g.r(11, 22, 4, 12, '#7a5233'); g.r(11, 22, 1, 12, '#8f6340');
    for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) {
      const ex = (x - 12.5 - dx) / 12, ey = (y - 12) / 11.5;
      const d = ex * ex + ey * ey;
      if (d < 1) g.px(x, y, d > 0.82 ? '#2f5a2b' : ey < -0.3 && ex < 0.2 ? '#7cb865' : (x + y) % 5 === 0 ? '#4c8a45' : '#5f9e54');
    }
  });
}
def('p_sign', 12, 24, (g) => {
  g.r(5, 10, 2, 13, '#5d6573'); g.r(3, 22, 6, 2, '#00000033');
  g.box(0, 0, 12, 11, '#2f6fd0', P.white);
  g.r(4, 2, 2, 7, P.white); g.r(6, 2, 2, 1, P.white); g.r(8, 3, 1, 2, P.white); g.r(6, 5, 2, 1, P.white);
});

// =====================================================================================
// v5: startup office — open space, lounge with coffee corner & game corner, swimming pool, office boys' items.
// =====================================================================================
const ellipse = (g, w, h, fn) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x + 0.5 - w / 2) / (w / 2);
    const dy = (y + 0.5 - h / 2) / (h / 2);
    const d = dx * dx + dy * dy;
    if (d <= 1) { const c = fn(d, dx, dy, x, y); if (c) g.px(x, y, c); }
  }
};

// ---- floors ----
def('floor_concrete', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#c9c8c2');
  for (const [x, y] of [[2, 3], [9, 1], [13, 6], [5, 9], [11, 12], [1, 13], [7, 5], [14, 14], [4, 15], [12, 3]]) g.px(x, y, '#bdbcb5');
  for (const [x, y] of [[6, 2], [10, 9], [3, 11]]) g.px(x, y, '#d6d5cf');
  g.r(0, 15, 16, 1, '#b7b6af'); g.r(15, 0, 1, 16, '#b7b6af');
});
def('floor_deck', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#e9dfca');
  g.r(0, 0, 8, 8, '#e3d7bf'); g.r(8, 8, 8, 8, '#e3d7bf');
  g.r(0, 7, 16, 1, '#d2c4a6'); g.r(7, 0, 1, 16, '#d2c4a6'); g.r(0, 15, 16, 1, '#d2c4a6'); g.r(15, 0, 1, 16, '#d2c4a6');
  g.px(3, 3, '#f2ead9'); g.px(11, 11, '#f2ead9');
});
def('floor_terrazzo', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#ece6dc');
  const chips = [[2, 2, '#c9a27a'], [7, 4, '#8fb3a6'], [12, 2, '#d98c7a'], [4, 8, '#9aa7c4'], [10, 9, '#c9a27a'], [14, 12, '#8fb3a6'], [1, 13, '#d98c7a'], [7, 13, '#b8b2a7'], [12, 6, '#b8b2a7']];
  for (const [x, y, c] of chips) { g.px(x, y, c); g.px(x + 1, y, c); }
  g.r(0, 15, 16, 1, '#ddd6ca'); g.r(15, 0, 1, 16, '#ddd6ca');
});
// Pool water tile: pool-floor grid seen through the water (the engine adds moving highlights).
def('pool_water', 16, 16, (g) => {
  g.r(0, 0, 16, 16, '#45aed6');
  g.r(0, 15, 16, 1, '#5bbde0'); g.r(15, 0, 1, 16, '#5bbde0');
  g.r(0, 7, 16, 1, '#4fb5dc'); g.r(7, 0, 1, 16, '#4fb5dc');
  g.px(3, 4, '#7fd0ec'); g.px(4, 4, '#7fd0ec'); g.px(11, 10, '#7fd0ec'); g.px(12, 10, '#7fd0ec');
});

// ---- swimming pool props ----
def('pool_ladder', 12, 14, (g) => {
  for (const x of [1, 9]) { g.r(x, 0, 2, 13, '#c9d3dc'); g.r(x, 0, 1, 13, '#f2f6f8'); g.r(x, 13, 2, 1, '#7d8a96'); }
  for (const y of [5, 9]) g.r(3, y, 6, 1, '#ffffff99');
  g.r(0, 0, 4, 2, '#c9d3dc'); g.r(8, 0, 4, 2, '#c9d3dc');
});
def('lounger', 30, 14, (g) => {
  g.r(2, 12, 27, 2, '#00000026');
  g.box(0, 1, 30, 11, '#f2f2ee', P.ol);
  g.r(1, 2, 10, 9, '#dcdcd6'); // raised back rest
  for (let x = 2; x < 29; x += 4) g.r(x, 3, 2, 7, x < 11 ? '#4f8fc0' : '#5ea3d6');
  g.r(1, 2, 28, 1, '#ffffff');
  g.r(11, 1, 1, 11, '#c2c2bb');
  g.r(2, 3, 6, 3, '#ffffffcc'); // pillow
});
def('parasol', 28, 28, (g) => {
  ellipse(g, 28, 28, (d, dx, dy) => {
    if (d > 0.92) return P.ol;
    const a = Math.atan2(dy, dx);
    const seg = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 8) % 2;
    const base = seg ? '#e85d4a' : '#f7f2e6';
    return dy < -0.3 && dx < 0.3 ? (seg ? '#f07a69' : '#ffffff') : base;
  });
  g.r(13, 13, 2, 2, '#8a5a37'); g.px(13, 13, '#c99466');
});
def('float_ring', 12, 12, (g) => {
  ellipse(g, 12, 12, (d, dx, dy) => {
    if (d < 0.22) return null;
    if (d > 0.9 || (d > 0.22 && d < 0.3)) return '#8f2e29';
    const q = (dx > 0) === (dy > 0);
    return q ? '#e84a3c' : '#f7f2e6';
  });
});
for (const [name, sway] of [['palm', 0], ['palm_b', 1]]) {
  def(name, 22, 34, (g) => {
    g.r(4, 32, 14, 2, '#00000022');
    g.box(5, 24, 12, 9, '#d9cbb3', P.ol); g.r(6, 25, 10, 1, '#efe5d3'); g.r(6, 31, 10, 1, '#b9ab93');
    for (let y = 10; y < 25; y++) g.r(10 + (y < 16 ? sway : 0), y, 2, 1, y % 3 ? '#8a6a44' : '#6b4f30');
    const frond = (x0, y0, dir, len) => { for (let i = 0; i < len; i++) { const x = x0 + dir * i; const y = y0 + Math.round(i * i * 0.08); g.r(x, y, 2, 2, i % 2 ? P.green : P.greenL); g.px(x, y + 2, P.greenD); } };
    frond(11 + sway, 9, -1, 10); frond(11 + sway, 9, 1, 10); frond(11 + sway, 7, -1, 6); frond(11 + sway, 7, 1, 6);
    g.r(9 + sway, 5, 4, 5, P.greenD); g.r(10 + sway, 4, 2, 2, P.greenL);
  });
}
def('lifebuoy', 12, 12, (g) => {
  ellipse(g, 12, 12, (d, dx, dy) => (d < 0.25 ? null : d > 0.88 ? '#8f2e29' : (Math.abs(dx) > Math.abs(dy) ? '#f07a3a' : '#f7f2e6')));
  g.r(5, 0, 2, 1, '#5d4636');
});
def('towel_rack', 18, 22, (g) => {
  g.r(1, 20, 16, 2, '#00000022');
  g.r(1, 2, 2, 18, P.woodD); g.r(15, 2, 2, 18, P.woodD); g.r(1, 2, 16, 2, P.wood);
  g.r(3, 4, 5, 12, '#5ea3d6'); g.r(3, 6, 5, 1, P.white); g.r(3, 10, 5, 1, P.white);
  g.r(9, 4, 5, 10, '#f2c14e'); g.r(9, 7, 5, 1, '#fff2b8');
  g.r(1, 12, 16, 1, P.woodD);
});
def('pool_shower', 10, 28, (g) => {
  g.r(1, 26, 8, 2, '#00000022');
  g.box(0, 22, 10, 5, '#d7dde3', '#9aa5b1');
  g.r(4, 4, 2, 19, '#c9d3dc'); g.r(4, 4, 1, 19, '#f2f6f8');
  g.r(4, 3, 5, 2, '#c9d3dc'); g.box(6, 4, 4, 3, '#aab6c2', '#7d8a96'); g.px(7, 7, '#9fd0ea'); g.px(8, 8, '#9fd0ea');
});

// ---- coffee corner ----
def('coffee_bar', 56, 28, (g) => {
  g.r(2, 26, 52, 2, '#00000026');
  // counter top
  g.box(0, 10, 56, 6, '#d9b58c', P.ol); g.r(1, 11, 54, 1, '#ecd0ad');
  // front panel with vertical slats
  g.box(0, 15, 56, 11, '#6b4428', P.ol);
  for (let x = 3; x < 54; x += 4) g.r(x, 16, 1, 9, '#5a381f');
  g.r(1, 24, 54, 1, '#4a2e19');
  // espresso machine
  g.box(4, 1, 16, 10, '#c9d3dc', P.ol); g.r(5, 2, 14, 2, '#eef2f5'); g.r(6, 5, 12, 1, '#7d8a96');
  g.r(7, 7, 3, 3, '#3d434e'); g.r(14, 7, 3, 3, '#3d434e'); g.px(11, 3, '#e5484d'); g.px(13, 3, '#5dd39e');
  // grinder
  g.r(23, 2, 6, 3, '#6b4428'); g.r(22, 5, 8, 6, '#2b2f37'); g.r(24, 1, 4, 2, '#8a5a37'); g.px(25, 7, '#c9d3dc');
  // cups
  for (const x of [33, 37]) { g.r(x, 7, 3, 4, P.white); g.r(x, 7, 3, 1, '#6b4428'); }
  g.r(33, 4, 3, 3, P.white); g.r(37, 4, 3, 3, '#5ea3d6');
  // cake dome
  g.r(43, 4, 9, 7, '#cfe8f2'); g.r(44, 3, 7, 1, '#cfe8f2'); g.r(46, 2, 3, 1, '#9aa5b1'); g.r(45, 7, 5, 3, '#c98b5a'); g.r(45, 7, 5, 1, '#f7f2e6'); g.r(44, 4, 1, 3, '#ffffffaa');
  g.r(42, 10, 11, 1, '#9aa5b1');
});
def('bar_stool', 10, 12, (g) => {
  g.r(2, 10, 7, 2, '#00000022');
  g.r(4, 5, 2, 6, '#5d6573'); g.r(2, 10, 6, 1, '#5d6573');
  ellipse(g, 10, 7, (d) => (d > 0.8 ? P.ol : d < 0.3 ? '#3a3f4b' : '#2b2f37'));
});
board('coffee_menu', 30, 22, '#6b4428', '#2b2f2d', (g) => {
  text(g, 'COFFEE', 3, 3, '#f7f2e6');
  for (let i = 0; i < 3; i++) { g.r(3, 11 + i * 3, 14, 1, '#cfd6cf'); g.r(22, 11 + i * 3, 4, 1, '#f2c14e'); }
});
def('drink_fridge', 16, 28, (g) => {
  g.r(1, 26, 14, 2, '#00000022');
  g.box(0, 0, 16, 26, '#e7ecf0', P.ol); g.r(1, 1, 14, 3, '#5ea3d6');
  g.r(2, 5, 12, 19, '#cfe8f2');
  const cols = ['#e5484d', '#f2c14e', '#5dd39e', '#8a6fb0'];
  for (let s = 0; s < 3; s++) { g.r(2, 10 + s * 6, 12, 1, '#9aa5b1'); for (let i = 0; i < 4; i++) g.r(3 + i * 3, 6 + s * 6, 2, 4, cols[(i + s) % 4]); }
  g.r(13, 9, 1, 8, '#7d8a96');
});

// ---- game corner ----
def('pingpong', 46, 28, (g) => {
  g.r(2, 26, 43, 2, '#00000026');
  g.r(3, 22, 2, 4, P.metalDD); g.r(41, 22, 2, 4, P.metalDD);
  g.box(0, 2, 46, 21, '#2f6f8f', P.ol);
  g.r(1, 3, 44, 1, '#f7f2e6'); g.r(1, 21, 44, 1, '#f7f2e6'); g.r(1, 3, 1, 19, '#f7f2e6'); g.r(44, 3, 1, 19, '#f7f2e6');
  g.r(2, 12, 42, 1, '#cfe1ea');
  g.r(22, 0, 2, 25, '#f7f2e6'); g.r(22, 0, 2, 1, P.ol); g.r(21, 1, 1, 23, '#1f2937'); g.r(24, 1, 1, 23, '#3d5a6b'); // net
  g.r(7, 6, 5, 5, '#c2413a'); g.r(9, 11, 1, 3, '#8a5a37'); // paddle red
  g.r(34, 14, 5, 5, '#2b2f37'); g.r(36, 19, 1, 3, '#8a5a37'); // paddle black
  g.px(30, 8, P.white);
});
def('foosball', 38, 24, (g) => {
  g.r(2, 22, 35, 2, '#00000026');
  g.box(0, 2, 38, 19, '#8a5a37', P.ol); g.r(2, 4, 34, 15, '#4f9a54');
  g.r(19, 4, 1, 15, '#ffffff88'); g.r(2, 9, 2, 5, '#ffffff88'); g.r(34, 9, 2, 5, '#ffffff88');
  for (let i = 0; i < 4; i++) {
    const x = 9 + i * 7;
    g.r(x, 0, 1, 24, '#c9d3dc');
    g.r(x, 0, 1, 2, '#2b2f37'); g.r(x, 22, 1, 2, '#2b2f37');
    for (const y of [7, 14]) g.r(x - 1, y, 3, 2, i % 2 ? '#3f6fb5' : '#d65a4a');
  }
  g.px(17, 11, P.white);
});
def('arcade', 18, 32, (g) => {
  g.r(1, 30, 16, 2, '#00000026');
  g.box(1, 0, 16, 30, '#4b2f7a', P.ol);
  g.r(2, 1, 14, 5, '#f2c14e'); g.r(3, 2, 12, 1, '#ff6ad5'); g.r(3, 4, 12, 1, '#ff6ad5');
  g.box(3, 7, 12, 10, '#0b1020', '#2b2f37');
  g.box(1, 18, 16, 6, '#5a3d8a', P.ol); g.r(4, 19, 2, 3, '#1f2329'); g.px(4, 19, '#e5484d'); g.px(9, 20, '#e5484d'); g.px(11, 20, '#f2c14e'); g.px(13, 20, '#5dd39e');
  g.r(1, 8, 1, 10, '#ff6ad5'); g.r(16, 8, 1, 10, '#5ec8f0');
  g.r(5, 25, 8, 3, '#2b2f37'); g.r(7, 26, 4, 1, '#f2c14e');
});
def('dartboard', 12, 12, (g) => {
  ellipse(g, 12, 12, (d, dx, dy) => (d > 0.86 ? '#1f2329' : d > 0.55 ? ((Math.atan2(dy, dx) * 4 / Math.PI + 8) % 2 < 1 ? '#c2413a' : '#f2eee4') : d > 0.25 ? '#2b2f37' : d > 0.06 ? '#3f8a4a' : '#c2413a'));
});

// ---- startup decor ----
def('neon_sign', 40, 14, (g) => {
  g.box(0, 0, 40, 14, '#22202a', '#141218');
  text(g, 'AI LAB', 8, 4, '#ff6ad5');
  for (let x = 2; x < 38; x += 3) { g.px(x, 1, '#5ec8f0'); g.px(x + 1, 12, '#5ec8f0'); }
});
def('phone_booth', 22, 34, (g) => {
  g.r(1, 32, 20, 2, '#00000026');
  g.box(0, 0, 22, 32, '#3d434e', P.ol); g.r(1, 1, 20, 3, '#5f7fb3');
  g.box(3, 5, 16, 25, '#9fd0ea', '#2b2f37'); g.r(4, 6, 4, 18, '#cdeaf7');
  g.r(8, 18, 6, 8, '#5f7fb3'); g.r(9, 14, 4, 4, '#e0ac69'); // someone's chair + lamp silhouette
  g.r(16, 16, 1, 4, '#2b2f37');
});
def('bike_rack', 32, 20, (g) => {
  g.r(2, 18, 28, 2, '#00000022');
  g.r(1, 15, 30, 2, '#7d8a96');
  const wheel = (cx) => { for (let a = 0; a < 24; a++) { const t = (a / 24) * Math.PI * 2; g.px(Math.round(cx + Math.cos(t) * 6), Math.round(10 + Math.sin(t) * 6), '#1f2329'); } g.px(cx, 10, '#9aa5b1'); };
  wheel(8); wheel(24);
  for (let i = 0; i <= 8; i++) { g.px(8 + i, 10 - Math.round(i * 0.5), '#2fa6a0'); g.px(16 + i, 6 + Math.round(i * 0.5), '#2fa6a0'); }
  g.r(12, 4, 6, 1, '#2fa6a0'); g.r(14, 2, 4, 2, '#2b2f37'); g.r(21, 3, 4, 1, '#2b2f37');
});
def('ob_cart', 22, 22, (g) => {
  g.r(1, 20, 20, 2, '#00000026');
  g.box(1, 4, 20, 14, '#8a93a3', P.ol); g.r(2, 10, 18, 1, '#5d6573');
  g.box(3, 6, 8, 8, '#f2c14e', '#a8792a'); g.r(4, 7, 6, 2, '#5ea3d6');
  g.r(13, 3, 3, 6, '#3f6fb5'); g.r(17, 4, 3, 5, '#5dd39e'); g.r(13, 2, 2, 1, P.white);
  g.r(12, 12, 8, 5, '#1f2329');
  g.r(0, 4, 1, 12, '#5d6573');
  g.r(3, 18, 3, 2, '#2b2f37'); g.r(16, 18, 3, 2, '#2b2f37');
});

// ---- office boy items (drawn in the hands / next to the NPC) ----
def('ob_tray', 10, 6, (g) => {
  g.r(0, 4, 10, 2, '#9aa5b1'); g.r(0, 4, 10, 1, '#dfe5ea');
  g.r(1, 1, 3, 3, P.white); g.r(1, 1, 3, 1, '#6b4428'); g.r(6, 1, 3, 3, P.white); g.r(6, 1, 3, 1, '#6b4428');
});
def('ob_mop', 8, 20, (g) => {
  g.r(3, 0, 1, 15, '#b07a4f'); g.r(4, 0, 1, 15, '#8a5a37');
  g.r(1, 15, 6, 2, '#9aa5b1'); for (let x = 0; x < 8; x += 2) g.r(x, 17, 1, 3, '#d7dde3');
});
def('wet_sign', 10, 13, (g) => {
  g.r(1, 11, 9, 2, '#00000022');
  g.box(1, 0, 8, 11, '#f2c14e', '#7a5b00'); g.r(2, 1, 6, 1, '#fff2b8');
  g.r(4, 3, 2, 4, '#1f2329'); g.r(4, 8, 2, 1, '#1f2329');
});
def('ob_net', 6, 22, (g) => {
  g.box(0, 0, 6, 6, '#cfe8f2', '#3f6fb5'); g.px(2, 2, '#3f6fb5'); g.px(3, 3, '#3f6fb5');
  g.r(2, 6, 2, 16, '#c9d3dc'); g.r(2, 6, 1, 16, '#f2f6f8');
});
def('ob_can', 9, 7, (g) => { g.box(1, 2, 6, 5, '#4f9a54', '#2f6a35'); g.r(2, 3, 4, 1, '#86c46c'); g.r(7, 2, 2, 1, '#4f9a54'); g.px(8, 1, '#4f9a54'); g.r(2, 0, 4, 1, '#2f6a35'); g.px(1, 1, '#2f6a35'); g.px(6, 1, '#2f6a35'); });

// ---------------- pack (shelf packing, 2px padding) ----------------
const PAD = 2;
const W = 512;
const list = Object.entries(sprites).sort((a, b) => b[1].h - a[1].h || b[1].w - a[1].w);
let x = PAD, y = PAD, shelfH = 0;
const frames = {};
for (const [name, s] of list) {
  if (x + s.w + PAD > W) {
    x = PAD;
    y += shelfH + PAD;
    shelfH = 0;
  }
  frames[name] = { x, y, w: s.w, h: s.h };
  x += s.w + PAD;
  shelfH = Math.max(shelfH, s.h);
}
const H = Math.ceil((y + shelfH + PAD) / 8) * 8;
const atlas = new Raster(W, H);
for (const [name, s] of list) {
  const g = new Raster(s.w, s.h);
  s.draw(g);
  atlas.blit(g, frames[name].x, frames[name].y);
}

// ---------------- PNG encoder (RGBA, filter 0, zlib level 9) ----------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let row = 0; row < H; row++) {
  raw[row * (W * 4 + 1)] = 0;
  atlas.d.copy(raw, row * (W * 4 + 1) + 1, row * W * 4, (row + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'office-atlas.png'), png);
// version = content hash: the PNG URL changes whenever the image changes, so a cached old sheet is never reused.
const version = crypto.createHash('sha1').update(png).digest('hex').slice(0, 12);
const meta = { version, image: 'office-atlas.png', width: W, height: H, frames };
fs.writeFileSync(path.join(outDir, 'office-atlas.json'), JSON.stringify(meta));
fs.writeFileSync(
  path.join(outDir, '..', 'js', 'office', 'atlas-data.js'),
  `// Generated by scripts/build-office-atlas.mjs — do not edit. Frame map of public/assets/office-atlas.png.\nexport default ${JSON.stringify(meta)};\n`
);
console.log(`office-atlas.png ${W}x${H}, ${Object.keys(frames).length} frames, ${png.length} bytes`);
