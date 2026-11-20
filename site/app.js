import { API_URL } from './config.js';
import { Reel, duration, HOLD } from './reel.js';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const audience = new URLSearchParams(location.hash.slice(1)).get('projector');
const isProjector = /^[0-9a-f-]{36}$/i.test(audience || '');

function say(id, value) {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}

function showMessage(id, message = '') {
  say(id, message);
  $(id).hidden = !message;
}

function node(tag, label) {
  const element = document.createElement(tag);
  element.textContent = label;
  return element;
}

function renderResults(id, run) {
  const list = $(id);
  const count = run?.revealed ?? 0;
  const tx = run?.receipt.tx || '';
  if (list.dataset.tx !== tx || list.children.length > count) {
    list.replaceChildren();
    list.dataset.tx = tx;
  }
  if (list.hidden !== !count) list.hidden = !count;
  if (list.children.length === count) return;
  list.append(...run.receipt.winners.slice(list.children.length, count).map(name => node('li', name)));
}

if (isProjector) {
  const channel = new BroadcastChannel('raffle-projector-' + audience);
  const reel = new Reel($('projector-stage').querySelector('.reel'));
  const projector = $('projector');
  const drawButton = $('projector-draw');
  let live = null;
  let frame = 0;
  $('operator').hidden = true;
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove();
  document.body.classList.add('presentation');
  projector.hidden = false;
  reel.idle('Ready for the draw');

  function drawFrame() {
    const run = live.run;
    const now = Date.now();
    reel.show(run, now);
    if (run.phase === 'spin' && !run.pausedAt && now - run.start < run.spin) {
      frame = requestAnimationFrame(drawFrame);
    }
  }

  function render() {
    cancelAnimationFrame(frame);
    const { eventName, prizeName, run } = live;
    say('projector-event', run?.receipt.eventName || eventName);
    say('projector-prize', run?.receipt.prizeName || prizeName || 'Live draw');
    if (!run) {
      reel.idle('Ready for the draw');
      say('projector-position', 'Standby');
      say('projector-caption', 'The draw will appear here.');
    } else {
      const done = run.phase === 'complete' || run.phase === 'summary';
      say('projector-position', done ? 'Draw complete' : 'Winner ' + (run.index + 1) + ' of ' + run.receipt.count);
      say('projector-caption', done ? run.revealed + ' winners revealed' :
        run.phase === 'hold' ? run.receipt.winners[run.index] : run.pausedAt ? 'Reveal paused' : 'Drawing…');
      drawFrame();
    }
    renderResults('projector-results', run);
  }

  channel.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    live = event.data;
    drawButton.disabled = !live.drawTx;
    render();
  });
  channel.postMessage({ type: 'ready' });
  $('fullscreen').addEventListener('click', async () => {
    try { await projector.requestFullscreen(); }
    catch (_) { say('fullscreen', 'Fullscreen unavailable'); }
  });
  drawButton.addEventListener('click', () => {
    if (document.fullscreenElement !== projector || drawButton.disabled) return;
    drawButton.disabled = true;
    channel.postMessage({ type: 'draw', tx: live.drawTx });
  });
} else {
  startOperator();
}

