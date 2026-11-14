#include "server/Server.hpp"

#include "core/log/Log.hpp"
#include "server/Protocol.hpp"

#define CROW_DISABLE_STATIC_DIR  // we serve static files ourselves, with path checks
#include <crow.h>

#include <algorithm>
#include <fstream>
#include <future>
#include <map>
#include <sstream>
#include <unordered_map>
#include <vector>

namespace radar::server {

namespace fs = std::filesystem;

std::optional<fs::path> resolveUnder(const fs::path& root, std::string_view requestPath) {
    if (requestPath.find('\0') != std::string_view::npos) return std::nullopt;
    std::error_code ec;
    const fs::path base = fs::canonical(root, ec);
    if (ec) return std::nullopt;
    fs::path rel(requestPath);
    if (rel.is_absolute()) rel = rel.relative_path();
    const fs::path candidate = fs::weakly_canonical(base / rel, ec);
    if (ec) return std::nullopt;
    // candidate must be base itself or below it, compared component by component.
    auto [baseEnd, candidateIt] = std::mismatch(base.begin(), base.end(), candidate.begin(), candidate.end());
    if (baseEnd != base.end()) return std::nullopt;
    if (!fs::is_regular_file(candidate, ec)) return std::nullopt;
    return candidate;
}

bool originAllowed(std::string_view origin, std::string_view host) {
    if (origin.empty()) return true;  // not a browser (e.g. a script): nothing to protect against
    const auto scheme = origin.find("://");
    if (scheme == std::string_view::npos) return false;
    return origin.substr(scheme + 3) == host;
}

std::string buildMapsIndex(const fs::path& mapsRoot) {
    // folder -> entry; std::map keeps the list sorted by folder.
    std::map<std::string, crow::json::wvalue> maps;
    std::error_code ec;
    for (const auto& dir : fs::directory_iterator(mapsRoot / "3d", ec)) {
        if (!dir.is_directory()) continue;
        const fs::path configPath = dir.path() / "map.json";
        std::ifstream in(configPath);
        if (!in) continue;
        std::stringstream text;
        text << in.rdbuf();
        auto config = crow::json::load(text.str());
        if (!config || config.t() != crow::json::type::Object) {
            log::warn("maps: ignoring {}: not a valid JSON object", configPath.string());
            continue;
        }
        const std::string folder = dir.path().filename().string();
        crow::json::wvalue entry;
        entry["folder"] = folder;
        entry["config"] = crow::json::wvalue(config);
        maps.emplace(folder, std::move(entry));
    }
    std::vector<crow::json::wvalue> list;
    for (auto& [key, entry] : maps) list.push_back(std::move(entry));
    return crow::json::wvalue(std::move(list)).dump();
}

struct Server::Impl {
    ServerConfig config;
    MessageHub& hub;
    RaidRecorder* recorder;
    RecordingIndex recordings;
    crow::SimpleApp app;
    std::future<void> running;
    std::mutex connMutex;
    std::unordered_map<crow::websocket::connection*, MessageHub::ClientId> connections;

    Impl(ServerConfig c, MessageHub& h, RaidRecorder* r)
        : config(std::move(c)), hub(h), recorder(r), recordings(config.recordingsRoot) {}

    static crow::response file(const fs::path& root, std::string_view path) {
        const auto resolved = resolveUnder(root, path);
        if (!resolved) return crow::response(404);
        crow::response res;
        res.set_static_file_info_unsafe(resolved->string());  // already validated by resolveUnder
        return res;
    }

    void routes() {
        CROW_WEBSOCKET_ROUTE(app, "/ws")
            // Only pages served from this host may connect: otherwise any website open in the
            // browser could read the stream from 127.0.0.1.
            .onaccept([](const crow::request& req, void**) {
                const bool ok = originAllowed(req.get_header_value("Origin"), req.get_header_value("Host"));
                if (!ok)
                    log::warn("server: rejected WebSocket from origin '{}' (host '{}')", req.get_header_value("Origin"),
                              req.get_header_value("Host"));
                return ok;
            })
            .max_payload(64 * 1024)  // clients don't send anything meaningful yet
            .onopen([this](crow::websocket::connection& conn) {
                const auto id = hub.connect([&conn](const std::string& m) { conn.send_text(m); }, encodeHello(config.live));
                std::lock_guard lock(connMutex);
                connections[&conn] = id;
                log::info("server: client connected ({})", conn.get_remote_ip());
            })
            .onclose([this](crow::websocket::connection& conn, const std::string&, std::uint16_t) {
                std::lock_guard lock(connMutex);
                if (auto it = connections.find(&conn); it != connections.end()) {
                    hub.disconnect(it->second);
                    connections.erase(it);
                }
                log::info("server: client disconnected");
            })
            .onmessage([](crow::websocket::connection&, const std::string&, bool) {
                // No client → server messages yet.
            });

        CROW_ROUTE(app, "/maps/index.json")([this] {
            crow::response res(buildMapsIndex(config.mapsRoot));
            res.set_header("Content-Type", "application/json");
            res.set_header("Cache-Control", "no-cache");
            return res;
        });
        CROW_ROUTE(app, "/maps/<path>")([this](const std::string& path) { return file(config.mapsRoot, path); });
        CROW_ROUTE(app, "/api/recordings")([this] {
            const auto active = recorder ? recorder->flushActive() : std::nullopt;
            crow::response res(recordings.listJson(active));
            res.set_header("Content-Type", "application/json");
            res.set_header("Cache-Control", "no-cache");
            return res;
        });
        CROW_ROUTE(app, "/api/recordings/<string>")([this](const std::string& name) {
            if (!isRecordingName(name)) return crow::response(404);
            if (recorder) (void)recorder->flushActive();
            auto res = file(config.recordingsRoot, name);
            if (res.code != 200) return res;
            // Served as stored: the client unpacks .gz itself (no Content-Encoding, so the size is the file's).
            res.set_header("Content-Type", name.ends_with(".gz") ? "application/gzip" : "application/x-ndjson");
            res.set_header("Cache-Control", "no-cache");
            return res;
        });
        CROW_ROUTE(app, "/data/<path>")([this](const std::string& path) { return file(config.dataRoot, path); });
        CROW_ROUTE(app, "/")([this] { return file(config.webRoot, "index.html"); });
        CROW_ROUTE(app, "/<path>")([this](const std::string& path) { return file(config.webRoot, path); });
    }
};

Server::Server(ServerConfig config, MessageHub& hub, RaidRecorder* recorder)
    : impl_(std::make_unique<Impl>(std::move(config), hub, recorder)) {
    impl_->routes();
}

Server::~Server() { stop(); }

bool Server::start() {
    auto& app = impl_->app;
    app.loglevel(crow::LogLevel::Warning);
    app.bindaddr(impl_->config.bindAddress).port(impl_->config.port).concurrency(2).signal_clear();
    impl_->running = app.run_async();
    if (app.wait_for_server_start(std::chrono::milliseconds(3000)) != std::cv_status::no_timeout) {
        log::error("server: failed to start on {}:{}", impl_->config.bindAddress, impl_->config.port);
        return false;
    }
    log::info("server: http://{}:{}/ (web root {}, maps {})", impl_->config.bindAddress, app.port(),
              impl_->config.webRoot.string(), impl_->config.mapsRoot.string());
    return true;
}

void Server::stop() {
    if (impl_ && impl_->running.valid()) {
        impl_->app.stop();
        impl_->running.wait();
        impl_->running = {};
    }
}

std::uint16_t Server::port() const { return impl_->app.port(); }

}  // namespace radar::server
