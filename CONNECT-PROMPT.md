# 给 AI Agent 的连接提示词（Cakewalk MCP）

> 把「复制下面这段」里的内容**整段原样**给你的 AI 助手（任何支持 MCP 的客户端）。
> 它会自己完成配置、检测和验证。
>
> **先改一处**：下面的 `<本机路径>` 必须换成你机器上这个包的真实目录（双击部署时
> 安装器打印的那行绝对路径）。其余部分不用动。
>
> 前提：本机已跑过 `双击部署.cmd` 并成功（看到 `installed.`）。

---

## 复制下面这段

```text
我想让你连接本机的一个 MCP 服务：它让我用自然语言直接操控 Cakewalk SONAR。
请按顺序执行，每一步都告诉我结果，不要跳过验证步骤。

【服务信息】
- 项目位置：<本机路径>
- 启动命令：<本机路径>\runtime\node.exe <本机路径>\bin\cakewalk-mcp.js
- 传输方式：stdio
- 已经装好了，你不需要部署。**不需要系统装过 Node.js**——运行库就在包的 runtime\ 目录里。

【第 1 步：配置 MCP】

在你的 MCP 客户端配置里加入这一项：

{
  "mcpServers": {
    "cakewalk": {
      "command": "G:\\cakewalkmcp\\runtime\\node.exe",
      "args": ["G:\\cakewalkmcp\\bin\\cakewalk-mcp.js"]
    }
  }
}

配好后**重启你的 MCP 客户端**。这一步不能省：已经在运行的服务器不会重载代码，
所以刚装好或刚更新过就必须重启，否则会看到工具报 "is not defined" 这类错误。

重启后确认工具列表里有 89 个 `cw_` 开头的工具。

【第 2 步：环境自检】

调用 cw_doctor，它会检查 5 条通信通道，每条给出
正常(pass) / 退化(degraded) / 不可用(unavailable) 和具体的修复办法。
再用 cw_document_state 确认 SONAR 里有没有打开工程。

判断标准（很重要：下面这些是预期现象，不是故障）：
- t1-cakescript   = unavailable → 正常。这个 SONAR 构建没有可用的脚本引擎入口，
                                  依赖它的工具（如 cw_list_tracks）会走替代路径或不可用。
- t3-surface      = unavailable → 正常。控制面板已从本项目移除，所有功能都不需要它。
- t5-uia-click    = degraded    → 两种原因：没打开工程，**或者 SONAR 处于未激活/Free License**
                                  （此时轨道条存在但不暴露子控件，打开工程也不会恢复）。
                                  先看 SONAR 标题栏和许可状态，再决定怎么处理。
- t4-realtime-midi = degraded   → SONAR 没勾选 MIDI 输入端口，或 loopMIDI 没运行。
                                  （部署时若 SONAR 没开，安装器会自动启用端口；
                                   若部署时 SONAR 正开着，会被跳过 → 手动勾选或关掉
                                   SONAR 重跑一次安装器即可）
                                  只影响实时发音符，其他功能照常。
- host / t2-wm-command 应为 pass。

【第 3 步：打开一个工程】

很多工具（尤其是轨道类）需要先有工程。cw_document_state 会直接告诉你有没有。

打开工程：文件 > 新建（命令 id 0x80B3）或 文件 > 打开（0xE101）。
如果没工程就调轨道类工具，会看到 t5 退化——那是原因，不是 bug。

【第 4 步：用真实可用的工具验证链路】

下面这些工具在本机**必然失败**，因为它们唯一的实现依赖 CakeScript，
而本机构建无法派发 CakeScript。别重试、别换参数：

  cw_list_tracks、cw_get_track、cw_set_track_volume、cw_set_track_pan、
  cw_get_clips、cw_get_notes、cw_locate

它们的报错里已经写明了该用什么替代，照着做即可。所以**不要拿它们来验证连通性**。

按下面这些实测可用的方式验证：

1. cw_midi_note  pitch=60 durationMs=300
   → 在 MIDI 线上弹一个中央 C。如果 SONAR 正在监听该端口，能听到声音，
     说明"实时 MIDI"这条路通了。没声音不代表连接失败，只是没勾选 MIDI 输入端口。

2. 打开工程后，用 cw_get_track_control（label 如「音量」「手动静音」）读一条轨道的数值
   → 能读出数值就说明"无障碍通道"是通的。注意静音的完整标签是「手动静音」，不是「静音」。
   Free License / 未登录时这一步必然失败，这是 SONAR 的许可门槛。

3. cw_set_track_name 改一条轨道的名字，再读回确认
   → 这会真实写入并读回验证，是最能证明链路通的一步（支持中文）。
     注意：SONAR 不能被最小化，否则点击落不到窗口上。
     注意：同样需要付费/会员许可；免费许可下轨道条没有可点击的子控件。

4. cw_convert  bar=1 → 换算拍/秒/滴答
   → 纯计算，不需要 SONAR 在线，可以用来确认工具本身能调通。

跑完把每步结果报给我。

【先读手册再动手】

这个适配器自带说明书，动手改任何东西之前先读：

  <本机路径>\AGENTS.md       → 给你的操作手册（工具选择、状态检查、恢复策略）
  <本机路径>\QUICKSTART.md  → 给人看的上手说明

AGENTS.md 里有一张「写混音参数的正确路径」表，务必照它做。

【这些事不要做】

1. 不要建议我去「编辑 → 参数设置 → MIDI → 控制界面」添加控制面板。
   那个面板已从本项目移除：SONAR 只保存面板配置、启动时从不读回
   （它内部有 PersistSurfaces，但没有任何 LoadSurfaces），所以每次启动都要手动重加，
   而且它唯一能做的写入会因宿主对象缺 IDispatch 被拒绝。混音参数请走文件路径。

2. 不要用授权破解、内存补丁这类手段。

3. 不要直接改 TTSSEQ.INI。里面的 MaxInPort 存的是**已启用设备的最高索引**，
   不是"启用全部"的开关；写错 -1 会静默关掉一台已配置机器的 MIDI 输入。
   要启用端口请用 cw_enable_midi_port（它会正确维护这个键）。

4. 不要修改我的真实工程文件；测试请用本机路径之外的临时目录。

【几个实测踩出来的坑，别重复踩】

- 改音量/声像：把 CC7/CC10 写进 .mid 再导入（cw_write_midi_file → cw_project importMidi）。
  不要试图用控制面板，也不要指望实时 MIDI 改混音（需要轨道监听该通道，未必成立）。
- CAL 改不了音量、声像、独奏、录音臂——它没有这些内建（已确认零命中）。
  CAL 能做的是：改名、静音、MIDI 通道/端口、音符的增删改查。CAL 不需要任何授权。
- 读音符不要靠 CAL 返回文本：CAL 无法写文件，跨事件累积的字符串会丢失（实测确认）。
  要读数就导出 .mid 再用 cw_read_midi_file 解析。
- 模态弹窗会挡住一切菜单命令。先 cw_list_overlays 看，再 cw_close_overlays 清掉。
- SONAR 最小化时写入会返回 verified: false。让用户恢复窗口再试。

如果你不确定从哪开始，就先跑 cw_doctor 和 cw_document_state，把结果报给我。
```

