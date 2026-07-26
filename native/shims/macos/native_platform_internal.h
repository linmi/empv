#ifndef EMPV_MACOS_NATIVE_PLATFORM_INTERNAL_H
#define EMPV_MACOS_NATIVE_PLATFORM_INTERNAL_H

#include "native_platform.h"

#include <IOSurface/IOSurface.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

struct EmpvMacFramePool {
    IOSurfaceRef surfaces[EMPV_MAC_SURFACE_COUNT] = {};
    int32_t surface_count = 0;
    EmpvMacRenderSize size = {};
};

static inline void empv_mac_write_error(
    char* destination,
    size_t capacity,
    const char* message
) {
    if (!destination || capacity == 0) {
        return;
    }
    std::snprintf(destination, capacity, "%s", message ? message : "Unknown native error.");
}

IOSurfaceRef empv_mac_session_surface_at(
    const EmpvMacSessionSurface* surface,
    int32_t surface_index
);

#endif
