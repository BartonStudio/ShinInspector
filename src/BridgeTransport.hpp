#pragma once

#include <iobject/RuntimeBridge.hpp>
#include <iobject/RuntimeBridgeProtocol.hpp>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace ShinInspector {

/// IObject 远程协议（RuntimeBridgePeer）↔ 传输层的胶水。
/// 传输层只认两个回调：发一帧字节、收一帧字节；具体载体（WebView2 共享内存）由 app 注入。
class BridgeTransport final {
public:
    /// @param root    IObject 域内唯一桥接入口（app::Domain().BridgeRoot()）。
    /// @param domain  握手时校验的域名字符串。
    /// @param sendFn  发一帧字节给远端；app 注入为 WebviewWrapper::PushSharedMemory。
    BridgeTransport(iobject::RuntimeBridgeRoot& root, std::string domain,
                    std::function<void(const void*, size_t)> sendFn)
        : send_(std::move(sendFn)),
          peer_(std::make_unique<iobject::RuntimeBridgePeer>(
              root, std::move(domain),
              [this](iobject::ByteView frame) {
                  if (send_) send_(frame.data(), frame.size());
              })) {}

    BridgeTransport(const BridgeTransport&) = delete;
    BridgeTransport& operator=(const BridgeTransport&) = delete;

    /// 传输层收到一帧字节时调用（app 从 WriteBufferData() 取出后喂进来）。
    void OnFrameReceived(const void* data, size_t len) {
        if (!peer_ || !data || len == 0) return;
        peer_->ReceiveMessage(iobject::ByteView(
            reinterpret_cast<const std::uint8_t*>(data), len));
    }

    bool IsOpen() const noexcept { return peer_ && peer_->IsOpen(); }
    void Close() noexcept { if (peer_) peer_->Close(); }

private:
    std::function<void(const void*, size_t)> send_;
    std::unique_ptr<iobject::RuntimeBridgePeer> peer_;
};

} // namespace ShinInspector
