# dean-nai Windows 启动器

`desktop_launcher/` 负责把当前项目目录中的 Flask 服务和 `deanai/desktop-web-dist` 打开为一个 pywebview 桌面程序。

公开发布 ZIP 包含桌面启动器、内置 Python 后端和 `desktop-web-dist`，用户完整解压后即可运行，不需要自行安装 Python 或 Node.js。根目录单独生成的 `dean-nai.exe` 仍只是启动器，不能离开配套目录独立工作。

完整构建：

```powershell
python -m pip install -r nai-artist-library\requirements.txt
python -m pip install -r desktop_launcher\requirements.txt
cd deanai
npm ci
cd ..
powershell -ExecutionPolicy Bypass -File desktop_launcher\build-desktop.ps1
```

如果 `deanai/desktop-web-dist` 已经是最新版本，只重新打包启动器：

```powershell
powershell -ExecutionPolicy Bypass -File desktop_launcher\build-desktop.ps1 -SkipWebBuild
```

构建结果：

```text
dean-nai.exe
```

构建完整 Windows x64 发布包：

```powershell
powershell -ExecutionPolicy Bypass -File desktop_launcher\build-release.ps1 -Version v2.0.0-preview.2
```

输出位于 `release-dist/`，包括发布 ZIP 和对应的 SHA-256 校验文件。发布包不包含数据库、图片、Token、日志、缓存或其他私人资料。

运行时只监听 `127.0.0.1:5179`。Flask 同时提供桌面静态页面、本地资料库、外置资料库、标签词库、本地画廊、在线画廊、设置和导出 API；pywebview 直接打开这个本机 HTTP Origin，使浏览器存储在多次启动之间保持稳定。

源码目录没有内置后端 exe 时，启动器仍会使用系统 Python 运行后端；公开发布包则优先使用随包附带的后端 exe。`start-local.bat` 是独立的浏览器开发启动方式，桌面 exe 不会调用它。

更多说明见项目根目录 [`README.md`](../README.md)。
