# dean-nai 前端

这里是 dean-nai 的 Next.js/React 前端源码。面向使用者的完整功能、安装和数据安全说明统一放在项目根目录 [`README.md`](../README.md)。

## 运行方式

开发服务器：

```powershell
npm ci
npm run dev
```

桌面静态资源：

```powershell
npm run build:desktop
```

输出到 `desktop-web-dist/`，由根目录 `dean-nai.exe` 和 Flask 本地服务读取。只修改前端时不必重新打包 exe。

常规检查：

```powershell
npm run typecheck
npm run lint
npm run build
```

当前全量 ESLint 检查仍会报告部分组件的 Effect 状态同步、Ref 使用和依赖声明问题，以及原生图片/跳转警告；这些是待整理项，不应把构建通过等同于静态检查全部通过。

## 运行环境差异

- 桌面构建设置 `NEXT_PUBLIC_LOCAL_DESKTOP=1`，启用常驻多页面工作区和本机 Flask API。
- 普通开发服务器保留 Next.js API Route，并同时连接 `127.0.0.1:5179` 的本地资料服务。

## 主要目录

| 路径 | 作用 |
| --- | --- |
| `app/` | App Router 页面、静态清单和 API Route |
| `components/sidebar/` | 生图提示词、模型、参数、角色和参考图 |
| `components/canvas/` | 流式结果、放大查看和 Director 工具 |
| `components/gallery/` | 生图页 IndexedDB 临时历史和内部回收站 |
| `components/local-gallery.tsx` | Windows 磁盘本地画廊 |
| `components/prompt-library.tsx` | 生图页中的本地资料选择器 |
| `components/external-library*.tsx` | 外置资料库完整页和生图页选择器 |
| `components/vocabulary-browser.tsx` | 标签词库 |
| `components/integrated-settings.tsx` | 桌面综合设置与便携资料入口 |
| `lib/nai/` | NovelAI 请求、模型、参数和持久化适配 |
| `lib/db/` | IndexedDB 生图历史与便携资料库 |
| `lib/store.ts` | Zustand 状态与生成生命周期 |
| `scripts/` | 桌面构建与自动验证脚本 |

源码仍保留少量 `nya-*` / `nyanovel-*` 的 localStorage、IndexedDB 和导入协议键名，用于兼容已有数据。直接改名可能导致现有 Token、设置、历史或便携资料失效。

## 数据原则

不要提交 Token、生成图片、私人资料库、`desktop-web-dist/`、`.next/` 或 `node_modules/`。这些路径已由根目录 `.gitignore` 管理。

许可证见 [`LICENSE`](LICENSE)，上游和本地改造基准见 [`../UPSTREAM.md`](../UPSTREAM.md)。
