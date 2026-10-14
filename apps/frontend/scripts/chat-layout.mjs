// Native layout regression. Build frontend to an isolated directory first.
// node chat-layout.mjs <build-dir> <evidence-dir>
// PLAYWRIGHT_MODULE may point to an existing Playwright installation (file URL).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [buildDir, evidenceDir] = process.argv.slice(2);
assert.ok(buildDir && evidenceDir, 'Pass isolated build and evidence directories');
fs.mkdirSync(evidenceDir, { recursive: true });
const server = http.createServer((_req, res) => { res.writeHead(500); res.end('Fixture interception required'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { viewports: [], errors: [], blocked: [] };
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const sockets = new Map();
    let nextId = 0;
    const sent = [];
    const deliver = messages => { for (const queue of sockets.values()) queue.push(...messages.map(msg => '42' + JSON.stringify(['receive_message', msg]))); };
    await context.routeWebSocket('**/*', ws => { report.blocked.push(ws.url()); ws.close(); });
    await context.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url()), p = u.pathname;
      const headers = { 'access-control-allow-origin': '*' };
      if (p === '/socket.io/') {
        const sid = u.searchParams.get('sid');
        if (!sid) {
          const id = 'synthetic-' + (++nextId); sockets.set(id, []);
          return route.fulfill({ contentType: 'text/plain', headers, body: '0' + JSON.stringify({ sid: id, upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }) });
        }
        const queue = sockets.get(sid);
        assert.ok(queue, 'Unknown fixture socket');
        if (req.method() === 'POST') {
          for (const packet of (req.postData() || '').split('\x1e')) {
            if (packet === '40') queue.push('40' + JSON.stringify({ sid }));
            const match = /^42(\d*)(\[.*)$/s.exec(packet);
            if (match) {
              const [event, data] = JSON.parse(match[2]);
              if (event === 'join_channel' || event === 'renew_playback') queue.push('43' + match[1] + JSON.stringify([{ ok: true, cap: 'synthetic-cap' }]));
              if (event === 'send_message') { sent.push(data); queue.push('42' + JSON.stringify(['receive_message', data])); }
            }
          }
          return route.fulfill({ contentType: 'text/plain', headers, body: 'ok' });
        }
        for (let i = 0; i < 50 && !queue.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
        return route.fulfill({ contentType: 'text/plain', headers, body: queue.splice(0).join('\x1e') || '2' }).catch(() => {});
      }
      if (p === '/api/public/streams/compactchat-fixture') return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ channelName: 'compactchat-fixture', isLive: true, isDisabled: false, isPasswordProtected: false }) });
      // Inert FLV header only: no live media, audio, animated content or publishers.
      if (p === '/live/compactchat-fixture.flv') return route.fulfill({ contentType: 'video/x-flv', headers, body: Buffer.from([70,76,86,1,0,0,0,0,9,0,0,0,0]) });
      if (u.origin === origin && req.method() === 'GET' && (p === '/watch/compactchat-fixture' || p.startsWith('/assets/') || p === '/vite.svg')) {
        const file = path.join(buildDir, p.startsWith('/watch/') ? 'index.html' : p);
        if (fs.existsSync(file)) return route.fulfill({ contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      report.blocked.push(req.url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await page.waitForTimeout(50); } throw new Error('Fixture condition timed out'); };
    try {
      await page.goto(origin + '/watch/compactchat-fixture');
      await page.getByPlaceholder('Choose a name').fill('test');
      await page.getByRole('button', { name: 'Join Stream' }).click();
      await page.getByRole('log').waitFor();
      const rows = page.getByTestId('chat-row'), log = page.getByRole('log'), input = page.getByPlaceholder('Send a message');
      deliver(['test', 'test', 'tes'].map(message => ({ username: 'test', message })));
      await wait(async () => await rows.count() === 3);
      const geometry = await rows.evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { top: r.top, height: r.height, lineHeight: parseFloat(s.lineHeight), position: s.position, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight }; }));
      const record = { width, short: geometry, status: 'failed' }; report.viewports.push(record);
      await page.screenshot({ path: path.join(evidenceDir, `compactchat-short-${width}.png`) });
      assert.ok(geometry.every(r => r.height <= r.lineHeight + 8), `Short rows must be content-height: ${JSON.stringify(geometry)}`);
      assert.ok(geometry[1].top - geometry[0].top <= geometry[0].lineHeight + 8, 'No stretched vertical gaps');
      assert.ok(geometry.every(r => r.position !== 'absolute'), 'Natural flow, not fixed-row virtualization');
      const start = await log.evaluate(n => ({ top: n.getBoundingClientRect().top, padding: parseFloat(getComputedStyle(n).paddingTop) }));
      assert.ok(Math.abs(geometry[0].top - start.top - start.padding) < 2, 'Messages stack at the top');
      const inline = await rows.first().locator('span').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
      assert.equal(inline[0], inline[1], 'Username and body are inline');
      const long = 'A readable wrapped message with words. '.repeat(15) + 'x'.repeat(250);
      deliver([{ username: 'other', message: long }, { username: '', message: 'Synthetic system notice', isSystem: true }]);
      await wait(async () => await rows.count() === 5);
      const wrapped = await rows.nth(3).evaluate(n => ({ height: n.getBoundingClientRect().height, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
      assert.ok(wrapped.height > geometry[0].height * 2, 'Wrapped rows grow naturally');
      assert.ok(wrapped.scrollHeight <= wrapped.clientHeight + 1 && wrapped.scrollWidth <= wrapped.clientWidth + 1, 'No clipped text or row-local scrolling');
      const chatBounds = await log.evaluate(n => { const r = n.parentElement.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      assert.ok(chatBounds.left >= 0 && chatBounds.right <= width + 1, 'Whole chat, including send button and wrapped text, fits viewport');
      const inputBefore = await input.boundingBox();
      assert.ok(inputBefore.x >= 0 && inputBefore.x + inputBefore.width <= width + 1 && inputBefore.y + inputBefore.height <= 900, 'Input stays inside viewport');
      await page.screenshot({ path: path.join(evidenceDir, `compactchat-wrapped-${width}.png`) });
      deliver(Array.from({ length: 120 }, (_, i) => ({ username: 'other', message: `History ${i}` })));
      await wait(async () => await rows.count() === 125);
      await wait(() => log.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight < 2));
      await log.evaluate(n => { n.scrollTop = 0; n.dispatchEvent(new Event('scroll', { bubbles: true })); });
      deliver([{ username: 'other', message: 'Do not jump the reader' }]);
      await wait(async () => await rows.count() === 126);
      assert.equal(await log.evaluate(n => n.scrollTop), 0, 'History reader is not forced down');
      await log.evaluate(n => { n.scrollTop = n.scrollHeight; n.dispatchEvent(new Event('scroll', { bubbles: true })); });
      await input.fill('Synthetic local send'); await input.press('Enter');
      await wait(async () => sent.length === 1 && await input.inputValue() === '' && await rows.count() === 127);
      await wait(() => log.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight < 2));
      assert.equal(sent[0].message, 'Synthetic local send');
      const inputAfter = await input.boundingBox();
      assert.ok(Math.abs(inputAfter.y - inputBefore.y) < 1, 'History does not displace input/footer');
      deliver(Array.from({ length: 600 }, (_, i) => ({ username: 'other', message: `Capped history ${i}` })));
      await wait(async () => await rows.count() === 500);
      await wait(() => log.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight < 2));
      assert.equal(await rows.first().innerText(), 'otherCapped history 100');
      const anchor = rows.nth(80);
      const anchorText = await anchor.innerText();
      await log.evaluate(n => { n.scrollTop = n.children[80].offsetTop; n.dispatchEvent(new Event('scroll', { bubbles: true })); });
      const anchorTop = (await anchor.boundingBox()).y;
      deliver([{ username: 'other', message: 'Arrival while reading capped history' }]);
      await wait(async () => (await rows.last().innerText()).includes('Arrival while reading capped history'));
      const retained = rows.filter({ hasText: anchorText }).first();
      assert.ok(Math.abs((await retained.boundingBox()).y - anchorTop) < 1, 'Capped history preserves the same visible message and offset');
      await page.screenshot({ path: path.join(evidenceDir, `compactchat-history-${width}.png`) });
      record.wrapped = wrapped; record.input = inputAfter; record.status = 'passed';
    } catch (error) {
      report.errors.push({ width, error: error.message });
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []);
} catch (error) { process.exitCode = 1; report.failure = error.message; }
finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidenceDir, 'compactchat-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
