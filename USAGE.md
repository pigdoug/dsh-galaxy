# 银河编辑器插件 · 使用手册

> 一句话：**你不需要记命令。** 插件把能力挂在我身上，你像平时一样用中文提要求，我会自己挑工具、自己核对结果。

---

## 0. 生效条件

插件装好后由 profile 里的 `dsh-galaxy` 包名加载，运行数据默认在 `%USERPROFILE%\.dsh\galaxy`（可用 `DSH_GALAXY_HOME` 覆盖）。

- **重启一次 DSH（或新开会话）**，才会加载最新代码与新数据目录。
- 确认方式（任选其一）：
  1. 侧边栏 **插件** 页面里能看到 `dsh-galaxy`；
  2. 直接问我一句「银河编辑器装好了吗」，我会调用 `galaxy_status` 回答。
- 不需要你在编辑器里装任何东西，也不需要开 SC2 游戏本体。

---

## 1. 三个最常用的开场

```
看一下银河编辑器现在的状态，截个图给我
```
```
帮我看看 D:\StarCraft II\Mods\...\2026.11.2.SC2Map 里触发器有多少个，
找出名字里带 Ranking 的函数
```
```
把这张图的 MapScript.galaxy 读出来，检查一下有没有语法问题
```

我会返回结论 + 证据（截图路径、命中的行号、触发器 ID），而不是让你自己去点菜单。

---

## 2. 能力对照表

| 你想做的事 | 我会用的工具 | 返回什么 |
| --- | --- | --- |
| 编辑器装了没 / 开着没 / 当前是哪张图 | `galaxy_status` | 安装路径、进程号、窗口标题、当前文档 |
| 看一眼编辑器界面 | `galaxy_editor` `action=screenshot` | PNG 路径（离屏抓取，被遮挡也能抓） |
| 打开某张地图 | `galaxy_map_open` | `opened`、标题、打开方式 |
| 地图里有哪些文件 | `galaxy_map_files` | 文件清单（可过滤） |
| 读出 `Triggers` / `MapScript.galaxy` | `galaxy_map_read` | 文本；超大文件自动落盘给路径 |
| 触发器统计 / 搜索 / 按名字取内容 | `galaxy_triggers` | 数量、最大触发器、命中项、元素 XML |
| 检查 Galaxy 语法 | `galaxy_lint` | 错误/警告 + 行号 |
| 把改好的文件写回地图 | `galaxy_map_write` | 写入模式、备份路径、容量 |
| 读写剪贴板（配合编辑器） | `galaxy_clipboard` | 文本 |
| 让插件多一个新手艺 | `galaxy_tool` | 新工具名，立刻可用 |

---

## 3. 典型工作流

### 3.1 先摸清现状

**你：** 看看编辑器，现在开的哪张图？

**我：** 调 `galaxy_status`，回你：进程 1724、标题 `触发器 - [E:/.../open-test.SC2Map]`、文档路径、窗口列表。想看图就再要一张截图。

> 截图是 `PrintWindow` 抓窗口内容，不依赖前台，你切到别的窗口也不影响。

### 3.2 读懂地图（最常用）

**你：** 这张图有多少触发器？列出动作最多的 5 个。

**我：** `galaxy_triggers` `action=summary` → 455 个触发器、1518 变量、231 函数，并给出 `largest` 列表。

**你：** 找一下叫 `Ranking Dialog` 的函数，把它的内容给我。

**我：** 先在 `TriggerStrings`（本地化表，触发器/函数名真正存在的地方）里把名字解析成 ID `6E253FA5`，再在 `Triggers` 里取出该元素 XML。

> 这一点很关键：`Triggers` 里只有 ID，没有中文名。直接正则搜中文名是搜不到的，插件会自动两边都查。

**你：** 全图里哪些地方提到了 `Strikers`？

**我：** `galaxy_triggers` `action=search`，返回行号 + 上下文片段，以及 `namedMatches`（名字命中的函数/变量）。

### 3.3 改代码前先自检

**你：** 这段 Galaxy 有问题吗？`<贴代码>`

**我：** `galaxy_lint` → 括号是否配平、`if` 是否漏了 `then`、条件里是否把 `==` 写成 `=`、调用的函数在本文件里有没有定义。

> 这是"秒回"的静态检查，不占用编辑器。真正的编译仍然以编辑器加载地图为准。

### 3.4 写回地图（重点，务必看限制）

**你：** 把这段新的 MapScript.galaxy 写回那张图。

**我：** `galaxy_map_write`，步骤是：
1. 先在旁边生成 `<地图名>.<时间戳>.bak` 备份；
2. 压缩后与原文件块比较容量；
3. 装得下 → 原位覆盖 + 只重写那一条块表记录，其余字节一个不动；
4. 装不下 → **直接报错并告诉你还差多少字节**，绝不写半成品。

**为什么这么保守：** 实测发现，银河编辑器会校验每个文件的物理位置。整档重排、或把新数据追加到表后面，都会被拒绝（报"无法加载依赖项数据"，严重时编辑器直接退出）。只有原位覆盖的档案能被正常打开——这条路径我已经用真实地图验证过。

