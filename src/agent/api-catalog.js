/**
 * Machine-readable catalog of every endpoint registered by `routes.js`.
 *
 * Why a separate table instead of metadata on each route: the route table in
 * `routes.js` is 900 lines of inline handlers, and threading a fourth argument
 * through 69 registrations would make every handler noisier without adding
 * behaviour. Keeping the descriptions here means one file to edit when a
 * parameter changes, and `test/descriptor.test.js` fails the build if this
 * table and the live route table ever drift apart.
 *
 * Rules for entries:
 *   - `path` must match the registered route exactly (no query string).
 *   - `params` mirrors what the handler actually reads, including defaults
 *     taken from the `intOr`/`bool` fallbacks in `routes.js`.
 *   - `readOnly: true` means the call has no side effects on the page, tabs,
 *     clipboard or extension config, so a planner can batch it freely.
 *   - `danger: true` means arbitrary code execution or a change that breaks
 *     the tunnel URL; agents should confirm with the user first.
 *
 * All endpoints are `GET` (HEAD is answered by the router for free), which is
 * why `method` is filled in by the mapping at the bottom rather than repeated
 * 70 times.
 */
'use strict';

/* ==================== parameter spec helpers ==================== */

function spec(type, extra) {
  return Object.assign({ type: type }, extra || {});
}

function bool(defaultValue, description) {
  return spec('boolean', { default: defaultValue, description: description });
}

function integer(defaultValue, description) {
  return spec('integer', { default: defaultValue, description: description });
}

function str(defaultValue, description) {
  return spec('string', { default: defaultValue, description: description });
}

/** Mark a spec as mandatory (missing -> 400 with `<name> is required`). */
function required(parameter) {
  return Object.assign({}, parameter, { required: true });
}

/** Group order matches the section comments in `routes.js`. */
const GROUP_ORDER = [
  '系统',
  '页面信息',
  '脚本执行',
  '交互',
  '导航',
  '剪贴板',
  '截图',
  '网络监控',
  '控制台',
  '标签页',
  '窗口',
  '配置'
];

/* ==================== endpoint table ==================== */

