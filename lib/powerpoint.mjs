import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {preflightMacPowerPoint} from './mac-office-preflight.mjs';

const scriptPath = fileURLToPath(new URL('../convert-presentation.ps1', import.meta.url));
const macScriptPath = fileURLToPath(new URL('../convert-presentation.applescript', import.meta.url));
const conversionTimeoutMs = 120_000;
const help = 'Open the file in PowerPoint, finish any activation or password prompt, then save it as PDF and select that PDF here.';

async function runPowerPoint({inputPath, outputPath, timeoutMs}) {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Direct PowerPoint import requires Microsoft PowerPoint on Windows or macOS. Save the presentation as PDF and select that PDF here.');
  if (process.platform === 'darwin') await preflightMacPowerPoint(inputPath);
  const executable = process.platform === 'darwin' ? '/usr/bin/osascript' : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = process.platform === 'darwin' ? [macScriptPath, inputPath, outputPath] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-PresentationPath', inputPath, '-OutputPath', outputPath];
  await new Promise((resolve, reject) => {
    execFile(executable, args,
    {windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (!error) return resolve();
      if (error.killed) return reject(new Error(`PowerPoint did not finish preparing the slides within ${Math.round(timeoutMs / 1000)} seconds. ${help}`));
      // The worker emits only a short, controlled error line; do not expose full COM diagnostics or paths.
      const reported = `${stdout}\n${stderr}`.split(/\r?\n/).find(line => line.startsWith('THEATER_ERROR:'));
      reject(new Error(reported ? reported.slice('THEATER_ERROR:'.length).trim() : process.platform === 'darwin'
        ? 'PowerPoint could not export this deck on this Mac. Check that it is installed and activated, and allow Theater Simple to control PowerPoint in System Settings → Privacy & Security → Automation. You can also save the deck as PDF in PowerPoint and select that PDF here.'
        : `PowerPoint could not prepare this presentation. ${help}`));
    });
  });
}

async function verifyPdf(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const {size} = await handle.stat();
    if (size < 20) throw new Error('PowerPoint produced an empty PDF.');
    const start = Buffer.alloc(Math.min(1024, size));
    const end = Buffer.alloc(Math.min(2048, size));
    await handle.read(start, 0, start.length, 0);
    await handle.read(end, 0, end.length, size - end.length);
    if (!start.includes(Buffer.from('%PDF-')) || !end.includes(Buffer.from('%%EOF'))) {
      throw new Error('PowerPoint did not produce a complete PDF.');
    }
  } finally { await handle.close(); }
}

// The factory permits isolated tests without opening Office. The default instance serializes all
// conversions because PowerPoint may reuse the same desktop application process for COM clients.
export function createPowerPointPreparer({runConverter = runPowerPoint, timeoutMs = conversionTimeoutMs} = {}) {
  let pending = Promise.resolve();
  const inFlight = new Map();

  return function preparePowerPoint({inputPath, outputPath}) {
    const input = path.resolve(inputPath);
    const output = path.resolve(outputPath);
    const identity = `${input}\0${output}`;
    if (inFlight.has(identity)) return inFlight.get(identity);
    const task = pending.catch(() => {}).then(async () => {
      const extension = path.extname(input).toLowerCase();
      if (!['.pptx', '.ppsx'].includes(extension)) {
        throw new Error('For direct slides, save this older PowerPoint file as .pptx or PDF, then select it here.');
      }
      if (path.extname(output).toLowerCase() !== '.pdf' || input === output) throw new Error('A separate PDF output path is required.');
      const metadata = await fs.stat(input);
      if (!metadata.isFile()) throw new Error('Select a PowerPoint file.');
      if (metadata.size > 150 * 1024 * 1024) throw new Error('This PowerPoint is too large. Save a smaller copy or export it as PDF.');
      await fs.mkdir(path.dirname(output), {recursive: true});
      const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.powerpoint-'));
      try {
        // A unique copy ensures Close() can never close a presentation already opened by the user.
        const copy = path.join(temporary, `presentation${extension}`);
        const converted = path.join(temporary, 'slides.pdf');
        await fs.copyFile(input, copy);
        await runConverter({inputPath: copy, outputPath: converted, timeoutMs});
        await verifyPdf(converted);
        await fs.rename(converted, output);
        return {outputPath: output, engine: 'powerpoint', staticSlides: true};
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`PowerPoint did not create slides. ${help}`);
        throw error;
      } finally {
        // Only this freshly created child directory is removed; the source and existing output survive failures.
        await fs.rm(temporary, {recursive: true, force: true, maxRetries: 2, retryDelay: 100}).catch(() => {});
      }
    });
    pending = task;
    inFlight.set(identity, task);
    task.finally(() => inFlight.delete(identity)).catch(() => {});
    return task;
  };
}

export const preparePowerPoint = createPowerPointPreparer();
