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
    std::filesystem::path questProbe;    // --quest-probe: also dump quest templates there (implies --diagnose)
    std::filesystem::path localeProbe;   // --locale-probe: also dump the game's text table lookups there (implies --diagnose)
    std::optional<int> timeoutSeconds;   // give up if not attached in time
    bool verbose = false;

    radar::server::ServerConfig server;
    bool noServer = false;
    bool offline = false;                // no memory source: serve the frontend and the recordings only
    bool noRecord = false;               // don't record raids
    std::optional<int> keepRecordings;   // delete older recordings beyond this many

    // The overlay window (overlay/Config.hpp), configured from the frontend over the server.
    bool overlay = false;
    std::string overlayOutput;           // monitor (Wayland output name); empty: the compositor's choice
    bool overlayStretch = false;         // the game's picture is stretched to the monitor (e.g. 4:3 on 16:9)
    bool overlayImmediate = false;       // no late drawing (overlay::WindowOptions::pacing off)
    bool overlayTest = false;            // draw a test pattern and status (overlay::WindowOptions::test)
    std::string overlayFont;             // TrueType file for labels; empty: a system font
};

// Parses the command line. On error, returns nullopt and sets `error` (empty for --help).
[[nodiscard]] std::optional<Options> parseOptions(int argc, char** argv, std::string& error);
void printUsage(const char* argv0);

}  // namespace radar::app
