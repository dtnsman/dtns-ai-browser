# 设计报告 · DTNS 浏览器 Agent HTTP 代理（v2.0）

| 项目 | 内容 |
|------|------|
| 交付物 | `.` |
| 重构对象 | `(历史版本)` 的 http-proxy 模块 |
| 参考实现 | `(线上 v1.0 实现)` |
| 版本 | 2.0.0 |
| 源文件 | 17 个模块，4665 行（含注释） |
| 测试 | 185 个用例（`src/` 行覆盖率 94.14%）+ 真机联调 72 项 / 68 条路由 |

---

## 1. 背景与目标

`browser-plugin` 是一个 MV3 浏览器扩展，通过 WebSocket 隧道把浏览器能力（页面读取、点击、截图、
标签页管理、网络与控制台观测）暴露为 HTTP API，访问域名为
`http://browser2.<clientId>.html.dtns.top`。

> 域名首段用于服务端路由：`browser.*` 仍由 v1.0 的 JSON 代理服务承接，二进制 v2 隧道必须使用
> 独立的首段（默认 `browser2`）。该值通过 `domainPrefix` 选项 / `extension/background.js`
> 顶部的 `DOMAIN_PREFIX` 常量配置，见 §13.1。

`dtns.http-proxy-site` 提供了同类的 `sdk.js`：它把 DTNS 二进制协议编解码与一个 Express 风格的
代理应用打包在一起，用「隧道帧 → Request/Response → 路由」的模型实现 HTTP 代理。

本次工作的目标是：**用 `sdk.js` 的协议与路由模型，重构 `browser-plugin` 的 http-proxy 模块**，
在保持既有 HTTP 接口语义（路径、参数、响应体）不变的前提下，替换传输格式、拆分层次、补齐健壮性，
并产出可测试、可构建、有文档的新版本。

---

## 2. 旧实现分析

重构不是重写业务，而是消除结构性问题。旧 `background.js`（4141 行）的 http-proxy 部分存在以下问题：

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| 1 | 使用 JSON 文本帧而非 DTNS 二进制帧 | `ws.send(JSON.stringify(message))`、`JSON.parse(data)`（L872） | 与 SDK/服务端的二进制协议不兼容；body 需 base64，体积膨胀约 33% |
| 2 | 单文件承载传输、路由、业务、chrome 调用 | 全文件 | 任一层都无法单独测试；改动风险高 |
| 3 | 路由是精确字符串键表 | `routeKey = path.split('?')[0]`；`routes[routeKey]` | 无路径参数、无通配符、无中间件 |
| 4 | 只有 404，没有 405 | 末尾 `else { status: 404 }` | 方法不匹配时语义错误；无 `Allow` 头 |
| 5 | 无鉴权 | 全文无 token 校验 | 任何知道域名的人都能操作浏览器 |
| 6 | 心跳只发不验 | `startHeartbeat` 仅发送 | 服务端或链路半死时无法感知，隧道长期处于"假在线" |
| 7 | 注册重试是 3s 固定定时器 | `setInterval(..., 3000)`，最多 5 次 | 失败后 `pendingRegistrations` 残留；重试节奏固定，无退避 |
| 8 | 每个功能各自 attach debugger | L121、L621-625、L3810、L3872、L4029 共 5 处；L621 甚至需要"失败就先 detach 再 attach" | 网络监控与控制台采集互斥，用户开 DevTools 后状态错乱 |
| 9 | 请求路径无 body 上限 | 无 `maxBodySize` | 单帧可被用于内存放大 |
| 10 | 每次消息前先 ping，并固定 sleep | `sendToActiveTab`：100ms 等待 + ping 探测 + 注入后 500ms | 每个 API 调用多 1 次 RPC 与 600ms 延迟 |
| 11 | 业务失败一律 HTTP 200 + `{error}` | 大量 `status: 200, body: {error}` | 调用方无法用状态码区分成功与失败 |
| 12 | 协议字段不一致 | 注册时发送 `localPort: 10999`、`features: [...]` | 二进制协议中端口是 u8、无 `features` 字段 |

---

## 3. 设计目标与非目标

**目标**

