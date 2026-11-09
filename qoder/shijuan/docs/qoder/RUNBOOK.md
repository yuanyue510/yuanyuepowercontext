# Qoder 开发执行手册（逐步）

> 目标：在 Qoder 里从零做出「拾卷」，每一步都有可截图的产出，时间线与 commit 对得上。
> 现有 `qoder/shijuan/` 是**对照答案**，不要拿它给 Qoder 看，否则就变成"改现成代码"而不是"开发"。

---

## 0. 准备工作（一次性，10 分钟）

```bash
# 1) 空工作目录
mkdir -p D:/赛题/qoder-dev && cd D:/赛题/qoder-dev
git init
git commit --allow-empty -m "chore: 初始化 Qoder 开发工作区"

# 2) 模型先备好（Qoder 写的代码要用它，23 MB）
mkdir -p models/bge-small-zh-v1.5/onnx
# 从现有项目拷一份，省去下载（下载源会 429）
cp -r D:/赛题/qoder-shijuan/models/bge-small-zh-v1.5/. models/bge-small-zh-v1.5/
```

- 安装 Qoder 桌面端（或 IDE 插件），**个人账号**登录（企业版无法公开 Sites）。
- Qoder 里打开 `D:/赛题/qoder-dev` 作为工作区。
- 确认 seekdb 可连：`192.168.192.131:2881`（虚拟机 DHCP 会变，变了就改 `.env`）。

**截图 0**：Qoder 欢迎页/工作区打开状态、终端 `git log` 一条空提交。

---

## P1 需求拆解（不写代码）

**粘这段**

```
我要参加「Qoder × OceanBase · Build with Qoder」比赛，做一个学习科研提效项目。
痛点：复习时找不到资料里的原句；通用大模型答得顺但口径和教材对不上；当时没读懂的概念事后忘了卡在哪。
约束：
1. 必须用 seekdb 提供数据存储、查询与检索能力（向量 + 全文混合检索）；
2. 不调用任何云端大模型或 embedding 接口，要能离线跑；
3. 前端零构建，npm start 就能用。
请先不要写代码，输出：功能清单（按用户操作顺序）、数据模型（表/字段/索引）、技术选型理由、目录结构、验收点。存成 docs/plan.md。
```

**验收**：`docs/plan.md` 里有四块（功能、模型、选型、验收），数据模型提到 `VECTOR` 和全文索引。
**偏差怎么纠**：如果它一上来就写代码 → 「先别写，我要先看方案」；如果只给功能不给模型 → 「补数据模型，精确到字段类型和索引」。
**截图 1**：① 对话框（你的提问 + 它的方案）② `docs/plan.md` 内容 ③ 无
**commit**：`docs: 需求拆解与数据模型`

---

## P2 脚手架

**粘这段**

```
按方案建 Node 项目：ESM、Express、端口 8790、原生前端。
依赖只要 express、seekdb、mysql2、@huggingface/transformers。
建 server/ public/ data/seed/ scripts/ tools/ 目录，写 .env.example（SEEKDB_HOST/PORT/USER/PASSWORD/DATABASE、PORT、EMBED_DTYPE、WEAK_THRESHOLD），写 .gitignore（node_modules、.env）。
npm scripts：start / seed / verify / reset / fetch-models。
```

**跑**

```bash
npm install
```

预期：**会报 `Unsupported URL Type "workspace:"`**（seekdb 的 peer 依赖声明）。把这个报错贴给 Qoder：

```
npm install 报 Unsupported URL Type "workspace:"，来自 seekdb 的 peer 依赖。请给出最小修复，不要改依赖版本。
```

它应该加到 `.npmrc`：`legacy-peer-deps=true`。装完 `node -v` 与 `ls node_modules | head` 都要有输出。

**截图 2**：① 报错原文 + 你贴给它的那段 ② 它加的 `.npmrc` ③ `npm install` 成功的尾巴
**commit**：`chore: 脚手架与依赖`

---

## P3 seekdb 接入（本阶段最关键）

**粘这段**

```
写 server/db.mjs，并补一个最小 server/index.mjs（只挂 GET /api/health，返回 seekdb 版本）：
1. 用 seekdb 的 AdminClient 确保 database `shijuan` 存在，再用 SeekdbClient 连接；
2. 文档集合：每个资料集一张表，列 embedding VECTOR(512) 走 HNSW cosine（M=16, efC=200, efS=128），document 走 ngram2 全文索引，metadata 存 JSON；
3. seekdb 集合名只允许 [a-zA-Z0-9_]，中文资料集名用 sha256 前 10 位映射成 slug（c_<hash>），标签与集合的映射存 sj_collections 表；
4. 记忆四表 sj_learners / sj_questions / sj_weakpoints / sj_reviews，用 mysql2 连接池，弱点是 (learner, collection, concept) 唯一；
5. 导出 listCollections / createCollection / deleteCollection / upsertDocs / refresh / search(label, {mode, queryText, embedding, k})。search 必须调用 col.hybridSearch()，RRF 交给 DBMS_HYBRID_SEARCH，不要在应用层合并两路结果。
```

