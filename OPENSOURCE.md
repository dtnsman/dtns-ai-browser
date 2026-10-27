# 开源说明（Open Source Notes）

本目录是 **DTNS Browser Proxy**（浏览器 Agent HTTP 代理）的对外开源发行版，
由主工作区 `.` 按白名单整理生成，专门用于在 Gitee 上公开发布与提交。

## 一、包含内容

| 路径 | 说明 |
| --- | --- |
| `src/` | 代理核心源码（HTTP 代理、请求转发、协议适配等） |
| `extension/` | 浏览器扩展（Manifest、popup、图标） |
| `docs/` | 设计与使用文档 |
| `examples/` | 示例代码 |
| `build.js` | 单文件 ESM 打包脚本 |
| `package.json` | 包元信息与脚本 |
| `README.md` | 项目总览与使用说明 |
| `LICENSE` | GPLv3 许可证 |

## 二、明确不包含（已排除）

以下内容属于本地私有资产或过程产物，**不进入开源仓库**：

- `dtns.http-proxy-site/` —— 内部站点资源，不对外发布
- `artifacts/` —— 构建/调试产物
- `test/`、`test-fixture.html`、`*.test.js`、`test-results/`、`coverage/` —— 测试文件与测试目录
- `tmp-*`、`*.tmp`、`*.temp` —— 临时文件
- `dist/`、`node_modules/`、`*.log` —— 构建与依赖产物
- `.svn/`、`.acl-recovery/`、`.DS_Store`、`Thumbs.db` 等版本控制/系统文件
- `*.pem`、`*.key`、`.env` 等私密信息

> 注意：私人令牌、SSH 私钥等凭据始终保存在工作区之外的
> `用户主目录下的 .ssh 目录` 下，任何情况下都不会被复制或提交。

## 三、使用方式

```bash
# 安装依赖（如有）
npm install

# 打包为单个 ESM 文件
node build.js
```

浏览器扩展：在 `chrome://extensions` 打开开发者模式，选择“加载已解压的扩展程序”，
指向本目录下的 `extension/`。

## 四、许可证

本项目以 GNU General Public License v3.0（GPLv3）发布，详见 [LICENSE](./LICENSE)。

你可以自由使用、修改和分发本项目，但衍生作品必须同样以 GPLv3 开源，并保留版权与许可声明。

## 五、同步与更新

开源目录是从主工作区复制的快照。主工作区更新后，重新执行白名单复制即可刷新：

```powershell
# 在 . 下执行
$items = @('build.js','package.json','README.md','src','docs','examples','extension')
foreach ($i in $items) {
  Copy-Item -LiteralPath $i -Destination '.\opensource' -Recurse -Force
}
```

请勿在 `opensource/` 内直接做“仅此处存在”的修改，以免下次同步时被覆盖。
