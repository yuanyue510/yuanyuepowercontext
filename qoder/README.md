# Qoder 赛道 · 书证（教材口径复习助手）

> 赛题：**Qoder × OceanBase「Build with Qoder」**
> 作品：**书证** —— 把教材按句切片存进 seekdb，混合检索后只从原文里抽答案、每句都带出处；
> 资料没讲到就直说没讲到，并把这个卡点记进库，换会话、换天回来还在复习队列里。

**项目全部内容在 [`shuzheng/`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng) 目录**，评审请从 [`shuzheng/00-材料清单.md`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng/00-材料清单.md) 开始，或直接看：

| 想了解 | 看文件 |
|---|---|
| 站点 | https://shuzheng-x27geuy7mf0.qoder.zone |
| 怎么跑 | [`shuzheng/README.md`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng/README.md) |
| 怎么验 | [`shuzheng/docs/VERIFICATION.md`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng/docs/VERIFICATION.md) |
| Qoder 怎么参与的 | [`shuzheng/QODER_DEVLOG.md`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng/QODER_DEVLOG.md) + `shuzheng/docs/qoder/` 对话截图 |
| 技术实现 | [`shuzheng/docs/TECHNICAL.md`](https://github.com/yuanyue510/yuanyuepowercontext/blob/2026-competition-ecosystem/qoder/shuzheng/docs/TECHNICAL.md) · `shuzheng/docs/plan.md` |

## 最短运行路径

```bash
cd shuzheng
npm install          # 仓库自带 .npmrc（legacy-peer-deps=true），seekdb 的 peer 依赖不再报错
cp .env.example .env # 改 SEEKDB_HOST/PORT 指向你的 seekdb（MySQL 协议，默认 2881）
npm start            # 启动后访问 http://127.0.0.1:8790
npm run seed         # 另开终端：导入示例教材
npm run verify       # 端到端验收，含直接查库核对
```

模型（bge-small-zh-v1.5 INT8，24 MB）随仓库提交，无需联网下载；全流程不调用任何云端大模型或 embedding API，不需要 API Key。

## 技术结合（seekdb 三处）

- **文档检索**：每份教材一张表，`VECTOR(512)`（HNSW/cosine）+ ngram2 全文，`hybridSearch()` → `DBMS_HYBRID_SEARCH`，RRF **在库内融合**，不把候选拉回应用层再排。
- **答案约束**：只用检索到的原句拼答案，每句挂 `[n]` 指回原文；覆盖率不足且没有一句命中两个以上查询词时，判「资料没讲到」——不编。
- **学习记忆**：卡点账本与复习队列落成 seekdb 表，按「学习者 + 教材 + 概念」唯一，状态流转（未掌握 → 复习中 → 已掌握）是一条可核对 SQL。

## 前置原型：拾卷（`shijuan/`）

同一目录下还有 [`shijuan/`](https://github.com/yuanyue510/yuanyuepowercontext/tree/2026-competition-ecosystem/qoder/shijuan)，
是动手前用来验证 seekdb 方案可行性的**本地原型**：把「混合检索 + 记忆四表」这条路先跑通、量出时延，
确认能站住之后再在 Qoder 桌面端从空目录重建为正式作品。

保留它的原因很简单：原型阶段的验收日志（27 项、3.3s）和截图还在，评审可以对照两版看方案是怎么收敛的。
**正式提交、Qoder 开发记录、站点均以 `shuzheng/` 为准。**

## 说明

本仓库同时容纳多个赛道的作品（`dify/` `stepfun/` `gaode/` `minimax/` `qoder/` 等），
根目录 README 属于 Dify 赛道作品；本赛道材料以上述 `shuzheng/` 内的文件为准。
