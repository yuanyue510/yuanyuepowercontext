"""把截图内联进单文件网站：site/template.html + evidence/shots/*.png → site/index.html

单文件的好处是发布到任何静态托管都不会丢图片路径。
"""
import base64
import io
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "evidence", "shots")
OUT = os.path.join(ROOT, "site", "index.html")
REPO = os.environ.get(
    "REPO_URL",
    "https://github.com/yuanyue510/yuanyuepowercontext/tree/2026-competition-ecosystem/qoder/shijuan",
)

REPO_LINE = (
    f'<a href="{REPO}" target="_blank" rel="noopener">{REPO}</a>'
    '<br /><span style="font-size:12.5px;color:#7a7a73">完整源码、验证脚本、运行说明与开发记录都在这里</span>'
)


def data_uri(path, width=1280, quality=82):
    im = Image.open(path).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    print(f"{os.path.basename(path)}: {len(buf.getvalue()) // 1024} KB")
    return f"data:image/jpeg;base64,{b64}"


def main():
    with open(os.path.join(ROOT, "site", "template.html"), encoding="utf-8") as f:
        html = f.read()
    for i, name in enumerate(["01-ask.png", "02-source.png", "03-memory.png", "04-collections.png"], start=1):
        html = html.replace("{{IMG%d}}" % i, data_uri(os.path.join(SHOTS, name)))
    html = html.replace("{{REPO_LINE}}", REPO_LINE)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("已生成", OUT, f"{os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
