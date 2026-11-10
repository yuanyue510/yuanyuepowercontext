# Qoder 开发记录 · 书证（教材口径复习助手）

> 本文档按真实时间线记录项目在 Qoder 中的开发过程。所有 commit 均可核对，
> 每个阶段对应 `docs/qoder/` 下的截图（文件名见 §2 表格）。

## 0. 账号与环境

| 项 | 值 |
|---|---|
| Qoder 账号 UID | `1940117489165517`（Qoder CN 账号资料页「阿里云账号 ID」，核对截图见 `docs/qoder/00-account-uid.png`） |
| Qoder 客户端 | Qoder 桌面端，**个人账号**登录（个人版才能把 Sites 设为「任何人都可访问」） |
| 工作区 | `D:/赛题/qoder-dev`（空目录起步，git 初始提交 `17c59d2`） |
| 开发日期 | 2026-11-10（11:05 起，19:54 完成 P8） |
| 项目网站 | `https://shuzheng-x27geuy7mf0.qoder.zone`（Qoder Sites 发布，`published:true`，可见范围 public） |
| 代码仓库 | `https://github.com/yuanyue510/yuanyuepowercontext/tree/2026-competition-ecosystem/qoder/shuzheng` |
| 运行环境 | Windows 11 + Node 22；seekdb 1.4.0 运行在 VMware CentOS 7 虚拟机 `192.168.192.131:2881`（MySQL 协议，库 `shijuan`） |

> UID 仅用于赛事材料核对（站点归属与使用记录），不在项目网站公开页面展示。

## 1. 开发时间线（真实过程，含纠偏）

### P1 需求拆解（11:11–11:35）

第一条提示词即明确约束：必须用 seekdb 混合检索、不调用云端模型、前端零构建。
Agent 未直接写代码，按要求先产出 `docs/plan.md`。

**过程中的三次纠偏（均有对话截图）：**

1. **反复环境探查**：连续 5 轮只读命令（`ls`/`cat`/`python --version`/`docker --version`/`netstat`），
   其中 `netstat` 在 Windows 上查 2881 必然为空——seekdb 在虚拟机里。补充部署信息后纠正。
2. **误判环境阻塞**：Agent 将「无 Docker CLI、无真正的 Python」判定为硬约束，转去调研 WSL
   （子 Agent 运行 197 秒）。人工打断并说明技术栈只需 Node，立即回到方案设计。
3. **整站爬取文档**：Agent 两次转向抓取文档站导航与 `sitemap.xml`，被判低效后拒绝；
   改为直接提供本地 `node_modules/seekdb/README.md` 的接口摘录（`SeekdbClient` / `Schema` /
   `FulltextIndexConfig` / `VectorIndexConfig` / `hybridSearch`），Agent 随即产出方案。

产出：`docs/plan.md`（363 行），含功能清单 F1–F10、数据模型、选型理由、目录结构、验收点；
并主动标注「范围冻结：主线 F1–F5 + F7/F8，F6/F9/F10 为可选扩展」。

### P2 骨架与依赖（11:37–13:54）

- 生成 `package.json`、`server/`（config / index / routes/health）、零构建前端壳 `public/`。
- **关键排错**：`npm install seekdb` 报 `Unsupported URL Type "workspace:"`。Agent 没有盲目重试，
  而是执行 `npm view seekdb peerDependencies` 定位根因：seekdb 的 peer 依赖
  `@seekdb/default-embed` 自带 `workspace:*` 引用。解法为项目根目录加
  `.npmrc`（`legacy-peer-deps=true`）关闭自动 peer 安装——该配置同时保证
  `@seekdb/default-embed`（云端向量化插件，违反离线约束）不会被装上，
  一个配置同时解决安装报错与合规约束两个问题。
- **部署模式判断**：Agent 实测嵌入式模式在 Windows 不可用（`@seekdb/js-bindings` 只有
  `download.js`，无本地原生库，进程挂起），确认 server 模式是唯一路径。
