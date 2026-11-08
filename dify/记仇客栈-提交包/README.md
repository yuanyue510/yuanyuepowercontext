# 记仇客栈 · 运行说明

> 青石镇唯一还开着的客栈。老板娘柳三娘记性极好——尤其是记仇。
> 你上次砍的价、赖的账、顺走的碗，都写在她柜台底下那本账上；下次进门，她先跟你算。

- 赛题：Dify × OceanBase · Just for Fun
- 技术选型：**Dify（必选）+ seekdb**（账本、设定检索）+ 可选 PowerContext 记忆层
- 交付物：`dsl/grudge-tavern.yml`（Dify 工作流）、`bridge/`（seekdb 存取服务）、`verification/`（验证脚本与占位模型）、`VERIFICATION.md`（验证样例与判据）、`evidence/`（运行日志与截图）

**想直接跑起来，按这个顺序读**：§4.1 起 seekdb → §4.2 起桥接服务 → §4.3 起 Dify → §4.4 接模型 → §4.5 导入 DSL。

> ⚠️ 导入 DSL 前先改一处：`dsl/grudge-tavern.yml` 里两个 HTTP 节点（`查账本`、`落账`）写的是本机演示地址 `http://192.168.192.128:5000`，请替换成你部署 `bridge` 的宿主机 IP，否则节点会连接超时。Dify 容器内不能用 `127.0.0.1` 访问宿主机的 bridge。

---

## 1. 玩法与体验方式

### 1.1 一句话玩法

报上名号 → 说话（点菜/砍价/吹牛/赖账/打听消息）→ 三娘回应并记账 → 下次（**新会话也行**）进门，她翻开账本，用你上次听到的那句原话把你怼回来。

### 1.2 为什么值得玩

- **记忆不是"存着"，是"拿来报仇的"**。账本每条都带一个 `quote` 字段——三娘当时记下的原话。下次见面她会原样念出来，而不是笼统地说"我记得你"。
- **记忆会改变世界**。信誉分决定菜价：同一只三娘醉鸡，信誉 80 的熟客 36 文，信誉 0 的黑名单 120 文，还只配吃素面。
- **有代价的互动**。赖账不用你点"确认"，你只要说一句"先记着"，账本就多一行；累积到通缉 3 级，她会喊哑巴伙计阿七。
- **设定不跑偏**。问"后山有什么"，回答只能落在 `lore` 表里那口井上；问表外的东西，她会说"不知道，也不想知道"。

### 1.3 入口

Dify 应用「记仇客栈」的 WebApp 页面：`http://<DIFY_HOST>/chat/<APP_ID>`
（也可用 API：`POST /v1/chat-messages`，入参 `inputs.player_name` + `query`）

首次进入需要填「名号」——**这个名号就是跨会话的主键**，换会话但同名号，账本照样认得你。

---

## 2. Dify 与 seekdb 的分工

| 组件 | 承担什么 | 在应用里的具体位置 |
|---|---|---|
| **Dify（Chatflow）** | 全部流程编排：打包入参 → 查账 → 模型扮演与记账判定 → 解析结构化输出 → 落账 → 输出 | `dsl/grudge-tavern.yml`，6 个节点 |
| **seekdb** | ① `players` 客官档案（信誉/欠账/通缉/进店次数）② `ledger` 账本（每轮一条，含原话）③ `lore` 客栈设定与传闻（按话头检索）④ `menu` 菜单基准价 | 由 `bridge/` 通过 MySQL 协议（2881）读写；Dify 用 HTTP Request 节点调用 `bridge` |

为什么不让 Dify 直接连 seekdb：Dify 的 HTTP Request 节点不能跑 SQL；中间放一个 30KB 的 Flask 服务，既能做参数校验、聚合信誉分与价格，也能把"取上下文"和"落账"收敛成两个稳定接口。
**seekdb 不是装饰**：把 `bridge` 停掉，应用立刻无法报价、无法翻旧账（第 6.3 节有这条验证）。

> PowerContext 是可选叠加：`bridge` 里已经预留 `POWERCONTEXT_URL` 开关，配置后每轮事件会额外写成一条 atomic-memory，`/v1/context` 会把语义召回的"印象"一起注入提示词；不配置则自动降级为纯 seekdb，玩法不受影响。

---

## 3. 运行环境与版本

