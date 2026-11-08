#include "game/eft/Layouts.hpp"

#include <doctest/doctest.h>

// The generated offsets must fill every layout field (no field may silently stay zero, except
// those that are legitimately zero, like the object header's klass pointer).
TEST_CASE("EFT layouts are populated from the generated offsets") {
    using radar::eft::kIl2CppLayout;
    using radar::eft::kUnityLayout;
    CHECK(kIl2CppLayout.objectKlass == 0);
    CHECK(kIl2CppLayout.stringChars > kIl2CppLayout.stringLength);
    CHECK(kIl2CppLayout.classStaticFields != 0);
    CHECK(kUnityLayout.componentEntryStride != 0);
    CHECK(kUnityLayout.hierarchyLocalTransforms != 0);
}
