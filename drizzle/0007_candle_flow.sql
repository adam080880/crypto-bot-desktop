-- Taker buy volume (base asset) + trade count per candle, for pump/accumulation research. Nullable:
-- rows stored before this migration stay NULL until `pnpm data:backfill --flow` refills them.
-- ADD COLUMN without a default only rewrites the schema (no table rewrite), so it is instant on a big DB.
ALTER TABLE `candles_1m` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_1m` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_5m` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_5m` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_15m` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_15m` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_1h` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_1h` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_4h` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_4h` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_1d` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_1d` ADD COLUMN `trades` integer;
--> statement-breakpoint
ALTER TABLE `candles_1w` ADD COLUMN `buy_volume` real;
--> statement-breakpoint
ALTER TABLE `candles_1w` ADD COLUMN `trades` integer;
