"""单变体评测调试：打印页面日志面板内容。"""
import asyncio
import sys
import time

from playwright.async_api import async_playwright

KEY = sys.argv[1] if len(sys.argv) > 1 else "fp32"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True,
                                         args=["--enable-unsafe-webgpu"])
        page = await browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("pageerror", lambda e: print("[pageerror]", e))
        page.on("crash", lambda: print("[PAGE CRASHED]"))
        suffix = "&forceWasm=1" if KEY != "fp16" else ""
        await page.goto(f"http://127.0.0.1:8787/?autorun=eval&variant={KEY}{suffix}", wait_until="domcontentloaded")
        t0 = time.time()
        last = ""
        while time.time() - t0 < 420:
            try:
                log_txt = await page.inner_text("#log")
                lines = [l for l in log_txt.splitlines() if l != last]
                for l in lines:
                    print("  page:", l)
                if lines:
                    last = log_txt.splitlines()[-1]
            except Exception as e:
                print("poll err", e)
                break
            if await page.evaluate("!!window.__evalResult"):
                r = await page.evaluate("window.__evalResult")
                print("RESULT:", r)
                break
            await page.wait_for_timeout(3000)
        await browser.close()


asyncio.run(main())
