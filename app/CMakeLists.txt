add_library(radar_app STATIC Diagnose.cpp Options.cpp)
target_link_libraries(radar_app PUBLIC radar_core radar_vmm_backend radar_eft radar_server radar_overlay PRIVATE radar_warnings)
if(TARGET radar_overlay_window)
    target_link_libraries(radar_app PUBLIC radar_overlay_window)
endif()

add_executable(radar-backend main.cpp)
target_link_libraries(radar-backend PRIVATE radar_app radar_warnings)
