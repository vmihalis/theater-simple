// Runs the real slideshow worker under Windows PowerShell 5.1. Where PowerPoint is not
// installed (such as the CI runner), it proves the worker parses, enables busy-retry,
// and reports the failing step with PowerPoint's own COM error code.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const powerPointInstalled = windows && spawnSync('reg', ['query', 'HKCR\\PowerPoint.Application'], {windowsHide: true}).status === 0;

async function runWorker(t, name, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-worker-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true, maxRetries: 3}));
  const input = path.join(directory, name);
  await fs.writeFile(input, bytes);
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'run-slideshow.ps1'), '-PresentationPath', input], {windowsHide: true});
  child.stdin.end();
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  const line = stdout.split(/\r?\n/).find(text => text.startsWith('{'));
  assert.ok(line, `Worker printed no JSON reply. Exit ${code}. stdout: ${stdout} stderr: ${stderr}`);
  return JSON.parse(line);
}

test('slideshow worker names the failing step and COM code when PowerPoint is missing', {skip: !windows ? 'Windows only' : powerPointInstalled ? 'PowerPoint is installed here; use tests/powerpoint-live.windows.mjs' : false}, async t => {
  const reply = await runWorker(t, 'Presentation.pptx', await fs.readFile(path.join(root, 'tests', 'fixtures', 'animation-rehearsal.pptx')));
  assert.equal(reply.id, 0);
  assert.match(reply.error, /could not start Microsoft PowerPoint/);
  assert.match(reply.error, /Details: step app, code 0x80040154/, 'REGDB_E_CLASSNOTREG from PowerPoint.Application');
  assert.doesNotMatch(reply.error, /busy-retry off/, 'The COM busy-retry filter must compile and register');
});

test('slideshow worker passes validation messages through unchanged', {skip: !windows && 'Windows only'}, async t => {
  const reply = await runWorker(t, 'Presentation.pptx', 'not a zip package');
  assert.equal(reply.id, 0);
  assert.equal(typeof reply.error, 'string', 'The validation message must reach the control panel');
  assert.ok(reply.error.length > 0);
  assert.doesNotMatch(reply.error, /Details: step/);
});

test('slideshow worker window helper lists top-level windows with class, visibility and title', {skip: !windows && 'Windows only'}, async () => {
  // Compiles the same C# the worker uses, taken from its source, and lists this session's windows.
  const script = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'run-slideshow.ps1').replace(/'/g, "''")}', [ref]$null, [ref]$null)
$assignment = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$filterSource' }, $true) | Select-Object -First 1
Add-Type -TypeDefinition $assignment.Right.Expression.Value -Language CSharp
$ids = [int[]]@(Get-Process | ForEach-Object { $_.Id })
[TheaterSimple.TopWindows]::List($ids) | Select-Object -First 50 | ForEach-Object { [Console]::WriteLine($_) }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {input: script, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `No windows listed. stderr: ${result.stderr}`);
  for (const line of lines) {
    assert.match(line, /^\d+\|[^|]*\|[01]\|[A-Za-z0-9+/]*={0,2}$/);
    const encodedTitle = line.split('|')[3];
    assert.equal(Buffer.from(encodedTitle, 'base64').toString('utf8').includes('\uFFFD'), false);
  }
});

test('slideshow worker selects only an unambiguous window named for its private deck', {skip: !windows && 'Windows only'}, async () => {
  // Evaluate the worker's actual selection function with competing PowerPoint windows.
  const script = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'run-slideshow.ps1').replace(/'/g, "''")}', [ref]$null, [ref]$null)
$function = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-OwnedSlideshowWindow' }, $true) | Select-Object -First 1
Invoke-Expression $function.Extent.Text
$windows = @(
  [pscustomobject]@{Handle=100; Class='screenClass'; Visible=$true; Title='PowerPoint Slide Show - Other deck'},
  [pscustomobject]@{Handle=200; Class='screenClass'; Visible=$true; Title='PowerPoint Slide Show - Theater-show-abc'},
  [pscustomobject]@{Handle=300; Class='#32770'; Visible=$true; Title='Theater-show-abc dialog'},
  [pscustomobject]@{Handle=400; Class='screenClass'; Visible=$true; Title='Theater-show-abc old'}
)
$selected = Find-OwnedSlideshowWindow $windows @(400) 'Theater-show-abc'
if ($selected -ne 200) { throw "Selected wrong window: $selected" }
try { Find-OwnedSlideshowWindow @($windows[0], $windows[2]) @() 'Theater-show-abc' | Out-Null; throw 'Selected an unrelated window' }
catch { if ($_.Exception.Message -eq 'Selected an unrelated window') { throw } }
try { Find-OwnedSlideshowWindow @($windows[1], $windows[3]) @() 'Theater-show-abc' | Out-Null; throw 'Selected an ambiguous window' }
catch { if ($_.Exception.Message -eq 'Selected an ambiguous window') { throw } }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {input: script, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
});
