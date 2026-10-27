# 测试报告 · DTNS 浏览器 Agent HTTP 代理（v2.0）

| 项 | 值 |
|----|----|
| 被测版本 | 2.0.0 |
| 测试框架 | Node.js 内置 `node:test` + `node:assert`（零依赖） |
| 用例总数 | **185** |
| 通过 / 失败 | **185 / 0** |
| 跳过 | 0 |
| 总耗时 | 约 1.5 s（`duration_ms: 1500`） |
| `src/` 行覆盖率 | **94.14%**（分支 71.54%，函数 87.89%） |
| 真机联调 | **72 项 / 68 条路由**（见 [LIVE-TEST.md](LIVE-TEST.md)） |
| 执行命令 | `node --test --test-timeout=15000 --test-reporter=spec "test/*.test.js"` |

---

## 1. 测试环境

| 项 | 值 |
|----|----|
| 操作系统 | Windows 10.0.26300（x64） |
| 运行时 | Node.js v24.21.0 |
| WebSocket | Node 内置 `globalThis.WebSocket`（客户端）；测试自建 RFC 6455 服务端 |
| 外部依赖 | 无（不访问网络、不依赖真实浏览器、不需要隧道服务端） |
| 硬件 | 12 vCPU / 32 GB |

> 说明：本次会话初期 `pwsh` 进程启动失败（`0xC0000142 STATUS_DLL_INIT_FAILED`），
> 属执行环境问题，与代码无关；沙箱策略调整为完全访问后恢复正常，全部测试均在该环境中执行。

---

## 2. 测试策略

采用分层策略，每层用最合适的「真实度」验证：

| 层次 | 手段 | 真实度 |
|------|------|--------|
| 协议编解码 | 纯函数单测 + 手工构造字节 | 字节级真实 |
| 路由 | 直接调用 `Router.handle`，注入钩子捕获响应 | 不经过 socket |
| 传输 | **真实 TCP** + 自建 WebSocket 服务端 | 真实握手/掩码/帧序 |
| 端到端代理 | 真实 socket + 服务端主动下发 `HTTP_REQUEST` | 全链路 |
| 浏览器能力 | 注入 `mock-chrome`（内存版 `chrome.*`） | 无浏览器 |
| 构建产物 | `import()` 打包后的 ESM，并连模拟隧道跑通 | 真实产物 |
| 扩展封装 | 静态校验 manifest、资源存在性、消息与 action 契约 | 可加载产物 |

关键设计：**测试不使用客户端桩**。`test/support/mock-tunnel-server.js` 实现了完整的
HTTP Upgrade 握手、`Sec-WebSocket-Accept` 计算、客户端掩码解除、分片重组与
Ping/Pong/Close 处理，因此传输层缺陷（帧边界、并发、半包）会真实暴露。

### 2.1 为什么不用真实隧道服务端

- 测试需要确定性（注册时限、断线重连、僵尸心跳），真实服务端不可控；
- 需要模拟「服务端拒绝注册」「服务端不响应心跳」「debugger 被用户关闭」等异常；
- 需在离线/CI 环境可重复执行。

真实环境联调建议沿用 `dtns.http-proxy-site/test-sdk-proxy-deployed.js` 的方式单独执行。

---

## 3. 用例分布

