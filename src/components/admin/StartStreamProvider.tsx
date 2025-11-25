'use client'

import React from 'react'

import StartStreamButton from './StartStreamButton'

const StartStreamProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <>
      {children}
      <StartStreamButton />
    </>
  )
}

export default StartStreamProvider
