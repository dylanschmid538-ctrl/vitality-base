'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The gate's only screen: an iOS-style passcode field.
 *
 * Six dots that fill as you type, and it submits itself on the sixth digit —
 * no button to reach for one-handed. Under the dots sits one real <input>,
 * visually hidden but focused: that keeps the OS keyboard, password managers
 * and screen readers working, which a grid of custom key <button>s would break.
 *
 * Deliberately says nothing about what it guards, and a wrong PIN gets the same
 * flat answer every time — except a lockout, which has to be explained or the
 * owner would just think the board is broken.
 */

const LEN = 6

export default function Login() {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockLeft, setLockLeft] = useState(0)
  const [shake, setShake] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const locked = lockLeft > 0

  // Count the lockout down live, so the wait is visible instead of a dead field.
  useEffect(() => {
    if (lockLeft <= 0) return
    const t = setInterval(() => setLockLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [lockLeft])

  async function submit(code: string) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: code }),
      })
      if (res.ok) {
        // Full navigation, not router.push: the browser has to attach the new
        // cookie to the next request for the middleware to see it.
        const next = new URLSearchParams(window.location.search).get('next')
        window.location.href = next && next.startsWith('/') ? next : '/'
        return
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number }
      if (body.error === 'locked') {
        setLockLeft(body.retryAfter ?? 60)
        setError('Zu viele Versuche')
      } else {
        setError('Falscher Code')
      }
    } catch {
      setError('Keine Verbindung')
    }
    setPin('')
    setShake(true)
    setTimeout(() => setShake(false), 420)
    setBusy(false)
    inputRef.current?.focus()
  }

  function onChange(value: string) {
    if (busy || locked) return
    const digits = value.replace(/\D/g, '').slice(0, LEN)
    setPin(digits)
    if (error) setError('')
    if (digits.length === LEN) void submit(digits)
  }

  const mins = Math.floor(lockLeft / 60)
  const secs = lockLeft % 60

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: '#08090a',
        color: '#e7e9ea',
        padding: 24,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <style>{`
        @keyframes vShake {
          0%,100% { transform: translateX(0) }
          20% { transform: translateX(-7px) }
          40% { transform: translateX(7px) }
          60% { transform: translateX(-4px) }
          80% { transform: translateX(4px) }
        }
        @media (prefers-reduced-motion: reduce) { .vDots { animation: none !important } }
      `}</style>

      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#6EE7B7', fontSize: 11, letterSpacing: '.22em', marginBottom: 28 }}>
          ✦ VITALITY
        </div>

        <div
          className="vDots"
          style={{
            display: 'flex',
            gap: 18,
            justifyContent: 'center',
            animation: shake ? 'vShake .42s' : undefined,
          }}
        >
          {Array.from({ length: LEN }, (_, i) => {
            const filled = i < pin.length
            return (
              <span
                key={i}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: '1.5px solid ' + (locked ? '#4a2323' : '#3a3f45'),
                  background: filled ? (locked ? '#ff6b6b' : '#6EE7B7') : 'transparent',
                  transition: 'background .12s ease',
                }}
              />
            )
          })}
        </div>

        {/* The real field. Off-screen rather than display:none — hidden inputs
            cannot hold focus, and without focus there is no keyboard. */}
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Code"
          autoFocus
          disabled={busy || locked}
          value={pin}
          onChange={(e) => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
        />

        <div
          role="alert"
          aria-live="polite"
          style={{ minHeight: 22, marginTop: 26, fontSize: 13, color: locked ? '#ff9b6b' : '#ff6b6b' }}
        >
          {locked
            ? `Gesperrt — noch ${mins ? `${mins} min ` : ''}${secs}s`
            : error}
        </div>
      </div>
    </main>
  )
}
