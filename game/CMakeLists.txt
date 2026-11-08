add_library(radar_eft STATIC
    eft/BuildCheck.cpp
    eft/Game.cpp
    eft/Lifecycle.cpp
    eft/Maps.cpp
    eft/raid/RaidFinder.cpp
    eft/raid/RaidMonitor.cpp
    eft/raid/Roster.cpp
    eft/players/Players.cpp
    eft/players/Skeleton.cpp
    eft/Read.cpp
    eft/items/ItemTree.cpp
    eft/world/Exfils.cpp
    eft/world/Explosives.cpp
    eft/world/Loot.cpp
)
target_link_libraries(radar_eft PUBLIC radar_core radar_offsets PRIVATE radar_warnings)
