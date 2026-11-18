# Avatars and voice

An avatar supplies visual identity; voice supplies speech. Neither changes personality, specialty or permissions.

Trace the active workspace component, backend audio/avatar service and desktop host together. Avatar routes include `packages/backend/src/api/routes/avatar.ts`; speech services include `packages/backend/src/services/audio-service.ts`. GenVR character authoring belongs in the [SDK contribution path](genvr.md), while Girru identity mapping and native permissions stay in the host.

Document compatible formats, engine/platform requirements, asset provenance, local/cloud processing and costs. Use only recordings owned by the contributor or used with permission. Keep speech credentials and source recordings out of public fixtures unless deliberately licensed for that use.

Preserve explicit model/engine selection. Do not auto-download engines or models, request microphone/camera capture, or send media to a provider merely by opening a settings page. Test mute/leave/disable cleanup, late-response cancellation, safe file bounds and packaged resources. Actual OS permission and hardware acceptance are separate from synthetic audio tests.

Current capabilities depend on the source revision and release; do not infer availability from roadmap copy. See [testing](testing.md) and [core boundaries](core.md).
