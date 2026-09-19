# ShinInspector 前端重构方案

> 把「表单面板式调试页」重构为「基于 Three.js 的节点可视化调试器」，并移除进程间通信（IPC）通道，只保留 WebSocket。
>
> 状态：**已实施并验证**（见文末「验证记录」）。
>
> ⚠️ **路径注记**：本文写于结构重构之前 —— 文中出现的 `ui/` 现已是 `apps/inspector/ui/`
> （`ui/tools/` → `apps/inspector/ui/tools/`）。`src/` 与 `third_party/` 路径未变。
> 分层的施工依据见 `workspace-layout-plan.md`。

---

## 一、工程定位

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 运行时框架 | `third_party/IObject` | 对象树（**允许多父的 DAG**）、命名数据通道、命名方法、事件。边由 `Connect(name, child)` 建立 |
| 远程协议 | `RuntimeBridgeRoot` / `RuntimeBridgePeer` | MessagePack，共 **9 个 op**；`RuntimeDomain` 提供「一棵树一个域名」的路由键 |
| 传输服务 | `WebSocketServer` | websocketpp + standalone Asio，一个服务可经 `BindDomain` 服务多个域 |
| 桌面壳 | `third_party/webview` + `src/webview/*` | WebView2 宿主（共享内存 IPC 通路保留在壳内，但应用层已不再使用） |
| 应用装配 | `src/App.cpp` | WebView2 宿主；`--demo` 时额外起 WS 服务端 + 测试树 |
| 前端 | `ui/` | Vite + Three.js 单页可视化调试器 |

**定位**：ShinInspector 是**跨进程观测器** —— 调试另一个 IObject 应用，因此只走 WebSocket。

---

## 二、核心模型：观察清单（用户声明，非自动发现）

这是本方案最关键的决策。

画布上显示哪些对象，**完全由用户声明**，工具不做全树扫描。

- 每条 `spec` 记录的是「**怎么找到它**」，而不是找到之后的 `addr`：
  | kind | 形式 | 解析方式 |
  | --- | --- | --- |
  | `root` | 锚点 | 握手响应里的 `client.root.addr`，始终保留 |
  | `path` | `Device.Sub` | 从 root 逐级 `GetChildItem` |
  | `addr` | `0x7FF6A1C0` | 直接作为句柄使用 |

- **边的来源**：只对「已声明的节点」调用 `GetChildren`。
  - 返回的子节点命中另一个已声明节点 → 连一条边
  - 未命中 → 记为「探到的子节点（未加入）」，由用户决定是否一键加入

这样工具的可见范围严格等于用户的声明范围，不会自作主张铺开整棵树。

### 两个必须记住的推论

1. **持久化键用路径，不用 addr。** `addr` 是指针数值，目标应用一重启即失效；路径才跨会话稳定。清单持久化的是 spec（路径/地址字符串），重连后重新解析。
2. **重连后必须重建整张图**（`addr` 全变了）。`on('reconnected')` 会重新解析清单并重新订阅。

---

## 三、协议约束（决定 UI 能做什么）

协议只有 9 个 op，**没有任何反射 / 元数据能力**：

| 想知道 | 协议支持 | 后果 |
| --- | --- | --- |
| 有哪些子对象 | ✅ `GetChildren` → `{name, addr}` | 图可反推拓扑 |
| 对象是什么类型 | ❌ | 节点只有 name + addr，**没有类型名** |
| 有哪些通道 | ❌ | 通道名需人工输入 |
| 有哪些方法 | ❌ | 方法名需人工输入 |
| 通道当前值 | ✅ `ReadData` | 主动拉取，或在事件中携带 |
| 结构是否变化 | ✅ `ChildConnected` / `ChildDisconnected` | 触发拓扑重算 |
| 通道是否变化 | ⚠️ `DataChannelChanged` **需先 SubscribeEvent** | 必须主动订阅才有推送 |

**「自动列出所有通道和方法」在现有协议下做不到。** 补偿手段是**用「学习」代替「反射」**：

1. 每个已声明节点自动订阅 4 个内置事件（`ChildConnected` / `ChildDisconnected` / `DataChannelChanged` / `Released`）；
2. 收到 `DataChannelChanged` 就记录**通道名 + 载荷快照 + 时间戳** → 检查器的「已观测通道」自己长出来；
3. 方法名按**对象路径**持久化到 `localStorage`，形成"我试过这些方法"的历史。

