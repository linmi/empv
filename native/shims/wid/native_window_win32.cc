#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include "native_window.h"

#include <windows.h>

#include <cstdio>
#include <exception>

namespace {

thread_local char lastErrorMessage[2048] = {};

void clearError() noexcept
{
    lastErrorMessage[0] = '\0';
}

void setError(const char* message) noexcept
{
    std::snprintf(
        lastErrorMessage,
        sizeof(lastErrorMessage),
        "%s",
        message ? message : "Unknown WID shim error."
    );
}

void setExceptionError(const std::exception& error) noexcept
{
    std::snprintf(
        lastErrorMessage,
        sizeof(lastErrorMessage),
        "WID shim threw a C++ exception: %s",
        error.what()
    );
}

void setWin32Error(const char* fallbackMessage) noexcept
{
    const DWORD error = GetLastError();
    if (error == 0) {
        setError(fallbackMessage);
        return;
    }

    LPSTR systemMessage = nullptr;
    const DWORD length = FormatMessageA(
        FORMAT_MESSAGE_ALLOCATE_BUFFER |
            FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        error,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<LPSTR>(&systemMessage),
        0,
        nullptr
    );
    if (length > 0 && systemMessage) {
        std::snprintf(
            lastErrorMessage,
            sizeof(lastErrorMessage),
            "%s %s (Win32 error %lu)",
            fallbackMessage,
            systemMessage,
            static_cast<unsigned long>(error)
        );
    } else {
        std::snprintf(
            lastErrorMessage,
            sizeof(lastErrorMessage),
            "%s (Win32 error %lu)",
            fallbackMessage,
            static_cast<unsigned long>(error)
        );
    }
    if (systemMessage) {
        LocalFree(systemMessage);
    }
}

class PlatformHost {
public:
    bool open() noexcept
    {
        if (window_) {
            setError("WID host window is already open.");
            return false;
        }
        if (!registerWindowClass()) {
            return false;
        }

        window_ = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            windowClassName(),
            L"empv video",
            WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            nullptr,
            nullptr,
            GetModuleHandleW(nullptr),
            nullptr
        );
        if (!window_) {
            setWin32Error("Failed to create embedded MPV video window.");
            return false;
        }
        ownerThread_ = GetCurrentThreadId();
        return true;
    }

    uintptr_t nativeHandle() const noexcept
    {
        return reinterpret_cast<uintptr_t>(window_);
    }

    bool hide() noexcept
    {
        if (!window_) {
            return true;
        }
        if (!isOwnerThread("hide")) {
            return false;
        }
        ShowWindow(window_, SW_HIDE);
        return true;
    }

    bool destroy() noexcept
    {
        if (!window_) {
            return true;
        }
        if (!isOwnerThread("destroy")) {
            return false;
        }
        if (!DestroyWindow(window_)) {
            setWin32Error("Failed to destroy embedded MPV video window.");
            return false;
        }
        window_ = nullptr;
        ownerThread_ = 0;
        return true;
    }

private:
    static const wchar_t* windowClassName() noexcept
    {
        return L"EmpvHostWindow";
    }

    static bool registerWindowClass() noexcept
    {
        WNDCLASSEXW windowClass{};
        windowClass.cbSize = sizeof(windowClass);
        windowClass.lpfnWndProc = &PlatformHost::windowProc;
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.lpszClassName = windowClassName();
        windowClass.hCursor =
            LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
        windowClass.hbrBackground =
            reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
        if (RegisterClassExW(&windowClass) == 0) {
            const DWORD error = GetLastError();
            if (error != ERROR_CLASS_ALREADY_EXISTS) {
                setWin32Error(
                    "Failed to register embedded MPV video window class."
                );
                return false;
            }
        }
        return true;
    }

