// 传输抽象：IObject 远程协议（MessagePack 帧）在两种载体上的统一接口。
// 每种传输只认两个方法：
//   send(bytes)      -> Promise    把一帧完整 MessagePack 发出去
//   onMessage(cb)    -> void       注册收帧回调（收到一帧完整 MessagePack 时调用）
(function (global) {
  'use strict';

  // 进程间通信：WebView2 共享内存 + postMessage 通知（window.Shin.binary）。
  class IpcTransport {
    constructor(binary) {
      this.binary = binary;
    }
    send(bytes) {
      return this.binary.write(bytes);
    }
    onMessage(cb) {
      this.binary.onData((payload) => cb(payload.data));
    }
  }

  // WebSocket：连接 IObject 内置 WebSocket 服务端（默认 ws://127.0.0.1:9002）。
  class WsTransport {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.listeners = [];
      this.queue = [];
    }
    connect() {
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
          this.queue.forEach((b) => this.ws.send(b));
          this.queue = [];
          resolve();
        };
        this.ws.onmessage = (e) => {
          const bytes = new Uint8Array(e.data);
          this.listeners.forEach((cb) => cb(bytes));
        };
        this.ws.onerror = () => reject(new Error('WebSocket 连接失败: ' + this.url));
      });
    }
    send(bytes) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(bytes);
      } else {
        this.queue.push(bytes);
      }
      return Promise.resolve();
    }
    onMessage(cb) {
      this.listeners.push(cb);
    }
  }

  global.IpcTransport = IpcTransport;
  global.WsTransport = WsTransport;
})(typeof window !== 'undefined' ? window : globalThis);
