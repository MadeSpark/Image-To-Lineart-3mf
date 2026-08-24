/**
 * 线稿底板生成器 - 全站访客计数器
 *
 * 路由：
 *   GET /visit   计数 +1 并返回最新计数（前端首次访问时调用）
 *   GET /count   仅返回当前计数（不 +1，可用于展示）
 *   GET /health  健康检查
 *
 * 计数存储在 KV namespace `VISITOR_COUNT` 的 `count` 键中。
 *
 * 部署完成后，把 Worker URL（如 https://visitor-counter.<你的子域>.workers.dev）
 * 填入 webapp/.env 的 VITE_VISITOR_COUNTER_URL 即可。
 */

interface Env {
  VISITOR_COUNT: KVNamespace
  ALLOWED_ORIGINS: string
  VISITOR_COUNTER: DurableObjectNamespace
}

const COUNT_KEY = 'count'
const VISIT_COOLDOWN_SECONDS = 15 * 60

function isAllowedOrigin(allowedOrigins: string, origin: string | null) {
  return Boolean(origin) && allowedOrigins.split(',').map((entry) => entry.trim()).includes(origin!)
}

async function hashClientIp(request: Request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const bytes = new TextEncoder().encode(ip)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class VisitorCounter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const count = (await this.state.storage.get<number>(COUNT_KEY)) ?? 0
    if (url.pathname === '/count') {
      return Response.json({ count })
    }
    if (url.pathname !== '/visit') return Response.json({ error: 'not found' }, { status: 404 })

    const clientKey = request.headers.get('X-Visitor-Key')
    if (!clientKey) return Response.json({ error: 'missing visitor key' }, { status: 400 })
    const visitKey = `visit:${clientKey}`
    if (await this.state.storage.get(visitKey)) {
      return Response.json({ count })
    }
    const next = count + 1
    await this.state.storage.put({ [COUNT_KEY]: next, [visitKey]: Date.now() })
    await this.state.storage.setAlarm(Date.now() + VISIT_COOLDOWN_SECONDS * 1000)
    return Response.json({ count: next })
  }

  async alarm(): Promise<void> {
    const entries = await this.state.storage.list<number>({ prefix: 'visit:' })
    const expiry = Date.now() - VISIT_COOLDOWN_SECONDS * 1000
    const expired = Array.from(entries.entries())
      .filter(([, recordedAt]) => recordedAt < expiry)
      .map(([key]) => key)
    if (expired.length) await this.state.storage.delete(expired)
    if ((await this.state.storage.list({ prefix: 'visit:', limit: 1 })).size) {
      await this.state.storage.setAlarm(Date.now() + VISIT_COOLDOWN_SECONDS * 1000)
    }
  }
}

function buildCorsHeaders(allowedOrigins: string, requestOrigin: string | null): HeadersInit {
  const list = allowedOrigins
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const allow = requestOrigin && list.includes(requestOrigin) ? requestOrigin : list[0] ?? ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  }
}

function jsonResponse(body: unknown, headers: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

async function readCurrentCount(env: Env): Promise<number> {
  const raw = await env.VISITOR_COUNT.get(COUNT_KEY)
  if (!raw) return 0
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const headers = buildCorsHeaders(env.ALLOWED_ORIGINS ?? '', origin)

    if (!isAllowedOrigin(env.ALLOWED_ORIGINS ?? '', origin)) {
      return jsonResponse({ error: 'origin not allowed' }, headers, 403)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, headers, 405)
    }

    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'visitor-counter' }, headers)
    }

    if (url.pathname === '/visit' || url.pathname === '/count' || url.pathname === '/') {
      const id = env.VISITOR_COUNTER.idFromName('global')
      const response = await env.VISITOR_COUNTER.get(id).fetch(new Request(
        new URL(url.pathname === '/' ? '/visit' : url.pathname, request.url),
        { headers: { 'X-Visitor-Key': await hashClientIp(request) } },
      ))
      return new Response(response.body, { status: response.status, headers })
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'visitor-counter' }, headers)
    }

    if (url.pathname === '/count') {
      const count = await readCurrentCount(env)
      return jsonResponse({ count }, headers)
    }

    if (url.pathname === '/visit' || url.pathname === '/') {
      // KV 是最终一致性存储，并发场景下用简单原子写入已足够（计数器容忍少量误差）。
      const current = await readCurrentCount(env)
      const next = current + 1
      await env.VISITOR_COUNT.put(COUNT_KEY, String(next))
      return jsonResponse({ count: next }, headers)
    }

    return jsonResponse({ error: 'not found' }, headers, 404)
  },
}
