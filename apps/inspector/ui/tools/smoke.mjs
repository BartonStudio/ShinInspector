// 端到端冒烟：用真实时钟驱动 dev server 上的 UI，连接本机 demo WS 服务并跑一遍关键交互。
//
// 为什么不用 `chrome --headless --virtual-time-budget`：
//   Chromium 的虚拟时钟不把 WebSocket 往返当作 pending 工作，会把时间预算瞬间快进掉，
//   于是 await 一个 RPC（getChildItem / invoke…）永远等不到结果，测试表现为"卡住"。
//   真实时钟（puppeteer 驱动）才靠得住。
//
// 用法：
//   node apps/inspector/ui/tools/smoke.mjs [wsUrl] [domain]
//   SHIN_APP_URL=http://127.0.0.1:8848/index.html node apps/inspector/ui/tools/smoke.mjs
//
// 前置：该方案的 Vite dev server 已在跑（apps/inspector/ui 下 `npm run dev`）；
//       并有一个提供 demo 对象树的 WS 服务（ShinInspectorApp.exe --demo，默认 9002）。
// 注意：输出目录取 process.cwd()，所以**从仓库根运行**，临时文件才落在 .workbuddy/tmp/。

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const WS_URL = process.argv[2] || 'ws://127.0.0.1:9002';
const DOMAIN = process.argv[3] || 'shininspector';
const APP_URL = process.env.SHIN_APP_URL || 'http://127.0.0.1:8848/index.html';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('找不到 Chromium 内核浏览器，无法运行冒烟测试。');
  process.exit(2);
}

const cwd = process.cwd();
const outDir = path.join(cwd, '.workbuddy', 'tmp');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();
page.on('console', (m) => {
  const text = m.text();
  if (text.includes('[smoke]')) console.log(text);
  else if (m.type() === 'error') console.log('  [console.error] ' + text);
});
page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));

console.log('打开 ' + APP_URL + '，目标 ' + WS_URL + ' (domain=' + DOMAIN + ')');
await page.goto(APP_URL, { waitUntil: 'load' });

// 清掉上一轮残留的观察清单与「学到的知识」：断言不该依赖历史状态，
// 否则第二次跑同一个脚本的结论会和第一次不同。
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });

// 等 main.js 装配完成再动手：调试句柄挂上、画布（或停摆面板）出现才算就绪。
// 只等 load 事件不够 —— dev server 的模块图是逐级 fetch 的，load 时装配可能还没跑完。
await page.waitForFunction(
  () => !!window.__shin
    && (!!document.querySelector('#graph-host canvas') || !!document.querySelector('.render-fatal')),
  { timeout: 20000 },
);

