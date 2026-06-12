import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// INSERT-trigger embedding generator. A pg_net DB trigger POSTs the new row
// here; we embed its `content` via SiliconFlow and write the vector back with
// the service-role key. anon/authenticated EXECUTE is REVOKE'd on the trigger
// side. verify_jwt stays false because the trigger calls it without a user JWT.
//
// Also supports batch mode: pass { records: [{id, content}, ...], table }
// to embed multiple rows in a single SiliconFlow API call (used by bulk-confirm
// in MemoryVaultPage to avoid N serial round-trips).
const SF_URL = 'https://api.siliconflow.cn/v1/embeddings'
const MODEL = 'BAAI/bge-m3'
const SILICONFLOW_API_KEY = Deno.env.get('SILICONFLOW_API_KEY') ?? ''

const ALLOWED_TABLES = new Set([
  'memories',
  'diaries',
  'handoff_letters',
  'timeline',
  'user_posts',
  'user_replies',
])

type RecordLike = { id: unknown; content: string; embedding?: unknown }

async function embedTexts(inputs: string[]): Promise<number[][] | null> {
  const r = await fetch(SF_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SILICONFLOW_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  })
  if (!r.ok) return null
  const data = await r.json()
  if (!Array.isArray(data?.data)) return null
  // data.data is sorted by index; re-sort just in case
  const sorted = [...data.data].sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  return sorted.map((item: { embedding: number[] }) => item.embedding)
}

Deno.serve(async (req: Request) => {
  try {
    if (!SILICONFLOW_API_KEY) {
      return new Response(JSON.stringify({ error: 'SILICONFLOW_API_KEY not configured' }), { status: 500 })
    }
    const payload = await req.json()
    const table = typeof payload.table === 'string' ? payload.table : 'memories'

    if (!ALLOWED_TABLES.has(table)) {
      return new Response(JSON.stringify({ skip: `unknown table: ${table}` }), { status: 200 })
    }

    // ── Batch mode ────────────────────────────────────────────────────────────
    if (Array.isArray(payload.records)) {
      const pending: RecordLike[] = (payload.records as RecordLike[]).filter(
        (r) => r?.id != null && typeof r?.content === 'string' && r.content.trim() && !r?.embedding,
      )
      if (pending.length === 0) {
        return new Response(JSON.stringify({ skip: 'no records to embed' }), { status: 200 })
      }

      const embeddings = await embedTexts(pending.map((r) => r.content))
      if (!embeddings) {
        return new Response(JSON.stringify({ error: 'SiliconFlow batch request failed' }), { status: 500 })
      }

      const supa = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      let ok = 0
      await Promise.all(
        pending.map(async (record, i) => {
          const embedding = embeddings[i]
          if (!Array.isArray(embedding)) return
          const { error } = await supa.from(table).update({ embedding }).eq('id', record.id)
          if (!error) ok++
        }),
      )

      return new Response(JSON.stringify({ ok: true, batch: true, table, embedded: ok, total: pending.length }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── Single-record mode (DB trigger path) ──────────────────────────────────
    const record = payload.record
    if (!record?.id || !record?.content) {
      return new Response(JSON.stringify({ skip: 'no id/content' }), { status: 200 })
    }
    if (record.embedding) {
      return new Response(JSON.stringify({ skip: 'embedding already set' }), { status: 200 })
    }

    const embeddings = await embedTexts([record.content])
    if (!embeddings) {
      return new Response(JSON.stringify({ error: 'SiliconFlow request failed' }), { status: 500 })
    }
    const embedding = embeddings[0]
    if (!Array.isArray(embedding)) {
      return new Response(JSON.stringify({ error: 'unexpected embedding response' }), { status: 502 })
    }

    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { error } = await supa.from(table).update({ embedding }).eq('id', record.id)
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    return new Response(JSON.stringify({ ok: true, table, id: record.id, dim: embedding.length }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
