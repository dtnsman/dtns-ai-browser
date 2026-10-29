# DTNS Browser Proxy · 把「你正在用的浏览器」变成 HTTP API

> 装一个 Chrome 扩展，你的浏览器就多了一个公网 HTTP 地址：
> `http://browser2.<clientId>.html.dtns.top/api/...`
> 不用公网 IP、不用端口映射、不用装 Playwright、不用把 cookie 交给第三方。

一句话：**别的方案是「给你一台新浏览器」，我们是「把你手上这台已登录的浏览器接出去」。**

```
调用方（服务器 / n8n / Dify / 任何语言）
        │  http://browser2.<clientId>.html.dtns.top/api/page/info
        ▼
   DTNS 隧道服务端
        ▲  wss:// 出站连接（无需公网 IP、无需开放端口）
        │
你的 Chrome（MV3 扩展）── 71 个 HTTP 端点 ── tabs / DOM / 截图 / 网络 / 控制台
```

---

## 一、它解决什么痛点

浏览器自动化这件事，卡住人的从来不是「怎么点按钮」，而是下面这几件事：

| 痛点 | 市面常见方案的处境 | 本方案怎么做 |
|---|---|---|
| **浏览器在我的电脑上，服务器够不着** | 要么把代码搬到本机跑，要么租云浏览器 | 扩展**主动出站**连隧道，NAT、CGNAT、公司防火墙后面都能被公网调用 |
| **目标网站需要登录，云浏览器是全新会话** | 导出 cookie 上传，或把账号密码交给第三方；MFA / 扫码登录基本没戏 | 跑在你**日常浏览器**里，登录态、MFA、插件、指纹天然可用，**零凭证外流** |
| **自动化工具链太重** | 装 Playwright/Puppeteer → 下载几百 MB 浏览器 → 驱动与浏览器版本对齐 → 每次升级重来 | **零运行时依赖**，浏览器就是你已经装好的那个 Chrome |
| **调用方不是 Node/Python** | 只有 SDK，Go / Java / PHP / 低代码平台接不进去 | **纯 HTTP + JSON**，`curl` 能通就能用 |
| **只想拿页面数据，不想跑无头浏览器** | 起 headless Chrome、处理字体缺失、反爬判定为机器人 | 用真实浏览器真实渲染，返回**结构化**的可见文本 / 表单 / 可点击元素 |
| **按小时计费，跑一晚账单不可控** | 云浏览器按 browser-hour 或 credit 计费 | 自托管，**无按小时费用**，成本只有电费和隧道 |

### 典型使用场景

- **AI Agent 的操作手**：LLM 在服务器上跑，需要点开用户浏览器里的页面、读 DOM、截图回传
- **低代码 / 工作流平台**：n8n、Dify、Coze、影刀之类需要一个 HTTP 接口来驱动浏览器
- **内网系统自动化**：OA、ERP 只在内网可访问，但你需要从外部触发操作
- **远程协助 / 值守**：人不在电脑前，仍要看到页面、点按钮、读控制台
- **需要登录态的数据采集**：用自己已登录的账号读取后台数据，而不是重新登录一次

---

## 二、和市面上同类项目的对比

浏览器自动化大致分成五类，本方案属于第六类——**「已有浏览器的远程出口」**，这一类目前基本是空白。

| 类别 | 代表项目 | 浏览器跑在哪 | 登录态从哪来 | 调用方式 | 公网入口 | 许可 / 成本 |
|---|---|---|---|---|---|---|
| **自动化库** | Playwright、Puppeteer、Selenium | 本地或 CI，自己拉起 | 自己注入 cookie / storageState | 语言 SDK（Node/Python/Java…） | 无，需自建 | Apache-2.0 / MIT，免费 |
| **云浏览器基础设施** | Browserbase、Hyperbrowser、Anchor、Kernel、Cloudflare Browser Run | 厂商云端数据中心 | 全新会话，需上传凭证 | Playwright / CDP 连接串 | 厂商提供 | 商业 SaaS，按浏览器小时或 credit 计费 |
| **自托管浏览器服务** | Steel、Browserless、BrowserStation | 你自己的服务器 | 同上，仍需自己灌 cookie | CDP / Playwright 远程连接 | 需自己暴露端口、配反代 | Steel Apache-2.0；Browserless SSPL-1.0（非 OSI 开源）；BrowserStation MIT |
| **Agent 框架** | browser-use、Stagehand | 本地或云端均可 | 取决于底层接入 | Python / TS SDK | 无 | MIT |
| **MCP 服务** | Playwright MCP、Chrome DevTools MCP | 本地 | 用本机 Chrome，有登录态 | MCP 协议（**要求客户端支持 MCP**） | 无，点对点 | 开源免费 |
| **本方案** | **DTNS Browser Proxy** | **你自己的、已登录的日常浏览器** | **原生登录态，零注入** | **纯 HTTP + JSON** | **出站隧道，无需公网 IP** | **GPLv3，免费** |

