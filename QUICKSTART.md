# 快速上手（给使用这个适配器的人）

当前 0.2.1 的验证范围、审计修复和未覆盖项见 [RELEASE-NOTES.md](RELEASE-NOTES.md)。
默认部署不启用 surface。仅在主动调试该组件时，需要给 SONAR 与 MCP 进程设置相同的
64 位十六进制 `CW_SURFACE_TOKEN`；没有有效 token 时不会监听。内存读取和 vtable 调用已禁用。

这是一个让 AI 助手（通过 MCP 协议）直接操控 Cakewalk SONAR 的适配器：建工程、写音符、开关静音/独奏/录制、插入带插件链的音轨模板、导出音频，大部分可以在对话里完成。**但不是每一步都能自动做**：少数对话框（新建工程向导、`插入 > 音轨模板` 等）需要你自己点，或由 agent 借 computer-use 之类的屏幕操作去点；其余步骤才是工具直接执行的。

本文是给人看的。给 AI agent 看的说明书在 [AGENTS.md](AGENTS.md)。

---

## 安装（一次性，约 1 分钟）

前提：Windows 10/11、已安装 Cakewalk SONAR。**不需要装 Node.js**——运行库随包携带。

**推荐：双击项目根目录的 `双击部署.cmd`。** 保持整个项目文件夹完整。适配器本身**不需要管理员权限、不写 HKLM**；但如果你机器上没有 loopMIDI，安装器会调用它的官方安装包装驱动，**这一步会弹一次 UAC**（不想装就手动加 `-LoopMidi skip`）。窗口会显示安装结果并保留供查看，日志保存在 `deploy-logs/`。

