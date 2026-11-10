"""seekdb（OceanBase，MySQL 协议）访问层：建表、写入、向量检索、全文检索。

设计要点
--------
* 工程资料（规格 / 代码符号 / 测试）以"工件"为单位落库，`artifact_id` 全局唯一；
* 向量单独存表 `embedding`，列类型 VECTOR(1024)，并建 HNSW 向量索引；
* 正文列建全文索引（ngram 分词，兼容中文），用于关键词召回；
* 每次 SQL 都会追加到 records/db_query_log.jsonl，作为"数据库实际参与"的证据。
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import pymysql
from pymysql.cursors import DictCursor

from .config import Config

DDL_ARTIFACT = """
CREATE TABLE IF NOT EXISTS artifact (
  artifact_id VARCHAR(191) NOT NULL,
  kind        VARCHAR(16)  NOT NULL,
  path        VARCHAR(512) NOT NULL,
  symbol      VARCHAR(255) NOT NULL DEFAULT '',
  start_line  INT          NOT NULL DEFAULT 0,
  end_line    INT          NOT NULL DEFAULT 0,
  title       VARCHAR(512) NOT NULL DEFAULT '',
  content     MEDIUMTEXT,
  tags        VARCHAR(255) NOT NULL DEFAULT '',
  refs        VARCHAR(1024) NOT NULL DEFAULT '',
  revision    CHAR(32)     NOT NULL,
  ingested_at DATETIME     NOT NULL,
  PRIMARY KEY (artifact_id)
)
"""

DDL_EMBEDDING_VEC = """
CREATE TABLE IF NOT EXISTS embedding (
  artifact_id VARCHAR(191) NOT NULL,
  model       VARCHAR(64)  NOT NULL,
  dim         INT          NOT NULL,
  vec         VECTOR(1024) NOT NULL,
  PRIMARY KEY (artifact_id),
  VECTOR INDEX idx_embedding_vec (vec) WITH (distance=cosine, type=hnsw, lib=vsag)
)
"""

DDL_EMBEDDING_PLAIN = """
CREATE TABLE IF NOT EXISTS embedding (
  artifact_id VARCHAR(191) NOT NULL,
  model       VARCHAR(64)  NOT NULL,
  dim         INT          NOT NULL,
  vec         VECTOR(1024) NOT NULL,
  PRIMARY KEY (artifact_id)
)
"""

DDL_RUN = """
CREATE TABLE IF NOT EXISTS ingest_run (
  run_id     VARCHAR(64) NOT NULL,
  started_at DATETIME    NOT NULL,
  finished_at DATETIME,
  spec_count INT NOT NULL DEFAULT 0,
  code_count INT NOT NULL DEFAULT 0,
  test_count INT NOT NULL DEFAULT 0,
  status     VARCHAR(16) NOT NULL DEFAULT 'running',
  note       VARCHAR(512) NOT NULL DEFAULT '',
  PRIMARY KEY (run_id)
)
"""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def vec_literal(vec: Sequence[float]) -> str:
    """把向量序列转成 seekdb 认的字符串字面量 '[0.1,0.2,...]'。

    只用格式化后的浮点数拼接，不含任何用户输入，避免注入。
    """
    return "[" + ",".join(f"{float(x):.8f}" for x in vec) + "]"


class SeekDB:
    def __init__(self, cfg: Config, log_path: Optional[str] = None) -> None:
        self.cfg = cfg
        self.log_path = log_path or os.path.join(cfg.records_dir, "db_query_log.jsonl")
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)

    # ------------------------------------------------------------------ 连接
    def _connect(self, database: Optional[str] = None):
        return pymysql.connect(
            host=self.cfg.db_host,
            port=self.cfg.db_port,
            user=self.cfg.db_user,
            password=self.cfg.db_password,
            database=database,
            charset="utf8mb4",
            cursorclass=DictCursor,
            autocommit=True,
            connect_timeout=10,
        )

    def _log(self, sql: str, params: Any, rows: int, elapsed_ms: float, note: str = "") -> None:
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "db": f"{self.cfg.db_host}:{self.cfg.db_port}/{self.cfg.db_name}",
            "sql": " ".join(sql.split())[:400],
            "params": _short_params(params),
            "rows": rows,
            "elapsed_ms": round(elapsed_ms, 2),
            "note": note,
        }
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")

    def execute(self, sql: str, params: Any = None, database: Optional[str] = None,
                note: str = "") -> Tuple[int, List[Dict[str, Any]]]:
        started = time.time()
        conn = self._connect(database)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if cur.description else []
                affected = cur.rowcount
            self._log(sql, params, len(rows) if rows else affected, (time.time() - started) * 1000, note)
            return affected, list(rows)
        finally:
            conn.close()

    def executemany(self, sql: str, seq: Iterable[tuple], note: str = "") -> int:
        started = time.time()
        conn = self._connect(self.cfg.db_name)
        try:
            with conn.cursor() as cur:
                affected = cur.executemany(sql, list(seq))
            self._log(sql, f"<{affected} rows>", affected, (time.time() - started) * 1000, note)
            return affected
        finally:
            conn.close()

    # ------------------------------------------------------------------ 建库
    def init_schema(self) -> Dict[str, Any]:
        conn = self._connect(None)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{self.cfg.db_name}` "
                    "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
                )
        finally:
            conn.close()
        self._log(f"CREATE DATABASE IF NOT EXISTS {self.cfg.db_name}", None, 1, 0.0, "init")

        caps = {"vector_index": False, "fulltext": False}
        # 向量索引：优先带 HNSW 建表，失败则退化为普通 VECTOR 列
        try:
            self.execute(DDL_EMBEDDING_VEC, database=self.cfg.db_name, note="ddl:embedding+hnsw")
            caps["vector_index"] = True
        except Exception as exc:  # noqa: BLE001
            self.execute(DDL_EMBEDDING_PLAIN, database=self.cfg.db_name, note="ddl:embedding")
            caps["vector_index_error"] = str(exc)[:200]

        self.execute(DDL_ARTIFACT, database=self.cfg.db_name, note="ddl:artifact")
        self.execute(DDL_RUN, database=self.cfg.db_name, note="ddl:ingest_run")

        # 全文索引：先看是否已存在（init-db 可重复执行，重复添加会报 Duplicate key name，
        # 不能把它当成"没有全文检索能力"）
        try:
            _, idx_rows = self.execute("SHOW INDEX FROM artifact", database=self.cfg.db_name,
                                       note="show:index")
            if any(r.get("Key_name") == "ft_artifact_content" for r in idx_rows):
                caps["fulltext"] = "existing"
        except Exception as exc:  # noqa: BLE001
            caps.setdefault("fulltext_errors", []).append(f"show index: {str(exc)[:120]}")

        # 中文需要 ngram 分词，失败则尝试默认分词，再失败则放弃
        for ddl, label in (
            ("ALTER TABLE artifact ADD FULLTEXT INDEX ft_artifact_content (content) WITH PARSER ngram", "ngram"),
            ("ALTER TABLE artifact ADD FULLTEXT INDEX ft_artifact_content (content)", "default"),
        ):
            if caps.get("fulltext"):
                break
            try:
                self.execute(ddl, database=self.cfg.db_name, note=f"ddl:fulltext:{label}")
                caps["fulltext"] = label
                break
            except Exception as exc:  # noqa: BLE001
                caps.setdefault("fulltext_errors", []).append(f"{label}: {str(exc)[:120]}")
        return caps

    # ------------------------------------------------------------------ 写入
    def replace_artifacts(self, items: List[Dict[str, Any]], embeddings: Dict[str, List[float]],
                          model: str) -> None:
        if not items:
            return
        self.executemany(
            "REPLACE INTO artifact (artifact_id, kind, path, symbol, start_line, end_line, "
            "title, content, tags, refs, revision, ingested_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [
                (
                    it["artifact_id"], it["kind"], it["path"], it.get("symbol", ""),
                    it.get("start_line", 0), it.get("end_line", 0), it.get("title", ""),
                    it.get("content", ""), it.get("tags", ""), it.get("refs", ""),
                    it["revision"], _now(),
                )
                for it in items
            ],
            note="upsert:artifact",
        )
        emb_rows = []
        for it in items:
            vec = embeddings.get(it["artifact_id"])
            if vec is None:
                continue
            emb_rows.append((it["artifact_id"], model, len(vec), vec_literal(vec)))
        if emb_rows:
            self.executemany(
                "REPLACE INTO embedding (artifact_id, model, dim, vec) VALUES (%s,%s,%s,%s)",
                emb_rows,
                note="upsert:embedding",
            )

    def delete_missing(self, keep_ids: Iterable[str]) -> int:
        keep = list(keep_ids)
        if not keep:
            affected, _ = self.execute("DELETE FROM artifact", database=self.cfg.db_name, note="prune:all")
            self.execute("DELETE FROM embedding", database=self.cfg.db_name, note="prune:all")
            return affected
        placeholders = ",".join(["%s"] * len(keep))
        affected, _ = self.execute(
            f"DELETE FROM artifact WHERE artifact_id NOT IN ({placeholders})",
            keep, database=self.cfg.db_name, note="prune:artifact",
        )
        self.execute(
            f"DELETE FROM embedding WHERE artifact_id NOT IN ({placeholders})",
            keep, database=self.cfg.db_name, note="prune:embedding",
        )
        return affected

    def start_run(self, run_id: str) -> None:
        self.execute(
            "REPLACE INTO ingest_run (run_id, started_at, status) VALUES (%s,%s,'running')",
            (run_id, _now()), database=self.cfg.db_name, note="ingest:start",
        )

    def finish_run(self, run_id: str, spec_count: int, code_count: int, test_count: int,
                   note: str = "") -> None:
        self.execute(
            "UPDATE ingest_run SET finished_at=%s, spec_count=%s, code_count=%s, "
            "test_count=%s, status='done', note=%s WHERE run_id=%s",
            (_now(), spec_count, code_count, test_count, note, run_id),
            database=self.cfg.db_name, note="ingest:finish",
        )

    # ------------------------------------------------------------------ 检索
    def vector_search(self, query_vec: Sequence[float], top_k: int = 10,
                      kinds: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
        literal = vec_literal(query_vec)
        sql = (
            "SELECT a.artifact_id, a.kind, a.path, a.symbol, a.start_line, a.end_line, a.title, "
            "a.tags, a.revision, cosine_distance(e.vec, %s) AS distance "
            "FROM embedding e JOIN artifact a ON a.artifact_id = e.artifact_id "
        )
        params: List[Any] = [literal]
        if kinds:
            sql += "WHERE a.kind IN (" + ",".join(["%s"] * len(kinds)) + ") "
            params.extend(kinds)
        sql += "ORDER BY distance ASC LIMIT %s"
        params.append(top_k)
        _, rows = self.execute(sql, params, database=self.cfg.db_name, note="search:vector")
        for row in rows:
            row["vector_score"] = max(0.0, 1.0 - float(row.pop("distance")))
        return rows

    def fulltext_search(self, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        _, rows = self.execute(
            "SELECT artifact_id, kind, path, symbol, start_line, end_line, title, tags, revision, "
            "MATCH(content) AGAINST(%s) AS ft_score FROM artifact "
            "WHERE MATCH(content) AGAINST(%s) ORDER BY ft_score DESC LIMIT %s",
            (query, query, top_k), database=self.cfg.db_name, note="search:fulltext",
        )
        return rows

    def like_search(self, terms: Sequence[str], top_k: int = 10) -> List[Dict[str, Any]]:
        """全文索引不可用时的退化路径：按词做 LIKE 召回。"""
        if not terms:
            return []
        clauses, params = [], []
        for term in terms[:6]:
            clauses.append("(content LIKE %s OR title LIKE %s OR path LIKE %s)")
            params.extend([f"%{term}%"] * 3)
        sql = (
            "SELECT artifact_id, kind, path, symbol, start_line, end_line, title, tags, revision "
            "FROM artifact WHERE " + " OR ".join(clauses) + " LIMIT %s"
        )
        params.append(top_k * 4)
        _, rows = self.execute(sql, params, database=self.cfg.db_name, note="search:like")
        return rows

    def get_artifacts(self, artifact_ids: Sequence[str]) -> List[Dict[str, Any]]:
        if not artifact_ids:
            return []
        ph = ",".join(["%s"] * len(artifact_ids))
        _, rows = self.execute(
            f"SELECT * FROM artifact WHERE artifact_id IN ({ph})",
            list(artifact_ids), database=self.cfg.db_name, note="get:artifacts",
        )
        return rows

    def artifacts_by_path(self, paths: Sequence[str]) -> List[Dict[str, Any]]:
        if not paths:
            return []
        ph = ",".join(["%s"] * len(paths))
        _, rows = self.execute(
            f"SELECT * FROM artifact WHERE path IN ({ph}) ORDER BY path, start_line",
            list(paths), database=self.cfg.db_name, note="get:by_path",
        )
        return rows

    def artifacts_by_kind(self, kind: str) -> List[Dict[str, Any]]:
        _, rows = self.execute(
            "SELECT * FROM artifact WHERE kind=%s ORDER BY path, start_line",
            (kind,), database=self.cfg.db_name, note=f"get:kind:{kind}",
        )
        return rows

    def stats(self) -> Dict[str, Any]:
        _, rows = self.execute(
            "SELECT kind, COUNT(*) AS n FROM artifact GROUP BY kind", database=self.cfg.db_name,
            note="stats:by_kind",
        )
        counts = {r["kind"]: r["n"] for r in rows}
        _, emb = self.execute("SELECT COUNT(*) AS n FROM embedding", database=self.cfg.db_name,
                              note="stats:embedding")
        _, runs = self.execute(
            "SELECT run_id, started_at, spec_count, code_count, test_count, status "
            "FROM ingest_run ORDER BY started_at DESC LIMIT 5",
            database=self.cfg.db_name, note="stats:runs",
        )
        return {
            "artifacts": counts,
            "total": sum(counts.values()),
            "embeddings": emb[0]["n"] if emb else 0,
            "recent_runs": runs,
        }


def _short_params(params: Any) -> Any:
    if params is None:
        return None
    if isinstance(params, (list, tuple)):
        out = []
        for p in params:
            if isinstance(p, str) and p.startswith("[") and len(p) > 60:
                out.append(p[:60] + "...")
            else:
                out.append(p)
        return out
    if isinstance(params, str) and len(params) > 200:
        return params[:200] + "..."
    return params
