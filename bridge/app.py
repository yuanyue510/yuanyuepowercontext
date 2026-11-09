#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""记仇客栈 · seekdb / PowerContext 桥接服务

Dify 的 HTTP Request 节点调用本服务的 /v1/context 与 /v1/settle：
  - /v1/context  读取客官档案、翻账本、按话头检索客栈设定，可选召回 PowerContext 记忆
  - /v1/settle   把 LLM 判定出的本次事件写进 seekdb 账本，并同步一条记忆
seekdb 承担结构化数据与检索，PowerContext 承担跨会话记忆（未配置时自动降级）。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

import pymysql
from flask import Flask, jsonify, request

# ---------------------------------------------------------------- 配置
DB = dict(
    host=os.getenv("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.getenv("SEEKDB_PORT", "2881")),
    user=os.getenv("SEEKDB_USER", "root"),
    password=os.getenv("SEEKDB_PASSWORD", ""),
    database=os.getenv("SEEKDB_DATABASE", "tavern"),
    charset="utf8mb4",
    autocommit=True,
    connect_timeout=5,
    cursorclass=pymysql.cursors.DictCursor,
)

PC_URL = os.getenv("POWERCONTEXT_URL", "").rstrip("/")
PC_TOKEN = os.getenv("POWERCONTEXT_TOKEN", "")
PC_SCOPE = os.getenv("POWERCONTEXT_SCOPE", "")
PC_TIMEOUT = float(os.getenv("POWERCONTEXT_TIMEOUT", "1.5"))

GOOD_KINDS = {"请客", "还钱", "帮忙", "打赏"}
DEBT_KINDS = {"赖账", "顺手牵羊"}
BAD_KINDS = {"赖账", "顺手牵羊", "挑衅", "吹牛", "砍价"}

NAME_RE = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9_\-]{1,24}$")

app = Flask(__name__)


# ---------------------------------------------------------------- seekdb
def db():
    return pymysql.connect(**DB)


def db_ping() -> str:
    try:
        with db() as c, c.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return "up"
    except Exception as exc:  # noqa: BLE001
        return f"down: {exc.__class__.__name__}"