**跑**

```bash
cp .env.example .env   # 改 SEEKDB_HOST 为你虚拟机的 IP
npm start              # 另开终端
curl -s http://127.0.0.1:8790/api/health
```

预期返回 JSON，含 `seekdb` 版本字符串与库名。如果连接失败，把报错原样贴回去让它改。

**截图 3**：① 对话框 ② `server/db.mjs` 里建集合那段 ③ `/api/health` 的返回
**commit**：`feat(seekdb): 集合封装与记忆表`

---

## P4 切片与向量化

**粘这段**

```
写 server/chunk.mjs 和 server/embed.mjs：
- 切片：320 字一片、重叠 60 字，优先在段落边界断开，单段超长再按句号切；片段 id = 文件名清洗后 + #序号（补零三位），保证重复导入幂等；
- 向量化：@huggingface/transformers 加载本地 bge-small-zh-v1.5（INT8，路径 models/，设 env.allowRemoteModels=false），pooling=cls、normalize=true；查询侧加 bge 官方前缀「为这个句子生成表示以用于检索相关文章：」，文档侧不加；批量 8 条；加载后预热一次。
```

**跑**（验证维度对不对）

```bash
node --input-type=module -e "
import { embed } from './server/embed.mjs';
const v = await embed(['操作系统的进程调度算法']);
console.log('dim', v[0].length, v[0].slice(0,3));
"
```

预期 `dim 512`。若报找不到模型，检查 `models/` 路径与 `allowRemoteModels=false`。

**截图 4**：① 对话框 ② `chunk.mjs` 的切分函数 ③ `dim 512` 的输出
**commit**：`feat(embed): 中文切片与本地向量化`

---

## P5 导入接口

**粘这段**

```
实现 POST /api/docs：{collection, files:[{name,text}]}
流程：建集合（若不存在）→ 切片 → 批量向量化 → upsert → refresh_index → 用最后一片的正文做一次检索自检。
返回 {chunks, files:[{name,chars,chunks}], selfCheck, ms:{chunk,embed,write,refresh,verify,total}}。
自检不通过要如实返回 selfCheck:false，不要假装成功。
```

**跑**

```bash
node --input-type=module -e "
const r = await fetch('http://127.0.0.1:8790/api/docs',{method:'POST',headers:{'content-type':'application/json'},
  body: JSON.stringify({collection:'测试',files:[{name:'a.md',text:'## 进程\n进程是资源分配的基本单位。\n\n## 线程\n线程是调度的基本单位。'}]})});
console.log(JSON.stringify(await r.json(),null,1));"
```

预期 `chunks:2`、`selfCheck:true`、`ms` 里有五段耗时。

**截图 5**：① 对话框 ② 接口实现 ③ 上面这段 JSON
**commit**：`feat(ingest): 导入接口与自检`

---

## P6 三种检索

**粘这段**

```
实现 POST /api/search：{collection, query, mode: hybrid|vector|fulltext, k}
- hybrid：hybridSearch 的全文 + knn 两路各取 40，RRF rankConstant=60、rankWindowSize=40，返回 top-k；
- vector：col.query 走 HNSW；
- fulltext：hybridSearch 只给 query.whereDocument.$contains。
返回每条 {id, rank, score, similarity=1-distance, text, metadata} 和 times:{embedMs, searchMs, totalMs}。
```

**跑**（三种模式各来一次，对比耗时）

```bash
for m in hybrid vector fulltext; do
  curl -s -X POST http://127.0.0.1:8790/api/search -H 'content-type: application/json' \
    -d "{\"collection\":\"测试\",\"query\":\"线程是什么\",\"mode\":\"$m\",\"k\":3}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('$m',j.times.searchMs+'ms','top1='+j.hits[0].id)})"
done
```

**截图 6**：① 对话框 ② 三路分支的代码 ③ 三行模式对比输出
**commit**：`feat(search): 混合/向量/全文三种检索`

---

## P7 答案抽取

**粘这段**

```
写 server/qa.mjs 的 answerFromHits(question, hits)：
1. 片段按空行切段，丢弃 Markdown 标题；以冒号结尾的引导句要和后面的编号列表合并（否则「分五步：」会把五步丢掉）；
2. 查询切中文 2-gram + 英文 token，过滤停用词；
3. 段落打分 = 命中词的 log(1+段落数/(1+df)) 之和 × 名次权重 1/(1+rank*0.4) × 长段落惩罚；
4. 要求命中 ≥2 词、与已选段落重合度 <0.45；
5. 输出 `- 段落… [n]`，n 为片段序号；
6. 另算查询词覆盖率，<0.34 时开头写「资料里没有正面讲到……」，covered=false。
不要调用任何大模型。
```

**跑**：直接用一段假 hits 测，不必等全链路

