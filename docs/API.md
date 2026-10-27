# API 文档 · DTNS 浏览器 Agent（v2.0）

本文档覆盖 `src/agent/routes.js` 注册的全部 **69 个 HTTP 端点**。

---

## 1. 基础信息

| 项 | 值 |
|----|----|
| 访问域名 | `http://browser2.<clientId>.html.dtns.top` |
| 协议 | HTTP over DTNS 隧道（二进制帧） |
| 方法 | 全部端点均为 `GET`；`HEAD` 由 GET 自动支持 |
| 参数位置 | 查询字符串（`?a=1`）优先于 JSON / 表单请求体 |
| 响应 | `application/json; charset=utf-8` |
| CORS | 所有响应带 `Access-Control-Allow-Origin: *` 等 5 个头，可配置关闭 |
| 隧道版本 | 响应头 `X-Tunnel-Version: dtns/2` |

> **关于域名首段**：服务端按域名首段分流，`browser.*` 指向 v1.0 的 JSON 代理服务，
> 二进制 v2 隧道使用 `browser2.*`。库调用方可用 `createBrowserAgent({ domainPrefix })`
> 覆盖，扩展改 `background.js` 顶部 `DOMAIN_PREFIX` 常量。clientId 不变，只有首段不同。

### 1.1 鉴权（可选）

启动时若配置了 `token`，所有请求必须携带其一：

```
Authorization: Bearer <token>
```

或（浏览器 WebSocket 无法自定义头时的备选）：

```
?token=<token>
```

失败返回 `401`：

```json
{ "ok": false, "error": "unauthorized", "hint": "Send Authorization: Bearer <token>." }
```

未配置 token 时不校验（与旧版行为一致）。生产部署建议开启。

### 1.2 两种响应信封

| 层 | 格式 | 典型状态码 |
|----|------|-----------|
| 代理层（未匹配 / 方法错 / 未授权 / 非法 body） | `{"ok": false, "error": "<code>"}` | 404 / 405 / 401 / 400 / 413 / 500 |
| 业务层（端点内部） | `{"success": true, ...}` / `{"success": false, "error": "..."}` | 200，参数缺失为 400 |

代理层错误码：`not_found`、`method_not_allowed`、`unauthorized`、`invalid_json`、
`payload_too_large`、`internal_error`、`websocket_route_not_found`、`sse_not_supported`。

### 1.3 通用行为

- `OPTIONS`：未显式注册 OPTIONS 路由时返回 `204`，并携带完整 CORS 头。
- `HEAD`：返回与 GET 相同的头部（含 `Content-Length`），但不返回响应体。
- 请求体上限 `1 MiB`（可配置），超限 `413 payload_too_large`。
- 业务失败一律 `200 + success:false`（保留旧版兼容性），参数缺失除外（`400`）。

---

## 2. 系统

### 2.1 `GET /health`

隧道健康检查。**不返回 `success` 字段**（与旧版一致）。

| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | `ok`（已注册）或 `degraded` |
| clientId | string | 客户端 ID |
| registeredDomains | string[] | 已注册域名 |
| protocolVersion | number | 协商后的协议版本（1 或 2） |
| uptimeMs | number | 运行时长 |
| timestamp | string | ISO 时间 |

```json
{
  "status": "ok",
  "clientId": "abc123def456ghi789jk",
  "registeredDomains": ["browser2.abc123def456ghi789jk.html.dtns.top"],
  "protocolVersion": 2,
  "uptimeMs": 58231,
  "timestamp": "2026-10-25T15:00:00.000Z"
}
```

### 2.2 `GET /api/info`

```json
{
  "success": true,
  "name": "AI灵驹浏览器插件",
  "version": "2.0.0",
  "clientId": "abc123…",
  "registeredDomains": ["browser2.abc123….html.dtns.top"],
  "capabilities": ["smart_reply", "dom_query", "click", "type", "navigate",
                   "clipboard", "evaluate", "screenshot", "tabs", "network", "console"]
}
```

### 2.3 `GET /api/domains`

