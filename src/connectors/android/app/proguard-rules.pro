-allowaccessmodification
-repackageclasses
-overloadaggressively
-mergeinterfacesaggressively

# Keep the entry points
-keep class ai.tlbx.midterm.MainActivity { *; }
-keep class ai.tlbx.midterm.TerminalActivity { *; }

# Strip Kotlin metadata
-dontwarn kotlin.**
-assumenosideeffects class kotlin.jvm.internal.Intrinsics {
    static void checkNotNullParameter(...);
    static void checkNotNullExpressionValue(...);
    static void checkParameterIsNotNull(...);
    static void checkExpressionValueIsNotNull(...);
}
