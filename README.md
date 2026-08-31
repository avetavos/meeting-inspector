# Meeting Inspector

Records a meeting, transcribes it, and works out who said what — entirely on your
own Mac. No transcription service, no summarizer, no upload. Whichever AI
assistant you already use reads the transcript over a local connection and
summarizes it there.

บันทึกการประชุม ถอดเสียง และแยกว่าใครพูด — ทำงานในเครื่องคุณทั้งหมด ไม่มีบริการถอดเสียง
ไม่มีการอัปโหลด ให้ AI ที่คุณใช้อยู่แล้วอ่าน transcript ผ่านการเชื่อมต่อในเครื่องแล้วสรุปให้

**[English](#install-macos) · [ภาษาไทย](#ติดตั้ง-macos)**

---

## Install (macOS)

**Requirements**

| | |
|---|---|
| Mac | Apple Silicon (M1 or later) |
| macOS | 13 Ventura or later — built and tested on macOS 26 |
| Disk | ~3.5 GB (the app is 120 MB; the speech models are the rest) |
| Memory | 8 GB works for short meetings, 16 GB is comfortable |

**The short way — one command**

```
curl -fsSL https://raw.githubusercontent.com/avetavos/meeting-inspector/main/install.sh | bash
```

Downloads the latest release, installs it, and opens it. No Gatekeeper dialog:
the "downloaded from the internet" flag that macOS blocks on is set by the
browser doing the downloading, not by macOS, so fetching with `curl` never
acquires it. ([read the script first](install.sh) if you'd rather not pipe to
bash — it is about forty lines.)

The rest of this section is the manual route.

**1. Download**

Get the `.dmg` from
[the latest release](https://github.com/avetavos/meeting-inspector/releases/latest).

**2. Install**

Open the .dmg and drag Meeting Inspector to Applications.

**3. First launch**

The app is not notarized by Apple, so macOS blocks it outright: *"Meeting
Inspector" Not Opened — Apple could not verify…*, offering only **Move to Trash**
and **Done**. On macOS 15 and later the old right-click → Open trick no longer
works — Apple removed it.

Press **Done**, then run this once in Terminal:

```
xattr -dr com.apple.quarantine "/Applications/Meeting Inspector.app"
```

That removes the "downloaded from the internet" flag macOS attaches to the file.
It leaves the app's signature intact and nothing else is changed. The app opens
normally from then on.

You can also try **System Settings → Privacy & Security**, scroll to Security,
and press **Open Anyway** next to the blocked app. That is Apple's documented
path, but for apps without a Developer ID the button does not always appear —
the Terminal command is the one that reliably works.

Only a paid Apple Developer ID and notarization would remove this step for good.

**4. Grant two permissions**

The app asks the first time you record:

- **Microphone** — records your own voice
- **Screen Recording** — macOS ties system audio to this permission, which is how
  the app hears everyone else. It never records your screen; the video stream is
  discarded the moment it opens.

Quit and reopen the app after granting Screen Recording — macOS does not apply it
to a running app.

**5. Download the speech models**

On first launch a panel offers four model files, about 3.1 GB in total. Press
**Download models**. Cancelling keeps what already arrived and resumes later. You
can record without them; only transcription waits.

### Using it

Type a meeting title, press **Start recording**, and run your meeting as usual.
The transcript appears as you go, about half a minute behind. Press **End meeting**
and the app works out who was speaking, then lets you put real names to them.

Everything is saved in `~/Documents/MeetingNotes/`, one folder per meeting, with
the audio and the transcript as plain files you own. The folder is named with a
UUID v7 — so folders sort by when the meeting happened — and the title you typed
lives in `meeting.json` beside them, where you can rename it freely without the
meeting's identity changing.

### Connecting an AI assistant

Meeting Inspector does not summarize anything itself. Instead it serves your
meetings over MCP at `http://127.0.0.1:8787/`, on your machine only, so an
assistant can read them and answer questions like *what did we decide this
morning?*

Turn on the MCP server under **Settings** and copy the line for your client:

**Claude Code** — paste the command the panel shows.

**Claude Desktop / ChatGPT Desktop** — paste the JSON the panel shows into the
client's MCP config, then restart it.

The server answers only while Meeting Inspector is open. Clients that fetch the
address from their own servers — ChatGPT on the web, Gemini's connected apps —
cannot reach an address on your machine, and are not supported.

---

## Windows and Linux

**Not supported.** Not "coming soon" — the parts that would make it work are not
written yet:

- The shipped `whisper-server` is an Apple Silicon binary compiled against Metal.
  Windows and Linux need their own build.
- The installer only produces a macOS .dmg.
- System-audio capture, the permission flow, and the window's glass appearance
  all use macOS APIs.

The speaker-separation library already ships Windows and Linux builds, and
Electron itself is cross-platform, so a port is possible — it just has not been
done.

---

## ติดตั้ง (macOS)

**เครื่องที่ใช้ได้**

| | |
|---|---|
| Mac | Apple Silicon (M1 ขึ้นไป) |
| macOS | 13 Ventura ขึ้นไป — พัฒนาและทดสอบบน macOS 26 |
| พื้นที่ | ~3.5 GB (ตัวแอป 120 MB ที่เหลือคือโมเดลถอดเสียง) |
| แรม | 8 GB พอสำหรับประชุมสั้น 16 GB สบายกว่า |

**ทางลัด — คำสั่งเดียว**

```
curl -fsSL https://raw.githubusercontent.com/avetavos/meeting-inspector/main/install.sh | bash
```

โหลด release ล่าสุด ติดตั้ง แล้วเปิดให้เลย ไม่เจอกล่อง Gatekeeper เพราะป้าย
"ดาวน์โหลดมาจากอินเทอร์เน็ต" ที่ macOS ใช้บล็อกนั้น **เบราว์เซอร์เป็นคนติด ไม่ใช่ระบบ**
โหลดด้วย `curl` เลยไม่ติดตั้งแต่แรก ([อ่านสคริปต์ก่อนได้](install.sh) ถ้าไม่อยากไพป์เข้า bash
— ยาวประมาณสี่สิบบรรทัด)

ที่เหลือด้านล่างคือวิธีติดตั้งด้วยมือ

**1. ดาวน์โหลด**

โหลดไฟล์ `.dmg` จาก
[release ล่าสุด](https://github.com/avetavos/meeting-inspector/releases/latest)

**2. ติดตั้ง**

เปิดไฟล์ .dmg แล้วลาก Meeting Inspector ไปไว้ใน Applications

**3. เปิดครั้งแรก**

แอปไม่ได้ผ่านการ notarize ของ Apple macOS จะบล็อกทันทีพร้อมข้อความ
*"Meeting Inspector" Not Opened — Apple could not verify…* และมีให้เลือกแค่
**Move to Trash** กับ **Done** — บน macOS 15 ขึ้นไป Apple เอาวิธีคลิกขวา → Open ออกไปแล้ว

กด **Done** แล้วรันคำสั่งนี้ใน Terminal ครั้งเดียว

```
xattr -dr com.apple.quarantine "/Applications/Meeting Inspector.app"
```

คำสั่งนี้ลบแค่ป้าย "ดาวน์โหลดมาจากอินเทอร์เน็ต" ที่ macOS ติดไว้กับไฟล์
ลายเซ็นของแอปยังอยู่ครบและไม่มีอะไรอื่นถูกแก้ หลังจากนั้นเปิดได้ตามปกติ

อีกทางคือ **System Settings → Privacy & Security** เลื่อนลงไปที่ Security แล้วกด
**Open Anyway** ข้างชื่อแอปที่ถูกบล็อก — เป็นวิธีที่ Apple บอกไว้ แต่กับแอปที่ไม่มี
Developer ID ปุ่มนั้นไม่ได้ขึ้นเสมอไป คำสั่งใน Terminal เชื่อถือได้กว่า

ทางเดียวที่จะตัดขั้นตอนนี้ออกถาวรคือซื้อ Apple Developer ID แล้ว notarize

**4. ให้สิทธิ์ 2 อย่าง**

แอปจะขอตอนกดอัดครั้งแรก

- **Microphone** — อัดเสียงของคุณ
- **Screen Recording** — macOS ผูกเสียงระบบไว้กับสิทธิ์นี้ ซึ่งเป็นทางเดียวที่แอปจะได้ยินเสียงคนอื่น
  แอปไม่ได้อัดหน้าจอ วิดีโอถูกทิ้งทันทีที่เปิดสตรีม

หลังให้สิทธิ์ Screen Recording **ต้องปิดแล้วเปิดแอปใหม่** เพราะ macOS ไม่ให้ผลกับแอปที่เปิดค้างอยู่

**5. โหลดโมเดลถอดเสียง**

เปิดครั้งแรกจะมีแผงให้โหลดไฟล์โมเดล 4 ไฟล์ รวมประมาณ 3.1 GB กด **โหลดโมเดล**
ถ้ากดยกเลิกกลางทาง ส่วนที่โหลดไปแล้วจะถูกเก็บไว้และโหลดต่อจากเดิม
ระหว่างยังไม่มีโมเดลก็อัดเสียงได้ แค่ยังถอดเสียงไม่ได้

### วิธีใช้

พิมพ์ชื่อการประชุม กด **เริ่มอัด** แล้วประชุมตามปกติ transcript จะขึ้นระหว่างประชุม
ช้ากว่าเสียงจริงประมาณครึ่งนาที พอกด **จบประชุม** แอปจะแยกว่าใครพูดช่วงไหน
แล้วให้คุณตั้งชื่อจริงให้แต่ละคน

ทุกอย่างเก็บใน `~/Documents/MeetingNotes/` แยกโฟลเดอร์ต่อการประชุม
ทั้งไฟล์เสียงและ transcript เป็นไฟล์ธรรมดาที่เป็นของคุณ ชื่อโฟลเดอร์เป็น UUID v7
(เรียงตามเวลาที่ประชุมจริง) ส่วนชื่อการประชุมเก็บแยกใน `meeting.json` จึงเปลี่ยนชื่อ
ได้อิสระโดยที่ id ไม่เปลี่ยน

### เชื่อมต่อ AI

Meeting Inspector ไม่สรุปให้เอง แต่เปิดให้ AI ดึงข้อมูลการประชุมผ่าน MCP ที่
`http://127.0.0.1:8787/` ซึ่งเข้าถึงได้จากเครื่องคุณเท่านั้น เพื่อให้ถามได้ว่า
*เมื่อเช้าประชุมสรุปว่าอะไร*

เปิด MCP server ในหน้า **ตั้งค่า** แล้วคัดลอกบรรทัดของ client ที่คุณใช้

**Claude Code** — วางคำสั่งที่แผงแสดงให้

**Claude Desktop / ChatGPT Desktop** — วาง JSON ที่แผงแสดงลงใน config ของ client
แล้วปิดเปิดโปรแกรมใหม่

server จะตอบเฉพาะตอนที่เปิด Meeting Inspector ค้างไว้ ส่วน client ที่ยิงเข้าหา address
จากเซิร์ฟเวอร์ตัวเอง — ChatGPT บนเว็บ หรือ connected apps ของ Gemini — เข้าถึง address
ในเครื่องคุณไม่ได้ จึงใช้ไม่ได้

### Windows กับ Linux

**ยังใช้ไม่ได้** และไม่ใช่ "เร็วๆ นี้" — ส่วนที่ต้องมียังไม่ได้เขียน

- `whisper-server` ที่แถมมาเป็น binary ของ Apple Silicon ที่ compile กับ Metal
  Windows และ Linux ต้อง build ของตัวเอง
- ตัวติดตั้งสร้างได้แค่ .dmg ของ macOS
- การดักเสียงระบบ ขั้นตอนขอสิทธิ์ และหน้าตากระจกของหน้าต่าง ใช้ API ของ macOS ทั้งหมด

ไลบรารีแยกเสียงผู้พูดมี build ของ Windows และ Linux อยู่แล้ว และ Electron เองก็ข้ามแพลตฟอร์มได้
ดังนั้นพอร์ตได้ — แค่ยังไม่ได้ทำ

---

## Build from source

```
brew install cmake
npm install
npm run dev        # run it
npm test           # chunker, wav, store, merge, download, ipc, mcp
npm run typecheck
npm run dist       # release/Meeting Inspector-<version>-arm64.dmg
npm run icon       # redraw build/icon.icns
```

`dist` compiles a static `whisper-server` from source first — a few minutes the
first time, cached afterwards. Homebrew's `whisper-cpp` cannot be bundled (its
ggml loads backends by dlopen from a path fixed at compile time), but it works as
a fallback for a checkout you have not built.

### How it works

Two audio tracks are recorded and never mixed: `loopback.wav` is everyone else,
`mic.wav` is you. That means "who said this" is free for your own speech, and
speaker separation only has to run on the cleaner of the two.

| file | what |
|---|---|
| `loopback.wav` | everyone else, 16kHz mono |
| `mic.wav` | you, 16kHz mono |
| `transcript.json` | segments sorted by time, speaker per segment |
| `transcript.md` | the same thing to read |

Audio is cut into ~30s chunks at the quietest moment near the mark rather than on
a fixed clock, so no word straddles a boundary and nothing has to be deduplicated.
Silent chunks are never sent. Transcription runs at about 5x realtime on an M3
Pro, so a chunk comes back in roughly six seconds.

Stopping waits for the queued tail chunks before writing, so the transcript
reaches the end of the meeting. Quitting mid-meeting saves what came back rather
than nothing.

### Measuring transcription accuracy

`npm run asr:read`, record yourself reading it in the app, stop, then
`npm run asr:score`. The scorer runs the app's own chunker and whisper over
`mic.wav`, so it measures the shipping pipeline, and scores the same audio twice —
with and without the seed vocabulary — so the prompt's effect is visible on one
recording.

Measured on 125s of read Thai dev-meeting speech: term recall 21/27 without a
prompt, 26/27 with one (CER 15.1% → 11.4%). The vocabulary is `DEFAULT_PROMPT` in
`src/main/whisper.ts` — edit it to match your team's jargon.

**Electron is pinned to 38.8.6.** 39+ returns a silent loopback audio track on
macOS 26 (electron#49607). Re-run `spike/electron-loopback` before bumping it.

## License

MIT
