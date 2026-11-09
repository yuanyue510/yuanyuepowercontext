# 记仇客栈 · Dify × OceanBase seekdb 参赛作品

> 青石镇唯一还开着的客栈。老板娘柳三娘记性极好——尤其是记仇。
> 你上次砍的价、赖的账、顺走的碗，都写在她柜台底下那本账上；**下次进门（新会话也算），她先跟你算。**

- 赛题：Dify × OceanBase · Just for Fun —— 用 Dify 做一个好玩的智能应用
- 技术选型：**Dify（必选）** + **seekdb**（应用数据存储与检索）
- 交付形态：Dify Chatflow 一份 DSL + 桥接服务 + 可复现的验证样例与运行证据

---

## 一、交付物速览

| 赛题条款 | 交付文件 | 说明 |
|---|---|---|
| **4.1 Dify DSL** | [`dsl/grudge-tavern.yml`](dsl/grudge-tavern.yml) | 唯一 DSL 文件，直接导入。Chatflow 共 **7 个节点**：开始 → 进库(HTTP) → 打包请求(代码) → 查账本(HTTP) → 三娘(LLM) → 记录判定(代码) → 落账(HTTP) → 直接回复。适用 Dify **1.9.1** |
| **4.2 运行说明** | 本文件（下方第三～五节） | 玩法、Dify 与 seekdb 分工、版本环境、从零部署步骤、模型配置、已知限制 |
| **4.3 验证样例** | [`VERIFICATION.md`](VERIFICATION.md) | 两组样例：三幕跨会话翻旧账、信誉影响实时报价。含初始状态 → 输入 → 预期 → 实际输出 → seekdb 落库记录 → 复位方法；§2.1 附规则复算自证 |
| **4.3 运行证据** | [`evidence/`](evidence) | 4 张截图 + 2 份原始日志（见第六节表格） |
| 4.4 依赖补充 | [`bridge/`](bridge) · [`dify-stack/`](dify-stack) · [`verification/`](verification) | seekdb 建表脚本与桥接服务、CentOS 7 适配、一键验证脚本 |
| 说明类文档 | [`00-材料清单.md`](00-材料清单.md) · [`DESIGN.md`](DESIGN.md) · [`NOTICE.md`](NOTICE.md) · [`LICENSE`](LICENSE) | 材料清单、设计推导、第三方声明（MIT） |

> **评审请从 [`00-材料清单.md`](00-材料清单.md) 开始**：一页纸说明每个文件干什么、按什么顺序导入。

---

## 二、玩法：记忆不是存着，是拿来报仇的

报上名号 → 说话（点菜 / 砍价 / 吹牛 / 赖账 / 打听消息）→ 三娘回应并记账 → 下次进门，她翻开账本，**用你上次那句原话**把你怼回来。

四个设计点：

1. **每条账都带原话**。`ledger.quote` 存的是玩家当时的原句。下次见面她原样念出来，而不是笼统地说"我记得你"。
2. **记忆会改变世界**。信誉分直接决定菜价，连续变化不跳档：三娘醉鸡基准 48 文，信誉 80 的座上宾 26 文，信誉 0 的黑名单 84 文；信誉 < 20 或通缉 ≥ 3，她直接下逐客令。
3. **有代价的互动**。赖账不需要点"确认"，你说一句"先记着"，账本就多一行。
4. **设定不跑偏**。问"后山有什么"，答案只能落在 `lore` 表那口井上；问表外的事，她会说"不知道，也不想知道"。

入口：`http://<DIFY_HOST>/chat/<APP_ID>`，或 API `POST /v1/chat-messages`（入参 `inputs.player_name` + `query`）。
**名号就是跨会话主键**——换会话、同名号，账本照样认得你。

---

## 三、Dify 与 seekdb 的分工

| 组件 | 承担什么 | 位置 |
|---|---|---|
| **Dify（Chatflow）** | 全部流程编排：打包入参 → 查账 → 模型扮演与记账判定 → 解析结构化输出 → 落账 → 输出 | [`dsl/grudge-tavern.yml`](dsl/grudge-tavern.yml)，7 节点 |
| **seekdb** | ① `players` 客官档案（信誉/欠账/通缉/到访）② `ledger` 账本（每轮一条，含原话）③ `lore` 客栈设定 19 条 ④ `menu` 菜单 8 道基准价 | [`bridge/sql/01-schema.sql`](bridge/sql/01-schema.sql) 建表，`bridge` 走 MySQL 协议 2881 读写 |

