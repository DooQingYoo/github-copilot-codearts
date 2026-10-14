# 项目指令：github-copilot-codearts

一个 VS Code 扩展，把**第三方国内 LLM 服务**接入 VS Code Copilot Chat 与 Agent 模式。
目前接入两家：`codebuddy`（腾讯 CodeBuddy 国内版）与 `qodercn`（阿里 Qoder 中国版）。

## 技术栈与约束

- **Node.js**：22 或更新版本。
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `out/`。
  `npm run compile` = `tsc -p ./` + `copy-wasm`（把 `src/qoder-cn-wasm.wasm`
  复制到 `out/qoder-cn-wasm.wasm`）。
  ⚠️ **`tsc` 不会复制 `.wasm`**，所以任何新加的二进制资产都必须在 `compile`
  脚本里显式复制，否则运行时 `readFileSync` 找不到文件。
- **测试**：`@vscode/test-cli`（`npm test`，先 `compile` + `lint` 再在
  Extension Development Host 中运行）。测试文件在 `src/test/`，会被编译到
  `out/test/`。
- **代码风格**：制表符缩进；单引号；语句结尾分号；`import * as vscode from 'vscode'`。
- **类型定义**：`@types/vscode@1.140.0`。⚠️ **该版本的 Chat Provider API 仍很新**，
  很多 DSH 主仓库里存在的字段（如 `reasoningEfforts`）**在这里没有** ——
  写代码前先 grep `node_modules/@types/vscode/index.d.ts` 核对，别凭印象用。

## ⚠️ 改完宿主侧代码必须重新编译并重启扩展开发宿主

宿主侧代码不是热重载的（只有客户端 bundle 才有 HMR）。**排查「改了没效果」时
先确认 `out/` 的 mtime 晚于改动时间**，并重启 Extension Development Host。

## 插件契约

- provider 通过 `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` 注册，
  且 `vendor` 必须同时在 `package.json` 的 `contributes.languageModelChatProviders`
  里声明（否则注册报错）。
- 每个 provider 的 `managementCommand` 指向一个命令，用户从模型选择器点「管理」
  时触发登录。
- 凭据一律存 `vscode.SecretStorage`，key 形如 `github-copilot-codearts.<provider>`。
- `activate()` 里所有 `Disposable` 都要 `context.subscriptions.push(...)`。

## ⚠️ `LanguageModelChatProvider` 的几个易错点（本仓库实测）

| 陷阱 | 说明 |
|------|------|
| `options.silent` | 为 `true` 时**不应触发登录/弹窗**，只做「凭据是否存在」的静默判断，否则每次打开模型选择器都会弹窗 |
| `provideLanguageModelChatResponse` 的 `options` | 该版本**没有** `system` / `maxTokens` 字段，只有 `modelOptions` / `tools` / `toolMode`。最大输出要取 `model.maxOutputTokens` |
| 工具调用 | 必须把 assistant 的 `tool_calls` 与 `role:'tool'` 的 `tool_call_id` **都**下发，缺一模型就「看不到自己调用过什么」→ 反复重调或编造 |
| 图片 | 带图消息的 `content` 必须是**多模态数组**（`{type:'image_url',...}`），压成纯文本会静默丢图 |
| 消息 part 判定 | 用 `instanceof vscode.LanguageModelTextPart` 等，不要靠 `type` 字段（`LanguageModelInputPart` 是类实例联合会） |
| 结束帧 | 见下「SSE 结束帧」 |
| 思考强度选择器 | 见下「思考强度（reasoningEffort）」 |

## ⚠️ 思考强度（`reasoningEffort`）：schema 声明 + 发送前再校验

两个 provider 都支持用户在模型选择器里**自由切换思考强度**。三条不变式：

1. **数据是契约，不能编** —— 档位值原样发上游，发未知档位会被以非法参数 400 拒绝。
   - Qoder 用 `qoderCn-models.ts` 里的实测 `efforts` / `supportsDisable`（`qoderCnEffortsFor` 会按 `supportsDisable` 补 `'none'`）。
   - CodeBuddy 用 `codebuddy-provider.ts` 的 `CODEBUDDY_EFFORTS`（对齐官方客户端与参考实现 `deepseek-harness-codearts` 的 `REASONING_EFFORTS`）。
   - ⚠️ **只有可枚举档位的模型才声明 `configurationSchema`**；不声明 = 不可配置。**不要声明空枚举**（UI 会出现无意义空下拉）。
2. **发送前必须再校验一次**：用户选的档位可能来自**缓存的旧目录**，`efforts.includes(selected)` 不成立就按未选处理（不要发）。
3. **两个 provider 的字段名/开关语义不同**（同族不等于同字段）：
   - CodeBuddy：`reasoning_effort` +（DeepSeek 系）`thinking:{type:'enabled'}`。实测**`reasoning_effort` 才是真正的开关**，`thinking` 单独不生效（保留它只为对齐官方出站形态）。
   - Qoder：`parameters.reasoning_effort`，且 `enable_thinking = (effort !== 'none')` —— **关闭思考靠把 `enable_thinking` 翻 false**，不是照发 `'none'`。

