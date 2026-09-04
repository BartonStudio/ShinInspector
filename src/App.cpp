#include "App.h"

#include "WebviewWrapper.hpp"  // WebView2 壳
#include "ShinBinaryJS.hpp"    // window.Shin.binary 前端二进制封装
#include "BridgeTransport.hpp" // IObject 远程协议 ↔ webview 二进制通道的胶水
#include "TestObject.hpp"      // 远程调试测试对象
#include <iobject/Executor.hpp>

#include <memory>

int App::Run(int argc, char* argv[]) {
    (void)argc;
    (void)argv;

    auto& webview = Shin::UI::WebviewWrapper::GetInstance();
    webview.SetTitle("ShinInspector");
    webview.SetSize(720, 480, false);
    // 前端由用户用 `python -m http.server` 在 ui/ 目录托管；
    // 端口需与此处一致（默认 8000）。先进入设置页，选择通信方式后再进入调试页。
    webview.SetStartupURL("http://127.0.0.1:8000/settings.html");
    // 页面加载后自动申请共享内存并暴露 window.Shin.binary，业务侧无需感知
    webview.InjectJSBeforeLoad(Shin::UI::kShinBinaryJS);

    if (!webview.Initialize()) {
        LOG_ERROR("Webview", ">>> Initialize() FAILED");
        return 1;
    }

    // 挂载远程调试测试对象到根节点：Sensor / Device（Device 下再挂 Sub）
    iobject::IRuntimeObject* sensorNode = iobject::Runtime::make<TestObject>("Sensor");
    iobject::IRuntimeObject* deviceNode = iobject::Runtime::make<TestObject>("Device");
    iobject::IRuntimeObject* subNode = iobject::Runtime::make<TestObject>("Sub");
    app::Root()->Connect("Sensor", sensorNode);
    app::Root()->Connect("Device", deviceNode);
    deviceNode->Connect("Sub", subNode);
    LOG_INFO("App", "已挂载测试对象：Sensor / Device / Device.Sub");

    // 可选：启动内置 WebSocket 远程服务端（默认 ws://127.0.0.1:9002，domain "iobject"）。
    // 业务方按需调用；这里显式启动以支持前端的 WS 模式。
    app::Domain().startBuiltinWebSocketServer();

    // 单线程：把 IObject 事件循环挂到 WebView2 的 UI 消息泵上。
    // 主线程同时承担「WebView2 消息循环」与「IObject 循环线程」两个角色。
    iobject::UseExecutor(std::make_unique<iobject::HostLoopExecutor>(
        /* onRun */         [&webview]() { webview.RunBlocking(); },
        /* onPost */        [&webview](std::function<void()> task) { webview.PostToUiThread(std::move(task)); },
        /* onStop */        [&webview]() { webview.Terminate(); },
        /* isOnLoopThread */[&webview]() { return webview.IsOnUiThread(); }));

    // 传输胶水放在内层作用域：作用域退出时先销毁会话（满足「会话先于业务对象销毁」），
    // 再清理测试节点。
    {
        ShinInspector::BridgeTransport bridgeTransport(
            app::Domain().BridgeRoot(),
            "shininspector",
            [&webview](const void* data, size_t len) {
                webview.PushSharedMemory(data, len);
            });
        webview.SetBinaryReceivedCallback(
            [&bridgeTransport](const void* data, size_t len) {
                bridgeTransport.OnFrameReceived(data, len);
            });

        // 阻塞运行，直到窗口关闭（RunBlocking 返回）或 iobject::Stop()
        iobject::Run();

        // 摘掉回调，避免 bridgeTransport 销毁后 webview 单例仍持悬挂引用
        webview.SetBinaryReceivedCallback(nullptr);
    } // bridgeTransport 在此销毁，远程会话关闭

    // 清理测试节点（会话已关闭；节点析构会自动解除拓扑）
    delete sensorNode;
    delete deviceNode;
    delete subNode;

    return 0;
}
