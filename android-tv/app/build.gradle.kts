plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Dirección del servidor que viene ya puesta en la app.
// Déjala vacía ("") para que la app la pregunte la primera vez.
// También se puede pasar al compilar: gradle assembleDebug -PserverUrl=https://tu-dominio.com
val serverUrl: String = (project.findProperty("serverUrl") as String?) ?: ""
val buildNumber: Int = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "com.nubecine.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nubecine.tv"
        minSdk = 21
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.$buildNumber"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    // Firma fija: permite instalar actualizaciones encima sin desinstalar la app
    signingConfigs {
        create("fija") {
            storeFile = file("nubecine.keystore")
            storePassword = "nubecine"
            keyAlias = "nubecine"
            keyPassword = "nubecine"
        }
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("fija")
        }
        release {
            signingConfig = signingConfigs.getByName("fija")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
