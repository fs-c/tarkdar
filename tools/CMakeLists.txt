# Developer tools for keeping game/eft/offsets/eft.offsets.json up to date (docs/offset-tools.md).

add_library(il2cpp_dump_lib STATIC il2cpp-dump/Dumper.cpp il2cpp-dump/PatternScan.cpp)
target_include_directories(il2cpp_dump_lib PUBLIC ${PROJECT_SOURCE_DIR})
target_link_libraries(il2cpp_dump_lib PUBLIC radar_core radar_offsets PRIVATE radar_warnings)

add_executable(il2cpp-dump il2cpp-dump/main.cpp)
target_link_libraries(il2cpp-dump PRIVATE il2cpp_dump_lib radar_vmm_backend radar_eft radar_warnings)

# One-shot check of the whole read chain (best run in a raid); the library is linked by the tests too.
add_library(radar_diagnose STATIC diagnose/Diagnose.cpp)
target_include_directories(radar_diagnose PUBLIC ${PROJECT_SOURCE_DIR})
target_link_libraries(radar_diagnose PUBLIC radar_core radar_eft PRIVATE radar_warnings)

add_executable(radar-diagnose diagnose/main.cpp)
target_link_libraries(radar-diagnose PRIVATE radar_diagnose radar_vmm_backend radar_warnings)

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

    # Python tests: they locate their inputs relative to themselves.
    add_test(NAME gen-offsets
        COMMAND ${Python3_EXECUTABLE} -m unittest -v test_gen_offsets
        WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}/cmake)
    add_test(NAME update-offsets
        COMMAND ${Python3_EXECUTABLE} -m unittest -v test_update_offsets
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

    # tools/assets.py (asset store) against a temporary local-directory store (needs rclone).
    # unittest exits 0 when everything is skipped; ctest reports that as "Skipped".
    add_test(NAME assets-tool
        COMMAND ${Python3_EXECUTABLE} -m unittest -v test_assets
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
    set_tests_properties(assets-tool PROPERTIES SKIP_REGULAR_EXPRESSION "OK \\(skipped=")

    # The 3D map builder's unit tests, when its venv is set up (make -C tools/maps3d install).
    if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/maps3d/.venv/bin/python)
        add_test(NAME maps3d
            COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/maps3d/.venv/bin/python -m unittest discover -s . -t .
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/maps3d)
    else()
        message(STATUS "maps3d tests skipped: tools/maps3d/.venv not found")
    endif()
endif()

# Interactive memory inspector (qwords with pointer/string/class hints, dwords/floats, raw dumps),
# for working out engine layouts by hand.
add_executable(mem-peek mem-peek/main.cpp)
target_include_directories(mem-peek PRIVATE ${PROJECT_SOURCE_DIR})
target_link_libraries(mem-peek PRIVATE radar_eft radar_vmm_backend radar_warnings)
