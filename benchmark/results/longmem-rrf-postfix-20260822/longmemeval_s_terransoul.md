# TerranSoul LongMemEval-S Retrieval Report

Date: 2026-08-22T11:51:23.960Z
Dataset: D:\Git\TerranSoulApp\target-copilot-bench\longmemeval\longmemeval_s_cleaned.json
Questions: 500 (0 abstention rows excluded)
Methodology: retrieval-only recall_any@K, matching agentmemory benchmark/longmemeval-bench.ts
Env: LONGMEM_EMBED=1 LONGMEM_EMBED_MODEL=embeddinggemma:latest LONGMEM_IPC_CMD=["D:/Git/TerranSoulApp/target-copilot-bench/release/longmemeval-ipc.exe"] OLLAMA_EMBED_NUM_GPU=99 | effective embed model: embeddinggemma:latest

| System | R@5 | R@10 | R@20 | NDCG@10 | MRR@20 | MRR@20 | Avg latency | Avg retrieved tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rrf | 99.4% | 99.8% | 100.0% | 94.8% | 95.6% | 95.6% | 217.19ms | 62,784 |

## By Question Type

### rrf

| Type | Count | R@5 | R@10 | NDCG@10 | MRR@20 | MRR@20 |
|---|---:|---:|---:|---:|---:|---:|
| single-session-user | 70 | 97.1% | 98.6% | 94.4% | 93.2% | 93.2% |
| multi-session | 133 | 100.0% | 100.0% | 94.9% | 97.2% | 97.2% |
| single-session-preference | 30 | 96.7% | 100.0% | 90.0% | 86.6% | 86.6% |
| temporal-reasoning | 133 | 100.0% | 100.0% | 92.7% | 94.5% | 94.5% |
| knowledge-update | 78 | 100.0% | 100.0% | 98.7% | 99.4% | 99.4% |
| single-session-assistant | 56 | 100.0% | 100.0% | 97.4% | 96.4% | 96.4% |

## Methodology Notes

- This is not official LongMemEval QA accuracy. It is retrieval-only recall on the LongMemEval-S haystack.
- Each question builds a fresh in-memory TerranSoul `MemoryStore` from that question's haystack sessions, searches with the raw question text, and checks whether any gold answer session appears in the retrieved top-K.
- The optional Ollama judge is a local diagnostic for evidence support and is not comparable to agentmemory's published retrieval-only number.
