# EXPERIMENT, SHELVED: the overlay didn't pan out and is not being developed. It still builds and
# its tests run so it doesn't rot unnoticed, but known issues in here are not being worked on
# (docs/design.md, "Layers").
#
# The overlay (overlay/Config.hpp): frames to draw, independent of any window system.
add_library(radar_overlay STATIC Frames.cpp Pacing.cpp Scene.cpp)
target_link_libraries(radar_overlay PUBLIC radar_core radar_eft PRIVATE radar_warnings)

# The overlay's window: Wayland (layer-shell), EGL and OpenGL ES 3. AUTO builds it when its
# libraries are found (radar-backend --overlay is only available then).
set(RADAR_OVERLAY_WINDOW AUTO CACHE STRING "Build the overlay window (Wayland): AUTO, ON or OFF")
set_property(CACHE RADAR_OVERLAY_WINDOW PROPERTY STRINGS AUTO ON OFF)
if(NOT RADAR_OVERLAY_WINDOW STREQUAL "OFF")
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(RADAR_WAYLAND QUIET IMPORTED_TARGET wayland-client wayland-egl egl glesv2)
        pkg_get_variable(RADAR_WAYLAND_PROTOCOLS wayland-protocols pkgdatadir)
    endif()
    find_program(RADAR_WAYLAND_SCANNER wayland-scanner)
    if(RADAR_WAYLAND_FOUND AND RADAR_WAYLAND_PROTOCOLS AND RADAR_WAYLAND_SCANNER)
        add_subdirectory(wayland)
        message(STATUS "overlay window: Wayland")
    elseif(RADAR_OVERLAY_WINDOW STREQUAL "ON")
        message(FATAL_ERROR "overlay window: needs wayland-client, wayland-egl, egl, glesv2, wayland-protocols and "
                            "wayland-scanner (Debian: libwayland-dev wayland-protocols libegl-dev libgles-dev)")
    else()
        message(STATUS "overlay window: not built (Wayland, EGL or OpenGL ES development files not found)")
    endif()
endif()
