# qq-agent

把 **NapCat**(QQ 协议端)、一层自己的 **Agent**、以及 **OpenCode**(干重活)整合在一起:
NapCat 登录一个 QQ 小号,Agent 通过它收发消息、管理这个号,实际的工作交给 OpenCode 去做。

```
QQ 小号 ── NapCat (OneBot 11, WebSocket) ── Agent ── OpenCode (opencode serve)
                                             │
                                             ├─ 每个会话(一个群/一个私聊)独立的上下文,保留近 200 条,更早的整理成摘要
                                             ├─ 跨会话长期记忆:群里说过的事,私聊里也记得
                                             ├─ 群聊每条新消息都做一次「要不要插嘴」的判定
                                             ├─ 一次回复可拆成多条消息(<msg> 标签)
                                             ├─ 图库:图片/动图/表情包/视频自动入库并生成描述索引,可发表情包
                                             └─ 本地 Web 控制台:改设置、看状态、管服务
```

## 安装(Ubuntu / Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/xirenlei/fi/main/qq-agent/install/install.sh | bash
```

或者把仓库克隆下来,在本地运行 `qq-agent/install/install.sh`。脚本会:

1. 用 apt 装系统依赖(git、curl、unzip、jq、ffmpeg、xvfb 等,需要 sudo;没有权限时加 `QQA_SKIP_DEPS=1` 并自行安装)
2. 安装 Bun(Agent 的运行环境,没有运行时依赖)
3. 安装最新版 OpenCode
4. 调用 NapCat 官方安装脚本,免 root 把 QQ 与 NapCat 装到 `~/Napcat`(QQ 从腾讯官方地址下载)
5. 写好配置(随机生成 NapCat 的访问 token,管理界面只监听本机)
6. 注册三个用户级 systemd 服务(没有 systemd 时用简易守护),并在桌面放一个「QQ Agent」图标
7. 启动全部服务

装完后:

1. **登录 QQ**:打开安装结束时打印的 NapCat 管理界面地址(`http://127.0.0.1:6099/webui?token=...`),用小号扫码。
2. **打开控制台**:桌面图标,或运行 `qq-agent open`(地址 `http://127.0.0.1:8765`)。
   在「设置」里填 DeepSeek API Key,把**你自己的 QQ 号**填进「管理员」。
3. 用别的 QQ 号给小号发条消息试试。

> 「管理员」是写进提示词的:管理员的话优先听。没有硬性的权限限制——别人让它改资料、跑命令、调 OpenCode 时由它自己判断,合理无害的会照做,涉及密钥、破坏性操作或明显是捉弄的会拒绝。所以请把它跑在专用机器上。

## 日常使用

```bash
qq-agent status                 # 三个服务的状态
qq-agent restart [napcat|opencode|agent]
qq-agent logs agent             # 也可以 napcat / opencode
qq-agent open                   # 打开控制台
```

配置文件 `~/.config/qq-agent/config.json`(含密钥,权限 600,不要提交或分享)。
控制台里改的设置大部分立即生效;改 NapCat 地址/token 或控制台端口需要重启 Agent。

### 默认模型

主模型和轻量模型默认都是 `deepseek-flash`,API 地址 `https://api.deepseek.com`,都能在控制台改。

- 主模型:聊天与工具调用。
- 轻量模型:群聊插嘴判定、图片描述、会话摘要(这些请求量大、不需要深度思考)。
- **思考内容**:每次回复的 `reasoning_content` 会保存,只把最近 N 轮(默认 20)带回给模型,更早的丢弃以省 token。
  同一轮里的工具调用循环必须带回思考内容,这点始终保证。如果接口拒绝历史轮次里的思考内容,会自动降级为不回传。
- 「额外请求参数」是个 JSON,会合并进每个请求体,接口参数有变化时可以直接在这里适配。

### 它怎么决定说话

- 私聊:每条消息都回复。
- 群聊:被 @ 或被回复时必回;其他消息先让轻量模型判定「要不要接话」,有冷却时间。判定为否就保持沉默。
- 模型自己决定发几条消息、发不发表情包;不想说话时输出 `<silent/>`。

### 图片、动图、表情包、视频

收到的媒体会自动存进 `~/.config/qq-agent/media/`,文件名带摘要。
图片只在刚收到的那一轮直接给模型看,同时单独发一个轻量请求生成描述;之后聊天记录里只保留 `[图片#13:摘要]` 这样的占位。
动图和视频用 ffmpeg 抽几帧再描述。Agent 可以按关键词搜图库、发表情包、把图片收藏为表情包、删除不要的内容。

### 管理 QQ 号本身

Agent 能改昵称、个性签名、头像,发/删 QQ 空间动态(可带图库里的图,可选公开/仅好友/仅自己),改在线状态;
也能点赞、戳一戳、给消息贴表情回应。这些都是 NapCat 提供的接口。

### 自主行动

它不只被动回复。每隔一段时间(默认平均 2 小时,随机浮动,凌晨 1 到 8 点安静)会进入「自由时间」:
拿到各个聊天的最近动静,自己决定要不要发动态、改签名/状态、主动找某个人或群说句话、整理图库、跟进之前记的事,也可以什么都不做。
它自己做过的事会记在记忆里,下次不重复。在控制台「设置 → 自主行动」可以开关、调间隔和安静时段,
「概览」页有按钮可以立即触发一次来测试。每次唤醒是一次模型请求。

### OpenCode

它把任务交给 OpenCode 后台执行,**完成后主动向发起任务的聊天汇报**(自己在自由时间提交的任务,完成后会唤醒它自己处理)。
OpenCode 使用与 Agent 相同的 DeepSeek Key(也可单独设置),工作目录默认 `~/.config/qq-agent/workspace`,
权限已放开(无人值守时不会卡在确认上),所以请把它跑在专用机器上。

## 开发

```bash
cd qq-agent
bun test            # 测试(用模拟的 NapCat / 模型 / OpenCode 服务)
bun run typecheck
bun run start       # 用 ~/.config/qq-agent 的配置运行
```

目录:

| 路径 | 内容 |
| --- | --- |
| `src/napcat/` | OneBot 11 客户端、消息解析 |
| `src/agent/` | 主循环、提示词、插嘴判定、输出解析、工具注册 |
| `src/llm/` | Chat Completions 客户端与思考内容处理 |
| `src/memory/` | SQLite 存储、摘要 |
| `src/media/` | 图库、抽帧、描述索引、收发 |
| `src/opencode/` | OpenCode 进程与任务管理 |
| `src/web/` | 本地控制台 |
| `install/` | 安装脚本、服务管理命令、配置写入 |

## 安全说明

- 控制台只监听 `127.0.0.1`,校验 Host,写操作需要自定义请求头;要远程访问请用 SSH 端口转发。
- NapCat 的 WebSocket 和管理界面也只监听本机,WebSocket 带随机 token。
- Agent 的 shell/读文件等工具没有硬性权限限制,靠提示词约束;OpenCode 的权限也是放开的。请只在专用机器上运行。
