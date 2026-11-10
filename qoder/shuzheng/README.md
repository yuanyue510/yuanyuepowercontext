# 书证 Shuzheng

教材口径复习助手：把自己导入的教材切到句级、存进 seekdb，提问时**只用教材原句**拼答案并逐句挂出处；
讲不出的就明说讲不出，并把这一处登记成卡点，之后按复习队列找回来。

无大模型、无云端 embedding、无前端构建 —— 断网（只要能连到 seekdb 端口）就能跑完整流程。

## 一、三条硬约束（赛题红线，代码里可核验）

| 约束 | 落地方式 | 怎么验 |
| --- | --- | --- |
| 存储 / 查询 / 检索全部由 seekdb 承担 | 向量 + 全文混合检索走 `collection.hybridSearch`，切片、注册表、卡点账本、复习队列都在同一个 seekdb 实例里 | `GET /api/health` 的 `seekdb.portOpen`；`npm run verify` 的检索①②③④ 四项 |
| 不调用任何云端大模型或 embedding 接口 | 本地 ONNX（`bge-small-zh-v1.5` q8）自算 512 维向量；建集合与取集合一律显式 `embeddingFunction: null`；`env.allowRemoteModels = false`；未安装 `@seekdb/default-embed` | `GET /api/health` 的 `offline.*`（`cloudModelCalls:"forbidden"`、`embeddingFunction:null`）；verify 第 1 项把这两个字段当断言 |
| 前端零构建 | 原生 ES Module + 手写 `el()` 建 DOM（不用 `innerHTML`），`express.static` 直接伺服 | 仓库无 `webpack/vite/rollup/esbuild` 配置、无 `dist/`；`npm start` 即可打开 |

答案不是生成的：`answer.kind` 只有 `extractive`（逐句挂 `ref`/`charStart`/`charEnd`）与 `refusal`（拒答 + 最近原文仅供对照）两种，
判定用的是可解释规则而不是任何分数阈值（见 `docs/TECHNICAL.md`）。

## 二、环境要求

- Node **≥ 22.9**（`--env-file-if-exists` 需要）。实测 v22.21.1。
- 一个可连通 **server 模式** seekdb（MySQL 协议）。嵌入式模式在 Windows 不可用（`@seekdb/js-bindings` 只发了 `download.js`）。
- 本地模型：**已随仓库提交，克隆下来就能用，不需要下载、不需要 Python**。
  ```
  models/bge-small-zh-v1.5/onnx/model_quantized.onnx   # 24 MB（24,010,842 字节），6071896 入库
  models/bge-small-zh-v1.5/tokenizer.json               # 与 config.json / tokenizer_config.json 同批入库
  ```
  运行时由 `@huggingface/transformers` 直接读目录（它自带 `onnxruntime-node`，纯 CPU）。
  缺文件时 `/api/health` 的 `offline.modelPresent/tokenizerPresent` 直接报 false，启动日志也会指出路径。
- 共享库注意：本项目所有对象一律 `sh_` 前缀，只 `CREATE TABLE IF NOT EXISTS`，**不 DROP 任何表**。

## 三、安装与配置

```bash
npm install
```

`.env`（放在仓库根，已被 `.gitignore` 忽略）。全部可用变量如下 —— 除 `SEEKDB_HOST` 外都有默认值：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `SEEKDB_HOST` | `127.0.0.1` | seekdb server 地址 |
| `SEEKDB_PORT` | `2881` | seekdb server 端口（MySQL 协议） |
| `SEEKDB_USER` | `root` | 用户名；不含 `@` 时连接串自动补成 `root@sys`（`server/lib/seekdb/sql.js:5`） |
| `SEEKDB_PASSWORD` | `''`（空） | 密码 |
| `SEEKDB_DATABASE` | `test` | 库名 |
| `PORT` | `8790` | 本服务监听端口 |

本项目实际用的 `.env` 形态（`evidence/verify-log.txt` 第 2 行会把它回显出来）：

```bash
SEEKDB_HOST=192.168.192.131
SEEKDB_PORT=2881
SEEKDB_USER=root
SEEKDB_PASSWORD=
SEEKDB_DATABASE=shijuan
```

模型路径、`ngram2` 全文索引、512 维、切片最短字数（15 字）、上下文窗口（±2 句）写在 `server/config.js` 里，不走环境变量。

## 四、跑起来（三条命令）

```bash
npm start          # 1) 起服务，默认 http://127.0.0.1:8790
npm run seed       # 2) 导入 eval/corpus 两篇示例资料（可反复执行，不会多出切片）
npm run verify     # 3) 端到端验收 24 项，任一失败退出码非 0
```

浏览器打开 <http://127.0.0.1:8790>：「提问」出证据卡与抽取式答案，「原文」按 `charStart` 高亮定位，「复习」是卡点队列。

