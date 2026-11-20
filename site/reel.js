export const HOLD = { standard: 1800, fast: 900 };
export const duration = (speed, reduced) => reduced ? 0 : speed === 'fast' ? 1650 : 4800;

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

  idle(label) {
    this.track.hidden = true;
    this.placeholder.hidden = false;
    this.placeholder.textContent = label;
    this.el.dataset.phase = 'idle';
  }

  show(run, now) {
    const { receipt, index, phase, start, spin, pausedAt, speed } = run;
    if (phase === 'summary') {
      this.idle('Draw complete');
      return;
    }
    const pool = receipt.names.length ? receipt.names : receipt.winners;
    const steps = speed === 'fast' ? 21 : 52;
    const atRest = phase === 'hold' || phase === 'complete';
    const travelled = atRest || spin === 0 ? steps : positionAt(((pausedAt ?? now) - start) / spin, steps);
    const base = Math.floor(travelled);
    const fraction = travelled - base;
    const landed = atRest || travelled === steps;
    this.track.hidden = false;
    this.placeholder.hidden = true;
    this.el.dataset.phase = landed ? 'landed' : 'spin';
    for (let i = 0; i < this.rows.length; i++) {
      const logical = index * steps + base + i - 3;
      const winner = logical > 0 && logical <= (index + 1) * steps && logical % steps === 0 ? receipt.winners[logical / steps - 1] : undefined;
      const name = winner || pool[((logical % pool.length) + pool.length) % pool.length];
      const row = this.rows[i];
      if (row.textContent !== name) {
        row.textContent = name;
        row.classList.toggle('long', name.length > 28);
      }
      row.dataset.center = String(i === (fraction < 0.5 ? 3 : 4));
    }
    this.track.style.transform = 'translate3d(0, calc(var(--row) * ' + -fraction + '), 0)';
  }
}
