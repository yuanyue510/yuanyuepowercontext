# 验证样例与运行证据

> 本文档对应赛题 4.3「验证样例与运行证据」。所有数字、对话、SQL 输出均为实际运行结果，
> 采集时间 **2026-11-08 10:47（GMT+8）**，环境为 `README.md` 第 3 节所述配置。
>
> 采集时使用的模型是 `verification/mock_llm.py`（无 key 时的占位模型，规则生成台词）。
> 链路、落库、跨会话记忆全部为真实行为；台词生硬是占位模型的已知限制，见第 6 节。
> 换成真实 `deepseek-flash` 后，流程与数据完全一致，只有台词质量不同。

---

## 0. 前置检查

三步确认环境就绪，任一步失败先看 `README.md` 第 4 节。

```bash
# ① 桥接服务活着，且能连上 seekdb
curl -s http://<DIFY_HOST>:5000/health
# 期望：{"ok":true,"powercontext":"disabled","seekdb":"up"}

# ② Dify 应用已导入并发布（控制台能看到「记仇客栈」，右上角状态为「已发布」）
curl -s http://<DIFY_HOST>/console/api/setup
# 期望：{"step":"finished",...}

# ③ seekdb 里四张表有初始数据
obclient -h127.0.0.1 -P2881 -uroot --password='' \
  -e "USE tavern; SELECT (SELECT COUNT(*) FROM lore) AS lore,
             (SELECT COUNT(*) FROM menu) AS menu,
             (SELECT COUNT(*) FROM players) AS players;"
# 期望：lore=19，menu=8，players=0（全新库）
```

模型不是真 key 时，先起占位模型（评审若已有 DeepSeek key，可跳过）：

```bash
docker run -d --name mock-llm --network host \
  -v $PWD/verification/mock_llm.py:/app/mock_llm.py \
  python:3.11-slim python /app/mock_llm.py
# 然后在 Dify「设置 → 模型供应商 → OpenAI-API-compatible」里，
# 把 Model Name 配成 deepseek-flash、endpoint 配成 http://<DIFY_HOST>:8100/v1
```

---

## 样例一：跨会话翻旧账（核心玩法）

**要证明的事**：同一名号换一个全新会话，三娘仍能从 seekdb 取出上次记下的原话并当面念出来。

### 1.1 初始状态

复位客官「张三」，使其回到从未进店的状态：

```bash
curl -s -X POST http://<DIFY_HOST>:5000/v1/reset \
  -H 'Content-Type: application/json' -d '{"player":"张三"}'
# {"ok":true,"player":"张三","reset":true}

curl -s "http://<DIFY_HOST>:5000/v1/ledger?player=%E5%BC%A0%E4%B8%89"
# {"count":0,"player":"张三","profile":null,"rows":[]}
```

Dify 侧对应：一个从没出现过的 `user`，`inputs.player_name` 填 `张三`。

### 1.2 操作步骤与预期

| 步 | 会话 | user | 输入 | 预期 |
|---|---|---|---|---|
| 1 | A（新会话） | `verify-a` | `来只醉鸡。四十八文？二十文，不然我走了。` | 三娘拒绝让价；`ledger` 新增 1 条「砍价」，信誉 50 → 41 |
| 2 | A（同一会话） | `verify-a` | `先记着账，我姓柳。` | 引用第 1 步记下的原话；新增 1 条「赖账」28 文，欠账 28，信誉 → 29 |
| 3 | **B（全新会话）** | `verify-b` | `今天还开张吗？` | **不依赖会话上下文**，凭 `张三` 这个名字从 seekdb 取回旧账，念出第 2 步的原话，并催 28 文 |

一步执行脚本（可重复跑，内部自动复位）：

```bash
DIFY_BASE=http://<DIFY_HOST> \
DIFY_APP_KEY=app-xxxxxxxx \
BRIDGE=http://<DIFY_HOST>:5000 \
python verification/run_demo.py --player 张三
```

### 1.3 实际结果