此外 `GetChildItem` 只支持不含 `.` 的单层名，拓扑是 DAG（一个节点可能被多个父节点连接），
因此节点**以 addr 为键去重**，路径仅作显示名。

---

## 四、实现结构

```
ui/
├── index.html            单页：连接条（含诊断条）+ 画布 + 检查器 + 时间线
├── vite.config.mjs       已移除 settings 入口，appType: spa
├── styles/app.css
├── tools/
│   ├── smoke.mjs         端到端冒烟：puppeteer 驱动系统 Chrome、真实时钟跑关键交互
│   └── probe-ws.mjs      一次性探针：确认 WebSocket 构造器对各 scheme 的真实行为
└── src/
    ├── main.js           装配 + 编排「连接 → 加载清单 → 解析 → 订阅」+ 暴露 __shin 调试句柄
    ├── store.js          全局状态 + 极简事件总线（各模块唯一的交换点）
    ├── session.js        连接生命周期：握手 / 关闭 / 断线重连（指数退避）+ 世代令牌
    ├── diagnose.js       连接失败的可执行诊断（主动探测 + 分情况给出下一步）
    ├── bytes.js          字节编解码 + 显示层类型推断（u8 / u32 / 文本）
    ├── memory.js         「学到的知识」，按对象路径持久化（通道 / 方法 / 被关掉的订阅）
    ├── workspace.js      观察清单：解析 / 增删 / 批量导入 / 导出 / 持久化
    ├── topology.js       从 GetChildren 反推边 + 深度计算（结构事件去抖）
    ├── observe.js        事件订阅与分发（支持按节点、按事件类型开关）
    ├── render/
    │   ├── index.js      渲染层入口：WebGL 硬要求，缺失即停摆（无降级）
    │   ├── scene.js      three 场景 / 相机 / OrbitControls / 渲染循环
    │   ├── layout.js     d3-force-3d 布局（手动 tick，与渲染帧同步）
    │   └── graph.js      InstancedMesh 节点 + LineSegments 边 + Sprite 标签 + 动画
    └── panel/
        ├── toolbar.js    连接配置 + 状态 + 全局动作
        ├── stagebar.js   布局切换 / 冻结 / 实时计数
        ├── inspector.js  未选中 = 清单管理；选中 = 节点详情（通道 / 方法 / 事件）
        └── timeline.js   事件时间线（rAF 节流 + 环形缓冲）
```

新增依赖：`three@0.186`、`d3-force-3d@3.0.6`；开发依赖 `puppeteer-core`（仅冒烟用，复用系统 Chrome，不下载 Chromium）。

### 视觉语义

| 状态 | 视觉 |
| --- | --- |
| root 锚点 | 蓝色球体 |
| 普通节点 | 灰蓝球体 |
| 选中 | 蓝色 + 面向相机的加粗环 |
| 刚发生 `DataChannelChanged` | 金色环向外扩散并淡出（950ms） |
| `Released` | 变灰、标签半透明 |
| 已订阅 | 检查器显示 `订阅 4 / 4` |

- 节点与标签的世界尺寸**按相机距离缩放**，屏幕上观感恒定 —— 图多大都读得清。
- 相机取景在**布局收敛后**触发一次（`alpha < 0.015`），且用户已手动转过相机时不抢镜。
- 默认 3/4 视角，避免正对 +z 时深度不可见导致节点在屏幕上互相压住。

---

## 五、交互补完

### 订阅是可控的，不是全有全无

原先只做「每节点无脑订阅 4 个内置事件」，检查器里的「全部取消」是个假按钮（只打日志）。
现在每个节点持有：

- `node.subs` —— 当前**生效**的订阅类型；
- `node.subsOff` —— 用户**显式关掉**的类型，按对象路径写进 `memory`（`localStorage`）。

两个集合分开存是必需的：`resolveAll` 每次都会重建 node 对象，
如果只把「关掉」记在 node 上，一次「重扫」就会把用户的意图抹掉。
同步逻辑也从「新节点才订阅」改成「**补齐缺失的订阅**」，这样关掉再打开也能挂回去。

订阅开关故意走轻量事件 `subscriptions` 而不是复用 `topology` ——
后者会触发布局 rebuild，为了切一个开关把整张图抖一遍是不合适的。

### 检查器