const result = await page.evaluate(async ({ wsUrl, domain }) => {
  const shin = window.__shin;
  const { state, emit, select, session, memory } = shin;
  const { addSpec, addSpecs, exportSpecs } = shin.workspace;
  const { setSubscription, setAllSubscriptions, subscriptionCount } = shin.observe;

  const say = (tag, text) => console.log('[smoke] [' + tag + '] ' + text);
  const checks = [];
  const check = (name, pass, detail = '') => {
    checks.push({ name, pass: !!pass, detail: String(detail) });
    say(pass ? 'PASS' : 'FAIL', name + (detail ? ' :: ' + detail : ''));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodeByName = (n) => state.nodes.find((x) => x.name === n);
  const waitFor = async (fn, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fn()) return true;
      await sleep(100);
    }
    return false;
  };

  // ---------- 渲染器与静态装帧 ----------
  check('渲染器为 webgl', state.renderer === 'webgl', 'renderer=' + state.renderer);
  check('画布图例已渲染', !!document.querySelector('.legend'));
  check('未误加 no-render', !document.getElementById('stage').classList.contains('no-render'));

  // ---------- 1280x720 布局：任何东西都不许溢出视口 ----------
  // 这条是窗口尺寸需求的守卫：宿主按 DPI 换算出 1280x720 逻辑像素，
  // 前端在这套尺寸下必须刚好放得下 —— 一旦某个面板撑破，这里立刻红。
  check('视口为 1280x720',
    window.innerWidth === 1280 && window.innerHeight === 720,
    window.innerWidth + 'x' + window.innerHeight);

  const de = document.documentElement;
  check('页面无横向溢出', de.scrollWidth <= window.innerWidth,
    'scrollWidth=' + de.scrollWidth + ' vs innerWidth=' + window.innerWidth);
  check('页面无纵向溢出', de.scrollHeight <= window.innerHeight,
    'scrollHeight=' + de.scrollHeight + ' vs innerHeight=' + window.innerHeight);

  const tb = document.getElementById('toolbar');
  check('顶栏自身不溢出', tb.scrollWidth <= tb.clientWidth + 1,
    'scrollWidth=' + tb.scrollWidth + ' clientWidth=' + tb.clientWidth);

  const box = (el) => el.getBoundingClientRect();
  const insp = box(document.getElementById('inspector'));
  check('检查器完整落在视口内',
    insp.right <= window.innerWidth + 1 && insp.left >= -1 && insp.width > 200,
    'x=[' + Math.round(insp.left) + ',' + Math.round(insp.right) + '] w=' + Math.round(insp.width));

  const tl = box(document.getElementById('timeline'));
  check('时间线完整落在视口内',
    tl.bottom <= window.innerHeight + 1 && tl.top >= -1 && tl.height > 60,
    'y=[' + Math.round(tl.top) + ',' + Math.round(tl.bottom) + '] h=' + Math.round(tl.height));

  const stage = box(document.getElementById('stage'));
  check('画布区仍有余量',
    stage.width >= 600 && stage.height >= 300,
    Math.round(stage.width) + 'x' + Math.round(stage.height));

  // ---------- TUI 主题装帧 ----------
  check('正文使用等宽终端字体',
    /mono|consolas/i.test(getComputedStyle(document.body).fontFamily),
    getComputedStyle(document.body).fontFamily.slice(0, 48));

  // 配色：黑底 + 近白正文 + 唯一强调色（橙）。上一版是"满屏荧光绿"，太伤眼睛，
  // 这三条断言就是防止它悄悄回潮 —— 换皮时可以换色，但不能换回高饱和大字面积。
  const rootStyle = getComputedStyle(document.documentElement);
  check('TUI 正文为近白',
    getComputedStyle(document.body).color.replace(/\s/g, '') === 'rgb(242,242,242)',
    getComputedStyle(document.body).color);
  check('TUI 强调色为橙',
    rootStyle.getPropertyValue('--accent').trim() === '#ff9000',
    rootStyle.getPropertyValue('--accent').trim());
  check('画布底色为纯黑',
    getComputedStyle(document.getElementById('stage')).backgroundColor.replace(/\s/g, '') === 'rgb(0,0,0)',
    getComputedStyle(document.getElementById('stage')).backgroundColor);
  check('直角（无圆角）', getComputedStyle(document.getElementById('inspector')).borderRadius === '0px',
    getComputedStyle(document.getElementById('inspector')).borderRadius);
  check('CRT 扫描线装饰层已挂载', !!document.querySelector('.crt'));
  check('顶栏输入框带提示符', document.querySelectorAll('#toolbar .ibox b').length === 2,
    'prompts=' + document.querySelectorAll('#toolbar .ibox b').length);

  // 布局切换按钮已按需求移除：布局默认力导向，舞台上只留一个冻结开关。
  check('浮层只剩冻结按钮',
    !document.getElementById('sb-force') && !document.getElementById('sb-radial')
    && document.querySelectorAll('#stage-bar button').length === 1,
    'buttons=' + document.querySelectorAll('#stage-bar button').length);

  const btn = document.getElementById('tb-connect');
  check('按钮为方括号装帧',
    getComputedStyle(btn, '::before').content === '"["',
    getComputedStyle(btn, '::before').content);

  // ---------- 连接失败诊断 ----------
  // 先走失败路径：挑一个几乎不可能被占用的端口，确保失败类型就是「无监听」。
  // 这段必须排在真连接之前 —— 连上之后再测就没意义了。
  emit('connect-request', { url: 'ws://127.0.0.1:59987', domain: 'shininspector' });
  const gotError = await waitFor(() => state.connection.status === 'error', 12000);
  check('连不上的端口进入 error 态', gotError, 'status=' + state.connection.status);

  const diag = state.connection.diagnosis;
  check('失败时产出结构化诊断', !!diag, diag ? diag.reason : 'diagnosis=null');
  check('诊断判定为端口无监听', /没有服务在监听/.test(diag?.reason || ''), diag?.reason || '-');
  check('诊断给出可执行的动作', (diag?.actions?.length || 0) >= 2,
    'actions=' + (diag?.actions?.length || 0));
  check('顶栏渲染出诊断条', !!document.querySelector('#conn-hint:not(.hidden) .ch-body'));
  check('诊断条含 --demo 的自救指引',
    /--demo/.test(document.getElementById('conn-hint')?.textContent || ''));
  check('时间线记录了失败原因',
    state.events.some((e) => e.isLog && String(e.path).includes('连接失败')));

  const chClose = document.getElementById('ch-close');
  if (chClose) {
    chClose.click();
    await sleep(100);
    check('诊断条可收起', !!document.querySelector('#conn-hint.hidden'));
  } else {
    check('诊断条可收起', false, '没有找到收起按钮');
  }

  // 非法 scheme 由 WebSocket 构造器直接抛 SyntaxError，不必探测网络
  emit('connect-request', { url: 'ftp://127.0.0.1:9002', domain: 'shininspector' });
  const gotSchemeErr = await waitFor(() => /协议/.test(state.connection.diagnosis?.reason || ''), 6000);
  check('非法 scheme 直接指出协议不支持', gotSchemeErr, state.connection.diagnosis?.reason || '-');

  // https:// 会被浏览器改写成 wss://，在明文端口上必然握手失败 ——
  // 这是「端口能连通但握手失败」这类诊断里最需要被点破的一种。
  emit('connect-request', { url: 'https://127.0.0.1:9002', domain: 'shininspector' });
  const gotTls = await waitFor(
    () => /握手失败/.test(state.connection.diagnosis?.reason || ''), 12000);
  const tlsActions = (state.connection.diagnosis?.actions || []).join(' ');
  check('https:// 判定为握手失败并点明协议改写', gotTls && /ws:\/\//.test(tlsActions),
    gotTls ? tlsActions.slice(0, 60) : (state.connection.diagnosis?.reason || '-'));

  // ---------- 连接 ----------
  emit('connect-request', { url: wsUrl, domain });
  const opened = await waitFor(() => state.connection.status === 'open', 8000);
  check('连接建立', opened, 'status=' + state.connection.status);
  check('连上后诊断条自动退场', !!document.querySelector('#conn-hint.hidden'));
  if (!opened) return { checks, fatal: '连接未建立，后续跳过' };

  // ---------- 断开必须能取消在途的连接 ----------
  // 回归：曾经 connect() 没有世代令牌，握手期间点「断开」后，在途的握手
  // resolve 时照样把状态写成「已连接」，还留下一个没人管的 socket。
  //
  // 两个 emit 之间不 await：socket 的 open 事件必须等一个 macrotask，
  // 而两个事件回调只在微任务层面让步，所以「断开」必定先落地。
  emit('connect-request', { url: wsUrl, domain });
  emit('disconnect-request');
  await sleep(2500);
  check('断开能取消在途连接',
    state.connection.status === 'idle' && !session.isOpen,
    'status=' + state.connection.status + ' isOpen=' + session.isOpen);

  emit('connect-request', { url: wsUrl, domain });
  const reopened = await waitFor(() => state.connection.status === 'open', 8000);
  check('断开后可重新连接', reopened, 'status=' + state.connection.status);
  if (!reopened) return { checks, fatal: '重连未建立，后续跳过' };

  // ---------- 清单与拓扑 ----------
  for (const p of ['Device', 'Device.Sub', 'Sensor']) {
    try { await addSpec(p); } catch (e) { say('note', 'add ' + p + ' :: ' + e.message); }
  }
  check('清单解析出 4 个节点', state.nodes.length === 4,
    'nodes=[' + state.nodes.map((n) => n.name).join(',') + ']');
  check('反推出 3 条边', state.edges.length === 3, 'edges=' + state.edges.length);
  check('订阅数 = 节点数 × 4', subscriptionCount() === state.nodes.length * 4,
    'subs=' + subscriptionCount());

  const dev = nodeByName('Device');
  if (!dev) return { checks, fatal: '没解析出 Device 节点，后续跳过' };
  select(dev.addr);
  await sleep(150);

  // ---------- 订阅开关 ----------
  const tabBtn = document.querySelector('[data-tab="events"]');
  if (tabBtn) tabBtn.click();
  await sleep(120);
  check('事件 tab 出现订阅按钮', document.querySelectorAll('[data-sub-toggle]').length === 4,
    'btns=' + document.querySelectorAll('[data-sub-toggle]').length);

  const before = subscriptionCount();
  await setSubscription(dev, 'DataChannelChanged', false);
  const d1 = nodeByName('Device');
  check('可取消单个订阅', !d1.subs.has('DataChannelChanged') && subscriptionCount() === before - 1,
    'count ' + before + '->' + subscriptionCount());
  check('取消状态已按路径持久化', memory.subsOff(d1.path).includes('DataChannelChanged'),
    JSON.stringify(memory.subsOff(d1.path)));

  await setSubscription(d1, 'DataChannelChanged', true);
  const d2 = nodeByName('Device');
  check('可恢复订阅', d2.subs.has('DataChannelChanged') && subscriptionCount() === before,
    'count=' + subscriptionCount());

  await setAllSubscriptions(d2, false);
  const offCount = nodeByName('Device').subs.size;
  await setAllSubscriptions(nodeByName('Device'), true);
  check('全部取消 / 全部订阅', offCount === 0 && nodeByName('Device').subs.size === 4,
    'off=' + offCount + ' on=' + nodeByName('Device').subs.size);

  // ---------- 通道学习 + 行内写入 ----------
  try {
    await session.ro(nodeByName('Device').addr).invoke('Bump', new Uint8Array(0));
  } catch (e) {
    say('note', 'invoke Bump 失败 :: ' + e.message);
  }
  const learnedOk = await waitFor(() => (nodeByName('Device')?.channels.size || 0) > 0, 5000);
  check('从事件学到通道名', learnedOk,
    JSON.stringify([...(nodeByName('Device')?.channels.keys() || [])]));

  select(nodeByName('Device').addr);
  // 之前为了看订阅按钮切到了事件 tab；写按钮只在通道 tab 渲染，先切回来。
  const chTab = document.querySelector('[data-tab="channels"]');
  if (chTab) chTab.click();
  await sleep(150);
  const wBtns = document.querySelectorAll('[data-write]');
  check('通道行渲染出写按钮', wBtns.length > 0, 'btns=' + wBtns.length);

  if (wBtns.length) {
    wBtns[0].click();
    await sleep(80);
    const input = document.querySelector('.write-row input');
    check('点「写」展开行内输入', !!input);

    if (input) {
      const originalPlaceholder = input.placeholder;
      input.value = '9';
      document.querySelector('.write-row [data-go]').click();

      // 注意：demo 对象的通道是只读的，服务端会拒绝 —— 这恰好覆盖"失败"分支。
      const wrote = await waitFor(() => state.events.some(
        (e) => e.isLog && String(e.path).includes('WriteData(')), 4000);
      const leftover = document.querySelector('.write-row');
      const goBtn = leftover?.querySelector('[data-go]');
      check('写入请求已送达服务端', wrote
        && state.events.some((e) => e.isLog && String(e.path).includes('WriteData(')));
      check('被拒时保留输入行并恢复按钮',
        !!leftover && goBtn && !goBtn.disabled,
        'rowKept=' + !!leftover + ' disabled=' + goBtn?.disabled);
      check('被拒时在输入框上给出错误提示',
        !!leftover && leftover.querySelector('input').placeholder !== originalPlaceholder,
        leftover ? leftover.querySelector('input').placeholder.slice(0, 40) : '-');

      // toggle：行还在，点一次应收起，再点一次应重新展开
      const again = document.querySelector('[data-write]');
      again.click();
      await sleep(60);
      const closed = !document.querySelector('.write-row');
      again.click();
      await sleep(60);
      const reopened = !!document.querySelector('.write-row');
      check('重复点击可收起 / 重新展开', closed && reopened,
        'closed=' + closed + ' reopened=' + reopened);
    }

    // 成功分支：demo 对象不给写，临时打桩验证"成功后收起"这条路径
    const realRo = session.ro.bind(session);
    session.ro = (addr) => {
      const ro = realRo(addr);
      ro.writeData = async () => {};
      return ro;
    };
    try {
      document.querySelector('[data-write]').click();
      await sleep(60);
      const fakeInput = document.querySelector('.write-row input');
      if (fakeInput) {
        fakeInput.value = '1';
        document.querySelector('.write-row [data-go]').click();
        const closedOnSuccess = await waitFor(
          () => !document.querySelector('.write-row'), 3000);
        check('写入成功时自动收起输入行（打桩）', closedOnSuccess);
      }
    } finally {
      session.ro = realRo;
    }
  }

  // ---------- 清单导入 / 导出 ----------
  const exp = exportSpecs();
  check('导出为逐行文本', exp.split('\n').length === state.specs.length,
    'lines=' + exp.split('\n').length + ' specs=' + state.specs.length);

  // 先移除一条，再用导入把它加回来 —— 这样才同时覆盖"新增成功"与"跳过重复"两条路径。
  const sensorSpec = state.specs.find((s) => s.value === 'Sensor');
  if (sensorSpec) await shin.workspace.removeSpec(sensorSpec.id);
  const { added, failed } = await addSpecs(['Sensor', 'Device', '# 注释', 'bad..path']);
  check('导入能加入新条目（其余重复项被跳过）', added.length === 1, 'added=' + added.length);
  check('导入报出非法行', failed.length === 1, 'failed=' + (failed[0]?.error || '-'));
  check('导入后节点数回到 4', state.nodes.length === 4, 'nodes=' + state.nodes.length);

  const ioToggle = document.getElementById('ws-io-toggle');
  if (ioToggle) {
    select(null);
    await sleep(120);
    const t = document.getElementById('ws-io-toggle');
    if (t) t.click();
    await sleep(120);
    check('导入导出面板可展开', !!document.getElementById('ws-io-text'));
  }

  say('summary', 'nodes=' + state.nodes.length + ' edges=' + state.edges.length
    + ' events=' + state.events.length + ' subs=' + subscriptionCount());

  return { checks, fatal: null };
}, { wsUrl: WS_URL, domain: DOMAIN });

