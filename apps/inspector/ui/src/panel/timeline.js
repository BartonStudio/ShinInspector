// 事件时间线：替代原来的日志框，做成这工具的「控制台」。
// 事件可能很密集，所以渲染用 rAF 节流 + 只保留最近若干行。

import { state, on, emit, select, setUI } from '../store.js';
import { describe } from '../bytes.js';

const MAX_ROWS = 300;

const FILTERS = { all: null, structure: ['ChildConnected', 'ChildDisconnected', 'Released'], data: ['DataChannelChanged'] };

export function mountTimeline(root) {
  root.innerHTML = `
    <div class="tl-head">
      <button class="ghost tiny" id="tl-fold">收起</button>
      <span class="title">事件时间线</span>
      <button class="tiny" id="tl-all">全部</button>
      <button class="tiny" id="tl-struct">结构</button>
      <button class="tiny" id="tl-data">数据</button>
      <span class="spacer" style="flex:1"></span>
      <span class="counts" id="tl-count"></span>
      <button class="tiny" id="tl-pause">暂停</button>
      <button class="tiny" id="tl-clear">清空</button>
    </div>
    <div class="tl-body" id="tl-body"></div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const body = $('tl-body');
  let dirty = true;
  let scheduled = false;
  let autoScroll = true;

  body.addEventListener('scroll', () => {
    autoScroll = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
  });

  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-addr]');
    if (!row) return;
    const addr = Number(row.dataset.addr);
    if (Number.isFinite(addr) && addr > 0) select(addr);
  });

  function markDirty() {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; flush(); });
  }

  function visibleRows() {
    const keep = FILTERS[state.ui.eventFilter];
    const list = keep ? state.events.filter((e) => keep.includes(e.type)) : state.events;
    return list.slice(-MAX_ROWS);
  }

  function flush() {
    if (!dirty) return;
    dirty = false;

    const rows = visibleRows();
    $('tl-count').textContent = state.events.length + ' 条' + (state.ui.eventPaused ? '（已暂停）' : '');

    if (rows.length === 0) {
      body.innerHTML = '<div class="empty">暂无事件。连接后在检查器里加入节点，事件会实时出现在这里。</div>';
      return;
    }

    body.innerHTML = rows.map((e) => {
      const payload = e.isLog
        ? ''
        : [e.channel, e.primary || (e.data ? describe(e.data).primary : '')].filter(Boolean).join('  ');
      return `<div class="tl-row" ${e.addr ? `data-addr="${e.addr}"` : ''}>
        <span class="t">${fmtTime(e.ts)}</span>
        <span class="ty ${tyClass(e.type)}">${esc(e.isLog ? 'log' : e.type)}</span>
        <span class="path">${esc(e.path || '')}</span>
        <span class="pay">${esc(payload)}</span>
      </div>`;
    }).join('');

    if (autoScroll) body.scrollTop = body.scrollHeight;
  }

  function renderButtons() {
    const f = state.ui.eventFilter;
    $('tl-all').classList.toggle('on', f === 'all');
    $('tl-struct').classList.toggle('on', f === 'structure');
    $('tl-data').classList.toggle('on', f === 'data');
    $('tl-pause').classList.toggle('on', state.ui.eventPaused);
    $('tl-pause').textContent = state.ui.eventPaused ? '继续' : '暂停';
    $('tl-fold').textContent = root.classList.contains('collapsed') ? '展开' : '收起';
  }

  $('tl-all').onclick = () => { setUI({ eventFilter: 'all' }); markDirty(); renderButtons(); };
  $('tl-struct').onclick = () => { setUI({ eventFilter: 'structure' }); markDirty(); renderButtons(); };
  $('tl-data').onclick = () => { setUI({ eventFilter: 'data' }); markDirty(); renderButtons(); };
  $('tl-pause').onclick = () => { setUI({ eventPaused: !state.ui.eventPaused }); markDirty(); renderButtons(); };
  $('tl-clear').onclick = () => { state.events.length = 0; markDirty(); };
  $('tl-fold').onclick = () => {
    root.classList.toggle('collapsed');
    renderButtons();
  };

  on('event', markDirty);
  on('ui', () => { markDirty(); renderButtons(); });
  on('reconnected', () => { state.events.length = 0; markDirty(); });

  markDirty();
  renderButtons();
  flush();
  setInterval(markDirty, 1500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function tyClass(type) {
  if (['ChildConnected', 'ChildDisconnected', 'DataChannelChanged', 'Released'].includes(type)) {
    return 'ty-' + type;
  }
  if (type === 'log') return 'ty-conn';
  return 'ty-other';
}

function fmtTime(d) {
  const t = new Date(d);
  return t.toLocaleTimeString('zh-CN', { hour12: false }) + '.' +
    String(t.getMilliseconds()).padStart(3, '0');
}