| 文件 | 用例 | 覆盖内容 |
|------|------|----------|
| `test/protocol.test.js` | 19 | 头部布局、37 种帧类型、双向编解码、v1/v2 状态码、魔数/截断/超限/字符串上限 |
| `test/router.test.js` | 26 | 路径参数/通配/尾斜杠、中间件顺序与短路、404/405/OPTIONS、鉴权、JSON/表单/文本 body、413、HEAD、204、自动序列化、重复响应、错误脱敏 |
| `test/transport.test.js` | 16 | 连接与注册、能力帧顺序、版本协商、心跳与 ack、注册超时重试、注册被拒终态、断线重连退避、僵尸连接检测、坏帧容错、帧上限、幂等 connect/close、状态字段、构造校验 |
| `test/proxy-e2e.test.js` | 18 | 真实 socket 上的 JSON 路由、参数、POST body、64KB body、404/405、CORS（含 OPTIONS）、鉴权三态、request 事件、12 路并发、错误脱敏、HEAD、SSE 501、WebSocket 升级/回显/关闭、状态计数、close、域名校验 |
| `test/agent.test.js` | 18 | 69 条路由注册、域名首段默认值/可配置、系统端点、页面端点、参数校验、交互端点、content script 注入回退、受限页面、CDP evaluate、截图缓存/强制刷新/统计、标签页增删改查、窗口、网络抓包全流程、控制台采集与执行、配置读取与校验、clientId 热重绑、强制重连 |
| `test/routes-extra.test.js` | 17 | 其余页面结构端点、元素端点、指针/键盘、剪贴板、导航与刷新（含 chrome.tabs 失败回退）、openOrSwitch、按 id/url/current 切换与关闭、窗口、截图预热、网络状态、config reset/generate、404/405/CORS、页面信息降级 |
| `test/units.test.js` | 41 | 图片头解析（PNG/JPEG/WebP）、base64 工具、ConfigStore 持久化/校验/旧键迁移、截图缓存/合并/限速/LRU、网络统计口径、控制台格式化、DebuggerHub 引用计数与掉线、TabBridge 注入/超时/无活动标签页回退、路由工具函数、Emitter、ProxyError、WebSocket 关闭码映射 |
| `test/edge.test.js` | 21 | WebSocket 文本/二进制/关闭幂等/服务端 close-end-error、控制台异常捕获与缓冲区上限、exec 失败、网络记录上限与过滤、debugger 掉线、注入式缩放器与失败回退、无标签页、**ChromeAdapter 回调式 API / Promise / lastError**、协议扩展帧、打包器 require 改写 |
| `test/dist.test.js` | 2 | 打包产物可 `import`、导出完整、能连模拟隧道跑通 `/health` 与自定义路由 |
| `test/extension.test.js` | 7 | manifest 合法性、被引用文件存在性、vendor 与 dist 一致且可加载、content-script action 覆盖全部路由、popup 消息全部有处理、`capture_tab` 桥、安装文档 |
| **合计** | **185** | |

---

## 4. 执行结果

```
ℹ tests 185
ℹ pass 185
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1526
```

完整输出见 [`artifacts/test-run.txt`](../artifacts/test-run.txt)，机器可读摘要见
[`artifacts/test-summary.json`](../artifacts/test-summary.json)。

复现：

```bash
npm test                 # 185 个用例
npm run test:report      # 生成上面两个 artifacts 文件
```

---

## 5. 覆盖率

采集命令：

```bash
node --test --experimental-test-coverage --test-coverage-include="src/**" "test/*.test.js"
```

| 文件 | 行 % | 分支 % | 函数 % | 未覆盖行 |
|------|------|--------|--------|----------|
| `agent/browser-agent.js` | 95.68 | 66.67 | 72.73 | 54-55 139-143 |
| `agent/chrome-adapter.js` | 96.65 | 70.37 | 96.77 | 42-44 55-58 |
| `agent/config-store.js` | 98.58 | 89.13 | 100.00 | 35-36 |
| `agent/console-collector.js` | 90.60 | 71.64 | 77.78 | 54-55 80-85 105-107 130-131 189-191 244-252 |
| `agent/debugger-hub.js` | 97.66 | 76.60 | 90.91 | 39-42 |
| `agent/image-info.js` | 82.48 | 71.93 | 87.50 | 51-56 69-83 102 123-124 |
| `agent/network-monitor.js` | 95.59 | 73.03 | 87.50 | 27-28 32-33 56-61 81-83 |
| `agent/routes.js` | 97.23 | 61.56 | 89.32 | 30 57-60 234-239 621-622 659-660 693 697 805-812 |
| `agent/screenshot-scheduler.js` | 84.56 | 84.75 | 93.75 | 30-68 212-214 |
| `agent/tab-bridge.js` | 90.63 | 73.53 | 100.00 | 69-70 106-111 164-170 177-178 180 |
| `protocol/dtns-protocol.js` | 98.87 | 76.22 | 100.00 | 99-100 173-177 503 |
| `proxy/http-proxy.js` | 89.11 | 68.18 | 70.77 | 144-145 155-156 181 192-193 234-237 300 306-307 313-314 318-321 338-341 343-344 346-347 349 354-356 399-402 433-435 437-440 442-445 480-481 483-484 493 500-502 540-545 |
| `proxy/router.js` | 92.53 | 76.38 | 80.00 | 34-35 169-175 188-193 208-210 232 277-280 301-303 307-310 328-329 465-466 489 532 534-538 551-552 |
| `proxy/transport.js` | 94.07 | 73.08 | 100.00 | 134-138 145-149 205-209 265-270 287-289 316-317 337 343-345 |
| `proxy/websocket.js` | 98.11 | 56.36 | 92.31 | 150-152 |
| `util/primitives.js` | 100.00 | 84.62 | 100.00 | — |
| **总计** | **94.14** | **71.54** | **87.89** | |

