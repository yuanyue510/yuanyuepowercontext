"""性能基准：WebGPU 与 WASM 两种后端各跑一轮，输出 JSON。

    python tools/bench_run.py            # 两种后端都跑
    python tools/bench_run.py --headless
"""
import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "evidence"
HEADLESS = "--headless" in sys.argv


async def bench(p, force_wasm):
    browser = await p.chromium.launch(channel="chrome", headless=HEADLESS,
                                     args=["--enable-unsafe-webgpu"])
    page = await browser.new_page(viewport={"width": 1500, "height": 900})
    suffix = "&forceWasm=1" if force_wasm else ""
    await page.goto(f"http://127.0.0.1:8787/?autorun=bench{suffix}", wait_until="domcontentloaded")
    await page.wait_for_function("!!window.__benchResult", timeout=900_000)
    r = await page.evaluate("window.__benchResult")
    await browser.close()
    return r


async def main():
    async with async_playwright() as p:
        results = {}
        for tag, fw in (("webgpu", False), ("wasm", True)):
            try:
                results[tag] = await bench(p, fw)
                print(f"[{tag}] {json.dumps(results[tag], ensure_ascii=False)}")
            except Exception as e:  # noqa: BLE001
                print(f"[{tag}] 失败: {e}")
        OUT.mkdir(exist_ok=True)
        (OUT / "bench-result.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")


asyncio.run(main())