```bash
node --input-type=module -e "
import { answerFromHits } from './server/qa.mjs';
const hits=[{id:'x#001',similarity:0.9,text:'缺页中断的处理分五步：1. 陷入内核 2. 检查页表 3. 找空闲页 4. 换入 5. 恢复执行。',metadata:{source:'x.md'}}];
const r=answerFromHits('缺页中断怎么处理', hits);
console.log(r.answer, '\ncovered=', r.covered);"
```

预期答案里五步齐全（不是只剩"分五步："）。

**截图 7**：① 对话框 ② 打分函数 ③ 答案输出（五步完整）
**commit**：`feat(qa): 抽取式答案与覆盖率判定`

---

## P8 记忆闭环

**粘这段**

```
实现 POST /api/ask：检索 → 生成答案 → 写 sj_questions（topScore 存覆盖率）→ 若 covered=false 自动 upsert 薄弱点（concept 由问题去标点、去「请问/帮我看看」前缀后截 40 字）。
再实现 GET /api/memory?learner=（待复习列表 + 统计）、POST /api/memory/weak（misses+1）、POST /api/memory/review（understood → status=mastered）、GET /api/export/review（导出 Markdown）。
复习列表按 misses DESC, asks DESC, updated_at DESC 排。
```

**跑**

```bash
curl -s -X POST http://127.0.0.1:8790/api/ask -H 'content-type: application/json' \
  -d '{"collection":"测试","query":"React 的 useEffect 依赖怎么写","learner":"demo"}'
curl -s "http://127.0.0.1:8790/api/memory?learner=demo"
```

预期：第一条 `covered:false` 且返回 `weak.id`；第二条能看到这条薄弱点在列表里（**这就是跨会话记忆的证据**）。

**截图 8**：① 对话框 ② 写库那段代码 ③ 上面两个返回
**commit**：`feat(memory): 提问记录与薄弱点闭环`

---

## P9 前端

**粘这段**

```
写 public/index.html + styles.css + app.js（原生 JS，无构建）：
左侧资料集列表（新建/切换/删除）+ 学习者输入；三个标签页：
「提问」输入框 + 模式选择 + TopK + 答案卡片（覆盖标签、耗时、[n] 引用、没懂按钮）+ 片段列表（details 展开看原文）；
「资料」粘贴/选文件导入 + 导入报告 + 资料集表格；
「复习」统计卡片 + 薄弱点条目（懂了/还是不懂）+ 导出清单。
配色米白底 + 墨绿主色，字号 14–15px，不要用框架。
```

**跑**：浏览器打开 `http://127.0.0.1:8790`，提一个问题看答案卡片。

**截图 9**：① 对话框 ② 界面截图 ③ 浏览器控制台无报错
**commit**：`feat(ui): 单页界面`

---

## P10 验收、文档与发布

**粘这段**

```
写 tools/verify.mjs：对着已启动的服务跑一组检查（健康、导入、幂等、三种检索、覆盖判定、引用完整性、时延、未覆盖识别、薄弱点落库、跨会话读回、掌握状态），并用 mysql2 直接查库核对 sj_weakpoints / sj_questions / 物理表列类型与索引类型，输出 evidence/verify-log.txt 与 verify.json，有失败就以非 0 退出。
再写 tools/reset.mjs 复位，以及 README.md（运行说明）、VERIFICATION.md（验证样例）。
```

**跑**

```bash
npm run verify
```

**截图 10**：① 对话框 ② verify 逐项输出 ③ **Qoder Sites 发布页 + 「任何人都可访问」设置**
**commit**：`test: 端到端验收脚本`

---

## 收尾（3 分钟）

```bash
# 把 Qoder 做出来的成果覆盖到提交仓库
cd D:/赛题
rm -rf yuanyuepowercontext/qoder/shijuan/{server,public,scripts,tools,data,package.json,package-lock.json,.npmrc}
cp -r qoder-dev/{server,public,scripts,tools,data,package.json,package-lock.json,.npmrc} yuanyuepowercontext/qoder/shijuan/
cd yuanyuepowercontext && git add -A qoder && git commit -m "feat(qoder): 按 Qoder 会话产出的实现替换参考实现" && git push
```

- 再把 `qoder-dev` 的 git 历史导出成 `docs/qoder/commits.txt`（`git log --stat > commits.txt`），和截图一起放进去。
- 站点仍用 `qoder-shijuan/site/index.html`（已包含最终数据和截图），发布即可。

---

## 时间分配建议

| 阶段 | 预计 | 卡点 |
|---|---|---|
| 0 准备 | 10 min | 找虚拟机 IP |
| P1–P2 | 20 min | npm 的 workspace 报错 |
| P3 | 40 min | seekdb 集合名限制、中文名映射 |
| P4–P5 | 30 min | 模型路径 |
| P6–P7 | 40 min | 覆盖率阈值调参 |
| P8–P9 | 40 min | 前端细节 |
| P10 | 30 min | verify 的判定阈值 |

一轮下来 3 小时左右。中途 Qoder 写错的地方**不要急着改掉**，先把报错和纠正过程截下来——评审看的就是这个。