```json
{ "success": true, "clientId": "abc123…", "registeredDomains": ["browser2.abc123….html.dtns.top"] }
```

---

## 3. 页面信息

> 以下端点通过 content script 执行，返回 `browser.tabs.sendMessage` 的结果。
> 页面不可访问（`chrome://` 等）或脚本不可用时返回 `success:false`。
> 以下响应示例的字段名取自一次真实浏览器联调（见 [LIVE-TEST.md](LIVE-TEST.md)）：
> 这些结构由内容脚本决定，本版原样透传，不做改写。

### 3.1 `GET /api/page/info`

```json
{ "success": true, "url": "https://example.com/", "title": "Example Domain", "readyState": "complete" }
```

失败时仍返回 `200`，并降级为：

```json
{ "success": false, "error": "Cannot access this page type", "url": "unknown",
  "title": "无法获取", "readyState": "unknown" }
```

### 3.2 `GET /api/page/visible-text`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| includePosition | boolean | true | 是否包含位置信息 |
| mergeText | boolean | true | 是否合并文本 |

```json
{
  "success": true,
  "totalBlocks": 12,
  "totalLength": 480,
  "url": "https://example.com/",
  "title": "Example Domain",
  "blocks": [{ "text": "块", "x": 100, "y": 200, "width": 300, "height": 20 }],
  "mergedText": "合并后的文本…"
}
```

> `blocks` 仅在 `includePosition=true` 时返回，`mergedText` 仅在 `mergeText=true` 时返回；
> 其余字段恒在。字段由内容脚本决定，本版原样透传。

### 3.3 `GET /api/page/visible-text/blocks`

```json
{ "success": true, "blocks": [ … ], "total": 42 }
```

### 3.4 `GET /api/page/visible-text/merged`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| separator | string | `\n` | 块间分隔符 |

```json
{ "success": true, "text": "a\nb", "length": 3 }
```

### 3.5 `GET /api/page/elements` / `GET /api/page/elements/simple`

返回完整 / 精简 DOM 结构，字段透传 content script（精简版为 `{success, elements, totalCount}`）。

### 3.6 `GET /api/page/links`

```json
{ "success": true, "links": [{ "href": "https://…", "text": "链接文本", "title": "标题" }] }
```

### 3.7 `GET /api/page/images`

```json
{ "success": true, "images": [{ "src": "https://…/a.png", "alt": "…" }] }
```

### 3.8 `GET /api/page/forms`

```json
{ "success": true, "forms": [{ "action": "/submit", "method": "post" }] }
```

### 3.9 `GET /api/page/inputs`

```json
{ "success": true, "inputs": [{ "name": "q", "type": "text", "value": "" }] }
```

### 3.10 `GET /api/page/buttons`

```json
{ "success": true, "buttons": [{ "text": "搜索", "selector": "#search" }] }
```

### 3.11 `GET /api/page/clickable-elements`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| includePosition | boolean | true | 是否含位置 |
| includeSelector | boolean | true | 是否含选择器 |

```json
{
  "success": true,
  "total": 50,
  "elements": [ … ],
  "summary": { "buttons": 10, "links": 30, "interactive": 10 }
}
```

### 3.12 `GET /api/page/clickable-elements/grouped`

```json
{ "success": true, "groups": { "button": ["#a"], "link": ["#b"] }, "total": 2 }
```

### 3.13 `GET /api/page/clickable-elements/selectors`

```json
{ "success": true, "selectors": ["#a", "#b"], "total": 2 }
```

### 3.14 `GET /api/element/info`

| 参数 | 必填 | 说明 |
|------|------|------|
| selector | ✅ | CSS 选择器 |

```json
{
  "success": true,
  "exists": true,
  "tag": "H1",
  "id": "hero",
  "className": "title",
  "text": "标题",
  "innerHTML": "标题",
  "outerHTML": "<h1 id=\"hero\" class=\"title\">标题</h1>",
  "attributes": { "id": "hero", "class": "title" },
  "position": { "left": 0, "top": 13, "right": 1912, "bottom": 63, "width": 1912, "height": 50 },
  "style": { … },
  "visible": true,
  "enabled": true
}
```

