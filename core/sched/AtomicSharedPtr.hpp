#pragma once

#include <atomic>
#include <memory>
#include <version>

#if !defined(__cpp_lib_atomic_shared_ptr)
#include <mutex>
#endif

namespace radar::sched {

// std::atomic<std::shared_ptr<T>> (C++20) where the standard library has it (libstdc++), with a
// mutex-based fallback for libc++ (Apple Clang), which doesn't implement it yet. The critical
// section is just a refcount copy/swap, so the fallback is fine for our publish/get pattern.
#if defined(__cpp_lib_atomic_shared_ptr)

template <class T>
using AtomicSharedPtr = std::atomic<std::shared_ptr<T>>;

#else

template <class T>
class AtomicSharedPtr {
public:
    AtomicSharedPtr() noexcept = default;
    AtomicSharedPtr(std::shared_ptr<T> value) noexcept : value_(std::move(value)) {}  // NOLINT(google-explicit-constructor)
    AtomicSharedPtr(const AtomicSharedPtr&) = delete;
    AtomicSharedPtr& operator=(const AtomicSharedPtr&) = delete;

    [[nodiscard]] std::shared_ptr<T> load(std::memory_order = std::memory_order_seq_cst) const {
        std::lock_guard lock(mutex_);
        return value_;
    }

    void store(std::shared_ptr<T> value, std::memory_order = std::memory_order_seq_cst) {
        {
            std::lock_guard lock(mutex_);
            value_.swap(value);
        }
        // The previous value (now in `value`) is released outside the lock.
    }

private:
    mutable std::mutex mutex_;
    std::shared_ptr<T> value_;
};

#endif

}  // namespace radar::sched
