#pragma once

#include <atomic>
#include <memory>

namespace radar::sched {

// Single-writer, many-reader publication of immutable snapshots. Readers get a shared_ptr to a
// consistent value and never block the writer (or each other).
template <class T>
class Published {
public:
    Published() : value_(std::make_shared<const T>()) {}

    void publish(T value) { value_.store(std::make_shared<const T>(std::move(value)), std::memory_order_release); }
    void publish(std::shared_ptr<const T> value) { value_.store(std::move(value), std::memory_order_release); }

    [[nodiscard]] std::shared_ptr<const T> get() const { return value_.load(std::memory_order_acquire); }

private:
    std::atomic<std::shared_ptr<const T>> value_;
};

}  // namespace radar::sched