1. 传输改为 DTNS 二进制帧，与 `sdk.js`、隧道服务端一致；协议版本可协商。
2. 分层：协议 / 传输 / 路由 / 浏览器能力，接口清晰，可独立测试。
3. 保持 HTTP 接口向后兼容：路径、查询参数、响应体字段不变（业务层仍用 `{success, ...}`）。
4. 补齐健壮性：心跳超时检测、退避重连、注册超时、帧大小上限、body 上限、鉴权、CORS。
5. 可在 Node 中完整测试（不依赖真实浏览器），并可打包为 MV3 Service Worker 可 `import` 的单文件。
6. 零运行时依赖。

**非目标**

- 不实现 SSE 流式转发（旧版同样未实现，本版返回明确的 501）。
- 不实现 `STREAM_*` 分块传输（协议已定义，`capabilities.stream` 仍为 false）。
- 不改动 `content-script.js`、`popup.js` 的行为契约（仍以 `action` 消息交互）。
- 不引入 UI。

---

## 4. 总体架构

### 4.1 分层

```
                    routes.js  （69 个端点，只做参数 → 能力 → 响应）
                         │
     ┌───────────────────┴────────────────────┐
     │  HttpProxyApp（http-proxy.js, 490 行）  │  生命周期 / 鉴权 / CORS / 响应编码
     │      └── Router（router.js, 513 行）    │  匹配 / 中间件 / 405 / OPTIONS / 自动序列化
     └───────────────────┬────────────────────┘
                         │ HTTP_REQUEST / HTTP_RESPONSE（解码后的消息对象）
     ┌───────────────────┴────────────────────┐
     │  TunnelTransport（transport.js, 426）   │  WebSocket / 注册 / 心跳 / 重连 / 帧编解码
     └───────────────────┬────────────────────┘
                         │ Uint8Array 帧
     ┌───────────────────┴────────────────────┐
     │  Protocol（dtns-protocol.js, 637 行）   │  纯函数编解码，无状态
     └────────────────────────────────────────┘

     浏览器能力层（与传输层完全解耦，仅被 routes.js 调用）
     ChromeAdapter · TabBridge · DebuggerHub · NetworkMonitor
     ConsoleCollector · ScreenshotScheduler · ConfigStore · image-info
```

关键约束：**只有 `chrome-adapter.js` 直接访问 `chrome.*`**。其余能力组件都只依赖适配器暴露的
Promise 接口，因此测试时替换为 `test/support/mock-chrome.js` 即可。

### 4.2 一次请求的时序

```
服务端            TunnelTransport        HttpProxyApp/Router        routes        ChromeAdapter
  │  HTTP_REQUEST frame  │                       │                     │                │
  ├─────────────────────►│ decodeFrame/decodeMessage                   │                │
  │                      ├──────────────────────►│ new Request         │                │
  │                      │                       │ CORS + auth         │                │
  │                      │                       ├────────────────────►│ 读取参数        │
  │                      │                       │                     ├───────────────►│ tabs.sendMessage
  │                      │                       │                     │◄───────────────┤ {title,...}
  │                      │                       │◄────────────────────┤ res.json        │
  │  HTTP_RESPONSE frame │◄──────────────────────┤ encodeHttpResponse  │                │
  │◄─────────────────────┤                       │                     │                │
```

### 4.3 模块清单

| 模块 | 行数 | 职责 |
|------|------|------|
| `protocol/dtns-protocol.js` | 637 | 帧编解码（双向 37 种帧）、版本感知、边界校验 |
| `proxy/transport.js` | 426 | 连接生命周期、注册与重试、心跳与 ack 跟踪、退避重连 |
| `proxy/router.js` | 513 | Request/Response、路径编译与匹配、中间件栈、错误收敛 |
| `proxy/http-proxy.js` | 490 | 组装、CORS、鉴权、请求分发、WebSocket 升级、热重绑 |
| `proxy/websocket.js` | 137 | 透传连接（text/binary、关闭码映射） |
| `agent/routes.js` | 791 | 69 个端点，含参数校验与响应整形 |
| `agent/chrome-adapter.js` | 165 | 唯一 `chrome.*` 访问点，MV2/MV3 回调与 Promise 归一 |
| `agent/tab-bridge.js` | 162 | content-script RPC，注入回退与超时 |
| `agent/debugger-hub.js` | 155 | 每标签页单一 debugger 会话，引用计数复用 |
| `agent/network-monitor.js` | 255 | CDP 网络抓包与统计 |
| `agent/console-collector.js` | 228 | CDP 控制台日志、代码执行与输出捕获 |
| `agent/screenshot-scheduler.js` | 238 | 截图缓存、限速、请求合并 |
| `agent/config-store.js` | 99 | clientId / wsUrl 持久化与校验 |
| `agent/image-info.js` | 123 | 从容器头读宽高（PNG/JPEG/WebP/GIF） |
| `agent/browser-agent.js` | 120 | 装配体：`createBrowserAgent` |
| `util/primitives.js` | 58 | `ProxyError`、`Emitter` |
| `index.js` | 68 | 公共出口 |

