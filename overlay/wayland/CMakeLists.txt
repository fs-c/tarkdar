# Protocol code generated with wayland-scanner: wlr-layer-shell (protocols/, from wlroots'
# wlr-protocols), xdg-shell, which it refers to, and presentation-time (both from the system's
# wayland-protocols).
set(gen ${CMAKE_CURRENT_BINARY_DIR}/protocols)
file(MAKE_DIRECTORY ${gen})
set(protocol_sources)
foreach(spec
        "${CMAKE_CURRENT_SOURCE_DIR}/protocols/wlr-layer-shell-unstable-v1.xml"
        "${RADAR_WAYLAND_PROTOCOLS}/stable/xdg-shell/xdg-shell.xml"
        "${RADAR_WAYLAND_PROTOCOLS}/stable/presentation-time/presentation-time.xml")
    get_filename_component(name ${spec} NAME_WE)
    add_custom_command(
        OUTPUT ${gen}/${name}-client-protocol.h ${gen}/${name}-protocol.c
        COMMAND ${RADAR_WAYLAND_SCANNER} client-header ${spec} ${gen}/${name}-client-protocol.h
        COMMAND ${RADAR_WAYLAND_SCANNER} private-code ${spec} ${gen}/${name}-protocol.c
        DEPENDS ${spec}
        VERBATIM)
    list(APPEND protocol_sources ${gen}/${name}-client-protocol.h ${gen}/${name}-protocol.c)
endforeach()

# Dear ImGui: its draw lists and font atlas, rendered with its OpenGL ES 3 backend.
set(imgui ${PROJECT_SOURCE_DIR}/third_party/imgui)
add_library(radar_imgui STATIC
    ${imgui}/imgui.cpp ${imgui}/imgui_draw.cpp ${imgui}/imgui_tables.cpp ${imgui}/imgui_widgets.cpp
    ${imgui}/backends/imgui_impl_opengl3.cpp)
target_include_directories(radar_imgui SYSTEM PUBLIC ${imgui})
target_compile_definitions(radar_imgui PUBLIC IMGUI_IMPL_OPENGL_ES3 IMGUI_DISABLE_DEMO_WINDOWS
                                              IMGUI_DISABLE_DEBUG_TOOLS)
target_link_libraries(radar_imgui PUBLIC PkgConfig::RADAR_WAYLAND)

add_library(radar_wayland_protocols STATIC ${protocol_sources})
target_include_directories(radar_wayland_protocols SYSTEM PUBLIC ${gen})
target_link_libraries(radar_wayland_protocols PUBLIC PkgConfig::RADAR_WAYLAND)

add_library(radar_overlay_window STATIC WaylandWindow.cpp)
target_link_libraries(radar_overlay_window PUBLIC radar_overlay
    PRIVATE radar_imgui radar_wayland_protocols PkgConfig::RADAR_WAYLAND radar_warnings)
target_compile_definitions(radar_overlay_window INTERFACE RADAR_HAVE_OVERLAY_WINDOW)

# The window with a made-up scene (Demo.cpp), for checking it on a desktop without the game.
add_executable(radar-overlay-demo Demo.cpp)
target_link_libraries(radar-overlay-demo PRIVATE radar_overlay_window radar_warnings)
