# Change Log

All notable changes to the "github-copilot-codearts" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.5]

### Added

- 新增 **OpenRouter** provider：把 OpenRouter 的 OpenAI 兼容端点接入 Copilot Chat。
  - ⚠️ **vendor 名是 `openrouter-byok`（不是 `openrouter`）**：官方契约要求 vendor
    「globally unique」，而 **Copilot Chat 内置的 BYOK 已占用 `openrouter`**。
    重名的症状极具误导性 —— `provideLanguageModelChatInformation` **照样被调用**
    （日志一切正常），但模型选择器里就是不出现我们的模型。
    选择器里显示为「OpenRouter (可自选上游供应商)」以与内置项区分。
  - **没有浏览器登录流程**：命令 `OpenRouter: 设置 API Key` 弹出输入框粘贴 key，
    保存前用 `GET /key` 自检（401/403 才判为无效，网络故障不会被误判成 key 坏）。
  - **模型列表做过滤**：OpenRouter 有 400+ 个模型，全部铺出来会让选择器没法用
    ⇒ 只展示全部免费模型（目录里带 `:free` 后缀的那批）与
    `deepseek/deepseek-v4.1-flash`、`z-ai/glm-5.3-flash` 两个收费模型。
  - **思考强度选项**由目录的 `reasoning.supported_efforts` 声明（上游按降序下发，
    这里按弱 → 强展示，与另外三家一致），发送前再校验一次。它在模型选择器里可选。
  - **上游供应商**取自该模型的 `/endpoints`（两级目录；`/models` 里没有供应商信息）。
    绑定后下发 `provider: { order: [slug], allow_fallbacks: false }`，即**严格只用它、
    不回退**；该家不可用时错误文案会说明这是严格语义的预期代价，并提示改回「自动」。
  - ⚠️ **上游绑定走「命令 + 设置」，不进模型选择器**（新增命令 `OpenRouter: 选择上游供应商`）：
    VS Code 的模型选择器只给每个模型**两个固定槽位**（`navigation` = 思考强度 /
    `tokens` = 上下文窗口），同一槽位只取一个属性；而借用 `tokens` 槽会让 VS Code
    把我们当成「扩展上下文档」并**显示错误的价格**（判据是「值 == 枚举最后一项」）。
    绑定存在设置项 `github-copilot-codearts.openrouter.pinnedProviders` 里
    （在 settings.json 里可见、可手改；留空或写 `"auto"` 表示交回负载均衡）。
  - SSE 处理：跳过 `: OPENROUTER PROCESSING` 心跳注释帧；把**流内 `error` 帧**
    （HTTP 已是 200，且可能是流里唯一的事件）当作失败抛出；上报上游总是附送的带
    `usage` 的末帧。
  - **刻意不下发 `max_tokens`**：它会参与 OpenRouter 的路由过滤，会让用户锁定的
    上游在路由阶段就被排除（模型级 `top_provider.max_completion_tokens` 是榜首
    那家的上限，各家在 131072 ~ 943718 之间分布）。
  - ⚠️ **并发去重**：VS Code 会高频并发调用 `provideLanguageModelChatInformation`
    （实测十几次 —— 那是正常的，打开选择器/每个会话解析当前模型都会查一次），
    但旧实现里 `catalogLoadedAt` 在拉取完成之后才写 ⇒ 并发各路**各自**发一轮请求
    （1 次目录 + N 次逐模型上游查询）。现共享同一个 in-flight Promise。
  - 新增命令：`OpenRouter: 设置 API Key` / `OpenRouter: 清除 API Key` /
    `OpenRouter: 选择上游供应商`。

## [0.0.4]

### Added

- 新增 **TRAE（字节）** provider：把 TRAE 的 SOLO 推理链路（`llm_utils_chat`）接入 Copilot Chat。
  - 登录走**本地回调**（`127.0.0.1:18080/authorize`，被占用时自动回退随机端口），回调直接回传 token。
  - 请求体转换为 SOLO 格式（`function` / `config_name` / `function_call` / `parameters` 序列化为字符串）。
  - 响应解析 SOLO 自定义 SSE（`event:output` / `token_usage` / `done` / `error`）。
  - 模型目录取自远端 `batch_get_detail_param`（多通道），失败时回退内置兜底表。
  - 支持思考强度选择（远端 `reasoning_effort_config.options`）、图片输入、工具调用、Max 模式（1M 上下文）。
  - 新增命令 `TRAE (字节): 登录 / 管理账号` 与 `TRAE (字节): 退出登录`。

## [0.0.3]

### Added

- 模型选择器里可直接切换**思考强度**（CodeBuddy 与 Qoder 中国版）：档位由模型目录声明，
  经 `configurationSchema` 暴露给选择器，发请求前再校验一次。

### Fixed

- 模型选择器里不显示模型的上下文窗口。

## [0.0.2]

### Added

- 新增 **Qoder（中国版）** provider：PKCE 设备码流程登录，走加密推理端点。

## [0.0.1]

- 首个版本：**CodeBuddy**（腾讯）provider。