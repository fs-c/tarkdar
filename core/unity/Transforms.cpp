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

bool Transforms::isNative(Address transform) const {
    if (!MemoryView::isUserPointer(transform)) return false;
    const Address hierarchy = mem_.read<Address>(transform + layout_.transformHierarchy);
    const auto index = mem_.read<std::int32_t>(transform + layout_.transformIndex);
    return MemoryView::isUserPointer(hierarchy) && index >= 0 && index < kMaxIndex;
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

void Transforms::composeByChains(std::span<ChainWalk> walks, std::span<std::optional<Pose>> out,
                                 Freshness freshness) const {
    // Parent indices one hop at a time for every chain together (one batch per hop: a chain is at
    // most kMaxDepth long, but the batches are few, where reading each hop of each chain on its own
    // took thousands of calls per tick while players spawned), then the TRS of every chain slot.
    std::vector<ChainWalk*> active;
    for (auto& w : walks) {
        w.chain.assign(1, w.index);
        active.push_back(&w);
    }
    while (!active.empty()) {
        std::vector<std::int32_t> parents(active.size());
        mem::ReadBatch batch(mem_);
        for (std::size_t i = 0; i < active.size(); ++i) {
            const auto* w = active[i];
            batch.add(w->parentIndices + static_cast<Address>(w->chain.back()) * sizeof(std::int32_t), parents[i]);
        }
        batch.execute(freshness);
        std::vector<ChainWalk*> next;
        for (std::size_t i = 0; i < active.size(); ++i) {
            ChainWalk& w = *active[i];
            const std::int32_t parent = parents[i];
            if (!batch.complete(i) || parent >= kMaxIndex || (parent >= 0 && w.chain.size() >= kMaxDepth)) {
                w.chain.clear();  // unreadable, garbage or a cycle
            } else if (parent >= 0) {
                w.chain.push_back(parent);
                next.push_back(&w);
            }
        }
        active = std::move(next);
    }

    std::vector<std::vector<TrsX>> locals(walks.size());
    mem::ReadBatch batch(mem_);
    std::vector<std::pair<std::size_t, std::size_t>> firstLast(walks.size());  // handle range per walk
    for (std::size_t i = 0; i < walks.size(); ++i) {
        const auto& w = walks[i];
        locals[i].resize(w.chain.size());
        firstLast[i].first = batch.size();
        for (std::size_t k = 0; k < w.chain.size(); ++k)
            batch.add(w.localTransforms + static_cast<Address>(w.chain[k]) * sizeof(TrsX), locals[i][k]);
        firstLast[i].second = batch.size();
    }
    batch.execute(freshness);
    for (std::size_t i = 0; i < walks.size(); ++i) {
        const auto& w = walks[i];
        if (w.chain.empty()) continue;
        bool complete = true;
        for (std::size_t h = firstLast[i].first; h < firstLast[i].second; ++h) complete = complete && batch.complete(h);
        if (!complete) continue;
        // Compact form for compose(): slot k's parent is k + 1, the root is last.
        std::vector<std::int32_t> parents(w.chain.size());
        for (std::size_t k = 0; k < w.chain.size(); ++k)
            parents[k] = k + 1 < w.chain.size() ? static_cast<std::int32_t>(k + 1) : -1;
        out[w.out] = compose(0, locals[i], parents);
    }
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
    // children, so the prefix holds every ancestor; if not (or for large hierarchies, or when the bulk
    // read failed), walk just these transforms' parent chains.
    std::vector<ChainWalk> walks;
    for (std::size_t i = 0; i < n; ++i) {
        auto it = groups.find(hierarchies[i]);
        if (it == groups.end() || indices[i] < 0 || indices[i] >= kMaxIndex) continue;
        Group& g = it->second;
        if (!g.local.empty()) {
            out[i] = compose(indices[i], g.local, g.parents);
            if (out[i]) continue;
        }
        if (!MemoryView::isUserPointer(g.localTransforms) || !MemoryView::isUserPointer(g.parentIndices)) continue;
        walks.push_back(ChainWalk{.out = i, .index = indices[i], .localTransforms = g.localTransforms,
                                  .parentIndices = g.parentIndices, .chain = {}});
    }
    if (!walks.empty()) composeByChains(walks, out, freshness);
    return out;
}

}  // namespace radar::unity