### 3.15 `GET /api/element/position`

| 参数 | 必填 |
|------|------|
| selector | ✅ |

注意坐标在 **`position` 对象内**（不是顶层 `x/y`）：

```json
{
  "success": true,
  "position": {
    "left": 0, "top": 13, "right": 1912, "bottom": 63,
    "width": 1912, "height": 50,
    "centerX": 956, "centerY": 38
  },
  "selector": "body"
}
```

### 3.16 `GET /api/element` 与 `GET /api/query`

| 参数 | 必填 | 说明 |
|------|------|------|
| selector | ✅ | CSS 选择器 |
| all | ❌ | 是否返回全部匹配 |

```json
{ "success": true, "exists": true, "tag": "DIV", "text": "元素文本", "html": "<div>…</div>" }
```

### 3.17 `GET /api/viewport/info`

```json
{
  "success": true,
  "scrollX": 0,
  "scrollY": 0,
  "clientWidth": 1912,
  "clientHeight": 948,
  "visualViewport": { "width": 1912, "height": 948, "scale": 1 }
}
```

> 注意字段名是 `clientWidth/clientHeight`（`document.documentElement` 的客户区），
> 不是 `width/height`；`visualViewport` 在无该 API 的环境下为 `null`。

---

## 4. 脚本执行

### 4.1 `GET /api/script/evaluate`

通过 CDP `Runtime.evaluate` 在页面中执行 JS。

| 参数 | 必填 | 说明 |
|------|------|------|
| script | ✅ | 要执行的表达式/代码 |

```json
{ "success": true, "result": 42, "type": "number" }
```

异常时：

```json
{ "success": false, "error": "Uncaught Error: boom" }
```

---

## 5. 交互

### 5.1 `GET /api/click`

| 参数 | 必填 |
|------|------|
| selector | ✅ |

```json
{ "success": true, "clicked": "#submit" }
```

### 5.2 `GET /api/click/at`

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| x, y | ✅ | — | 视口坐标 |
| button | ❌ | `left` | `left` / `right` / `middle` |
| double | ❌ | `false` | 是否双击 |

### 5.3 `GET /api/click/right` / `GET /api/click/double`

| 参数 | 必填 |
|------|------|
| x, y | ✅ |

### 5.4 `GET /api/mouse/move`

| 参数 | 必填 |
|------|------|
| x, y | ✅ |

### 5.5 `GET /api/type`

| 参数 | 必填 | 说明 |
|------|------|------|
| selector | ✅ | 目标输入框 |
| text | ✅ | 输入内容 |

### 5.6 `GET /api/smart_reply`

| 参数 | 必填 | 说明 |
|------|------|------|
| text | ✅ | 回复文本 |
| context | ❌ | 上下文 |

### 5.7 `GET /api/scroll`

| 参数 | 默认 | 说明 |
|------|------|------|
| x | 0 | 水平滚动量 |
| y | 0 | 垂直滚动量 |

```json
{ "success": true, "x": 0, "y": 400 }
```

---

## 6. 导航

### 6.1 `GET /api/navigate`

| 参数 | 必填 |
|------|------|
| url | ✅ |

优先 `chrome.tabs.update`，失败时回退到 content script 的 `navigate`。

```json
{ "success": true, "url": "https://example.com/", "tabId": 123, "status": "loading" }
```

### 6.2 `GET /api/refresh`

```json
{ "success": true, "tabId": 123, "message": "Page reloaded" }
```

---

## 7. 剪贴板与选区

### 7.1 `GET /api/clipboard/copy`

| 参数 | 必填 | 说明 |
|------|------|------|
| text | ✅* | 纯文本 |
| html | ✅* | HTML（与 text 二选一） |

```json
{ "success": true, "message": "Copied to clipboard" }
```

### 7.2 `GET /api/clipboard/read`

