#pragma once

#include <string>
#include <functional>
#include <memory>
#include <vector>
#include <filesystem>
#include <cstdint>

// 静态链接到本工程，导出宏退化为空
#define SHIN_UIWEBVIEW_API

// Disable C4251 for std::unique_ptr crossing DLL boundary
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable: 4251)
#endif

namespace Shin {
namespace UI {

    class SHIN_UIWEBVIEW_API WebviewWrapper {
    public:
        static WebviewWrapper& GetInstance();

        WebviewWrapper(const WebviewWrapper&) = delete;
        WebviewWrapper& operator=(const WebviewWrapper&) = delete;

        void SetDebug(bool enable);
        // Enables remote debugging (CDP) on localhost:<port>. Must be called before Initialize().
        // port <= 0 disables remote debugging.
        void SetRemoteDebuggingPort(int port);
        void SetParentWindow(void* hwnd);
        
        void SetStartupURL(const std::string& url);
        void SetStartupHTML(const std::string& html);

        void SetContextMenuEnabled(bool enable);

        // Business Layer callback
        void SetJavascriptMessageCallback(std::function<std::string(const std::string&)> callback);

        void InjectJSBeforeLoad(const std::string& js);
        void BindFunction(const std::string& name, std::function<std::string(const std::string&)> fn);

        void SetTitle(const std::string& title);
        void SetSize(int width, int height, bool fixed = false);

        struct BrowserExtensionResult {
            bool success = false;
            std::filesystem::path path;
            std::string name;
            std::int32_t hresult = 0;
            std::string error;
        };
        using BrowserExtensionCallback = std::function<void(const BrowserExtensionResult&)>;

        // Must be configured before Initialize because it changes WebView2 EnvironmentOptions.
        void SetBrowserExtensionsEnabled(bool enable);
        // Installs a local unpacked extension directory. The callback is invoked asynchronously.
        bool AddBrowserExtension(const std::filesystem::path& extensionPath,
                                 BrowserExtensionCallback callback = {});

        bool Initialize();

        void OpenDevTools();

        void* GetNativeWindow();
        void* GetNativeController();

        void RunBlocking();
        void Terminate();
        void PostToUiThread(std::function<void()> fn);  // 线程安全：投递到 UI 消息泵线程执行（总是异步排队）
        bool IsOnUiThread() const;                       // 当前线程是否是 UI 线程
        void Navigate(const std::string& url);
        void ExecuteJS(const std::string& js); 
        
        void SendJson(const std::string& json);
        
        // In JS, listen via: window.chrome.webview.addEventListener('message', e => { if(typeof e.data === 'string') ... })
        void SendString(const std::string& str);
        
        // 二进制数据通道：单块共享内存（零拷贝）。
        // WebView2 的 sharedbufferreceived 只在第一次 PostSharedBufferToScript 时触发，
        // 因此这块内存只推一次；之后两个方向都往同一块内存读写，用文本消息（SharedMemoryUpdate / SharedMemoryPush）通知对方。
        bool EnsureWriteBuffer(size_t size);                           // 确保共享内存 >= size
        bool SendWriteBufferAddress(const std::string& meta = "{}");   // 把共享内存推给 JS（仅一次，SharedMemoryInit）
        void* WriteBufferData() const;                                 // C++ 读 JS 写进的数据
        size_t WriteBufferSize() const;                                // C++ 读当前共享内存大小
        bool PushSharedMemory(const void* data, size_t len);           // C++ 写数据到共享内存 + 文本通知 JS 读取（SharedMemoryPush）

        // 二进制帧收到回调：JS 写进写 buffer 后（SharedMemoryUpdate），C++ 读字节回调给上层。
        void SetBinaryReceivedCallback(std::function<void(const void*, size_t)> callback);
        void OnBinaryReceived(const void* data, size_t len);           // 转发给已注册的回调

    private:
        WebviewWrapper();
        ~WebviewWrapper();

        struct Impl;
        std::unique_ptr<Impl> m_impl; 
    };

}
}

#ifdef _MSC_VER
#pragma warning(pop)
#endif
