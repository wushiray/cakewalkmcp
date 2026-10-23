# AGENTS.md — 给 AI agent 的操作手册

## 0.2.1 修订

- 升级旧版：0.2.0 的 `cw_save_state` 对导入 MIDI 可能误报可安全关闭，不应依赖旧版的该结论。
- 文档标签与主标题任一存在脏标记就按未保存处理。缺少或不匹配的标签、未知文档状态均不得推断安全关闭。`safeToClose` 是一次观测，不是关闭授权。
- `cw_close_overlays` 的 `closedCount` 只统计请求后从剩余列表消失的目标；`attemptedCount` 是尝试数，不能当成功数。`closed:true` 也不表示所有弹窗已关闭，仍须检查 `overlays`。
- `cw_track_controls` 无可见控件时 `ready:false`。可能是空工程、视图、许可或读取失败；不得仅因返回控件词表就宣称当前能写。
- **许可不是已证实的充分解释（2026-10-23 实测）。** 免费许可横幅可见时，由空白 CWP 模板创建并导入 MIDI 后照样暴露 `on Track` 控件，且 mute/solo/arm 实际写入 `verified: true` 并经外部 AX 复核；而早前导入 MIDI 的会话则没有子控件。因此"免费许可 → 轨道条不暴露控件 → 必须付费"这类绝对断言不成立：暴露与可写性随会话/工程/视图/工作区变化。以 `cw_track_controls` / `cw_get_track_control` 的实际返回为准，不要由许可推断。
- **导入 MIDI 要区分目标（2026-10-23 实测）。** 导入到**空 CWP**：6 个音符、通道 2/5、program 32/0、CC7/10 与中文轨道名全部保留。向**当前选中的已有 MIDI 轨**导入则是合并，且已有轨的通道 5 会覆盖输入里的通道 2。要保真就先建空工程再导入；合并语义不要当成"导入失败"。
- **导出 0xA659 只包含选中内容。** 需要完整往返时，先 `cw_navigate` 的 selectAll 再导出，否则导出文件会缺轨道；读回有缺项时先核对选区，再判断是否发生数据丢失。
- **中文宿主轨名需显式选择编码。** `cw_read_midi_file` / `cw_write_midi_file` 新增显式 `textEncoding:'gbk'`，UTF-8 仍是默认值；CP936 中文 SONAR 能正确显示 GBK 名称。SMF 本身不携带字符集声明，所以不要笼统说"标准是 UTF-8"；看到乱码时先用 `textEncoding:'gbk'` 重读，而不是断言工程损坏。
- **音轨模板：请求 ≠ 已验证。** BassRockRhythm 经 MCP 插入到新轨 3 后 `verified: true` 并经外部 AX 复核。但手动 插入菜单 → 音轨模板 对话框仍是必需前置（见下文）；插入后瞬时读取错误不代表插入失败，也**不要自动重试未验证的插入**——先重新读取确认。
- **CAL 修复（2026-10-23 实测）。** `addNotes` 的缩进问题与 `deleteNotes` 的二进制 `&&` 已修好，真实导出先后验证为 18 个音符、删除后 6 个音符。仍然遵守：`deleteNotes` 必须带 `confirm:"deleteNotes"`，`addNotes` 的 intervals 限于 -127..127。
- 以下安全约束全部保留：破坏性确认、弹窗默认保留、T1 只检测不实现、surface 默认关闭且 read/dump/call/qi/probe 永久禁用、无工程不发送命令、只有 `verified: true` 才报成功、不盲重试。

## 0.2.0 发布更新

