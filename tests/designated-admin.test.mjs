import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './sheets-fixture.mjs';

const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
const roster5 = () => [['Name', 'Participant ID'], ['Alice', '1'], ['Bob', '2'], ['Carol', '3'], ['Dave', '4'], ['Eve', '5']];

function setup() {
  const app = fixture();
  app.initialize();
  app.loadRoster(roster5());
  ok(app.request('settings', { eventName: 'Year End Party', nameHeader: 'Name' }));
  return app;
}

test('hidden admin assignments are verified, saved, listed, removed and edited', () => {
  const app = setup();
  const prizeId = ok(app.request('prize', { name: 'Mixed Prize', limit: 3, perDraw: 3 })).id;
  const entry = { prizeId, position: 2, name: 'Carol' };
  // Exact name only: wrong case does not verify.
  assert.equal(app.request('adminDesignatedAward', { ...entry, name: 'carol', verify: true }).code, 'VALIDATION');
  assert.equal(app.request('adminDesignatedAward', { ...entry, name: 'Nobody', verify: true }).code, 'VALIDATION');
  const writes = app.writes();
  assert.equal(ok(app.request('adminDesignatedAward', { ...entry, verify: true })).verified, true);
  assert.equal(app.writes(), writes, 'verify must not write');
  // Save, list, and check the roster ID was kept.
  ok(app.request('adminDesignatedAward', entry));
  const saved = ok(app.request('state')).designatedAwards[0];
  assert.equal(saved.name, 'Carol');
  assert.equal(saved.participantId, '3');
  assert.equal(saved.position, 2);
  // Same slot, different person: must remove first.
  assert.equal(app.request('adminDesignatedAward', { ...entry, name: 'Dave' }).code, 'VALIDATION');
  // Same person, different slot/prize: duplicate assignment.
  assert.equal(app.request('adminDesignatedAward', { ...entry, position: 1 }).code, 'VALIDATION');
  // Position outside the open slots.
  assert.equal(app.request('adminDesignatedAward', { ...entry, position: 0 }).code, 'VALIDATION');
  assert.equal(app.request('adminDesignatedAward', { ...entry, position: 4 }).code, 'VALIDATION');
  // Remove, then the slot is free again.
  assert.equal(ok(app.request('adminDesignatedAward', { ...entry, remove: true, participantId: '3' })).removed, true);
  assert.deepEqual(ok(app.request('state')).designatedAwards, []);
  ok(app.request('adminDesignatedAward', { ...entry, name: 'Dave' }));
  assert.equal(ok(app.request('state')).designatedAwards[0].name, 'Dave');
  // Stale remove (wrong participant id) is a conflict.
  assert.equal(app.request('adminDesignatedAward', { ...entry, remove: true, participantId: '999' }).code, 'CONFLICT');
});

test('designated recipients are reserved and land at the assigned slot in reel and wheel', () => {
  for (const drawTheme of ['reel', 'wheel']) {
    const app = setup();
    const prizeId = ok(app.request('prize', { name: 'Mixed Prize', limit: 3, perDraw: 3 })).id;
    const otherId = ok(app.request('prize', { name: 'Random Prize', limit: 1, perDraw: 1 })).id;
    ok(app.request('adminDesignatedAward', { prizeId, position: 2, name: 'Carol' }));
    // Carol must not win the other prize, but her name still appears in its
    // names, so there is no visible clue that she is reserved.
    const other = ok(app.request('draw', { tx: randomUUID(), prizeId: otherId }));
    assert.equal(other.winners.includes('Carol'), false);
    assert.equal(other.names.includes('Carol'), true);
    assert.equal(other.names.length, 5);
    // The designated draw: Carol is always winner 2, in both themes.
    for (let i = 0; i < 5; i++) {
      const trial = setup();
      const pid = ok(trial.request('prize', { name: 'Mixed Prize', limit: 3, perDraw: 3 })).id;
      ok(trial.request('adminDesignatedAward', { prizeId: pid, position: 2, name: 'Carol' }));
      const draw = ok(trial.request('draw', { tx: randomUUID(), prizeId: pid, drawTheme }));
      assert.deepEqual(draw.designated, [2]);
      assert.equal(draw.winners[1], 'Carol');
      assert.equal(new Set(draw.winners).size, 3);
      assert.equal(draw.names.includes('Carol'), true);
      if (drawTheme === 'wheel') assert.equal(draw.wheel.names[draw.wheel.winnerIndexes[1]], 'Carol');
    }
    // Re-draw of the designated slot is blocked; the receipt records it.
    const draw = ok(app.request('draw', { tx: randomUUID(), prizeId, drawTheme }));
    assert.deepEqual(draw.designated, [2]);
    assert.equal(draw.winners[1], 'Carol');
    const redraw = app.request('redraw', { tx: randomUUID(), drawTx: draw.tx, position: 2, prizeId });
    assert.equal(redraw.code, 'VALIDATION');
    assert.equal(/designated/i.test(redraw.message), false, 're-draw error must not name the reason');
    assert.deepEqual(ok(app.request('receipt', { tx: draw.tx })).designated, [2]);
    assert.equal('designated' in ok(app.request('state')).history.find(w => w.id === '3'), false);
  }
});