- 收尾：`/api/health` 返回 JSON（seekdb 连通、模型在位、`cloudModelCalls: "forbidden"`）。

Commits：`5d0a32f`（骨架）。

### P3 seekdb 连通与冒烟（13:54–14:07）

`npm run smoke` 全链路通过：连接 → `createCollection`（ngram2 + HNSW 512 cosine，
`embeddingFunction: null`）→ `add` → `get` → `hybridSearch`。
顺手完成限时探针（`npm run probe`），三项结论写入 plan.md：

1. `$contains` 对中文短词有效；
2. **ngram2 跨词边召回成立**：`"重力加"`、`"能定"` 这类二元组片段可命中——关键词降级策略的依据；
3. 返回结构只有 `ids/distances/documents/metadatas/embeddings`，无 `similarity` 字段，`ids` 为嵌套数组需 `.flat()`。

Commits：`6071896`（内置 23MB ONNX 模型，普通提交不用 LFS，保证评审离线可跑）、`348e9c8`（连通与冒烟）。

### P4 导入链路（14:07–14:30）

实测并写入 plan.md 的四条结论：

1. `hybridSearch` 是**并集融合**而非 AND 过滤——关键词不存在时仍返回向量近邻，
   所以"资料没讲到"不能靠空结果判断；
2. `distances` 经差分测试（固定关键词、只换查询向量）确认为**融合名次分**：
   排序不变、分数微变；纯向量 `query()` 才有界（0.357/0.563）。据此定死规则：
   **分数只用于排序，不参与判定**；
3. 写入后向量通道有秒级可见性延迟（T+0 只召回全文命中 1 条，T+5s 稳定 2 条）
   → 导入必须加"就绪门槛"（轮询而非固定 sleep）；
4. `getCollection` 必须显式传 `embeddingFunction: null`，否则 SDK 动态
   `import('@seekdb/default-embed')` 报错——这条同时挡住了云端插件。

**Agent 自我纠错一例（保留在对话记录中）**：Agent 曾误判 `metadatas` 与 `documents`
错位，经单条验证后自行更正，真实结论是 `get({ids})` 按表序返回、不保查询顺序。

实测数据：33 条句级切片（短句合并生效 4 条）、本地向量化 356 ms / 33 条 / 512 维、
写入 33 条（每批 8 条）、offset 自检通过。

Commit：`c7f7693`。

### P5 证据卡与未覆盖判定（15:14–15:30）

21 个文件、+1158 行。期间 Agent 自检发现真实 bug：

> R1 短句合并拼接时丢掉句间换行，导致 `slice(char_start, char_end)` 不再等于存储文本。
> 修法：**文本按构造即为精确 span**，不做事后 slice，从根上避免引用错位。

`coverage.js` 实现两条可解释的未覆盖判定规则（覆盖率 < 0.34 且无一句含 ≥2 个查询词，
两条同时成立才判未覆盖）；`assemble.js` 产出带 `[n]` 引用的抽取式答案；
`ready.js` 实现就绪轮询门槛。

**实测量化（换一篇语料「生物必修1-细胞代谢讲义」重跑，不是复用上一篇）：**

| 项 | 实测 |
|---|---|
| 导入 | HTTP 200，客户端 9051 ms（其中首次加载 ONNX 模型 8071 ms），9 节 / 33 切片 / 合并 7 条 / 残留短句 0 / `offsetOk: true` |
| 就绪门槛 | 轮询 3 次、467 ms 放行（上限 10000 ms）：第 1 次表内 33 行但**向量通道可召回 0 条**，第 2 次 33/33 |
| 已覆盖判定 | 「有氧呼吸哪个阶段释放的能量最多」覆盖率 1.0、最强句含 3 个查询词 → 判已覆盖，`sufficient`，引用句 `char 821-838` 与原文逐字一致 |
| 未覆盖判定 | 「洛伦兹力的方向怎么判断」覆盖率 0、无一句含 2 个查询词 → 两条规则同时成立 → 拒答，`accuracy: none`，同时写入卡点账本 `st_cc8aa7b54c85 (open)` |
| 端到端时延 | 3 题分别 705 ms / 1179 ms / 512 ms（其中 1179 ms 超过 800 ms 目标，原因与取舍见下） |