`npm run verify` 的产物：

- `evidence/verify-log.txt` —— 24 条 `[PASS]/[FAIL]` 明细（含库内轮询日志）
- `evidence/verify.json` —— 同一批结果的机读版（`checks[]` / `measurements[]` / `exitCode`）
- `evidence/seed-log.txt`、`evidence/samples/` —— 导入日志与三组样例的请求/响应/库内对照

### 全部 npm 脚本

| 命令 | 干什么 |
| --- | --- |
| `npm start` | 起服务（`server/index.js`） |
| `npm run seed` | 导入两篇示例语料，打印切片数 / offset 自检 / 向量化耗时 / 就绪门槛轮询 |
| `npm run verify` | **P7 端到端验收**，24 项，写 `evidence/verify-log.txt` + `verify.json` |
| `npm run show:review` | 直接查库打印 `sh_review`（可给 id 前缀：`npm run show:review -- rv_e847`） |
| `npm run probe` | 早期中文 ngram 检索探针（基线集合 `sh_probe_ngram`，保留不动） |
| `npm run smoke` | seekdb 建集合→写→读→混合检索链路冒烟 |
| `npm run verify:distances` | 判定 `distances` 语义的差分测试 |
| `npm run verify:p5` | P5 那批断言（已被 `npm run verify` 覆盖，保留做回归） |
| `npm run demo:import` | P4 导入链路演示 |

## 五、可复制的单条命令

> **Windows Git Bash 的两个编码坑（实测，别踩）**
> 1. `curl -d '{"query":"中文"}'` 里行内中文会被本机代码页转成 GBK 字节再发出去 —— 服务端收到乱码。
>    `--data-urlencode "dataset=中文"` 同理，且**不报错**、只让结果静默变成空列表。
> 2. URL 路径里直接写中文，Node 的 HTTP 解析器返回 **400 `URIError: Failed to decode`**（不是 404）。
>
> 统一解法：**内容走 UTF-8 文件，路径走百分号编码**。仓库里 `evidence/samples/` 已放好请求体与 `dataset-bio.txt`。

```bash
# 健康自检（含离线红线字段）
curl -s http://127.0.0.1:8790/api/health

# 已覆盖：出抽取式答案，每句带 ref + 字符区间
curl -s -X POST http://127.0.0.1:8790/api/search \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @evidence/samples/A-covered.request.json

# 未覆盖：拒答 + 自动落卡点（返回体 stuck.reviewId 就是队列主键）
curl -s -X POST http://127.0.0.1:8790/api/search \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @evidence/samples/B-refusal.request.json

# 资料集列表（拿 collectionName / docId / chunkCount）
curl -s http://127.0.0.1:8790/api/dataset/list

# 某篇原文，前端高亮用它。路径必须编码：
curl -s "http://127.0.0.1:8790/api/dataset/$(node -e "process.stdout.write(encodeURIComponent('生物必修1-细胞代谢讲义'))")/text"

# 复习队列：待复习（status IN open,reviewing），按 miss_count DESC, last_seen ASC
curl -sG "http://127.0.0.1:8790/api/review" \
  --data-urlencode "dataset@$(cygpath -w evidence/samples/dataset-bio.txt)" -d "limit=50"

# 状态机：open→reviewing→mastered，回退只允许回到 open（id 是 ASCII，行内 JSON 安全）
curl -s -X POST http://127.0.0.1:8790/api/review/rv_e847b9c2064cebea/state \
  -H "Content-Type: application/json" -d '{"status":"reviewing"}'

# 卡点流水（append-only，一次拒答一行）
curl -s "http://127.0.0.1:8790/api/stuck?limit=5"

# 直接查库看复习队列（绕开接口，证明改动真在 seekdb 里）
npm run show:review -- rv_e847
```

浏览器地址栏不受上面两个坑影响，直接开 <http://127.0.0.1:8790> 操作即可。

API 一览：`GET /api/health`｜`POST /api/dataset/import`｜`GET /api/dataset/list`｜`GET /api/dataset/:name/text`｜
`POST /api/search`｜`GET /api/stuck`｜`GET /api/review`｜`POST /api/review/:id/state`。
`/api/term/*`、`/api/export/*` 明确返回 **501 未实现**（可选扩展，M1 不做）。

## 六、验收状态

`npm run verify` 最近一次：**退出码 0，24 项全通过**（4.2 秒，服务进程 PID 14512）。逐项覆盖：健康与离线红线、导入幂等、
就绪门槛（含"表行数够但向量通道召回为 0 不许放行"的负例）、四种检索形态、已覆盖判定、offset 逐字一致、
**查询词必须是原文子串**、未覆盖拒答、卡点落库、错次累加、状态机 200/409/400/404、并发只推进一次、
mastered 后离队、复习页非空与空态、时延实测、死连接自愈。原始输出与三组样例见 `evidence/`，逐步对照见 `docs/VERIFICATION.md`。

