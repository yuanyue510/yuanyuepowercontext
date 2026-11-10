# 验收说明（P7）

怎么跑、跑出什么、以及三组样例从**输入 → 预期 → 实际输出 → 库内记录**的逐条对照。
所有引文都是 2026-11-10 在 `http://127.0.0.1:8790`（最新代码）上实测的原始输出，未做修饰。

## 一、跑法与产物

```bash
npm start          # 终端 A：起服务
npm run seed       # 终端 B：导入示例语料（可重复，第二次不会多出切片）
npm run verify     # 端到端 24 项，任一失败 → 退出码非 0
```

| 产物 | 内容 |
| --- | --- |
| `evidence/verify-log.txt` | 24 条 `[PASS]/[FAIL]` + 就绪门槛的库内轮询日志 + 时延样本 |
| `evidence/verify.json` | 同一批结果的机读版：`checks[]`（name/ok/ms/detail）、`measurements[]`、`exitCode`、起止时间 |
| `evidence/seed-log.txt` | 两篇语料的切片数、R1 合并数、offset 自检、向量化耗时、就绪门槛轮询 |
| `evidence/samples/` | 三组样例的请求体、响应原文、库内前后对照（下面第二节逐条引用） |

最近一次：`npm run seed` 退出码 **0**，`npm run verify` 退出码 **0**，24/24 通过，全程 4.19 秒
（`10:29:48.404Z → 10:29:52.594Z`，8790 上重启后的新进程 PID 14512）。
下面第二节引用的三组样例原文（`evidence/samples/`）采自当天早些时候、同一份代码的一次请求；
计数类字段（`sh_stuck` 行数、探针的 `miss_count`）每次重跑单调增长，属预期，不是漂移。

## 二、三组样例

### A 组：已覆盖的问题 → 抽取式答案，逐句挂出处

**输入**

```json
{ "datasetName": "生物必修1-细胞代谢讲义", "query": "酶有什么特性" }
```

**预期**：`coverage.covered=true` 且 `confidence` 非 `none`；`answer.kind="extractive"`，每条 statement 只有
`ref + sentence + charStart/charEnd`，正文逐字等于原句；`stuck=null`（已覆盖不许落卡点）。

**实际输出**（`evidence/samples/A-covered.response.json`，服务端 `timing.totalMs=49`，其中本地向量化 15 ms）

```
confidence = thin    coverage = 1（floor 0.34）    witnessTermCount = 1    stuck = null
answer.statements:
 [ref 1] doc_03ee62e3b9#s3#001  「2 酶的特性」  charStart 164 – charEnd 220
         酶具有高效性。
         与无机催化剂相比，酶的催化效率大约是无机催化剂的 10^7 到 10^13 倍。
         酶具有专一性。
 [ref 2] doc_03ee62e3b9#s3#003  「2 酶的特性」  charStart 265 – charEnd 292
         高温、过酸、过碱都会使酶的空间结构遭到破坏而永久失活。
 [ref 3] doc_03ee62e3b9#s3#002  「2 酶的特性」  charStart 220 – charEnd 265
         每一种酶只能催化一种或一类化学反应，例如麦芽糖酶只能催化麦芽糖水解。
         酶的作用条件较温和。
```

**库内记录**（SDK `collection.get({ids})`，证明句子来自 seekdb 而不是接口现编）

```
id        : doc_03ee62e3b9#s3#001
document  : "2 酶的特性 酶具有高效性。\n与无机催化剂相比，酶的催化效率大约是无机催化剂的 10^7 到 10^13 倍。\n酶具有专一性。"
metadata  : {"doc_id":"doc_03ee62e3b9","sent_no":1,"char_start":164,"char_end":220,"norm_len":56,
             "section_id":"s3","section_title":"2 酶的特性","merged_count":3,"has_formula":true,
             "dataset_name":"生物必修1-细胞代谢讲义",
             "section_path":"生物必修 1 · 细胞代谢（示例语料） > 2 酶的特性"}
```

三条 statement 的 `slice(charStart, charEnd)` 与 `sentence` **逐字相等**（verify「offset 逐字一致」一项，全文 1233 字）。
`merged_count=3` 说明这是短句合并后的切片，`ref 1` 里三个 `\n` 就是合并时接回去的句间空白 —— 这正是
`docs/plan.md` 事实 15 记的那个坑。

### B 组：教材里没讲的问题 → 拒答，并自动落卡点

**输入**

```json
{ "datasetName": "生物必修1-细胞代谢讲义", "query": "DNA甲基化怎么遗传给子代" }
```

**预期**：两条判据同时成立才拒答；`statements` 为空；只给「最近原文」且文案明说这不构成答案；
`sh_stuck` 追加一行流水，`sh_review` 新增一行 `status=open, miss_count=1`，`stuck.reviewId` 可被本地算法复算。

**实际输出**（`evidence/samples/B-refusal.response.json`，`timing.totalMs=84`）

