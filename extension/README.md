# AI灵驹 · 网页灵犀（DTNS 代理 2.0）— 扩展安装说明

这个目录是**可直接加载的 Chrome 扩展**（Manifest V3），不再是需要你自己接线的库。

```
extension/
├── manifest.json                     MV3 清单（service_worker + type: module）
├── background.js                     入口：启动隧道 + popup/内容脚本消息桥
├── vendor/dtns-browser-proxy.js      `npm run build` 生成的代理模块（勿手改）
├── content-script.js                 原有内容脚本（原样复用，未改动）
├── popup.html / popup.js             原有配置面板（原样复用，未改动）
└── icon16/48/128.png                 图标
```

## 一、安装

1. 打开 `chrome://extensions/`（或 `edge://extensions/`）
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `.\extension`
4. 点扩展图标打开 popup，即可看到 **客户端 ID** 与访问域名
5. 浏览器会提示授予 **调试器** 权限（网络监控 / 控制台接口需要），选择允许

### 想保留旧插件的 clientId？

Chrome 的未打包扩展以**目录路径**作为身份，换目录安装等于装了一个新扩展，存储是空的。

- **推荐**：把本目录内容覆盖到旧插件目录（同一路径）后再「重新加载」，
  扩展 ID 不变，`chrome.storage.local` 保留；新版本会自动把旧的
  `clientId / wsServerUrl / autoReconnect` 三个键迁移到新配置项，域名保持不变。
- 或者：从旧 popup 复制 clientId，在新 popup 的「客户端 ID」里粘贴并保存。

## 二、验证是否工作

> 域名首段是 **`browser2`**：`browser.*` 仍由 v1.0 的 JSON 代理服务承接，二进制 v2 隧道必须换前缀。
> 如需别的首段，改 `background.js` 顶部的 `DOMAIN_PREFIX` 后重新加载扩展。

在 popup 里确认状态为「在线」后，用任意 HTTP 客户端访问（把 `<clientId>` 换成你的 ID）：

```bash
curl http://browser2.<clientId>.html.dtns.top/health
# {"status":"ok","clientId":"…","registeredDomains":["browser2.….html.dtns.top"],…}

curl http://browser2.<clientId>.html.dtns.top/api/page/info
# {"success":true,"url":"https://…","title":"…","readyState":"complete"}

curl http://browser2.<clientId>.html.dtns.top/api/screenshot2
# {"success":true,"imageData":"…","width":1280,"height":720,…}
```

完整端点清单见 [../docs/API.md](../docs/API.md)（69 个）。

## 三、与旧插件的关系

| 部件 | 处理方式 |
|------|----------|
| `content-script.js` | 原样复用（网页内交互逻辑未改） |
| `popup.html` / `popup.js` | 原样复用；`background.js` 补齐了它依赖的 7 个消息：`getConnectionStatus`、`getConfig`、`setClientId`、`generateNewClientId`、`setServerUrl`、`resetConfig`、`reconnect` |
| `background.js` | **替换**为隧道代理入口（原 4141 行 → 入口约 130 行 + 17 个模块） |
| 快捷键 | `Alt+S` 智能选区保留 |
| `capture_tab` 消息 | 保留，改由截图调度器实现（带缓存与限速） |

## 四、常见问题

**Q：popup 一直显示离线？**
查看 `chrome://extensions` → 本扩展 → **Service Worker** 链接里的控制台日志，
常见原因是 `wss://` 服务地址不可达，或该 clientId 对应的域名已被占用。

**Q：域名访问 404 / No tunnel registered？**
说明隧道未注册成功。检查 popup 里的「服务器地址」，以及是否需要企业网络代理。

**Q：网络监控、控制台接口报错？**
这两个能力依赖 `chrome.debugger`，并且会与已经打开的 DevTools 争夺同一标签页——
先关闭该标签页的 DevTools 再调用。

**Q：Service Worker 被休眠导致断开？**
MV3 的 Service Worker 空闲 30 秒会被回收。Chrome 116+ 在 WebSocket 有活动时会延长生命周期，
因此心跳（默认 25 秒）通常足以保活；极端情况下隧道会在 worker 唤醒后自动重连。

**Q：想加访问口令？**
编辑 `background.js` 顶部 `createBrowserAgent({ token: '…' })`，重新加载扩展后，
所有请求需带 `Authorization: Bearer <token>`（或 `?token=`）。
注意 `/api/script/evaluate` 与 `/api/console/exec` 可执行任意页面脚本，公网使用务必设置。
