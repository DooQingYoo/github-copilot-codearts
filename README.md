# github copilot codearts

把四家服务的模型额度接进 VS Code Copilot Chat / Agent 模式：**CodeBuddy**（腾讯）、**Qoder 中国版**（阿里）、**TRAE**（字节）、**OpenRouter**。

## 功能

- 在 Copilot Chat 的模型选择器里直接选用上述四家的模型，含 Agent 模式（工具调用）。
- 支持流式输出、思考过程（思维链）、图片输入。
- 登录凭据存在 VS Code 的 `SecretStorage` 里；访问令牌过期会自动续期。
- 除 OpenRouter 外都走各自官方客户端的授权流程，无需自备密钥。

## 使用

1. 安装扩展（VSIX，或从源码构建，见文末）。
2. 打开命令面板，运行对应命令完成登录：

   | 服务 | 命令 | 登录方式 |
   |---|---|---|
   | CodeBuddy（腾讯） | `CodeBuddy: 登录 / 管理账号` | 浏览器授权 |
   | Qoder（中国版） | `Qoder (中国版): 登录 / 管理账号` | 浏览器授权 |
   | TRAE（字节） | `TRAE (字节): 登录 / 管理账号` | 浏览器授权 |
   | OpenRouter | `OpenRouter: 设置 API Key` | 粘贴 API Key |

   OpenRouter 的 API Key 在 [openrouter.ai/keys](https://openrouter.ai/keys) 创建，粘贴后会先校验一次，无效会当场提示。

3. 在 Copilot Chat 的模型选择器里选模型即可开始对话。
4. 要清除本机凭据，运行对应的 `退出登录`（OpenRouter 是 `清除 API Key`）。

> Copilot Chat 仍需已有可用的 GitHub Copilot 订阅。企业版/商业版环境还可能由组织策略控制是否允许自带模型。

## OpenRouter 的两个特别之处

1. **只列出少量模型**：OpenRouter 有 400+ 个模型，全部铺出来选择器没法用。因此只展示
   ① 所有**免费模型**，以及 ② `deepseek/deepseek-v4.1-flash`、`z-ai/glm-5.3-flash` 两个收费模型。
2. **可以指定上游供应商**（这正是它与 Copilot 自带 OpenRouter 的关键区别）：同一个模型背后
   有几十家上游服务商，OpenRouter 默认按价格**随机**负载均衡，命中的可能不是你想要的那家。
   运行命令 **`OpenRouter: 选择上游供应商`**，先选模型、再选上游即可锁定。

   - 锁定是**严格**的（只用它、不回退）：该家当前不可用时这一轮会直接失败并报错，
     错误里会说明是锁定导致、以及如何改回「自动」。
   - 选「**自动**」即解除锁定，交回 OpenRouter 负载均衡。
   - 绑定关系会写入设置项 `github-copilot-codearts.openrouter.pinnedProviders`，
     在 `settings.json` 里可见、也可手改，例如
     `{ "deepseek/deepseek-v4.1-flash": "deepinfra/fp8" }`；留空或写 `"auto"` 表示自动。
   - 每个模型的**思考强度**仍在模型选择器里直接可选。

> ⚠️ 选择器里的两个 OpenRouter 不是同一个：Copilot 自带的那个**不能**自选上游；
> 本插件的是显示为 **「OpenRouter (可自选上游供应商)」** 的那个。

## 常见问题

- **换过供应商或刚登录，模型选择器里看不到新模型？** 重启 VS Code 即可（模型列表不热刷新）。
- **提示「请先运行"OpenRouter: 设置 API Key"」** 凭据没配置或已被清除，重新配置一次。
- **锁定某家上游后一直报错** 那家上游当前不可用。运行 `OpenRouter: 选择上游供应商` 改回「自动」。
- **OpenRouter 下只有十几个模型** 这是刻意的，见上面第 1 条。
- **思考强度下拉里没有想要的档位** 档位由 OpenRouter 按模型下发，只有它声明的档位可选。

## 从源码构建

需要 Node.js 22 或更新版本。

```powershell
npm install
npm run compile   # 编译到 out/
```

然后在 VS Code 里按 `F5` 启动 Extension Development Host 试用，或用
`npm run package` 打成 VSIX 安装。

