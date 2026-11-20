const PRODUCTION_SHEET = '10pY8HUtzIEznO9bbK_A5Ub5uQLfiELMsHqfuU1l6arY';
const ROSTER = 'ALL IMS';
const ID_HEADER = 'Participant ID';
const GUARD = 'RAFFLE_WRITE_VERSION';
const ARCHIVED_PRIZE = 'archivedPrize:';
const SYSTEM = {
  SETTINGS: ['key', 'value'],
  PRIZES: ['prizeId', 'sheetId', 'name', 'limit', 'perDraw', 'createdAt'],
  DRAW_HISTORY: ['transactionId', 'prizeId', 'prizeName', 'eventName', 'committedAt', 'count'],
  DRAW_WINNERS: ['transactionId', 'prizeId', 'participantId', 'name', 'position']
};
const TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function settings_() {
  const p = PropertiesService.getScriptProperties();
  const admin = p.getProperty('RAFFLE_ADMIN_TOKEN');
  const random = p.getProperty('RAFFLE_RANDOM_KEY');
  if (!TOKEN.test(admin || '') || !TOKEN.test(random || '') || admin === random) {
    fail_('SETUP', 'Configure two distinct 64-character hexadecimal keys in Apps Script.');
  }
  return { id: p.getProperty('RAFFLE_SPREADSHEET_ID') || PRODUCTION_SHEET, admin, random };
}

// Run both editor functions as the account that will deploy the web app.
function verifySpreadsheetAccess() {
  const cfg = settings_();
  const book = meta_(cfg.id);
  console.info('Readable spreadsheet: ' + book.properties.title + ' (' + cfg.id + ')');
}

function initializeRaffle() {
  const cfg = settings_();
  return locked_(() => initialize_(cfg.id));
}

function doGet() {
  return json_({ ok: true, service: 'raffle-draw', version: 1 });
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents;
    if (!body || body.length > 4096) fail_('BAD_REQUEST', 'Invalid request body.');
    let input;
    try { input = JSON.parse(body); } catch (_) { fail_('BAD_REQUEST', 'Invalid JSON.'); }
    if (!input || typeof input !== 'object') fail_('BAD_REQUEST', 'Invalid request.');
    const cfg = settings_();
    if (!equalToken_(input.token, cfg.admin)) fail_('UNAUTHORIZED', 'The administrator key is incorrect.');
    const result = locked_(() => dispatch_(cfg, input));
    return json_({ ok: true, result });
  } catch (error) {
    if (!error.code) console.error(error.stack || String(error));
    return json_({ ok: false, code: error.code || 'BACKEND_ERROR',
      message: error.code ? error.message : 'Google Sheets could not complete the request. Check the sync status and retry.' });
  }
}

function equalToken_(value, expected) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function locked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('BUSY', 'The spreadsheet is busy. Retry this request.');
  try { return action(); } finally { lock.releaseLock(); }
}

function meta_(id) {
  return Sheets.Spreadsheets.get(id, {
    fields: 'properties(title),sheets(properties(sheetId,title,index,sheetType,hidden,gridProperties),merges),namedRanges(namedRangeId,name,range)'
  });
}

