"""端到端验收脚本：加载页面 → 导入语料 → 检索 → 截图。

用法：
    python tools/e2e.py                # 有头 Chrome（WebGPU 走真实 GPU）
    python tools/e2e.py --headless     # 无头
    python tools/e2e.py --force-wasm   # 走 ?forceWasm=1，验证降级路径
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = "http://127.0.0.1:8787/"
HEADLESS = "--headless" in sys.argv
FORCE_WASM = "--force-wasm" in sys.argv
TAG = "wasm" if FORCE_WASM else "gpu"
OUT = ROOT / "evidence" / "shots"
OUT.mkdir(parents=True, exist_ok=True)
DEMO = sorted(str(p) for p in (ROOT / "data" / "demo").glob("*.md"))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=HEADLESS,
                                         args=["--enable-unsafe-webgpu"])
        page = await browser.new_page(viewport={"width": 1600, "height": 1000})
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))

        url = URL + ("?forceWasm=1" if FORCE_WASM else "")
        await page.goto(url, wait_until="domcontentloaded")

        t0 = time.time()
        await page.wait_for_function("window.__modelReady === true", timeout=300_000)
        backend = await page.inner_text("#badgeBackend")
        print(f"[1] 模型就绪 {time.time()-t0:.1f}s  backend={backend}")

        # 新集合
        await page.evaluate("""async () => {
          const r = await fetch('/api/collections');
          const j = await r.json();
          for (const c of j.collections) await fetch('/api/collections/' + c.name, {method:'DELETE'});
        }""")
        await page.click("#btnRefreshList")
        await page.wait_for_timeout(500)
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept("policy")))
        await page.click("#btnNewKb")
        await page.wait_for_timeout(1200)
        print("[2] 已建集合")

        # 导入
        await page.set_input_files("#fileInput", DEMO)
        await page.wait_for_function("document.querySelector('#importLog').textContent.includes('本次导入')", timeout=300_000)
        print("[3] 导入完成:\n" + await page.inner_text("#importLog"))
        await page.screenshot(path=str(OUT / f"01-after-ingest-{TAG}.png"))

        # 检索
        for q in ["退款多久能到账", "发票怎么下载", "接口返回 429 怎么办", "会员自动续费怎么关"]:
            await page.fill("#q", q)
            await page.click("#btnSearch")
            await page.wait_for_timeout(300)
            await page.wait_for_function("document.querySelectorAll('#results .result').length > 0", timeout=120_000)
            meta = await page.inner_text("#searchMeta")
            top = await page.evaluate("""() => Array.from(document.querySelectorAll('#results .result')).slice(0,2).map(n => ({
                src: n.querySelector('.src').textContent, score: n.querySelector('.score').textContent,
                text: n.querySelector('.snippet').textContent.slice(0,60)}))""")
            print(f"[4] 「{q}」 {meta}\n    {json.dumps(top, ensure_ascii=False)}")
            await page.wait_for_timeout(300)

        await page.screenshot(path=str(OUT / f"02-search-{TAG}.png"))
        await page.click("#tabs button[data-tab='diag']")
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(OUT / f"03-diag-{TAG}.png"))
        await page.click("#tabs button[data-tab='data']")
        await page.wait_for_timeout(600)
        await page.screenshot(path=str(OUT / f"04-data-{TAG}.png"))

        diag = await page.evaluate("""() => ({
          backend: document.querySelector('#badgeBackend').textContent,
          timing: document.querySelector('#timingTable').innerText,
          sizes: document.querySelector('#sizeTable').innerText,
          collections: document.querySelector('#kbList').innerText
        })""")
        print("[5] 诊断:\n" + json.dumps(diag, ensure_ascii=False, indent=1))

        errs = [l for l in logs if l.startswith("[pageerror]")]
        print(f"[6] pageerror {len(errs)} 条; 控制台 {len(logs)} 条")
        for e in errs[:6]:
            print("   ", e)
        await browser.close()


asyncio.run(main())
