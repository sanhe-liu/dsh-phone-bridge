# DSH 手机桥 · dsh-phone-bridge

> 让手机浏览器直接访问电脑上的 **DSH 桌面版**（DeepSeek Harness）Web 界面：局域网秒开，出门用 Tailscale 也能用。
> 附带手机端界面适配（加宽聊天区、修掉键盘弹出时的底部空白）与开机自启。

`DSH` 的桌面 Web GUI 只监听 `127.0.0.1`，手机天然够不着。这个项目是一个小的 Node 桥：
它代替 DSH 监听局域网端口，校验访问口令后注入合法会话 cookie，再把请求转给 `127.0.0.1` 上的 DSH。

```
手机浏览器 ──► 桥 0.0.0.0:8090 ──► 127.0.0.1:<DSH 端口>
                  │
                  ├─ ?k=<口令> → 30 天 cookie；错 5 次锁 15 分钟
                  ├─ 只放行 内网 / Tailscale 100.64.0.0/10 / Cloudflare 隧道
                  ├─ 注入 mobile.css：聊天区加宽、键盘遮挡修复
                  └─ gzip + 静态资源 immutable 缓存，4G 首屏更快
```

## 特性

- **一条命令装好**：文件、口令、防火墙、开机自启、启动自检一次完成，最后直接打印手机能打开的地址。
- **口令即登录**：`?k=<口令>` 换 30 天 cookie；口令错 5 次锁 15 分钟，访问记录写进 `bridge-auth.log`。
- **只给可信来源**：默认只放行私网与 Tailscale 网段，公网 IP 直连一律 403。
- **DSH 换端口也不怕**：DSH 每次启动端口可能变，桥自动重探上游；DSH 还没起来时最多等 15 分钟。
- **手机界面适配**：聊天区从 325px 加宽到接近满屏，键盘弹出时输入框贴着键盘、上面的内容看得见。
- **两台设备同步**：桥只是转发，电脑上的会话、配置、工作区原样呈现在手机上。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 |
| Node.js | 18+（`winget install OpenJS.NodeJS.LTS`） |
| DSH | 桌面版已安装并能正常打开 |
| 手机 | 任意现代浏览器（Android Chrome/Edge、iOS Safari 均可） |

## 快速开始

```powershell
git clone https://github.com/你的用户名/dsh-phone-bridge.git
cd dsh-phone-bridge
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

没有 git？在 GitHub 页面点 **Code → Download ZIP**，解压后双击 `install.ps1`（或右键 → 使用 PowerShell 运行）。

脚本跑完会打印类似：

```
   手机浏览器打开（第一次必须带 ?k=，之后靠 cookie）：
     http://192.168.1.23:8090/?k=xxxxxxxxxxxxxxxxxxxxxxxx
     http://100.94.80.64:8090/?k=xxxxxxxxxxxxxxxxxxxxxxxx

   口令：xxxxxxxxxxxxxxxxxxxxxxxx
   安装目录：C:\Users\你\.dsh\phone-bridge
```

手机打开第一个地址 → 在浏览器菜单里「添加到主屏幕」，以后点图标直达。

> 首次安装若提示需要管理员，是因为要加防火墙规则；用管理员 PowerShell 重跑一次即可，
> 或者按提示手动执行那条 `New-NetFirewallRule`。

## 安装成 DSH 技能（推荐）

`install.ps1` 会同时把 `skill\` 复制到 `%USERPROFILE%\.dsh\skills\dsh-phone-bridge`。
重启 DSH 后，在会话里直接说「把手机接上」之类的话，DSH 会自动加载这个技能并按需执行安装/诊断/卸载。

只用技能、不装桥：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoSetup
```

## 出门也能用：Tailscale

