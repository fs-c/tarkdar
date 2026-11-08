# Builds LeechCore, the LeechCore QEMU device plugin and VMM (from MemProcFS) as shared
# libraries, following build-sketch/. All runtime artefacts go into one bin/ directory with
# $ORIGIN RPATH: vmm.so and leechcore.so locate info.db, libpdbcrust.so and the device plugins
# relative to their own location (dladdr).
#
# Don't link LeechCore and VMM statically into one binary: both compile their own copies of the
# ob_* object manager with identical symbol names.

set(LC_DIR  ${PROJECT_SOURCE_DIR}/third_party/LeechCore)
set(VMM_DIR ${PROJECT_SOURCE_DIR}/third_party/MemProcFS)
set(LCP_DIR ${PROJECT_SOURCE_DIR}/third_party/LeechCore-plugins)

foreach(dir IN ITEMS ${LC_DIR} ${VMM_DIR} ${LCP_DIR})
    if(NOT EXISTS ${dir}/LICENSE AND NOT EXISTS ${dir}/README.md)
        message(FATAL_ERROR "${dir} is empty. Run: git submodule update --init")
    endif()
endforeach()

# ---- local patches ------------------------------------------------------------------------
# Each entry: <submodule dir>|<patch file>. Applied once; skipped if already applied.
set(RADAR_THIRD_PARTY_PATCHES
    "${LCP_DIR}|${PROJECT_SOURCE_DIR}/patches/leechcore-plugins-qemu-memfd.patch"
)
find_package(Git REQUIRED)
foreach(entry IN LISTS RADAR_THIRD_PARTY_PATCHES)
    string(REPLACE "|" ";" parts "${entry}")
    list(GET parts 0 patch_dir)
    list(GET parts 1 patch_file)
    execute_process(COMMAND ${GIT_EXECUTABLE} apply --reverse --check ${patch_file}
        WORKING_DIRECTORY ${patch_dir} RESULT_VARIABLE already_applied OUTPUT_QUIET ERROR_QUIET)
    if(NOT already_applied EQUAL 0)
        execute_process(COMMAND ${GIT_EXECUTABLE} apply ${patch_file}
            WORKING_DIRECTORY ${patch_dir} RESULT_VARIABLE apply_result)
        if(NOT apply_result EQUAL 0)
            message(FATAL_ERROR "Failed to apply ${patch_file} in ${patch_dir}")
        endif()
        message(STATUS "Applied patch ${patch_file}")
    endif()
endforeach()

find_package(Threads REQUIRED)

set(RADAR_VMM_WARNING_FLAGS -w)   # third-party code: don't drown our own warnings

# ---- LeechCore ----------------------------------------------------------------------------
file(GLOB LC_SRC CONFIGURE_DEPENDS ${LC_DIR}/leechcore/*.c ${LC_DIR}/leechcore/ob/*.c)
list(FILTER LC_SRC EXCLUDE REGEX "leechrpcshared\\.c$")      # Windows-only
add_library(leechcore SHARED ${LC_SRC})
set_target_properties(leechcore PROPERTIES PREFIX "" OUTPUT_NAME leechcore
    C_VISIBILITY_PRESET hidden)
target_include_directories(leechcore PRIVATE ${LC_DIR}/leechcore)
target_include_directories(leechcore SYSTEM PUBLIC ${LC_DIR}/includes)
target_compile_definitions(leechcore PUBLIC LINUX PRIVATE _GNU_SOURCE)
target_compile_options(leechcore PRIVATE ${RADAR_VMM_WARNING_FLAGS})
target_link_libraries(leechcore PRIVATE ${CMAKE_DL_LIBS} Threads::Threads)
if(RADAR_WITH_LIBUSB)
    # libusb is only used by the FPGA/USB3380 paths, but LeechCore's oscompatibility.h includes
    # it unconditionally on Linux, so turning this off requires patching LeechCore.
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(LIBUSB REQUIRED IMPORTED_TARGET libusb-1.0)
    target_link_libraries(leechcore PRIVATE PkgConfig::LIBUSB)
endif()

# ---- QEMU device plugin (dlopen'ed by LeechCore) ------------------------------------------
add_library(leechcore_device_qemu MODULE ${LCP_DIR}/leechcore_device_qemu/leechcore_device_qemu.c)
set_target_properties(leechcore_device_qemu PROPERTIES PREFIX "")
target_include_directories(leechcore_device_qemu PRIVATE ${LCP_DIR}/includes)
target_compile_options(leechcore_device_qemu PRIVATE ${RADAR_VMM_WARNING_FLAGS})
target_link_libraries(leechcore_device_qemu PRIVATE leechcore rt)

# ---- VMM ----------------------------------------------------------------------------------
file(GLOB_RECURSE VMM_SRC CONFIGURE_DEPENDS ${VMM_DIR}/vmm/*.c)
list(FILTER VMM_SRC EXCLUDE REGEX "m_sys_cert\\.c$")         # Windows-only
add_library(vmm SHARED ${VMM_SRC})
set_target_properties(vmm PROPERTIES PREFIX "" OUTPUT_NAME vmm
    C_STANDARD 11 C_EXTENSIONS OFF C_VISIBILITY_PRESET hidden)
target_include_directories(vmm PRIVATE ${VMM_DIR}/vmm)
target_include_directories(vmm SYSTEM PUBLIC ${VMM_DIR}/includes)
target_compile_definitions(vmm PUBLIC LINUX PRIVATE _GNU_SOURCE SQLITE_THREADSAFE=2 SQLITE_CORE)
target_compile_options(vmm PRIVATE ${RADAR_VMM_WARNING_FLAGS})
target_link_libraries(vmm PRIVATE leechcore m ${CMAKE_DL_LIBS} Threads::Threads)
