#include "core/il2cpp/Managed.hpp"

#include "core/text/Utf16.hpp"

#include <algorithm>

namespace radar::il2cpp {

namespace {
constexpr std::size_t kClassNameMax = 256;
}

std::optional<std::string> Managed::readString(Address stringObject, std::size_t maxChars,
                                               Overflow overflow, Freshness freshness) const {
    maxChars = std::min(maxChars, kMaxChars);
    std::int32_t length = 0;
    if (!mem::MemoryView::isUserPointer(stringObject) ||
        !mem_.tryRead(stringObject + layout_.stringLength, length, freshness) || length < 0)
        return std::nullopt;
    std::size_t n = static_cast<std::size_t>(length);
    if (n > maxChars) {
        if (overflow == Overflow::Reject) return std::nullopt;
        n = maxChars;
    }
    if (n == 0) return std::string{};
    std::vector<char16_t> buf(n);
    if (!mem_.readBytes(stringObject + layout_.stringChars, std::as_writable_bytes(std::span{buf}), freshness))
        return std::nullopt;
    return text::utf16ToUtf8(buf);
}

std::optional<std::string> Managed::readStringField(Address fieldAddress, std::size_t maxChars,
                                                    Overflow overflow, Freshness freshness) const {
    Address object = 0;
    if (!mem::MemoryView::isUserPointer(fieldAddress) || !mem_.tryRead(fieldAddress, object, freshness))
        return std::nullopt;
    auto s = readString(object, maxChars, overflow, freshness);
    if (!s) return std::nullopt;
    const auto end = s->find_last_not_of(" \t\r\n");
    s->erase(end == std::string::npos ? 0 : end + 1);
    return s;
}

std::optional<Managed::ListHeader> Managed::readListHeader(Address listObject, std::size_t maxElements,
                                                           Freshness freshness) const {
    std::int32_t size = 0;
    Address items = 0;
    if (!mem::MemoryView::isUserPointer(listObject) ||
        !mem_.tryRead(listObject + layout_.listSize, size, freshness) || size < 0 ||
        static_cast<std::size_t>(size) > maxElements)
        return std::nullopt;
    if (size == 0) return ListHeader{0, 0};
    std::uint64_t capacity = 0;
    if (!mem_.tryRead(listObject + layout_.listItems, items, freshness) ||
        !mem::MemoryView::isUserPointer(items) ||
        !mem_.tryRead(items + layout_.arrayLength, capacity, freshness) ||
        capacity < static_cast<std::uint64_t>(size))  // _size can never exceed the backing array
        return std::nullopt;
    return ListHeader{items, static_cast<std::size_t>(size)};
}

std::optional<Address> Managed::klassOf(Address object, Freshness freshness) const {
    Address klass = 0;
    if (!mem::MemoryView::isUserPointer(object) || !mem_.tryRead(object + layout_.objectKlass, klass, freshness) ||
        !mem::MemoryView::isUserPointer(klass))
        return std::nullopt;
    return klass;
}

std::string Managed::className(Address klass) const {
    if (!mem::MemoryView::isUserPointer(klass)) return {};
    return mem_.readCString(mem_.read<Address>(klass + layout_.className), kClassNameMax);
}

std::string Managed::classNamespace(Address klass) const {
    if (!mem::MemoryView::isUserPointer(klass)) return {};
    return mem_.readCString(mem_.read<Address>(klass + layout_.classNamespace), kClassNameMax);
}

std::string Managed::fullClassName(Address klass) const {
    std::string name = className(klass);
    if (name.empty()) return {};
    std::string ns = classNamespace(klass);
    return ns.empty() ? name : ns + "." + name;
}

std::optional<Address> Managed::parentClass(Address klass) const {
    if (!mem::MemoryView::isUserPointer(klass)) return std::nullopt;
    const Address parent = mem_.read<Address>(klass + layout_.classParent);
    if (!mem::MemoryView::isUserPointer(parent)) return std::nullopt;
    return parent;
}

std::string Managed::classNameOf(Address object) const {
    const auto klass = klassOf(object);
    return klass ? className(*klass) : std::string{};
}

std::vector<Managed::ClassNames> Managed::ancestry(Address klass) const {
    {
        std::lock_guard lock(classCache_->mutex);
        if (auto it = classCache_->ancestry.find(klass); it != classCache_->ancestry.end()) return it->second;
    }
    std::vector<ClassNames> chain;
    bool complete = false, namesComplete = true;
    std::optional<Address> k = klass;
    for (int depth = 0; k && depth < kMaxClassDepth; ++depth) {
        ClassNames names{className(*k), fullClassName(*k)};
        // An unnamed class (unreadable or empty name) must not end the walk: its ancestors still
        // count (e.g. Vest < <unnamed> < CompoundItem). Keep walking, but don't cache the chain
        // in case the name read was transient.
        if (names.shortName.empty()) namesComplete = false;
        chain.push_back(std::move(names));
        const Address parentField = mem_.read<Address>(*k + layout_.classParent);
        if (parentField == 0) {
            complete = true;  // reached the root (System.Object has no parent)
            break;
        }
        const auto parent = parentClass(*k);
        if (!parent || parent == k) break;  // unreadable or corrupt
        k = parent;
    }
    if (complete && namesComplete) {
        std::lock_guard lock(classCache_->mutex);
        classCache_->ancestry.emplace(klass, chain);
    }
    return chain;
}

bool Managed::classIsA(Address klass, std::string_view name) const {
    const bool full = name.find('.') != std::string_view::npos;
    for (const auto& c : ancestry(klass))
        if ((full ? c.fullName : c.shortName) == name) return true;
    return false;
}

bool Managed::isInstanceOf(Address object, std::string_view name) const {
    const auto klass = klassOf(object);
    return klass && classIsA(*klass, name);
}

std::optional<Address> Managed::nativePointer(Address unityObject, Freshness freshness) const {
    Address native = 0;
    if (!mem::MemoryView::isUserPointer(unityObject) ||
        !mem_.tryRead(unityObject + layout_.unityObjectCachedPtr, native, freshness) ||
        !mem::MemoryView::isUserPointer(native))
        return std::nullopt;
    return native;
}

}  // namespace radar::il2cpp
