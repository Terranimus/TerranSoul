# TerranSoul LongMemEval-S Retrieval Report

Date: 2026-08-30T14:23:18.772Z
Dataset: D:\Git\TerranSoulApp\target-copilot-bench\longmemeval\longmemeval_s_cleaned.json
Questions: 120 (0 abstention rows excluded)
Methodology: retrieval-only recall_any@K, matching agentmemory benchmark/longmemeval-bench.ts
Env: LONGMEM_EMBED=1 LONGMEM_KG_EDGES=1 OLLAMA_EMBED_NUM_GPU=99 | effective embed model: mxbai-embed-large (harness default)

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR@20 | MRR@20 | Avg latency | Avg retrieved tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rrf | 99.2% | 100.0% | 100.0% | 88.4% | 90.0% | 90.0% | 915.30ms | 59,359 |
| rrf_kg | 99.2% | 100.0% | 100.0% | 88.4% | 90.0% | 90.0% | 923.58ms | 62,535 |

## By Question Type

### rrf

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 70 | 98.6% | 100.0% | 92.5% | 90.0% | 90.0% |
| multi-session | 50 | 100.0% | 100.0% | 82.6% | 90.0% | 90.0% |

### rrf_kg

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 70 | 98.6% | 100.0% | 92.5% | 90.0% | 90.0% |
| multi-session | 50 | 100.0% | 100.0% | 82.6% | 90.0% | 90.0% |

## Methodology Notes

- This is not official LongMemEval QA accuracy. It is retrieval-only recall on the LongMemEval-S haystack.
- Each question builds a fresh in-memory TerranSoul `MemoryStore` from that question's haystack sessions, searches with the raw question text, and checks whether any gold answer session appears in the retrieved top-K.
- The optional Ollama judge is a local diagnostic for evidence support and is not comparable to agentmemory's published retrieval-only number.
