// Short two-tone "attention please" beep, used when a device parks
// waiting for operator input. Pure Web Audio — no asset shipped, and
// no playback unless the browser's autoplay policy allows it (which it
// does once the user has interacted with the page, which is always
// true by the time we'd hit this code path).

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx && ctx.state !== "closed") return ctx;
  try {
    const Ctor: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function beep(c: AudioContext, freq: number, startAt: number, durationMs: number, gain = 0.18) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Quick attack + release so the tone doesn't click.
  g.gain.setValueAtTime(0, startAt);
  g.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  g.gain.linearRampToValueAtTime(gain, startAt + durationMs / 1000 - 0.03);
  g.gain.linearRampToValueAtTime(0, startAt + durationMs / 1000);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durationMs / 1000 + 0.05);
}

// Throttle so we don't spam if the polling sees the same parked count
// flicker. Min 2s between sounds.
let lastPlayed = 0;

export function playAttentionSound(): void {
  const now = Date.now();
  if (now - lastPlayed < 2000) return;
  const c = getCtx();
  if (!c) return;
  // Some browsers leave the context "suspended" until a user gesture.
  // Try to resume; if it fails we just silently drop the cue.
  if (c.state === "suspended") {
    void c.resume().catch(() => {});
  }
  try {
    const t = c.currentTime + 0.01;
    beep(c, 880, t, 180);             // ~A5
    beep(c, 1175, t + 0.22, 240);     // ~D6 — rising interval = "attention"
    lastPlayed = now;
  } catch {
    // ignore
  }
}
