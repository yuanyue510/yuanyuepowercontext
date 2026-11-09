#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最小 OpenAI 兼容 mock，用于没有模型 key 时验证 Dify 图能否跑通。

它不是真的语言模型：它会读 Dify 塞进 prompt 里的 context（seekdb 查出来的
账本 / 信誉 / 菜单）和玩家这句话，按几条固定规则拼出台词和 events。
目的是让 HTTP、Code、落库节点都被真实执行到，并且能演示"跨会话翻旧账"。
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

DEC = json.JSONDecoder()

K_BARGAIN = ("贵", "便宜", "打折", "少点", "几文", "砍", "二十", "太黑")
K_OWE = ("赊", "记着", "没带钱", "下次给", "先欠", "欠着", "回头给")
K_INSULT = ("骂", "滚", "难吃", "黑店", "骗子", "砸")
K_PAY = ("还钱", "还你", "给你钱", "结账", "清了")


def extract_ctx(text: str) -> dict:
    """从 prompt 里挖出 ctx.body 那段 JSON（带 status / grudges 的那个）。

    Dify 把 HTTP 节点的 body 以 JSON 文本塞进 system prompt，里面嵌套很多对象，
    所以不能从最近的 '{' 往前试，要按顶层锚点定位。
    """
    for anchor in ('{"first_visit"', '{"grudges"', '{"player"', '{"status"'):
        i = text.find(anchor)
        if i < 0:
            continue
        try:
            obj, _ = DEC.raw_decode(text[i:])
            if isinstance(obj, dict) and ("status" in obj or "grudges" in obj):
                return obj
        except Exception:  # noqa: BLE001
            pass
    idx = text.find('"status"')
    if idx < 0:
        return {}
    start = text.rfind("{", 0, idx)
    for _ in range(40):
        if start < 0:
            break
        try:
            obj, _ = DEC.raw_decode(text[start:])
            if isinstance(obj, dict) and "status" in obj:
                return obj
        except Exception:  # noqa: BLE001
            pass
        start = text.rfind("{", 0, start)
    return {}


def last_user(messages) -> str:
    for m in reversed(messages or []):
        if isinstance(m, dict) and m.get("role") == "user":
            return str(m.get("content") or "")
    return ""


def build(query: str, ctx: dict) -> dict:
    grudges = ctx.get("grudges") or []
    st = ctx.get("status") or {}
    debt = int(st.get("debt") or 0)
    rep = st.get("reputation")

    kind, sev, amt, line = None, 0, 0, ""
    if any(k in query for k in K_OWE):
        kind, sev, amt = "赖账", 4, 28
        line = "先记着？我姓柳——你姓柳？"
    elif any(k in query for k in K_INSULT):
        kind, sev, amt = "挑衅", 4, 0
        line = "碗放下。这话我不接第二遍。"
    elif any(k in query for k in K_PAY):
        kind, sev, amt = "还钱", 1, min(debt, 28) or 28
        line = "钱放桌上，我数一遍。"
    elif any(k in query for k in K_BARGAIN):
        kind, sev, amt = "砍价", 3, 0
        line = "四十八文的鸡，你出二十，还嫌我刀钝。"
    elif debt > 0:
        line = "站着说话不腰疼。"
    else:
        line = "坐吧。先付后吃。"

    parts = []
    if grudges:
        quote = str(grudges[0].get("quote") or "").strip()
        if quote:
            parts.append("「%s」——账上写着呢，客官。" % quote[:30])
    if debt > 0:
        parts.append("先清 %d 文，再谈别的。" % debt)
    elif rep is not None and int(rep) < 40:
        parts.append("我这儿的凳子，你坐得不太稳。")
    parts.append(line)
    reply = "".join(parts)[:140]

    events = []
    if kind:
        events.append({
            "kind": kind,
            "summary": (query[:40] or "在店里闹了一场"),
            "quote": line[:30],
            "severity": sev,
            "amount": amt,
        })
    return {"reply": reply, "events": events}


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({"object": "list", "data": [{"id": "mock-chat", "object": "model"}]})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw or b"{}")
        except Exception:  # noqa: BLE001
            req = {}

        messages = req.get("messages") or []
        blob = "\n".join(str(m.get("content") or "") for m in messages if isinstance(m, dict))
        try:
            with open("/app/last_prompt.txt", "w", encoding="utf-8") as fh:
                fh.write(blob)
        except Exception:  # noqa: BLE001
            pass
        ctx = extract_ctx(blob)
        content = json.dumps(build(last_user(messages), ctx), ensure_ascii=False)

        if "chat/completions" in self.path and req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            step = 60
            for i in range(0, len(content), step):
                chunk = {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "mock-chat",
                    "choices": [{"index": 0, "delta": {"content": content[i:i + step]},
                                 "finish_reason": None}],
                }
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
                self.wfile.flush()
            done = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-chat",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(("data: " + json.dumps(done, ensure_ascii=False) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        if "chat/completions" in self.path:
            self._send(
                {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion",
                    "model": "mock-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
                }
            )
        else:
            self._send({"ok": True})

    def log_message(self, fmt, *args):  # 安静一点
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8100), Handler).serve_forever()
