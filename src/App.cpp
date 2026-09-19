#include "App.h"

#include "WebviewWrapper.hpp"  // WebView2 壳
#include "TestObject.hpp"      // --demo 用的测试对象

#include <iobject/Executor.hpp>
#include <iobject/WebSocketServer.hpp>  // WS 传输服务（仅 --demo 使用）

#include <atomic>
#include <chrono>
#include <memory>
#include <string_view>
#include <thread>
#include <vector>

namespace {

/// 设计尺寸（逻辑像素 / DIP），1280x720。
///
/// 这里写的是"人眼看上去的大小"，不是物理像素：同一个 1280 在 100% 缩放下占 1280 物理像素，
/// 在 150% 缩放下占 1920 物理像素 —— 由 WebviewWrapper::ApplyDesignSize 按显示器 DPI 换算，
/// 并在装不下时按工作区等比收敛，保证窗口永远不溢出屏幕。
constexpr int kDesignWidth = 1280;
constexpr int kDesignHeight = 720;

/// 演示模式（--demo）用的一棵小对象树。
/// 结构：root ─┬─ Device ─┬─ Sub
///            │          └─ Port
///            ├─ Sensor
///            └─ Player
/// 定时器周期性调用 Bump，从而发布 DataChannelChanged —— 用来验证节点脉冲动画。
struct DemoTree {
    std::vector<iobject::IRuntimeObject*> nodes;

    void Mount() {
        auto make = [this](iobject::IRuntimeObject* parent, const char* name) {
            auto* node = iobject::Runtime::make<TestObject>(name);
            parent->Connect(name, node);
            nodes.push_back(node);
            return node;
        };

        iobject::IRuntimeObject* root = app::Root();
        auto* device = make(root, "Device");
        make(root, "Sensor");
        make(root, "Player");
        make(device, "Sub");
        make(device, "Port");
    }

    void Unmount() {
        for (auto* node : nodes) delete node;
        nodes.clear();
    }
};

} // namespace

