#pragma once

#include <cstdint>

namespace radar::il2cpp {

// Offsets of IL2CPP runtime structures and managed object layouts (x64). They depend on the
// IL2CPP/Unity version, so the game layer supplies them from its generated offsets.
struct Layout {
    // Managed object header / UnityEngine.Object
    std::uint32_t objectKlass;          // Il2CppObject.klass
    std::uint32_t unityObjectCachedPtr; // UnityEngine.Object.m_CachedPtr → native object

    // System.String
    std::uint32_t stringLength;  // int32, UTF-16 code units
    std::uint32_t stringChars;   // UTF-16LE data

    // T[]
    std::uint32_t arrayLength;   // il2cpp_array_size_t (u64)
    std::uint32_t arrayData;     // first element

    // List<T>
    std::uint32_t listItems;     // T[] _items
    std::uint32_t listSize;      // int32 _size

    // Dictionary<K,V>
    std::uint32_t dictEntries;   // Entry[] entries; Entry = {int32 hashCode; int32 next; K; V}
    std::uint32_t dictCount;     // int32 count (slots used, including freed ones)

    // Il2CppClass
    std::uint32_t className;         // const char*
    std::uint32_t classNamespace;    // const char*
    std::uint32_t classParent;       // Il2CppClass*
    std::uint32_t classStaticFields; // void* static field block
};

}  // namespace radar::il2cpp