⚠️ **类型定义是本仓库本地补的**（`src/vscode.proposed.modelConfiguration.d.ts`）：
`@types/vscode@1.140.0` 尚无 `configurationSchema` / `modelConfiguration`，而 VS Code 1.141+ / Copilot Chat 0.48+ 已支持。运行时若 VS Code 不读该字段，**降级为「不可配置」而非报错**，故调用点一律用 `options.modelConfiguration?.x` 兜底。
⚠️ 不要把这条经验写死成「VS Code 不支持思考档位」 —— 官方曾用 `reasoningEfforts` 字段名，本版本换成了 `configurationSchema` + `modelConfiguration` 这套通用 JSON Schema 机制。

## ⚠️ Qoder（中国版）协议：逐条踩过的坑

### 冒烟排查顺序

1. 先看是否登录成功、模型列表是否出现（`qoder-cn-auth.ts` / `qoder-cn-models.ts`）。
2. 对话报错时，**先看错误信息里带出的「原始帧」**——`consumeQoderSse` 的
   「无法解析的 SSE 数据」与「业务错误」两条都会把原文（前 2000 字符）带进
   `message`，这是排障的第一手证据。

### 推理必须走加密端点

公开的 OpenAI 兼容端点**不认目录 key**（`qfmodel` / `dmodel` 等），且 CN 的公开
端点实测 503。真实链路是：

```
POST {encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
body: <由 src/qoder-cn-wasm.ts 加密>
```

- **`Authorization` 头由 WASM 生成**（`Bearer COSY.<载荷>.<签名>`），**原样透传**，
  不能自己用 `Bearer <token>` 覆盖 —— 否则 `403 Signature invalid`。
- 请求体必须带 **`business: { type: 'agent' }`** 与 **`uid`**：
  - 缺 `business` → 服务端路由到故障节点 → `[FAIL]node:... msg:Execution failed`；
  - 缺 `uid` → 签名无效（`Signature invalid (101)`）。
- **`session_type` = `qoder_work`**（国际版是 `qodercli`，CN 不同）。
- WASM 上下文（`QoderEncryptedInfer`）**一次请求一个实例，用完必须 `dispose()`**：
  进程级共享的 wasm 堆只增不减，长会话会以裸 `RuntimeError: unreachable` 暴毙。
  释放失败**只记日志、不上抛**（清理动作不该改写本次请求的结论）。

### ⚠️⚠️ SSE 结束帧：信封里包着 `"body":"[DONE]"`（真实缺陷，2026-10-13）

Qoder 的结束帧形如：

```json
{"headers":{"Content-Type":["application/json"]},"body":"[DONE]","statusCodeValue":200,"statusCode":"OK"}
```

`consumeQoderSse` 的处置顺序**必须**是「先剥信封，再判 `[DONE]`」：

- 若只在**剥信封之前**判 `[DONE]`，剥出来的 `frame === '[DONE]'` 会漏网 →
  被 `classifyInner` 误归为 `chunk` → `JSON.parse('[DONE]')` **抛错**。
- 症状极具误导性：**模型内容全部正常输出**，但最后稳定报「无法解析的 SSE
  数据」并触发 Copilot 整轮重试（实测重试 3 次、每次都输出一遍）。

其余规范：

- 响应是**带信封的 SSE**，内层 `body` **未加密**，剥信封即得标准 OpenAI chunk。
- 心跳帧（`body: null` / 空串 / `{}`）要**整帧跳过**，不能透传（透传后
  `data: null` 会让下游 `JSON.parse('null')` 得到 `null`）。
- 分类靠**结构**（`choices` / `usage` / `error` 字段），不要靠字符串嗅探
  （`includes('"choices"')` 有正反两向缺陷）。
- 报错**必须带出原文**，否则「纯文本错误体」（如 `[FAIL]node:...`）与真正的
  解析缺陷会混成一条无信息量的错误。

## 与参考实现的关系

`https://gitee.com/iJetLi/deepseek-harness-codearts.git` 是这套协议实现的**参考源**：

- `src/qoder.ts` / `qoder-oauth.ts` / `qoder-wasm.ts` / `qoder-product.ts` /
  `qoder-adapter.ts` ↔ 本仓库的 `qoder-cn*.ts`。
- `src/qoder-auth-wasm.wasm` ↔ 本仓库的 `src/qoder-cn-wasm.wasm`（**同源**）。

⚠️ **差异是有意的，别为了「对齐」而抹平**：

- 参考实现是多账号池 + 积分/签到 + 聚合渠道 + 限流切号，本扩展是**单凭据 +
  只做推理**（用户明确要求）。移植时只取「协议 + 推理」部分。
- 参考实现用 DSH 的 `LlmAdapter` / `LlmError` / `consumeOpenAiSse`，本扩展用
  VS Code 的 `LanguageModelChatProvider` / `Progress`，接口层自己实现。
- 参考实现按 provider **工厂 + 产品配置**接入多家，本扩展**每个 provider 一套
  独立实现**（与既有 CodeBuddy 保持一致）。

## 测试与验证

- 纯函数（PKCE、URL、凭据、模型目录、折扣推算、消息/工具/请求体构造、SSE 消费）
  优先单测，**不 mock fetch**。见 `src/test/qoder-cn.test.ts`。
- SSE 消费器已导出（`consumeQoderSse`），可用 `new Response(text).body!` 直接喂
  字符串测各种帧形态。
- 加了新帧形态的处置逻辑（如心跳/结束帧），**补一条回归用例**：本仓库的
  `[DONE]` 缺陷正是靠「内容正常但稳定报错」的现象反推出来的。
- 改动后跑 `npm test`（含 `lint`）；全绿再交付。
