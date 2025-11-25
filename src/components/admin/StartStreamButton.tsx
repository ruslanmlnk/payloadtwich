'use client'

import React, { useCallback, useState } from 'react'

type Status = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

const StartStreamButton: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')

  const handleToggle = useCallback(async () => {
    if (status === 'starting' || status === 'stopping') return

    setMessage('')

    if (status === 'running') {
      setStatus('stopping')
      try {
        const res = await fetch('/api/stop-stream', { method: 'POST' })
        const data = (await res.json().catch(() => ({}))) as { message?: string }
        if (!res.ok) {
          throw new Error(data?.message || 'Не вдалося зупинити трансляцію')
        }
        setStatus('idle')
        setMessage(data?.message || 'Стрім зупинено')
      } catch (error) {
        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Не вдалося зупинити трансляцію')
      }
      return
    }

    setStatus('starting')
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
  }, [status])

  const label =
    status === 'starting'
      ? 'Запускаю…'
      : status === 'running'
        ? 'Зупинити трансляцію'
        : status === 'stopping'
          ? 'Зупиняю…'
          : 'Почати трансляцію'

  return (
    <button
      aria-live="polite"
      aria-label="Почати трансляцію"
      className="start-stream-fab"
      disabled={status === 'starting' || status === 'stopping'}
      onClick={handleToggle}
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
