# Game Memories · 游戏回忆

<img src="src-tauri/icons/icon.png" width="112" height="112" alt="Game Memories 应用图标">

**把 Steam 截图与评价、Nintendo Switch 2 截图与视频，整理成自己的 Obsidian 游戏回忆。**

一个桌面应用，按游戏归档，按日期回看。打开应用、选择平台、点击「开始同步」，程序寻找新增内容并去重；已有笔记和手写感想继续保留。

## 可以保存什么

| | Steam | Nintendo Switch 2 |
|---|---|---|
| 内容来源 | 自己公开发布的截图动态 | 已上传到 Nintendo Switch App 的账号云相册 |
| 归档内容 | 截图、评价文字、发布时间 | 截图、视频、原始拍摄时间 |
| 游戏信息 | 游戏名、appid、商店横版封面；可选累计游玩时长 | 游戏名、游戏标识；支持补选本地游戏海报 |
| 回忆文字 | 保留 Steam 截图原有评价 | 在 Obsidian 的右侧感想区自己补写 |
| 日常同步 | 从最新截图页寻找新增内容 | 读取当前云相册，只归档新增内容 |

每款游戏一份 Markdown 笔记，媒体与海报保存在本地。Switch 布局为左侧截图／视频、右侧「我的感想」；已启用 Dataview JavaScript 的仓库可直接使用独立输入框，未启用的仓库使用普通 Markdown 编辑。

当前版本 **0.2.1**。项目原名 `steam-experience-sync`；原配置、账号授权、内部应用标识和去重状态保留兼容。

## 安装与开始使用

### Apple Silicon Mac

目前提供 M 系列芯片、macOS 13.5 或更新系统的安装包，包内自带 Node 和 Switch 相册客户端。

