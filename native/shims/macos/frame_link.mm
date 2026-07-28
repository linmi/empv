#include "native_platform_internal.h"

#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <mach/mach_error.h>
#include <servers/bootstrap.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <new>
#include <string>

#if defined(EMPV_MAC_FRAME_LINK_SENDER) == defined(EMPV_MAC_FRAME_LINK_RECEIVER)
#error "Build frame_link.mm with exactly one frame-link role."
#endif

namespace {

constexpr uint32_t kFrameLinkMagic = 0x524d5046;
constexpr uint32_t kFrameLinkVersion = 1;
constexpr size_t kFrameLinkSessionIdMax = 64;
constexpr mach_msg_id_t kFrameLinkMessageId = 0x524d5046;
#if defined(EMPV_MAC_FRAME_LINK_RECEIVER)
char kReceiverQueueKey;
#endif

struct FrameLinkPayload {
    uint32_t magic;
    uint32_t version;
    char session_id[kFrameLinkSessionIdMax];
    uint64_t generation;
    uint32_t surface_count;
    uint32_t width_pixels;
    uint32_t height_pixels;
};

struct FrameLinkPoolMessage {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t surfaces[EMPV_MAC_SURFACE_COUNT];
    FrameLinkPayload payload;
};

#if defined(EMPV_MAC_FRAME_LINK_RECEIVER)
struct FrameLinkPoolMessageReceive {
    FrameLinkPoolMessage message;
    mach_msg_trailer_t trailer;
};

void destroy_pool(EmpvMacFramePool* pool) {
    if (!pool) {
        return;
    }
    for (int32_t index = 0; index < pool->surface_count; index += 1) {
        if (pool->surfaces[index]) {
            CFRelease(pool->surfaces[index]);
        }
    }
    delete pool;
}
#endif

}  // namespace

#if defined(EMPV_MAC_FRAME_LINK_SENDER)
struct EmpvMacFrameSender {
    std::string service_name;
    mach_port_t send_port = MACH_PORT_NULL;
};
#endif

#if defined(EMPV_MAC_FRAME_LINK_RECEIVER)
struct EmpvMacFrameReceiver {
    mach_port_t receive_port = MACH_PORT_NULL;
    dispatch_queue_t queue = nullptr;
    dispatch_source_t source = nullptr;
    dispatch_semaphore_t cancelled = nullptr;
    std::atomic<bool> active{true};
    std::atomic<bool> delete_on_cancel{false};
    void* callback_context = nullptr;
    EmpvMacFramePoolCallback callback = nullptr;
    EmpvMacContextReleaseCallback release_context = nullptr;
};
#endif

