# Underwriter Reference Dataset

This dataset is intentionally **sample MVP data**. Every company, payment score, credit band, default rate, DSO value, and liquidity index is fabricated for local demos and prompt testing.

It is not real-time data, a credit report, a financial statement, a verified company registry, or investment advice. The underwriter must never present these records as verified facts about a debtor.

`underwriter-reference.json` contains:

- `companies`: synthetic debtor profiles with sample payment indicators.
- `industries`: synthetic industry benchmarks for default risk, average DSO, and liquidity.
- `datasetStatus`, `isRealTime`, `dataStatus`, `description`, and `notes`: explicit safeguards so prompts can distinguish sample context from supplied debt evidence.

The application may use this file as contextual evidence in the MVP. Missing or unmatched records must be treated as unknown, never as positive evidence.
