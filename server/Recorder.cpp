#include "server/Recorder.hpp"

#include "core/log/Log.hpp"
#include "server/Protocol.hpp"

#include <crow/json.h>
#include <zlib.h>

#include <algorithm>
#include <cctype>
#include <ctime>
#include <set>

namespace radar::server {

namespace fs = std::filesystem;

namespace {

std::int64_t systemNowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

bool sameLoot(const eft::LootEntry& a, const eft::LootEntry& b) {
    return a.kind == b.kind && a.templateId == b.templateId && a.objectName == b.objectName &&
           a.position == b.position && a.contents == b.contents;
}

int playerFlags(const eft::PlayerState& p) { return (p.dead ? 1 : 0) | (p.absent ? 2 : 0); }

// "2026-11-10_19-03-12_bigmap.jsonl", in local time; a suffix if it exists already.
fs::path recordingPath(const fs::path& dir, std::int64_t nowMs, const std::string& locationId) {
    const std::time_t secs = static_cast<std::time_t>(nowMs / 1000);
    std::tm tm{};
    localtime_r(&secs, &tm);
    char stamp[32];
    std::strftime(stamp, sizeof stamp, "%Y-%m-%d_%H-%M-%S", &tm);
    std::string location;
    for (char c : locationId)
        location += (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_') ? c : '_';
    if (location.empty()) location = "unknown";
    const std::string base = std::string(stamp) + "_" + location;
    fs::path path = dir / (base + ".jsonl");
    for (int n = 2; fs::exists(path) || fs::exists(path.string() + ".gz"); ++n)
        path = dir / (base + "-" + std::to_string(n) + ".jsonl");
    return path;
}

bool endsWith(std::string_view s, std::string_view suffix) {
    return s.size() >= suffix.size() && s.substr(s.size() - suffix.size()) == suffix;
}

}  // namespace

bool isRecordingName(std::string_view name) {
    if (name.empty() || name.front() == '.' || name.find('/') != std::string_view::npos ||
        name.find('\\') != std::string_view::npos || name.find('\0') != std::string_view::npos)
        return false;
    return endsWith(name, ".jsonl") || endsWith(name, ".jsonl.gz");
}

bool gzipFile(const fs::path& from, const fs::path& to) {
    std::ifstream in(from, std::ios::binary);
    if (!in) return false;
    const fs::path tmp = to.string() + ".tmp";
    gzFile out = gzopen(tmp.c_str(), "wb6");
    if (!out) return false;
    std::vector<char> buf(1 << 20);
    bool ok = true;
    while (ok && in) {
        in.read(buf.data(), static_cast<std::streamsize>(buf.size()));
        const auto n = in.gcount();
        if (n > 0 && gzwrite(out, buf.data(), static_cast<unsigned>(n)) != static_cast<int>(n)) ok = false;
    }
    if (in.bad()) ok = false;
    if (gzclose(out) != Z_OK) ok = false;
    std::error_code ec;
    if (ok) fs::rename(tmp, to, ec);
    if (!ok || ec) {
        fs::remove(tmp, ec);
        return false;
    }
    return true;
}

// ---- RaidRecorder -------------------------------------------------------------------------------

RaidRecorder::RaidRecorder(Config config, Clock now) : config_(std::move(config)), now_(std::move(now)) {
    if (!now_) now_ = systemNowMs;
}

RaidRecorder::~RaidRecorder() {
    finish();
    if (compressor_.joinable()) compressor_.join();
}

void RaidRecorder::onStatus(const eft::Status& status, const std::string& message) {
    std::lock_guard lock(mutex_);
    const bool inRaid = status.state == eft::Status::State::InRaid && status.raidId != 0;
    if (out_.is_open() && (!inRaid || status.raidId != raidId_)) {
        write("status", message);  // the file ends with the status that ended the raid
        finishLocked();
    }
    if (inRaid && !out_.is_open()) start(status);
    if (out_.is_open()) write("status", message);
}

void RaidRecorder::start(const eft::Status& status) {
    std::error_code ec;
    fs::create_directories(config_.dir, ec);
    prune();
    file_ = recordingPath(config_.dir, now_(), status.locationId);
    out_.open(file_, std::ios::out | std::ios::trunc);
    if (!out_) {
        log::error("recorder: can't write {}", file_.string());
        out_.close();
        return;
    }
    raidId_ = status.raidId;
    lastFlush_ = now_();
    lastPlayersWrite_ = 0;
    pendingPlayers_.clear();
    playerFlags_.clear();
    lastLoot_.reset();
    lastLootKeyframe_ = 0;
    stats_.clear();
    log::info("recorder: recording raid {} to {}", raidId_, file_.string());
    write("recording", encodeRecordingHeader(status));
    // Snapshots of this raid published before its status said so. Status is written by the caller.
    for (const auto& [type, latest] : latest_)
        if (latest.raidId == raidId_ && type != "loot" && type != "players") write(type, latest.message);
    if (const auto it = latest_.find("players"); it != latest_.end() && it->second.raidId == raidId_ && earlyPlayers_)
        writePlayers(*earlyPlayers_, it->second.message, now_());
    earlyPlayers_.reset();
    if (const auto it = latest_.find("loot"); it != latest_.end() && it->second.raidId == raidId_ && earlyLoot_) {
        write("loot", it->second.message);
        lastLootKeyframe_ = now_();
        lastLoot_ = std::move(earlyLoot_);
    }
    earlyLoot_.reset();
}

void RaidRecorder::onPlayers(const eft::PlayersSnapshot& players, const std::string& message) {
    std::lock_guard lock(mutex_);
    latest_["players"] = {players.raidId, message};
    if (!recording(players.raidId)) {
        if (players.raidId != 0) earlyPlayers_ = players;
        return;
    }
    // Someone appeared, died, left or vanished: write at once, whatever the throttle says.
    bool changed = players.players.size() != playerFlags_.size();
    for (const auto& p : players.players) {
        const auto it = playerFlags_.find(p.id);
        if (it == playerFlags_.end() || it->second != playerFlags(p)) changed = true;
    }
    const auto now = now_();
    if (changed || now - lastPlayersWrite_ >= config_.playersInterval.count()) writePlayers(players, message, now);
    else pendingPlayers_ = message;
}

void RaidRecorder::writePlayers(const eft::PlayersSnapshot& players, const std::string& message, std::int64_t now) {
    write("players", message);
    lastPlayersWrite_ = now;
    pendingPlayers_.clear();
    playerFlags_.clear();
    for (const auto& p : players.players) playerFlags_[p.id] = playerFlags(p);
}

void RaidRecorder::onLoot(const eft::LootSnapshot& loot, const std::string& message) {
    std::lock_guard lock(mutex_);
    latest_["loot"] = {loot.raidId, message};
    if (recording(loot.raidId)) writeLoot(loot, message);
    else if (loot.raidId != 0) earlyLoot_ = loot;
}

void RaidRecorder::writeLoot(const eft::LootSnapshot& loot, const std::string& message) {
    const auto now = now_();
    if (!lastLoot_ || now - lastLootKeyframe_ >= config_.lootKeyframeInterval.count()) {
        write("loot", message);
        lastLootKeyframe_ = now;
        lastLoot_ = loot;
        return;
    }
    std::unordered_map<std::uint32_t, const eft::LootEntry*> before;
    before.reserve(lastLoot_->loot.size());
    for (const auto& l : lastLoot_->loot) before.emplace(l.id, &l);
    std::vector<const eft::LootEntry*> added, changed;
    std::vector<std::uint32_t> removed;
    for (const auto& l : loot.loot) {
        const auto it = before.find(l.id);
        if (it == before.end()) added.push_back(&l);
        else {
            if (!sameLoot(*it->second, l)) changed.push_back(&l);
            before.erase(it);
        }
    }
    for (const auto& [id, entry] : before) removed.push_back(id);
    std::sort(removed.begin(), removed.end());
    if (!added.empty() || !removed.empty() || !changed.empty())
        write("lootDiff", encodeLootDiff(loot.raidId, loot.revision, added, removed, changed));
    lastLoot_ = loot;
}

void RaidRecorder::onMessage(const std::string& type, std::uint64_t raidId, const std::string& message) {
    std::lock_guard lock(mutex_);
    latest_[type] = {raidId, message};
    if (recording(raidId)) write(type, message);
}

void RaidRecorder::write(const std::string& type, const std::string& line) {
    out_ << line << '\n';
    auto& [lines, bytes] = stats_[type];
    ++lines;
    bytes += line.size() + 1;
    const auto now = now_();
    if (now - lastFlush_ >= config_.flushInterval.count()) {
        out_.flush();
        lastFlush_ = now;
    }
}

std::optional<std::string> RaidRecorder::flushActive() {
    std::lock_guard lock(mutex_);
    if (!out_.is_open()) return std::nullopt;
    out_.flush();
    lastFlush_ = now_();
    return file_.filename().string();
}

void RaidRecorder::finish() {
    std::lock_guard lock(mutex_);
    finishLocked();
}

void RaidRecorder::finishLocked() {
    if (!out_.is_open()) return;
    if (!pendingPlayers_.empty()) write("players", pendingPlayers_);
    pendingPlayers_.clear();
    out_.close();
    std::string summary;
    std::size_t total = 0;
    for (const auto& [type, s] : stats_) {
        summary += std::format(" {} {}×/{:.1f} MB", type, s.first, static_cast<double>(s.second) / 1e6);
        total += s.second;
    }
    log::info("recorder: raid {} done, {:.1f} MB:{}", raidId_, static_cast<double>(total) / 1e6, summary);
    raidId_ = 0;
    if (!config_.compress) return;
    if (compressor_.joinable()) compressor_.join();
    compressor_ = std::jthread([file = file_] {
        const fs::path gz = file.string() + ".gz";
        if (!gzipFile(file, gz)) {
            log::warn("recorder: couldn't compress {}; leaving it as is", file.string());
            return;
        }
        std::error_code ec;
        fs::remove(file, ec);
    });
}

void RaidRecorder::prune() {
    if (!config_.keep) return;
    std::vector<fs::directory_entry> files;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(config_.dir, ec))
        if (e.is_regular_file() && isRecordingName(e.path().filename().string())) files.push_back(e);
    if (static_cast<int>(files.size()) < *config_.keep) return;
    std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) { return a.last_write_time() > b.last_write_time(); });
    // The new recording counts too: keep `keep - 1` old ones.
    for (std::size_t i = static_cast<std::size_t>(std::max(*config_.keep - 1, 0)); i < files.size(); ++i) {
        log::info("recorder: deleting old recording {}", files[i].path().filename().string());
        fs::remove(files[i].path(), ec);
    }
}

