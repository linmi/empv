#ifndef EMPV_MACOS_NATIVE_PLATFORM_H
#define EMPV_MACOS_NATIVE_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    EMPV_MAC_SURFACE_COUNT = 3,
    EMPV_MAC_OCCLUSION_VISIBILITY_CHANGED = 1,
    EMPV_MAC_OCCLUSION_WINDOW_CLOSED = 2,
    EMPV_MAC_FRAME_LINK_UNKNOWN_SERVICE = -2,
    EMPV_MAC_FRAME_LINK_INVALID_DESTINATION = -3,
    EMPV_MAC_FRAME_LINK_SEND_FAILED = -4,
    EMPV_MAC_FRAME_LINK_FATAL_SETUP_FAILED = -5,
};

typedef struct EmpvMacSessionSurface EmpvMacSessionSurface;
typedef struct EmpvMacFrameSender EmpvMacFrameSender;
typedef struct EmpvMacFrameReceiver EmpvMacFrameReceiver;
typedef struct EmpvMacFramePool EmpvMacFramePool;
typedef struct EmpvMacPresenter EmpvMacPresenter;
typedef struct EmpvMacOcclusionObserver EmpvMacOcclusionObserver;

typedef struct EmpvMacBounds {
    double x;
    double y;
    double width;
    double height;
    double corner_radius;
} EmpvMacBounds;

typedef struct EmpvMacRenderSize {
    int32_t width_pixels;
    int32_t height_pixels;
} EmpvMacRenderSize;

// Called on the receiver's private serial dispatch queue. pool ownership transfers
// to the callback. On successful receiver or occlusion-observer creation,
// callback_context ownership transfers to native code and release_context is
// called exactly once after native callbacks have drained. Receiver destroy drains
// synchronously from other threads so the bootstrap receive right is released
// before it returns; when invoked from the receiver callback itself it cancels
// asynchronously to avoid self-deadlock.
typedef void (*EmpvMacFramePoolCallback)(
    void* context,
    const char* session_id,
    uint64_t generation,
    EmpvMacFramePool* pool
);
typedef void (*EmpvMacContextReleaseCallback)(void* context);

// Called on the AppKit main thread. WINDOW_CLOSED is emitted after native
// notification tokens have been removed. Calling observer_destroy from the
// callback is supported.
typedef void (*EmpvMacOcclusionCallback)(
    void* context,
    int32_t event,
    bool visible
);

// Every fallible function returns 0 on success and a negative value on failure,
// except ensure_pool which returns 1 when it recreated the pool, 0 when the
// existing pool already matched, and a negative value on failure. On failure,
// error_message receives a NUL-terminated diagnostic when capacity is non-zero.

EmpvMacSessionSurface* empv_mac_session_surface_create(
    char* error_message,
    size_t error_capacity
);
void empv_mac_session_surface_destroy(EmpvMacSessionSurface* surface);
int32_t empv_mac_session_surface_make_current(
    EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
);
void empv_mac_session_surface_clear_current(void);
void* empv_mac_session_surface_get_proc_address(void* context, const char* name);
int32_t empv_mac_session_surface_ensure_pool(
    EmpvMacSessionSurface* surface,
    int32_t width_pixels,
    int32_t height_pixels,
    char* error_message,
    size_t error_capacity
);
int32_t empv_mac_session_surface_framebuffer(
    const EmpvMacSessionSurface* surface,
    int32_t surface_index,
    uint32_t* framebuffer,
    char* error_message,
    size_t error_capacity
);
int32_t empv_mac_session_surface_finish_frame(
    EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
);
int32_t empv_mac_session_surface_capture_rgba(
    EmpvMacSessionSurface* surface,
    int32_t surface_index,
    uint8_t* pixels,
    size_t pixels_length,
    char* error_message,
    size_t error_capacity
);
void empv_mac_session_surface_size(
    const EmpvMacSessionSurface* surface,
    EmpvMacRenderSize* size
);

EmpvMacFrameSender* empv_mac_frame_sender_create(
    const char* service_name,
    char* error_message,
    size_t error_capacity
);
void empv_mac_frame_sender_destroy(EmpvMacFrameSender* sender);
int32_t empv_mac_frame_sender_connect(
    EmpvMacFrameSender* sender,
    char* error_message,
    size_t error_capacity
);
int32_t empv_mac_frame_sender_send_pool(
    EmpvMacFrameSender* sender,
    const char* session_id,
    uint64_t generation,
    const EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
);

EmpvMacFrameReceiver* empv_mac_frame_receiver_create(
    const char* service_name,
    void* callback_context,
    EmpvMacFramePoolCallback callback,
    EmpvMacContextReleaseCallback release_context,
    char* error_message,
    size_t error_capacity
);
void empv_mac_frame_receiver_destroy(EmpvMacFrameReceiver* receiver);
void empv_mac_frame_pool_destroy(EmpvMacFramePool* pool);
void empv_mac_frame_pool_size(
    const EmpvMacFramePool* pool,
    EmpvMacRenderSize* size
);

EmpvMacPresenter* empv_mac_presenter_create(
    uintptr_t native_view,
    bool overlay,
    const EmpvMacBounds* bounds,
    EmpvMacRenderSize* size,
    char* error_message,
    size_t error_capacity
);
void empv_mac_presenter_invalidate(EmpvMacPresenter* presenter);
void empv_mac_presenter_destroy(EmpvMacPresenter* presenter);
int32_t empv_mac_presenter_set_bounds(
    EmpvMacPresenter* presenter,
    const EmpvMacBounds* bounds,
    EmpvMacRenderSize* size,
    char* error_message,
    size_t error_capacity
);
int32_t empv_mac_presenter_present(
    EmpvMacPresenter* presenter,
    const EmpvMacFramePool* pool,
    int32_t surface_index,
    char* error_message,
    size_t error_capacity
);

int32_t empv_mac_window_set_backdrop(
    uintptr_t native_view,
    bool enabled,
    double red,
    double green,
    double blue,
    char* error_message,
    size_t error_capacity
);
EmpvMacOcclusionObserver* empv_mac_occlusion_observer_create(
    uintptr_t native_view,
    void* callback_context,
    EmpvMacOcclusionCallback callback,
    EmpvMacContextReleaseCallback release_context,
    char* error_message,
    size_t error_capacity
);
void empv_mac_occlusion_observer_destroy(EmpvMacOcclusionObserver* observer);

#ifdef __cplusplus
}
#endif

#endif
