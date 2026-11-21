#include "overlay/Pacing.hpp"

#include <algorithm>

namespace radar::overlay {

std::optional<FramePacer::Plan> FramePacer::plan(std::int64_t now) const {
    if (refresh_ <= 0 || lastVblank_ <= 0) return std::nullopt;
    const std::int64_t lead = margin_ + drawEstimate();
    // The first vblank on the grid that can still be made: starting at it − lead isn't past.
    std::int64_t n = std::max<std::int64_t>((now + lead - lastVblank_ + refresh_ - 1) / refresh_, 1);
    if (lastTarget_) n = std::max(n, (*lastTarget_ + refresh_ / 2 - lastVblank_) / refresh_ + 1);
    const std::int64_t target = lastVblank_ + n * refresh_;
    return Plan{target - lead, target};
}

void FramePacer::drew(std::int64_t duration, std::optional<std::int64_t> target) {
    lastTarget_ = target;
    draws_.push_back(std::max<std::int64_t>(duration, 0));
    while (draws_.size() > kDrawSamples) draws_.pop_front();
}

void FramePacer::presented(std::int64_t read, std::int64_t presented, std::int64_t refresh,
                           std::optional<std::int64_t> target) {
    bool missed = false;
    if (target && refresh > 0) {
        missed = presented > *target + refresh / 2;
        const bool early = presented < *target - refresh / 2;  // made an earlier vblank: the margin is too big
        if (missed) {
            margin_ = std::min(margin_ + kMarginStepUp, kMaxMarginRefreshes * refresh);
            hits_ = 0;
        } else if (early) {
            margin_ = std::max(margin_ - kMarginStepUp, kMinMargin);
            hits_ = 0;
        } else if (++hits_ >= kHitsToShrink) {
            margin_ = std::max(margin_ - kMarginStepDown, kMinMargin);
            hits_ = 0;
        }
    }
    lastVblank_ = presented;
    refresh_ = refresh;
    samples_.push_back({presented - read, presented, missed});
    while (samples_.size() > kStatSamples) samples_.pop_front();
}

std::int64_t FramePacer::drawEstimate() const { return draws_.empty() ? 1'000'000 : std::ranges::max(draws_); }

FramePacer::Stats FramePacer::stats() const {
    constexpr double kMs = 1e6;
    Stats s{.frames = samples_.size(), .refreshMs = static_cast<double>(refresh_) / kMs,
            .drawMs = static_cast<double>(drawEstimate()) / kMs, .marginMs = static_cast<double>(margin_) / kMs,
            .discarded = discarded_};
    if (samples_.empty()) return s;
    double sum = 0;
    for (const Sample& x : samples_) {
        sum += static_cast<double>(x.latency);
        s.latencyMaxMs = std::max(s.latencyMaxMs, static_cast<double>(x.latency) / kMs);
        s.missed += x.missed ? 1 : 0;
    }
    s.latencyAvgMs = sum / static_cast<double>(samples_.size()) / kMs;
    if (samples_.size() > 1)
        s.intervalAvgMs = static_cast<double>(samples_.back().presented - samples_.front().presented) /
                          static_cast<double>(samples_.size() - 1) / kMs;
    return s;
}

}  // namespace radar::overlay
