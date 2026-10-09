# Pi Subagent 发布指南

[English](releasing.md) | 简体中文

## CI 已配置的内容

工作流位于 `.github/workflows/release.yml`：

- `main`、`dev` 的推送和 PR：在 Node **22.19.0 / 24** 上执行类型检查、测试、包信息校验和打包检查。
- Node 24 检查通过后上传 `.tgz` 安装包，名称为 `npm-package-<提交 SHA>`，保留 14 天。
- 可以在 **Actions → CI and Release → Run workflow** 手动运行检查，不会发布。
- 只有新仓库 `main` 上的**版本递增**才会在所有检查通过后自动发布 npm、创建版本标签和 GitHub Release。

普通代码提交、PR、手动运行 CI、推送标签都不会触发发布。正式版使用 npm 的 `latest`，预发布版使用 `next`。

## 首次发布 0.1.0

npm 包名为 **@oldflag2333333/pi-subagent**。

**npm 要求包已经存在，才能配置 Trusted Publisher。** 因此首次发布需要你登录 npm 手动完成，之后才使用 CI 自动发布。参见 [npm 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)。

1. 为 npm 账号开启双因素认证（2FA）。
2. 将准备发布的代码推送到 `main`，等待整个 **CI and Release** 工作流通过。
3. 下载该次运行的 `npm-package-<提交 SHA>` artifact 并解压。使用确认过的 `main` 构建，不要使用 PR 的产物。
4. 在解压目录中执行：

   ```bash
   npx --yes npm@11.21.0 login --registry=https://registry.npmjs.org
   npx --yes npm@11.21.0 publish ./oldflag2333333-pi-subagent-0.1.0.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org
   ```

   按提示完成浏览器登录和 2FA，不要把凭据或验证码发给助手。直接发布 CI 打好的包，不用在本地重新打包。首次交互式发布不带 CI provenance，也不会自动创建 GitHub Release。

5. 确认结果：

   ```bash
   npm view @oldflag2333333/pi-subagent version --registry=https://registry.npmjs.org
   ```

## npm 网站上需要配置什么

进入 **@oldflag2333333/pi-subagent 包页面 → Settings → Trusted publishing → Add trusted publisher → GitHub Actions**：

| 字段 | 填写内容 |
| --- | --- |
| Organization or user | `oldflag2333333` |
| Repository | `pi-subagent` |
| Workflow filename | `release.yml`，不要填完整路径 |
| Environment name | 留空 |
| Allowed actions | 勾选允许直接 `npm publish`，不能只有 staged publishing |

**GitHub 不需要添加 `NPM_TOKEN`。** 工作流使用 OIDC 临时身份，标签和 Release 使用 GitHub 自动提供的 token。

新建的信任配置需要在 **2 天内成功完成一次 OIDC 发布**，否则会过期。准备发布下一版时再配置；过期后删除并重建即可。验证自动发布成功后，建议将 **Publishing access** 设置为 **Require two-factor authentication and disallow tokens**。

来源：[npm Trusted publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

## 后续发布

在干净的工作区中执行：

```bash
npm version patch --no-git-tag-version
# 0.1.0 → 0.1.1
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
git push origin main
```

如果仓库要求 PR，就通过 PR 将版本变更合入 `main`。之后 CI 自动完成 npm 发布、标签和 GitHub Release，不需要再手动 `npm publish`，也不要提前创建标签。

发布失败时，修正 npm 等外部配置后，重跑**原来失败的工作流**。相同产物不会重复发布；标签或包内容冲突会报错，不会覆盖。不要用同一个 npm 版本号发布不同内容，也不要并行发布多个版本。
