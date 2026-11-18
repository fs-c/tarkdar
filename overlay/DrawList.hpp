#pragma once

#include "overlay/Config.hpp"

#include <string>
#include <variant>
#include <vector>

namespace radar::overlay {

// Surface pixels (logical: before the output's scale), origin top left, y down.
struct Point {
    float x = 0, y = 0;
    friend bool operator==(Point, Point) = default;
};

// What one overlay frame draws, independent of how it's drawn (the window renders it).
struct DrawList {
    struct Line {
        Point a, b;
        Color color;
        float width;
    };
    struct Circle {
        Point center;
        float radius;
        Color color;
        float width;  // 0: filled
    };
    struct Polygon {
        std::vector<Point> points;
        Color color;
        float width;  // 0: filled
    };
    struct Text {
        Point at;  // top left
        std::string text;
        Color color;
        float size;  // px
    };
    using Item = std::variant<Line, Circle, Polygon, Text>;
    std::vector<Item> items;

    [[nodiscard]] bool empty() const { return items.empty(); }
};

}  // namespace radar::overlay
