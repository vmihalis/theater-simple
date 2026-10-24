import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const launcher = fileURLToPath(new URL('../Start Theater.ps1', import.meta.url));

test('launcher identifies only the old Theater copy for shutdown', {skip: process.platform !== 'win32' && 'Windows only'}, () => {
  // Run the launcher functions against sample process records, without starting
  // or stopping any real application.
  const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${launcher.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher does not parse.' }
foreach ($name in @('Get-ServerPath', 'Test-OldDesktopProcess')) {
  $definition = $ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name}, $true)
  if (-not $definition) { throw "Missing $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}
$oldRoot = 'C:\\Theater Old'
$old = [pscustomobject]@{ ExecutablePath = 'C:\\Theater Old\\runtime\\electron\\electron.exe' }
$unrelated = [pscustomobject]@{ ExecutablePath = 'C:\\Other App\\runtime\\electron\\electron.exe' }
if (-not (Test-OldDesktopProcess $old $oldRoot)) { throw 'Old Theater desktop not selected.' }
if (Test-OldDesktopProcess $unrelated $oldRoot) { throw 'Unrelated app selected for shutdown.' }
if ((Get-ServerPath '"C:\\Theater Old\\runtime\\node.exe" "C:\\Theater Old\\server.mjs"') -ne 'C:\\Theater Old\\server.mjs') { throw 'Old server path not read.' }
if (Get-ServerPath 'node.exe C:relative\\server.mjs') { throw 'Relative server path accepted.' }
[Console]::WriteLine('PASS')
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});
