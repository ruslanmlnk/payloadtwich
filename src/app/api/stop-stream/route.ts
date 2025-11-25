export const runtime = 'nodejs'

import { NextResponse } from 'next/server'

import { isStreaming, stopStream } from '@/lib/streamer'

export async function POST() {
  if (!isStreaming()) {
    return NextResponse.json({ message: 'Стрім не запущений' })
  }

  stopStream()
  return NextResponse.json({ message: 'Стрім зупинено' })
}
