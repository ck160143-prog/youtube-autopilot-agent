# Finish report — क्या पूरा हुआ, क्या नहीं

**तारीख:** 28 नवंबर 2026 · **base:** `main@31d9be7` · **PR #31 खुला (merge नहीं)**

> हर दावे के आगे सबूत है। जो नहीं चला उसे "चल गया" नहीं लिखा गया।

---

## 1. पूर्णता (ईमानदार आकलन)

| क्षेत्र | स्थिति | भार |
|---|---|---|
| Core app (auth, sessions, CSRF, projects, queue) | 🟢 verified | — |
| Hindi story / script / scenes | 🟢 verified (mock provider) | — |
| Research + sources | 🟢 verified (mock provider) | — |
| Images / TTS / captions | 🟢 verified (mock provider) | — |
| FFmpeg render 60s, download | 🟢 **verified असली FFmpeg** | — |
| Analytics + insights | 🟢 verified (stubbed Google) | — |
| Upload / scheduling / OAuth | 🟡 code पूरा, **असली Google पर unverified** | — |
| **Storage persistence** | 🟢 **नया — अब है (local + S3 driver)** | — |
| **Disk hygiene** | 🟢 **नया — 4.11x → 1.28x** | — |
| **2.5D camera (parallax)** | 🟢 **नया — असली render verified** | — |
| **Full-body 3D** | ⛔ **BLOCKED — environment** | — |
| **Hindi lip-sync** | 🟡 2D mouth-sprite (rig चाहिए), 3D lip-sync नहीं | — |
| Mobile UI | 🟡 viewport + media queries; असली फ़ोन पर देखना बाकी | — |

**कुल कार्य-आधारित आकलन: ~78%** (पहले ~70%)। यह प्रतिशत दावा नहीं, नीचे की तालिका का योग है।

---

## 2. इस दौर में जो असल में बना (PR #31, 8 files, +724/−14)

### 2.1 Disk leak — मापा और ठीक किया
असली 1-मिनट प्रोजेक्ट रेंडर करके मापा:

| | पहले | अब |
|---|---|---|
| final MP4 | 2.03 MB | 2.03 MB |
| प्रोजेक्ट कुल | **8.32 MB** | **2.60 MB** |
| overhead | **4.11x** | **1.28x** |

कारण: `clips/`, `chunks/`, `timeline.mp4`, `mixed.mp4`, `music-bed.m4a`, `sfx-*` कभी नहीं हटते थे।
`cleanupIntermediates()` अब सिर्फ़ अपनी बनाई files हटाता है — render output कभी नहीं, fail हुए probe पर कुछ नहीं (resume बचा रहे), delete error render नहीं तोड़ता।

### 2.2 Storage persistence — नया abstraction
`lib/storage.js`: `local` + `s3` drivers, SigV4 खुद node `crypto` से (कोई SDK नहीं — 512 MB instance पर tens of MB बचते हैं)।

- बिना config: backup बंद, कुछ "सेव हुआ" नहीं कहता
- आधा config: local पर गिरता है, नकली backup नहीं
- दोनों render paths backup करते हैं, नतीजा project पर दर्ज होता है

**असली bytes से सत्यापित:** 1.92 MB MP4 → backup में **SHA-256 हूबहू** (`053b0118…`), साथ `project.json`.

₹0 विकल्प documented: Cloudflare R2 (10 GB free), Backblaze B2 (10 GB), MinIO, या Render Disk + `STORAGE_LOCAL_DIR`.

### 2.3 2.5D parallax camera
`parallax` / `parallax-reverse`: दो परतें, अलग गति (front ~3x), feathered edge — studio multi-plane trick।

**verified:** तीनों motions असली 1280×720 h264 clips बनाते हैं; mid-clip frame पर तीनों **अलग images** (raw pixel diff 58 और 18); पूरा 60.04 s parallax render pass।

**साफ़ सीमा:** यह still image पर depth का भ्रम है, modelled 3D नहीं। कोड और UI दोनों यही कहते हैं।

---

## 3. जो नहीं हो सका — और क्यों (छिपाया नहीं)

### 3.1 Full-body 3D — ⛔ BLOCKED (environment)
- `blender` binary PATH पर नहीं है।
- `bpy` 5.0.1 wheel **install हो जाता है**, पर `import bpy` fail: `libXrender.so.1` नहीं मिलता।
- `ldd` से पूरी सूची: **libXrender, libSM, libICE, libXi, libGL, libXfixes, libXt, libxkbcommon** — आठ system libs।
- तीनों रास्ते बंद: apt में package नहीं, archive.ubuntu.com unreachable, कोई PyPI wheel इन्हें नहीं देता।

