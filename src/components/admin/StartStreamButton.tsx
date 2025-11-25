'use client'

import React, { useCallback, useState } from 'react'

type Status = 'idle' | 'starting' | 'running' | 'error'

const StartStreamButton: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')

  const handleStart = useCallback(async () => {
    setStatus('starting')
    setMessage('')

    try {
      const res = await fetch('/api/start-stream', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { message?: string }

      if (!res.ok) {
        throw new Error(data?.message || 'Не вдалося запустити трансляцію')
      }

      setStatus('running')
      setMessage(data?.message || 'Стрім запущено')
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'Не вдалося запустити трансляцію')
    }
  }, [])

  const label =
    status === 'starting'
      ? 'Запускаю…'
      : status === 'running'
        ? 'Стрім запущено'
        : 'Почати трансляцію'

  return (
    <button
      aria-live="polite"
      aria-label="Почати трансляцію"
      className="start-stream-fab"
      disabled={status === 'starting'}
      onClick={handleStart}
      type="button"
    >
      <span className="start-stream-fab__glow" aria-hidden="true" />
      <span className="start-stream-fab__inner">
        <span className="start-stream-fab__icon" aria-hidden="true">
          <svg height="12" viewBox="0 0 12 12" width="12" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 1.5 10 6 3 10.5z" fill="currentColor" />
          </svg>
        </span>
        <span className="start-stream-fab__text">{label}</span>
      </span>
      {message && <span className="start-stream-fab__meta">{message}</span>}
    </button>
  )
}

export default StartStreamButton
