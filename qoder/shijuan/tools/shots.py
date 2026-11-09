"""生成 README / 项目网站用的界面截图（开发辅助工具，不参与功能验收）。

用法：
    python tools/shots.py           # 默认对着 http://127.0.0.1:8790
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8790")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "evidence", "shots")
os.makedirs(OUT, exist_ok=True)


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def seed_memory():
    """给 demo 学习者造出几条真实记忆，截图里的数字都来自实际接口返回。"""
    post("/api/ask", {"collection": "期末复习", "query": "Linux 的 epoll 和 select 有什么区别", "learner": "demo"})
    post("/api/ask", {"collection": "期末复习", "query": "React 的 useEffect 依赖数组怎么写", "learner": "demo"})
    post(
        "/api/memory/weak",
        {
            "learner": "demo",
            "collection": "期末复习",
            "question": "Linux 的 epoll 和 select 有什么区别",
            "evidence": "",
            "score": 0.58,
            "miss": 1,
        },
    )
    post("/api/ask", {"collection": "期末复习", "query": "缺页中断的处理流程是什么", "learner": "demo"})


def content_height(page, selector, pad=28, limit=2400):
    """按最后一张卡片的底部裁剪，避免截图下方大片空白。"""
    bottom = page.evaluate(
        "(sel) => { const el = document.querySelector(sel); if (!el) return null;"
        " return Math.ceil(el.getBoundingClientRect().bottom + window.scrollY); }",
        selector,
    )
    return min(int(bottom or 900) + pad, limit)


def shoot(page, name, selector):
    page.screenshot(
        path=os.path.join(OUT, name),
        full_page=True,
        clip={"x": 0, "y": 0, "width": 1440, "height": content_height(page, selector)},
    )
    print("  →", name)


def main():
    seed_memory()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 1024}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(BASE, wait_until="networkidle")

        # 1. 提问：混合检索 + 抽取式答案
        page.fill("#q", "缺页中断的处理流程是什么")
        page.click("#ask-form .primary")
        page.wait_for_selector("#answer-box:not(.hidden)", timeout=30000)
        page.wait_for_timeout(600)
        shoot(page, "01-ask.png", "#hits")

        # 2. 展开片段，证明答案可追溯到原文
        page.click("#hits details:nth-child(2) summary")
        page.wait_for_timeout(400)
        shoot(page, "02-source.png", "#hits")

        # 3. 复习清单：跨会话仍在的薄弱点
        page.click('.tab[data-tab="memory"]')
        page.wait_for_timeout(800)
        shoot(page, "03-memory.png", ".mem-foot")

        # 4. 资料集与索引
        page.click('.tab[data-tab="docs"]')
        page.wait_for_timeout(500)
        shoot(page, "04-collections.png", "#chunk-table")

        browser.close()
    print("截图已输出到", OUT)


if __name__ == "__main__":
    sys.exit(main())
