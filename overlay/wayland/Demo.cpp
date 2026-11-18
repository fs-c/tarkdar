// radar-overlay-demo: the overlay window with a made-up scene, no game needed. For checking the window
// itself on a desktop: that it covers the right monitor, above fullscreen windows, lets clicks
// through, and how the marks look. The camera turns slowly on the spot; players stand in a ring
// around it, with loot, an exfil and the ground grid.
//
//   radar-overlay-demo [--output <name>] [--font <file>] [--scoped] [--seconds <n>]

#include "core/log/Log.hpp"
#include "overlay/Window.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <numbers>
#include <string_view>
#include <thread>

namespace {

using namespace radar;
using math::Mat4;
using math::Vec3;

constexpr float kFov = 75, kAspect = 16.f / 9.f;
constexpr Vec3 kEye{0, 1.7f, 0};
constexpr float kDegPerSecond = 12;

void set(Mat4& m, int r, int c, float v) { m.m[static_cast<std::size_t>(c * 4 + r)] = v; }

// View (OpenGL convention: looks down −z) for a camera at `p` turned `yaw` degrees from +z, clockwise
// seen from above, as Unity's yaw.
Mat4 view(Vec3 p, float yawDegrees) {
    const float yaw = yawDegrees * std::numbers::pi_v<float> / 180;
    const Vec3 right{std::cos(yaw), 0, -std::sin(yaw)}, up{0, 1, 0}, forward{std::sin(yaw), 0, std::cos(yaw)};
    Mat4 v;
    const Vec3 rows[3] = {right, up, forward * -1.f};
    for (int r = 0; r < 3; ++r) {
        const Vec3 row = rows[r];
        set(v, r, 0, row.x), set(v, r, 1, row.y), set(v, r, 2, row.z);
        set(v, r, 3, -(row.x * p.x + row.y * p.y + row.z * p.z));
    }
    set(v, 3, 3, 1);
    return v;
}

Mat4 perspective(float fovDegrees, float aspect, float zNear = 0.05f, float zFar = 1000.0f) {
    Mat4 m;
    const float f = 1.0f / std::tan(fovDegrees * std::numbers::pi_v<float> / 360.0f);
    set(m, 0, 0, f / aspect), set(m, 1, 1, f), set(m, 2, 2, (zFar + zNear) / (zNear - zFar));
    set(m, 2, 3, 2 * zFar * zNear / (zNear - zFar)), set(m, 3, 2, -1);
    return m;
}

Mat4 multiply(const Mat4& a, const Mat4& b) {
    Mat4 out;
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c) {
            float sum = 0;
            for (int k = 0; k < 4; ++k) sum += a.at(r, k) * b.at(k, c);
            set(out, r, c, sum);
        }
    return out;
}

// A camera that turns with time.
class TurningCamera final : public eft::CameraReader {
public:
    explicit TurningCamera(bool scoped) : scoped_(scoped) {}
    std::uint64_t raidId() const override { return 1; }
    std::optional<eft::CameraView> fps() const override { return at(kFov); }
    std::optional<eft::CameraView> optic() const override {
        if (!scoped_) return std::nullopt;
        return at(kFov / 8, 1);  // a narrow view (in the game: the scope's own camera)
    }

private:
    eft::CameraView at(float fov, float aspect = kAspect) const {
        const float t = std::chrono::duration<float>(std::chrono::steady_clock::now() - start_).count();
        return {multiply(perspective(fov, aspect), view(kEye, t * kDegPerSecond)), kEye, fov, aspect};
    }
    bool scoped_;
    std::chrono::steady_clock::time_point start_ = std::chrono::steady_clock::now();
};

