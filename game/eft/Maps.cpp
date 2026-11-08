#include "game/eft/Maps.hpp"

#include <algorithm>
#include <cctype>

namespace radar::eft {

namespace {
bool equalsIgnoreCase(std::string_view a, std::string_view b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
               return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
           });
}
template <class List>
bool contains(const List& list, std::string_view id) {
    return std::any_of(list.begin(), list.end(), [&](std::string_view e) { return equalsIgnoreCase(e, id); });
}
}  // namespace

bool isLobbyLocation(std::string_view id) { return id.empty() || contains(kLobbyLocations, id); }

bool isRaidLocation(std::string_view id) { return !isLobbyLocation(id) && contains(kRaidLocations, id); }

}  // namespace radar::eft
