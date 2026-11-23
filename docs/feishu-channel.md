# Feishu Channel 使用说明

把 kda agent 变成飞书 bot：在飞书里私聊（或群里 @）机器人，消息进入与终端 REPL **同一个 agent session**，回复以引用式消息回到飞书。长连接模式（官方 SDK 的 WSClient），**无需公网 IP/域名**，本机跑 kda 即可。

## 快速开始

```bash
# 1. 配置凭据（仓库根 .env，已被 gitignore）
cp .env.example .env   # 已有则补齐以下三项
#   KDA_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
#   KDA_FEISHU_APP_SECRET=...
#   KDA_FEISHU_CHAT_ID=    # 可选，见下文"单会话策略"

# 2. 启动 kda 并开启渠道
pnpm dev
/channel start feishu
#   → Channel "feishu" starting → connecting (long connection)…
/channel list
#   → feishu  [running]  long connection ready

# 3. 在飞书里私聊机器人发消息
```

说明：
- SDK 惰性加载：只有执行 `/channel start feishu` 时才会 import 飞书 SDK，不用的用户零成本
- `kda` 进程退出（空行或 EOF）时渠道自动关闭；想让 bot 常驻就在 tmux/screen 里跑 kda，并保持 stdin 打开
- `/channel stop feishu` 手动断开；群聊需要 @机器人

## 飞书应用配置（自建应用，一次性）

在[飞书开发者后台](https://open.feishu.cn)完成，**任何变更后都必须创建新版本并发布**（含企业管理员审核），否则不生效：

1. 创建**企业自建应用** → 凭证与基础信息页拿 App ID / App Secret
2. 添加应用能力 → **机器人**
3. **事件与回调 → 订阅方式选「使用长连接接收」**（默认的 webhook 模式下本渠道收不到任何事件）
4. 事件配置 → 添加 **接收消息 `im.message.receive_v1`**
5. 权限管理 → 开通「**获取用户发给机器人的单聊消息**」和 `im:message:send_as_bot`
6. 版本管理 → 创建版本并发布

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `KDA_FEISHU_APP_ID` | ✅ | 格式 `cli_` + 16 位十六进制，格式错误会在 start 时立即报错（SDK 对非法 id 会静默不连） |
| `KDA_FEISHU_APP_SECRET` | ✅ | 应用密钥 |
| `KDA_FEISHU_CHAT_ID` | — | 会话白名单（`chat_id` 逗号分隔） |

Provider 相关变量（`DEFAULT_PROVIDER` / `ZHIPU_API_KEY` / `ZHIPU_BASE_URL` 等）见根 `.env.example`。注意 coding 套餐需 `ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4`。

## 单会话策略

v1 是单 agent 实例：所有消息共享同一 session。默认**首会话绑定**——启动后第一个来消息的会话被绑定，其它会话会收到提示（附其 `chat_id`）；把该 id 填进 `KDA_FEISHU_CHAT_ID` 可显式指定（支持多个，逗号分隔）。重启后绑定重新开始。

## 排错速查

| 症状 | 排查 |
|---|---|
| `/channel start feishu` 立即报错 | 缺 env 或 App ID 格式错，按提示修 `.env` |
| 连接正常但发消息无反应 | 控制台三件套：订阅方式=**长连接**？`im.message.receive_v1` 已订阅？单聊消息权限已开？改过后**发布版本**了吗？ |
| 飞书收到 `(no reply)` | agent 轮次无产出——多半是模型供应商报错（余额/网络），看终端日志 |
| 回复没到但终端有输出 | 看 `[feishu]` 开头的 warn（reply 失败会降级 create，仍失败会打印错误码） |

## 行为细节

- **3 秒规则**：飞书要求事件处理 3s 内返回否则重推——渠道只做同步解析+入队，agent 回合异步跑完后统一回信（架构天然满足）
- **消息类型**：v1 只处理文本；图片/富文本等静默忽略
- **回复方式**：优先引用式回复（`im.message.reply`），失败降级为普通发送（`im.message.create`）到同会话
- **重推去重**：按 `message_id` 去重（有界缓存），飞书 at-least-once 推送下防重复处理
