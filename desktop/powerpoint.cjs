'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

// One owned, read-only copy and one COM worker per slideshow. Never attach to an
// arbitrary active presentation or select a desktop window by its display name.
class PowerPointShow {
  constructor({ origin, directory, spawnWorker = spawn, fetchFile = fetch }) {
    Object.assign(this, { origin, directory, spawnWorker, fetchFile });
    this.closed = false; this.commandUncertain = false; this.statusQuarantined = false; this.pending = new Map(); this.sequence = 0;
  }
  async start(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Choose a saved PowerPoint file.');
    const signal = AbortSignal.timeout(120000);
    const catalogue = await this.fetchFile(`${this.origin}/api/state`, { signal });
    if (!catalogue.ok) throw new Error('The local presentation service is unavailable.');
    const file = (await catalogue.json()).files?.find(item => item.id === id && item.type === 'powerpoint');
    if (!file) throw new Error('This PowerPoint file is no longer available.');
    if (!/\.(pptx|ppsx)$/i.test(file.name)) throw new Error('Save this older presentation as .pptx in PowerPoint, then choose it here.');
    const response = await this.fetchFile(`${this.origin}/files/${encodeURIComponent(id)}`, { signal });
    if (!response.ok || Number(response.headers.get('content-length')) > 150 * 1024 * 1024) throw new Error('Could not read this PowerPoint file.');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 150 * 1024 * 1024 || this.closed) { await this.close(); throw new Error('Presentation opening cancelled or file too large.'); }
      chunks.push(chunk);
    }
    if (this.closed) throw new Error('Presentation opening cancelled.');
    await fs.mkdir(this.directory, { recursive: true });
    this.temporary = await fs.mkdtemp(path.join(this.directory, 'show-'));
    // Give the private copy a unique name so its slideshow can be identified
    // without confusing it with another PowerPoint user's window.
    const input = path.join(this.temporary, `Theater-${path.basename(this.temporary)}.pptx`);
    await fs.writeFile(input, Buffer.concat(chunks));
    if (this.closed) { await this.cleanup(); throw new Error('Presentation opening cancelled.'); }
    this.child = this.spawnWorker('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../run-slideshow.ps1'), '-PresentationPath', input], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', () => {}); // COM diagnostics may contain document data.
    const lines = createInterface({ input: this.child.stdout });
    const ready = new Promise((resolve, reject) => {
      this.pending.set(0, { resolve, reject });
      lines.on('line', line => {
        let value; try { value = JSON.parse(line); } catch { return; }
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        if (value.error) {
          const error = new Error(value.error);
          error.uncertain = value.uncertain === true;
          request.reject(error);
        } else request.resolve(value);
      });
      const fail = () => {
        for (const request of this.pending.values()) request.reject(new Error('PowerPoint slideshow closed. Choose the file again to restart it.'));
        this.pending.clear(); this.closed = true; this.cleanup().catch(() => {});
      };
      this.child.once('error', fail); this.child.once('exit', fail);
    });
    const result = await this.withTimeout(ready, 120000, 'PowerPoint did not open in time. Finish any PowerPoint activation or password prompt, then choose the file again.');
    if (!/^\d+$/.test(String(result.hwnd)) || Number(result.hwnd) === 0) throw new Error('PowerPoint did not provide a slideshow window.');
    this.hwnd = String(result.hwnd); this.name = file.name;
    return { ...result, name: file.name };
  }
  async withTimeout(promise, ms, message) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async command(action) {
    if (!['next', 'previous', 'focus', 'status'].includes(action)) throw new Error('Unknown slideshow action.');
    if (this.commandUncertain) throw new Error('PowerPoint did not confirm the last click. Restart this slideshow before using the clicker.');
    if (this.closed || !this.hwnd || !this.child?.stdin.writable) throw new Error('Choose a PowerPoint file to start its slideshow.');
    if (action === 'status' && this.statusQuarantined) throw new Error('PowerPoint is still working on a previous status check.');
    const navigation = action === 'next' || action === 'previous';
    const timeoutMessage = navigation
      ? 'PowerPoint did not confirm the last click. Restart this slideshow before using the clicker.'
      : 'PowerPoint is busy. Check its slideshow window.';
    const id = ++this.sequence;
    let replied = false;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve(value) { replied = true; resolve(value); },
        reject(error) { replied = true; reject(error); },
      });
    });
    this.child.stdin.write(JSON.stringify({ id, action }) + '\n');
    try {
      const result = await this.withTimeout(response, navigation ? 40000 : 10000, timeoutMessage);
      if (action !== 'status') this.statusQuarantined = false;
      return result;
    }
    catch (error) {
      // A timed-out status may still run later. Do not queue more polls ahead of
      // the operator's next click; resume polling after a command gets a reply.
      if (action === 'status' && !replied) this.statusQuarantined = true;
      if (action !== 'status' && replied && !error.uncertain) this.statusQuarantined = false;
      // Office may complete an in-flight COM call after our deadline. Refuse a
      // second click on this session rather than unexpectedly skipping a slide.
      if (navigation && (error.uncertain || error.message === timeoutMessage)) {
        this.commandUncertain = true;
        throw new Error(timeoutMessage);
      }
      throw error;
    }
    finally { this.pending.delete(id); }
  }
  async cleanup() {
    // Only our uniquely allocated directory; an in-use copy is retained if Office locks it.
    if (this.temporary) await fs.rm(this.temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
  async close() {
    this.closed = true;
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.stdin.end(); // EOF lets the worker close only its own deck in finally.
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
      // Never terminate PowerPoint: it can contain the user's other presentations.
    }
    await this.cleanup();
  }
}

function findSlideshowSource(sources, hwnd) {
  if (!/^\d+$/.test(String(hwnd))) return undefined;
  return sources.find(source => /^window:\d+:\d+$/.test(source.id) && BigInt(source.id.split(':')[1]) === BigInt(hwnd));
}
module.exports = { PowerPointShow, findSlideshowSource };
