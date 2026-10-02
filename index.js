'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require('@discordjs/voice');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const app = express(), PORT = Number(process.env.PORT) || 3000, states = new Map();
let lastActiveId = null;
app.use(express.json({ limit: '24kb' }));
const log = (tag, message) => console.log(`[${tag}] ${message}`);
const aliases = { p:'play', next:'skip', s:'skip', disconnect:'leave', dc:'leave', q:'queue', mix:'shuffle', vol:'volume', continue:'resume', repeat:'loop', connect:'join' };
const CANONICAL = new Set(['play','skip','stop','leave','join','queue','shuffle','remove','pause','resume','volume','loop','autoplay']);
const KNOWN = new Set([...CANONICAL, ...Object.keys(aliases)]);
// Users allowed to control the bot even when they are NOT in the bot's voice
// channel. Comma/space separated Discord user IDs from OWNER_IDS (or WHITELIST_IDS).
const WHITELIST = new Set(String(process.env.OWNER_IDS || process.env.WHITELIST_IDS || '')
  .split(/[\s,]+/).map(x => x.trim()).filter(Boolean));
function parseVoiceCommand(text) {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'ave') {
      const raw = words[i + 1] || '';
      if (!raw) continue;
      return { prefix:'ave', command:aliases[raw] || raw, args:words.slice(i + 2) };
    }
    if (w.length > 3 && w.startsWith('ave')) {
      const raw = w.slice(3);
      if (KNOWN.has(raw)) return { prefix:'ave', command:aliases[raw] || raw, args:words.slice(i + 1) };
    }
  }
  return null;
}
function stateFor(id, name='') {
  let s = states.get(id);
  if (!s) {
    s = { guildId:id, guild:name, channelId:'', channel:'', connection:null, player:createAudioPlayer({ behaviors: { maxMissedFrames: 50, noSubscriber: 'play' } }), queue:[], currentTrack:null, started:0, pausedAt:0, volume:100, loopMode:'off', autoplay:false, shuffle:false, status:'idle', error:'', generation:0, playingGeneration:0, epoch:0, busy:false, pending:null, leaving:false, recent:[], recentKeys:[] };
    s.player.on(AudioPlayerStatus.Idle, () => advance(s, s.playingGeneration));
    s.player.on('error', e => { log('Player', e.message); s.error=e.message; s.currentTrack=null; s.generation++; advance(s,s.generation); });
    states.set(id,s);
  }
  if(name) s.guild=name;
  return s;
}
function getPosition(s) { return !s.currentTrack || !s.started ? 0 : Math.max(0,(s.status==='paused'?s.pausedAt:Date.now())-s.started); }
function snapshot(s) { return { connected:!!s?.connection, guild:s?.guild||null, guildId:s?.guildId||null, voiceChannel:s?.channel||null, voiceChannelId:s?.channelId||null, playing:s?.status==='playing', paused:s?.status==='paused', status:s?.status||'disconnected', error:s?.error||null, currentTrack:s?.currentTrack||null, queue:(s?.queue||[]).map((track,index)=>({...track,index:index+1})), volume:s?.volume??100, loopMode:s?.loopMode||'off', autoplay:s?.autoplay||false, shuffle:s?.shuffle||false, position:s?getPosition(s):0, duration:s?.currentTrack?.duration||0 }; }
let ytdlpResolved, cookieFilePath, cookieResolved = false;
function binaryExists(cmd) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) { try { if (fs.existsSync(path.join(dir, cmd + ext))) return true; } catch (_) {} }
  }
  return false;
}
function resolveYtdlp() {
  if (ytdlpResolved) return ytdlpResolved;
  const list = [];
  if (process.env.YTDLP_PATH) list.push({ cmd: process.env.YTDLP_PATH, pre: [] });
  list.push({ cmd: 'yt-dlp', pre: [] });
  list.push({ cmd: 'python3', pre: ['-m', 'yt_dlp'] });
  list.push({ cmd: 'python', pre: ['-m', 'yt_dlp'] });
  for (const c of list) {
    if (path.isAbsolute(c.cmd) ? fs.existsSync(c.cmd) : binaryExists(c.cmd)) { ytdlpResolved = c; break; }
  }
  if (!ytdlpResolved) { log('YouTube', 'yt-dlp binary not found; install yt-dlp or set YTDLP_PATH'); ytdlpResolved = { cmd: 'yt-dlp', pre: [] }; }
  else log('YouTube', `Using yt-dlp: ${ytdlpResolved.cmd}`);
  return ytdlpResolved;
}
function parseCookies(raw) {
  const text = String(raw || '').replace(/^cookie\s*:/i, '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.length || !parsed[0]?.name) throw Error('cookie JSON must be an array of {name,value}');
    return parsed.map(c => ({ name: c.name, value: c.value, domain: c.domain || '.youtube.com', path: c.path || '/' }));
  }
  const list = text.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    if (i < 1) return null;
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.youtube.com', path: '/' };
  }).filter(Boolean);
  if (!list.length) throw Error('no cookies found');
  return list;
}
function cookieFile() {
  if (cookieResolved) return cookieFilePath;
  cookieResolved = true;
  const raw = process.env.YOUTUBE_COOKIE;
  if (!raw) return null;
  try {
    const cookies = parseCookies(raw);
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
      const domain = c.domain || '.youtube.com';
      lines.push([domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', 'FALSE', '0', c.name, c.value].join('\t'));
    }
    const finalPath = path.join(os.tmpdir(), 'avebot-cookies.txt');
    // Write to a unique temp file, then rename, so concurrent yt-dlp processes
    // never read a half-written cookie file (which yt-dlp rejects as non-Netscape).
    const tmpPath = finalPath + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
    fs.renameSync(tmpPath, finalPath);
    cookieFilePath = finalPath;
    log('YouTube', `Cookie file ready (${cookies.length} cookies)`);
  } catch (e) { log('YouTube', `Invalid YOUTUBE_COOKIE: ${e.message}`); }
  return cookieFilePath;
}
function envChoice(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const t = String(v).trim();
  if (!t || ['off', 'none', 'false', '0'].includes(t.toLowerCase())) return '';
  return t;
}
let ytdlpCapsCache = null;
function ytdlpCapabilities() {
  if (ytdlpCapsCache) return ytdlpCapsCache;
  ytdlpCapsCache = { jsRuntimes: true, remoteComponents: true };
  try {
    const { cmd, pre } = resolveYtdlp();
    const help = execFileSync(cmd, [...pre, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    ytdlpCapsCache.jsRuntimes = /--js-runtimes/.test(help);
    ytdlpCapsCache.remoteComponents = /--remote-components/.test(help);
  } catch (_) {}
  log('YouTube', 'yt-dlp capabilities: js-runtimes=' + ytdlpCapsCache.jsRuntimes + ' remote-components=' + ytdlpCapsCache.remoteComponents);
  return ytdlpCapsCache;
}
function ytdlpArgs(extra = [], allowPlaylist = false, useCookie = false, client) {
  const args = ['--no-warnings', '--socket-timeout', '15'];
  if (!allowPlaylist) args.push('--no-playlist');
  // With a logged-in cookie, YouTube answers HTTP 403 for the web clients
  // (default / web_embedded) on every stream, but the android and mweb clients
  // work reliably. Without a cookie the web clients still work, so keep android
  // as the default and let the env override it if YouTube changes again.
  const pc = client || process.env.YTDLP_PLAYER_CLIENT || 'android';
  if (pc) args.push('--extractor-args', 'youtube:player_client=' + pc);
  // YouTube requires solving the signature/n challenge before googlevideo URLs are
  // usable. Without a JS runtime yt-dlp cannot solve it, so the CDN answers HTTP
  // 403 ("unable to download video data") or YouTube asks to confirm you are not
  // a bot. Enable the Node runtime plus the remote EJS challenge solver.
  const caps = ytdlpCapabilities();
  const jsRuntime = envChoice('YTDLP_JS_RUNTIME', 'node');
  if (caps.jsRuntimes && jsRuntime) args.push('--js-runtimes', jsRuntime);
  const rc = envChoice('YTDLP_REMOTE_COMPONENTS', 'ejs:github');
  if (caps.remoteComponents && rc) args.push('--remote-components', rc);
  if (useCookie) { const ck = cookieFile(); if (ck) args.push('--cookies', ck); }
  return args.concat(extra);
}
function hasCookie() { return !!cookieFile(); }
function ytdlpJson(input, opts = {}) {
  const { cmd, pre } = resolveYtdlp();
  const extra = ['--dump-single-json', '--skip-download'].concat(opts.extra || []);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...ytdlpArgs(extra, !!opts.playlist, !!opts.cookie), input], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { const msg = (err || `yt-dlp exited ${code}`).trim().split('\n').filter(Boolean).pop(); return reject(Error(msg || 'yt-dlp failed')); }
      try { resolve(JSON.parse(out)); } catch (e) { reject(Error('Failed to parse yt-dlp output')); }
    });
  });
}
function toPcm(source) {
  const ff = spawn(resolveFfmpeg(), ['-hide_banner','-loglevel','error','-i','pipe:0','-f','s16le','-ar','48000','-ac','2','pipe:1'], { stdio: ['pipe','pipe','pipe'] });
  const out = ff.stdout;
  out.on('error', () => {});
  ff.stdin.on('error', () => {});
  source.on('error', () => {});
  source.pipe(ff.stdin);
  ff.stderr.on('data', d => { const line = String(d).trim(); if (line) log('Player', line.split('\n').pop()); });
  ff.on('error', e => out.destroy(e));
  ff.on('close', code => { if (code !== 0 && !ff.killed) out.destroy(Error(`ffmpeg exited ${code}`)); });
  const destroy = out.destroy.bind(out);
  out.destroy = (err) => { try { source.destroy(); } catch (_) {} try { ff.kill('SIGKILL'); } catch (_) {} return destroy(err); };
  return out;
}
function resolveFfmpeg() {
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch (_) {}
  return 'ffmpeg';
}
function ytdlpStream(url, useCookie, client) {
  const { cmd, pre } = resolveYtdlp();
  const child = spawn(cmd, [...pre, ...ytdlpArgs(['-f', 'bestaudio/best', '-o', '-', '--quiet', url], false, !!useCookie, client)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = child.stdout;
  out.on('error', () => {});
  child.stderr.on('data', d => { const line = String(d).trim(); if (!line) return; const last = line.split('\n').pop(); if (/Broken pipe|unable to write data/i.test(last)) return; log('YouTube', last); });
  child.on('error', e => out.destroy(e));
  child.on('close', code => { if (code !== 0 && !child.killed) out.destroy(Error(`yt-dlp exited ${code}`)); });
  const destroy = out.destroy.bind(out);
  out.destroy = (err) => { try { child.kill('SIGKILL'); } catch (_) {} return destroy(err); };
  return out;
}
function safeUrl(value) {
  let u;
  try { u = new URL(value); } catch (_) { throw Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('URL not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw Error('URL not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') throw Error('URL not allowed');
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) throw Error('URL not allowed');
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) throw Error('URL not allowed');
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) throw Error('URL not allowed');
  return u;
}
async function findYoutube(q, useCookie) {
  const isUrl = /^https?:/i.test(q);
  const input = isUrl ? q : `ytsearch1:${q}`;
  const attempts = isUrl ? 1 : 3;
  let v = null, lastErr = null;
  for (let i = 0; i < attempts && !v; i++) {
    try {
      const info = await ytdlpJson(input, { cookie: useCookie });
      const cand = info.entries ? info.entries[0] : info;
      if (cand && cand.webpage_url) v = cand;
    } catch (e) { lastErr = e; log('YouTube', 'Search attempt ' + (i + 1) + ' failed: ' + e.message); }
    if (!v && i < attempts - 1) await new Promise(r => setTimeout(r, 800));
  }
  if (!v) throw Error(lastErr ? lastErr.message : 'No YouTube result');
  const t = toTrack(v);
  t.cookie = !!useCookie;
  return t;
}
function toTrack(v) {
  const id = v.id || (v.webpage_url && (v.webpage_url.match(/[?&]v=([\w-]+)/) || [])[1]);
  return {
    title: v.title || 'Unknown',
    artist: v.uploader || v.channel || 'Unknown',
    url: v.webpage_url || (id ? 'https://www.youtube.com/watch?v=' + id : ''),
    duration: Number(v.duration || 0) * 1000,
    thumbnail: v.thumbnail || (id ? 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' : ''),
    platform: 'youtube'
  };
}
// Resolve a YouTube URL or search. When YOUTUBE_COOKIE is configured we go
// straight to the cookie-authenticated request and only fall back to the
// anonymous request if that fails (never the other way around).
async function resolveYoutube(q) {
  if (!hasCookie()) return findYoutube(q, false);
  try { return await findYoutube(q, true); }
  catch (e) {
    log('YouTube', 'Cookie attempt failed (' + e.message + '); retrying without cookie');
    return findYoutube(q, false);
  }
}
async function findYoutubeCandidates(q, n, useCookie) {
  const info = await ytdlpJson(`ytsearch${n}:${q}`, { playlist: true, extra: ['--flat-playlist'], cookie: useCookie });
  const entries = (info.entries || []).filter(Boolean);
  const tracks = entries.map(e => toTrack(e)).filter(t => t.url);
  for (const t of tracks) t.cookie = !!useCookie;
  return tracks;
}
function trackKey(t) {
  if (!t) return '';
  const base = String(t.title || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')            // (official video), [4K remaster], etc.
    .replace(/\b(feat|ft|featuring|with)\b.*$/g, ' ')     // feat. X -> drop
    .replace(/\b(official|lyric|lyrics|audio|video|visualizer|remaster(ed)?|hd|hq|4k|8k|mv|m\/v|music video|explicit|clean|live|acoustic|version|edit|prod)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  // Remove every token that belongs to the artist name so "keshi - always" and
  // "Always" (or the same song under a different uploader) collapse to one key.
  const artistTokens = new Set(String(t.artist || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean));
  const key = base.split(' ').filter(w => w && !artistTokens.has(w)).join(' ');
  return key.replace(/\s+/g, ' ').trim();
}
function pushRecent(s, t) {
  if (!t) return;
  if (t.url) { s.recent.unshift(t.url); s.recent = s.recent.slice(0, 20); }
  const k = trackKey(t);
  if (k) { s.recentKeys.unshift(k); s.recentKeys = s.recentKeys.slice(0, 20); }
}
// Normalize an artist name so "keshi", "keshi - Topic" and "Keshi Official"
// all compare equal when deciding whether autoplay stays with the same artist.
function artistKey(a) {
  return String(a || '').toLowerCase()
    .replace(/-\s*topic$/g, ' ')
    .replace(/\b(vevo|official|music|records|entertainment|topic|channel|band|the)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function sameArtist(a, b) {
  const ka = artistKey(a), kb = artistKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // tolerate "keshi" vs "keshi music" and similar suffixed uploader names
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 3 && long.startsWith(short + ' ');
}
async function autoplayNext(s, done) {
  if (!done || !done.artist) return null;
  const seenUrls = new Set(s.recent);
  const seenKeys = new Set(s.recentKeys || []);
  if (done.url) seenUrls.add(done.url);
  { const dk = trackKey(done); if (dk) seenKeys.add(dk); }
  // Autoplay stays on the SAME artist but must pick a DIFFERENT song.
  const isNew = t => t && t.url && !seenUrls.has(t.url) && !seenKeys.has(trackKey(t));
  const blocked = /podcast|interview|tutorial|full album|mix\b|reaction|compilation|1 hour|\d+\s*(hours?|minutes?)/i;
  const queries = [
    [done.artist, 'official audio'].filter(Boolean).join(' '),
    [done.artist, 'songs'].filter(Boolean).join(' '),
    [done.artist, 'album'].filter(Boolean).join(' ')
  ].filter(Boolean);
  for (const q of queries) {
    let cands = [];
    try { cands = await findYoutubeCandidates(q, 20, hasCookie()); }
    catch (e) {
      if (hasCookie()) { try { cands = await findYoutubeCandidates(q, 20, false); } catch (_) {} }
      if (!cands.length) { log('Player', 'Autoplay search failed (' + q + '): ' + e.message); continue; }
    }
    const pick = cands.find(t => isNew(t) && sameArtist(t.artist, done.artist) && !blocked.test(t.title));
    if (pick) return pick;
  }
  log('Player', 'Autoplay: no other track found for "' + done.artist + '"');
  return null;
}
function spotifyTrackId(value) {
  const v = String(value || '');
  return (v.match(/track[\/:]([A-Za-z0-9]{22})/) || [])[1] || (v.match(/track[\/:]([A-Za-z0-9]+)/) || [])[1] || null;
}
async function spotifyMeta(url) {
  const id = spotifyTrackId(url);
  // Parallel race: Spotify API vs yt-dlp music.youtube.com search.
  // Spotify blocks oembed/scrape from datacenter IPs; yt-dlp ytmusic works.
  const tasks = [];
  if (id && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    tasks.push((async () => {
      try {
        const Spotify = require('spotify-web-api-node');
        const api = new Spotify({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET });
        api.setAccessToken((await api.clientCredentialsGrant()).body.access_token);
        const t = (await api.getTrack(id)).body;
        return { title: t.name, artist: t.artists.map(x => x.name).join(', '), duration: t.duration_ms, thumbnail: t.album.images[0] ? t.album.images[0].url : '' };
      } catch (e) { log('Spotify', 'API getTrack failed (' + (e.statusCode || e.message) + ')'); return null; }
    })());
  }
  tasks.push((async () => {
    try {
      const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url));
      if (!r.ok) return null;
      const j = await r.json();
      const raw = j.title || '';
      if (!raw) return null;
      const parts = raw.split(' - ');
      const artist = parts.length > 1 ? parts[0] : '';
      const track = parts.length > 1 ? parts.slice(1).join(' - ') : raw;
      const info = await ytdlpJson('ytsearch1:' + (artist + ' ' + track).trim(), { cookie: hasCookie() });
      const v = info.entries ? info.entries[0] : info;
      return { title: track, artist: artist, duration: Number((v && v.duration) || 0) * 1000, thumbnail: j.thumbnail_url || (v && v.thumbnail) || '' };
    } catch (_) { return null; }
  })());
  const race = tasks.map(t => Promise.resolve(t).then(r => { if (!r) throw new Error('skip'); return r; }));
  const winner = await Promise.any(race).catch(() => null)
    || await Promise.all(tasks.map(t => Promise.resolve(t).catch(() => null))).then(rs => rs.find(Boolean) || null);
  if (winner) return winner;
  throw Error('Could not read Spotify track metadata');
}
async function resolveSpotify(url) {
  const id = spotifyTrackId(url);
  const canonical = 'https://open.spotify.com/track/' + id;
  const meta = await spotifyMeta(canonical);
  const q = [meta.artist, meta.title].filter(Boolean).join(' ') || meta.title;
  log('Spotify', 'Resolving on YouTube: ' + q);
  let t = null;
  try { t = await findYoutube(q, hasCookie()); }
  catch (e) {
    if (!t) {
      const fb = (await deezerSearch(q)) || (await spotifySearch(q));
// ponytail: preview fallback removed per user request; upgrade path: restore if user re-enables previews
      throw e;
    }
  }
  return { title: meta.title || t.title, artist: meta.artist || t.artist, url: t.url, duration: meta.duration || t.duration, thumbnail: meta.thumbnail || t.thumbnail, platform: 'spotify', cookie: !!t.cookie };
}
async function spotifySearch(q) {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;
  try {
    const Spotify = require('spotify-web-api-node');
    const api = new Spotify({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET });
    api.setAccessToken((await api.clientCredentialsGrant()).body.access_token);
    const r = await api.searchTracks(q, { limit: 1 });
    const t = r.body && r.body.tracks && r.body.tracks.items && r.body.tracks.items[0];
    if (!t) return null;
    return { title: t.name, artist: (t.artists || []).map(x => x.name).join(', '), preview: '' };
  } catch (e) { log('Spotify', 'Search fallback unavailable (' + (e && e.statusCode ? 'HTTP ' + e.statusCode : (e && e.message) || e) + ')'); return null; }
}
async function deezerSearch(q) {
  try {
    const r = await fetch('https://api.deezer.com/search?limit=1&q=' + encodeURIComponent(q));
    if (!r.ok) return null;
    const j = await r.json();
    const t = j.data && j.data[0];
    if (!t) return null;
    return { title: t.title, artist: (t.artist && t.artist.name) || '', preview: t.preview || '' };
  } catch (e) { log('Spotify', 'Deezer fallback unavailable (' + (e && e.message) + ')'); return null; }
}
const MAX_PLAYLIST = 50;
function playlistId(value) {
  const v = String(value || '');
  const m = v.match(/playlist[\/:]([A-Za-z0-9]{22})/) || v.match(/album[\/:]([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}
function playlistKind(value) {
  const v = String(value || '');
  if (/[\/:]album[\/:]/.test(v) || /^spotify:album:/.test(v)) return 'album';
  return 'playlist';
}
async function spotifyPlaylist(url) {
  const id = playlistId(url);
  if (!id) throw Error('Could not read Spotify playlist id');
  const kind = playlistKind(url);
  const embed = 'https://open.spotify.com/embed/' + kind + '/' + id;
  const r = await fetch(embed, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en' } });
  if (!r.ok) throw Error('Spotify playlist unavailable (HTTP ' + r.status + ')');
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw Error('Could not parse Spotify playlist');
  const j = JSON.parse(m[1]);
  const entity = j && j.props && j.props.pageProps && j.props.pageProps.state && j.props.pageProps.state.data && j.props.pageProps.state.data.entity;
  const list = (entity && entity.trackList) || [];
  if (!list.length) throw Error('Spotify playlist is empty');
  return list.slice(0, MAX_PLAYLIST).filter(t => t && t.title).map(t => ({
    title: t.title,
    artist: t.subtitle || 'Unknown',
    duration: Number(t.duration || 0),
    thumbnail: '',
    platform: 'spotify',
    query: [t.subtitle, t.title].filter(Boolean).join(' ')
  }));
}
async function youtubePlaylist(url) {
  let info;
  try { info = await ytdlpJson(url, { playlist: true, extra: ['--flat-playlist'], cookie: hasCookie() }); }
  catch (e) {
    if (!hasCookie()) throw e;
    log('YouTube', 'Playlist cookie attempt failed (' + e.message + '); retrying without cookie');
    info = await ytdlpJson(url, { playlist: true, extra: ['--flat-playlist'] });
  }
  const entries = (info.entries || []).filter(Boolean).slice(0, MAX_PLAYLIST);
  if (!entries.length) throw Error('YouTube playlist is empty');
  return entries.map(e => {
    const id = e.id || (e.url && (e.url.match(/[?&]v=([\w-]+)/) || [])[1]);
    const link = e.webpage_url || e.url || (id ? 'https://www.youtube.com/watch?v=' + id : '');
    if (!link) return null;
    return {
      title: e.title || 'Unknown',
      artist: e.uploader || e.channel || 'Unknown',
      url: link,
      duration: Number(e.duration || 0) * 1000,
      thumbnail: e.thumbnails && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : (id ? 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' : ''),
      platform: 'youtube'
    };
  }).filter(Boolean);
}
function isPlaylistQuery(q) {
  const v = String(q || '');
  if (/[?&]list=/.test(v) || /youtube\.com\/playlist/i.test(v)) return true;
  if (/spotify:(playlist|album):/i.test(v)) return true;
  if (/spotify\.com\/(playlist|album)\//i.test(v)) return true;
  return false;
}
async function resolvePlaylist(q) {
  const v = String(q || '');
  if (/spotify:(playlist|album):/i.test(v) || /spotify\.com\/(playlist|album)\//i.test(v)) {
    log('Spotify', 'Loading playlist ' + playlistId(v));
    const tracks = await spotifyPlaylist(v);
    log('Spotify', 'Playlist tracks: ' + tracks.length);
    return tracks;
  }
  log('YouTube', 'Loading playlist');
  const tracks = await youtubePlaylist(v);
  log('YouTube', 'Playlist tracks: ' + tracks.length);
  return tracks;
}
async function resolveOne(q) {
  q = String(q || '').trim();
  if (!q) throw Error('Song title or URL required');
  if (/spotify\.com\//i.test(q) || /^spotify:/i.test(q)) {
    if (!spotifyTrackId(q)) throw Error('Unsupported Spotify link');
    return resolveSpotify(q);
  }
  if (/^https?:/i.test(q)) {
    const u = safeUrl(q);
    if (/youtube\.com$|youtu\.be$/i.test(u.hostname)) return resolveYoutube(q);
    if (/soundcloud\.com$/i.test(u.hostname)) throw Error('SoundCloud is not supported in this build');
    if (!/\.(mp3|ogg|opus|wav|m4a|aac|flac)(\?|$)/i.test(u.pathname + u.search)) throw Error('URL must point to audio');
    return { title: path.basename(u.pathname), artist: u.hostname, url: u.href, duration: 0, thumbnail: '', platform: 'direct' };
  }
// Parallel race: yt-dlp (cookie+anon) vs Spotify/Deezer metadata → YT search.
  // First to resolve wins; losers are discarded silently.
  const tasks = [];
  tasks.push(findYoutube(q, hasCookie()).catch(() => null));
  if (!hasCookie()) tasks.push(findYoutube(q, false).catch(() => null));
  tasks.push((async () => {
    const fb = (await spotifySearch(q)) || (await deezerSearch(q));
    if (!fb) return null;
    const retry = [fb.artist, fb.title].filter(Boolean).join(' ') || q;
    try {
      const t = await findYoutube(retry, hasCookie());
      return { ...t, title: fb.title || t.title, artist: fb.artist || t.artist, platform: 'spotify' };
    } catch (_) { return null; }
  })());
  const race = tasks.map(t => Promise.resolve(t).then(r => { if (!r) throw new Error('skip'); return r; }));
  const winner = await Promise.any(race).catch(() => null)
    || await Promise.all(tasks.map(t => Promise.resolve(t).catch(() => null))).then(rs => rs.find(Boolean) || null);
  if (winner) return winner;
  throw Error('No result from any source');
}

async function prepareTrack(s, track) {
  if (!track) return null;
  if (track.lazy) {
    log('Queue', 'Resolving ' + (track.title || track.query));
    const resolved = await resolveOne(track.query);
    return { ...resolved, title: track.title || resolved.title, artist: track.artist || resolved.artist };
  }
  return track;
}
async function playCurrent(s, g) {
  if (g !== s.generation || !s.currentTrack) return;
  const t = s.currentTrack;
  s.status = 'loading'; s.error = '';
  log('Player', 'Preparing ' + t.title);
  let source;
  if (t.platform === 'direct') {
    const r = await fetch(safeUrl(t.url), { redirect: 'error' });
    if (!r.ok || !r.body || !(r.headers.get('content-type') || '').startsWith('audio/')) throw Error('Audio URL unavailable');
    source = Readable.fromWeb(r.body);
  } else source = ytdlpStream(t.url, t.cookie, t.client);
  source.on('error', e => { if (g === s.generation) { log('Player', e.message); streamFailed(s, g, e); } });
  const resource = createAudioResource(toPcm(source), { inputType: StreamType.Raw, inlineVolume: true });
  if (resource.volume) resource.volume.setVolume(s.volume / 100);
  s.started = Date.now(); s.pausedAt = 0; s.playingGeneration = g;
  s.player.play(resource); s.status = 'playing';
  log('Player', 'Playing ' + t.title);
}
// A track failed mid-stream (network/ffmpeg/yt-dlp 403). yt-dlp-backed tracks
// are retried twice with alternate player clients (cookies are already used on
// the first attempt), then dropped from the queue so playback can continue.
function streamFailed(s, g, err) {
  if (g !== s.generation) return;
  const failed = s.currentTrack;
  s.error = (err && err.message) || 'Stream failed';
  s.currentTrack = null;
  s.generation++;
  s.status = 'idle'; s.started = 0;
  try { s.player.stop(true); } catch (_) {}
  const ytdlpTrack = failed && failed.url && failed.platform !== 'direct';
  if (ytdlpTrack && (failed.attempt || 0) < 2) {
    const attempt = (failed.attempt || 0) + 1;
    const useCookie = hasCookie() && !failed.cookie;
    const client = useCookie ? undefined : (attempt === 1 ? 'mweb' : 'android');
    log('YouTube', 'Stream failed (' + s.error + '); retry ' + attempt + (useCookie ? ' with cookie' : ' with client ' + client));
    s.queue.unshift({ ...failed, attempt, cookie: useCookie || !!failed.cookie, client });
  } else if (failed && failed.url) {
    log('Player', 'Giving up on "' + (failed.title || failed.url) + '": ' + s.error);
    pushRecent(s, failed);
  }
  setTimeout(() => advance(s, s.generation, false), 0);
}
async function advance(s, g, manualSkip) {
  if (g !== s.generation) return;
  const epoch = s.epoch;
  if (s.busy) { s.pending = { manualSkip: !!manualSkip }; return; }
  s.busy = true;
  try {
    const done = s.currentTrack;
    if (done) {
      pushRecent(s, done);
      // Natural end while looping a single track: replay the same track.
      if (!manualSkip && s.loopMode === 'track') { await playCurrent(s, ++s.generation); return; }
      // Loop queue (or a manual skip while looping the queue): keep it in rotation.
      if (s.loopMode === 'queue') s.queue.push(done);
    }
    if (manualSkip && s.loopMode === 'track') { s.loopMode = 'off'; log('Player', 'Loop track disabled by skip'); }
    // Pull the next playable track. Failed/unresolvable tracks are dropped and
    // we continue with the next one instead of hanging or stopping the player.
    let guard = 0;
    while (guard++ < 300) {
      if (epoch !== s.epoch) return; // stop/leave/skip happened while preparing
      let next = s.shuffle && s.queue.length ? s.queue.splice(Math.floor(Math.random() * s.queue.length), 1)[0] : s.queue.shift() || null;
      if (!next) break;
      if (next.lazy) {
        try { next = await prepareTrack(s, next); }
        catch (e) { log('Queue', 'Skipping unresolved track "' + next.title + '": ' + e.message); continue; }
        if (!next) continue;
      }
      s.currentTrack = next;
      try { await playCurrent(s, ++s.generation); return; }
      catch (e) {
        s.error = e.message;
        if (next.url && next.platform !== 'direct' && (next.attempt || 0) < 2) {
          const attempt = (next.attempt || 0) + 1;
          const useCookie = attempt === 1 && hasCookie() && !next.cookie;
          log('YouTube', 'Track failed (' + e.message + '); retry ' + attempt + (useCookie ? ' with cookie' : ' with alternate client'));
          s.queue.unshift({ ...next, attempt, cookie: useCookie || !!next.cookie, client: attempt >= 2 ? 'mweb' : undefined });
        } else {
          log('Player', 'Skipping failed track "' + next.title + '": ' + e.message);
          pushRecent(s, next);
        }
        s.currentTrack = null;
      }
    }
    s.currentTrack = null;
    if (s.autoplay && done) {
      const candidate = await autoplayNext(s, done);
      if (candidate) { s.currentTrack = candidate; try { await playCurrent(s, ++s.generation); return; } catch (e) { s.error = e.message; s.currentTrack = null; } }
    }
    s.status = 'idle'; s.started = 0;
  } catch (e) {
    s.error = e.message; s.status = 'error'; log('Player', e.message);
  } finally {
    s.busy = false;
    const p = s.pending;
    s.pending = null;
    if (p) setTimeout(() => kick(s, p.manualSkip), 0);
  }
}
// Start the next track when the player is idle. If another advance is running,
// remember the request so it is honoured once that one finishes.
function kick(s, manualSkip) {
  if (s.busy) { s.pending = { manualSkip: !!manualSkip }; return; }
  if (s.currentTrack || s.queue.length) advance(s, s.generation, !!manualSkip);
}
async function enqueue(s, query) {
  query = String(query || '').trim();
  if (!query) throw Error('Song title or URL required');
  s.epoch++; // cancel any in-flight advance so concurrent text queries don't race
  const startIdle = !s.currentTrack || ['idle', 'error', 'disconnected'].includes(s.status);
  if (isPlaylistQuery(query)) {
    const tracks = await resolvePlaylist(query);
    if (!tracks.length) throw Error('Playlist is empty');
    let added = 0;
    for (const t of tracks) {
      if (s.queue.length >= 200) break;
      if (t.url) s.queue.push(t);
      else s.queue.push({ title: t.title, artist: t.artist, duration: t.duration || 0, thumbnail: '', platform: t.platform || 'spotify', lazy: true, query: t.query || ((t.artist || '') + ' ' + (t.title || '')).trim() });
      added++;
    }
    log('Queue', 'Added ' + added + ' playlist tracks');
  } else {
    if (s.queue.length >= 200) throw Error('Queue is full');
    const t = await resolveOne(query);
    if (!startIdle) { s.queue.push(t); return; }
    s.queue.unshift(t);
  }
  // Everything goes through the resilient advance loop so a track that fails to
  // resolve or stream is skipped instead of hanging the player.
  if (startIdle) { s.generation++; kick(s, false); }
}
async function run(s, cmd, args = []) {
  s.error = '';
  if (s.connection) lastActiveId = s.guildId;
  switch (cmd) {
    case 'play': await enqueue(s, args.join(' ')); break;
    case 'pause': if (s.player.pause()) { s.pausedAt = Date.now(); s.status = 'paused'; } break;
    case 'resume': if (s.player.unpause()) { if (s.pausedAt) s.started += Date.now() - s.pausedAt; s.pausedAt = 0; s.status = 'playing'; } break;
    case 'skip': { if (!s.currentTrack && !s.queue.length) throw Error('Nothing to skip'); s.generation++; s.epoch++; s.player.stop(true); kick(s, true); break; }
    case 'stop': s.generation++; s.epoch++; s.player.stop(true); s.queue = []; s.currentTrack = null; s.started = 0; s.status = 'idle'; s.error = ''; break;
    case 'leave': s.generation++; s.epoch++; s.leaving = true; s.player.stop(true); s.queue = []; s.currentTrack = null; s.status = 'disconnected'; s.connection?.destroy(); states.delete(s.guildId); break;
    case 'join': if (s.connection && s.connection.state.status === VoiceConnectionStatus.Ready) break; throw Error('Not connected. Join via the web controller or type avejoin while you are in a voice channel.');
    case 'queue': break;
    case 'shuffle': { const m = args.find(a => ['on', 'off'].includes(a)); if (m === 'off') { s.shuffle = false; } else { if (!s.shuffle) { for (let i = s.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]]; } } s.shuffle = true; } break; }
    case 'remove': { const raw = args.find(a => Number.isInteger(Number(a))); const i = Number(raw) - 1; if (!Number.isInteger(i) || i < 0 || i >= s.queue.length) throw Error('Queue index out of range'); s.queue.splice(i, 1); break; }
    case 'volume': { const raw = args.find(a => Number.isFinite(Number(a))); const v = Number(raw); if (raw === undefined || !Number.isFinite(v) || v < 0 || v > 100) throw Error('Volume must be 0-100'); s.volume = v; const r = s.player.state.resource; if (r?.volume) r.volume.setVolume(v / 100); break; }
    case 'loop': { const m = args.find(a => ['off', 'track', 'queue'].includes(a)); if (args.length && !m) throw Error('Loop must be off, track, or queue'); s.loopMode = m || 'track'; break; }
    case 'autoplay': { const m = args.find(a => ['on', 'off'].includes(a)); if (args.length && !m) throw Error('Autoplay must be on or off'); s.autoplay = m ? m === 'on' : true; break; }
    default: throw Error('Unknown command: ' + cmd);
  }
}
const client=new Client({ checkUpdate: false });
// Text control channel: type commands with the "ave" prefix in any text channel
// AveBot can read (e.g. "ave play laufey promise", "avejoin", "ave skip").
// A voice session counts as "in use" while it is playing/loading/paused or has
// queued tracks. An idle connection is not in use, so others may pull the bot.
function isBotBusy(s) {
  if (!s || !s.connection) return false;
  if (s.currentTrack) return true;
  if (s.status === 'playing' || s.status === 'paused' || s.status === 'loading') return true;
  return !!(s.queue && s.queue.length);
}
// AveBot NEVER replies, reacts, or sends anything back to Discord.
client.on('messageCreate', async (m) => {
  try {
    if (!m || !m.content || !m.author) return;
    if (m.author.bot) return;
    const parsed = parseVoiceCommand(m.content);
    if (!parsed || !parsed.command) return;
    if (!KNOWN.has(parsed.command)) { log('Command', 'Unknown command: ' + parsed.command); return; }
    const vc = m.member && m.member.voice ? m.member.voice.channel : null;
    const whitelisted = WHITELIST.has(m.author.id);
    // The bot holds at most one voice connection at a time.
    const botState = [...states.values()].find(st => st.connection);
    const sameVoice = !!vc && !!botState && vc.id === botState.channelId;
    // avejoin: allowed when the bot is free (not connected, or connected but idle),
    // when you are already in its channel, or when you are whitelisted. A bot that is
    // actively in use in another channel will NOT be pulled away by non-whitelisted users.
    if (parsed.command === 'join') {
      if (!vc) { log('Voice', 'join ignored: you are not in a voice channel'); return; }
      if (botState && !sameVoice && isBotBusy(botState) && !whitelisted) {
        log('Voice', 'join ignored for ' + m.author.id + ': bot is in use in "' + (botState.channel || botState.channelId) + '"');
        return;
      }
      await joinChannel(vc.id);
      log('Command', 'join -> ' + vc.name);
      return;
    }
    let s;
    if (!botState) {
      // Bot is not in voice yet: anyone in a voice channel may start playback here.
      if (!vc) { log('Command', 'no active player; join a voice channel first'); return; }
      s = await joinChannel(vc.id);
    } else {
      // Bot is already playing: only users in the SAME voice channel (or whitelisted)
      // may control it. Everyone else is silently ignored.
      if (!sameVoice && !whitelisted) {
        log('Command', 'ignored "' + parsed.command + '" from ' + m.author.id + ': not in the bot\'s voice channel');
        return;
      }
      s = botState;
    }
    await run(s, parsed.command, parsed.args);
    log('Command', parsed.command + (parsed.args.length ? ' ' + parsed.args.join(' ') : ''));
  } catch (e) { log('Command', e.message); }
});
// A user account can only hold ONE voice session, but a hard-killed process leaves
// a ghost session on Discord's side (the client shows the bot in an old channel).
// Send a voice-state leave (op 4) for every guild before we join a new one.
function clearStaleVoiceSessions() {
  try {
    const shard = client.ws && client.ws.shards ? client.ws.shards.first() : null;
    if (!shard) return;
    for (const g of client.guilds.cache.values()) {
      try { shard.send({ op: 4, d: { guild_id: g.id, channel_id: null, self_mute: true, self_deaf: true } }); } catch (_) {}
    }
  } catch (_) {}
}
async function joinChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!/^\d{17,20}$/.test(id)) throw Error('Invalid Voice Channel ID');
  const ch = await client.channels.fetch(id);
  const isVoice = ch ? (typeof ch.isVoiceBased === 'function' ? ch.isVoiceBased() : (typeof ch.isVoice === 'function' ? ch.isVoice() : ['GUILD_VOICE','GUILD_STAGE_VOICE'].includes(ch.type))) : false;
  if (!isVoice || !ch.guild) throw Error('Voice channel unavailable');
  const s = stateFor(ch.guild.id, ch.guild.name);
  // A user account holds a single voice connection: tear down every other guild
  // first, and clear any ghost voice session left on Discord by a previous run.
  for (const [gid, other] of states) {
    if (gid === ch.guild.id) continue;
    other.leaving = true;
    try { other.player.stop(true); } catch (_) {}
    try { other.connection?.destroy(); } catch (_) {}
    states.delete(gid);
  }
  try {
    const shard = client.ws && client.ws.shards ? client.ws.shards.first() : null;
    if (shard) for (const g of client.guilds.cache.values()) {
      if (g.id === ch.guild.id) continue;
      try { shard.send({ op: 4, d: { guild_id: g.id, channel_id: null, self_mute: true, self_deaf: true } }); } catch (_) {}
    }
  } catch (_) {}
  s.connection?.destroy();
  s.leaving=false;
  const c = joinVoiceChannel({ channelId:id, guildId:ch.guild.id, adapterCreator:ch.guild.voiceAdapterCreator, selfDeaf:true, selfMute:true });
  s.connection=c; s.channelId=id; s.channel=ch.name; s.status='idle';
  c.subscribe(s.player);
  c.on('error',e=>log('Voice',e.message));
  c.on(VoiceConnectionStatus.Disconnected,()=>{
    log('Voice','Disconnected from voice channel');
    if(s.leaving || s.connection !== c) return;
    // Try to recover: re-signal, and if that fails, rejoin the same channel.
    Promise.resolve().then(async()=>{
      try { await Promise.race([entersState(c, VoiceConnectionStatus.Signalling, 5000), entersState(c, VoiceConnectionStatus.Connecting, 5000)]); }
      catch(_) {
        if(s.leaving || s.connection !== c) return;
        try { c.destroy(); } catch(_){}
        if(s.leaving || s.connection !== c) return;
        log('Voice','Reconnecting to '+s.channel+'...');
        try { await joinChannel(s.channelId); } catch(e) { log('Voice','Reconnect failed: '+e.message); s.status='disconnected'; }
      }
    }).catch(e=>log('Voice',e.message));
  });
  c.on(VoiceConnectionStatus.Destroyed,()=>{if(s.connection===c)s.connection=null;if(!s.leaving&&s.connection===null)s.status='disconnected';});
  let ready = false, lastErr = null;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    try { await entersState(c, VoiceConnectionStatus.Ready, 15000); ready = true; }
    catch (e) {
      lastErr = e;
      log('Voice', 'Join attempt ' + attempt + ' failed: ' + e.message);
      if (c.state.status === VoiceConnectionStatus.Destroyed) break;
      if (attempt < 3) { try { c.rejoin(); } catch (_) {} await new Promise(r => setTimeout(r, 1000)); }
    }
  }
  if (!ready) {
    try { c.destroy(); } catch(_) {}
    s.connection = null; s.status = 'disconnected'; s.channelId = ''; s.channel = '';
    if (!s.currentTrack && !s.queue.length) states.delete(s.guildId);
    let hint = '';
    try {
      const me = ch.guild.members.me || await ch.guild.members.fetch(client.user.id);
      if (me && me.communicationDisabledUntil && new Date(me.communicationDisabledUntil) > new Date()) {
        hint = ' This account is timed out in "' + ch.guild.name + '" until ' + new Date(me.communicationDisabledUntil).toISOString() + '; Discord blocks timed-out members from joining voice.';
      }
    } catch (_) {}
    throw Error('Voice connection failed: ' + (lastErr ? lastErr.message : 'timeout') + hint);
  }
  lastActiveId = s.guildId;
  log('Voice',`Connected to ${ch.name}`);
  return s;
}
function send(res,promise) { promise.then(()=>res.json({ok:true,message:'OK'})).catch(e=>{log('API',e.message);res.status(200).json({ok:false,error:e.message});}); }
app.get('/health',(q,r)=>r.json({ok:true,service:'AveBot'}));app.get('/',(q,r)=>r.sendFile(path.join(__dirname,'index.html')));
app.get('/api/state',(q,r)=>r.json(snapshot(active())));
app.post('/api/join',(q,r)=>send(r,joinChannel(q.body.channelId)));
const active=()=>{ if(lastActiveId&&states.has(lastActiveId)) return states.get(lastActiveId); for(const st of states.values()) if(st.connection) return st; return states.values().next().value; };
for(const [route,cmd] of Object.entries({leave:'leave',play:'play',pause:'pause',resume:'resume',skip:'skip',stop:'stop',queue:'queue',shuffle:'shuffle',loop:'loop',autoplay:'autoplay',volume:'volume','remove-queue-item':'remove'}))app.post(`/api/${route}`,(q,r)=>{try{const s=active();if(!s)return r.json({ok:false,error:'No active player'});const body=q.body||{};const args=cmd==='play'?[String(body.query||'')]:cmd==='volume'?[String(body.volume)]:cmd==='loop'?[String(body.mode||'')].filter(Boolean):cmd==='autoplay'||cmd==='shuffle'?[String(body.state||'')].filter(Boolean):cmd==='remove'?[String(body.index)]:[];send(r,run(s,cmd,args));}catch(e){log('API',e.message);if(!r.headersSent)r.status(200).json({ok:false,error:e.message});}});
app.use('/api',(q,r)=>r.status(404).json({ok:false,error:'Unknown API endpoint'}));
app.use((err,q,r,n)=>{log('Web',err.message);if(r.headersSent)return;r.status(400).json({ok:false,error:'Invalid request'});});
client.once('ready',()=>{log('Discord',`Logged in as ${client.user.tag}`);setTimeout(clearStaleVoiceSessions,1500);});
process.on('unhandledRejection',e=>log('Discord','Unhandled rejection: '+(e&&e.message?e.message:e)));
process.on('uncaughtException',e=>log('Discord','Uncaught exception: '+(e&&e.message?e.message:e)));
async function main(){app.listen(PORT,'0.0.0.0',()=>log('Web',`Listening on 0.0.0.0:${PORT}`));if(!process.env.DISCORD_TOKEN){log('Discord','DISCORD_TOKEN missing - web controller only');return;}await client.login(process.env.DISCORD_TOKEN);}
main().catch(e=>{console.error('[Discord]',e.message);process.exit(1);});
