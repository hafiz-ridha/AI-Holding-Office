// Generates the office sprite sheet: public/assets/office-atlas.png (+ .json frame map).
// Original pixel art drawn with simple primitives, encoded as a compressed PNG using only Node built-ins (zlib).
// Run: node scripts/build-office-atlas.mjs   (you may replace the PNG with your own art using the same frame names)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

// ---------------- pack (shelf packing, 2px padding) ----------------
const PAD = 2;
const W = 256;
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
fs.writeFileSync(path.join(outDir, 'office-atlas.json'), JSON.stringify({ version: 1, image: 'office-atlas.png', width: W, height: H, frames }));
console.log(`office-atlas.png ${W}x${H}, ${Object.keys(frames).length} frames, ${png.length} bytes`);
