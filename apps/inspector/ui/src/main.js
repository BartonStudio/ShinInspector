// 装配入口：把所有模块接起来，并编排「连接 -> 加载清单 -> 解析 -> 订阅」这条流程。

import { state, on, emit, select, logLine, setUI } from './store.js';
import { session } from './session.js';
import { memory } from './memory.js';
import { mountToolbar } from './panel/toolbar.js';
import { mountStageBar } from './panel/stagebar.js';
import { mountInspector } from './panel/inspector.js';
import { mountTimeline } from './panel/timeline.js';
import { mountRenderer, setBaseHint } from './render/index.js';
import { bootstrapWorkspace, resolveAll, clearNodes, addSpec, addSpecs, removeSpec, exportSpecs } from './workspace.js';
import { cancelAll, setSubscription, setAllSubscriptions, subscriptionCount } from './observe.js';

const stageHint = document.getElementById('stage-hint');
const graphHost = document.getElementById('graph-host');

setBaseHint(stageHint, `
  画布上只显示你加入的节点。<br>
  先在顶栏连上目标应用，然后在右侧「观察清单」里加入对象，<br>
  例如 <code>Device.Sub</code> 或 <code>0x7FF6A1C0</code>。
`);

const renderer = mountRenderer(graphHost, (addr) => select(addr));
state.renderer = renderer.kind;

// 渲染器停摆 => 整个 UI 停摆：没有对象图，连上目标也是徒劳。
// 首帧就先按渲染器状态裁决一次，避免引导语在错误面板上闪现。
syncStageHint();

mountToolbar(document.getElementById('toolbar'));
mountStageBar(document.getElementById('stage-bar'));
mountInspector(document.getElementById('inspector'));
mountTimeline(document.getElementById('timeline'));

// 舞台中央引导语的唯一裁决点。
// 曾经散落在 4 个事件回调里各自 toggle，任何一个漏判都会让它在不该出现时冒出来
// （渲染器停摆时尤其明显：文字直接压在错误面板上）。
function syncStageHint() {
  const blocked = !renderer.ok;
  // 渲染器停摆时，舞台上所有浮层（布局按钮、引导语、图例）都是噪音，一律退场。
  document.getElementById('stage').classList.toggle('no-render', blocked);
  stageHint.classList.toggle('hidden',
    blocked || (state.connection.status === 'open' && state.nodes.length > 0));
}

// ---------------- 布局与渲染联动 ----------------

on('topology', () => {
  renderer.layout.rebuild();
  renderer.autoFrame();
  syncStageHint();
});

on('workspace', syncStageHint);

// 布局模式不再有 UI 入口（见 panel/stagebar.js）：默认力导向，只在结构变化时重跑。
// 需要临时看层级时可以在控制台执行 __shin.renderer.layout.setMode('radial')。

on('focus-node', () => renderer.frameNow());

// ---------------- 连接编排 ----------------

on('connect-request', async ({ url, domain }) => {
  try {
    await session.connect(url, domain);
  } catch {
    return; // 状态已在顶栏体现
  }
  memory.bind(domain);
  await bootstrapWorkspace(url, domain);
  renderer.autoFrame();
  syncStageHint();
});

on('disconnect-request', async () => {
  await cancelAll();
  await session.close();
  clearNodes();
  syncStageHint();
});

on('rescan-request', async () => {
  await resolveAll();
  renderer.autoFrame();
});

on('clear-request', async () => {
  state.specs = state.specs.filter((s) => s.kind === 'root');
  localStorage.removeItem('shin.workspace.' + state.connection.url + '|' + state.connection.domain);
  await resolveAll();
  syncStageHint();
});

/** 断线重连后 addr 全变，必须重新解析清单。 */
on('reconnected', async () => {
  memory.bind(state.connection.domain);
  logLine('重连成功，重新解析观察清单…');
  await resolveAll();
  renderer.autoFrame();
  syncStageHint();
});

on('connection', syncStageHint);

// ---------------- 键盘快捷键 ----------------

window.addEventListener('keydown', (e) => {
  const t = e.target;
  // 正在输入时一律不抢按键
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement
    || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;

  switch (e.key) {
    case 'f': case 'F':
      renderer.frameNow();
      break;
    case 'Escape':
      select(null);
      break;
    case ' ':
      e.preventDefault();
      setUI({ frozen: !state.ui.frozen });
      break;
    case 'r': case 'R':
      emit('rescan-request');
      break;
    case '/':
      e.preventDefault();
      select(null); // 清单视图才有「加入」输入框
      requestAnimationFrame(() => document.getElementById('ws-add')?.focus());
      break;
    default:
      break;
  }
});

logLine(renderer.ok
  ? 'ShinInspector 已就绪（渲染器：' + renderer.kind + '）'
  : 'WebGL 不可用，已停止渲染 —— 请查看画布中的排查提示。');

// 把视口与 DPR 记进时间线：宿主按显示器缩放系数给窗口定尺寸（1280x720 逻辑像素，
// 装不下会等比收缩），这两个数字就是"DPI 到底有没有被正确适配"的现场证据 ——
// 例如 200% 缩放下 DPR 应是 2，CSS 视口约 1267x712。
logLine('视口 ' + window.innerWidth + 'x' + window.innerHeight
  + ' @DPR ' + window.devicePixelRatio + '（宿主设计尺寸 1280x720）');

// ---------------- 调试句柄 ----------------
// 在 DevTools 里可直接操作本工具：__shin.emit('rescan-request')、
// __shin.state.nodes、__shin.workspace.addSpec('Device.Sub')…
//
// 之所以要显式暴露，是因为 Vite dev server 会给模块 URL 挂 HMR 时间戳（?t=…），
// 从控制台或外部脚本 import('/src/store.js') 拿到的是**另一个模块实例**，
// 读到的 state 全是初始值 —— apps/inspector/ui/tools/smoke.mjs 就踩过这个坑。
window.__shin = {
  state, emit, on, select, setUI, logLine, renderer,
  session, memory,
  workspace: { addSpec, addSpecs, removeSpec, exportSpecs, resolveAll, clearNodes, bootstrapWorkspace },
  observe: { setSubscription, setAllSubscriptions, subscriptionCount, cancelAll },
};
