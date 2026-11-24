# 架构与关键实现

## 为什么需要桥

DSH 桌面版的 Web GUI 默认只监听 `127.0.0.1:<随机端口>`，并且：

1. 端口每次启动都可能变（实测 58459 → 50694）；
2. 前端资源是 `Cache-Control: no-cache`，4G 下每个请求都要回源；
3. 没有任何面向手机的布局适配（聊天区固定窄列、键盘遮挡）。

桥做三件事：**端口代理**、**登录发 cookie**、**手机端体验优化**。

## 登录是怎么"免密"的

DSH 的会话 cookie 不是随机会话表，而是 HMAC 签名：

- 签名密钥持久化在 `$DSH_HOME/.credentials.yaml`（默认 `%USERPROFILE%\.dsh\.credentials.yaml`）；
- 桥读出 `client-connection` / `browser-session` 对应的 secret，离线签出合法 cookie；
- 桥自己再发一个 `dsh-bridge` cookie（`HMAC(PASS)`），30 天有效。

所以桥不需要知道 DSH 的启动 token，也不用改 DSH 任何代码。

> 这也意味着：能读 `.credentials.yaml` 的进程就能冒充浏览器登录 DSH。
> 桥本身是本地进程，请只放在自己信任的电脑上。

## 请求流程

```
GET /?k=<口令>
   ├─ 口令对 → 303 + Set-Cookie: dsh-bridge=...；带上游 DSH cookie 继续
   ├─ 有 dsh-bridge cookie → 直接转发
   └─ 都没有 → 401 / 403

GET /（已登录）
   ├─ peerAllowed? 否 → 403 "只允许局域网或 Tailscale 访问"
   ├─ 上游 127.0.0.1:DSH_PORT 转发
   ├─ /assets/* → 响应头改 immutable，长缓存；gzip（text/js/css/json）
   ├─ HTML → 收全后改写：注入 viewport meta、mobile.css、visualViewport 脚本
   └─ WebSocket → upgrade 后回环转发
```

### 自动探测 DSH 端口

`bridge.mjs` 用 `netstat -ano` 找监听进程：

1. 优先认 HTTP 401 + 响应体含 `dsh web authentication required` 的端口；
2. 兜底扫描 `49152-65535` 与 `3000-3100`（并发 600）；
3. 找不到就 `waitForDsh(15 * 60_000)` 每 3 秒重试——开机时桥可能比 DSH 先起来。

### 口令与限流

- `?k=<口令>` 正确 → `Set-Cookie: dsh-bridge=<HMAC(PASS)>`，`Max-Age=30 天`；
- 失败 5 次 → 锁 15 分钟（按来源 IP，写 `bridge-auth.log`）；
- 口令默认随机 24 位 base64url，存 `bridge.pass.txt`。

### 手机端注入

`MOBILE_TAG` 由三段拼成，插在 `</head>` 前：

1. 第二个 `<meta name="viewport">`：`width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`
   （同一文档里靠后的 meta 生效，用来覆盖 DSH 原来的 viewport）；
2. `<link rel="stylesheet" href="/__mobile.css?v=3">`；
3. `visualViewport` 脚本：resize/scroll 时把 `--dsh-mobile-vh` 设为可视高度，CSS 用它兜底。

`mobile.css` 的关键改动：

- 去掉 DSH 自带的 `body { zoom: .95 }`，恢复满宽（412px 设备实测 body 391 → 412）；
- 覆盖三个 CSS 变量：`--dsh-chat-content-width`、`--dsh-composer-card-max-width`、`--dsh-composer-side-clearance`；
- 压缩消息列、输入区、头部内边距，让正文接近满屏（325 → 389px）；
- `html, body { height: var(--dsh-mobile-vh, 100%); overflow: hidden }` —— 键盘弹出时布局视口跟着缩，输入框不再被盖住。

> `mobile.css` 里的类名（`an3WzG_body`、`V4vHZW_column`、`GRgSLq_card`、`mP3x-q_frame` 等）是 DSH 前端打包时的 hash 名。
> DSH 升级后可能变化；症状是"加宽失效"，用浏览器 DevTools 查新类名替换即可。

### 性能

| 资源 | 原始 | 经桥 gzip |
| --- | --- | --- |
| HTML | 46 KB | 6.7 KB |
| `index-*.js` | 1,070 KB | 322 KB |
| `vendor-*.js` | 724 KB | 176 KB |

外加 `/assets/*` 改成 `immutable` 一年缓存，二次打开不再回源。

## 自动启动

- 计划任务 `DSH-Phone-Bridge`：`wscript.exe start-bridge.vbs`（隐藏窗口，无窗口闪烁）；
- 启动文件夹快捷方式指向同一个 vbs（双保险，任务被禁用也能起来）；
- 进程写 `bridge.pid`，`uninstall.ps1` / `status.ps1` 靠它定位。

## 文件落点

安装目录（默认 `%USERPROFILE%\.dsh\phone-bridge`）：

| 文件 | 作用 |
| --- | --- |
| `bridge.mjs` / `mobile.css` | 桥本体与手机样式 |
| `bridge.pass.txt` | 口令（删掉后重启会重新生成） |
| `start-bridge.cmd` / `start-bridge.vbs` | 启动器 |
| `bridge.pid` | 当前进程号 |
| `phone-url.txt` / `手机地址.txt` | 手机可用地址 |
| `bridge.out.log` / `bridge.err.log` | 输出 / 错误日志 |
| `bridge-auth.log` | 认证成功与失败记录 |
