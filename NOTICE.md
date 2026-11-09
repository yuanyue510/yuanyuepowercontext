# 第三方组件与参考来源

本作品的 DSL、桥接服务、SQL 与文档均为本次参赛原创。以下为运行依赖与参考来源，按赛题 4.2「复用公开工作流、代码或数据时，注明来源及所作改动」的要求列明。

## 运行依赖

| 组件 | 版本 | 用途 | 许可 |
|---|---|---|---|
| Dify | 1.9.1（自建，Docker Compose） | 应用流程编排，必选技术 | Apache-2.0（含附加条款，见 dify 仓库 LICENSE） |
| seekdb | 1.4.0（自建） | 账本、设定、菜单的数据存储与检索 | 见 oceanbase/seekdb 仓库 LICENSE |
| OpenAI-API-compatible 插件 | 0.0.17 | 在 Dify 中接入兼容 OpenAI 协议的模型服务 | 见 Dify 插件市场该插件页面 |

## 参考但不含其代码

| 来源 | 参考内容 | 本作品的处理 |
|---|---|---|
| `dzh-gitcode/dify-workflows`（赛题 2.4 公开示例） | 互动文字类应用的玩法组织方式 | 仅作玩法参考。DSL 全部自行编写，未复制其节点、提示词或配置 |
| Dify 官方仓库 `api/tests/fixtures/workflow/*.yml` | DSL 的字段结构（节点 schema、边定义、变量引用语法） | 用于核对 DSL 格式正确性。未复制任何测试用例内容 |

## 模型服务

DSL 中 LLM 节点使用 `langgenius/openai_api_compatible/openai_api_compatible` 供应商下的模型占位名，运行前需替换为实际服务（见 README §4.4）。仓库内不含任何 API Key。

## `verification/mock_llm.py` 的定位

该文件是一个**规则驱动的假模型**，仅用于没有模型 Key 时验证 Dify 图能否跑通（HTTP 节点、代码节点、落库是否被真实执行）。它不参与应用的实际推理，也不是作品的核心逻辑。评审体验时应按 README §4.4 接入真实模型；用它跑出的台词是固定规则拼接的，仅供链路自检。
