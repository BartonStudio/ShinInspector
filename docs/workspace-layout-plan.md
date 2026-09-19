# Shin-Apps 工作区结构方案

> 状态：**方案，未实施**。本文是结构重构与仓库改名的施工依据。
> 适用前提：ShinInspector 是**平台上的第一个方案**，后续还会有若干界面完全不同的 Web 应用方案。

## 0. 定位

ShinInspector 不是"一个工具"，而是**一个平台 + 若干方案**：

- **平台**：WebView2 宿主壳、IObject 桥接、连接与状态基础设施。**不认识任何具体方案**。
- **方案**：用 Web 技术写的完整应用（界面各自独立），可自带 C++。

两个必须分清的概念（早期方案里混淆过一次）：

| 概念 | 是什么 | 变不变 |
| --- | --- | --- |
| **方案（app）** | 一套完整的 Web 应用：自己的界面、自己的入口 | **可变**，这才是"变"的单位 |
| **被调试目标（target）** | 运行时连上的那棵对象树，只是地址 + 域名两个参数 | 不是代码单位，不进目录结构 |

## 1. 分层的判据

> **这段代码删掉，两个方案会各自抄一份吗？**
> 会 → `platform/`；不会 → `apps/<name>/`。

按这条尺子，渲染、面板、主题、样式**全部下沉到方案**（每个方案界面完全不同，放平台必然互相打架）；只有"任何方案都要重写一遍"的东西才留在平台。

## 2. 目录结构

```
<workspace>/
├─ platform/                      # ★ 不变：所有方案共用的底座
│  ├─ host/                       # C++
│  │  ├─ WebviewShell.{hpp,cpp}   #   ← src/webview/WebviewWrapper（窗口 / DPI / 消息泵）
│  │  ├─ RuntimeHost.{hpp,cpp}    #   ← App.h 的域 / 执行器 / 日志宏（域名由清单注入）
│  │  └─ AppManifest.hpp          #   读 app.json：窗口尺寸 / 入口 URL / 默认连接
│  ├─ webui/                      # JS：只放"每个方案都要重写一遍"的东西
│  │  ├─ transport/               #   session · diagnose · retry（会话、自诊断、可取消）
│  │  ├─ bridge/                  #   iobject-js 封装：远端句柄 / 订阅 / 通道读写 / 事件流
│  │  ├─ state/                   #   事件总线 + 按对象路径持久化
│  │  └─ ui-kit/                  #   可选：终止态面板 / 诊断条 / 主题变量
│  └─ cmake/ShinApp.cmake         #   shin_add_app() 宏
├─ apps/                          # ★ 可变：一个方案一个目录，彼此互不可见
│  └─ inspector/
│     ├─ app.json                 #   方案清单（见 §3）
│     ├─ ui/                      #   该方案的全部界面（index.html / styles / src）
│     ├─ native/                  #   该方案的 C++（可选）—— ← TestObject / DemoTree
│     ├─ tools/                   #   smoke.mjs · look.mjs · probe-ws.mjs
│     └─ CMakeLists.txt
├─ third_party/                   # 不动（IObject 是 submodule）
├─ docs/
└─ CMakeLists.txt                 # 根：加 third_party → platform → 遍历 apps
```

## 3. 方案清单 `app.json`

```json
{
  "name": "inspector",
  "title": "ShinInspector",
  "window": { "width": 1280, "height": 720 },
  "entry": {
    "dev":  "http://127.0.0.1:8848/index.html",
    "dist": "web/index.html"
  },
  "connect": {
    "url": "ws://127.0.0.1:9002",
    "domain": "shininspector"
  }
}
```

| 字段 | 谁读 | 用途 |
| --- | --- | --- |
| `name` | 宿主 + 构建 | 方案标识，必须与目录名一致 |
| `title` | 宿主 | 窗口标题 |
| `window.*` | 宿主 | **逻辑像素**设计尺寸，交给 `ApplyDesignSize()` 做 DPI 换算与不溢出收敛 |
| `entry.dev` | 宿主（开发模式） | Vite dev server 地址 |
| `entry.dist` | 宿主（生产模式） | 相对 `apps/<name>/` 的静态入口 |
| `connect.*` | 前端 | 顶栏预填值，用户仍可改 |

### 3.1 刻意**不设** `native` 字段

早期草案里有 `"native": null` 表示"纯 Web 方案"。**已删除，不要加回来。**

理由：同一件事会有两个真源 —— `apps/x/native/` 目录是否存在（构建期 CMake 知道），和清单里的 `native` 字段（运行时读）。两者一旦不一致（目录里有 `native/`，清单却写 `null`），症状是"C++ 代码莫名不生效"，而排查要从构建系统反向追到运行时清单。

