---
name: stock
description: 维护 SlackTrader Windows 股票浮窗项目，处理分时与盘口界面、在线更新确认、签名打包、GitHub Release 命名与附件精简、覆盖安装数据保留和发布验证。用于用户要求修改、构建、发布或排查该项目更新流程时。
---

# SlackTrader 开发、发布与在线更新

## 确认任务边界与现状

- 在当前工作区定位 `package.json`、`src-tauri/tauri.conf.json` 和 Git remote；常用项目目录是 `D:/GPP`，迁移机器后以实际工作区为准。
- 区分“修改代码”“提交源码”“发布可下载版本”。用户要求发布版本时，完成安装包与 Release，不只推送 main；只要求本地修改时，不推送。
- 先记录 Git 状态与现有改动，备份待修改文件及哈希。保留用户的未提交修改、持仓、配色和窗口位置。
- 用户未要求操作桌面时，使用终端、GitHub API 和隔离无头浏览器，不操纵用户屏幕或运行真实安装向导。

## 项目约定

- 公共标题使用 `SlackTrader v0.x`，Git 标签使用 `v0.x`；软件内部、Cargo、Tauri 配置和更新清单使用 `0.x.0`。新版本递增 x，勿用旧版本号替换不同二进制。
- 同步 `package.json`、`package-lock.json`（含根 package）、`src-tauri/Cargo.toml`、`Cargo.lock` 中的应用包版本，以及 `tauri.conf.json`。README 显示公共版本。
- 应用标识保持 `com.bluetoothassistant.desktop`。覆盖安装沿用原目录，不清空 WebView2 数据。便携版更新动作打开的是安装版向导，不会原地替换任意位置的便携 EXE。
- 保持小窗紧凑、配色可调、不置顶、非更新场景不加悬停提示。行情错误保留真实状态，不填虚构价格或成交记录。

## 更新交互与网络

- 入口为 `src/updatePanel.ts`；`src/updater.ts` 管理检查、下载、校验、安装状态；`src/updatePrompt.ts` 管理确认及“稍后”的去重。
- 启动后检查、设置中手动检查；发现新版自动询问。稍后不下载，同版不反复自动提醒；手动检查可再次询问。检查失败不触发新版本弹窗。
- 只有确认后才下载。使用 Tauri updater 的原生签名校验；下载 Promise 成功后才调用安装，不把 Finished 事件当作校验通过。
- 原生命令 `check_app_update` 使用固定可信更新配置，自动模式先直连、失败再尝试系统代理，每路有限超时；不修改系统代理。新建的更新资源交给官方 updater 下载和安装命令。
- 更新失败分别提示超时、连接失败、清单缺失、格式异常及平台缺失；错误不冒充“已是最新”。保留可重试操作，锁住重复弹窗和重复安装。
- 网络诊断先对固定 `releases/latest/download/latest.json` 做完整 GET（跟随跳转），分别测试直连与系统代理。API、Git 传输和附件 CDN 的连通性可能不同；不要写死个人代理地址，也不要关闭 TLS 校验。

## 最小公开附件

只上传 `scripts/release-utils.mjs` 的 `publicAssets()` / 构建输出 `upload-assets.json` 指定的三项：

1. `SlackTrader-v0.x-Setup-x64.exe`
2. `SlackTrader-v0.x-Portable-x64.exe`
3. `latest.json`

- `latest.json` 保存内部版本、安装地址和完整签名内容。它是自动更新必需项。
- 独立 `.exe.sig`、`SHA256SUMS.txt`、本地 Source.zip、日志和验证截图留在本地；签名私钥始终排除。
- GitHub 自动生成 Source code (zip/tar.gz)，不是手动上传的冗余附件。使用对应标签下载源码。
- 清理既有附件前记录 ID、名称、哈希并备份；确认签名已经嵌入清单后再移除独立签名文件，保留所有仍需使用的更新清单。

## 签名构建与发布顺序

- 复用已发布客户端信任的公钥／私钥对，勿临时重生成。私钥来自环境 `TAURI_SIGNING_PRIVATE_KEY` 或本机 `%LOCALAPPDATA%/SlackTrader/signing/updater.key`；不打印、不提交、不放入公开 ZIP。
- 修改后执行测试和前端构建，再执行签名发布构建；系统可执行文件使用 Windows GUI 子系统，避免启动黑窗口。

```powershell
npm test
npm run build
npm run release:build -- --tag v0.7 --notes release-notes.md
```

上述例子要求内部版本已经统一为 `0.7.0`；以用户指定且尚未发布的实际版本替换。

- 核对安装 EXE、便携 EXE、内嵌签名、清单下载路径及源码对应关系。`verify-update` 使用与客户端一致的签名验证器，并测试篡改被拒绝。
- 获准发布后提交源码并创建对应标签，核对远程主分支和标签。先创建 Draft Release，再上传这三个资产，清单最后上传，验证后公开为 Latest。
- 首次启用 GitHub Actions 构建需维护者配置匹配的签名 Secret；已通过本机构建且附件完整时，工作流可跳过重复构建。不要未经确认更换远程私钥或宣称 Secret 已配置。
- API 上传中断时先重读 Draft ID 和资产列表，按名称、大小、摘要恢复；不盲目重复建 Release 或覆盖不同内容。认证信息只发给固定 GitHub API / upload 主机，公开下载不带认证头。

## 分层验证与交付

- 单元测试覆盖：有／无新版本、取消、同版去重、手动重问、失败重试、并发防重、异常清单、签名失败不安装和版本命名。
- 无头 UI 测试覆盖：小窗／隐藏状态发现更新、确认、进度、错误重试、无注入的说明文本及持仓／配色不变；用隔离上下文和模拟对话框、安装调用，避免实际操作桌面。
- 真实网络检查使用 `update-probe`；旧版本视角检查到新版本后下载并进行原生签名校验，同版本视角应显示 current。

```powershell
cargo run --release --features tauri/custom-protocol --example update-probe -- 0.6.0 direct D:/GPP/artifacts/probe-update.exe
```

将版本、路径替换为实际测试输入。探针不创建窗口、不调用 install；真实安装需另行得到用户允许并使用适当隔离环境。分别报告模拟交互、真实下载校验和实际安装的验证结果，不把前两者描述成已完成覆盖安装。

- 发布后通过公开地址核对 Latest 清单、附件名称和摘要，重新下载关键附件比较哈希。核对工作流状态、README 与 Release 一致。
- 提供 Release 链接、本地可直接运行 EXE 路径和验证摘要。保留原文件哈希、差异、验证记录及已在隔离副本测试的回滚脚本。
- 本文件是可导出的技能正文；个人技能发现入口为用户技能目录下 `stock/SKILL.md`。更新内容时同步两份，并验证 UTF-8 无 BOM、frontmatter 与 UI 元数据。
