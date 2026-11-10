#pragma once

#include "core/mem/VmmBackend.hpp"
#include "server/Server.hpp"

#include <filesystem>
#include <optional>
#include <string>

namespace radar::app {

struct Options {
    radar::mem::VmmConfig vmm;           // --device etc.; required unless --offline
    bool once = false;                   // connectivity check only
    bool diagnose = false;               // one-shot check of the whole read chain
    std::optional<int> timeoutSeconds;   // give up if not attached in time
    bool verbose = false;

    radar::server::ServerConfig server;
    bool noServer = false;
    bool offline = false;                // no memory source: serve the frontend and the recordings only
    bool noRecord = false;               // don't record raids
    std::optional<int> keepRecordings;   // delete older recordings beyond this many
};

// Parses the command line. On error, returns nullopt and sets `error` (empty for --help).
[[nodiscard]] std::optional<Options> parseOptions(int argc, char** argv, std::string& error);
void printUsage(const char* argv0);

}  // namespace radar::app
