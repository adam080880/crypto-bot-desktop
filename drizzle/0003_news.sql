CREATE TABLE `economic_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`currency` text NOT NULL,
	`impact` text NOT NULL,
	`time` integer NOT NULL,
	`forecast_raw` text,
	`previous_raw` text,
	`actual_raw` text,
	`forecast` real,
	`previous` real,
	`actual` real,
	`actual_source` text,
	`actual_at` integer,
	`rule_key` text,
	`usd_bias` text,
	`crypto_bias` text,
	`bias_reason` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economic_events_time_idx` ON `economic_events` (`time`);--> statement-breakpoint
CREATE TABLE `event_reactions` (
	`event_id` text NOT NULL,
	`symbol` text NOT NULL,
	`horizon_min` integer NOT NULL,
	`price_before` real NOT NULL,
	`price_after` real NOT NULL,
	`change_pct` real NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`event_id`, `symbol`, `horizon_min`)
);
--> statement-breakpoint
CREATE TABLE `news_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`symbol` text NOT NULL,
	`created_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `news_candidates_created_idx` ON `news_candidates` (`created_at`);