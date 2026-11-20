import { API_URL } from './config.js';
import { Reel, duration, HOLD, DEFAULT_REVEAL_SECONDS, DEFAULT_NAMES_PER_SECOND } from './reel.js';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const holdMessage = 'You can continue after the winner display time.';
const timingFields = [
  ['reveal-seconds', 'revealSeconds', DEFAULT_REVEAL_SECONDS],
  ['names-per-second', 'namesPerSecond', DEFAULT_NAMES_PER_SECOND],
  ['winner-seconds', 'winnerSeconds', HOLD.standard / 1000]
];
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
  const redrawing = run?.phase === 'spin' && run.index < count ? run.index : -1;
  const tx = run ? [run.receipt.tx, run.receipt.redrawTx, redrawing].join(':') : '';
  if (list.dataset.tx !== tx || list.children.length > count) {
    list.replaceChildren();
    list.dataset.tx = tx;
  }
  if (list.hidden !== !count) list.hidden = !count;
  if (list.children.length === count) return;
  const start = list.children.length;
  list.append(...run.receipt.winners.slice(start, count).map((name, offset) =>
    node('li', start + offset === redrawing ? '—' : name)));
}

if (isProjector) {
  const channel = new BroadcastChannel('raffle-projector-' + audience);
  const reel = new Reel($('projector-stage').querySelector('.reel'));
  const projector = $('projector');
  const actionButton = $('projector-action-button');
  const advanceSelect = $('projector-advance');
  const controls = $('projector-controls');
  const toggle = $('projector-toggle');
  const redrawButton = $('projector-redraw');
  const redrawDialog = $('redraw-dialog');
  const redrawConfirm = $('redraw-confirm');
  const redrawCancel = $('redraw-cancel');
  const redrawWinner = $('redraw-winner');
  let live = null;
  let frame = 0;
  $('operator').hidden = true;
  for (const dialog of document.querySelectorAll('dialog:not(#redraw-dialog)')) dialog.remove();
  document.body.classList.add('presentation');
  projector.hidden = false;
  reel.idle('');

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
    const { eventName, prizeName, run: currentRun, advance, advanceEditable, drawTx, remote, nextReady } = live;
    const run = currentRun?.phase === 'complete' && currentRun.advance === 'manual' ? null : currentRun;
    $('projector-remote').hidden = !remote;
    advanceSelect.disabled = !advanceEditable;
    advanceSelect.value = advance || 'auto';
    const revealing = run?.phase === 'spin' || run?.phase === 'hold';
    const manualHold = !remote && run?.phase === 'hold' && run.advance === 'manual';
    $('projector-action').hidden = !!remote;
    actionButton.disabled = remote || (revealing ? !manualHold || !nextReady : !drawTx);
    let actionLabel = revealing ? 'Drawing…' : 'Draw';
    if (manualHold) actionLabel = run.revealed === run.receipt.count ? 'Finish draw' : 'Next winner';
    say('projector-action-button', actionLabel);
    const redrawRequiresUpdate = live.redrawSupported === false;
    const redrawUpdateMessage = 'Deploy the updated Google Apps Script to enable Re-draw.';
    showMessage('projector-hold-note', redrawRequiresUpdate ? redrawUpdateMessage : manualHold && !nextReady ? holdMessage : '');
    redrawButton.disabled = !live.canRedraw;
    redrawButton.title = live.canRedraw ? '' : redrawRequiresUpdate ? redrawUpdateMessage : 'Available while a winner is on the ticket.';
    if (live.redrawPrompt && document.fullscreenElement === projector) {
      if (!redrawDialog.open) {
        redrawWinner.replaceChildren(...run.receipt.winners.slice(0, run.revealed).map((name, index) =>
          new Option((index + 1) + '. ' + name, String(index + 1))));
        redrawWinner.value = String(run.index + 1);
      }
      if (live.redrawPending) redrawWinner.value = String(live.redrawPending);
      redrawWinner.disabled = !!(live.redrawBusy || live.redrawPending);
      showMessage('redraw-error', live.redrawError);
      redrawConfirm.disabled = !!live.redrawBusy;
      redrawCancel.disabled = live.redrawBusy || live.redrawPending;
      say('redraw-confirm', live.redrawBusy ? 'Re-drawing…' : live.redrawPending ? 'Retry re-draw' : 'Yes, re-draw');
      if (!redrawDialog.open) redrawDialog.showModal();
    } else if (redrawDialog.open) {
      redrawDialog.close();
    }
    say('projector-event', run?.receipt.eventName || eventName);
    say('projector-prize', run?.receipt.prizeName || prizeName || currentRun?.receipt.prizeName || 'Live draw');
    const caption = $('projector-caption');
    caption.toggleAttribute('data-announcement-only', run?.phase === 'hold');
    caption.toggleAttribute('data-drawing', run?.phase === 'spin' && !run.pausedAt);
    if (!run) {
      reel.idle('');
      showMessage('projector-position');
      say('projector-caption', '');
    } else {
      const done = run.phase === 'complete' || run.phase === 'summary';
      showMessage('projector-position', done ? 'Draw complete' : 'Winner ' + (run.index + 1) + ' of ' + run.receipt.count);
      say('projector-caption', done ? run.revealed + ' winners revealed' :
        run.phase === 'hold' ? run.receipt.winners[run.index] : run.pausedAt ? 'Reveal paused' : 'Drawing…');
      drawFrame();
    }
    renderResults('projector-results', run);
  }

  channel.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    live = event.data;
    render();
  });
  channel.postMessage({ type: 'ready' });
  function pollPresentation() {
    if (!document.hidden) channel.postMessage({ type: 'poll-presentation' });
  }
  document.addEventListener('visibilitychange', pollPresentation);
  setInterval(pollPresentation, 1500);
  $('fullscreen').addEventListener('click', async () => {
    try { await projector.requestFullscreen(); }
    catch (_) { say('fullscreen', 'Fullscreen unavailable'); }
  });
  function setControls(open) {
    controls.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => {
    if (document.fullscreenElement === projector) setControls(controls.hidden);
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement !== projector) {
      setControls(false);
      channel.postMessage({ type: 'redraw-cancel' });
    }
    if (live) render();
  });
  window.addEventListener('pagehide', () => channel.postMessage({ type: 'redraw-cancel' }));
  redrawButton.addEventListener('click', () => {
    if (document.fullscreenElement !== projector || !live?.canRedraw) return;
    const { receipt, index } = live.run;
    channel.postMessage({ type: 'redraw-prompt', drawTx: receipt.tx, index, throughRedrawTx: receipt.redrawTx });
  });
  redrawCancel.addEventListener('click', () => channel.postMessage({ type: 'redraw-cancel' }));
  redrawDialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!redrawCancel.disabled) channel.postMessage({ type: 'redraw-cancel' });
  });
  $('redraw-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!redrawConfirm.disabled && live?.redrawPrompt) {
      redrawConfirm.disabled = true;
      channel.postMessage({ type: 'redraw-confirm', position: Number(redrawWinner.value) });
    }
  });
  advanceSelect.addEventListener('change', () => {
    if (document.fullscreenElement !== projector || advanceSelect.disabled) return;
    channel.postMessage({ type: 'advance', value: advanceSelect.value });
  });
  actionButton.addEventListener('click', () => {
    if (document.fullscreenElement !== projector || actionButton.disabled) return;
    actionButton.disabled = true;
    const { run, drawTx } = live;
    if (run?.phase === 'hold') {
      channel.postMessage({ type: 'next', tx: run.receipt.tx, index: run.index });
    } else {
      channel.postMessage({ type: 'draw', tx: drawTx });
    }
  });
} else {
  startOperator();
}

