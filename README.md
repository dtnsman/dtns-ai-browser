# DTNS Browser Proxy · 浏览器 Agent HTTP 代理（重构版 2.0）

基于 `dtns.http-proxy-site/site/assets/sdk.js` 的协议与路由模型，重构 `dtns.ai-pet-pony/browser-plugin`
的 http-proxy 模块：把原来「JSON over WebSocket + 单文件路由表」的实现，替换为
**二进制 DTNS 帧传输 + 分层路由 + 可注入的 chrome 适配层**。

- 传输层：二进制帧（与 SDK / 隧道服务端同一套编解码），协议版本协商、心跳与僵尸连接检测、指数退避重连
- 路由层：Express 风格（路径参数、通配符、中间件、405/OPTIONS、鉴权、CORS、自动序列化）
- 能力层：69 个浏览器 API 端点，全部通过可注入的 `ChromeAdapter` 访问 `chrome.*`，因此可在 Node 中完整测试
- 零运行时依赖；`node --test` 185 个用例全绿，`src/` 行覆盖率 94.14%；真机联调 72 项、覆盖 68/69 条路由

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome MV3 Service Worker                                   │
│                                                              │
│  routes.js (69 endpoints)                                    │
│        │  req / res                                          │
│  HttpProxyApp ── Router（匹配 / 中间件 / 鉴权 / CORS）        │
│        │  HTTP_REQUEST / HTTP_RESPONSE                       │
│  TunnelTransport ── DTNS 二进制帧 / 心跳 / 重连              │
│        │                                                     │
│  ChromeAdapter ── tabs / windows / debugger / scripting      │
└──────────────┬───────────────────────────────────────────────┘
               │ wss://res2.dtns.top/tunnel?clientId=…
┌──────────────┴───────────────────────────────────────────────┐
│  DTNS 隧道服务端                                              │
└──────────────┬───────────────────────────────────────────────┘
               │ http://browser2.<clientId>.html.dtns.top/api/...
        ┌──────┴──────┐
        │   调用方     │
        └─────────────┘
```

## 安装为 Chrome 扩展（推荐）

`extension/` 是一个**可直接加载**的 MV3 扩展，已包含原插件的 `content-script.js`、`popup.html/js` 与图标，
只有后台入口被替换：

1. 打开 `chrome://extensions/`，开启右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `.\extension`
3. 点扩展图标查看 clientId 与访问域名；首次会提示授予「调试器」权限（网络/控制台接口需要）

**想保留旧插件的 clientId**：把 `extension/` 的内容替换到旧插件目录（同一路径）后「重新加载」。
Chrome 的未打包扩展以目录路径为身份，同路径才会保留存储；新版本会自动迁移旧的
`clientId / wsServerUrl` 键。换路径安装等于新扩展，需在 popup 里手动填回旧 ID。

详见 [extension/README.md](extension/README.md)。

## 快速开始

### 在浏览器扩展中使用

```js
// background.js (manifest v3, "type": "module")
import { createBrowserAgent } from './dist/dtns-browser-proxy.mjs';

const agent = await createBrowserAgent();   // 自动读取 chrome.storage 中的 clientId
await agent.listen();                       // 隧道注册完成

// 例如：https://browser2.<clientId>.html.dtns.top/api/page/info
```

### 在 Node 中作为纯 HTTP 代理使用

```js
const { createProxy } = require('./src/index.js');

const app = createProxy({
  domain: 'my-agent.html.dtns.top',
  wsUrl: 'wss://res2.dtns.top/tunnel',
  WebSocket                       // Node 22+ 内置；更早版本传入 `ws`
});

app.get('/hello', (req, res) => res.json({ ok: true, query: req.query }));
app.post('/echo', (req, res) => res.status(201).json({ body: req.body }));

await app.listen();
```

## 目录结构

