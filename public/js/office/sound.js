// Optional office sounds, synthesized with WebAudio (no audio files, no dependency).
// Always OFF when the page loads and never autoplays: the AudioContext is created only inside the click that turns
// sound on. Typing ticks play only while a visible character really has the WORKING state.
export function createSound() {
  let ctx = null;
  let on = false;
  let timer = null;
  let typingFn = () => false;

  function tone(freq, dur, type = 'sine', vol = 0.05, delay = 0) {
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function tick() {
    // Soft keyboard click: very short filtered square blip with random pitch.
    tone(1800 + Math.random() * 900, 0.025, 'square', 0.012);
  }

  function loop() {
    clearTimeout(timer);
    if (!on) return;
    if (typingFn() && !document.hidden) tick();
    timer = setTimeout(loop, 140 + Math.random() * 260);
  }

  return {
    get on() {
      return on;
    },
    // Must be called from a user gesture (button click).
    toggle() {
      on = !on;
      if (on) {
        ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume?.();
        tone(880, 0.08, 'triangle', 0.04);
        loop();
      } else {
        clearTimeout(timer);
        ctx?.suspend?.();
      }
      return on;
    },
    setTypingSource(fn) {
      typingFn = fn;
    },
    notify(kind) {
      if (!on) return;
      if (kind === 'fail') {
        tone(330, 0.12, 'triangle', 0.05);
        tone(247, 0.16, 'triangle', 0.05, 0.12);
      } else if (kind === 'done') {
        tone(660, 0.09, 'triangle', 0.045);
        tone(990, 0.12, 'triangle', 0.045, 0.09);
      } else tone(740, 0.09, 'sine', 0.04);
    },
    destroy() {
      on = false;
      clearTimeout(timer);
      ctx?.close?.();
      ctx = null;
    },
  };
}
