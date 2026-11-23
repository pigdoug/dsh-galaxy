# dsh-galaxy · 银河编辑器（SC2 Galaxy Editor）插件

> **怎么用**：见 [使用手册 USAGE.md](USAGE.md)。日常只需用中文提要求，插件由 Agent 自动调用。

让 DeepSeek Harness 直接操作《星际争霸 II》银河编辑器：驱动窗口与菜单、读写地图档案、检查 Galaxy 代码，并允许 Agent **在运行中给自己定义新工具**。

## 安装

```powershell
git clone https://github.com/pigdoug/dsh-galaxy.git
```

两种放法，任选其一（插件本体不必在 C 盘，profile 只要能按包名解析到它）：

```powershell
# 方式 A：目录联接，指向克隆下来的源码目录（无需管理员，改源码即生效）
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-galaxy"
cmd /c mklink /J "$dst" "<克隆路径>\dsh-galaxy"

# 方式 B：整份复制进 profile
Copy-Item -Recurse -Force "dsh-galaxy" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-galaxy"
```

然后在 profile 的 `package.json` 里登记：

```json
{
  "dependencies": { "dsh-galaxy": "link:<克隆路径>/dsh-galaxy" },
  "dsh": { "profile": { "bundles": ["...", "dsh-galaxy"] } }
}
```

重启 DSH（或在 Plugins 页面确认已加载）。若之后跑过 `pnpm install` 把联接覆盖成普通目录，重跑方式 A 即可恢复。

依赖：Windows、`powershell.exe`（5.1 即可）、Python 3（仅 MPQ 相关工具需要；默认使用 DSH 自带的 Python）。

数据目录：`DSH_GALAXY_HOME`（默认 `%USERPROFILE%\.dsh\galaxy`），自扩展工具存在 `<data>\tools`。
临时落盘：`DSH_GALAXY_TMP`（默认 `<data>\tmp`），解包出来的 `Triggers` 等大文件写在这里。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `galaxy_status` | 探测已安装的编辑器、进程/窗口/当前文档、Python 与脚本就绪状态 |
| `galaxy_editor` | 聚焦窗口、按菜单命令名/ID 触发、发送快捷键、离屏截图、枚举窗口/对话框、等待窗口 |
| `galaxy_clipboard` | 读写 Windows 剪贴板（与 `galaxy_editor` 的按键配合，可在编辑器里粘贴/回读文本） |
| `galaxy_map_open` | 通过「文件 → 打开」对话框打开地图（Blizzard 自绘对话框，尽力而为） |
| `galaxy_map_files` | 列出 `.SC2Map` / `.SC2Mod` 内的文件 |
| `galaxy_map_read` | 读取内嵌文件（`Triggers`、`MapScript.galaxy` 等），大文件自动落盘 |
| `galaxy_map_write` | **原位**替换内嵌文件（详见下方限制），自动备份 |
| `galaxy_triggers` | 触发器摘要 / 正则搜索 / 按名称或 ID 取单个元素；名称先查 `TriggerStrings` 本地化表（触发器名、函数名其实存在那里），再回落到 `Triggers` 的 ID |
| `galaxy_lint` | Galaxy 静态检查：括号、缺 `then`、条件里误用 `=`、未定义调用 |
| `galaxy_tool` | 列出 / 定义 / 删除自定义工具；定义后立刻可用，重启后仍在 |

## 自扩展：让 Agent 自己写工具

`galaxy_tool` 接受 `{name, description, parameters, code}`，代码体会被编译成一个新工具：

```js
// 例：统计编辑器安装目录下最近改动的 10 张地图
const { statSync } = await import('node:fs');
return api.findMaps()
  .map((f) => ({ f, t: statSync(f).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, args.limit ?? 10);
```

`api` 提供：`bridge(cmd, params)`（直接调桥接）、`mpq()`（MPQ 工具）、`lint`、`summarizeTriggers`、`searchTriggers`、`installs()`、`findMaps()`、`read`、`write`、`tmp`。
定义文件存放在 `%USERPROFILE%\.dsh\galaxy\tools\<name>.json`，删除同名文件即卸载。

## 设计要点

- **桥接**：`scripts/galaxy-bridge.ps1` 常驻进程，JSON 行协议；`PostMessage` 发 `WM_COMMAND`（模态对话框不会阻塞）、`PrintWindow` 离屏截图、`AttachThreadInput` 强制置前、STA 线程操作剪贴板。
- **地图层**：`scripts/mpqtool.py` 自带 MPQ 解析（表加解密、zlib/bzip2/LZMA 逐扇区、无法解码的块原始搬运），不依赖 StormLib。
- **触发器解析**：`Triggers` 是 `Element Type="Trigger"` 元素表，33 MB 级别，必须线性扫描（正则回溯会卡死）。

## 已知限制（实测结论）

1. **写回只能原位**。编辑器（v3 档案，含加密的 BET/HET 表）会校验文件位置：任何移动块的整档重排、或把数据追加到表后，都会被拒绝（报「无法加载依赖项数据」或静默失败）。因此 `galaxy_map_write` 只覆盖原数据区并重写那一条块表记录；新内容压缩后**必须不超过**原块容量，否则返回明确错误而不是写入坏档。
   变通：在编辑器里把地图「另存为」一次，StormLib 会重写档案并腾出空间。
2. `galaxy_map_open` 依赖 Blizzard 自绘的「打开文档」对话框，自动化成功率有限；命令行传地图路径（`SC2Editor.exe "路径"`）更可靠，插件也用它兜底。
3. 触发器里的中文名不一定存在于 `Triggers`（有的地图本就没有 `Name` 节点），此时只能按 ID 定位。