- `cw_verify_commands` 默认仅探测两个视图命令；无工程时不发送。显式 ID 也受安全清单限制，遇到标准模态框立即停止并保留弹窗。
- `cw_run_command`、classified、编辑、工程和导航入口共用破坏性确认。按错误给出的精确命令名提供 `confirm`。
- `cw_close_overlays` 默认保留标准对话框；只有 `closeDialogs:true` 且 `confirm:"closeDialogs"` 才会关闭它们，可能丢弃未保存内容。
- `cw_cal_run deleteNotes` 必须提供 `confirm:"deleteNotes"`。addNotes 的 intervals 限制为 -127..127。
- T1 只检测、不实现 IPC；检测到 Assistant 也不能报告可用。transport 使用菜单回退。
- surface 仍默认关闭。主动启用时 SONAR 与 MCP 环境需要相同的 64 位十六进制 `CW_SURFACE_TOKEN`。read/dump/call/qi/probe 永久禁用；不要尝试通过 TCP 或原语绕过。
- `npm test` / `npm run test:full` 默认使用测试专用的无宿主桥；不触碰真实 DAW/MIDI。真实写入测试需显式 `--live-host`，且只使用可丢弃工程。

你是通过 MCP 工具操控 Cakewalk SONAR 的 agent。这份手册是给你的：怎么选工具、调用前必须检查什么、出错后怎么恢复。给人看的安装说明在 [QUICKSTART.md](QUICKSTART.md)，完整技术文档在 [README.md](README.md)。

---

## 会话开始时必做的事

```text
1. cw_doctor          → 看五条通道各自动态（pass/degraded/unavailable + 修复建议）
2. cw_document_state  → 看当前有没有打开工程
```

`cw_doctor` 的输出就是你的状态地图。`degraded` 不是故障——它通常意味着"差一个会话前置条件"（比如没开工程、SONAR 处于免费许可），fix 字段会告诉你差什么。

## 轨道相关：三条铁律

1. **工程必须已打开。** 没有工程就没有轨道，轨道控件根本不存在。先看 `cw_document_state`。
2. **轨道必须在音轨视图里可见。** 滚出视野的轨会被**拒绝**而不是盲点——这是故意的（盲点会写到错误的位置上）。报错 "scrolled out of the Track view" 时，让用户滚动或减少轨道。
3. **SONAR 不能是最小化的。** 最小化时读取正常、写入必然失败（点击落不到窗口上）。看到 `verified: false` 先检查这个。

## 工具选择决策树

**改轨道状态（静音/独奏/录制/改名）：**
```text
cw_set_track_mute / cw_set_track_solo / cw_set_track_arm / cw_set_track_name
```
返回值里的 `verified` 是唯一可信字段——true 表示读回确认到位。`alreadyThere: true` 表示本来就处于目标状态，**这是成功，不要重试**。

**读轨道当前状态（任意控件）：**
```text
cw_get_track_control   → 任意标签：音量/声像/手动静音/输入/输出/存档……
cw_list_tracks / cw_get_track   → CakeScript 通道（本构建不可用，**没有备用实现**，会直接报错并给出替代做法）
```

**音量/声像（数值）：**
```text
cw_set_track_volume / cw_set_track_pan   → CakeScript 路线
cw_set_volume / cw_set_pan / cw_apply_mix → 实时 MIDI 路线（需要轨道监听对应通道）
```
滑块在 UI 层不可写（SONAR 忽略值写入模式）——这是产品限制，不要反复尝试 T5 路线。

**插入音色/插件链：**
```text
1. cw_list_track_templates   → 列出可用模板（可 filter；数量随安装变化，本机 184 个）
2. cw_insert_track_template  → 插入并按新轨名验证
```
⚠️ 插入前**必须先手动打开** 导入音轨模板 对话框（插入菜单 → 音轨模板）——0x8536 命令派发不可靠，这是已知限制。对话框没开时工具会明确报错而不是乱插。已实测 BassRockRhythm 经 MCP 插入到新轨 3：`verified: true` 并经外部 AX 复核；但返回值只代表"已请求 + 新轨名核验通过"，插入后的瞬时读取错误不代表插入失败——先重读确认，**不要自动重试未验证的插入**。

**写音符：**
```text
cw_midi_note / cw_midi_chord / cw_midi_cc   → 实时（立即发声）
cw_write_midi_file + cw_project importMidi   → 写文件再导入（可批量）
cw_cal_run                                    → CAL 宏（自由许可下唯一能在工程内直接增删音符的通道；写文件再导入同样能创建音符）
```

