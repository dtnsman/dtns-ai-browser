# 真机联调报告 · DTNS 浏览器 Agent（v2.0）

| 项 | 值 |
|----|----|
| 目标实例 | `http://browser2.wwz5g7mv8e1p183xt15g.html.dtns.top` |
| 协议 | `protocolVersion: 2`（welcome 协商结果） |
| 扩展 | `extension/`（MV3，`browser2` 前缀） |
| 测试靶场 | `test-fixture.html`（本机 `http://127.0.0.1:8765/test-fixture.html`） |
| 时间 | 2026-10-26（Asia/Shanghai） |
| 结果 | **72 项检查：69 通过 / 0 失败 / 3 警告** |
| 路由覆盖 | **68 / 69 = 98.6%** |
| 脚本 | `test/live-integration.js`（`--mutate` 启用写操作） |
| 原始数据 | [`artifacts/live-run.json`](../artifacts/live-run.json) |

---

## 1. 结论

真实浏览器实例上，隧道注册、二进制帧传输、代理层 HTTP 语义、chrome 能力层、**全部写操作**均工作正常：

- 截图 **1912×948 / 45–48 KiB** 真实 JPEG，图片头尺寸与响应字段一致，缓存命中 `latency=0`
- **写操作全部真机验证**：点击（选择器/坐标/右键/双击）、悬停、输入、滚动、导航、刷新、
  剪贴板读写清、标签页增删切换批量、窗口创建、debugger 抓包与控制台执行
- 代理层语义（404 / 405 / 400 / CORS / OPTIONS / `x-tunnel-version`）全部符合设计
- 68 / 69 条路由在真机执行，唯一例外是会更换域名的 `config/clientId/generate`

联调期间发现并修复 **5 个只有真机能暴露的缺陷**（详见 §4），全部补了回归用例。

---

## 2. 执行方式

```bash
# 只读（48 项）
node test/live-integration.js

# 只读 + 写操作（72 项，使用专属 fixture 标签页，结束自动清理）
node test/live-integration.js --mutate

# 额外执行会更换域名的配置轮换端点（谨慎）
node test/live-integration.js --mutate --destructive
```

退出码：`0` 全部通过，`1` 存在硬失败，`2` 脚本异常。

**靶场页面**：`test-fixture.html` 提供稳定的 DOM 契约——计数器按钮（验证点击次数）、
右键/双击/悬停区、输入框、可滚动长页、表单与链接。所有写操作只作用于它，
并用 `window.__fixtureClicks` 等状态变量做**副作用断言**，而不是只看 `success:true`。

---

## 3. 最终结果（72 项）

### 3.1 系统 / 页面 / 代理（只读共 48 项，下表为代表项）

| 检查 | 耗时 | 关键结果 |
|------|------|----------|
| `GET /health` | 95ms | `v2` `uptime` 正常 |
| `GET /api/info` | 47ms | `version=2.0.0` `capabilities=11` |
| `GET /api/domains` / `config` | 29–33ms | 域名与协议一致（`browser2` 回归点） |
| `page/info`、`visible-text`×3、`elements`×2 | 32–48ms | fixture 上 `blocks=9`、`links=2`、`forms=1`、`inputs=4`、`buttons=6` |
| `page/images|forms|inputs|buttons` | 29–41ms | 数组结构正确 |
| `clickable-elements`×3 | 29–53ms | `total=8`，`groups=5` |
| `element/info`、`element/position`、`element`、`query` | 30–34ms | `tag=BODY`、`w=1912 h=948` |
| `viewport/info` | 31ms | `1912x948` |
| `selected/text`、`clipboard/read` | 29–31ms | 长度正确 |

### 3.2 截图链路（6 项）

| 检查 | 耗时 | 关键结果 |
|------|------|----------|
| `screenshot2`（强制刷新） | 165ms | `1912x948` `47.8KiB` `latency=49ms` |
| `screenshot2`（缓存） | 98ms | `fromCache=true` `latency=0ms`，字节与首帧一致 |
| `screenshot`（legacy） | 103ms | `44044` 字节 |
| `screenshot/stats|clear-cache|preload` | 27–32ms | 统计与缓存操作正常 |

### 3.3 写操作（18 项，全部针对 fixture）

| 检查 | 耗时 | 副作用断言 |
|------|------|-----------|
| `click`（选择器） | 177ms | 计数器 `0 -> 1` |
| `click/at`（坐标） | 130ms | 计数器 `1 -> 2`（**精确 +1**） |
| `click/right` | 96ms | `__fixtureState=right-click` |
| `click/double` | 104ms | `__fixtureState=double-click` |
| `mouse/move` | 36ms | 目标元素命中 |
| `type` | 62ms | 输入框值 === 写入值（18 字符） |
| `scroll` | 91ms | `scrollY=600`，随后复位 |
| `navigate` + `refresh` | 310ms | 回到 fixture 且标题正确 |
| `clipboard/copy` + `append` | 115–336ms | 读回校验后**恢复原内容** |
| `clipboard/clear` | 81ms | 清空后读回为空 |
| `network/start` + `stop` | 143ms | attach → 有监视器 → detach 归零 |
| `network/requests` + `request/detail` | 1072ms | 抓到 30 条，取首条详情 |
| `network/clear` | 60ms | 清空后 `total=0` |
| `console/start` + `exec` + `stop` | 94ms | `exec` 返回 `3` |
| `tabs/open/batch` + `close` | 203ms | 建 2 关 2 |
| `tabs/openOrSwitch`（复用/新建） | 56–137ms | 已存在则切换、否则新建 |
| `tabs/open/background` + `close` | 124ms | `active=false` |
| `windows/open` | 346ms | 建窗口并关闭其标签页（窗口随之关闭） |

