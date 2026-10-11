# Vendored third-party files

Self-hosted so the app works offline and does not depend on a CDN.

| File | Source | Notes |
|---|---|---|
| `mediapipe/vision_bundle.mjs`, `mediapipe/wasm/vision_wasm_internal.{js,wasm}` | npm `@mediapipe/tasks-vision@0.10.14` | Apache-2.0 (per the package's `license` field). Only the SIMD wasm build is included; devices without WASM SIMD use the built-in fallback segmenter. |

## The model is NOT bundled

`magic_touch.tflite` (MediaPipe Interactive Segmenter, ~6 MB) is downloaded by the app on
first use from `https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`
(see `MODEL_URL` in `segment.js`) and cached by the service worker for offline use.
Its licence terms were not verified, which is why it is not redistributed here.
The bucket answers with `access-control-allow-origin: *`, so any origin can fetch it.

Privacy side effect: the first run contacts Google's storage host (it sees the visitor's IP).
Photos are never uploaded; segmentation runs on the device.

## Version pinning matters

`@mediapipe/tasks-vision@1.1.0` (npm `latest` when this was written) fails to load this
model: *"Task bundle is missing: interactive_segmentation_encoder.int8.tflite"*. Keep
the bundle at 0.10.14, or upgrade the bundle and the model together and re-run
`tests/e2e.cjs` and `tests/offline.cjs`.
