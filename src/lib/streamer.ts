import { spawn, spawnSync, type ChildProcess } from 'child_process'

type StreamState = {
  process: ChildProcess | null
  running: boolean
  lastOpts: StartOptions | null
}

type StartOptions = {
  backgroundPaths: string[]
  tracks: string[]
  streamUrl: string
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'
const FORCE_XFADE = process.env.FORCE_XFADE === 'true'
const FORCE_ACROSSFADE = process.env.FORCE_ACROSSFADE === 'true'

const FPS = Number(process.env.STREAM_FPS || 30)
const AUDIO_SR = 44100
const DEFAULT_XFADE = Number(process.env.STREAM_XFADE_SEC || 2)

const state: StreamState = {
  process: null,
  running: false,
  lastOpts: null,
}

const filterCache = new Map<string, boolean>()

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

const buildFilterGraph = (durations: number[], xfade: number, opts: { useXfade: boolean; useAcrossfade: boolean }) => {
  const count = durations.length
  if (!count) throw new Error('No durations to build filter graph')

  const videoParts: string[] = []
  const audioParts: string[] = []
  const videoOps: string[] = []
  const audioOps: string[] = []

  for (let i = 0; i < count; i++) {
    const dur = durations[i]
    videoParts.push(
      `[${i}:v]format=rgb24,scale=1280:720:force_original_aspect_ratio=decrease:in_range=pc:out_range=tv,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,trim=duration=${dur.toFixed(
        3,
      )},setpts=PTS-STARTPTS[v${i}]`,
    )
    audioParts.push(
      `[${count + i}:a]atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
    )
  }

  let vPrev = 'v0'
  let aPrev = 'a0'
  let offset = durations[0] - xfade

  if (count > 1) {
    if (opts.useXfade) {
      for (let i = 1; i < count; i++) {
        const vOut = i === count - 1 ? 'vmerged' : `vxf${i}`
        videoOps.push(
          `[${vPrev}][v${i}]xfade=transition=fade:duration=${xfade.toFixed(
            3,
          )}:offset=${offset.toFixed(3)},format=yuv420p[${vOut}]`,
        )
        vPrev = vOut
        offset += durations[i] - xfade
      }
    } else {
      videoOps.push(
        `${Array.from({ length: count }, (_, idx) => `[v${idx}]`).join('')}concat=n=${count}:v=1:a=0[vmerged]`,
      )
      vPrev = 'vmerged'
    }
  }

  if (count > 1) {
    if (opts.useAcrossfade) {
      offset = durations[0] - xfade
      for (let i = 1; i < count; i++) {
        const aOut = i === count - 1 ? 'amerge' : `axf${i}`
        audioOps.push(`[${aPrev}][a${i}]acrossfade=d=${xfade.toFixed(3)}:c1=tri:c2=tri[${aOut}]`)
        aPrev = aOut
        offset += durations[i] - xfade
      }
    } else {
      audioOps.push(
        `${Array.from({ length: count }, (_, idx) => `[a${idx}]`).join('')}concat=n=${count}:v=0:a=1[amerge]`,
      )
      aPrev = 'amerge'
    }
  }

  const sumDur = durations.reduce((sum, d) => sum + d, 0)
  const videoTotal = sumDur - (opts.useXfade ? xfade * (count - 1) : 0)
  const audioTotal = sumDur - (opts.useAcrossfade ? xfade * (count - 1) : 0)
  const totalDuration = Math.min(videoTotal, audioTotal)

  const parts = [...videoParts, ...audioOps, ...videoOps, ...audioParts].filter(Boolean)

  return {
    filter: parts.join(';'),
    vLabel: vPrev,
    aLabel: aPrev,
    totalDuration,
  }
}

export const startStream = async (opts: { backgroundPaths: string[]; tracks: string[]; streamUrl: string }) => {
  if (!opts.tracks.length) {
    return { ok: false, message: 'No tracks provided' }
  }
  if (!opts.backgroundPaths.length) {
    return { ok: false, message: 'No backgrounds provided' }
  }

  state.lastOpts = opts
  return runStream(opts, true, false)
}

const runStream = async (opts: StartOptions, preferXfade: boolean, attemptedFallback: boolean) => {
  const tracks = opts.tracks
  const backgroundsForTracks = tracks.map((_, idx) => opts.backgroundPaths[idx % opts.backgroundPaths.length])

  let durations: number[]
  try {
    durations = tracks.map((t) => probeDuration(t))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read durations'
    return { ok: false, message }
  }

  const minDur = Math.min(...durations)
  const xfade = Math.min(DEFAULT_XFADE, Math.max(0.2, minDur / 2))

  const hasXfadeFilter = FORCE_XFADE || hasFilter('xfade')
  const hasAcrossfadeFilter = FORCE_ACROSSFADE || hasFilter('acrossfade')
  const useXfade = preferXfade && hasXfadeFilter
  const useAcrossfade = hasAcrossfadeFilter

  let filterGraph: string
  let vLabel: string
  let aLabel: string
  let totalDuration: number
  try {
    const built = buildFilterGraph(durations, xfade, { useXfade, useAcrossfade })
    filterGraph = built.filter
    vLabel = built.vLabel
    aLabel = built.aLabel
    totalDuration = built.totalDuration
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build filter graph'
    return { ok: false, message }
  }

  stopStream()

  const args: string[] = ['-re', '-hide_banner', '-loglevel', 'warning']

  for (const bg of backgroundsForTracks) {
    args.push('-loop', '1', '-i', bg)
  }

  for (const track of tracks) {
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
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    `${AUDIO_SR}`,
    '-ac',
    '2',
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

    if (!wasRunning) return

    if (signal || (typeof code === 'number' && code !== 0)) {
      if (useXfade && !attemptedFallback) {
        console.warn('[stream] retrying without xfade due to ffmpeg failure')
        setTimeout(() => runStream(opts, false, true), 300)
      } else {
        console.warn('[stream] restart after failure (xfade off)')
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
      backgrounds: backgroundsForTracks.length,
      xfade,
      useXfade,
      useAcrossfade,
      duration: totalDuration.toFixed(2),
    }),
  )

  return {
    ok: true,
    message: useXfade ? 'Stream started (looping with crossfade)' : 'Stream started (video hard cuts, audio may crossfade)',
  }
}

export const stopStream = () => {
  const wasRunning = state.running
  state.running = false

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
