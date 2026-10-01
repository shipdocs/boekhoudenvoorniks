const { spawn } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const electron = require('electron'); // pad naar electron.exe
const logFile = join(process.env.RUNNER_TEMP || require('node:os').tmpdir(), 'probe.log');
rmSync(logFile, { force: true });
const one = (mode) => new Promise((resolve) => {
  const env = { ...process.env, PROBE_MODE: mode, PROBE_LOG: logFile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__dirname], { env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.on('error', () => undefined);
  setTimeout(() => child.stdin.write('regel-een\n'), 1500);
  setTimeout(() => child.stdin.end('regel-twee\n'), 4500);
  child.on('exit', (code) => { console.log(`${mode}: exit ${code}, stdout=${JSON.stringify(out)}`); resolve(); });
});
(async () => {
  for (const mode of ['stdin', 'fsstream', 'net', 'readsync']) await one(mode);
  console.log(readFileSync(logFile, 'utf8'));
})();
