# 排障手册

按"从哪一步开始查"组织。所有命令在 PowerShell 里执行。

## 0. 先看状态

```powershell
powershell -ExecutionPolicy Bypass -File .\skill\scripts\status.ps1
```

它一口气告诉你：计划任务在不在跑、端口有没有监听、`bridge.pid`、手机地址、Tailscale 地址、两份日志的尾部。
90% 的问题看这一屏就能定位。

## 1. 手机打不开页面

| 检查 | 命令 / 动作 | 正常表现 |
| --- | --- | --- |
| 桥在跑吗 | `Get-NetTCPConnection -LocalPort 8090 -State Listen` | 有 `Listen`（PID 是 node） |
| 计划任务 | `Get-ScheduledTask DSH-Phone-Bridge` | `Ready` 或 `Running` |
| 电脑地址 | `ipconfig` / `status.ps1` | 手机能 ping 通 192.168.x.x 或 100.x |
| 防火墙 | `Get-NetFirewallRule -DisplayName 'DSH Phone Bridge*'` | `Enabled: True`，Profile 含 Private |
| 同一网络 | 手机 Wi‑Fi 是否和电脑同一路由器；出门是否两端都登了 Tailscale | — |

桥没在跑就先手动拉起来看报错：

```powershell
Start-ScheduledTask DSH-Phone-Bridge
Get-Content "$env:USERPROFILE\.dsh\phone-bridge\bridge.err.log" -Tail 20
```

想直接看实时输出（不隐藏窗口）：

```powershell
cd "$env:USERPROFILE\.dsh\phone-bridge"
node bridge.mjs --port 8090
```

## 2. 能连上，但页面 403 / 401

- **403 `只允许局域网或 Tailscale 访问`**：来源 IP 不在白名单。常见于用公网 IP、别人家的网络直连。
  换局域网地址，或两端登 Tailscale 用 `100.x`。
- **401 / 一直要口令**：地址里的 `?k=` 要完整；口令在 `bridge.pass.txt`。
  手机浏览器清掉该站点 cookie 后，重新打开带 `?k=` 的地址。
- **429 / 页面提示锁定**：口令错 5 次锁 15 分钟。等 15 分钟，或改口令：
  `setup.ps1 -Pass <新口令>`，旧 cookie 立即失效。

## 3. 报「找不到正在运行的 DSH Web 服务」

桥启动时没探测到 DSH。处理顺序：

1. 先打开 DSH 桌面版，等界面出来；
2. 桥会在 **15 分钟内每 3 秒重试**，自己会连上（不用重启桥）；
3. 还不行就看 DSH 到底在哪个端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object OwningProcess -in (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue).Id
```

拿到端口可以写死：`node bridge.mjs --port 8090 --dsh-port 50694`。

## 4. 电脑重启后手机打不开

开机时桥（计划任务/启动项）常常比 DSH 先起来，桥会等 DSH —— 这属于正常情况，等 1~2 分钟。
如果一直等不到：

1. `status.ps1` 看 DSH 是否真的启动；
2. DSH 端口变了不用管，桥自动重探；
3. 计划任务被安全软件拦了：手动 `Start-ScheduledTask DSH-Phone-Bridge`。

**电脑睡眠会断网**。建议关掉空闲睡眠：

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

## 5. 打开了，但样式没变化 / 还是很窄

- 手机浏览器强制刷新（下拉刷新一般不够，试试关标签页重开；或清站点数据）；
- 确认 HTML 里注入了新版本：DevTools 里搜 `__mobile.css?v=`，应为 v=3；
- **DSH 升级后**前端 hash 类名会变，`mobile.css` 的规则可能失效。查新类名：

```powershell
# 在电脑上直接看 DSH 的 HTML
curl "http://127.0.0.1:<DSH端口>/" -Headers @{ 'Host' = '127.0.0.1' }
```

把 `an3WzG_body` / `V4vHZW_column` / `GRgSLq_card` / `mP3x-q_frame` 等换成新名字即可。

## 6. 键盘弹出时输入框还是被挡住

根因是浏览器对 `interactive-widget=resizes-content` 的支持。Android Chrome/Edge 新版默认支持；
旧浏览器会退化成"键盘盖住布局底部"。确认 HTML 里有两个 viewport meta，且**后一个**带 `interactive-widget`。
仍不行就升级浏览器。

## 7. 页面很慢

```powershell
tailscale status     # 看 relay= 是直连还是 hkg/tok/lax 中继
tailscale netcheck   # UDP 是否可用
```

- 局域网还慢：检查是不是走了 Cloudflare 隧道（换回 `http://192.168.x.x:8090`）；
- 4G 慢：中继在境外。香港 DERP 约 78ms、东京 87ms 属正常；洛杉矶 189ms 以上就明显卡；
- 首屏慢是 JS 包大（1MB+），桥已 gzip 到 ~330KB 并长缓存；第二次打开应该快很多。

## 8. 口令泄露 / 忘记口令

```powershell
# 换口令（旧 cookie 立即失效）
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1 -Pass '<新口令>'
```

忘了口令：直接看 `%USERPROFILE%\.dsh\phone-bridge\bridge.pass.txt`。

## 9. 端口被占用

`setup.ps1` 会检测并提示。换端口：

```powershell
powershell -ExecutionPolicy Bypass -File .\skill\scripts\setup.ps1 -Port 8091
```

别忘了同步防火墙（脚本会自动加）和手机上的地址。

## 10. 给贡献者的坑

- **PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM**，BOM 会让 CSS 整段失效、让 `JSON.parse` 报
  `Unexpected token ''`。写文本文件用 `[IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。
- 计划任务里 `wscript.exe` 启动的进程在终端工具调用结束时可能被一起回收——手动验证时用 `Start-Process` 起
  `node bridge.mjs` 更稳。
- 桥在 `?k=` 命中时返回 **303 重定向**。用 `curl -o` 直接取会得到 0 字节，要加 `-L -c cookies -b cookies`。
