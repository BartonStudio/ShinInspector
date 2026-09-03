#include "WebviewMessageHandler.hpp"
#include "WebviewWrapper.hpp"

#include "App.h"  // LOG_INFO / LOG_ERROR 等日志宏

#include <nlohmann/json.hpp>
#include <unordered_map>
#include <functional>

#include <iobject/Executor.hpp>  // iobject::Post —— 后台动作投递到 IObject 事件循环

#include <windows.h>
#include <WebView2.h>
#include <wrl.h>

namespace Shin {
namespace UI {
namespace WebviewMessageHandler {

    std::string ProcessMessage(const std::string& jsonRequest);

    namespace {
        struct ActionDef {
            ActionHandler handler;
            bool runOnLoopThread;  // true = 投递到 IObject 事件循环；false = 直接在 WebView2 UI 线程执行
        };

        bool TryParseRequest(const std::string& raw, nlohmann::json& outJson, WebviewWrapper& webview) {
            try {
                outJson = nlohmann::json::parse(raw);
                return true;
            } catch (const nlohmann::json::parse_error& e) {
                LOG_ERROR("WebviewMessageHandler", "Invalid JSON: " + std::string(e.what()));
                nlohmann::json errResponse = {
                    {"action", "ErrorReport"},
                    {"msg", std::string("解析前端参数失败，不是合法的 JSON 格式: ") + e.what()}
                };
                webview.SendJson(errResponse.dump());
                return false;
            }
        }

        void HandleSharedMemoryInit(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            constexpr size_t kDefaultSize = 1024 * 1024; // 1 MiB
            size_t size = req.value("size", static_cast<size_t>(kDefaultSize));
            if (size == 0) size = kDefaultSize;

            auto& webview = WebviewWrapper::GetInstance();
            if (!webview.EnsureWriteBuffer(size)) {
                res["action"] = "ErrorReport";
                res["msg"] = "共享内存分配失败 (EnsureWriteBuffer)";
                sendResponse(res);
                return;
            }

            // 推给 JS：action=SharedMemoryInit 表示这是「可写 buffer」，等待 JS 写入。
            // 真正完成的信号是 JS 的 sharedbufferreceived 事件，JSON 回执只作 ack。
            nlohmann::json meta = {
                {"action", "SharedMemoryInit"},
                {"size", webview.WriteBufferSize()}
            };
            if (!webview.SendWriteBufferAddress(meta.dump())) {
                res["action"] = "ErrorReport";
                res["msg"] = "共享内存地址推送到前端失败 (PostSharedBufferToScript)";
                sendResponse(res);
                return;
            }

            res["size"] = webview.WriteBufferSize();
            sendResponse(res);
            LOG_INFO("WebviewMessageHandler", "[C++ -> JS] 共享内存已就绪: " + std::to_string(size) + " bytes");
        }

        void HandleSharedMemoryUpdate(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            size_t written = req.value("size", static_cast<size_t>(0));
            auto& webview = WebviewWrapper::GetInstance();
            size_t capacity = webview.WriteBufferSize();
            if (capacity == 0) {
                res["action"] = "ErrorReport";
                res["msg"] = "共享内存尚未初始化，无法接收二进制数据";
                sendResponse(res);
                return;
            }
            // 把 JS 写进写 buffer 的字节交给上层（传输胶水等）
            if (written > 0 && written <= capacity) {
                webview.OnBinaryReceived(webview.WriteBufferData(), written);
            }
            res["size"] = written;
            sendResponse(res);
            LOG_INFO("WebviewMessageHandler", "[JS -> C++] 共享内存更新完成: " + std::to_string(written) + " bytes");
        }

        void HandleWindowMinimize(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            HWND hwnd = (HWND)WebviewWrapper::GetInstance().GetNativeWindow();
            if (hwnd) {
                PostMessage(hwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0);
            }
        }

        void HandleWindowDrag(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            HWND hwnd = (HWND)WebviewWrapper::GetInstance().GetNativeWindow();
            if (hwnd) {
                ReleaseCapture();
                SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
            }
        }

