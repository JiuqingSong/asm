#pragma once
#include <algorithm>
#include <stdexcept>

namespace asm86 {
struct Viewport { int x, y, width, height; };

// 保持客体宽高比并居中；先按宽缩放，若超出客户端高度则改按高缩放，余区留黑。
inline Viewport viewport(int width, int height, int sourceWidth = 640, int sourceHeight = 400) {
    if (sourceWidth <= 0 || sourceHeight <= 0) throw std::runtime_error("Display dimensions must be positive");
    width = std::max(width, 0); height = std::max(height, 0);
    int w = width, h = int(static_cast<long long>(width) * sourceHeight / sourceWidth);
    if (h > height) { h = height; w = int(static_cast<long long>(height) * sourceWidth / sourceHeight); }
    return {(width - w) / 2, (height - h) / 2, w, h};
}
}
