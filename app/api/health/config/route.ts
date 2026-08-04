import { metricConfig } from '@/lib/server/healthMetrics'

/**
 * The iOS app's instruction sheet: which HealthKit types to read, in which
 * unit, and how to fold a day's samples into one number.
 *
 * The app ships knowing none of this. It asks on launch, caches the answer,
 * and collects whatever comes back. So adding a metric is a line in
 * lib/server/healthMetrics.ts and a deploy — never a new build, a new
 * signature and a re-install on the phone.
 *
 * Same bearer as the push (HEALTH_TOKEN), and excluded from the password gate
 * for the same reason: a phone app cannot hold a browser session cookie.
 * Reading this list tells an attacker which metrics exist, which is not a
 * secret worth protecting separately.
 */

export async function GET(req: Request): Promise<Response> {
  const token = process.env.HEALTH_TOKEN
  if (!token) return Response.json({ error: 'health_sync_disabled' }, { status: 503 })

  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (given !== token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  return Response.json({
    // Bump when the SHAPE of this response changes, so a future app version can
    // tell "new metrics" from "new contract" without guessing.
    version: 1,
    metrics: metricConfig(),
  })
}