| 能力 | 说明 |
| --- | --- |
| 通道行内写入 | 每行「写」按钮就地展开输入框（hex / 文本），走局部 DOM 操作**不整块重绘** —— 重绘会打断输入，也会把刚读到的其他通道值刷掉。失败时保留输入行、恢复按钮、把错误 flash 在 placeholder 上 |
| 通道行内读取 | 「读」按钮，结果写回行内并同步进 `memory` |
| 清单导入 / 导出 | 内联 textarea。导出为逐行文本（`0x…` 或路径），导入按行解析、跳过空行与 `#` 注释、跳过重复项、汇总报出非法行 |
| 清单筛选 | 条目多于 5 条时出现筛选框，按 spec 值或节点名过滤 |

导入走新增的 `workspace.addSpecs()` 而不是循环调 `addSpec()`：
后者每调一次就 `resolveAll()` 一遍全清单，导入 20 条会变成 20 次全量重扫。
批量版先攒齐再解析一次。

重绘一律走 `render()` 里的 **keepFocus** 逻辑（记下 `document.activeElement.id` 与光标位置再还原）——
检查器里全是输入框，而 `DataChannelChanged` 会频繁触发重绘，不这么做打字打到一半就会丢焦点。

### 画布与快捷键

- 画布左下角补上图例（`.legend` 样式早就在，但从来没人渲染它，颜色语义对用户不可见）。
- 渲染器停摆时给 `#stage` 加 `no-render` 类，冻结开关 / 引导语 / 图例一起退场。
- 快捷键：`F` 重新取景、`Esc` 取消选择、`空格` 冻结布局、`R` 重扫清单、`/` 聚焦「加入」输入框。
  正在输入（input / select / textarea / contenteditable）时一律不抢按键。

### `window.__shin` 调试句柄

`main.js` 装配完成后把核心对象挂到 `window.__shin`（state / emit / session / memory /
renderer / workspace.* / observe.*）。两个用途：

1. 在 DevTools 里直接驱动这个工具本身，例如 `__shin.emit('rescan-request')`；
2. **给冒烟测试用**。这不是可选项 —— Vite dev server 会给模块 URL 挂 HMR 时间戳
   （`/src/store.js?t=1789757828842`），从外部 `import('/src/store.js')` 拿到的是
   **另一个模块实例**，读到的 state 全是初始值。踩过一次，记在这里。

### 端到端冒烟：`ui/tools/smoke.mjs`

```bash
node ui/tools/smoke.mjs [wsUrl] [domain]
# 前置：ui 的 Vite dev server 在跑；ShinInspectorApp.exe --demo 提供 9002
```

用 `puppeteer-core` 驱动**系统 Chrome**（不下载 Chromium），真实时钟跑 36 项断言。

> 为什么不用 `chrome --headless --virtual-time-budget`：
> Chromium 的虚拟时钟不把 WebSocket 往返当作 pending 工作，会把时间预算瞬间快进掉，
> 于是 `await` 一个 RPC（`getChildItem` / `invoke`…）永远等不到结果，测试表现为"卡住"。
> 更隐蔽的是：用 `setInterval` 轮询等连接会**持续烧掉**预算，连前面的步骤都跑不完。
> 这条路趟过一遍，结论是——需要真实网络往返的端到端测试必须用真实时钟。

### 连接失败诊断

**问题**：连不上时浏览器只给 `onerror`，不带任何原因（安全考虑），
SDK 只能转述成 `OperationFailed: WebSocket 连接错误`。对一个调试工具来说，
最高频的失败模式报一句零信息量的话是不可接受的。

**做法**（`ui/src/diagnose.js`）：失败之后补一次**主动探测**，把「连不上」拆成互不相同的几种情况：

| 判定 | 依据 | 给出的下一步 |
| --- | --- | --- |
| 地址协议不支持 | 构造器抛的 SyntaxError 文案含 `scheme` | 只接受 ws/wss（http/https 会被自动改写） |
| 地址无法解析 | `new URL()` 失败 | 格式应为 `ws://主机:端口` |
| 域名不存在 | 服务端回了 `DomainNotFound` | 域名须与 `RuntimeDomain` 名字完全一致；demo 是 `shininspector` |
| 端口可连通但握手失败 | 探测到端口是开的 | 该端口不是 IObject WS 端点 / 代理剥了 Upgrade 头 |
| 无响应 | 探测请求 2.5s 内无结果 | 防火墙 / 主机不可达 |
| **没有服务在监听** | 探测到连接被拒绝 | 确认目标已启动；本机自测用 `--demo`；若已带 `--demo` 则说明 9002 被占用 |

