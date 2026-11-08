#pragma once

#include <cstdint>

namespace radar::unity {

// Offsets of Unity engine (native C++) structures. They depend on the Unity version, not on the
// scripting backend; the game layer supplies them from its generated offsets.
struct Layout {
    // GameObjectManager: doubly-linked list of active GameObjects.
    std::uint32_t gomLastActiveNode;  // ListNode* (tail)
    std::uint32_t gomActiveNodes;     // ListNode* (head)
    std::uint32_t listNodeNext;       // ListNode*
    std::uint32_t listNodeObject;     // GameObject*

    // GameObject
    std::uint32_t gameObjectComponents;      // ComponentEntry* (inline dynamic_array data pointer)
    std::uint32_t gameObjectComponentCount;  // u64 (dynamic_array size)
    std::uint32_t gameObjectName;            // const char*

    // Component array entries: {typeInfo, Component*}. Entry 0 is always the Transform.
    std::uint32_t componentEntryStride;
    std::uint32_t componentEntryComponent;

    // Component
    std::uint32_t componentManagedObject;  // managed (C#) wrapper object
    std::uint32_t componentGameObject;     // owning GameObject*

    // Transform → TransformHierarchy
    std::uint32_t transformHierarchy;  // TransformHierarchy*
    std::uint32_t transformIndex;      // int32 slot of this transform in the hierarchy

    // TransformHierarchy
    std::uint32_t hierarchyParentIndices;   // int32[]: parent slot per slot, -1 for the root
    std::uint32_t hierarchyLocalTransforms; // TrsX[]: local translation/rotation/scale per slot
};

}  // namespace radar::unity