也可以手动运行：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install.ps1
```

它会自动完成：检查环境 → 装 npm 依赖 → 检查虚拟 MIDI 线 → 运行健康检查。

看到 `installed.` 表示文件和依赖都就位了；**它不等于“SONAR 一定能用”**——同一屏上还有健康检查的结论，可能是 `UNVERIFIED` 或某个通道 unhealthy，要读那一行。若安装器发现 SONAR 缺少 C++ 运行库，它会打印 `installed, but SONAR cannot start yet.` 并以非零码退出。**装完没有每会话步骤**——不需要每次启动 SONAR 后再去设置里点什么，也不需要 computer-use 运行时。

> **第一次装、SONAR 还没启动过？** 健康检查会提示 `SONAR is not running, so most
> channels could not be checked.` 这是正常的：没有 SONAR 就没有可检查的对象。
> 启动 SONAR 后再跑一次安装器（或 `cw_doctor`）就能得到真实结论。

## 依赖一览（哪些自动、哪些要动手）

| 依赖 | 谁来装 | 说明 |
|---|---|---|
| Node.js 运行时 | **随包携带**（`runtime\` 目录共 105 MB，其中 `node.exe` 93 MB） | 自包含，无需安装、无需管理员。只有在你自己删掉 `runtime\` 目录时才需要另外装 |
| npm 依赖（`node_modules`） | 安装器自动装；**若随包附带则完全不需要联网** | 只有两个直接依赖（MCP SDK、zod），纯 JS、无本地二进制，21 MB，可整个复制 |
| loopMIDI（虚拟 MIDI 线） | 安装器检测；**没装则自动安装**（winget，或官方包） | 免费软件。不装只影响"实时发音符"这一类功能，其余全部可用。不想让它装：`-LoopMidi skip` |
| SONAR MIDI 输入启用 | **安装器自动** | 部署时若 SONAR 未运行，安装器会直接写入 `TTSSEQ.INI` 启用 loopMIDI 端口（带 `.bak` 备份）。若安装时 SONAR 正开着，会被跳过——运行中的 SONAR 会用内存里的列表覆盖它，这时需手动勾选或重启后重跑安装器 |
| gcc / mingw | **不需要** | 面板 DLL 已改为可选（`-WithSurface`），默认路径不编译任何东西 |
| 面板 DLL 的 C 运行库 | **不需要** | 面板 DLL 只依赖 Windows 自带 DLL（KERNEL32/USER32/OLEAUT32/ADVAPI32/WS2_32/msvcrt） |
| **SONAR 自己的 C++ 运行库** | **SONAR 安装器负责；本安装器只做检查** | `Sonar.exe` 直接导入 `msvcp140.dll` / `vcruntime140.dll` / `mfc140u.dll`。这三个缺失时 SONAR **启动即退出**（`0xC0000135`），适配器随后只会看到"SONAR 不可达"。干净 VM 实测过这种半装状态。安装器现在会在 step 1 检查，缺失时明确报警，并把结尾的 `installed.` 改成 `installed, but SONAR cannot start yet.` |

## loopMIDI：随包携带，端口也会自动建好

虚拟 MIDI 端口**只在 loopMIDI 运行时存在**，而且**新装的 loopMIDI 默认一个端口都没有**——所以"装了"和"能用"是两件事。安装器把这几步都做完了：

| 状态 | 安装器做什么 |
|---|---|
| 没装 | **直接用包内的 `vendor\loopMIDI\loopMIDISetup.exe` 安装**（作者授权随包分发，安装前校验数字签名），不需要联网 |
| 装了但没运行 | 自动启动（路径通过进程 → PATH → Program Files 搜索 → 开始菜单快捷方式四种方式定位，**不依赖固定安装路径**） |
| **运行中但没有端口** | **自动创建 `loopMIDI Port` 并重启 loopMIDI**，然后把它启用为 SONAR 的 MIDI 输入 |
| 端口已就绪 | 直接在 SONAR 里启用该端口 |

检测为什么不能用注册表：实测 loopMIDI 的卸载项**没有 InstallLocation**，`DisplayIcon` 指向的是 Package Cache 里的安装器而不是 `loopMIDI.exe`。所以只能从进程、搜索和快捷方式找。

## 重要：轨道控件是否可用取决于实际控件，不要只看许可证

实测（干净安装、未登录）：SONAR 主窗口只暴露 **52 个无障碍元素**，没有任何
`音量 on Track 1` / `手动静音 on Track 1` 这类控件；登录后同一窗口变成 **402 个**，
全部出现。

**2026-10-20 追加实测**：光"登录"不够，还必须是付费/会员状态。同一台机器上
SONAR 显示 `Free License` 时，主窗口有 69 个元素，5 条轨道条（`Drums`/`Bass`/…）
都在，但**每条轨道条的子元素数为 0**——`音量`/`声像`/`手动静音` 一个都不暴露。
同一版本此前在会员状态下曾测到 402 个。当时推断是 SONAR 把许可证状态直接映射到
无障碍树上（**该推断已被 2026-10-23 的实测部分推翻，见下**）。

**2026-10-23 更正：许可证状态不是充分解释。** 实测时 `Free License` 横幅**一直
可见**，但由空白 CWP 模板创建并导入 MIDI 后，轨道条上的 `音量`/`手动静音` 等控件照样暴露，而且静音/独奏/
录音准备的真实写入返回 `verified: true`、外部 AX 检查也确认真实变化；更早那次
"没有子控件"的实测用的是**导入 MIDI 之后的会话**。会话、工程、视图、工作区不同，
结果就不同——**以实际暴露的控件为准，不要用许可证状态去推断能不能用**。
下面是把 `Free License` 当成唯一原因时得出的旧结论，保留作历史记录：

后果：**未登录或免费许可时**，靠点击轨道条的三个工具不可用——

- `cw_set_track_mute` / `cw_set_track_solo` / `cw_set_track_arm`
- `cw_set_track_name`

报错类似 `no element named '手动静音 on Track 1'`。这**不是适配器的 bug**，而是
SONAR 这一会话里没有构建轨道条的无障碍子树。先 `cw_doctor`／重新读取实际控件，
再决定是否需要登录或换会话，别一上来就断定"许可证不行"。

其它功能（读工程状态、菜单命令、文件导入/导出、实时 MIDI、CAL）不受影响；
写歌本身不依赖轨道条——`cw_write_midi_file` → 导入这条路完全可用。

所以在一台新机器上部署时，顺序是：**装 SONAR → 登录并确认许可证状态 → 再部署/使用本适配器**。登录后仍报 `no element named …` 时，先看 doctor 与当前会话实际暴露的控件，必要时重启 SONAR 或换一个工程/会话再试（见上文的 2026-10-23 更正）。

## 完整顺序（从零到能用）

1. **解压项目包**（不需要装 Node.js——`runtime\` 里已带）
2. **安装 SONAR 并登录一次** —— 未激活/未登录时 SONAR 常常不暴露轨道条的无障碍控件，
   轨道类工具会不可用（见上一节；但最终以实际控件为准）
3. **双击 `双击部署.cmd`** —— 看到 `installed.` 即完成
4. **启动 SONAR** —— 首次会问"是否迁移先前设置"，选取消（没有可迁移的旧配置）
   若选完后进程没有主窗口，**再启动一次**即可（首次运行向导退出时的已知行为）
5. **（部署已完成）MIDI 输入** —— 安装器已在 SONAR 未运行时自动启用 loopMIDI 端口。
   若安装时 SONAR 正开着而被跳过：`编辑 → 参数设置 → MIDI → 设备` 里勾上，确定即可生效
   （不用重启 SONAR）。安装器也会报告 SONAR 的登录状态
6. **新建或打开一个工程** —— 轨道类工具需要工程存在
7. **配置 MCP 客户端并重启它** —— 配置片段见下一节；不重启会看到 `is not defined`
8. **让 agent 跑 `cw_doctor`** 验证，然后就能用了

前三步之外都可以反过来做，但第 4 步之前必须已经启动 SONAR（否则打不开参数设置）。

## 关于"控制面板"：已不再是必需，默认不装

早期版本需要在 SONAR 的 **参数设置 → MIDI → 控制界面** 里手动加一个面板，**而且每次启动 SONAR 都要重加一遍**。这个设计已经取消，原因是查清了机制：

- SONAR 里有 `CCtrlSurface::PersistSurfaces`（**写**配置的函数），但**搜不到任何** `LoadSurfaces` / `RestoreSurfaces` 之类的符号——它只保存、启动时从不读回。
- 实测印证：配置文件里存着本适配器的 CLSID，SONAR 启动后进程模块表里**没有** `cw_surface.dll`。
- 也就是说面板只在"你按下确定"的那一瞬间被创建，之后永远不再恢复。**这跟"一键"从根本上不相容**，而从外部无法修复（除非改 SONAR 本体，本项目不做这个）。

**能力没有因为去掉面板而减少。** 面板原本能写的混音参数，现在分别走三条替代路径（文件导入、真实点击、CAL），都不需要往 SONAR 里加面板：

| 能力 | 现在的路径 |
|---|---|
| 音量 / 声像 | 写进 .mid 的 CC7/CC10，导入工程时被读取（已端到端验证） |
| 静音 / 独奏 / 录音准备 | 真实点击轨道条上的按钮，读回验证 |
| 改名 / 静音（CAL 版）/ 通道端口 | CAL 脚本，不需要任何授权 |
| 音符、导出、建轨、模板 | 一直是文件或菜单路径，与面板无关 |

想自己验证面板（纯属诊断用途）可以加装：`install.ps1 -WithSurface`。装了之后那"每次 30 秒"的手动步骤会回来，脚本会明确告诉你。

## 接入 AI 助手

想让 Agent 帮你配置与检查，直接复制 **[视频同款连接提示词](CONNECT-PROMPT.md)**，
填入实际安装路径即可；同一页还有四小节小曲与后续修改示例。

在 MCP 客户端配置里加一项。**`command` 指向包里自带的 runtime**，这样不依赖系统是否装过 Node：

```json
{
  "mcpServers": {
    "cakewalk": {
      "command": "<本目录路径>\\runtime\\node.exe",
      "args": ["<本目录路径>\\bin\\cakewalk-mcp.js"]
    }
  }
}
```

（如果你的机器本来就装过 Node，把 `command` 写成 `"node"` 也能用，但自带 runtime 更可靠。）

## 日常使用速查

| 你想做的事 | 对 AI 说的话（示例） | 用到的能力 |
|---|---|---|
| 建一个新工程 | "新建一个 16 轨工程" | 打开向导对话框（**需要手动点**，向导是自绘控件，适配器点不了；也可以让 agent 用 computer-use 去点） |
| 改轨名 | "把轨道 3 改名叫'主唱'" | 中文名直接支持 |
| 静音/独奏/录音准备 | "把 2、5 轨静音，3 轨录音准备" | 真实点击写入后自动读回验证，以 erified 为准 |
| 挂音色/效果链 | "给工程加一条'Bass Rock Rhythm'轨" | 通过 MCP 插到新轨（第 3 轨，实测 `verified: true` + 外部 AX 确认）；**仍需先打开 `插入 > 音轨模板` 对话框**（对话框检测已修好，但它需要人/屏幕操作去点） |
| 写音符 | "在轨道 1 第 5 小节写一个 C4 四分音符" | 实时 MIDI / CAL（`addNotes` 缩进与 `deleteNotes` 的 `&&` 已修正，实际导出测得 18 → 6 个音符） |
| 导出 | "把工程导出成 wav" | 渲染导出（导出只取当前选中内容；整曲导出前先 selectAll） |

## 中文 MIDI 导入/导出要点

1. **编码**：文本（轨道名等）读写支持 `textEncoding` 参数。默认仍是 `UTF8`；
   在中文 Windows（CP936/GBK）上、或要跟 SONAR 显示保持一致时，显式传
   `textEncoding: 'gbk'`。实测 CP936 主机上的中文 SONAR 能正确显示 GBK 轨名。
2. **SMF 本身不带字符集信息**——.mid 文件里没有"这段文字是什么编码"的标记，
   所以不能说"UTF-8 才是标准"，只能按目标主机/SONAR 的实际显示选编码。
3. **导入位置很关键**：
   - 导入到**空工程（empty CWP）**：实测 6 个音符、通道 2/5、音色 32/0、CC7/CC10、
     中文轨名全部保留；
   - 导入到**当前选中的已有 MIDI 轨**：会与已有内容合并，已有通道 5 会覆盖输入里的
     通道 2。
   想原样保留就用空工程，或先 `文件 > 打开` 那个 MIDI 再操作。
4. **整曲导出前先 selectAll**：导出（如 `0xA659`）只取当前选中内容；`cw_navigate`
   先 `selectAll` 再做完整往返，否则只会导出选中片段。

## 出问题时

**第一步永远是问 AI 运行 `cw_doctor`**——它检查 6 项（host 探测 + 5 条通信通道），每条给出"正常/退化/不可用"和具体的修复办法。

常见情况：

| 现象 | 原因与处理 |
|---|---|
| 写静音/改名报 `verified: false` | SONAR 被最小化了。**恢复窗口**再试（读取不受影响，点击落不到最小化窗口上） |
| doctor 说 `frameGhost` | SONAR 的窗口没了但进程还在（此版本偶发）。重启 SONAR 即可 |
| doctor 说 `t5-uia-click: degraded` 且提示 open a project | 当前没打开工程。轨道不存在于空工程里 |
| doctor 说 `t4-realtime-midi: degraded` | 没勾选 SONAR 的 MIDI 输入端口，或 loopMIDI 没运行。只影响实时发音符，其余功能照常 |
| 某个工具报 "is not defined" | MCP 服务还是旧代码。**重启你的 AI 助手**（运行中的服务不会重载模块） |
| SONAR 升级后某些功能失灵 | 跑 `cw_doctor`。界面文字变了的话，改 `native\uia\cw_uia.ps1` 顶部的词表（有说明），不改代码 |
| 全部失灵 | 重启 SONAR；再不行重启 MCP 服务（退出并重开你的 AI 助手） |

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File deploy\uninstall.ps1
```