```json
{ "success": true, "text": "剪贴板文本", "html": "<b>HTML</b>", "length": 5 }
```

### 7.3 `GET /api/clipboard/append`

| 参数 | 必填 | 默认 |
|------|------|------|
| text | ✅ | — |
| separator | ❌ | `\n` |

### 7.4 `GET /api/clipboard/clear`

```json
{ "success": true, "message": "Clipboard cleared" }
```

### 7.5 `GET /api/selected/text`

```json
{ "success": true, "text": "用户选中的文本" }
```

---

## 8. 截图

### 8.1 `GET /api/screenshot`

| 参数 | 默认 | 说明 |
|------|------|------|
| quality | 75 | 1–100 |
| format | jpeg | 仅支持 `jpeg` |

```json
{ "success": true, "imageData": "<base64，不含 data: 前缀>", "format": "jpeg" }
```

### 8.2 `GET /api/screenshot2`（推荐）

| 参数 | 默认 | 说明 |
|------|------|------|
| quality | 80 | 1–100 |
| format | webp | `webp` / `jpeg` |
| maxWidth | — | 最大宽度（需 `OffscreenCanvas`） |
| maxHeight | — | 最大高度 |
| forceRefresh | false | 跳过缓存 |
| tabId | 当前活动页 | 指定标签页 |

响应头：`X-Screenshot-Latency`、`X-Screenshot-From-Cache`、`Cache-Control`。

```json
{
  "success": true,
  "imageData": "<base64>",
  "format": "webp",
  "quality": 80,
  "width": 1280,
  "height": 720,
  "size": 51234,
  "latency": 87,
  "fromCache": false,
  "timestamp": "2026-10-25T15:00:00.000Z"
}
```

缓存：3 秒 TTL，键为 `tabId|format|quality|maxWidth|maxHeight`，最多 24 条（LRU）；
相同参数的并发请求会合并为一次抓取；失败不缓存。

### 8.3 `GET /api/screenshot/stats`

```json
{ "success": true, "stats": { "requests": 10, "captures": 4, "cacheHits": 6,
  "coalesced": 0, "failures": 0, "cacheSize": 4, "pending": 0,
  "lastLatency": 87, "avgLatency": 92 } }
```

### 8.4 `GET /api/screenshot/clear-cache`

```json
{ "success": true, "message": "Screenshot cache cleared", "cleared": 4 }
```

### 8.5 `GET /api/screenshot/preload`

后台预热缓存，立即返回。

```json
{ "success": true, "message": "Preload started in background" }
```

---

## 9. 网络监控（需要 `debugger` 权限）

### 9.1 `GET /api/network/start`

| 参数 | 默认 | 说明 |
|------|------|------|
| duration | 30000 | 监控时长 ms，`0` 表示持续 |
| tabId | 当前活动页 | 目标标签页 |

```json
{ "success": true, "message": "Network monitoring started for 30000ms",
  "tabId": 123, "url": "https://example.com/" }
```

### 9.2 `GET /api/network/stop`

| 参数 | 默认 |
|------|------|
| tabId | 当前活动页 |

```json
{
  "success": true,
  "tabId": 123,
  "summary": {
    "total": 42,
    "byMethod": { "GET": 30, "POST": 12 },
    "byStatus": { "200s": 38, "300s": 0, "400s": 4, "500s": 0, "others": 0 },
    "errors": 4,
    "avgDuration": 150
  },
  "requests": [ … ],
  "totalCount": 42,
  "duration": 30000
}
```

### 9.3 `GET /api/network/status`

带 `tabId`：`{ "success": true, "active": true, "tabId": 123, "duration": 30000, "elapsed": 1200, "count": 8 }`

不带：`{ "success": true, "activeMonitors": [{ "tabId": 123, "duration": 30000, "elapsed": 1200 }], "totalRecords": 8 }`

### 9.4 `GET /api/network/requests`

| 参数 | 默认 | 说明 |
|------|------|------|
| limit | 100 | 返回最近 N 条 |
| method | — | 按方法过滤 |
| urlPattern | — | URL 正则（非法则 400） |
| tabId | — | 按标签页过滤 |