```
confidence = none    answer.kind = refusal    statements = []
coverage: terms=[遗传给子代, 甲基化]  coverage=0  floor=0.34
          rule1_low_coverage=true  rule2_no_shared_term_sentence=true  nearestRefs=[1,2]
answer.text:
  资料集「生物必修1-细胞代谢讲义」中没有讲到这个问题的原句。判据①：2 个查询词里，命中句覆盖 0 个
  （覆盖率 0 < 0.34）；判据②：没有任何一句同时包含 2 个查询词。下面是字面最接近 2 条原文，
  仅供判断是否口径不同，不构成答案。
stuck: {"stuckId":"st_c1abdf2b7390","collectionName":"sh_stuck","state":"open",
        "reviewId":"rv_e847b9c2064cebea"}
```

**库内记录**

`sh_stuck`（向量集合，一次拒答一行，带查询向量以便事后复现"当时为什么没召回"）：

```
id       : st_c1abdf2b7390
document : "DNA甲基化怎么遗传给子代"      向量维度 : 512
metadata : {"state":"open","source":"refusal","coverage":0,"created_at":1794300070916,
            "query_terms":"遗传给子代,甲基化","missed_terms":"遗传给子代,甲基化",
            "nearest_ids":"doc_03ee62e3b9#s5#001,doc_03ee62e3b9#s1#001",
            "rule1_low_coverage":true,"rule2_no_shared_term_sentence":true,
            "dataset_name":"生物必修1-细胞代谢讲义","chunk_collection":"sh_ds_doc_3e42fa73"}
```

`sh_review`（关系表，`npm run show:review -- rv_e847`，落库瞬间）：

```
id='rv_e847b9c2064cebea' status='open' miss=1 coverage=0 doc='doc_03ee62e3b9'
first_seen=16:41:10 last_seen=16:41:10 status_changed_at=16:41:10 mastered_at=null
```

`reviewId` 是 `sha1(dataset + '::' + question)` 的前 16 位，所以**同一个问题第二次拒答不会多出一行**：
verify「错次累加」一项实测 `miss_count 6→7` 而 `SELECT COUNT(*) ... WHERE id=?` 恒为 1，
`latest_stuck_id` 换成了新的流水号。

### C 组：复习队列状态机 —— 200 / 409 / 400 / 404 与并发只推进一次

**输入**：对 B 组产生的 `rv_e847b9c2064cebea` 依次做 6 次写请求（完整命令与响应体见
`evidence/samples/C-transcript.txt`）。

**预期**：只允许 `open→reviewing→mastered` 与回退 `→open`；重复走同一条边 409；未知取值 400；
不存在的 id 404；两条并发请求只能有一条推进时间戳；`mastered` 之后从待复习列表消失。

**实际输出**

| # | 请求 | HTTP | 备注 |
| --- | --- | --- | --- |
| 1 | `{"status":"reviewing"}` | **200** | `row.status=reviewing`，`allowed=["mastered","open"]` |
| 2 | 同 #1 再发 | **409** | `{"error":"状态已从 reviewing 变化，reviewing → reviewing 不是允许的流转","from":"reviewing","allowed":["mastered","open"]}` |
| 3 | `{"status":"done"}` | **400** | 状态机里没有这个取值 |
| 4 | `POST /api/review/rv_not_exist/state` | **404** | id 不存在 |
| 5 | 复位 open 后**同时**发两条 `{"status":"reviewing"}` | **200 + 409** | A 拿到 200，B 的守卫不成立 |
| 6 | `{"status":"mastered"}` | **200** | 写 `mastered_at` |

**库内记录**（同一行，前后对照）

```
前：status='open'     miss=1  status_changed_at=16:41:10  mastered_at=null
后：status='mastered' miss=1  status_changed_at=16:41:46  mastered_at=16:41:46
```

6 次写请求里 4 次被挡在门外，`status_changed_at` 只前进了**一次**。实现上靠的是一条语句：

```sql
UPDATE sh_review SET status=?, status_changed_at=?, mastered_at=?
 WHERE id=? AND status IN (<该目标态的全部前驱>)
```

以 `affectedRows` 作为唯一裁判（`server/lib/review/store.js:transition`），所以不存在"先查后改"的竞态窗口；
409 之后那次后置 `SELECT` 只为拼错误文案。`miss_count` 全程保持 1 —— 状态流转不记错次，只有拒答才 +1。
`GET /api/review?limit=200` 随后不再包含该 id，`counts={"open":8,"reviewing":1,"mastered":1}`。

## 三、24 项断言 ↔ `docs/plan.md` 验收点

