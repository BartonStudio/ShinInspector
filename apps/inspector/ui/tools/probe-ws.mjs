// 一次性探针：确认 new WebSocket('http://host:port') 到底是抛错还是被改写成 ws://。
// 这决定了 diagnose.js 里「协议不对」这条分支是不是死代码。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8848/index.html', { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(() => new Promise((resolve) => {
  const results = [];
  const probe = (url, label) => new Promise((res) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      results.push(label + ' -> THREW ' + e.name + ': ' + e.message);
      res();
      return;
    }
    const done = (verdict) => { try { ws.close(); } catch {} results.push(label + ' -> ' + verdict); res(); };
    ws.onopen = () => done('OPEN');
    ws.onerror = () => done('ERROR(onerror)');
    setTimeout(() => done('TIMEOUT'), 3000);
  });
  (async () => {
    await probe('http://127.0.0.1:9002', 'http  -> 9002(demo 在跑)');
    await probe('http://127.0.0.1:59987', 'http  -> 59987(无人监听)');
    await probe('ftp://127.0.0.1:9002', 'ftp   -> 9002');
    await probe('127.0.0.1:9002', '无 scheme');
    resolve(results);
  })();
}));

console.log(out.join('\n'));
await browser.close();
