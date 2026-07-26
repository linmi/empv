#include "native_window.h"

#include <X11/Xlib.h>
#include <X11/extensions/shape.h>

#include <cstdio>
#include <cstdlib>
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

class PlatformHost {
public:
    bool open() noexcept
    {
        if (display_ || window_) {
            setError("WID host window is already open.");
            return false;
        }
        if (!isAvailable()) {
            setError(
                "Embedded MPV on Linux requires X11 or Xwayland; DISPLAY is not set."
            );
            return false;
        }

        display_ = XOpenDisplay(nullptr);
        if (!display_) {
            setError("Unable to open the X11 display for embedded MPV.");
            return false;
        }

        XSetWindowAttributes attributes{};
        attributes.background_pixel =
            BlackPixel(display_, DefaultScreen(display_));
        attributes.event_mask = ExposureMask | StructureNotifyMask;
        attributes.override_redirect = True;

        window_ = XCreateWindow(
            display_,
            DefaultRootWindow(display_),
            0,
            0,
            1,
            1,
            0,
            CopyFromParent,
            InputOutput,
            CopyFromParent,
            CWBackPixel | CWEventMask | CWOverrideRedirect,
            &attributes
        );
        if (!window_) {
            setError("Failed to create embedded MPV X11 video window.");
            destroy();
            return false;
        }

        clearInputShape();
        XFlush(display_);
        return true;
    }

    static bool isAvailable() noexcept
    {
        const char* display = std::getenv("DISPLAY");
        return display && display[0] != '\0';
    }

    uintptr_t nativeHandle() const noexcept
    {
        return static_cast<uintptr_t>(window_);
    }

    bool hide() noexcept
    {
        if (!display_ || !window_) {
            return true;
        }
        if (XUnmapWindow(display_, window_) == 0) {
            setError("Failed to unmap embedded MPV X11 video window.");
            return false;
        }
        XFlush(display_);
        drainEvents();
        return true;
    }

    bool destroy() noexcept
    {
        bool succeeded = true;
        if (display_ && window_) {
            if (XDestroyWindow(display_, window_) == 0) {
                setError("Failed to destroy embedded MPV X11 video window.");
                succeeded = false;
            } else {
                window_ = 0;
            }
        }
        if (display_ && (succeeded || !window_)) {
            XCloseDisplay(display_);
            display_ = nullptr;
        }
        return succeeded;
    }

private:
    void drainEvents() noexcept
    {
        while (display_ && XPending(display_) > 0) {
            XEvent event{};
            XNextEvent(display_, &event);
        }
    }

    void clearInputShape() noexcept
    {
        int eventBase = 0;
        int errorBase = 0;
        if (!display_ || !window_ ||
            !XShapeQueryExtension(display_, &eventBase, &errorBase)) {
            return;
        }
        XShapeCombineRectangles(
            display_,
            window_,
            ShapeInput,
            0,
            0,
            nullptr,
            0,
            ShapeSet,
            Unsorted
        );
    }

    Display* display_ = nullptr;
    Window window_ = 0;
};

class PlatformPresenter {
public:
    bool queryScale(
        uintptr_t parentHandle,
        double* outScale) const noexcept
    {
        if (parentHandle == 0) {
            setError("WID presenter parent X11 window is required.");
            return false;
        }
        if (!outScale) {
            setError("WID presenter scale output pointer is required.");
            return false;
        }
        *outScale = 1.0;
        return true;
    }

    bool prepareChild(
        uintptr_t childHandle,
        bool overlay) noexcept
    {
        (void)overlay;
        if (childHandle == 0) {
            setError("WID presenter child X11 window is required.");
            return false;
        }
        return true;
    }

    bool attach(
        uintptr_t parentHandle,
        uintptr_t childHandle) noexcept
    {
        if (parentHandle == 0 || childHandle == 0) {
            setError("WID presenter parent and child X11 windows are required.");
            return false;
        }
        Display* connection = display();
        if (!connection) {
            return false;
        }
        if (XReparentWindow(
                connection,
                static_cast<Window>(childHandle),
                static_cast<Window>(parentHandle),
                0,
                0
            ) == 0) {
            setError("Failed to adopt embedded MPV X11 child window.");
            return false;
        }
        XFlush(connection);
        return true;
    }

    bool setBounds(
        uintptr_t childHandle,
        int32_t xPixels,
        int32_t yPixels,
        int32_t widthPixels,
        int32_t heightPixels,
        bool frameChanged) noexcept
    {
        (void)frameChanged;
        if (childHandle == 0) {
            setError("WID presenter child X11 window is required.");
            return false;
        }
        if (widthPixels < 1 || heightPixels < 1) {
            setError("WID presenter pixel width and height must be positive.");
            return false;
        }
        Display* connection = display();
        if (!connection) {
            return false;
        }

        const Window child = static_cast<Window>(childHandle);
        if (XMoveResizeWindow(
                connection,
                child,
                xPixels,
                yPixels,
                static_cast<unsigned int>(widthPixels),
                static_cast<unsigned int>(heightPixels)
            ) == 0 ||
            XRaiseWindow(connection, child) == 0) {
            setError("Failed to position embedded MPV X11 child window.");
            return false;
        }
        XFlush(connection);
        return true;
    }

    bool setVisible(uintptr_t childHandle, bool visible) noexcept
    {
        if (childHandle == 0) {
            setError("WID presenter child X11 window is required.");
            return false;
        }
        Display* connection = display();
        if (!connection) {
            return false;
        }
        const Window child = static_cast<Window>(childHandle);
        const int result = visible
            ? XMapWindow(connection, child)
            : XUnmapWindow(connection, child);
        if (result == 0) {
            setError(
                visible
                    ? "Failed to map embedded MPV X11 child window."
                    : "Failed to unmap embedded MPV X11 child window."
            );
            return false;
        }
        XFlush(connection);
        return true;
    }

    bool detach(uintptr_t childHandle) noexcept
    {
        if (childHandle == 0) {
            setError("WID presenter child X11 window is required.");
            return false;
        }
        Display* connection = display();
        if (!connection) {
            return false;
        }
        const Window child = static_cast<Window>(childHandle);
        if (XUnmapWindow(connection, child) == 0 ||
            XReparentWindow(
                connection,
                child,
                DefaultRootWindow(connection),
                0,
                0
            ) == 0) {
            setError("Failed to release embedded MPV X11 child window.");
            return false;
        }
        XFlush(connection);
        return true;
    }

    void closeDisplay() noexcept
    {
        if (display_) {
            XCloseDisplay(display_);
            display_ = nullptr;
        }
    }

private:
    Display* display() noexcept
    {
        if (!display_) {
            display_ = XOpenDisplay(nullptr);
            if (!display_) {
                setError("Unable to open the X11 display for WID presenter.");
            }
        }
        return display_;
    }

    Display* display_ = nullptr;
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
    if (PlatformHost::isAvailable()) {
        return 1;
    }
    setError(
        "Embedded MPV on Linux requires X11 or Xwayland; DISPLAY is not set."
    );
    return 0;
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
        presenter->platform.closeDisplay();
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
