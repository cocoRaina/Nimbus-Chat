import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// INSERT-trigger embedding generator. A pg_net DB trigger POSTs the new row
// here; we embed its `content` via SiliconFlow and write the vector back with
// the service-role key. anon/authenticated EXECUTE is REVOKE'd on the trigger
// side. verify_jwt stays false because the trigger calls it without a user JWT.
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

Deno.serve(async (req: Request) => {
  try {
    if (!SILICONFLOW_API_KEY) {
      return new Response(JSON.stringify({ error: 'SILICONFLOW_API_KEY not configured' }), { status: 500 })
    }
    const payload = await req.json()
    const record = payload.record
    const table = typeof payload.table === 'string' ? payload.table : 'memories'

    if (!ALLOWED_TABLES.has(table)) {
      return new Response(JSON.stringify({ skip: `unknown table: ${table}` }), { status: 200 })
    }
    if (!record?.id || !record?.content) {
      return new Response(JSON.stringify({ skip: 'no id/content' }), { status: 200 })
    }
    if (record.embedding) {
      return new Response(JSON.stringify({ skip: 'embedding already set' }), { status: 200 })
    }

    const r = await fetch(SF_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SILICONFLOW_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: record.content }),
    })
    if (!r.ok) {
      const text = await r.text()
      return new Response(JSON.stringify({ error: `SiliconFlow ${r.status}: ${text}` }), { status: 500 })
    }
    const data = await r.json()
    const embedding = data?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      return new Response(JSON.stringify({ error: 'unexpected embedding response' }), { status: 502 })
    }

    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { error } = await supa
      .from(table)
      .update({ embedding })
      .eq('id', record.id)
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
