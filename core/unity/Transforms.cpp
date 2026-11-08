#include "core/unity/Transforms.hpp"

#include "core/mem/ReadBatch.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <utility>

namespace radar::unity {

using mem::Freshness;
using mem::MemoryView;

namespace {

bool plausible(const Pose& pose) {
    constexpr float kOrigin = 0.001f;
    const auto& p = pose.position;
    if (!math::isSane(p)) return false;
    return !(std::fabs(p.x) < kOrigin && std::fabs(p.y) < kOrigin && std::fabs(p.z) < kOrigin);
}

}  // namespace

std::optional<Address> Transforms::resolveNative(Address transform, const il2cpp::Managed& managed) const {
    auto looksNative = [&](Address c) {
        if (!MemoryView::isUserPointer(c)) return false;
        const Address hierarchy = mem_.read<Address>(c + layout_.transformHierarchy);
        const auto index = mem_.read<std::int32_t>(c + layout_.transformIndex);
        return MemoryView::isUserPointer(hierarchy) && index >= 0 && index < kMaxIndex;
    };
    if (auto native = managed.nativePointer(transform); native && looksNative(*native)) return native;
    if (looksNative(transform)) return transform;
    return std::nullopt;
}

std::optional<Pose> Transforms::compose(std::int32_t index, std::span<const TrsX> local,
                                        std::span<const std::int32_t> parents) {
    if (index < 0 || static_cast<std::size_t>(index) >= local.size() || local.size() != parents.size())
        return std::nullopt;
    Pose pose{local[index].t, local[index].q};
    std::int32_t cur = index;
    for (std::size_t depth = 0;; ++depth) {
        const std::int32_t parent = parents[cur];
        if (parent < 0) break;  // reached the root
        // The depth cap also ends cycles in corrupt data.
        if (static_cast<std::size_t>(parent) >= local.size() || depth >= kMaxDepth) return std::nullopt;
        const TrsX& p = local[parent];
        pose.position = math::rotate(p.q, math::hadamard(pose.position, p.s)) + p.t;
        pose.rotation = p.q * pose.rotation;
        cur = parent;
    }
    pose.rotation = math::normalized(pose.rotation);
    if (!plausible(pose)) return std::nullopt;
    return pose;
}

std::optional<Pose> Transforms::composeByChain(std::int32_t index, Address localTransforms, Address parentIndices,
                                               Freshness freshness) const {
    // Parent indices one hop at a time, then the TRS of each chain slot.
    std::vector<std::int32_t> chain{index};
    while (true) {
        const auto parent =
            mem_.read<std::int32_t>(parentIndices + static_cast<Address>(chain.back()) * sizeof(std::int32_t), freshness);
        if (parent < 0) break;
        if (parent >= kMaxIndex || chain.size() >= kMaxDepth) return std::nullopt;  // garbage or a cycle
        chain.push_back(parent);
    }
    std::vector<TrsX> local(chain.size());
    mem::ReadBatch batch(mem_);
    for (std::size_t k = 0; k < chain.size(); ++k)
        batch.add(localTransforms + static_cast<Address>(chain[k]) * sizeof(TrsX), local[k]);
    batch.execute(freshness);
    for (std::size_t k = 0; k < chain.size(); ++k)
        if (!batch.complete(k)) return std::nullopt;
    // Compact form for compose(): slot k's parent is k + 1, the root is last.
    std::vector<std::int32_t> parents(chain.size());
    for (std::size_t k = 0; k < chain.size(); ++k)
        parents[k] = k + 1 < chain.size() ? static_cast<std::int32_t>(k + 1) : -1;
    return compose(0, local, parents);
}

std::vector<std::optional<Pose>> Transforms::worldPoses(std::span<const Address> transforms,
                                                        Freshness freshness) const {
    const std::size_t n = transforms.size();
    std::vector<std::optional<Pose>> out(n);

    // Stage 1: hierarchy pointer and slot index of every transform.
    std::vector<Address> hierarchies(n);
    std::vector<std::int32_t> indices(n, -1);
    {
        mem::ReadBatch batch(mem_);
        for (std::size_t i = 0; i < n; ++i) {
            if (!MemoryView::isUserPointer(transforms[i])) continue;
            batch.add(transforms[i] + layout_.transformHierarchy, hierarchies[i]);
            batch.add(transforms[i] + layout_.transformIndex, indices[i]);
        }
        batch.execute(freshness);
    }

    // Stage 2: array pointers per distinct hierarchy, and the highest slot index needed.
    struct Group {
        Address localTransforms = 0;
        Address parentIndices = 0;
        std::int32_t maxIndex = -1;
        std::vector<TrsX> local;
        std::vector<std::int32_t> parents;
    };
    std::map<Address, Group> groups;
    for (std::size_t i = 0; i < n; ++i) {
        if (!MemoryView::isUserPointer(hierarchies[i]) || indices[i] < 0 || indices[i] >= kMaxIndex) continue;
        auto& g = groups[hierarchies[i]];
        g.maxIndex = std::max(g.maxIndex, indices[i]);
    }
    {
        mem::ReadBatch batch(mem_);
        for (auto& [hierarchy, g] : groups) {
            batch.add(hierarchy + layout_.hierarchyLocalTransforms, g.localTransforms);
            batch.add(hierarchy + layout_.hierarchyParentIndices, g.parentIndices);
        }
        batch.execute(freshness);
    }

    // Stage 3: bulk-read the [0, maxIndex] prefix of small hierarchies.
    {
        mem::ReadBatch batch(mem_);
        std::vector<std::pair<Group*, std::pair<mem::ReadBatch::Handle, mem::ReadBatch::Handle>>> reads;
        for (auto& [hierarchy, g] : groups) {
            const auto count = static_cast<std::size_t>(g.maxIndex) + 1;
            if (!MemoryView::isUserPointer(g.localTransforms) || !MemoryView::isUserPointer(g.parentIndices) ||
                count > kBulkMaxSlots)
                continue;
            g.local.resize(count);
            g.parents.resize(count);
            const auto a = batch.addBytes(g.localTransforms, g.local.data(), count * sizeof(TrsX));
            const auto b = batch.addBytes(g.parentIndices, g.parents.data(), count * sizeof(std::int32_t));
            reads.push_back({&g, {a, b}});
        }
        batch.execute(freshness);
        for (auto& [g, handles] : reads) {
            if (!batch.complete(handles.first) || !batch.complete(handles.second)) {
                g->local.clear();
                g->parents.clear();
            }
        }
    }

    // Stage 4: compose from the bulk-read prefix. Parents usually sit at lower indices than their
    // children, so the prefix holds every ancestor; if not (or for large hierarchies), walk just this
    // transform's parent chain with individual reads.
    for (std::size_t i = 0; i < n; ++i) {
        auto it = groups.find(hierarchies[i]);
        if (it == groups.end() || indices[i] < 0 || indices[i] >= kMaxIndex) continue;
        Group& g = it->second;
        if (!g.local.empty()) {
            out[i] = compose(indices[i], g.local, g.parents);
            if (out[i]) continue;
        }
        if (!MemoryView::isUserPointer(g.localTransforms) || !MemoryView::isUserPointer(g.parentIndices)) continue;
        out[i] = composeByChain(indices[i], g.localTransforms, g.parentIndices, freshness);
    }
    return out;
}

}  // namespace radar::unity
