#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
#define EMPV_WID_NOEXCEPT noexcept
extern "C" {
#else
#define EMPV_WID_NOEXCEPT
#endif

typedef struct EmpvWidHost EmpvWidHost;
typedef struct EmpvWidPresenter EmpvWidPresenter;

enum {
    EMPV_WID_OK = 0,
    EMPV_WID_ERROR = -1,
};

/*
 * Error text is thread-local and remains valid until the next shim call on the
 * same thread. Callers must copy it before making another shim call.
 */
const char* empv_wid_last_error(void) EMPV_WID_NOEXCEPT;

/*
 * Host ownership:
 * - host_create allocates only the opaque owner; host_open creates the native
 *   video window.
 * - host_destroy is idempotent and releases the native window while retaining
 *   the opaque owner. host_free also destroys an open window.
 * - On Win32, each host owns a dedicated native message thread. Public calls
 *   synchronously marshal bounded commands to that thread, so Electron utility
 *   IPC never becomes the HWND message pump and a hung window command reports
 *   an error instead of waiting forever.
 */
EmpvWidHost* empv_wid_host_create(void)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_free(EmpvWidHost* host)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_is_available(void)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_open(EmpvWidHost* host)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_wid(
    const EmpvWidHost* host,
    char* output,
    size_t output_length) EMPV_WID_NOEXCEPT;
uintptr_t empv_wid_host_native_handle(
    const EmpvWidHost* host) EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_hide(EmpvWidHost* host)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_host_destroy(EmpvWidHost* host)
    EMPV_WID_NOEXCEPT;

/*
 * Presenter ownership and boundary:
 * - The opaque presenter contains platform resources only (an X11 Display*
 *   connection on Linux; no product state on Win32).
 * - Every operation is a single platform action. Rust owns parent/child/bounds,
 *   attachment, suspension, sequencing, rollback, and lifecycle decisions.
 * - Calls must be serialized on the owning application thread. Win32 then
 *   marshals each platform action to the HWND owner thread.
 */
EmpvWidPresenter* empv_wid_presenter_create(void)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_free(EmpvWidPresenter* presenter)
    EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_query_scale(
    EmpvWidPresenter* presenter,
    uintptr_t parent_handle,
    double* out_scale) EMPV_WID_NOEXCEPT;
/*
 * prepare_child may change platform window styles but never reparents the
 * child. attach performs only the platform reparent operation; on failure the
 * child remains detached. Rust can therefore make attachment transactional.
 */
int32_t empv_wid_presenter_prepare_child(
    EmpvWidPresenter* presenter,
    uintptr_t child_handle) EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_attach(
    EmpvWidPresenter* presenter,
    uintptr_t parent_handle,
    uintptr_t child_handle) EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_set_bounds(
    EmpvWidPresenter* presenter,
    uintptr_t child_handle,
    int32_t x_pixels,
    int32_t y_pixels,
    int32_t width_pixels,
    int32_t height_pixels,
    int32_t frame_changed) EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_set_visible(
    EmpvWidPresenter* presenter,
    uintptr_t child_handle,
    int32_t visible) EMPV_WID_NOEXCEPT;
int32_t empv_wid_presenter_detach(
    EmpvWidPresenter* presenter,
    uintptr_t child_handle) EMPV_WID_NOEXCEPT;

#ifdef __cplusplus
}
#endif

#undef EMPV_WID_NOEXCEPT
