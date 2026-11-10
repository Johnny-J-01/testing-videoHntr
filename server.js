require('dotenv').config();
const express = require('express');
const busboy = require('busboy');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

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


// ---------- playback: relay bytes from Drive to a <video> tag (nothing is saved on disk) ----------
// A <video> tag cannot send the x-admin-key header, so playback uses a short-lived random token
// that is handed out by /api/stream-token/:id (which does require the admin key).
const streamTokens = new Map(); // token -> { id, exp, stats }
const TOKEN_TTL_MS = 10 * 60 * 1000;

function newStreamToken(id) {
  const now = Date.now();
  for (const [t, v] of streamTokens) if (v.exp < now) streamTokens.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  streamTokens.set(token, {
    id,
    exp: now + TOKEN_TTL_MS,
    stats: { requests: 0, bytesServed: 0, firstByteMs: [], ranges: [] },
  });
  return token;
}

app.get('/stream/:id', validId, async (req, res) => {
  const entry = streamTokens.get(String(req.query.t || ''));
  if (!entry || entry.id !== req.params.id || entry.exp < Date.now()) {
    return res.status(403).send('Invalid or expired stream token');
  }
  entry.exp = Date.now() + TOKEN_TTL_MS; // sliding expiry while the video is being watched

  const started = Date.now();
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // user stopped, seeked or closed the tab: stop reading from Drive

  try {
    const headers = { Authorization: `Bearer ${await accessToken()}` };
    if (req.headers.range) headers.Range = req.headers.range; // pass the browser's Range request straight to Drive
    const up = await fetch(mediaUrl(req.params.id), { headers, signal: abort.signal });
    const firstByteMs = Date.now() - started;

    entry.stats.requests += 1;
    entry.stats.firstByteMs.push(firstByteMs);
    if (entry.stats.ranges.length < 40) entry.stats.ranges.push(req.headers.range || 'none');
    console.log(`[stream] ${req.params.id} range=${req.headers.range || 'none'} -> ${up.status} in ${firstByteMs} ms`);

    if (!up.ok) return res.status(up.status).send(`Drive returned ${up.status}`);

    res.status(up.status); // 206 for a range request
    res.set('Accept-Ranges', 'bytes'); // Drive does not send this header; the browser needs it to allow seeking
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', up.headers.get('content-type') || 'video/mp4');
    if (up.headers.get('content-length')) res.set('Content-Length', up.headers.get('content-length'));
    if (up.headers.get('content-range')) res.set('Content-Range', up.headers.get('content-range'));

    const body = Readable.fromWeb(up.body);
    body.on('data', (chunk) => (entry.stats.bytesServed += chunk.length));
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send(`Stream failed: ${e.message}`);
    else res.destroy();
  }
});

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

// Playback: hand out a short-lived stream token, and report what the stream actually fetched
app.get('/api/stream-token/:id', validId, wrap(async (req, res) => {
  const token = newStreamToken(req.params.id);
  res.json({ token, url: `/stream/${req.params.id}?t=${token}`, expiresAfterIdleMin: TOKEN_TTL_MS / 60000 });
}));

app.get('/api/stream-stats/:token', wrap(async (req, res) => {
  const e = streamTokens.get(req.params.token);
  if (!e) return res.status(404).json({ error: 'Unknown or expired token' });
  const t = e.stats.firstByteMs;
  res.json({
    requestsToDrive: e.stats.requests,
    bytesServedMB: mb(e.stats.bytesServed),
    firstByteMsAvg: t.length ? avg(t) : null,
    firstByteMsMax: t.length ? Math.max(...t) : null,
    rangesRequestedByPlayer: e.stats.ranges,
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

// ---------- compare: process directly from Drive vs download to disk first ----------
async function ffmpegJob({ task, input, headers, start, duration, reencode, seconds, out }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (headers) args.push('-headers', headers);
  if (task === 'clip') {
    args.push(
      '-ss', String(start), '-i', input, '-t', String(duration),
      ...(reencode
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac']
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']),
      out
    );
  } else {
    args.push('-i', input, '-vn', '-ac', '1', '-b:a', '32k', ...(seconds ? ['-t', String(seconds)] : []), out);
  }
  const r = await run(FFMPEG, args);
  if (r.code !== 0) throw new Error(`ffmpeg failed (exit ${r.code}, signal ${r.signal}): ${r.stderr}`);
}

async function downloadToDisk(id, dest) {
  const r = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
  await pipeline(r.data, fs.createWriteStream(dest));
}

const avg = (list) => Math.round(list.reduce((a, b) => a + b, 0) / list.length);

// ?task=clip|audio  &start=30&duration=10 (&reencode=1)  &seconds=60 (audio)  &runs=1..3
app.get('/api/compare/:id', validId, wrap(async (req, res) => {
  const id = req.params.id;
  const task = req.query.task === 'audio' ? 'audio' : 'clip';
  const runs = Math.min(3, Math.max(1, Number(req.query.runs) || 1));
  const params = {
    task,
    start: Math.max(0, Number(req.query.start) || 0),
    duration: Math.min(120, Number(req.query.duration) || 10),
    reencode: !!req.query.reencode,
    seconds: Number(req.query.seconds) || 0,
  };
  const ext = task === 'clip' ? '.mp4' : '.mp3';

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);
  const results = [];

  try {
    for (let i = 0; i < runs; i++) {
      const directFirst = i % 2 === 0; // alternate the order so neither method always goes first
      const entry = { run: i + 1, order: directFirst ? 'direct first' : 'download first' };

      const doDirect = async () => {
        const out = tmpFile(ext);
        const headers = await ffHeaders(); // token fetched before the timer starts
        const t = Date.now();
        try {
          await ffmpegJob({ ...params, input: mediaUrl(id), headers, out });
          entry.directMs = Date.now() - t;
        } finally {
          rm(out);
        }
      };

      const doDownload = async () => {
        const local = tmpFile('.bin');
        const out = tmpFile(ext);
        try {
          let t = Date.now();
          await downloadToDisk(id, local);
          entry.downloadMs = Date.now() - t;
          entry.diskUsedMB = mb(fs.statSync(local).size);
          t = Date.now();
          await ffmpegJob({ ...params, input: local, out });
          entry.localProcessMs = Date.now() - t;
          entry.downloadThenProcessMs = entry.downloadMs + entry.localProcessMs;
        } finally {
          rm(local);
          rm(out);
        }
      };

      if (directFirst) { await doDirect(); await doDownload(); }
      else { await doDownload(); await doDirect(); }
      results.push(entry);
    }
  } finally {
    clearInterval(sampler);
  }

  const direct = avg(results.map((r) => r.directMs));
  const viaDisk = avg(results.map((r) => r.downloadThenProcessMs));
  res.json({
    params,
    results,
    averageMs: {
      A_directFromDrive: direct,
      B_downloadThenProcess: viaDisk,
      B_downloadPart: avg(results.map((r) => r.downloadMs)),
      C_processOnlyIfAlreadyOnDisk: avg(results.map((r) => r.localProcessMs)),
    },
    verdict:
      direct <= viaDisk
        ? `Direct from Drive was faster: ${direct} ms vs ${viaDisk} ms`
        : `Download-then-process was faster: ${viaDisk} ms vs ${direct} ms`,
    peakBackendRssMB: mb(peakRss),
    note: 'C is what every later job on the same video would cost if the file were cached on disk.',
  });
}));

app.delete('/api/files/:id', validId, wrap(async (req, res) => {
  await drive.files.delete({ fileId: req.params.id });
  res.json({ deleted: req.params.id });
}));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
