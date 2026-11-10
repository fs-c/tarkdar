cmake_minimum_required(VERSION 3.20)
project(radar C CXX)

option(RADAR_WITH_LIBUSB "Link LeechCore against libusb (its headers require it unless patched out)" ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "" FORCE)
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# One output directory for everything (see cmake/vmm.cmake for why).
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
if(APPLE)
    set(CMAKE_BUILD_RPATH  "@loader_path")
    set(CMAKE_INSTALL_RPATH "@loader_path")
else()
    set(CMAKE_BUILD_RPATH  "\$ORIGIN")
    set(CMAKE_INSTALL_RPATH "\$ORIGIN")
endif()

include(cmake/vmm.cmake)
include(cmake/offsets.cmake)

# Warnings for our own code only.
add_library(radar_warnings INTERFACE)
target_compile_options(radar_warnings INTERFACE -Wall -Wextra -Wpedantic -Wshadow -Wconversion
    -Wno-sign-conversion)

add_subdirectory(core)
add_subdirectory(game)
add_subdirectory(server)
add_subdirectory(app)

option(RADAR_BUILD_TESTS "Build unit tests" ON)
if(RADAR_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

add_subdirectory(tools)