const ENDPOINTS = [
  /* ---------- 系统 ---------- */
  {
    group: '系统',
    path: '/health',
    summary: '隧道健康检查；返回 status / clientId / 注册域名 / 协议版本，不含 success 字段',
    readOnly: true
  },
  {
    group: '系统',
    path: '/api/info',
    summary: '插件名称、版本、clientId、已注册域名与能力标签列表',
    readOnly: true
  },
  {
    group: '系统',
    path: '/api/domains',
    summary: '当前 clientId 与已注册域名',
    readOnly: true
  },
  {
    group: '系统',
    path: '/api.json',
    summary: '本文件：机器可读的端点目录，供 Agent / 低代码平台自动发现',
    readOnly: true
  },

  /* ---------- 页面信息 ---------- */
  {
    group: '页面信息',
    path: '/api/page/info',
    summary: '当前标签页的 url / title / readyState',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/visible-text',
    summary: '读取可见文本，可选附带元素位置',
    readOnly: true,
    params: {
      includePosition: bool(true, '是否返回每段文本的坐标与尺寸'),
      mergeText: bool(true, '是否把同一文本节点的片段合并')
    }
  },
  {
    group: '页面信息',
    path: '/api/page/visible-text/blocks',
    summary: '按块返回可见文本（块级元素为切分单位）',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/visible-text/merged',
    summary: '把整页可见文本合并成一个字符串',
    readOnly: true,
    params: {
      separator: str('\n', '块与块之间的连接符')
    }
  },
  {
    group: '页面信息',
    path: '/api/page/elements',
    summary: '页面结构化元素（含语义角色与文本）',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/elements/simple',
    summary: '页面元素的精简视图，适合直接拼进 prompt',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/links',
    summary: '页面内所有链接及锚文本',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/images',
    summary: '页面内所有图片及地址、尺寸',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/forms',
    summary: '页面表单结构（字段、类型、提交目标）',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/inputs',
    summary: '页面输入控件及其当前值',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/buttons',
    summary: '页面按钮及其可用状态',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/clickable-elements',
    summary: '可点击元素清单（含坐标与选择器），按可操作性排序',
    readOnly: true,
    params: {
      includePosition: bool(true, '是否返回坐标与尺寸'),
      includeSelector: bool(true, '是否返回 CSS 选择器')
    }
  },
  {
    group: '页面信息',
    path: '/api/page/clickable-elements/grouped',
    summary: '可点击元素按区域分组的结果',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/page/clickable-elements/selectors',
    summary: '只返回可点击元素的 CSS 选择器列表',
    readOnly: true
  },
  {
    group: '页面信息',
    path: '/api/element/info',
    summary: '单个元素的标签、文本、属性与可见性',
    readOnly: true,
    params: {
      selector: required(str(undefined, 'CSS 选择器'))
    }
  },
  {
    group: '页面信息',
    path: '/api/element/position',
    summary: '单个元素的位置与尺寸（视口坐标）',
    readOnly: true,
    params: {
      selector: required(str(undefined, 'CSS 选择器'))
    }
  },
  {
    group: '页面信息',
    path: '/api/element',
    summary: '按选择器查询 DOM 节点及其属性',
    readOnly: true,
    params: {
      selector: required(str(undefined, 'CSS 选择器')),
      all: bool(false, '是否返回全部匹配节点')
    }
  },
  {
    group: '页面信息',
    path: '/api/query',
    summary: '/api/element 的别名，按选择器查询 DOM',
    readOnly: true,
    params: {
      selector: required(str(undefined, 'CSS 选择器')),
      all: bool(false, '是否返回全部匹配节点')
    }
  },
  {
    group: '页面信息',
    path: '/api/viewport/info',
    summary: '视口尺寸、滚动位置与设备像素比',
    readOnly: true
  },

  /* ---------- 脚本执行 ---------- */
  {
    group: '脚本执行',
    path: '/api/script/evaluate',
    summary: '在当前标签页执行任意 JS 表达式并取回结果',
    readOnly: false,
    danger: true,
    params: {
      script: required(str(undefined, '要执行的 JS 表达式或语句'))
    }
  },

  /* ---------- 交互 ---------- */
  {
    group: '交互',
    path: '/api/click',
    summary: '点击 CSS 选择器匹配的元素',
    readOnly: false,
    params: {
      selector: required(str(undefined, 'CSS 选择器'))
    }
  },
  {
    group: '交互',
    path: '/api/click/at',
    summary: '在视口坐标处点击',
    readOnly: false,
    params: {
      x: required(integer(0, '视口横坐标')),
      y: required(integer(0, '视口纵坐标')),
      button: str('left', '按键：left / right / middle'),
      double: bool(false, '是否双击')
    }
  },
  {
    group: '交互',
    path: '/api/click/right',
    summary: '在视口坐标处右键点击',
    readOnly: false,
    params: {
      x: required(integer(0, '视口横坐标')),
      y: required(integer(0, '视口纵坐标'))
    }
  },
  {
    group: '交互',
    path: '/api/click/double',
    summary: '在视口坐标处双击',
    readOnly: false,
    params: {
      x: required(integer(0, '视口横坐标')),
      y: required(integer(0, '视口纵坐标'))
    }
  },
  {
    group: '交互',
    path: '/api/mouse/move',
    summary: '把鼠标移动到视口坐标（不点击）',
    readOnly: false,
    params: {
      x: required(integer(0, '视口横坐标')),
      y: required(integer(0, '视口纵坐标'))
    }
  },
  {
    group: '交互',
    path: '/api/type',
    summary: '向输入框填入文本（先聚焦再写入）',
    readOnly: false,
    params: {
      selector: required(str(undefined, 'CSS 选择器')),
      text: required(str(undefined, '要输入的内容'))
    }
  },
  {
    group: '交互',
    path: '/api/smart_reply',
    summary: '调用插件内置的机灵回复，针对给定文本生成并复制回复',
    readOnly: false,
    params: {
      text: required(str(undefined, '要回复的原文')),
      context: str('', '可选的上下文提示')
    }
  },
  {
    group: '交互',
    path: '/api/scroll',
    summary: '按偏移量滚动页面',
    readOnly: false,
    params: {
      x: integer(0, '横向偏移像素'),
      y: integer(0, '纵向偏移像素')
    }
  },

  /* ---------- 导航 ---------- */
  {
    group: '导航',
    path: '/api/navigate',
    summary: '让当前标签页跳转到指定 URL',
    readOnly: false,
    params: {
      url: required(str(undefined, '目标 URL'))
    }
  },
  {
    group: '导航',
    path: '/api/refresh',
    summary: '刷新当前标签页',
    readOnly: false
  },

  /* ---------- 剪贴板 ---------- */
  {
    group: '剪贴板',
    path: '/api/clipboard/copy',
    summary: '写入剪贴板；text 与 html 至少提供一个',
    readOnly: false,
    params: {
      text: str(undefined, '纯文本内容'),
      html: str(undefined, 'HTML 内容')
    }
  },
  {
    group: '剪贴板',
    path: '/api/clipboard/read',
    summary: '读取剪贴板的文本与 HTML',
    readOnly: true
  },
  {
    group: '剪贴板',
    path: '/api/clipboard/append',
    summary: '把文本追加到剪贴板末尾',
    readOnly: false,
    params: {
      text: required(str(undefined, '追加内容')),
      separator: str('\n', '追加前插入的分隔符')
    }
  },
  {
    group: '剪贴板',
    path: '/api/clipboard/clear',
    summary: '清空剪贴板',
    readOnly: false
  },
  {
    group: '剪贴板',
    path: '/api/selected/text',
    summary: '读取当前页面中用户选中的文本',
    readOnly: true
  },

  /* ---------- 截图 ---------- */
  {
    group: '截图',
    path: '/api/screenshot',
    summary: '截取当前标签页，返回 base64；png 会被降级为 jpeg',
    readOnly: true,
    params: {
      quality: integer(75, 'JPEG 质量 0-100'),
      format: str('jpeg', '图片格式，实际只支持 jpeg')
    }
  },
  {
    group: '截图',
    path: '/api/screenshot2',
    summary: '带缓存、限速与缩放的截图，返回响应头 x-screenshot-from-cache 等诊断信息',
    readOnly: true,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页'),
      quality: integer(80, '图片质量 0-100'),
      format: str('webp', '图片格式：webp 或 jpeg'),
      maxWidth: integer(undefined, '最大宽度，超出则等比缩小'),
      maxHeight: integer(undefined, '最大高度，超出则等比缩小'),
      forceRefresh: bool(false, '跳过缓存强制重新截图')
    }
  },
  {
    group: '截图',
    path: '/api/screenshot/stats',
    summary: '截图缓存命中率等统计',
    readOnly: true
  },
  {
    group: '截图',
    path: '/api/screenshot/clear-cache',
    summary: '清空截图缓存',
    readOnly: false
  },
  {
    group: '截图',
    path: '/api/screenshot/preload',
    summary: '后台预热截图缓存，立即返回',
    readOnly: false
  },

  /* ---------- 网络监控 ---------- */
  {
    group: '网络监控',
    path: '/api/network/start',
    summary: '开始抓取指定标签页的网络请求',
    readOnly: false,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页'),
      duration: integer(30000, '自动停止的毫秒数')
    }
  },
  {
    group: '网络监控',
    path: '/api/network/stop',
    summary: '停止抓包并返回汇总',
    readOnly: false,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页')
    }
  },
  {
    group: '网络监控',
    path: '/api/network/status',
    summary: '抓包状态；不带 tabId 时返回全部活动会话',
    readOnly: true,
    params: {
      tabId: integer(undefined, '只看这一个标签页')
    }
  },
  {
    group: '网络监控',
    path: '/api/network/requests',
    summary: '列出已抓到的请求，可按方法 / URL 片段过滤',
    readOnly: true,
    params: {
      limit: integer(100, '最多返回条数'),
      method: str('', '按 HTTP 方法过滤，如 POST'),
      urlPattern: str('', '按 URL 子串过滤'),
      tabId: integer(undefined, '只取这一个标签页的记录')
    }
  },
  {
    group: '网络监控',
    path: '/api/network/request/detail',
    summary: '单条请求的完整详情（头、时序、响应体摘要）',
    readOnly: true,
    params: {
      requestId: required(str(undefined, '请求 ID，来自 /api/network/requests'))
    }
  },
  {
    group: '网络监控',
    path: '/api/network/clear',
    summary: '清空已抓到的请求记录',
    readOnly: false
  },

  /* ---------- 控制台 ---------- */
  {
    group: '控制台',
    path: '/api/console/logs',
    summary: '读取页面控制台日志，可按级别过滤',
    readOnly: true,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页'),
      limit: integer(100, '最多返回条数'),
      level: str('', '按级别过滤：log / info / warn / error'),
      clear: bool(false, '读取后是否清空')
    }
  },
  {
    group: '控制台',
    path: '/api/console/start',
    summary: '开始采集控制台日志',
    readOnly: false,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页'),
      duration: integer(0, '自动停止的毫秒数，0 表示不自动停止')
    }
  },
  {
    group: '控制台',
    path: '/api/console/stop',
    summary: '停止采集控制台日志',
    readOnly: false,
    params: {
      tabId: integer(undefined, '目标标签页，缺省为当前标签页')
    }
  },
  {
    group: '控制台',
    path: '/api/console/clear',
    summary: '清空控制台日志缓冲',
    readOnly: false,
    params: {
      tabId: integer(undefined, '只清这一个标签页；缺省清全部')
    }
  },
  {
    group: '控制台',
    path: '/api/console/exec',
    summary: '在页面上下文执行代码并返回结果',
    readOnly: false,
    danger: true,
    params: {
      code: required(str(undefined, '要执行的代码')),
      tabId: integer(undefined, '目标标签页，缺省为当前标签页')
    }
  },

  /* ---------- 标签页 ---------- */
  {
    group: '标签页',
    path: '/api/tabs/list',
    summary: '列出标签页',
    readOnly: true,
    params: {
      active: bool(false, '只返回激活的标签页'),
      currentWindow: bool(false, '只返回当前窗口的标签页')
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/current',
    summary: '当前标签页的信息',
    readOnly: true
  },
  {
    group: '标签页',
    path: '/api/tabs/switch',
    summary: '按 tabId / index / url / title 切换标签页',
    readOnly: false,
    params: {
      tabId: integer(undefined, '目标标签页 ID'),
      index: integer(undefined, '目标标签页序号'),
      url: str(undefined, '按 URL 精确匹配'),
      title: str(undefined, '按标题子串匹配'),
      focusWindow: bool(true, '是否同时聚焦所在窗口')
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/open',
    summary: '新开一个标签页',
    readOnly: false,
    params: {
      url: required(str(undefined, '要打开的 URL')),
      active: bool(true, '是否立即激活'),
      position: str(undefined, '插入位置：start 或数字序号'),
      windowId: integer(undefined, '目标窗口 ID')
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/open/batch',
    summary: '批量打开多个标签页',
    readOnly: false,
    params: {
      urls: required(str(undefined, 'URL 列表，逗号分隔或 JSON 数组字符串')),
      active: str('last', '激活策略：last / first / none / true / false / 序号'),
      windowId: integer(undefined, '目标窗口 ID')
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/openOrSwitch',
    summary: '已存在同 URL 标签页则切换过去，否则新开',
    readOnly: false,
    params: {
      url: required(str(undefined, '目标 URL')),
      active: bool(true, '是否立即激活')
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/open/background',
    summary: '在后台新开标签页（不激活）',
    readOnly: false,
    params: {
      url: required(str(undefined, '要打开的 URL'))
    }
  },
  {
    group: '标签页',
    path: '/api/tabs/close',
    summary: '关闭标签页；tabId / tabIds / url / title / current 任选其一',
    readOnly: false,
    params: {
      tabId: integer(undefined, '单个标签页 ID'),
      tabIds: str(undefined, '多个 ID，逗号分隔或 JSON 数组'),
      url: str(undefined, '按 URL 精确匹配'),
      title: str(undefined, '按标题子串匹配'),
      current: bool(false, '关闭当前标签页')
    }
  },

  /* ---------- 窗口 ---------- */
  {
    group: '窗口',
    path: '/api/windows/open',
    summary: '新建浏览器窗口，可指定尺寸与初始标签页',
    readOnly: false,
    params: {
      urls: str(undefined, '初始标签页 URL，逗号分隔或 JSON 数组'),
      width: integer(undefined, '窗口宽度'),
      height: integer(undefined, '窗口高度'),
      left: integer(undefined, '窗口左边距'),
      top: integer(undefined, '窗口上边距'),
      type: str(undefined, '窗口类型：normal / popup / panel'),
      active: bool(true, '是否聚焦新窗口')
    }
  },

  /* ---------- 配置 ---------- */
  {
    group: '配置',
    path: '/api/config',
    summary: '当前配置与隧道状态（不含 token 本身）',
    readOnly: true
  },
  {
    group: '配置',
    path: '/api/config/clientId',
    summary: '改写 clientId 并重连；会换掉访问域名，调用前必须确认',
    readOnly: false,
    danger: true,
    params: {
      clientId: required(str(undefined, '新的 clientId'))
    }
  },
  {
    group: '配置',
    path: '/api/config/clientId/generate',
    summary: '随机生成新 clientId 并重连；旧域名立即失效',
    readOnly: false,
    danger: true
  },
  {
    group: '配置',
    path: '/api/config/server',
    summary: '改写隧道服务器地址并重连',
    readOnly: false,
    danger: true,
    params: {
      url: required(str(undefined, '新的 WebSocket 服务器地址'))
    }
  },
  {
    group: '配置',
    path: '/api/config/reset',
    summary: '重置全部配置（clientId 与服务器地址）并重连',
    readOnly: false,
    danger: true
  },
  {
    group: '配置',
    path: '/api/config/reconnect',
    summary: '以当前配置强制重连隧道',
    readOnly: false,
    danger: true
  }
];

const API_CATALOG = ENDPOINTS.map((entry) => Object.assign({ method: 'GET' }, entry));

/** Same document, second URL. Kept in one place so the parity test can use it. */
const API_ALIASES = ['/apis'];

/** Paths that stay readable when a token is configured, so callers can discover the API. */
const DISCOVERY_PATHS = ['/api.json'].concat(API_ALIASES);

module.exports = {
  API_CATALOG,
  API_ALIASES,
  DISCOVERY_PATHS,
  GROUP_ORDER
};