```
package.json
build.js                      # 打包为单个 ESM 文件（无外部依赖）
src/
  index.js                    # 公共出口
  protocol/dtns-protocol.js   # 二进制帧编解码（双向、版本感知）
  proxy/
    transport.js              # WebSocket 生命周期 / 注册 / 心跳 / 重连
    router.js                 # Request / Response / Router
    websocket.js              # WebSocket 透传连接
    http-proxy.js             # HttpProxyApp：组装三层 + CORS + 鉴权
  agent/
    browser-agent.js          # createBrowserAgent：装配浏览器能力与路由
    routes.js                 # 69 个 HTTP 端点
    chrome-adapter.js         # 唯一接触 chrome.* 的地方
    tab-bridge.js             # content-script RPC（含注入回退、超时）
    debugger-hub.js           # 每标签页单一 debugger 会话，引用计数复用
    network-monitor.js        # CDP 网络抓包
    console-collector.js      # CDP 控制台日志 / 代码执行
    screenshot-scheduler.js   # 截图缓存 / 限速 / 请求合并
    config-store.js           # clientId / 服务器地址持久化
    image-info.js             # 从图片头读取宽高（PNG/JPEG/WebP/GIF）
  util/primitives.js          # ProxyError / Emitter
test/                         # 185 个用例 + 模拟隧道服务端 + 模拟 chrome + 真机联调脚本
docs/
  DESIGN.md                   # 设计报告
  API.md                      # API 文档
  TEST-REPORT.md              # 测试报告
  LIVE-TEST.md                # 真机联调报告
examples/
  background.js               # MV3 service worker 接入示例
extension/                    # 可直接「加载已解压的扩展程序」的 Chrome 扩展
  manifest.json
  background.js               # 隧道入口 + popup/内容脚本消息桥
  vendor/dtns-browser-proxy.js  # `npm run build` 生成
  content-script.js / popup.*   # 原插件资产（原样复用）
dist/
  dtns-browser-proxy.mjs      # 构建产物（扩展直接 import）
artifacts/                    # 测试输出与覆盖率原始数据
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm test` | 运行全部 185 个用例 |
| `npm run test:report` | 运行测试并写入 `artifacts/test-run.txt`、`artifacts/test-summary.json` |
| `node test/live-integration.js` | 对真实浏览器实例做只读联调（48 项） |
| `node test/live-integration.js --mutate` | 追加写操作（专属靶场标签页，72 项） |
| `node test/live-integration.js --mutate --destructive` | 额外执行会更换域名的配置轮换端点 |
| `npm run build` | 生成 `dist/dtns-browser-proxy.mjs` 并同步到 `extension/vendor/` |

覆盖率采集：

```bash
node --test --experimental-test-coverage --test-coverage-include="src/**" "test/*.test.js"
```

## 文档

- [设计报告](docs/DESIGN.md) — 架构、协议、与旧版差异、取舍与限制
- [API 文档](docs/API.md) — 69 个端点的参数、响应与错误码
- [测试报告](docs/TEST-REPORT.md) — 策略、结果、覆盖率、发现并修复的缺陷
- [真机联调报告](docs/LIVE-TEST.md) — 真实浏览器实例上的 72 项联调、靶场页面与发现的缺陷
- [性能分析报告](docs/PERFORMANCE.md) — v1.0 → v2.0 的网络层字节/延迟对比与对扩展的影响（理论分析）

## 与旧版的主要差异

| 维度 | 旧版 `browser-plugin/background.js` | 本版 |
|------|--------------------------------------|------|
| 隧道域名 | `browser.<clientId>.html.dtns.top` | `browser2.<clientId>.html.dtns.top`（`browser.*` 仍指向 v1.0 协议服务，故换前缀；可用 `domainPrefix` 配置） |
| 传输格式 | JSON 文本帧 + base64 body | DTNS 二进制帧（body 原样传输） |
| 协议版本 | 无协商 | welcome 帧协商 v1/v2 |
| 代码结构 | 单文件 4141 行，传输/路由/业务耦合 | 17 个模块，三层解耦 |
| 路由 | 字符串键值表，无路径参数、无 405 | Express 风格，含中间件、405、OPTIONS |
| 可测试性 | 需真实浏览器 | 注入 mock chrome + 自建 WS 服务端 |
| 鉴权 | 无 | Bearer / `?token=` |
| 心跳 | 仅发送，不检测僵尸连接 | ack 跟踪 + 超时强制重连 |
| 注册重试 | 3s 定时器 ×5，成功时不清理 | 单次定时器，成功后必然清理 |
| 调试器 | 网络与控制台各自 attach（互相冲突） | 单一会话引用计数复用 |