```json
{ "success": true, "requests": [ … ], "total": 12 }
```

单条记录字段：`id, requestId, tabId, url, method, type, requestHeaders, status, statusText,
mimeType, startTime, endTime, duration, size, error, fromCache, responseHeaders`。

### 9.5 `GET /api/network/request/detail`

| 参数 | 必填 |
|------|------|
| requestId | ✅ |

```json
{ "success": true, "request": { … } }
```

不存在时 `{ "success": false, "error": "Request not found", "requestId": "…" }`。

### 9.6 `GET /api/network/clear`

```json
{ "success": true, "message": "Network records cleared", "cleared": 42 }
```

---

## 10. 控制台（需要 `debugger` 权限）

### 10.1 `GET /api/console/logs`

| 参数 | 默认 | 说明 |
|------|------|------|
| tabId | 当前活动页 | 目标标签页 |
| limit | 100 | 返回条数 |
| level | — | `log` / `info` / `warn` / `error` / `debug` / `trace` |
| clear | false | 读取后清空缓冲区 |

```json
{ "success": true, "logs": [{ "level": "log", "message": "hello 7",
  "timestamp": 1700000000000, "source": "console" }], "total": 1, "tabId": 123 }
```

### 10.2 `GET /api/console/start`

| 参数 | 默认 | 说明 |
|------|------|------|
| duration | 0 | 收集时长 ms，`0` 表示持续 |
| tabId | 当前活动页 | |

### 10.3 `GET /api/console/stop`

```json
{ "success": true, "tabId": 123, "logs": [ … ], "total": 3, "duration": 5120 }
```

### 10.4 `GET /api/console/clear`

| 参数 | 说明 |
|------|------|
| tabId | 省略则清空全部 |

```json
{ "success": true, "message": "Console logs cleared", "tabId": 123 }
```

### 10.5 `GET /api/console/exec`

执行代码并返回**本次执行期间**产生的控制台输出。

| 参数 | 必填 |
|------|------|
| code | ✅ |
| tabId | ❌ |

```json
{
  "success": true,
  "result": "eval:40+2",
  "type": "string",
  "consoleOutput": [{ "level": "log", "message": "inside", "timestamp": 1700000000000 }],
  "error": null
}
```

---

## 11. 标签页

### 11.1 `GET /api/tabs/list`

| 参数 | 默认 | 说明 |
|------|------|------|
| active | false | 仅活动标签页 |
| currentWindow | false | 仅当前窗口 |

```json
{ "success": true, "total": 2, "tabs": [
  { "id": 1, "windowId": 1, "index": 0, "active": true,
    "url": "https://example.com/", "title": "Example", "status": "complete" } ] }
```

### 11.2 `GET /api/tabs/current`

```json
{ "success": true, "tab": { … } }
```

### 11.3 `GET /api/tabs/switch`

| 参数 | 说明 |
|------|------|
| tabId | 标签页 ID |
| index | 索引 |
| url | URL 匹配（忽略结尾 `/`） |
| title | 标题子串 |
| focusWindow | 是否聚焦窗口，默认 `true` |

```json
{ "success": true, "tab": { … }, "message": "Switched to tab" }
```

找不到时 `{ "success": false, "error": "No matching tab found", "candidates": 2 }`。

### 11.4 `GET /api/tabs/open`

| 参数 | 默认 | 说明 |
|------|------|------|
| url | ✅ | 目标地址 |
| active | true | 是否激活 |
| position | `end` | `start` / `end` / 索引 |
| windowId | — | 指定窗口 |

### 11.5 `GET /api/tabs/open/batch`

| 参数 | 默认 | 说明 |
|------|------|------|
| urls | ✅ | JSON 数组或逗号分隔 |
| active | `last` | `first` / `last` / `none` / 索引 |
| position | `end` | |
| windowId | — | |

```json
{ "success": true, "created": [ { "id": 101, "url": "https://a/" } ], "total": 1 }
```