未覆盖部分主要是**只有真实浏览器才会进入的路径**：

- `browser-agent.js` 44-45、`http-proxy.js` 540-545：`chrome` 全局探测 / 随机 ID 的
  `crypto` 缺失分支；
- `screenshot-scheduler.js` 30-68：`OffscreenCanvas` 真实缩放实现（Node 无此 API，
  已用注入式 `resizer` 覆盖其调用约定）；
- `image-info.js` 69-83：WebP/JPEG 的少数变体与越界保护；
- `http-proxy.js` 中注入式 transport、外部 `createWebSocket` 等宿主定制分支。

原始数据：[`artifacts/coverage-src.txt`](../artifacts/coverage-src.txt)。

---

## 6. 开发过程中发现并修复的缺陷

下列问题均由测试或联调**实际暴露**，不是假设：

| # | 现象 | 根因 | 修复 |
|---|------|------|------|
| 1 | 传输层拿不到 `clientId` / `domain`，注册断言失败 | `decodeMessage` 只解码 `welcome`/`registered`/`http_request` 等，`register_tunnel`、`heartbeat`、`capabilities` 落入 default 分支只返回原始 payload | 为这 4 类帧补齐解码分支（`test/transport.test.js` 暴露） |
| 2 | 用户关闭 DevTools 后，网络监控仍显示 active | `NetworkMonitor._onEvent` 先做 `params.requestId` 查表并提前 `return`，`__detached__` 分支永远到不了 | 把 `__detached__` 判定提到最前，并释放 debugger 引用（`test/edge.test.js` 暴露） |
| 3 | JPEG/PNG 传入 `Uint8Array` 时宽高解析返回 `null` | `sniffImage` 对 `Uint8Array` 输入仍调用 `decodeBase64Head(input, …)` | 统一按输入类型取切片，只在需要时解码 base64（`test/units.test.js` 暴露） |
| 4 | `HEAD` 响应的 `Content-Length` 为 0 | 沿用 `sdk.js`：先把 body 清空再按空 body 计算长度 | 先记录 `payloadLength` 再清空负载（`test/router.test.js` 固化） |
| 5 | 修改 clientId 的请求自身超时、收不到响应 | 路由先 `await rebind()`（内部关闭旧 socket）再 `res.json()`，响应帧落在已关闭连接上 | 改为**先响应、后重绑**，重绑在下一个宏任务执行（`test/agent.test.js` 暴露） |
| 6 | 「服务端接受 socket 但拒绝注册」时重试计数被清零，退避失效 | `attempts` 在 `onopen` 归零 | 改为只在**注册成功**时归零（`test/transport.test.js` 断言） |
| 7 | 注册帧里的 `localPort` 变成 247 | 协议端口字段是 u8，旧版 JSON 的 `10999` 被静默截断 | 显式声明 `80` 并在设计文档 §10.1 说明约束 |
| 8 | 并发 12 个请求时测试进程报 `MaxListenersExceededWarning` | 每个等待响应的 Promise 都向 EventEmitter 注册监听 | 测试服务端 `setMaxListeners(0)`（仅测试基建） |