        void HandleWindowToggleMaximize(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            HWND hwnd = (HWND)WebviewWrapper::GetInstance().GetNativeWindow();
            if (hwnd) {
                if (IsZoomed(hwnd)) {
                    PostMessage(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0);
                } else {
                    PostMessage(hwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
                }
            }
        }

        void HandleWindowClose(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            HWND hwnd = (HWND)WebviewWrapper::GetInstance().GetNativeWindow();
            if (hwnd) {
                PostMessage(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0);
            }
        }

        void HandleWindowOpenDevTools(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            auto controller = (ICoreWebView2Controller*)WebviewWrapper::GetInstance().GetNativeController();
            if (controller) {
                Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
                if (SUCCEEDED(controller->get_CoreWebView2(&wv2))) {
                    wv2->OpenDevToolsWindow();
                }
            }
        }

        void HandleNavigate(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            std::string url = req.value("url", "");
            if (!url.empty()) {
                WebviewWrapper::GetInstance().Navigate(url);
            } else {
                res["action"] = "ErrorReport";
                res["msg"] = "Navigate URL is empty";
                sendResponse(res);
            }
        }

        void HandleWindowSetSize(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse) {
            if (!req.contains("width") || !req["width"].is_number_integer() ||
                !req.contains("height") || !req["height"].is_number_integer()) {
                return;
            }

            int width = req["width"].get<int>();
            int height = req["height"].get<int>();
            bool fixed = req.value("fixed", false);

            WebviewWrapper::GetInstance().SetSize(width, height, fixed);
        }

        static std::unordered_map<std::string, ActionDef> s_actionHandlers = {
            { "SharedMemoryInit", { HandleSharedMemoryInit, false } },
            { "SharedMemoryUpdate", { HandleSharedMemoryUpdate, false } },
            { "WindowMinimize", { HandleWindowMinimize, false } },
            { "WindowDrag", { HandleWindowDrag, false } },
            { "WindowToggleMaximize", { HandleWindowToggleMaximize, false } },
            { "WindowClose", { HandleWindowClose, false } },
            { "WindowOpenDevTools", { HandleWindowOpenDevTools, false } },
            { "Navigate", { HandleNavigate, false } },
            { "WindowSetSize", { HandleWindowSetSize, false } }
        };
    }

    void RegisterAction(const std::string& actionName, ActionHandler handler, bool runOnLoopThread) {
        s_actionHandlers[actionName] = { handler, runOnLoopThread };
        LOG_INFO("WebviewMessageHandler", "Registered new custom action handler: " + actionName + " (loopThread=" + std::to_string(runOnLoopThread) + ")");
    }

    std::string ProcessMessage(const std::string& jsonRequest) {
        LOG_INFO("WebviewMessageHandler", "Received request from JS: " + jsonRequest);
        
        auto& webview = WebviewWrapper::GetInstance();
        nlohmann::json parsedJson;

        if (!TryParseRequest(jsonRequest, parsedJson, webview)) {
            return "{}";
        }

        if (parsedJson.is_array() && !parsedJson.empty()) {
            parsedJson = parsedJson[0];
        }

        if (parsedJson.is_string()) {
            try {
                parsedJson = nlohmann::json::parse(parsedJson.get<std::string>());
            } catch (...) {}
        }
        
        if (!parsedJson.contains("action") || !parsedJson["action"].is_string()) {
            nlohmann::json errResponse = {
                {"action", "ErrorReport"},
                {"msg", "请求中缺少 'action' 字段或其不是合法的字符串类型"}
            };
            if (parsedJson.is_object() && parsedJson.contains("msgIndex")) {
                errResponse["msgIndex"] = parsedJson["msgIndex"];
            }
            webview.SendJson(errResponse.dump());
            return "{}";
        }

        std::string action = parsedJson["action"].get<std::string>();
        std::string msgIndex = parsedJson.value("msgIndex", "");

        auto it = s_actionHandlers.find(action);
        if (it != s_actionHandlers.end()) {
            ResponseCallback sendResponse = [action, msgIndex](const nlohmann::json& responseData) {
                nlohmann::json resBase = responseData;
                // 如果业务侧自己指定了 action (如 AuthResponse)，就不覆盖；否则默认使用原请求的 action
                if (!resBase.contains("action")) {
                    resBase["action"] = action;
                }
                if (!msgIndex.empty() && !resBase.contains("msgIndex")) {
                    resBase["msgIndex"] = msgIndex;
                }
                // 安全获取实例并发送
                WebviewWrapper::GetInstance().SendJson(resBase.dump());
            };

            nlohmann::json initialRes;
            initialRes["action"] = action;
            if (!msgIndex.empty()) initialRes["msgIndex"] = msgIndex;

            if (it->second.runOnLoopThread) {
                // 投递到 IObject 事件循环（主线程），保证 IObject 业务跑在线程亲和要求的线程上
                iobject::Post([handler = it->second.handler, req = parsedJson, res = initialRes, sendResponse]() {
                    handler(req, res, sendResponse);
                });
            } else {
                it->second.handler(parsedJson, initialRes, sendResponse);
            }
        } else {
            nlohmann::json resBase;
            resBase["action"] = "ErrorReport";
            if (!msgIndex.empty()) resBase["msgIndex"] = msgIndex;
            resBase["msg"] = "未知的业务类型 (Unknown Action): " + action;
            webview.SendJson(resBase.dump());
        }
        
        return "{}";
    }

}
}
}
