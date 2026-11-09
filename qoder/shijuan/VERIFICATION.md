# 验证样例

三组可按步骤执行的样例，覆盖「导入 → 混合检索 → 带出处回答 → 记忆写入 → 跨会话复用 → 掌握状态更新」的完整链路。每组都给出**初始状态、输入、操作、预期结果、实际输出、seekdb 落库记录、复位方法**。

> 所有输出都是在本机（Windows 11 / Node 22.22.2 / seekdb 1.4.0）实际执行后的原始结果，未做修饰。
> `BASE=http://127.0.0.1:8790`，学习者统一用 `sample`。

---

## 0. 准备

```bash
npm install && npm run fetch-models        # 依赖与 23MB 本地模型
cp .env.example .env                       # 改 SEEKDB_HOST 指向你的 seekdb
npm start                                  # 终端 A
npm run seed                               # 终端 B：导入 6 篇 / 33 个片段
npm run reset -- --learner=sample          # 清掉该学习者的历史记忆，保证初始状态干净
```

初始状态核对：

```bash
curl -s $BASE/api/health
# → {"ok":true,"seekdb":{"version":"5.7.25-OceanBase seekdb-v1.4.0.0","database":"shijuan"},
#    "model":{"name":"bge-small-zh-v1.5","dtype":"q8","dimension":512,...},
#    "collections":[{"name":"期末复习","slug":"c_69fed40d72","count":33,...}]}
```

**判据**：`count = 33`，`dimension = 512`，seekdb 版本为 `seekdb-v1.4.0.0`。

---

## 1. 样例一：资料里有的问题，答案要带出处

**初始状态**：`期末复习` 资料集 33 个片段，学习者 `sample` 记忆为空。

**输入**

```bash
curl -s -X POST $BASE/api/ask -H 'content-type: application/json' \
  -d '{"collection":"期末复习","query":"缺页中断的处理流程是什么","learner":"sample"}'
```

**预期**

1. `covered = true`，`coverage = 1`（查询词全部在命中片段中出现）；
2. 命中片段来自 `02-操作系统-虚拟内存.md`；
3. 答案包含完整的五步处理流程，并以 `[n]` 标注出处；
4. `sj_questions` 增加一行，`top_score = 1`。

**实际输出**

```
covered     true
coverage    1
citations   2
hits        8
times       { embedMs: 37, searchMs: 62, totalMs: 107 }
top1       02-操作系统-虚拟内存_md#001

根据 02-操作系统-虚拟内存.md：
- 当 CPU 访问的虚拟页不在物理内存中，页表项的有效位为 0，硬件触发缺页异常，控制权转入内核。处理流程通常分五步：
1. 内核检查该虚拟地址是否落在进程的合法地址区间，非法则向进程发送段错误信号，进程终止。
2. 在物理内存中寻找一个空闲页框；若没有空闲页框，进入页面置换流程挑出一个牺牲页。
3. 若牺牲页被修改过（脏位为 1），先把它写回磁盘的交换区。
4. 从磁盘读入所需页面到选定的页框，更新页表项，把有效位置 1。
5. 重新执行触发异常的那条指令，此时地址翻译成功。 [2]
- 整个过程对进程是透明的，但一次缺页要访问磁盘，耗时是内存访问的十万倍量级，因此缺页率直接决定程序性能。 [2]
```

**seekdb 侧记录**

```sql
SELECT learner, question, mode, top_score, hit_count FROM sj_questions WHERE learner='sample';
--  sample | 缺页中断的处理流程是什么 | hybrid | 1 | 8
```

片段本身也能在库里查到（物理表名由 SDK 登记在 `sdk_collections`）：

```sql
SELECT collection_name, collection_id FROM sdk_collections;
--  sj_c_69fed40d72 | ecb76126dc3511f19dd5000c29976e2a
--  物理表：c$v2$ecb76126dc3511f19dd5000c29976e2a
SELECT document FROM `c$v2$ecb76126dc3511f19dd5000c29976e2a` WHERE metadata->>'$.source'='02-操作系统-虚拟内存.md';
```

**复位**：`npm run reset -- --learner=sample`

---

## 2. 样例二：资料里没有的问题，要记住「这根筋没通」

**初始状态**：承接样例一（`sample` 已有 1 条提问记录）。

**输入**：问一个资料集里完全没有的概念。

```bash
curl -s -X POST $BASE/api/ask -H 'content-type: application/json' \
  -d '{"collection":"期末复习","query":"React 的 useEffect 依赖数组怎么写","learner":"sample"}'
```

**预期**

1. `covered = false`，`coverage = 0.286`（低于 0.34 的判定线）；
2. 答案明确说明「资料里没有正面讲到」，只给最接近的片段，不编造；
3. 自动写入一条薄弱点，`concept = "React的useEffect依赖数组怎么写"`，`status = open`；
4. 换一个会话（新进程 / 新浏览器 / 直接 GET 接口）仍能读回这条薄弱点；
5. 标记「懂了」后，`sj_weakpoints.status` 变为 `mastered`，不再出现在待复习列表。

**实际输出（1）提问**

