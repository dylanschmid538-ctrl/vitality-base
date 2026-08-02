import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, validSession } from '@/lib/server/session'

/**
 * The password gate. This file is the whole access-control story for the app,
 * so the matcher at the bottom is the security boundary — read it before
 * trusting any route to be protected.
 *
 * Unprotected on purpose:
 *   /login, /api/auth/*   — the gate itself; protecting it would lock everyone out.
 *   /api/mcp/*            — the Claude connector, which has its own bearer /
 *                           OAuth check. Password-gating it would break /sweep.
 *   /tiles/*              — sealed tile HTML. Public source code, no user data;
 *                           the DATA behind it lives in /api/store and is gated.
 *   static assets, icons  — no data, and gating them breaks the PWA manifest.
 *
 * When SITE_PASSWORD is unset the gate stays OFF, so a fresh clone still boots
 * to a working local board. That is safe on localhost and dangerous in
 * production — hence the loud check in /api/store guarded by requireGate below.
 */

export async function middleware(req: NextRequest) {
  const password = process.env.SITE_PASSWORD
  if (!password) return NextResponse.next() // unconfigured → local-only mode, no gate

  const ok = await validSession(req.cookies.get(SESSION_COOKIE)?.value, password)
  if (ok) return NextResponse.next()

  // API callers get a machine answer; humans get sent to the login page.
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const login = new URL('/login', req.url)
  login.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: [
    /*
     * Everything except the exclusions above. Negative lookahead rather than an
     * allowlist, so a NEW route is protected by default — forgetting to add a
     * route here fails closed, not open.
     */
    '/((?!login|api/auth|api/mcp|tiles/|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest).*)',
  ],
}
