"""PowerContext HTTP 客户端（只依赖标准库）。

PowerContext 1.5.1 的最小 Server（SQLite 后端、无需模型 API）即可满足本题：
用 Memory 保存任务进展，用 Source 保存测试日志等证据，重启模块后再检索读回。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import Config


class PowerContextError(RuntimeError):
    pass


class PowerContext:
    def __init__(self, cfg: Config, log_path: Optional[str] = None) -> None:
        self.cfg = cfg
        self.base = cfg.powercontext_url
        self.log_path = log_path or os.path.join(cfg.records_dir, "powercontext_log.jsonl")
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)
        self.scope_id = cfg.powercontext_scope_id

    # ------------------------------------------------------------------ HTTP
    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base}{path}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.cfg.powercontext_token:
            headers["Authorization"] = f"Bearer {self.cfg.powercontext_token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:600]
            self._log(method, path, body, exc.code, detail, time.time() - started)
            raise PowerContextError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            self._log(method, path, body, -1, str(exc), time.time() - started)
            raise PowerContextError(
                f"无法连接 PowerContext ({self.base})，请先启动：powercontext server run"
            ) from exc
        self._log(method, path, body, 200, "", time.time() - started)
        return payload

    def _log(self, method: str, path: str, body: Any, status: int, error: str,
             elapsed: float) -> None:
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "method": method,
            "path": path,
            "status": status,
            "elapsed_ms": round(elapsed * 1000, 1),
            "request_preview": _preview(body),
            "error": error,
        }
        with open(self.log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------------ Scope
    def list_scopes(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/scopes").get("items", [])

    def ensure_scope(self, title: str, summary: str) -> str:
        """优先用配置的 Scope；否则复用同名 Scope；都没有则创建。"""
        if self.scope_id:
            return self.scope_id
        for scope in self.list_scopes():
            if scope.get("title") == title:
                self.scope_id = scope["scope_id"]
                return self.scope_id
        created = self._request("POST", "/v1/scopes", {
            "title": title,
            "summary": summary,
            "idempotency_key": f"scope-{abs(hash(title)) % 10**8}",
        })
        self.scope_id = created["scope_id"]
        return self.scope_id

    # ------------------------------------------------------------------ 写入
    def remember(self, kind: str, text: str, description: Optional[str] = None) -> Dict[str, Any]:
        if not self.scope_id:
            raise PowerContextError("scope_id 未初始化，先调用 ensure_scope()")
        body: Dict[str, Any] = {"scope_id": self.scope_id, "kind": kind, "text": text}
        if description:
            body["description"] = description
        return self._request("POST", "/v1/memory/remember", body)

    def capture_source(self, source_id: str, content: str,
                       metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.scope_id:
            raise PowerContextError("scope_id 未初始化，先调用 ensure_scope()")
        return self._request("POST", "/v1/sources/content", {
            "scope_id": self.scope_id,
            "source_id": source_id,
            "content": content[:190000],
            "metadata": metadata or {},
        })

    def search(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        if not self.scope_id:
            raise PowerContextError("scope_id 未初始化，先调用 ensure_scope()")
        payload = self._request("POST", "/v1/memory/search", {
            "scope_id": self.scope_id, "query": query, "limit": limit,
        })
        return payload.get("hits", [])

    def capability(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/capabilities")


def _preview(body: Any) -> Any:
    if body is None:
        return None
    text = json.dumps(body, ensure_ascii=False)
    if len(text) <= 300:
        return body
    return {"_truncated": True, "preview": text[:300], "length": len(text)}
