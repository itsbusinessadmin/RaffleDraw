import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const code = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
export const key = 'a'.repeat(64);
export const testId = 'isolated-test-spreadsheet';

export function fixture(defaultRows = []) {
  let inLock = false;
  let sheets = new Map([[0, { properties: {
    sheetId: 0, title: 'Sheet1', index: 0, sheetType: 'GRID', hidden: false,
    gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 0 }
  }, rows: structuredClone(defaultRows) }]]);
  let ranges = new Map();
  let failure = '';
  let lastRequests = [];
  let batches = 0;
  const sheetByName = (store, title) => [...store.values()].find(sheet => sheet.properties.title === title);
  const set = (rows, row, col, values) => {
    rows[row] ||= [];
    values.forEach((value, index) => { rows[row][col + index] = value ?? ''; });
  };
  const compact = rows => {
    const result = Array.from(rows, row => {
      const cells = Array.from(row || [], value => value ?? '');
      while (cells.at(-1) === '') cells.pop();
      return cells;
    });
    while (result.length && !result.at(-1).length) result.pop();
    return result;
  };

  function applyBatch({ requests }, id) {
    if (id !== testId || !inLock) throw Error('Writes require the test workbook and script lock');
    lastRequests = structuredClone(requests);
    if (failure === 'before') {
      failure = '';
      throw Error('Network failed before commit');
    }
    const next = structuredClone(sheets);
    const named = structuredClone(ranges);
    for (const request of requests) {
      const [type, body] = Object.entries(request)[0];
      if (type === 'addNamedRange') {
        const item = body.namedRange;
        if (named.has(item.namedRangeId) || [...named.values()].some(range => range.name === item.name)) throw Error('Duplicate range');
        named.set(item.namedRangeId, item);
      } else if (type === 'deleteNamedRange') {
        if (!named.delete(body.namedRangeId)) throw Error('Stale write guard');
      } else if (type === 'addSheet') {
        const p = body.properties;
        if (next.has(p.sheetId) || sheetByName(next, p.title)) throw Error('Duplicate tab');
        next.set(p.sheetId, { properties: { ...p, index: next.size, sheetType: 'GRID' }, rows: [] });
      } else if (type === 'updateSheetProperties') {
        const p = body.properties;
        const previous = next.get(p.sheetId).properties;
        Object.assign(previous, p, { gridProperties: { ...previous.gridProperties, ...p.gridProperties } });
      } else if (type === 'appendDimension') {
        const grid = next.get(body.sheetId).properties.gridProperties;
        grid[body.dimension === 'ROWS' ? 'rowCount' : 'columnCount'] += body.length;
      } else if (type === 'updateCells') {
        const { sheetId, rowIndex, columnIndex } = body.start;
        const target = next.get(sheetId);
        for (const [i, row] of body.rows.entries()) {
          if (rowIndex + i >= target.properties.gridProperties.rowCount ||
              columnIndex + row.values.length > target.properties.gridProperties.columnCount) throw Error('Write exceeds grid');
          set(target.rows, rowIndex + i, columnIndex,
            row.values.map(cell => Object.values(cell.userEnteredValue || {})[0]));
        }
      } else if (type === 'copyPaste') {
        const { source: s, destination: d } = body;
        for (let offset = 0; offset < s.endRowIndex - s.startRowIndex; offset++) {
          const data = next.get(s.sheetId).rows[s.startRowIndex + offset];
          set(next.get(d.sheetId).rows, d.startRowIndex + offset, d.startColumnIndex,
            Array.from({ length: s.endColumnIndex - s.startColumnIndex }, (_, i) => data?.[s.startColumnIndex + i]));
        }
      } else if (type === 'deleteDimension') {
        const { sheetId, startIndex, endIndex } = body.range;
        const sheet = next.get(sheetId);
        sheet.rows.splice(startIndex, endIndex - startIndex);
        sheet.properties.gridProperties.rowCount -= endIndex - startIndex;
        if (sheet.properties.gridProperties.rowCount <= sheet.properties.gridProperties.frozenRowCount) throw Error('No editable rows left');
      } else if (type !== 'repeatCell') {
        throw Error('Unexpected batch request ' + type);
      }
    }
    sheets = next;
    ranges = named;
    batches++;
    if (failure === 'after') {
      failure = '';
      throw Error('Network failed after commit');
    }
  }

  const context = vm.createContext({
    console: { info() {}, error() {} },
    ContentService: { MimeType: { JSON: 1 }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (inLock) return false; inLock = true; return true; },
      releaseLock: () => { inLock = false; }
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => ({
      RAFFLE_SPREADSHEET_ID: testId, RAFFLE_ADMIN_TOKEN: key, RAFFLE_RANDOM_KEY: 'b'.repeat(64)
    })[name] }) },
    Utilities: {
      getUuid: randomUUID,
      computeHmacSha256Signature: (value, secret) => [...createHmac('sha256', secret).update(value).digest()]
    },
    Sheets: { Spreadsheets: {
      get(id) {
        if (id !== testId) throw Error('Wrong test workbook');
        return structuredClone({ properties: { title: 'Raffle Rehearsal' },
          sheets: [...sheets.values()].map(({ properties }) => ({ properties })), namedRanges: [...ranges.values()] });
      },
      batchUpdate: applyBatch,
      Values: { batchGet(id, { ranges }) {
        if (id !== testId) throw Error('Wrong test workbook');
        return { valueRanges: ranges.map(range => ({
          values: structuredClone(compact(sheetByName(sheets, range.slice(1, -1).replaceAll("''", "'")).rows))
        })) };
      } }
    } }
  });
  vm.runInContext(code, context);
  function loadRows(name, rows) {
    const sheet = sheetByName(sheets, name);
    sheet.rows = structuredClone(rows);
    sheet.properties.gridProperties.rowCount = Math.max(sheet.properties.gridProperties.rowCount, rows.length);
  }
  return {
    initialize: () => context.initializeRaffle(),
    verify: () => context.verifySpreadsheetAccess(),
    request: (action, args = {}, token = key) => context.doPost({ postData: { contents: JSON.stringify({ ...args, action, token }) } }),
    data: name => structuredClone(compact(sheetByName(sheets, name).rows)),
    names: () => [...sheets.values()].map(({ properties }) => properties.title),
    hidden: () => [...sheets.values()].filter(({ properties }) => properties.hidden).map(({ properties }) => properties.title),
    loadRoster: rows => loadRows('ALL IMS', rows),
    loadRows,
    fail: when => { failure = when; },
    writes: () => batches,
    rejectStale: () => {
      inLock = true;
      try { applyBatch({ requests: lastRequests }, testId); } finally { inLock = false; }
    }
  };
}
