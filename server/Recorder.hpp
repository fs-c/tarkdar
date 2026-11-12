#pragma once

#include "game/eft/Status.hpp"
#include "game/eft/model/Players.hpp"
#include "game/eft/model/World.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

// Raid recordings: one file per raid, written while it runs (docs/protocol.md, "Raid recordings").
namespace radar::server {

// Records every raid to its own file in `dir`, from the same messages the live stream sends:
//   - a "recording" header line first, then the messages as they happen;
//   - players at most every `playersInterval` (and at once when someone dies, leaves or appears);
//   - skeletons at most every `skeletonsInterval` (the ones in between are dropped);
//   - loot as a full "loot" keyframe at the start and every `lootKeyframeInterval`, "lootDiff" lines
//     in between.
// A finished recording is gzipped in the background (<name>.jsonl → <name>.jsonl.gz).
// Fed by LiveFeed (one thread); flushActive() may be called from any thread.
class RaidRecorder {
public:
    struct Config {
        std::filesystem::path dir = "recordings";
        std::chrono::milliseconds playersInterval{100};
        std::chrono::milliseconds skeletonsInterval{200};
        std::chrono::milliseconds lootKeyframeInterval{60'000};
        std::chrono::milliseconds flushInterval{1'000};
        // Finished recordings to keep; older ones are deleted when a raid starts. nullopt: keep all.
        std::optional<int> keep{};
        bool compress = true;
    };
    // Current time in ms (injectable for tests).
    using Clock = std::function<std::int64_t()>;

    explicit RaidRecorder(Config config, Clock now = {});
    ~RaidRecorder();  // finishes the active recording and waits for compression

    RaidRecorder(const RaidRecorder&) = delete;
    RaidRecorder& operator=(const RaidRecorder&) = delete;

    // Starts a recording when a raid starts, finishes it when the raid ends.
    void onStatus(const eft::Status& status, const std::string& message);
    void onPlayers(const eft::PlayersSnapshot& players, const std::string& message);
    void onLoot(const eft::LootSnapshot& loot, const std::string& message);
    void onSkeletons(std::uint64_t raidId, const std::string& message);
    // Other per-raid messages (exfils, explosives, equipment): written as they are.
    void onMessage(const std::string& type, std::uint64_t raidId, const std::string& message);

    // Flushes the active recording and returns its file name; nullopt outside a raid.
    std::optional<std::string> flushActive();
    // Finishes the active recording (if any) now.
    void finish();

private:
    struct Latest {
        std::uint64_t raidId = 0;
        std::string message;
    };

    void start(const eft::Status& status);
    void finishLocked();
    void write(const std::string& type, const std::string& line);
    void writePlayers(const eft::PlayersSnapshot& players, const std::string& message, std::int64_t now);
    void writeLoot(const eft::LootSnapshot& loot, const std::string& message);
    void prune();
    [[nodiscard]] bool recording(std::uint64_t raidId) const { return out_.is_open() && raidId == raidId_; }

    Config config_;
    Clock now_;
    mutable std::mutex mutex_;

    std::ofstream out_;
    std::filesystem::path file_;
    std::uint64_t raidId_ = 0;
    std::int64_t lastFlush_ = 0;

    // Latest message per type, so a recording that starts after a raid's first snapshots still gets them.
    std::map<std::string, Latest> latest_;

    // Players throttling.
    std::int64_t lastPlayersWrite_ = 0;
    std::string pendingPlayers_;  // newest players message not written yet (written on finish)
    std::unordered_map<std::uint32_t, int> playerFlags_;  // id → dead/absent bits as last written
    std::optional<eft::PlayersSnapshot> earlyPlayers_;    // this raid's players from before the recording started
    std::int64_t lastSkeletonsWrite_ = 0;

    // Loot diffing: the loot as last written, and when the last keyframe was.
    std::optional<eft::LootSnapshot> lastLoot_;
    std::optional<eft::LootSnapshot> earlyLoot_;  // this raid's loot from before the recording started
    std::int64_t lastLootKeyframe_ = 0;

    // Stats for the end-of-raid log line.
    std::map<std::string, std::pair<std::size_t, std::size_t>> stats_;  // type → (lines, bytes)

    std::jthread compressor_;
};

// Gzips `from` into `to` (via a temporary file, renamed when complete). Returns false on failure.
bool gzipFile(const std::filesystem::path& from, const std::filesystem::path& to);

// A recording file in the recordings directory.
struct RecordingInfo {
    std::string name;  // file name
    std::uintmax_t size = 0;
    std::optional<std::string> locationId{};
    std::optional<std::int64_t> start{}, end{};  // ms since the Unix epoch; end unknown while active
    bool active = false;
};

// Recordings (*.jsonl, *.jsonl.gz) in `dir`, newest first. Reads each file once (cached by size and
// modification time) for its location and time span. The active recording isn't scanned for its end.
class RecordingIndex {
public:
    explicit RecordingIndex(std::filesystem::path dir) : dir_(std::move(dir)) {}
    [[nodiscard]] std::vector<RecordingInfo> list(const std::optional<std::string>& active);
    // JSON array of the list (docs/protocol.md).
    [[nodiscard]] std::string listJson(const std::optional<std::string>& active);

    [[nodiscard]] const std::filesystem::path& dir() const { return dir_; }

private:
    struct Cached {
        std::uintmax_t size = 0;
        std::filesystem::file_time_type mtime;
        RecordingInfo info;
    };
    std::filesystem::path dir_;
    std::mutex mutex_;
    std::unordered_map<std::string, Cached> cache_;
};

// Whether `name` is a plain recording file name (no path parts, .jsonl or .jsonl.gz).
[[nodiscard]] bool isRecordingName(std::string_view name);

}  // namespace radar::server
