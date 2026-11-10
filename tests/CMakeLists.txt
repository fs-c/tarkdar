add_library(doctest INTERFACE)
target_include_directories(doctest SYSTEM INTERFACE ${PROJECT_SOURCE_DIR}/third_party/doctest)

add_executable(radar-tests main.cpp mem_tests.cpp il2cpp_tests.cpp unity_tests.cpp eft_tests.cpp raid_tests.cpp players_tests.cpp server_tests.cpp world_tests.cpp items_tests.cpp diagnose_tests.cpp)
find_package(ZLIB REQUIRED)
target_link_libraries(radar-tests PRIVATE radar_core radar_eft radar_server radar_app doctest ZLIB::ZLIB radar_warnings)
add_test(NAME radar-tests COMMAND radar-tests)

add_test(NAME gen-offsets
    COMMAND ${Python3_EXECUTABLE} -m unittest -v test_gen_offsets
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
set_tests_properties(gen-offsets PROPERTIES
    ENVIRONMENT "GEN_OFFSETS=${PROJECT_SOURCE_DIR}/cmake/gen_offsets.py;OFFSETS_JSON=${RADAR_OFFSETS_JSON}")
