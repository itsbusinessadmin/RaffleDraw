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

test('prize reset identifies unmatched IDs and restores winners across blank rows', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID'];
  app.loadRoster([header, ['Same name', '001'], ['Same name', '002']]);
  const name = 'Grand Prize';
  const prizeId = ok(app.request('prize', { name, limit: 2, perDraw: 2 })).id;
  const throughTx = randomUUID();
  ok(app.request('draw', { tx: throughTx, prizeId }));
  const [, first, second] = app.data(name);
  const reset = { prizeId, throughTx };
  const writes = app.writes();
  for (const id of ['', 'Unexpected', first[1]]) {
    app.loadRows(name, [header, first, [], [second[0], id]]);
    const reply = app.request('resetPrize', reset);
    assert.equal(reply.code, 'INTEGRITY');
    assert.match(reply.message, /prize worksheet rows 4\./);
    assert.equal(app.writes(), writes);
  }
  app.loadRows(name, [header, first]);
  assert.match(app.request('resetPrize', reset).message, /1 row with data\. DRAW_WINNERS lists 2 winners/);
  app.loadRows(name, [header, first, [], second]);
  assert.equal(ok(app.request('resetPrize', reset)).restored, 2);
  assert.deepEqual(app.data('ALL IMS'), [header, first, second]);
  assert.deepEqual(app.data(name), [header]);
});

test('prize reset recovers an empty two-column prize tab from the winner ledger', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID'];
  const entrants = [['Same name', '0001'], ['Same name', '0002'], ['Three', '0003'],
    ['Four', '0004'], ['Five', '0005'], ['Six', '0006']];
  app.loadRoster([header, ...entrants]);
  const otherId = ok(app.request('prize', { name: 'Other Prize', limit: 1, perDraw: 1 })).id;
  ok(app.request('draw', { tx: randomUUID(), prizeId: otherId }));
  const name = 'Wireless Vacuum';
  const prizeId = ok(app.request('prize', { name, limit: 4, perDraw: 4 })).id;
  const throughTx = randomUUID();
  ok(app.request('draw', { tx: throughTx, prizeId }));
  const expected = [...app.data('ALL IMS'), ...app.data(name).slice(1)];
  const otherRows = app.data('Other Prize');
  app.loadRows(name, [header]);

  const reset = { prizeId, throughTx };
  assert.equal(ok(app.request('resetPrize', reset)).restored, 4);
  assert.deepEqual(app.data('ALL IMS'), expected);
  assert.deepEqual(app.data('Other Prize'), otherRows);
  assert.deepEqual(app.data(name), [header]);
  const state = ok(app.request('state'));
  assert.deepEqual([state.eligible, state.won], [5, 1]);
  assert.equal(state.prizes.find(prize => prize.id === prizeId).remaining, 4);
  assert.equal(app.request('draw', { tx: throughTx, prizeId }).code, 'CONFLICT');
  assert.equal(ok(app.request('resetPrize', reset)).restored, 0);
});

test('prize reset requires a backup for an empty tab whose roster has additional fields', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID', 'Team'];
  app.loadRoster([header, ['One', '001', 'Red']]);
  const name = 'Grand Prize';
  const prizeId = ok(app.request('prize', { name, limit: 1, perDraw: 1 })).id;
  const throughTx = randomUUID();
  ok(app.request('draw', { tx: throughTx, prizeId }));
  app.loadRows(name, [header]);
  const writes = app.writes();
  assert.equal(app.request('resetPrize', { prizeId, throughTx }).code, 'INTEGRITY');
  assert.equal(app.writes(), writes);
  assert.deepEqual(app.data('ALL IMS'), [header]);
  assert.equal(ok(app.request('state')).won, 1);
});