test('designated awards adjust the draw count and cannot target a winner who already won', () => {
  const app = setup();
  const prizeId = ok(app.request('prize', { name: 'Mixed Prize', limit: 3, perDraw: 3 })).id;
  const stateBefore = ok(app.request('state'));
  // drawCount is always present, so its presence is not a clue.
  assert.equal(stateBefore.prizes.find(p => p.id === prizeId).drawCount, 3);
  ok(app.request('adminDesignatedAward', { prizeId, position: 2, name: 'Carol' }));
  const stateAfter = ok(app.request('state'));
  // One eligible person is reserved, but the plan still draws 3 (2 random + 1 designated),
  // and the prize's eligible count shown in the dashboard does not change.
  assert.equal(stateAfter.prizes.find(p => p.id === prizeId).drawCount, 3);
  assert.equal(stateAfter.prizes.find(p => p.id === prizeId).eligible, 5);
  // Draw a different prize first (random), then try to designate its winner.
  const otherId = ok(app.request('prize', { name: 'Other Prize', limit: 1, perDraw: 1 })).id;
  const other = ok(app.request('draw', { tx: randomUUID(), prizeId: otherId }));
  const winner = other.winners[0];
  assert.notEqual(winner, 'Carol');
  assert.equal(app.request('adminDesignatedAward', { prizeId, position: 1, name: winner }).code, 'VALIDATION');
  // Duplicate names: exactly one eligible match is required.
  const dup = fixture();
  dup.initialize();
  dup.loadRoster([['Name', 'Participant ID'], ['Sam', '1'], ['Sam', '2'], ['Alex', '3']]);
  ok(dup.request('settings', { eventName: 'Party', nameHeader: 'Name' }));
  const dupPrize = ok(dup.request('prize', { name: 'Dup Prize', limit: 1, perDraw: 1 })).id;
  assert.equal(dup.request('adminDesignatedAward', { prizeId: dupPrize, position: 1, name: 'Sam' }).code, 'VALIDATION');
  assert.equal(ok(dup.request('adminDesignatedAward', { prizeId: dupPrize, position: 1, name: 'Alex' })).saved, true);
});

test('a fully designated draw still shows the full name pool', () => {
  const app = setup();
  const prizeId = ok(app.request('prize', { name: 'Single Prize', limit: 1, perDraw: 1 })).id;
  ok(app.request('adminDesignatedAward', { prizeId, position: 1, name: 'Carol' }));
  const draw = ok(app.request('draw', { tx: randomUUID(), prizeId, drawTheme: 'wheel' }));
  assert.deepEqual(draw.winners, ['Carol']);
  // The wheel / reel pool is the full eligible list, not just the winner.
  assert.equal(draw.names.length, 5);
  assert.equal(draw.wheel.names.length, 5);
  assert.equal(draw.wheel.names[draw.wheel.winnerIndexes[0]], 'Carol');
});