### 各类方案真正擅长什么（不吹不黑）

- **Playwright / Puppeteer**：引擎能力最全、调试工具最好、生态最大。**如果你能自由起浏览器、且不需要登录态，直接用它们**，不必绕一层 HTTP。
- **云浏览器（Browserbase 等）**：并发、隔离、录制回放、代理出口是硬需求时的正解。缺点是数据中心 IP、全新会话、按小时计费。
- **Steel / Browserless**：想要自托管又不介意运维容器，Steel 是 Apache-2.0 里最成熟的选择。
- **MCP 服务**：LLM 直接操作浏览器体验最顺，但**必须有支持 MCP 的客户端**，服务端后台任务、工作流平台接不进去。
- **browser-use / Stagehand**：把「用自然语言驱动页面」封装好了，适合做 Agent 应用；底层仍然要一台能连上的浏览器。

---

## 三、我们的竞争点

### 1. 零公网依赖：出站隧道，不需要公网 IP

市面上几乎所有「远程控制浏览器」的方案都要求浏览器侧**可被访问**——公网 IP、端口映射、反向代理、内网穿透工具。DTNS 反过来：扩展**主动出站**用 WebSocket 连隧道服务端，再由服务端把 HTTP 请求回注。

结果：笔记本、家用宽带、公司内网、4G 热点、远程桌面里的浏览器，都能被公网 HTTP 调用。

### 2. 真实登录态：不导出 cookie，不上传凭证

云浏览器的会话是全新的，要登录就得把账号密码或 cookie 交给第三方，MFA 和扫码登录基本不可行。

本方案跑在你**已经登录好**的浏览器里：扫码、短信、硬件密钥、企业 SSO 全部照常，凭证从不离开你的机器。

### 3. 调用方语言无关：纯 HTTP，`curl` 就能用

不需要装 SDK、不需要 Playwright 驱动、不需要 MCP 客户端：

```bash
curl "http://browser2.<clientId>.html.dtns.top/api/page/visible-text"
curl "http://browser2.<clientId>.html.dtns.top/api/screenshot2"
```

Go、Java、PHP、n8n、Dify、Coze、影刀，只要能发 HTTP 就能接入。

### 4. 零运行时依赖：没有浏览器二进制，没有驱动对齐

不用下载 Chromium，不用管 `playwright install`，不用处理「驱动版本和浏览器版本不匹配」。浏览器就是用户已经装好的那个。

### 5. 面向「取数据」而非「模拟操作」

71 个端点里有大量**结构化读取**能力，专为 LLM / 数据管道设计：

- 页面：`/api/page/visible-text`、`/api/page/visible-text/blocks`、`/api/page/forms`、`/api/page/links`、`/api/page/images`
- 元素：`/api/page/clickable-elements`、`/api/element/info`、`/api/element/position`
- 观测：`/api/screenshot2`（带缓存与限速）、`/api/network/requests`、`/api/console/logs`
- 操作：`/api/click`、`/api/type`、`/api/scroll`、`/api/navigate`、`/api/tabs/*`

返回的是可直接喂给模型的扁平结构，而不是让人再去写选择器。

### 6. 工程化程度可验证

- `node --test` **185 个用例全绿**，`src/` 行覆盖率 **94.14%**
- 真机联调 **72 项**、覆盖 **68/69** 条业务路由
- 三层解耦（协议 / 传输 / 路由 / 能力），`ChromeAdapter` 可注入 mock，**不依赖真实浏览器即可测试**
- 二进制 DTNS 帧传输（body 原样透传，不 base64 膨胀），协议版本协商 + 心跳 + 僵尸连接检测 + 指数退避重连

### 7. 可被 Agent 自动发现

`GET /api.json`（别名 `/apis`）返回整份能力目录：端点分组、参数类型与默认值，以及
`readOnly` / `danger` 标记。LLM 或低代码平台不用先读文档就能生成正确调用；即使配置了
`token`，这两条发现路径仍然公开（返回体里只有“是否需要鉴权”，不含 token 本身）。

---

## 四、什么时候**不该**用它

诚实地说，以下场景请直接用别的方案：

| 场景 | 更合适的选择 |
|---|---|
| 需要成百上千并发、彼此隔离的会话 | 云浏览器基础设施（Browserbase、Kernel 等） |
| 需要在 Linux CI 里跑无头浏览器 | Playwright / Steel |
| 需要 Firefox / WebKit 内核 | Playwright |
| 严格多租户隔离、审计合规 | 云厂商托管方案 |
| 需要 SSE / 流式响应 | 当前返回 `501`（协议是一问一答模型），暂不支持 |
| 需要浏览器侧的完全控制（自定义 Chromium、CDP 全量） | 直接用 Puppeteer / CDP |