// ---- RecordingIndex -----------------------------------------------------------------------------

namespace {

std::optional<crow::json::rvalue> parseLine(const std::string& line) {
    auto json = crow::json::load(line);
    if (!json || json.t() != crow::json::type::Object) return std::nullopt;
    return json;
}

std::optional<std::int64_t> lineTime(const std::string& line) {
    auto json = parseLine(line);
    if (!json || !json->has("t") || (*json)["t"].t() != crow::json::type::Number) return std::nullopt;
    return (*json)["t"].i();
}

// Location from a header ("recording") or status line.
std::optional<std::string> lineLocation(const std::string& line) {
    if (line.find("\"locationId\"") == std::string::npos) return std::nullopt;
    auto json = parseLine(line);
    if (!json || !json->has("data")) return std::nullopt;
    const auto& data = (*json)["data"];
    if (data.t() != crow::json::type::Object || !data.has("locationId") ||
        data["locationId"].t() != crow::json::type::String)
        return std::nullopt;
    return std::string(data["locationId"].s());
}

// Reads a recording (plain or gzipped) for its location and time span.
void scan(const fs::path& path, RecordingInfo& info, bool wantEnd) {
    gzFile in = gzopen(path.c_str(), "rb");
    if (!in) return;
    gzbuffer(in, 1 << 18);
    std::vector<char> buf(1 << 20);
    std::string line, last, prev;
    bool first = true;
    const auto takeLine = [&] {
        if (line.empty()) return;
        if (first) {
            info.start = lineTime(line);
            first = false;
        }
        if (!info.locationId) info.locationId = lineLocation(line);
        prev = std::move(last);
        last = std::move(line);
        line.clear();
    };
    for (;;) {
        // Without the end, stop once the start and location are known.
        if (!wantEnd && info.start && info.locationId) break;
        const int n = gzread(in, buf.data(), static_cast<unsigned>(buf.size()));
        if (n <= 0) break;
        for (int i = 0; i < n; ++i) {
            if (buf[i] == '\n') takeLine();
            else line += buf[i];
        }
    }
    gzclose(in);
    takeLine();  // a last line without newline (possibly cut off)
    if (wantEnd) {
        info.end = lineTime(last);
        if (!info.end) info.end = lineTime(prev);
    }
}

}  // namespace