function range_(title) {
  return "'" + title.replace(/'/g, "''") + "'";
}

function rows_(id, titles, rendering = 'UNFORMATTED_VALUE') {
  const reply = Sheets.Spreadsheets.Values.batchGet(id, {
    ranges: titles.map(range_), valueRenderOption: rendering, dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  return Object.fromEntries(titles.map((title, i) => [title, reply.valueRanges[i].values || []]));
}

function batch_(id, requests) {
  Sheets.Spreadsheets.batchUpdate({ requests }, id);
}

function cell_(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

function write_(sheetId, rowIndex, columnIndex, values) {
  return { updateCells: {
    start: { sheetId, rowIndex, columnIndex },
    rows: values.map(row => ({ values: row.map(cell_) })),
    fields: 'userEnteredValue'
  } };
}

function header_(sheetId, width) {
  return { repeatCell: {
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
    cell: { userEnteredFormat: {
      backgroundColor: { red: 0.09, green: 0.13, blue: 0.12 },
      textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
    } },
    fields: 'userEnteredFormat(backgroundColor,textFormat)'
  } };
}

function resize_(requests, sheet, rowCount, columnCount) {
  const grid = sheet.gridProperties;
  for (const [dimension, count, current] of [
    ['ROWS', rowCount, grid.rowCount], ['COLUMNS', columnCount, grid.columnCount]
  ]) {
    if (count > current) requests.push({ appendDimension: { sheetId: sheet.sheetId, dimension, length: count - current } });
  }
}

function addGuard_(sheetId) {
  return { addNamedRange: { namedRange: {
    name: GUARD, namedRangeId: 'raffle' + Utilities.getUuid().replace(/-/g, ''),
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }
  } } };
}

function commit_(db, requests) {
  // The old range ID is a one-use write precondition. A late or competing
  // Sheets request built against the same version cannot apply stale row indexes.
  requests.unshift({ deleteNamedRange: { namedRangeId: db.guard.namedRangeId } }, addGuard_(db.tabs.SETTINGS.sheetId));
  batch_(db.id, requests);
}

function newSheetId_(used) {
  let id = 1;
  while (used.has(id)) id++;
  used.add(id);
  return id;
}

function addSheet_(id, title, hidden, columns) {
  return { addSheet: { properties: {
    sheetId: id, title, hidden,
    gridProperties: { rowCount: 200, columnCount: Math.max(columns, 8), frozenRowCount: 1 }
  } } };
}

function initialize_(id) {
  const book = meta_(id);
  if ((book.namedRanges || []).some(item => item.name === GUARD)) {
    database_(id);
    return 'Raffle sheets already initialized.';
  }
  const existing = book.sheets.map(sheet => sheet.properties);
  const used = new Set(existing.map(sheet => sheet.sheetId));
  const byName = Object.fromEntries(existing.map(sheet => [sheet.title, sheet]));
  if (existing.some(sheet => Object.keys(SYSTEM).some(name => name.toLowerCase() === sheet.title.toLowerCase()))) {
    fail_('SETUP', 'A system sheet name is already in use. Resolve the conflict before initializing.');
  }
  let roster = byName[ROSTER];
  const requests = [];
  if (!roster) {
    const first = existing.length === 1 ? existing[0] : null;
    if (!first || first.sheetType !== 'GRID' || rows_(id, [first.title], 'FORMULA')[first.title].length) {
      fail_('SETUP', 'Use a blank spreadsheet or name your existing participant tab ALL IMS.');
    }
    roster = first;
  }
  if (roster.sheetType !== 'GRID') fail_('SETUP', 'ALL IMS must be a standard grid worksheet.');
  const rosterRows = rows_(id, [roster.title])[roster.title];
  requests.push({ updateSheetProperties: {
    properties: { sheetId: roster.sheetId, title: ROSTER, index: 0, hidden: false, gridProperties: { frozenRowCount: 1 } },
    fields: 'title,index,hidden,gridProperties.frozenRowCount'
  } });
  if (rosterRows.length === 0) {
    resize_(requests, roster, 1, 2);
    requests.push(write_(roster.sheetId, 0, 0, [['Name', ID_HEADER]]), header_(roster.sheetId, 2));
  }
  let settingsSheet;
  for (const [title, columns] of Object.entries(SYSTEM)) {
    const id = newSheetId_(used);
    requests.push(addSheet_(id, title, true, columns.length), write_(id, 0, 0, [columns]), header_(id, columns.length));
    if (title === 'SETTINGS') settingsSheet = id;
  }
  const nameHeader = !rosterRows.length || (rosterRows[0] || []).includes('Name') ? 'Name' : '';
  requests.push(write_(settingsSheet, 1, 0, [['eventName', 'Raffle Draw'], ['nameHeader', nameHeader]]),
    addGuard_(settingsSheet));
  batch_(id, requests);
  database_(id);
  return 'Raffle sheets initialized.';
}

function database_(id) {
  const book = meta_(id);
  const tabs = Object.fromEntries(book.sheets.map(sheet => [sheet.properties.title, sheet.properties]));
  const guard = (book.namedRanges || []).find(item => item.name === GUARD);
  if (!guard || !tabs[ROSTER] || Object.keys(SYSTEM).some(name => !tabs[name])) {
    fail_('SETUP', 'Run initializeRaffle in Apps Script before using the app.');
  }
  const source = book.sheets.find(sheet => sheet.properties.sheetId === tabs[ROSTER].sheetId);
  const data = rows_(id, [ROSTER, ...Object.keys(SYSTEM)]);
  for (const [title, columns] of Object.entries(SYSTEM)) {
    if (JSON.stringify(data[title][0]) !== JSON.stringify(columns)) {
      fail_('INTEGRITY', title + ' has an unexpected header.');
    }
  }
  if (data.SETTINGS[1]?.[0] !== 'eventName' || data.SETTINGS[2]?.[0] !== 'nameHeader') {
    fail_('INTEGRITY', 'SETTINGS rows have changed.');
  }
  const rawHeaders = data[ROSTER][0] || [];
  const headers = rawHeaders.map(value => String(value || '').trim());
  const usedHeaders = headers.filter(Boolean);
  const nameHeader = String(data.SETTINGS[2][1] || '');
  const nameColumn = headers.indexOf(nameHeader);
  const idColumn = headers.indexOf(ID_HEADER);
  if (new Set(usedHeaders).size !== usedHeaders.length) fail_('INTEGRITY', 'ALL IMS has duplicate column headers.');
  const winnerList = data.DRAW_WINNERS.slice(1).map(([tx, prizeId, id, name, position]) =>
    ({ tx, prizeId, id: String(id ?? '').trim(), name, position }));
  const winnerIds = new Set(winnerList.map(winner => winner.id));
  const winnerCounts = new Map();
  const winnersByDraw = new Map();
  for (const winner of winnerList) {
    winnerCounts.set(winner.prizeId, (winnerCounts.get(winner.prizeId) || 0) + 1);
    if (!winnersByDraw.has(winner.tx)) winnersByDraw.set(winner.tx, []);
    winnersByDraw.get(winner.tx).push(winner);
  }
  const history = data.DRAW_HISTORY.slice(1).map(([tx, prizeId, prizeName, eventName, at, count]) =>
    ({ tx, prizeId, prizeName, eventName, at, count }));
  if (winnerList.length !== winnerIds.size || new Set(history.map(draw => draw.tx)).size !== history.length ||
      history.reduce((total, draw) => total + draw.count, 0) !== winnerList.length ||
      history.some(draw => {
        const winners = winnersByDraw.get(draw.tx) || [];
        return winners.length !== draw.count || winners.some(winner => winner.prizeId !== draw.prizeId);
      })) {
    fail_('INTEGRITY', 'The winner ledger and draw history disagree.');
  }
  const activeIds = new Set();
  const eligible = [];
  let invalid = 0;
  let excluded = 0;
  data[ROSTER].slice(1).forEach((values, offset) => {
    if (!values.some(value => value !== undefined && value !== '')) return;
    const participantId = String(values[idColumn] ?? '').trim();
    if (participantId && activeIds.has(participantId)) fail_('INTEGRITY', 'ALL IMS contains a duplicate participant ID.');
    if (participantId) activeIds.add(participantId);
    if (winnerIds.has(participantId)) { excluded++; return; }
    const name = nameHeader && nameColumn >= 0 ? String(values[nameColumn] ?? '').trim() : '';
    if (!name || name.length > 500) { invalid++; return; }
    eligible.push({ row: offset + 1, id: participantId, name });
  });
  const settings = new Map(data.SETTINGS.slice(3));
  const prizes = data.PRIZES.slice(1).map(([id, sheetId, name, limit, perDraw, at], index) => {
    const sheet = tabs[name];
    const won = winnerCounts.get(id) || 0;
    if (!sheet || sheet.sheetId !== sheetId || !Number.isSafeInteger(limit) || !Number.isSafeInteger(perDraw) ||
        perDraw < 1 || perDraw > limit || won > limit) fail_('INTEGRITY', 'A prize record or worksheet has changed outside the app.');
    const archived = settings.get(ARCHIVED_PRIZE + id) === true;
    return { id, sheetId, name, limit, perDraw, at, won, remaining: limit - won, archived, index: index + 1 };
  });
  if (new Set(prizes.map(prize => prize.id)).size !== prizes.length ||
      [...winnerCounts.keys()].some(id => !prizes.some(prize => prize.id === id))) {
    fail_('INTEGRITY', 'Prize identifiers and the winner ledger disagree.');
  }
  return { id, tabs, guard, source, bookSheets: book.sheets, data, headers, rawHeaders, nameHeader, idColumn, eligible, invalid, excluded, history,
    winnersByDraw, prizes, winnerList, winnerIds, activeIds, eventName: String(data.SETTINGS[1][1] || 'Raffle Draw') };
}

function dispatch_(cfg, input) {
  const db = database_(cfg.id);
  switch (input.action) {
    case 'state': return state_(db);
    case 'settings': return saveSettings_(db, input);
    case 'prize': return savePrize_(db, input);
    case 'archivePrize': return archivePrize_(db, input);
    case 'resetPrize': return resetPrize_(db, input);
    case 'draw': return draw_(db, cfg.random, input);
    case 'receipt': {
      const tx = tx_(input.tx);
      const item = db.history.find(draw => draw.tx === tx);
      if (!item?.count) fail_('NOT_FOUND', 'No current draw has this transaction ID.');
      return receipt_(db, item);
    }
    default: fail_('BAD_REQUEST', 'Unknown action.');
  }
}

function state_(db) {
  const byTx = new Map(db.history.map(draw => [draw.tx, draw]));
  return {
    eventName: db.eventName, nameHeader: db.nameHeader, headers: db.headers.filter(name => name && name !== ID_HEADER),
    total: db.eligible.length + db.invalid + db.winnerList.length, eligible: db.eligible.length, won: db.winnerList.length,
    invalid: db.invalid, excluded: db.excluded, prizes: db.prizes, lastDraw: db.history.filter(draw => draw.count).at(-1) || null,
    history: db.winnerList.slice().reverse().map(winner => {
      const draw = byTx.get(winner.tx);
      return { ...winner, prizeName: draw.prizeName, at: draw.at };
    })
  };
}

function saveSettings_(db, input) {
  const name = typeof input.eventName === 'string' ? input.eventName.trim() : '';
  if (!name || name.length > 120) fail_('VALIDATION', 'Enter an event name of 1–120 characters.');
  if (!db.headers.includes(input.nameHeader) || !input.nameHeader || input.nameHeader === ID_HEADER) {
    fail_('VALIDATION', 'Select an existing participant name column.');
  }
  commit_(db, [write_(db.tabs.SETTINGS.sheetId, 1, 0, [['eventName', name], ['nameHeader', input.nameHeader]])]);
  return { saved: true };
}

function savePrize_(db, input) {
  const name = input.name;
  if (typeof name !== 'string' || !name || name.length > 100 || name !== name.trim() ||
      /[\[\]:*?/\\\u0000-\u001f\u007f]/.test(name) || name.startsWith("'") || name.endsWith("'") ||
      ['history', ...[ROSTER, ...Object.keys(SYSTEM)].map(title => title.toLowerCase())].includes(name.toLowerCase())) {
    fail_('VALIDATION', 'Enter an exact, valid worksheet name up to 100 characters.');
  }
  const current = input.id ? db.prizes.find(prize => prize.id === input.id) : null;
  if (input.id && !current) fail_('NOT_FOUND', 'Prize not found.');
  if (Object.values(db.tabs).some(sheet => sheet.title.toLowerCase() === name.toLowerCase() && sheet.sheetId !== current?.sheetId)) {
    fail_('VALIDATION', 'A worksheet with that name already exists.');
  }
  const { limit, perDraw } = input;
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(perDraw) || limit < 1 || limit > 100000 ||
      perDraw < 1 || perDraw > Math.min(1000, limit) || limit < (current?.won || 0)) {
    fail_('VALIDATION', 'Check the winner limits. Each draw can award up to 1,000 winners and the prize limit must cover existing wins.');
  }
  const sheetId = current?.sheetId ?? newSheetId_(new Set(Object.values(db.tabs).map(sheet => sheet.sheetId)));
  const prizeId = current?.id || Utilities.getUuid();
  const requests = [];
  if (!current) {
    const columns = db.rawHeaders.slice();
    if (db.idColumn < 0) columns.push(ID_HEADER);
    requests.push(addSheet_(sheetId, name, false, columns.length), write_(sheetId, 0, 0, [columns]), header_(sheetId, columns.length));
  } else if (current.name !== name) {
    requests.push({ updateSheetProperties: { properties: { sheetId, title: name }, fields: 'title' } });
  }
  const ledger = db.tabs.PRIZES;
  const row = current?.index ?? db.data.PRIZES.length;
  resize_(requests, ledger, row + 1, SYSTEM.PRIZES.length);
  requests.push(write_(ledger.sheetId, row, 0, [[prizeId, sheetId, name, limit, perDraw, current?.at || new Date().toISOString()]]));
  commit_(db, requests);
  return { id: prizeId };
}

function tx_(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail_('VALIDATION', 'A valid draw transaction ID is required.');
  return value.toLowerCase();
}

function archivePrize_(db, input) {
  const prize = db.prizes.find(item => item.id === input.prizeId);
  if (!prize) fail_('NOT_FOUND', 'Prize not found.');
  const { archived } = input;
  if (typeof archived !== 'boolean') fail_('VALIDATION', 'Choose whether to archive or restore the prize.');
  if (prize.archived === archived) return { archived };

  const settings = db.tabs.SETTINGS;
  const key = ARCHIVED_PRIZE + prize.id;
  const rows = db.data.SETTINGS;
  const existing = rows.findIndex(([name]) => name === key);
  const index = existing < 0 ? rows.length : existing;
  const requests = [];
  resize_(requests, settings, index + 1, SYSTEM.SETTINGS.length);
  requests.push(write_(settings.sheetId, index, 0, [[key, archived]]));
  commit_(db, requests);
  return { archived };
}

function deleteRows_(requests, sheet, indexes) {
  const rows = indexes.slice().sort((a, b) => b - a);
  for (let i = 0; i < rows.length;) {
    const endIndex = rows[i] + 1;
    let startIndex = rows[i++];
    while (rows[i] === startIndex - 1) startIndex = rows[i++];
    requests.push({ deleteDimension: { range: {
      sheetId: sheet.sheetId, dimension: 'ROWS', startIndex, endIndex
    } } });
  }
}

function resetPrize_(db, input) {
  const prize = db.prizes.find(item => item.id === input.prizeId);
  if (!prize) fail_('NOT_FOUND', 'Prize not found.');
  const throughTx = tx_(input.throughTx);
  const confirmed = db.history.find(draw => draw.tx === throughTx && draw.prizeId === prize.id);
  if (confirmed?.count === 0) return { restored: 0 };
  if (prize.archived) fail_('VALIDATION', 'Restore this archived prize before resetting it.');
  const draws = db.history.filter(draw => draw.prizeId === prize.id && draw.count);
  if (draws.at(-1)?.tx !== throughTx) fail_('CONFLICT', 'This prize changed. Refresh data and confirm the reset again.');

  const output = db.tabs[prize.name];
  const roster = db.tabs[ROSTER];
  const records = rows_(db.id, [prize.name])[prize.name];
  const width = records.reduce((max, row) => Math.max(max, row.length), db.rawHeaders.length);
  const header = values => Array.from({ length: width }, (_, i) => values?.[i] ?? '');
  if (db.idColumn < 0 || JSON.stringify(header(records[0])) !== JSON.stringify(header(db.rawHeaders))) {
    fail_('INTEGRITY', 'Restore the ALL IMS column layout used by this prize before resetting it.');
  }
  const winnerRows = [];
  const winnerIds = new Set();
  db.winnerList.forEach((winner, index) => {
    if (winner.prizeId !== prize.id) return;
    winnerRows.push(index + 1);
    winnerIds.add(winner.id);
  });
  const recordIndexes = [];
  const unmatchedRows = [];
  for (let index = 1; index < records.length; index++) {
    const row = records[index] || [];
    if (!row.some(value => value !== undefined && value !== null && value !== '')) continue;
    recordIndexes.push(index);
    const participantId = String(row[db.idColumn] ?? '').trim();
    if (!winnerIds.delete(participantId)) unmatchedRows.push(index + 1);
  }
  // An empty prize tab can be rebuilt from the ledger only when it contains every roster field.
  const recoverFromLedger = !recordIndexes.length && width === 2 && db.nameHeader === 'Name' &&
    db.headers[0] === 'Name' && db.idColumn === 1 && db.data[ROSTER].every(row => row.length <= 2);
  if (!recoverFromLedger && (unmatchedRows.length || winnerIds.size)) {
    const counts = 'The prize worksheet has ' + recordIndexes.length + (recordIndexes.length === 1 ? ' row' : ' rows') +
      ' with data. DRAW_WINNERS lists ' + winnerRows.length + (winnerRows.length === 1 ? ' winner' : ' winners') + ' for this prize.';
    const affected = unmatchedRows.length ? ' Check for missing, duplicate, or unexpected Participant IDs on prize worksheet rows ' +
      unmatchedRows.slice(0, 8).join(', ') + (unmatchedRows.length > 8 ? ', and others.' : '.') : '';
    fail_('INTEGRITY', counts + affected + ' Compare those records with DRAW_WINNERS before retrying.');
  }
  const winners = winnerRows.map(index => db.winnerList[index - 1]);
  if (recoverFromLedger && winners.some(winner =>
    !winner.id || typeof winner.name !== 'string' || !winner.name.trim() || winner.name.length > 500)) {
    fail_('INTEGRITY', 'DRAW_WINNERS is missing a valid name or Participant ID for this prize. Restore the prize records from a backup before resetting.');
  }
  if (winners.some(winner => db.activeIds.has(winner.id))) {
    fail_('INTEGRITY', 'ALL IMS already contains a winner from this prize. Resolve the duplicate record before resetting.');
  }
  const outputMeta = db.bookSheets.find(sheet => sheet.properties.sheetId === output.sheetId);
  if (db.source.merges?.length || outputMeta.merges?.length) {
    fail_('VALIDATION', 'Unmerge cells in ALL IMS and the prize worksheet before resetting.');
  }

  const requests = [];
  const rosterEnd = db.data[ROSTER].length;
  resize_(requests, roster, rosterEnd + winners.length, width);
  if (recoverFromLedger) {
    requests.push(write_(roster.sheetId, rosterEnd, 0, winners.map(winner => [winner.name, winner.id])));
  }
  for (let i = 0; i < recordIndexes.length;) {
    const startRowIndex = recordIndexes[i];
    const startDestination = rosterEnd + i;
    let endRowIndex = startRowIndex + 1;
    while (recordIndexes[++i] === endRowIndex) endRowIndex++;
    const source = { sheetId: output.sheetId, startRowIndex, endRowIndex, startColumnIndex: 0, endColumnIndex: width };
    const destination = { ...source, sheetId: roster.sheetId, startRowIndex: startDestination, endRowIndex: rosterEnd + i };
    for (const pasteType of ['PASTE_NORMAL', 'PASTE_VALUES']) {
      requests.push({ copyPaste: { source, destination, pasteType, pasteOrientation: 'NORMAL' } });
    }
  }
  const ledger = db.tabs.DRAW_WINNERS;
  for (const [sheet, count] of [[output, recordIndexes.length], [ledger, winnerRows.length]]) {
    resize_(requests, sheet, count + (sheet.gridProperties.frozenRowCount || 0) + 1, 0);
  }
  deleteRows_(requests, output, recordIndexes);
  deleteRows_(requests, ledger, winnerRows);
  // Keep a zero-count record so retries cannot redraw a transaction canceled by a reset.
  requests.push(write_(db.tabs.DRAW_HISTORY.sheetId, 1, SYSTEM.DRAW_HISTORY.length - 1,
    db.history.map(draw => [draw.prizeId === prize.id ? 0 : draw.count])));
  commit_(db, requests);
  return { restored: winners.length };
}

function receipt_(db, draw, reelNames) {
  return {
    ...draw,
    winners: db.winnersByDraw.get(draw.tx).slice().sort((a, b) => a.position - b.position).map(winner => winner.name),
    names: reelNames || db.eligible.map(person => person.name)
  };
}

function randomStream_(key, context) {
  let counter = 0;
  let bytes = [];
  let offset = 0;
  return size => {
    const cutoff = 4294967296 - (4294967296 % size);
    for (;;) {
      if (offset === bytes.length) {
        bytes = Utilities.computeHmacSha256Signature('raffle/v1/' + context + '/' + counter++, key);
        offset = 0;
      }
      let value = 0;
      for (let i = 0; i < 4; i++) value = value * 256 + (bytes[offset++] & 255);
      if (value < cutoff) return value % size;
    }
  };
}

function select_(list, count, random) {
  const pool = list.slice();
  for (let i = 0; i < count; i++) {
    const j = i + random(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function draw_(db, key, input) {
  const tx = tx_(input.tx);
  const prior = db.history.find(draw => draw.tx === tx);
  if (prior) {
    if (prior.prizeId !== input.prizeId) fail_('CONFLICT', 'That transaction belongs to another prize.');
    if (!prior.count) fail_('CONFLICT', 'This draw was canceled when the prize was reset. Start a new draw.');
    return receipt_(db, prior);
  }
  const prize = db.prizes.find(item => item.id === input.prizeId);
  if (!prize) fail_('NOT_FOUND', 'Select an existing prize.');
  if (prize.archived) fail_('VALIDATION', 'This prize is archived. Select another prize.');
  if (db.source.merges?.length) fail_('VALIDATION', 'Unmerge ALL IMS cells before drawing.');
  if (db.invalid) fail_('VALIDATION', 'Check the name column and fix incomplete participant rows before drawing.');
  if (db.excluded) fail_('VALIDATION', 'ALL IMS includes previous winners. Remove those re-imported records before drawing.');
  const count = Math.min(prize.perDraw, prize.remaining, db.eligible.length);
  if (!count) fail_('VALIDATION', 'There are no eligible participants or winning slots for this prize.');
  const names = db.eligible.map(person => person.name);
  const selected = select_(db.eligible, count, randomStream_(key, db.id + '/' + tx + '/' + prize.id));
  const width = db.data[ROSTER].reduce((max, row) => Math.max(max, row.length), db.headers.length);
  const ids = db.idColumn < 0 ? width : db.idColumn;
  const headers = Array.from({ length: Math.max(width, ids + 1) }, (_, i) => i === ids && db.idColumn < 0 ? ID_HEADER : db.rawHeaders[i] ?? '');
  const output = db.tabs[prize.name];
  const existing = rows_(db.id, [prize.name])[prize.name];
  if (existing.length !== prize.won + 1) fail_('INTEGRITY', 'The prize worksheet row count differs from the winner ledger.');
  if (prize.won && JSON.stringify(Array.from({ length: Math.max(headers.length, existing[0].length) },
    (_, i) => existing[0][i] ?? '')) !== JSON.stringify(headers)) {
    fail_('INTEGRITY', 'Restore the ALL IMS column layout used by this prize before drawing again.');
  }
  const requests = [];
  const roster = db.tabs[ROSTER];
  resize_(requests, roster, Math.max(db.data[ROSTER].length, count + 2), headers.length);
  if (db.idColumn < 0) requests.push(write_(roster.sheetId, 0, ids, [[ID_HEADER]]), header_(roster.sheetId, ids + 1));
  const missing = db.eligible.filter(person => !person.id);
  for (let i = 0; i < missing.length;) {
    const start = missing[i].row;
    const values = [];
    do {
      const person = missing[i++];
      do { person.id = Utilities.getUuid(); } while (db.activeIds.has(person.id) || db.winnerIds.has(person.id));
      db.activeIds.add(person.id);
      values.push([person.id]);
    } while (missing[i]?.row === start + values.length);
    requests.push(write_(roster.sheetId, start, ids, values));
  }
  resize_(requests, output, existing.length + count, headers.length);
  if (!prize.won) requests.push(write_(output.sheetId, 0, 0, [headers]), header_(output.sheetId, headers.length));
  const span = (sheetId, row) => ({ sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: headers.length });
  selected.forEach((person, index) => {
    const source = span(roster.sheetId, person.row);
    const destination = span(output.sheetId, existing.length + index);
    requests.push({ copyPaste: { source, destination, pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL' } },
      { copyPaste: { source, destination, pasteType: 'PASTE_VALUES', pasteOrientation: 'NORMAL' } });
  });
  const at = new Date().toISOString();
  const history = db.tabs.DRAW_HISTORY;
  const winners = db.tabs.DRAW_WINNERS;
  resize_(requests, history, db.data.DRAW_HISTORY.length + 1, SYSTEM.DRAW_HISTORY.length);
  resize_(requests, winners, db.data.DRAW_WINNERS.length + count, SYSTEM.DRAW_WINNERS.length);
  requests.push(write_(history.sheetId, db.data.DRAW_HISTORY.length, 0, [[tx, prize.id, prize.name, db.eventName, at, count]]),
    write_(winners.sheetId, db.data.DRAW_WINNERS.length, 0, selected.map((person, i) => [tx, prize.id, person.id, person.name, i + 1])));
  deleteRows_(requests, roster, selected.map(person => person.row));
  commit_(db, requests);
  return { tx, prizeId: prize.id, prizeName: prize.name, eventName: db.eventName, at, count, winners: selected.map(person => person.name), names };
}
