import type { ExpoConfig } from 'expo/config';

/**
 * CONSTRUX Field — application configuration.
 *
 * Expo rather than bare React Native CLI, and the reason is a hard constraint
 * rather than a preference: **there is no Mac.** EAS Build compiles, signs and
 * submits the iOS binary on Apple hardware in the cloud, so an iOS release
 * needs an Apple Developer account and nothing else. Bare RN would need Xcode
 * on a machine we do not have.
 *
 * This is still React Native, which is what §A3 requires. Expo is the toolchain
 * around it, not a different framework, and the native modules §A3 names —
 * camera, speech, secure storage, biometrics, background work — are all present
 * as config plugins rather than as Xcode project edits.
 *
 * **The one thing this does not solve is testing.** A build in the cloud is not
 * a build somebody has held in the rain. §F2's field-condition suite — gloves,
 * wet screen, direct sunlight, one-handed reach — needs a physical device, and
 * so does most of §17.1's device matrix.
 */

const API_BASE = process.env.CONSTRUX_API_BASE ?? 'https://construxvg.com';

const config: ExpoConfig = {
  name: 'CONSTRUX Field',
  slug: 'construx-field',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'construx',
  userInterfaceStyle: 'automatic',
  // The site is bright and the screen is often wet. A field app that only looks
  // right in a dark office is a field app people hold at an angle all day.
  newArchEnabled: true,

  ios: {
    bundleIdentifier: 'com.construx.field',
    supportsTablet: true,
    // §A3: iOS 15+. Set here so a dependency cannot quietly raise it.
    deploymentTarget: '15.1',
    infoPlist: {
      // Every permission string says what the data is for, in the words a
      // person on site would use. Apple rejects vague ones, and rightly:
      // "needs access to your location" tells nobody anything.
      NSCameraUsageDescription:
        'CONSTRUX Field uses the camera to photograph site conditions, defects and completed work as evidence against your project record.',
      NSMicrophoneUsageDescription:
        'CONSTRUX Field records dictation so you can capture a diary entry, a snag or an observation without typing.',
      NSLocationWhenInUseUsageDescription:
        'CONSTRUX Field tags each record with where on site it was captured, at the moment you capture it. It never tracks you in the background.',
      NSFaceIDUsageDescription: 'CONSTRUX Field uses Face ID to unlock the app without re-entering your password on site.',
      NSPhotoLibraryAddUsageDescription: 'CONSTRUX Field saves photographs you choose to keep to your own library.',
      // Background sync only. No background location, ever — §16.6 prohibits
      // continuous tracking and MOB-001's non-goals name it explicitly.
      UIBackgroundModes: ['fetch', 'processing', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: true,
    },
  },

  android: {
    package: 'com.construx.field',
    // §A3: Android 10+.
    permissions: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.USE_BIOMETRIC',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
    ],
    // Deliberately absent: ACCESS_BACKGROUND_LOCATION. §16.6 — attendance is
    // never inferred from continuous GPS, and asking for a permission the
    // product must not use is how a Play review turns into a policy argument.
    edgeToEdgeEnabled: true,
  },

  plugins: [
    'expo-dev-client',
    'expo-secure-store',
    'expo-local-authentication',
    [
      'expo-camera',
      { cameraPermission: 'CONSTRUX Field uses the camera to capture site evidence against your project record.' },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'CONSTRUX Field tags a record with where it was captured, at the moment of capture.',
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    [
      '@op-engineering/op-sqlite',
      // SQLCipher, which is §A3's requirement and the reason for this library
      // rather than expo-sqlite: the local store holds project evidence and
      // must be encrypted at rest with a device-bound key.
      { sqlcipher: true },
    ],
    [
      'expo-build-properties',
      {
        android: { minSdkVersion: 29, compileSdkVersion: 35, targetSdkVersion: 35 },
        ios: { deploymentTarget: '15.1' },
      },
    ],
  ],

  extra: {
    apiBase: API_BASE,
    eas: { projectId: process.env.EAS_PROJECT_ID ?? '' },
  },

  updates: {
    // §17.5's forced-minimum-version path. An update must never discard queued
    // work, so the outbox is checked before an update is applied.
    fallbackToCacheTimeout: 0,
    checkAutomatically: 'ON_LOAD',
  },
  runtimeVersion: { policy: 'appVersion' },
};

export default config;
