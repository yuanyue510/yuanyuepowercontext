"""
复现 INT8 量化：对 FP32 ONNX 模型做动态 INT8 量化（per-channel, reduce_range）。

与 Xenova 发布的 model_quantized.onnx 采用同一 optimum/onnxruntime 量化配置
（见仓库内 quantize_config.json：per_channel=true, reduce_range=true, weight_type=QInt8），
用于验证「量化方式」可复现。

用法：
    pip install onnxruntime onnx
    python scripts/quantize_int8.py public/models/bge-small-zh-v1.5/onnx/model.onnx \
        --out public/models/bge-small-zh-v1.5/onnx/model_quantized_local.onnx
"""
import argparse
from pathlib import Path

from onnxruntime.quantization import quantize_dynamic, QuantType


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="FP32 ONNX 文件路径")
    ap.add_argument("--out", default=None, help="输出路径（默认 <src目录>/model_quantized_local.onnx）")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out) if args.out else src.with_name("model_quantized_local.onnx")
    print(f"[quantize] {src} ({src.stat().st_size/1048576:.1f} MB)")
    quantize_dynamic(
        model_input=str(src),
        model_output=str(out),
        per_channel=True,
        reduce_range=True,
        weight_type=QuantType.QInt8,
    )
    print(f"[quantize] -> {out} ({out.stat().st_size/1048576:.1f} MB)")
    print(f"[quantize] 压缩比 {src.stat().st_size/out.stat().st_size:.2f}x")


if __name__ == "__main__":
    main()