1. 打开 [Mac 构建页面](https://github.com/YQM1989/game-memories/actions/workflows/build-macos.yml)，选择最近一次成功的 `Build Apple Silicon Mac App`。
2. 下载 `Game-Memories-macOS-arm64` 附件，解压得到 `.dmg`。
3. 打开 `.dmg`，把 `Game Memories.app` 拖到「应用程序」，然后启动。
4. 在应用 Settings 中填写 **Obsidian 仓库根目录**，例如 `/Users/你的用户名/Documents/YQM-Obsidian`，再设置需要同步的平台。

安装包目前采用 ad-hoc 签名，尚未经过 Apple Developer ID 签名和公证；首次打开可能受到 macOS 拦截。确认下载来源后，可按「系统设置 → 隐私与安全性」中的提示允许打开。[Tauri 签名说明](https://v2.tauri.app/distribute/sign/macos/)

### Steam

在 Steam → Settings 填写 Steam ID；API Key 可留空，只用于补充累计游玩时长。保存后在 Dashboard 点击「开始同步」。程序检查最新公开截图动态，处理当前新增内容后退出。

需要补录较早截图、预览写入或使用命令行时，见 [Steam 使用说明](docs/steam-experience.md)。

### Switch 2

1. 切换到 Switch 2 → Settings，确认 Obsidian 仓库及保存目录。
2. 阅读并同意第三方认证的数据流向，完成一次 Nintendo 官方网页授权。复制官方「使用此账号」按钮的链接到应用中完成连接。
3. 在 Dashboard 点击「开始同步」，读取当前云相册并归档新增截图／视频。
4. 在 Obsidian 对应游戏笔记里补写感想；需要左右布局时点击 Settings 中的「安装 Obsidian 左右布局」。

相册客户端在应用后台按需启动并退出，日常同步只需打开 Game Memories。最终流程无需单独启动 nxapi 窗口或登录 Discord。已有账号授权可继续使用；「扫描相册」是可选查看步骤。

独立感想区支持离开输入框保存、保存按钮及 ⌘/Ctrl+Enter。再次同步会保留已写文字；相同游戏、拍摄时间、类型及内容的重复上传会合并显示，并保留来源标识。新游戏的海报可在游戏列表中选择本地 JPG／PNG。

误触保存的素材可点击「删除这条记录」并确认，移到笔记底部折叠的「已删除记录」。可从那里恢复；后续同步会跳过已删除项。删除操作保留原始附件与感想，不修改 Nintendo 云相册。

详见 [Switch 使用说明](docs/switch-experience.md) 和 [nxapi 接入复盘](docs/nxapi-integration-notes.md)。授权链接、令牌和配置文件应留在本机。

### Windows 与 Intel Mac

Steam 命令行可在 Windows／macOS 使用，桌面源码保留 Windows 构建入口。**Switch 的 Windows 账号存储桥接及新版安装包尚未完成适配和实机验证。** Intel Mac 暂未提供安装包。

## Obsidian 中的记录

默认笔记目录：

```text
<Obsidian 仓库>/00_输入源/50_我是谁/
├── Steam体验记录/
│   └── <游戏名>.md
└── Switch体验记录/
    └── <游戏名>.md
```

日期作为游戏笔记中的分段。Switch 媒体和海报默认放在 `附件/Switch体验记录/`，感想保存于所属游戏笔记的独立属性；同步状态保存在 `.obsidian/steam-experience-sync/` 和 `.obsidian/switch-experience-sync/`。

源码、安装包和运行依赖留在项目目录中。每台设备分别设置自己的 Obsidian 路径；跨端共享状态和并发同步尚未实机验证，日常使用应由一台设备执行同步。

## 获取范围与账号安全

- Steam 读取公开截图页面，截图同步不依赖 API Key。私密或好友可见内容不在当前范围；程序没有复用 Steam Cookie 或网页登录态。
- Switch 读取已经上传的云相册，主机中尚未上传的素材无法从此接口取得。即使按按钮执行一次，也需要完成账号认证及相册协议处理。
- Switch 使用第三方 **nxapi 远程认证及加解密服务**，该服务会处理 Nintendo 令牌、部分账号资料和相册数据。媒体文件从 Nintendo 返回的 CDN 地址下载。完整数据流向见 [Switch 使用说明](docs/switch-experience.md#凭据与数据流向)。
- Mac 的 Nintendo 凭据由钥匙串保存；关闭上游账号文件缓存及原始调试日志，收窄未使用的相册附带请求。错误提示保留脱敏阶段与已知错误代号。
- Steam API Key 保存在当前用户的本机配置中，不写入笔记。Mac 配置位置为 `~/Library/Application Support/com.yqm.steam-experience-sync/config.json`；请勿分享该文件。
- 遇到限流按冷却处理；停止、超时或认证失败会结束当前流程。

## 开发与构建

桌面应用使用 **React + Tauri**，与命令行共用 Node 同步核心。以下步骤面向开发者，安装用户直接使用上面的应用包即可。

```bash
git clone https://github.com/YQM1989/game-memories.git
cd game-memories
npm ci
npm run switch:prepare
npm run tauri:dev
```

开发环境需要 Node.js 24、Rust 和对应系统的 Tauri 构建工具。[Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)

Apple Silicon Mac 打包使用官方独立 arm64 Node.js 24，并将运行时和固定 nxapi 发布客户端打入应用：

```bash
npm run desktop:prepare
npm test
npm run test:ui
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri:build
npm run desktop:verify-mac
```

构建产物位于 `src-tauri/target/release/bundle/`。开发配置为项目内 `.steam-experience-sync/config.json`，与安装版配置分开；打包范围不包含真实 `.env`、账号凭据、个人笔记和相册素材。

Switch 客户端通过 `npm run switch:prepare` 按独立锁文件准备。原 Steam CLI、worker 及本地网页 GUI 继续保留，命令和历史补录策略见 [Steam 使用说明](docs/steam-experience.md)。

## 已验证结果与当前限制

- Mac 安装版已完成真实云相册导入及桌面一键重复同步验证，已有笔记、媒体和感想保持。
- 核心、界面与 Rust 测试，以及 Mac 自动打包、包内运行环境和签名检查已通过。具体版本结果见 [改动说明](CHANGELOG.md)。
- Windows Switch 账号桥接、新版安装包、跨设备同步和长期增量使用尚未实机验证。
- 新游戏自动匹配海报尚未实现，当前提供本地海报选择入口。

## 许可证与第三方组件

原项目 MIT 许可见 [LICENSE](LICENSE)。nxapi 发布客户端及 `src/switch/nxapi-preload.mjs` 存储适配文件使用 **AGPL-3.0-or-later**；根目录 MIT 许可不覆盖这些组件。许可全文、固定版本和对应源码位置见 [第三方说明](docs/THIRD-PARTY-NOTICES-SWITCH.txt) 及 [AGPL 全文](docs/NXAPI-AGPL-LICENSE.txt)。

仓库包含本项目集成与适配源码；依赖目录、凭据及真实相册不提交。公开组合安装包需核对对应源码与许可证要求，子进程方式不构成免除这些要求的依据。