namespace {

#if defined(EMPV_MAC_FRAME_LINK_SENDER)
void deallocate_surface_ports(mach_port_t* ports) {
    for (int32_t index = 0; index < EMPV_MAC_SURFACE_COUNT; index += 1) {
        if (ports[index] != MACH_PORT_NULL) {
            mach_port_deallocate(mach_task_self(), ports[index]);
            ports[index] = MACH_PORT_NULL;
        }
    }
}
#endif

#if defined(EMPV_MAC_FRAME_LINK_RECEIVER)
void receive_pool_message(
    EmpvMacFrameReceiver* receiver,
    FrameLinkPoolMessage& message
) {
    const uint32_t descriptor_count = message.body.msgh_descriptor_count;
    if (message.payload.magic != kFrameLinkMagic ||
        message.payload.version != kFrameLinkVersion ||
        descriptor_count != EMPV_MAC_SURFACE_COUNT ||
        message.payload.surface_count != EMPV_MAC_SURFACE_COUNT) {
        mach_msg_destroy(&message.header);
        return;
    }

    auto* pool = new (std::nothrow) EmpvMacFramePool();
    if (!pool) {
        mach_msg_destroy(&message.header);
        return;
    }
    pool->surface_count = static_cast<int32_t>(message.payload.surface_count);
    pool->size = {
        static_cast<int32_t>(message.payload.width_pixels),
        static_cast<int32_t>(message.payload.height_pixels),
    };

    bool complete = true;
    for (int32_t index = 0; index < pool->surface_count; index += 1) {
        const mach_port_t port = message.surfaces[index].name;
        if (port != MACH_PORT_NULL) {
            pool->surfaces[index] = IOSurfaceLookupFromMachPort(port);
            mach_port_deallocate(mach_task_self(), port);
            message.surfaces[index].name = MACH_PORT_NULL;
        }
        complete = complete && pool->surfaces[index] != nullptr;
    }
    for (uint32_t index = message.payload.surface_count;
         index < std::min<uint32_t>(descriptor_count, EMPV_MAC_SURFACE_COUNT);
         index += 1) {
        const mach_port_t port = message.surfaces[index].name;
        if (port != MACH_PORT_NULL) {
            mach_port_deallocate(mach_task_self(), port);
            message.surfaces[index].name = MACH_PORT_NULL;
        }
    }

    const size_t session_id_length =
        strnlen(message.payload.session_id, kFrameLinkSessionIdMax);
    if (!complete || session_id_length == 0 ||
        session_id_length == kFrameLinkSessionIdMax) {
        destroy_pool(pool);
        return;
    }

    if (!receiver->active.load(std::memory_order_acquire) || !receiver->callback) {
        destroy_pool(pool);
        return;
    }
    receiver->callback(
        receiver->callback_context,
        message.payload.session_id,
        message.payload.generation,
        pool
    );
}

void drain_messages(EmpvMacFrameReceiver* receiver) {
    while (receiver->active.load(std::memory_order_acquire)) {
        FrameLinkPoolMessageReceive receive = {};
        const kern_return_t result = mach_msg(
            &receive.message.header,
            MACH_RCV_MSG | MACH_RCV_TIMEOUT,
            0,
            sizeof(receive),
            receiver->receive_port,
            0,
            MACH_PORT_NULL
        );
        if (result == MACH_RCV_TIMED_OUT) {
            return;
        }
        if (result != KERN_SUCCESS) {
            return;
        }
        if (receive.message.header.msgh_id == kFrameLinkMessageId &&
            (receive.message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
            receive.message.header.msgh_size == sizeof(FrameLinkPoolMessage)) {
            receive_pool_message(receiver, receive.message);
        } else {
            mach_msg_destroy(&receive.message.header);
        }
    }
}
#endif

}  // namespace

#if defined(EMPV_MAC_FRAME_LINK_SENDER)
extern "C" EmpvMacFrameSender* empv_mac_frame_sender_create(
    const char* service_name,
    char* error_message,
    size_t error_capacity
) {
    if (!service_name || service_name[0] == '\0' ||
        std::strlen(service_name) >= BOOTSTRAP_MAX_NAME_LEN) {
        empv_mac_write_error(
            error_message,
            error_capacity,
            "Frame link service name must be non-empty and under 128 bytes."
        );
        return nullptr;
    }
    auto* sender = new (std::nothrow) EmpvMacFrameSender();
    if (!sender) {
        empv_mac_write_error(error_message, error_capacity, "Unable to allocate the frame-link sender.");
        return nullptr;
    }
    sender->service_name = service_name;
    return sender;
}

extern "C" void empv_mac_frame_sender_destroy(EmpvMacFrameSender* sender) {
    if (!sender) {
        return;
    }
    if (sender->send_port != MACH_PORT_NULL) {
        mach_port_deallocate(mach_task_self(), sender->send_port);
    }
    delete sender;
}

extern "C" int32_t empv_mac_frame_sender_connect(
    EmpvMacFrameSender* sender,
    char* error_message,
    size_t error_capacity
) {
    if (!sender) {
        empv_mac_write_error(error_message, error_capacity, "The frame-link sender is unavailable.");
        return -1;
    }
    if (sender->send_port != MACH_PORT_NULL) {
        return 0;
    }
    mach_port_t send_port = MACH_PORT_NULL;
    const kern_return_t result =
        bootstrap_look_up(bootstrap_port, sender->service_name.c_str(), &send_port);
    if (result != KERN_SUCCESS || send_port == MACH_PORT_NULL) {
        empv_mac_write_error(error_message, error_capacity, bootstrap_strerror(result));
        return result == BOOTSTRAP_UNKNOWN_SERVICE
            ? EMPV_MAC_FRAME_LINK_UNKNOWN_SERVICE
            : -1;
    }
    sender->send_port = send_port;
    return 0;
}

extern "C" int32_t empv_mac_frame_sender_send_pool(
    EmpvMacFrameSender* sender,
    const char* session_id,
    uint64_t generation,
    const EmpvMacSessionSurface* surface,
    char* error_message,
    size_t error_capacity
) {
    if (!sender || !session_id || session_id[0] == '\0' ||
        std::strlen(session_id) >= kFrameLinkSessionIdMax || !surface) {
        empv_mac_write_error(error_message, error_capacity, "Invalid frame-link pool message arguments.");
        return EMPV_MAC_FRAME_LINK_FATAL_SETUP_FAILED;
    }
    EmpvMacRenderSize size = {};
    empv_mac_session_surface_size(surface, &size);
    if (size.width_pixels <= 0 || size.height_pixels <= 0) {
        empv_mac_write_error(error_message, error_capacity, "The IOSurface pool is unavailable.");
        return EMPV_MAC_FRAME_LINK_FATAL_SETUP_FAILED;
    }

    if (sender->send_port == MACH_PORT_NULL) {
        empv_mac_write_error(error_message, error_capacity, "The frame-link sender is not connected.");
        return EMPV_MAC_FRAME_LINK_FATAL_SETUP_FAILED;
    }
    const mach_port_t send_port = sender->send_port;

    mach_port_t surface_ports[EMPV_MAC_SURFACE_COUNT] = {};
    for (int32_t index = 0; index < EMPV_MAC_SURFACE_COUNT; index += 1) {
        IOSurfaceRef io_surface = empv_mac_session_surface_at(surface, index);
        surface_ports[index] =
            io_surface ? IOSurfaceCreateMachPort(io_surface) : MACH_PORT_NULL;
        if (surface_ports[index] == MACH_PORT_NULL) {
            deallocate_surface_ports(surface_ports);
            empv_mac_write_error(error_message, error_capacity, "Failed to create IOSurface Mach ports.");
            return EMPV_MAC_FRAME_LINK_FATAL_SETUP_FAILED;
        }
    }

    FrameLinkPoolMessage message = {};
    message.header.msgh_bits =
        MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    message.header.msgh_size = sizeof(message);
    message.header.msgh_remote_port = send_port;
    message.header.msgh_id = kFrameLinkMessageId;
    message.body.msgh_descriptor_count = EMPV_MAC_SURFACE_COUNT;
    for (int32_t index = 0; index < EMPV_MAC_SURFACE_COUNT; index += 1) {
        message.surfaces[index].name = surface_ports[index];
        message.surfaces[index].disposition = MACH_MSG_TYPE_COPY_SEND;
        message.surfaces[index].type = MACH_MSG_PORT_DESCRIPTOR;
    }
    message.payload.magic = kFrameLinkMagic;
    message.payload.version = kFrameLinkVersion;
    std::memcpy(message.payload.session_id, session_id, std::strlen(session_id));
    message.payload.generation = generation;
    message.payload.surface_count = EMPV_MAC_SURFACE_COUNT;
    message.payload.width_pixels = static_cast<uint32_t>(size.width_pixels);
    message.payload.height_pixels = static_cast<uint32_t>(size.height_pixels);

    const kern_return_t send_result = mach_msg(
        &message.header,
        MACH_SEND_MSG | MACH_SEND_TIMEOUT,
        sizeof(message),
        0,
        MACH_PORT_NULL,
        100,
        MACH_PORT_NULL
    );
    deallocate_surface_ports(surface_ports);
    if (send_result != KERN_SUCCESS) {
        if (send_result == MACH_SEND_INVALID_DEST) {
            mach_port_deallocate(mach_task_self(), sender->send_port);
            sender->send_port = MACH_PORT_NULL;
        }
        empv_mac_write_error(error_message, error_capacity, mach_error_string(send_result));
        return send_result == MACH_SEND_INVALID_DEST
            ? EMPV_MAC_FRAME_LINK_INVALID_DESTINATION
            : EMPV_MAC_FRAME_LINK_SEND_FAILED;
    }
    return 0;
}
#endif

#if defined(EMPV_MAC_FRAME_LINK_RECEIVER)
extern "C" EmpvMacFrameReceiver* empv_mac_frame_receiver_create(
    const char* service_name,
    void* callback_context,
    EmpvMacFramePoolCallback callback,
    EmpvMacContextReleaseCallback release_context,
    char* error_message,
    size_t error_capacity
) {
    if (!service_name || service_name[0] == '\0' ||
        std::strlen(service_name) >= BOOTSTRAP_MAX_NAME_LEN || !callback ||
        !release_context) {
        empv_mac_write_error(error_message, error_capacity, "Invalid frame-link receiver arguments.");
        return nullptr;
    }

    mach_port_t receive_port = MACH_PORT_NULL;
    const kern_return_t check_in_result =
        bootstrap_check_in(bootstrap_port, service_name, &receive_port);
    if (check_in_result != KERN_SUCCESS || receive_port == MACH_PORT_NULL) {
        empv_mac_write_error(error_message, error_capacity, bootstrap_strerror(check_in_result));
        return nullptr;
    }

    auto* receiver = new (std::nothrow) EmpvMacFrameReceiver();
    if (!receiver) {
        mach_port_mod_refs(
            mach_task_self(),
            receive_port,
            MACH_PORT_RIGHT_RECEIVE,
            -1
        );
        empv_mac_write_error(error_message, error_capacity, "Unable to allocate the frame-link receiver.");
        return nullptr;
    }
    receiver->receive_port = receive_port;
    receiver->callback_context = callback_context;
    receiver->callback = callback;
    receiver->release_context = release_context;
    receiver->queue =
        dispatch_queue_create("dev.empv.frame-link", DISPATCH_QUEUE_SERIAL);
    receiver->cancelled = dispatch_semaphore_create(0);
    if (!receiver->queue || !receiver->cancelled) {
        mach_port_mod_refs(
            mach_task_self(),
            receive_port,
            MACH_PORT_RIGHT_RECEIVE,
            -1
        );
        delete receiver;
        empv_mac_write_error(error_message, error_capacity, "Failed to create the frame-link dispatch queue.");
        return nullptr;
    }
    dispatch_queue_set_specific(
        receiver->queue,
        &kReceiverQueueKey,
        receiver,
        nullptr
    );
    receiver->source = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_MACH_RECV,
        receive_port,
        0,
        receiver->queue
    );
    if (!receiver->source) {
        mach_port_mod_refs(
            mach_task_self(),
            receive_port,
            MACH_PORT_RIGHT_RECEIVE,
            -1
        );
        delete receiver;
        empv_mac_write_error(error_message, error_capacity, "Failed to create the frame-link dispatch source.");
        return nullptr;
    }