# ---------------------------------------------------------------- PowerContext
def pc_call(method: str, path: str, payload: dict | None = None) -> dict | None:
    """静默调用 PowerContext；不可用时返回 None，绝不阻断玩法。"""
    if not PC_URL:
        return None
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    req = urllib.request.Request(PC_URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if PC_TOKEN:
        req.add_header("Authorization", "Bearer " + PC_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=PC_TIMEOUT) as resp:
            body = resp.read().decode("utf-8") or "{}"
            return json.loads(body)
    except Exception:  # noqa: BLE001
        return None


def pc_scope() -> str:
    global PC_SCOPE
    if PC_SCOPE:
        return PC_SCOPE
    listed = pc_call("GET", "/v1/scopes")
    if listed:
        items = listed.get("items") or listed.get("scopes") or []
        for it in items:
            if it.get("title") == "记仇客栈":
                PC_SCOPE = it.get("scope_id") or it.get("id")
                return PC_SCOPE
    created = pc_call("POST", "/v1/scopes", {"title": "记仇客栈"})
    if created:
        PC_SCOPE = created.get("scope_id") or created.get("id") or ""
    return PC_SCOPE


def pc_remember(text: str) -> bool:
    scope = pc_scope()
    if not scope:
        return False
    body = {
        "family": "atomic-memory",
        "content": {
            "schema": "powercontext.atomic-memory.v1",
            "kind": "tavern-event",
            "text": text[:8000],
        },
    }
    return pc_call("POST", f"/v1/scopes/{scope}/artifacts", body) is not None


def pc_recall(query: str, limit: int = 3) -> list[str]:
    scope = pc_scope()
    if not scope:
        return []
    res = pc_call(
        "POST",
        "/v1/atomic-memory/search",
        {"scope_id": scope, "query": query, "mode": "text", "limit": limit},
    )
    out: list[str] = []
    if not res:
        return out
    for hit in res.get("hits", [])[:limit]:
        try:
            out.append(hit["memory"]["content"]["text"])
        except Exception:  # noqa: BLE001
            continue
    return out


# ---------------------------------------------------------------- 业务规则
def tone_of(rep: int, bounty: int) -> str:
    if bounty >= 3:
        return "通缉在身，三娘准备喊阿七了"
    if rep >= 80:
        return "座上宾，会送一碟小菜"
    if rep >= 60:
        return "熟客，可以赊一碗汤"
    if rep >= 40:
        return "生客，先付后吃"
    if rep >= 20:
        return "刺头，说话带刺，先收钱"
    return "黑名单，随时可能被赶出门"


def price_of(base: int, rep: int) -> int:
    """信誉越低，价格越贵：50 分按原价，0 分 1.75 倍，100 分 2.5 折（0.25 倍）。"""
    factor = 1 + (50 - rep) / 100 * 1.5
    return max(1, int(round(base * factor)))


def clamp(v, lo, hi, default=None):
    try:
        return max(lo, min(hi, int(v)))
    except Exception:  # noqa: BLE001
        return lo if default is None else default


def clean_name(raw: str | None) -> str:
    name = (raw or "").strip()
    return name if NAME_RE.match(name) else "无名客"


def ensure_player(cur, player: str) -> dict:
    cur.execute("SELECT * FROM players WHERE player=%s", (player,))
    row = cur.fetchone()
    if row:
        return row
    cur.execute("INSERT INTO players (player) VALUES (%s)", (player,))
    cur.execute("SELECT * FROM players WHERE player=%s", (player,))
    return cur.fetchone()


def search_lore(cur, q: str, limit: int = 4) -> list[dict]:
    """按玩家话头检索设定：先命中标题/标签，再退化为整句关键词。"""
    q = (q or "").strip()
    hits: list[dict] = []
    seen: set[int] = set()
    if q:
        tokens = [t for t in re.split(r"[\s，。！？、,.!?~]+", q) if len(t) >= 2][:6]
        for tok in tokens:
            cur.execute(
                "SELECT id, category, title, content FROM lore "
                "WHERE tags LIKE %s OR title LIKE %s LIMIT %s",
                (f"%{tok}%", f"%{tok}%", limit),
            )
            for row in cur.fetchall():
                if row["id"] not in seen:
                    seen.add(row["id"])
                    hits.append(row)
            if len(hits) >= limit:
                break
    if len(hits) < 2:
        cur.execute(
            "SELECT id, category, title, content FROM lore WHERE category='规矩' ORDER BY id LIMIT %s",
            (limit - len(hits),),
        )
        for row in cur.fetchall():
            if row["id"] not in seen:
                seen.add(row["id"])
                hits.append(row)
    return hits[:limit]


# ---------------------------------------------------------------- 路由
@app.get("/health")
def health():
    pc = "disabled"
    if PC_URL:
        pc = "up" if pc_call("GET", "/health/live") is not None else "down"
    return jsonify(ok=db_ping() == "up", seekdb=db_ping(), powercontext=pc)


@app.route("/v1/context", methods=["GET", "POST"])
def context():
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        player_raw = payload.get("player")
        query = str(payload.get("q", ""))[:200]
    else:
        player_raw = request.args.get("player")
        query = request.args.get("q", "")[:200]
    player = clean_name(player_raw)

    with db() as c, c.cursor() as cur:
        profile = ensure_player(cur, player)
        first_visit = profile["visits"] == 0
        last = profile["last_seen"]
        if last is None or datetime.now() - last > timedelta(minutes=20):
            cur.execute(
                "UPDATE players SET visits=visits+1, last_seen=NOW() WHERE player=%s", (player,)
            )
        else:
            cur.execute("UPDATE players SET last_seen=NOW() WHERE player=%s", (player,))

        cur.execute(
            "SELECT ts, kind, summary, quote, severity, amount FROM ledger "
            "WHERE player=%s ORDER BY ts DESC, id DESC LIMIT 8",
            (player,),
        )
        ledger = [
            {**r, "ts": r["ts"].strftime("%Y-%m-%d %H:%M") if r["ts"] else ""}
            for r in cur.fetchall()
        ]

        cur.execute(
            "SELECT ts, kind, summary, quote, severity FROM ledger "
            "WHERE player=%s ORDER BY severity DESC, ts DESC LIMIT 2",
            (player,),
        )
        grudges = [
            {**r, "ts": r["ts"].strftime("%Y-%m-%d %H:%M") if r["ts"] else ""}
            for r in cur.fetchall()
        ]

        lore = search_lore(cur, query)

        cur.execute("SELECT item, base_price, description FROM menu ORDER BY base_price DESC")
        menu = [
            {
                "item": r["item"],
                "price": price_of(r["base_price"], profile["reputation"]),
                "note": r["description"],
            }
            for r in cur.fetchall()
        ]

        cur.execute("SELECT COUNT(*) AS n FROM ledger")
        total_ledger = cur.fetchone()["n"]

    memory = pc_recall(f"{player} {query}".strip(), 3) if PC_URL else []

    return jsonify(
        player=player,
        first_visit=first_visit,
        visits=profile["visits"] + (1 if first_visit else 0),
        status={
            "reputation": profile["reputation"],
            "debt": profile["debt"],
            "bounty": profile["bounty"],
            "tone": tone_of(profile["reputation"], profile["bounty"]),
            "banished": profile["reputation"] < 20 or profile["bounty"] >= 3,
        },
        ledger=ledger,
        grudges=grudges,
        lore=lore,
        menu=menu,
        memory=memory,
        ledger_rows_in_db=total_ledger,
    )


@app.post("/v1/settle")
def settle():
    payload = request.get_json(silent=True) or {}
    player = clean_name(payload.get("player"))
    events = payload.get("events") or []
    if isinstance(events, str):
        try:
            events = json.loads(events)
        except Exception:  # noqa: BLE001
            events = []
    if not isinstance(events, list):
        events = []

    accepted: list[dict] = []
    with db() as c, c.cursor() as cur:
        profile = ensure_player(cur, player)
        rep, debt, bounty = profile["reputation"], profile["debt"], profile["bounty"]

        for raw in events[:6]:
            if not isinstance(raw, dict):
                continue
            kind = str(raw.get("kind", "")).strip()[:16] or "杂事"
            summary = str(raw.get("summary", "")).strip()[:250]
            quote = str(raw.get("quote", "")).strip()[:250]
            if not summary:
                continue
            sev = clamp(raw.get("severity"), 1, 5, 1)
            amount = clamp(raw.get("amount"), 0, 9999, 0)

            if kind in GOOD_KINDS:
                rep += sev * 3
            elif kind in BAD_KINDS:
                rep -= sev * 3
            if kind in DEBT_KINDS:
                debt += amount
            if kind == "还钱":
                debt = max(0, debt - max(amount, sev * 10))
            if kind == "顺手牵羊" and sev >= 4:
                bounty += 1
            if kind == "挑衅" and sev >= 5:
                bounty += 1

            rep = max(0, min(100, rep))
            bounty = max(0, min(5, bounty))
            cur.execute(
                "INSERT INTO ledger (player, kind, summary, quote, severity, amount) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (player, kind, summary, quote or summary, sev, amount),
            )
            accepted.append(dict(kind=kind, summary=summary, severity=sev, amount=amount))

        cur.execute(
            "UPDATE players SET reputation=%s, debt=%s, bounty=%s, last_seen=NOW() WHERE player=%s",
            (rep, debt, bounty, player),
        )

    mem_lines = []
    for e in accepted:
        mem_lines.append(
            f"[{datetime.now():%Y-%m-%d %H:%M}] {player} 在客栈「{e['kind']}」：{e['summary']}"
            f"（严重度 {e['severity']}，涉银 {e['amount']} 文）"
        )
    mem_ok = bool(mem_lines) and any(pc_remember(m) for m in mem_lines)

    return jsonify(
        ok=True,
        player=player,
        accepted=len(accepted),
        status={
            "reputation": rep,
            "debt": debt,
            "bounty": bounty,
            "tone": tone_of(rep, bounty),
            "banished": rep < 20 or bounty >= 3,
        },
        memory_written=mem_ok,
    )


@app.get("/v1/ledger")
def ledger():
    player = clean_name(request.args.get("player"))
    with db() as c, c.cursor() as cur:
        cur.execute(
            "SELECT id, player, ts, kind, summary, quote, severity, amount FROM ledger "
            "WHERE player=%s ORDER BY id",
            (player,),
        )
        rows = [
            {**r, "ts": r["ts"].strftime("%Y-%m-%d %H:%M:%S") if r["ts"] else ""}
            for r in cur.fetchall()
        ]
        cur.execute("SELECT * FROM players WHERE player=%s", (player,))
        prof = cur.fetchone()
        if prof and prof.get("last_seen"):
            prof["last_seen"] = prof["last_seen"].strftime("%Y-%m-%d %H:%M:%S")
    return jsonify(player=player, profile=prof, rows=rows, count=len(rows))


@app.post("/v1/reset")
def reset():
    player = clean_name((request.get_json(silent=True) or {}).get("player"))
    with db() as c, c.cursor() as cur:
        cur.execute("DELETE FROM ledger WHERE player=%s", (player,))
        cur.execute("DELETE FROM players WHERE player=%s", (player,))
    return jsonify(ok=True, player=player, reset=True)


@app.get("/v1/stats")
def stats():
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM ledger")
        n_ledger = cur.fetchone()["n"]
        cur.execute("SELECT COUNT(*) AS n FROM players")
        n_players = cur.fetchone()["n"]
        cur.execute("SELECT COUNT(*) AS n FROM lore")
        n_lore = cur.fetchone()["n"]
        cur.execute("SELECT COUNT(*) AS n FROM menu")
        n_menu = cur.fetchone()["n"]
        cur.execute("SELECT VERSION() AS v")
        ver = cur.fetchone()["v"]
    return jsonify(
        seekdb_version=ver,
        ledger=n_ledger,
        players=n_players,
        lore=n_lore,
        menu=n_menu,
        epoch=int(time.time()),
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
