# Obsidian 社区插件提交准备

核验日期：2026-10-01。准备版本：`0.1.2`。当前仅完成仓库和 Release 准备，尚未提交或获批官方目录。

## 本轮调整

- 添加 MIT 许可证、README 许可说明和 Lark CLI 的第三方许可。完整声明嵌入 `main.js`，确保社区安装器单独下载运行文件时仍保留声明。
- 将最低 Obsidian 版本从未经验证的 `1.4.0` 调整为本轮官方稳定版及实际测试的 `1.13.7`；固定开发 API 类型为 `1.13.1`。API 类型包与桌面程序版本号不要求相同。
- 保持 `isDesktopOnly: true`：哈希、本地授权回调和系统文件打开使用 Node.js / Electron。
- 设置分组使用原生 `Setting.setHeading()`，删除重复的插件名称标题；打开规则文件改用公开 `FileSystemAdapter.getFullPath()` 与 Electron `shell.openPath()`，移除对内部 `app.openWithDefaultApp` 的依赖。
- 状态栏事件和自动同步定时器登记至插件生命周期；卸载时清理定时器、本机回调和状态栏引用。
- 关闭调试日志时不输出普通进度及调试信息；警告、错误只输出一次。README 明确日志可能含笔记路径及接口错误。
- 增补账户、费用、联网域名、上传内容、明文凭据、回调端口、文件访问范围及数据收集说明。
- 生产 JavaScript 保持可阅读；构建检查没有额外打包开发依赖。新增 `check:release`，检查许可证、元数据一致性及标签完全匹配。

## 验证证据和范围

- 使用锁文件干净安装后完成 `npm run package`：19 项转换测试、15 项安全测试、73 个离线端到端场景、生产包加载及临时仓库安装验证。
- 独立 ZIP 解码检查文件列表、CRC、字节内容和 SHA-256；标签 `0.1.2` 通过，错误标签 `v0.1.2` 被拒绝。
- macOS 真实宿主：独立临时配置和合成仓库运行 Obsidian **1.13.7**，Electron **34.2.0**、宿主 Node.js **20.18.2**。加载的是生产安装包，未使用真实 Work 仓库或授权配置。
- 实际验证插件加载、五条命令、八个设置分组、密钥输入遮蔽、无凭据时的提示、安全默认值、禁用时定时器清理和授权回调取消、命令移除及重新启用后的配置保留。
- 构建环境：macOS、Node.js 26.6.0。宿主的 Node.js 20.18.2 加载验证不等同于使用 Node.js 20 从源码构建；本轮未单独测试 Windows、Linux 或早于 1.13.7 的 Obsidian。
- 本轮不调用真实飞书服务，不代替真实账号的授权及在线同步验收，也不代表官方审核已通过。

## 提交时填写

| 字段 | 值 |
| --- | --- |
| Repository | `https://github.com/chenqaq123/ObsidianSync` |
| Plugin ID | `feishu-wiki-sync` |
| Name | `Feishu Wiki Sync` |
| Author | `cgx` |
| Version / Release tag | `0.1.2` |
| Minimum app version | `1.13.7` |
| Desktop only | `true` |
| License | `MIT` |

英文描述与 manifest 保持一致：

> Sync Markdown notes with a Feishu Wiki space as editable cloud documents or original Markdown files.

根据[官方提交文档](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)，登录 [Obsidian Community](https://community.obsidian.md)，绑定拥有该仓库的 GitHub 账户，在 **Plugins → New plugin** 填写仓库和所有者。确认开发者政策及维护要求后提交，根据审核页面处理反馈。设置为 Publish 后，仍需满足审核要求才能在 Obsidian 中安装。

该网站的 Obsidian 账户登录、GitHub 绑定和维护承诺需要仓库所有者操作；仓库和 Release 本身不会自动发起上架申请。目录最终以提交时的唯一性检查和审核结果为准。

## 后续发布

1. 同步更新 `manifest.json`、`package.json`、`package-lock.json` 版本；向 `versions.json` 增加新版本与最低宿主版本的对应项，不修改历史记录。
2. 执行 `npm ci`、`npm run package`、`npm run check:release -- 新版本号`，检查安装包和变更说明。
3. 提交源码与生成的 `main.js`，推送默认分支，为该提交创建与版本完全相等的标签，**不要加 `v` 前缀**。
4. 创建对应 GitHub Release，将 `dist/feishu-wiki-sync/` 下的 `main.js`、`manifest.json`、`styles.css` 分别作为附件上传；同时提供 ZIP 和 SHA256SUMS 供手动安装。
5. 已发布版本不能悄悄更换内容；修改后发布新版本。本仓库早期 `v0.1.0`、`v0.1.1` 标签保留，社区提交使用新的 `0.1.2` Release。

官方依据：[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[账户绑定与提交入口](https://docs.obsidian.md/community-directory/set-up-and-claim)、[官方稳定版版本清单](https://github.com/obsidianmd/obsidian-releases/blob/master/desktop-releases.json)。
