# Change Log

All notable changes to the "github-copilot-codearts" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- 新增 **TRAE（字节）** provider：把 TRAE 的 SOLO 推理链路（`llm_utils_chat`）接入 Copilot Chat。
  - 登录走**本地回调**（`127.0.0.1:18080/authorize`，被占用时自动回退随机端口），回调直接回传 token。
  - 请求体转换为 SOLO 格式（`function` / `config_name` / `function_call` / `parameters` 序列化为字符串）。
  - 响应解析 SOLO 自定义 SSE（`event:output` / `token_usage` / `done` / `error`）。
  - 模型目录取自远端 `batch_get_detail_param`（多通道），失败时回退内置兜底表。
  - 支持思考强度选择（远端 `reasoning_effort_config.options`）、图片输入、工具调用、Max 模式（1M 上下文）。
  - 新增命令 `TRAE (字节): 登录 / 管理账号` 与 `TRAE (字节): 退出登录`。

## [0.0.3]

- Initial release