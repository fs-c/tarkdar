#pragma once

// Managed objects with a native side placed into a FakeWorld: components with a GameObject and a
// Transform, and item templates. Free functions; they only write to the world's heap.

#include "FakeWorld.hpp"

namespace radar::test {

// Gives a managed component a native side, a named GameObject and a Transform at `pos`.
inline void place(FakeWorld& w, Address managed, math::Vec3 pos, std::string_view name = "object",
                  math::Quat rotation = {}) {
    auto& h = w.heap;
    const Address native = h.alloc(0x100), go = h.alloc(0x100), transform = h.alloc(0x100);
    const Address hierarchy = h.alloc(0x100), trs = h.alloc(sizeof(unity::TrsX)), parents = h.alloc(4);
    h.put<Address>(managed + kIl2Cpp.unityObjectCachedPtr, native);
    h.put<Address>(native + kUnity.componentGameObject, go);
    h.put<Address>(go + kUnity.gameObjectName, h.cString(name));
    const Address entries = h.alloc(kUnity.componentEntryStride);
    h.put<Address>(entries + kUnity.componentEntryComponent, transform);
    h.put<Address>(go + kUnity.gameObjectComponents, entries);
    h.put<std::uint64_t>(go + kUnity.gameObjectComponentCount, 1);
    h.put<Address>(transform + kUnity.transformHierarchy, hierarchy);
    h.put<std::int32_t>(transform + kUnity.transformIndex, 0);
    h.put<Address>(hierarchy + kUnity.hierarchyLocalTransforms, trs);
    h.put<Address>(hierarchy + kUnity.hierarchyParentIndices, parents);
    h.put<std::int32_t>(parents, -1);
    h.put(trs, unity::TrsX{pos, 0, rotation, {1, 1, 1}, 0});
}

// Moves a component placed with place(), keeping its rotation.
inline void move(FakeWorld& w, Address managed, math::Vec3 pos) {
    mem::MemoryView view(w.fake, FakeWorld::kPid);
    const Address native = view.read<Address>(managed + kIl2Cpp.unityObjectCachedPtr);
    const Address go = view.read<Address>(native + kUnity.componentGameObject);
    const Address transform =
        view.read<Address>(view.read<Address>(go + kUnity.gameObjectComponents) + kUnity.componentEntryComponent);
    const Address trs =
        view.read<Address>(view.read<Address>(transform + kUnity.transformHierarchy) + kUnity.hierarchyLocalTransforms);
    auto local = view.read<unity::TrsX>(trs);
    local.t = pos;
    w.heap.put(trs, local);
}

// An item template with a MongoID string id.
inline Address itemWithTemplate(FakeWorld& w, std::u16string_view templateId, bool quest = false) {
    auto& h = w.heap;
    const Address item = h.alloc(0x100), tmpl = h.alloc(0x200);
    h.put<Address>(item + off::Item::Template, tmpl);
    h.put<Address>(tmpl + off::ItemTemplate::_id + off::MongoID::StringId, h.managedString(templateId));
    h.put<std::uint8_t>(tmpl + off::ItemTemplate::QuestItem, quest ? 1 : 0);
    return item;
}

}  // namespace radar::test
