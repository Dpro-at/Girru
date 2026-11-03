plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    // Applied by :app only when its google-services.json is present.
    alias(libs.plugins.google.services) apply false
}
