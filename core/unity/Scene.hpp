#pragma once

#include "core/il2cpp/Managed.hpp"
#include "core/mem/MemoryView.hpp"
#include "core/unity/Layout.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace radar::unity {

using mem::Address;

struct GameObjectRef {
    Address native = 0;
    std::string name;
};

// Access to the GameObjectManager's object list and to GameObject components.
class Scene {
public:
    static constexpr std::size_t kMaxNodes = 8192;
    static constexpr std::size_t kMaxComponents = 128;
    static constexpr std::size_t kMaxNameBytes = 64;

    Scene(const mem::MemoryView& mem, const Layout& layout) : mem_(mem), layout_(layout) {}

    struct Walk {
        std::vector<Address> objects;  // native GameObject* in list order
        enum class End { ReachedTail, InvalidNext, Cycle, Cap, BadHeader } end = End::BadHeader;
    };

    // Walks the active-object list from head to tail (inclusive). The walk itself is
    // pointer-serial (one read per node); node bodies are then read in one batch.
    [[nodiscard]] Walk activeObjects(Address gameObjectManager, std::size_t maxNodes = kMaxNodes) const;

    // Active GameObjects whose name equals `name`, case-insensitively.
    [[nodiscard]] std::vector<GameObjectRef> findByName(Address gameObjectManager, std::string_view name) const;

    [[nodiscard]] std::string objectName(Address gameObject) const;

    // Native components of a GameObject, in array order (index 0 is the Transform). Empty if the
    // count is outside 1..kMaxComponents.
    [[nodiscard]] std::vector<Address> components(Address gameObject) const;
    [[nodiscard]] std::optional<Address> transform(Address gameObject) const;
    [[nodiscard]] std::optional<Address> managedObject(Address component) const;
    [[nodiscard]] std::optional<Address> gameObjectOf(Address component) const;

    // First component whose managed object is an instance of `className` (class or base class,
    // see il2cpp::Managed::isInstanceOf). Returns the managed object.
    [[nodiscard]] std::optional<Address> findManagedComponent(Address gameObject, std::string_view className,
                                                              const il2cpp::Managed& managed) const;

private:
    mem::MemoryView mem_;
    Layout layout_;
};

}  // namespace radar::unity
