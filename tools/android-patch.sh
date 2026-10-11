#!/usr/bin/env bash
# Customise the Capacitor Android project that `npx cap add android` generates into ./android:
#   - camera permission (getUserMedia + the camera file chooser), portrait only
#   - launcher icon, splash colour, app name already comes from capacitor.config.json
#   - a fixed signing key, so a new build installs over the previous one (keeps your vault)
# Every edit asserts that the pattern it expects exists, so a changed template fails loudly.
#   VERSION_CODE / VERSION_NAME can be set by CI (defaults: 1 / 1.0).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d android/app/src/main ] || { echo "android/ not found - run: npx cap add android" >&2; exit 1; }

cp -r android-res/. android/app/src/main/res/
cp tools/nukki-debug.keystore android/app/nukki-debug.keystore

python3 - <<'PY'
import os, pathlib

def edit(path, fn):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    out = fn(s)
    p.write_text(out, encoding="utf-8")

def must_replace(s, old, new, what):
    if old not in s:
        raise SystemExit(f"android-patch: expected {what!r} was not found - the Capacitor template changed")
    return s.replace(old, new, 1)

# --- manifest: camera + portrait -------------------------------------------------
def manifest(s):
    if "android.permission.CAMERA" not in s:
        s = must_replace(
            s,
            '<uses-permission android:name="android.permission.INTERNET" />',
            '<uses-permission android:name="android.permission.INTERNET" />\n'
            '    <uses-permission android:name="android.permission.CAMERA" />\n'
            '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
            "INTERNET permission line",
        )
    return must_replace(
        s,
        'android:launchMode="singleTask"',
        'android:launchMode="singleTask"\n            android:screenOrientation="portrait"',
        "launchMode attribute",
    )
edit("android/app/src/main/AndroidManifest.xml", manifest)

# --- launch theme: dark splash instead of the Capacitor logo ----------------------
def styles(s):
    return must_replace(
        s,
        '<item name="android:background">@drawable/splash</item>',
        '<item name="android:background">@color/nukki_splash</item>\n'
        '        <item name="windowSplashScreenBackground">@color/nukki_splash</item>',
        "splash background item",
    )
edit("android/app/src/main/res/values/styles.xml", styles)

# --- gradle: fixed signing key, version ------------------------------------------
def gradle(s):
    s = must_replace(
        s,
        "android {\n",
        "android {\n"
        "    signingConfigs {\n"
        "        nukki {\n"
        '            storeFile file("nukki-debug.keystore")\n'
        '            storePassword "android"\n'
        '            keyAlias "nukki"\n'
        '            keyPassword "android"\n'
        "        }\n"
        "    }\n",
        "android block",
    )
    s = must_replace(s, "    buildTypes {\n", "    buildTypes {\n        debug {\n            signingConfig signingConfigs.nukki\n        }\n", "buildTypes block")
    s = must_replace(s, "versionCode 1", f"versionCode {int(os.environ.get('VERSION_CODE', '1'))}", "versionCode")
    s = must_replace(s, 'versionName "1.0"', f'versionName "{os.environ.get("VERSION_NAME", "1.0")}"', "versionName")
    return s
edit("android/app/build.gradle", gradle)
print("android-patch: ok")
PY