**判据：同一事实不要有两个真源。** `app.json` 的职责是**运行时**清单；"要不要编 native"是**构建期**决定，让 CMake 看目录结构自己判断。

## 4. 构建：`shin_add_app`

```cmake
# apps/inspector/CMakeLists.txt —— 自带 C++
add_subdirectory(native)
shin_add_app(inspector NATIVE_TARGET shin_app_inspector)

# apps/dashboard/CMakeLists.txt —— 纯 Web，零 C++ 改动
shin_add_app(dashboard)
```

`NATIVE_TARGET <target>` 取代早期的布尔开关 `WITH_NATIVE`：

- 布尔开关只回答"要不要"，库名还得在别处定义，**两处必须对齐**；
- `NATIVE_TARGET` 直接声明**依赖哪个库**，自解释，且和目标名强绑定。

### 4.1 输出目录约定

每个方案在产物目录里占一个 `apps/<name>/`，宿主按名字查找：

```
build/bin/
├─ ShinShell.exe              # 通用宿主：跑纯 Web 方案（shin_add_app 未传 NATIVE_TARGET）
├─ ShinInspector.exe          # 自带 native 的方案：独立 exe
└─ apps/
   ├─ inspector/{app.json, web/}
   └─ dashboard/{app.json, web/}
```

- **纯 Web 方案**共用 `ShinShell.exe`，`ShinShell.exe --app dashboard` 启动；
- **自带 C++ 的方案**生成 `<AppName>.exe`，只链自己的 `NATIVE_TARGET`。

宏的职责：① 复制 `app.json` 到 `bin/apps/<name>/`；② 若有 `entry.dist` 对应产物，一并复制为 `web/`；③ 传了 `NATIVE_TARGET` 才生成独立 exe。

### 4.2 通用宿主先不做

**现在只有 inspector 一个方案，暂不抽 `ShinShell.exe`。** 等第二个纯 Web 方案真的出现再抽 —— 到那时才知道壳里该留什么。过早抽出来的一定是错的。

## 5. 迁移步骤

每一步都可独立验证，不要合并跳跃。

| # | 步骤 | 验证方式 |
| --- | --- | --- |
| 1 | 删死代码：`src/BridgeTransport.hpp`、`src/webview/ShinBinaryJS.hpp`（grep 确认零引用） | 增量编译通过 |
| 2 | `ui/` → `apps/inspector/ui/`，Vite root 指过去（**不改任何逻辑**） | dev server 起得来、界面照旧 |
| 3 | 抽 `platform/webui`：`session/diagnose/store/memory` 移入，加 alias `@shin/webui` | 冒烟测试全绿 |
| 4 | 抽 `platform/host`：`WebviewWrapper` 平移 + `AppManifest` 读 `app.json`；`App.h` 的硬编码域名改为从清单注入 | `--demo` 仍能起、日志 DPI 行正常 |
| 5 | `TestObject` + `DemoTree` → `apps/inspector/native/`，改 `shin_add_app(inspector NATIVE_TARGET …)` | 生成同名 exe，`--demo` 跑通 |
| 6 | 建第二个方案骨架（hello world 即可） | **验证"加方案零改平台"是否真成立** |

### 5.1 改名合并到本次重构

本地目录改名（`ShinInspector` → `Shin-Apps`）与上述结构重构**合并为一次操作、一个提交**。分两次做会在历史里留下两次连续的大规模移动，之后 `git log --follow` 追文件会非常痛苦。

GitHub 侧改名：仓库 Settings → Rename（本机无 `gh` CLI，网页最快）。GitHub 会为旧 URL 保留自动重定向，但建议本地同步：

```bash
git remote set-url origin https://github.com/BartonStudio/Shin-Apps.git
```

## 6. 已知陷阱（改结构前必读）

1. **`.gitignore` 的路径断言**。原规则按 `ui/node_modules/` 写死，`ui/` 一搬就失效。
   **已改为路径无关的 `node_modules/` 与 `dist/`**，搬家后无需再动。
   （若某天要写新的忽略规则，一律优先用路径无关写法。）
2. **`build/` 必须删掉重配**。`CMakeCache.txt` 内部全是绝对路径，目录改名后全部失效，
   增量编译会以莫名其妙的方式失败 —— 不是代码问题，别去查代码。
3. **改名要先停进程**。Vite dev server 与宿主 exe 持有文件句柄时，Windows 上改名会直接失败。
4. **`third_party/IObject` 是 submodule，且当前处于未初始化状态**（实际内容是一份独立 clone，
   内含 `js/node_modules`）。提交时**不要 `git add -A`**，会把它连同 node_modules 卷进去 —— 逐路径 `add`。
5. **`.workbuddy/` 不入库**（已加入 `.gitignore`）。它是本地工作区数据（AI 会话记忆、临时日志与截图）。
