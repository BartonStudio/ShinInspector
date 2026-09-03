#include "WebviewWrapper.hpp"
#include "WebviewMessageHandler.hpp"

#include "App.h"  // LOG_INFO / LOG_ERROR 等日志宏

#include <webview.h>
#include <thread>
#include <mutex>
#include <atomic>
#include <vector>
#include <algorithm>
#include <filesystem>
#include <future>
#include <optional>
#include <cstring>

#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <WebView2.h>
#include <wrl.h>
#pragma comment(lib, "comctl32.lib")
#endif

// 声明内部链接的 ProcessMessage
namespace Shin {
namespace UI {
namespace WebviewMessageHandler {
    std::string ProcessMessage(const std::string& jsonRequest);
}
}
}

#ifdef _WIN32
namespace {
    // 转发声明
    LRESULT CALLBACK HostSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData);
    LRESULT CALLBACK ChildSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData);
    BOOL CALLBACK EnumChildProc(HWND hWnd, LPARAM lParam);

    LRESULT CALLBACK HostSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData) {
        switch (uMsg) {
        case WM_NCCALCSIZE: {
            if (wParam) {
                // 如果是无边框模式，我们告诉系统客户区覆盖整个窗口
                DWORD style = GetWindowLongPtr(hWnd, GWL_STYLE);
                if (!(style & WS_CAPTION)) {
                    if (IsZoomed(hWnd)) {
                        // 最大化时需要留出边距，否则内容会超出屏幕或覆盖任务栏
                        LPNCCALCSIZE_PARAMS pncsp = reinterpret_cast<LPNCCALCSIZE_PARAMS>(lParam);
                        int border = GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                        pncsp->rgrc[0].top += border;
                        pncsp->rgrc[0].left += border;
                        pncsp->rgrc[0].right -= border;
                        pncsp->rgrc[0].bottom -= border;
                    }
                    return 0;
                }
            }
            break;
        }
        case WM_NCHITTEST: {
            // 先尝试系统的默认逻辑（这会处理滚动条等）
            LRESULT hit = DefSubclassProc(hWnd, uMsg, wParam, lParam);
            
            DWORD style = GetWindowLongPtr(hWnd, GWL_STYLE);
            // 只有无边框且非最大化时，才执行自定义边缘探测
            if (!(style & WS_CAPTION) && (style & WS_THICKFRAME) && !IsZoomed(hWnd)) {
                POINT pt = { GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
                RECT rc;
                GetWindowRect(hWnd, &rc);
                
                const int span = 10; // 足够大的探测范围

                bool left = (pt.x < rc.left + span);
                bool right = (pt.x >= rc.right - span);
                bool top = (pt.y < rc.top + span);
                bool bottom = (pt.y >= rc.bottom - span);

                if (top && left) return HTTOPLEFT;
                if (top && right) return HTTOPRIGHT;
                if (bottom && left) return HTBOTTOMLEFT;
                if (bottom && right) return HTBOTTOMRIGHT;
                if (top) return HTTOP;
                if (bottom) return HTBOTTOM;
                if (left) return HTLEFT;
                if (right) return HTRIGHT;
            }
            return hit;
        }
        case WM_SIZE:
        case WM_SHOWWINDOW: {
            EnumChildWindows(hWnd, EnumChildProc, (LPARAM)hWnd);
            break;
        }
        case WM_GETMINMAXINFO: {
            // 确保最大化时不会遮挡任务栏
            MINMAXINFO* mmi = (MINMAXINFO*)lParam;
            HMONITOR monitor = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
            if (monitor) {
                MONITORINFO mi = { sizeof(mi) };
                if (GetMonitorInfo(monitor, &mi)) {
                    mmi->ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
                    mmi->ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
                    mmi->ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
                    mmi->ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
                }
            }
            return 0;
        }
        }
        return DefSubclassProc(hWnd, uMsg, wParam, lParam);
    }

    LRESULT CALLBACK ChildSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass, DWORD_PTR dwRefData) {
        if (uMsg == WM_NCHITTEST) {
            HWND hostHwnd = (HWND)dwRefData;
            DWORD style = GetWindowLongPtr(hostHwnd, GWL_STYLE);

            if (!(style & WS_CAPTION) && (style & WS_THICKFRAME) && !IsZoomed(hostHwnd)) {
                POINT pt = { GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
                RECT rc;
                GetWindowRect(hostHwnd, &rc);
                
                const int span = 10;
                // 检查鼠标是否在宿主窗口的边缘
                if (pt.x < rc.left + span || pt.x >= rc.right - span ||
                    pt.y < rc.top + span || pt.y >= rc.bottom - span) {
                    // 让消息穿透到宿主窗口
                    return HTTRANSPARENT;
                }
            }
        } else if (uMsg == WM_NCDESTROY) {
            RemoveWindowSubclass(hWnd, ChildSubclassProc, uIdSubclass);
            RemovePropW(hWnd, L"ShinSubclassed");
        }
        return DefSubclassProc(hWnd, uMsg, wParam, lParam);
    }

    BOOL CALLBACK EnumChildProc(HWND hWnd, LPARAM lParam) {
        // 检查是否已经子类化过
        if (!GetPropW(hWnd, L"ShinSubclassed")) {
            SetWindowSubclass(hWnd, ChildSubclassProc, 2, lParam);
            SetPropW(hWnd, L"ShinSubclassed", (HANDLE)1);
            
            // 继续向下递归枚举子窗口的子窗口
            EnumChildWindows(hWnd, EnumChildProc, lParam);
        }
        return TRUE;
    }
}
#endif

