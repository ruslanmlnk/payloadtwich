export const runtime = 'nodejs'

import fs from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import payloadConfig from '@/payload.config'
import type { Media, StreamDatum } from '@/payload-types'
import { isStreaming, startStream, stopStream } from '@/lib/streamer'

const MEDIA_DIR = path.join(process.cwd(), 'media')

const normalizeStreamUrl = (twitchKey: string) =>
  twitchKey.startsWith('rtmp://') ? twitchKey : `rtmp://live.twitch.tv/app/${twitchKey}`

const resolveMediaPath = (media: Media | number | null | undefined) => {
  if (!media || typeof media === 'number') return null

  const filename = media.filename || media.url?.split('/').pop()
  if (!filename) return null

  const localPath = path.join(MEDIA_DIR, filename)
  return fs.existsSync(localPath) ? localPath : null
}

export async function POST() {
  try {
    const payload = await getPayload({ config: payloadConfig })
    const streamData = (await payload.findGlobal({ slug: 'stream-data', depth: 2 })) as StreamDatum

    const backgrounds =
      (streamData.backgrounds as Array<{ image?: Media | number | null; duration?: number | string | null }> | undefined)
        ?.map((item) => {
          const path = item?.image && typeof item.image === 'object' ? resolveMediaPath(item.image as Media) : null
          const duration = Number(item?.duration) || 0
          if (!path || duration <= 0) return null
          return { path, duration }
        })
        .filter((val): val is { path: string; duration: number } => Boolean(val)) || []

    if (!backgrounds.length) {
      return NextResponse.json(
        { message: 'Background not found on disk or duration missing (backgrounds -> image + duration).' },
        { status: 400 },
      )
    }

    const tracks =
      streamData.mp3Files
        ?.map((item) => resolveMediaPath(item?.file as Media))
        .filter((trackPath): trackPath is string => Boolean(trackPath)) || []

    if (!tracks.length) {
      return NextResponse.json(
        { message: 'No mp3 files found in Stream Data or on disk.' },
        { status: 400 },
      )
    }

    const streamUrl = normalizeStreamUrl(streamData.twitchKey)

    if (isStreaming()) {
      stopStream()
    }

    const result = await startStream({
      backgrounds,
      streamUrl,
      tracks,
    })

    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: 400 })
    }

    return NextResponse.json({
      message: result.message,
      streamUrl,
      tracks: tracks.length,
      backgrounds: backgrounds.length,
    })
  } catch (error) {
    console.error('[stream] failed to start stream', error)
    return NextResponse.json({ message: 'Stream failed to start due to an error.' }, { status: 500 })
  }
}