```
[0] 复位 张三
{"ok":true,"player":"张三","reset":true}
初始状态（seekdb）：{"count":0,"profile":null,"rows":[]}

[1] 会话 A 第 1 句：砍价
三娘：四十八文的鸡，你出二十，还嫌我刀钝。
    → ledger 1 条，reputation 50 → 41

[2] 会话 A 第 2 句：赖账
三娘：「四十八文的鸡，你出二十，还嫌我刀钝。」——账上写着呢，客官。先记着？我姓柳——你姓柳？
    → ledger 2 条，reputation 29，debt 28

[3] 会话 B（全新会话，同名号）第 1 句：进店
三娘：「先记着？我姓柳——你姓柳？」——账上写着呢，客官。先清 28 文，再谈别的。
```

第 3 步的会话 ID 与第 1、2 步不同（`verify-b` 新建），模型上下文里没有前两轮对话，
引号里的那句话只可能来自 seekdb。

### 1.4 seekdb 侧证据

```sql
USE tavern;
SELECT player, reputation, debt, bounty, visits, last_seen FROM players;
SELECT id, player, kind, severity, amount, quote FROM ledger ORDER BY id;
```

```
player  reputation  debt  bounty  visits  last_seen
张三    29          28    0       1       2026-11-08 10:47:43
王五    41          0     0       1       2026-11-06 11:12:54

id  player  kind  severity  amount  quote
3   王五    砍价  3         0       四十八文的鸡，你出二十，还嫌我刀钝
8   张三    砍价  3         0       四十八文的鸡，你出二十，还嫌我刀钝。
9   张三    赖账  4         28      先记着？我姓柳——你姓柳？
```

`id=3` 是同一天早先测试「王五」留下的行，正好说明账本按 `player` 隔离——
张三进店时，三娘只翻张三的账（`grudges` 里不含王五那条）。

原始记录见 `evidence/02-demo-run.log`、`evidence/01-seekdb-ledger.txt`。

### 1.5 判据与复位

判据满足三条即通过：

1. 第 2、3 步的回答里出现**前一轮 `quote` 字段的原文**（不是"我记得你"这类泛化表述）；
2. `players.reputation` 从 50 降到 41，再降到 29；
3. `players.debt` 从 0 变成 28，且第 3 步回答里出现了这个数字。

复位：`POST /v1/reset {"player":"张三"}` 删掉该玩家的 `players` 行与全部 `ledger` 行，
重跑 `run_demo.py` 即可完整复现。

---

## 样例二：信誉改变菜价（seekdb 参与实时计算）

**要证明的事**：seekdb 里的 `reputation` 不是存着好看，它直接参与每一轮报价。

同一道「三娘醉鸡」，两个客官同时问价：

| 客官 | `players.reputation` | 返回的醉鸡价 | `status.tone` |
|---|---|---|---|
| 李四（新客，库中无记录，默认 50） | 50 | **48 文** | 生客，先付后吃 |
| 张三（样例一之后） | 29 | **63 文** | 刺头，说话带刺，先收钱 |

```bash
curl -s -X POST http://<DIFY_HOST>:5000/v1/context \
  -H 'Content-Type: application/json' -d '{"player":"张三","q":"来只醉鸡"}'
```

价格由 `bridge` 用 `price_of(base_price, reputation)` 现算，`base_price` 来自 `menu` 表，
倍率随信誉浮动。**停掉 seekdb，这个数字就算不出来**——这是第 3 节要说明的分工。

---

## 3. seekdb 在每一轮里做了什么

一轮对话中，Dify 的两个 HTTP Request 节点各访问一次 seekdb：

```
玩家输入
  ↓
[Dify] 打包请求 → POST /v1/context {player, q}
        ↓  bridge 执行 4 条 SQL
        ├─ SELECT * FROM players WHERE player=?          → 信誉 / 欠账 / 通缉 / 进店次数
        ├─ SELECT * FROM ledger WHERE player=? ORDER BY ts DESC LIMIT 5  → grudges（最想翻的旧账）
        ├─ SELECT * FROM lore WHERE tags LIKE ? OR title LIKE ?          → 相关设定
        └─ SELECT item, base_price FROM menu                             → 菜单（按信誉改价）
  ↓
[Dify] 三娘（LLM）拿到上述 JSON，按《规矩》扮演并判定本轮要记什么
  ↓
[Dify] 代码节点解析 → POST /v1/settle {player, events[]}
        ↓  bridge 执行事务
        ├─ INSERT INTO ledger (...)                                      → 落账
        └─ UPDATE players SET reputation=?, debt=?, bounty=?, visits=?   → 改档案
  ↓
[Dify] 输出 reply
```