| verify 项 | 对应验收点 | 最近一次实测 |
| --- | --- | --- |
| 健康自检 / 零云端调用 | A.1 零云端、A.3 零构建 | `cloudModelCalls:"forbidden"`、`embeddingFunction:null`、模型与分词器在位、512 维 + ngram2 |
| 导入幂等 | C.10 | 两次均 33 切片；集合内 33 条、id 全唯一、与 `sh_registry.chunk_count` 一致 |
| 就绪门槛：行数够 + 向量召回 0 → 不放行 | F1.4 | 12 次探测全为「表行数 33 / 可召回 0」，300 ms 上限后抛错，报错含实际与期望 |
| 就绪门槛：连续两次相同才放行 | F1.4 | 第 2 次读数 33/33 才放行 |
| 检索①全文通道 `$contains` | A.2 | `ADP` → 1 条且字面含词；`洛伦兹力` → 0 条 |
| 检索②向量通道 `query()` | A.2 | Top5 距离 0.461/0.474/0.529/0.529/0.554（有界） |
| 检索③融合语义（并集，非 AND 过滤） | A.2、事实 7 | 全文命中 `#s5#002` 升到第 1（基线里不在 Top5），其余 4 条向量补位 |
| 检索④多路 k+1 通道 | B.4 | 3 个查询词 → 3 条全文 + 1 条向量，融合 8 张卡，`channelCount` 序列 44444443 |
| 已覆盖判定 | B.5 | 覆盖率 1 ≥ 0.34，置信 thin，答案 3 句 |
| offset 逐字一致 | B.4 痛点 1 | 3 条 statements 区间全部逐字命中 |
| **查询词必须是原文子串** | 本次新增 | 4 条查询、7 个查询词、7 条通道关键词全部 ⊆ 原问题；证据卡原句均能在原文定位；命中词均在原句或小节标题里 |
| 未覆盖拒答 | B.5 痛点 2 | 判据①②同时成立，`statements=[]`，只给 2 条最近原文并声明不构成答案 |
| 卡点落库 | B.6 痛点 3 | `sh_stuck` 29→30（每次重跑 +1 是流水，预期）；`sh_review` 该题恰有一行 `status=open` |
| 错次累加 | B.6 | `miss_count` +1 且行数恒为 1，`latest_stuck_id` 换新 |
| 状态机 200 / 409 / 400+404 | B.6 | 见 C 组 |
| 并发只推进一次 | C.9 | 200 + 409，时间戳只前进一次 |
| mastered 后离队 | B.6 | 队列不含该 id；回退 open 时 `mastered_at` 清空 |
| 复习页非空 | B.6 | 9 条待复习，8 个字段齐全，排序与 `miss_count DESC, last_seen ASC` 一致 |
| 复习页空态 | F8.3 | 空数据集 → HTTP 200 且 `pending=[]`；前端源码含「还没有卡点」与三个按钮文案 |
| 时延（单词键 / 多关键词） | C.7 | 单词键 40/57/59/59/69 ms；4 通道串行 75/83/79 ms（中位 79、最大 83，均 ≤ 800） |
| 死连接自愈 | 本次新增（事实 24） | 死连接错误第 1 次抛、第 2 次成功（calls=2）；非死连接错误原样抛出不重试；重建后 `openCollection` 仍读到 33 条 |

## 四、前端验证做到哪一步

`evidence/samples/D-frontend-dom.txt` 记录的是通过 `evaluate_script` 读到的 **DOM 结构**断言：复习标签页渲染 9 张卡、
计数「待复习 9 条｜已掌握 1 条」、按钮按服务端下发的 `allowed` 置灰（`status=open` 的行：还没懂/已掌握 disabled，在复习可点）、
切到无卡点的资料集显示「还没有卡点」而不是留白、控制台无报错。

**没有做**像素级截图：本环境浏览器面板折叠，`take_screenshot` 返回 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`。
样式与响应式布局需要打开 <http://127.0.0.1:8790> 自己过一眼 —— 这条已写进 README 已知限制第 3 条。

## 五、重跑时的注意事项

- `verify` 会真的写库：`sh_stuck` 追加流水、`sh_review` 里探针卡点 `rv_e97b50b0236d0765` 的 `miss_count` 每次 +1。
  断言用的是**相对增量**而不是绝对值，所以反复跑不会假失败。
- `verify` 会跑**两次**导入（幂等断言要求两次切片数一致），因此 `sh_ds_doc_3e42fa73` 是整体重建的，跑完集合仍是 33 条。
- 状态机断言从 `open` 起步，靠 `resetToOpen()` 复位；中途手改过这行的状态也没关系。
- 就绪门槛的负例用的是构造出来的假集合（`count()` 返 33、`query()` 返空），不会碰真数据，300 ms 就结束。
- 想干净复现样例 B：换一个语料里不存在的问题即可，`reviewId` 由 `sha1` 现算，不会和已有行冲突。
- 环境不通时不会刷屏：`/api/dataset/list` 拿不到列表、集合打不开、原文取不到这三种"后续断言的前提"失败时，脚本只记一条
  `[FAIL] 环境可用（后续断言的前提）` 就停，并把已经跑过的部分照常写进 `evidence/`（退出码 1）。
  看到这一条先查服务是否在跑、seekdb 是否可达，而不是去改断言。