| 项 | 版本 / 说明 |
|---|---|
| 操作系统 | CentOS 7.9（内核 3.10.0-1160），4~6 vCPU / 8 GB 内存 / 30 GB 磁盘起 |
| Docker | docker-ce **26.1.4**，docker compose plugin **2.27.1** |
| Dify | **1.9.1**（`docker/docker-compose.yaml` 官方编排） |
| Dify 模型插件 | `langgenius/openai_api_compatible` **0.0.17**（离线 `.difypkg` 安装，见 4.3） |
| 模型服务 | DeepSeek `deepseek-flash`（OpenAI 兼容，`https://api.deepseek.com`）；不接真模型时可用 `verification/mock_llm.py` 跑通链路 |
| seekdb | **seekdb 1.4.0**（`5.7.25-OceanBase seekdb-v1.4.0.0`），MySQL 协议端口 2881，root 空口令（仅本地演示） |
| 桥接服务 | Python 3.11 + Flask 3.0.3 + PyMySQL 1.1.1，监听 `0.0.0.0:5000` |
| 依赖插件 | 仅上面的模型插件；工作流内不使用其它 marketplace 插件 |

网络要求：Dify 容器需要能访问模型服务的公网地址；`bridge` 需要能访问 seekdb（同机 `127.0.0.1:2881`）。若模型服务在境外且网络不稳，可换任意 OpenAI 兼容端点。

---

## 4. 从零部署

> 下面命令均在 Dify 所在机器执行，`<...>` 为占位值。

### 4.1 准备 seekdb 并建库

```bash
# seekdb 已按官方一键脚本安装并启动（2881 端口）
obclient -h127.0.0.1 -P2881 -uroot --password='' < bridge/sql/01-schema.sql
obclient -h127.0.0.1 -P2881 -uroot --password='' < bridge/sql/02-seed.sql
# 自检：应看到 players / ledger / lore / menu 四张表，lore 19 行、menu 8 行
obclient -h127.0.0.1 -P2881 -uroot --password='' -e "USE tavern; SHOW TABLES; SELECT COUNT(*) FROM lore;"
```

`02-seed.sql` 可重复执行（先 DELETE 再 INSERT），用来把设定与菜单复位。

### 4.2 启动桥接服务

```bash
cd bridge
docker compose up -d --build
curl -s http://127.0.0.1:5000/health
# {"ok":true,"powercontext":"disabled","seekdb":"up"}
```

`docker-compose.yml` 里用 `network_mode: host`，所以 seekdb 走 `127.0.0.1:2881`。
Dify 容器访问它时用**宿主机 IP**（本机演示为 `http://192.168.192.128:5000`），已写进 DSL 的两个 HTTP 节点。

要启用 PowerContext 记忆层：把 `POWERCONTEXT_URL` 指向 `http://127.0.0.1:8000` 后重启容器即可，其余无需改动。

### 4.3 部署 Dify

```bash
# 1) 取官方编排（1.9.1）
mkdir -p /opt/dify && cd /opt/dify
#  docker-compose.yaml / .env.example 来自 langgenius/dify@1.9.1 的 docker/ 目录
#  另外需要同目录下的 nginx/、ssrf_proxy/、volumes/sandbox/conf/config.yaml（否则容器会把缺失文件挂成目录）
# 2) 覆盖文件：CentOS 7 内核过旧，docker 26 默认 seccomp 会拦住 postgres initdb
cp docker-compose.override.yaml /opt/dify/
# 3) 启动
cp .env.example .env && docker compose up -d
```

`docker-compose.override.yaml` 只做一件事：给 `db` / `sandbox` / `ssrf_proxy` 加 `security_opt: [seccomp:unconfined]`。
不加会看到 `FATAL: could not write to file "pg_wal/xlogtemp.XX": Operation not permitted`（`db` 反复重启）。

装模型插件（离线，marketplace 拉不到时用）：

```bash
# 下载 openai_api_compatible 0.0.17
curl -o /tmp/oac.difypkg \
  'https://marketplace.dify.ai/api/v1/plugins/langgenius/openai_api_compatible/0.0.17/download'
# 上传 → 安装（TOKEN 为 Dify 控制台登录后的 access_token）
curl -X POST http://127.0.0.1/console/api/workspaces/current/plugin/upload/pkg \
  -H "Authorization: Bearer $TOKEN" -F 'pkg=@/tmp/oac.difypkg'
curl -X POST http://127.0.0.1/console/api/workspaces/current/plugin/install/pkg \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"plugin_unique_identifiers":["langgenius/openai_api_compatible:0.0.17@<hash>"]}'
```

### 4.4 配模型

控制台 → 设置 → 模型供应商 → **OpenAI-API-compatible** → 添加模型：

| 字段 | 值 |
|---|---|
| Model Name | `deepseek-flash`（旧名 `deepseek-chat` 已于 2026-07-24 下线，以开放平台文档页当前模型 ID 为准） |
| API Key | `<DEEPSEEK_API_KEY>` |
| API endpoint URL | `https://api.deepseek.com` |
| Mode | chat |
| Context size | 65536 |
| Max tokens | 8192 |

