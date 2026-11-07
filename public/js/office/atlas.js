// Loads the local sprite sheet once (≈3 KB PNG + frame map) and draws frames by name.
let promise = null;

export function loadAtlas() {
  if (!promise) {
    promise = (async () => {
      const meta = await fetch('/assets/office-atlas.json', { credentials: 'same-origin' }).then((r) => {
        if (!r.ok) throw new Error('Atlas kantor tidak ditemukan');
        return r.json();
      });
      // onload/onerror instead of img.decode(): decode() can stay pending for cached images in some Chromium builds.
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout memuat sprite sheet kantor')), 15000);
        img.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Sprite sheet kantor gagal dimuat'));
        };
        img.src = `/assets/${meta.image}?v=${meta.version}`;
        if (img.complete && img.naturalWidth) {
          clearTimeout(timer);
          resolve();
        }
      });
      return {
        img,
        frames: meta.frames,
        has: (name) => Boolean(meta.frames[name]),
        // Draw at world coordinates (logical px) into a context already scaled to world space.
        draw(ctx, name, x, y, w, h) {
          const f = meta.frames[name];
          if (!f) return;
          ctx.drawImage(img, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), w ?? f.w, h ?? f.h);
        },
        size: (name) => meta.frames[name] || { w: 0, h: 0 },
      };
    })().catch((e) => {
      promise = null;
      throw e;
    });
  }
  return promise;
}