std::vector<RecordingInfo> RecordingIndex::list(const std::optional<std::string>& active) {
    std::lock_guard lock(mutex_);
    std::vector<RecordingInfo> result;
    std::set<std::string> names;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir_, ec)) {
        const auto name = e.path().filename().string();
        if (e.is_regular_file() && isRecordingName(name)) names.insert(name);
    }
    for (const auto& name : names) {
        // Mid-compression both exist; the plain one is about to go.
        if (endsWith(name, ".jsonl") && names.contains(name + ".gz")) continue;
        const fs::path path = dir_ / name;
        const bool isActive = active && *active == name;
        const auto size = fs::file_size(path, ec);
        if (ec) continue;
        const auto mtime = fs::last_write_time(path, ec);
        auto& cached = cache_[name];
        if (isActive || cached.size != size || cached.mtime != mtime || cached.info.name.empty()) {
            RecordingInfo info{.name = name, .size = size};
            scan(path, info, /*wantEnd*/ !isActive);
            cached = {size, mtime, std::move(info)};
        }
        auto info = cached.info;
        info.size = size;
        info.active = isActive;
        if (isActive) info.end.reset();
        result.push_back(std::move(info));
    }
    // Forget files that are gone.
    std::erase_if(cache_, [&](const auto& kv) { return !names.contains(kv.first); });
    std::sort(result.begin(), result.end(), [](const RecordingInfo& a, const RecordingInfo& b) {
        return a.start.value_or(0) != b.start.value_or(0) ? a.start.value_or(0) > b.start.value_or(0) : a.name > b.name;
    });
    return result;
}

std::string RecordingIndex::listJson(const std::optional<std::string>& active) {
    std::vector<crow::json::wvalue> list;
    for (const auto& r : this->list(active)) {
        crow::json::wvalue v;
        v["name"] = r.name;
        v["size"] = static_cast<std::uint64_t>(r.size);
        if (r.locationId) v["locationId"] = *r.locationId;
        else v["locationId"] = nullptr;
        if (r.start) v["start"] = *r.start;
        else v["start"] = nullptr;
        if (r.end) v["end"] = *r.end;
        else v["end"] = nullptr;
        v["active"] = r.active;
        list.push_back(std::move(v));
    }
    return crow::json::wvalue(std::move(list)).dump();
}

}  // namespace radar::server
