import { AudioCapture } from '/audio-capture.js';
import { createProgram } from '/program.js';
const $ = id => document.getElementById(id);
let state = null;
let serverConnected = false;
let fileSignature = '';
let directionDirty = false;
let source = null;
let sourceKind = null;
let camera = null;
let stageWindow = null;
let mode = 'holding';
let sourceGeneration = 0;
let cameraGeneration = 0;
let choosingSource = false;
let choosingCamera = false;
let capture = null;
let captionStarting = false;
let captionRunning = false;
let captionStopping = false;
let captionGeneration = 0;
let noticeTimer;
let contentGeneration = 0;
let pdf = null;
let pdfPageCount = 0;
let pdfReady = false;
let powerPointName = '';
let powerPointBusy = false;
let powerPointPosition = null;
let nativePowerPoint = null;
let powerPointStatusInFlight = null;
const program = createProgram({ program: $('program'), video: $('preview-video'), pdfCanvas: $('preview-pdf'), camera: $('preview-camera'), placeholder: $('preview-placeholder'), captions: $('preview-captions'), text: $('preview-caption-text'), onPdfStatus(value) {
  if (!pdf) return;
  pdfPageCount = value.pageCount || 0;
  pdfReady = value.status === 'ready';
  $('pdf-page-status').textContent = value.status === 'error' ? value.error : pdfPageCount ? `${pdf.type === 'powerpoint' ? 'Slide' : 'Page'} ${pdf.page} of ${pdfPageCount}${pdfReady ? '' : ' · Loading…'}` : 'Loading presentation…';
  updateButtons();
} });

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 14000 : 8000);
}
async function api(path, body, options = {}) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...options });
  const payload = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof payload === 'object' ? payload.error || payload.message || `Request failed (${response.status}).` : payload || `Request failed (${response.status}).`);
  return payload;
}
async function withButton(button, action) {
  button.disabled = true;
  try { return await action(); } catch (error) { notice(error.message || String(error), true); }
  finally { button.disabled = false; updateButtons(); }
}
function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
function streamActive(stream) { return !!stream?.getVideoTracks().some(track => track.readyState === 'live'); }
function publish() {
  program.render({ mode, source, pdf, camera, caption: serverConnected ? state?.captions?.translation || '' : '', captionsEnabled: serverConnected && state?.captions?.enabled !== false });
  try { if (stageWindow && !stageWindow.closed && stageWindow.TheaterStage) stageWindow.TheaterStage.update({ mode, source, pdf, camera }); } catch { /* A closed or navigated output is handled by its status below. */ }
  $('pdf-controls').hidden = !pdf && sourceKind !== 'powerpoint';
  $('pdf-name').textContent = pdf?.name || (sourceKind === 'powerpoint' ? powerPointName : '');
  $('focus-powerpoint').hidden = sourceKind !== 'powerpoint';
  if (sourceKind === 'powerpoint') $('pdf-page-status').textContent = powerPointPosition ? `Slide ${powerPointPosition.slide} of ${powerPointPosition.slides} · Animation ${Math.max(0, powerPointPosition.click)} of ${powerPointPosition.clicks}` : 'Live PowerPoint';
  $('browse-website').hidden = sourceKind !== 'website' || !window.theaterDesktop;
  $('zoom-help').textContent = pdf || window.theaterDesktop && source ? 'In Zoom, share the Theater Simple · Projector window. Your presentation and captions appear together.' : 'In Zoom, share the original presentation window and use Zoom translated captions. A remote presenter can share normally.';
  $('mode-label').textContent = mode === 'live' ? 'LIVE PRESENTATION' : mode.toUpperCase();
  document.querySelectorAll('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  updateButtons();
}
function updateButtons() {
  const captionsBusy = captionStarting || captionRunning || captionStopping;
  const serverBusy = ['connecting', 'streaming', 'stopping'].includes(typeof state?.captions?.status === 'string' ? state.captions.status : state?.captions?.status?.state);
  $('choose-source').disabled = choosingSource;
  $('website-button').disabled = choosingSource;
  $('choose-source').textContent = source ? 'Change window' : 'Choose window';
  $('stop-source').disabled = !source && !choosingSource;
  $('pdf-previous').disabled = !pdfReady || !pdf || pdf.page <= 1;
  $('pdf-next').disabled = !pdfReady || !pdf || pdf.page >= pdfPageCount;
  if (sourceKind === 'powerpoint') { $('pdf-previous').disabled = powerPointBusy; $('pdf-next').disabled = powerPointBusy; }
  $('start-camera').disabled = choosingCamera || !!camera;
  $('stop-camera').disabled = !camera && !choosingCamera;
  $('start-captions').disabled = captionsBusy || serverBusy || !serverConnected || !state?.captions?.hasKey;
  $('stop-captions').disabled = captionStopping || (!captionStarting && !captionRunning);
  $('caption-direction').disabled = captionsBusy || serverBusy;
  $('microphone-device').disabled = captionsBusy;
  $('refresh-microphones').disabled = captionsBusy;
  $('test-caption-button').disabled = captionsBusy || serverBusy || !serverConnected;
  $('caption-api-key').disabled = captionsBusy || serverBusy;
  $('caption-key-form').querySelector('button').disabled = captionsBusy || serverBusy || !serverConnected;
}
function setConnection(connected) {
  serverConnected = connected;
  $('connection-status').textContent = connected ? 'LOCAL APP CONNECTED' : 'RECONNECTING…';
  $('connection-status').classList.toggle('connected', connected);
  $('connection-status').classList.toggle('error', !connected);
  if (!connected) { $('caption-original').textContent = 'Connection lost. Reconnecting…'; $('caption-translation').textContent = 'Caption text cleared while disconnected.'; }
  publish();
}
function captionStatus(value) {
  const status = typeof value === 'string' ? value : value?.state || value?.status || 'idle';
  const message = typeof value === 'object' ? value.message : '';
  const labels = { idle: 'Not running', test: 'Test text', connecting: 'Connecting…', streaming: 'Listening', stopping: 'Finishing…', stopped: 'Stopped', error: 'Caption error' };
  $('caption-status').textContent = labels[status] || status;
  $('caption-status').classList.toggle('running', status === 'streaming');
  $('caption-status').classList.toggle('error', status === 'error');
  $('caption-detail').textContent = message || (status === 'streaming' ? 'Speech is being translated. Keep this control panel open.' : state?.captions?.hasKey ? 'Ready to use the selected microphone. Stop captions before changing language.' : 'Add your Soniox key below, then start captions.');
}
function renderFiles(files) {
  const signature = JSON.stringify(files);
  if (signature === fileSignature) return;
  fileSignature = signature;
  $('file-list-tools').hidden = !files.length;
  $('file-list-summary').textContent = `${files.length} ${files.length === 1 ? 'presentation' : 'presentations'}, A to Z`;
  $('file-list').replaceChildren();
  if (!files.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Your files will appear here.'; $('file-list').append(empty); }
  files.forEach(file => {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = file.type === 'pdf' ? 'PDF' : 'PPT';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
    const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = 'Show'; button.setAttribute('aria-label', `Show ${file.name}`);
    button.addEventListener('click', () => showFile(file));
    const remove = document.createElement('button'); remove.className = 'button quiet small'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${file.name} from the list`);
    remove.addEventListener('click', () => withButton(remove, () => removeFile(file)));
    row.append(icon, name, button, remove); $('file-list').append(row);
  });
}
async function removeFile(file) {
  const result = await api('/api/remove-file', { id: file.id });
  forgetShown([file.id]);
  renderState(result.state);
  notice(`${file.name} was removed from the list.`);
}
// A removed presentation must leave the preview and projector as well.
function forgetShown(ids) {
  const removedPdf = pdf && ids.includes(pdf.id);
  const removedNative = nativePowerPoint && ids.includes(nativePowerPoint.id) ? nativePowerPoint : null;
  if (!removedPdf && !removedNative) return;
  contentGeneration++;
  if (removedNative) {
    sourceGeneration++;
    choosingSource = false;
    nativePowerPoint = null;
    detachPowerPointSource();
    if (removedNative.token) window.theaterDesktop.closePowerPoint(removedNative.token).catch(() => {});
    $('source-status').textContent = 'PowerPoint removed. Choose another presentation to continue.';
    $('content-status').hidden = true;
  }
  if (removedPdf) { pdf = null; pdfReady = false; pdfPageCount = 0; $('pdf-page-status').textContent = ''; }
  publish();
}
function renderState(next) {
  if (!next || next.app !== 'theater-simple') throw new Error('This is not the Theater Simple server.');
  const available = new Set((next.files || []).map(file => file.id));
  forgetShown([pdf?.id, nativePowerPoint?.id].filter(id => id && !available.has(id)));
  state = next;
  $('app-version').textContent = state.version ? `THEATER SIMPLE ${state.version}` : 'THEATER SIMPLE';
  renderFiles(state.files || []);
  $('caption-original').textContent = state.captions?.original || 'Speech will appear here.';
  $('caption-translation').textContent = state.captions?.translation || 'Translation will appear here.';
  $('captions-visible').checked = state.captions?.enabled !== false;
  $('key-status').textContent = state.captions?.hasKey ? 'Session key ready' : 'Key not set';
  if (!directionDirty) $('caption-direction').value = state.settings?.targetLanguage === 'en' ? 'ja-en' : 'en-ja';
  if (!captionStarting && !captionStopping) captionStatus(state.captions?.status || 'idle');
  if (state.captions?.error) $('caption-detail').textContent = typeof state.captions.error === 'string' ? state.captions.error : 'Caption service reported an error.';
  setConnection(true);
}
async function refreshState() { const result = await api('/api/state'); renderState(result); return result; }

async function showFile(file) {
  const generation = ++contentGeneration;
  $('content-status').hidden = false;
  $('content-status').textContent = file.type === 'powerpoint' ? `Preparing ${file.name}…` : '';
  try {
    if (file.type === 'powerpoint') {
      if (window.theaterDesktop?.openPowerPoint) { await showPowerPoint(file, generation); return; }
      const result = await api('/api/prepare-file', { id: file.id });
      if (generation !== contentGeneration) return;
      file = result.file;
    }
    showPdf(file);
  } catch (error) {
    if (generation === contentGeneration) notice(error.message || 'Could not prepare this presentation.', true);
  } finally { if (generation === contentGeneration) $('content-status').hidden = true; }
}

function detachPowerPointSource() {
  if (sourceKind !== 'powerpoint') return;
  const previous = source;
  nativePowerPoint = null;
  source = null; sourceKind = null; powerPointName = ''; powerPointPosition = null; powerPointBusy = false;
  stopTracks(previous);
  publish();
}
async function showPowerPoint(file, generation) {
  const sourceToken = ++sourceGeneration;
  choosingSource = true; updateButtons();
  // Opening another native show closes the old one, even if the new file fails.
  // Retire its picture first so its queued ended event cannot affect a replacement.
  detachPowerPointSource();
  const native = { id: file.id, token: null };
  nativePowerPoint = native;
  let selected, nativeSession;
  try {
    const opened = await window.theaterDesktop.openPowerPoint(file.id);
    nativeSession = opened.token;
    native.token = nativeSession;
    if (generation !== contentGeneration || sourceToken !== sourceGeneration || nativePowerPoint !== native) { await window.theaterDesktop.closePowerPoint(nativeSession); return; }
    selected = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    if (generation !== contentGeneration || sourceToken !== sourceGeneration || nativePowerPoint !== native) { stopTracks(selected); await window.theaterDesktop.closePowerPoint(nativeSession); return; }
    const track = selected.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('PowerPoint picture did not connect.');
    stopTracks(source); source = selected; sourceKind = 'powerpoint'; powerPointName = file.name; powerPointPosition = null;
    pdf = null; pdfReady = false; pdfPageCount = 0; mode = 'live';
    track.addEventListener('ended', () => {
      // A cancelled picker changes the attempt generation, but this remains the
      // active picture. Stream identity determines which ended event is current.
      if (source !== selected) return;
      detachPowerPointSource();
      window.theaterDesktop.closePowerPoint(nativeSession).catch(() => {});
      notice('PowerPoint slideshow ended. Click Show on the file to restart it.');
    });
    $('source-status').textContent = 'Live PowerPoint connected. Next plays the next animation or slide.';
    $('window-options').open = false;
    publish();
    notice('PowerPoint ready, with animations. Use Next or your clicker here.');
    await updatePowerPointPosition();
  } catch (error) {
    if (selected && selected !== source) stopTracks(selected);
    const detail = generation === contentGeneration && sourceToken === sourceGeneration ? await window.theaterDesktop.powerPointError().catch(() => '') : '';
    if (nativeSession !== undefined) await window.theaterDesktop.closePowerPoint(nativeSession).catch(() => {});
    if (generation === contentGeneration && sourceToken === sourceGeneration) {
      throw new Error(detail || error.message || 'Could not open the PowerPoint slideshow.');
    }
  } finally {
    if (nativePowerPoint === native && sourceKind !== 'powerpoint') nativePowerPoint = null;
    if (sourceToken === sourceGeneration) { choosingSource = false; updateButtons(); }
  }
}
async function updatePowerPointPosition() {
  if (sourceKind !== 'powerpoint' || powerPointBusy || !nativePowerPoint || powerPointStatusInFlight === nativePowerPoint) return;
  const current = source, native = nativePowerPoint;
  powerPointStatusInFlight = native;
  try {
    const result = await window.theaterDesktop.powerPointCommand('status');
    if (source === current && nativePowerPoint === native && sourceKind === 'powerpoint') { powerPointPosition = result; publish(); }
  } catch { /* The capture-ended event handles a closed slideshow. */ }
  finally { if (powerPointStatusInFlight === native) powerPointStatusInFlight = null; }
}
setInterval(updatePowerPointPosition, 1500);
async function advancePowerPoint(delta) {
  if (powerPointBusy || sourceKind !== 'powerpoint') return;
  powerPointBusy = true; updateButtons(); const current = source;
  try {
    const result = await window.theaterDesktop.powerPointCommand(delta > 0 ? 'next' : 'previous');
    if (source === current) powerPointPosition = result.positionUnknown ? null : result;
  }
  catch (error) { if (source === current) notice(error.message, true); }
  finally { if (source === current) { powerPointBusy = false; publish(); } }
}
$('focus-powerpoint').addEventListener('click', () => window.theaterDesktop.powerPointCommand('focus').catch(error => notice(error.message, true)));

function showPdf(file) {
  sourceGeneration++; choosingSource = false;
  nativePowerPoint = null;
  stopTracks(source); source = null; sourceKind = null;
  window.theaterDesktop?.closeWebsite().catch(() => {});
  window.theaterDesktop?.closePowerPoint?.().catch(() => {});
  pdf = null; publish();
  pdfPageCount = 0; pdfReady = false;
  pdf = { id: file.id, name: file.name, type: file.type, url: file.presentationUrl || `/files/${encodeURIComponent(file.id)}`, page: 1 };
  mode = 'live';
  $('source-status').textContent = 'Presentation is shown directly. No window selection needed.';
  $('window-options').open = false;
  publish();
  notice('Presentation ready. Use Previous and Next below the preview.');
}
function changePdfPage(delta) {
  if (sourceKind === 'powerpoint') { advancePowerPoint(delta); return; }
  if (!pdf || !pdfReady) return;
  const page = Math.max(1, Math.min(pdfPageCount, pdf.page + delta));
  if (page === pdf.page) return;
  pdf = { ...pdf, page }; pdfReady = false; publish();
}
$('pdf-previous').addEventListener('click', () => changePdfPage(-1));
$('pdf-next').addEventListener('click', () => changePdfPage(1));
document.addEventListener('keydown', event => {
  if ((!pdf && sourceKind !== 'powerpoint') || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('input,textarea,select,[contenteditable]')) return;
  if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp', 'ArrowDown', 'ArrowUp', ' '].includes(event.key)) {
    event.preventDefault(); changePdfPage(['ArrowRight', 'PageDown', 'ArrowDown', ' '].includes(event.key) ? 1 : -1);
  }
});

function openContent(url) {
  // Reserve a fresh window during this click, then remove its access to the controller.
  const content = window.open('about:blank', '_blank', 'popup=yes,width=1280,height=800');
  if (!content) { notice('Your browser blocked the content window. Allow popups for this local app, then click Open again.', true); return; }
  content.opener = null;
  content.location.replace(url);
  notice('Content opened separately. Click Choose window to connect it.');
}
$('website-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (choosingSource) return;
  let selected;
  const generation = ++sourceGeneration;
  contentGeneration++; $('content-status').hidden = true;
  try {
    let value = $('website-url').value.trim();
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use a website address beginning with https:// or http://.');
    if (url.username || url.password) throw new Error('Enter a website address without a username or password.');
    if (!window.theaterDesktop) { openContent(url.href); $('window-options').open = true; return; }
    choosingSource = true; updateButtons();
    notice('Opening website…');
    detachPowerPointSource();
    nativePowerPoint = null;
    await window.theaterDesktop.openWebsite(url.href);
    if (generation !== sourceGeneration) return;
    selected = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (generation !== sourceGeneration) { stopTracks(selected); return; }
    const track = selected.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('The website picture could not connect. Click Show website to try again.');
    const previous = source; source = selected; sourceKind = 'website'; stopTracks(previous);
    pdf = null; pdfReady = false; pdfPageCount = 0; mode = 'live';
    track.addEventListener('ended', () => { if (source !== selected) return; source = null; sourceKind = null; publish(); notice('Website window closed. Enter its address to show it again.'); });
    $('source-status').textContent = `Website: ${url.hostname}`;
    $('window-options').open = false;
    publish();
    notice('Website connected. Browse in its window; the projector follows with captions.');
  } catch (error) {
    if (selected && selected !== source) stopTracks(selected);
    if (generation === sourceGeneration) notice(error.message || 'Could not show this website.', true);
  } finally { if (generation === sourceGeneration) { choosingSource = false; updateButtons(); } }
});
$('browse-website').addEventListener('click', () => window.theaterDesktop?.focusWebsite().catch(error => notice(error.message, true)));
$('open-desktop').hidden = !!window.theaterDesktop;
$('website-help').textContent = window.theaterDesktop ? 'Browse in the website window; its picture connects automatically with captions.' : 'For automatic website display, use Open desktop app. In this browser, PowerPoint is static and websites need Choose window.';
$('open-desktop').addEventListener('click', event => withButton(event.currentTarget, async () => { await api('/api/open-desktop', {}); notice('Desktop app opened. Use that window for PowerPoint animations and automatic website display.'); }));
document.querySelector('.help-link').addEventListener('click', event => {
  if (!window.theaterDesktop) return;
  event.preventDefault();
  $('website-url').value = new URL('/demo', location.origin).href;
  $('website-form').requestSubmit();
});
$('upload-button').addEventListener('click', () => $('upload-input').click());
$('clear-files').addEventListener('click', () => withButton($('clear-files'), async () => {
  const files = state?.files || [];
  if (!files.length) return;
  if (!confirm(`Remove all ${files.length} presentations from the list?\n\nTheir copies in the app's data folder are deleted. Your original files stay where they are.`)) return;
  const result = await api('/api/clear-files', {});
  forgetShown(files.map(file => file.id));
  renderState(result.state);
  notice('The presentation list was cleared.');
}));
$('upload-input').addEventListener('change', async () => {
  const files = Array.from($('upload-input').files || []);
  if (!files.length) return;
  if (files.some(file => !/\.(pdf|ppt|pptx|pps|ppsx)$/i.test(file.name))) { notice('Choose PDF or PowerPoint files (.pdf, .ppt, .pptx, .pps, .ppsx).', true); $('upload-input').value = ''; return; }
  $('upload-button').disabled = true; $('upload-status').hidden = false;
  try {
    const generation = ++contentGeneration;
    let firstFile = null;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; $('upload-status').textContent = `Adding ${index + 1} of ${files.length}: ${file.name}`;
      const result = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, undefined, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!firstFile) firstFile = result.file;
    }
    await refreshState();
    if (firstFile && generation === contentGeneration) await showFile(firstFile);
  } catch (error) { notice(error.message, true); await refreshState().catch(() => {}); }
  finally { $('upload-button').disabled = false; $('upload-status').hidden = true; $('upload-input').value = ''; }
});

