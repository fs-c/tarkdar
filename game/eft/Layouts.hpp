#pragma once

#include "core/il2cpp/Layout.hpp"
#include "core/unity/Layout.hpp"

#include <eft_offsets.hpp>

// The game's IL2CPP and Unity layouts, filled from the generated offsets.
namespace radar::eft {

inline constexpr il2cpp::Layout kIl2CppLayout{
    .objectKlass = off::managed::Object::Klass,
    .unityObjectCachedPtr = off::managed::UnityObject::CachedPtr,
    .stringLength = off::managed::String::Length,
    .stringChars = off::managed::String::Chars,
    .arrayLength = off::managed::Array::Length,
    .arrayData = off::managed::Array::Data,
    .listItems = off::managed::List::Items,
    .listSize = off::managed::List::Size,
    .dictEntries = off::managed::Dictionary::Entries,
    .dictCount = off::managed::Dictionary::Count,
    .className = off::managed::Il2CppClass::Name,
    .classNamespace = off::managed::Il2CppClass::Namespace,
    .classParent = off::managed::Il2CppClass::Parent,
    .classStaticFields = off::managed::Il2CppClass::StaticFields,
};

inline constexpr unity::Layout kUnityLayout{
    .gomLastActiveNode = off::unity::GameObjectManager::LastActiveNode,
    .gomActiveNodes = off::unity::GameObjectManager::ActiveNodes,
    .listNodeNext = off::unity::ListNode::Next,
    .listNodeObject = off::unity::ListNode::Object,
    .gameObjectComponents = off::unity::GameObject::Components,
    .gameObjectComponentCount = off::unity::GameObject::ComponentCount,
    .gameObjectName = off::unity::GameObject::Name,
    .componentEntryStride = off::unity::ComponentEntry::Stride,
    .componentEntryComponent = off::unity::ComponentEntry::Component,
    .componentManagedObject = off::unity::Component::ManagedObject,
    .componentGameObject = off::unity::Component::GameObject,
    .transformHierarchy = off::unity::Transform::Hierarchy,
    .transformIndex = off::unity::Transform::Index,
    .hierarchyParentIndices = off::unity::TransformHierarchy::ParentIndices,
    .hierarchyLocalTransforms = off::unity::TransformHierarchy::LocalTransforms,
};

}  // namespace radar::eft