test('archiving a prize preserves its records and blocks new draws until restored', () => {
  const app = fixture();
  app.initialize();
  app.loadRoster([['Name', 'Participant ID'], ['One', '001'], ['Two', '002']]);
  const name = 'Grand Prize';
  const prizeId = ok(app.request('prize', { name, limit: 2, perDraw: 1 })).id;
  const first = { prizeId, tx: randomUUID() };
  const receipt = ok(app.request('draw', first));
  const rosterBefore = app.data('ALL IMS');
  const prizeBefore = app.data(name);
  const historyBefore = ok(app.request('state')).history;
  const archive = { prizeId, archived: true };
  assert.equal(app.request('archivePrize', archive, 'wrong').code, 'UNAUTHORIZED');
  assert.equal(app.request('archivePrize', { ...archive, archived: 'true' }).code, 'VALIDATION');

  app.fail('after');
  assert.equal(app.request('archivePrize', archive).code, 'BACKEND_ERROR');
  const writes = app.writes();
  assert.equal(ok(app.request('archivePrize', archive)).archived, true);
  assert.equal(app.writes(), writes);
  const state = ok(app.request('state'));
  assert.equal(state.prizes[0].archived, true);
  assert.deepEqual(state.history, historyBefore);
  assert.deepEqual(app.data('ALL IMS'), rosterBefore);
  assert.deepEqual(app.data(name), prizeBefore);
  assert.deepEqual(ok(app.request('draw', first)).winners, receipt.winners);
  const second = { prizeId, tx: randomUUID() };
  assert.equal(app.request('draw', second).code, 'VALIDATION');
  assert.equal(app.request('resetPrize', { prizeId, throughTx: first.tx }).code, 'VALIDATION');

  assert.equal(ok(app.request('archivePrize', { prizeId, archived: false })).archived, false);
  assert.equal(ok(app.request('state')).prizes[0].archived, false);
  assert.equal(ok(app.request('draw', second)).count, 1);
});

test('deleting a prize atomically restores its winners and rejects stale confirmations', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID', 'Team'];
  app.loadRoster([header, ['One', '001', 'Blue'], ['Two', '002', 'Red']]);
  const name = 'Grand Prize';
  const prizeId = ok(app.request('prize', { name, limit: 1, perDraw: 1 })).id;
  const emptyId = ok(app.request('prize', { name: 'Empty Prize', limit: 1, perDraw: 1 })).id;
  const throughTx = randomUUID();
  ok(app.request('draw', { tx: throughTx, prizeId }));
  const roster = app.data('ALL IMS');
  const prize = app.data(name);
  const deletion = { prizeId, throughTx };
  assert.equal(app.request('deletePrize', { ...deletion, throughTx: '' }).code, 'CONFLICT');
  app.fail('before');
  assert.equal(app.request('deletePrize', deletion).code, 'BACKEND_ERROR');
  assert.deepEqual(app.data('ALL IMS'), roster);
  assert.deepEqual(app.data(name), prize);
  app.fail('after');
  assert.equal(app.request('deletePrize', deletion).code, 'BACKEND_ERROR');
  assert.equal(ok(app.request('deletePrize', deletion)).deleted, true);
  assert.deepEqual(app.data('ALL IMS'), [...roster, ...prize.slice(1)]);
  assert.equal(app.names().includes(name), false);
  assert.equal(ok(app.request('state')).won, 0);
  assert.equal(app.request('draw', { tx: throughTx, prizeId }).code, 'CONFLICT');
  assert.equal(ok(app.request('deletePrize', { prizeId: emptyId, throughTx: '' })).deleted, true);
  assert.equal(ok(app.request('state')).prizes.length, 0);
});

