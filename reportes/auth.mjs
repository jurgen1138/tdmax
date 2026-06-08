/**
 * Run once locally to get your refresh token.
 * Usage: node auth.mjs <CLIENT_ID> <CLIENT_SECRET>
 */
import { OAuth2Client } from 'google-auth-library';
import { createServer } from 'http';

const [,, CLIENT_ID, CLIENT_SECRET] = process.argv;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node auth.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const REDIRECT = 'http://localhost:3000/callback';
const client   = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/analytics.readonly'],
});

console.log('\nAbre esta URL en tu navegador:\n');
console.log(url);
console.log('\nEsperando autorización en http://localhost:3000 ...\n');

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:3000');
  if (!u.pathname.startsWith('/callback')) return;

  const code = u.searchParams.get('code');
  if (!code) { res.end('No code found'); return; }

  try {
    const { tokens } = await client.getToken(code);
    res.end('<h2 style="font-family:sans-serif">✅ Listo, puedes cerrar esta pestaña.</h2>');
    console.log('\n✅ Copia estos 3 secrets en GitHub → Settings → Secrets:\n');
    console.log(`GOOGLE_CLIENT_ID     =  ${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET =  ${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN =  ${tokens.refresh_token}`);
    console.log('');
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error(e);
  } finally {
    server.close();
  }
});

server.listen(3000);
