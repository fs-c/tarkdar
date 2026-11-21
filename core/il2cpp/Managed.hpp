#pragma once

#include "core/il2cpp/Layout.hpp"
#include "core/mem/MemoryView.hpp"
#include "core/mem/ReadBatch.hpp"

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
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
    static constexpr std::size_t kDefaultMaxElements = 16384;

    Managed(const mem::MemoryView& mem, const Layout& layout)
        : mem_(mem), layout_(layout), classCache_(std::make_shared<ClassCache>()) {}

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

    // ---- batched forms -------------------------------------------------------------------------
    // The same results as the readers above, element for element, but for many inputs at once: one
    // batched read per step (2-3 in total) instead of a few reads per input.

    // readStringField for every field address.
    [[nodiscard]] std::vector<std::optional<std::string>> readStringFields(std::span<const Address> fieldAddresses,
                                                                           std::size_t maxChars = kDefaultMaxChars,
                                                                           Freshness freshness = Freshness::Cached) const;

    template <class T>
    [[nodiscard]] std::vector<std::optional<std::vector<T>>> readArrays(std::span<const Address> arrayObjects,
                                                                        std::size_t maxElements = kDefaultMaxElements,
                                                                        Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        const std::size_t n = arrayObjects.size();
        std::vector<Address> at(n);
        for (std::size_t i = 0; i < n; ++i)
            at[i] = mem::MemoryView::isUserPointer(arrayObjects[i]) ? arrayObjects[i] + layout_.arrayLength : 0;
        const auto lengths = mem::readEach<std::uint64_t>(mem_, at, freshness);
        std::vector<Span> spans(n);
        for (std::size_t i = 0; i < n; ++i)
            if (lengths[i] && *lengths[i] <= maxElements)
                spans[i] = {true, arrayObjects[i] + layout_.arrayData, static_cast<std::size_t>(*lengths[i])};
        return readElementsEach<T>(spans, freshness);
    }

    template <class T>
    [[nodiscard]] std::vector<std::optional<std::vector<T>>> readLists(std::span<const Address> listObjects,
                                                                       std::size_t maxElements = kDefaultMaxElements,
                                                                       Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        return readElementsEach<T>(readListHeaders(listObjects, maxElements, freshness), freshness);
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

    // HashSet<T> → the values of the occupied slots, in slot order. Unlike Dictionary's count, the
    // slot count (_lastIndex) is checked against the slots array's length: a mismatch means the
    // object isn't a HashSet with the assumed layout.
    template <class T>
    [[nodiscard]] std::optional<std::vector<T>> readHashSet(Address setObject,
                                                            std::size_t maxElements = kDefaultMaxElements,
                                                            Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        struct Slot {  // natural alignment matches the managed struct layout
            std::int32_t hashCode;
            std::int32_t next;
            T value;
        };
        std::int32_t used = 0;
        Address slots = 0;
        std::uint64_t capacity = 0;
        if (!mem::MemoryView::isUserPointer(setObject) ||
            !mem_.tryRead(setObject + layout_.hashSetLastIndex, used, freshness) || used < 0 ||
            static_cast<std::size_t>(used) > maxElements)
            return std::nullopt;
        if (used == 0) return std::vector<T>{};
        if (!mem_.tryRead(setObject + layout_.hashSetSlots, slots, freshness) ||
            !mem::MemoryView::isUserPointer(slots) ||
            !mem_.tryRead(slots + layout_.arrayLength, capacity, freshness) ||
            capacity < static_cast<std::uint64_t>(used))
            return std::nullopt;
        auto read = readElements<Slot>(slots + layout_.arrayData, static_cast<std::size_t>(used), freshness);
        if (!read) return std::nullopt;
        std::vector<T> out;
        out.reserve(read->size());
        for (const Slot& s : *read)
            if (s.hashCode >= 0) out.push_back(s.value);  // hashCode < 0: freed slot
        return out;
    }

    // ---- class identity -----------------------------------------------------------------------
    [[nodiscard]] std::optional<Address> klassOf(Address object,
                                                 Freshness freshness = Freshness::Cached) const;
    [[nodiscard]] std::string className(Address klass) const;
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
    // The same, but nullopt where "no" can't be told: the ancestry couldn't be read up to
    // System.Object (a class name or parent pointer was unreadable), so the name might be further up.
    [[nodiscard]] std::optional<bool> classIsAKnown(Address klass, std::string_view name) const;
    // The ancestry as read, for logs: "ObservedLootItem < LootItem < … < System.Object", with "?" for
    // unreadable names and " (incomplete)" when the walk stopped before System.Object.
    [[nodiscard]] std::string describeAncestry(Address klass) const;

    // UnityEngine.Object → native engine object (m_CachedPtr).
    [[nodiscard]] std::optional<Address> nativePointer(Address unityObject,
                                                       Freshness freshness = Freshness::Cached) const;

private:
    static constexpr std::size_t kDefaultMaxChars = 128;

    [[nodiscard]] std::string classNamespace(Address klass) const;

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

    // Where a container's elements are: `ok` false means the container is unreadable (nullopt).
    struct Span {
        bool ok = false;
        Address first = 0;
        std::size_t count = 0;
    };
    [[nodiscard]] std::vector<Span> readListHeaders(std::span<const Address> listObjects, std::size_t maxElements,
                                                    Freshness freshness) const;

    template <class T>
    [[nodiscard]] std::vector<std::optional<std::vector<T>>> readElementsEach(std::span<const Span> spans,
                                                                              Freshness freshness) const {
        std::vector<std::vector<T>> values(spans.size());
        std::vector<mem::ReadBatch::Handle> handles(spans.size());
        mem::ReadBatch batch(mem_);
        for (std::size_t i = 0; i < spans.size(); ++i) {
            if (!spans[i].ok || spans[i].count == 0) continue;
            values[i].resize(spans[i].count);
            handles[i] = batch.addBytes(spans[i].first, values[i].data(), spans[i].count * sizeof(T));
        }
        batch.execute(freshness);
        std::vector<std::optional<std::vector<T>>> out(spans.size());
        for (std::size_t i = 0; i < spans.size(); ++i)
            if (spans[i].ok && (spans[i].count == 0 || batch.complete(handles[i]))) out[i] = std::move(values[i]);
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
    struct Ancestry {
        std::vector<ClassNames> chain;
        bool complete = false;  // read up to System.Object, every name readable
    };
    [[nodiscard]] Ancestry ancestry(Address klass) const;

    mem::MemoryView mem_;
    Layout layout_;
    std::shared_ptr<ClassCache> classCache_;
};

}  // namespace radar::il2cpp
