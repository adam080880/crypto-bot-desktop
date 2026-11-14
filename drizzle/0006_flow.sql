-- Futures positioning (docs/entry-v2.md §10). Like the candle tables: WITHOUT ROWID, manual SQL
-- (not in schema.ts). Short retention: OI 3 days, funding 35 days (pruned by FlowSync).
CREATE TABLE `flow_oi` (
  `symbol_id` integer NOT NULL,
  `t` integer NOT NULL,
  `value` real NOT NULL,
  PRIMARY KEY (`symbol_id`, `t`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `flow_funding` (
  `symbol_id` integer NOT NULL,
  `t` integer NOT NULL,
  `rate` real NOT NULL,
  PRIMARY KEY (`symbol_id`, `t`)
) WITHOUT ROWID;