对应材料：

- 建表与初始数据：`bridge/sql/01-schema.sql`、`02-seed.sql`
- 读写实现：`bridge/app.py` 的 `/v1/context`、`/v1/settle`、`/v1/ledger`、`/v1/reset`
- Dify 侧：`dsl/grudge-tavern.yml` 的 `查账本`、`落账` 两个 http-request 节点

**反向验证**：把 `bridge` 停掉（`docker stop tavern-bridge`），再发一句话，
Dify 会因 `查账本` 节点连不上而报错，三娘一句话都说不出来。
这可以用来说明：seekdb 不是旁挂的演示，它断了应用就断。

---

## 4. Dify 侧执行记录

在 Dify 控制台打开「记仇客栈 → 日志与标注」，点任一条会话，
`追踪` 面板会显示 6 个节点的执行顺序与各自的输入输出：

| 节点 | 类型 | 本轮输出（正常值） |
|---|---|---|
| `start` | 开始 | `player_name=张三`，`sys.query=来只醉鸡…` |
| `prep` | 代码 | `{"player":"张三","q":"来只醉鸡…"}` |
| `查账本` | HTTP | `200`，body 为 context JSON（含 `grudges`/`status`/`menu`） |
| `三娘` | LLM | 一段 JSON 文本（`reply` + `events`） |
| `parse` | 代码 | `reply`、`settle_payload` |
| `落账` | HTTP | `200`，返回 `{"ok":true,"ledger_id":9,...}` |
| `answer` | 直接回复 | `{{#parse.reply#}}` |

截图见 `screenshots/`（`01-canvas.png` 画布、`02-run-trace.png` 节点追踪、
`03-seekdb.png` 库表、`04-chat.png` 对话窗口）。

---

## 5. 材料清单

| 文件 | 内容 |
|---|---|
| `evidence/01-seekdb-ledger.txt` | `players` / `ledger` 两张表的实际查询输出 |
| `evidence/02-demo-run.log` | `run_demo.py` 完整运行日志（含复位、三轮对话、每轮落账后的库内状态） |
| `evidence/screenshots/01-canvas.png` | Dify 工作流画布，6 个节点与连线 |
| `evidence/screenshots/02-run-trace.png` | 会话 B 的节点执行追踪（7 节点全部 SUCCESS，含各自耗时） |
| `evidence/screenshots/03-seekdb.png` | seekdb 中 `players` / `ledger` 的查询结果 |
| `evidence/screenshots/04-chat.png` | 预览面板里会话 B 的对话窗口，回复引用了旧账原话与欠款金额 |

---

## 6. 已知限制

1. **占位模型的台词是规则拼的**。`verification/mock_llm.py` 不含语言模型，
   它按关键词判断意图、按账本内容拼句子，所以句式重复、语气生硬。
   它的作用是让 HTTP 与落库节点被真实执行，并演示跨会话检索；
   换成真实 `deepseek-flash` 后，同一套流程会得到自然得多的台词。
2. **`lore` 检索是关键词匹配**（`tags` / `title` 的 `LIKE`），不是向量召回。
   问法太偏时可能召不回相关设定，此时三娘会按《规矩》回答"不知道，也不想知道"。
3. **seekdb 以 root 空口令运行**，仅为本地演示方便，交付环境请自行改口令并同步 `bridge` 的环境变量。
4. **信誉只降不自动回升**。还钱（`kind=还钱`）会加回少量信誉，但不会回到 50，符合"记仇"设定。
5. **单机部署**。`bridge` 用 `--network host` 与 seekdb 同机，Dify 通过宿主机 IP 访问它；
   跨机部署时需要把 DSL 里两个 HTTP 节点的地址改成 `bridge` 的实际地址。
