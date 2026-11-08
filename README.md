# mokakit

> 内网灵动岛：把局域网互传、聊天、便签、音乐、快捷工具和 AI Agent 状态，都收进屏幕顶部的一颗小胶囊。

mokakit 是一款基于 Electron 的 Windows 桌面小工具。它以「灵动岛」的形态常驻屏幕顶部，展开后是一个多页签的工具面板，收起后只占一条细胶囊。

## 功能

- **内网互传**：同一局域网内自动发现设备，拖拽即可发送文件、图片，也能直接发文字；聊天式界面，支持粘贴截图、Ctrl+C 文件。
- **文件中转站**：把文件暂存到列表中，稍后一次性取用。
- **最近文件 / 最近复制**：快速找回最近用过的文件与剪贴板内容。
- **便签**：多种显示方式（卡片 / 列表 / 网格），可自定义颜色。
- **音乐播放器**：播放本地歌单，灵动岛显示滚动歌词；本地 `.lrc` 优先，缺失时在线匹配歌词，支持 `±0.5s` 手动对齐与偏移记忆。
- **快捷工具**：应用快捷启动（自动提取系统图标、拼音首字母搜索）、时钟、番茄钟。
- **AI Agent 状态**：实时显示 TRAE 与 WorkBuddy 的四种状态——🔴 正在工作 / 🟢 工作完成 / 🟡 等待批准 / ⚪️ 空闲，展开面板与收起胶囊都能看到。
- **窗口行为**：任意拖动、贴边收缩、自动收起、窗口不透明度与低内存模式。

## 安装

从 [Releases](https://github.com/wangcai-zhao/mokakit/releases/latest) 下载 `mokakit-<version>-portable.exe`，双击即可运行，无需安装、不创建桌面快捷方式。

## 自动更新

应用启动后会静默检查 GitHub Releases 上的新版本，也可以在「设置 → 关于 → 检查更新」手动触发：

1. 发现新版本 → 点「下载更新」；
2. 下载完成（带进度）→ 点「重启安装」。

下载内容会校验 SHA-512 后才安装。更新源为公开仓库的 Release，无需配置 Token。

## 开发

```bash
npm install
npm start          # 本地运行
npx electron test-ui.js   # UI 自动化测试（65 项断言）
```

打包 Windows 便携版：

```bash
npx electron-builder --win portable --x64
```

产物在 `dist/`，同时会生成 `latest.yml`（自动更新清单）。

## 发版流程

1. 修改 `package.json` 里的 `version`；
2. 重新打包；
3. 在 GitHub 创建对应的 tag Release，上传 `mokakit-<version>-portable.exe` 与 `latest.yml`；
4. 已安装的旧版本下次启动时会收到更新提示。

## 技术栈

Electron 33 · 原生 HTML/CSS/JS 渲染 · electron-updater · 局域网 UDP 广播发现 + HTTP 传输。

## 许可证

MIT
