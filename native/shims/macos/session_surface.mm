#include "native_platform_internal.h"

#include <CoreVideo/CoreVideo.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <dlfcn.h>

#include <limits>
#include <new>

struct EmpvMacSessionSurface {
    CGLPixelFormatObj pixel_format = nullptr;
    CGLContextObj context = nullptr;
    IOSurfaceRef surfaces[EMPV_MAC_SURFACE_COUNT] = {};
    GLuint textures[EMPV_MAC_SURFACE_COUNT] = {};
    GLuint framebuffers[EMPV_MAC_SURFACE_COUNT] = {};
    EmpvMacRenderSize size = {};
};

namespace {

void destroy_pool(EmpvMacSessionSurface* surface) {
    if (!surface) {
        return;
    }
    if (surface->context) {
        CGLSetCurrentContext(surface->context);
        glDeleteFramebuffers(EMPV_MAC_SURFACE_COUNT, surface->framebuffers);
        glDeleteTextures(EMPV_MAC_SURFACE_COUNT, surface->textures);
    }
    for (int32_t index = 0; index < EMPV_MAC_SURFACE_COUNT; index += 1) {
        surface->framebuffers[index] = 0;
        surface->textures[index] = 0;
        if (surface->surfaces[index]) {
            CFRelease(surface->surfaces[index]);
            surface->surfaces[index] = nullptr;
        }
    }
    surface->size = {};
}

bool valid_surface_index(int32_t index) {
    return index >= 0 && index < EMPV_MAC_SURFACE_COUNT;
}

}  // namespace

extern "C" EmpvMacSessionSurface* empv_mac_session_surface_create(
    char* error_message,
    size_t error_capacity
) {
    auto* surface = new (std::nothrow) EmpvMacSessionSurface();
    if (!surface) {
        empv_mac_write_error(error_message, error_capacity, "Unable to allocate the macOS video surface.");
        return nullptr;
    }

    // Prefer an accelerated renderer, but do not require one. kCGLPFAAccelerated
    // makes hardware a hard constraint, and CGLChoosePixelFormat then fails with
    // "invalid pixel format" wherever no accelerated renderer is available to the
    // session -- a headless machine, a VM, a CI runner. Dropping the attribute on
    // the second attempt does not force software rendering; it stops demanding
    // hardware, so CGL picks the best renderer that exists. Slow video beats no
    // video, the same trade the WID backend makes with mpv's gpu-sw.
    const CGLPixelFormatAttribute accelerated_attributes[] = {
        kCGLPFAAccelerated,
        kCGLPFAOpenGLProfile,
        static_cast<CGLPixelFormatAttribute>(kCGLOGLPVersion_3_2_Core),
        static_cast<CGLPixelFormatAttribute>(0),
    };
    const CGLPixelFormatAttribute any_renderer_attributes[] = {
        kCGLPFAOpenGLProfile,
        static_cast<CGLPixelFormatAttribute>(kCGLOGLPVersion_3_2_Core),
        static_cast<CGLPixelFormatAttribute>(0),
    };
    GLint virtual_screen_count = 0;
    CGLError choose_result =
        CGLChoosePixelFormat(accelerated_attributes, &surface->pixel_format, &virtual_screen_count);
    if (choose_result != kCGLNoError || !surface->pixel_format) {
        choose_result = CGLChoosePixelFormat(
            any_renderer_attributes,
            &surface->pixel_format,
            &virtual_screen_count
        );
    }
    if (choose_result != kCGLNoError || !surface->pixel_format) {
        empv_mac_write_error(
            error_message,
            error_capacity,
            CGLErrorString(choose_result)
        );
        delete surface;
        return nullptr;
    }

    const CGLError create_result =
        CGLCreateContext(surface->pixel_format, nullptr, &surface->context);
    if (create_result != kCGLNoError || !surface->context) {
        empv_mac_write_error(
            error_message,
            error_capacity,
            CGLErrorString(create_result)
        );
        CGLReleasePixelFormat(surface->pixel_format);
        delete surface;
        return nullptr;
    }

    return surface;
}

extern "C" void empv_mac_session_surface_destroy(
    EmpvMacSessionSurface* surface
) {
    if (!surface) {
        return;
    }
    destroy_pool(surface);
    if (surface->context) {
        CGLSetCurrentContext(nullptr);
        CGLReleaseContext(surface->context);
    }
    if (surface->pixel_format) {
        CGLReleasePixelFormat(surface->pixel_format);
    }
    delete surface;
}

extern "C" int32_t empv_mac_session_surface_make_current(
    EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
) {
    if (!surface || !surface->context) {
        empv_mac_write_error(error_message, error_capacity, "The macOS OpenGL surface is unavailable.");
        return -1;
    }
    const CGLError result = CGLSetCurrentContext(surface->context);
    if (result != kCGLNoError) {
        empv_mac_write_error(error_message, error_capacity, CGLErrorString(result));
        return -1;
    }
    return 0;
}

extern "C" void empv_mac_session_surface_clear_current(void) {
    CGLSetCurrentContext(nullptr);
}

extern "C" void* empv_mac_session_surface_get_proc_address(
    void* context,
    const char* name
) {
    (void)context;
    return name ? dlsym(RTLD_DEFAULT, name) : nullptr;
}

