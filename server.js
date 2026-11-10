require('dotenv').config();
const express = require('express');
const busboy = require('busboy');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const FFPROBE = process.env.FFPROBE_PATH || require('ffprobe-static').path;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, ADMIN_KEY } = process.env;
for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, ADMIN_KEY })) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// ---------- Google Drive auth (access token + refresh token) ----------
const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2 });

// getAccessToken() reuses the cached token and refreshes it automatically when it expires.
async function accessToken() {
  const { token } = await oauth2.getAccessToken();
  if (!token) throw new Error('Could not get an access token (refresh token revoked or expired?)');
  return token;
}
const mediaUrl = (id) => `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
// ffmpeg wants HTTP headers separated by CRLF and ending with CRLF
const ffHeaders = async () => `Authorization: Bearer ${await accessToken()}\r\n`;

// ---------- helpers ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-3000)));
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
const tmpFile = (ext) => path.join(os.tmpdir(), `vh-${crypto.randomUUID()}${ext}`);
const rm = (f) => fs.unlink(f, () => {});
const mb = (bytes) => +(bytes / 1024 / 1024).toFixed(2);
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(500).json({ error: e.message }));
const validId = (req, res, next) =>
  /^[\w-]{10,}$/.test(req.params.id) ? next() : res.status(400).json({ error: 'Bad file id' });

// ---------- app ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// everything under /api needs the admin key (the app can write to your Drive)
app.use('/api', (req, res, next) =>
  req.get('x-admin-key') === ADMIN_KEY ? next() : res.status(401).json({ error: 'Wrong or missing admin key' })
);

// Environment info: handy to confirm the production box has ffmpeg
app.get('/api/info', wrap(async (req, res) => {
  const v = await run(FFMPEG, ['-version']);
  res.json({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    ffmpeg: v.stdout.split('\n')[0],
    tmpdir: os.tmpdir(),
    rssMB: mb(process.memoryUsage().rss),
  });
}));

// Does ffmpeg itself crash or fail on network access (separate from Drive)?
app.get('/api/netcheck', wrap(async (req, res) => {
  const t = Date.now();
  const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=format_name', 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']);
  res.json({
    ms: Date.now() - t,
    ffprobePath: FFPROBE,
    exitCode: r.code,
    signal: r.signal,
    stderr: r.stderr,
    note: 'An HTTP/format error here is fine. A signal (e.g. SIGSEGV) or empty stderr with a non-zero exit means the binary itself breaks on network calls.',
  });
}));

// List files this app uploaded
app.get('/api/files', wrap(async (req, res) => {
  const r = await drive.files.list({
    q: 'trashed = false',
    pageSize: 50,
    orderBy: 'createdTime desc',
    fields: 'files(id,name,size,mimeType,createdTime)',
  });
  res.json(r.data.files);
}));

// Upload: browser -> backend (as a stream, nothing saved on disk) -> Drive
app.post('/api/upload', (req, res) => {
  const started = Date.now();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);
  const finish = (status, body) => {
    clearInterval(sampler);
    if (!res.headersSent) res.status(status).json(body);
  };

  let upload = null;
  const bb = busboy({ headers: req.headers, limits: { files: 1 } });
  bb.on('file', (_field, file, info) => {
    upload = drive.files.create({
      requestBody: { name: info.filename },
      media: { mimeType: info.mimeType, body: file },
      fields: 'id,name,size,mimeType',
    });
    upload.catch(() => {}); // avoid an unhandled rejection; the error is handled below
  });
  bb.on('close', async () => {
    if (!upload) return finish(400, { error: 'No file received' });
    try {
      const r = await upload;
      finish(200, {
        ...r.data,
        sizeMB: mb(Number(r.data.size || 0)),
        uploadMs: Date.now() - started,
        peakBackendRssMB: mb(peakRss),
      });
    } catch (e) {
      finish(500, { error: e.message });
    }
  });
  bb.on('error', (e) => finish(500, { error: e.message }));
  req.pipe(bb);
});

// ffprobe straight from Drive (reads only the header)
app.get('/api/probe/:id', validId, wrap(async (req, res) => {
  const t = Date.now();
  const r = await run(FFPROBE, [
    '-v', 'error',
    '-headers', await ffHeaders(),
    '-print_format', 'json',
    '-show_format', '-show_streams',
    mediaUrl(req.params.id),
  ]);
  if (r.code !== 0) return res.status(502).json({ error: 'ffprobe failed', exitCode: r.code, signal: r.signal, stderr: r.stderr });
  const j = JSON.parse(r.stdout);
  res.json({
    ms: Date.now() - t,
    format: j.format.format_name,
    durationSec: Number(j.format.duration),
    sizeMB: mb(Number(j.format.size)),
    streams: j.streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: s.r_frame_rate,
      sampleRate: s.sample_rate,
    })),
  });
}));

// ffmpeg: extract audio (mono 32kbps mp3) straight from Drive. ?seconds=60 limits it for a quick test.
app.get('/api/audio/:id', validId, wrap(async (req, res) => {
  const t = Date.now();
  const out = tmpFile('.mp3');
  const seconds = Number(req.query.seconds) || 0;
  const r = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-headers', await ffHeaders(),
    '-i', mediaUrl(req.params.id),
    '-vn', '-ac', '1', '-b:a', '32k',
    ...(seconds ? ['-t', String(seconds)] : []),
    out,
  ]);
  if (r.code !== 0) {
    rm(out);
    return res.status(502).json({ error: 'ffmpeg failed', exitCode: r.code, signal: r.signal, stderr: r.stderr });
  }
  const size = fs.statSync(out).size;
  rm(out);
  res.json({ ms: Date.now() - t, audioSizeMB: mb(size), limitedToSeconds: seconds || 'full video' });
}));

// ffmpeg: cut a clip straight from Drive. ?start=30&duration=10 (&reencode=1) (&download=1)
app.get('/api/clip/:id', validId, wrap(async (req, res) => {
  const t = Date.now();
  const start = Math.max(0, Number(req.query.start) || 0);
  const duration = Math.min(120, Number(req.query.duration) || 10);
  const out = tmpFile('.mp4');
  const codec = req.query.reencode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  const r = await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-headers', await ffHeaders(),
    '-ss', String(start),            // before -i = jump using range requests instead of reading from the start
    '-i', mediaUrl(req.params.id),
    '-t', String(duration),
    ...codec,
    out,
  ]);
  if (r.code !== 0) {
    rm(out);
    return res.status(502).json({ error: 'ffmpeg failed', exitCode: r.code, signal: r.signal, stderr: r.stderr });
  }
  if (req.query.download) return res.download(out, 'clip.mp4', () => rm(out));
  const size = fs.statSync(out).size;
  rm(out);
  res.json({ ms: Date.now() - t, start, duration, mode: req.query.reencode ? 're-encode' : 'stream copy', clipSizeMB: mb(size) });
}));

// Does Drive redirect the media request, and does the Authorization header survive the redirect?
app.get('/api/redirect-check/:id', validId, wrap(async (req, res) => {
  const headers = { Authorization: `Bearer ${await accessToken()}`, Range: 'bytes=0-1023' };
  const pick = (r) => ({
    status: r.status,
    acceptRanges: r.headers.get('accept-ranges'),
    contentRange: r.headers.get('content-range'),
    contentType: r.headers.get('content-type'),
    location: r.headers.get('location') ? new URL(r.headers.get('location')).host : null,
  });
  const first = await fetch(mediaUrl(req.params.id), { headers, redirect: 'manual' });
  const report = { hop1: pick(first) };
  if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
    const second = await fetch(first.headers.get('location'), { headers, redirect: 'manual' });
    report.hop2_withAuthHeaderKept = pick(second);
  }
  res.json(report);
}));

app.delete('/api/files/:id', validId, wrap(async (req, res) => {
  await drive.files.delete({ fileId: req.params.id });
  res.json({ deleted: req.params.id });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