探测手段：浏览器不允许裸 TCP，用一个 `fetch(url, {mode:'no-cors'})` 代偿 ——
能连上并拿到响应（哪怕是 404）就说明端口开着，连接被拒会立刻抛 TypeError。

结论以**顶栏诊断条**呈现（可收起、带「重试连接」，改动地址后自动作废），
同时全量写进时间线留存。

> 实测记录（`ui/tools/probe-ws.mjs`）：Chrome **接受** `http://` 并自动改写成 `ws://`
> （报错文案自己就写着 "must be either 'http', 'https', 'ws', or 'wss'"）。
> 所以「填了 http://」不是错误 —— 一度把它当格式问题拦下来是**死代码**。
> 但 `https://` 会变成 `wss://`，在明文端口上必然握手失败，这一条需要单独点破。

### 连接的世代令牌（`session.epoch`）

握手动辄要几秒，期间用户完全可能点「断开」或改地址再连一次。没有令牌的话，
在途的那次 `connect()` 会在 resolve 之后照样把状态写成「已连接」、照样把 socket
存进 `this.client` —— 表现为**「点了断开却连上了」**，而被顶替的旧 socket 还泄漏在后面
（它的 `onClose` 反过来会把新连接的状态清掉）。

现在 `connect()` / `close()` 各自自增 `epoch`，在途尝试发现自己的 epoch 过期就把
socket 丢弃并抛 `SupersededError`：不写状态、不记日志；`scheduleRetry` 也不再为重排程续命。

### C++ 侧的静默失败

`WebSocketServer` 的约定是「Start 失败不抛异常」（见其类注释"容错"），端口被占用时
它会静默进入未运行状态 —— 用户只会看到一个无从下手的连接错误。
`App.cpp` 因此在构造后显式查一次 `IsRunning()`，失败就报 ERROR 并说明是端口占用。

---

## 六、改动清单（已执行）

### 删除
- `ui/settings.html`、`ui/settings.js`、`ui/debug.js`
- `ui/vite.config.mjs` 中的 `settings` 构建入口

### C++ 侧（`src/App.cpp`）
- 移除 `InjectJSBeforeLoad(kShinBinaryJS)` 与 `#include "ShinBinaryJS.hpp"`
- 移除 `BridgeTransport` 实例、`SetBinaryReceivedCallback` 接线、`#include "BridgeTransport.hpp"`
- 启动 URL 改为 `http://127.0.0.1:8848/index.html`；窗口放大到 1440×900
- 新增 `--demo` 开关：
  - **不带参数**：不建 WS 服务端、不挂测试对象，只作 WebView2 宿主，前端连远端应用
  - **带 `--demo`**：起 WS 服务端(9002) + 挂一棵测试树（`Device(Sub, Port) / Sensor / Player`），
    并用独立线程每 900ms 经 `iobject::Post` 触发一次 `Bump`，让脉冲动画有东西可动

### C++ 侧（`src/webview/WebviewWrapper` + `App.cpp`）
- `WebviewWrapper` 新增 `AppendBrowserArguments(args)`：Initialize 之前累加额外 Chromium 参数。
  内部用独立数组保存，与 `SetRemoteDebuggingPort`（它每次会整体替换自己那段）**互不覆盖**，
  拼接顺序为「远程调试参数在前、追加参数在后」。
- `App.cpp` 因此传入 `--ignore-gpu-blocklist` —— WebGL 是硬依赖，集显 / 虚拟 GPU 被黑名单
  拦下时会悄悄退到软件路径，表现为前端直接停摆。

### 保留未删
`src/BridgeTransport.hpp`、`src/webview/ShinBinaryJS.hpp` 及 `WebviewWrapper` 内的共享内存能力：
它们已无引用，但属于 vendored 拷贝，删除容易带出编译风险；且以后若要做进程内调试仍可用。

---

## 七、风险与对策