    dispatch_source_set_event_handler(receiver->source, ^{
      drain_messages(receiver);
    });
    dispatch_source_set_cancel_handler(receiver->source, ^{
      mach_port_mod_refs(
          mach_task_self(),
          receive_port,
          MACH_PORT_RIGHT_RECEIVE,
          -1
      );
      const bool delete_after_cancel =
          receiver->delete_on_cancel.load(std::memory_order_acquire);
      dispatch_semaphore_t cancelled = receiver->cancelled;
      receiver->release_context(receiver->callback_context);
      dispatch_semaphore_signal(cancelled);
      if (delete_after_cancel) {
          delete receiver;
      }
    });
    dispatch_resume(receiver->source);
    return receiver;
}

extern "C" void empv_mac_frame_receiver_destroy(
    EmpvMacFrameReceiver* receiver
) {
    if (!receiver) {
        return;
    }
    if (!receiver->active.exchange(false, std::memory_order_acq_rel)) {
        return;
    }
    const bool on_receiver_queue =
        dispatch_get_specific(&kReceiverQueueKey) == receiver;
    receiver->delete_on_cancel.store(on_receiver_queue, std::memory_order_release);
    dispatch_source_cancel(receiver->source);
    if (on_receiver_queue) {
        return;
    }
    dispatch_semaphore_wait(receiver->cancelled, DISPATCH_TIME_FOREVER);
    delete receiver;
}

extern "C" void empv_mac_frame_pool_destroy(EmpvMacFramePool* pool) {
    destroy_pool(pool);
}

extern "C" void empv_mac_frame_pool_size(
    const EmpvMacFramePool* pool,
    EmpvMacRenderSize* size
) {
    if (size) {
        *size = pool ? pool->size : EmpvMacRenderSize{};
    }
}
#endif
