# 1-मिनट वीडियो — असली e2e test plan और नतीजे

> यह plan `origin/main` (merge commit `ad04bad`) पर **असल में चलाया गया**।
> AI provider एक deterministic fake था (कोई network/कोई key नहीं), उसके बाद का
> सब कुछ असली: image validation, audio normalisation, lip-sync analysis,
> FFmpeg render, captions, persistence, download.
> जहाँ "MOCK" लिखा है वहाँ असली Google नहीं छुआ गया — यह छिपाया नहीं गया है।

## Setup

| चीज़ | मान |
|---|---|
| असली FFmpeg | `imageio-ffmpeg` 9.0.2 binary (`FFMPEG_PATH`) |
| ffprobe | उपलब्ध नहीं — streams `ffmpeg -i` के stderr से पढ़े गए |
| AI provider | **MOCK** (deterministic; 10 scenes, PNG scene, 1.2s speech-like tone) |
| Story | "जादुई नदी की कहानी" — छोटा बाघ टोटो, 10 दृश्य, हिंदी narration + dialogue |
| Aspect / duration | 16:9, 1 मिनट |
| Upload | **कुछ भी upload नहीं किया गया** |

## Steps और परिणाम

| # | जाँच | अपेक्षा | असली नतीजा | स्थिति |
|---|---|---|---|---|
| 1 | हिंदी कहानी बनना | 10 दृश्य, JSON valid | 10 दृश्य, title "जादुई नदी की कहानी" | ✅ PASS |
| 2 | स्क्रिप्ट/narration | हर दृश्य में हिंदी narration | 10/10 दृश्यों में narration + dialogue | ✅ PASS |
| 3 | scene plan | हर scene का imagePrompt | सभी 10 में imagePrompt | ✅ PASS |
| 4 | तस्वीरें | हर scene के लिए valid image | 10/10 (mock PNG, असली validation से गुज़रीं) | ✅ PASS (mock AI) |
| 5 | हिंदी आवाज़ | हर scene के लिए audio | 10/10 (mock tone, असली normalisation) | ✅ PASS (mock TTS) |
| 6 | उपशीर्षक | SRT + burned captions | `captions: burned`, SRT **30 cues**, 2000 bytes | ✅ PASS |
| 7 | MP4 render | असली h264/aac फ़ाइल | **1280×720, h264 + aac, 24 fps, 2.05 MB** | ✅ PASS |
| 8 | अवधि | ~60 सेकंड | **00:01:00.04** | ✅ PASS |
| 9 | A/V sync | दोनों tracks बराबर | video **00:01:00.04** vs audio **00:01:00.02** (20 ms) | ✅ PASS |
| 10 | फ़ाइल integrity | पूरा decode बिना error | `ffmpeg -i … -f null -` → **exit 0, कोई error नहीं** | ✅ PASS |
| 11 | डाउनलोड | रेंडर हुई फ़ाइल के बराबर bytes | HTTP 200 `video/mp4`, **2045868 == 2045868 bytes** | ✅ PASS |
| 12 | मोबाइल | viewport + responsive layout | viewport meta ✅, 4 `@media` blocks | ✅ PASS (static check) |
| 13 | render समय | — | **18 सेकंड** (ultrafast preset, 10 दृश्य) | ✅ मापा गया |
| 14 | lip-sync | rig हो तो mouth animation | इस test में rig नहीं था → `lipSync: {scenes:0, cues:0}`; rig वाला रास्ता `test/e2e-pipeline.test.js` में असली FFmpeg से पास | ✅ (अलग test) |

## जो यह test साबित नहीं करता

- असली Gemini से कहानी/तस्वीर/आवाज़ की **गुणवत्ता** — इस environment में key नहीं है।
- असली YouTube upload/analytics — OAuth credentials नहीं हैं।
- असली फ़ोन पर layout — सिर्फ़ static/JSdom जाँच; इंसानी नज़र से देखना बाकी है।

## दोबारा चलाने का तरीका

```bash
export FFMPEG_PATH=$(python -m imageio_ffmpeg --version >/dev/null 2>&1; \
  python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")
node /tmp/v60/run.js        # ऊपर का harness; नतीजा /tmp/v60/result.json में
```

असली AI के साथ वही flow: dashboard → विषय → "पूरा ऑटोमैटिक काम शुरू करें"
(`GEMINI_API_KEY` सेट होने पर)।
