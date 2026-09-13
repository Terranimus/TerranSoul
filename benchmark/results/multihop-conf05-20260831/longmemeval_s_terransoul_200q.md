# TerranSoul LongMemEval-S Retrieval Report

Date: 2026-08-31T13:20:51.161Z
Dataset: D:\Git\TerranSoulApp\target-copilot-bench\longmemeval\longmemeval_s_cleaned.json
Questions: 200 (0 abstention rows excluded)
Methodology: retrieval-only recall_any@K, matching agentmemory benchmark/longmemeval-bench.ts
Env: LONGMEM_EMBED=1 LONGMEM_EMBED_MODEL=embeddinggemma:latest LONGMEM_IPC_CMD=["target-copilot-bench/release/longmemeval-ipc.exe"] LONGMEM_KG_EDGES=1 OLLAMA_EMBED_NUM_GPU=99 | effective embed model: embeddinggemma:latest

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR@20 | MRR@20 | Avg latency | Avg retrieved tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rrf | 98.5% | 99.5% | 100.0% | 93.9% | 94.3% | 94.3% | 337.09ms | 62,853 |
| rrf_multihop | 91.5% | 98.0% | 100.0% | 72.3% | 65.0% | 65.0% | 438.61ms | 59,932 |

## By Question Type

### rrf

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 70 | 97.1% | 98.6% | 94.4% | 93.2% | 93.2% |
| multi-session | 100 | 100.0% | 100.0% | 94.4% | 96.8% | 96.8% |
| single-session-preference | 30 | 96.7% | 100.0% | 91.2% | 88.3% | 88.3% |

### rrf_multihop

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 70 | 95.7% | 98.6% | 76.2% | 68.7% | 68.7% |
| multi-session | 100 | 94.0% | 100.0% | 75.5% | 69.5% | 69.5% |
| single-session-preference | 30 | 73.3% | 90.0% | 52.6% | 41.4% | 41.4% |

## Methodology Notes

- This is not official LongMemEval QA accuracy. It is retrieval-only recall on the LongMemEval-S haystack.
- Each question builds a fresh in-memory TerranSoul `MemoryStore` from that question's haystack sessions, searches with the raw question text, and checks whether any gold answer session appears in the retrieved top-K.
- The optional Ollama judge is a local diagnostic for evidence support and is not comparable to agentmemory's published retrieval-only number.