---

## 5. 协议层设计

### 5.1 帧格式

与 `sdk.js` 完全一致（13 字节头 + 负载，大端）：

```
offset  size  field
0       4     magic "DTNS"
4       1     version（1=状态码 u8，2=状态码 u16）
5       2     type code
7       2     flags
9       4     payload length
13      N     payload
```

字符串为 `u16 长度 + UTF-8`，缓冲区为 `u32 长度 + 原始字节`，头部为 `u16 数量 + (key,value)*`，
多值头部以 `\n` 连接。

### 5.2 编解码对称性

`sdk.js` 只实现了「客户端编码 + 服务端解码」的方向。本次补齐了反方向
（`encodeWelcome` / `encodeRegistered` / `encodeHeartbeatAck` / `encodeHttpRequest` /
`encodeServerWebSocketData` / `encodeServerWebSocketClose`）与客户端侧的
`decodeRegisterTunnel` / `decodeHeartbeat` / `decodeCapabilities` / `decodeHttpResponse`。

收益有两个：

1. 测试可以搭建**真实的**进程内隧道服务端（`test/support/mock-tunnel-server.js`，实现了 RFC 6455
   握手、掩码解析、分片重组），端到端验证走真实 TCP 字节流，而不是打桩；
2. 若要写服务端，可以直接复用同一份编解码，不会出现第二套协议实现。

### 5.3 版本协商与 v1 局限

`TunnelTransport.serverVersion` 初始为 2，收到 `welcome` 帧后采用服务端声明的版本。
`HTTP_RESPONSE` 的状态码字段宽度随版本变化：v2 为 u16，v1 为 u8。

v1 的 u8 无法表达 3 位状态码——`404` 会被截断为 `404 & 0xff = 148`（`test/protocol.test.js`
中有一条用例显式固化了这个行为）。这就是保留 v2 协商、并让 v1 仅作兼容路径的原因。

### 5.4 健壮性增量

| 校验 | 位置 | 说明 |
|------|------|------|
| 帧长度上限 | `decodeFrame({maxFrameSize})` | 默认 32 MiB，先于分配判定，防长度前缀放大 |
| 截断检测 | `decodeFrame` | 声明长度 > 实到字节数即报错 |
| 魔数校验 | `decodeFrame` | 非 "DTNS" 直接拒绝 |
| 读取下溢 | `Reader._need` | u8/u16/u32/str/buf 越界抛错，而非静默读出 undefined |
| 字符串上限 | `encodeString` | 超过 u16 可表达范围（65535 字节）立即报错 |
| 可选尾字段 | `decodeHttpRequest` / `decodeHttpResponse` | 兼容老服务端缺少 `sseRequestId` / `wsRequestId` |

---

## 6. 传输层设计

### 6.1 状态机

```
        connect()
  IDLE ─────────► CONNECTING ──open──► OPEN ──registered──► REGISTERED
    ▲                 │                  │                     │
    │                 │ error            │ close/heartbeat超时  │ close
    │                 ▼                  ▼                     ▼
    └────────── FAILED(terminal) ◄── RECONNECTING ◄────────────┘
```

- `FAILED` 仅用于「还没成功注册过一次」的终态（注册被拒、注册超时、无法创建 socket）。
- 已注册过的连接断开后走 `RECONNECTING`，达到 `maxAttempts` 才进入 `FAILED`。

### 6.2 注册与超时重试

打开连接后依次发送 `CAPABILITIES` 与 `REGISTER_TUNNEL`，随后启动一次性定时器：
`registerTimeout`（默认 4s）内未收到 `REGISTERED` 就重发，最多 `registerRetries`（默认 3）次，
仍无响应则 `REGISTER_TIMEOUT` 终态失败。

