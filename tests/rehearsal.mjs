import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { RAFFLE_API_URL: endpoint, RAFFLE_ADMIN_TOKEN: token, RAFFLE_REHEARSAL_EVENT: event,
  RAFFLE_PAGES_URL: page } = process.env;
if (!endpoint || !token || !/^Raffle Rehearsal [a-f0-9-]{36}$/.test(event || '')) {
  throw new Error('Set RAFFLE_API_URL, RAFFLE_ADMIN_TOKEN and the exact RAFFLE_REHEARSAL_EVENT printed by seedRehearsal.');
}
const target = new URL(endpoint);
assert.equal(target.protocol, 'https:');
assert.ok(target.hostname === 'script.google.com' || target.hostname.endsWith('.workers.dev'));
const origin = page ? new URL(page).origin : 'https://itsbusinessadmin.github.io';

async function call(action, fields = {}, key = token, signal = AbortSignal.timeout(45000)) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin },
    body: JSON.stringify({ ...fields, action, token: key }),
    signal
  });
  assert.equal(response.ok, true, 'API HTTP ' + response.status);
  return response.json();
}

function result(reply) {
  assert.equal(reply.ok, true, reply.code + ': ' + reply.message);
  return reply.result;
}

if (page) {
  const response = await fetch(page);
  assert.equal(response.ok, true, 'GitHub Pages HTTP ' + response.status);
  const html = await response.text();
  assert.match(html, /id="draw"/);
  for (const asset of ['style.css', 'app.js', 'reel.js', 'config.js', 'fonts/inter-latin.woff2']) {
    assert.equal((await fetch(new URL(asset, page))).ok, true, 'Missing published asset ' + asset);
  }
}

const initial = result(await call('state'));
assert.equal(initial.eventName, event, 'Rehearsal challenge mismatch. No writes attempted.');
assert.deepEqual([initial.total, initial.eligible, initial.won, initial.prizes.length], [1050, 1050, 0, 0]);
assert.equal((await call('prize', { name: 'Unauthorized attempt', limit: 1, perDraw: 1 }, 'x')).code, 'UNAUTHORIZED');
assert.equal((await call('draw', { tx: randomUUID(), prizeId: 'unauthorized' }, 'x')).code, 'UNAUTHORIZED');

const a = result(await call('prize', { name: 'Rehearsal Giftcard', limit: 10, perDraw: 10 })).id;
const b = result(await call('prize', { name: 'Rehearsal Voucher', limit: 10, perDraw: 10 })).id;
const c = result(await call('prize', { name: 'Rehearsal Concurrent', limit: 6, perDraw: 3 })).id;
const request = { tx: randomUUID(), prizeId: a };
const first = result(await call('draw', request));
assert.equal(first.winners.length, 10);
assert.equal(first.names.length, 1050);
assert.deepEqual(result(await call('draw', request)).winners, first.winners);
assert.equal(result(await call('state')).eligible, 1040);
result(await call('prize', { id: a, name: 'Rehearsal Giftcard Final', limit: 10, perDraw: 10 }));
assert.equal(result(await call('receipt', { tx: first.tx })).prizeName, 'Rehearsal Giftcard');

const interrupted = { tx: randomUUID(), prizeId: b };
try {
  await call('draw', interrupted, token, AbortSignal.timeout(250));
} catch (error) {
  if (!['TimeoutError', 'AbortError'].includes(error.name)) throw error;
}
const second = result(await call('draw', interrupted));
assert.equal(second.winners.length, 10);
assert.deepEqual(result(await call('draw', interrupted)).winners, second.winners);
const [third, fourth] = (await Promise.all([
  call('draw', { tx: randomUUID(), prizeId: c }), call('draw', { tx: randomUUID(), prizeId: c })
])).map(result);
assert.equal(third.winners.length, 3);
assert.equal(fourth.winners.length, 3);
assert.equal(new Set([first, second, third, fourth].flatMap(draw => draw.winners)).size, 26);
const final = result(await call('state'));
assert.deepEqual([final.total, final.eligible, final.won], [1050, 1024, 26]);
assert.ok(final.prizes.every(prize => prize.remaining === 0));
assert.equal(new Set(final.history.map(winner => winner.id)).size, 26);
console.log('Live API checks passed. Run verifyRehearsal in the rehearsal Apps Script editor to verify physical worksheet data.');
