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

// Offsets of the native Camera and of the engine's camera list. They depend on the Unity version;
// the game layer supplies them from its generated offsets.
struct CameraLayout {
    // Camera
    std::uint32_t worldToCamera;   // Matrix4x4: view matrix (OpenGL convention: looks down -Z)
    std::uint32_t viewProjection;  // Matrix4x4: projection × view, as used for culling
    std::uint32_t fieldOfView;     // float: vertical, degrees
    std::uint32_t aspect;          // float: width / height
    // The camera list (pointed to by a UnityPlayer global): {Camera** items, u32 count, …, u64 count}.
    // Unity versions differ in which count is filled; the 64-bit one wins when valid.
    std::uint32_t listItems;
    std::uint32_t listCount;
    std::uint32_t listCount64;
};

}  // namespace radar::unity
