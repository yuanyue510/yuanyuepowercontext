"""运行时配置：全部来自环境变量，可选从 .env 文件加载（不覆盖已存在的环境变量）。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional


def load_env_file(path: Optional[str]) -> None:
    """极简 .env 解析：KEY=VALUE，忽略注释与空行，不覆盖已有环境变量。"""
    if not path:
        return
    p = Path(path)
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass
class Config:
    # --- seekdb / OceanBase（MySQL 协议）---
    db_host: str = "127.0.0.1"
    db_port: int = 2881
    db_user: str = "root"
    db_password: str = ""
    db_name: str = "sdd_context"

    # --- 向量化 ---
    embed_provider: str = "hash"          # hash | minimax
    embed_dim: int = 1024

    # --- MiniMax ---
    minimax_api_key: str = ""
    minimax_base_url: str = "https://api.minimax.chat"
    minimax_model: str = "MiniMax-M2"
    minimax_group_id: str = ""
    minimax_embed_model: str = "embo-01"

    # --- PowerContext ---
    powercontext_url: str = "http://127.0.0.1:8000"
    powercontext_scope_id: str = ""
    powercontext_token: str = ""

    # --- 记录目录 ---
    records_dir: str = field(default_factory=lambda: str(Path.cwd() / "records"))

    @classmethod
    def from_env(cls, env_file: Optional[str] = None) -> "Config":
        candidate = env_file or os.environ.get("SDD_ENV_FILE")
        if not candidate and os.path.isfile(".env"):
            candidate = ".env"
        load_env_file(candidate)
        g = os.environ.get
        cfg = cls(
            db_host=g("SDD_DB_HOST", cls.db_host),
            db_port=int(g("SDD_DB_PORT", str(cls.db_port))),
            db_user=g("SDD_DB_USER", cls.db_user),
            db_password=g("SDD_DB_PASSWORD", cls.db_password),
            db_name=g("SDD_DB_NAME", cls.db_name),
            embed_provider=g("SDD_EMBED_PROVIDER", cls.embed_provider).lower(),
            embed_dim=int(g("SDD_EMBED_DIM", str(cls.embed_dim))),
            minimax_api_key=g("MINIMAX_API_KEY", ""),
            minimax_base_url=g("MINIMAX_BASE_URL", cls.minimax_base_url).rstrip("/"),
            minimax_model=g("MINIMAX_MODEL", cls.minimax_model),
            minimax_group_id=g("MINIMAX_GROUP_ID", ""),
            minimax_embed_model=g("MINIMAX_EMBED_MODEL", cls.minimax_embed_model),
            powercontext_url=g("POWERCONTEXT_URL", cls.powercontext_url).rstrip("/"),
            powercontext_scope_id=g("POWERCONTEXT_SCOPE_ID", ""),
            powercontext_token=g("POWERCONTEXT_TOKEN", ""),
            records_dir=g("SDD_RECORDS_DIR", os.path.join(os.getcwd(), "records")),
        )
        return cfg

    def as_dict(self) -> Dict[str, object]:
        return {
            "db": f"{self.db_user}@{self.db_host}:{self.db_port}/{self.db_name}",
            "embed_provider": self.embed_provider,
            "embed_dim": self.embed_dim,
            "minimax_model": self.minimax_model,
            "minimax_key_present": bool(self.minimax_api_key),
            "powercontext_url": self.powercontext_url,
        }
