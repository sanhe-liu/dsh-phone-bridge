---
name: dsh-phone-bridge
description: 让手机用浏览器访问本机 DSH 桌面版（DeepSeek Harness）的 Web 界面——一键安装桥接服务、开机自启、Tailscale/局域网/Cloudflare 隧道访问、手机端界面适配与故障排查。当用户说"想在手机上用 DSH""手机连不上电脑上的 DSH""DeepSeek Harness 手机打不开"或要卸载/诊断手机访问时使用。
---

# DSH 手机桥（dsh-phone-bridge）

把一个只监听 `127.0.0.1` 的 DSH 桌面 Web GUI，安全地暴露给手机浏览器。

```
手机浏览器 ──► 桥 (0.0.0.0:8090) ──► 127.0.0.1:<DSH 端口>
                  │
                  ├─ ?k=<口令> → 换取 30 天有效 cookie
                  ├─ 只放行内网 / Tailscale 100.64.0.0/10 / Cloudflare 隧道
                  ├─ 手机端注入 CSS：加宽聊天区、键盘遮挡修复
                  └─ gzip + 静态资源长缓存（4G 下首屏更快）
```

## 什么时候用

- 用户想在手机上看/操作电脑上的 DSH 会话；
- 手机打不开 DSH 页面、或打开了但很慢；
- 换电脑、换网络后要重新安装；
- 要诊断（端口、进程、日志、Tailscale 状态）或卸载。

## 三条命令

在装好 Node.js 18+ 的 Windows 电脑上（PowerShell）：

```powershell
# 1. 安装（复制文件、生成口令、注册开机自启、放行防火墙、启动并自检）
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1

# 2. 看状态
powershell -ExecutionPolicy Bypass -File .\skill\scripts\status.ps1

# 3. 卸载
powershell -ExecutionPolicy Bypass -File .\skill\scripts\uninstall.ps1
```

安装完成后脚本会把「手机可用的地址」和口令打印出来。手机第一次必须带 `?k=<口令>`，
之后靠 30 天 cookie；建议用浏览器菜单「添加到主屏幕」。

## 常用参数

`setup.ps1`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Port` | `8090` | 桥监听端口 |
| `-Pass` | 自动 | 访问口令；省略则复用/随机生成 |
| `-InstallDir` | `%USERPROFILE%\.dsh\phone-bridge` | 安装目录 |
| `-Bind` | `0.0.0.0` | 监听地址，只给本机用可写 `127.0.0.1` |
| `-DshPort` | `auto` | 上游 DSH 端口，一般不用改 |
| `-NoFirewall` / `-NoAutostart` / `-NoStart` | — | 跳过对应步骤 |
| `-Force` | — | 端口被别的程序占用时也继续 |

## 推荐搭配 Tailscale（出门也能用）

局域网直连最快；不在家时推荐 Tailscale（免费、点对点、失败时走香港 DERP 中继）：

1. 电脑和手机装 Tailscale（<https://tailscale.com/download>），登录同一账号；
2. 手机打开 `http://<电脑的 100.x 地址>:8090/?k=<口令>`；
3. 桥已默认放行 `100.64.0.0/10` 与 `fd7a:115c:a1e0::/48`，不用改配置。

细节见 `references/tailscale.md`。

## 排障顺序

1. `status.ps1` 看：计划任务是否在跑、端口是否监听、日志尾部报错；
2. 手机连不上：先确认手机和电脑在同一网络（或都登了 Tailscale），再查防火墙；
3. 桥起来但页面 403/401：口令不对、或来源不在允许范围（公网 IP 直连会被拒绝）；
4. 桥起来但报「找不到 DSH」：先打开 DSH 桌面版，桥会在 15 分钟内自动重探上游端口；
5. 电脑重启后手机打不开：多半是 DSH 还没启动，或 DSH 端口变了——桥会自动重探。

更多见 `references/troubleshooting.md`。

## 安全须知

- 口令等于访问权：不要发在公开群里；泄露了就删 `bridge.pass.txt` 后重跑 `setup.ps1 -Pass <新口令>`；
- 桥只放行私网与 Tailscale 来源，不要把它挂到公网 IP 上；
- 日志里会记录访问者 IP 与失败次数（`bridge-auth.log`），错 5 次锁 15 分钟。

## 文件

```
skill/scripts/bridge.mjs    桥本体（探测 DSH 端口、口令换 cookie、注入手机样式、gzip）
skill/scripts/mobile.css    手机端适配样式（加宽 + 键盘遮挡修复）
skill/scripts/setup.ps1     安装（自启、防火墙、启动自检）
skill/scripts/status.ps1    状态与日志
skill/scripts/uninstall.ps1 卸载（停任务、删快捷方式、清防火墙、可选删文件）
skill/references/           架构、Tailscale、排障细节
```
