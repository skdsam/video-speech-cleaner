import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Exercise the actual progress writer through a redirected PowerShell pipe.
const source = readFileSync('src-tauri/scripts/install-dependencies.ps1', 'utf8');
const writer = source.slice(source.indexOf('function Send-Progress'), source.indexOf('function Get-Download'));
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${writer}\nSend-Progress 25 'Downloading model…'; Start-Sleep -Milliseconds 1500; Send-Progress 50 'Verifying model…'`
], { windowsHide: true });
let output = '';
let firstUpdateAt;
let errors = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', data => {
  output += data;
  if (output.includes('PROGRESS|25|')) firstUpdateAt ??= Date.now();
});
child.stderr.on('data', data => { errors += data; });
child.on('error', error => { throw error; });
child.on('close', code => {
  assert.equal(code, 0, errors);
  assert.ok(firstUpdateAt && Date.now() - firstUpdateAt >= 1000, 'Progress must arrive while the installer is still running');
  assert.ok(output.includes('PROGRESS|50|Verifying model…'), output);
  assert.ok(!output.includes('\uFFFD'), 'UTF-8 text must survive the pipe');
  console.log('PASS: live progress arrived more than one second before process completion; Unicode preserved.');
});
