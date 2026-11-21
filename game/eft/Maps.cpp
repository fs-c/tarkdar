#include "game/eft/Maps.hpp"

#include "core/text/Ascii.hpp"

#include <algorithm>

namespace radar::eft {

namespace {
template <class List>
bool contains(const List& list, std::string_view id) {
    return std::any_of(list.begin(), list.end(), [&](std::string_view e) { return text::equalsIgnoreCase(e, id); });
}
}  // namespace

bool isLobbyLocation(std::string_view id) { return id.empty() || contains(kLobbyLocations, id); }

bool isRaidLocation(std::string_view id) { return contains(kRaidLocations, id); }

}  // namespace radar::eft
