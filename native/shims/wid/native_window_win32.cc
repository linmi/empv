#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include "native_window.h"

#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <exception>
#include <mutex>
#include <new>
#include <string>
#include <thread>

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

const wchar_t* parkingPropertyName() noexcept
{
    return L"EmpvParkingWindow";
}

constexpr UINT commandMessage = WM_APP + 0x31F;
constexpr UINT commandTimeoutMs = 5'000;

enum class WindowOperation {
    hideHost,
    closeHost,
    prepareChild,
    attach,
    setBounds,
    show,
    hide,
    detach,
};

struct WindowCommand {
    WindowOperation operation;
    HWND parent = nullptr;
    HWND child = nullptr;
    int32_t xPixels = 0;
    int32_t yPixels = 0;
    int32_t widthPixels = 0;
    int32_t heightPixels = 0;
    bool frameChanged = false;
    bool completed = false;
    bool succeeded = false;
    char error[2048] = {};
};

bool prepareChildOnOwnerThread(HWND child) noexcept
{
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

bool attachOnOwnerThread(HWND parent, HWND child) noexcept
{
    SetLastError(ERROR_SUCCESS);
    const HWND previousParent = SetParent(child, parent);
    if (!previousParent && GetLastError() != ERROR_SUCCESS) {
        setWin32Error("Failed to adopt embedded MPV child window.");
        return false;
    }
    return true;
}

bool setBoundsOnOwnerThread(const WindowCommand& command) noexcept
{
    UINT flags = SWP_NOACTIVATE;
    if (command.frameChanged) {
        flags |= SWP_FRAMECHANGED;
    }
    if (!SetWindowPos(
            command.child,
            HWND_TOP,
            command.xPixels,
            command.yPixels,
            command.widthPixels,
            command.heightPixels,
            flags
        )) {
        setWin32Error("Failed to position embedded MPV child window.");
        return false;
    }
    return true;
}

bool detachOnOwnerThread(HWND child) noexcept
{
    const HWND parking =
        reinterpret_cast<HWND>(GetPropW(child, parkingPropertyName()));
    if (!parking || !IsWindow(parking)) {
        setError(
            "WID presenter child has no valid session-owned parking window."
        );
        return false;
    }
    ShowWindow(child, SW_HIDE);
    SetLastError(ERROR_SUCCESS);
    const HWND previousParent = SetParent(child, parking);
    if (!previousParent && GetLastError() != ERROR_SUCCESS) {
        setWin32Error(
            "Failed to return the embedded MPV child window to its session-owned parking window."
        );
        return false;
    }
    return true;
}

void finishCommand(WindowCommand& command, bool succeeded) noexcept
{
    command.succeeded = succeeded;
    if (!succeeded) {
        std::snprintf(
            command.error,
            sizeof(command.error),
            "%s",
            lastErrorMessage[0] == '\0'
                ? "Win32 WID window-thread command failed."
                : lastErrorMessage
        );
    }
    command.completed = true;
}

LRESULT executeCommand(HWND, WindowCommand& command) noexcept
{
    clearError();
    switch (command.operation) {
        case WindowOperation::hideHost:
            ShowWindow(command.child, SW_HIDE);
            finishCommand(command, true);
            break;
        case WindowOperation::closeHost:
            if (command.child && IsWindow(command.child)) {
                RemovePropW(command.child, parkingPropertyName());
                if (!DestroyWindow(command.child)) {
                    setWin32Error("Failed to destroy embedded MPV video window.");
                    finishCommand(command, false);
                    break;
                }
            }
            finishCommand(command, true);
            PostQuitMessage(0);
            break;
        case WindowOperation::prepareChild:
            finishCommand(command, prepareChildOnOwnerThread(command.child));
            break;
        case WindowOperation::attach:
            finishCommand(
                command,
                attachOnOwnerThread(command.parent, command.child)
            );
            break;
        case WindowOperation::setBounds:
            finishCommand(command, setBoundsOnOwnerThread(command));
            break;
        case WindowOperation::show:
            ShowWindow(command.child, SW_SHOWNOACTIVATE);
            finishCommand(command, true);
            break;
        case WindowOperation::hide:
            ShowWindow(command.child, SW_HIDE);
            finishCommand(command, true);
            break;
        case WindowOperation::detach:
            finishCommand(command, detachOnOwnerThread(command.child));
            break;
    }
    return command.succeeded ? 1 : 0;
}

bool dispatchCommand(
    HWND target,
    WindowCommand& command,
    const char* timeoutMessage) noexcept
{
    if (!target || !IsWindow(target)) {
        setError("WID window-thread command target is not a valid Win32 window.");
        return false;
    }
    auto* dispatched = new (std::nothrow) WindowCommand(command);
    if (!dispatched) {
        setError("Failed to allocate a Win32 WID window-thread command.");
        return false;
    }
    SetLastError(ERROR_SUCCESS);
    DWORD_PTR ignored = 0;
    const LRESULT sent = SendMessageTimeoutW(
        target,
        commandMessage,
        0,
        reinterpret_cast<LPARAM>(dispatched),
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        commandTimeoutMs,
        &ignored
    );
    if (sent == 0) {
        // SendMessageTimeout may return while a target that started processing
        // the message still owns lParam. Leak this one command deliberately:
        // the caller treats the timeout as a generation failure and exits the
        // utility process, while freeing here would create a cross-thread UAF.
        const DWORD error = GetLastError();
        if (error == ERROR_TIMEOUT || error == ERROR_SUCCESS) {
            setError(timeoutMessage);
        } else {
            setWin32Error(timeoutMessage);
        }
        return false;
    }
    command = *dispatched;
    delete dispatched;
    if (!command.completed) {
        setError("Win32 WID window-thread command returned without a result.");
        return false;
    }
    if (!command.succeeded) {
        setError(command.error);
        return false;
    }
    return true;
}

class PlatformHost {
public:
    bool open() noexcept
    {
        if (windowThread_.joinable() || window_.load() != 0) {
            setError("WID host window is already open.");
            return false;
        }

        {
            std::lock_guard<std::mutex> lock(startupMutex_);
            startupFinished_ = false;
            startupSucceeded_ = false;
            startupError_.clear();
        }
        try {
            windowThread_ = std::thread([this]() { runWindowThread(); });
        } catch (const std::exception& error) {
            std::snprintf(
                lastErrorMessage,
                sizeof(lastErrorMessage),
                "Failed to start the Win32 WID window thread: %s",
                error.what()
            );
            return false;
        }

        std::unique_lock<std::mutex> lock(startupMutex_);
        startupCondition_.wait(lock, [this]() { return startupFinished_; });
        const bool succeeded = startupSucceeded_;
        const std::string error = startupError_;
        lock.unlock();
        if (!succeeded) {
            if (windowThread_.joinable()) {
                windowThread_.join();
            }
            setError(error.c_str());
        }
        return succeeded;
    }

    uintptr_t nativeHandle() const noexcept
    {
        return window_.load(std::memory_order_acquire);
    }

    bool hide() noexcept
    {
        const HWND child = windowHandle();
        if (!child) {
            return true;
        }
        WindowCommand command{
            .operation = WindowOperation::hideHost,
            .child = child,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out hiding the embedded MPV video window on its owner thread."
        );
    }

    bool destroy() noexcept
    {
        if (!windowThread_.joinable()) {
            return true;
        }
        const HWND parking = parkingWindowHandle();
        const HWND child = windowHandle();
        if (!parking) {
            setError(
                "WID host window thread is active without its parking window."
            );
            return false;
        }
        WindowCommand command{
            .operation = WindowOperation::closeHost,
            .child = child,
        };
        if (!dispatchCommand(
                parking,
                command,
                "Timed out destroying the embedded MPV video window on its owner thread."
            )) {
            return false;
        }
        windowThread_.join();
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

    void finishStartup(bool succeeded) noexcept
    {
        std::lock_guard<std::mutex> lock(startupMutex_);
        startupSucceeded_ = succeeded;
        startupFinished_ = true;
        if (!succeeded) {
            startupError_ =
                lastErrorMessage[0] == '\0'
                    ? "Failed to start the Win32 WID window thread."
                    : lastErrorMessage;
        }
        startupCondition_.notify_one();
    }

    void runWindowThread() noexcept
    {
        if (!registerWindowClass()) {
            finishStartup(false);
            return;
        }

        HWND parking = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            windowClassName(),
            L"empv video parking",
            WS_POPUP | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            nullptr,
            nullptr,
            GetModuleHandleW(nullptr),
            nullptr
        );
        if (!parking) {
            setWin32Error("Failed to create embedded MPV parking window.");
            finishStartup(false);
            return;
        }

        HWND child = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            windowClassName(),
            L"empv video",
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            parking,
            nullptr,
            GetModuleHandleW(nullptr),
            nullptr
        );
        if (!child) {
            setWin32Error("Failed to create embedded MPV video window.");
            DestroyWindow(parking);
            finishStartup(false);
            return;
        }
        if (!SetPropW(
                child,
                parkingPropertyName(),
                reinterpret_cast<HANDLE>(parking)
            )) {
            setWin32Error(
                "Failed to associate the embedded MPV video window with its parking window."
            );
            DestroyWindow(child);
            DestroyWindow(parking);
            finishStartup(false);
            return;
        }
        parkingWindow_.store(
            reinterpret_cast<uintptr_t>(parking),
            std::memory_order_release
        );
        window_.store(
            reinterpret_cast<uintptr_t>(child),
            std::memory_order_release
        );
        finishStartup(true);

        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        if (IsWindow(child)) {
            RemovePropW(child, parkingPropertyName());
            DestroyWindow(child);
        }
        if (IsWindow(parking)) {
            DestroyWindow(parking);
        }
        window_.store(0, std::memory_order_release);
        parkingWindow_.store(0, std::memory_order_release);
    }

    static LRESULT CALLBACK windowProc(
        HWND window,
        UINT message,
        WPARAM wParam,
        LPARAM lParam) noexcept
    {
        if (message == commandMessage) {
            auto* command = reinterpret_cast<WindowCommand*>(lParam);
            if (!command) {
                return 0;
            }
            return executeCommand(window, *command);
        }
        if (message == WM_NCHITTEST) {
            return HTTRANSPARENT;
        }
        if (message == WM_ERASEBKGND) {
            return 1;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }

    HWND windowHandle() const noexcept
    {
        return reinterpret_cast<HWND>(
            window_.load(std::memory_order_acquire)
        );
    }

    HWND parkingWindowHandle() const noexcept
    {
        return reinterpret_cast<HWND>(
            parkingWindow_.load(std::memory_order_acquire)
        );
    }

    std::thread windowThread_;
    std::mutex startupMutex_;
    std::condition_variable startupCondition_;
    bool startupFinished_ = false;
    bool startupSucceeded_ = false;
    std::string startupError_;
    std::atomic<uintptr_t> parkingWindow_{0};
    std::atomic<uintptr_t> window_{0};
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

    // No z-order parameter: a child window composites above the web contents its
    // parent draws, and nothing here can change that. It used to take one and
    // discard it, which meant a caller asking for underlay got overlay in silence.
    // The refusal now happens at the N-API boundary, where it can be reported.
    bool prepareChild(uintptr_t childHandle) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter cannot prepare an invalid Win32 child.");
            return false;
        }
        WindowCommand command{
            .operation = WindowOperation::prepareChild,
            .child = child,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out preparing the embedded MPV child on its owner thread."
        );
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
        WindowCommand command{
            .operation = WindowOperation::attach,
            .parent = parent,
            .child = child,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out adopting the embedded MPV child on its owner thread."
        );
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
        WindowCommand command{
            .operation = WindowOperation::setBounds,
            .child = child,
            .xPixels = xPixels,
            .yPixels = yPixels,
            .widthPixels = widthPixels,
            .heightPixels = heightPixels,
            .frameChanged = frameChanged,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out positioning the embedded MPV child on its owner thread."
        );
    }

    bool setVisible(uintptr_t childHandle, bool visible) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter child is not a valid Win32 window.");
            return false;
        }
        WindowCommand command{
            .operation = visible
                ? WindowOperation::show
                : WindowOperation::hide,
            .child = child,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out changing embedded MPV child visibility on its owner thread."
        );
    }

    bool detach(uintptr_t childHandle) const noexcept
    {
        HWND child = reinterpret_cast<HWND>(childHandle);
        if (!child || !IsWindow(child)) {
            setError("WID presenter child is not a valid Win32 window.");
            return false;
        }
        WindowCommand command{
            .operation = WindowOperation::detach,
            .child = child,
        };
        return dispatchCommand(
            child,
            command,
            "Timed out detaching the embedded MPV child on its owner thread."
        );
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
    uintptr_t childHandle) noexcept
{
    return statusBoundary([=]() {
        if (!presenter) {
            setError("WID presenter is null.");
            return false;
        }
        return presenter->platform.prepareChild(childHandle);
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
