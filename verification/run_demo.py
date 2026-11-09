#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""记仇客栈 · 验证样例执行脚本（可重复运行）

按赛题要求把"初始状态 → 输入 → 预期 → 实际结果"跑一遍：
  0. 复位客官「张三」，使其回到初始状态（信誉 50 / 无账本）
  1. 会话 A：砍价 → 落一条账
  2. 会话 A：赖账 → 再落一条账，信誉下降
  3. 会话 B（全新会话，同一个名号）：进店 → 应主动翻旧账
每一步都会打印 seekdb 里的账本实况，便于核对。

用法：
  DIFY_BASE=http://192.168.192.128 \
  DIFY_APP_KEY=app-xxx \
  BRIDGE=http://192.168.192.128:5000 \
  python verification/run_demo.py [--player 张三]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DIFY = os.environ.get("DIFY_BASE", "http://192.168.192.128")
APP_KEY = os.environ.get("DIFY_APP_KEY", "")
BRIDGE = os.environ.get("BRIDGE", "http://192.168.192.128:5000")


def http(method, url, payload=None, headers=None):
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def chat(query, player, user, conversation_id=""):
    status, body = http(
        "POST",
        DIFY + "/v1/chat-messages",
        {"inputs": {"player_name": player}, "query": query, "response_mode": "blocking",
         "conversation_id": conversation_id, "user": user},
        {"Authorization": "Bearer " + APP_KEY},
    )
    if status != 200:
        raise SystemExit(f"调用失败 {status}: {body[:400]}")
    return json.loads(body)


def ledger(player):
    status, body = http("GET", f"{BRIDGE}/v1/ledger?player={urllib.parse.quote(player)}")
    return json.loads(body) if status == 200 else {"rows": [], "profile": None}


def show(title, data):
    print("\n" + "=" * 66)
    print(title)
    print("-" * 66)
    print(json.dumps(data, ensure_ascii=False, indent=1)[:1600])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--player", default="张三")
    args = ap.parse_args()
    player = args.player

    if not APP_KEY:
        raise SystemExit("需要设置 DIFY_APP_KEY（Dify 应用「API 访问」里生成）")

    print(f"[0] 复位 {player}")
    print(http("POST", BRIDGE + "/v1/reset", {"player": player})[1])
    show("初始状态（seekdb）", ledger(player))

    print(f"\n[1] 会话 A 第 1 句：砍价")
    a1 = chat("来只醉鸡。四十八文？二十文，不然我走了。", player, "verify-a")
    print("三娘：" + a1["answer"])
    show("落账后（seekdb）", ledger(player))

    print(f"\n[2] 会话 A 第 2 句：赖账")
    a2 = chat("先记着账，我姓柳。", player, "verify-a", a1["conversation_id"])
    print("三娘：" + a2["answer"])
    show("落账后（seekdb）", ledger(player))

    print(f"\n[3] 会话 B（全新会话，同名号）第 1 句：进店")
    b1 = chat("今天还开张吗？", player, "verify-b")
    print("三娘：" + b1["answer"])
    show("会话 B 开局时 seekdb 已经把旧账交给模型", ledger(player))

    print("\n" + "=" * 66)
    print("判定要点：会话 B 的回答应出现前面账本里的原话（quote 字段），"
          "且信誉分低于初始值 50。")


if __name__ == "__main__":
    main()
