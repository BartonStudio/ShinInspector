// 顶栏：连接配置 + 状态 + 全局动作。
// 这里只负责收集意图并 emit，真正的连接与清单加载由 main.js 编排。

import { state, on, emit } from '../store.js';

const LS_URL = 'shin.lastUrl';
const LS_DOMAIN = 'shin.lastDomain';

const statusText = {
  idle: 'IDLE · 未连接',
  connecting: 'LINKING…',
  open: 'ONLINE',
  closed: 'LINK DOWN · 重连中…',
  error: 'ERROR',
};

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function mountToolbar(root) {
  root.innerHTML = `
    <div class="brand">Shin<span>::Inspector</span></div>
    <div class="dot" id="tb-dot"></div>
    <div class="conn-status" id="tb-status">未连接</div>
    <div class="spacer"></div>
    <label class="ibox"><b>&gt;</b><input type="text" id="tb-url" spellcheck="false" placeholder="ws://127.0.0.1:9002"></label>
    <label class="ibox"><b>&gt;</b><input type="text" id="tb-domain" spellcheck="false" placeholder="domain"></label>
    <button class="primary" id="tb-connect">连接</button>
    <button id="tb-rescan" disabled>重扫</button>
    <button id="tb-clear" disabled>清空清单</button>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const urlEl = $('tb-url');
  const domainEl = $('tb-domain');
  const hintEl = document.getElementById('conn-hint');

  /** 被手动「收起」的那一份诊断。按对象身份比对 —— 新的诊断结论会自动重新弹出。 */
  let hintDismissed = null;

  urlEl.value = localStorage.getItem(LS_URL) || 'ws://127.0.0.1:9002';
  domainEl.value = localStorage.getItem(LS_DOMAIN) || 'shininspector';

  // 用户一动地址，上一条诊断就作废了 —— 它描述的是另一组参数下的事实。
  for (const el of [urlEl, domainEl]) {
    el.addEventListener('input', () => {
      if (state.connection.diagnosis) hintDismissed = state.connection.diagnosis;
      renderHint();
    });
  }

  $('tb-connect').onclick = () => {
    if (sessionOpen()) {
      emit('disconnect-request');
      return;
    }
    const url = urlEl.value.trim() || 'ws://127.0.0.1:9002';
    const domain = domainEl.value.trim() || 'shininspector';
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_DOMAIN, domain);
    emit('connect-request', { url, domain });
  };

  $('tb-rescan').onclick = () => emit('rescan-request');
  $('tb-clear').onclick = () => {
    if (confirm('清空观察清单？仅保留 root 锚点。')) emit('clear-request');
  };

  // 回车即连接
  for (const el of [urlEl, domainEl]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('tb-connect').click();
    });
  }

  function sessionOpen() {
    const s = state.connection.status;
    return s === 'open' || s === 'connecting';
  }

  /** WebGL 缺失时渲染层直接停摆，此时连接目标没有意义，所有入口一律禁用。 */
  function rendererBlocked() {
    return state.renderer !== null && state.renderer !== 'webgl';
  }

  /**
   * 连接失败提示条。
   *
   * 「连不上」是个多义现象（端口没开 / 域名不对 / 协议填错 / 防火墙），
   * 而传输层给不出任何线索 —— 所以这里必须把诊断结论和「下一步做什么」
   * 摆在顶栏，而不是只在几秒后就滚走的日志里留一句 "WebSocket 连接错误"。
   */
  function renderHint() {
    const d = state.connection.diagnosis;
    if (!d || hintDismissed === d) {
      hintEl.classList.add('hidden');
      hintEl.innerHTML = '';
      return;
    }
    hintEl.innerHTML = `
      <span class="ch-tag">连接诊断</span>
      <div class="ch-body">
        <div class="ch-title">${esc(d.reason)}</div>
        <div class="ch-detail">${esc(d.detail)}</div>
        ${d.actions?.length
          ? `<ol>${d.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`
          : ''}
      </div>
      <div class="ch-actions">
        <button class="tiny" id="ch-retry">重试连接</button>
        <button class="tiny ghost" id="ch-close">收起</button>
      </div>
    `;
    hintEl.classList.remove('hidden');
    // 重试走顶栏同一个入口，这样用户改了地址再点「重试」才符合预期。
    hintEl.querySelector('#ch-retry').onclick = () => $('tb-connect').click();
    hintEl.querySelector('#ch-close').onclick = () => {
      hintDismissed = d;
      renderHint();
    };
  }

  function render() {
    const c = state.connection;
    const blocked = rendererBlocked();

    if (blocked) {
      $('tb-dot').className = 'dot error';
      $('tb-status').textContent = 'FATAL · WebGL 不可用，已停止渲染';
    } else {
      $('tb-dot').className = 'dot ' + c.status;
      let text = statusText[c.status] || c.status;
      if (c.status === 'open') text = 'ONLINE ' + c.url + ' :: ' + c.domain;
      if (c.status === 'error' && c.error) text = 'ERROR 连接失败：' + c.error;
      if (c.status === 'connecting') text = 'LINKING ' + c.url + ' …';
      $('tb-status').textContent = text;
    }

    $('tb-connect').textContent = sessionOpen() ? '断开' : '连接';
    $('tb-connect').classList.toggle('primary', !sessionOpen());
    $('tb-connect').disabled = blocked;
    $('tb-rescan').disabled = blocked || c.status !== 'open';
    $('tb-clear').disabled = blocked || c.status !== 'open' || state.specs.length <= 1;

    renderHint();
  }

  on('connection', render);
  on('workspace', render);
  on('topology', render);
  render();

  return {
    values: () => ({ url: urlEl.value.trim(), domain: domainEl.value.trim() }),
  };
}
