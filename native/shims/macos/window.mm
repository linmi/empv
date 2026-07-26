#include "native_platform_internal.h"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <atomic>
#include <new>

@interface EmpvMacBackdropView : NSView
@end

@implementation EmpvMacBackdropView
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

NSView* find_backdrop(NSView* host_view) {
    for (NSView* view in host_view.subviews) {
        if ([view.identifier isEqualToString:kBackdropIdentifier]) {
            return view;
        }
    }
    return nil;
}

}  // namespace

struct EmpvMacOcclusionObserver {
    NSWindow* __weak window = nil;
    id occlusion_token = nil;
    id close_token = nil;
    std::atomic<bool> active{true};
    uint32_t callback_depth = 0;
    bool destroy_pending = false;
    void* callback_context = nullptr;
    EmpvMacOcclusionCallback callback = nullptr;
    EmpvMacContextReleaseCallback release_context = nullptr;
};

namespace {

void remove_observer_tokens(EmpvMacOcclusionObserver* observer) {
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    if (observer->occlusion_token) {
        [center removeObserver:observer->occlusion_token];
        observer->occlusion_token = nil;
    }
    if (observer->close_token) {
        [center removeObserver:observer->close_token];
        observer->close_token = nil;
    }
}

void finalize_observer(EmpvMacOcclusionObserver* observer) {
    remove_observer_tokens(observer);
    observer->window = nil;
    observer->release_context(observer->callback_context);
    delete observer;
}

void invoke_observer_callback(
    EmpvMacOcclusionObserver* observer,
    int32_t event,
    bool visible
) {
    observer->callback_depth += 1;
    observer->callback(observer->callback_context, event, visible);
    observer->callback_depth -= 1;
    if (observer->callback_depth == 0 && observer->destroy_pending) {
        finalize_observer(observer);
    }
}

}  // namespace

extern "C" int32_t empv_mac_window_set_backdrop(
    uintptr_t native_view,
    bool enabled,
    double red,
    double green,
    double blue,
    char* error_message,
    size_t error_capacity
) {
    if (native_view == 0) {
        empv_mac_write_error(error_message, error_capacity, "Unable to resolve the Electron native window handle.");
        return -1;
    }

    __block NSString* failure = nil;
    run_on_main_thread_sync(^{
      NSView* host_view = resolve_host_view(native_view);
      if (!host_view || !host_view.window) {
          failure = @"Unable to resolve the Electron content view.";
          return;
      }
      NSView* backdrop = find_backdrop(host_view);
      if (!enabled) {
          [backdrop removeFromSuperview];
          return;
      }
      if (!backdrop) {
          backdrop = [[EmpvMacBackdropView alloc] initWithFrame:host_view.bounds];
          backdrop.identifier = kBackdropIdentifier;
          backdrop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
          // Assign the layer before wantsLayer, the ordering NSView.wantsLayer
          // documents as "crucial" for a layer-hosting view. This backdrop's
          // entire purpose is state that lives on its layer: the backgroundColor
          // set below is what shows through the presenter's seams, and nothing
          // re-applies it until the next set_backdrop call. A layer-backed
          // view's layer belongs to AppKit, which may create it via
          // makeBackingLayer; hosting our own keeps that state ours. AppKit
          // still drives a hosted layer's geometry, so the autoresizing mask
          // above keeps sizing it with the host view.
          backdrop.layer = [CALayer layer];
          backdrop.wantsLayer = YES;
          [host_view addSubview:backdrop positioned:NSWindowBelow relativeTo:nil];
      }
      backdrop.layer.backgroundColor = [
          NSColor
          colorWithSRGBRed:static_cast<CGFloat>(red)
          green:static_cast<CGFloat>(green)
          blue:static_cast<CGFloat>(blue)
          alpha:1.0
      ].CGColor;
    });
    if (failure) {
        empv_mac_write_error(error_message, error_capacity, failure.UTF8String);
        return -1;
    }
    return 0;
}

extern "C" EmpvMacOcclusionObserver* empv_mac_occlusion_observer_create(
    uintptr_t native_view,
    void* callback_context,
    EmpvMacOcclusionCallback callback,
    EmpvMacContextReleaseCallback release_context,
    char* error_message,
    size_t error_capacity
) {
    if (native_view == 0 || !callback || !release_context) {
        empv_mac_write_error(error_message, error_capacity, "Invalid window occlusion observer arguments.");
        return nullptr;
    }
    auto* observer = new (std::nothrow) EmpvMacOcclusionObserver();
    if (!observer) {
        empv_mac_write_error(error_message, error_capacity, "Unable to allocate the window occlusion observer.");
        return nullptr;
    }
    observer->callback_context = callback_context;
    observer->callback = callback;
    observer->release_context = release_context;

    __block NSString* failure = nil;
    run_on_main_thread_sync(^{
      NSView* parent_view =
          (__bridge NSView*)reinterpret_cast<void*>(native_view);
      NSWindow* window = parent_view.window;
      if (!window) {
          failure = @"Unable to resolve the Electron window for occlusion.";
          return;
      }
      observer->window = window;
      NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
      observer->occlusion_token = [center
          addObserverForName:NSWindowDidChangeOcclusionStateNotification
          object:window
          queue:nil
          usingBlock:^(NSNotification* notification) {
            if (!observer->active.load(std::memory_order_acquire)) {
                return;
            }
            NSWindow* changed_window = (NSWindow*)notification.object;
            const bool visible =
                (changed_window.occlusionState & NSWindowOcclusionStateVisible) != 0;
            invoke_observer_callback(
                observer,
                EMPV_MAC_OCCLUSION_VISIBILITY_CHANGED,
                visible
            );
          }];
      observer->close_token = [center
          addObserverForName:NSWindowWillCloseNotification
          object:window
          queue:nil
          usingBlock:^(NSNotification* notification) {
            (void)notification;
            if (!observer->active.exchange(false, std::memory_order_acq_rel)) {
                return;
            }
            remove_observer_tokens(observer);
            invoke_observer_callback(
                observer,
                EMPV_MAC_OCCLUSION_WINDOW_CLOSED,
                false
            );
          }];

      const bool visible =
          (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
      invoke_observer_callback(
          observer,
          EMPV_MAC_OCCLUSION_VISIBILITY_CHANGED,
          visible
      );
    });
    if (failure) {
        delete observer;
        empv_mac_write_error(error_message, error_capacity, failure.UTF8String);
        return nullptr;
    }
    return observer;
}

extern "C" void empv_mac_occlusion_observer_destroy(
    EmpvMacOcclusionObserver* observer
) {
    if (!observer) {
        return;
    }
    observer->active.store(false, std::memory_order_release);
    run_on_main_thread_sync(^{
      remove_observer_tokens(observer);
      if (observer->callback_depth > 0) {
          observer->destroy_pending = true;
          return;
      }
      finalize_observer(observer);
    });
}