> 就绪门槛这一项的截图 `09-import-ready.png` 是整套材料里最能说明「为什么不能 fixed sleep」的证据：
> 表里明明已有 33 行，向量通道却召回 0 条——固定 sleep 短了必然漏。

**如实记录的两处不达标（已写入 plan.md 与 TECHNICAL 的已知限制，不做掩盖）：**

1. 三关键词那题 1179 ms，超了 800 ms 目标。根因是 4 条检索通道串行、`hybridSearch` 用会话变量不能并发；
   降到 3 条通道即可回到目标内，但会牺牲一路召回，**选择先保召回、把时延如实写出来**。
2. 前端只验证到「模块全部 200 + 相对 import 图解析通过」，DOM 渲染与点击高亮需人工在浏览器确认。

**一次危险操作的自我纠正（保留在记录里）**：Agent 用过 `taskkill /IM node.exe` 清端口，
会连带杀掉同机其他 node 进程（包括编辑器插件的 node 进程）。正确做法是按 PID 精确结束，
这条已写进 plan.md 的「禁止操作」清单。

### P6 复习闭环（15:40–16:10）

14 个文件、+532/−20。交付三样：复习队列接口、状态机、前端复习页。

**① 接口自描述**：`GET /api/review` 返回 `{"table":"sh_review","pending":[...],"counts":{"open":1}}`，
每条带 `allowed: ["reviewing"]` —— 前端不用硬编码状态流转规则，按钮由后端给。

**② 同一问题问两次 → 一条卡点、错次累加**：`missCount=2`，`concept="洛伦兹力、方向、判断"`，
`nearestDocId=doc_03ee62e3b9`。卡点不是每次新建，而是按「学习者 + 资料集 + 概念」归并。

**③ 状态机实测（表格为 `npm run show:review` 直查 seekdb 的库内前后对照，不走业务接口）**

| 阶段 | HTTP | status | miss | status_changed_at | mastered_at |
|---|---|---|---|---|---|
| 拒答两次后 | — | open | 2 | 15:53:40 | null |
| →reviewing | 200 | reviewing | 2 | 15:54:21 | null |
| →reviewing（重放） | **409** | — | — | 不推进 | — |
| →mastered | 200 | mastered | 2 | 15:54:34 | 15:54:34 |
| →reviewing（跨态回跳） | **409** | — | — | 不推进 | — |
| →open（回退） | 200 | open | 2 | 15:54:50 | null（已清空） |
| 并发双发 open→reviewing | 一个 200 / 一个 **409** | reviewing | 2 | 只推进一次 | null |

外加：非法状态值 400、不存在的 id 404、`mastered` 后从队列消失（`counts={"reviewing":1,"mastered":1}`）。

**过程中一个真发现**：seekdb JS SDK 的 `execute()` 对非 SELECT 语句返回 `null`，拿不到
`affectedRows`，因此「并发只推进一次」无法靠返回值判断。改法：新增 `server/lib/seekdb/sql.js`，
用**带前驱状态守卫的 `UPDATE ... WHERE id=? AND status IN (...)`**，以受影响行数裁决 ——
两个并发请求只有一个能匹配到前驱状态，另一个自然 409。

**如实说明的取舍**：`mastered` 回退到 `open` 时 `mastered_at` 被清空，即只保留当前态，
**不保留掌握历史**。没有为它加事件表（比赛周期内不值得），这条写进 TECHNICAL 的已知限制。

### P7 收口与验收（16:20–18:34）

