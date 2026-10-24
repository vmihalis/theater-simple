import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {PowerPointShow} from '../desktop/powerpoint.cjs';

function readyShow() {
  const writes = [];
  const show = new PowerPointShow({origin: 'http://127.0.0.1:1', directory: ''});
  show.hwnd = '123';
  show.child = {stdin: {writable: true, write(line) { writes.push(JSON.parse(line)); }}};
  return {show, writes};
}

test('an unconfirmed PowerPoint click cannot be repeated on the same session', async () => {
  const {show, writes} = readyShow();
  show.withTimeout = async () => { throw Object.assign(new Error('PowerPoint was busy'), {uncertain: true}); };
  await assert.rejects(show.command('next'), /Restart this slideshow/);
  await assert.rejects(show.command('next'), /Restart this slideshow/);
  assert.deepEqual(writes.map(command => command.action), ['next']);
});

test('a status timeout still permits navigation, but a navigation timeout quarantines the session', async () => {
  const first = readyShow();
  first.show.withTimeout = async (_response, _ms, message) => { throw new Error(message); };
  await assert.rejects(first.show.command('status'), /PowerPoint is busy/);
  assert.equal(first.show.statusQuarantined, true);
  assert.equal(first.show.commandUncertain, false);
  await assert.rejects(first.show.command('previous'), /Restart this slideshow/);
  assert.equal(first.show.commandUncertain, true);
  await assert.rejects(first.show.command('next'), /Restart this slideshow/);
  assert.deepEqual(first.writes.map(command => command.action), ['status', 'previous']);
});

test('a timed-out status is not repeated until a click receives a reply', async () => {
  const {show, writes} = readyShow();
  show.withTimeout = async (response, _ms, message) => {
    if (writes.length === 1) throw new Error(message);
    show.pending.get(writes.at(-1).id).resolve({id: writes.at(-1).id, slide: 2});
    return response;
  };
  await assert.rejects(show.command('status'), /PowerPoint is busy/);
  await assert.rejects(show.command('status'), /previous status check/);
  await assert.rejects(show.command('status'), /previous status check/);
  assert.deepEqual(writes.map(command => command.action), ['status']);
  assert.equal((await show.command('next')).slide, 2);
  assert.equal(show.statusQuarantined, false);
  await show.command('status');
  assert.deepEqual(writes.map(command => command.action), ['status', 'next', 'status']);
});

test('the native worker receives a private copy with a unique slideshow title', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-show-name-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  let input;
  const worker = new EventEmitter();
  worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
  worker.exitCode = null; worker.killed = false;
  worker.stdin.once('finish', () => { worker.exitCode = 0; worker.emit('exit', 0); });
  const show = new PowerPointShow({
    origin: 'http://127.0.0.1:1', directory,
    fetchFile: async url => url.endsWith('/api/state')
      ? Response.json({files: [{id: 'deck', type: 'powerpoint', name: 'Example.pptx'}]})
      : new Response(Buffer.from('private deck bytes')),
    spawnWorker(_command, args) {
      input = args.at(-1);
      queueMicrotask(() => worker.stdout.write(JSON.stringify({id: 0, hwnd: '123', slide: 1}) + '\n'));
      return worker;
    },
  });
  try {
    await show.start('deck');
    assert.match(path.basename(input), /^Theater-show-[a-zA-Z0-9]+\.pptx$/);
    assert.equal(await fs.readFile(input, 'utf8'), 'private deck bytes');
  } finally { await show.close(); }
});
