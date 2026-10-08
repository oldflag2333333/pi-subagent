# Facets

[English](README.md) | 简体中文

给 Pi 配置可复用的专用助手，用于代码审查、资料调研等任务。每个助手都在独立的 Herdr 标签页中工作，将结果发回主对话，不继承主对话的聊天记录。

一份 **profile（角色配置）** 定义助手的指令、工具，以及可选的技能和模型。你可以手动调用，也可以让主 Pi 自行委派任务。

## 安装

需要 **Node.js 22.19+**、**[Pi](https://pi.dev) 1.0.4+** 和 **Herdr**。启动助手时，Pi 必须运行在 Herdr 工作区中，并且能调用 `herdr` 命令。

```bash
pi install npm:pi-facets
```

安装后重启 Pi，或执行 `/reload`。Facets 使用 Pi 已有的模型服务凭据，请先确认 Pi 能正常对话。

后续更新：

```bash
pi update npm:pi-facets
```

更新后同样需要重启 Pi 或执行 `/reload`。

## 快速上手：代码审查助手

Facets 不附带内置角色。先创建一个：

```bash
mkdir -p ~/.pi/agent/facets/profiles/reviewer
```

将以下内容保存为 `~/.pi/agent/facets/profiles/reviewer/config.json`：

```json
{
  "version": 1,
  "name": "reviewer",
  "description": "检查代码中的缺陷和测试遗漏，不修改文件。",
  "tools": ["read", "grep", "find", "ls"]
}
```

在同一目录下创建 `instructions.md`：

```markdown
检查指定代码中的缺陷、回归风险和测试遗漏。
不要修改文件。报告具体、可操作的问题，并附上文件路径和行号。
如果没有发现明显问题，请明确说明，并指出尚未验证的部分。
```

在 Pi 中执行 `/reload`，然后输入：

```text
/sub:reviewer 检查 src/auth 中的认证代码。
```

将 `src/auth` 替换为你项目中的路径。审查助手会在独立的 Herdr 标签页中启动，并将结果发回主对话。等待期间，你可以继续处理其他工作。

也可以直接让主 Pi 委派：

```text
让 reviewer 检查 src/auth 中的缺陷和测试遗漏。
```

## 日常使用

| 你想做什么 | 操作方式 |
| --- | --- |
| 查看可用角色或配置错误 | `/profiles` |
| 启动助手，或给它追加任务 | `/sub:reviewer <任务>` |
| 让 Pi 选择助手 | 告诉 Pi 将任务委派给合适的角色 |
| 查看进度 | 让 Pi 列出子助手，或打开助手的 Herdr 标签页 |
| 停止当前任务，但保留助手会话 | 让 Pi 中断该子助手 |
| 结束使用 | 让 Pi 关闭子助手，或手动关闭其 Herdr 标签页 |

在同一个主会话（Main）中，多次调用 `/sub:reviewer` 会复用该角色已打开的子助手（Sub）。如果它正在工作，新任务会排队。任务完成后，标签页不会自动关闭。

如果想将角色应用到当前 Pi，而不是打开子助手，可以这样启动：

```bash
pi --profile reviewer
```

不传入 `--profile` 时，Pi 原有的工具、模型和技能配置保持不变。

## 自定义角色

### 配置放在哪里

- **个人配置：** `~/.pi/agent/facets/profiles/<name>/`
- **项目配置：** 项目或其上级目录中的 `.pi/facets/profiles/<name>/`，仅在项目信任后加载。

每个目录都需要一份 `config.json`，其中的 `name` 必须与目录名一致。距离当前工作目录更近的项目配置会替换上级目录或个人目录中的同名角色，不会合并字段。旧式的 `<name>.json` 单文件配置仍然受支持。

### 角色指令

将角色说明写在 `config.json` 旁边的 `instructions.md` 中。它优先于 JSON 内的 `"instructions": "..."` 字段；文件不存在时才使用 JSON 字段。角色指令会补充 Pi 原有的项目上下文，而不是替换它。

指令文件不能为空，且不能超过 65,536 个字符。文件无效或无法读取时会报错，不会静默忽略。

修改角色后执行 `/reload`。已经打开的子助手保留启动时的配置，需要关闭并重新打开才能使用新配置。

### 可选设置

按需在 `config.json` 中添加：

| 字段 | 作用 |
| --- | --- |
| `"invocation": "manual"` | 只允许用户通过 `/sub:reviewer` 等命令启动。默认值为 `"both"`，也允许 Pi 自行委派。 |
| `"sessionPersistence": "persistent"` | 保存子助手对话，关闭后可以恢复。默认值为 `"ephemeral"`，仅保存在内存中。 |
| `"model": "provider/model-id"` | 指定 Pi 配置中可用的模型。 |
| `"thinkingLevel": "high"` | 请求所选模型支持的思考级别。 |
| `"skills": ["skill-name", "./path/to/SKILL.md"]` | 加载已安装的技能，或使用相对于角色配置的路径。 |

通过 `/sub:reviewer` 启动的持久化助手，在关闭后，可以从同一个已保存的主会话中再次执行该命令来恢复。不同的主会话各自拥有独立的助手。设置为手动调用的角色不能由 Pi 自行委派。

### 角色专属技能

将技能放在角色目录中，就只会在选中该角色时加载，无需填写 `skills` 字段：

```text
reviewer/
├── config.json
├── instructions.md
└── skills/
    └── code-review/
        └── SKILL.md
```

### 主 Pi 的委派规则

在 `~/.pi/agent/facets/MAIN.md` 或受信任项目的 `.pi/facets/MAIN.md` 中写入规则，例如：

```markdown
宣布任务完成之前，让 reviewer 审查本次代码变更。
```

这些指令只适用于主 Pi，不会加载到子助手中。主 Pi 和子助手都需要遵守的项目规则应放在 `AGENTS.md` 中。

## 使用须知

- **子助手依赖 Herdr。** 不支持无界面后台运行；最多同时打开四个子助手，子助手不能继续委派。
- **角色配置不是沙箱。** 子助手以你的系统用户身份运行，配置“只读角色”不等于限制文件系统权限。
- **MCP 沿用 Pi 的常规配置。** 角色只选择非 MCP 工具，不隔离或筛选 MCP 服务。自定义的非 MCP 工具必须来自主 Pi 已加载的扩展。
- **子助手拥有独立对话。** 它会收到任务、角色配置和常规项目上下文，但不会收到主对话的聊天记录。请在任务中提供必要信息。
- **重载主 Pi 不会关闭子助手。** 不再需要时请关闭标签页；异常崩溃后可能需要手动清理。

如果找不到角色或启动失败，先运行 `/profiles`，检查目录名与 `name` 是否一致、项目是否受信任，以及引用的工具和技能是否可用。如果提示 Herdr 不可用，请确认 Pi 正在 Herdr 工作区内运行。

如需在 Herdr 的 Agents 面板中隐藏或显示 Facets 子助手，可安装可选的 [Herdr 配套插件](herdr-plugin/README.md)（英文说明）。

## 开发

```bash
npm install
npm run check
pi -e ./src/index.ts
```

维护者可参考[发布指南](docs/releasing.md)（英文），了解 CI 和 npm 自动发布流程。