另外，`/api/script/evaluate` 与 `/api/console/exec` 可执行任意页面脚本，**公网暴露务必配置 `token`**，详见 [API 文档](docs/API.md#11-鉴权可选)。

---

## 五、安装为 Chrome 扩展（推荐）

`extension/` 是一个**可直接加载**的 MV3 扩展：

1. 打开 `chrome://extensions/`，开启右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `.\extension`
3. 点扩展图标查看 clientId 与访问域名；首次会提示授予「调试器」权限（网络/控制台接口需要）

验证：

```bash
curl http://browser2.<clientId>.html.dtns.top/health
# {"status":"ok","clientId":"…","registeredDomains":["browser2.….html.dtns.top"],…}

curl http://browser2.<clientId>.html.dtns.top/api.json
# 端点目录：apiBase / auth / groups / endpoints（含参数与默认值）
```

**想保留旧插件的 clientId**：把 `extension/` 的内容替换到旧插件目录（同一路径）后「重新加载」。
Chrome 的未打包扩展以目录路径为身份，同路径才会保留存储；新版本会自动迁移旧的
`clientId / wsServerUrl` 键。换路径安装等于新扩展，需在 popup 里手动填回旧 ID。

详见 [extension/README.md](extension/README.md)。

## 六、在代码中使用

### 浏览器扩展 / MV3 Service Worker

```js
// background.js (manifest v3, "type": "module")
import { createBrowserAgent } from './dist/dtns-browser-proxy.mjs';

const agent = await createBrowserAgent();   // 自动读取 chrome.storage 中的 clientId
await agent.listen();                       // 隧道注册完成

// 例如：https://browser2.<clientId>.html.dtns.top/api/page/info
```

### Node 中作为纯 HTTP 代理使用

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

## 七、目录结构

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
    routes.js                 # 71 个 HTTP 端点
    api-catalog.js            # 端点元数据（参数/分组/只读/危险），单一数据源
    api-descriptor.js         # 由 catalog + 实时域名生成 /api.json
    chrome-adapter.js         # 唯一接触 chrome.* 的地方
    tab-bridge.js             # content-script RPC（含注入回退、超时）
    debugger-hub.js           # 每标签页单一 debugger 会话，引用计数复用
    network-monitor.js        # CDP 网络抓包
    console-collector.js      # CDP 控制台日志 / 代码执行
    screenshot-scheduler.js   # 截图缓存 / 限速 / 请求合并
    config-store.js           # clientId / 服务器地址持久化
    image-info.js             # 从图片头读取宽高（PNG/JPEG/WebP/GIF）
  util/primitives.js          # ProxyError / Emitter
docs/
  DESIGN.md                   # 设计报告
  API.md                      # 71 个端点的参数、响应与错误码
  TEST-REPORT.md              # 测试报告
  LIVE-TEST.md                # 真机联调报告
  PERFORMANCE.md              # v1.0 → v2.0 网络层对比
examples/
  background.js               # MV3 service worker 接入示例
extension/                    # 可直接「加载已解压的扩展程序」的 Chrome 扩展
  manifest.json
  background.js               # 隧道入口 + popup/内容脚本消息桥
  vendor/dtns-browser-proxy.js  # `npm run build` 生成
  content-script.js / popup.*   # 原插件资产（原样复用）
```

## 八、常用命令

| 命令 | 说明 |
|------|------|
| `npm test` | 运行全部 185 个用例 |
| `npm run test:report` | 运行测试并写入 `artifacts/` |
| `node test/live-integration.js` | 对真实浏览器实例做只读联调（48 项） |
| `node test/live-integration.js --mutate` | 追加写操作（专属靶场标签页，72 项） |
| `npm run build` | 生成 `dist/dtns-browser-proxy.mjs` 并同步到 `extension/vendor/` |

覆盖率采集：

```bash
node --test --experimental-test-coverage --test-coverage-include="src/**" "test/*.test.js"
```

## 九、文档

- [API 文档](docs/API.md) — 71 个端点的参数、响应与错误码
- [设计报告](docs/DESIGN.md) — 架构、协议、取舍与限制
- [测试报告](docs/TEST-REPORT.md) — 策略、结果、覆盖率、发现并修复的缺陷
- [真机联调报告](docs/LIVE-TEST.md) — 真实浏览器实例上的 72 项联调
- [性能分析报告](docs/PERFORMANCE.md) — v1.0 → v2.0 的网络层对比

## 十、与旧版的主要差异

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
| 调试器 | 网络与控制台各自 attach（互相冲突） | 单一会话引用计数复用 |

## 十一、许可

GNU General Public License v3.0（GPLv3），详见 [LICENSE](LICENSE)。

---

<sub>对比数据中，Browserbase / Steel / Browserless / Hyperbrowser / Anchor / Kernel / Cloudflare / Lightpanda 的许可与计费形态整理自各项目公开页面（截至 2026-09）。价格与版本会变动，选型前请以官方为准。</sub>