namespace Shin {
namespace UI {

#ifdef _WIN32
    namespace {
        std::string WideToUtf8(const wchar_t* value) {
            if (!value) return {};
            const int length = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
            if (length <= 1) return {};
            std::string result(length - 1, '\0');
            WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), length, nullptr, nullptr);
            return result;
        }

        // —— 共享内存槽：两块独立 buffer，各有一个 owner，消除「扩容导致地址失效」竞态 ——
        struct SharedBufferSlot {
            Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer> buffer;
            void* memory = nullptr;
            size_t size = 0;
        };

        void ResetSharedBuffer(SharedBufferSlot& slot) {
            if (slot.memory) {
                UnmapViewOfFile(slot.memory);
                slot.memory = nullptr;
            }
            if (slot.buffer) {
                slot.buffer->Close();
                slot.buffer = nullptr;
            }
            slot.size = 0;
        }

        // 在 UI 线程上确保槽 >= size，不够则重建（新建成功后才释放旧槽）。调用方保证在 UI 线程。
        bool EnsureSharedBuffer(SharedBufferSlot& slot, size_t size, ICoreWebView2Controller* controller) {
            if (!controller || size == 0) return false;
            if (slot.buffer && slot.size >= size) return true;

            // 过小的 buffer 可能触发 CreateSharedBuffer/MapViewOfFile 的边界问题，统一至少 1 MiB。
            const size_t allocSize = size < 1048576 ? 1048576 : size;

            Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
            if (FAILED(controller->get_CoreWebView2(&wv2))) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2_2> wv2_2;
            if (FAILED(wv2.As(&wv2_2))) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2Environment> env;
            wv2_2->get_Environment(&env);
            if (!env) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2Environment12> env12;
            if (FAILED(env.As(&env12))) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer> newBuffer;
            if (FAILED(env12->CreateSharedBuffer(allocSize, &newBuffer))) return false;

            HANDLE handle = NULL;
            if (FAILED(newBuffer->get_FileMappingHandle(&handle)) || !handle) return false;

            void* mapped = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, allocSize);
            if (!mapped) return false;

