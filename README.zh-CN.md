[English](README.md) · **简体中文** · [日本語](README.ja.md)

> 以英文版 [README.md](README.md) 为准。

# Apple Health MCP — Mibly Receiver

一个开源的 **Apple Health MCP 服务**:把你的 Apple Health(HealthKit)数据——睡眠、步数、心率、HRV、运动、体重、体脂等——接入 Claude Desktop/Code、Codex,或任何你自己搭建、自己运行的 AI Agent(只要支持 MCP 即可)。

**Local 模式:你的数据不会经过 Mibly 的服务器。** 无需账号、无云端、无遥测。数据加密存放在你自己掌控的机器上,而本仓库就是实现这一点的代码。

## 最快上手方式

1. **在 iPhone 上下载 Mibly** → [App Store](https://apps.apple.com/us/app/mibly-health-data-for-ai/id6812404098)
2. **复制安装提示词**:来自 [mibly.app](https://mibly.app/) <!-- TODO: replace with the exact prompt page URL -->,粘贴给你的 Agent。

Agent 会替你搭好 Receiver 和 MCP 服务。无需克隆、无需构建、无需手写配置文件。

## 为什么需要 iPhone App?

Apple Health 数据只能通过 HealthKit 在原生 iOS App 内读取,没有网页 API。Mibly 负责 HealthKit 这一侧——权限、后台同步和数据格式化——所以你不需要 Apple 开发者账号,也不需要 Xcode。

## 这个仓库是什么

这是你的 Agent 所安装的 Receiver 的参考实现。放在这里是为了让你可以:

- **审查**你的机器上到底运行了什么、数据去了哪里
- **自定义**它(如果你愿意)

使用 Mibly 并不需要这份代码,推荐的方式是上面的安装提示词。

## 数据去了哪里?

| 问题 | 回答 |
|---|---|
| 健康数据存在哪里? | 只存在 `~/.mibly/data.enc`。AES-256-GCM,密钥 = scrypt(配对 token, 随机 salt)。 |
| 服务会主动发起对外网络请求吗? | 不会。它只监听。没有遥测,没有更新检查。 |
| 谁能通过网络读取? | 持有配对 token 的人。所有路由都要求 `Authorization: Bearer <token>`。 |
| 保留多久? | 30 天历史(最多 25,000 条样本)。每种类型只有"最新一条"会保留得更久。 |
| 传输过程加密吗? | **不加密。** Local 模式是为家庭或办公室局域网设计的:iPhone 和 Receiver 在同一个 Wi-Fi 下,使用明文 HTTP 通信。不要把端口暴露到公网。 |

你可以自己验证。下面的命令应该没有任何输出:

```sh
grep -rnE "fetch\(|https?\.request|axios|net\.connect|XMLHttpRequest" src
```

通信协议(接口、数据格式、存储格式)见 [PROTOCOL.md](PROTOCOL.md),威胁模型见 [SECURITY.md](SECURITY.md)(均为英文)。

## 自己运行

需要 Node.js 18+。

```sh
npm ci
npm run build
MIBLY_TOKEN=<token from the Mibly app> npm start
```

首次运行时,token 会保存到 `~/.mibly/config.json`(权限 0600),之后重启不再需要环境变量。启动时 Receiver 会打印可用的地址,例如 `Target Host to enter in Mibly: 192.168.1.24:7345 (en0)`。把它填到 App 的"目标主机"(Target Host)一栏即可(只填 `IP:端口`,不要 `http://`,不要路径);如果列出了多个地址,选你的 Wi-Fi/局域网那一个。

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MIBLY_TOKEN` | 来自 App 的配对 token | 已保存的配置 |
| `MIBLY_HOST` | 监听地址 `host:port` | `0.0.0.0:7345` |

MCP 客户端通过 HTTP 连接 `http://<ip>:7345/mcp`,并带上请求头 `Authorization: Bearer <token>`。对于以 stdio 方式启动 MCP 服务的 Agent,加上 `--stdio`(日志输出到 stderr)。

如果你在 App 里重新生成了 token,请用新的 `MIBLY_TOKEN` 重启。旧的加密数据无法用新密钥解密,所以 Receiver 会从空库开始。

代码地图:`src/index.ts`(路由)· `src/auth.ts`(token 校验)· `src/config.ts`(`~/.mibly/config.json`)· `src/ingest.ts`(校验)· `src/store.ts`(加密、保留、查询)· `src/mcp.ts`(两个工具)。运行测试:`npm test`。

## Local 与 Cloud

| | Local(免费) | Cloud(Pro) |
|---|---|---|
| 数据路径 | iPhone → 你自己掌控的 Agent 环境 | iPhone → Mibly Cloud → 你的 Agent |
| 跨设备远程访问 | — | ✓ |
| 多个 Agent 共用同一份数据 | — | ✓ |
| 经期数据 | 可用(默认关闭) | 永不上传 |

本仓库只涵盖 Local。你可以选择共享哪些数据类型,并随时关闭其中任何一种。

## 说明

- Mibly 不做诊断,也不做医疗决策。它只是让你的 Agent 访问你选择共享的数据。
- 本仓库的 Issue 仅用于 Receiver 代码。App 相关支持请见 [mibly.app](https://mibly.app/)。
- 隐私政策:https://mibly.app/privacy/

## 许可证

MIT <!-- TODO: confirm license -->