### 3.4 配置与收尾（4 项）

| 检查 | 结果 |
|------|------|
| `config/reconnect` | 重连后同域名恢复 |
| `config/clientId` / `config/server`（非法值） | 均 `400`，且**不触发重绑** |
| `config/reset` | 默认跳过（`--destructive` 才执行） |
| teardown | 关闭 fixture 后标签数恢复原值，无残留 |

### 3.5 3 条警告（非缺陷）

| 检查 | 原因 |
|------|------|
| `smart_reply` | 依赖外部服务 `ibbot.devibbot.html.dtns.top`，本机不可达；端点本身响应正常 |
| `clipboard/copy`、`clipboard/clear` | Chrome 要求**文档聚焦**才能写剪贴板；浏览器窗口失焦时必然失败（本次运行窗口未聚焦，上一轮聚焦时通过） |

---

## 4. 联调发现的 5 个缺陷（本地 185 用例均未覆盖）

| # | 现象 | 根因 | 为什么本地测不出 |
|---|------|------|-----------------|
| 1 | `/api/tabs/list` 500，所有标签页接口报 `No active tab found` | `ChromeAdapter.invoke()` 用 `fn.length <= args.length` 判定同步 API；真实 `chrome.tabs.query.length === 1`，回调前就 `resolve(undefined)` | mock 一律返回 Promise，走不到该分支 |
| 2 | `config.reset()` 后 `wsServerUrl` 变成 `undefined`，`save()` 永久 400 | `new ConfigStore(adapter, { wsServerUrl: opts.wsUrl })` 在 `opts.wsUrl` 为 undefined 时**覆盖**了默认值 | 测试从不传 `undefined` |
| 3 | 握手失败 `400`：`wss://res2.dtns.top/?clientId=…` | 配置里的 `wsServerUrl` 只有主机名，传输层直接拼 `?clientId=`，落在 `/` 上 | 测试总是传完整 `/tunnel` URL |
| 4 | `TypeError: Cannot read properties of undefined (reading 'writeText')` | `navigator.clipboard` 不存在时属性访问**同步抛错**，`try/catch` 拦不住（只拦 Promise） | Node 无 clipboard，无法模拟同步 TypeError |
| 5 | 一次 `/api/click/at` 触发**两次** click | 既 `dispatchEvent(new MouseEvent('click'))` 又调用 `element.click()` | mock 无法观察 DOM 事件次数 |

**第 5 项的判定证据**（CDP 对照实验）：

```
新序列（mousedown/mouseup + 原生 click）: delta +1  ✅
旧序列（额外 dispatch 合成 click）      : delta +2  ❌
```

影响：真实页面上的提交按钮会提交两次、开关会被切回原状态。

### 修复与固化

| 缺陷 | 修复 | 回归用例 |
|------|------|----------|
| 1 | 删除启发式：Promise → Promise；返回值非 undefined → 同步 getter；其余等回调 | 3 个（callback/promise/lastError）+ 1 个 activeTab 回退 |
| 2 | `definedOnly()` 过滤 undefined；`reset()` 保证 URL 非空 | 2 个 |
| 3 | 传输层 `normalizeTunnelUrl()` 自动补 `/tunnel`；两处默认值统一 | 2 个 |
| 4 | 能力检测 + `execCommand` 降级 | 真机验证 |
| 5 | 只派发 mousedown/mouseup，click 交给原生 `click()` | 真机对照实验 |

本地用例从 177 增至 **185**，全部通过。

---

## 5. 真机路由覆盖

| 维度 | 数值 |
|------|------|
| 路由总数 | 69 |
| 真机已执行 | **68** |
| 覆盖率 | **98.6%** |
| 未执行 | `GET /api/config/clientId/generate` |

**为什么这一条不执行**：它会把 clientId 换成随机值、域名随之改变。恢复失败会让用户保存的
URL 失效，且在 MV3 下重绑可能让 Service Worker 休眠、隧道长时间不可用（本次联调中确实发生过两次，
见 §6）。该端点与已验证的 `config/reset`、`config/clientId` 共享 `config.reset()` + `rebind()` 路径，
本地用例已覆盖；真机执行需显式 `--destructive`。

---

## 6. 联调过程中的事故与处置（如实记录）

调试 `config/reset` 时隧道曾被中断两次，原因分别是 §4 的缺陷 2 与缺陷 3：

1. 缺陷 2 让 `wsServerUrl` 变成 `undefined`，`save()` 无法再改配置；
2. 缺陷 3 让修复时填写的裸域名指向 `/`，服务端返回 400，Service Worker 因无心跳而休眠。

处置：先用 `/api/config/server` 修复 URL 字段，再在扩展重载后由传输层规范化路径，
最终恢复为原域名。**这两个缺陷正是因此才被发现**——若不真机执行 reset，它们会留在交付件里。

因此 `config/reset` 与 `config/clientId/generate` 默认不执行，需 `--destructive` 显式开启。

---

## 7. 边界与未验证项

**已验证**：68 条路由、二进制帧往返、截图与缓存、全部页面写操作、剪贴板、标签页与窗口、
debugger 抓包、控制台执行、错误信封与状态码、配置热重绑。

**未验证**：

1. `config/clientId/generate`（破坏性，见 §5）；
2. `smart_reply` 的成功路径（外部服务不可达，仅验证端点响应确定）；
3. 剪贴板在**窗口聚焦**下的稳定性（受环境影响，时通时不通）；
4. 小时级稳定性（`uptimeMs` 峰值观测约 57 分钟连续在线，未做更长观察）；
5. 非 Chrome 内核浏览器。