// ---------- 多尺寸兜底 ----------
// 宿主的窗口尺寸不是恒定的 1280x720：显示器缩放系数一大，1280x720 逻辑像素就会超出工作区，
// 此时 WebviewWrapper::ApplyDesignSize 会**等比收缩**窗口（实测本机 200% 缩放下收到约 1185x664）。
// 也就是说前端必须在小一号的视口里也放得下 —— 下面这几档就是为它兜底的回归。
for (const vp of [
  { width: 1280, height: 720 },
  { width: 1185, height: 664 },
  { width: 1024, height: 600 },
  { width: 900, height: 560 },
]) {
  await page.setViewport(vp);
  await new Promise((r) => setTimeout(r, 350));
  const r = await page.evaluate(() => {
    const tb = document.getElementById('toolbar');
    const insp = document.getElementById('inspector').getBoundingClientRect();
    const tl = document.getElementById('timeline').getBoundingClientRect();
    return {
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      tbOver: tb.scrollWidth - tb.clientWidth,
      inspRight: Math.round(insp.right),
      tlBottom: Math.round(tl.bottom),
    };
  });
  const bad = r.sw > r.innerW + 1 || r.sh > r.innerH + 1
    || r.tbOver > 1 || r.inspRight > r.innerW + 1 || r.tlBottom > r.innerH + 1;
  result.checks.push({
    name: '视口 ' + vp.width + 'x' + vp.height + ' 不溢出',
    pass: !bad,
    detail: 'doc=' + r.sw + 'x' + r.sh + ' 顶栏溢出=' + r.tbOver
      + ' 检查器右边界=' + r.inspRight + ' 时间线下边界=' + r.tlBottom,
  });
}
await page.setViewport({ width: 1280, height: 720 });
await new Promise((r) => setTimeout(r, 200));

