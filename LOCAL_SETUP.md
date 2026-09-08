# 本地 dean-nai 工作台

这个目录包含两个只监听本机的程序：

- `deanai/`：参考 `https://novelai.moe/` 的 NovelAI 生图工作台。
- `nai-artist-library/`：本地画师串和场景提示词资料库。

## 启动

双击根目录的 `start-local.bat`。首次启动会执行 `npm install`，之后自动打开：

```text
http://127.0.0.1:3000
```

保持启动窗口开启。关闭窗口或按 `Ctrl+C` 会停止两个本地服务。

## 日志与故障排查

日志按日期写入根目录的 `logs/`。同一天多次启动会追加到同一个目录，并通过每行的 `run-id` 区分，例如：

```text
logs/2026-08-28/
├─ launcher.log
├─ nai-artist-library.log
├─ dean-nai-web.log
└─ dean-nai-desktop.log
```

`logs/latest-session.txt` 始终记录当天日志目录。PID 和退出码位于被 Git 忽略的 `.runtime/`，启动结束后自动清理。服务异常退出时，启动窗口会显示两个后台任务的状态、退出码以及两份服务日志的最后 80 行；Flask 写到 stderr 的普通开发服务器警告只会被记录，不再导致启动器在读取日志时二次报错。

服务日志同时包含浏览器端未捕获的 JavaScript/Promise 异常，以及脱敏后的 Token 验证、生成和保存事件。不记录 Token、完整 Prompt 或图片内容。日志默认保留 30 天，可在“设置 → 日志与数据”修改，下一次启动时生效。

需要实时查看时，可在另一个 PowerShell 窗口运行：

```powershell
$latest = Get-Content -Raw .\logs\latest-session.txt
Get-Content -Wait (Join-Path $latest "dean-nai-web.log")
```

首次打开工作台时，在连接窗口填入 NovelAI 的 Persistent API Token（通常以 `pst-` 开头），Host 保持默认的：

```text
https://image.novelai.net
```

Token 只存放在当前浏览器的 localStorage 中，不要写进源码、`.env` 或截图。

## 使用本地资料库

在左侧 `Prompt` 标题旁点击“资料库”：

1. 在“画师串”和“场景”之间切换。
2. 搜索标题、Prompt 或标签。
3. 点击卡片后，画师条目替换“画师串”，场景条目替换“场景提示词”，资料库窗口自动关闭。
4. 画师卡片带有负面提示词时，可以选择是否一并替换当前负面提示词。
5. “待用”用于角色、动作、服装等自由编辑内容；返回输入框继续修改，再生成图片。

最终提交给 NovelAI 的正向 Prompt 顺序固定为：

```text
画师串 → 待用 → 场景提示词
```

负面提示词单独提交。Sampling、Quality、Guidance、参考图等较少改动的设置位于 `Advanced`。

“管理”按钮会打开原资料库页面 `http://127.0.0.1:5179`，可继续维护条目和示例图。

## 开发

前端源码位于 `deanai/`。常用命令：

```powershell
cd deanai
npm run dev
npm run typecheck
npm run lint
npm run build
```

本地资料库地址默认固定为 `http://127.0.0.1:5179`。如确实需要修改，可在启动 dean-nai 前设置：

```powershell
$env:NAI_LIBRARY_URL = "http://127.0.0.1:5179"
```

自定义生图反代默认关闭。只有显式设置 `NYANOVEL_PROXY_TARGET` 时，服务端代理才允许转发到完全相同的目标 URL；直接使用 NovelAI 官方 Host 不需要该变量。
