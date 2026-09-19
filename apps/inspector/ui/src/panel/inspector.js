// 检查器：未选中时是「观察清单」管理器，选中时是节点详情面板。
//
// 设计要点：协议没有反射，所以「有哪些通道 / 有哪些方法」不是查出来的，是**学出来的** ——
// 通道来自订阅到的 DataChannelChanged 与手动重读，方法来自调用历史（按对象路径持久化）。

import { state, on, emit, select, logLine, nodeByAddr } from '../store.js';
import { session } from '../session.js';
import { memory } from '../memory.js';
import { describe, parseBytes, bytesToHex, errText, shortAddr } from '../bytes.js';
import { addSpec, removeSpec, addByPath, describeSpec, addSpecs, exportSpecs } from '../workspace.js';
import { BUILTIN_EVENTS, setSubscription, setAllSubscriptions } from '../observe.js';

export function mountInspector(el) {
  let tab = 'channels';
  let invokeResult = '';
  let inspectingChannel = null; // { name, mode: 'read'|'write' }
  let draftMethod = '';
  let listFilter = '';
  let ioOpen = false;
  let ioNote = '';

  /**
   * 重绘。
   * 检查器里全是输入框，而事件（DataChannelChanged 之类）会频繁触发重绘 ——
   * 不保留焦点与光标位置的话，打字打到一半就会被抢走焦点。
   */
  function render() {
    const active = document.activeElement;
    const keepId = active && el.contains(active) && active.id ? active.id : null;
    const keepPos = keepId && 'selectionStart' in active ? active.selectionStart : null;

    const node = state.selection ? nodeByAddr(state.selection) : null;
    el.innerHTML = node ? nodeView(node) : listView();
    bind(node);

    if (keepId) {
      const again = el.querySelector('#' + keepId);
      if (again) {
        again.focus();
        if (keepPos != null && typeof again.setSelectionRange === 'function') {
          try { again.setSelectionRange(keepPos, keepPos); } catch { /* 某些 input 类型不支持 */ }
        }
      }
    }
  }

  // ======================= 观察清单 =======================

  function listView() {
    const f = listFilter.trim().toLowerCase();
    const nameOf = (spec) => {
      const n = state.nodes.find((x) => x.spec === spec);
      return n ? (n.name || '') : '';
    };
    const visible = f
      ? state.specs.filter((s) => (describeSpec(s) + ' ' + nameOf(s)).toLowerCase().includes(f))
      : state.specs;

    const rows = visible.map((spec) => {
      const failed = !!spec.error;
      const isRoot = spec.kind === 'root';
      return `
        <div class="spec ${failed ? 'failed' : ''} ${isRoot ? 'root' : ''}" data-spec="${esc(spec.id)}">
          <span class="kind">${isRoot ? '锚点' : spec.kind === 'addr' ? '地址' : '路径'}</span>
          <span class="label" ${failed ? '' : `data-goto="1"`} title="${esc(spec.error || describeSpec(spec))}">
            ${esc(describeSpec(spec))}
          </span>
          ${isRoot ? '' : '<button class="ghost tiny x" data-del="1">移除</button>'}
        </div>
        ${failed ? `<div class="note err" style="margin:-3px 0 6px 4px">${esc(spec.error)}</div>` : ''}
      `;
    }).join('');

    return `
      <div class="sec">
        <h3>观察清单</h3>
        <div class="note" style="margin-bottom:10px">
          画布上只显示你加入的对象，工具不会扫描整棵树。<br>
          路径相对 root，例如 <code>Device.Sub</code>；也可直接填 <code>0x7FF6A1C0</code>。
        </div>
        <div class="field">
          <input type="text" id="ws-add" spellcheck="false" placeholder="Device.Sub 或 0x…">
          <button class="primary" id="ws-add-btn">加入</button>
        </div>
        ${state.specs.length > 5 || f ? `
        <div class="field">
          <input type="text" id="ws-filter" spellcheck="false" placeholder="筛选清单…" value="${esc(listFilter)}">
        </div>` : ''}
        ${visible.length
          ? rows
          : `<div class="note">${state.specs.length ? '没有匹配的条目。' : '清单为空。'}</div>`}
        <div class="field" style="margin-top:8px">
          <button class="ghost tiny" id="ws-io-toggle">${ioOpen ? '收起' : '导入 / 导出'}</button>
          <span class="note">共 ${state.specs.length} 条</span>
        </div>
        ${ioOpen ? `
        <div class="io-box">
          <textarea id="ws-io-text" spellcheck="false"
            placeholder="每行一个对象，例如：&#10;Device.Sub&#10;0x7FF6A1C0">${esc(exportSpecs())}</textarea>
          <div class="field" style="margin:6px 0 0">
            <button class="primary tiny" id="ws-io-import">按文本导入</button>
            <button class="ghost tiny" id="ws-io-refresh">导出当前清单</button>
            <button class="ghost tiny" id="ws-io-copy">复制</button>
          </div>
          <div class="note" id="ws-io-note">${esc(ioNote || '导入会跳过重复项，以 # 开头的行视为注释。')}</div>
        </div>` : ''}
      </div>
      ${state.connection.status !== 'open'
        ? '<div class="note warn">尚未连接，清单无法解析。填入 ws 地址后点顶栏「连接」。</div>'
        : ''}
    `;
  }

  function bindList() {
    const input = el.querySelector('#ws-add');
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromInput(); });
    }
    const btn = el.querySelector('#ws-add-btn');
    if (btn) btn.onclick = addFromInput;

    const filter = el.querySelector('#ws-filter');
    if (filter) {
      filter.addEventListener('input', () => {
        listFilter = filter.value;
        render(); // 光标与焦点由 render() 的 keepFocus 逻辑还原
      });
    }

    const ioToggle = el.querySelector('#ws-io-toggle');
    if (ioToggle) ioToggle.onclick = () => { ioOpen = !ioOpen; render(); };

    const ioImport = el.querySelector('#ws-io-import');
    if (ioImport) ioImport.onclick = doImport;

    const ioRefresh = el.querySelector('#ws-io-refresh');
    if (ioRefresh) {
      ioRefresh.onclick = () => {
        const ta = el.querySelector('#ws-io-text');
        if (ta) ta.value = exportSpecs();
        setIoNote('已填入当前清单，共 ' + state.specs.length + ' 条。');
      };
    }

    const ioCopy = el.querySelector('#ws-io-copy');
    if (ioCopy) {
      ioCopy.onclick = async () => {
        const ta = el.querySelector('#ws-io-text');
        const text = ta?.value || '';
        try {
          await navigator.clipboard.writeText(text);
          setIoNote('已复制 ' + text.split('\n').filter(Boolean).length + ' 行到剪贴板。');
        } catch {
          // 无剪贴板权限（非安全上下文等）时退化为全选，让用户自己复制
          ta?.focus();
          ta?.select();
          setIoNote('浏览器拒绝了剪贴板写入，已选中文本，按 Ctrl+C 复制。');
        }
      };
    }

    for (const row of el.querySelectorAll('.spec')) {
      const id = row.dataset.spec;
      const del = row.querySelector('[data-del]');
      if (del) {
        del.onclick = async () => {
          try { await removeSpec(id); } catch (e) { logLine('移除失败：' + errText(e)); }
        };
      }
      const goto = row.querySelector('[data-goto]');
      if (goto) {
        goto.onclick = () => {
          const spec = state.specs.find((s) => s.id === id);
          if (!spec) return;
          const node = state.nodes.find((n) => n.spec === spec)
            || (spec.kind === 'root' ? state.nodes.find((n) => n.isRoot) : null);
          if (node) select(node.addr);
        };
      }
    }
  }

  async function doImport() {
    const ta = el.querySelector('#ws-io-text');
    if (!ta) return;
    try {
      const { added, failed } = await addSpecs(ta.value.split(/\r?\n/));
      const parts = ['新增 ' + added.length + ' 条'];
      if (failed.length) parts.push('格式非法 ' + failed.length + ' 条');
      setIoNote(parts.join('，') + '。'
        + (failed.length ? '例：' + failed[0].line + ' —— ' + failed[0].error : ''));
      logLine('导入清单：' + parts.join('，'));
    } catch (e) {
      setIoNote('导入失败：' + errText(e));
    }
    render();
  }

  /** 导入结果提示要能扛过 render()（重绘会把 textarea 恢复成当前清单）。 */
  function setIoNote(text) {
    ioNote = text;
    const n = el.querySelector('#ws-io-note');
    if (n) n.textContent = text;
  }

  async function addFromInput() {
    const input = el.querySelector('#ws-add');
    if (!input || !input.value.trim()) return;
    const raw = input.value.trim();
    try {
      await addSpec(raw);
      input.value = '';
      render();
    } catch (e) {
      logLine('加入失败：' + errText(e));
      flash(input, '加入失败：' + errText(e));
    }
  }

  // ======================= 节点详情 =======================

  function nodeView(node) {
    const tabs = `
      <div class="tabs">
        <button class="tiny ${tab === 'channels' ? 'on' : ''}" data-tab="channels">通道</button>
        <button class="tiny ${tab === 'methods' ? 'on' : ''}" data-tab="methods">方法</button>
        <button class="tiny ${tab === 'events' ? 'on' : ''}" data-tab="events">事件</button>
      </div>`;

    return `
      <div class="sec">
        <div class="node-title">${esc(node.name || shortAddr(node.addr))}
          ${node.released ? '<span class="note err">已 Released</span>' : ''}
        </div>
        <div class="node-sub">${esc(node.path || '（地址声明，路径未知）')}</div>
        <div class="kv"><span>addr</span><span>${esc(shortAddr(node.addr))}</span></div>
        <div class="kv"><span>深度</span><span>${node.depth ?? '-'}</span></div>
        <div class="kv"><span>子节点</span><span>${
          node.childError ? '读取失败' : (node.childCount ?? '-')
        }</span></div>
        <div class="kv"><span>订阅</span><span>${node.subs ? node.subs.size : 0} / ${BUILTIN_EVENTS.length}</span></div>
        ${node.childError ? `<div class="note err" style="margin-top:6px">${esc(node.childError)}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="tiny ghost" data-act="focus">定位</button>
          <button class="tiny ghost" data-act="unselect">返回清单</button>
        </div>
      </div>

      ${unjoinedBlock(node)}

      <div class="sec">
        ${tabs}
        ${tab === 'channels' ? channelsBlock(node) : ''}
        ${tab === 'methods' ? methodsBlock(node) : ''}
        ${tab === 'events' ? eventsBlock(node) : ''}
      </div>
    `;
  }

  function unjoinedBlock(node) {
    if (!node.unjoined || node.unjoined.length === 0) return '';
    const items = node.unjoined.map((c) => `
      <div class="row">
        <span class="name">${esc(c.name)}</span>
        <button class="ghost tiny" data-join="${esc(c.path || c.name)}">加入</button>
      </div>
    `).join('');
    return `
      <div class="sec">
        <h3>探到的子节点（未加入）</h3>
        ${items}
      </div>`;
  }

  function channelsBlock(node) {
    const names = new Set();
    for (const name of node.channels.keys()) names.add(name);
    for (const name of memory.channelNames(node.path)) names.add(name);

    const rows = [...names].sort().map((name) => {
      const live = node.channels.get(name);
      const value = live ? live.primary : '（未读到值）';
      const hex = live?.hex || '';
      return `
        <div class="row" data-chan="${esc(name)}">
          <span class="name">${esc(name)}</span>
          <span class="val" title="${esc(hex)}"><b data-val>${esc(value)}</b></span>
          <button class="ghost tiny" data-read="${esc(name)}">读</button>
          <button class="ghost tiny" data-write="${esc(name)}">写</button>
        </div>
      `;
    }).join('');

    return `
      ${rows || '<div class="row empty">暂无已观测通道</div>'}
      <div class="note" style="margin:8px 0 10px">
        通道名无法从协议查询，这里列出的是订阅期间观察到过的通道，以及你手动读过的通道。
      </div>
      <h3>手动读取 / 写入</h3>
      <div class="field">
        <input type="text" id="ch-name" spellcheck="false" placeholder="通道名" value="${esc(inspectingChannel?.name || '')}">
        <button class="ghost tiny" id="ch-read">读</button>
      </div>
      <div class="field">
        <input type="text" id="ch-data" spellcheck="false" placeholder="hex 或文本">
        <select id="ch-astext"><option value="0">hex</option><option value="1">文本</option></select>
        <button class="ghost tiny" id="ch-write">写</button>
      </div>
    `;
  }

  function methodsBlock(node) {
    const learned = memory.methodNames(node.path);
    const chips = learned.length
      ? learned.map((m) => `<span class="chip ${draftMethod === m ? 'on' : ''}" data-method="${esc(m)}">${esc(m)}</span>`).join('')
      : '<span class="note">还没有调用历史。调用成功的方法会自动记在这里（按对象路径持久化）。</span>';

    return `
      <div class="chips" style="margin-bottom:10px">${chips}</div>
      <div class="field">
        <input type="text" id="m-name" spellcheck="false" placeholder="方法名，如 Echo" value="${esc(draftMethod)}">
      </div>
      <div class="field">
        <input type="text" id="m-args" spellcheck="false" placeholder="参数（hex 或文本）">
        <select id="m-astext"><option value="1">文本</option><option value="0">hex</option></select>
        <button class="primary tiny" id="m-go">执行</button>
      </div>
      ${invokeResult ? `<div class="row" style="align-items:flex-start"><span class="val" style="margin:0;text-align:left">${esc(invokeResult)}</span></div>` : ''}
    `;
  }

  function eventsBlock(node) {
    const builtin = BUILTIN_EVENTS.map((t) => {
      const on = !!node.subs?.has(t);
      return `
      <div class="row">
        <span class="name">${esc(t)}</span>
        <span class="val">${on ? '已订阅' : '<span style="color:var(--text-faint)">未订阅</span>'}</span>
        <button class="ghost tiny" data-sub-toggle="${esc(t)}" data-on="${on ? '0' : '1'}">${on ? '取消' : '订阅'}</button>
      </div>`;
    }).join('');

    const mine = state.events.filter((e) => e.addr === node.addr).slice(-20).reverse();
    const rows = mine.length
      ? mine.map((e) => `
          <div class="row">
            <span class="name ${tyClass(e.type)}">${esc(e.type)}</span>
            <span class="val">${esc(e.channel || e.primary || '')} · ${esc(fmtTime(e.ts))}</span>
          </div>`).join('')
      : '<div class="row empty">暂无事件</div>';

    return `
      <h3>内置事件订阅</h3>
      ${builtin}
      <div style="display:flex;gap:6px;margin:8px 0 12px">
        <button class="tiny ghost" id="ev-on">全部订阅</button>
        <button class="tiny ghost" id="ev-off">全部取消</button>
      </div>
      <div class="note" style="margin-bottom:12px">
        关掉的类型不再接收该事件，选择会按对象路径记住 —— 重解析清单后不会被自动打开。
      </div>
      <h3>该节点最近事件</h3>
      ${rows}
    `;
  }

  // ======================= 绑定 =======================

  function bind(node) {
    if (!node) { bindList(); return; }

    for (const b of el.querySelectorAll('[data-tab]')) {
      b.onclick = () => { tab = b.dataset.tab; render(); };
    }
    const focusBtn = el.querySelector('[data-act="focus"]');
    if (focusBtn) focusBtn.onclick = () => emit('focus-node', node.addr);
    const unsel = el.querySelector('[data-act="unselect"]');
    if (unsel) unsel.onclick = () => select(null);

    for (const b of el.querySelectorAll('[data-join]')) {
      b.onclick = async () => {
        try { await addByPath(b.dataset.join); } catch (e) { logLine('加入失败：' + errText(e)); }
      };
    }

    for (const b of el.querySelectorAll('[data-read]')) {
      b.onclick = () => readChannel(node, b.dataset.read);
    }
    for (const b of el.querySelectorAll('[data-write]')) {
      b.onclick = () => openInlineWrite(b.closest('.row'), node, b.dataset.write);
    }
    const chName = el.querySelector('#ch-name');
    const chRead = el.querySelector('#ch-read');
    if (chRead) chRead.onclick = () => { if (chName.value.trim()) readChannel(node, chName.value.trim()); };
    const chWrite = el.querySelector('#ch-write');
    if (chWrite) {
      chWrite.onclick = () => {
        const name = chName.value.trim();
        if (!name) return flash(chName, '先填通道名');
        writeChannel(node, name, el.querySelector('#ch-data').value, el.querySelector('#ch-astext').value === '1');
      };
    }

    for (const c of el.querySelectorAll('[data-method]')) {
      c.onclick = () => { draftMethod = c.dataset.method; render(); };
    }
    const mGo = el.querySelector('#m-go');
    if (mGo) {
      mGo.onclick = () => {
        const name = el.querySelector('#m-name').value.trim();
        if (!name) return flash(el.querySelector('#m-name'), '先填方法名');
        draftMethod = name;
        doInvoke(node, name, el.querySelector('#m-args').value, el.querySelector('#m-astext').value === '1');
      };
    }

    for (const b of el.querySelectorAll('[data-sub-toggle]')) {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await setSubscription(node, b.dataset.subToggle, b.dataset.on === '1');
        } catch (e) {
          logLine('订阅操作失败：' + errText(e));
        }
        render();
      };
    }

    const evOn = el.querySelector('#ev-on');
    if (evOn) evOn.onclick = () => toggleAllSubs(node, true, evOn);
    const evOff = el.querySelector('#ev-off');
    if (evOff) evOff.onclick = () => toggleAllSubs(node, false, evOff);
  }

  async function toggleAllSubs(node, on, btn) {
    btn.disabled = true;
    try {
      const n = await setAllSubscriptions(node, on);
      logLine((on ? '已订阅 ' : '已取消 ') + (node.path || node.name)
        + ' 的内置事件（当前 ' + n + ' / ' + BUILTIN_EVENTS.length + '）');
    } catch (e) {
      logLine('订阅操作失败：' + errText(e));
    }
    render();
  }

  // ======================= 动作 =======================

  async function readChannel(node, name) {
    try {
      const bytes = await session.ro(node.addr).readData(name);
      const info = describe(bytes);
      node.channels.set(name, { hex: info.hex, primary: info.primary, at: Date.now() });
      memory.observeChannel(node.path, name, bytes);
      inspectingChannel = { name, mode: 'read' };
      logLine('ReadData(' + name + ') = ' + info.primary);
      refreshChannelRows(node);
      if (!el.querySelector(`[data-chan="${cssEsc(name)}"]`)) render();
      refreshChannelCounts();
    } catch (e) {
      logLine('ReadData(' + name + ') 失败：' + errText(e));
      memory.noteChannel(node.path, name);
      render();
    }
  }

  async function writeChannel(node, name, raw, asText) {
    try {
      const bytes = parseBytes(raw, asText);
      await session.ro(node.addr).writeData(name, bytes);
      logLine('WriteData(' + name + ') <- ' + bytesToHex(bytes));
    } catch (e) {
      logLine('WriteData(' + name + ') 失败：' + errText(e));
    }
  }

  /**
   * 通道行的行内写入。
   * 刻意不整块重绘 —— 那会打断输入，也会把刚读到的其他通道值一起刷掉。
   * 收起方式：再点一次「写」、按 Esc、或写入成功。
   */
  function openInlineWrite(row, node, name) {
    if (!row) return;

    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('write-row')) {
      existing.remove();
      return;
    }
    el.querySelectorAll('.write-row').forEach((r) => r.remove());

    const wr = document.createElement('div');
    wr.className = 'row write-row';
    wr.innerHTML = `
      <input type="text" spellcheck="false" placeholder="值（hex 或文本，回车写入）">
      <select><option value="1">文本</option><option value="0">hex</option></select>
      <button class="primary tiny" data-go>写入</button>
    `;
    row.after(wr);

    const input = wr.querySelector('input');
    const sel = wr.querySelector('select');
    const go = wr.querySelector('[data-go]');

    const submit = async () => {
      go.disabled = true;
      try {
        const bytes = parseBytes(input.value, sel.value === '1');
        await session.ro(node.addr).writeData(name, bytes);
        logLine('WriteData(' + name + ') ← ' + bytesToHex(bytes));
        wr.remove();
      } catch (e) {
        go.disabled = false;
        flash(input, errText(e));
        logLine('WriteData(' + name + ') 失败：' + errText(e));
      }
    };

    go.onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') wr.remove();
    });
    input.focus();
  }

  async function doInvoke(node, method, raw, asText) {
    try {
      const args = parseBytes(raw, asText);
      const resBytes = await session.ro(node.addr).invoke(method, args);
      const info = describe(resBytes);
      invokeResult = method + '(' + (raw || '') + ') → ' + info.primary
        + (info.hex ? '   [' + info.hex + ']' : '');
      memory.learnMethod(node.path, method);
      logLine('Invoke ' + method + ' → ' + info.primary);
    } catch (e) {
      invokeResult = method + ' 调用失败：' + errText(e);
      logLine('Invoke ' + method + ' 失败：' + errText(e));
    }
    render();
  }

  // ======================= 局部刷新（避免打字时被重绘打断） =======================

  function refreshChannelRows(node) {
    for (const row of el.querySelectorAll('[data-chan]')) {
      const name = row.dataset.chan;
      const live = node.channels.get(name);
      if (!live) continue;
      const target = row.querySelector('[data-val]');
      if (target) target.textContent = live.primary;
      row.title = live.hex || '';
    }
  }

  function refreshChannelCounts() { /* 计数在画布浮层里 */ }

  on('selection', render);
  on('workspace', render);
  on('topology', render);
  on('ui', render);
  // 订阅开关只影响本节点面板，走轻量事件重绘 —— 不能借道 'topology'，
  // 那会触发布局 rebuild 把图重新抖一遍。
  on('subscriptions', ({ addr }) => { if (state.selection === addr) render(); });
  on('node-data', ({ addr }) => {
    if (state.selection !== addr || tab !== 'channels') return;
    const node = nodeByAddr(addr);
    if (!node) return;
    // 新通道是"学"出来的：首次出现时必须整块重绘，否则列表不会生长。
    const needed = new Set([...node.channels.keys(), ...memory.channelNames(node.path)]);
    const shown = new Set([...el.querySelectorAll('[data-chan]')].map((r) => r.dataset.chan));
    for (const name of needed) {
      if (!shown.has(name)) { render(); return; }
    }
    refreshChannelRows(node);
  });
  on('reconnected', () => { invokeResult = ''; });

  render();
  return { render };
}

// ---------------- 小工具 ----------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString('zh-CN', { hour12: false }) + '.' +
    String(new Date(d).getMilliseconds()).padStart(3, '0');
}

function tyClass(type) {
  if (['ChildConnected', 'ChildDisconnected', 'DataChannelChanged', 'Released'].includes(type)) {
    return 'ty-' + type;
  }
  return 'ty-other';
}

function flash(input, msg) {
  if (!input) return;
  input.style.borderColor = 'var(--danger)';
  input.placeholder = msg;
  setTimeout(() => { input.style.borderColor = ''; }, 1600);
}
