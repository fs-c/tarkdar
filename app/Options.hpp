#pragma once

#include "core/mem/VmmBackend.hpp"
#include "server/Server.hpp"

#include <filesystem>
#include <optional>
#include <string>

namespace radar::app {

struct Options {
    radar::mem::VmmConfig vmm;           // --device etc.; required unless replaying
    bool once = false;                   // connectivity check only
    bool diagnose = false;               // one-shot check of the whole read chain
    std::optional<int> timeoutSeconds;   // give up if not attached in time
    bool verbose = false;

    radar::server::ServerConfig server;
    bool noServer = false;
    std::optional<std::filesystem::path> record;  // append the message stream to this file
    std::optional<std::filesystem::path> replay;  // serve a recorded stream instead of a live game
    double replaySpeed = 1.0;
    bool replayLoop = true;
};

// Parses the command line. On error, returns nullopt and sets `error` (empty for --help).
[[nodiscard]] std::optional<Options> parseOptions(int argc, char** argv, std::string& error);
void printUsage(const char* argv0);

}  // namespace radar::app