function startOperator() {
  const reel = new Reel($('stage').querySelector('.reel'));
  const scope = 'raffle:' + location.pathname + ':';
  const savedEndpoint = scope + 'endpoint';
  const sessionKey = scope + 'connection';
  const rememberedKey = scope + 'remembered-connection';
  const projectorKey = scope + 'projector';
  const projectorId = sessionStorage.getItem(projectorKey) || crypto.randomUUID();
  const presentationOrigin = crypto.randomUUID();
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
  let selectingPrizes = false;
  let selectingArchived = false;
  let bulkRequest = null;
  const selectedPrizes = new Set();
  const selectedArchived = new Set();
  const latestDraws = new Map();
  let run = null;
  let redrawPrompt = false;
  let redrawError = '';
  let offeredDraw = null;
  let frame = 0;
  let advanceTimer = 0;
  let remotePresentation = null;
  let presentationRevision = null;
  let presentationGeneration = 0;
  let queuedPresentation = null;
  let writingPresentation = false;
  let readingPresentation = false;

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
    if (remotePresentation) {
      channel.postMessage({ type: 'state', ...remotePresentation, remote: true });
      return;
    }
    channel.postMessage({
      type: 'state', eventName: state?.eventName || 'Raffle Draw',
      prizeName: state?.prizes.find(prize => prize.id === selected)?.name || '',
      drawTx: offeredDraw?.tx, run, advance: active() ? run.advance : $('advance').value,
      advanceEditable: !!state && !!token && !active() && !mutation,
      nextReady: canAdvance(), canRedraw: canPromptRedraw(), redrawSupported: state ? !!state.redrawMode : null,
      redrawPrompt, redrawError,
      redrawBusy: redrawPrompt && mutation, redrawPending: redrawPrompt ? pendingRedraw()?.position : null
    });
  }

  function queuePresentation(kind) {
    if (!state?.presentationSync || !token) return;
    remotePresentation = null;
    presentationGeneration++;
    // Keep an unsent start when a later frame supersedes it in the queue.
    const starting = queuedPresentation?.kind === 'begin' && queuedPresentation.run?.tx === run?.receipt.tx;
    queuedPresentation = {
      kind: kind === 'continue' && starting ? 'begin' : kind,
      origin: presentationOrigin,
      eventName: run?.receipt.eventName || state.eventName,
      prizeId: run?.receipt.prizeId || selected,
      prizeName: run?.receipt.prizeName || state.prizes.find(prize => prize.id === selected)?.name || '',
      advance: run?.advance || $('advance').value,
      run: run && {
        tx: run.receipt.tx, phase: run.phase, index: run.index, revealed: run.revealed, speed: run.speed, spin: run.spin,
        namesPerSecond: run.namesPerSecond,
        redrawTx: run.receipt.redrawTx,
        paused: Boolean(run.pausedAt), elapsed: Math.min(60000, Math.max(0, (run.pausedAt ?? Date.now()) - run.start))
      }
    };
    flushPresentation();
  }

  async function flushPresentation() {
    if (writingPresentation) return;
    writingPresentation = true;
    try {
      while (queuedPresentation && token) {
        const update = queuedPresentation;
        const url = endpoint;
        const key = token;
        queuedPresentation = null;
        try {
          await api('publishPresentation', update, url, key);
        } catch (error) {
          if (endpoint !== url || token !== key) continue;
          // If a start or selection failed in transit, send the latest state once more.
          const retry = queuedPresentation || update;
          if (retry.kind === 'continue' && update.kind === 'begin' && retry.run?.tx === update.run.tx) retry.kind = 'begin';
          queuedPresentation = null;
          try { await api('publishPresentation', retry, url, key); }
          catch (_) {
            if (endpoint === url && token === key) showMessage('issue', 'Projector sync interrupted. ' + error.message);
          }
        }
      }
    } finally {
      writingPresentation = false;
    }
  }

  async function followPresentation() {
    if (!state?.presentationSync || !token || readingPresentation || writingPresentation || active()) return;
    readingPresentation = true;
    const url = endpoint;
    const key = token;
    const generation = presentationGeneration;
    try {
      const { snapshot, now } = await api('presentation', {}, url, key);
      if (snapshot?.revision === presentationRevision || (!snapshot && !remotePresentation)) return;
      let remoteRun = null;
      if (snapshot?.run && snapshot.origin !== presentationOrigin) {
        const details = snapshot.run;
        const cached = remotePresentation?.run?.receipt;
        const receipt = cached?.tx === details.tx && cached.redrawTx === details.redrawTx
          ? cached : await api('receipt', { tx: details.tx }, url, key).catch(error => {
          if (error.code !== 'NOT_FOUND') throw error;
          return null;
        });
        if (receipt && receipt.redrawTx !== details.redrawTx) return;
        if (receipt && details.index < receipt.count && details.revealed <= receipt.count) {
          const localTime = Date.now();
          const age = details.paused ? 0 : Math.max(0, now - snapshot.updatedAt);
          remoteRun = {
            ...details, receipt, advance: snapshot.advance,
            start: localTime - details.elapsed - age, pausedAt: details.paused ? localTime : null
          };
        }
      }
      if (endpoint !== url || token !== key || generation !== presentationGeneration || writingPresentation || active()) return;
      presentationRevision = snapshot?.revision || null;
      remotePresentation = snapshot && snapshot.origin !== presentationOrigin ? {
        eventName: snapshot.eventName, prizeName: snapshot.prizeName, advance: snapshot.advance, run: remoteRun
      } : null;
      publish();
    } catch (_) {
      // Keep the last rendered state while the next projector poll retries.
    } finally {
      readingPresentation = false;
    }
  }

  channel.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'ready') publish();
    if (message?.type === 'ready' || message?.type === 'poll-presentation') followPresentation();
    if (message?.type === 'draw') {
      if (offeredDraw && message.tx === offeredDraw.tx) startDraw();
      else publish();
    }
    if (message?.type === 'advance') {
      if (state && token && !active() && !mutation && ['auto', 'manual'].includes(message.value)) {
        $('advance').value = message.value;
      }
      publish();
    }
    if (message?.type === 'next') {
      if (canAdvance() && run.advance === 'manual' &&
          message.tx === run.receipt.tx && message.index === run.index) next();
      else publish();
    }
    if (message?.type === 'redraw-prompt' && canPromptRedraw() &&
        message.drawTx === run.receipt.tx && message.index === run.index &&
        message.throughRedrawTx === run.receipt.redrawTx) {
      redrawPrompt = true;
      run.pausedAt = Date.now();
      updateReveal();
    }
    if (message?.type === 'redraw-cancel' && redrawPrompt && !mutation && !pendingRedraw()) {
      redrawPrompt = false;
      redrawError = '';
      togglePause();
    }
    if (message?.type === 'redraw-confirm' && redrawPrompt && !mutation) {
      const retry = pendingRedraw();
      if (!retry && pending()) {
        redrawError = 'Resolve the pending draw before replacing this winner.';
        publish();
        return;
      }
      const position = retry?.position ?? message.position;
      if (!Number.isSafeInteger(position) || position < 1 || position > run.revealed) {
        redrawError = 'Choose a revealed winner to replace.';
        publish();
        return;
      }
      const request = retry || {
        tx: crypto.randomUUID(), started: Date.now(), drawTx: run.receipt.tx, prizeId: run.receipt.prizeId,
        position, revealed: run.revealed, throughRedrawTx: run.receipt.redrawTx, advance: run.advance,
        revealSeconds: run.spin / 1000, namesPerSecond: run.namesPerSecond, winnerSeconds: run.hold / 1000
      };
      commitDraw(request);
    }
  });

  function applyState(value) {
    state = value;
    connectionStatus('Sheets connected', 'connected');
    say('updated', 'Last synced ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    renderDashboard();
    if ($('prize-dialog').open) renderPrizeParticipants();
  }

  function connectionRecord() {
    return JSON.stringify({ endpoint, token });
  }

  function endSession(forget = true) {
    if (forget && localStorage.getItem(rememberedKey) === connectionRecord()) {
      // A signed-out marker keeps older tabs from restoring a legacy tab session.
      localStorage.setItem(rememberedKey, 'null');
    }
    sessionStorage.removeItem(sessionKey);
    token = '';
    refreshSequence++;
    state = null;
    run = null;
    redrawPrompt = false;
    redrawError = '';
    remotePresentation = null;
    presentationRevision = null;
    presentationGeneration++;
    queuedPresentation = null;
    selectingPrizes = false;
    selectingArchived = false;
    selectedPrizes.clear();
    selectedArchived.clear();
    showMessage('archive-error');
    showMessage('bulk-result');
    showMessage('archived-bulk-result');
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

  function prizeCheckbox(prize, selection) {
    const label = document.createElement('label');
    label.className = 'prize-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = prize.id;
    check.checked = selection.has(prize.id);
    check.setAttribute('aria-label', 'Select ' + prize.name);
    check.addEventListener('change', () => {
      if (check.checked) selection.add(prize.id);
      else selection.delete(prize.id);
      renderBulkActions();
    });
    label.append(check, node('span', prize.name));
    return label;
  }

  function renderArchived() {
    const prizes = state?.prizes.filter(prize => prize.archived) || [];
    const archivedIds = new Set(prizes.map(prize => prize.id));
    for (const id of selectedArchived) if (!archivedIds.has(id)) selectedArchived.delete(id);
    $('archived-select-mode').setAttribute('aria-pressed', String(selectingArchived));
    say('archived-select-mode', selectingArchived ? 'Done' : 'Select');
    $('archived-bulk-actions').hidden = !selectingArchived;
    showMessage('archived-empty', prizes.length ? '' : state ? 'No archived prizes.' : 'Connect Google Sheets to view archived prizes.');
    $('archived-list').replaceChildren(...prizes.map(prize => {
      const item = document.createElement('li');
      if (selectingArchived) {
        item.append(prizeCheckbox(prize, selectedArchived));
        return item;
      }
      const restore = node('button', 'Restore');
      restore.type = 'button';
      restore.className = 'restore-prize';
      restore.setAttribute('aria-label', 'Restore ' + prize.name);
      restore.addEventListener('click', () => setPrizeArchived(prize, false));
      item.append(node('span', prize.name), restore);
      return item;
    }));
  }

  function renderDashboard() {
    const prizes = state?.prizes.filter(prize => !prize.archived) || [];
    showMessage('total-prize-count', state ? number.format(state.prizes.length) : '');
    showMessage('archived-prize-count', state ? number.format(state.prizes.length - prizes.length) : '');
    const availableIds = new Set(prizes.map(prize => prize.id));
    for (const id of selectedPrizes) if (!availableIds.has(id)) selectedPrizes.delete(id);
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
    $('prizes-select-mode').setAttribute('aria-pressed', String(selectingPrizes));
    say('prizes-select-mode', selectingPrizes ? 'Done' : 'Select');
    $('bulk-prize-actions').hidden = !selectingPrizes;
    $('prize-row-actions').hidden = selectingPrizes;
    latestDraws.clear();
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
          ' to ALL IMS if they have no other wins. All wins for this prize will be cleared.');
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
      const nameCell = node('td', prize.name);
      if (selectingPrizes) nameCell.replaceChildren(prizeCheckbox(prize, selectedPrizes));
      actions.hidden = selectingPrizes;
      row.append(nameCell, awarded, node('td', number.format(prize.perDraw)),
        node('td', number.format(prize.remaining)), statusCell, actions);
      return row;
    }));
    showMessage('prize-empty', prizes.length ? '' : !state ? 'Prizes will appear after you connect.' :
      state.prizes.length ? 'All prizes are archived.' : 'Add the first prize to start drawing.');
    const warnings = [];
    if (state?.invalid) warnings.push(number.format(state.invalid) + ' participant rows need a valid name. Review the name column in Settings.');
    if (state?.excluded) warnings.push(number.format(state.excluded) + ' previous winners are back in ALL IMS. Remove their re-imported rows before drawing.');
    showMessage('notice', warnings.join(' '));
    if ($('archived-dialog').open) renderArchived();
    renderControls();
  }

  function active() {
    return run && (run.phase === 'spin' || run.phase === 'hold');
  }

  function winnerTimeRemaining() {
    return Math.max(0, run.start + run.hold - (run.pausedAt ?? Date.now()));
  }

  function canAdvance() {
    return run?.phase === 'hold' && !run.pausedAt && winnerTimeRemaining() === 0;
  }

  function canPromptRedraw() {
    return !!state?.redrawMode && !!token && run?.phase === 'hold' && !run.pausedAt &&
      !mutation && !pending();
  }

  function pendingRedraw() {
    const request = pending();
    return run && request?.drawTx === run.receipt.tx && request.throughRedrawTx === run.receipt.redrawTx &&
      request.position >= 1 && request.position <= run.revealed ? request : null;
  }

  function renderBulkActions() {
    const unavailable = mutation || !!active() || !!(token && pending());
    const blocked = !selectedPrizes.size || unavailable;
    say('selected-prize-count', number.format(selectedPrizes.size) + ' selected');
    say('archived-selected-count', number.format(selectedArchived.size) + ' selected');
    $('bulk-archive').disabled = blocked;
    $('bulk-delete').disabled = blocked;
    $('bulk-reset').disabled = blocked || ![...selectedPrizes].some(id => latestDraws.has(id));
    $('bulk-restore').disabled = unavailable || !selectedArchived.size;
    for (const [list, button, selection] of [
      [$('prizes'), $('prizes-select-all'), selectedPrizes],
      [$('archived-list'), $('archived-select-all'), selectedArchived]
    ]) {
      const count = list.querySelectorAll('input[type="checkbox"]').length;
      button.disabled = mutation || !count;
      say(button.id, count && selection.size === count ? 'Clear Selection' : 'Select All');
    }
  }

  function renderControls() {
    const prizes = state?.prizes.filter(item => !item.archived) || [];
    const prize = prizes.find(item => item.id === selected);
    const eligible = prize?.eligible ?? state?.eligible ?? 0;
    const count = Math.min(prize?.perDraw || 0, prize?.remaining || 0, eligible);
    const waiting = token && pending();
    const confirming = $('disconnect-dialog').open || $('reset-dialog').open || $('bulk-dialog').open || $('archived-dialog').open;
    $('prize-select').disabled = !prizes.length || mutation || !!active();
    $('prizes-select-mode').disabled = mutation || (!prizes.length && !selectingPrizes);
    $('draw').disabled = !token || !count || !!active() || mutation || confirming || !!waiting ||
      !!state?.invalid || (!!state?.excluded && !prize?.allParticipants);
    if ($('draw').disabled) offeredDraw = null;
    else if (offeredDraw?.prizeId !== selected) offeredDraw = { tx: crypto.randomUUID(), prizeId: selected };
    say('draw', mutation ? 'Saving…' : count ? 'Draw ' + number.format(count) + (count === 1 ? ' winner' : ' winners') : 'Draw winners');
    const pool = prize?.allParticipants ? ' · ' + number.format(eligible) + ' eligible, including earlier winners' : '';
    say('slots', prize ? number.format(prize.remaining) + ' winning slots remaining' + pool :
      !state ? 'Connect to load your prizes.' :
        !prizes.length && state.prizes.length ? 'All prizes are archived.' :
          prizes.length && prizes.every(item => !item.remaining) ? 'All prizes are complete.' : 'Choose an available prize.');
    $('retry').hidden = !waiting;
    $('retry').disabled = mutation || (!!active() && !waiting?.drawTx);
    for (const button of document.querySelectorAll('.reset-prize')) {
      button.disabled = !button.dataset.throughTx || mutation || !!active() || !!waiting;
    }
    for (const button of document.querySelectorAll('.archive-prize, .restore-prize')) {
      button.disabled = mutation || !!active() || !!waiting;
    }
    $('archived-select-mode').disabled = mutation ||
      (!selectingArchived && !state?.prizes.some(item => item.archived));
    for (const check of document.querySelectorAll('.prize-check input')) check.disabled = mutation;
    renderBulkActions();
    $('reveal-actions').hidden = !active();
    $('pause').disabled = !active() || redrawPrompt || (run.phase === 'hold' && run.advance === 'manual');
    $('skip').disabled = !active() || run.phase !== 'spin';
    const waitingForWinner = run?.phase === 'hold' && !canAdvance();
    $('next').disabled = !canAdvance();
    $('all').disabled = !active() || waitingForWinner;
    showMessage('winner-hold-note', waitingForWinner && run.advance === 'manual' ? holdMessage : '');
    say('next', run && run.revealed === run.receipt.count ? 'Finish draw' : 'Next winner');
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

  function updateReveal(kind = 'continue') {
    clearTimeout(advanceTimer);
    drawFrame();
    const message = run.phase === 'hold' ? run.receipt.winners[run.index] :
      run.phase === 'spin' ? (run.pausedAt ? 'Reveal paused' : 'Drawing…') : run.revealed + ' winners revealed';
    say('stage-status', run.receipt.prizeName);
    say('stage-caption', active() ? 'Winner ' + (run.index + 1) + ' of ' + run.receipt.count + ' · ' + message : message);
    renderResults('operator-results', run);
    queuePresentation(kind);
    renderControls();
    if (!run.pausedAt && run.phase === 'spin') {
      advanceTimer = setTimeout(land, Math.max(0, run.start + run.spin - Date.now()));
    } else if (run.phase === 'hold') {
      scheduleWinnerAdvance();
    }
  }

  function scheduleWinnerAdvance() {
    if (run?.phase !== 'hold' || run.pausedAt) return;
    const remaining = winnerTimeRemaining();
    if (remaining > 0) advanceTimer = setTimeout(scheduleWinnerAdvance, remaining);
    else if (run.advance === 'auto') next();
    else renderControls();
  }

  function land() {
    if (!run || run.phase !== 'spin') return;
    Object.assign(run, { phase: 'hold', start: Date.now(), pausedAt: null, revealed: Math.max(run.revealed, run.index + 1) });
    updateReveal();
  }

  function selectPrize(id) {
    selected = id;
    $('prize-select').value = id;
    if (run && !active()) {
      run = null;
      renderResults('operator-results', null);
    }
    queuePresentation('selection');
    renderControls();
  }

  function next() {
    if (!canAdvance()) return;
    if (run.revealed === run.receipt.count) {
      Object.assign(run, { phase: 'complete', pausedAt: null });
      if (run.advance === 'manual') {
        const prizes = state.prizes;
        const current = prizes.findIndex(prize => prize.id === run.receipt.prizeId);
        const nextPrize = [...prizes.slice(current + 1), ...prizes.slice(0, Math.max(0, current))]
          .find(prize => !prize.archived && prize.remaining > 0);
        if (nextPrize) {
          selectPrize(nextPrize.id);
          return;
        }
      }
    } else {
      Object.assign(run, { phase: 'spin', start: Date.now(), index: run.revealed, pausedAt: null });
    }
    updateReveal();
  }

  function begin(receipt, options = {}) {
    const speed = options.speed || 'standard';
    const seconds = options.winnerSeconds;
    const index = options.drawTx ? options.position - 1 : 0;
    run = {
      receipt, speed, advance: options.advance || $('advance').value, index,
      phase: 'spin', start: Date.now(),
      spin: duration(speed, reduceMotion.matches, options.revealSeconds ?? state?.revealSeconds),
      namesPerSecond: options.namesPerSecond,
      hold: Number.isFinite(seconds) && seconds >= 1 && seconds <= 60 ? Math.round(seconds * 1000) : HOLD[speed],
      pausedAt: null, revealed: options.drawTx ? options.revealed ?? index : 0
    };
    updateReveal('begin');
  }

  function startDraw() {
    if (!offeredDraw || pending()) return;
    commitDraw({
      ...offeredDraw, started: Date.now(), advance: $('advance').value,
      revealSeconds: state?.revealSeconds ?? DEFAULT_REVEAL_SECONDS,
      namesPerSecond: state?.namesPerSecond, winnerSeconds: state?.winnerSeconds
    });
  }

  async function commitDraw(request) {
    if (!request || mutation || (active() && !(request.drawTx && redrawPrompt))) return;
    mutation = true;
    refreshSequence++;
    savePending(request);
    showMessage('issue');
    redrawError = '';
    renderControls();
    try {
      const { tx, prizeId, drawTx, position, throughRedrawTx } = request;
      const receipt = drawTx
        ? await api('redraw', { tx, prizeId, drawTx, position, throughRedrawTx })
        : await api('draw', { tx, prizeId });
      clearPending(request.tx);
      redrawPrompt = false;
      if (token) begin(receipt, request);
    } catch (error) {
      const definitive = ['VALIDATION', 'NOT_FOUND', 'CONFLICT'].includes(error.code) ||
        (request.drawTx && error.code === 'INTEGRITY');
      if (definitive) clearPending(request.tx);
      if (request.drawTx) redrawError = error.message;
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
    const errorId = $('archived-dialog').open ? 'archived-error' : 'archive-error';
    showMessage(errorId);
    renderControls();
    try {
      const result = await api('archivePrize', { prizeId: prize.id, archived });
      if (result.archived !== archived) throw new Error('The API could not confirm the archive change. Refresh data and try again.');
      const current = state?.prizes.find(item => item.id === prize.id);
      if (!current) return;
      current.archived = archived;
      if (archived && run?.receipt.prizeId === prize.id) {
        run = null;
        renderResults('operator-results', null);
      }
    } catch (error) {
      const message = error.code === 'BAD_REQUEST' && error.message === 'Unknown action.'
        ? 'Deploy the updated Apps Script version to use prize archiving.' : error.message;
      showMessage(errorId, message);
    } finally {
      mutation = false;
      renderDashboard();
      if (document.activeElement === document.body) {
        const target = $('archived-dialog').open ? $('archived-dialog').querySelector('[data-close]') :
          $('archive-' + prize.id) || $('archived-open');
        target?.focus({ preventScroll: true });
      }
    }
  }

  function bulkTargets(action) {
    return (state?.prizes || [])
      .filter(prize => selectedPrizes.has(prize.id) && !prize.archived && (action !== 'resetPrize' || latestDraws.has(prize.id)))
      .map(prize => ({ ...prize, throughTx: latestDraws.get(prize.id) || '' }));
  }

  function confirmBulk(action) {
    const prizes = bulkTargets(action);
    if (!prizes.length) return;
    bulkRequest = { action, prizes };
    const quantity = number.format(prizes.length) + (prizes.length === 1 ? ' prize' : ' prizes');
    const deleting = action === 'deletePrize';
    say('bulk-heading', (deleting ? 'Delete ' : 'Reset ') + quantity + '?');
    say('bulk-warning', deleting
      ? 'This permanently deletes the selected prize worksheets and any remaining contents. Winners return to ALL IMS if they have no other wins.'
      : 'This clears the wins for the selected prizes. Winners return to ALL IMS if they have no other wins.');
    say('bulk-confirm', deleting ? 'Delete prizes' : 'Reset prizes');
    $('bulk-dialog').showModal();
    renderControls();
  }

  async function runBulk(action, prizes, restoring = false) {
    if (!prizes.length || !token || mutation || active() || pending()) return;
    mutation = true;
    refreshSequence++;
    const selection = restoring ? selectedArchived : selectedPrizes;
    const errorId = restoring ? 'archived-error' : 'archive-error';
    const resultId = restoring ? 'archived-bulk-result' : 'bulk-result';
    showMessage(errorId);
    showMessage(resultId, 'Updating ' + number.format(prizes.length) + ' selected ' + (prizes.length === 1 ? 'prize…' : 'prizes…'));
    if ($('bulk-dialog').open) $('bulk-dialog').close();
    renderControls();
    const failures = [];
    try {
      for (const prize of prizes) {
        try {
          await api(action, { prizeId: prize.id, throughTx: prize.throughTx, ...(action === 'archivePrize' && { archived: !restoring }) });
          const current = state?.prizes.find(item => item.id === prize.id);
          if (current && action === 'archivePrize') current.archived = !restoring;
          if (current && action === 'deletePrize') state.prizes = state.prizes.filter(item => item.id !== prize.id);
          if (run?.receipt.prizeId === prize.id) {
            run = null;
            renderResults('operator-results', null);
          }
          selection.delete(prize.id);
        } catch (error) {
          const message = error.code === 'BAD_REQUEST' && error.message === 'Unknown action.'
            ? 'Deploy the updated Apps Script version to use this action.' : error.message;
          failures.push(prize.name + ' — ' + message);
        }
      }
      await refresh(true);
    } finally {
      mutation = false;
      renderDashboard();
    }
    const successes = prizes.length - failures.length;
    const verb = restoring ? 'Restored' : action === 'archivePrize' ? 'Archived' : action === 'resetPrize' ? 'Reset' : 'Deleted';
    showMessage(resultId, successes ? verb + ' ' + number.format(successes) + (successes === 1 ? ' prize.' : ' prizes.') : '');
    showMessage(errorId, failures.length ? failures.slice(0, 3).join(' ') +
      (failures.length > 3 ? ' ' + number.format(failures.length - 3) + ' more failed.' : '') : '');
  }

  function renderPrizeParticipants() {
    const all = $('prize-all-participants').checked;
    const count = all ? state?.total : state?.eligible;
    const label = all ? ' total ' : ' eligible ';
    showMessage('prize-participants-count', Number.isFinite(count)
      ? number.format(count) + label + (count === 1 ? 'participant' : 'participants') : '');
  }

  function openPrize(prize) {
    editingPrize = prize?.id || '';
    say('prize-form-title', prize ? 'Edit prize' : 'Add prize');
    $('prize-name').value = prize?.name || '';
    $('prize-limit').value = prize?.limit || 1;
    $('prize-count').value = prize?.perDraw || 1;
    $('prize-all-participants').checked = prize?.allParticipants ?? false;
    renderPrizeParticipants();
    $('prize-all-participants').disabled = !state?.allParticipantsMode;
    say('prize-participants-hint', state?.allParticipantsMode
      ? 'Include earlier winners. Each person can win this prize once.'
      : 'Deploy the updated Apps Script version to enable this option.');
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
  for (const dialog of [$('disconnect-dialog'), $('reset-dialog'), $('bulk-dialog'), $('archived-dialog')]) {
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
    if (mutation) return;
    if (token) {
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
      token = key;
      localStorage.setItem(rememberedKey, connectionRecord());
      sessionStorage.removeItem(sessionKey);
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
    for (const [id, key, fallback] of timingFields) {
      $(id).value = state[key] ?? fallback;
      $(id).disabled = !Number.isFinite(state[key]);
    }
    showMessage('timing-update-hint', timingFields.some(([id]) => $(id).disabled)
      ? 'Deploy the updated Apps Script version to enable all timing settings.' : '');
    formError($('settings-form'));
    $('settings-dialog').showModal();
  });
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault();
    const values = { eventName: $('event-name').value, nameHeader: $('name-header').value };
    for (const [id, key] of timingFields) {
      if (!$(id).disabled) values[key] = $(id).valueAsNumber;
    }
    saveForm(event.currentTarget, 'settings', values);
  });
  $('archived-open').addEventListener('click', () => {
    selectingArchived = false;
    selectedArchived.clear();
    showMessage('archived-error');
    showMessage('archived-bulk-result');
    renderArchived();
    $('archived-dialog').showModal();
    renderControls();
  });
  $('prizes-select-mode').addEventListener('click', () => {
    selectingPrizes = !selectingPrizes;
    selectedPrizes.clear();
    showMessage('bulk-result');
    if (selectingPrizes && $('prizes-panel').hidden) $('prizes-toggle').click();
    renderDashboard();
  });
  $('archived-select-mode').addEventListener('click', () => {
    selectingArchived = !selectingArchived;
    selectedArchived.clear();
    showMessage('archived-bulk-result');
    renderArchived();
    renderControls();
  });
  for (const [list, button, selection] of [
    [$('prizes'), $('prizes-select-all'), selectedPrizes],
    [$('archived-list'), $('archived-select-all'), selectedArchived]
  ]) {
    button.addEventListener('click', () => {
      const checks = list.querySelectorAll('input[type="checkbox"]');
      const selectAll = selection.size !== checks.length;
      selection.clear();
      for (const check of checks) {
        check.checked = selectAll;
        if (selectAll) selection.add(check.value);
      }
      renderBulkActions();
    });
  }
  $('bulk-restore').addEventListener('click', () => {
    const prizes = state?.prizes.filter(prize => prize.archived && selectedArchived.has(prize.id)) || [];
    runBulk('archivePrize', prizes, true);
  });
  $('bulk-archive').addEventListener('click', () => runBulk('archivePrize', bulkTargets('archivePrize')));
  $('bulk-reset').addEventListener('click', () => confirmBulk('resetPrize'));
  $('bulk-delete').addEventListener('click', () => confirmBulk('deletePrize'));
  $('bulk-confirm').addEventListener('click', () => {
    if (bulkRequest) runBulk(bulkRequest.action, bulkRequest.prizes);
  });
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
  $('prize-all-participants').addEventListener('change', renderPrizeParticipants);
  $('prize-form').addEventListener('submit', event => {
    event.preventDefault();
    saveForm(event.currentTarget, 'prize', {
      id: editingPrize, name: $('prize-name').value, limit: $('prize-limit').valueAsNumber, perDraw: $('prize-count').valueAsNumber,
      ...(state?.allParticipantsMode && { allParticipants: $('prize-all-participants').checked })
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
    selectPrize($('prize-select').value);
  });
  $('draw').addEventListener('click', startDraw);
  $('advance').addEventListener('change', publish);
  $('retry').addEventListener('click', () => commitDraw(pending()));
  function togglePause() {
    if (!active() || redrawPrompt) return;
    const now = Date.now();
    if (run.pausedAt) {
      run.start += now - run.pausedAt;
      run.pausedAt = null;
    } else {
      run.pausedAt = now;
    }
    updateReveal();
  }
  $('pause').addEventListener('click', togglePause);
  $('skip').addEventListener('click', land);
  $('next').addEventListener('click', next);
  $('all').addEventListener('click', () => {
    if (!active() || (run.phase === 'hold' && !canAdvance())) return;
    Object.assign(run, { phase: 'summary', index: run.receipt.count - 1, revealed: run.receipt.count, pausedAt: null });
    updateReveal();
  });
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
    if (event.storageArea !== localStorage) return;
    if (token && (event.key === rememberedKey || event.key === null) &&
        localStorage.getItem(rememberedKey) !== connectionRecord()) {
      endSession(false);
    }
    if (event.key?.startsWith(pendingPrefix())) renderControls();
  });
  setInterval(() => {
    if (!document.hidden && !mutation && token) refresh();
  }, 30000);
  const remembered = localStorage.getItem(rememberedKey);
  try {
    const saved = JSON.parse(remembered ?? sessionStorage.getItem(sessionKey));
    if (typeof saved?.token === 'string' && /^[0-9a-f]{64}$/.test(saved.token)) {
      endpoint = apiURL(saved.endpoint);
      token = saved.token;
      if (remembered === null) localStorage.setItem(rememberedKey, connectionRecord());
    }
  } catch (_) {
    // An unreadable saved connection requires a new sign-in.
  }
  sessionStorage.removeItem(sessionKey);
  if (token) {
    connectionStatus('Reconnecting…', 'checking');
    say('connection', 'Disconnect');
    refresh();
  }
  renderDashboard();
}