| 风险 | 对策 | 状态 |
| --- | --- | --- |
| WebGL 不可用（软件渲染 / 远程桌面 / 驱动黑名单） | **不降级**：直接停摆，画布显示终止态面板（原因 + 排查方向），顶栏禁用全部入口，连接按钮不可点 | ✅ 已验证 |
| 布局未收敛就取景，相机贴脸 | 等 `alpha < 0.015` 再自动取景 | ✅ 已验证 |
| 节点数膨胀 | 不做全树扫描，节点数 = 用户声明数；`InstancedMesh` 按需扩容 | ✅ 设计上消除 |
| 订阅量 | 每节点 4 个订阅，仅对已声明节点；`state.ui.autoSubscribe` 可关 | ✅ |
| 重连后 addr 失效 | 持久化按路径；`reconnected` 触发全量重解析与重新订阅 | ✅ |
| 新通道出现时列表不更新 | `node-data` 处理器检测「有通道没有对应行」时整块重绘 | ✅ 已修 |
| 引导语在错误面板上闪现 | 显示条件收敛到 `syncStageHint()` 单点裁决，任何回调不再各自 toggle | ✅ 已修 |
| 连不上时报 `WebSocket 连接错误`，零信息量 | `diagnose.js` 失败后主动探测，拆成 6 种情况分别给下一步；顶栏诊断条 + 时间线留存 | ✅ 已修 |
| 握手期间点「断开」仍会连上，且泄漏旧 socket | `session.epoch` 世代令牌：在途尝试被顶替即丢弃 socket 并抛 `SupersededError` | ✅ 已修 |
| WS 端口被占用时服务端静默不启动 | `App.cpp` 构造后显式查 `IsRunning()`，失败报 ERROR 指明端口占用 | ✅ 已修 |

### 关于「WebGL 是硬性依赖」这条决策

曾经实现过 Canvas2D 降级，已按需求移除。理由：本工具的全部价值在于**空间化地看对象图** ——
3D 力导向布局被压平到 2D 后，连线重叠、深度次序完全丢失，用户会据此对对象结构作出错误判断。
一个看起来能用的残次品比直接停摆更危险，因此宁可拦停，并把原因与排查方向写在画布上。

停摆时被一并停用的范围：渲染循环、连接入口（顶栏全部按钮）、引导语。
检查器与时间线仍会渲染，但未连接状态下本来就没有数据可操作。

---

## 八、验证记录

用 `ui/tools/smoke.mjs`（puppeteer + 系统 Chrome，真实时钟）对 dev server 跑端到端冒烟，
连接本机 9002 上的真实 WS 服务，**36 项断言全部通过**：

| 检查项 | 结果 |
| --- | --- |
| 渲染器 / 图例 / no-render | ✅ `renderer=webgl`，图例已渲染，未误加停摆类 |
| WebGL 缺失终止态（无头 + `--disable-gpu --disable-software-rasterizer`） | ✅ `renderer=none`、无 canvas、终止态面板出现、顶栏按钮禁用、引导语与图例退场 |
| **连接失败诊断** | ✅ 无监听端口 → `127.0.0.1:59987 上没有服务在监听`，2 条动作，诊断条渲染、含 `--demo` 自救指引、可收起，失败原因进时间线 |
| **非法 scheme** | ✅ `ftp://` → `地址协议不支持` |
| **https:// 改写** | ✅ 判定为「可连通但握手失败」并点明应改用 `ws://` |
| **断开取消在途连接** | ✅ 同 tick 内先后 emit 连接/断开 → 最终 `status=idle`、`isOpen=false` |
| 断开后可重连 | ✅ `status=open` |
| 连接握手 | ✅ `status=open` |
| 清单解析 | ✅ `nodes=[root,Device,Sub,Sensor]` |
| 边反推 | ✅ 3 条边 |
| 自动订阅 | ✅ 16 订阅 = 4 节点 × 4 |
| 订阅开关 | ✅ 取消 16→15、状态写入 memory、恢复回 16、全部取消 0 / 全部订阅 4 |
| 通道学习 | ✅ 从事件学到 `Counter` |
| 通道行内写入（失败分支） | ✅ 请求送达、被服务端拒绝、输入行保留、按钮恢复、错误 flash |
| 通道行内写入（成功分支） | ✅ 打桩覆盖：成功后自动收起输入行 |
| 行内输入 toggle | ✅ 重复点击可收起 / 重新展开 |
| 清单导出 | ✅ 逐行文本与 specs 数量一致 |
| 清单导入 | ✅ 新条目加入、重复项跳过、非法行报错、节点数回到 4 |
| 前端构建 | ✅ `vite build` 通过 |
| C++ 编译 + 链接 | ✅ `App.cpp` / `WebviewWrapper.cpp` 编译通过，链接产出新 exe；`--demo` 启动日志确认 `IsRunning()` 分支正常 |

