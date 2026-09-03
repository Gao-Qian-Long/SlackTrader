# 发布与应用内升级

## 用户侧

- 启动约 5 秒后检查 GitHub 正式版本，之后每 6 小时检查；设置中可手动检查。
- 提醒只出现在展开的软件窗口内，不使用桌面通知、托盘悬停提示，也不会自动展开窗口。
- 点击“下载并安装”才会下载。原生更新组件校验签名后打开可交互的 Windows 安装向导；成功打开向导时软件退出。完成安装后重新打开软件。
- 下载、签名校验或安装向导启动失败时保持当前版本，允许重试。GitHub 访问失败或缺少更新清单不等于“已是最新”。
- 覆盖安装使用相同应用标识和原安装位置；持仓、成本、配色、窗口位置仍保存在原 WebView2 数据目录。请勿在升级前卸载并删除应用数据，也不要手动清空该目录。
- 较早版本尚未包含更新组件，需要手动覆盖安装一次本功能版本。便携版也可检查更新，但“下载并安装”安装的是安装版，不会替换任意目录的便携 EXE；继续便携使用可自行下载新版便携 EXE。

## 首次准备签名

更新包采用 Tauri 官方 updater 的签名校验。配置内保存公钥，私钥只保存在本机或 GitHub Actions Secret 中。已有发布密钥应持续复用，丢失或更换私钥后旧客户端将拒绝新签名。

首次为新项目初始化（已有密钥时跳过）：

```powershell
$keyDir = Join-Path $env:LOCALAPPDATA 'SlackTrader\signing'
New-Item -ItemType Directory -Force $keyDir | Out-Null
npm run tauri signer generate -- --ci -w (Join-Path $keyDir 'updater.key')
```

将 `updater.key.pub` 的完整内容填写到 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。不要把私钥或生成日志提交到仓库。请另外妥善备份私钥。

## 本机构建和发布

1. 将 `package.json`、`package-lock.json` 的版本（含 `packages[""].version`）、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的应用包版本，以及 `src-tauri/tauri.conf.json` 同步更新为更高的内部三段版本号 `0.x.0`。对外标题统一为 `SlackTrader v0.x`，Git 标签和附件名统一使用 `v0.x`；例如内部 `0.5.0` 对应 `v0.5`，下一版使用 `0.6.0` / `v0.6`。
2. 执行测试和签名构建。脚本优先读取 `TAURI_SIGNING_PRIVATE_KEY`，否则读取本机 `%LOCALAPPDATA%\SlackTrader\signing\updater.key`。有密码的密钥同时设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

```powershell
npm ci
npm test
npm run release:build
# 可选：显式核对 tag 并写入更新说明（版本须已同步）
npm run release:build -- --tag v0.5 --notes release-notes.md
```

3. `release/v0.x/` 生成六个发布资产：安装 EXE、对应 `.exe.sig`、便携 EXE、源码 ZIP、`latest.json`、`SHA256SUMS.txt`。源码 ZIP 包含当前工作区源文件，不含签名私钥、用户数据及构建缓存。
4. 在 GitHub 创建同名 `v0.x` 的正式 Release，上传这六个文件，并将它设为 Latest。`latest.json` 应最后上传，避免清单先出现而安装包尚未上传。

更新入口固定为：

`https://github.com/Gao-Qian-Long/SlackTrader/releases/latest/download/latest.json`

清单的 `version` 必须高于已安装版本；`platforms.windows-x86_64.signature` 是签名文件的内容，不是文件链接。不要只上传 EXE，也不要把开发包用原版本号冒充新版。构建脚本使用与客户端一致的验证器检查签名，并测试被篡改的字节会被拒绝。

## GitHub Actions 自动发布附件

仓库包含 `.github/workflows/release.yml`，正式 Release 发布后构建并上传上述资产，也支持输入已有 tag 手动运行。首次启用前由仓库维护者在 Settings → Secrets and variables → Actions 添加：

- `TAURI_SIGNING_PRIVATE_KEY`：与已安装客户端公钥对应的私钥文件完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：密钥密码；无密码时留空。

工作流与源文件必须已进入发布 tag，tag 使用 `v0.x`，必须匹配代码中的内部版本 `0.x.0`。更新清单的 `version` 仍使用三段版本号，以满足客户端版本比较。发布后等待工作流成功，用户才能检测到完整更新。GitHub 网络访问及 WebView2 环境仍会影响检查、下载和安装。

本地构建不会自动提交代码、推送 tag、上传附件或配置远程 Secret。

参考：[Tauri 官方更新组件](https://v2.tauri.app/plugin/updater/)。