test('event settings persist spin duration, name scroll speed, and winner display time independently', () => {
  const app = fixture();
  app.initialize();
  const settings = { eventName: 'Year End Party', nameHeader: 'Name' };
  assert.equal(ok(app.request('state')).revealSeconds, 4.8);
  assert.equal(ok(app.request('state')).namesPerSecond, 11);
  assert.equal(ok(app.request('state')).winnerSeconds, 1.8);
  for (const revealSeconds of [0, 60.1, 4.85, '8', null]) {
    assert.equal(app.request('settings', { ...settings, revealSeconds }).code, 'VALIDATION');
  }
  assert.equal(app.request('settings', { ...settings, revealSeconds: 20, namesPerSecond: 31 }).code, 'VALIDATION');
  assert.equal(app.request('settings', { ...settings, winnerSeconds: 4.85 }).code, 'VALIDATION');
  assert.equal(ok(app.request('state')).eventName, 'Raffle Draw');
  ok(app.request('settings', { ...settings, revealSeconds: 8.5, namesPerSecond: 7, winnerSeconds: 5.5 }));
  ok(app.request('settings', settings));
  assert.equal(ok(app.request('state')).revealSeconds, 8.5);
  ok(app.request('settings', { ...settings, revealSeconds: 60 }));
  assert.equal(ok(app.request('state')).revealSeconds, 60);
  assert.equal(ok(app.request('state')).namesPerSecond, 7);
  assert.equal(ok(app.request('state')).winnerSeconds, 5.5);
  assert.equal(duration('standard', false, 8.5), 8500);
  assert.equal(duration('fast', false, 60), 1650);
  assert.equal(duration('standard', true, 60), 0);
});

test('projector sync shares selections and committed draw progress across operators', () => {
  const app = fixture();
  app.initialize();
  app.loadRoster([['Name', 'Participant ID'], ['First', '001'], ['Second', '002']]);
  const prizeId = ok(app.request('prize', { name: 'Phone Prize', limit: 2, perDraw: 1 })).id;
  const screen = { origin: randomUUID(), eventName: 'Raffle Draw', prizeId, prizeName: 'Phone Prize', advance: 'manual' };
  assert.equal(ok(app.request('state')).presentationSync, true);
  assert.equal(ok(app.request('presentation')).snapshot, null);
  assert.equal(app.request('presentation', {}, 'wrong').code, 'UNAUTHORIZED');
  assert.equal(app.request('publishPresentation', { ...screen, kind: 'selection' }, 'wrong').code, 'UNAUTHORIZED');
  const sheetsWrites = app.writes();
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'selection' })).published, true);
  const { snapshot } = ok(app.request('presentation'));
  assert.equal(snapshot.prizeName, 'Phone Prize');
  assert.equal(snapshot.run, null);
  assert.equal(app.writes(), sheetsWrites);

  const tx = randomUUID();
  const run = { tx, phase: 'spin', index: 0, revealed: 0, elapsed: 0, speed: 'standard', spin: 60000, namesPerSecond: 7, paused: false };
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'begin', run })).published, false);
  const receipt = ok(app.request('draw', { tx, prizeId }));
  assert.equal(app.request('publishPresentation', { ...screen, kind: 'begin', run: { ...run, spin: 60001 } }).code, 'VALIDATION');
  assert.equal(app.request('publishPresentation', { ...screen, kind: 'begin', run: { ...run, namesPerSecond: 0 } }).code, 'VALIDATION');
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'begin', run })).published, true);
  const hold = { ...run, phase: 'hold', revealed: 1 };
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'continue', run: hold })).published, true);
  const current = ok(app.request('presentation')).snapshot;
  assert.equal(current.run.phase, 'hold');
  assert.equal(current.run.tx, tx);
  assert.equal(current.run.spin, 60000);
  assert.equal(current.run.namesPerSecond, 7);
  assert.equal(current.run.winners, undefined);
  assert.deepEqual(ok(app.request('receipt', { tx })).winners, receipt.winners);

  const other = { ...screen, origin: randomUUID(), kind: 'selection' };
  ok(app.request('publishPresentation', other));
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'continue', run: hold })).published, false);
  assert.equal(ok(app.request('presentation')).snapshot.origin, other.origin);
  const second = randomUUID();
  ok(app.request('draw', { tx: second, prizeId }));
  assert.equal(ok(app.request('publishPresentation', { ...screen, kind: 'begin', run })).published, false);
  ok(app.request('publishPresentation', { ...other, kind: 'begin', run: { ...run, tx: second } }));
  ok(app.request('resetPrize', { prizeId, throughTx: second }));
  assert.equal(ok(app.request('presentation')).snapshot, null);
});

