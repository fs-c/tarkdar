#pragma once

#include <memory>
#include <utility>

#include "core/sched/AtomicSharedPtr.hpp"

namespace radar::sched {

// Publication of immutable snapshots to many readers. Readers get a shared_ptr to a consistent
// value. Any number of threads may publish and read; the last publish wins. Lock-free where
// std::atomic<std::shared_ptr> is (see AtomicSharedPtr.hpp), otherwise a short mutex-guarded copy
// of the pointer, so readers and writers can briefly block each other.
template <class T>
class Published {
public:
    Published() : value_(std::make_shared<const T>()) {}

    void publish(T value) { value_.store(std::make_shared<const T>(std::move(value)), std::memory_order_release); }

    [[nodiscard]] std::shared_ptr<const T> get() const { return value_.load(std::memory_order_acquire); }

private:
    AtomicSharedPtr<const T> value_;
};

}  // namespace radar::sched
