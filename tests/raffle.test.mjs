import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './sheets-fixture.mjs';
import { Reel, positionAt, duration } from '../site/reel.js';

const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
const roster = count => [['Department', 'Full Name', 'Employee level'],
  ...Array.from({ length: count }, (_, i) => ['Team ' + (i % 8), 'Participant ' + (i + 1), i % 4])];

test('initialization is guarded, idempotent and safe on a nonblank default tab', () => {
  const dirty = fixture([['Existing value']]);
  assert.throws(() => dirty.initialize(), /blank spreadsheet/);
  assert.deepEqual(dirty.names(), ['Sheet1']);
  const app = fixture();
  app.verify();
  app.initialize();
  app.initialize();
  assert.equal(app.writes(), 1);
  assert.deepEqual(app.names(), ['ALL IMS', 'SETTINGS', 'PRIZES', 'DRAW_HISTORY', 'DRAW_WINNERS']);
  assert.deepEqual(app.hidden(), ['SETTINGS', 'PRIZES', 'DRAW_HISTORY', 'DRAW_WINNERS']);
  assert.deepEqual(app.data('ALL IMS'), [['Name', 'Participant ID']]);
  assert.equal(app.request('draw', {}, 'wrong').code, 'UNAUTHORIZED');
  assert.equal(app.writes(), 1);
});

test('1,050 records, configured name column, stable IDs, exact prize tabs and atomic winner transfers', () => {
  const app = fixture();
  app.initialize();
  app.loadRoster(roster(1050));
  assert.equal(ok(app.request('state')).invalid, 1050);
  ok(app.request('settings', { eventName: 'Corporate Evening', nameHeader: 'Full Name' }));
  assert.equal(ok(app.request('state')).eventName, 'Corporate Evening');
  assert.equal(ok(app.request('state')).eligible, 1050);
  const a = ok(app.request('prize', { name: 'SM Giftcard', limit: 11, perDraw: 10 })).id;
  const b = ok(app.request('prize', { name: "Operator's Award", limit: 20, perDraw: 20 })).id;
  assert.equal(app.request('prize', { name: 'sm giftcard', limit: 1, perDraw: 1 }).code, 'VALIDATION');
  assert.equal(app.request('prize', { name: 'DRAW_HISTORY', limit: 1, perDraw: 1 }).code, 'VALIDATION');
  const firstInput = { tx: randomUUID(), prizeId: a };
  const first = ok(app.request('draw', firstInput));
  assert.equal(first.names.length, 1050);
  assert.equal(new Set(first.winners).size, 10);
  assert.equal(app.data('SM Giftcard').length, 11);
  assert.equal(app.data('ALL IMS').length, 1041);
  const original = new Map(roster(1050).slice(1).map(row => [row[1], row]));
  for (const row of app.data('SM Giftcard').slice(1)) {
    assert.deepEqual(row.slice(0, 3), original.get(row[1]));
    assert.match(row[3], /^[a-f0-9-]{36}$/);
  }
  assert.throws(() => app.rejectStale(), /Stale write guard/);
  const remainingIds = new Map(app.data('ALL IMS').slice(1).map(row => [row[1], row[3]]));
  assert.equal(new Set(remainingIds.values()).size, 1040);
  assert.deepEqual(ok(app.request('draw', firstInput)).winners, first.winners);
  assert.equal(app.request('draw', { ...firstInput, prizeId: b }).code, 'CONFLICT');
  const second = ok(app.request('draw', { tx: randomUUID(), prizeId: b }));
  assert.equal(second.winners.length, 20);
  assert.equal(new Set([...first.winners, ...second.winners]).size, 30);
  assert.equal(app.data("Operator's Award").length, 21);
  assert.equal(app.data('ALL IMS').length, 1021);
  for (const row of app.data('ALL IMS').slice(1)) assert.equal(row[3], remainingIds.get(row[1]));
  const beforeRename = app.data('SM Giftcard');
  ok(app.request('prize', { id: a, name: 'SM Giftcard Final', limit: 11, perDraw: 4 }));
  assert.deepEqual(app.data('SM Giftcard Final'), beforeRename);
  assert.equal(app.names().includes('SM Giftcard'), false);
  assert.equal(ok(app.request('receipt', { tx: first.tx })).prizeName, 'SM Giftcard');
  assert.equal(ok(app.request('draw', { tx: randomUUID(), prizeId: a })).winners.length, 1);
  assert.equal(app.request('draw', { tx: randomUUID(), prizeId: a }).code, 'VALIDATION');
  const state = ok(app.request('state'));
  assert.deepEqual([state.total, state.eligible, state.won], [1050, 1019, 31]);
  assert.equal(app.data('DRAW_HISTORY').length, 4);
  assert.equal(app.data('DRAW_WINNERS').length, 32);
});