test('All participants includes earlier winners once per prize and preserves overlapping awards', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID', 'Team'];
  const people = [['Same name', '001', 'Blue'], ['Same name', '002', 'Red']];
  app.loadRoster([header, ...people]);
  const regular = ok(app.request('prize', { name: 'Regular', limit: 2, perDraw: 2 })).id;
  const special = { name: 'Special', limit: 3, perDraw: 1 };
  special.id = ok(app.request('prize', special)).id;
  const regularTx = randomUUID();
  ok(app.request('draw', { prizeId: regular, tx: regularTx }));
  assert.deepEqual(app.data('ALL IMS'), [header]);
  assert.equal(app.request('draw', { prizeId: special.id, tx: randomUUID() }).code, 'VALIDATION');
  assert.equal(app.request('prize', { ...special, allParticipants: 'true' }).code, 'VALIDATION');
  ok(app.request('prize', { ...special, allParticipants: true }));
  ok(app.request('prize', special));
  assert.equal(ok(app.request('state')).prizes.find(prize => prize.id === special.id).eligible, 2);
  const first = { prizeId: special.id, tx: randomUUID() };
  const second = { prizeId: special.id, tx: randomUUID() };
  ok(app.request('draw', first));
  const result = ok(app.request('draw', second));
  assert.equal(result.names.length, 1);
  assert.equal(app.request('draw', { prizeId: special.id, tx: randomUUID() }).code, 'VALIDATION');
  assert.deepEqual(app.data('Special').slice(1).sort((a, b) => a[1].localeCompare(b[1])), people);
  assert.equal(app.data('Regular').length, 3);
  const state = ok(app.request('state'));
  assert.deepEqual([state.total, state.eligible, state.won, state.history.length], [2, 0, 2, 4]);

  assert.equal(ok(app.request('resetPrize', { prizeId: regular, throughTx: regularTx })).restored, 0);
  assert.deepEqual(app.data('ALL IMS'), [header]);
  ok(app.request('deletePrize', { prizeId: special.id, throughTx: second.tx }));
  assert.deepEqual(app.data('ALL IMS').slice(1).sort((a, b) => a[1].localeCompare(b[1])), people);
  assert.equal(ok(app.request('state')).eligible, 2);
});

test('All participants can recover earlier winners from the two-column ledger', () => {
  const app = fixture();
  app.initialize();
  const header = ['Name', 'Participant ID'];
  app.loadRoster([header, ['Employee', '001']]);
  const prior = ok(app.request('prize', { name: 'Earlier Prize', limit: 1, perDraw: 1 })).id;
  ok(app.request('draw', { prizeId: prior, tx: randomUUID() }));
  app.loadRows('Earlier Prize', [header]);
  ok(app.request('archivePrize', { prizeId: prior, archived: true }));
  const prize = { name: 'Special Prize', limit: 1, perDraw: 1, allParticipants: true };
  prize.id = ok(app.request('prize', prize)).id;
  ok(app.request('prize', { ...prize, allParticipants: false }));
  assert.equal(app.request('draw', { prizeId: prize.id, tx: randomUUID() }).code, 'VALIDATION');
  ok(app.request('prize', prize));
  ok(app.request('draw', { prizeId: prize.id, tx: randomUUID() }));
  assert.deepEqual(app.data('Special Prize'), [header, ['Employee', '001']]);
  assert.deepEqual(app.data('ALL IMS'), [header]);
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

  const custom = { ...run, speed: 'standard', spin: 20000, namesPerSecond: 4 };
  reel.show(custom, 11000);
  assert.equal(reel.rows.find(row => row.dataset.center === 'true').textContent, 'Eligible 40');
  reel.show({ ...custom, namesPerSecond: 8 }, 11000);
  assert.equal(reel.rows.find(row => row.dataset.center === 'true').textContent, 'Eligible 80');
  reel.show({ ...custom, phase: 'hold' }, 21000);
  assert.equal(reel.rows[3].textContent, 'Committed first');
});