**इसलिए:** 3D का दावा नहीं किया गया। इसकी जगह 2.5D parallax बनाया जो उपलब्ध tools से असली है।
**अगला कदम:** ऐसे host पर जहाँ `apt-get install libxrender1 libsm6 libxi6 libxfixes3 libxkbcommon0` चल सके, वहाँ `bpy` prototype (नीचे §6)।

### 3.2 Hindi lip-sync — 🟡 आधा
मौजूदा: 2D mouth-sprite overlay (rigged character पर), Rhubarb cues से timing। असली render में verified (`test/e2e-pipeline.test.js`)।
नहीं है: 3D facial rig, phoneme-level viseme animation, jaw/mouth shapes की असली भाषाई शुद्धता।
**क्यों:** mouth-sprite के लिए हर किरदार के mouth images चाहिए (user upload), और 3D के लिए §3.1 वाला block।

### 3.3 असली Gemini — unverified
`GEMINI_API_KEY` इस environment में नहीं है, TLS भी blocked। पूरा pipeline mock provider से verified — **data shape असली, network call नहीं**।
चलाने का plan: `REAL-AI-1MIN-TEST-PLAN.md` (बिना upload के)।

---

## 4. Tests — असली परिणाम

| | पहले | अब |
|---|---|---|
| Suite | 260 pass | **274 pass / 0 fail / 1 skip** |
| नए tests | — | 14 (storage 9, cleanup 4, parallax 1) |
| Build | 63 files 312.6 KB | 63 files 314.7 KB |
| असली 60s render | ✅ | ✅ (2.66 MB, 60.04 s, parallax सहित) |
| असली backup | — | ✅ SHA-256 मेल |

**एक test टूटा और छिपाया नहीं गया:** resume test cleanup के बाद fail हुआ (पुराना व्यवहार मानता था)। उसे कमज़ोर नहीं किया — अब दोनों contracts साबित करता है।

एक और असली बग test ने पकड़ा: parallax test सपाट रंग वाली image पर fail हुआ, क्योंकि बिना texture के depth दिख ही नहीं सकती। Test अब textured scene इस्तेमाल करता है — यही असली दुनिया की स्थिति है।

---

## 5. Security (इस दौर में जोड़ा गया)

| मद | स्थिति |
|---|---|
| Storage key traversal | `../`, absolute, hidden, empty — सब 400; root के बाहर कुछ नहीं लिखा जा सकता ✅ test |
| S3 signing | असली SigV4, fake fetch से verified; 404 vs 502 अलग ✅ |
| Backup failure | render नहीं तोड़ता, झूठा success नहीं ✅ |
| Deadline | हर storage call पर `AbortSignal.timeout` ✅ |
| Secrets | कोई नई secret नहीं; S3 keys सिर्फ़ env से, repo में नहीं |

---

## 6. 3D prototype — तैयार plan (जब environment अनुमति दे)

जिस host पर system libs मिल सकें, वहाँ यही चलाना है:

```bash
pip install bpy==5.0.1            # 374 MB wheel
python -c "import bpy; print(bpy.app.version_string)"
```
फिर minimal prototype: cube-based body + armature (hips/spine/arm/leg) → walk cycle keyframes → camera dolly → `bpy.ops.render.render(animation=True)` → frames को मौजूदा FFmpeg pipeline से जोड़ना (`renderSceneClip` का image input animation से बदलना)।

**Render free plan पर यह नहीं चलेगा** (512 MB, CPU-only) — इसलिए job queue से अलग worker चाहिए। मौजूदा `MAX_RENDER_JOBS` + `recoverInterrupted()` ढाँचा इसके लिए तैयार है।

---

## 7. अगले कदम (प्राथमिकता क्रम में)

1. **PR #31 merge** (आपकी अनुमति) — disk leak और storage अब ज़रूरी हैं।
2. Render पर एक env var: `STORAGE_LOCAL_DIR=/var/data/backup` (Disk के साथ) **या** R2/B2 keys — वरना deploy पर वीडियो फिर मिटेंगे।
3. असली `GEMINI_API_KEY` से 1-मिनट test (`REAL-AI-1MIN-TEST-PLAN.md`)।
4. 3D: ऐसा worker host चुनना जहाँ system libs install हो सकें, फिर §6।
5. Lip-sync: अभी 2D sprite; 3D के साथ ही आएगा।

**अनुमानित बचा काम:** injection/3D/lip-sync को छोड़कर production-ready होने में ~2–3 कार्य-दिन (जिनमें से ज़्यादातर असली credentials के साथ verification है, नई सुविधा नहीं)। 3D + 3D lip-sync अलग ~1–2 हफ़्ते, और वह भी सिर्फ़ सही host मिलने पर।
