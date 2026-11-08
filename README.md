# 2026 OceanBase AI 数据库大赛 · 作品提交仓库

本仓库按赛题分目录存放参赛作品。点击下表进入对应作品。

| 目录 | 赛题 | 作品 | 状态 |
|---|---|---|---|
| [`dify/`](dify/) | Dify × OceanBase · Just for Fun | **记仇客栈**——会记仇的客栈老板娘，跨会话翻你的旧账 | 已提交 |
| [`gaode/`](gaode/) | 高德地图方向 | 周边探索 Skill（地点搜索 + 步行路线推荐） | 已提交 |
| `minimax/` | MiniMax 方向 | — | 待提交 |
| `qoder/` | Qoder 方向 | — | 待提交 |
| `stepfun/` | 阶跃星辰方向 | — | 待提交 |

## 直接看 Dify 作品

- **作品入口（先读这个）**：[`dify/记仇客栈-提交包/README.md`](dify/记仇客栈-提交包/README.md)
- **材料清单与导入顺序**：[`dify/记仇客栈-提交包/00-材料清单.md`](dify/记仇客栈-提交包/00-材料清单.md)
- **Dify DSL**：[`dify/记仇客栈-提交包/dsl/grudge-tavern.yml`](dify/记仇客栈-提交包/dsl/grudge-tavern.yml)
- **验证样例与运行证据**：[`dify/记仇客栈-提交包/VERIFICATION.md`](dify/记仇客栈-提交包/VERIFICATION.md)

### 这作品是什么

青石镇唯一还开着的客栈。老板娘柳三娘记性极好——尤其是记仇。你上次砍的价、赖的账、顺走的碗，都写在她柜台底下那本账上；下次进门，她先跟你算。

技术选型：**Dify（必选，流程编排）+ seekdb（账本、设定、菜单的数据存储）**。未使用 PowerContext。

### 最短体验路径

1. 起 seekdb，执行 `bridge/sql/01-schema.sql`、`02-seed.sql`
2. 起 `bridge` 服务，`curl http://<宿主机IP>:5000/health` 返回 `{"ok":true}`
3. 起 Dify 1.9.1，配置 OpenAI 兼容模型供应商
4. **改 DSL 里两个 HTTP 节点的 IP**（`查账本`、`落账`，原值 `192.168.192.128:5000`）
5. 导入 `dsl/grudge-tavern.yml` → 发布 → 名号填「张三」

完整步骤、版本、已知限制见 `dify/记仇客栈-提交包/README.md`。

## 赛题条款对照（Dify 赛题 · 第四章 提交材料）

| 赛题条款 | 要求 | 对应文件 |
|---|---|---|
| 4.1 Dify DSL | 全部 DSL、用途与导入顺序、Dify 版本与部署方式、重新绑定步骤 | `dify/记仇客栈-提交包/dsl/grudge-tavern.yml`（单文件，无导入顺序）；README §4.5 导入步骤；适用版本 Dify 1.9.1（Docker Compose 自建）；导入后无需绑定知识库，仅需改 2 个 HTTP 节点地址（README 顶部 ⚠️ 说明） |
| 4.2 运行说明 | 创意玩法与体验方式、技术分工、环境与版本、模型服务及配置项、Embedding/Rerank 说明、完整步骤与应用入口、外部服务与网络条件、已知限制、占位凭据、复用来源 | `README.md`（§1 玩法 / §2 技术分工 / §3–4 环境版本与步骤 / §6 已知限制）；Embedding/Rerank：README §4.4 明确声明未使用；复用来源见 `NOTICE.md`；凭据全为占位值 |
| 4.3 验证样例与运行证据 | 初始状态 → 输入 → 预期 → 实际结果；截图/日志；seekdb 作用与读写记录；复位方法 | `VERIFICATION.md`（样例一：三幕跨会话翻旧账；样例二：信誉影响报价）；`evidence/`（2 份日志 + 4 张截图）；seekdb 读写 SQL 与落库记录见 VERIFICATION §3 与 `evidence/01-seekdb-ledger.txt`；复位：`POST /v1/reset`（VERIFICATION §4） |
| 4.4 按依赖补充 | 建库数据、桥接源码、插件来源版本、部署适配 | `bridge/sql/`（建表 + 幂等初始数据）；`bridge/`（Flask 源码 + Dockerfile + compose）；插件 `langgenius/openai_api_compatible` 0.0.17（来源与安装见 NOTICE.md 与 README §4.4）；CentOS 7 适配 `dify-stack/docker-compose.override.yaml` |

## 说明

- 本仓库默认分支为 `2026-competition-ecosystem`，`master` 等分支为底层项目原始代码，与参赛作品无关。
- 各作品目录内不含任何真实 API Key、口令或凭据；模型与数据库配置均为占位值，需按各自 README 绑定自己的服务。
