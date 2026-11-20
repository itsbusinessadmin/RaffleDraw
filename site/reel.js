export const HOLD = { standard: 1800, fast: 900 };
export const DEFAULT_REVEAL_SECONDS = 4.8;

export function duration(speed, reduced, seconds = DEFAULT_REVEAL_SECONDS) {
  if (reduced) return 0;
  if (speed === 'fast') return 1650;
  const standard = Number.isFinite(seconds) && seconds >= 1 && seconds <= 60 ? seconds : DEFAULT_REVEAL_SECONDS;
  return Math.round(standard * 1000);
}

// Normalized integral of a half-sine velocity profile: rest → peak → rest.
export function positionAt(progress, steps) {
  const t = Math.max(0, Math.min(1, progress));
  return steps * (1 - Math.cos(Math.PI * t)) / 2;
}

export class Reel {
  constructor(element) {
    this.el = element;
    this.placeholder = document.createElement('div');
    this.placeholder.className = 'reel-placeholder';
    this.track = document.createElement('div');
    this.track.className = 'reel-track';
    this.el.append(this.placeholder, this.track);
    this.rows = Array.from({ length: 7 }, (_, index) => {
      const row = document.createElement('div');
      row.className = 'reel-row';
      row.style.setProperty('--index', index - 3);
      this.track.append(row);
      return row;
    });
  }

  idle(label, phase = 'idle') {
    if (!this.track.hidden) this.track.hidden = true;
    if (this.placeholder.hidden) this.placeholder.hidden = false;
    if (this.placeholder.textContent !== label) this.placeholder.textContent = label;
    if (this.el.dataset.phase !== phase) this.el.dataset.phase = phase;
  }

  show(run, now) {
    const { receipt, index, phase, start, spin, pausedAt, speed } = run;
    if (phase === 'summary') {
      this.idle('Draw complete', 'summary');
      return;
    }
    const pool = receipt.names.length ? receipt.names : receipt.winners;
    const steps = speed === 'fast' ? 21 : 52;
    const atRest = phase === 'hold' || phase === 'complete';
    const travelled = atRest || spin === 0 ? steps : positionAt(((pausedAt ?? now) - start) / spin, steps);
    const base = Math.floor(travelled);
    const fraction = travelled - base;
    const landed = atRest || travelled === steps;
    if (this.track.hidden) this.track.hidden = false;
    if (!this.placeholder.hidden) this.placeholder.hidden = true;
    const reelPhase = landed ? 'landed' : 'spin';
    if (this.el.dataset.phase !== reelPhase) this.el.dataset.phase = reelPhase;
    const center = fraction < 0.5 ? 3 : 4;
    for (let i = 0; i < this.rows.length; i++) {
      const logical = index * steps + base + i - 3;
      const winner = logical > 0 && logical <= (index + 1) * steps && logical % steps === 0 ? receipt.winners[logical / steps - 1] : undefined;
      const name = winner || pool[((logical % pool.length) + pool.length) % pool.length];
      const row = this.rows[i];
      if (row.textContent !== name) {
        row.textContent = name;
        row.classList.toggle('long', name.length > 28);
      }
      const centered = String(i === center);
      if (row.dataset.center !== centered) row.dataset.center = centered;
    }
    this.track.style.transform = 'translate3d(0, calc(var(--row) * ' + -fraction + '), 0)';
  }
}