与旧版对比：旧版是 3s 周期定时器最多 5 次，且在注册成功分支只 `clearInterval` 而不删除
`pendingRegistrations` 条目；本版定时器在注册成功、失败、关闭三条路径上都会清理（`_clearRegisterTimer`）。

### 6.3 心跳与僵尸连接检测

- 每 `heartbeatInterval`（默认 25s）发送 `HEARTBEAT`，携带 `tunnelCount / registeredCount /
  sseConnections / totalRequests / totalErrors`；后两项由 `HttpProxyApp` 通过 `extraStats` 注入。
- 收到 `HEARTBEAT_ACK` 记录 `lastAckAt`。
- 独立看门狗每 `heartbeatInterval` 检查一次：若 `now - lastAckAt > heartbeatTimeout`
  （默认 60s），判定为僵尸连接，主动关闭 socket 并进入重连。

这一条是旧实现完全没有的能力：WebSocket 的 `readyState` 在链路半死时仍是 `OPEN`。

### 6.4 重连退避

`delay = min(baseDelay * factor^(n-1), maxDelay)`，默认 1500 × 1.7ⁿ⁻¹，上限 20s，
并叠加 ±20% 抖动避免服务端重启时的惊群。`attempts` 只在**注册成功**时归零——若在
`onopen` 就归零，服务器接受 socket 但拒绝注册时会无限快速重试。

### 6.5 事件契约

| 事件 | 载荷 | 说明 |
|------|------|------|
| `open` | — | socket 建立 |
| `welcome` | `{clientId, protocolVersion, message}` | 版本协商 |
| `registered` | `{domain, success, message}` | 注册成功 |
| `register_failed` | `{domain, error}` | 注册被拒 |
| `register_retry` | `{attempt}` | 注册超时重发 |
| `message` | 解码后的业务消息 | `http_request` / `websocket_*` |
| `heartbeat_ack` | — | 心跳确认 |
| `reconnecting` | `{attempt, delay}` | 即将重连 |
| `disconnected` | `{code, reason, wasRegistered, willRetry}` | 连接断开 |
| `error` | `ProxyError` | 非致命错误 |
| `failed` | `ProxyError` | 终态失败 |

---

## 7. 路由层设计

从 `sdk.js` 的 `AgentApp` 中抽出 `Router`，保持语义一致，并做三处修正：

1. **Response 不再反向依赖 App 单例**。`Response` 构造时接收
   `{send, finish, upgrade}` 三个钩子，可脱离 socket 单独测试（`test/router.test.js` 26 个用例）。
2. **HEAD 的 `Content-Length` 修正**。`sdk.js` 先清空 body 再计算长度，导致 HEAD 返回
   `content-length: 0`；本版先记录 `payloadLength`，HEAD 只清空负载，头部仍描述 GET 表示。
3. **完成回调**。`onComplete(status)` 让上层可以准确统计「路由已结束」，而不必轮询 `res.finished`。

其余行为（`:param`、`*` 通配、中间件前缀、`next(err)`、自动序列化、204/405/OPTIONS）与 SDK 一致，
逐条固化在 `test/router.test.js` 中。

---

## 8. 浏览器能力层设计

### 8.1 ChromeAdapter

- 单一 `chrome.*` 入口；MV2 回调式与 MV3 Promise 式 API 用同一套 `invoke()` 归一（优先 Promise，
  否则等待回调，并用 `settled` 防重复结算）。
- 判定规则要简单可证：**返回 Promise 用 Promise；返回值非 `undefined` 视为同步 getter；其余一律等回调**。
  早期版本用 `fn.length <= args.length` 猜「同步 API」，而真实 Chrome 的 `chrome.tabs.query.length === 1`，
  导致回调前就 resolve 成 `undefined`——这类错误只有真机联调才暴露（见 `docs/LIVE-TEST.md` §3）。
- 缺失的 API 区域（如没有 `debugger` 权限）映射为 `CHROME_AREA_MISSING / 501`，而不是
  未捕获的 `TypeError`。
- 新增 `updateWindow`，替换旧版直接调用 `chrome.windows.update` 的写法。

### 8.2 TabBridge

旧版每次消息前先用 `ping` 探测 content script，并固定 sleep 100ms；注入后再 sleep 500ms。
本版：**先直接发送**，只有出现
`Could not establish connection` 类错误时才注入、短暂等待、重试一次。
正常路径省掉一次 RPC 与 600ms 延迟，异常路径行为等价。

