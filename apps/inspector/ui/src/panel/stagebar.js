// 画布浮层：冻结开关 + 实时计数。
//
// 这里曾经还有「力导向 / 径向」两个布局切换按钮，现已移除：
// 布局默认就是力导向，也没人真的会去切——两个常年只亮一个的按钮纯属噪音。
// layout.js 的 setMode('radial') 仍然保留，需要时可以在控制台里
// `__shin.renderer.layout.setMode('radial')` 手动切回来。

import { state, on, setUI } from '../store.js';
import { subscriptionCount } from '../observe.js';

export function mountStageBar(el) {
  el.innerHTML = `
    <button class="tiny" id="sb-freeze" title="冻结布局（空格）">冻结</button>
    <span class="counts" id="sb-counts"></span>
  `;
  const $ = (id) => el.querySelector('#' + id);

  $('sb-freeze').onclick = () => setUI({ frozen: !state.ui.frozen });

  function render() {
    $('sb-freeze').classList.toggle('on', state.ui.frozen);

    const subs = subscriptionCount();
    $('sb-counts').textContent =
      state.nodes.length + ' 节点 / ' + state.edges.length + ' 边 / ' +
      state.events.length + ' 事件' + (subs ? ' / ' + subs + ' 订阅' : '');
  }

  on('ui', render);
  on('topology', render);
  on('workspace', render);
  on('event', () => { /* 事件计数靠时间线重绘时的节流刷新 */ });
  setInterval(render, 1000);
  render();
}
