#pragma once

#include <cstdint>
#include <deque>
#include <optional>

// Frame pacing for the overlay window: when to read the camera and draw, so the frame reaches the
// screen as soon after the read as possible.
//
// Drawing as soon as the compositor's frame callback arrives (right after it composited) leaves the
// frame waiting for the compositor's next pass, about a refresh later. Instead, with the vblank times
// the compositor reports (presentation feedback), the pacer picks the next vblank the frame can make
// and starts drawing just in time for it: the compositor's lead before the vblank (`margin`, learnt:
// it grows when a frame misses its vblank and slowly shrinks while frames make it) plus the time a
// frame takes to draw (the slowest of the recent ones).
//
// Times are nanoseconds on the compositor's presentation clock.
namespace radar::overlay {

class FramePacer {
public:
    static constexpr std::int64_t kInitialMargin = 4'000'000;
    static constexpr std::int64_t kMinMargin = 500'000;
    // The compositor's lead can be more than a refresh: KWin's triple buffering (when compositing is
    // slow) composites a whole frame ahead.
    static constexpr std::int64_t kMaxMarginRefreshes = 3;
    static constexpr std::int64_t kMarginStepUp = 500'000;    // on a missed vblank
    static constexpr std::int64_t kMarginStepDown = 100'000;  // after kHitsToShrink made in a row
    static constexpr int kHitsToShrink = 240;
    static constexpr std::size_t kDrawSamples = 64;
    static constexpr std::size_t kStatSamples = 300;          // presented frames the stats cover

    struct Plan {
        std::int64_t start;   // start reading and drawing then
        std::int64_t target;  // the vblank it's for
    };
    // When to draw the next frame, asked at `now`; nullopt while no vblank time and refresh are known
    // (no presentation feedback yet, or a variable refresh rate): draw right away.
    [[nodiscard]] std::optional<Plan> plan(std::int64_t now) const;

    // A frame took this long to draw (read to swapped, the GPU's work included); `target`: the vblank
    // it was planned for. The next plan is for a later one: the compositor's frame callback for this
    // frame can come before that vblank, when it's too late to make it.
    void drew(std::int64_t duration, std::optional<std::int64_t> target = std::nullopt);
    // A frame read at `read` reached the screen at `presented`, the output refreshing every `refresh`
    // (0: unknown or variable). `target`: the vblank it was planned for, if it was.
    void presented(std::int64_t read, std::int64_t presented, std::int64_t refresh, std::optional<std::int64_t> target);
    // A frame was never shown (replaced by a newer one first).
    void discarded() { ++discarded_; }

    struct Stats {
        std::size_t frames = 0;                 // presented frames these cover
        double latencyAvgMs = 0, latencyMaxMs = 0;  // read → on screen
        double intervalAvgMs = 0;               // between presented frames
        double refreshMs = 0;
        std::size_t missed = 0;                 // of the planned frames, those later than their vblank
        double drawMs = 0, marginMs = 0;        // the draw estimate and the learnt margin
        std::uint64_t discarded = 0;
    };
    [[nodiscard]] Stats stats() const;

private:
    [[nodiscard]] std::int64_t drawEstimate() const;

    std::int64_t lastVblank_ = 0, refresh_ = 0;
    std::optional<std::int64_t> lastTarget_;
    std::int64_t margin_ = kInitialMargin;
    int hits_ = 0;
    std::deque<std::int64_t> draws_;
    struct Sample {
        std::int64_t latency, presented;
        bool planned, missed;
    };
    std::deque<Sample> samples_;
    std::uint64_t discarded_ = 0;
};

}  // namespace radar::overlay