            ResetSharedBuffer(slot);
            slot.buffer = newBuffer;
            slot.memory = mapped;
            slot.size = allocSize;
            return true;
        }

        // 在 UI 线程上把指定 buffer 推给 JS（sharedbufferreceived）。调用方保证在 UI 线程。
        bool PostBufferToScript(ICoreWebView2SharedBuffer* buffer, const std::string& meta, ICoreWebView2Controller* controller) {
            if (!buffer || !controller) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
            if (FAILED(controller->get_CoreWebView2(&wv2))) return false;

            Microsoft::WRL::ComPtr<ICoreWebView2_17> wv2_17;
            if (FAILED(wv2.As(&wv2_17))) return false;

            int size_needed = MultiByteToWideChar(CP_UTF8, 0, meta.c_str(), (int)meta.size(), NULL, 0);
            std::wstring wmeta(size_needed, 0);
            MultiByteToWideChar(CP_UTF8, 0, meta.c_str(), (int)meta.size(), &wmeta[0], size_needed);

            HRESULT hr = wv2_17->PostSharedBufferToScript(
                buffer,
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                wmeta.c_str()
            );
            return SUCCEEDED(hr);
        }

        class BrowserExtensionAddedHandler final
            : public ICoreWebView2ProfileAddBrowserExtensionCompletedHandler {
        public:
            BrowserExtensionAddedHandler(std::filesystem::path path,
                                        WebviewWrapper::BrowserExtensionCallback callback)
                : m_path(std::move(path)), m_callback(std::move(callback)) {}

            HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
                if (!object) return E_POINTER;
                if (iid == IID_IUnknown || iid == IID_ICoreWebView2ProfileAddBrowserExtensionCompletedHandler) {
                    *object = static_cast<ICoreWebView2ProfileAddBrowserExtensionCompletedHandler*>(this);
                    AddRef();
                    return S_OK;
                }
                *object = nullptr;
                return E_NOINTERFACE;
            }

            ULONG STDMETHODCALLTYPE AddRef() override { return ++m_referenceCount; }
            ULONG STDMETHODCALLTYPE Release() override {
                const ULONG count = --m_referenceCount;
                if (count == 0) delete this;
                return count;
            }

            HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode,
                                             ICoreWebView2BrowserExtension* extension) override {
                WebviewWrapper::BrowserExtensionResult result;
                result.path = m_path;
                result.success = SUCCEEDED(errorCode) && extension;
                result.hresult = static_cast<std::int32_t>(errorCode);

                if (result.success) {
                    LPWSTR name = nullptr;
                    if (SUCCEEDED(extension->get_Name(&name))) {
                        result.name = WideToUtf8(name);
                        CoTaskMemFree(name);
                    }
                } else {
                    result.error = "AddBrowserExtension failed with HRESULT 0x" +
                                   std::to_string(static_cast<unsigned long>(errorCode));
                }

                if (m_callback) m_callback(result);
                return S_OK;
            }

        private:
            volatile ULONG m_referenceCount = 1;
            std::filesystem::path m_path;
            WebviewWrapper::BrowserExtensionCallback m_callback;
        };
    }