> DSL 里 LLM 节点写死的是 `provider: langgenius/openai_api_compatible/openai_api_compatible` + `name: deepseek-flash`，只要这里同名同 provider 就能对上。换模型时两边一起改。
>
> **本作品未使用 Embedding / Rerank 服务**。`lore` 设定检索与账本查询均为 seekdb 的关键词匹配 + 结构化过滤（SQL `LIKE` / `WHERE`），不涉及向量库；Dify 侧也未配置任何知识库（DSL 导入后无需重新绑定知识库）。

### 4.5 导入 DSL 并发布

1. 控制台 → 创建空白应用 → **导入 DSL 文件** → 选 `dsl/grudge-tavern.yml`（只有一个文件，无导入顺序问题）。
2. 导入后检查两个 HTTP 节点（`查账本`、`落账`）的地址是否为你自己的宿主机 IP，不是就改。
3. 右上角 **发布** → 更新。
4. 应用 → 访问 API → 创建密钥（后面验证脚本要用）。

### 4.6 体验

浏览器打开 `http://<DIFY_HOST>/chat/<APP_ID>`，填名号，然后照第 5 节的样例说三句话。

---

## 5. 验证样例

完整的分步样例（初始状态、输入、预期、实际输出、seekdb 记录与截图索引）见 **`VERIFICATION.md`**，一键执行：

```bash
DIFY_BASE=http://<DIFY_HOST> \
DIFY_APP_KEY=app-xxx \
BRIDGE=http://<DIFY_HOST>:5000 \
python verification/run_demo.py --player 张三
```

脚本会自动：复位「张三」→ 会话 A 砍价 → 会话 A 赖账 → **新开会话 B** 进店，并在每步后打印 seekdb 账本实况。

---

## 6. 已知限制与排查

1. **名号即身份**。谁填同一个名号，就继承同一本账。演示场景够用，生产要加登录（Dify 的 `sys.user_id` 或外部鉴权）。
2. **`root` 空口令**。seekdb 是本地演示配置，不要直接暴露 2881。桥接服务同理只在内网。
3. **信誉/价格是确定性规则，不是模型算的**。金额、severity 由模型判断，聚合与定价由 `bridge` 计算，避免模型自己改账。
4. **模型输出必须是 JSON**。DeepSeek 偶尔会加解释文字，`parse` 节点做了兜底（截取首尾大括号、失败则把原文当台词、`events` 置空），所以最坏情况是"这轮不记账"，不会把应用跑挂。
5. **HTTP 节点地址写死宿主机 IP**。换机器要改两处（`查账本`、`落账`）。用 `host.docker.internal` 需要在 compose 里加 `extra_hosts`，本方案选了更直白的写法。
6. **CentOS 7 + docker 26 的 seccomp 问题**见 4.3，必须带 override 文件启动。
7. **不做向量检索**。当前检索用标题/标签/关键词匹配（`LIKE`）+ 结构化过滤；账本条目短、专有名词多，关键词命中足够。要上语义检索需再配 Embedding 服务，`lore` 表已预留 `content` 字段可切向量列。

---

## 7. 材料来源与改动

- Dify 编排与 DSL 结构：`langgenius/dify@1.9.1` 官方 `docker/` 目录与 `api/tests/fixtures/workflow/basic_chatflow.yml` 结构参考。
- 模型插件：`langgenius/openai_api_compatible` 0.0.17，来自 Dify 官方插件市场。
- seekdb：OceanBase 官方一键安装脚本（1.4.0），未修改源码。
- 客栈设定、菜单、人物、账本规则、提示词、桥接服务、验证脚本：本作品原创。
- 未复用其它公开工作流 DSL。

---

## 8. 目录说明

```
dify-grudge-tavern/
├── DESIGN.md                       玩法与数据设计
├── README.md                       本文件（运行说明）
├── VERIFICATION.md                 验证样例、判据与证据索引
├── dsl/
│   └── grudge-tavern.yml           Dify Chatflow DSL（唯一文件，直接导入）
├── bridge/
│   ├── app.py                      seekdb 读写与规则聚合（Flask）
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── sql/
│       ├── 01-schema.sql           建库建表
│       └── 02-seed.sql             设定/菜单初始数据（幂等）
├── dify-stack/
│   └── docker-compose.override.yaml  CentOS 7 适配（seccomp）
├── verification/
│   ├── run_demo.py                 一键跑验证样例（内部自动复位）
│   └── mock_llm.py                 无模型 key 时的假模型（验证链路用）
└── evidence/
    ├── 01-seekdb-ledger.txt        players / ledger 实际查询输出
    ├── 02-demo-run.log             run_demo.py 完整运行日志
    └── screenshots/                画布 / 节点追踪 / seekdb / 对话 四张截图
```
