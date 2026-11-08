#pragma once

#include "core/il2cpp/Layout.hpp"
#include "core/mem/FakeBackend.hpp"
#include "core/unity/Layout.hpp"

#include <string>
#include <string_view>

namespace radar::test {

using mem::Address;

// Layouts used by core tests. Values mirror a typical x64 IL2CPP/Unity build, but the tests only
// rely on them being self-consistent.
inline constexpr il2cpp::Layout kIl2Cpp{
    .objectKlass = 0x0, .unityObjectCachedPtr = 0x10,
    .stringLength = 0x10, .stringChars = 0x14,
    .arrayLength = 0x18, .arrayData = 0x20,
    .listItems = 0x10, .listSize = 0x18,
    .dictEntries = 0x18, .dictCount = 0x20,
    .className = 0x10, .classNamespace = 0x18, .classParent = 0x58, .classStaticFields = 0xB8,
};

inline constexpr unity::Layout kUnity{
    .gomLastActiveNode = 0x20, .gomActiveNodes = 0x28,
    .listNodeNext = 0x8, .listNodeObject = 0x10,
    .gameObjectComponents = 0x58, .gameObjectComponentCount = 0x68, .gameObjectName = 0x88,
    .componentEntryStride = 0x10, .componentEntryComponent = 0x8,
    .componentManagedObject = 0x20, .componentGameObject = 0x58,
    .transformHierarchy = 0x70, .transformIndex = 0x78,
    .hierarchyParentIndices = 0x40, .hierarchyLocalTransforms = 0x68,
};

// Bump allocator over a FakeBackend process, with helpers to lay out managed objects.
class Heap {
public:
    Heap(mem::FakeBackend& fake, mem::Pid pid, Address base = 0x1'0000'0000) : fake_(fake), pid_(pid), next_(base) {}

    Address alloc(std::size_t size, std::size_t align = 16) {
        next_ = (next_ + align - 1) / align * align;
        const Address a = next_;
        next_ += size + 16;  // gap so neighbours don't touch
        // Mark the whole allocation as mapped (zeros).
        std::string zeros(size, '\0');
        fake_.write(pid_, a, zeros.data(), zeros.size());
        return a;
    }

    template <class T>
    void put(Address a, const T& v) { fake_.writeValue(pid_, a, v); }
    void putBytes(Address a, const void* data, std::size_t n) { fake_.write(pid_, a, data, n); }

    Address cString(std::string_view s) {
        const Address a = alloc(s.size() + 1);
        putBytes(a, s.data(), s.size());
        return a;
    }

    Address managedString(std::u16string_view s) {
        const Address a = alloc(kIl2Cpp.stringChars + s.size() * 2 + 2);
        put<std::int32_t>(a + kIl2Cpp.stringLength, static_cast<std::int32_t>(s.size()));
        putBytes(a + kIl2Cpp.stringChars, s.data(), s.size() * 2);
        return a;
    }

    // Il2CppClass with name/namespace/parent.
    Address klass(std::string_view name, std::string_view ns = "", Address parent = 0) {
        const Address k = alloc(0x130);
        put<Address>(k + kIl2Cpp.className, cString(name));
        put<Address>(k + kIl2Cpp.classNamespace, cString(ns));
        put<Address>(k + kIl2Cpp.classParent, parent);
        return k;
    }

    Address object(Address klass, std::size_t size = 0x100) {
        const Address o = alloc(size);
        put<Address>(o + kIl2Cpp.objectKlass, klass);
        return o;
    }

    template <class T>
    Address array(const std::vector<T>& elems, std::uint64_t lengthOverride = ~0ull) {
        const Address a = alloc(kIl2Cpp.arrayData + elems.size() * sizeof(T));
        put<std::uint64_t>(a + kIl2Cpp.arrayLength, lengthOverride == ~0ull ? elems.size() : lengthOverride);
        if (!elems.empty()) putBytes(a + kIl2Cpp.arrayData, elems.data(), elems.size() * sizeof(T));
        return a;
    }

    template <class T>
    Address list(const std::vector<T>& elems, std::size_t capacity = 0) {
        std::vector<T> backing = elems;
        backing.resize(std::max(capacity, elems.size()));
        const Address l = alloc(0x20);
        put<Address>(l + kIl2Cpp.listItems, array(backing));
        put<std::int32_t>(l + kIl2Cpp.listSize, static_cast<std::int32_t>(elems.size()));
        return l;
    }

private:
    mem::FakeBackend& fake_;
    mem::Pid pid_;
    Address next_;
};

}  // namespace radar::test