#endif

    struct WebviewWrapper::Impl {
        bool debug = false;
        void* parentWindow = nullptr;
        std::string startupUrl;
        std::string startupHtml;
        bool contextMenuEnabled = false;
        std::string title = "Shin UI";
        int width = 800;
        int height = 600;
        int hints = WEBVIEW_HINT_NONE;
        bool browserExtensionsEnabled = false;
        std::string additionalBrowserArguments;
        
        struct BindData {
            std::string name;
            std::function<std::string(const std::string&)> fn;
        };
        std::vector<BindData> binds;
        std::vector<std::string> initScripts;
        std::function<std::string(const std::string&)> jsCallback;
        std::function<void(const void*, size_t)> binaryReceivedCallback;

        std::unique_ptr<webview::webview> w;
        std::atomic<bool> isInitialized{false};
        std::thread::id uiThreadId;

#ifdef _WIN32
        SharedBufferSlot writeBuffer;  // 单块共享内存：JS↔C++ 双向共用，posted 一次后不再重复推送
#endif
    };

    WebviewWrapper& WebviewWrapper::GetInstance() {
        static WebviewWrapper instance;
        return instance;
    }

    WebviewWrapper::WebviewWrapper() : m_impl(std::make_unique<Impl>()) {}
    WebviewWrapper::~WebviewWrapper() {
#ifdef _WIN32
        if (m_impl && m_impl->writeBuffer.memory) {
            UnmapViewOfFile(m_impl->writeBuffer.memory);
        }
#endif
    }

    void WebviewWrapper::SetDebug(bool enable) {
        if (!m_impl->isInitialized) m_impl->debug = enable;
    }

    void WebviewWrapper::SetRemoteDebuggingPort(int port) {
        if (m_impl->isInitialized) return;
        m_impl->additionalBrowserArguments.clear();
        if (port > 0) {
            // WebView2 binds the CDP endpoint to loopback (localhost) by default.
            m_impl->additionalBrowserArguments =
                "--remote-debugging-port=" + std::to_string(port);
        }
    }

    void WebviewWrapper::SetParentWindow(void* hwnd) {
        if (!m_impl->isInitialized) m_impl->parentWindow = hwnd;
    }

    void WebviewWrapper::SetStartupURL(const std::string& url) {
        if (!m_impl->isInitialized) m_impl->startupUrl = url;
    }

    void WebviewWrapper::SetStartupHTML(const std::string& html) {
        if (!m_impl->isInitialized) m_impl->startupHtml = html;
    }

    void WebviewWrapper::SetJavascriptMessageCallback(std::function<std::string(const std::string&)> callback) {
        if (!m_impl->isInitialized) m_impl->jsCallback = callback;
    }

    void WebviewWrapper::SetContextMenuEnabled(bool enable) {
        m_impl->contextMenuEnabled = enable;
        if (m_impl->w) {
#ifdef _WIN32
            auto controller = (ICoreWebView2Controller*)GetNativeController();
            if (controller) {
                Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
                if (SUCCEEDED(controller->get_CoreWebView2(&wv2))) {
                    Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
                    if (SUCCEEDED(wv2->get_Settings(&settings))) {
                        settings->put_AreDefaultContextMenusEnabled(enable);
                    }
                }
            }
#endif
        }
    }

    void WebviewWrapper::InjectJSBeforeLoad(const std::string& js) {
        if (!m_impl->isInitialized) m_impl->initScripts.push_back(js);
    }

    void WebviewWrapper::BindFunction(const std::string& name, std::function<std::string(const std::string&)> fn) {
        if (!m_impl->isInitialized) {
            m_impl->binds.push_back({name, fn});
        }
    }

    void WebviewWrapper::SetTitle(const std::string& title) {
        m_impl->title = title;
        if (m_impl->isInitialized && m_impl->w) {
            if (std::this_thread::get_id() == m_impl->uiThreadId) {
                m_impl->w->set_title(title);
            } else {
                m_impl->w->dispatch([this, title]() { m_impl->w->set_title(title); });
            }
        }
    }

    void WebviewWrapper::SetBrowserExtensionsEnabled(bool enable) {
        if (!m_impl->isInitialized) {
            m_impl->browserExtensionsEnabled = enable;
        }
    }

    void WebviewWrapper::SetSize(int width, int height, bool fixed) {
        m_impl->width = width;
        m_impl->height = height;
        m_impl->hints = fixed ? WEBVIEW_HINT_FIXED : WEBVIEW_HINT_NONE;
        
        if (m_impl->isInitialized && m_impl->w) {
            int w_copy = m_impl->width;
            int h_copy = m_impl->height;
            int hints_copy = m_impl->hints;
            if (std::this_thread::get_id() == m_impl->uiThreadId) {
                m_impl->w->set_size(w_copy, h_copy, static_cast<webview_hint_t>(hints_copy));
            } else {
                m_impl->w->dispatch([this, w_copy, h_copy, hints_copy]() { 
                    m_impl->w->set_size(w_copy, h_copy, static_cast<webview_hint_t>(hints_copy)); 
                });
            }
        }
    }

    bool WebviewWrapper::Initialize() {
        if (m_impl->isInitialized) return true;

        try {
            m_impl->w = std::make_unique<webview::webview>(
                m_impl->debug, m_impl->parentWindow,
                m_impl->browserExtensionsEnabled,
                m_impl->additionalBrowserArguments);
            m_impl->uiThreadId = std::this_thread::get_id();

            m_impl->w->set_title(m_impl->title);
            m_impl->w->set_size(m_impl->width, m_impl->height, static_cast<webview_hint_t>(m_impl->hints));

            // Apply Context Menu settings
            SetContextMenuEnabled(m_impl->contextMenuEnabled);

            for (const auto& js : m_impl->initScripts) {
                m_impl->w->init(js);
            }

            // Initialize custom namespace
            m_impl->w->init("window.Shin = window.Shin || {};");

            // Register Fixed Business Layer Entry Point (Auto-mounted to WebviewMessageHandler)
            m_impl->w->bind("__sendDataToCpp__", [this](const std::string& req) -> std::string {
                // If a dynamic callback was set via SetJavascriptMessageCallback, use it.
                if (m_impl->jsCallback) {
                    return m_impl->jsCallback(req);
                }
                // Otherwise, automatically route to the built-in business layer handler.
                return WebviewMessageHandler::ProcessMessage(req);
            });
            m_impl->w->init("window.Shin.sendDataToCpp = window.__sendDataToCpp__; delete window.__sendDataToCpp__;");

            // Keep custom binds working for backward compatibility or special cases
            for (const auto& b : m_impl->binds) {
                m_impl->w->bind(b.name, [fn = b.fn](const std::string& req) -> std::string {
                    return fn(req);
                });

                // Auto-map internal bound functions that start with __ and end with __ 
                // e.g. "__sendDataToCpp__" -> "window.Shin.sendDataToCpp"
                if (b.name.size() > 4 && b.name.substr(0, 2) == "__" && b.name.substr(b.name.size() - 2) == "__") {
                    std::string exposedName = b.name.substr(2, b.name.size() - 4);
                    std::string mappingScript = 
                        "window.Shin." + exposedName + " = window." + b.name + "; "
                        "delete window." + b.name + ";";
                    m_impl->w->init(mappingScript);
                }
            }

            if (!m_impl->startupHtml.empty()) {
                m_impl->w->set_html(m_impl->startupHtml);
            } else if (!m_impl->startupUrl.empty()) {
                m_impl->w->navigate(m_impl->startupUrl);
            }

            m_impl->isInitialized = true;

#ifdef _WIN32
            HWND hostHwnd = (HWND)GetNativeWindow();
            if (hostHwnd) {
                // 1. 宿主窗口子类化：处理边缘碰撞检测
                SetWindowSubclass(hostHwnd, HostSubclassProc, 1, 0);
                
                // 2. 子窗口枚举并子类化：让 WebView2 的边缘消息穿透到宿主
                // 稍微延迟一下确保 WebView2 子窗口已创建（可选，这里先同步尝试）
                EnumChildWindows(hostHwnd, EnumChildProc, (LPARAM)hostHwnd);
            }
#endif

            return true;
        } catch (...) {
            return false;
        }
    }

    void* WebviewWrapper::GetNativeWindow() {
        if (m_impl->w) {
            auto res = m_impl->w->window();
            if (res.ok()) return res.value();
        }
        return nullptr;
    }

    void WebviewWrapper::OpenDevTools() {
#ifdef _WIN32
        auto controller = (ICoreWebView2Controller*)GetNativeController();
        if (controller) {
            Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
            if (SUCCEEDED(controller->get_CoreWebView2(&wv2))) {
                wv2->OpenDevToolsWindow();
            }
        }
#endif
    }

    void* WebviewWrapper::GetNativeController() {
        if (m_impl->w) {
            auto res = m_impl->w->browser_controller();
            if (res.ok()) return res.value();
        }
        return nullptr;
    }

    bool WebviewWrapper::AddBrowserExtension(
        const std::filesystem::path& extensionPath,
        BrowserExtensionCallback callback) {
        if (!m_impl->isInitialized || !m_impl->w || !m_impl->browserExtensionsEnabled) {
            if (callback) {
                callback({false, extensionPath, {}, 0,
                          "Browser extensions must be enabled before Initialize"});
            }
            return false;
        }

        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            m_impl->w->dispatch([this, extensionPath, callback]() {
                AddBrowserExtension(extensionPath, callback);
            });
            return true;
        }

        const auto manifestPath = extensionPath / "manifest.json";
        if (!std::filesystem::is_directory(extensionPath) ||
            !std::filesystem::is_regular_file(manifestPath)) {
            if (callback) {
                callback({false, extensionPath, {}, 0,
                          "Extension directory must contain a top-level manifest.json"});
            }
            LOG_ERROR("Webview", "Invalid browser extension directory: " + extensionPath.string());
            return false;
        }