$('choose-source').addEventListener('click', async () => {
  if (choosingSource) return;
  contentGeneration++; $('content-status').hidden = true;
  const generation = ++sourceGeneration;
  choosingSource = true; updateButtons();
  let selected;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Open Theater Simple in current Microsoft Edge or Chrome on this PC.');
    selected = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude' });
    if (generation !== sourceGeneration) { stopTracks(selected); return; }
    const track = selected.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('The selected window could not be captured. Please try again.');
    const previous = source; source = selected; sourceKind = 'window'; stopTracks(previous); pdf = null; pdfReady = false; pdfPageCount = 0;
    // Leave an owned slideshow running if the operator manually selected it.
    track.addEventListener('ended', () => { if (source !== selected) return; source = null; sourceKind = null; $('source-status').textContent = 'Sharing stopped. Choose a presentation window to resume.'; publish(); });
    $('source-status').textContent = `Selected: ${track.label || 'Presentation window'}`;
    notice('Picture connected. Use Live presentation to show it on the projector.');
    publish();
  } catch (error) {
    if (selected && selected !== source) stopTracks(selected);
    if (generation === sourceGeneration) notice(error.name === 'NotAllowedError' || error.name === 'AbortError' ? (source || pdf ? 'Window selection cancelled. Your previous presentation is still connected.' : 'No window selected. Choose window when ready.') : error.message, !['NotAllowedError', 'AbortError'].includes(error.name));
  } finally { if (generation === sourceGeneration) { choosingSource = false; updateButtons(); } }
});
$('stop-source').addEventListener('click', () => { sourceGeneration++; contentGeneration++; choosingSource = false; nativePowerPoint = null; stopTracks(source); source = null; sourceKind = null; window.theaterDesktop?.closePowerPoint?.().catch(() => {}); $('source-status').textContent = 'Presentation picture stopped. Choose a window to resume.'; publish(); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; publish(); }));
$('open-projector').addEventListener('click', () => {
  if (stageWindow && !stageWindow.closed) { try { if (stageWindow.location.origin === location.origin) { stageWindow.focus(); publish(); return; } } catch {} }
  stageWindow = window.open('/stage.html', 'theater-simple-projector', 'popup=yes,width=1280,height=760');
  if (!stageWindow) { $('projector-status').textContent = 'Popup blocked. Allow popups for this local app, then try again.'; notice('Allow popups for this local app to open the projector window.', true); return; }
  $('projector-status').textContent = 'Projector window opened. Move it to the theater screen, then click Full screen.';
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== stageWindow) return;
  if (event.data?.type === 'theater-stage-ready') publish();
  if (event.data?.type === 'theater-advance' && [-1, 1].includes(event.data.delta) && mode === 'live') changePdfPage(event.data.delta);
});
setInterval(() => { if (stageWindow?.closed) { stageWindow = null; $('projector-status').textContent = 'Projector window closed. Open it again when ready.'; } }, 1500);

