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
}

const COUNT_KEY = 'count'

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