#ifdef _WIN32
        auto controller = static_cast<ICoreWebView2Controller*>(GetNativeController());
        if (!controller) {
            if (callback) callback({false, extensionPath, {}, 0, "ICoreWebView2Controller is unavailable"});
            return false;
        }

        Microsoft::WRL::ComPtr<ICoreWebView2> webview;
        Microsoft::WRL::ComPtr<ICoreWebView2_13> webview13;
        Microsoft::WRL::ComPtr<ICoreWebView2Profile> profile;
        Microsoft::WRL::ComPtr<ICoreWebView2Profile7> profile7;

        HRESULT result = controller->get_CoreWebView2(&webview);
        if (SUCCEEDED(result)) result = webview.As(&webview13);
        if (SUCCEEDED(result)) result = webview13->get_Profile(&profile);
        if (SUCCEEDED(result)) result = profile.As(&profile7);
        if (FAILED(result)) {
            if (callback) {
                callback({false, extensionPath, {}, static_cast<std::int32_t>(result),
                          "WebView2 Runtime does not support the Browser Extensions API"});
            }
            LOG_ERROR("Webview", "Browser Extensions API unavailable, HRESULT=" + std::to_string(static_cast<long>(result)));
            return false;
        }

        const std::wstring absolutePath = std::filesystem::absolute(extensionPath).wstring();
        auto* handler = new BrowserExtensionAddedHandler(extensionPath, callback);
        result = profile7->AddBrowserExtension(absolutePath.c_str(), handler);
        if (FAILED(result)) {
            handler->Release();
            if (callback) {
                callback({false, extensionPath, {}, static_cast<std::int32_t>(result),
                          "AddBrowserExtension request was rejected"});
            }
            LOG_ERROR("Webview", "AddBrowserExtension request failed for " + extensionPath.string() + ", HRESULT=" + std::to_string(static_cast<long>(result)));
            return false;
        }
        return true;
