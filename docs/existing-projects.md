# 现有项目调研

调研日期：2026-10-09。依据项目 README、使用文档及发布页；未在本机安装运行，以下不代表实测。文档未写明的能力记为“待验证”，不等同于不存在。

## 结论

已有与目标高度重合的桌宠，建议先试用 AgentPaw 与 Clawd on Desk。差异验证重点为：只展示选中的 Agent、切换时自动使用该 Agent 的角色，以及用户实际使用的平台是否提供账户额度。

## 候选比较

| 项目 | 已有能力 | 对本项目的意义与待验证项 |
| --- | --- | --- |
| [AgentPaw / codex-desktop-pet](https://github.com/vista-zhangg/codex-desktop-pet) | Windows x64 桌宠；Codex 5h/7d 额度和 Token 统计；自定义 GIF、角色包、多 Agent 会话 | 与 Windows/Codex 需求接近。需确认单 Agent 模式、按 Agent 绑定角色、其他平台额度范围。 |
| [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) | Windows/macOS/Linux；多 Agent 状态；订阅额度展示；自定义主题和 Codex Pet 包导入 | 适合更多 Agent 与动画包复用。额度取决于源 Agent 实际报告；单 Agent 固定展示及角色绑定待验证。 |
| [AI Pet](https://github.com/thgoas/ai-pet) | Tauri 桌宠；读取 Claude Code、Codex、opencode 本地日志；跨平台安装包 | README 的账户额度百分比来源是 Anthropic，多客户端日志聚合不能据此认定具备 Codex 账户额度；自定义皮肤需继续验证。 |
| [CodexBar](https://github.com/steipete/CodexBar) | 多平台用量、额度窗口与重置时间；仓库列出 Windows 社区版本 | 用量数据接入的参考来源。自身是菜单栏/托盘工具，不是宠物动画底座。 |

AgentPaw 本次查看的发布页为 [v1.9.7](https://github.com/vista-zhangg/codex-desktop-pet/releases/tag/v1.9.7)。

Clawd 的 [接入说明](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/setup-guide.md) 说明：Claude 的本地额度收集默认关闭，开启后使用状态行报告的数据；数据源可能不提供某个额度窗口。不能从“支持某 Agent”直接推断“能显示该 Agent 的全部订阅额度”。

## 动画资源候选

[chatgpt-chibi-pets](https://github.com/fywdy/chatgpt-chibi-pets) 提供 ChatGPT 白发龙娘等多套角色、状态动画和通用预览资源，文档也列出 Clawd on Desk 导入包。白发龙娘是否为用户所指形象仍待确认；尚未下载、安装或打包。

该仓库 [NOTICE](https://github.com/fywdy/chatgpt-chibi-pets/blob/main/NOTICE.md) 将美术资源标为 CC BY-NC 4.0，要求署名且限非商业使用。代码许可与美术资源许可需分别保留。AgentPaw 代码为 MIT；Clawd 代码为 AGPL-3.0，其美术素材另行声明。

## 最小差异验证

1. 安装包是否在目标 Windows 环境正常运行。
2. 是否能锁定并切换当前 Agent，而非始终聚合所有会话。
3. 切换 Agent 后，用量和角色是否能够一起变化并保存配置。
4. Codex 显示的数据是否与账户额度一致，是否标明数据时间。
5. 第二个 Agent 是否也提供所需额度；无数据时是否如实显示不可用。
6. 能否导入用户自制动画，缺失状态如何回退。

若现成功能满足则直接配置使用；若只缺单 Agent 选择与角色绑定，优先在底座上修改这两项。只有底座的数据或动画限制确实阻碍目标时，再考虑独立实现。