// ShinInspector 远程调试工具。
// 依赖：window.IObjectSDK（由 ui/build-sdk.mjs 从官方 iobject-js SDK 打包而来）、window.Shin.binary。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let client = null;               // IObjectSDK.IObjectClient
  const subs = new Map();          // subscriptionId -> {sub, addr, type}

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

  function errStr(e) {
    if (!e) return '未知错误';
    if (e && e.code) return e.code + ': ' + (e.message || '');
    return e.message || String(e);
  }

  function assertClient() { if (!client || !client.isOpen) throw new Error('尚未连接'); }

  // 用 raw addr 临时包一个 RemoteObject（SDK 的对象是 addr 语义化的，这里保持调试页按 addr 操作）。
  function ro(addr) { return new IObjectSDK.RemoteObject(client, addr); }

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
            const children = await ro(addr).getChildren();
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
      await renderNode(container, 'root', client.root.addr);
      log('已刷新对象树（root @ ' + client.root.addr + '）');
    } catch (e) { log('刷新对象树失败: ' + errStr(e)); }
  }

  async function doGetChildItem() {
    try {
      assertClient();
      const addr = parseInt($('childAddr').value, 10);
      const childId = $('childId').value.trim();
      if (!childId) throw new Error('childId 不能为空');
      const obj = await ro(addr).getChildItem(childId);
      $('childResult').textContent = 'addr = ' + obj.addr;
      log('GetChildItem(' + addr + ', "' + childId + '") = addr ' + obj.addr);
      setAddr(obj.addr);
    } catch (e) { log('GetChildItem 失败: ' + errStr(e)); }
  }

  // ---------------- IPC 传输适配器 ----------------
  // 把 window.Shin.binary（共享内存桥）伪装成 SDK 的 WebSocketLike，
  // 这样 IPC / WS 两种模式都走官方 IObjectClient 这一套代码。
  class IpcSocketAdapter {
    constructor(url, protocols) {
      this.binaryType = 'arraybuffer';
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._bin = window.Shin && window.Shin.binary;
      if (!this._bin) throw new Error('window.Shin.binary 不存在');

      this._bin.onData((payload) => {
        if (this.onmessage) this.onmessage({ data: payload.data });
      });

      // 共享内存就绪即视为「连接已打开」。SDK 的 waitOpen 会先挂好 onopen，故异步触发。
      const fireOpen = () => { if (this.onopen && this._bin.ready) this.onopen({}); };
      if (this._bin.ready) {
        setTimeout(fireOpen, 0);
      } else {
        let tries = 0;
        const t = setInterval(() => {
          if (this._bin.ready) { clearInterval(t); fireOpen(); }
          else if (++tries > 250) { clearInterval(t); if (this.onerror) this.onerror(new Error('共享内存桥超时就绪')); }
        }, 20);
      }
    }

    send(data) {
      this._bin.write(data).catch((e) => { if (this.onerror) this.onerror(e); });
    }

    close() { /* IPC 无独立关闭语义；会话随应用生命周期 */ }
  }

  // ---------------- 连接 ----------------
  const MODE = (localStorage.getItem('shin.mode') || 'ipc');
  const WS_URL = localStorage.getItem('shin.wsUrl') || 'ws://127.0.0.1:9002';
  const WS_DOMAIN = localStorage.getItem('shin.wsDomain') || 'shininspector';

  async function doConnect() {
    try {
      const domain = $('domain').value.trim() || (MODE === 'ws' ? WS_DOMAIN : 'shininspector');
      log('正在连接 [' + (MODE === 'ws' ? 'WS ' + WS_URL : 'IPC') + '] domain=' + domain + ' ...');
      const opts = { domain: domain };
      let url;
      if (MODE === 'ws') {
        url = WS_URL;
      } else {
        url = 'ipc://local';
        opts.WebSocket = IpcSocketAdapter;   // 走共享内存桥的自定义传输
      }
      client = await IObjectSDK.IObjectClient.connect(url, opts);
      $('rootHandle').textContent = client.root.addr;
      log('已连接，root 句柄 = ' + client.root.addr);
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
      const result = await ro(addr).invoke(method, args);
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
      const data = await ro(addr).readData(channel);
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
      await ro(addr).writeData(channel, data);
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
      const sub = await ro(addr).subscribe(type, onEvent);
      subs.set(sub.id, { sub: sub, addr: addr, type: type });
      log('已订阅: sub#' + sub.id + ' (' + type + ' @ ' + addr + ')');
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
          await info.sub.cancel();
          subs.delete(sid);
          log('已取消 sub#' + sid);
          renderSubs();
        } catch (e) { log('CancelEvent 失败: ' + errStr(e)); }
      };
      row.appendChild(btn);
      el.appendChild(row);
    }
  }

  // ---------------- Logger 快捷测试 ----------------
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
      const data = await client.root.readData('Level');
      log('Logger Level = ' + bytesToHex(data) + ' (0=Trace..4=Error)');
    } catch (e) { log('读取 Level 失败: ' + errStr(e)); }
  }

  async function quickWriteLevel() {
    try {
      assertClient();
      const lv = parseInt($('quickLevel').value, 10);
      await client.root.writeData('Level', new Uint8Array([lv]));
      log('已写入 Level = ' + lv);
    } catch (e) { log('写入 Level 失败: ' + errStr(e)); }
  }

  async function quickLog() {
    try {
      assertClient();
      const lv = parseInt($('quickLogLevel').value, 10);
      const tag = $('quickLogTag').value.trim() || 'JS';
      const msg = $('quickLogMsg').value;
      await client.root.invoke('Log', encodeLogMessage(lv, tag, msg));
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
  log('调试工具已加载 v4 [' + modeName + (MODE === 'ws' ? ' ' + WS_URL : '') + ']');
})();