---

## 7. 关键行为验证清单

| 行为 | 用例 | 结果 |
|------|------|------|
| 二进制帧与 SDK 一致（magic/version/type/flags/length） | protocol | ✅ |
| v2 用 u16 状态码，v1 用 u8（含 404→148 的局限） | protocol | ✅ |
| 超限帧在分配前被拒绝 | protocol / transport | ✅ |
| 能力帧先于注册帧发送 | transport | ✅ |
| 注册超时按 `registerTimeout × registerRetries` 重试后终态失败 | transport | ✅ |
| 心跳 ack 超时判定僵尸并重连 | transport | ✅ |
| 断线后退避重连且计数在注册成功后归零 | transport | ✅ |
| 404 / 405 + `Allow` / OPTIONS 204 | router / e2e | ✅ |
| 鉴权（Bearer、`?token=`、拒绝） | router / e2e / agent | ✅ |
| JSON / 表单 / 文本 body 解析与 413 | router / e2e | ✅ |
| 12 路并发请求互不串包 | e2e | ✅ |
| WebSocket 101 升级、双向数据、关闭码映射 | e2e / units | ✅ |
| 截图缓存命中、强制刷新、LRU、并发合并、失败不缓存 | units / agent | ✅ |
| 网络抓包统计口径（分桶、错误数、均值） | units / agent | ✅ |
| 控制台异常捕获、缓冲区上限、exec 输出捕获 | units / agent | ✅ |
| 热重绑后新域名完成注册 | agent / routes-extra | ✅ |
| 打包产物可加载并工作 | dist | ✅ |
| 扩展目录可直接「加载已解压的扩展程序」 | extension | ✅ |
| 真实浏览器实例上的全链路联调 | live（72 项，见 §10） | ✅ |

---

## 8. 遗留风险与未测试项

1. **真实 Chrome 环境**：`chrome.*` 在真实 MV3 Service Worker 中的行为差异（Service Worker 休眠、
   `chrome.debugger` 权限提示、`captureVisibleTab` 频率限制）。已通过真机联调覆盖主链路与全部写操作
   （见 §10）；仅 `config/clientId/generate` 未在真机执行。
2. **真实隧道服务端**：域名白名单、限流、`localPort` 语义以服务端实现为准；本次仅验证客户端协议正确性。
3. **`OffscreenCanvas` 缩放**：Node 无该 API，仅验证了调用约定与失败回退。
4. **v1 协议**：只覆盖编解码与协商，未做端到端；状态码截断是协议固有限制。
5. **`/api/config/clientId` 的时序**：响应先于重绑，调用方立即访问新域名可能短暂失败（已在 API 文档标注）。

---

## 9. 结论

- 185 个用例全部通过，覆盖协议、路由、传输、端到端、浏览器能力、构建产物与扩展封装七个层次；
- `src/` 行覆盖率 94.14%，未覆盖部分集中于必须真实浏览器才可执行的路径；
- 开发过程中通过测试发现并修复了 8 个缺陷，其中 5 个属于重构引入或沿袭的真实逻辑问题；
- 真机联调 72 项（69 通过 / 3 警告）、覆盖 68 条路由，发现并修复 5 个只有真实 Chrome 才暴露的缺陷（见 §10）；
- 传输格式与路由模型与 `sdk.js` 保持一致，HTTP 接口对旧版保持路径与响应体兼容，
  差异项（状态码语义、`localPort`、`features`）已在设计报告与 API 文档中逐条说明。

---

## 10. 真机联调（真实浏览器实例）

