import { spawn, spawnSync, type ChildProcess } from 'child_process'

type StreamState = {
  process: ChildProcess | null
  running: boolean
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'

const FPS = Number(process.env.STREAM_FPS || 30)
const AUDIO_SR = 44100
const DEFAULT_XFADE = Number(process.env.STREAM_XFADE_SEC || 2)

const state: StreamState = {
  process: null,
  running: false,
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

const buildFilterGraph = (durations: number[], xfade: number) => {
  const count = durations.length
  if (!count) throw new Error('No durations to build filter graph')

  const videoParts: string[] = []
  const audioParts: string[] = []

  // Inputs are ordered: backgrounds per track first, then audio tracks.
  // background index = i, audio index = count + i
  for (let i = 0; i < count; i++) {
    const dur = durations[i]
    videoParts.push(
      `[${i}:v]format=rgba,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration=${dur.toFixed(
        3,
      )},setpts=PTS-STARTPTS[v${i}]`,
    )
    audioParts.push(
      `[${count + i}:a]atrim=duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
    )
  }

  let videoChain = ''
  let audioChain = ''

  let vPrev = 'v0'
  let aPrev = 'a0'
  let offset = durations[0] - xfade

  for (let i = 1; i < count; i++) {
    const vOut = i === count - 1 ? 'vmerged' : `vxf${i}`
    videoChain += `[${vPrev}][v${i}]xfade=transition=fade:duration=${xfade.toFixed(
      3,
    )}:offset=${offset.toFixed(3)},format=yuv420p[${vOut}];`
    vPrev = vOut

    const aOut = i === count - 1 ? 'amerge' : `axf${i}`
    audioChain += `[${aPrev}][a${i}]acrossfade=d=${xfade.toFixed(
      3,
    )}:c1=tri:c2=tri[${aOut}];`
    aPrev = aOut

    offset += durations[i] - xfade
  }

  const totalDuration = durations.reduce((sum, d) => sum + d, 0) - xfade * (count - 1)
  const totalFrames = Math.max(1, Math.ceil(totalDuration * FPS))
  const totalSamples = Math.max(1, Math.ceil(totalDuration * AUDIO_SR))

  const loopVideo = `[${vPrev}]format=yuv420p,loop=loop=-1:size=${totalFrames}:start=0,setpts=N/FRAME_RATE/TB[vout]`
  const loopAudio = `[${aPrev}]aloop=loop=-1:size=${totalSamples}:start=0,asetpts=N/${AUDIO_SR}/TB[aout]`

  const parts = [...videoParts, ...audioParts, videoChain, audioChain, loopVideo, loopAudio].filter(Boolean)

  return {
    filter: parts.join(';'),
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

  let filterGraph: string
  let totalDuration: number
  try {
    const built = buildFilterGraph(durations, xfade)
    filterGraph = built.filter
    totalDuration = built.totalDuration
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build filter graph'
    return { ok: false, message }
  }

  stopStream()

  const args: string[] = ['-re', '-hide_banner', '-loglevel', 'warning']

  // Background inputs (per track for easy pairing)
  for (const bg of backgroundsForTracks) {
    args.push('-loop', '1', '-i', bg)
  }

  // Audio inputs
  for (const track of tracks) {
    args.push('-i', track)
  }

  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
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
    state.running = false
    state.process = null
  })

  proc.on('error', (err) => {
    console.error('[stream] ffmpeg error', err)
    stopStream()
  })

  console.log(
    '[stream] started ffmpeg',
    JSON.stringify({
      tracks: tracks.length,
      backgrounds: backgroundsForTracks.length,
      xfade,
      duration: totalDuration.toFixed(2),
    }),
  )

  return { ok: true, message: 'Stream started (looping with crossfade)' }
}

export const stopStream = () => {
  state.running = false

  if (state.process) {
    try {
      state.process.kill()
    } catch (err) {
      console.error('[stream] failed to kill ffmpeg', err)
    }
  }

  state.process = null
}

export const isStreaming = () => state.running