function languageSettings() { return $('caption-direction').value === 'ja-en' ? { targetLanguage: 'en', sourceLanguages: ['ja'] } : { targetLanguage: 'ja', sourceLanguages: ['en'] }; }
$('caption-direction').addEventListener('change', () => { directionDirty = true; });
$('caption-key-form').addEventListener('submit', event => { event.preventDefault(); withButton(event.currentTarget.querySelector('button'), async () => {
  const input = $('caption-api-key'); const key = input.value.trim(); if (!key) throw new Error('Paste your Soniox key first.');
  try { await api('/api/caption-key', { key }); } finally { input.value = ''; }
  await refreshState(); notice('Soniox key saved for this session.');
}); });
async function listInputs(kind, selectId, defaultLabel) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === kind);
  const select = $(selectId); const previous = select.value;
  select.replaceChildren(new Option(defaultLabel, ''));
  devices.forEach((device, index) => select.add(new Option(device.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`, device.deviceId)));
  if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
}
$('refresh-microphones').addEventListener('click', event => withButton(event.currentTarget, async () => {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs current Edge or Chrome on localhost.');
  const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stopTracks(permissionStream);
  await listInputs('audioinput', 'microphone-device', 'System default microphone');
  notice('Microphones refreshed. Select the input carrying the speaker’s voice.');
}));
function setLevel(level) { const value = Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * 100); $('audio-level-fill').style.width = `${value}%`; $('audio-level-fill').parentElement.setAttribute('aria-valuenow', String(value)); }
$('start-captions').addEventListener('click', async () => {
  if (captionStarting || captionRunning || captionStopping) return;
  const generation = ++captionGeneration;
  const current = () => generation === captionGeneration;
  captionStarting = true; updateButtons(); captionStatus({ state: 'connecting', message: 'Preparing microphone…' });
  let localCapture;
  try {
    const settings = languageSettings();
    await api('/api/caption-settings', settings); if (!current()) return;
    directionDirty = false;
    localCapture = new AudioCapture({
      onStatus: value => { if (!current()) return; captionStatus(value); if (['error', 'stopped'].includes(value.state)) { captionRunning = false; updateButtons(); } if (value.state === 'error') notice(value.message || 'Caption connection failed.', true); },
      onLevel: level => { if (current()) setLevel(level); },
    });
    capture = localCapture;
    await localCapture.start({ deviceId: $('microphone-device').value, ...settings });
    if (!current()) { await localCapture.stop(); return; }
    captionRunning = true;
    listInputs('audioinput', 'microphone-device', 'System default microphone').catch(() => {});
  } catch (error) {
    if (localCapture) await localCapture.stop().catch(() => {});
    if (!current()) return;
    captionRunning = false; if (capture === localCapture) capture = null;
    captionStatus({ state: 'error', message: error.message || 'Could not start captions.' }); notice(error.message || 'Could not start captions.', true);
  } finally { if (current()) { captionStarting = false; updateButtons(); } }
});
$('stop-captions').addEventListener('click', async () => {
  if (captionStopping) return;
  const generation = ++captionGeneration;
  const oldCapture = capture;
  capture = null; captionRunning = false; captionStarting = false; captionStopping = true; updateButtons(); captionStatus({ state: 'stopping', message: 'Stopping audio and finishing captions…' });
  try { await oldCapture?.stop(); }
  catch (error) { if (generation === captionGeneration) notice(error.message, true); }
  finally { if (generation === captionGeneration) { captionStopping = false; setLevel(0); captionStatus('stopped'); updateButtons(); await refreshState().catch(() => {}); } }
});
$('captions-visible').addEventListener('change', event => {
  const checkbox = event.currentTarget;
  withButton(checkbox, async () => {
    try { await api('/api/captions-visible', { enabled: checkbox.checked }); await refreshState(); }
    catch (error) { checkbox.checked = state?.captions?.enabled !== false; throw error; }
  });
});
$('clear-captions').addEventListener('click', event => withButton(event.currentTarget, async () => { await api('/api/caption-clear', {}); await refreshState(); }));
$('caption-test-form').addEventListener('submit', event => { event.preventDefault(); withButton($('test-caption-button'), async () => { const text = $('test-caption-text').value.trim(); if (!text) throw new Error('Enter test text first.'); await api('/api/caption-test', { text }); await refreshState(); notice('Test caption sent. Choose Live presentation to see it on the projector.'); }); });

$('start-camera').addEventListener('click', async () => {
  if (choosingCamera || camera) return;
  const generation = ++cameraGeneration; choosingCamera = true; updateButtons();
  let selected;
  try {
    const deviceId = $('camera-device').value;
    selected = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
    if (generation !== cameraGeneration) { stopTracks(selected); return; }
    camera = selected;
    camera.getVideoTracks()[0].addEventListener('ended', () => { if (camera !== selected) return; camera = null; $('camera-status').textContent = 'Camera disconnected. Start it again to resume.'; publish(); });
    $('camera-status').textContent = `Camera on: ${camera.getVideoTracks()[0].label || 'Selected camera'}`;
    publish();
    listInputs('videoinput', 'camera-device', 'System default camera').catch(() => {});
  } catch (error) { if (selected && selected !== camera) stopTracks(selected); if (generation === cameraGeneration) notice(error.message || 'Could not start the camera.', true); }
  finally { if (generation === cameraGeneration) { choosingCamera = false; updateButtons(); } }
});
$('stop-camera').addEventListener('click', () => { cameraGeneration++; choosingCamera = false; stopTracks(camera); camera = null; $('camera-status').textContent = 'Camera is off.'; publish(); });

window.addEventListener('beforeunload', event => { if (streamActive(source) || streamActive(camera) || captionRunning || captionStarting) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  sourceGeneration++; cameraGeneration++; captionGeneration++;
  stopTracks(source); stopTracks(camera); capture?.fail('Control panel closed.');
  window.theaterDesktop?.closePowerPoint?.().catch(() => {});
  try { stageWindow?.postMessage({ type: 'theater-control-closed' }, location.origin); } catch {}
  events.close(); program.close();
});
const events = new EventSource('/events');
events.addEventListener('state', event => { try { renderState(JSON.parse(event.data)); } catch { setConnection(false); } });
events.onerror = () => setConnection(false);
refreshState().catch(error => { setConnection(false); notice(`Cannot reach the local app: ${error.message}`, true); });
listInputs('videoinput', 'camera-device', 'System default camera').catch(() => {});
setInterval(() => { if (events.readyState !== EventSource.OPEN) refreshState().catch(() => setConnection(false)); }, 10000);
publish();