然后删掉本目录即可。卸载会清干净注册表（已验证无残留），**不影响** SONAR 本体、工程文件和任何授权。

## 安全与隐私

- 所有通信只走本机回环（127.0.0.1），不出网
- 适配器自身只写当前用户的注册表（无 HKLM、无提权）；例外是 loopMIDI 的驱动安装（会弹 UAC）和 `-WithSurface` 时复制到 SONAR 的 Shared Surfaces 目录
- 不接触、不修改、不绕过 SONAR 的任何授权机制
- AI 能做的每一件事，你自己坐在这台电脑前也能做——它没有额外权限

## 深入阅读

- [README.md](README.md) —— 完整技术文档：5 条通信通道（另有 host 探测，doctor 共 6 项）的原理、每个工具的说明、所有"走过的弯路"的记录
- [AGENTS.md](AGENTS.md) —— 给 AI agent 的操作手册（工具选择、状态检查、恢复策略）
- [deploy/README.md](deploy/README.md) —— 部署细节：发给别人时要带哪些文件
- [native/surface/ANALYSIS.md](native/surface/ANALYSIS.md) —— 逆向工程记录与发布前审计报告

## 已有旧版本？升级步骤

1. 把新版本**覆盖解压到同一个目录**（不要先删旧的——先删会丢掉已装好的 `node_modules`，还得重下一次）。
2. 重新双击 `双击部署.cmd`。安装器是**幂等**的：依赖会重新校验（好则跳过 npm），MIDI 端口不会重复添加，`TTSSEQ.INI` 会先备份再改。
3. **重启你的 MCP 客户端**。已经在跑的进程还持着旧的模块图，新装的工具会显示为"不存在"。
4. 如果旧版装过控制面板（`-WithSurface`），先跑 `deploy\uninstall.ps1` 清掉 COM 注册和 Shared Surfaces 里的副本，再装新的。

> 升级不会动你的工程文件，也不会动 SONAR 的授权状态。
