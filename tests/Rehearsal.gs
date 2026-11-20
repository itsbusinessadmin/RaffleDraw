// Add this file only to the separate rehearsal Apps Script project.
function rehearsalDb_() {
  const configured = PropertiesService.getScriptProperties().getProperty('RAFFLE_SPREADSHEET_ID');
  if (!configured || configured === PRODUCTION_SHEET ||
      !meta_(configured).properties.title.startsWith('Raffle Rehearsal')) {
    fail_('REHEARSAL', 'Use an explicit, separate spreadsheet named Raffle Rehearsal.');
  }
  return database_(configured);
}

function seedRehearsal() {
  return locked_(() => {
    const db = rehearsalDb_();
    if (db.eligible.length || db.invalid || db.history.length || db.prizes.length) {
      fail_('REHEARSAL', 'Start with a fresh, initialized rehearsal workbook.');
    }
    const eventName = 'Raffle Rehearsal ' + Utilities.getUuid();
    const roster = db.tabs[ROSTER];
    const values = [['Employee code', 'Rehearsal name', ID_HEADER, 'Department', 'Active']];
    for (let i = 1; i <= 1050; i++) {
      values.push([i, 'Rehearsal participant ' + i, i > 525 ? 'test-' + i : '', 'Team ' + (i % 8), i % 2 === 0]);
    }
    const requests = [];
    resize_(requests, roster, values.length, values[0].length);
    requests.push(write_(roster.sheetId, 0, 0, values),
      write_(db.tabs.SETTINGS.sheetId, 1, 0, [['eventName', eventName], ['nameHeader', 'Rehearsal name']]));
    commit_(db, requests);
    console.info('RAFFLE_REHEARSAL_EVENT = ' + eventName);
  });
}

function verifyRehearsal() {
  return locked_(() => {
    const db = rehearsalDb_();
    const summary = state_(db);
    const fail = message => fail_('REHEARSAL', message);
    if (summary.total !== 1050 || summary.eligible !== 1024 || summary.won !== 26 ||
        db.history.length !== 4 || db.invalid || db.excluded) fail('Unexpected final counts.');
    const expected = { 'Rehearsal Giftcard Final': 10, 'Rehearsal Voucher': 10, 'Rehearsal Concurrent': 6 };
    if (db.tabs['Rehearsal Giftcard'] || db.prizes.length !== 3) fail('Unexpected prize tabs.');
    const stored = rows_(db.id, [ROSTER, ...Object.keys(expected)]);
    const seen = new Set();
    for (const [name, list] of Object.entries(stored)) {
      if (list.length !== (expected[name] ?? 1024) + 1) fail(name + ' has an unexpected row count.');
      for (const row of list.slice(1)) {
        const [i, participant, id, team, active] = row;
        if (!Number.isInteger(i) || i < 1 || i > 1050 || seen.has(i) || !id ||
            participant !== 'Rehearsal participant ' + i || team !== 'Team ' + (i % 8) || active !== (i % 2 === 0) ||
            (i > 525 && id !== 'test-' + i) || db.winnerIds.has(String(id)) !== (name !== ROSTER)) {
          fail(name + ' contains a missing, duplicate or changed record.');
        }
        seen.add(i);
      }
    }
    console.info('Passed: 1,050 source records accounted for, 26 transferred, 4 unique draw transactions.');
  });
}