**端口收口**：8790 上的 P5 旧实例（PID 9636）与 8791 的临时实例（PID 42452）按 PID 精确结束，
最新代码在 8790 重启（PID 14512，内含 `withReconnect`），**全程未再开 8791**，也未使用
`taskkill /IM` 这类会误伤同机其他 node 进程的命令。

**验收结果**：`npm run seed` 退出码 0、`npm run verify` 退出码 0，
`evidence/verify-log.txt` 记 **24 项通过、0 失败**，耗时 4.19 s（10:29:48.404Z → 10:29:52.594Z），
`evidence/verify.json` 记 `exitCode: 0 / passed: 24 / failed: 0`。

**时延（这次把冷热两种情况分开记，避免自相矛盾）：**

| 场景 | 数值 | 说明 |
|---|---|---|
| 单词键查询（warm，5 次样本） | 40 / 57 / 59 / 59 / 69 ms | P95 ≤ 69 ms，远低于 800 ms 目标 |
| 多关键词 4 通道串行（重启后稳态，3 次） | 75 / 83 / 79 ms（中位 79、最大 83） | 达标 |
| 同形查询走 3 条通道（物理篇） | 52 ms | 对照用，说明通道数是主要成本项 |
| 首次提问（含 ONNX 模型加载） | 1179 ms | **冷启动**，不进达标判定，写进已知限制 |

> 早前材料里那句「三关键词 1179 ms 超 800 ms」是冷启动含模型加载的值，不是稳态；
> 稳态实测 75–83 ms 已达标。两处都保留，标注清楚，不留「一个数两种说法」的尾巴。

**Agent 自查出的一处真错**：验收脚本原来把物理篇的通道数（3 条）标在了生物篇查询后面，
与断言文案里的「4 条通道」自相矛盾；改正为各归各的，并重跑生成最终 evidence。
这种「验收脚本自己错、自己抓出来」的过程保留在记录里。

**文档与实测对齐**：README / VERIFICATION / TECHNICAL 的验收项数统一为 24（原写 23），
性能表换成重启后新进程的稳态值并保留冷启动数字；TECHNICAL 第九节补「`withReconnect` 的自愈范围」
风险项 —— 它只重试死连接这一类错误，且重试后要实测集合仍可用，不是万能重试。

Commit：`88c94b7`（29 个文件：三份文档、两个脚本、`client.js`、`package.json`、`evidence/**`、
以及 `.gitignore` 里的 UID 截图排除行）。

### P8 项目网站与发布（19:40–19:54）

**产出**：`site/index.html` 单文件 665,079 字节（649.5 KB），含 4 张截图以 `data:image/png;base64`
内联（共 626 KB）；生成脚本 `scripts/build-site.mjs` 留在仓库里，删了可重跑复现，站点本身不依赖脚本。

**页面结构**（8 节，对应评审最想先看的东西）：

1. 头部：一句话定位 + 四条红线（seekdb 承担存储检索 / 零云端模型 / 前端零构建 / 答案只从原文抽）
2. 三个痛点：找不到原句、大模型答得顺但口径不一致、事后忘了卡在哪
3. 做法：导入（句级切片 + 偏移 + 就绪门槛）→ 提问（k 条全文 + 1 条向量 → 证据卡 → 判定）→ 复习（卡点队列 + 状态机）
4. 与 seekdb 的三处结合：库内混合检索、拒答判据（覆盖率 0.34 / ≥2 词同句，并解释为何不用名次分阈值）、卡点账本与复习队列
5. 实测数据：24 项验收表、冷热时延表、两条真实原文引用（含一句拒答全文）
6. 截图与原始输出：4 张内联图 + `verify-log.txt` 尾部原文
7. 三步跑起来：`npm install` → `npm start` → `npm run seed && npm run verify`
8. 已知限制 7 条（前两条即 `mastered_at` 回退清空、前端仅 DOM 级验证）