test('both sides of an uncertain commit recover with the same transaction ID', () => {
  const app = fixture();
  app.initialize();
  app.loadRoster([['Name', 'Participant ID', 'Team'], ['Same name', 123, true], ['Same name', 456, false]]);
  const prizeId = ok(app.request('prize', { name: 'Grand Prize', limit: 2, perDraw: 1 })).id;
  const first = { tx: randomUUID(), prizeId };
  app.fail('before');
  assert.equal(app.request('draw', first).code, 'BACKEND_ERROR');
  assert.equal(app.data('ALL IMS').length, 3);
  assert.equal(app.request('receipt', { tx: first.tx }).code, 'NOT_FOUND');
  const result = ok(app.request('draw', first));
  assert.equal(result.winners.length, 1);
  const second = { tx: randomUUID(), prizeId };
  app.fail('after');
  assert.equal(app.request('draw', second).code, 'BACKEND_ERROR');
  const retry = ok(app.request('draw', second));
  assert.deepEqual(retry.winners, ok(app.request('receipt', { tx: second.tx })).winners);
  assert.equal(app.data('DRAW_HISTORY').length, 3);
  assert.equal(app.data('ALL IMS').length, 1);
  const records = app.data('Grand Prize').slice(1).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(records, [['Same name', 123, true], ['Same name', 456, false]]);
  const winningIds = app.data('DRAW_WINNERS').slice(1).map(row => row[2]);
  assert.equal(new Set(winningIds).size, 2);
});

test('duplicate identifiers and re-imported winner records block unsafe draws', () => {
  const app = fixture();
  app.initialize();
  app.loadRoster([['Name', 'Participant ID'], ['One', 'X'], ['Two', 'X']]);
  assert.equal(app.request('state').code, 'INTEGRITY');
  app.loadRoster([['Name', 'Participant ID'], ['One', 'X']]);
  const prizeId = ok(app.request('prize', { name: 'One Prize', limit: 2, perDraw: 1 })).id;
  ok(app.request('draw', { tx: randomUUID(), prizeId }));
  app.loadRoster([['Name', 'Participant ID'], ['One', 'X'], ['Two', 'Y']]);
  assert.equal(ok(app.request('state')).excluded, 1);
  assert.equal(app.request('draw', { tx: randomUUID(), prizeId }).code, 'VALIDATION');
  const throughTx = ok(app.request('state')).lastDraw.tx;
  assert.equal(app.request('resetPrize', { prizeId, throughTx }).code, 'INTEGRITY');
  assert.deepEqual(app.data('One Prize').slice(1), [['One', 'X']]);
});

