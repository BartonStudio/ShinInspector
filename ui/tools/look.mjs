// 一次性外观核查（不属于常规测试）：把顶栏 / 检查器以 2x 清晰度截出来，
// 并打印关键元素的计算样式，用来确认 TUI 主题真的落到了像素上。
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.SHIN_APP_URL || 'http://127.0.0.1:8848/index.html';
const WS_URL = process.argv[2] || 'ws://127.0.0.1:9002';
const DOMAIN = process.argv[3] || 'shininspector';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const exe = CANDIDATES.find((p) => fs.existsSync(p));

const outDir = path.join(process.cwd(), '.workbuddy', 'tmp');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-first-run', '--force-device-scale-factor=2'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto(APP_URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__shin, { timeout: 20000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__shin && !!document.querySelector('#graph-host canvas'),
  { timeout: 20000 });

// 连上 dmeo 并把 Device 加进清单，让检查器渲染出真实内容
await page.evaluate(async ({ wsUrl, domain }) => {
  const s = window.__shin;
  s.emit('connect-request', { url: wsUrl, domain });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && s.state.connection.status !== 'open') {
    await new Promise((r) => setTimeout(r, 100));
  }
  await s.workspace.addSpec('Device');
  await s.workspace.addSpec('Device.Sub');
  const dev = s.state.nodes.find((n) => n.name === 'Device');
  if (dev) s.select(dev.addr);
}, { wsUrl: WS_URL, domain: DOMAIN });
await new Promise((r) => setTimeout(r, 1500));

const styles = await page.evaluate(() => {
  const cs = (sel, pseudo) => {
    const el = document.querySelector(sel);
    if (!el) return sel + ' -> (缺失)';
    const s = getComputedStyle(el, pseudo);
    return [
      sel + (pseudo || ''),
      'color=' + s.color,
      'bg=' + s.backgroundColor,
      'border=' + s.borderTopColor,
      'radius=' + s.borderRadius,
      'font=' + s.fontFamily.split(',')[0],
      'shadow=' + (s.textShadow === 'none' ? '-' : s.textShadow),
    ].join('  ');
  };
  return [
    cs('body'),
    cs('.brand'),
    cs('.conn-status'),
    cs('#tb-connect'),
    cs('#tb-connect', '::before'),
    cs('#tb-rescan'),
    cs('#inspector .sec'),
    cs('#inspector .sec > h3'),
    cs('#inspector .tabs button.on'),
    cs('.row .name'),
    cs('.row .val b'),
    cs('.tl-row .t'),
    cs('.note'),
    cs('.legend i[data-c="root"]'),
  ];
});
console.log(styles.join('\n'));
console.log('body 尺寸: ' + JSON.stringify(await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  scrollW: document.documentElement.scrollWidth,
  scrollH: document.documentElement.scrollHeight,
}))));

const shot = async (name, clip) => {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, clip });
  console.log('截图: ' + file);
};
const rect = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, sel);

await shot('look-header.png', { ...(await rect('#app-head')), x: 0, y: 0 });
await shot('look-inspector.png', await rect('#inspector'));
await shot('look-timeline.png', await rect('#timeline'));
await shot('look-canvas.png', await rect('#stage'));

await browser.close();
