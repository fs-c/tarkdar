#include "overlay/Scene.hpp"

#include <algorithm>
#include <cmath>
#include <format>
#include <numbers>
#include <unordered_map>

namespace radar::overlay {

using math::Vec3;

namespace {

constexpr float kDefaultFov = 75;      // degrees, if the camera's is unknown
constexpr float kDefaultAspect = 16.f / 9.f;
constexpr float kBody = 1.8f;           // m: a player's height, without a skeleton
constexpr float kGridStep = 5;          // m
constexpr float kGridRange = 60;        // m
constexpr float kTextSize = 15;         // px
constexpr Color kGridColor{180, 200, 210, 110};
constexpr Color kLensColor{200, 210, 220, 90};

float widthOf(Emphasis e) {
    switch (e) {
        case Emphasis::Faint: return 1.5f;
        case Emphasis::Normal: return 2.f;
        case Emphasis::Strong: return 2.5f;
        case Emphasis::Loud: return 3.5f;
    }
    return 2.f;
}

// A mark's size by distance: near things bigger, within limits.
float sizeAt(float depth, Emphasis e) { return std::clamp(60.f / depth, 2.f, 10.f) * (e == Emphasis::Loud ? 1.3f : 1.f); }

Color faded(Color c, float alpha) { return {c.r, c.g, c.b, static_cast<std::uint8_t>(std::clamp(alpha, 0.f, 1.f) * c.a)}; }

float horizontalDistance(Vec3 a, Vec3 b) { return std::hypot(a.x - b.x, a.z - b.z); }

// Projects world points onto the surface, through the first-person view or, inside the scope's
// circle while scoped, through the scope.
class Painter {
public:
    Painter(const CameraView& fps, Viewport vp, std::optional<ScopeMapping> scope, float scopeRadius)
        : fps_(fps), vp_(vp), scope_(std::move(scope)), radius_(scopeRadius * vp.height) {}

    struct Screen {
        Point at;
        float depth;
    };
    // nullopt: behind the camera, hidden behind the scope's picture, or off the picture.
    [[nodiscard]] std::optional<Screen> toScreen(Vec3 p) const {
        const Point centre{vp_.x + vp_.width / 2, vp_.y + vp_.height / 2};
        if (const auto q = project(fps_.viewProjection, p)) {
            const Point at{vp_.x + (q->x + 1) * 0.5f * vp_.width, vp_.y + (1 - q->y) * 0.5f * vp_.height};
            if (!scope_ || !insideLens(at, centre)) return visible(at) ? std::optional(Screen{at, q->depth}) : std::nullopt;
        }
        if (!scope_) return std::nullopt;
        // Inside the scope's circle: where the scope shows it.
        const auto o = scope_->offset(p);
        if (!o) return std::nullopt;
        const Point at{centre.x + o->x * vp_.height, centre.y - o->y * vp_.height};
        return insideLens(at, centre) ? std::optional(Screen{at, o->depth}) : std::nullopt;
    }
    [[nodiscard]] bool scoped() const { return scope_.has_value(); }
    [[nodiscard]] float lensRadius() const { return radius_; }
    [[nodiscard]] Point centre() const { return {vp_.x + vp_.width / 2, vp_.y + vp_.height / 2}; }

private:
    [[nodiscard]] bool insideLens(Point at, Point centre) const { return std::hypot(at.x - centre.x, at.y - centre.y) <= radius_; }
    [[nodiscard]] bool visible(Point at) const {
        // A little past the edges, so labels of marks just outside still show.
        const float mx = 0.05f * vp_.width, my = 0.05f * vp_.height;
        return at.x >= vp_.x - mx && at.x <= vp_.x + vp_.width + mx && at.y >= vp_.y - my && at.y <= vp_.y + vp_.height + my;
    }

