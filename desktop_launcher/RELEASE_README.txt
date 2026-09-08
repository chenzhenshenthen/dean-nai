dean-nai Windows x64
=====================

使用方法
--------

1. 完整解压 ZIP，不要只把 dean-nai.exe 单独拖出来。
2. 双击 dean-nai.exe。
3. 首次启动时在“设置”中填写自己的 NovelAI Persistent API Token。

本发布包不需要安装 Node.js 或 Python。Windows 10/11 通常已包含 Microsoft
Edge WebView2 Runtime；如果系统提示缺少 WebView2，请从 Microsoft 官方安装后重试。

数据与隐私
----------

- 数据库和资料库媒体保存在 nai-artist-library\data\。
- 桌面浏览器状态保存在 .desktop-webview\。
- 日志保存在 logs\。
- 上述目录在首次运行时创建，不包含在原始发布包中。
- 程序不会把 Token、私人资料库或生成图片上传到项目仓库。

升级与备份
----------

升级前请先在程序中创建完整 ZIP 备份。不要直接覆盖仍含个人数据的旧目录；建议解压
新版本后，再通过程序的导入/恢复功能迁移资料。

项目主页：https://github.com/chenzhenshenthen/dean-nai
许可与第三方说明见随包附带的 LICENSES.md、THIRD_PARTY_NOTICES.md 和
deanai\LICENSE。
