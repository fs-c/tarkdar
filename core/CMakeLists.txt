add_library(radar_core STATIC
    log/Log.cpp
    mem/MemoryView.cpp
    mem/PatternScan.cpp
    mem/Pe.cpp
    mem/ReadBatch.cpp
    mem/Target.cpp
    text/Utf16.cpp
    il2cpp/Managed.cpp
    il2cpp/TypeInfoTable.cpp
    unity/Scene.cpp
    unity/Transforms.cpp
    sched/TaskRunner.cpp
)
target_include_directories(radar_core PUBLIC ${PROJECT_SOURCE_DIR})
target_link_libraries(radar_core PRIVATE radar_warnings)

# The VMM backend is separate so that tests and replay tools can link radar_core without VMM.
add_library(radar_vmm_backend STATIC mem/VmmBackend.cpp)
target_link_libraries(radar_vmm_backend PUBLIC radar_core PRIVATE vmm radar_warnings)
