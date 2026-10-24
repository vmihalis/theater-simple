import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {setImmediate as nextTurn} from 'node:timers/promises';

const controller = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function until(check) {
  for (let i = 0; i < 30 && !check(); i++) await nextTurn();
  assert.ok(check(), 'Expected asynchronous controller action to complete');
}
function stream() {
  const listeners = [];
  const track = {
    readyState: 'live', label: 'Owned slideshow', stopped: false,
    addEventListener(type, callback) { if (type === 'ended') listeners.push(callback); },
    stop() { this.stopped = true; this.readyState = 'ended'; },
    end() { this.readyState = 'ended'; listeners.forEach(callback => callback()); },
  };
  return {track, getVideoTracks: () => [track], getTracks: () => [track]};
}
function fixture() {
  const elements = new Map(), captures = [], closeCalls = [], renders = [];
  const saved = new Set(['first', 'old', 'broken', 'replacement', 'older', 'newer', 'pending', 'other', 'pdf']);
  const eventHandlers = new Map();
  const serverState = () => ({app: 'theater-simple', files: [...saved].map(id => ({id, name: `${id}.pptx`, type: 'powerpoint'})), captions: {}, settings: {}});
  let currentSession = null, sessionSequence = 0;
  class Element {
    constructor() { this.listeners = new Map(); this.options = []; this.children = []; this.style = {}; this.value = ''; this.classList = {toggle() {}}; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    async dispatch(type, values = {}) { return this.listeners.get(type)?.({currentTarget: this, target: this, preventDefault() {}, ...values}); }
    querySelector() { return this.button ||= new Element(); }
    replaceChildren(...children) { this.children = children; this.options = children; }
    append(...children) { this.children.push(...children); }
    add(option) { this.options.push(option); }
    setAttribute() {}
    closest() { return null; }
  }
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const desktop = {
    async openPowerPoint(id) { currentSession = `${id}-${++sessionSequence}`; return {token: currentSession}; },
    async closePowerPoint(token) { closeCalls.push(token); if (token === undefined || token === currentSession) currentSession = null; },
    async powerPointError() { return ''; },
    async powerPointCommand() { return {slide: 1, slides: 2, click: 0, clicks: 2}; },
    async closeWebsite() {},
    async openWebsite() { currentSession = null; },
    async focusWebsite() {},
  };
  const location = {origin: 'http://127.0.0.1:43120'};
  const context = vm.createContext({
    document: {getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {}},
    window: {theaterDesktop: desktop, addEventListener() {}}, location, URL,
    navigator: {mediaDevices: {getDisplayMedia() { const capture = deferred(); captures.push(capture); return capture.promise; }, async enumerateDevices() { return []; }}},
    createProgram: () => ({render(value) { renders.push(value); }, close() {}}), AudioCapture: class {},
    EventSource: class { static OPEN = 1; addEventListener(type, callback) { eventHandlers.set(type, callback); } close() {} },
    Option: class { constructor(text, value) { Object.assign(this, {text, value}); } },
    fetch: async (url, options) => {
      if (url === '/api/remove-file') saved.delete(JSON.parse(options.body).id);
      if (url === '/api/clear-files') saved.clear();
      return Response.json(url === '/api/state' ? serverState() : {ok: true, state: serverState()});
    },
    confirm: () => true,
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
  });
  vm.runInContext(controller, context, {filename: 'public/app.js'});
  function show(id) { context.selectedFile = {id, name: `${id}.pptx`, type: 'powerpoint'}; return vm.runInContext('showFile(selectedFile)', context); }
  return {element, captures, closeCalls, renders, desktop, show,
    get currentSession() { return currentSession; },
    get picture() { return renders.at(-1).source; },
    pollPosition() { return vm.runInContext('updatePowerPointPosition()', context); },
    remove(id) { context.selectedFile = {id, name: `${id}.pptx`}; return vm.runInContext('removeFile(selectedFile)', context); },
    clear() { return element('clear-files').dispatch('click'); },
    showPdf(id) { context.selectedFile = {id, name: `${id}.pdf`, type: 'pdf'}; vm.runInContext('showPdf(selectedFile)', context); },
    pushFiles(ids) {
      saved.clear(); ids.forEach(id => saved.add(id));
      eventHandlers.get('state')({data: JSON.stringify(serverState())});
    },
    async connected(id) {
      const before = captures.length, opening = show(id);
      await until(() => captures.length > before);
      const picture = stream(); captures.at(-1).resolve(picture); await opening;
      return picture;
    },
  };
}

test('cancelling the window picker retains PowerPoint and its eventual ended cleanup', async () => {
  const f = fixture(), picture = await f.connected('first'), token = f.currentSession;
  const choosing = f.element('choose-source').dispatch('click');
  await until(() => f.captures.length === 2);
  f.captures[1].reject(Object.assign(new Error('Cancelled'), {name: 'NotAllowedError'}));
  await choosing;
  assert.equal(f.picture, picture);
  assert.equal(f.element('pdf-controls').hidden, false);
  picture.track.end();
  assert.equal(f.picture, null);
  assert.equal(f.element('pdf-controls').hidden, true);
  assert.deepEqual(f.closeCalls, [token]);
  assert.equal(f.currentSession, null);
});

test('failed replacement retires the old picture and late old-ended events cannot close another deck', async () => {
  const f = fixture(), old = await f.connected('old');
  const replacing = f.show('broken');
  await until(() => f.captures.length === 2);
  const brokenToken = f.currentSession;
  assert.equal(f.picture, null, 'The old native show is closing, so its picture must not remain active');
  assert.equal(old.track.stopped, true);
  f.captures[1].reject(new Error('PowerPoint could not open this file'));
  await replacing;
  assert.equal(f.picture, null);
  assert.deepEqual(f.closeCalls, [brokenToken]);
  const current = await f.connected('replacement'), currentToken = f.currentSession;
  old.track.end();
  assert.equal(f.picture, current);
  assert.equal(f.currentSession, currentToken);
  assert.deepEqual(f.closeCalls, [brokenToken]);
});

test('a delayed obsolete capture is stopped and closes only its own native session', async () => {
  const f = fixture();
  const older = f.show('older'); await until(() => f.captures.length === 1);
  const olderToken = f.currentSession;
  const newer = f.show('newer'); await until(() => f.captures.length === 2);
  const newerToken = f.currentSession, current = stream();
  f.captures[1].resolve(current); await newer;
  const obsolete = stream(); f.captures[0].resolve(obsolete); await older;
  assert.equal(obsolete.track.stopped, true);
  assert.equal(f.picture, current);
  assert.equal(f.currentSession, newerToken);
  assert.deepEqual(f.closeCalls, [olderToken]);
});

test('a failed website switch clears the closing native slideshow without affecting later content', async () => {
  const f = fixture(), old = await f.connected('old');
  f.element('website-url').value = 'https://example.com';
  const switching = f.element('website-form').dispatch('submit');
  await until(() => f.captures.length === 2);
  assert.equal(f.picture, null);
  f.captures[1].reject(new Error('Website failed')); await switching;
  assert.equal(f.picture, null);
  const current = await f.connected('newer'), token = f.currentSession;
  old.track.end();
  assert.equal(f.picture, current);
  assert.equal(f.currentSession, token);
  assert.deepEqual(f.closeCalls, []);
});

test('removing a playing native PowerPoint stops its picture and closes only its session', async () => {
  const f = fixture(), picture = await f.connected('first'), token = f.currentSession;
  await f.remove('first');
  assert.equal(picture.track.stopped, true);
  assert.equal(f.picture, null);
  assert.equal(f.element('pdf-controls').hidden, true);
  assert.deepEqual(f.closeCalls, [token]);
  assert.equal(f.currentSession, null);
});

test('clearing presentations closes a playing native PowerPoint', async () => {
  const f = fixture(), picture = await f.connected('first'), token = f.currentSession;
  await f.clear();
  assert.equal(picture.track.stopped, true);
  assert.equal(f.picture, null);
  assert.deepEqual(f.closeCalls, [token]);
});

test('removing a pending PowerPoint cannot close a replacement when its capture arrives late', async () => {
  const f = fixture();
  const pending = f.show('pending'); await until(() => f.captures.length === 1);
  const pendingToken = f.currentSession;
  await f.remove('pending');
  const current = await f.connected('newer'), currentToken = f.currentSession;
  const obsolete = stream(); f.captures[0].resolve(obsolete); await pending;
  assert.equal(obsolete.track.stopped, true);
  assert.equal(f.picture, current);
  assert.equal(f.currentSession, currentToken);
  assert.ok(f.closeCalls.includes(pendingToken));
  assert.ok(!f.closeCalls.includes(currentToken));
});

test('server state removes a deleted native deck from the preview and projector', async () => {
  const f = fixture(), picture = await f.connected('first'), token = f.currentSession;
  f.pushFiles(['other']);
  assert.equal(picture.track.stopped, true);
  assert.equal(f.picture, null);
  assert.deepEqual(f.closeCalls, [token]);
});

test('server state cancels a pending native deck without closing a later show', async () => {
  const f = fixture();
  const pending = f.show('pending'); await until(() => f.captures.length === 1);
  const pendingToken = f.currentSession;
  f.pushFiles(['newer']);
  const current = await f.connected('newer'), currentToken = f.currentSession;
  const obsolete = stream(); f.captures[0].resolve(obsolete); await pending;
  assert.equal(obsolete.track.stopped, true);
  assert.equal(f.picture, current);
  assert.ok(f.closeCalls.includes(pendingToken));
  assert.ok(!f.closeCalls.includes(currentToken));
});

test('server state removes a deleted PDF from the preview and projector', () => {
  const f = fixture();
  f.showPdf('pdf');
  assert.equal(f.renders.at(-1).pdf.id, 'pdf');
  f.pushFiles(['other']);
  assert.equal(f.renders.at(-1).pdf, null);
  assert.equal(f.element('pdf-controls').hidden, true);
});

test('a successful click with unknown position waits for a status refresh', async () => {
  const f = fixture(); await f.connected('first');
  f.desktop.powerPointCommand = async action => action === 'next' ? {positionUnknown: true} : {slide: 1, slides: 2, click: 0, clicks: 2};
  await f.element('pdf-next').dispatch('click');
  await until(() => f.element('pdf-page-status').textContent === 'Live PowerPoint');
  assert.equal(f.element('pdf-page-status').textContent, 'Live PowerPoint');
  assert.equal(f.element('pdf-next').disabled, false);
});

test('position polling sends only one status request per active slideshow while PowerPoint is busy', async () => {
  const f = fixture(); await f.connected('first');
  const pending = deferred();
  let calls = 0;
  f.desktop.powerPointCommand = async action => {
    assert.equal(action, 'status');
    calls++;
    return pending.promise;
  };
  const first = f.pollPosition();
  await Promise.all([f.pollPosition(), f.pollPosition(), f.pollPosition()]);
  assert.equal(calls, 1, 'Repeated timer ticks must not queue behind a busy COM request');
  pending.resolve({slide: 1, slides: 2, click: 1, clicks: 2});
  await first;
  await f.pollPosition();
  assert.equal(calls, 2, 'Polling resumes after the prior request finishes');
});

test('a stuck status request for an old deck cannot block polling its replacement', async () => {
  const f = fixture(); await f.connected('first');
  const oldToken = f.currentSession, oldStatus = deferred();
  let newStatusCalls = 0;
  f.desktop.powerPointCommand = async action => {
    assert.equal(action, 'status');
    if (f.currentSession === oldToken) return oldStatus.promise;
    newStatusCalls++;
    return {slide: 1, slides: 2, click: 0, clicks: 2};
  };
  const pollingOld = f.pollPosition();
  const replacement = await f.connected('newer');
  assert.equal(newStatusCalls, 1, 'The new deck should get its own status immediately');
  oldStatus.resolve({slide: 99, slides: 99, click: 99, clicks: 99});
  await pollingOld;
  assert.equal(f.picture, replacement);
  assert.match(f.element('pdf-page-status').textContent, /Slide 1 of 2/);
});