### 11.6 `GET /api/tabs/openOrSwitch`

| 参数 | 默认 |
|------|------|
| url | ✅ |
| active | true |

```json
{ "success": true, "tab": { … }, "switched": true }
```

### 11.7 `GET /api/tabs/open/background`

| 参数 | 必填 |
|------|------|
| url | ✅ |

### 11.8 `GET /api/tabs/close`

四选一：`tabId`、`tabIds`（数组或逗号分隔）、`url`、`title`、`current=true`。

```json
{ "success": true, "closed": 1, "requested": 1 }
```

---

## 12. 窗口

### 12.1 `GET /api/windows/open`

| 参数 | 说明 |
|------|------|
| urls | 数组或逗号分隔 |
| width / height / left / top | 尺寸与位置 |
| type | `normal` / `popup` / `panel` |
| active | 是否聚焦，默认 `true` |

```json
{ "success": true, "windowId": 10, "tabs": [ { … } ] }
```

---

## 13. 配置

### 13.1 `GET /api/config`

```json
{
  "success": true,
  "config": { "clientId": "abc123…", "wsServerUrl": "wss://res2.dtns.top", "autoReconnect": true },
  "status": { "connected": true, "registered": true,
              "browserDomain": "http://browser2.abc123….html.dtns.top",
              "wsUrl": "wss://res2.dtns.top/tunnel", "serverVersion": 2 }
}
```

### 13.2 `GET /api/config/clientId`

| 参数 | 必填 | 规则 |
|------|------|------|
| clientId | ✅ | 8–32 位小写字母数字 |

```json
{ "success": true, "message": "Client ID changed to …", "newClientId": "…",
  "expectedDomain": "http://browser2.….html.dtns.top" }
```

非法 ID → `400 { "success": false, "error": "clientId must be 8-32 …" }`。

> 响应先于重绑返回；重绑完成后会重新触发 `listening` 事件。等待新域名时可用
> `expectedDomain` 或监听事件，切勿立即请求。

### 13.3 `GET /api/config/clientId/generate`

```json
{ "success": true, "message": "New client ID generated and reconnected",
  "clientId": "…", "expectedDomain": "http://browser2.….html.dtns.top" }
```

### 13.4 `GET /api/config/server`

| 参数 | 必填 | 规则 |
|------|------|------|
| url | ✅ | 以 `ws://` 或 `wss://` 开头 |

```json
{ "success": true, "message": "Server URL changed to …", "newUrl": "wss://…" }
```

### 13.5 `GET /api/config/reset`

```json
{ "success": true, "message": "Configuration reset", "clientId": "…",
  "wsServerUrl": "wss://res2.dtns.top", "expectedDomain": "http://browser2.….html.dtns.top" }
```

### 13.6 `GET /api/config/reconnect`

```json
{ "success": true, "message": "Reconnection initiated" }
```

---

## 14. 与旧版 API 文档（v1.5）的差异

| 差异 | 说明 |
|------|------|
| 隧道域名 | 由 `browser.<id>.html.dtns.top` 改为 `browser2.<id>.html.dtns.top`（首段决定服务端协议版本，`browser` 属 v1） |
| 参数缺失 | 由 `200 + {error}` 改为 `400 + {error}` |
| 未知路径 | 由 `404 + {availableRoutes}` 改为 `404 + {ok:false,error:'not_found'}` |
| 方法不匹配 | 新增 `405 + Allow`（旧版落到 404） |
| 鉴权 | 新增可选 Bearer token |
| 新增端点 | `/api/element`（`/api/query` 的别名）；`/api/console/clear`、`/api/screenshot/stats` 等旧版已有端点在 v1.5 文档中缺失，本版补齐说明 |
| `localPort` | 注册帧中由 `10999` 改为 `80`（协议字段为 u8，无本地监听端口） |
| 截图宽高 | 由浏览器 canvas 计算改为解析图片头，Node 环境同样可得 |
| SSE 请求 | 明确返回 `501 sse_not_supported` |