---

## 关于这份提示词

**它包含的真实事实**（都已在本机核实）：

| 项 | 值 |
|---|---|
| 入口 | `<本机路径>\bin\cakewalk-mcp.js` |
| 运行时 | `<本机路径>\runtime\node.exe`（随包携带，无需系统安装 Node） |
| 工具数 | 89（默认） |
| 传输 | stdio |
| 受保护目录 | 你的真实工程目录（每个用户不同） |

**刻意写进去的"预期现象"**，是为了防止对方把正常状态误报成故障：

1. `t1-cakescript: unavailable` —— 本机 SONAR 构建没有可用的脚本引擎入口。
   注意 `cw_list_tracks` 这类工具**虽然注册了但调用会失败**，所以提示词改用
   实测可用的工具做验证，并列出七个"必然失败"的工具（它们唯一的实现依赖
   CakeScript），免得对方拿它们去验证连通性然后误报故障。
2. `t3-surface: unavailable` —— 控制面板已从部署中移除。SONAR 只保存面板配置、
   启动时从不读回（有 PersistSurfaces，没有 LoadSurfaces），所以它无法做到一键部署。
   不装它不影响任何功能。
3. `t5-uia-click: degraded` —— 没打开工程时的正常表现。

**如果你想连的是别的机器**：把提示词里的 `<本机路径>` 换成目标机器的实际路径，
其余不用改。

**如果对方需要 8 个面板诊断工具**（默认不注册）：启动时加环境变量
`CAKEWALK_MCP_SURFACE=1`，工具数会变成 97。日常不需要。

## 只想要配置片段的话

```json
{
  "mcpServers": {
    "cakewalk": {
      "command": "G:\\cakewalkmcp\\runtime\\node.exe",
      "args": ["G:\\cakewalkmcp\\bin\\cakewalk-mcp.js"]
    }
  }
}
```

JSON 里的反斜杠必须写成 `\\`。