为什么中间放一层 `bridge`：Dify 的 HTTP Request 节点不能跑 SQL。30 KB 的 Flask 服务把"取上下文"和"落账"收敛成两个稳定接口，价格与信誉聚合在服务端确定性计算，不让模型改账。

**seekdb 不是装饰**：把 `bridge` 停掉，应用立刻无法报价、无法翻旧账。

接口：`POST /v1/context`（查账 + lore 检索 + 算价 + 语气）、`POST /v1/settle`（落账 + 改信誉）、`POST /v1/reset`、`GET /v1/ledger`、`GET /health`。

> PowerContext 为可选叠加：`bridge` 预留 `POWERCONTEXT_URL` 开关，配置后每轮事件额外写 atomic-memory 并把语义召回注入提示词；不配置则自动降级为纯 seekdb，玩法不受影响。

---

## 四、运行环境

| 项 | 版本 / 说明 |
|---|---|
| 操作系统 | CentOS 7.9（内核 3.10.0-1160），4~6 vCPU / 8 GB 内存 / 30 GB 磁盘起 |
| Docker | docker-ce **26.1.4**，compose plugin **2.27.1** |
| Dify | **1.9.1**（官方 `docker/docker-compose.yaml`） |
| Dify 模型插件 | `langgenius/openai_api_compatible` **0.0.17** |
| 模型服务 | 任意 OpenAI 兼容端点（演示用 DeepSeek，`https://api.deepseek.com`，模型 `deepseek-flash`）；**没有 key 也能跑通链路**，见 5.5 |
| seekdb | **seekdb 1.4.0**（`5.7.25-OceanBase seekdb-v1.4.0.0`），MySQL 协议 2881，root 空口令（仅本地演示） |
| 桥接服务 | Python 3.11 + Flask 3.0.3 + PyMySQL 1.1.1，监听 `0.0.0.0:5000` |

---

## 五、从零部署

> ⚠️ **导入 DSL 前必改一处**：`dsl/grudge-tavern.yml` 里 `查账本`、`落账` 两个 HTTP 节点写的是演示机内网地址 `http://192.168.192.128:5000`，请换成你部署 `bridge` 的宿主机 IP。Dify 容器内不能用 `127.0.0.1` 访问宿主机。

### 5.1 建库

```bash
obclient -h127.0.0.1 -P2881 -uroot --password='' < bridge/sql/01-schema.sql
obclient -h127.0.0.1 -P2881 -uroot --password='' < bridge/sql/02-seed.sql
# 自检：4 张表，lore 19 行、menu 8 行
obclient -h127.0.0.1 -P2881 -uroot --password='' -e "USE tavern; SHOW TABLES; SELECT COUNT(*) FROM lore;"
```

### 5.2 起桥接服务

```bash
cd bridge && docker compose up -d --build
curl -s http://127.0.0.1:5000/health
# {"ok":true,"powercontext":"disabled","seekdb":"up"}
```

### 5.3 起 Dify

```bash
mkdir -p /opt/dify && cd /opt/dify   # 放 docker-compose.yaml / .env.example / nginx/ / ssrf_proxy/ / volumes/sandbox/conf/config.yaml
cp <本仓库>/dify-stack/docker-compose.override.yaml .   # CentOS 7 必须：给 db/sandbox/ssrf_proxy 关 seccomp
cp .env.example .env && docker compose up -d
```

不加 override 会看到 `FATAL: could not write to file "pg_wal/xlogtemp.XX": Operation not permitted`（`db` 反复重启）——这是内核 3.10 缺 `clone3` 导致 docker 26 默认 seccomp 拦截。

### 5.4 配模型

控制台 → 设置 → 模型供应商 → **OpenAI-API-compatible** → 添加模型：

| 字段 | 值 |
|---|---|
| Model Name | `deepseek-flash`（与 DSL 内 `name` 一致；换模型两边一起改） |
| API Key | 你的 key |
| API endpoint URL | `https://api.deepseek.com` |
| Mode / Context / Max tokens | chat / 65536 / 8192 |

> 本作品**未使用 Embedding / Rerank，也未绑定任何知识库**。`lore` 检索与账本查询都是 seekdb 的关键词匹配 + 结构化过滤（SQL `LIKE` / `WHERE`），DSL 导入后无需再绑知识库。

### 5.5 没有 API Key 时如何验证

`verification/mock_llm.py` 是规则假模型：**链路、落库、跨会话记忆全部真实，只有台词是规则拼接**。把它作为 OpenAI 兼容端点挂上（`/v1/chat/completions`），DSL 不用改，就能在零成本下验证 7 节点全部跑通、账本真的落进 seekdb。声明见 [`NOTICE.md`](NOTICE.md)。

