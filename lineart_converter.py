#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
LineArt Converter - 黑白线稿图转换工具
=====================================

将彩色/灰度图片转换为仅保留轮廓的黑白线稿图。
综合使用 XDoG（扩展高斯差分）、自适应阈值和 Canny 边缘检测三种算法融合，
并通过形态学操作和连通域分析进行线条清理，输出高质量纯黑白线稿。

依赖:
    pip install opencv-python numpy

基本用法:
    # 处理单个文件
    python lineart_converter.py -i input.png -o output.png

    # 批量处理文件夹
    python lineart_converter.py -i ./images -o ./lineart

    # 自定义参数
    python lineart_converter.py -i input.png -o output.png --scale 4 --sigma 1.5 --threshold 180

    # 使用预设风格
    python lineart_converter.py -i input.png -o output.png --style clean

编程接口:
    from lineart_converter import LineArtConverter

    converter = LineArtConverter(scale=4, style='clean')
    result = converter.convert('input.png')
    converter.save(result, 'output.png')

    # 批量处理
    converter.batch_convert('./images', './lineart')
"""

import argparse
import os
import sys
import glob
import time
from typing import Optional, Tuple, List

import cv2
import numpy as np


# ============================================================
#  预设风格参数
# ============================================================
STYLE_PRESETS = {
    'clean': {
        # 干净风格：线条清晰，噪点少
        'scale': 4,
        'sigma': 1.5,
        'k': 2.5,
        'epsilon': 0.005,
        'phi': 20,
        'bilateral_d': 11,
        'bilateral_sigma_color': 50,
        'bilateral_sigma_space': 50,
        'adaptive_block_size': 21,
        'adaptive_c': 8,
        'canny_lower_ratio': 0.5,
        'canny_upper_ratio': 1.5,
        'min_noise_area': 15,
        'final_threshold': 180,
    },
    'sketch': {
        # 素描风格：保留更多细节和纹理
        'scale': 4,
        'sigma': 1.0,
        'k': 2.0,
        'epsilon': 0.01,
        'phi': 15,
        'bilateral_d': 9,
        'bilateral_sigma_color': 40,
        'bilateral_sigma_space': 40,
        'adaptive_block_size': 15,
        'adaptive_c': 5,
        'canny_lower_ratio': 0.4,
        'canny_upper_ratio': 1.4,
        'min_noise_area': 8,
        'final_threshold': 160,
    },
    'bold': {
        # 粗线风格：线条更粗，适合小尺寸图片
        'scale': 4,
        'sigma': 2.0,
        'k': 3.0,
        'epsilon': 0.003,
        'phi': 25,
        'bilateral_d': 13,
        'bilateral_sigma_color': 60,
        'bilateral_sigma_space': 60,
        'adaptive_block_size': 25,
        'adaptive_c': 10,
        'canny_lower_ratio': 0.6,
        'canny_upper_ratio': 1.6,
        'min_noise_area': 20,
        'final_threshold': 200,
    },
    'minimal': {
        # 极简风格：只保留主要轮廓，去除细节
        'scale': 4,
        'sigma': 2.5,
        'k': 3.5,
        'epsilon': 0.002,
        'phi': 30,
        'bilateral_d': 15,
        'bilateral_sigma_color': 75,
        'bilateral_sigma_space': 75,
        'adaptive_block_size': 31,
        'adaptive_c': 12,
        'canny_lower_ratio': 0.7,
        'canny_upper_ratio': 1.7,
        'min_noise_area': 30,
        'final_threshold': 200,
    },
}

# 支持的图片格式
SUPPORTED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.tif'}


class LineArtConverter:
    """
    黑白线稿图转换器

    将彩色或灰度图片转换为纯黑白线稿图，仅保留轮廓线条。

    算法流程:
        1. 透明背景合成到白底
        2. 高倍放大（默认 4x）获取更多边缘细节
        3. 三种算法并行提取轮廓:
           - XDoG（扩展高斯差分）: 手绘风格线条
           - 自适应阈值: 区域轮廓
           - Canny 边缘检测: 精确边缘
        4. 融合三路结果（取最暗值，保留所有线条）
        5. 形态学清理 + 连通域去噪
        6. 高斯模糊 + 二值化输出纯黑白

    Attributes:
        scale: 放大倍数，越大线条越平滑但处理越慢
        style: 预设风格名称 ('clean', 'sketch', 'bold', 'minimal')
        params: 完整参数字典（覆盖 style 预设）
    """

    def __init__(
        self,
        scale: int = 4,
        style: str = 'clean',
        **kwargs
    ):
        """
        初始化转换器

        Args:
            scale: 放大倍数 (1-8)，默认 4
            style: 预设风格 ('clean'|'sketch'|'bold'|'minimal')，默认 'clean'
            **kwargs: 自定义参数，覆盖预设值。可用参数:
                sigma, k, epsilon, phi (XDoG 参数)
                bilateral_d, bilateral_sigma_color, bilateral_sigma_space (滤波参数)
                adaptive_block_size, adaptive_c (自适应阈值参数)
                canny_lower_ratio, canny_upper_ratio (Canny 参数)
                min_noise_area (去噪参数)
                final_threshold (最终二值化阈值)
        """
        if style not in STYLE_PRESETS:
            raise ValueError(
                f"未知风格 '{style}'，可选: {list(STYLE_PRESETS.keys())}"
            )
        if not (1 <= scale <= 8):
            raise ValueError("scale 必须在 1-8 之间")

        self.scale = scale
        self.style = style
        # 合并预设参数和自定义覆盖
        self.params = {**STYLE_PRESETS[style], **kwargs}
        self.params['scale'] = scale

    # --------------------------------------------------------
    #  核心算法
    # --------------------------------------------------------

    @staticmethod
    def _composite_on_white(img: np.ndarray) -> np.ndarray:
        """将透明背景图片合成到白色背景上"""
        if img.shape[2] == 4:
            alpha = img[:, :, 3:4].astype(np.float32) / 255.0
            bgr = img[:, :, :3].astype(np.float32)
            white_bg = np.ones_like(bgr) * 255.0
            composited = bgr * alpha + white_bg * (1.0 - alpha)
            return composited.astype(np.uint8)
        return img[:, :, :3]

    @staticmethod
    def _upscale(img: np.ndarray, scale: int) -> np.ndarray:
        """高质量放大图片（三次立方插值）"""
        h, w = img.shape[:2]
        return cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)

    def _xdog(self, gray: np.ndarray) -> np.ndarray:
        """
        XDoG (eXtended Difference of Gaussians) 算法

        通过两组不同 sigma 的高斯模糊做差分，再用 tanh 函数增强对比度，
        产生类似手绘线稿的效果。

        Returns:
            白底黑线的 uint8 图像
        """
        p = self.params
        sigma = p['sigma']
        k = p['k']
        epsilon = p['epsilon']
        phi = p['phi']

        g1 = cv2.GaussianBlur(gray, (0, 0), sigma)
        g2 = cv2.GaussianBlur(gray, (0, 0), sigma * k)
        d = g1.astype(np.float64) / 255.0 - g2.astype(np.float64) / 255.0

        result = np.ones_like(d)
        mask = d < epsilon
        result[mask] = 1.0 + np.tanh(phi * (d[mask] - epsilon))
        return np.clip(result * 255, 0, 255).astype(np.uint8)

    def _adaptive_threshold_lines(self, gray: np.ndarray) -> np.ndarray:
        """
        自适应阈值法提取线条

        使用双边滤波去噪（保留边缘），再用高斯加权自适应阈值
        提取不同区域的轮廓线。

        Returns:
            白底黑线的 uint8 图像
        """
        p = self.params
        filtered = cv2.bilateralFilter(
            gray,
            d=p['bilateral_d'],
            sigmaColor=p['bilateral_sigma_color'],
            sigmaSpace=p['bilateral_sigma_space'],
        )
        # blockSize 必须为奇数
        block_size = p['adaptive_block_size']
        if block_size % 2 == 0:
            block_size += 1
        return cv2.adaptiveThreshold(
            filtered, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=block_size,
            C=p['adaptive_c'],
        )

    def _canny_lines(self, gray: np.ndarray) -> np.ndarray:
        """
        Canny 边缘检测提取精确轮廓

        自动计算高低阈值（基于中位数），并轻微膨胀线条。

        Returns:
            白底黑线的 uint8 图像
        """
        p = self.params
        filtered = cv2.bilateralFilter(
            gray,
            d=p['bilateral_d'],
            sigmaColor=p['bilateral_sigma_color'],
            sigmaSpace=p['bilateral_sigma_space'],
        )
        median = np.median(filtered)
        lower = int(max(0, p['canny_lower_ratio'] * median))
        upper = int(min(255, p['canny_upper_ratio'] * median))
        edges = cv2.Canny(filtered, lower, upper)
        # 轻微膨胀使线条更连贯
        kernel = np.ones((2, 2), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)
        return 255 - edges  # 反转为白底黑线

    def _clean_lines(self, binary_img: np.ndarray) -> np.ndarray:
        """
        线条清理：去噪点、连接断线、平滑边缘

        步骤:
            1. 中值滤波去除孤立噪点
            2. 形态学闭运算连接断裂线条
            3. 形态学开运算去除小噪点
            4. 连通域分析移除面积过小的黑色区域
            5. 高斯模糊 + 重新二值化平滑边缘

        Args:
            binary_img: 白底黑线的二值图像

        Returns:
            清理后的白底黑线二值图像
        """
        p = self.params

        # 1. 中值滤波
        cleaned = cv2.medianBlur(binary_img, 3)

        # 2. 闭运算：连接断线
        kernel_close = np.ones((3, 3), np.uint8)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel_close, iterations=1)

        # 3. 开运算：去小噪点
        kernel_open = np.ones((2, 2), np.uint8)
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel_open, iterations=1)

        # 4. 连通域去噪
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
            255 - cleaned, connectivity=8
        )
        min_area = p['min_noise_area']
        for i in range(1, num_labels):
            if stats[i, cv2.CC_STAT_AREA] < min_area:
                cleaned[labels == i] = 255

        # 5. 高斯模糊 + 二值化
        cleaned = cv2.GaussianBlur(cleaned, (3, 3), 0)
        _, cleaned = cv2.threshold(cleaned, 200, 255, cv2.THRESH_BINARY)

        return cleaned

    def _fuse_results(
        self,
        xdog_result: np.ndarray,
        adaptive_result: np.ndarray,
        canny_result: np.ndarray,
    ) -> np.ndarray:
        """
        融合三种算法的结果

        取三者最小值（最暗像素 = 线条），保留所有检测到的轮廓。
        """
        return np.minimum(np.minimum(xdog_result, adaptive_result), canny_result)

    # --------------------------------------------------------
    #  公开 API
    # --------------------------------------------------------

    def convert(self, image: np.ndarray) -> np.ndarray:
        """
        将图片转换为黑白线稿图

        Args:
            image: 输入图片 (BGR 或 BGRA, uint8)

        Returns:
            黑白线稿图 (灰度, uint8)，白底黑线

        Raises:
            ValueError: 图片格式不正确
        """
        if image is None or image.size == 0:
            raise ValueError("输入图片为空")

        if len(image.shape) not in (2, 3):
            raise ValueError(f"不支持的图片维度: {image.shape}")

        # 透明背景合成
        if len(image.shape) == 3 and image.shape[2] == 4:
            img = self._composite_on_white(image)
        elif len(image.shape) == 3:
            img = image[:, :, :3]
        else:
            img = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        # 放大
        img_large = self._upscale(img, self.scale)

        # 转灰度
        gray = cv2.cvtColor(img_large, cv2.COLOR_BGR2GRAY)

        # 三算法并行提取
        xdog_result = self._xdog(gray)
        adaptive_result = self._adaptive_threshold_lines(gray)
        canny_result = self._canny_lines(gray)

        # 融合
        combined = self._fuse_results(xdog_result, adaptive_result, canny_result)

        # 清理
        cleaned = self._clean_lines(combined)

        # 最终平滑 + 二值化
        cleaned = cv2.GaussianBlur(cleaned, (3, 3), 0)
        _, final = cv2.threshold(
            cleaned, self.params['final_threshold'], 255, cv2.THRESH_BINARY
        )

        return final

    def convert_file(
        self,
        input_path: str,
        output_path: Optional[str] = None,
    ) -> Optional[np.ndarray]:
        """
        转换单个图片文件

        Args:
            input_path: 输入图片路径
            output_path: 输出路径，为 None 时不保存

        Returns:
            转换后的线稿图，读取失败返回 None
        """
        # 读取（支持中文路径）
        img = cv2.imdecode(
            np.fromfile(input_path, dtype=np.uint8), cv2.IMREAD_UNCHANGED
        )
        if img is None:
            print(f"  [错误] 无法读取: {input_path}")
            return None

        result = self.convert(img)

        if output_path:
            self.save(result, output_path)

        return result

    @staticmethod
    def save(image: np.ndarray, output_path: str) -> bool:
        """
        保存图片（支持中文路径）

        Args:
            image: 灰度图片
            output_path: 输出路径

        Returns:
            是否保存成功
        """
        ext = os.path.splitext(output_path)[1]
        if not ext:
            ext = '.png'
            output_path += ext

        # 灰度转 BGR 以兼容所有编码器
        if len(image.shape) == 2:
            image_bgr = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        else:
            image_bgr = image

        ok, buf = cv2.imencode(ext, image_bgr)
        if ok:
            buf.tofile(output_path)
            return True
        return False

    def batch_convert(
        self,
        input_dir: str,
        output_dir: str,
        suffix: str = '_线稿',
        verbose: bool = True,
    ) -> Tuple[int, int]:
        """
        批量处理文件夹内所有图片

        Args:
            input_dir: 输入文件夹
            output_dir: 输出文件夹
            suffix: 输出文件名后缀，默认 '_线稿'
            verbose: 是否打印进度信息

        Returns:
            (成功数, 失败数)
        """
        # 收集图片文件
        image_files = []
        for f in sorted(os.listdir(input_dir)):
            ext = os.path.splitext(f)[1].lower()
            if ext in SUPPORTED_EXTENSIONS:
                image_files.append(os.path.join(input_dir, f))

        if not image_files:
            if verbose:
                print("未找到任何图片文件！")
            return 0, 0

        os.makedirs(output_dir, exist_ok=True)

        if verbose:
            print(f"找到 {len(image_files)} 张图片，开始处理...")
            print(f"风格: {self.style} | 放大倍数: {self.scale}x\n")

        success = 0
        failed = 0
        start_time = time.time()

        for i, img_path in enumerate(image_files, 1):
            filename = os.path.basename(img_path)
            name, ext = os.path.splitext(filename)
            output_path = os.path.join(output_dir, f"{name}{suffix}{ext}")

            try:
                result = self.convert_file(img_path)
                if result is not None:
                    self.save(result, output_path)
                    if verbose:
                        print(f"  [{i}/{len(image_files)}] [完成] {filename}")
                    success += 1
                else:
                    failed += 1
            except Exception as e:
                if verbose:
                    print(f"  [{i}/{len(image_files)}] [错误] {filename}: {e}")
                failed += 1

        elapsed = time.time() - start_time
        if verbose:
            print(f"\n处理完成！成功: {success}，失败: {failed}，耗时: {elapsed:.1f}s")
            print(f"输出目录: {output_dir}")

        return success, failed


# ============================================================
#  命令行接口
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    """构建命令行参数解析器"""
    parser = argparse.ArgumentParser(
        description='黑白线稿图转换工具 - 将图片转换为仅保留轮廓的黑白线稿',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 转换单个文件
  python lineart_converter.py -i photo.png -o lineart.png

  # 批量处理文件夹
  python lineart_converter.py -i ./images -o ./output

  # 使用素描风格
  python lineart_converter.py -i photo.png -o lineart.png --style sketch

  # 自定义参数
  python lineart_converter.py -i photo.png -o lineart.png --scale 4 --sigma 2.0 --threshold 200

  # 列出可用风格
  python lineart_converter.py --list-styles
        """,
    )

    parser.add_argument(
        '-i', '--input',
        help='输入图片文件或文件夹路径',
    )
    parser.add_argument(
        '-o', '--output',
        help='输出图片文件或文件夹路径',
    )
    parser.add_argument(
        '-s', '--style',
        choices=list(STYLE_PRESETS.keys()),
        default='clean',
        help='预设风格 (默认: clean)',
    )
    parser.add_argument(
        '--scale',
        type=int,
        default=4,
        help='放大倍数 1-8，越大线条越平滑 (默认: 4)',
    )
    parser.add_argument(
        '--sigma',
        type=float,
        help='XDoG 高斯模糊 sigma (覆盖预设)',
    )
    parser.add_argument(
        '--k',
        type=float,
        help='XDoG 比例因子 k (覆盖预设)',
    )
    parser.add_argument(
        '--epsilon',
        type=float,
        help='XDoG 阈值 epsilon (覆盖预设)',
    )
    parser.add_argument(
        '--phi',
        type=float,
        help='XDoG 增强强度 phi (覆盖预设)',
    )
    parser.add_argument(
        '--threshold',
        type=int,
        help='最终二值化阈值 0-255 (覆盖预设)',
    )
    parser.add_argument(
        '--min-noise-area',
        type=int,
        help='最小噪点面积，小于此值的黑色区域被移除 (覆盖预设)',
    )
    parser.add_argument(
        '--suffix',
        default='_线稿',
        help='批量处理时输出文件名后缀 (默认: _线稿)',
    )
    parser.add_argument(
        '--list-styles',
        action='store_true',
        help='列出所有可用风格及其参数',
    )
    parser.add_argument(
        '-q', '--quiet',
        action='store_true',
        help='安静模式，不打印进度信息',
    )

    return parser


