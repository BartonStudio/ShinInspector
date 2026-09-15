// ShinInspector 远程调试工具。
// 依赖：window.MsgPack（msgpack.js）、window.IObjectClient（iobject.js）、window.Shin.binary。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let client = null;
  const subs = new Map(); // subscriptionId -> {addr, type}

  // ---------------- 工具函数 ----------------
  function hexToBytes(hex) {
    const s = String(hex || '').replace(/\s+/g, '');
    if (s === '') return new Uint8Array(0);
    if (s.length % 2 !== 0) throw new Error('hex 长度必须为偶数');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      const b = parseInt(s.substr(i * 2, 2), 16);
      if (Number.isNaN(b)) throw new Error('非法 hex: ' + s.substr(i * 2, 2));
      out[i] = b;
    }
    return out;
  }

  function bytesToHex(bytes) {
    if (!bytes || bytes.length === 0) return '(空)';
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }

  function bytesToText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { return ''; }
  }

  function parseBytes(str, asText) {
    if (asText) return new TextEncoder().encode(str || '');
    return hexToBytes(str);
  }

  function showBytes(bytes) {
    if (!bytes || bytes.length === 0) return '(空)';
    return 'hex: ' + bytesToHex(bytes) + '\ntext: ' + bytesToText(bytes);
  }

  function log(msg) { $('log').textContent += msg + '\n'; }

  function errStr(e) { return e && (e.message || e.code || String(e)) || String(e); }

  function assertClient() { if (!client || !client.connected) throw new Error('尚未连接'); }

  function setAddr(addr) {
    $('childAddr').value = addr;
    $('invokeAddr').value = addr;
    $('chanAddr').value = addr;
    $('evtAddr').value = addr;
  }

  // ---------------- 对象树 ----------------
  async function renderNode(container, name, addr) {
    const node = document.createElement('div');
    node.className = 'tree-node';

    const header = document.createElement('div');
    header.className = 'tree-header';

    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle';
    toggle.textContent = '+';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = name + ' @ ' + addr;
    label.title = '点击填充 addr';
    label.onclick = () => setAddr(addr);

    header.appendChild(toggle);
    header.appendChild(label);
    node.appendChild(header);

    const kids = document.createElement('div');
    kids.className = 'tree-kids';
    kids.style.display = 'none';
    node.appendChild(kids);
    container.appendChild(node);

    toggle.onclick = async () => {
      if (kids.style.display === 'none') {
        if (kids.childElementCount === 0) {
          try {
            const children = await client.getChildren(addr);
            for (const c of children) await renderNode(kids, c.name, c.addr);
          } catch (e) { log('GetChildren(' + addr + ') 失败: ' + errStr(e)); }
        }
        kids.style.display = 'block';
        toggle.textContent = '-';
      } else {
        kids.style.display = 'none';
        toggle.textContent = '+';
      }
    };
  }

  async function refreshTree() {
    try {
      assertClient();
      const container = $('treeContainer');
      container.innerHTML = '';
      await renderNode(container, 'root', client.root);
      log('已刷新对象树（root @ ' + client.root + '）');
    } catch (e) { log('刷新对象树失败: ' + errStr(e)); }
  }

  async function doGetChildItem() {
    try {
      assertClient();
      const addr = parseInt($('childAddr').value, 10);
      const childId = $('childId').value.trim();
      if (!childId) throw new Error('childId 不能为空');
      const resp = await client.getChildItem(addr, childId);
      $('childResult').textContent = 'addr = ' + resp.addr;
      log('GetChildItem(' + addr + ', "' + childId + '") = addr ' + resp.addr);
      setAddr(resp.addr);
    } catch (e) { log('GetChildItem 失败: ' + errStr(e)); }
  }

  // ---------------- 连接 ----------------
  const MODE = (localStorage.getItem('shin.mode') || 'ipc');
  const WS_URL = localStorage.getItem('shin.wsUrl') || 'ws://127.0.0.1:9002';
  const WS_DOMAIN = localStorage.getItem('shin.wsDomain') || 'shininspector';

  function makeTransport() {
    if (MODE === 'ws') {
      return new WsTransport(WS_URL);
    }
    const bin = window.Shin && window.Shin.binary;
    if (!bin) throw new Error('window.Shin.binary 不存在');
    return new IpcTransport(bin);
  }

  async function doConnect() {
    try {
      const domain = $('domain').value.trim() || (MODE === 'ws' ? WS_DOMAIN : 'shininspector');
      log('正在连接 [' + (MODE === 'ws' ? 'WS ' + WS_URL : 'IPC') + '] domain=' + domain + ' ...');
      const transport = makeTransport();
      if (transport.connect) await transport.connect();  // WS 需要先建立连接
      client = new IObjectClient(transport, log);
      // 加超时：若 5 秒内没收到 Connect 响应，报错而不是无限挂起
      const root = await Promise.race([
        client.connect(domain),
        new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时（5 秒无响应）')), 5000))
      ]);
      $('rootHandle').textContent = root;
      log('已连接，root 句柄 = ' + root);
      await refreshTree();
    } catch (e) { log('连接失败: ' + errStr(e)); }
  }

  async function doClose() {
    try {
      assertClient();
      await client.close();
      log('已发送 Close');
    } catch (e) { log('Close 失败: ' + errStr(e)); }
  }

  // ---------------- Invoke ----------------
  async function doInvoke() {
    try {
      assertClient();
      const addr = parseInt($('invokeAddr').value, 10);
      const method = $('invokeMethod').value.trim();
      if (!method) throw new Error('method 不能为空');
      const args = parseBytes($('invokeArgs').value, $('invokeArgsText').checked);
      log('Invoke: addr=' + addr + ' method=' + method + ' args=' + bytesToHex(args));
      const result = await client.invoke(addr, method, args);
      $('invokeResult').textContent = showBytes(result);
      log('Invoke 返回: ' + showBytes(result));
    } catch (e) { log('Invoke 失败: ' + errStr(e)); }
  }

  // ---------------- ReadData / WriteData ----------------
  async function doRead() {
    try {
      assertClient();
      const addr = parseInt($('chanAddr').value, 10);
      const channel = $('chanName').value.trim();
      if (!channel) throw new Error('channel 不能为空');
      const data = await client.readData(addr, channel);
      $('readResult').textContent = showBytes(data);
      log('ReadData(' + addr + ', "' + channel + '") = ' + showBytes(data));
    } catch (e) { log('ReadData 失败: ' + errStr(e)); }
  }

  async function doWrite() {
    try {
      assertClient();
      const addr = parseInt($('chanAddr').value, 10);
      const channel = $('chanName').value.trim();
      if (!channel) throw new Error('channel 不能为空');
      const data = parseBytes($('chanData').value, $('chanDataText').checked);
      await client.writeData(addr, channel, data);
      log('WriteData(' + addr + ', "' + channel + '") 成功, 数据 = ' + bytesToHex(data));
    } catch (e) { log('WriteData 失败: ' + errStr(e)); }
  }

  // ---------------- SubscribeEvent / CancelEvent ----------------
  function onEvent(frame) {
    const line = '[事件] ' + frame.event +
      ' sub#' + frame.subscription +
      ' addr=' + frame.addr +
      ' channel="' + (frame.channel || '') + '"' +
      (frame.data != null ? ' data=' + bytesToHex(frame.data) : '');
    log(line);
    $('eventLog').textContent += line + '\n';
  }

  async function doSubscribe() {
    try {
      assertClient();
      const addr = parseInt($('evtAddr').value, 10);
      const type = $('evtType').value.trim();
      if (!type) throw new Error('type 不能为空');
      const sid = await client.subscribeEvent(addr, type, onEvent);
      subs.set(sid, { addr: addr, type: type });
      log('已订阅: sub#' + sid + ' (' + type + ' @ ' + addr + ')');
      renderSubs();
    } catch (e) { log('SubscribeEvent 失败: ' + errStr(e)); }
  }

  function renderSubs() {
    const el = $('subscriptions');
    el.innerHTML = '';
    for (const [sid, info] of subs) {
      const row = document.createElement('div');
      row.className = 'sub-row';
      row.textContent = 'sub#' + sid + ' (' + info.type + ' @ ' + info.addr + ') ';
      const btn = document.createElement('button');
      btn.textContent = '取消';
      btn.onclick = async () => {
        try {
          await client.cancelEvent(sid);
          subs.delete(sid);
          log('已取消 sub#' + sid);
          renderSubs();
        } catch (e) { log('CancelEvent 失败: ' + errStr(e)); }
      };
      row.appendChild(btn);
      el.appendChild(row);
    }
  }

  // ---------------- Logger 快捷测试（当前根节点是 Logger） ----------------
  function encodeLogMessage(level, tag, msg) {
    const tagB = new TextEncoder().encode(tag);
    const msgB = new TextEncoder().encode(msg);
    const out = new Uint8Array(1 + 4 + tagB.length + 4 + msgB.length);
    out[0] = level;
    const dv = new DataView(out.buffer);
    dv.setUint32(1, tagB.length, false);
    out.set(tagB, 5);
    dv.setUint32(5 + tagB.length, msgB.length, false);
    out.set(msgB, 9 + tagB.length);
    return out;
  }

  async function quickReadLevel() {
    try {
      assertClient();
      const data = await client.readData(client.root, 'Level');
      log('Logger Level = ' + bytesToHex(data) + ' (0=Trace..4=Error)');
    } catch (e) { log('读取 Level 失败: ' + errStr(e)); }
  }

  async function quickWriteLevel() {
    try {
      assertClient();
      const lv = parseInt($('quickLevel').value, 10);
      await client.writeData(client.root, 'Level', new Uint8Array([lv]));
      log('已写入 Level = ' + lv);
    } catch (e) { log('写入 Level 失败: ' + errStr(e)); }
  }

  async function quickLog() {
    try {
      assertClient();
      const lv = parseInt($('quickLogLevel').value, 10);
      const tag = $('quickLogTag').value.trim() || 'JS';
      const msg = $('quickLogMsg').value;
      await client.invoke(client.root, 'Log', encodeLogMessage(lv, tag, msg));
      log('已发送 Log(' + lv + ', "' + tag + '", "' + msg + '")');
    } catch (e) { log('发送 Log 失败: ' + errStr(e)); }
  }

  // ---------------- 绑定 ----------------
  $('btnConnect').onclick = doConnect;
  $('btnClose').onclick = doClose;
  $('btnRefreshTree').onclick = refreshTree;
  $('btnGetChildItem').onclick = doGetChildItem;
  $('btnInvoke').onclick = doInvoke;
  $('btnRead').onclick = doRead;
  $('btnWrite').onclick = doWrite;
  $('btnSubscribe').onclick = doSubscribe;
  $('btnQuickReadLevel').onclick = quickReadLevel;
  $('btnQuickWriteLevel').onclick = quickWriteLevel;
  $('btnQuickLog').onclick = quickLog;

  // 状态提示
  const modeName = (MODE === 'ws') ? 'WebSocket (WS)' : '进程间通信 (IPC)';
  $('modeBadge').textContent = '[' + modeName + ']';
  if (MODE === 'ws') {
    $('domain').value = WS_DOMAIN;
  }

  function check() {
    const st = $('status');
    if (MODE === 'ws') {
      st.textContent = 'WebSocket 模式：' + WS_URL + '（点击「连接」建立 WS）';
      st.className = 'status ok';
      return;
    }
    const bin = window.Shin && window.Shin.binary;
    if (!bin) { st.textContent = '未检测到 window.Shin.binary（不是从 ShinInspector 打开的页面？）'; st.className = 'status warn'; return; }
    st.textContent = 'window.Shin.binary ' + (bin.ready ? '就绪（' + bin.capacity + ' bytes）' : '等待共享内存…');
    st.className = 'status ' + (bin.ready ? 'ok' : 'warn');
  }
  check();
  setTimeout(check, 800);
  log('调试工具已加载 v3 [' + modeName + (MODE === 'ws' ? ' ' + WS_URL : '') + ']');
})();
