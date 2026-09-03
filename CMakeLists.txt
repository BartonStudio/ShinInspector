cmake_minimum_required(VERSION 3.20)
project(ShinInspector VERSION 0.1.0 LANGUAGES CXX)

# 统一输出目录：exe 与 dll 同目录，便于运行时加载
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

set_property(GLOBAL PROPERTY USE_FOLDERS ON)

# ---------------------------------------------------------------------------
# IObject —— 运行时对象模型静态库（C++20）
# ---------------------------------------------------------------------------
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/IObject)

# ---------------------------------------------------------------------------
# WebView2 SDK（仅本地头文件，供 webview 库与 webview 包装层编译）
# ---------------------------------------------------------------------------
set(MSWebView2_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/WebView2" CACHE PATH "WebView2 SDK root" FORCE)

# ---------------------------------------------------------------------------
# webview 库（vendored，github.com/webview/webview，只构建静态库）
# ---------------------------------------------------------------------------
set(WEBVIEW_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(WEBVIEW_BUILD_STATIC_LIBRARY ON CACHE BOOL "" FORCE)
set(WEBVIEW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WEBVIEW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WEBVIEW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(WEBVIEW_BUILD_AMALGAMATION OFF CACHE BOOL "" FORCE)
set(WEBVIEW_INSTALL_TARGETS OFF CACHE BOOL "" FORCE)
set(WEBVIEW_ENABLE_PACKAGING OFF CACHE BOOL "" FORCE)
set(WEBVIEW_USE_COMPAT_MINGW OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/webview)

# ---------------------------------------------------------------------------
# nlohmann/json（vendored，仅头文件）
# ---------------------------------------------------------------------------
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/json)

# ---------------------------------------------------------------------------
# webview 包装层（从 Shin 拷贝，已剥离 Shin::Core 依赖）
# ---------------------------------------------------------------------------
add_library(webviewui STATIC
    src/webview/WebviewWrapper.cpp
    src/webview/WebviewMessageHandler.cpp
)
target_include_directories(webviewui
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/webview
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/WebView2/include
)
target_compile_features(webviewui PUBLIC cxx_std_20)
if(MSVC)
    target_compile_options(webviewui PRIVATE /utf-8)
endif()
target_link_libraries(webviewui PUBLIC
    webview::core_static
    nlohmann_json::nlohmann_json
    IObject::IObject
)

# ---------------------------------------------------------------------------
# ShinInspector 应用
# ---------------------------------------------------------------------------
add_executable(ShinInspectorApp
    src/main.cpp
    src/App.cpp
    src/TestObject.cpp
)
target_include_directories(ShinInspectorApp PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_features(ShinInspectorApp PRIVATE cxx_std_20)
if(MSVC)
    target_compile_options(ShinInspectorApp PRIVATE /utf-8)
endif()
target_link_libraries(ShinInspectorApp PRIVATE
    IObject::IObject
    webviewui
)
set_target_properties(ShinInspectorApp PROPERTIES FOLDER "Application")