test('prize reset restores whole records and preserves other awards and transaction safety', () => {
  const app = fixture();
  app.initialize();
  const entrants = [['Name', 'Participant ID', 'Level'], ['Same name', '001', 0],
    ['Same name', '002', false], ['Three', '003', 3], ['Four', '004', 4], ['Five', '005', 5]];
  app.loadRoster(entrants);
  const prizeId = ok(app.request('prize', { name: 'Grand Prize', limit: 3, perDraw: 2 })).id;
  const otherId = ok(app.request('prize', { name: 'Other Prize', limit: 1, perDraw: 1 })).id;
  const first = { tx: randomUUID(), prizeId };
  const other = { tx: randomUUID(), prizeId: otherId };
  const last = { tx: randomUUID(), prizeId };
  for (const draw of [first, other, last]) ok(app.request('draw', draw));
  const reset = { prizeId, throughTx: last.tx };
  const otherRecords = app.data('Other Prize');
  const prizeRecords = app.data('Grand Prize');
  const rosterBeforeReset = app.data('ALL IMS');
  assert.equal(app.request('resetPrize', reset, 'wrong').code, 'UNAUTHORIZED');
  assert.equal(app.request('resetPrize', { ...reset, throughTx: first.tx }).code, 'CONFLICT');
  app.fail('before');
  assert.equal(app.request('resetPrize', reset).code, 'BACKEND_ERROR');
  assert.deepEqual(app.data('ALL IMS'), rosterBeforeReset);
  assert.deepEqual(app.data('Grand Prize'), prizeRecords);
  assert.equal(ok(app.request('state')).won, 4);
  app.fail('after');
  assert.equal(app.request('resetPrize', reset).code, 'BACKEND_ERROR');
  const writes = app.writes();
  assert.equal(ok(app.request('resetPrize', reset)).restored, 0);
  assert.equal(app.writes(), writes);
  assert.deepEqual(app.data('ALL IMS'), [...rosterBeforeReset, ...prizeRecords.slice(1)]);
  assert.deepEqual(app.data('Grand Prize'), [entrants[0]]);
  assert.deepEqual(app.data('Other Prize'), otherRecords);
  assert.equal(app.request('draw', first).code, 'CONFLICT');
  assert.equal(app.request('receipt', { tx: last.tx }).code, 'NOT_FOUND');
  const state = ok(app.request('state'));
  assert.deepEqual([state.eligible, state.won, state.lastDraw.tx], [4, 1, other.tx]);
  assert.deepEqual(state.history.map(winner => winner.prizeId), [otherId]);
  assert.equal(state.prizes.find(prize => prize.id === prizeId).remaining, 3);
  const fresh = { tx: randomUUID(), prizeId };
  ok(app.request('draw', fresh));
  assert.equal(ok(app.request('resetPrize', reset)).restored, 0);
  assert.equal(ok(app.request('receipt', { tx: fresh.tx })).count, 2);
});

test('the reel starts slowly, accelerates, slows again and settles exactly', () => {
  const steps = 52;
  const sequence = Array.from({ length: 11 }, (_, i) => positionAt(i / 10, steps));
  const velocities = sequence.slice(1).map((value, i) => value - sequence[i]);
  assert.equal(sequence[0], 0);
  assert.equal(sequence.at(-1), steps);
  assert.ok(velocities.every(value => value > 0));
  assert.ok(velocities[4] > velocities[1]);
  assert.ok(velocities[8] > velocities[9]);
  assert.equal(duration('standard', true), 0);
  assert.ok(duration('standard', false) > duration('fast', false));
});


test('the reel recycles seven rows and keeps the exact committed winner at center', t => {
  class Element {
    children = [];
    dataset = {};
    style = { setProperty() {} };
    classList = { toggle() {} };
    append(...children) { this.children.push(...children); }
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new Element() }
  });
  t.after(() => { delete globalThis.document; });
  const reel = new Reel(new Element());
  const receipt = {
    names: Array.from({ length: 1050 }, (_, i) => 'Eligible ' + i),
    winners: ['Committed first', 'Committed second']
  };
  const run = { receipt, speed: 'fast', index: 0, phase: 'spin', start: 1000, spin: 1650, pausedAt: null };
  reel.show(run, 1360);
  assert.equal(reel.rows.length, 7);
  assert.ok(reel.rows.every(row => row.textContent.startsWith('Eligible ')));
  reel.show({ ...run, phase: 'hold' }, 2650);
  assert.equal(reel.rows[3].textContent, 'Committed first');
  assert.equal(reel.rows[3].dataset.center, 'true');
  reel.show({ ...run, index: 1 }, 1000);
  assert.equal(reel.rows[3].textContent, 'Committed first');
  reel.show({ ...run, index: 1, phase: 'complete' }, 5000);
  assert.equal(reel.rows[3].textContent, 'Committed second');
  assert.equal(reel.el.dataset.phase, 'landed');
});