### 5.6 导入并发布

创建空白应用 → **导入 DSL 文件** → `dsl/grudge-tavern.yml` → 核对两个 HTTP 节点地址 → 发布 → 访问 API 创建密钥。

---

## 六、验证

完整分步样例见 [`VERIFICATION.md`](VERIFICATION.md)。一键执行：

```bash
DIFY_BASE=http://<DIFY_HOST> DIFY_APP_KEY=app-xxx BRIDGE=http://<DIFY_HOST>:5000 \
python verification/run_demo.py --player 张三
```

脚本自动：复位「张三」→ 会话 A 砍价 → 会话 A 赖账 → **新开会话 B** 进店，每步后打印 seekdb 账本实况。

**价格规则（唯一权威，实现与文档一致）**

```python
def price_of(base: int, rep: int) -> int:
    return max(1, round(base * (1 + (50 - rep) / 100 * 1.5)))
```

醉鸡（base 48）随信誉变化：信誉 100/80/60/50/40/20/0 → **12 / 26 / 41 / 48 / 55 / 70 / 84 文**。
即倍率 0.25 / 0.55 / 0.85 / 1.00 / 1.15 / 1.45 / 1.75 倍。还钱扣账口径为 `-max(amount, 10 × severity)`。

**运行证据**

| 文件 | 内容 |
|---|---|
| [`evidence/screenshots/01-canvas.png`](evidence/screenshots/01-canvas.png) | Dify 工作流画布，7 节点与连线 |
| [`evidence/screenshots/02-run-trace.png`](evidence/screenshots/02-run-trace.png) | 会话 B 节点执行追踪，7 节点全 SUCCESS，含耗时 |
| [`evidence/screenshots/03-seekdb.png`](evidence/screenshots/03-seekdb.png) | seekdb 中 `players` / `ledger` 查询结果（张三信誉 29、欠账 28、两条原话） |
| [`evidence/screenshots/04-chat.png`](evidence/screenshots/04-chat.png) | 对话窗口：问「今天还开张吗」，三娘念出上次赖账原话并索要 28 文 |
| [`evidence/01-seekdb-ledger.txt`](evidence/01-seekdb-ledger.txt) | 上述 SQL 原始终端输出，与 03 截图逐字对应 |
| [`evidence/02-demo-run.log`](evidence/02-demo-run.log) | `run_demo.py` 完整日志：复位、三轮对话、每轮落库后状态 |

---

## 七、已知限制（如实说明）

1. **交付时的台词来自规则假模型**。`mock_llm.py` 只负责生成台词，跨会话记忆、落库、定价链路全部真实。接入真模型后体验明显不同（语气、临场发挥），但流程与数据一字不改。
2. **HTTP 节点写死内网 IP**，换机器要改两处（见第五节警告）。
3. **名号即身份**，同名继承同一本账；生产需接 Dify `sys.user_id` 或外部鉴权。
4. **seekdb root 空口令**，仅本地演示，不要暴露 2881。
5. **不做向量检索**，`lore` 用关键词匹配；`content` 字段已预留可切向量列。
6. **模型输出必须是 JSON**，`parse` 节点有兜底（截首尾大括号，失败则原文当台词、`events` 置空），最坏情况是"这轮不记账"，不会把应用跑挂。

---

## 八、仓库说明

```
.
├── README.md                 本文件（运行说明，赛题 4.2）
├── 00-材料清单.md            一页纸材料索引与导入顺序
├── VERIFICATION.md           验证样例与判据（赛题 4.3）
├── DESIGN.md                 玩法与数据模型设计
├── NOTICE.md                 第三方组件与 mock_llm 声明
├── LICENSE                   MIT
├── dsl/grudge-tavern.yml     Dify Chatflow DSL（赛题 4.1，唯一文件）
├── bridge/                   seekdb 读写服务（Flask）+ 建表/种子 SQL
├── dify-stack/               CentOS 7 seccomp 适配 override
├── verification/             run_demo.py 一键验证 + mock_llm.py
└── evidence/                 4 张截图 + 2 份原始日志
```

- 根目录这份交付物与 [`dify/记仇客栈-提交包/`](dify/记仇客栈-提交包) **内容一致**，后者是最初上传的原始目录，保留不动。
- 仓库中的 `gaode/`、`minimax/`、`qoder/`、`stepfun/` 是上游 PowerContext 示例目录，**与本作品无关**，可忽略。
- 提报信息：分支 `2026-competition-ecosystem`，提交以最新 commit 为准。
