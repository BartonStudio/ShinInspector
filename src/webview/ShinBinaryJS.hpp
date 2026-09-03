#pragma once

// window.Shin.binary —— 前端二进制通道封装。
//
// 用法：在 WebviewWrapper::Initialize() 之前调用
//   webview.InjectJSBeforeLoad(Shin::UI::kShinBinaryJS);
//
// 设计目标（对外部业务完全不可知）：
//   * 页面加载后自动向 C++ 申请一块共享内存（SharedMemoryInit），分配好后就绪；
//   * 业务代码只用 window.Shin.binary.write(data) / read() / onData(cb)；
//   * 共享内存分配、sharedbufferreceived 事件、SharedMemoryUpdate 通知全部隐藏在内部。
//
// 说明：WebView2 限制 —— JS 无法主动创建 buffer，只能由 C++ 创建后
// PostSharedBufferToScript 推回；所以「JS 申请」本质是发一个 SharedMemoryInit
// 控制指令，C++ 分配并把 buffer 句柄推给 JS，这一切对业务透明。

namespace Shin {
namespace UI {

inline const char* const kShinBinaryJS = R"JS(
(function () {
    'use strict';
    if (window.Shin && window.Shin.binary) return; // 幂等，防止重复注入

    var DEFAULT_SIZE = 1024 * 1024; // 1 MiB

    var buffer = null;      // 当前可写的 ArrayBuffer
    var view = null;        // 覆盖 buffer 的 Uint8Array
    var capacity = 0;
    var ready = false;

    var inflight = null;        // 进行中的 ensure() promise
    var allocWaiters = [];      // 等待可写 buffer 到位
    var dataWaiters = [];       // 等待 C++ 主动推数据 (read)
    var dataListeners = [];     // onData 订阅
    var retryCount = 0;

    function bridge() {
        var fn = window.Shin && window.Shin.sendDataToCpp;
        if (typeof fn !== 'function') {
            throw new Error('window.Shin.sendDataToCpp 尚未就绪');
        }
        return fn;
    }

    // sendDataToCpp 返回 Promise（解析为 ProcessMessage 返回值，恒 "{}"）。
    // 二进制通道不依赖该回执：SharedMemoryInit 的完成信号是 sharedbufferreceived。
    function send(action, payload) {
        var msg = Object.assign({ action: action }, payload || {});
        var p;
        try {
            p = bridge()(msg);
        } catch (e) {
            return Promise.reject(e);
        }
        return Promise.resolve(p).catch(function (e) {
            console.error('[Shin.binary] 发送 ' + action + ' 失败:', e);
            throw e;
        });
    }

    function toBytes(data) {
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (Array.isArray(data)) return Uint8Array.from(data);
        if (typeof data === 'string') return new TextEncoder().encode(data);
        throw new Error('[Shin.binary] 不支持的数据类型: ' + typeof data);
    }

    if (window.chrome && window.chrome.webview) {
        // sharedbufferreceived 只在 C++ 第一次（也是唯一一次）推送共享内存时触发。
        // 之后 C++ -> JS 的数据一律走「写进同一块内存 + 文本消息通知」，不再重复推 buffer。
        window.chrome.webview.addEventListener('sharedbufferreceived', function (e) {
            var meta = {};
            try { meta = JSON.parse(e.additionalData || '{}'); } catch (err) {}
            console.log('[Shin.binary] sharedbufferreceived action=', meta.action, 'size=', meta.size);

            buffer = e.getBuffer();
            view = new Uint8Array(buffer);
            capacity = buffer.byteLength;
            ready = true;
            var aws = allocWaiters; allocWaiters = [];
            aws.forEach(function (w) { w.resolve(); });
        });

        // C++ -> JS 推数据的文本通知：从同一块共享内存里读取前 size 字节。
        window.chrome.webview.addEventListener('message', function (e) {
            var data = e.data;
            if (!data || data.action !== 'SharedMemoryPush') return;
            console.log('[Shin.binary] message SharedMemoryPush size=', data.size);
            var size = (typeof data.size === 'number') ? data.size : 0;
            if (!ready || size <= 0 || size > capacity) return;
            var chunk = view.slice(0, size);
            var payload = { data: chunk, meta: data };
            dataListeners.slice().forEach(function (cb) {
                try { cb(payload); } catch (err) { console.error('[Shin.binary] onData 回调异常:', err); }
            });
            var ws = dataWaiters; dataWaiters = [];
            ws.forEach(function (w) { w.resolve(payload); });
        });
    }

    // 确保可写 buffer 至少 size 字节；不足则发 SharedMemoryInit 让 C++ 扩容并重新推送。
    function ensure(size) {
        size = size || DEFAULT_SIZE;
        if (ready && capacity >= size) return Promise.resolve();
        if (inflight) return inflight;

        inflight = new Promise(function (resolve, reject) {
            var waiter = { resolve: resolve, reject: reject };
            allocWaiters.push(waiter);
            send('SharedMemoryInit', { size: size }).catch(function (err) {
                var i = allocWaiters.indexOf(waiter);
                if (i >= 0) allocWaiters.splice(i, 1);
                reject(err);
            });
        }).finally(function () { inflight = null; });

        return inflight;
    }

    // JS -> C++：写入字节数据（自动预分配/扩容 + 通知）。
    function write(data) {
        return Promise.resolve().then(function () {
            var bytes = toBytes(data);
            function doWrite() {
                if (ready && capacity >= bytes.byteLength) {
                    view.set(bytes, 0);
                    return send('SharedMemoryUpdate', { size: bytes.byteLength });
                }
                return ensure(bytes.byteLength).then(doWrite);
            }
            return doWrite();
        });
    }

    // C++ -> JS：读取下一次 C++ 主动推送的数据（action=SharedMemoryPush）。
    function read() {
        return new Promise(function (resolve, reject) {
            dataWaiters.push({ resolve: resolve, reject: reject });
        });
    }

    // C++ -> JS：订阅 C++ 主动推送的数据。
    function onData(cb) {
        if (typeof cb === 'function') dataListeners.push(cb);
    }

    function autoInit() {
        var fn = window.Shin && window.Shin.sendDataToCpp;
        if (typeof fn !== 'function') {
            // 桥接函数尚未就绪（初始化顺序），稍后重试，最多约 5 秒
            if (retryCount < 50) { retryCount++; setTimeout(autoInit, 100); }
            return;
        }
        ensure(DEFAULT_SIZE).catch(function (e) {
            console.error('[Shin.binary] 预分配共享内存失败:', e);
        });
    }

    var api = {
        write: write,
        read: read,
        onData: onData,
        ensure: ensure,
        get ready() { return ready; },
        get capacity() { return capacity; }
    };

    window.Shin = window.Shin || {};
    window.Shin.binary = api;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit, { once: true });
    } else {
        autoInit();
    }
})();
)JS";

} // namespace UI
} // namespace Shin
