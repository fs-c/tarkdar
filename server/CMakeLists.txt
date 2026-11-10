# Crow (header-only) on standalone Asio.
add_library(crow INTERFACE)
target_include_directories(crow SYSTEM INTERFACE
    ${PROJECT_SOURCE_DIR}/third_party/Crow/include
    ${PROJECT_SOURCE_DIR}/third_party/asio/asio/include)
target_compile_definitions(crow INTERFACE ASIO_STANDALONE)
target_link_libraries(crow INTERFACE Threads::Threads)

add_library(radar_server STATIC
    Feeds.cpp
    MessageHub.cpp
    Protocol.cpp
    Recorder.cpp
    Server.cpp
)
find_package(ZLIB REQUIRED)
target_link_libraries(radar_server PUBLIC radar_eft PRIVATE crow ZLIB::ZLIB radar_warnings)