**装不下怎么办：**
- 在编辑器里对该地图执行一次 `文件 → 保存`（或"另存为"），StormLib 会重写档案，往往能腾出空间；
- 或者把改动拆小；
- 或者告诉我要改的是哪个触发器，我们改用"生成文本 → 你在编辑器里粘贴"的方式。

### 3.5 让插件长出新手艺（自扩展）

**你：** 给我加一个工具，能列出最近改过的地图。

**我：** `galaxy_tool` `action=define`，写一段 JS：

```js
const { statSync } = await import('node:fs');
const rows = api.findMaps().map((file) => {
  const st = statSync(file);
  return { file, modified: st.mtime.toISOString() };
});
rows.sort((a, b) => (a.modified < b.modified ? 1 : -1));
return { maps: rows.slice(0, args.limit ?? 10) };
```

下一轮我就能直接调用它。定义存在 `<数据目录>\tools\galaxy_maps_recent.json`，重启后仍在；同名再定义会**替换旧工具**，想删就说"删掉这个工具"。

`api` 里可用：`bridge(cmd, params)`、`mpq()`、`lint`、`summarizeTriggers`、`searchTriggers`、`installs()`、`findMaps()`、`read`、`write`、`tmp`。

> 注意：自扩展工具如果返回数组或字符串，会被自动包成 `{ ok, result }`；返回对象最直观。
> 安全边界：工具代码在你本机的 DSH 宿主进程里执行，权限和插件本身一样。只定义你自己看得懂的代码。

### 3.6 直接驱动编辑器

**你：** 让编辑器执行一次"测试文档"。

**我：** `galaxy_editor` `action=command` `command=testDocument`（对应 `Ctrl+F9`）。

可用命令名：`new` `open` `save` `saveAs` `close` `testDocument` `undo` `redo` `copy` `copyAsText` `paste` `selectAll` `delete` `rename` `find` `replace` `publish` `dependencies` `preferences` `exit`。

也可以直接发按键（`action=keys`，SendKeys 语法：`^`=Ctrl、`%`=Alt、`+`=Shift，例如 `"^s"`、`"^+c"`、`"%{F4}"`），或配合 `galaxy_clipboard` 把文本送进/取出编辑器。

---

## 4. 已知限制（都是实测结论，不是猜测）

| 限制 | 说明 |
| --- | --- |
| 写回不能变大 | 见 3.4。容量不足会明确报错，不会写坏档 |
| 打开地图分两种 | 编辑器**没运行**时可靠（命令行带地图启动）；**已运行**时单实例交接不稳定，会返回 `opened:false` 和提示 |
| 自绘对话框不可填充 | "打开文档"是 Blizzard 自绘窗口，没有子控件，粘贴路径无效 |
| 触发器名不在 Triggers | 名字在 `TriggerStrings`；插件会自动去查，但你直接正则搜 XML 是搜不到的 |
| 亚服/国服两个安装 | 会同时列出，默认取第一个（`D:\StarCraft II`）；要指定可设 `GALAXY_EDITOR_ROOT` |

---

## 5. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 我说"没有 galaxy_* 工具" | 宿主还没重载 | 重启 DSH |
| `editor is not running` | 编辑器没开 | 让我用 `galaxy_map_open` 启动，或你自己打开 |
| 截图只有标题栏/很小 | 窗口被最小化 | 让我先"聚焦编辑器"（会自动还原） |
| 写回报 `replacement needs X but block holds Y` | 容量不足 | 见 3.4 |
| 打开地图返回 `opened:false` | 编辑器已在运行 | 关掉编辑器再让我开，或手动打开 |
| 中文路径/中文名异常 | 历史遗留的编码问题（已修） | 若复现，告诉我具体路径 |

---

## 6. 参数速查

| 工具 | 关键参数 |
| --- | --- |
| `galaxy_status` | `pid`（指定进程）、`probe`（默认 true，false 则不连桥） |
| `galaxy_editor` | `action`（必填）、`command`/`command_id`、`keys`、`out`、`title`、`timeout_ms`、`force` |
| `galaxy_clipboard` | `action`=get/set、`text` |
| `galaxy_map_open` | `path`（必填）、`launch`、`confirm_ms` |
| `galaxy_map_files` | `path`、`filter`、`limit`（默认 200） |
| `galaxy_map_read` | `path`、`name`、`out`、`max_chars`（默认 200000） |
| `galaxy_map_write` | `path`、`name`、`text` 或 `text_file`、`backup`（默认 true） |
| `galaxy_triggers` | `path`、`action`=summary/search/trigger、`pattern`、`trigger`、`max_hits`、`limit`（默认 50） |
| `galaxy_lint` | `text` 或 `file`、`name` |
| `galaxy_tool` | `action`=list/define/delete/examples、`name`、`description`、`parameters`、`code` |

---

## 7. 安全建议

1. **写回前先确认有备份**（默认会留 `.bak`，别用 `backup=false` 去赌）。
2. 编辑器里开着这张图时，外部改写文件不会自动刷新；改完让我提醒你重新加载。
3. 插件只读写你指定路径的文件，不会碰 `D:\StarCraft II` 里的其他内容；遇到不认识的压缩块会原样搬运，不重编码。
