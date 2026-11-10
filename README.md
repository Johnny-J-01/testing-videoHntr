# Drive + ffmpeg test

A tiny app to answer one question: **can ffprobe/ffmpeg read a video straight from Google Drive, in development and in production?**

No editor, no database, no login. Upload goes browser -> backend (streamed, nothing saved on disk) -> Drive. Then ffprobe/ffmpeg read from Drive over HTTP.

## 1. Google Cloud setup (one time)

1. Go to console.cloud.google.com, create a project.
2. **APIs & Services -> Library** -> enable **Google Drive API**.
3. **OAuth consent screen** -> User type **External** -> fill the required fields.
   - Add the scope `.../auth/drive.file` (the app can only see files it uploaded itself).
   - Add your own Google account as a test user.
   - **Then click "Publish app" (status: In production).** If you leave it in *Testing*, the refresh token expires after about 7 days and everything breaks later with `invalid_grant`. `drive.file` is a non-sensitive scope, so publishing should not need Google verification. You will see an "unverified app" warning when you approve; click Advanced -> continue.
4. **Credentials -> Create credentials -> OAuth client ID** -> type **Web application**.
   - Authorized redirect URI: `http://localhost:3001/oauth2callback`
   - Copy the client ID and client secret.

## 2. Run locally

```bash
npm install
cp .env.example .env        # fill GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_KEY
npm run get-token           # open the printed URL, approve, copy GOOGLE_REFRESH_TOKEN into .env
npm start                   # http://localhost:3000
```

Open the page, type your admin key, click **Server info** (confirms ffmpeg works), then upload a video.

## 3. Deploy on Render

- New **Web Service**, connect the repo.
- Build command: `npm install`  Start command: `npm start`
- Environment variables: the same four values from `.env`.
- ffmpeg and ffprobe come from the `ffmpeg-static` and `ffprobe-static` packages, so nothing else needs installing.

## 4. What to test, and how to read the results

| Button | What it proves | Good result |
|---|---|---|
| Server info | ffmpeg runs on this machine | prints an ffmpeg version |
| Redirect check | Does Drive redirect, and does the auth header survive? | hop1 status 206 (or 200) with `acceptRanges: bytes`. If hop1 is a 3xx, hop2 should be 206/200, not 401/403 |
| Probe | ffprobe reads the header from Drive | finishes in about 1-3 s, shows duration and codecs |
| Audio (60s) | ffmpeg decodes audio from Drive | fast, small mp3 |
| Audio (full) | Reads the whole file once | time is roughly "download the whole file" time |
| Clip (start 30) | Range requests work | about the same time as a clip starting at 0 |
| Clip (start near the end) | Seeking really skips ahead | **similar time to start 0.** If it is much slower, ffmpeg is reading from the start (see below) |
| Clip + download | The output is valid | the file plays |
| Upload | Streaming upload works | `peakBackendRssMB` stays well under your Render memory limit |

**If a late clip is much slower than an early one:** the MP4's metadata (moov atom) is probably at the end of the file. Remux once with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` and upload that. (Not built into this test on purpose.)

**Run each test in both places** (local and Render) and compare. Also try 2-3 clips in a row, quickly, to see if Drive starts returning 403/429 (rate limit). Errors show the ffmpeg stderr in the output box.

## Notes

- Files you upload stay in your Drive until you press **Delete**.
- The admin key only protects this test app. Use a long random value, and delete the Render service when you are done.

## 5. Compare: direct from Drive vs download-to-disk first

The **Compare clip / Compare audio** buttons run the same job two ways on the same file, in the same request:

- **A (direct):** ffmpeg reads straight from Drive.
- **B (download first):** the whole file is downloaded to the server's `/tmp`, then ffmpeg processes the local copy. The result shows the download time and the processing time separately.
- **C (already on disk):** the processing-only part of B. This is what later jobs on the same video would cost if you cached the file.

Tips: run each comparison twice and ignore the first run (cold start). Use `runs=2` or `3` to average and to alternate which method goes first. On a big file with Audio (full), keep `runs=1`, because the request can hit Render's request time limit. `diskUsedMB` shows how much temp disk the download-first method needed. Files are deleted after each run.
