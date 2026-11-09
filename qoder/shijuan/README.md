# 拾卷 · 学习资料检索与记忆助手

把笔记、教材、论文片段导入 seekdb，提问时返回**带出处的答案**，并且把「资料没讲到 / 你没读懂」的问题记成复习清单——换会话、换浏览器都还在。

> 赛题：Qoder × OceanBase · Build with Qoder
> 技术选型：**Qoder（开发与站点发布）+ seekdb 1.4.0（混合检索 + 学习记忆存储）**
> 一句话：答案不是编的，是从你的资料里挑出来并标了出处的；记性不是装的，是存在 seekdb 表里的。

---

## 一、它解决什么

| 场景 | 原来的做法 | 拾卷的做法 |
|---|---|---|
| 复习时想找「缺页中断五步」 | 翻文件、Ctrl+F，关键词不对就找不到 | 向量 + 全文双路召回，库内 RRF 融合，8 条候选 10–20 ms |
| 想知道教材怎么定义某个概念 | 问通用大模型，口径和教材对不上 | 答案由检索到的段落拼装，每句带 `[n]`，点开就是原文 |
| 当时没读懂，后来忘了卡在哪 | 无 | 「没懂」写进 `sj_weakpoints`，下次打开直接在复习清单里 |
| 想确认「它真用了 seekdb」 | — | `npm run verify` 直接连库，把 `VECTOR(512)` 列、FULLTEXT/VECTOR 索引、记忆行全部打印出来 |

## 二、环境与依赖

| 项 | 版本 / 说明 |
|---|---|
| Node.js | ≥ 20（实测 22.22.2） |
| seekdb | 1.4.0（`5.7.25-OceanBase seekdb-v1.4.0.0`，server 模式实测；也支持 Docker 与嵌入式） |
| npm 依赖 | `express@4` `seekdb@1.4` `mysql2@3` `@huggingface/transformers@3.7` |
| 嵌入模型 | `bge-small-zh-v1.5` ONNX INT8，512 维，23 MB，**进程内推理，不需要 API Key** |
| 浏览器 | 任意现代浏览器（界面无构建步骤，原生 ES Module） |

> 说明：仓库自带 `.npmrc`（`legacy-peer-deps=true`）。seekdb 的 peer 依赖声明会让 npm 严格模式报 `Unsupported URL Type "workspace:"`，这个文件让 `npm install` 直接可用。
>
> 说明：本项目**没有调用任何大模型**。答案是从检索结果里抽取段落拼装的，因此离线可跑、结果可核对；代价是表达不如生成式自然，见 §七。

## 三、从零跑起来

### 1. 准备 seekdb

Docker（任意机器）：

```bash
docker run -d --name seekdb -p 2881:2881 oceanbase/seekdb
```

或使用已有 seekdb 实例（云上、虚拟机、本机均可），只要 2881 端口可达。数据库 `shijuan` 与所有表由程序首次启动时自动创建，无需手工建库。

> 实测环境是一台 CentOS 7 虚拟机上的 seekdb 1.4.0（原生安装，`systemctl start seekdb`），宿主机通过 `SEEKDB_HOST` 直连。Docker 方式未在本机实测（开发机未装 Docker），命令来自 seekdb 官方文档。

### 2. 装依赖与模型

```bash
npm install
npm run fetch-models      # 从 hf-mirror 下载 bge-small-zh-v1.5 的 INT8 ONNX（约 23 MB）
```

模型文件落在 `models/bge-small-zh-v1.5/`。脚本依次尝试 hf-mirror 与 huggingface.co，遇到 429 限流会自动换源；**提交压缩包内已附带这 23 MB 模型**，从压缩包解压后可直接跳过这一步。

### 3. 配置

```bash
cp .env.example .env
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEEKDB_HOST` / `SEEKDB_PORT` | `127.0.0.1` / `2881` | seekdb 地址，**改成你的实例** |
| `SEEKDB_USER` / `SEEKDB_PASSWORD` | `root` / 空 | 官方镜像默认 root 空密码 |
| `SEEKDB_DATABASE` | `shijuan` | 库名，不存在会自动建 |
| `PORT` | `8790` | 服务端口 |
| `WEAK_THRESHOLD` | `0.55` | 覆盖率低于该值视为「资料没讲到」（备用阈值，判定以覆盖率为准） |

### 4. 启动并导入示例语料

```bash
npm start                 # http://localhost:8790
npm run seed              # 另开一个终端，导入 data/seed/ 下 6 篇学习资料
```

导入成功会打印每篇的切片数、各阶段耗时和「导入后自检」结果：

```
导入 6 篇到资料集「期末复习」
  01-操作系统-进程与线程.md  932 字 → 5 片
  ...
共 33 片；耗时 切片 1ms / 向量化 1800ms / 写入 297ms / 刷新索引 628ms / 自检 82ms
导入后自检（新片段是否可检索）：通过
```

### 5. 用起来

