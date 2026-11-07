// Procedural pixel-art characters (original art, generated at runtime: zero image downloads).
// A character frame is 16x24 logical pixels. Frames are pre-rendered once per employee into a small sprite sheet.

export const FW = 16;
export const FH = 24;

const DEFAULT = { skin: '#f1c27d', hair: '#3b2416', hairStyle: 'short', shirt: '#3b82f6', pants: '#1f2937', accent: '#ffffff', glasses: false };
const SHOE = '#20232a';
const EYE = '#1b1b1b';
const OUTLINE = 'rgba(0,0,0,0.28)';

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

function painter(ctx, ox, oy) {
  return (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(ox + x, oy + y, w, h);
  };
}

function hair(p, pal, facing) {
  const H = pal.hair;
  const style = pal.hairStyle || 'short';
  if (style === 'bald') return;
  if (style === 'cap') {
    p(4, 2, 8, 3, pal.accent);
    p(4, 2, 8, 1, shade(pal.accent, 1.15));
    if (facing === 'down') p(3, 5, 10, 1, shade(pal.accent, 0.75));
    if (facing === 'side') p(9, 5, 4, 1, shade(pal.accent, 0.75));
    if (facing === 'up') p(4, 5, 8, 3, H);
    return;
  }
  p(4, 2, 8, 3, H);
  p(5, 1, 6, 1, H);
  if (facing === 'up') {
    p(4, 5, 8, 4, H);
    if (style === 'long') p(4, 9, 8, 3, H);
  } else if (facing === 'side') {
    p(4, 5, 3, 3, H);
    if (style === 'long') p(4, 8, 3, 4, H);
  } else {
    p(4, 5, 1, 2, H);
    p(11, 5, 1, 2, H);
    if (style === 'long') {
      p(3, 5, 1, 7, H);
      p(12, 5, 1, 7, H);
      p(4, 7, 1, 5, H);
      p(11, 7, 1, 5, H);
    }
  }
  if (style === 'messy') {
    p(3, 2, 1, 2, H);
    p(12, 2, 1, 2, H);
    p(6, 0, 1, 1, H);
    p(9, 0, 1, 1, H);
  }
  if (style === 'bun') {
    p(6, -1, 4, 2, shade(H, 0.9));
  }
}

function head(p, pal, facing) {
  if (facing === 'side') {
    p(5, 3, 7, 6, pal.skin);
    p(10, 6, 1, 1, EYE);
    if (pal.glasses) p(9, 5, 3, 3, 'rgba(20,20,20,0.85)'), p(10, 6, 1, 1, '#cfe8ff');
  } else {
    p(4, 3, 8, 6, pal.skin);
    p(4, 8, 8, 1, shade(pal.skin, 0.9));
    if (facing === 'down') {
      p(6, 6, 1, 1, EYE);
      p(9, 6, 1, 1, EYE);
      p(7, 8, 2, 1, shade(pal.skin, 0.75));
      if (pal.glasses) {
        p(5, 5, 3, 3, 'rgba(20,20,20,0.85)');
        p(8, 5, 3, 3, 'rgba(20,20,20,0.85)');
        p(6, 6, 1, 1, '#cfe8ff');
        p(9, 6, 1, 1, '#cfe8ff');
      }
    }
  }
  hair(p, pal, facing);
}

function torso(p, pal, facing, armPose = 0) {
  const S = pal.shirt;
  const dark = shade(S, 0.8);
  if (facing === 'side') {
    p(5, 9, 6, 7, S);
    p(5, 15, 6, 1, dark);
    const swing = armPose === 1 ? -1 : armPose === 2 ? 1 : 0;
    p(7 + swing, 10, 2, 5, dark);
    p(7 + swing, 15, 2, 1, pal.skin);
    return;
  }
  p(3, 9, 10, 7, S);
  p(3, 15, 10, 1, dark);
  if (facing === 'down') {
    p(7, 9, 2, 3, pal.accent);
    p(7, 12, 2, 1, shade(pal.accent, 0.8));
  }
  // arms
  const la = armPose === 1 ? -1 : armPose === 2 ? 1 : 0;
  p(2, 10 + la, 1, 5, dark);
  p(13, 10 - la, 1, 5, dark);
  p(2, 15 + la, 1, 1, pal.skin);
  p(13, 15 - la, 1, 1, pal.skin);
}

