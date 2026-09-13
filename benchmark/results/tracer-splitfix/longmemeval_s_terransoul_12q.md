# TerranSoul LongMemEval-S Retrieval Report

Date: 2026-08-22T14:39:55.416Z
Dataset: D:\Git\TerranSoulApp\benchmark\results\tracer-slice-12.json
Questions: 12 (0 abstention rows excluded)
Methodology: retrieval-only recall_any@K, matching agentmemory benchmark/longmemeval-bench.ts
Env: LONGMEM_EMBED=1 LONGMEM_EMBED_MODEL=embeddinggemma:latest LONGMEM_IPC_CMD=["D:/Git/TerranSoulApp/target-copilot-bench/release/longmemeval-ipc.exe"] OLLAMA_EMBED_NUM_GPU=99 | effective embed model: embeddinggemma:latest

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR@20 | MRR@20 | Avg latency | Avg retrieved tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rrf | 100.0% | 100.0% | 100.0% | 78.9% | 75.0% | 75.0% | 216.53ms | 60,493 |

## By Question Type

### rrf

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 3 | 100.0% | 100.0% | 87.7% | 83.3% | 83.3% |
| single-session-preference | 2 | 100.0% | 100.0% | 81.5% | 75.0% | 75.0% |
| multi-session | 1 | 100.0% | 100.0% | 69.3% | 50.0% | 50.0% |
| temporal-reasoning | 3 | 100.0% | 100.0% | 65.2% | 66.7% | 66.7% |
| knowledge-update | 1 | 100.0% | 100.0% | 92.0% | 100.0% | 100.0% |
| single-session-assistant | 2 | 100.0% | 100.0% | 81.5% | 75.0% | 75.0% |

## Methodology Notes

- This is not official LongMemEval QA accuracy. It is retrieval-only recall on the LongMemEval-S haystack.
- Each question builds a fresh in-memory TerranSoul `MemoryStore` from that question's haystack sessions, searches with the raw question text, and checks whether any gold answer session appears in the retrieved top-K.
- The optional Ollama judge is a local diagnostic for evidence support and is not comparable to agentmemory's published retrieval-only number.