**改工程/视图/菜单：**
```text
cw_run_command       → 按 id 发命令；返回 none-observed 时用截图确认（视图类命令在原窗口内打开，不产生新窗口）
cw_list_commands     → source="live" 找可发的 id（source="index" 只能搜索，不能派发）
cw_list_overlays / cw_close_overlays → 模态弹窗会挡住一切命令，先清掉
```

**诊断与恢复：**
```text
cw_doctor            → 总入口
cw_verify_commands   → SONAR 升级后重测命令 id
```
注意 `cw_surface_*` 那八个工具**默认不注册**（需 `CAKEWALK_MCP_SURFACE=1`）。
它们依赖的"控制面板"已被判定为不可用路径：SONAR 只保存面板配置、启动时从不读回
（`Sonar.exe` 有 `PersistSurfaces`，没有任何 `LoadSurfaces`），因此每会话都要手动
重加，且它唯一能做的写入在宿主对象缺 `IDispatch` 下会直接拒绝。**不要建议用户去
参数设置里加面板，也不要把它当成混音写入的手段。**

## 哪些工具在本机根本不工作（别浪费轮次去试）

这些工具的**唯一实现**是一条 CakeScript 模板，而本机无法派发 CakeScript，
所以它们 100% 失败。**别重试、别换参数**——它们各自的报错里已经写明了替代做法：

| 工具 | 替代 |
|---|---|
| `cw_list_tracks` | 导出 `.mid`（`cw_run_command 0xA659`）→ `cw_read_midi_file` 拿轨道名 |
| `cw_get_track` | `cw_get_track_control`（逐个读轨道条控件） |
| `cw_set_track_volume` | `cw_set_volume` / `cw_apply_mix`（实时 CC7）。**没有**直接写推子的方法 |
| `cw_set_track_pan` | `cw_set_pan`（实时 CC10），或把 `panCC` 烘进 `.mid` 再导入 |
| `cw_get_clips` | 导出 `.mid` → `cw_read_midi_file` |
| `cw_get_notes` | 导出 `.mid` → `cw_read_midi_file includeNotes=true` |
| `cw_locate` | 只有 `cw_navigate` 的按小节步进（`goToNextMeasure` / `goToPrevMeasure`），**没有绝对跳转** |

**会兜底、能正常用的**（别把它们和上面混为一谈）：
`cw_set_track_mute` / `cw_set_track_solo` / `cw_set_track_arm`（走真实点击）、
`cw_set_track_name`（走名称栏）、`cw_transport`（走菜单命令 0x801D/0x801F/0x801C，
但**需要先打开工程**，且没有独立的 pause）。

⚠️ 前四个依赖轨道条是否**暴露** `on Track N` 子控件；**这不是许可等级的确定函数**。
实测 2026-10-23：Free License 横幅可见、由空白 CWP 模板创建并导入 MIDI 后子控件照常暴露，mute/solo/arm 写入
`verified: true` 并经外部 AX 复核；而另一会话（此前导入过 MIDI）却没有子控件。
暴露与可写性随会话/工程/视图/工作区变化——**以 `cw_track_controls` /
`cw_get_track_control` 的实际返回为准，不要由许可推断"必须付费才能写"**。
遇到 `no element named '手动静音 on Track N'` 时，先确认工程已打开、轨道在屏上、
SONAR 未最小化、并读一次控件词表，再考虑其它原因；写歌/导入导出不依赖这些控件。

## 写混音参数的正确路径

| 目标 | 用什么 |
|---|---|
| 音量 / 声像 | `cw_write_midi_file`（含 `volumeCC` / `panCC`）→ `cw_project importMidi`。工程加载时被读取，**已端到端验证** |
| 静音 / 独奏 / 录音准备 | `cw_set_track_mute` / `cw_set_track_solo` / `cw_set_track_arm` —— 真实点击轨道条并读回验证；SONAR 必须在前台且未最小化 |
| 改名 | `cw_set_track_name`（中文可用）或 `cw_cal_run` 的 renameTrack |
| MIDI 通道 / 端口 | `cw_cal_run` 的 `setTrackRouting`（CAL 有 `TrackChannel` / `TrackPort` 内建） |