其余契约保持：受限页面（`chrome://`、`edge://`、`about:`、应用商店等）返回
`Cannot access this page type`；所有失败都以 `{success:false, error, code}` 返回，不抛异常。

### 8.3 DebuggerHub

Chrome 每个标签页只允许一个 debugger 客户端。旧版有 5 处独立 `chrome.debugger.attach`，
L621 甚至写了「attach 失败就 detach 再 attach」的补偿逻辑，说明冲突真实存在。

本版把 attach 收敛到 `DebuggerHub`：

- `acquire(tabId)` 引用计数 +1，复用同一会话；`release()` 归零时才 `detach`；
- 域（`Network` / `Runtime`）按会话只 `enable` 一次；
- 用户关闭 DevTools 触发 `onDetach` 时，向所有订阅者派发 `__detached__` 并清理会话；
- `dispose()` 统一释放。

### 8.4 NetworkMonitor / ConsoleCollector

两者都基于 `DebuggerHub`，各自维护状态对象与 `unsubscribe`，在 `stop()`、定时到期、debugger 掉线
三条路径上都会释放引用——旧版的定时器到期后不保证 detach。

`NetworkMonitor` 的统计口径：按方法计数、按状态区间（200s/300s/400s/500s/others）分桶、
`errors` 计入 `status >= 400` 与 `loadingFailed`，`avgDuration` 只统计有耗时的记录。
记录上限 1000 条，超出按 FIFO 淘汰。

`ConsoleCollector` 的 `logs({clear:true})` 会真正清空所读缓冲区（旧版文档承诺、实现未做）；
`exec()` 只返回这次执行期间产生的日志，避免与后台采集混淆。

### 8.5 ScreenshotScheduler 与 image-info

- 缓存键 = `tabId|format|quality|maxWidth|maxHeight`，TTL 默认 3s，**缓存有上限**（默认 24 条，LRU）。
- 相同参数的并发请求**合并**为一次抓取（旧版有排队但无合并）。
- 抓取失败不写缓存。
- 最小抓取间隔 200ms（`captureVisibleTab` 有频率限制）。
- 宽高不再依赖 canvas：`image-info.js` 直接解析 PNG IHDR、JPEG SOF、WebP（VP8/VP8L/VP8X）、GIF 头，
  因此在 Service Worker 与 Node 测试中都可得；缩放仍用 `OffscreenCanvas`，且**失败时回退原图**。

### 8.6 ConfigStore 与热重绑

`clientId`、`wsServerUrl`、`autoReconnect` 统一存于 `chrome.storage.local` 的 `dtnsProxyConfig` 键，
校验规则：clientId 为 8–32 位小写字母数字，URL 必须以 `ws://` 或 `wss://` 开头。

修改 clientId 需要换一个隧道域名，因此 `HttpProxyApp` 提供 `rebind()`：

1. 在下一个宏任务再执行切换（先让当前响应的帧写到旧 socket）；
2. 关闭旧 transport，用新的 clientId/域名新建 transport 并重连；
3. 注册成功会再次触发 `listening` 事件。

对应端点先返回响应，再异步执行重绑，避免"回复自己的请求时把承载它的连接关掉"。

---

## 9. 兼容性矩阵

| 能力 | 旧版 | 本版 | 兼容性 |
|------|------|------|--------|
| 域名格式 | `browser.<clientId>.html.dtns.top` | `browser2.<clientId>.html.dtns.top` | ⚠️ 首段不同，见 §10.6 |
| 69 个 HTTP 路径 | 全部存在 | 全部存在 | ✅ 路径一致 |
| 查询参数 | GET 参数覆盖 POST 参数 | 同（`mergeParams`） | ✅ |
| 业务响应 | `{success:true, ...}` / `{success:false, error}` | 同 | ✅ |
| 参数缺失 | 多为 `200 + {error}` | `400 + {error}` | ⚠️ 见下 |
| 未知路径 | `404 + {error, availableRoutes}` | `404 + {ok:false, error:'not_found'}` | ⚠️ 见下 |
| 方法不匹配 | 落到 404 | `405 + Allow` | ⚠️ 改进 |
| `localPort` | `10999` | `80` | ⚠️ 见 §10.1 |
| `features` 字段 | 发送 | 不发送 | ⚠️ 见 §10.2 |
| CORS | 每个响应手工合并 5 个头 | 统一注入（可关闭） | ✅ |
| SSE | 未处理 | `501 sse_not_supported` | ⚠️ 明确化 |
| 鉴权 | 无 | 可选 Bearer / `?token=` | ✅ 默认关闭 |

