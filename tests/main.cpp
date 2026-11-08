#define DOCTEST_CONFIG_IMPLEMENT
#include <doctest/doctest.h>

#include "core/log/Log.hpp"

int main(int argc, char** argv) {
    // Expected failures in tests log errors; keep the output readable. Pass --verbose-log to see them.
    bool verbose = false;
    for (int i = 1; i < argc; ++i)
        if (std::string_view(argv[i]) == "--verbose-log") verbose = true;
    radar::log::setMinLevel(verbose ? radar::log::Level::Debug : radar::log::Level::Off);
    doctest::Context context(argc, argv);
    return context.run();
}
