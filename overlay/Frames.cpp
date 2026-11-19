#include "overlay/Frames.hpp"

#include "overlay/Scene.hpp"

#include <format>

namespace radar::overlay {

void CameraHistory::add(CameraReading r) {
    while (!readings_.empty() && readings_.back().at > r.at) readings_.pop_back();  // a clock going back
    readings_.push_back(std::move(r));
    while (readings_.size() > 1 && readings_.back().at - readings_.front().at > kKeep) readings_.pop_front();
}

std::optional<CameraReading> CameraHistory::at(sched::Clock::time_point at) const {
    if (readings_.empty()) return std::nullopt;
    for (auto it = readings_.rbegin(); it != readings_.rend(); ++it)
        if (it->at <= at) return *it;
    return readings_.front();
}

bool Frames::active() const { return config_.get()->on && world_.cameraReader.get()->reader != nullptr; }

DrawList Frames::frame(float width, float height, sched::Clock::time_point now) {
    const auto config = config_.get();
    const auto reader = world_.cameraReader.get()->reader;
    if (!config->on || !reader) {
        history_.clear();
        return {};
    }
    if (reader->raidId() != historyRaid_) {
        history_.clear();
        historyRaid_ = reader->raidId();
    }
    const auto camera = world_.camera.get();
    // Read right before drawing; the scope's camera only while it renders.
    CameraReading reading{.at = now, .fps = reader->fps(), .optic = camera->scoped ? reader->optic() : std::nullopt};
    if (!reading.fps && camera->raidId == reader->raidId()) reading.fps = camera->fps;  // a failed read: the last good one
    history_.add(std::move(reading));
    const auto shown = history_.at(now - config->delay);
    if (!shown) return {};

    const auto players = world_.players.get();
    const auto loot = world_.loot.get();
    const auto exfils = world_.exfils.get();
    return buildScene({.config = *config,
                       .camera = *camera,
                       .fps = shown->fps,
                       .optic = shown->optic,
                       .players = *players,
                       .loot = *loot,
                       .exfils = *exfils,
                       .surfaceWidth = width,
                       .surfaceHeight = height,
                       .stretch = stretch_});
}

DrawList Frames::testPattern(float width, float height, const DrawList& scene) const {
    const auto config = config_.get();
    const auto reader = world_.cameraReader.get()->reader;
    const auto camera = world_.camera.get();
    const auto players = world_.players.get();
    DrawList d;
    const Color magenta{255, 0, 255, 255}, yellow{255, 230, 0, 255}, white{255, 255, 255, 255};
    const float inset = 4, cx = width / 2, cy = height / 2;
    d.items.push_back(DrawList::Polygon{
        {{inset, inset}, {width - inset, inset}, {width - inset, height - inset}, {inset, height - inset}}, magenta, 4});
    d.items.push_back(DrawList::Line{{cx - 40, cy}, {cx + 40, cy}, magenta, 2});
    d.items.push_back(DrawList::Line{{cx, cy - 40}, {cx, cy + 40}, magenta, 2});
    d.items.push_back(DrawList::Circle{{cx, cy}, 60, magenta, 2});

    const char* why = !config->on                                   ? "overlay is OFF (frontend: Settings, Overlay)"
                      : !reader                                     ? "no camera reader (not in a raid yet?)"
                      : config->raid != reader->raidId()            ? "the frontend's marks are for another raid"
                      : !camera->fps                                ? "no first-person camera read"
                      : scene.empty()                               ? "nothing in view or in range"
                                                                    : "drawing";
    const std::string lines[] = {
        std::format("OVERLAY TEST  {:.0f}x{:.0f}  picture {}, camera aspect {:.3f}", width, height,
                    stretch_ ? "stretched" : "letterboxed", camera->fps ? camera->fps->aspect : 0.f),
        std::format("status: {}", why),
        std::format("config: {}, raid {}, {} marks, other players {}, loot range {:.0f} m", config->on ? "on" : "off",
                    config->raid, config->marks.size(), config->otherPlayers ? "shown" : "hidden", config->lootRange),
        std::format("reader raid: {}  camera raid: {} ({})  players: {} (raid {})", reader ? reader->raidId() : 0,
                    camera->raidId, camera->fps ? "fps ok" : "no fps", players->players.size(), players->raidId),
        std::format("scene items: {}", scene.items.size()),
    };
    float y = 24;
    for (const auto& line : lines) {
        d.items.push_back(DrawList::Text{{24, y}, line, y == 24 ? magenta : line.starts_with("status") ? yellow : white, 18});
        y += 22;
    }
    return d;
}

}  // namespace radar::overlay