CAL **没有**音量、声像、独奏、录音臂的内建（grep 已确认为零命中），别去试。

## SONAR 升级后的顺序

```text
1. cw_doctor          → 找出哪条通道退化
2. 按各通道 fix 字段处理：
   - t5 退化且提到 labels → 改 native/uia/cw_uia.ps1 顶部词表（环境变量 CW_UI_* 可覆盖，无需改码）
   - t2 退化             → cw_list_overlays 清弹窗，再 cw_verify_commands 重测 id
   - t4 退化             → loopMIDI 没运行，或 SONAR 没勾选 MIDI 输入端口
   - t3 退化             → 正常现象，面板已不是必需路径；除非用户显式要求面板诊断，否则忽略
```

## 错误恢复模式

| 错误特征 | 含义 | 动作 |
|---|---|---|
| `verified: false` + 无 warning | 写了但读回没变 | 检查 SONAR 是否最小化；再查轨道是否可见 |
| `scrolled out of the Track view` | 轨道在视野外 | 让用户滚动，**不要**换坐标重试 |
| `not a writable track control` | 用了只读键 | volume/pan 走 MIDI 路线 |
| `no element named '<X> on Track <N>'` | 轨不在屏上或标签不存在 | visibleTracks 确认；注意错误消息里回显的正是你要找的名字 |
| `GHOST STATE`（doctor） | SONAR 进程在、主窗口没了 | 重启 SONAR，没有别的办法 |
| `needs-user-setup`（面板） | DLL 加载了但没 Connect | **这个面板已从本项目移除，别再让用户加它**；只有 `-WithSurface` 诊断装法才会遇到 |
| 工具返回 `isError` 且含 `Hint:` | 已给出修复建议 | 按 Hint 做，不要盲目重试 |

## 已知边界（不要浪费时间的地方）

- **依赖自动化的分界**：安装器自动处理 npm 依赖（自带 `runtime\node.exe`，不需要系统装 Node）、loopMIDI 检测/安装/建端口、SONAR 的 MIDI 输入启用（TTSSEQ.INI）。**没有每次启动都要做的手工步骤**：控制面板是可选诊断件（`-WithSurface`），默认不安装，也不需要每会话重加。用户没有 loopMIDI 时，实时 MIDI 类工具（音符/音量/声像）不可用，其余照常——doctor 的 t4 会给出下载地址。安装 loopMIDI 本身会触发一次 UAC（它要装驱动）；不想装就加 `-LoopMidi skip`。
- **插件参数级控制不存在。** FX 槽没有无障碍元素，逆向调用已证实会崩 SONAR（详见 ANALYSIS.md）。插件能力=模板插入，这是天花板。
- **滑块（音量/声像/增益）和路由按钮（输入/输出）UI 不可写。** 前者走 MIDI CC，后者无解。
- **音量写走 CakeScript 的 cw_set_track_volume 在本构建不可用**（会自动报 CAKESCRIPT_UNAVAILABLE 并附各通道状态表）。
- **菜单栏按坐标点击不可靠**（元素名与绘制不匹配）——用元素索引或 T2 命令 id。
- **物理像素 vs 光栅像素不要换算。** UIA bounds 与 SetCursorPos 同为物理像素，直接用元素中心；只有 computer-use 截图（光栅）需要除以缩放。

## 对话风格

- 写操作后**如实报告 `verified`**：true 才说"已完成"；false 就说没成功并给出你打算怎么排查。
- 不要在没跑 `cw_doctor`/`cw_document_state` 的情况下猜测环境状态。
- 破坏性命令（cw_project close/revert、CAL 删除类）工具自身有确认门槛，触发时如实向用户转述要求。
