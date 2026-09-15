#pragma once

#include <iobject/Logger.hpp>
#include <iobject/Runtime.hpp>
#include <iobject/RuntimeDomain.hpp>

#include "InspectorRoot.hpp"

// 应用入口封装。当前为占位实现，后续在此承载：
//   - WebView2 前后端消息路由
//   - IObject 运行时域（连接目标 runtime 的对象树/事件/数据通道）
class App {
public:
    App() = default;
    ~App() = default;

    App(const App&) = delete;
    App& operator=(const App&) = delete;

    int Run(int argc, char* argv[]);
};

// =============================================================================
// 全局运行时域：懒初始化（首次访问时自动创建），无需显式注册
// =============================================================================
namespace app {
// 本应用唯一的对象树，域名为 "shininspector"（远程客户端 Connect 时用同名路由到这里）。
inline iobject::RuntimeDomain& Domain() {
    static iobject::RuntimeDomain domain(iobject::Runtime::make<InspectorRoot>(), "shininspector");
    return domain;
}

inline iobject::IRuntimeObject* Root() {
    return Domain().RootAnchor();
}
} // namespace app

// =============================================================================
// 分级日志宏：替代「找 domain 根节点 → Invoke("Log") 打印」的复杂写法
//   用法：LOG_INFO("App", "hello");
// =============================================================================
#define LOG_TRACE(tag, msg) ::app::Root()->Invoke("Log", iobject::EncodeLogMessage(iobject::LogLevel::Trace, (tag), (msg)), [](iobject::ByteView) {})
#define LOG_DEBUG(tag, msg) ::app::Root()->Invoke("Log", iobject::EncodeLogMessage(iobject::LogLevel::Debug, (tag), (msg)), [](iobject::ByteView) {})
#define LOG_INFO(tag, msg)  ::app::Root()->Invoke("Log", iobject::EncodeLogMessage(iobject::LogLevel::Info, (tag), (msg)), [](iobject::ByteView) {})
#define LOG_WARN(tag, msg)  ::app::Root()->Invoke("Log", iobject::EncodeLogMessage(iobject::LogLevel::Warning, (tag), (msg)), [](iobject::ByteView) {})
#define LOG_ERROR(tag, msg) ::app::Root()->Invoke("Log", iobject::EncodeLogMessage(iobject::LogLevel::Error, (tag), (msg)), [](iobject::ByteView) {})