## 七、已知限制（都是实测口径，不是免责声明）

1. **首请求有冷启动，稳态很快；P5 记的「三关键词 1179 ms 未达标」在 P7 未复现。**
   P7 实测（同一天两次，含收尾重启后的那次）：单词键 warm 31–72 / 40–69 ms，三关键词（4 条通道串行）44–48 / 75–83 ms，
   `C.7 P95 ≤ 800 ms` **达标**。
   进程冷启动分项 337 ms（`import` 158 + 模型加载 158 + 首次推理 21）。P5 那批 512–705 / 1179 ms 取的是服务端
   `timing.totalMs` 的**首批**请求样本，无法与 P7 的 warm 数字直接比较 —— 这里以 `evidence/verify-log.txt` 为准。
   收尾时确实重启过 8790（新进程 PID 14512），但重启后第一个被计时的请求已经过了一轮热身，所以 **HTTP 层"进程起来后的第一次
   /api/search"至今没有数字**，只有上面那条分项冷启动时间能间接说明它的量级。
2. **`mastered_at` 在回退到 open 时会被清空。** 一条 UPDATE 同时写 `status/status_changed_at/mastered_at`，
   目标是"这一列只描述当前状态"。想留"曾经掌握过"的历史需要另开一列或看 `sh_stuck` 流水，M1 没做。
   verify 的「mastered 后离队」一项把清空这件事本身作为断言写死了。
3. **前端只做了 DOM 结构级验证，没有像素级截图。** `evidence/samples/D-frontend-dom.txt` 记录的是通过
   `evaluate_script` 读到的渲染结果（9 条待复习、按钮按服务端 `allowed` 置灰、切到空资料集显示「还没有卡点」、无 console 报错）；
   本环境浏览器面板折叠导致 `take_screenshot` 返回 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，样式与响应式布局请自己打开页面过一眼。
4. **检索与入库在本进程内串行。** SDK v1.4 的 `hybridSearch` 靠连接上的会话变量 `@search_parm`，并发会互相覆盖，
   所以 `exclusive()` 把检索排成一条队（`docs/TECHNICAL.md` 事实 13）。复习队列走独立 mysql2 连接池，不排在这条队后面。
5. **`hybridSearch` 带 `knn` 时全文条件是加权、不是硬过滤**（P7 复核成立，见事实 7 / 20）。字面命中由应用层
   `matchedTerms` 的 `includes` 校验兜住，所以证据卡不会出现"看着像但原文没有"的句子；代价是全文没命中时向量近邻仍占名额。
6. **示例语料是自写口径**（`eval/corpus/*.md`，10 + 9 小节），不是任何出版社原文；真实教材需要你自己导入。
7. **未实现（可选扩展，M1 冻结范围外）**：F6 口径体检、F9 沉淀导出、F10 管理面板 —— 路由返回 501，不做静默降级。
8. **长期空闲后曾整体报 500，现已自愈，但仍要重启一次才算"全新状态"。** P7 实测：进程跑约 97 分钟后，所有走 seekdb SDK
   的接口（检索 / 导入 / 取原文）一律 `500 {"error":"Can't add new command when connection is in closed state"}`，
   而 `/api/health` 仍报 `portOpen:true`（它只做 TCP 探测，不代表会话还在）。根因是 `server/lib/seekdb/client.js`
   缓存的单个 `SeekdbClient` 底下那条连接被服务端超时关掉后不会重建（`docs/TECHNICAL.md` 事实 24）。
   现在 `withReconnect()` 认出这类错误就丢掉单例重试一次，验收第 24 项盯着它。**残留边界**：只覆盖"打开集合 / 原生 SQL"
   这两个写入之前的动作 —— 一次请求写到一半才断的话，本次仍会失败，由下一个请求自愈（不重试写入是为了不重复落库）；
   也没有加保活心跳。所以现场演示前还是建议先空跑一次 `npm run seed`，既热身也把连接建立起来。

## 八、仓库往哪看

- `docs/plan.md` —— 赛题理解、功能清单 F1–F10、数据模型、验收点（**范围以它为准**）
- `docs/TECHNICAL.md` —— 24 条实测事实与取舍（改检索/入库代码前先读它）
- `docs/VERIFICATION.md` —— 怎么验收、24 项对照、三组样例的输入→预期→实际→库内记录
- `evidence/` —— `verify-log.txt`、`verify.json`、`seed-log.txt`、`samples/`
- `server/lib/` —— `ingest/`（切片）、`seekdb/`（连接、就绪门槛、SQL 池）、`answer/`（关键词、覆盖、拼装）、`review/`（队列与状态机）