void publishScene(eft::WorldState& world, sched::Published<overlay::Config>& config, bool scoped) {
    using overlay::Color;
    using overlay::Emphasis;
    using overlay::MarkKind;
    eft::PlayersSnapshot players;
    players.raidId = 1;
    players.players.push_back({.id = 1, .local = true, .position = Vec3{0, 0, 0}});
    overlay::Config c{.on = true, .raid = 1, .otherPlayers = Color{230, 230, 230, 255}, .grid = true};
    struct Who {
        float bearing, distance;
        const char* label;
        Color color;
        Emphasis emphasis;
    };
    const Who who[] = {
        {0, 25, "USEC", {80, 160, 255, 255}, Emphasis::Normal},     {35, 60, "BEAR", {255, 90, 82, 255}, Emphasis::Normal},
        {80, 12, "Scav", {255, 200, 80, 255}, Emphasis::Faint},     {140, 40, "Killa", {255, 60, 200, 255}, Emphasis::Loud},
        {200, 90, "Raider", {255, 140, 40, 255}, Emphasis::Strong}, {290, 18, "", {0, 0, 0, 0}, Emphasis::Normal},
    };
    std::uint32_t id = 2;
    for (const Who& w : who) {
        const float b = w.bearing * std::numbers::pi_v<float> / 180;
        players.players.push_back({.id = id, .position = Vec3{std::sin(b) * w.distance, 0, std::cos(b) * w.distance}});
        if (w.label[0]) c.marks.push_back({.kind = MarkKind::Player, .id = id, .color = w.color, .label = w.label, .emphasis = w.emphasis});
        ++id;  // the unlabelled one isn't marked: drawn as one of the other players
    }
    eft::LootSnapshot loot;
    loot.raidId = 1;
    for (std::uint32_t i = 0; i < 24; ++i) {
        const float b = static_cast<float>(i) * 15 * std::numbers::pi_v<float> / 180, d = 6.f + static_cast<float>(i % 5) * 4;
        eft::LootEntry entry;
        entry.id = i + 1;
        entry.position = Vec3{std::sin(b) * d, 0.1f, std::cos(b) * d};
        loot.loot.push_back(std::move(entry));
        if (i % 3 == 0)
            c.marks.push_back({.kind = MarkKind::Loot, .id = i + 1, .color = {255, 216, 77, 255},
                               .label = i % 6 == 0 ? "LEDX" : "", .emphasis = Emphasis::Strong});
    }
    eft::ExfilsSnapshot exfils{.raidId = 1};
    exfils.exfils.push_back({.id = 1, .name = "Gate", .position = Vec3{-120, 2, 40}});
    c.marks.push_back({.kind = MarkKind::Exfil, .id = 1, .color = {80, 220, 120, 255}, .label = "Gate"});

    eft::CameraSnapshot camera{.raidId = 1, .aiming = scoped, .magnification = scoped ? 8.f : 1.f, .scoped = scoped};
    world.players.publish(std::move(players));
    world.loot.publish(std::move(loot));
    world.exfils.publish(std::move(exfils));
    world.camera.publish(std::move(camera));
    world.cameraReader.publish(eft::CameraReaderRef{std::make_shared<TurningCamera>(scoped)});
    config.publish(std::move(c));
}

}  // namespace

int main(int argc, char** argv) {
    overlay::WindowOptions options;
    bool scoped = false;
    int seconds = 0;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        const bool hasValue = i + 1 < argc;
        if (arg == "--output" && hasValue) options.output = argv[++i];
        else if (arg == "--font" && hasValue) options.font = argv[++i];
        else if (arg == "--scoped") scoped = true;
        else if (arg == "--seconds" && hasValue) {
            const std::string_view v = argv[++i];
            std::from_chars(v.data(), v.data() + v.size(), seconds);
        } else {
            std::fprintf(stderr, "usage: %s [--output <name>] [--font <file>] [--scoped] [--seconds <n>]\n", argv[0]);
            return 2;
        }
    }
    eft::WorldState world;
    sched::Published<overlay::Config> config;
    publishScene(world, config, scoped);
    overlay::Frames frames(world, config);
    std::jthread window([&](std::stop_token stop) {
        if (auto r = overlay::runOverlayWindow(stop, options, frames); !r) log::error("overlay: {}", r.error());
    });
    if (seconds > 0) {
        std::this_thread::sleep_for(std::chrono::seconds(seconds));
        window.request_stop();
    }
    window.join();  // until stopped, or the window fails or is closed
    return 0;
}
