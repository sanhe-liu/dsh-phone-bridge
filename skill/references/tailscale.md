# Tailscale：出门也能访问家里的电脑

家里的 Wi‑Fi 直连就够了；一旦出门、用手机流量，就需要一条"回家"的隧道。
Tailscale 基于 WireGuard，免费个人版够用，而且对国内网络比较友好（打洞失败会走香港/东京中继）。

## 一次性配置

### 1. 电脑（Windows）

```powershell
winget install --id Tailscale.Tailscale -e
```

装不上、或者官网/商店打不开时，直接下官方 MSI：

```
https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi
```

安装完托盘会出现 Tailscale 图标。**当前用户不是管理员也能装**，但安装服务需要 UAC 确认。

### 2. 手机

- Android：应用商店搜 Tailscale；或直连官方 APK：
  `https://pkgs.tailscale.com/stable/tailscale-android-universal-<版本>.apk`
  （桥的 `apk/` 目录可以放这个文件，装好后从 `/apk/文件名.apk` 直接下载安装）
- iOS：App Store 搜 Tailscale。

### 3. 登录同一个账号

电脑托盘 → **Sign in**（推荐 Microsoft，最快；Google/GitHub 也行）。
手机 App → 登录**同一个账号**。

两端都登录后：

```powershell
tailscale status
# 100.94.80.64   desktop-xxxx   you@        windows  -
# 100.94.210.80  redmi-k60      you@        android  -
```

- 电脑的 `100.x` 地址：托盘图标悬停提示、`tailscale ip -4`、或手机 App 的机器列表；
- 手机打开 `http://<电脑 100.x>:8090/?k=<口令>` 即可。

桥默认放行 `100.64.0.0/10` 与 `fd7a:115c:a1e0::/48`，装完就能用，不需要改任何配置。

## 直连还是中继？

```powershell
tailscale status        # 最后一列 relay= 就是走的 DERP 中继
tailscale netcheck      # UDP 是否可用、到各 DERP 的延迟
tailscale ping 100.x.y.z
```

实测参考：国内家宽到香港 DERP 约 78ms、东京 87ms、洛杉矶约 189ms。
直连（局域网或打洞成功）延迟 <10ms，体验和家里 Wi‑Fi 一样。

如果一直走中继且延迟很高：

1. `tailscale netcheck` 看 `UDP: false` → 运营商/公司网络拦了 UDP，Tailscale 会退到 443/TCP，能连但慢；
2. 公司 Wi‑Fi 拦截时，用手机流量试；
3. 家里路由器开了 UPnP 会更容易打洞成功（小米路由器默认开）。

## 常见问题

**登录窗口打不开 / 一直转圈**
用浏览器登录 `https://login.tailscale.com` 后再回托盘；或换 Microsoft 账号登录。

**电脑装了但 `tailscale status` 报 Access denied**
非管理员会话读不了 `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`。
开一个管理员 PowerShell 再执行，或者直接看托盘提示。

**手机 App 显示电脑离线**
电脑休眠/睡眠会断（见 `troubleshooting.md` 里关睡眠的 powercfg 命令）；也可能是 Tailscale 服务没起来：
`Get-Service Tailscale` 应为 `Running`，不是就 `Start-Service Tailscale`（需管理员）。

**100.x 地址能 ping 通但网页打不开**
防火墙没放行。桥安装脚本会建规则 `DSH Phone Bridge (TCP 8090)`；
确认它的 Profiles 包含 `Private`（Tailscale 网卡被 Windows 归为专用网络）。

**能否用 Cloudflare Tunnel 代替 Tailscale？**
可以，桥也放行 Cloudflare 隧道来源（带 `cf-connecting-ip` 头）。
但实测临时隧道出口在洛杉矶，单请求往返 400~600ms，比 Tailscale 直连/香港中继慢一个量级，只适合临时应急。