function legs(p, pal, facing, step = 0) {
  const P = pal.pants;
  if (facing === 'side') {
    const a = step === 1 ? 1 : step === 3 ? -1 : 0;
    p(6, 16, 4, 3, P);
    p(6 + a, 19, 2, 3, P);
    p(8 - a, 19, 2, 3, shade(P, 0.85));
    p(6 + a, 22, 3, 1, SHOE);
    p(8 - a, 22, 3, 1, SHOE);
    return;
  }
  p(4, 16, 8, 3, P);
  const l = step === 1 ? -1 : 0;
  const r = step === 3 ? -1 : 0;
  p(5, 19, 3, 3 + l, P);
  p(8, 19, 3, 3 + r, shade(P, 0.9));
  p(5, 22 + l, 3, 1, SHOE);
  p(8, 22 + r, 3, 1, SHOE);
}

// Draw one frame into ctx at (ox, oy).
export function drawFrame(ctx, palette, pose, frame, ox = 0, oy = 0) {
  const pal = { ...DEFAULT, ...palette };
  const p = painter(ctx, ox, oy);
  switch (pose) {
    case 'walk_down':
    case 'walk_up':
    case 'walk_side': {
      const facing = pose.slice(5);
      const bob = frame % 2 === 1 ? 1 : 0;
      const q = painter(ctx, ox, oy + bob);
      legs(p, pal, facing, frame);
      torso(q, pal, facing, frame === 1 ? 1 : frame === 3 ? 2 : 0);
      head(q, pal, facing);
      break;
    }
    case 'sit_back': {
      // Seated at a desk, seen from behind; arms reach forward and alternate (typing).
      const q = painter(ctx, ox, oy + 3);
      q(3, 9, 10, 6, pal.shirt);
      q(3, 14, 10, 1, shade(pal.shirt, 0.8));
      const t = frame % 2;
      q(2, 7 + t, 2, 4, shade(pal.shirt, 0.8));
      q(12, 8 - t, 2, 4, shade(pal.shirt, 0.8));
      q(2, 6 + t, 2, 1, pal.skin);
      q(12, 7 - t, 2, 1, pal.skin);
      head(q, pal, 'up');
      break;
    }
    case 'sit_front': {
      // Relaxed seated pose (waiting): hands behind the head.
      const q = painter(ctx, ox, oy + 3);
      q(4, 16, 8, 2, pal.pants);
      q(4, 18, 3, 1, SHOE);
      q(9, 18, 3, 1, SHOE);
      torso(q, pal, 'down', 0);
      q(2, 10, 1, 5, pal.shirt);
      q(13, 10, 1, 5, pal.shirt);
      head(q, pal, 'down');
      q(2, 4, 2, 2, pal.skin);
      q(12, 4, 2, 2, pal.skin);
      if (frame % 2) q(7, 8, 2, 1, shade(pal.skin, 0.6));
      break;
    }
    case 'jump': {
      const up = frame % 2 ? 3 : 0;
      const q = painter(ctx, ox, oy - up);
      legs(q, pal, 'down', 0);
      torso(q, pal, 'down', 0);
      q(1, 6, 1, 4, shade(pal.shirt, 0.8));
      q(14, 6, 1, 4, shade(pal.shirt, 0.8));
      q(1, 5, 1, 1, pal.skin);
      q(14, 5, 1, 1, pal.skin);
      head(q, pal, 'down');
      break;
    }
    default: {
      // stand (front), frame 1 = slight breathing
      const q = painter(ctx, ox, oy + (frame % 2));
      legs(p, pal, 'down', 0);
      torso(q, pal, 'down', 0);
      head(q, pal, 'down');
    }
  }
}

export const POSES = [
  ['stand', 2], ['walk_down', 4], ['walk_up', 4], ['walk_side', 4], ['sit_back', 2], ['sit_front', 2], ['jump', 2],
];

// Sprite sheet: one row per pose, columns = frames. Returns { canvas, frame(pose, i) -> [sx, sy] }.
export function buildSheet(palette) {
  const cols = Math.max(...POSES.map(([, n]) => n));
  const c = document.createElement('canvas');
  c.width = cols * FW;
  c.height = POSES.length * FH + 2; // +2 headroom for buns
  const ctx = c.getContext('2d');
  const index = {};
  POSES.forEach(([pose, n], row) => {
    index[pose] = row;
    for (let i = 0; i < n; i++) drawFrame(ctx, palette, pose, i, i * FW, row * FH + 2);
  });
  return {
    canvas: c,
    frame(pose, i) {
      const row = index[pose] ?? 0;
      const n = POSES[row][1];
      return [(i % n) * FW, row * FH];
    },
  };
}

// Small standalone avatar for lists/forms.
export function avatarCanvas(palette, scale = 2, pose = 'stand') {
  const c = document.createElement('canvas');
  c.width = FW;
  c.height = FH + 2;
  c.className = 'avatar-canvas';
  c.style.width = `${FW * scale}px`;
  c.style.height = `${(FH + 2) * scale}px`;
  drawFrame(c.getContext('2d'), palette || {}, pose, 0, 0, 2);
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'avatar');
  return c;
}
