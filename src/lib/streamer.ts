import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

type StreamState = {
  backgroundPath: string
  currentIndex: number
  process: ChildProcessWithoutNullStreams | null
  running: boolean
  streamUrl: string
  tracks: string[]
}

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'

const state: StreamState = {
  backgroundPath: '',
  currentIndex: 0,
  process: null,
  running: false,
  streamUrl: '',
  tracks: [],
}

const buildArgs = (track: string) => [
  '-re',
  '-hide_banner',
  '-loglevel',
  'info',
  '-stats',
  '-loop',
  '1',
  '-framerate',
  '30',
  '-i',
  state.backgroundPath,
  '-i',
  track,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0',
  '-shortest',
  '-vf',
  'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
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
  '44100',
  '-ac',
  '2',
  '-f',
  'flv',
  state.streamUrl,
]

const startNext = () => {
  const track = state.tracks[state.currentIndex]
  const args = buildArgs(track)

  const proc = spawn(FFMPEG_BIN, args, { stdio: 'inherit' })
  state.process = proc

  proc.on('close', () => {
    if (!state.running) return
    state.process = null
    state.currentIndex = (state.currentIndex + 1) % state.tracks.length
    setTimeout(startNext, 1000)
  })

  proc.on('error', (err) => {
    console.error('[stream] ffmpeg error', err)
    stopStream()
  })
}

export const startStream = (opts: { backgroundPath: string; tracks: string[]; streamUrl: string }) => {
  if (!opts.tracks.length) {
    return { ok: false, message: 'No tracks provided' }
  }

  stopStream()

  state.backgroundPath = opts.backgroundPath
  state.streamUrl = opts.streamUrl
  state.tracks = opts.tracks
  state.currentIndex = 0
  state.running = true

  console.log('[stream] starting stream to', opts.streamUrl, 'with', opts.tracks.length, 'tracks')
  startNext()

  return { ok: true, message: 'Stream started' }
}

export const stopStream = () => {
  state.running = false
  state.currentIndex = 0

  if (state.process) {
    try {
      state.process.kill()
    } catch (err) {
      console.error('[stream] failed to kill ffmpeg', err)
    }
  }

  state.process = null
  state.tracks = []
}

export const isStreaming = () => state.running
