#pragma once
#include <string>
#include <functional>
#include <nlohmann/json.hpp>

// 静态链接到本工程，导出宏退化为空
#define SHIN_UIWEBVIEW_API

namespace Shin { 
    namespace UI { 
        class WebviewWrapper; 
        namespace WebviewMessageHandler { 
            using ResponseCallback = std::function<void(const nlohmann::json&)>;
            using ActionHandler = std::function<void(const nlohmann::json& req, nlohmann::json res, ResponseCallback sendResponse)>; 
            SHIN_UIWEBVIEW_API void RegisterAction(const std::string& actionName, ActionHandler handler, bool runOnLoopThread = true); 
        } 
    } 
}