// ---------- WebGL 缺失的终止态 ----------
// 项目硬约束：拿不到 WebGL 就整块停摆（只留终止态面板 + 顶栏禁用），不做 2D 降级。
// 用 --disable-3d-apis 造出这个场景 —— 这条路径平时跑不到，而它恰恰是最容易腐烂的地方
// （面板样式刚被整体重写过）。
try {
  const b2 = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-first-run', '--disable-3d-apis', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const p2 = await b2.newPage();
  await p2.goto(APP_URL, { waitUntil: 'load' });
  await p2.waitForFunction(() => !!document.querySelector('.render-fatal'), { timeout: 20000 });
  const r = await p2.evaluate(() => {
    const box = document.querySelector('.rf-box').getBoundingClientRect();
    return {
      renderer: window.__shin?.state?.renderer,
      noRender: document.getElementById('stage').classList.contains('no-render'),
      hintHidden: document.getElementById('stage-hint').classList.contains('hidden'),
      connectDisabled: document.getElementById('tb-connect').disabled,
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight,
      boxH: box.height,
      items: document.querySelectorAll('.render-fatal ol li').length,
    };
  });
  result.checks.push({ name: 'WebGL 缺失 -> 渲染器停摆', pass: r.renderer === 'none', detail: 'renderer=' + r.renderer });
  result.checks.push({
    name: 'WebGL 缺失 -> 舞台浮层退场',
    pass: r.noRender && r.hintHidden,
    detail: 'no-render=' + r.noRender + ' hintHidden=' + r.hintHidden,
  });
  result.checks.push({ name: 'WebGL 缺失 -> 连接入口禁用', pass: r.connectDisabled, detail: 'disabled=' + r.connectDisabled });
  result.checks.push({
    name: 'WebGL 缺失 -> 终止态面板不溢出',
    pass: r.sw <= 1281 && r.sh <= 721 && r.boxH <= 720,
    detail: 'doc=' + r.sw + 'x' + r.sh + ' boxH=' + Math.round(r.boxH) + ' 排查项=' + r.items,
  });
  await p2.screenshot({ path: path.join(outDir, 'smoke-nowebgl.png') });
  await b2.close();
} catch (e) {
  result.checks.push({ name: 'WebGL 缺失的终止态', pass: false, detail: '未能造出场景：' + e.message });
}

await page.screenshot({ path: path.join(outDir, 'smoke-final.png') });
await browser.close();

console.log('\n================ 冒烟结果 ================');
if (result.fatal) console.log('中断：' + result.fatal);
let failed = 0;
for (const c of result.checks) {
  if (!c.pass) failed += 1;
  console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.detail ? '   (' + c.detail + ')' : ''));
}
console.log('共 ' + result.checks.length + ' 项，失败 ' + failed + ' 项');
console.log('截图：' + path.join(outDir, 'smoke-final.png'));
process.exit(failed || result.fatal ? 1 : 0);
