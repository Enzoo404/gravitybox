import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./fixture.html', import.meta.url), 'utf8');
const engine = await readFile(new URL('../runtime/engine.js', import.meta.url), 'utf8');
const entries = JSON.parse(await readFile(new URL('../dict/base.json', import.meta.url), 'utf8'));
const server = createServer((req, res) => {
  if (req.url !== '/fixture') { res.writeHead(404); res.end(); return; }
  const origin = `http://127.0.0.1:${server.address().port}`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html + `<script>globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({ origin, path: '/fixture', dictionary: { schema: 1, version: 'visual-demo', entries } }).replaceAll('<', '\\u003c')};\n${engine}</script>`);
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/fixture`));
process.on('SIGTERM', () => server.close());
