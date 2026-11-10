// Run once on your own computer: npm run get-token
// It opens a Google consent screen, then prints GOOGLE_REFRESH_TOKEN for your .env
require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const PORT = 3001;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);

const url = client.generateAuthUrl({
  access_type: 'offline', // needed to get a refresh token
  prompt: 'consent',      // forces Google to return a refresh token every time
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\nOpen this URL in your browser and approve access:\n\n' + url + '\n');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/oauth2callback') return res.end();
  try {
    const { tokens } = await client.getToken(u.searchParams.get('code'));
    res.end('Done. You can close this tab and go back to the terminal.');
    console.log('Add this line to your .env (and to Render env vars):\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (e) {
    res.end('Failed: ' + e.message);
    console.error(e.message);
  }
  server.close();
});
server.listen(PORT);
