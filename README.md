# AveBot

Discord music bot controlled from a web dashboard and Discord text commands.

> AveBot does not respond to Discord text messages. It never replies, reacts, or sends anything back. Commands are sent as text (prefix `ave`) or through the web controller.

## Features

- Web dashboard to join/leave voice, play, and control the player
- Text commands with the prefix `ave` in any Discord text channel AveBot can read
- Silent `avejoin` trigger: type `avejoin` (or `ave join`) while you are in a voice channel and AveBot joins you
- YouTube playback via yt-dlp (search + URL), Spotify track resolution (Web API or oembed fallback), direct audio links
- Resolution order for a text query: yt-dlp (cookie first) and Spotify/Deezer metadata race in parallel; the first result wins
- Resolution order for a YouTube URL: yt-dlp (cookie first), then an anonymous retry
- Resolution order for a Spotify URL: Spotify Web API or public oembed metadata -> yt-dlp (cookie first) search on YouTube
- yt-dlp runs with a JavaScript runtime and the EJS challenge solver, which fixes YouTube HTTP 403 / "Sign in to confirm you are not a bot" on datacenter IPs
- YouTube and Spotify playlists (up to 50 tracks per playlist) are queued automatically
- A track that fails to resolve or stream is skipped automatically so playback keeps going
- Queue, shuffle, loop (off/track/queue), autoplay
- Realtime volume control
- Per-guild state (`Map<guildId, playerState>`); the dashboard follows the active guild
- Railway-ready deployment

## Requirements

- Node.js 20 or newer
- `yt-dlp` on PATH (or `python -m yt_dlp` available, or set `YTDLP_PATH`)
- `ffmpeg` on PATH (the bundled `ffmpeg-static` is used automatically when present)

## Local Setup

1. Install yt-dlp: `pip install -U yt-dlp`
2. Make sure ffmpeg is on PATH (or rely on `ffmpeg-static`)
3. Copy `.env.example` to `.env` and fill in values
4. Run:

```bash
npm install
npm start
```

5. Open http://localhost:3000

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord user token (required). Keep it in the environment only; never put it in the web UI. |
| `PORT` | Web server port (default 3000, set automatically by Railway) |
| `SPOTIFY_CLIENT_ID` | Spotify API client ID (optional; falls back to public metadata when unavailable) |
| `SPOTIFY_CLIENT_SECRET` | Spotify API client secret (optional) |
| `YTDLP_PATH` | Custom yt-dlp binary path (optional) |
| `YTDLP_PLAYER_CLIENT` | Override the yt-dlp YouTube player client (optional; default `default,web_embedded`) |
| `YTDLP_JS_RUNTIME` | JavaScript runtime yt-dlp uses to solve YouTube signature/n challenges (default `node`; set to `off` to disable) |
| `YTDLP_REMOTE_COMPONENTS` | Remote EJS challenge solver component (default `ejs:github`; set to `off` to disable) |
| `YOUTUBE_COOKIE` | YouTube cookie (JSON export or raw `name=value; ...` header). Strongly recommended on Railway: AveBot uses it first and only falls back to an anonymous request when it is missing or fails. |

## Discord Setup

AveBot uses a Discord user token (selfbot). It never sends messages, replies, embeds, or reactions.

1. Set `DISCORD_TOKEN` in the environment (Railway variables or `.env` locally).
2. Use the account in the server that owns the voice channel.
3. Start AveBot. It logs `[Discord] Logged in as ...`.

## Joining Voice

AveBot has no default voice channel. It joins in two ways:

- **Web:** paste a Voice Channel ID in the dashboard and press **Join Voice**.
- **Text trigger:** be in a voice channel and type `avejoin` (or `ave join`) in any text channel AveBot can read. AveBot joins your current voice channel and stays silent.

### Getting a Voice Channel ID

1. Enable Developer Mode in Discord Settings > Advanced
2. Right-click a voice channel
3. Click "Copy Channel ID"
4. Paste it into the dashboard's Voice Channel ID field

## Commands

Commands use the prefix `ave` and are typed in any text channel AveBot can read. AveBot never replies:

```
ave join
ave play laufey promise
ave play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
ave play https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI
ave pause
ave resume
ave skip
ave stop
ave leave
ave queue
ave shuffle
ave remove 2
ave volume 70
ave loop
ave loop track
ave loop queue
ave autoplay on
ave autoplay off
```

Aliases: `p` play, `next`/`s` skip, `disconnect`/`dc` leave, `q` queue, `mix` shuffle, `vol` volume, `continue` resume, `repeat` loop, `connect` join.

## Railway Deployment

1. Push this repository to GitHub
2. Create a new project on Railway from the GitHub repo
3. Add the environment variables in the Railway dashboard
4. Deploy

The build installs `yt-dlp`, `ffmpeg` and Node.js 20 automatically:
- Railpack (Railway's current default builder) reads `railpack.json`.
- Nixpacks reads `nixpacks.toml`.
Both files are kept in sync, so the deploy works with either builder. The web server listens on `0.0.0.0:$PORT` and exposes `GET /health`.

## Architecture

```
Discord text command ─┐
                      ├──> Command Router ───> Music Engine (yt-dlp + ffmpeg)
Website API ──────────┘
```

Text and web inputs share the same per-guild player state, so queue, volume, loop, autoplay and status stay in sync.

## License

MIT - see LICENSE file. Based on [umutxyp/MusicBot](https://github.com/umutxyp/MusicBot).