浏览器打开 <http://localhost:8790>：

1. 左侧是资料集（示例数据已建好「期末复习」），点「＋ 新建」可以开新资料集；
2. 「提问」页输入问题 → 选择混合 / 仅向量 / 仅全文 → 得到答案与片段列表；
3. 觉得没读懂，点「没懂，记下来」；资料没讲到时也会自动记录；
4. 「复习」页查看薄弱点，点「懂了」或「还是不懂」；
5. 「资料」页粘贴或选择 `.md/.txt` 导入新内容。

### 6. 一键验收

```bash
npm run verify
```

27 项检查全部通过才会以 0 退出，同时写出 `evidence/verify-log.txt` 与 `evidence/verify.json`（详见 `VERIFICATION.md`）。

复位到初始状态：

```bash
npm run reset -- --learner=demo          # 只清该学习者的记忆
npm run reset -- --learner=demo --collection=期末复习   # 连资料集一起删
```

## 四、目录结构

```
server/index.mjs      HTTP 接口（导入 / 检索 / 提问 / 记忆 / 导出）
server/db.mjs         seekdb 双通道：集合（向量+全文）与记忆四表（SQL）
server/embed.mjs      本地 bge 向量化（INT8，进程内）
server/chunk.mjs      中文友好切片（320 字 / 重叠 60）
server/qa.mjs         抽取式答案：查询词×稀有度打分，带 [n] 引用
public/               单页前端（原生 JS，无构建）
data/seed/            6 篇演示语料（操作系统 / 数据库 / 机器学习 / 算法 / 网络）
scripts/fetch-models.mjs  模型下载
scripts/seed.mjs      导入示例语料
tools/verify.mjs      端到端验收（含直接查库）
tools/reset.mjs       复位脚本
tools/shots.py        截图（开发辅助）
tools/build_site.py   生成单文件项目网站
site/                 Qoder Sites 发布用的静态页
docs/qoder/           Qoder 开发记录（对话截图、提示词、UID）
```

## 五、接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | seekdb 版本、模型状态、资料集与片段数 |
| GET | `/api/overview?learner=` | 资料集 + 记忆概览 |
| GET/POST/DELETE | `/api/collections` | 列出 / 新建 / 删除资料集 |
| POST | `/api/docs` | `{collection, files:[{name,text}]}` 切片、向量化、写入、刷新、自检 |
| POST | `/api/search` | `{collection, query, mode, k}` 三种检索模式 |
| POST | `/api/ask` | 检索 + 拼答案 + 记录提问 + 未覆盖时写薄弱点 |
| GET | `/api/memory?learner=` | 复习清单与统计 |
| POST | `/api/memory/weak` | 手动标记「没懂」 |
| POST | `/api/memory/review` | `{weakId, result}` 标记掌握 / 仍不懂 |
| GET | `/api/export/review?learner=` | 导出 Markdown 复习清单 |

## 六、seekdb 分工（技术结合）

| 用途 | 落在哪里 | 怎么证明 |
|---|---|---|
| 文档检索 | 每个资料集一张表：`embedding VECTOR(512)`（HNSW/cosine）+ `document`（ngram2 全文）+ `metadata` JSON；检索走 `hybridSearch()` → `DBMS_HYBRID_SEARCH`，**RRF 在库内融合** | `npm run verify` 会打印物理表列类型与 `FULLTEXT + VECTOR` 索引；`evidence/verify.json` 记录三种模式的耗时与 top1 |
| 学习记忆 | `sj_learners` / `sj_questions` / `sj_weakpoints` / `sj_reviews` 四张表，按「学习者 + 资料集 + 概念」唯一 | `npm run verify` 直接 `SELECT` 出本次产生的记忆行，并验证「已掌握」不再出现在待复习列表 |

两处用的是同一个 seekdb 实例、同一个库：文档走集合接口，记忆走 SQL。**本项目未使用 PowerContext**（赛题要求 seekdb / PowerContext 至少一种）。

## 七、已知限制

| 项 | 现状 |
|---|---|
| 答案生成 | 纯抽取式，不调用大模型；长段落会被截断到 420 字，表达不如生成式自然 |
| 「资料没讲到」判定 | 以查询词覆盖率（≥34%）为主，属于启发式；同义改写较多的问题可能误判为未覆盖 |
| 资料集命名 | seekdb 集合名只允许 `[a-zA-Z0-9_]`，因此中文名通过 `sj_collections` 做 slug 映射（`sj_c_<hash>`） |
| 规模 | 演示数据 33 片段；设计上面向个人笔记量级（万级片段），未做更大规模压测 |
| 多用户 | 记忆按 `learner` 字段区分，但没有登录鉴权，属于单机自用定位 |
| 图片/PDF | 只支持纯文本 `.md/.txt`，PDF 需先转文本 |

## 八、许可证

MIT，见 `LICENSE`。第三方组件与模型来源见 `NOTICE.md`。
