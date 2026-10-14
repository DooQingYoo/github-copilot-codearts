# github copilot codearts

将腾讯 CodeBuddy 国内版与阿里 Qoder（中国版）模型接入 VS Code Copilot Chat 和 Agent 模式，推理请求使用对应账号的模型额度。

## 功能

- **CodeBuddy**：使用 CodeBuddy 官方授权流程登录，凭据保存在 VS Code `SecretStorage`。
- **Qoder（中国版）**：使用 Qoder PKCE 设备码流程登录，凭据同样保存在 `SecretStorage`。
- 从远端获取（CodeBuddy）或使用内置目录（Qoder）提供模型列表。
- 支持流式文本响应、工具调用、工具结果和图片输入。
- 请求时自动刷新即将过期的访问令牌。

## 使用

1. 在 VS Code 扩展开发宿主中运行本扩展，或安装打包后的 VSIX。
2. 打开命令面板，运行 `CodeBuddy: 登录 / 管理账号` 或 `Qoder (中国版): 登录 / 管理账号` 并在浏览器完成授权。
3. 在 Copilot Chat 的模型选择器中选择 `CodeBuddy` 或 `Qoder (中国版)` 下的模型。
4. 如需清除本机凭据，运行对应的 `退出登录` 命令。

Copilot Chat 仍需用户已有可用的 GitHub Copilot Chat。企业版/商业版环境还可能由组织策略控制是否允许自带模型。

## 本地开发

需要 Node.js 22 或更新版本。

```powershell
npm install
npm run compile   # tsc 编译到 out/，并复制 Qoder 的 WASM
npm test          # 编译 + lint + 在 Extension Development Host 中跑测试
```

按 `F5` 启动 Extension Development Host。在开发宿主中登录后即可验证模型目录与聊天调用。

## 项目结构

| 路径 | 说明 |
|------|------|
| `src/extension.ts` | 扩展入口：注册两个 provider 与登录/登出命令 |
| `src/codebuddy-auth.ts` | CodeBuddy 登录与凭据续期 |
| `src/codebuddy-provider.ts` | CodeBuddy 的 `LanguageModelChatProvider` |
| `src/qoder-cn*.ts` | Qoder（中国版）：协议、登录、模型目录、provider、WASM 桥 |
| `src/qoder-cn-wasm.wasm` | Qoder 加密推理用的 WASM（编译时复制到 `out/`） |
| `src/test/` | 单元/集成测试（`@vscode/test-cli`） |
| `out/` | 编译产物（已 gitignore） |

### 两个 provider 的协议差异

| 维度 | CodeBuddy | Qoder（中国版） |
|------|-----------|----------------|
| 登录 | 官方授权轮询（`/v2/plugin/auth/*`） | PKCE 设备码 + 轮询（`/api/v1/deviceToken/poll`） |
| 推理端点 | `copilot.tencent.com/v2/chat/completions`（OpenAI 兼容） | `gateway.qoder.com.cn/algo/.../agent_chat_generation`（**加密**） |
| 请求体 | 明文 JSON | 由 WASM 加密，`Authorization` 头也由 WASM 生成 |
| 模型目录 | 远端（`/console/.../models` + `/v3/config`） | 内置实测表（公开端点不可用） |
| 响应 | 标准 OpenAI SSE | 带信封的 SSE（每帧 `{body:"<inner JSON>"}`） |

## 已知限制

- CodeBuddy 接入腾讯 CodeBuddy 国内版服务地址 `copilot.tencent.com`。
- Qoder（中国版）接入 `qoder.cn` / `openapi.qoder.com.cn` / `gateway.qoder.com.cn`，推理走**加密端点**（`agent_chat_generation`，请求体由随扩展分发的 WASM 加密），因此必须走 `npm run compile` 把 WASM 复制到 `out/`。
- CodeBuddy 模型目录失败时，内置兜底列出 DeepSeek V4 Flash、Hy4 Preview 和 GLM-5.3。
- Qoder（中国版）目前**只提供推理**，未接入积分余额 / 每日领取。
- 两个 provider 都支持**自由选择思考强度**：通过 `configurationSchema` 在模型选择器里暴露 `reasoningEffort`（Qoder 用内置目录里的实测档位、CodeBuddy 用对齐官方客户端的档位表）。
  - CodeBuddy 透传为 `reasoning_effort`，DeepSeek 系额外带 `thinking:{type:'enabled'}`（实测该字段单独不生效、`reasoning_effort` 才是开关）。
  - Qoder 透传为 `parameters.reasoning_effort`，并按「选中 `none` → `enable_thinking=false`」推出开关。
  - ⚠️ 只对**有档位**的模型声明选择器；选择器里的值在发送前会**再校验一次**（防止缓存的旧目录带来非法档位 → 上游 400）。
  - ⚠️ 这些字段属较新 API：类型定义由本仓库的 `src/vscode.proposed.modelConfiguration.d.ts` 本地补充（`@types/vscode@1.140.0` 尚未收录）。运行时若 VS Code 不读它，则降级为「不可配置」而非报错。
- 图片以 Base64 内联发送；超大图可能受请求体限制。
- 使用 GitHub Copilot Business/Enterprise 时，管理员可能禁用自带模型策略。