def list_styles():
    """打印所有可用风格"""
    print("=" * 60)
    print("可用风格预设")
    print("=" * 60)
    for name, params in STYLE_PRESETS.items():
        print(f"\n  {name}:")
        for k, v in params.items():
            print(f"    {k:30s} = {v}")
    print()


def main():
    """命令行入口"""
    parser = build_parser()
    args = parser.parse_args()

    # 列出风格
    if args.list_styles:
        list_styles()
        return

    # 检查必要参数
    if not args.input:
        parser.print_help()
        sys.exit(1)

    # 收集自定义参数覆盖
    overrides = {}
    if args.sigma is not None:
        overrides['sigma'] = args.sigma
    if args.k is not None:
        overrides['k'] = args.k
    if args.epsilon is not None:
        overrides['epsilon'] = args.epsilon
    if args.phi is not None:
        overrides['phi'] = args.phi
    if args.threshold is not None:
        overrides['final_threshold'] = args.threshold
    if args.min_noise_area is not None:
        overrides['min_noise_area'] = args.min_noise_area

    # 创建转换器
    converter = LineArtConverter(
        scale=args.scale,
        style=args.style,
        **overrides,
    )

    # 判断是单文件还是批量
    if os.path.isfile(args.input):
        # 单文件模式
        output = args.output or 'output_lineart.png'
        result = converter.convert_file(args.input, output)
        if result is not None:
            if not args.quiet:
                print(f"转换完成: {args.input} -> {output}")
        else:
            sys.exit(1)

    elif os.path.isdir(args.input):
        # 批量模式
        output_dir = args.output or os.path.join(args.input, '线稿图')
        success, failed = converter.batch_convert(
            args.input,
            output_dir,
            suffix=args.suffix,
            verbose=not args.quiet,
        )
        if failed > 0 and success == 0:
            sys.exit(1)

    else:
        print(f"错误: 路径不存在 - {args.input}")
        sys.exit(1)


if __name__ == '__main__':
    main()
