// Withhold rows that carry ONE explicit tag from a brain retrieval response,
// before the benchmark agent sees it. Pure, no side effects: the bench proxy
// (mcp-auth-proxy.mjs) calls it, and proxy-withhold-repo-rows.test.mjs pins it.
//
// ⛔ WHAT LEAKED. The bench store (mcp-data-tbench-clean/memory.db) holds 982
// of 2525 rows tagged `terransoul-repo`: TerranSoul's OWN development lessons
// (harness internals, competitor audits, purity sweeps) and its app settings.
// That tag was introduced precisely "so MCP agents can isolate project-coding
// context from generic meta-lessons" (completion-log). None of the 982 is
// agent-authored task work: zero carry category `self-improve-attempt` (1001
// rows do) and zero start "SYMPTOM:" (328 rows do). They were served into
// benchmark containers anyway, displacing on-topic lessons: in the
// ts0914*/ts0915* sweep 4 of 66 brain_search responses carried one (7 of 256
// served rows, 3 of 75 graded trials).
//
// ⛔ WHY HERE AND NOT AT STORE BUILD. 666 of the 982 are
// `system.default_system_setting` rows that the brain SERVER reads by SQL as
// its own configuration (gateway.rs, acp.rs, agentic_verify_rank.rs `avr.*`),
// including retrieval and verification knobs (avr, multihop, retrieval,
// hybrid, rerank, rag_gate, verify, query). Deleting the tag at store build
// would silently change the retrieval path of the brain being measured. At the
// proxy the server keeps its configuration, and the agent is never handed the
// rows.
//
// THE KEY IS THE EXPLICIT TAG, EXACTLY, AND NOTHING ELSE. A tag list entry
// equal to `terransoul-repo` after trimming. Not a near-miss tag, not the word
// in prose, no task names, no content heuristics (rules/bench-agi-purity.md).
//
// SCOPE, stated plainly. It applies to the tools that RANK rows for the agent:
// `brain_search` (and `brain_suggest_context`, which is not in the server's
// EXPOSED_TOOLS and had 0 calls in that sweep; its LLM-written `summary` string
// cannot be filtered by tag). `brain_get_entry` fetches a row by an id the agent
// already holds and `brain_kg_neighbors` walks edges; in the same sweep 0 of
// 9 get_entry reads and 0 of 90 authored ids were tagged, and kg_neighbors was
// called twice.

export const WITHHELD_TAG = 'terransoul-repo'

/** Tools whose responses are filtered. */
export const WITHHOLD_TOOLS = new Set(['brain_search', 'brain_suggest_context'])

/** Does a comma-separated tag string (or a tag array) carry `tag` exactly? */
export function carriesTag(tags, tag = WITHHELD_TAG) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []
  return list.some((t) => String(t).trim() === tag)
}

/** The `tools/call` name in a request body, or null. */
export function toolCallName(bodyBuf) {
  try {
    const req = JSON.parse(Buffer.isBuffer(bodyBuf) ? bodyBuf.toString('utf8') : String(bodyBuf))
    return req?.method === 'tools/call' && typeof req.params?.name === 'string' ? req.params.name : null
  } catch {
    return null
  }
}

function isTaggedRow(value, tag) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && carriesTag(value.tags, tag)
}

/** Drop tagged rows from arrays and null a tagged row held directly in a field. */
function prune(value, tag, withheld) {
  if (Array.isArray(value)) {
    const kept = []
    for (const el of value) {
      if (isTaggedRow(el, tag)) withheld.push(el.id ?? null)
      else kept.push(prune(el, tag, withheld))
    }
    return kept
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      if (isTaggedRow(v, tag)) {
        withheld.push(v.id ?? null)
        out[key] = null
      } else {
        out[key] = prune(v, tag, withheld)
      }
    }
    return out
  }
  return value
}

/** Prune every JSON text block of one JSON-RPC message in place; true if anything went. */
function pruneRpc(rpc, tag, withheld) {
  const blocks = rpc?.result?.content
  if (!Array.isArray(blocks)) return false
  let changed = false
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const t = block.text.trim()
    // Other text blocks (e.g. the router's advisory note) are not row payloads.
    if (!t.startsWith('[') && !t.startsWith('{')) continue
    let payload
    try {
      payload = JSON.parse(t)
    } catch {
      continue
    }
    const before = withheld.length
    const pruned = prune(payload, tag, withheld)
    if (withheld.length > before) {
      block.text = JSON.stringify(pruned)
      changed = true
    }
  }
  return changed
}

/**
 * Remove every row tagged `tag` from a tools/call response body, JSON or SSE.
 *
 * @param {string} text the upstream response body
 * @param {string} [tag]
 * @returns {{text: string, withheld: Array<number|null>}} the body to forward
 *   (the ORIGINAL string, untouched, when nothing was withheld) and the ids removed
 */
export function withholdTaggedRows(text, tag = WITHHELD_TAG) {
  const raw = String(text ?? '')
  const withheld = []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    let rpc
    try {
      rpc = JSON.parse(trimmed)
    } catch {
      return { text: raw, withheld: [] }
    }
    return pruneRpc(rpc, tag, withheld) ? { text: JSON.stringify(rpc), withheld } : { text: raw, withheld: [] }
  }
  // Streamable HTTP / SSE: filter each `data:` frame, keep every other line.
  let changed = false
  const lines = raw.split('\n').map((line) => {
    if (!line.startsWith('data:')) return line
    const cr = line.endsWith('\r') ? '\r' : ''
    let rpc
    try {
      rpc = JSON.parse(line.slice('data:'.length).trim())
    } catch {
      return line
    }
    if (!pruneRpc(rpc, tag, withheld)) return line
    changed = true
    return `data: ${JSON.stringify(rpc)}${cr}`
  })
  return changed ? { text: lines.join('\n'), withheld } : { text: raw, withheld: [] }
}
