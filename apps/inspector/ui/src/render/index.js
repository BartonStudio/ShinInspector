// 渲染层入口。WebGL 是硬性要求：拿不到上下文就不渲染任何东西。
//
// 这里刻意不提供降级路径 —— 本工具的全部价值在于「空间化地看对象图」，
// 一个画不出边的平面图会误导判断（3D 布局被压平后连线重叠、深度信息丢失）。
// 宁可直接停摆并说清原因，也不给一个看起来能用的残次品。

import { createLayout } from './layout.js';
import { webglSupported, createScene } from './scene.js';
import { createGraph } from './graph.js';

const SETTLED_ALPHA = 0.015;

export function mountRenderer(host, { onPick }) {
  const layout = createLayout();

  // 探测与初始化分两步：探测只能说明"理论上能拿到上下文"，
  // 真正建 WebGLRenderer 时仍可能因为驱动 / 显存 / 上下文数上限而抛错。
  let view = null;
  let failure = '';
  if (!webglSupported()) {
    failure = '当前环境没有可用的 WebGL 上下文（webgl / webgl2 均创建失败）。';
  } else {
    try {
      view = createScene(host);
    } catch (e) {
      failure = (e && e.message) ? e.message : String(e);
    }
  }

  if (failure) {
    host.innerHTML = '';
    showFatal(host, failure);
    // layout 仍然返回：保持对外接口形状一致，调用方无需到处判空。
    // 但没有任何东西会去 tick 它，画布也不会挂载。
    return {
      kind: 'none',
      ok: false,
      layout,
      autoFrame() {},
      frameNow() {},
      dispose() {},
    };
  }

  const graph = createGraph(view);

  // 取景必须等力导向把节点推开之后再做：刚 rebuild 时所有节点还叠在原点，
  // 这时候算包围盒会得到一个退化的点，相机就会贴到脸上。
  let autoFrameArmed = false;
  let userInteracted = false;

  view.addFrame(() => {
    layout.tick();
    graph.update();
    if (autoFrameArmed && !userInteracted && layout.alpha() < SETTLED_ALPHA) {
      autoFrameArmed = false;
      view.frameAll(graph.bounds());
    }
  });

  const down = { x: 0, y: 0 };
  const canvas = view.renderer.domElement;
  canvas.addEventListener('wheel', () => { userInteracted = true; }, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    down.x = e.clientX;
    down.y = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
    // 拖拽旋转相机时不要误触发选中
    if (moved) {
      userInteracted = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const node = graph.pick(ndcX, ndcY);
    onPick(node ? node.addr : null);
  });

  return {
    kind: 'webgl',
    ok: true,
    layout,
    /** 图结构变化后调用：等布局收敛再自动取景一次（用户已手动转过相机就不抢镜）。 */
    autoFrame() { userInteracted = false; autoFrameArmed = true; },
    frameNow() { view.frameAll(graph.bounds()); },
    dispose() { graph.dispose(); view.dispose(); },
  };
}

/** WebGL 缺失时的终止态面板：不画图，只把原因和排查方向说清楚。 */
function showFatal(host, detail) {
  const el = document.createElement('div');
  el.className = 'render-fatal';
  el.innerHTML = `
    <div class="rf-box">
      <div class="rf-head">
        <span class="rf-tag">WebGL 不可用</span>
        <span class="rf-title">已停止渲染</span>
      </div>
      <p class="rf-lead">
        本工具依赖 WebGL 渲染对象图，没有降级方案。<br>
        连接、观察清单、事件时间线都随渲染器一并停用，以免给出失真的画面。
      </p>
      <div class="rf-detail">${escapeHtml(detail)}</div>
      <div class="rf-block">
        <div class="rf-block-title">排查方向</div>
        <ol>
          <li>打开 <code>chrome://gpu</code>（或 <code>edge://gpu</code>）确认 WebGL 处于 Enabled，而非 Disabled / Software only。</li>
          <li>远程桌面 / 虚拟机 / 无显示器会话常常拿不到 GPU，改在本机物理桌面运行。</li>
          <li>检查显卡驱动是否正常，必要时关闭浏览器/WebView2 的硬件加速黑名单。</li>
          <li>WebView2 宿主：确认启动参数和环境变量 <code>WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS</code> 里没有 <code>--disable-gpu</code>、<code>--disable-software-rasterizer</code> 这类开关。</li>
        </ol>
      </div>
    </div>
  `;
  host.appendChild(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 舞台中央的基础提示（"先在顶栏连接…"），由 main.js 在装配时写入。
let baseHint = '';

export function setBaseHint(el, html) {
  baseHint = html;
  if (el) el.innerHTML = baseHint;
}
