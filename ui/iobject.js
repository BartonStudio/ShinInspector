// IObject 远程协议客户端。
// 依赖：window.MsgPack（msgpack.js）+ 一个传输对象（transport.js，send/onMessage）。
// 协议（与 C++ RuntimeBridgePeer 对应）：每帧是一个 MessagePack map：
//   请求   {id, op, ...}                    响应 {id, ok, ...} 或 {id, ok:false, error:{code,message}}
//   事件帧 {event, subscription, addr, channel, data?}
// 二进制字段（data/args/result/事件 data）为 msgpack bin，用 Uint8Array 表示。
(function (global) {
  'use strict';

  class IObjectClient {
    constructor(transport, onLog) {
      this.transport = transport;
      this.onLog = (typeof onLog === 'function') ? onLog : function () {};
      this.nextId = 1;
      this.pending = new Map();        // id -> {resolve, reject}
      this.subscriptions = new Map();  // subscriptionId -> callback
      this.root = 0;
      this.connected = false;
      transport.onMessage((bytes) => this._onFrame(bytes));
    }

    _onFrame(bytes) {
      this.onLog('[IObject] 收到帧 ' + (bytes ? bytes.length : 0) + ' bytes');
      let frame;
      try { frame = global.MsgPack.decode(bytes); }
      catch (e) { this.onLog('[IObject] msgpack 解码失败: ' + e.message); return; }
      this.onLog('[IObject] 解码成功: ' + JSON.stringify(frame));

      if (frame.id != null) {
        // 响应帧
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame);
        else p.reject(frame.error || { code: 'Unknown', message: '未知错误' });
        return;
      }
      if (frame.event != null) {
        // 事件帧
        const cb = this.subscriptions.get(frame.subscription);
        if (cb) { try { cb(frame); } catch (e) { console.error('[IObjectClient] 事件回调异常:', e); } }
      }
    }

    _request(op, fields) {
      const id = this.nextId++;
      const frame = Object.assign({ id: id, op: op }, fields || {});
      const bytes = global.MsgPack.encode(frame);
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve: resolve, reject: reject });
        this.transport.send(bytes).catch(reject);
      });
    }

    /// 握手：必须第一个调用。返回根对象句柄。
    async connect(domain) {
      const resp = await this._request('Connect', { domain: domain });
      this.root = resp.root;
      this.connected = true;
      return resp.root;
    }

    getChildItem(addr, childId) { return this._request('GetChildItem', { addr: addr, childId: childId }); }
    getChildren(addr) { return this._request('GetChildren', { addr: addr }); }

    /// 返回该通道的数据字节（Uint8Array）。
    async readData(addr, channel) { return (await this._request('ReadData', { addr: addr, channel: channel })).data; }

    /// data 为 Uint8Array。
    writeData(addr, channel, data) { return this._request('WriteData', { addr: addr, channel: channel, data: data }); }

    /// args 为 Uint8Array；返回结果字节（Uint8Array）。
    async invoke(addr, method, args) { return (await this._request('Invoke', { addr: addr, method: method, args: args })).result; }

    async subscribeEvent(addr, type, cb) {
      const resp = await this._request('SubscribeEvent', { addr: addr, type: type });
      this.subscriptions.set(resp.subscription, cb);
      return resp.subscription;
    }

    cancelEvent(subscription) { return this._request('CancelEvent', { subscription: subscription }); }
    close() { return this._request('Close', {}); }
  }

  global.IObjectClient = IObjectClient;
})(typeof window !== 'undefined' ? window : globalThis);