在家时手机和电脑连同一个 Wi‑Fi，直接用局域网地址最快。
不在家时推荐 [Tailscale](https://tailscale.com/download)（免费，点对点直连，打洞失败自动走香港/东京 DERP 中继）：

1. 电脑和手机各装 Tailscale，登录**同一个账号**；
2. 手机上打开 `http://<电脑的 100.x 地址>:8090/?k=<口令>`；
3. 桥已默认放行 `100.64.0.0/10` 与 `fd7a:115c:a1e0::/48`，无需改配置。

电脑的 100.x 地址：托盘图标悬停提示、手机 Tailscale App 的机器列表，或 `tailscale ip -4`。
详细说明与原理解析见 [`skill/references/tailscale.md`](skill/references/tailscale.md)。

## 常用命令

```powershell
# 安装 / 重新安装（复用已有口令）
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1

# 换端口安装
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1 -Port 8091

# 重置口令
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1 -Pass 新的口令

# 看状态（任务、端口、日志、Tailscale 地址）
powershell -ExecutionPolicy Bypass -File .\skill\scripts\status.ps1

# 卸载（保留文件加 -KeepFiles）
powershell -ExecutionPolicy Bypass -File .\skill\scripts\uninstall.ps1
```

## 排障速查

| 现象 | 先看这里 |
| --- | --- |
| 手机打不开页面 | `status.ps1`：桥在跑吗？端口在听吗？手机与电脑同一网络吗？防火墙放行了吗？ |
| 页面 403 | 来源不在允许网段（比如用公网 IP 直连）；换局域网 IP 或 Tailscale |
| 页面 401 / 反复要口令 | 口令不对；地址里的 `?k=` 要完整；清掉站点 cookie 重开 |
| 「找不到正在运行的 DSH Web 服务」 | 先打开 DSH 桌面版；桥会每 3 秒重试，最多等 15 分钟 |
| 电脑重启后手机打不开 | DSH 可能还没起来，或端口变了——等一会儿或重启计划任务 |
| 页面能开但很慢 | 关掉 Wi‑Fi 用蜂窝网络试试；或看 `references/tailscale.md` 里 DERP 选择 |
| 键盘弹出来输入框被挡住 | 需要浏览器的 `interactive-widget=resizes-content` 支持；Android Chrome/Edge 新版已支持 |

完整排障见 [`skill/references/troubleshooting.md`](skill/references/troubleshooting.md)。

## 目录结构

```
dsh-phone-bridge/
├─ install.ps1                  一键安装（技能 + 桥）
├─ skill/
│  ├─ SKILL.md                  DSH 技能说明（自动发现）
│  ├─ scripts/
│  │  ├─ bridge.mjs             桥本体
│  │  ├─ mobile.css             手机端适配样式
│  │  ├─ setup.ps1              安装 / 启动自检
│  │  ├─ status.ps1             状态与日志
│  │  └─ uninstall.ps1          卸载
│  └─ references/
│     ├─ architecture.md        原理与关键实现
│     ├─ tailscale.md           Tailscale 组网与打洞
│     └─ troubleshooting.md     故障排查手册
├─ LICENSE
└─ README.md
```

## 安全说明

- **口令就是钥匙**：不要发在公开群/截图里；泄露后 `setup.ps1 -Pass <新口令>` 立刻作废旧 cookie；
- 桥只放行私网与 Tailscale 来源，**不要**用路由器端口映射把它挂到公网；
- 桥能读写 DSH 的会话数据，请安装在你自己信任的电脑上；
- 30 天 cookie 到期后手机需重新带 `?k=` 打开一次。

## 已知限制

- 仅支持 Windows（用了 `netstat`、计划任务、防火墙规则）；
- DSH 升级后前端 CSS 的 hash 类名可能变化，`mobile.css` 的加宽规则可能需要跟着更新；
- 桥不缓存会话数据，只是透明转发。

## License

[MIT](LICENSE)。与 DeepSeek 官方无关，纯个人工具。

---

如果这个项目帮你省了事，给个 ⭐ 就行。