```
covered   false
coverage  0.286
weak      {"id":13,"concept":"React的useEffect依赖数组怎么写","asks":1,"misses":0,"last_score":0.286}

资料里没有正面讲到「React 的 useEffect 依赖数组怎么写」，最接近的说法是：
- 如果只需要最终答案，二维表可以压成一维，用滚动数组；注意一维化后遍历方向要保证依赖的是上一轮的值。… [3]
```

**实际输出（2）新会话读记忆**

```bash
curl -s "$BASE/api/memory?learner=sample"
```

```json
{"questions":2,"avgScore":0.643,"open":1,"mastered":0,"asks":1,
 "recent":[{"question":"React 的 useEffect 依赖数组怎么写","score":0.286,...},
           {"question":"缺页中断的处理流程是什么","score":1,...}]}
# items: 13  React的useEffect依赖数组怎么写  期末复习  asks=1 misses=0 status=open
```

界面表现：打开「复习」页即可看到这条，旁边是「懂了 / 还是不懂」。**清掉浏览器 localStorage 也一样**——记忆不在浏览器，在 seekdb。

**实际输出（3）标记掌握**

```bash
curl -s -X POST $BASE/api/memory/review -H 'content-type: application/json' \
  -d '{"weakId":13,"result":"understood"}'
# → weak 13 mastered
```

**seekdb 落库记录**

```sql
SELECT id, learner, concept, asks, misses, status, last_score FROM sj_weakpoints WHERE learner='sample';
-- 13 | sample | React的useEffect依赖数组怎么写 | 1 | 0 | mastered | 0.286

SELECT weak_id, result, created_at FROM sj_reviews;
-- 13 | understood | 2026-11-09 ...
```

**复位**：`npm run reset -- --learner=sample`

---

## 3. 样例三：三种检索模式确实走的是不同通路

**输入**：同一查询、同一 TopK，切换 `mode`。

```bash
for m in hybrid vector fulltext; do
  curl -s -X POST $BASE/api/search -H 'content-type: application/json' \
    -d "{\"collection\":\"期末复习\",\"query\":\"缺页中断的处理流程是什么\",\"mode\":\"$m\",\"k\":8}"
done
```

**实际输出**

| 模式 | 检索耗时 | 命中数 | top1 | 覆盖来源文档数 |
|---|---|---|---|---|
| hybrid（向量 + 全文，库内 RRF） | 13–20 ms | 8 | `02-操作系统-虚拟内存_md#001` | 3 |
| vector（仅 HNSW 近邻） | 7 ms | 8 | `02-操作系统-虚拟内存_md#001` | 3 |
| fulltext（仅 ngram2 全文） | 19 ms | 8 | `02-操作系统-虚拟内存_md#001` | 4 |

**判据**：三种模式都能返回正确 top1；hybrid 的来源分布介于两者之间，说明双路都在贡献结果。更直观的对比可以问一个术语与语义不一致的问题，例如「换页的时候硬盘要做什么」：fulltext 命中 `页面置换算法` 段，vector 命中 `缺页中断` 段，hybrid 两段都在前列。

**seekdb 侧证据**：`npm run verify` 会打印物理表结构与索引类型：

```
PASS  文档表包含 VECTOR 列（seekdb 原生向量类型）  — _id:varbinary document:string embedding:VECTOR(512) metadata:json
PASS  文档表同时建有 FULLTEXT 与 VECTOR 索引  — BTREE + FULLTEXT + VECTOR
```

---

## 4. 一键验收（27 项）

```bash
npm run verify
```

覆盖：健康检查、导入、导入后自检、重复导入幂等、三种检索模式、覆盖判定、答案引用完整性、五步流程完整性、端到端时延、未覆盖识别、薄弱点落库、跨会话读回、手动标记、排序、掌握状态、直接查库核对、导出清单。

**实际结果**

```
结果：27/27 通过，0 失败，总耗时 11.2s
已写入 evidence/verify-log.txt 与 evidence/verify.json
```

产物：

- `evidence/verify-log.txt`：逐项 PASS/FAIL 与耗时（纯文本，可直接 diff）
- `evidence/verify.json`：seekdb 版本、导入各阶段耗时、三种模式 top1、提问覆盖率、记忆表行、物理表名与索引类型

---

## 5. 复位与清理

| 目的 | 命令 |
|---|---|
| 清空某学习者的记忆（提问 / 薄弱点 / 复习记录） | `npm run reset -- --learner=sample` |
| 连资料集一起删（顺便 DROP 物理表） | `npm run reset -- --learner=sample --collection=期末复习` |
| 清空所有记忆表 | `npm run reset -- --all` |

复位后重新执行 §0 的 `npm run seed` 即可回到初始的 33 个片段。

---

## 6. 判据汇总

| 赛题要求 | 本项目对应证据 |
|---|---|
| 项目能按运行说明跑通 | §0 命令全部可复制执行；`npm run verify` 27/27 |
| seekdb 提供数据存储、查询与检索 | §1 的 `sj_questions` 记录 + §3 的三种检索模式与索引类型 |
| 记忆被保存并在后续复用 | §2：写入 `sj_weakpoints` → 新会话读回 → `mastered` 状态更新 |
| 技术作用可核对 | `evidence/verify-log.txt`（逐项输出）、`evidence/verify.json`（结构化数据）、界面截图 `evidence/shots/` |
