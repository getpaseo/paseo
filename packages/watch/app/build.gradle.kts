plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

// The Wearable Data Layer only routes between a phone app and a watch app that
// share BOTH the same applicationId and the same signing certificate. A watch
// app with its own package can never receive a snapshot from the phone — the
// puts succeed, the listeners register, and Play Services silently delivers
// nothing. So the watch's identity must mirror the phone variant it pairs with
// (sh.paseo / sh.paseo.debug / sh.paseo.assembly, see packages/app/app.config.js),
// and release builds must be signed with that variant's key.
//
// The default is the debug variant: a debug watch build and a locally-built dev
// phone app on the same machine share ~/.android/debug.keystore, so the bridge
// works in development with no flags. CI passes -PpaseoApplicationId for the
// distribution variants.
val paseoApplicationId = (findProperty("paseoApplicationId") as String?) ?: "sh.paseo.debug"
val paseoVersionCode = (findProperty("paseoVersionCode") as String?)?.toInt() ?: 1
val paseoVersionName = (findProperty("paseoVersionName") as String?) ?: "0.1.0"

android {
  namespace = "sh.paseo.watch"
  compileSdk = 36

  defaultConfig {
    applicationId = paseoApplicationId
    // Wear OS 3.0. Below this the Compose-for-Wear vocabulary and the standalone
    // app model don't apply.
    minSdk = 30
    targetSdk = 36
    versionCode = paseoVersionCode
    versionName = paseoVersionName
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlin {
    compilerOptions {
      jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
  }

  buildFeatures {
    compose = true
  }
}

dependencies {
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.foundation)
  implementation(libs.compose.ui.tooling.preview)
  debugImplementation(libs.compose.ui.tooling)

  implementation(libs.activity.compose)

  implementation(libs.wear.compose.material)
  implementation(libs.wear.compose.foundation)
  implementation(libs.wear.compose.navigation)
  implementation(libs.wear.input)

  implementation(libs.wear.tiles)
  implementation(libs.wear.protolayout)
  implementation(libs.wear.protolayout.material)
  implementation(libs.wear.protolayout.expression)
  implementation(libs.concurrent.futures)

  implementation(libs.play.services.wearable)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.play.services)
  implementation(libs.lifecycle.runtime.compose)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)

  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.kotlinx.coroutines.test)
}
