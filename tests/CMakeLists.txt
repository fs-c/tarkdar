add_library(doctest INTERFACE)
target_include_directories(doctest SYSTEM INTERFACE ${PROJECT_SOURCE_DIR}/third_party/doctest)

add_executable(radar-tests main.cpp mem_tests.cpp il2cpp_tests.cpp unity_tests.cpp eft_tests.cpp raid_tests.cpp players_tests.cpp server_tests.cpp world_tests.cpp items_tests.cpp diagnose_tests.cpp camera_tests.cpp overlay_tests.cpp sched_tests.cpp)
find_package(ZLIB REQUIRED)
target_link_libraries(radar-tests PRIVATE radar_core radar_eft radar_server radar_diagnose doctest ZLIB::ZLIB radar_warnings)
add_test(NAME radar-tests COMMAND radar-tests)
