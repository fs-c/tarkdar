#include "TestMemory.hpp"

#include "game/eft/Layouts.hpp"

#include <doctest/doctest.h>

#include <cstring>

// The game's layouts must be exactly the ones the test heap lays out objects with (test::kIl2Cpp,
// test::kUnity); FakeWorld relies on it.
TEST_CASE("EFT layouts are the ones the test heap uses") {
    using namespace radar;
    static_assert(sizeof(il2cpp::Layout) == sizeof(test::kIl2Cpp));
    static_assert(sizeof(unity::Layout) == sizeof(test::kUnity));
    CHECK(std::memcmp(&eft::kIl2CppLayout, &test::kIl2Cpp, sizeof(test::kIl2Cpp)) == 0);
    CHECK(std::memcmp(&eft::kUnityLayout, &test::kUnity, sizeof(test::kUnity)) == 0);
}

// Spot checks that the generated offsets filled the layouts (a few fields that must be non-zero, and
// one that is legitimately zero: the object header's klass pointer).
TEST_CASE("EFT layouts are populated from the generated offsets") {
    using radar::eft::kIl2CppLayout;
    using radar::eft::kUnityLayout;
    CHECK(kIl2CppLayout.objectKlass == 0);
    CHECK(kIl2CppLayout.stringChars > kIl2CppLayout.stringLength);
    CHECK(kIl2CppLayout.classStaticFields != 0);
    CHECK(kUnityLayout.componentEntryStride != 0);
    CHECK(kUnityLayout.hierarchyLocalTransforms != 0);
}
