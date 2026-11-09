"""浏览器端探测：WebGPU 可用性 + 页面加载状态。"""
import asyncio
import sys
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8787"
HEADLESS = "--headless" not in sys.argv


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=HEADLESS,
                                         args=["--enable-unsafe-webgpu", "--enable-features=Vulkan"])
        page = await browser.new_page(viewport={"width": 1600, "height": 1000})
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        await page.goto(URL, wait_until="domcontentloaded")
        gpu = await page.evaluate("""async () => {
          if (!('gpu' in navigator)) return {gpu:false};
          const a = await navigator.gpu.requestAdapter();
          return {gpu:true, adapter:!!a, f16: !!(a && a.features && a.features.has('shader-f16')),
                  vendor: a ? (a.info && a.info.vendor) : null, isolated: self.crossOriginIsolated};
        }""")
        print("GPU:", gpu)
        # 等模型加载完成
        for _ in range(120):
            txt = await page.inner_text("#badgeBackend")
            if "WebGPU" in txt or "WASM" in txt:
                break
            await page.wait_for_timeout(1000)
        print("backend badge:", await page.inner_text("#badgeBackend"))
        print("seekdb badge:", await page.inner_text("#badgeSeekdb"))
        print("model badge:", await page.inner_text("#badgeModel"))
        print("--- console ---")
        for l in logs[-40:]:
            print(l)
        await page.screenshot(path="tmp/shot_boot.png", full_page=False)
        await browser.close()


asyncio.run(main())