> demo 对象的通道是**只读**的（写入返回 `OperationFailed: 对象拒绝写入通道`），
> 这恰好覆盖了失败分支；成功分支用临时打桩 `session.ro().writeData` 验证。

脚本开头会 `localStorage.clear()` —— 否则第二次跑会复用到上一轮残留的观察清单，
同一个脚本跑出不同结论。

---

## 九、后续可做

1. **打包**：现在前端必须由 Vite dev server 托管。若要让 `ShinInspectorApp` 独立运行，
   需要把 `dist/` 用 `SetStartupHTML` 或本地静态资源加载，并处理 ES module 的 `file://` 限制。
2. **代码分割**：单包 661 kB（three.js 占大头），可按需动态 import 渲染层。
3. **清单分组**：多套观察清单（按目标应用切换）而不是「一个端点一套」。
4. **通道值曲线**：记录通道历史并画时序图，比只显示"最近值"更有调试价值。
   前置条件是先给 `memory` 的通道快照加上环形缓冲（现在只存最后一个值）。
5. **方法参数记忆**：目前只按路径记住方法名，参数还是每次手填；
   可以把「方法名 + 最后一次参数」一起存下来，重复调用就变成一次点击。

---

## 十、视觉：TUI / 终端风（已实施）

目标不是"深色主题"，而是**看起来像一台终端**。落地成四条可核对的规则：

| 规则 | 做法 | 约束 |
| --- | --- | --- |
| 只有一个字体族 | `--sans: var(--mono)`，全套等宽（Cascadia Mono → JetBrains Mono → Consolas → 雅黑） | 新增样式别引第二个字体 |
| 只有四个语义色 | 白=正文/正常，橙=强调/主操作/选中，琥珀=数据变化，红=错误 | 见 `app.css` 顶部 `:root` |
| 直角 + 硬边框 | `--r: 0px`，1px 实线，无阴影无模糊（去掉了 `backdrop-filter`） | 不做圆角、不做毛玻璃 |
| 方括号装帧 | `button::before{content:'['}` / `::after{content:']'}`；输入框套 `.ibox` 给出 `>` 提示符 | **JS 里不要自己写 `[ ]`**，否则会变成双层括号 |

额外的终端质感：

- `.crt` 固定层：扫描线 + 暗角，`pointer-events:none`，整体不透明度压到 12%
  （再高就会糊住 11px 小字；终端风味不该以可读性为代价），`prefers-reduced-motion` 时直接隐藏。
- `.sec` 用「标题骑在框线上」的做法做出 `┌─ TITLE ─┐` 的观感，不需要任何 ASCII 边框绘制代码。
- 章节标题 `.sec > h3` 前缀 `─·`，注释类文案 `.note` 前缀 `# `，时间线行前缀 `> `。
- Three.js 侧同步换色：`scene.js` 的 `BG` 必须与 CSS `--bg` 完全相等（差一点画布就像贴上去的补丁）；
  `graph.js` 的色板与 `--accent / --warn` 对齐；节点标签改等宽字体并加一圈黑描边
  （深浅节点重叠时不糊）；地面加一层极暗的 `GridHelper` 作为"地平线"。

### 配色改版：黑 + 橙（2026-09-19，第二次换皮）

第一版是「满屏荧光绿」。用下来结论很明确：**高饱和绿字贴黑底伤眼睛** —— 绿在暗背景上
会有明显的色差闪烁感，整屏都是绿字时眼睛发涩。第二版换成终端里最耐看的组合：

| 槽位 | 旧值 | 新值 | 用途 |
| --- | --- | --- | --- |
| 正文 | 荧光绿 `#4ef08a` | 近白 `#f2f2f2` | 正文、节点名、普通对象 |
| 强调 | 亮绿 `#7dffb0` | 橙 `#ff9000` | 选中、root、主按钮、焦点框 |
| 次级文字 | `#2aa25c` / `#17683a` | `#a6a6a6` / `#7d7d7d` | 次级/注释（整体提亮，11px 要看得清） |
| 变化 | 琥珀 `#ffb524` | 琥珀 `#ffc23d` | 数据变化脉冲、警告 |
| 错误 | `#ff5f5f` | `#ff4d4d` | 错误 |

三条落地原则，改配色时照着来：

