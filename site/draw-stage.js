import { Reel, positionAt } from './reel.js';

export const DEFAULT_WHEEL_SECONDS = 6;
export const DEFAULT_WHEEL_NAMES_PER_SECOND = 12;
const SECTORS = 12;
const sectorAngle = 360 / SECTORS;
const wrap = (index, length) => ((index % length) + length) % length;

function part(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

class Wheel {
  constructor() {
    this.el = part('div', 'draw-wheel');
    this.el.setAttribute('aria-hidden', 'true');
    this.el.hidden = true;
    const frame = part('div', 'draw-wheel-frame');
    this.disc = part('div', 'draw-wheel-disc');
    this.winner = part('p', 'draw-wheel-winner');
    this.labels = Array.from({ length: SECTORS }, (_, index) => {
      const sector = part('div', 'draw-wheel-sector');
      const label = part('span', 'draw-wheel-label');
      sector.style.transform = 'rotate(' + index * sectorAngle + 'deg)';
      sector.append(label);
      this.disc.append(sector);
      return label;
    });
    frame.append(this.disc, part('span', 'draw-wheel-hub'), part('span', 'draw-wheel-pointer'));
    this.el.append(frame, this.winner);
  }

  idle(label) {
    this.updateLabels(null);
    this.disc.style.transform = '';
    this.setWinner(label);
  }

  setWinner(name) {
    if (this.winner.textContent !== name) this.winner.textContent = name;
    this.winner.hidden = !name;
  }

  updateLabels(receipt, index = 0, step = 0, stop = 0, landed = false) {
    if (this.receipt === receipt && this.index === index && this.step === step &&
        this.stop === stop && this.landed === landed) return;
    this.receipt = receipt;
    this.index = index;
    this.step = step;
    this.stop = stop;
    this.landed = landed;
    const pool = receipt?.names.length ? receipt.names : receipt?.winners;
    this.labels.forEach((label, sector) => {
      // Reuse sectors as they pass the back of the wheel, away from the pointer.
      const offset = wrap(-step - sector + SECTORS / 2, SECTORS) - SECTORS / 2;
      const slot = step + offset;
      const selected = landed && offset === 0;
      const name = !pool ? '' : slot === stop
        ? receipt.winners[index] : pool[wrap(index * stop + slot, pool.length)];
      if (label.textContent !== name) label.textContent = name;
      label.toggleAttribute('data-picked', selected);
    });
  }

  show(run, now) {
    if (run.phase === 'summary') {
      this.idle('Draw complete');
      return;
    }
    const { receipt, index, phase, start, spin, pausedAt, namesPerSecond } = run;
    const steps = Math.max(1, Math.round(spin * (namesPerSecond ?? DEFAULT_WHEEL_NAMES_PER_SECOND) / 1000));
    const landed = phase === 'hold' || phase === 'complete';
    const travelled = landed || !spin ? steps : positionAt(((pausedAt ?? now) - start) / spin, steps);
    this.disc.style.transform = 'rotate(' + travelled * sectorAngle + 'deg)';
    this.updateLabels(receipt, index, Math.floor(travelled), steps, landed);
    this.setWinner(landed ? receipt.winners[index] : '');
  }
}

export class DrawStage {
  constructor(element) {
    this.reel = new Reel(element);
    this.wheel = new Wheel();
    element.after(this.wheel.el);
  }

  display(theme) {
    const wheel = theme === 'wheel';
    if (this.reel.el.hidden !== wheel) {
      this.wheel.el.hidden = !wheel;
      this.reel.el.hidden = wheel;
    }
    return wheel ? this.wheel : this.reel;
  }

  idle(label, theme) {
    this.display(theme).idle(label);
  }

  show(run, now) {
    this.display(run.drawTheme).show(run, now);
  }
}