    static LRESULT CALLBACK windowProc(
        HWND window,
        UINT message,
        WPARAM wParam,
        LPARAM lParam) noexcept
    {
        if (message == WM_NCHITTEST) {
            return HTTRANSPARENT;
        }
        if (message == WM_ERASEBKGND) {
            return 1;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    bool isOwnerThread(const char* operation) const noexcept
    {
        if (ownerThread_ == GetCurrentThreadId()) {
            return true;
        }
        std::snprintf(
            lastErrorMessage,
            sizeof(lastErrorMessage),
            "Win32 WID host_%s must run on the thread that created the HWND.",
            operation
        );
        return false;
    }

    HWND window_ = nullptr;
    DWORD ownerThread_ = 0;
};

class PlatformPresenter {
public:
    bool queryScale(
        uintptr_t parentHandle,
        double* outScale) const noexcept
    {
        HWND parent = reinterpret_cast<HWND>(parentHandle);
        if (!parent || !IsWindow(parent)) {
            setError("WID presenter parent handle is not a valid Win32 window.");
            return false;
        }
        if (!outScale) {
            setError("WID presenter scale output pointer is required.");
            return false;
        }
        *outScale = queryScaleForWindow(parent);
        return true;
    }

    bool prepareChild(
        uintptr_t childHandle,
        bool overlay) const noexcept
    {
        (void)overlay;
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter cannot prepare an invalid Win32 child.");
            return false;
        }

        SetLastError(ERROR_SUCCESS);
        const LONG_PTR previousStyle = SetWindowLongPtrW(
            child,
            GWL_STYLE,
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
        );
        if (previousStyle == 0 && GetLastError() != ERROR_SUCCESS) {
            setWin32Error("Failed to set embedded MPV child window style.");
            return false;
        }

        SetLastError(ERROR_SUCCESS);
        const LONG_PTR previousExtendedStyle = SetWindowLongPtrW(
            child,
            GWL_EXSTYLE,
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT
        );
        if (previousExtendedStyle == 0 && GetLastError() != ERROR_SUCCESS) {
            setWin32Error(
                "Failed to set embedded MPV child extended window style."
            );
            return false;
        }
        return true;
    }

    bool attach(
        uintptr_t parentHandle,
        uintptr_t childHandle) const noexcept
    {
        HWND parent = reinterpret_cast<HWND>(parentHandle);
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!parent || !child || !IsWindow(parent) || !IsWindow(child)) {
            setError("WID presenter cannot attach invalid Win32 windows.");
            return false;
        }
        SetLastError(ERROR_SUCCESS);
        const HWND previousParent = SetParent(child, parent);
        if (!previousParent && GetLastError() != ERROR_SUCCESS) {
            setWin32Error("Failed to adopt embedded MPV child window.");
            return false;
        }
        return true;
    }

    bool setBounds(
        uintptr_t childHandle,
        int32_t xPixels,
        int32_t yPixels,
        int32_t widthPixels,
        int32_t heightPixels,
        bool frameChanged) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter cannot position an invalid Win32 child.");
            return false;
        }
        if (widthPixels < 1 || heightPixels < 1) {
            setError("WID presenter pixel width and height must be positive.");
            return false;
        }
        UINT flags = SWP_NOACTIVATE;
        if (frameChanged) {
            flags |= SWP_FRAMECHANGED;
        }
        if (!SetWindowPos(
                child,
                HWND_TOP,
                xPixels,
                yPixels,
                widthPixels,
                heightPixels,
                flags
            )) {
            setWin32Error("Failed to position embedded MPV child window.");
            return false;
        }
        return true;
    }

    bool setVisible(uintptr_t childHandle, bool visible) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter child is not a valid Win32 window.");
            return false;
        }
        ShowWindow(child, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
        return true;
    }

    bool detach(uintptr_t childHandle) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter child is not a valid Win32 window.");
            return false;
        }
        ShowWindow(child, SW_HIDE);
        SetLastError(ERROR_SUCCESS);
        const HWND previousParent = SetParent(child, nullptr);
        if (!previousParent && GetLastError() != ERROR_SUCCESS) {
            setWin32Error("Failed to release embedded MPV child window.");
            return false;
        }
        return true;
    }

private:
    static double queryScaleForWindow(HWND parent) noexcept
    {
        const UINT dpi = GetDpiForWindow(parent);
        return dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
    }
};

template <typename Callback>
int32_t statusBoundary(Callback&& callback) noexcept
{
    clearError();
    try {
        return callback() ? EMPV_WID_OK : EMPV_WID_ERROR;
    } catch (const std::exception& error) {
        setExceptionError(error);
    } catch (...) {
        setError("WID shim threw an unknown C++ exception.");
    }
    return EMPV_WID_ERROR;
}

} // namespace

struct EmpvWidHost {
    PlatformHost platform;
};

struct EmpvWidPresenter {
    PlatformPresenter platform;
};

extern "C" const char* empv_wid_last_error(void) noexcept
{
    return lastErrorMessage;
}

extern "C" EmpvWidHost* empv_wid_host_create(void) noexcept
{
    clearError();
    try {
        return new EmpvWidHost();
    } catch (const std::exception& error) {
        setExceptionError(error);
    } catch (...) {
        setError("WID host allocation threw an unknown C++ exception.");
    }
    return nullptr;
}

