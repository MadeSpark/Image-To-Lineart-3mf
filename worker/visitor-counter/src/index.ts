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
  // 只在请求 origin 命中白名单时回显它自己。
  // 早前未命中时会回显 list[0]（写死的 localhost:5173），浏览器于是报
  // "The 'Access-Control-Allow-Origin' header has a value '...' that is not equal to the
  // supplied origin"——把这个接口在任意非白名单来源（宝塔域名、file:// 双击）上都变成必然失败，
  // 而且报错信息把人往错误方向引。非白名单来源本来就会被下面 403 拦掉，
  // 与其回显一个错误的 origin，不如干脆不设这个头。
  const allowOrigin = requestOrigin && list.includes(requestOrigin) ? requestOrigin : null
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
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

    return jsonResponse({ error: 'not found' }, headers, 404)
  },
}
