# Developer tools for keeping game/eft/offsets/eft.offsets.json up to date (docs/offset-tools.md).

add_library(il2cpp_dump_lib STATIC il2cpp-dump/Dumper.cpp)
target_include_directories(il2cpp_dump_lib PUBLIC ${PROJECT_SOURCE_DIR})
target_link_libraries(il2cpp_dump_lib PUBLIC radar_core radar_offsets PRIVATE radar_warnings)

add_executable(il2cpp-dump il2cpp-dump/main.cpp)
target_link_libraries(il2cpp-dump PRIVATE il2cpp_dump_lib radar_vmm_backend radar_eft radar_warnings)

# Raw physical memory dumps for offline development.
add_executable(mem-dump mem-dump/main.cpp)
target_link_libraries(mem-dump PRIVATE radar_core radar_vmm_backend radar_warnings)

# Sanity check of the VMM/LeechCore setup (process list, kernel read), nothing game-specific.
add_executable(vmm-check vmm-check/main.cpp)
target_link_libraries(vmm-check PRIVATE radar_core radar_vmm_backend radar_warnings)

if(RADAR_BUILD_TESTS)
    add_executable(il2cpp-dump-tests il2cpp-dump/tests.cpp)
    target_link_libraries(il2cpp-dump-tests PRIVATE il2cpp_dump_lib radar_warnings)
    target_include_directories(il2cpp-dump-tests SYSTEM PRIVATE ${PROJECT_SOURCE_DIR}/third_party/doctest)
    add_test(NAME il2cpp-dump-tests COMMAND il2cpp-dump-tests)

    add_test(NAME update-offsets
        COMMAND ${Python3_EXECUTABLE} -m unittest -v test_update_offsets
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
    set_tests_properties(update-offsets PROPERTIES
        ENVIRONMENT "UPDATE_OFFSETS=${CMAKE_CURRENT_SOURCE_DIR}/update-offsets.py;OFFSETS_JSON=${RADAR_OFFSETS_JSON}")

    # scripts/assets.py (B2 data files) against a local mock of the B2 API.
    add_test(NAME assets-tool
        COMMAND ${Python3_EXECUTABLE} -m unittest -v test_assets
        WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}/scripts)
endif()
