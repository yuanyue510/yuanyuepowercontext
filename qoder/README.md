# Qoder 赛道 · 拾卷（学习资料检索与记忆助手）

> 赛题：Qoder × OceanBase · Build with Qoder —— 用 Qoder 做一个让学习、科研和工作更高效的项目
> 作品：**拾卷** —— 把笔记/论文导入 seekdb，混合检索出带 `[n]` 出处的答案；资料没讲到的问题自动记成薄弱点，换会话仍在。

**项目全部内容在 [`shijuan/`](shijuan) 目录**，评审请从 [`shijuan/00-材料清单.md`](shijuan/00-材料清单.md) 开始，或直接看：

| 想了解 | 文件 |
|---|---|
| 怎么跑 | [`shijuan/README.md`](shijuan/README.md) |
| 怎么验 | [`shijuan/VERIFICATION.md`](shijuan/VERIFICATION.md) + `npm run verify`（27 项） |
| Qoder 开发记录 | [`shijuan/QODER_DEVLOG.md`](shijuan/QODER_DEVLOG.md) + `shijuan/docs/qoder/` |
| 技术实现 | [`shijuan/TECHNICAL.md`](shijuan/TECHNICAL.md) · [`shijuan/DESIGN.md`](shijuan/DESIGN.md) |
| 实测证据 | [`shijuan/evidence/`](shijuan/evidence) |

## 最短运行路径

```bash
cd shijuan
npm install          # 仓库自带 .npmrc（legacy-peer-deps=true），seekdb 的 peer 依赖不再报错
cp .env.example .env # 改 SEEKDB_HOST/PORT 指向你的 seekdb（兼容 MySQL 协议，默认 2881）
npm start            # 启动后访问 http://127.0.0.1:8790
npm run seed         # 另开终端：导入 6 篇示例资料
npm run verify       # 27 项端到端验收，含直接查库核对
```

模型（bge-small-zh-v1.5 INT8，23 MB）已随仓库提交，无需联网下载。

## 技术结合（seekdb 两处，都在库内）

- **文档检索**：每个资料集一张表，`VECTOR(512)`（HNSW/cosine）+ ngram2 全文，`hybridSearch()` → `DBMS_HYBRID_SEARCH`，RRF(k=60) **在库内融合**。
- **学习记忆**：`sj_learners / sj_questions / sj_weakpoints / sj_reviews` 四表，按「学习者+资料集+概念」唯一，复习队列是带排序的 SQL。
- 未使用 PowerContext（赛题要求两者选一）。
- 不调用任何云端大模型 / embedding API，无 API Key；向量化由本地 ONNX 模型在 Node 进程内完成。

## 说明

本仓库同时容纳多个赛道的作品（`dify/` `stepfun/` `gaode/` `minimax/` `qoder/` 等），根目录 README 属于 Dify 赛道作品；本赛道材料以上述 `shijuan/` 内的文件为准。
