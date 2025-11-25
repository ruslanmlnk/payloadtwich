import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync, type ChildProcess } from 'child_process'

type StreamState = {
  process: ChildProcess | null
  running: boolean
  lastOpts: StartOptions | null
  consecutiveFailures: number
  lastFailureAt: number
}

type StartOptions = {
  backgrounds: { path: string; duration: number }[]
  tracks: string[]
  streamUrl: string
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'
const FORCE_XFADE = process.env.FORCE_XFADE === 'true'
const FORCE_ACROSSFADE = process.env.FORCE_ACROSSFADE === 'true'
const REMUX_TRACKS = process.env.REMUX_TRACKS !== 'false'

const FPS = Number(process.env.STREAM_FPS || 30)
const AUDIO_SR = 44100
const DEFAULT_XFADE = Number(process.env.STREAM_XFADE_SEC || 2)
const FAILURE_RESET_MS = 30_000
const MAX_CONSECUTIVE_FAILURES = 3

const state: StreamState = {
  process: null,
  running: false,
  lastOpts: null,
  consecutiveFailures: 0,
  lastFailureAt: 0,
}

const filterCache = new Map<string, boolean>()
const sanitizedTrackCache = new Map<string, { tmpPath: string; cacheKey: string }>()
const remuxTrackCache = new Map<string, { tmpPath: string; cacheKey: string }>()

const buildCacheKey = (stats: fs.Stats) => `${stats.mtimeMs}-${stats.size}`

const id3v2Size = (buf: Buffer) => {
  if (buf.length < 10) return 0
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0

  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]
  return 10 + size
}

const hasId3v1Tag = (buf: Buffer) => {
  if (buf.length < 128) return false
  const start = buf.length - 128
  return buf[start] === 0x54 && buf[start + 1] === 0x41 && buf[start + 2] === 0x47
}

const firstMp3FrameOffset = (buf: Buffer) => {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      return i
    }
  }
  return 0
}

const apeTailOffset = (buf: Buffer) => {
  const sig = Buffer.from('APETAGEX')
  const idx = buf.lastIndexOf(sig)
  // Only treat it as an APE footer if it sits near the end of the file.
  if (idx !== -1 && idx >= buf.length - 256) {
    return idx
  }
  return buf.length
}

const sanitizeTrack = async (trackPath: string): Promise<string> => {
  try {
    const stats = await fs.promises.stat(trackPath)
    const cacheKey = buildCacheKey(stats)
    const cached = sanitizedTrackCache.get(trackPath)
    if (cached?.cacheKey === cacheKey && fs.existsSync(cached.tmpPath)) {
      return cached.tmpPath
    }

    const data = await fs.promises.readFile(trackPath)
    const stripFrom = Math.max(id3v2Size(data), firstMp3FrameOffset(data))
    const stripTo = Math.min(hasId3v1Tag(data) ? data.length - 128 : data.length, apeTailOffset(data))

    if (stripFrom === 0 && stripTo === data.length) {
      return trackPath
    }
    if (stripTo <= stripFrom || stripTo - stripFrom < 1024) {
      return trackPath
    }

    const tmpPath = path.join(os.tmpdir(), `stream-track-${crypto.randomBytes(6).toString('hex')}.mp3`)
    await fs.promises.writeFile(tmpPath, data.subarray(stripFrom, stripTo))
    sanitizedTrackCache.set(trackPath, { tmpPath, cacheKey })
    return tmpPath
  } catch (error) {
    console.warn('[stream] failed to sanitize track; using original', { trackPath, error })
    return trackPath
  }
}

const remuxTrack = async (trackPath: string): Promise<string> => {
  if (!REMUX_TRACKS) return trackPath

  try {
    const stats = await fs.promises.stat(trackPath)
    const cacheKey = buildCacheKey(stats)
    const cached = remuxTrackCache.get(trackPath)
    if (cached?.cacheKey === cacheKey && fs.existsSync(cached.tmpPath)) {
      return cached.tmpPath
    }

    const tmpPath = path.join(os.tmpdir(), `stream-track-remux-${crypto.randomBytes(6).toString('hex')}.wav`)
    const res = spawnSync(FFMPEG_BIN, [
      '-v',
      'error',
      '-y',
      '-i',
      trackPath,
      '-vn',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-c:a',
      'pcm_s16le',
      '-ar',
      `${AUDIO_SR}`,
      '-ac',
      '2',
      tmpPath,
    ])

    if (res.error || (typeof res.status === 'number' && res.status !== 0)) {
      console.warn('[stream] remux failed; using sanitized track', {
        trackPath,
        error: res.error,
        status: res.status,
        stderr: (res.stderr || '').toString(),
      })
      return trackPath
    }

    remuxTrackCache.set(trackPath, { tmpPath, cacheKey })
    return tmpPath
  } catch (error) {
    console.warn('[stream] remux threw; using sanitized track', { trackPath, error })
    return trackPath
  }
}