单测与模拟服务端无法覆盖「真实 Chrome 的 API 行为」，因此另有一层联调：对运行中的扩展实例
执行检查，写操作全部针对专属靶场页面 `test-fixture.html`，结束自动清理。
详细报告见 [LIVE-TEST.md](LIVE-TEST.md)，原始数据见 [`artifacts/live-run.json`](../artifacts/live-run.json)。

```bash
node test/live-integration.js              # 只读 48 项
node test/live-integration.js --mutate     # 只读 + 写操作，72 项
```

**结果**：72 项检查 —— **69 通过 / 0 失败 / 3 警告**，总耗时约 14.7 s。
**路由覆盖**：69 条路由中 **68 条在真机执行（98.6%）**，仅 `config/clientId/generate` 未执行（会更换域名）。

### 10.1 联调发现的 5 个缺陷（本地 185 个用例均未覆盖）

| # | 现象 | 根因 | 为什么本地测不出 |
|---|------|------|-----------------|
| 1 | `/api/tabs/list` 500；所有标签页接口报 `No active tab found` | `ChromeAdapter.invoke()` 用 `fn.length <= args.length` 判定同步 API，而真实 `chrome.tabs.query.length === 1`，回调前就 `resolve(undefined)` | mock 一律返回 Promise，走不到该分支 |
| 2 | `config.reset()` 后 `wsServerUrl` 变 `undefined`，此后 `save()` 永远 400 | `new ConfigStore(adapter, { wsServerUrl: opts.wsUrl })` 在 `opts.wsUrl` 为 undefined 时覆盖了默认值 | 测试从不传 undefined |
| 3 | 握手 400：`wss://res2.dtns.top/?clientId=…`（缺 `/tunnel`） | 配置只存主机名，传输层直接拼 `?clientId=`，落在 `/` 上 | 测试总传完整 `/tunnel` URL |
| 4 | `TypeError: … reading 'writeText'` | `navigator.clipboard` 不存在时属性访问同步抛错，`try/catch` 只拦 Promise | Node 无 clipboard，无法模拟同步 TypeError |
| 5 | 一次 `/api/click/at` 触发两次 click | 既 `dispatchEvent('click')` 又调用 `element.click()` | mock 无法观察 DOM 事件次数 |

第 5 项用 CDP 做了对照实验确认：新序列（只派发 mousedown/mouseup + 原生 click）为 `+1`，
旧序列为 `+2`。该缺陷会让真实页面的提交按钮提交两次、开关被切回原状态。

### 10.2 修复与回归

| 缺陷 | 修复 | 新增用例 |
|------|------|----------|
| 1 | 删除启发式：Promise → Promise；返回值非 undefined → 同步 getter；其余等回调 | 3（callback / promise / lastError）+ 1（activeTab 回退） |
| 2 | `definedOnly()` 过滤 undefined；`reset()` 保证 URL 非空 | 2 |
| 3 | 传输层 `normalizeTunnelUrl()` 自动补 `/tunnel`；两处默认值统一 | 2 |
| 4 | `navigator.clipboard` 能力检测 + `execCommand` 降级 | 真机验证 |
| 5 | 只派发 mousedown/mouseup，click 交给原生 `click()` | 真机对照实验 |

本地用例因此从 177 增至 **185**，全部通过。

### 10.3 3 条警告（非缺陷）

| 检查 | 原因 |
|------|------|
| `smart_reply` | 依赖外部服务 `ibbot.devibbot.html.dtns.top`，本机不可达；端点自身响应正常 |
| `clipboard/copy`、`clipboard/clear` | Chrome 要求文档聚焦才能写剪贴板；窗口失焦时必然失败（聚焦时通过） |

### 10.4 未在真机执行

1. `config/clientId/generate` —— 会更换域名并可能让 Service Worker 休眠（联调中发生过两次），
   需 `--destructive` 显式开启；与已验证的 `config/reset`、`config/clientId` 共享同一代码路径。
2. `smart_reply` 成功路径（外部服务不可达）。
3. 剪贴板在窗口聚焦下的稳定性（受环境影响）。
4. 小时级稳定性（`uptimeMs` 峰值观测约 57 分钟连续在线）。