int App::Run(int argc, char* argv[]) {
    // --demo：在本进程内起一个 WS 服务端并挂一棵测试树，
    //         用来在没有目标应用时开发和验证前端。
    bool demo = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--demo") demo = true;
    }

    auto& webview = Shin::UI::WebviewWrapper::GetInstance();
    webview.SetTitle(demo ? "ShinInspector [demo]" : "ShinInspector");
    webview.SetSize(kDesignWidth, kDesignHeight, false);
    // 前端由 Vite 开发服务器托管（ui/ 目录，端口 8848，见 ui/vite.config.mjs）。
    // 工具只通过 WebSocket 连接目标应用，因此这里不再注入任何桥接脚本。
    webview.SetStartupURL("http://127.0.0.1:8848/index.html");

    // WebGL 是本工具的硬依赖：拿不到上下文前端就整块停摆。
    // 部分集显 / 虚拟 GPU 会被 Chromium 的 GPU 黑名单判为不可用而悄悄退到软件路径，
    // 这里显式忽略黑名单 —— 宁可尝试硬件加速，也不接受"看着能用"的软件渲染。
    webview.AppendBrowserArguments("--ignore-gpu-blocklist");

    if (!webview.Initialize()) {
        LOG_ERROR("Webview", ">>> Initialize() FAILED");
        return 1;
    }

    // 窗口建好之后再做一次 DPI 结算：把 1280x720 的逻辑尺寸按显示器缩放系数换算成物理像素，
    // 装不下则等比收缩，最后在工作区里居中。日志里的 DPI 就是当前显示器的缩放基准
    // （96 = 100%，120 = 125%，144 = 150%，192 = 200%）。
    const auto metrics = webview.ApplyDesignSize(kDesignWidth, kDesignHeight);
    LOG_INFO("App", "窗口 " + std::to_string(metrics.designWidth) + "x" + std::to_string(metrics.designHeight)
        + " (逻辑) @ DPI " + std::to_string(metrics.dpi)
        + " -> 外框 " + std::to_string(metrics.windowWidth) + "x" + std::to_string(metrics.windowHeight)
        + " / 客户区 " + std::to_string(metrics.clientWidth) + "x" + std::to_string(metrics.clientHeight)
        + " 物理像素；工作区 " + std::to_string(metrics.workAreaWidth) + "x" + std::to_string(metrics.workAreaHeight)
        + (metrics.shrunkToFit ? "（装不下，已等比收敛）" : ""));
    if (metrics.shrunkToFit) {
        LOG_INFO("App", "提示：当前显示器缩放系数让 1280x720 逻辑像素超出了工作区，窗口已按比例收缩以避免溢出。");
    }

    DemoTree demoTree;
    std::unique_ptr<iobject::WebSocketServer> wsServer;
    std::atomic<bool> tickerStop{false};
    std::thread ticker;

    if (demo) {
        demoTree.Mount();
        LOG_INFO("Demo", "已挂载测试对象：Device(Sub, Port) / Sensor / Player");

        wsServer = std::make_unique<iobject::WebSocketServer>(
            iobject::WebSocketServer::Config{9002});
        wsServer->BindDomain(app::Domain());  // 路由键 = app::Domain().Name() = "shininspector"

        // WebSocketServer 的约定是「Start 失败不抛异常」（见其类注释"容错"），
        // 端口被占用时它会静默进入未运行状态。这里必须显式查一次 ——
        // 否则前端只会看到一句没有信息量的连接失败，无从判断是哪一层出的问题。
        if (!wsServer->IsRunning()) {
            LOG_ERROR("Demo", "WebSocket 服务端启动失败：端口 9002 可能已被占用。"
                              "前端将连不上本进程，请腾出 9002 或改用其它端口。");
        } else {
            LOG_INFO("Demo", "WebSocket 服务端已启动: 9002 (domain=" + app::Domain().Name() + ")");
        }

        // 周期性触发一次状态变化，让前端能看到数据通道脉冲。
        auto* device = demoTree.nodes.size() > 0 ? demoTree.nodes[0] : nullptr;
        auto* sensor = demoTree.nodes.size() > 1 ? demoTree.nodes[1] : nullptr;
        ticker = std::thread([&tickerStop, device, sensor]() {
            int n = 0;
            while (!tickerStop.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(900));
                if (tickerStop.load()) break;
                iobject::IRuntimeObject* target = (n++ % 2 == 0) ? device : sensor;
                if (target == nullptr) continue;
                // Invoke 触碰对象树，一律经事件循环串行执行。
                iobject::Post([target]() {
                    target->Invoke("Bump", iobject::ByteInput{}, [](iobject::ByteView) {});
                });
            }
        });
    } else {
        LOG_INFO("App", "未启用 --demo：仅作 WebView2 宿主，前端连接远端应用");
    }

    // 单线程：把 IObject 事件循环挂到 WebView2 的 UI 消息泵上。
    // 主线程同时承担「WebView2 消息循环」与「IObject 循环线程」两个角色。
    iobject::UseExecutor(std::make_unique<iobject::HostLoopExecutor>(
        /* onRun */         [&webview]() { webview.RunBlocking(); },
        /* onPost */        [&webview](std::function<void()> task) { webview.PostToUiThread(std::move(task)); },
        /* onStop */        [&webview]() { webview.Terminate(); },
        /* isOnLoopThread */[&webview]() { return webview.IsOnUiThread(); }));

    // 阻塞运行，直到窗口关闭（RunBlocking 返回）或 iobject::Stop()
    iobject::Run();

    // 先停定时器与 WS 服务（关闭全部远程会话），再销毁业务对象，
    // 满足「会话先于业务对象销毁」的约束。
    tickerStop.store(true);
    if (ticker.joinable()) ticker.join();
    wsServer.reset();
    demoTree.Unmount();

    return 0;
}
