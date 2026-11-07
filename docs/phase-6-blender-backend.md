# Modular Blender backend boundary

## Current status

The active backend in Phase 6 is **FFmpeg still-image narration**. It creates 1280x720 frames from generated scene images, burns SRT captions, and muxes the corresponding Hindi audio. It does not animate a character mesh, create skeletal movement, render facial expressions, or synchronize mouth shapes to phonemes.

No Blender executable, Blender scene, licensed character rig, phoneme/viseme library, or GPU rendering worker is provisioned by the current Render Free service. Therefore this document is an integration contract, not a claim that Blender rendering is already operational.

## Required separate worker

A real Blender backend should run in its own container/worker with:
- a pinned Blender LTS binary and matching Python API;
- a project template containing licensed character meshes, armatures, materials, facial shape keys, and reusable village/indoor sets;
- deterministic character IDs and a versioned character bible (mesh, clothing, palette, scale, rig);
- a Hindi ASR/phoneme alignment stage that emits timestamped visemes from the final TTS audio;
- a renderer that accepts the durable job ID, ordered scene manifest, audio object references, caption object reference, character/rig version, resolution, and frame rate;
- one durable checkpoint per rendered scene, with outputs uploaded to private object storage before marking success;
- CPU/GPU, memory, disk, wall-clock, and output-size quotas enforced per segment.

## Proposed worker contract

Input is a JSON manifest with jobId, sceneId, sequence, prompt, characterIds, audioRef, captionRef, durationSeconds, resolution, and fps. Output must include jobId, sceneId, sequence, assetRef, durationSeconds, width, height, fps, rendererVersion, characterRigVersion, and a verified media checksum.

The orchestrator must reject outputs that are missing, out of sequence, have a mismatched duration, or fail FFmpeg/Blender media inspection. The Blender worker must never report an animated result if it only produced a still image.

## Lip-sync acceptance criteria

- Hindi audio is aligned to phoneme/viseme timestamps, not merely to sentence boundaries.
- Every rendered frame samples the active viseme and animates jaw/lips plus facial expression controls.
- The same character rig and outfit/material identifiers persist across scenes.
- Human review confirms visible mouth motion matches the supplied audio.
- A no-face/voiceover-only scene is explicitly marked as such, not described as lip-synced.

## Deployment boundary

Do not install Blender into the existing Render Free web service or increase its plan automatically. Provision and benchmark a separate worker only after an explicit infrastructure decision. The current FFmpeg backend remains the fallback and must be labelled still-image narration.