function startOperator() {
  const reel = new Reel($('stage').querySelector('.reel'));
  const scope = 'raffle:' + location.pathname + ':';
  const savedEndpoint = scope + 'endpoint';
  const sessionKey = scope + 'connection';
  const projectorKey = scope + 'projector';
  const projectorId = sessionStorage.getItem(projectorKey) || crypto.randomUUID();
  sessionStorage.setItem(projectorKey, projectorId);
  const channel = new BroadcastChannel('raffle-projector-' + projectorId);
  const navLinks = [...document.querySelectorAll('.section-nav a')];
  let endpoint = localStorage.getItem(savedEndpoint) || API_URL;
  let token = '';
  let state = null;
  let updating = 0;
  let refreshSequence = 0;
  let syncError = '';
  let mutation = false;
  let selected = '';
  let prizeOptionsKey = '';
  let editingPrize = '';
  let resetRequest = null;
  let archiveUndo = null;
  let limit = 30;
  let run = null;
  let offeredDraw = null;
  let frame = 0;
  let advanceTimer = 0;

  function connectionStatus(label, status) {
    const indicator = $('sync');
    indicator.dataset.state = status;
    indicator.lastChild.textContent = label;
  }

  function pendingPrefix() {
    return scope + 'pending:' + endpoint + ':';
  }

  function pending() {
    const prefix = pendingPrefix();
    const stored = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => {
      try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
    }).filter(value => value?.tx && value?.prizeId);
    const owned = stored.find(item => item.tx === sessionStorage.getItem(scope + 'draw'));
    return owned || stored.sort((a, b) => b.started - a.started)[0];
  }

  function savePending(item) {
    localStorage.setItem(pendingPrefix() + item.tx, JSON.stringify(item));
    sessionStorage.setItem(scope + 'draw', item.tx);
  }

  function clearPending(tx) {
    localStorage.removeItem(pendingPrefix() + tx);
    if (sessionStorage.getItem(scope + 'draw') === tx) sessionStorage.removeItem(scope + 'draw');
  }

  function apiURL(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Enter the deployed HTTPS raffle API URL.'); }
    const google = url.hostname === 'script.google.com' && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname);
    const worker = url.hostname.endsWith('.workers.dev') && url.pathname === '/';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || (!google && !worker)) {
      throw new Error('Enter an Apps Script /exec URL or the approved Cloudflare Worker root URL.');
    }
    return url.href;
  }

  async function api(action, args = {}, url = endpoint, key = token) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ ...args, action, token: key }),
        signal: AbortSignal.timeout(45000)
      });
    } catch (_) {
      throw new Error('The API did not respond. Check the deployment and network connection.');
    }
    if (!response.ok) throw new Error('The API returned HTTP ' + response.status + '. Check the deployment.');
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('The API returned an unexpected response. Check the deployment access.'); }
    if (!data.ok) {
      const error = new Error(data.message || 'The request failed.');
      error.code = data.code;
      throw error;
    }
    return data.result;
  }

  function publish() {
    channel.postMessage({
      type: 'state', eventName: state?.eventName || 'Raffle Draw',
      prizeName: state?.prizes.find(prize => prize.id === selected)?.name || '',
      drawTx: offeredDraw?.tx, run
    });
  }

  channel.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'ready') publish();
    if (message?.type === 'draw') {
      if (offeredDraw && message.tx === offeredDraw.tx) startDraw();
      else publish();
    }
  });

  function applyState(value) {
    state = value;
    connectionStatus('Sheets connected', 'connected');
    say('updated', 'Last synced ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    renderDashboard();
  }

  function endSession() {
    sessionStorage.removeItem(sessionKey);
    token = '';
    refreshSequence++;
    state = null;
    run = null;
    archiveUndo = null;
    showMessage('archive-error');
    syncError = '';
    clearTimeout(advanceTimer);
    cancelAnimationFrame(frame);
    renderResults('operator-results', null);
    connectionStatus('Disconnected', 'idle');
    say('connection', 'Connect');
    say('updated', 'Google Sheets');
    showMessage('issue');
    renderDashboard();
  }

  async function refresh(force = false) {
    if (!token || (updating && !force)) return;
    updating++;
    const sequence = ++refreshSequence;
    const keyAtStart = token;
    const endpointAtStart = endpoint;
    try {
      const value = await api('state');
      if (sequence === refreshSequence && keyAtStart === token && endpointAtStart === endpoint) {
        if (syncError && $('issue').textContent === syncError) showMessage('issue');
        syncError = '';
        applyState(value);
      }
    } catch (error) {
      if (sequence !== refreshSequence || keyAtStart !== token || endpointAtStart !== endpoint) return;
      const rejected = error.code === 'UNAUTHORIZED';
      if (rejected) endSession();
      connectionStatus(rejected ? 'Key rejected' : 'Sync interrupted', 'error');
      syncError = error.message;
      showMessage('issue', syncError);
    } finally {
      updating--;
    }
  }

  function renderHistory() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const history = state?.history || [];
    const rows = query ? history.filter(item =>
      [item.name, item.prizeName, item.id].some(value => String(value).toLocaleLowerCase().includes(query))) : history;
    $('history').replaceChildren(...rows.slice(0, limit).map(item => {
      const row = document.createElement('tr');
      row.append(node('td', item.name), node('td', item.prizeName), node('td', date.format(new Date(item.at))));
      return row;
    }));
    showMessage('history-empty', rows.length ? '' : query ? 'No matching winners.' : 'Committed winners will appear here.');
    $('history-more').hidden = rows.length <= limit;
  }

  function renderDashboard() {
    const prizes = state?.prizes.filter(prize => !prize.archived) || [];
    if (!prizes.some(prize => prize.id === selected && prize.remaining)) selected = prizes.find(prize => prize.remaining)?.id || '';
    const selector = $('prize-select');
    const options = prizes.map(({ id, name, remaining, won, limit }) => [id, name, !remaining, won, limit]);
    const optionsKey = JSON.stringify(options);
    if (optionsKey !== prizeOptionsKey) {
      prizeOptionsKey = optionsKey;
      selector.replaceChildren(new Option(prizes.length ? 'Select a prize' : 'No prizes yet', ''), ...options.map(([id, name, complete, won, limit]) => {
        const label = complete ? name + ' · Complete (' + number.format(won) + '/' + number.format(limit) + ')' : name;
        const option = new Option(label, id);
        option.disabled = complete;
        return option;
      }));
    }
    if (selector.value !== selected) selector.value = selected;
    say('event', state?.eventName || 'Raffle Draw');
    for (const key of ['total', 'eligible', 'won']) say(key, state ? number.format(state[key]) : '—');
    $('settings-open').disabled = !state || mutation;
    $('prize-add').disabled = !state || mutation;
    $('refresh').disabled = !token;
    $('search').disabled = !state;
    const latestDraws = new Map();
    for (const winner of state?.history || []) {
      if (!latestDraws.has(winner.prizeId)) latestDraws.set(winner.prizeId, winner.tx);
    }
    $('prizes').replaceChildren(...prizes.map(prize => {
      const row = document.createElement('tr');
      const progress = document.createElement('progress');
      progress.max = prize.limit;
      progress.value = prize.won;
      progress.setAttribute('aria-label', prize.name + ' winners awarded');
      const awarded = node('td', number.format(prize.won) + ' of ' + number.format(prize.limit));
      awarded.append(progress);
      const edit = node('button', 'Edit');
      edit.type = 'button';
      edit.disabled = mutation;
      edit.setAttribute('aria-label', 'Edit ' + prize.name);
      edit.addEventListener('click', () => openPrize(prize));
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'reset-prize';
      reset.title = 'Reset ' + prize.name;
      reset.setAttribute('aria-label', reset.title);
      const throughTx = latestDraws.get(prize.id) || '';
      reset.dataset.throughTx = throughTx;
      reset.addEventListener('click', () => {
        if (!throughTx || mutation || active() || pending()) return;
        resetRequest = { prizeId: prize.id, throughTx };
        const winners = number.format(prize.won) + (prize.won === 1 ? ' winner' : ' winners');
        say('reset-warning', 'Resetting “' + prize.name + '” returns ' + winners +
          ' to ALL IMS and removes their wins for this prize from Winner history. They can enter future draws again.');
        formError($('reset-form'));
        $('reset-dialog').showModal();
        renderControls();
      });
      const archive = document.createElement('button');
      archive.type = 'button';
      archive.id = 'archive-' + prize.id;
      archive.className = 'archive-prize';
      archive.title = 'Archive ' + prize.name;
      archive.setAttribute('aria-label', archive.title);
      archive.addEventListener('click', () => setPrizeArchived(prize, true));
      const actions = document.createElement('td');
      const buttons = document.createElement('div');
      buttons.className = 'prize-actions';
      buttons.append(edit, reset, archive);
      actions.append(buttons);
      const status = node('span', prize.remaining ? 'Open' : 'Complete');
      status.className = prize.remaining ? 'prize-status' : 'prize-status is-complete';
      const statusCell = document.createElement('td');
      statusCell.append(status);
      row.append(node('td', prize.name), awarded, node('td', number.format(prize.perDraw)),
        node('td', number.format(prize.remaining)), statusCell, actions);
      return row;
    }));
    showMessage('prize-empty', prizes.length ? '' : !state ? 'Prizes will appear after you connect.' :
      state.prizes.length ? 'All prizes are archived.' : 'Add the first prize to start drawing.');
    if (!state?.prizes.some(prize => prize.id === archiveUndo?.id && prize.archived)) archiveUndo = null;
    $('archive-feedback').hidden = !archiveUndo;
    say('archive-message', archiveUndo ? 'Archived “' + archiveUndo.name + '”.' : '');
    const warnings = [];
    if (state?.invalid) warnings.push(number.format(state.invalid) + ' participant rows need a valid name. Review the name column in Settings.');
    if (state?.excluded) warnings.push(number.format(state.excluded) + ' previous winners are back in ALL IMS. Remove their re-imported rows before drawing.');
    showMessage('notice', warnings.join(' '));
    renderHistory();
    renderControls();
  }

  function active() {
    return run && (run.phase === 'spin' || run.phase === 'hold');
  }

  function renderControls() {
    const prizes = state?.prizes.filter(item => !item.archived) || [];
    const prize = prizes.find(item => item.id === selected);
    const count = Math.min(prize?.perDraw || 0, prize?.remaining || 0, state?.eligible || 0);
    const waiting = token && pending();
    const confirming = $('disconnect-dialog').open || $('reset-dialog').open;
    $('prize-select').disabled = !prizes.length || mutation || !!active();
    $('draw').disabled = !token || !count || !!active() || mutation || confirming || !!waiting || !!state?.invalid || !!state?.excluded;
    if ($('draw').disabled) offeredDraw = null;
    else if (offeredDraw?.prizeId !== selected) offeredDraw = { tx: crypto.randomUUID(), prizeId: selected };
    say('draw', mutation ? 'Saving…' : count ? 'Draw ' + number.format(count) + (count === 1 ? ' winner' : ' winners') : 'Draw winners');
    say('slots', prize ? number.format(prize.remaining) + ' winning slots remaining' :
      !state ? 'Connect to load your prizes.' :
        !prizes.length && state.prizes.length ? 'All prizes are archived.' :
          prizes.length && prizes.every(item => !item.remaining) ? 'All prizes are complete.' : 'Choose an available prize.');
    $('retry').hidden = !waiting;
    $('retry').disabled = mutation || !!active();
    for (const button of document.querySelectorAll('.reset-prize')) {
      button.disabled = !button.dataset.throughTx || mutation || !!active() || !!waiting;
    }
    for (const button of document.querySelectorAll('.archive-prize, #archive-undo')) {
      button.disabled = mutation || !!active() || !!waiting;
    }
    $('reveal-actions').hidden = !active();
    $('pause').disabled = !active() || (run.phase === 'hold' && run.advance === 'manual');
    $('skip').disabled = !active() || run.phase !== 'spin';
    $('next').disabled = !active() || run.phase !== 'hold';
    say('next', run?.index + 1 === run?.receipt.count ? 'Finish draw' : 'Next winner');
    say('pause', run?.pausedAt ? 'Resume' : 'Pause');
    if (!run) {
      const label = prize ? 'Ready to draw' : 'Waiting for a prize';
      reel.idle(label);
      say('stage-status', prize?.name || 'Standby');
      say('stage-caption', state ? (prize ? 'Choose Draw winners to begin' : 'Set up a prize to begin') : 'Connect Google Sheets to load your prizes');
    }
    publish();
  }

  function drawFrame() {
    cancelAnimationFrame(frame);
    if (!run) return;
    reel.show(run, Date.now());
    if (run.phase === 'spin' && !run.pausedAt && Date.now() - run.start < run.spin) frame = requestAnimationFrame(drawFrame);
  }

  function updateReveal() {
    clearTimeout(advanceTimer);
    drawFrame();
    const message = run.phase === 'hold' ? run.receipt.winners[run.index] :
      run.phase === 'spin' ? (run.pausedAt ? 'Reveal paused' : 'Drawing…') : run.revealed + ' winners revealed';
    say('stage-status', run.receipt.prizeName);
    say('stage-caption', active() ? 'Winner ' + (run.index + 1) + ' of ' + run.receipt.count + ' · ' + message : message);
    renderResults('operator-results', run);
    renderControls();
    if (!run.pausedAt && run.phase === 'spin') {
      advanceTimer = setTimeout(land, Math.max(0, run.start + run.spin - Date.now()));
    } else if (!run.pausedAt && run.phase === 'hold' && run.advance === 'auto') {
      advanceTimer = setTimeout(next, Math.max(0, run.start + HOLD[run.speed] - Date.now()));
    }
  }

  function land() {
    if (!run || run.phase !== 'spin') return;
    Object.assign(run, { phase: 'hold', start: Date.now(), pausedAt: null, revealed: run.index + 1 });
    updateReveal();
  }

  function next() {
    if (!run || run.phase !== 'hold') return;
    if (run.revealed === run.receipt.count) {
      Object.assign(run, { phase: 'complete', pausedAt: null });
    } else {
      Object.assign(run, { phase: 'spin', start: Date.now(), index: run.index + 1, pausedAt: null });
    }
    updateReveal();
  }

  function begin(receipt, options = {}) {
    const speed = options.speed || $('speed').value;
    run = {
      receipt, speed, advance: options.advance || $('advance').value, index: 0,
      phase: 'spin', start: Date.now(), spin: duration(speed, reduceMotion.matches), pausedAt: null, revealed: 0
    };
    updateReveal();
  }

  function startDraw() {
    if (!offeredDraw || pending()) return;
    commitDraw({ ...offeredDraw, started: Date.now(), speed: $('speed').value, advance: $('advance').value });
  }

  async function commitDraw(request) {
    if (!request || mutation || active()) return;
    mutation = true;
    refreshSequence++;
    savePending(request);
    showMessage('issue');
    renderControls();
    try {
      const receipt = await api('draw', { tx: request.tx, prizeId: request.prizeId });
      clearPending(request.tx);
      begin(receipt, request);
    } catch (error) {
      const definitive = ['VALIDATION', 'NOT_FOUND', 'CONFLICT'].includes(error.code);
      if (definitive) clearPending(request.tx);
      showMessage('issue', definitive ? error.message :
        error.message + ' Use Retry pending draw to check or complete transaction ' + request.tx + '.');
    } finally {
      mutation = false;
      renderControls();
      await refresh(true);
    }
  }

  async function setPrizeArchived(prize, archived) {
    if (!prize || !token || mutation || active() || pending()) return;
    mutation = true;
    refreshSequence++;
    showMessage('archive-error');
    renderControls();
    let changed = false;
    try {
      const result = await api('archivePrize', { prizeId: prize.id, archived });
      if (result.archived !== archived) throw new Error('The API could not confirm the archive change. Refresh data and try again.');
      const current = state?.prizes.find(item => item.id === prize.id);
      if (!current) return;
      current.archived = archived;
      archiveUndo = archived ? current : null;
      if (archived && run?.receipt.prizeId === prize.id) {
        run = null;
        renderResults('operator-results', null);
      }
      changed = true;
    } catch (error) {
      const message = error.code === 'BAD_REQUEST' && error.message === 'Unknown action.'
        ? 'Deploy the updated Apps Script version to use prize archiving.' : error.message;
      showMessage('archive-error', message);
    } finally {
      mutation = false;
      renderDashboard();
      if (document.activeElement === document.body) {
        const target = changed && archived ? $('archive-undo') : $('archive-' + prize.id);
        target?.focus({ preventScroll: true });
      }
    }
  }

  function openPrize(prize) {
    editingPrize = prize?.id || '';
    say('prize-form-title', prize ? 'Edit prize' : 'Add prize');
    $('prize-name').value = prize?.name || '';
    $('prize-limit').value = prize?.limit || 1;
    $('prize-count').value = prize?.perDraw || 1;
    formError($('prize-form'));
    $('prize-dialog').showModal();
  }

  function formError(form, message = '') {
    const output = form.querySelector('[role="alert"]');
    output.textContent = message;
    output.hidden = !message;
  }

  async function saveForm(form, action, values, onSave) {
    if (mutation) return;
    mutation = true;
    refreshSequence++;
    formError(form);
    const submit = form.querySelector('button[type="submit"], button.primary');
    const cancel = form.querySelector('[data-close]');
    submit.disabled = true;
    cancel.disabled = true;
    renderControls();
    try {
      const result = await api(action, values);
      if (result.id) selected = result.id;
      onSave?.();
      form.closest('dialog').close();
      showMessage('issue');
      await refresh(true);
    } catch (error) {
      formError(form, error.message);
    } finally {
      mutation = false;
      submit.disabled = false;
      cancel.disabled = false;
      renderDashboard();
    }
  }

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  for (const dialog of [$('disconnect-dialog'), $('reset-dialog')]) {
    dialog.addEventListener('close', renderControls);
  }
  $('reset-dialog').addEventListener('cancel', event => {
    if (mutation) event.preventDefault();
  });
  function updateNavigation() {
    const locationHash = location.hash || '#draw-section';
    for (const link of navLinks) {
      if (link.hash === locationHash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', updateNavigation);
  updateNavigation();
  $('connection').addEventListener('click', () => {
    if (token) {
      if (mutation) return;
      $('disconnect-dialog').showModal();
      renderControls();
      return;
    }
    $('endpoint').value = endpoint;
    $('token').value = '';
    showMessage('connect-error');
    $('connect-dialog').showModal();
  });
  $('disconnect-confirm').addEventListener('click', () => {
    if (mutation) return;
    $('disconnect-dialog').close();
    endSession();
  });
  $('connect-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('connect-submit');
    if (submit.disabled) return;
    submit.disabled = true;
    showMessage('connect-error');
    try {
      const url = apiURL($('endpoint').value.trim());
      const key = $('token').value.trim();
      const result = await api('state', {}, url, key);
      endpoint = url;
      localStorage.setItem(savedEndpoint, url);
      sessionStorage.setItem(sessionKey, JSON.stringify({ endpoint: url, token: key }));
      token = key;
      $('token').value = '';
      $('connect-dialog').close();
      say('connection', 'Disconnect');
      showMessage('issue');
      applyState(result);
    } catch (error) {
      showMessage('connect-error', error.message);
    } finally {
      submit.disabled = false;
    }
  });
  $('settings-open').addEventListener('click', () => {
    $('event-name').value = state.eventName;
    $('name-header').replaceChildren(new Option('Select a column', ''),
      ...state.headers.map(name => new Option(name, name)));
    $('name-header').value = state.nameHeader || '';
    formError($('settings-form'));
    $('settings-dialog').showModal();
  });
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    saveForm(event.currentTarget, 'settings', { eventName: $('event-name').value, nameHeader: $('name-header').value });
  });
  $('archive-undo').addEventListener('click', () => setPrizeArchived(archiveUndo, false));
  $('prize-add').addEventListener('click', () => openPrize());
  $('prizes-toggle').addEventListener('click', event => {
    const button = event.currentTarget;
    const panel = $('prizes-panel');
    panel.hidden = !panel.hidden;
    const label = panel.hidden ? 'Expand prize list' : 'Collapse prize list';
    button.setAttribute('aria-expanded', String(!panel.hidden));
    button.setAttribute('aria-label', label);
    button.title = label;
  });
  $('prize-form').addEventListener('submit', event => {
    event.preventDefault();
    saveForm(event.currentTarget, 'prize', {
      id: editingPrize, name: $('prize-name').value, limit: $('prize-limit').valueAsNumber, perDraw: $('prize-count').valueAsNumber
    });
  });
  $('reset-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!resetRequest || active() || pending()) return;
    const request = resetRequest;
    saveForm(event.currentTarget, 'resetPrize', request, () => {
      if (run?.receipt.prizeId === request.prizeId) {
        run = null;
        renderResults('operator-results', null);
      }
      selected = request.prizeId;
    });
  });
  $('prize-select').addEventListener('change', () => {
    selected = $('prize-select').value;
    if (run && !active()) {
      run = null;
      renderResults('operator-results', null);
    }
    renderControls();
  });
  $('draw').addEventListener('click', startDraw);
  $('retry').addEventListener('click', () => commitDraw(pending()));
  $('pause').addEventListener('click', () => {
    if (!active()) return;
    const now = Date.now();
    if (run.pausedAt) {
      run.start += now - run.pausedAt;
      run.pausedAt = null;
    } else {
      run.pausedAt = now;
    }
    updateReveal();
  });
  $('skip').addEventListener('click', land);
  $('next').addEventListener('click', next);
  $('all').addEventListener('click', () => {
    if (!active()) return;
    Object.assign(run, { phase: 'summary', index: run.receipt.count - 1, revealed: run.receipt.count, pausedAt: null });
    updateReveal();
  });
  $('search').addEventListener('input', () => { limit = 30; renderHistory(); });
  $('history-more').addEventListener('click', () => { limit += 30; renderHistory(); });
  $('refresh').addEventListener('click', () => { showMessage('issue'); refresh(); });
  $('projector-open').addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = 'projector=' + projectorId;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token && !mutation) refresh();
  });
  window.addEventListener('storage', event => {
    if (event.key?.startsWith(pendingPrefix())) renderControls();
  });
  setInterval(() => {
    if (!document.hidden && !mutation && token) refresh();
  }, 30000);
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey));
    if (typeof saved?.token === 'string' && /^[0-9a-f]{64}$/.test(saved.token)) {
      endpoint = apiURL(saved.endpoint);
      token = saved.token;
    }
  } catch (_) {
    sessionStorage.removeItem(sessionKey);
  }
  if (token) {
    connectionStatus('Reconnecting…', 'checking');
    say('connection', 'Disconnect');
    refresh();
  }
  renderDashboard();
}
