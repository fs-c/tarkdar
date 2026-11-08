#pragma once

#include "core/il2cpp/Layout.hpp"
#include "core/mem/MemoryView.hpp"

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace radar::il2cpp {

using mem::Address;
using mem::Freshness;

// Readers for IL2CPP managed objects: strings, arrays, lists, dictionaries, and class identity.
//
// Conventions for every reader:
//  - nullopt means "couldn't read a trustworthy value": invalid pointer, failed read, or a count
//    outside its sanity cap. An empty container or string is a valid result.
//  - Element types must be trivially copyable (use Address for reference-type elements).
class Managed {
public:
    // Default sanity caps, matching what the game code needs today.
    static constexpr std::size_t kDefaultMaxChars = 128;
    static constexpr std::size_t kMaxChars = 4096;
    static constexpr std::size_t kDefaultMaxElements = 16384;
    static constexpr int kMaxClassDepth = 32;

    Managed(const mem::MemoryView& mem, const Layout& layout)
        : mem_(mem), layout_(layout), classCache_(std::make_shared<ClassCache>()) {}

    [[nodiscard]] const mem::MemoryView& memory() const noexcept { return mem_; }
    [[nodiscard]] const Layout& layout() const noexcept { return layout_; }

    // ---- strings ------------------------------------------------------------------------------
    enum class Overflow {
        Reject,    // length > maxChars → nullopt
        Truncate,  // length > maxChars → first maxChars characters
    };

    // System.String object → UTF-8. Cuts at the first NUL.
    [[nodiscard]] std::optional<std::string> readString(Address stringObject,
                                                        std::size_t maxChars = kDefaultMaxChars,
                                                        Overflow overflow = Overflow::Reject,
                                                        Freshness freshness = Freshness::Cached) const;

    // Reads the string pointer stored at fieldAddress, then the string, and strips trailing
    // whitespace. A null field yields nullopt.
    [[nodiscard]] std::optional<std::string> readStringField(Address fieldAddress,
                                                             std::size_t maxChars = kDefaultMaxChars,
                                                             Overflow overflow = Overflow::Reject,
                                                             Freshness freshness = Freshness::Cached) const;

    // ---- containers ---------------------------------------------------------------------------
    template <class T>
    [[nodiscard]] std::optional<std::vector<T>> readArray(Address arrayObject,
                                                          std::size_t maxElements = kDefaultMaxElements,
                                                          Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        std::uint64_t length = 0;
        if (!mem::MemoryView::isUserPointer(arrayObject) ||
            !mem_.tryRead(arrayObject + layout_.arrayLength, length, freshness) || length > maxElements)
            return std::nullopt;
        return readElements<T>(arrayObject + layout_.arrayData, static_cast<std::size_t>(length), freshness);
    }

    template <class T>
    [[nodiscard]] std::optional<std::vector<T>> readList(Address listObject,
                                                         std::size_t maxElements = kDefaultMaxElements,
                                                         Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        auto header = readListHeader(listObject, maxElements, freshness);
        if (!header) return std::nullopt;
        if (header->size == 0) return std::vector<T>{};
        return readElements<T>(header->items + layout_.arrayData, header->size, freshness);
    }

    // Dictionary<K,V> → (key, value) pairs of the occupied slots, in slot order.
    template <class K, class V>
    [[nodiscard]] std::optional<std::vector<std::pair<K, V>>> readDictionary(
        Address dictObject, std::size_t maxElements = kDefaultMaxElements,
        Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<K> && std::is_trivially_copyable_v<V>);
        struct Entry {  // natural alignment matches the managed struct layout
            std::int32_t hashCode;
            std::int32_t next;
            K key;
            V value;
        };
        std::int32_t count = 0;
        Address entries = 0;
        if (!mem::MemoryView::isUserPointer(dictObject) ||
            !mem_.tryRead(dictObject + layout_.dictCount, count, freshness) || count < 0 ||
            static_cast<std::size_t>(count) > maxElements)
            return std::nullopt;
        if (count == 0) return std::vector<std::pair<K, V>>{};
        if (!mem_.tryRead(dictObject + layout_.dictEntries, entries, freshness) ||
            !mem::MemoryView::isUserPointer(entries))
            return std::nullopt;
        auto slots = readElements<Entry>(entries + layout_.arrayData, static_cast<std::size_t>(count), freshness);
        if (!slots) return std::nullopt;
        std::vector<std::pair<K, V>> out;
        out.reserve(slots->size());
        for (const Entry& e : *slots)
            if (e.hashCode >= 0) out.emplace_back(e.key, e.value);  // hashCode < 0: freed slot
        return out;
    }

    // ---- class identity -----------------------------------------------------------------------
    [[nodiscard]] std::optional<Address> klassOf(Address object,
                                                 Freshness freshness = Freshness::Cached) const;
    [[nodiscard]] std::string className(Address klass) const;
    [[nodiscard]] std::string classNamespace(Address klass) const;
    // "Namespace.Name", or just "Name" for an empty namespace (e.g. nested types).
    [[nodiscard]] std::string fullClassName(Address klass) const;
    [[nodiscard]] std::optional<Address> parentClass(Address klass) const;

    // Short class name of an object's runtime class; empty on failure.
    [[nodiscard]] std::string classNameOf(Address object) const;

    // True if the object's class, or any base class, matches `name`. A name containing '.' is
    // compared against the full name, otherwise against the short name. Class ancestries are cached
    // by class pointer (classes don't move or change for the life of the process).
    [[nodiscard]] bool isInstanceOf(Address object, std::string_view name) const;
    [[nodiscard]] bool classIsA(Address klass, std::string_view name) const;

    // UnityEngine.Object → native engine object (m_CachedPtr).
    [[nodiscard]] std::optional<Address> nativePointer(Address unityObject,
                                                       Freshness freshness = Freshness::Cached) const;

private:
    struct ListHeader {
        Address items;
        std::size_t size;
    };
    [[nodiscard]] std::optional<ListHeader> readListHeader(Address listObject, std::size_t maxElements,
                                                           Freshness freshness) const;

    template <class T>
    [[nodiscard]] std::optional<std::vector<T>> readElements(Address first, std::size_t count,
                                                             Freshness freshness) const {
        std::vector<T> out(count);
        if (count == 0) return out;
        if (!mem_.readBytes(first, std::as_writable_bytes(std::span{out}), freshness)) return std::nullopt;
        return out;
    }

    struct ClassNames {
        std::string shortName, fullName;
    };
    // Class → its ancestry (itself first). Shared by copies of this Managed; thread-safe.
    struct ClassCache {
        std::mutex mutex;
        std::unordered_map<Address, std::vector<ClassNames>> ancestry;
    };
    [[nodiscard]] std::vector<ClassNames> ancestry(Address klass) const;

    mem::MemoryView mem_;
    Layout layout_;
    std::shared_ptr<ClassCache> classCache_;
};

}  // namespace radar::il2cpp
