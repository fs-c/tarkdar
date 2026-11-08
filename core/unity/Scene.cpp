#include "core/unity/Scene.hpp"

#include "core/mem/ReadBatch.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <unordered_set>

namespace radar::unity {

using mem::Freshness;
using mem::MemoryView;

namespace {
bool equalsIgnoreCase(std::string_view a, std::string_view b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
               return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
           });
}
}  // namespace

Scene::Walk Scene::activeObjects(Address gom, std::size_t maxNodes) const {
    Walk walk;
    Address head = 0, tail = 0;
    if (!MemoryView::isUserPointer(gom) || !mem_.tryRead(gom + layout_.gomActiveNodes, head, Freshness::Fresh) ||
        !mem_.tryRead(gom + layout_.gomLastActiveNode, tail, Freshness::Fresh) ||
        !MemoryView::isUserPointer(head) || !MemoryView::isUserPointer(tail))
        return walk;

    std::vector<Address> nodes;
    std::unordered_set<Address> visited;
    Address cur = head;
    walk.end = Walk::End::InvalidNext;
    while (MemoryView::isUserPointer(cur)) {
        if (nodes.size() >= maxNodes) {
            walk.end = Walk::End::Cap;
            break;
        }
        if (!visited.insert(cur).second) {
            walk.end = Walk::End::Cycle;
            break;
        }
        nodes.push_back(cur);
        if (cur == tail) {
            walk.end = Walk::End::ReachedTail;
            break;
        }
        cur = mem_.read<Address>(cur + layout_.listNodeNext, Freshness::Fresh);
    }

    std::vector<Address> objects(nodes.size());
    mem::ReadBatch batch(mem_);
    for (std::size_t i = 0; i < nodes.size(); ++i) batch.add(nodes[i] + layout_.listNodeObject, objects[i]);
    batch.execute(Freshness::Fresh);
    for (Address o : objects)
        if (MemoryView::isUserPointer(o)) walk.objects.push_back(o);
    return walk;
}

std::vector<GameObjectRef> Scene::findByName(Address gom, std::string_view name) const {
    const Walk walk = activeObjects(gom);
    const std::size_t n = walk.objects.size();

    std::vector<Address> namePtrs(n);
    mem::ReadBatch ptrBatch(mem_);
    for (std::size_t i = 0; i < n; ++i) ptrBatch.add(walk.objects[i] + layout_.gameObjectName, namePtrs[i]);
    ptrBatch.execute(Freshness::Cached);

    std::vector<std::array<char, kMaxNameBytes>> names(n);
    mem::ReadBatch nameBatch(mem_);
    for (std::size_t i = 0; i < n; ++i)
        if (MemoryView::isUserPointer(namePtrs[i])) nameBatch.add(namePtrs[i], names[i]);
    nameBatch.execute(Freshness::Cached);

    std::vector<GameObjectRef> out;
    for (std::size_t i = 0; i < n; ++i) {
        const auto& buf = names[i];
        const std::string_view candidate(buf.data(), std::find(buf.begin(), buf.end(), '\0') - buf.begin());
        if (equalsIgnoreCase(candidate, name)) out.push_back({walk.objects[i], std::string(candidate)});
    }
    return out;
}

std::string Scene::objectName(Address gameObject) const {
    if (!MemoryView::isUserPointer(gameObject)) return {};
    return mem_.readCString(mem_.read<Address>(gameObject + layout_.gameObjectName), kMaxNameBytes);
}

std::vector<Address> Scene::components(Address gameObject) const {
    if (!MemoryView::isUserPointer(gameObject)) return {};
    std::uint64_t count = 0;
    Address entries = 0;
    if (!mem_.tryRead(gameObject + layout_.gameObjectComponentCount, count) || count == 0 ||
        count > kMaxComponents || !mem_.tryRead(gameObject + layout_.gameObjectComponents, entries) ||
        !MemoryView::isUserPointer(entries))
        return {};
    std::vector<Address> out(count);
    mem::ReadBatch batch(mem_);
    for (std::size_t i = 0; i < count; ++i)
        batch.add(entries + i * layout_.componentEntryStride + layout_.componentEntryComponent, out[i]);
    batch.execute(Freshness::Cached);
    return out;
}

std::optional<Address> Scene::transform(Address gameObject) const {
    Address entries = 0;
    if (!MemoryView::isUserPointer(gameObject) || !mem_.tryRead(gameObject + layout_.gameObjectComponents, entries) ||
        !MemoryView::isUserPointer(entries))
        return std::nullopt;
    const Address t = mem_.read<Address>(entries + layout_.componentEntryComponent);
    if (!MemoryView::isUserPointer(t)) return std::nullopt;
    return t;
}

std::optional<Address> Scene::managedObject(Address component) const {
    if (!MemoryView::isUserPointer(component)) return std::nullopt;
    const Address m = mem_.read<Address>(component + layout_.componentManagedObject);
    if (!MemoryView::isUserPointer(m)) return std::nullopt;
    return m;
}

std::optional<Address> Scene::gameObjectOf(Address component) const {
    if (!MemoryView::isUserPointer(component)) return std::nullopt;
    const Address go = mem_.read<Address>(component + layout_.componentGameObject);
    if (!MemoryView::isUserPointer(go)) return std::nullopt;
    return go;
}

std::optional<Address> Scene::findManagedComponent(Address gameObject, std::string_view className,
                                                   const il2cpp::Managed& managed) const {
    for (Address component : components(gameObject)) {
        const auto object = managedObject(component);
        if (object && managed.isInstanceOf(*object, className)) return object;
    }
    return std::nullopt;
}

}  // namespace radar::unity
