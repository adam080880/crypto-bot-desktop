CREATE TABLE `symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`base_asset` text NOT NULL,
	`quote_asset` text NOT NULL,
	`onboard_date` integer NOT NULL,
	`status` text NOT NULL,
	`is_active` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbols_symbol_unique` ON `symbols` (`symbol`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`symbol_id` integer NOT NULL,
	`timeframe` text NOT NULL,
	`first_open_time` integer,
	`last_open_time` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`symbol_id`, `timeframe`)
);
