#include "overlay/Frames.hpp"

#include "overlay/Scene.hpp"

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
                       .surfaceHeight = height});
}

}  // namespace radar::overlay
