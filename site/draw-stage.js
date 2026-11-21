import { Reel, positionAt } from './reel.js';

export const DEFAULT_WHEEL_SECONDS = 6;
export const DEFAULT_WHEEL_NAMES_PER_SECOND = 12;
const wheelColors = ["#442639", "#28232e", "#654239", "#593046"];
const wheelSize = 896;
const number = new Intl.NumberFormat();
const wrap = (index, length) => ((index % length) + length) % length;

function part(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function wheelPool(receipt, index) {
  const redraw = receipt.wheelRedraw;
  if (redraw?.position === index + 1) {
    return { names: redraw.names, winnerIndex: redraw.winnerIndex };
  }
  if (receipt.wheel && receipt.wheel.names[receipt.wheel.winnerIndexes[index]] === receipt.winners[index]) {
    return { names: receipt.wheel.names, winnerIndex: receipt.wheel.winnerIndexes[index] };
  }
  const name = receipt.winners[index];
  const winnerIndex = receipt.names.indexOf(name);
  return winnerIndex < 0 ? { names: [...receipt.names, name], winnerIndex: receipt.names.length }
    : { names: receipt.names, winnerIndex };
}

class Wheel {
  constructor() {
    this.el = part('div', 'draw-wheel');
    this.el.hidden = true;
    this.frame = part('div', 'draw-wheel-frame');
    this.frame.setAttribute('role', 'img');
    this.disc = part('canvas', 'draw-wheel-disc');
    this.disc.width = this.disc.height = wheelSize;
    this.hub = part('span', 'draw-wheel-hub');
    this.count = part('span', 'draw-wheel-count');
    this.countLabel = part('span', 'draw-wheel-count-label');
    this.countLabel.textContent = 'entries';
    this.hub.append(this.count, this.countLabel);
    this.winner = part('p', 'draw-wheel-winner');
    this.winner.setAttribute('aria-hidden', 'true');
    this.frame.append(this.disc, this.hub, part('span', 'draw-wheel-pointer'));
    this.el.append(this.frame, this.winner);
  }

  setCaption(name, preview = false) {
    if (this.winner.textContent !== name) this.winner.textContent = name;
    if (this.winner.hidden !== !name) this.winner.hidden = !name;
    this.winner.toggleAttribute('data-preview', preview);
  }

  paint(names, designated = false) {
    if (this.names === names && this.designated === designated) return;
    this.names = names;
    this.designated = designated;
    const count = names.length;
    this.count.textContent = count ? number.format(count) : '';
    this.countLabel.hidden = !count;
    this.frame.setAttribute('aria-label', designated ? 'Presentation wheel for one preselected recipient' : count
      ? 'Draw wheel with ' + number.format(count) + (count === 1 ? ' entry' : ' entries') : 'Empty draw wheel');
    const ctx = this.disc.getContext('2d');
    if (!ctx) return;
    const radius = wheelSize / 2;
    const span = 2 * Math.PI / count;
    ctx.clearRect(0, 0, wheelSize, wheelSize);
    for (let index = 0; index < count; index++) {
      const angle = index * span - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(radius, radius);
      ctx.arc(radius, radius, radius, angle - span / 2, angle + span / 2);
      ctx.closePath();
      ctx.fillStyle = wheelColors[index % wheelColors.length];
      ctx.fill();
      if (!designated && count <= 72) {
        ctx.strokeStyle = '#c89e5f';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.save();
        ctx.translate(radius, radius);
        ctx.rotate(angle);
        ctx.font = '600 ' + Math.min(29, Math.max(10, 1460 / count)) + 'px sans-serif';
        ctx.fillStyle = '#fff1d4';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(names[index], radius * 0.58, 0, radius * 0.63);
        ctx.restore();
      }
    }
    if (designated) {
      ctx.beginPath();
      ctx.arc(radius, radius, radius * 0.92, -Math.PI * 0.59, -Math.PI * 0.41);
      ctx.strokeStyle = '#e0ba72';
      ctx.lineWidth = 8;
      ctx.stroke();
    }
  }

  idle(label) {
    if (this.names?.length || !this.names) this.paint([]);
    this.receipt = null;
    this.disc.style.transform = '';
    this.setCaption(label);
  }

  show(run, now, designated = false) {
    const { receipt, index, phase, start, spin, pausedAt, namesPerSecond } = run;
    if (phase === 'summary') {
      this.idle('Draw complete');
      return;
    }
    if (this.receipt !== receipt || this.index !== index) {
      this.receipt = receipt;
      this.index = index;
      this.pool = designated ? { names: [receipt.winners[index]], winnerIndex: 0 } : wheelPool(receipt, index);
      this.paint(this.pool.names, designated);
    }
    const { names, winnerIndex } = this.pool;
    const anglePerEntry = 360 / names.length;
    const landed = phase === 'hold' || phase === 'complete';
    const elapsed = (pausedAt ?? now) - start;
    // Give every pool a full turn and stop with the committed entry under the fixed pointer.
    const totalAngle = 720 + wrap(-winnerIndex * anglePerEntry, 360);
    const angle = landed || !spin ? totalAngle : positionAt(elapsed / spin, totalAngle);
    this.disc.style.transform = 'rotate(' + angle + 'deg)';
    if (landed) {
      this.setCaption(receipt.winners[index]);
    } else if (designated) {
      this.setCaption('');
    } else {
      const interval = 1000 / (namesPerSecond ?? DEFAULT_WHEEL_NAMES_PER_SECOND);
      const sample = Math.floor(Math.max(0, elapsed) / interval) * interval;
      const sampleAngle = spin ? positionAt(sample / spin, totalAngle) : totalAngle;
      const entry = wrap(Math.round(-sampleAngle / anglePerEntry), names.length);
      this.setCaption(names[entry], true);
    }
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
    const display = this.display(theme);
    display.el.removeAttribute('data-designated');
    display.el.removeAttribute('data-designated-spinning');
    display.idle(label);
  }

  show(run, now) {
    const display = this.display(run.drawTheme);
    const designated = run.phase !== 'summary' && run.receipt.designated?.includes(run.index + 1);
    display.el.toggleAttribute('data-designated', !!designated);
    const ticketSweep = designated && run.drawTheme !== 'wheel' && run.phase === 'spin';
    display.el.toggleAttribute('data-designated-spinning', !!ticketSweep);
    if (ticketSweep) {
      const progress = run.spin ? positionAt(((run.pausedAt ?? now) - run.start) / run.spin, 1) : 1;
      display.el.style.setProperty('--designated-glint', (progress * 140 - 20) + '%');
      display.idle('');
    } else {
      display.show(run, now, designated);
    }
  }
}