#else
        if (callback) callback({false, extensionPath, {}, 0, "Browser extensions are supported only on Windows/WebView2"});
        return false;
#endif
    }

    void WebviewWrapper::RunBlocking() {
        if (m_impl->isInitialized && m_impl->w) {
            m_impl->w->run();
            // 关键：在 UI 线程就地销毁 webview。
            // 它的析构里会跑 deplete_run_loop_event_queue()（需要本线程的消息泵），
            // 若留到进程退出在主线程析构，会因为消息窗口线程已死而永久阻塞。
            m_impl->w.reset();
            m_impl->isInitialized = false;
        }
    }

    void WebviewWrapper::Terminate() {
        if (m_impl->isInitialized && m_impl->w) {
            m_impl->w->terminate();
        }
    }

    void WebviewWrapper::PostToUiThread(std::function<void()> fn) {
        if (m_impl->isInitialized && m_impl->w && fn) {
            // dispatch 内部是 PostMessageW 到消息窗口，总是在 UI 线程的下一轮消息循环执行
            m_impl->w->dispatch(std::move(fn));
        }
    }

    bool WebviewWrapper::IsOnUiThread() const {
        return std::this_thread::get_id() == m_impl->uiThreadId;
    }

    void WebviewWrapper::Navigate(const std::string& url) {
          if (m_impl->isInitialized && m_impl->w) {
            if (std::this_thread::get_id() == m_impl->uiThreadId) {
                m_impl->w->navigate(url);
            } else {
                m_impl->w->dispatch([this, url]() { m_impl->w->navigate(url); });
            }
        }
    }

    void WebviewWrapper::ExecuteJS(const std::string& js) {
        if (m_impl->isInitialized && m_impl->w) {
            if (std::this_thread::get_id() == m_impl->uiThreadId) {
                m_impl->w->eval(js);
            } else {
                m_impl->w->dispatch([this, js]() { m_impl->w->eval(js); });
            }
        }
    }

    void WebviewWrapper::SendJson(const std::string& json) {
        if (!m_impl->isInitialized || !m_impl->w) return;

        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            m_impl->w->dispatch([this, json]() { SendJson(json); });
            return;
        }

#ifdef _WIN32
        auto controller = (ICoreWebView2Controller*)GetNativeController();
        if (controller) {
            Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
            if (SUCCEEDED(controller->get_CoreWebView2(&wv2))) {
                int size_needed = MultiByteToWideChar(CP_UTF8, 0, json.c_str(), (int)json.size(), NULL, 0);
                std::wstring wjson(size_needed, 0);
                MultiByteToWideChar(CP_UTF8, 0, json.c_str(), (int)json.size(), &wjson[0], size_needed);
                wv2->PostWebMessageAsJson(wjson.c_str());
            }
        }