extern "C" int32_t empv_wid_host_free(
    EmpvWidHost* host) noexcept
{
    return statusBoundary([host]() {
        if (!host) {
            setError("WID host is null.");
            return false;
        }
        if (!host->platform.destroy()) {
            return false;
        }
        delete host;
        return true;
    });
}

extern "C" int32_t empv_wid_host_is_available(void) noexcept
{
    clearError();
    return 1;
}

extern "C" int32_t empv_wid_host_open(
    EmpvWidHost* host) noexcept
{
    return statusBoundary([host]() {
        if (!host) {
            setError("WID host is null.");
            return false;
        }
        return host->platform.open();
    });
}

extern "C" int32_t empv_wid_host_wid(
    const EmpvWidHost* host,
    char* output,
    size_t outputLength) noexcept
{
    return statusBoundary([host, output, outputLength]() {
        if (!host) {
            setError("WID host is null.");
            return false;
        }
        const uintptr_t handle = host->platform.nativeHandle();
        if (handle == 0) {
            setError("WID host window is not open.");
            return false;
        }
        if (!output || outputLength == 0) {
            setError("WID host wid output buffer is required.");
            return false;
        }
        const int written = std::snprintf(
            output,
            outputLength,
            "%llu",
            static_cast<unsigned long long>(handle)
        );
        if (written < 0 || static_cast<size_t>(written) >= outputLength) {
            setError("WID host wid output buffer is too small.");
            return false;
        }
        return true;
    });
}

extern "C" uintptr_t empv_wid_host_native_handle(
    const EmpvWidHost* host) noexcept
{
    clearError();
    try {
        if (!host) {
            setError("WID host is null.");
            return 0;
        }
        const uintptr_t handle = host->platform.nativeHandle();
        if (handle == 0) {
            setError("WID host window is not open.");
        }
        return handle;
    } catch (const std::exception& error) {
        setExceptionError(error);
    } catch (...) {
        setError("WID native-handle lookup threw an unknown C++ exception.");
    }
    return 0;
}

extern "C" int32_t empv_wid_host_hide(
    EmpvWidHost* host) noexcept
{
    return statusBoundary([host]() {
        if (!host) {
            setError("WID host is null.");
            return false;
        }
        return host->platform.hide();
    });
}

extern "C" int32_t empv_wid_host_destroy(
    EmpvWidHost* host) noexcept
{
    return statusBoundary([host]() {
        if (!host) {
            setError("WID host is null.");
            return false;
        }
        return host->platform.destroy();
    });
}

extern "C" EmpvWidPresenter*
empv_wid_presenter_create(void) noexcept
{
    clearError();
    try {
        return new EmpvWidPresenter();
    } catch (const std::exception& error) {
        setExceptionError(error);
    } catch (...) {
        setError("WID presenter allocation threw an unknown C++ exception.");
    }
    return nullptr;
}

extern "C" int32_t empv_wid_presenter_free(
    EmpvWidPresenter* presenter) noexcept
{
    return statusBoundary([presenter]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        delete presenter;
        return true;
    });
}

extern "C" int32_t empv_wid_presenter_query_scale(
    EmpvWidPresenter* presenter,
    uintptr_t parentHandle,
    double* outScale) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.queryScale(parentHandle, outScale);
    });
}

extern "C" int32_t empv_wid_presenter_prepare_child(
    EmpvWidPresenter* presenter,
    uintptr_t childHandle,
    int32_t overlay) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.prepareChild(childHandle, overlay != 0);
    });
}

extern "C" int32_t empv_wid_presenter_attach(
    EmpvWidPresenter* presenter,
    uintptr_t parentHandle,
    uintptr_t childHandle) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.attach(parentHandle, childHandle);
    });
}

extern "C" int32_t empv_wid_presenter_set_bounds(
    EmpvWidPresenter* presenter,
    uintptr_t childHandle,
    int32_t xPixels,
    int32_t yPixels,
    int32_t widthPixels,
    int32_t heightPixels,
    int32_t frameChanged) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.setBounds(
            childHandle,
            xPixels,
            yPixels,
            widthPixels,
            heightPixels,
            frameChanged != 0
        );
    });
}

extern "C" int32_t empv_wid_presenter_set_visible(
    EmpvWidPresenter* presenter,
    uintptr_t childHandle,
    int32_t visible) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.setVisible(childHandle, visible != 0);
    });
}

extern "C" int32_t empv_wid_presenter_detach(
    EmpvWidPresenter* presenter,
    uintptr_t childHandle) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.detach(childHandle);
    });
}
