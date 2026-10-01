// Tijdelijke proef voor #191: welke manier van stdin lezen werkt in het hoofdproces van Electron op Windows?
const fs = require('node:fs');
const { app } = require('electron');
const log = (...a) => fs.appendFileSync(process.env.PROBE_LOG, `${a.join(' ')}\n`);
const mode = process.env.PROBE_MODE;
log(`--- ${mode}`);
try {
  const s = fs.fstatSync(0);
  log('fstat(0): fifo', s.isFIFO(), 'file', s.isFile(), 'char', s.isCharacterDevice());
} catch (e) {
  log('fstat(0) fout', e.code);
}
const watch = (name, stream) => {
  stream.on('data', (d) => log(name, 'data', d.length, JSON.stringify(String(d).slice(0, 30))));
  stream.on('end', () => log(name, 'end'));
  stream.on('close', () => log(name, 'close'));
  stream.on('error', (e) => log(name, 'error', e.code || e.message));
};
try {
  if (mode === 'stdin') {
    log('process.stdin is', process.stdin.constructor.name, 'fd', process.stdin.fd);
    watch('stdin', process.stdin);
  } else if (mode === 'fsstream') {
    watch('fsstream', fs.createReadStream(null, { fd: 0 }));
  } else if (mode === 'net') {
    watch('net', new (require('node:net').Socket)({ fd: 0, readable: true, writable: false }));
  } else if (mode === 'readsync') {
    setTimeout(() => {
      try {
        const buf = Buffer.alloc(1024);
        log('readSync', fs.readSync(0, buf, 0, 1024, null));
      } catch (e) {
        log('readSync fout', e.code);
      }
    }, 3000);
  }
} catch (e) {
  log('opzetten mislukt', e.code || e.message);
}
process.stdout.write('hallo-van-de-proef\n');
setTimeout(() => app.exit(0), 7000);
