#include "native_platform_internal.h"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <atomic>
#include <cmath>
#include <mutex>
#include <new>

@interface EmpvMacVideoView : NSView
@end

@implementation EmpvMacVideoView
- (BOOL)isFlipped {
    return YES;
}

- (NSView*)hitTest:(NSPoint)point {
    (void)point;
    return nil;
}
@end

namespace {

NSString* const kBackdropIdentifier = @"dev.empv.window-backdrop";

void run_on_main_thread_sync(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

NSView* resolve_host_view(uintptr_t native_view) {
    NSView* parent_view = (__bridge NSView*)reinterpret_cast<void*>(native_view);
    return parent_view.window ? parent_view.window.contentView : parent_view;
}

struct PixelAlignedBounds {
    CGFloat x;
    CGFloat y;
    CGFloat width;
    CGFloat height;
};

PixelAlignedBounds align_css_bounds_to_backing_pixels(
    const EmpvMacBounds& bounds,
    CGFloat scale
) {
    // Origin and size must be rounded as one edge interval. Rounding width
    // independently from a fractional origin can leave the far edge one backing
    // pixel short after a split-pane drag. Align outward so the native presenter
    // always covers the transparent DOM hole completely.
    const double left_pixels = std::floor(bounds.x * static_cast<double>(scale));
    const double top_pixels = std::floor(bounds.y * static_cast<double>(scale));
    const double right_pixels =
        std::ceil((bounds.x + bounds.width) * static_cast<double>(scale));
    const double bottom_pixels =
        std::ceil((bounds.y + bounds.height) * static_cast<double>(scale));
    const double width_pixels = std::max(1.0, right_pixels - left_pixels);
    const double height_pixels = std::max(1.0, bottom_pixels - top_pixels);

    return {
        static_cast<CGFloat>(left_pixels / scale),
        static_cast<CGFloat>(top_pixels / scale),
        static_cast<CGFloat>(width_pixels / scale),
        static_cast<CGFloat>(height_pixels / scale),
    };
}

NSRect frame_from_aligned_bounds(NSView* host_view, const PixelAlignedBounds& bounds) {
    const NSRect host_bounds = host_view.bounds;
    const CGFloat origin_y = host_view.isFlipped
        ? bounds.y
        : NSMaxY(host_bounds) - bounds.y - bounds.height;
    return NSMakeRect(
        bounds.x,
        origin_y,
        bounds.width,
        bounds.height
    );
}

NSView* find_backdrop(NSView* host_view) {
    for (NSView* view in host_view.subviews) {
        if ([view.identifier isEqualToString:kBackdropIdentifier]) {
            return view;
        }
    }
    return nil;
}

// An integer render target cannot represent every display aspect exactly, so
// mpv can leave a one-backing-pixel keep-aspect remainder bar on one side of the
// surface while preserving aspect. Crop a single source pixel from every edge so
// that remainder never reaches the screen; real letterboxing is far wider than
// one pixel and stays intact.
//
// The crop is expressed in the presented surface's own normalized coordinates
// rather than in presenter geometry, and that is what makes it hold while a
// resize is in flight. The layer frame is updated synchronously on the main
// thread, but the surface rendered for that frame only arrives after a
// cross-process round trip (renderer -> main -> utility render thread -> frame
// link). kCAGravityResize maps contents by normalized position, so a crop
// expressed as presenter-space overscan drifts against a stale surface by
// (new_width + 2) / old_width - 1 backing pixels -- it degenerates to zero when
// the sizes agree, but enlarging the presenter mid-drag slides the bar back into
// the last visible column as a dark seam. A contentsRect crop travels with the
// surface it was computed for, so it stays exact at every size.
CGRect remainder_crop_for_surface(const EmpvMacRenderSize& size) {
    const CGFloat width = static_cast<CGFloat>(size.width_pixels);
    const CGFloat height = static_cast<CGFloat>(size.height_pixels);
    if (!(width > 2.0) || !(height > 2.0)) {
        return CGRectMake(0.0, 0.0, 1.0, 1.0);
    }
    return CGRectMake(
        1.0 / width,
        1.0 / height,
        1.0 - 2.0 / width,
        1.0 - 2.0 / height
    );
}

}  // namespace

struct EmpvMacPresenter {
    std::mutex mutex;
    bool active = true;
    EmpvMacVideoView* container_view = nil;
    CALayer* container_layer = nil;
    CALayer* video_layer = nil;
    std::atomic<bool> first_frame_presented{false};
};

namespace {

bool apply_bounds(
    EmpvMacPresenter* presenter,
    const EmpvMacBounds* bounds,
    EmpvMacRenderSize* size
) {
    if (!presenter || !presenter->container_view || !bounds || !size) {
        return false;
    }
    NSView* host_view = presenter->container_view.superview;
    if (!host_view) {
        return false;
    }
    const CGFloat scale = host_view.window
        ? host_view.window.backingScaleFactor
        : NSScreen.mainScreen.backingScaleFactor;
    const PixelAlignedBounds aligned =
        align_css_bounds_to_backing_pixels(*bounds, scale);

    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    presenter->container_view.frame =
        frame_from_aligned_bounds(host_view, aligned);
    presenter->container_layer.cornerRadius =
        static_cast<CGFloat>(std::max(0.0, bounds->corner_radius));
    // The video layer exactly fills the presenter. mpv's keep-aspect remainder
    // bar is cropped in surface space when the frame is presented (see
    // remainder_crop_for_surface) instead of being pushed out by overscanning
    // the layer here: presenter-space overscan only clips the bar while the
    // presented surface still matches this frame, which every resize breaks for
    // the duration of the render round trip.
    presenter->video_layer.frame = presenter->container_view.bounds;
    presenter->video_layer.contentsScale = scale;
    [CATransaction commit];
    // The view frame expands to whole backing-pixel edges so it never leaves a
    // seam around Chromium's transparent hole. Keep the mpv render target tied
    // to the requested CSS size, however: using the expanded frame dimensions
    // can alter the target aspect by one pixel and makes mpv paint that surplus
    // column or row black. kCAGravityResize then stretches the cropped IOSurface
    // by at most one backing pixel to cover the aligned view.
    size->width_pixels = static_cast<int32_t>(
        std::max(1.0, std::round(bounds->width * static_cast<double>(scale))));
    size->height_pixels = static_cast<int32_t>(
        std::max(1.0, std::round(bounds->height * static_cast<double>(scale))));
    return true;
}

}  // namespace

extern "C" EmpvMacPresenter* empv_mac_presenter_create(
    uintptr_t native_view,
    bool overlay,
    const EmpvMacBounds* bounds,
    EmpvMacRenderSize* size,
    char* error_message,
    size_t error_capacity
) {
    if (native_view == 0 || !bounds || !size) {
        empv_mac_write_error(error_message, error_capacity, "Invalid macOS presenter arguments.");
        return nullptr;
    }
    auto* presenter = new (std::nothrow) EmpvMacPresenter();
    if (!presenter) {
        empv_mac_write_error(error_message, error_capacity, "Unable to allocate the macOS presenter.");
        return nullptr;
    }

    __block NSString* failure = nil;
    run_on_main_thread_sync(^{
      NSView* host_view = resolve_host_view(native_view);
      if (!host_view) {
          failure = @"Unable to resolve the Electron content view.";
          return;
      }
      auto* container_view =
          [[EmpvMacVideoView alloc] initWithFrame:NSZeroRect];
      CALayer* container_layer = [CALayer layer];
      CALayer* video_layer = [CALayer layer];
      container_layer.backgroundColor = NSColor.clearColor.CGColor;
      container_layer.masksToBounds = YES;
      video_layer.backgroundColor = NSColor.blackColor.CGColor;
      video_layer.contentsGravity = kCAGravityResize;
      video_layer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
      video_layer.opaque = YES;
      // Assign the layer BEFORE wantsLayer. NSView.wantsLayer documents the
      // ordering as load-bearing: "To create a layer-hosting view, you must set
      // the layer property first and then set this property to true. The order
      // in which you set the values of these properties is crucial." Setting
      // wantsLayer first yields a layer-backed view instead, whose layer belongs
      // to AppKit and which AppKit may create for itself via makeBackingLayer.
      //
      // This presenter is built entirely on the layer-hosting model -- it owns
      // its sublayer tree, caches container_layer/video_layer for the whole
      // session, and mutates them out of band (cornerRadius, frame, contents,
      // contentsRect) -- so it must declare that model rather than run on a
      // layer AppKit is free to manage. A layer it replaced would orphan those
      // cached pointers: clipping would stop applying to what is on screen and
      // presented frames would land off-tree.
      //
      // Measured on macOS 27 rather than assumed: AppKit keeps driving a hosted
      // root layer's geometry (layer.bounds follows view.frame across resizes,
      // re-parenting and cross-window moves). That is why apply_bounds sets only
      // container_view.frame and must never set container_layer.frame itself.
      container_view.layer = container_layer;
      container_view.wantsLayer = YES;
      [container_layer addSublayer:video_layer];
      presenter->container_view = container_view;
      presenter->container_layer = container_layer;
      presenter->video_layer = video_layer;

      NSView* backdrop = find_backdrop(host_view);
      if (overlay) {
          [host_view addSubview:container_view positioned:NSWindowAbove relativeTo:nil];
      } else if (backdrop) {
          [host_view
              addSubview:container_view
              positioned:NSWindowAbove
              relativeTo:backdrop];
      } else {
          [host_view addSubview:container_view positioned:NSWindowBelow relativeTo:nil];
      }
      if (!apply_bounds(presenter, bounds, size)) {
          [container_view removeFromSuperview];
          presenter->container_view = nil;
          presenter->container_layer = nil;
          presenter->video_layer = nil;
          failure = @"Unable to apply the macOS presenter bounds.";
      }
    });

    if (failure) {
        empv_mac_write_error(error_message, error_capacity, failure.UTF8String);
        delete presenter;
        return nullptr;
    }
    return presenter;
}

extern "C" void empv_mac_presenter_destroy(EmpvMacPresenter* presenter) {
    if (!presenter) {
        return;
    }
    empv_mac_presenter_invalidate(presenter);
    delete presenter;
}

extern "C" void empv_mac_presenter_invalidate(
    EmpvMacPresenter* presenter
) {
    if (!presenter) {
        return;
    }
    run_on_main_thread_sync(^{
      std::lock_guard<std::mutex> lock(presenter->mutex);
      if (!presenter->active) {
          return;
      }
      presenter->active = false;
      [presenter->container_view removeFromSuperview];
      presenter->container_view = nil;
      presenter->container_layer = nil;
      presenter->video_layer = nil;
    });
}

extern "C" int32_t empv_mac_presenter_set_bounds(
    EmpvMacPresenter* presenter,
    const EmpvMacBounds* bounds,
    EmpvMacRenderSize* size,
    char* error_message,
    size_t error_capacity
) {
    __block bool applied = false;
    run_on_main_thread_sync(^{
      if (!presenter) {
          return;
      }
      std::lock_guard<std::mutex> lock(presenter->mutex);
      applied = presenter->active && apply_bounds(presenter, bounds, size);
    });
    if (!applied) {
        empv_mac_write_error(error_message, error_capacity, "Unable to apply the macOS presenter bounds.");
        return -1;
    }
    return 0;
}

extern "C" int32_t empv_mac_presenter_present(
    EmpvMacPresenter* presenter,
    const EmpvMacFramePool* pool,
    int32_t surface_index,
    char* error_message,
    size_t error_capacity
) {
    if (!presenter || !pool || surface_index < 0 ||
        surface_index >= pool->surface_count || !pool->surfaces[surface_index]) {
        empv_mac_write_error(error_message, error_capacity, "The requested presenter surface is unavailable.");
        return -1;
    }
    IOSurfaceRef io_surface = pool->surfaces[surface_index];
    CFRetain(io_surface);
    // Resolved here, in the synchronous body: the dispatched block must not
    // dereference the pool, whose lifetime the caller owns. The crop belongs to
    // this surface's dimensions, so it is captured by value alongside it.
    const CGRect contents_rect = remainder_crop_for_surface(pool->size);
    CALayer* video_layer = nil;
    {
        std::lock_guard<std::mutex> lock(presenter->mutex);
        if (presenter->active) {
            video_layer = presenter->video_layer;
        }
    }
    if (!video_layer) {
        CFRelease(io_surface);
        empv_mac_write_error(error_message, error_capacity, "The macOS presenter layer is unavailable.");
        return -1;
    }
    // Latch the first-frame transition here, in the synchronous body. The Rust
    // caller holds &self across this call, so the presenter is guaranteed alive
    // now; the dispatched block, by contrast, only strongly retains video_layer
    // and must never touch presenter -- a main-thread JS destroy can inline
    // invalidate + delete the presenter before a previously queued present
    // block runs, which would be a use-after-free. Capture only this bool.
    const bool should_clear_backing =
        !presenter->first_frame_presented.exchange(true);
    dispatch_async(dispatch_get_main_queue(), ^{
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      video_layer.contents = (__bridge id)io_surface;
      video_layer.contentsRect = contents_rect;
      // The video layer is created opaque black so the loading window stays a
      // solid black frame between session creation (the DOM hole is already
      // transparent) and the first decoded frame -- clearing it earlier would
      // let a light theme flash white through the hole. Once real content
      // covers the layer, drop the black backing to clear so any transient
      // geometry mismatch shows through to the theme-colored backdrop instead
      // of black. opaque stays YES because contents always cover the layer.
      if (should_clear_backing) {
          video_layer.backgroundColor = NSColor.clearColor.CGColor;
      }
      [CATransaction commit];
      CFRelease(io_surface);
    });
    return 0;
}