extern "C" int32_t empv_mac_session_surface_ensure_pool(
    EmpvMacSessionSurface* surface,
    int32_t width_pixels,
    int32_t height_pixels,
    char* error_message,
    size_t error_capacity
) {
    if (!surface || !surface->context || width_pixels <= 0 || height_pixels <= 0) {
        empv_mac_write_error(error_message, error_capacity, "Invalid macOS video surface dimensions.");
        return -1;
    }
    if (surface->surfaces[0] && surface->size.width_pixels == width_pixels &&
        surface->size.height_pixels == height_pixels) {
        return 0;
    }
    if (empv_mac_session_surface_make_current(surface, error_message, error_capacity) < 0) {
        return -1;
    }

    destroy_pool(surface);
    for (int32_t index = 0; index < EMPV_MAC_SURFACE_COUNT; index += 1) {
        NSDictionary* properties = @{
            (__bridge NSString*)kIOSurfaceWidth: @(width_pixels),
            (__bridge NSString*)kIOSurfaceHeight: @(height_pixels),
            (__bridge NSString*)kIOSurfaceBytesPerElement: @4,
            (__bridge NSString*)kIOSurfacePixelFormat:
                @((uint32_t)kCVPixelFormatType_32BGRA),
        };
        IOSurfaceRef io_surface =
            IOSurfaceCreate((__bridge CFDictionaryRef)properties);
        if (!io_surface) {
            empv_mac_write_error(error_message, error_capacity, "Failed to create an IOSurface.");
            destroy_pool(surface);
            return -1;
        }

        surface->surfaces[index] = io_surface;
        glGenTextures(1, &surface->textures[index]);
        glBindTexture(GL_TEXTURE_RECTANGLE, surface->textures[index]);
        const CGLError bind_result = CGLTexImageIOSurface2D(
            surface->context,
            GL_TEXTURE_RECTANGLE,
            GL_RGBA8,
            width_pixels,
            height_pixels,
            GL_BGRA,
            GL_UNSIGNED_INT_8_8_8_8_REV,
            io_surface,
            0
        );
        glGenFramebuffers(1, &surface->framebuffers[index]);
        glBindFramebuffer(GL_FRAMEBUFFER, surface->framebuffers[index]);
        glFramebufferTexture2D(
            GL_FRAMEBUFFER,
            GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_RECTANGLE,
            surface->textures[index],
            0
        );
        if (bind_result != kCGLNoError ||
            glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            empv_mac_write_error(
                error_message,
                error_capacity,
                bind_result == kCGLNoError
                    ? "Failed to create a complete IOSurface framebuffer."
                    : CGLErrorString(bind_result)
            );
            destroy_pool(surface);
            return -1;
        }
    }

    surface->size = {width_pixels, height_pixels};
    return 1;
}

extern "C" int32_t empv_mac_session_surface_framebuffer(
    const EmpvMacSessionSurface* surface,
    int32_t surface_index,
    uint32_t* framebuffer,
    char* error_message,
    size_t error_capacity
) {
    if (!surface || !framebuffer || !valid_surface_index(surface_index) ||
        !surface->surfaces[surface_index] || surface->framebuffers[surface_index] == 0) {
        empv_mac_write_error(error_message, error_capacity, "The requested IOSurface framebuffer is unavailable.");
        return -1;
    }
    *framebuffer = surface->framebuffers[surface_index];
    return 0;
}

extern "C" int32_t empv_mac_session_surface_finish_frame(
    EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
) {
    if (!surface || !surface->context) {
        empv_mac_write_error(error_message, error_capacity, "The macOS OpenGL surface is unavailable.");
        return -1;
    }
    glFlush();
    return 0;
}

extern "C" int32_t empv_mac_session_surface_capture_rgba(
    EmpvMacSessionSurface* surface,
    int32_t surface_index,
    uint8_t* pixels,
    size_t pixels_length,
    char* error_message,
    size_t error_capacity
) {
    if (!surface || !pixels || !valid_surface_index(surface_index) ||
        !surface->surfaces[surface_index]) {
        empv_mac_write_error(error_message, error_capacity, "No rendered IOSurface is available to capture.");
        return -1;
    }
    const size_t width = static_cast<size_t>(surface->size.width_pixels);
    const size_t height = static_cast<size_t>(surface->size.height_pixels);
    if (width == 0 || height == 0 ||
        width > std::numeric_limits<size_t>::max() / height / 4 ||
        pixels_length < width * height * 4) {
        empv_mac_write_error(error_message, error_capacity, "The RGBA capture buffer has an invalid size.");
        return -1;
    }
    if (empv_mac_session_surface_make_current(surface, error_message, error_capacity) < 0) {
        return -1;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, surface->framebuffers[surface_index]);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(
        0,
        0,
        surface->size.width_pixels,
        surface->size.height_pixels,
        GL_RGBA,
        GL_UNSIGNED_BYTE,
        pixels
    );
    return 0;
}

extern "C" void empv_mac_session_surface_size(
    const EmpvMacSessionSurface* surface,
    EmpvMacRenderSize* size
) {
    if (size) {
        *size = surface ? surface->size : EmpvMacRenderSize{};
    }
}

IOSurfaceRef empv_mac_session_surface_at(
    const EmpvMacSessionSurface* surface,
    int32_t surface_index
) {
    return surface && valid_surface_index(surface_index)
        ? surface->surfaces[surface_index]
        : nullptr;
}
