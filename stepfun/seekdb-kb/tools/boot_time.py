"""模型加载计时：冷启动（全新上下文，需完整下载模型）vs 热加载（缓存命中 + 页面刷新）。

    python tools/boot_time.py [--headless]
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
HEADLESS = "--headless" in sys.argv


async def timed_boot(browser, tag):
    ctx = await browser.new_context()
    page = await ctx.new_page()
    t0 = time.time()
    await page.goto("http://127.0.0.1:8787/", wait_until="domcontentloaded")
    await page.wait_for_function("window.__modelReady === true", timeout=600_000)
    ms = (time.time() - t0) * 1000
    backend = await page.inner_text("#badgeBackend")
    print(f"{tag}: {ms:.0f} ms  ({backend})")
    await ctx.close()
    return {"tag": tag, "ms": round(ms), "backend": backend}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=HEADLESS,
                                         args=["--enable-unsafe-webgpu"])
        out = []
        out.append(await timed_boot(browser, "cold-1"))   # 全新上下文：模型需完整传输
        out.append(await timed_boot(browser, "cold-2"))   # 全新上下文但 HTTP 缓存目录相同？——
        # 热加载：同一上下文内 reload，命中内存/磁盘缓存
        ctx = await browser.new_context()
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:8787/", wait_until="domcontentloaded")
        await page.wait_for_function("window.__modelReady === true", timeout=600_000)
        t0 = time.time()
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_function("window.__modelReady === true", timeout=600_000)
        warm = (time.time() - t0) * 1000
        print(f"warm-reload: {warm:.0f} ms")
        out.append({"tag": "warm-reload", "ms": round(warm), "backend": await page.inner_text("#badgeBackend")})
        await ctx.close()
        await browser.close()
        (ROOT / "evidence" / "boot-time.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


asyncio.run(main())
