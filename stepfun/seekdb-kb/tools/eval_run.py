"""质量评测：每个精度变体在独立浏览器实例中运行，避免多模型同时驻留导致崩溃。

    python tools/eval_run.py [--headless]

输出 evidence/eval-result.json：FP32 / FP16 / INT8 的 Recall@5、nDCG@10、MRR 与检索延迟。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "evidence"
HEADLESS = "--headless" in sys.argv


async def run_variant(p, key, force_wasm):
    browser = await p.chromium.launch(channel="chrome", headless=HEADLESS,
                                     args=["--enable-unsafe-webgpu"])
    page = await browser.new_page(viewport={"width": 1500, "height": 900})
    page.on("pageerror", lambda e: print(f"  [{key}] pageerror: {e}"))
    suffix = "&forceWasm=1" if force_wasm else ""
    await page.goto(f"http://127.0.0.1:8787/?autorun=eval&variant={key}{suffix}", wait_until="domcontentloaded")
    t0 = time.time()
    await page.wait_for_function("!!window.__evalResult", timeout=900_000)
    r = await page.evaluate("window.__evalResult")
    print(f"  [{key}] {time.time()-t0:.0f}s -> {json.dumps(r['results'], ensure_ascii=False)}")
    await page.wait_for_timeout(400)
    # 切到「评测」标签页再截图，确保结果表格入镜
    await page.click('button[data-tab="eval"]')
    await page.wait_for_timeout(200)
    await page.screenshot(path=str(OUT / "shots" / f"05-eval-{key}.png"))
    await browser.close()
    return r["results"]


async def main():
    plan = [("fp32", True), ("q8", True), ("fp16", False)]
    all_results = []
    async with async_playwright() as p:
        for key, fw in plan:
            try:
                all_results.extend(await run_variant(p, key, fw))
            except Exception as e:  # noqa: BLE001
                print(f"  [{key}] 失败: {e}")
    (OUT / "eval-result.json").write_text(
        json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "results": all_results}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    print("saved -> evidence/eval-result.json")


asyncio.run(main())