三处 ⚠️ 的状态码变化是**有意**的：旧版「参数缺失返回 200」会让调用方无法区分成功与失败。
若需严格兼容，可在 `registerBrowserRoutes` 外层加一层中间件把 400 改写为 200——文档
（`docs/API.md`）已把这一差异单列说明。

---

## 10. 协议约束与设计取舍

### 10.1 `localPort` 只能是 0–255

`REGISTER_TUNNEL` 的端口字段是 **u8**（`encodeRegisterTunnel` 中 `u8(port & 0xff)`）。
旧版 JSON 里写着 `10999`，二进制化后会静默截断成 `247`。浏览器隧道按域名路由、没有本地监听端口，
因此本版显式声明 `localPort: 80`，并在 `DEFAULTS` 注释与测试用例中固化这一事实，而不是让截断值
悄悄出现在服务端面板上。

### 10.2 `features` 字段无对应槽位

旧版注册体里有 `features: ['smart_reply', ...]`，二进制 schema 没有该字段。能力声明改由
`CAPABILITIES` 帧承担（`stream` / `multiValueHeaders` 两个标志位），业务能力清单则通过
`GET /api/info` 暴露。服务端不会因此丢失信息。

### 10.3 v1 状态码截断

见 §5.3。默认 v2，只有服务端在 welcome 中声明 v1 时才会触发。

### 10.4 未实现流式

`capabilities.stream` 恒为 `false`；`HTTP_RESPONSE` 一次性携带完整 body，SSE 明确返回 501。
流式（`STREAM_*` 帧）留作后续，因为浏览器侧 API 目前没有长连接返回场景。

### 10.5 请求/响应不是 1:1 长连接

每次 `HTTP_REQUEST` 独立，无跨请求状态。WebSocket 升级是例外：`acceptWebSocket()` 发 101 后，
连接对象进入 `wsConnections` 映射，直到关闭。

### 10.6 隧道域名首段必须与协议版本匹配

服务端按域名**首段**分流：`browser.*` 指向 v1.0 的 JSON 代理服务，不认二进制帧；二进制 v2 隧道
注册到 `browser.*` 会注册失败或收到无法解析的响应。因此本版默认使用 `browser2.*`：

```js
const DEFAULT_DOMAIN_PREFIX = 'browser2';
browserDomain(clientId, prefix?)   // → <prefix>.<clientId>.html.dtns.top
```

- 库调用方：`createBrowserAgent({ domainPrefix: 'browser3' })`，或直接传 `domain` 覆盖整串；
- 扩展：修改 `extension/background.js` 顶部的 `DOMAIN_PREFIX` 常量后重新加载；
- `/api/config` 返回的 `status.browserDomain` 与 `/health` 的 `registeredDomains` 都取自
  `app.domain`，只有一处事实来源，避免"面板显示 A、实际注册 B"。

**升级提醒**：域名变了，旧书签/脚本里的 `browser.<id>...` 需要改成 `browser2.<id>...`；
clientId 本身不变（`ConfigStore` 会迁移旧存储键），所以只有首段需要替换。

---

## 11. 安全设计

| 面向 | 措施 |
|------|------|
| 鉴权 | 可选 token，支持 `Authorization: Bearer` 与 `?token=`（浏览器 WebSocket 无法自定义头）；未授权返回 401 + `WWW-Authenticate` |
| 请求体 | `maxBodySize` 默认 1 MiB，超限 413 |
| 帧大小 | `maxFrameSize` 默认 32 MiB |
| 错误信息 | 默认 5xx 只返回 `internal_error`，不泄露堆栈；`exposeErrors:true` 才会带上 `message` |
| 页面限制 | 拒绝 `chrome://`、`edge://`、`about:`、扩展页、应用商店等 |
| CORS | 默认 `*`（与旧版一致），可用 `cors:false` 关闭；额外暴露 `X-Tunnel-Version` |
| 凭据存储 | clientId 存 `chrome.storage.local`；不存 token（token 由宿主注入） |

需要强调：`/api/script/evaluate` 与 `/api/console/exec` 能在页面上下文执行任意 JS，
**生产环境务必设置 token**，否则等于把浏览器交给任何知道域名的人。