#endif
    }

    void WebviewWrapper::SendString(const std::string& str) {
        if (!m_impl->isInitialized || !m_impl->w) return;

        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            m_impl->w->dispatch([this, str]() { SendString(str); });
            return;
        }

#ifdef _WIN32
        auto controller = (ICoreWebView2Controller*)GetNativeController();
        if (controller) {
            Microsoft::WRL::ComPtr<ICoreWebView2> wv2;
            if (SUCCEEDED(controller->get_CoreWebView2(&wv2))) {
                int size_needed = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), NULL, 0);
                std::wstring wstr(size_needed, 0);
                MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.size(), &wstr[0], size_needed);
                wv2->PostWebMessageAsString(wstr.c_str());
            }
        }
#endif
    }

    bool WebviewWrapper::EnsureWriteBuffer(size_t size) {
        if (!m_impl->isInitialized || !m_impl->w || size == 0) return false;

        // WebView2 COM 对象必须在 UI 线程访问（STA）。跨线程则 dispatch 并等待结果。
        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            auto promise = std::make_shared<std::promise<bool>>();
            auto future = promise->get_future();
            m_impl->w->dispatch([this, promise, size]() {
                promise->set_value(this->EnsureWriteBuffer(size));
            });
            return future.get();
        }

#ifdef _WIN32
        return EnsureSharedBuffer(m_impl->writeBuffer, size, (ICoreWebView2Controller*)GetNativeController());
#else
        return false;
#endif
    }

    bool WebviewWrapper::SendWriteBufferAddress(const std::string& meta) {
        if (!m_impl->isInitialized || !m_impl->w) return false;

        // 跨线程才 dispatch，同线程必须立即同步执行（PostSharedBufferToScript 的深坑）
        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            m_impl->w->dispatch([this, meta]() { SendWriteBufferAddress(meta); });
            return true;
        }

#ifdef _WIN32
        return PostBufferToScript(m_impl->writeBuffer.buffer.Get(), meta, (ICoreWebView2Controller*)GetNativeController());
#else
        return false;
#endif
    }

    void* WebviewWrapper::WriteBufferData() const {
        return m_impl->writeBuffer.memory;
    }

    size_t WebviewWrapper::WriteBufferSize() const {
        return m_impl->writeBuffer.size;
    }

    bool WebviewWrapper::PushSharedMemory(const void* data, size_t len) {
        if (!data || len == 0) {
            LOG_ERROR("Webview", "PushSharedMemory: 参数无效");
            return false;
        }
        if (!m_impl->isInitialized || !m_impl->w) {
            LOG_ERROR("Webview", "PushSharedMemory: 未初始化");
            return false;
        }

        if (std::this_thread::get_id() != m_impl->uiThreadId) {
            auto promise = std::make_shared<std::promise<bool>>();
            auto future = promise->get_future();
            m_impl->w->dispatch([this, promise, data, len]() {
                promise->set_value(this->PushSharedMemory(data, len));
            });
            return future.get();
        }

#ifdef _WIN32
        auto controller = (ICoreWebView2Controller*)GetNativeController();
        // 单块共享内存：写入已 posted 的 buffer，不再重复 PostSharedBufferToScript（WebView2 只认第一次推送）。
        if (!EnsureSharedBuffer(m_impl->writeBuffer, len, controller)) {
            LOG_ERROR("Webview", "PushSharedMemory: EnsureSharedBuffer 失败 size=" + std::to_string(len));
            return false;
        }
        memcpy(m_impl->writeBuffer.memory, data, len);
        // 用文本消息通知 JS 读取（而不是再推一次 buffer）
        const std::string msg = "{\"action\":\"SharedMemoryPush\",\"size\":" + std::to_string(len) + "}";
        SendJson(msg);
        LOG_INFO("Webview", "PushSharedMemory: 写入并通知 " + std::to_string(len) + " bytes");
        return true;
#else
        return false;
#endif
    }

    void WebviewWrapper::SetBinaryReceivedCallback(std::function<void(const void*, size_t)> callback) {
        m_impl->binaryReceivedCallback = std::move(callback);
    }

    void WebviewWrapper::OnBinaryReceived(const void* data, size_t len) {
        if (m_impl->binaryReceivedCallback) {
            m_impl->binaryReceivedCallback(data, len);
        }
    }

}
}