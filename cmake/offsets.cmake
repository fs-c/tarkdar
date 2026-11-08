# Offsets are compile-time constants. The checked-in JSON is turned into a header at build time;
# no offset JSON is read at runtime. Game updates are rare for SPT, so regenerating the JSON and
# rebuilding is cheaper than maintaining runtime offset loading.

find_package(Python3 REQUIRED COMPONENTS Interpreter)

set(RADAR_OFFSETS_JSON ${PROJECT_SOURCE_DIR}/game/eft/offsets/eft.offsets.json)
set(RADAR_OFFSETS_GEN_DIR ${CMAKE_BINARY_DIR}/generated)
set(RADAR_OFFSETS_HEADER ${RADAR_OFFSETS_GEN_DIR}/eft_offsets.hpp)

add_custom_command(
    OUTPUT ${RADAR_OFFSETS_HEADER}
    COMMAND ${Python3_EXECUTABLE} ${PROJECT_SOURCE_DIR}/cmake/gen_offsets.py
            ${RADAR_OFFSETS_JSON} ${RADAR_OFFSETS_HEADER}
    DEPENDS ${RADAR_OFFSETS_JSON} ${PROJECT_SOURCE_DIR}/cmake/gen_offsets.py
    COMMENT "Generating eft_offsets.hpp"
    VERBATIM)

add_custom_target(radar_offsets_gen DEPENDS ${RADAR_OFFSETS_HEADER})
add_library(radar_offsets INTERFACE)
add_dependencies(radar_offsets radar_offsets_gen)
target_include_directories(radar_offsets INTERFACE ${RADAR_OFFSETS_GEN_DIR})
