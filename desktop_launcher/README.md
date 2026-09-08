# dean-nai Windows 启动器

`desktop_launcher/` 负责把当前项目目录中的 Flask 服务和 `deanai/desktop-web-dist` 打开为一个 pywebview 桌面程序。

根目录 `dean-nai.exe` 是项目本地启动器，不是包含前端、Python 服务和私人数据库的独立安装包。它必须与当前源码目录配套使用。从 Git 首次获取源码时需要构建；复制完整程序目录到另一台 Windows 电脑时，通常可沿用 exe，但仍须安装 Python、后端依赖及 WebView2 运行环境。

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

运行时只监听 `127.0.0.1:5179`。Flask 同时提供桌面静态页面、本地资料库、外置资料库、标签词库、本地画廊、在线画廊、设置和导出 API；pywebview 直接打开这个本机 HTTP Origin，使浏览器存储在多次启动之间保持稳定。

`start-local.bat` 是独立的浏览器开发启动方式，桌面 exe 不会调用它。

更多说明见项目根目录 [`README.md`](../README.md)。