    const CameraView& fps_;
    Viewport vp_;
    std::optional<ScopeMapping> scope_;
    float radius_;
};

// `distance`: from the camera, in metres.
void label(DrawList& out, Point at, float offset, const std::string& text, float distance, Color color) {
    const std::string line = text.empty() ? std::format("{:.0f} m", distance) : std::format("{} {:.0f} m", text, distance);
    out.items.emplace_back(DrawList::Text{{at.x + offset + 3, at.y - kTextSize / 2}, line, color, kTextSize});
}

void drawPlayer(DrawList& out, const Painter& painter, Vec3 eye, const eft::PlayerState& p, const Mark& m) {
    const Vec3 feet = *p.position;
    Vec3 head = feet + Vec3{0, kBody, 0};
    if (p.joints) head = feet + (*p.joints)[static_cast<std::size_t>(eft::Joint::Head)];
    const auto f = painter.toScreen(feet), h = painter.toScreen(head);
    if (!f && !h) return;
    const float width = widthOf(m.emphasis);
    const auto& top = h ? *h : *f;
    const float size = sizeAt(top.depth, m.emphasis);
    // Feet to head; just the head (or feet) when only one end shows, e.g. the feet below the picture.
    if (f && h) out.items.emplace_back(DrawList::Line{f->at, h->at, m.color, width});
    out.items.emplace_back(DrawList::Circle{top.at, size / 1.5f, m.color, 0});
    label(out, top.at, size, m.label, math::length(feet - eye), m.color);
}

void drawDot(DrawList& out, const Painter& painter, Vec3 eye, Vec3 pos, const Mark& m) {
    const auto s = painter.toScreen(pos);
    if (!s) return;
    const float size = sizeAt(s->depth, m.emphasis);
    out.items.emplace_back(DrawList::Circle{s->at, std::max(2.f, size / 2.5f), m.color, 0});
    label(out, s->at, size / 2, m.label, math::length(pos - eye), m.color);
}

void drawExfil(DrawList& out, const Painter& painter, Vec3 eye, Vec3 pos, const Mark& m) {
    const auto s = painter.toScreen(pos);
    if (!s) return;
    const float r = std::max(5.f, sizeAt(s->depth, m.emphasis));
    const Point c = s->at;
    out.items.emplace_back(DrawList::Polygon{{{c.x, c.y - r}, {c.x + r, c.y}, {c.x, c.y + r}, {c.x - r, c.y}}, m.color, widthOf(m.emphasis)});
    label(out, c, r, m.label, math::length(pos - eye), m.color);
}

void drawGrid(DrawList& out, const Painter& painter, Vec3 eye, float ground, float range) {
    const float x0 = std::round(eye.x / kGridStep) * kGridStep, z0 = std::round(eye.z / kGridStep) * kGridStep;
    const float r = std::min(range, kGridRange);
    for (float dx = -r; dx <= r; dx += kGridStep)
        for (float dz = -r; dz <= r; dz += kGridStep)
            if (const auto s = painter.toScreen({x0 + dx, ground, z0 + dz}))
                out.items.emplace_back(
                    DrawList::Circle{s->at, 1.5f, faded(kGridColor, std::max(0.2f, 1 - s->depth / kGridRange)), 0});
}

}  // namespace

std::optional<Projected> project(const math::Mat4& vp, Vec3 p) {
    const auto& m = vp.m;
    const float cx = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    const float cy = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    const float w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
    if (!(w > kNear) || !std::isfinite(cx) || !std::isfinite(cy)) return std::nullopt;
    return Projected{cx / w, cy / w, w};
}

Viewport letterbox(float sw, float sh, float aspect) {
    if (!(aspect > 0) || !(sw > 0) || !(sh > 0)) return {0, 0, sw, sh};
    const float w = std::min(sw, sh * aspect), h = w / aspect;
    return {(sw - w) / 2, (sh - h) / 2, w, h};
}

std::optional<Projected> ScopeMapping::offset(Vec3 p) const {
    if (optic) {
        const float halfFov =
            std::tan((fps.fieldOfView > 0 ? fps.fieldOfView : kDefaultFov) / 2 * std::numbers::pi_v<float> / 180);
        const auto q = project(optic->viewProjection, p);
        if (!q) return std::nullopt;
        return Projected{q->x * halfFov, q->y * halfFov, q->depth};
    }
    const auto q = project(fps.viewProjection, p);
    if (!q) return std::nullopt;
    const float aspect = fps.aspect > 0 ? fps.aspect : kDefaultAspect;
    return Projected{q->x * aspect / 2 * magnification, q->y / 2 * magnification, q->depth};
}

DrawList buildScene(const SceneInput& in) {
    DrawList out;
    const Config& cfg = in.config;
    if (!cfg.on || !in.fps || in.players.raidId == 0) return out;
    const CameraView& fps = *in.fps;
    const Viewport vp = letterbox(in.surfaceWidth, in.surfaceHeight, fps.aspect > 0 ? fps.aspect : kDefaultAspect);

    std::optional<ScopeMapping> scope;
    if (in.camera.scoped && (in.optic || in.camera.magnification > 1))
        scope = ScopeMapping{in.optic, fps, in.camera.magnification};
    const Painter painter(fps, vp, scope, cfg.scopeRadius);

    const eft::PlayerState* local = in.players.local();
    const Vec3 eye = fps.position.value_or(local && local->position ? *local->position : Vec3{});
    if (cfg.grid && (fps.position || (local && local->position))) {
        const float ground = local && local->position ? local->position->y : eye.y - 1.6f;
        drawGrid(out, painter, eye, ground, cfg.lootRange);
    }

    // Marks only apply to the raid they were made for: ids restart every raid.
    const bool marksApply = cfg.raid == in.players.raidId;
    std::unordered_map<std::uint32_t, const eft::PlayerState*> players;
    for (const auto& p : in.players.players) players.emplace(p.id, &p);
    std::unordered_map<std::uint32_t, bool> markedPlayers;

    if (marksApply) {
        std::unordered_map<std::uint32_t, const eft::LootEntry*> loot;
        if (in.loot.raidId == in.players.raidId)
            for (const auto& l : in.loot.loot) loot.emplace(l.id, &l);
        std::unordered_map<std::uint32_t, const eft::Exfil*> exfils;
        if (in.exfils.raidId == in.players.raidId)
            for (const auto& e : in.exfils.exfils) exfils.emplace(e.id, &e);
        for (const Mark& m : cfg.marks) {
            switch (m.kind) {
                case MarkKind::Player:
                    if (const auto it = players.find(m.id); it != players.end()) {
                        markedPlayers[m.id] = true;
                        const auto& p = *it->second;
                        if (!p.local && !p.absent && p.position) drawPlayer(out, painter, eye, p, m);
                    }
                    break;
                case MarkKind::Loot:
                    if (const auto it = loot.find(m.id);
                        it != loot.end() && horizontalDistance(it->second->position, eye) <= cfg.lootRange)
                        drawDot(out, painter, eye, it->second->position, m);
                    break;
                case MarkKind::Exfil:
                    if (const auto it = exfils.find(m.id); it != exfils.end() && it->second->position)
                        drawExfil(out, painter, eye, *it->second->position, m);
                    break;
            }
        }
    }
    if (cfg.otherPlayers)
        for (const auto& p : in.players.players)
            if (!markedPlayers.contains(p.id) && !p.local && !p.absent && !p.dead && p.position)
                drawPlayer(out, painter, eye, p, Mark{.kind = MarkKind::Player, .id = p.id, .color = *cfg.otherPlayers});

    // The scope's circle, so it's clear which marks are placed through the scope.
    if (painter.scoped()) out.items.emplace_back(DrawList::Circle{painter.centre(), painter.lensRadius(), kLensColor, 1.5f});
    return out;
}

}  // namespace radar::overlay
