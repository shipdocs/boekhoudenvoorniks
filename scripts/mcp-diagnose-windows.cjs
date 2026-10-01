// Tijdelijke diagnose voor #191: hoe gedraagt `--mcp` zich op Windows met stdin/stdout als pijp?
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const programs = join(process.env.LOCALAPPDATA, 'Programs');
const exe = readdirSync(programs).map((d) => join(programs, d, 'BoekhoudenVoorNiks.exe')).find(existsSync);
const init = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag', version: '1' } } })}\n`;

function run(label, { delay = 0, write = true, env = {}, args = ['--mcp'], end = 'after-output' }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const e = { ...process.env, ...env };
    delete e.BOEKHOUDENVOORNIKS_SMOKE_TEST;
    delete e.BOEKHOUDENVOORNIKS_DATA;
    const child = spawn(exe, args, { env: e });
    let out = '', err = '', firstOut = null;
    child.stdout.on('data', (d) => { out += d; firstOut ??= Date.now() - start; if (end === 'after-output') child.stdin.end(); });
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (x) => (err += `[stdin error ${x.code}]`));
    const timer = setTimeout(() => { err += '[timeout: gekild]'; child.kill(); }, 20_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      console.log(`${label}: exit ${code} na ${Date.now() - start} ms; eerste uitvoer na ${firstOut} ms; stdout=${JSON.stringify(out.slice(0, 160))}; stderr=${JSON.stringify(err.slice(0, 300))}`);
      resolve();
    });
    if (write) setTimeout(() => child.stdin.write(init), delay);
  });
}

(async () => {
  console.log('exe:', exe);
  const smoke = spawnSync(exe, [], { env: { ...process.env, BOEKHOUDENVOORNIKS_SMOKE_TEST: '1' }, timeout: 120_000, encoding: 'utf8' });
  console.log('rooktest (maakt de administratie):', smoke.status, (smoke.stdout || '').trim().split('\n')[0]);
  await run('A direct schrijven', {});
  await run('B na 5 s schrijven', { delay: 5000 });
  await run('C niets schrijven, stdin open laten', { write: false, end: 'never' });
  await run('D met ELECTRON_ENABLE_LOGGING', { env: { ELECTRON_ENABLE_LOGGING: '1' } });
  await run('E met ELECTRON_NO_ATTACH_CONSOLE', { env: { ELECTRON_NO_ATTACH_CONSOLE: '1' } });
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `$r = '${init.trim().replace(/'/g, "''")}' | & '${exe}' --mcp | Out-String; "uitvoer=[$r] exit=$LASTEXITCODE"`], { encoding: 'utf8', timeout: 60_000 });
  console.log('F via PowerShell-pijp:', (ps.stdout || '').trim().slice(0, 300), (ps.stderr || '').trim().slice(0, 300));
})();