**自查（DOM 级，浏览器截图工具在本机不可用，如实记录证据等级）**：
`<script>` 0 个、`<link>` 0 个、`@import`/CDN/外部字体 0 处、CSS `url()` 非 data 0 处；
4/4 图片为 data URI 且与源文件 sha 逐张一致；正文无「待填写/TODO/占位」；617px 视口无横向溢出。

**发布**：Qoder Sites，`published: true`、`Operation committed`、`Release active`，
可见范围经授权改为 **public**（revision 2）。线上地址见 §0。

**两处如实说明：**

1. 线上响应里有一段平台注入的水印脚本（`<script data-qoder-watermark="v1">`，内联、不额外拉资源），
   不是本项目文件里的内容——评审在「查看源代码」时看到它属正常。
2. `20-review-empty.png` **没有**内联进站点：那张图头部带内网地址与库名，公开页面上印这些没必要，
   只放了 09/11/15/21 四张。仓库里仍保留全部截图供核对。

Commits：`5b7c9e9`（文档口径纠正）、`433a59e`（许可与截图）、`03e8245`（展示页与生成脚本）。

## 2. 截图清单（`docs/qoder/`）

| 文件 | 内容 | 状态 |
|---|---|---|
| `00-account-uid.png` | Qoder CN 账号资料页（已裁去 IP 与活跃会话）——含账号名与 ID，**已加入 .gitignore，只随提交附件提供** | ✅ |
| `01-plan-prompt.png` | P1 提示词 + Agent 环境探查连击 | 待补 |
| `02-plan-deviation.png` | WSL 误判 / sitemap 爬取的纠偏对话 | 待补 |
| `03-plan-output.png` | `docs/plan.md` 生成过程 | 待补 |
| `04-npm-error.png` | `workspace:` 报错原文 | 待补 |
| `05-npm-root-cause.png` | `npm view seekdb peerDependencies` 定位根因 | 待补 |
| `06-embedded-fail.png` | 嵌入式模式不可用的实测结论 | 待补 |
| `07-smoke.png` | smoke 全链路输出 | 待补 |
| `08-probe.png` | 中文 `$contains` + ngram2 三项结论 | 待补 |
| `09-import-ready.png` | 导入 HTTP 200 + 就绪轮询三次探测（33 行 / 向量可召回 0→33→33，467 ms 放行） | ✅ |
| `10-offset-bug.png` | R1 offset bug 的发现与修复 diff | 待补 |
| `11-coverage-refusal.png` | 已覆盖（覆盖率 1、最强句含 3 词）与未覆盖拒答（覆盖率 0、卡点账本 `st_cc8aa7b54c85`） | ✅ |
| `12-sites-publish.png` | Qoder Sites 发布与可见范围设置 | 待补 |
| `13-p5-changes.png` | P5 收尾：27 个文件 +1,480/−64 的变更总览与 offset 修法说明 | ✅ |
| `14-review-api.png` | `GET /api/review` 空队列 → 拒答两次 → `missCount=2 / allowed=["reviewing"]` | ✅ |
| `15-review-state-machine.png` | 状态机全路径库内对照：200 / 409 / 并发只推进一次 / 回退清空 | ✅ |
| `16-p6-changes.png` | P6 收尾：14 个文件 +532/−20，以及两条如实说明 | ✅ |
| `20-review-empty.png` | 前端复习页空态 | ✅ |
| `21-review-queue.png` | 前端复习页列表与三个状态按钮 | ✅ |

## 3. 人机分工说明（如实）

- **Qoder 完成**：需求方案（plan.md）、全部后端与前端代码、依赖排错、探针脚本、
  就绪门槛、未覆盖判定规则的实现。
- **人工完成**：提出需求与约束、纠正 Agent 跑偏（WSL / 文档爬取）、提供本机环境信息
  （seekdb 在虚拟机）、审批每次文件写入与命令执行、验收每阶段产出、决定范围裁剪
  （F6/F9/F10 转可选）。
- **未使用**：本项目代码未在其他 AI 编程工具中生成；仓库 commit 时间与 Qoder 会话时间一致，可交叉核对。