---

## 12. 性能考量

| 项 | 旧版 | 本版 |
|----|------|------|
| body 编码 | base64（+33%） | 原始字节 |
| 每请求 RPC 次数 | ping + 实际消息 = 2 | 1（失败才重试） |
| 固定延迟 | ~600ms | 0 |
| 帧解析 | `JSON.parse` + `atob`/`atou` | 单次遍历 + DataView |
| 截图 | 无缓存或缓存无上限 | 3s TTL + 24 条 LRU + 并发合并 + 200ms 限速 |
| 心跳 | 每 30s 一次 | 每 25s 一次 + ack 跟踪，开销可控 |

`sdk.js` 的随机 ID 用 `crypto.getRandomValues`；本版保留该路径并对无 crypto 环境做了退化。

---

## 13. 构建与交付

`build.js` 是一个约 130 行的打包器：扫描 `src/**/*.js`，把静态 `require('./x')` 重写为内部
`__require('x')` 注册表调用，最后按 `src/index.js` 的导出列表生成 ESM 导出。

- 打包时会跳过注释与字符串字面量中的 `require(`（有专门用例覆盖），因此文档示例不会被误改写；
- 输出 `dist/dtns-browser-proxy.mjs`：17 个模块，30 个导出，约 167 KiB（未压缩，含注释）；
- 产物由 `test/dist.test.js` 验证：既能 `import` 出完整 API，也能真的连上模拟隧道服务端跑通
  `/health` 与自定义路由。

### 13.1 可加载扩展（`extension/`）

库本身不能直接装进 Chrome，因此额外产出一个**零改动可加载**的扩展目录：

```
extension/
├── manifest.json         MV3，background.type = module
├── background.js         隧道入口（约 130 行）+ popup/内容脚本消息桥
├── vendor/dtns-browser-proxy.js   build 时从 dist 同步（含 type:module 标记）
├── content-script.js     原插件资产，原样复用
├── popup.html / popup.js 原插件资产，原样复用
└── icon*.png
```

设计要点：

1. **只替换后台**。页面内交互（`content-script.js`）与配置面板（`popup.*`）一行未改，
   避免升级时丢失既有体验；本版 69 个端点用到的 content-script action 与原实现完全对齐，
   由 `test/extension.test.js` 逐个比对。
2. **补全消息契约**。popup 依赖 7 个 worker 消息
   （`getConnectionStatus`、`getConfig`、`setClientId`、`generateNewClientId`、
   `setServerUrl`、`resetConfig`、`reconnect`）；内容脚本的 `screenshot` 还依赖
   `capture_tab`（要求返回 data URL）。这些都在 `background.js` 中实现，
   并复用截图调度器获得缓存与限速。
3. **配置键迁移**。旧版把 `clientId`、`wsServerUrl`、`autoReconnect` 存成三个独立键；
   `ConfigStore` 首次加载时若发现没有新键 `dtnsProxyConfig`，会读取旧键并写入新结构，
   避免升级后 clientId 被重新生成、域名变化导致已保存的 URL 全部失效。
4. **构建一致性**。`npm run build` 同时写 `dist/*.mjs` 与 `extension/vendor/*.js`，
   测试断言两者字节相同，杜绝"仓库里的扩展是旧包"。

---

## 14. 已知限制与后续工作

1. **SSE / 流式**：未实现，返回 501。需要服务端配合 `SSE_*` 或 `STREAM_*` 帧。
2. **v1 状态码截断**：协议固有限制，依赖服务端保持 v2。
3. **截图缩放**依赖 `OffscreenCanvas`；不可用时返回原尺寸（宽高仍正确）。
4. **`/api/config/clientId` 的响应先于重绑完成**：调用方若立即访问新域名可能短暂 404，
   应以 `listening` 事件或 `expectedDomain` 为准。
5. **网络/控制台采集**依赖 `debugger` 权限，会与用户 DevTools 互斥（Chrome 限制）。
6. **测试未覆盖**：真实 Chrome 环境下的 `chrome.*` 行为差异、真实隧道服务端的限流与域名白名单策略。
   后者建议以 `test-sdk-proxy-deployed.js` 的方式做部署后联调。
7. **类型定义**：未提供 `.d.ts`；API 契约以 `docs/API.md` 为准。