const prepareTrack = async (trackPath: string) => {
  const sanitizedPath = await sanitizeTrack(trackPath)
  const remuxedPath = await remuxTrack(sanitizedPath)
  return {
    path: remuxedPath,
    sanitized: sanitizedPath !== trackPath,
    remuxed: remuxedPath !== sanitizedPath,
  }
}

const hasFilter = (name: string): boolean => {
  if (filterCache.has(name)) return filterCache.get(name) as boolean

  try {
    const res = spawnSync(FFMPEG_BIN, ['-hide_banner', '-filters'])
    const output = `${res.stdout || ''}${res.stderr || ''}`.toString().toLowerCase()
    const found = output.includes(` ${name.toLowerCase()} `)
    filterCache.set(name, found)
    return found
  } catch {
    filterCache.set(name, false)
    return false
  }
}

const probeDuration = (file: string): number => {
  const res = spawnSync(FFPROBE_BIN, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ])

  const out = (res.stdout || '').toString().trim()
  const dur = parseFloat(out)
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Could not read duration for ${file}`)
  }
  return dur
}

const buildBackgroundGraph = (durations: number[]) => {
  const count = durations.length
  if (!count) throw new Error('No backgrounds to build filter graph')

  const parts: string[] = []

  for (let i = 0; i < count; i++) {
    const dur = durations[i]
    parts.push(
      `[${i}:v]format=rgb24,scale=1280:720:force_original_aspect_ratio=decrease:in_range=pc:out_range=tv,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},setsar=1,format=yuv420p,trim=duration=${dur.toFixed(
        3,
      )},setpts=PTS-STARTPTS[bg${i}]`,
    )
  }

  let vPrev = 'bg0'

  const totalDuration = durations.reduce((sum, d) => sum + d, 0)
  const totalFrames = Math.max(1, Math.ceil(totalDuration * FPS))

  if (count > 1) {
    parts.push(`${Array.from({ length: count }, (_, idx) => `[bg${idx}]`).join('')}concat=n=${count}:v=1:a=0[bgcat]`)
    vPrev = 'bgcat'
  }

  parts.push(`[${vPrev}]loop=loop=-1:size=${totalFrames}:start=0,setpts=N/(${FPS}*TB)[vloop]`)
  vPrev = 'vloop'

  return {
    filter: parts.join(';'),
    vLabel: vPrev,
    totalDuration,
  }
}

const buildAudioGraph = (inputOffset: number, durations: number[], xfade: number, opts: { useAcrossfade: boolean }) => {
  const count = durations.length
  if (!count) throw new Error('No tracks to build audio graph')

  const parts: string[] = []

  for (let i = 0; i < count; i++) {
    const dur = durations[i]
    const inputIdx = inputOffset + i
    parts.push(
      `[${inputIdx}:a]atrim=duration=${dur.toFixed(
        3,
      )},asetpts=PTS-STARTPTS,aresample=${AUDIO_SR}:async=1:first_pts=0,aformat=sample_rates=${AUDIO_SR}:channel_layouts=stereo[a${i}]`,
    )
  }

  let aPrev = 'a0'
  let offset = durations[0] - xfade

  if (count > 1) {
    if (opts.useAcrossfade) {
      for (let i = 1; i < count; i++) {
        const aOut = i === count - 1 ? 'amerge' : `axf${i}`
        parts.push(`[${aPrev}][a${i}]acrossfade=d=${xfade.toFixed(3)}:c1=tri:c2=tri[${aOut}]`)
        aPrev = aOut
        offset += durations[i] - xfade
      }
    } else {
      parts.push(
        `${Array.from({ length: count }, (_, idx) => `[a${idx}]`).join('')}concat=n=${count}:v=0:a=1[amerge]`,
      )
      aPrev = 'amerge'
    }
  }

  const audioTotal = durations.reduce((sum, d) => sum + d, 0) - (opts.useAcrossfade ? xfade * (count - 1) : 0)
  const loopSize = Math.max(1, Math.floor(audioTotal * AUDIO_SR))
  parts.push(`[${aPrev}]aloop=loop=-1:size=${loopSize}:start=0,asetpts=N/${AUDIO_SR}/TB[aloop]`)
  aPrev = 'aloop'

  return {
    filter: parts.join(';'),
    aLabel: aPrev,
    totalDuration: audioTotal,
  }
}

export const startStream = async (opts: { backgrounds: { path: string; duration: number }[]; tracks: string[]; streamUrl: string }) => {
  if (!opts.tracks.length) {
    return { ok: false, message: 'No tracks provided' }
  }
  if (!opts.backgrounds.length) {
    return { ok: false, message: 'No backgrounds provided' }
  }

  state.lastOpts = opts
  return runStream(opts, true, false)
}

const runStream = async (opts: StartOptions, preferXfade: boolean, attemptedFallback: boolean) => {
  const tracks = opts.tracks
  const backgrounds = opts.backgrounds

  let preparedTracks: { path: string; sanitized: boolean; remuxed: boolean }[]
  try {
    preparedTracks = await Promise.all(tracks.map((track) => prepareTrack(track)))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to prepare tracks'
    return { ok: false, message }
  }

  const inputTracks = preparedTracks.map((t) => t.path)
  const backgroundDurations = backgrounds.map((b) => Math.max(0.5, b.duration || 0))

  let durations: number[]
  try {
    durations = inputTracks.map((t) => probeDuration(t))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read durations'
    return { ok: false, message }
  }

  const minDur = Math.min(...durations)
  const xfade = Math.min(DEFAULT_XFADE, Math.max(0.2, minDur / 2))

  const useXfade = false
  const hasAcrossfadeFilter = FORCE_ACROSSFADE || hasFilter('acrossfade')
  const useAcrossfade = preferXfade ? hasAcrossfadeFilter : hasAcrossfadeFilter && !attemptedFallback

  let filterGraph: string
  let vLabel: string
  let aLabel: string
  let totalDuration: number
  try {
    const bgGraph = buildBackgroundGraph(backgroundDurations)
    const audioGraph = buildAudioGraph(backgrounds.length, durations, xfade, { useAcrossfade })
    filterGraph = [bgGraph.filter, audioGraph.filter].filter(Boolean).join(';')
    vLabel = bgGraph.vLabel
    aLabel = audioGraph.aLabel
    totalDuration = Math.max(bgGraph.totalDuration, audioGraph.totalDuration)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build filter graph'
    return { ok: false, message }
  }

  stopStream()

  const args: string[] = ['-re', '-hide_banner', '-loglevel', 'warning']

  args.push(
    '-fflags',
    '+discardcorrupt',
    '-ignore_unknown',
    '-err_detect',
    'ignore_err',
  )

  for (const bg of backgrounds) {
    const isImage = /\.(png|jpe?g|gif)$/i.test(bg.path)
    if (isImage) {
      args.push('-loop', '1', '-i', bg.path)
    } else {
      args.push('-stream_loop', '-1', '-i', bg.path)
    }
  }

  for (const track of inputTracks) {
    args.push('-i', track)
  }

  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    `[${vLabel}]`,
    '-map',
    `[${aLabel}]`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '2500k',
    '-maxrate',
    '2500k',
    '-bufsize',
    '5000k',
    '-flvflags',
    'no_duration_filesize',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    `${AUDIO_SR}`,
    '-ac',
    '2',
    '-threads',
    '1',
    '-f',
    'flv',
    opts.streamUrl,
  )

  const proc = spawn(FFMPEG_BIN, args, { stdio: 'inherit' })
  state.process = proc
  state.running = true

  proc.on('close', (code, signal) => {
    console.log('[stream] ffmpeg exited', { code, signal })
    const wasRunning = state.running
    state.running = false
    state.process = null
    if (code === 0) {
      state.consecutiveFailures = 0
      state.lastFailureAt = 0
    }

    if (!wasRunning) return

    if (signal || (typeof code === 'number' && code !== 0)) {
      const now = Date.now()
      if (now - state.lastFailureAt > FAILURE_RESET_MS) {
        state.consecutiveFailures = 0
      }
      state.consecutiveFailures += 1
      state.lastFailureAt = now

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[stream] ffmpeg failed repeatedly, giving up until next manual start')
        state.lastOpts = null
        return
      }

      if (useAcrossfade && !attemptedFallback) {
        console.warn('[stream] retrying without audio crossfade due to ffmpeg failure')
        setTimeout(() => runStream(opts, false, true), 300)
      } else {
        console.warn('[stream] restart after failure (xfade/crossfade off)')
        setTimeout(() => runStream(opts, false, true), 500)
      }
    } else {
      // completed playlist, restart to loop
      setTimeout(() => runStream(opts, preferXfade, attemptedFallback), 200)
    }
  })

  proc.on('error', (err) => {
    console.error('[stream] ffmpeg error', err)
    stopStream()
  })

  console.log(
    '[stream] started ffmpeg',
    JSON.stringify({
      ffmpegPath: FFMPEG_BIN,
      tracks: tracks.length,
      backgrounds: backgrounds.length,
      xfade,
      useAcrossfade,
      duration: totalDuration.toFixed(2),
      sanitizedTracks: preparedTracks.some((t) => t.sanitized),
      remuxedTracks: preparedTracks.some((t) => t.remuxed),
    }),
  )

  return {
    ok: true,
    message: 'Stream started (looping backgrounds, audio playlist running)',
  }
}

export const stopStream = () => {
  const wasRunning = state.running
  state.running = false
  state.consecutiveFailures = 0
  state.lastFailureAt = 0

  if (state.process) {
    try {
      state.process.kill()
    } catch (err) {
      console.error('[stream] failed to kill ffmpeg', err)
    }
  }

  state.process = null
  if (wasRunning) {
    state.lastOpts = null
  }
}

export const isStreaming = () => state.running