1. **强调色占屏比例要极低**。橙只出现在"需要你注意"的地方（选中 / root / 主按钮 / 焦点框），
   正文一律近白。满屏彩色 = 满屏都没有重点，而且费眼。
2. **次级文字提亮，不是提暗**。暗底上 `#6b6b6b` 这类字看久了最累，提到 `#7d7d7d` 以上。
3. **时间线这类长列表避开高饱和橙做正文色**（`DataChannelChanged` 用最柔的琥珀），
   它是一屏一屏滚动的，颜色刺激要降到最低。

配套删除：`--cyan / --cyan-dim / --ok / --purple` 四个变量全部并入 `--accent / --warn / --danger`，
色板从"六色"收敛到"白 + 橙 + 琥珀 + 红"。**`--cyan` 这个名字不再存在**，
新样式里用 `var(--accent)`，别按老名字去找。

### 布局切换按钮已移除

「力导向 / 径向」两个按钮删掉了 —— 默认就是力导向，实际使用中没人会去切，
两个常年只亮一个的按钮纯属噪音。连带删掉 `'layout-request'` 事件与 `state.ui.layout`
（布局模式由 `render/layout.js` 自己持有）。`layout.setMode('radial')` 的实现保留，
需要在控制台里 `__shin.renderer.layout.setMode('radial')` 就能切回来。


**CSS 变量名与语义类名一律沿用改造前的命名**（`--surface` / `.sec` / `.row` / `.ty-*` …），
所以这次换皮**没有改动任何 JS 逻辑**。这条值得保持：换视觉不该牵动数据流。

---

## 十一、窗口尺寸与 DPI 适配（已实施）

**设计尺寸 1280x720，写的是逻辑像素（DIP），不是物理像素。**

- `App.cpp`：`kDesignWidth = 1280` / `kDesignHeight = 720` → `SetSize()`。
- 底层 `webview` 的 `set_size()` 已经把 DIP 换成物理像素（`scale_size(w, h, 96, dpi)`）并补上非客户区边框，
  但**它从不检查显示器工作区** —— 所以"不溢出"这件事必须由我们兜。
- `WebviewWrapper::ApplyDesignSize(designW, designH)`（Initialize 之后、UI 线程）：
  1. `DpiOfWindow()` 取窗口所在显示器的 DPI；
  2. `MulDiv(design, dpi, 96)` 换成物理像素，`SizeWithFrame()` 加上边框；
  3. 大于工作区则**等比收缩**（保持 16:9，不做轴向拉伸）；
  4. 在工作区里居中。
  返回 `WindowMetrics`（含工作区尺寸与 `shrunkToFit`），`App.cpp` 直接打进日志。
- `HostSubclassProc` 处理 `WM_DPICHANGED`：先让底层按新 DPI 重算尺寸，再 `FitWindowIntoWorkArea()`
  兜一次工作区 —— 底层那次 resize 带 `SWP_NOMOVE`，窗口围着左上角长，
  从 100% 屏幕拖到 150% 屏幕会长到屏幕外面去。

### 实测（本机）

```
窗口 1280x720 (逻辑) @ DPI 192 -> 外框 2560x1495 / 客户区 2534x1424 物理像素；
工作区 2560x1504（装不下，已等比收敛）
```

屏幕 2560x1600 @ 200%：1280x720 逻辑 = 2560x1440 客户区，加边框后**宽度超出 16px**，
于是等比收缩 → 前端实际拿到 **1267x712 CSS px**。也就是说：

> 前端不能假设自己一定跑在 1280x720 上，必须在小一号的视口里也放得下。

`smoke.mjs` 因此加了多视口不溢出断言（1280x720 / 1185x664 / 1024x600 / 900x560）。
`app.css` 侧对应两条兜底：`max-width:1120px` 收窄检查器，`max-height:660px` 压低时间线。

### 踩过的坑

`windows.h` 的 `min` / `max` 是**函数式宏**：`std::min({1.0, a, b})` 会被当成"宏传了 3 个参数"直接编译失败
（`C4002 too many arguments for function-like macro invocation 'min'`），
后面还会连带报出一串"'{' 未匹配""WebviewWrapper 不是类或命名空间"的假错。
改用显式比较，或写成 `(std::min)(a, b)`（`min` 后面紧跟 `)` 时宏不展开）。
另外 `work.left` 是 `LONG`，与 `int` 混用会让 `std::min/max` 的模板推导失败 —— 统一成 `int` 再比。
