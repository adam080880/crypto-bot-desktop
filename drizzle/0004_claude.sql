CREATE TABLE `claude_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`symbol` text NOT NULL,
	`bias` text NOT NULL,
	`confidence` real NOT NULL,
	`price` real,
	`forced_skip` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_analyses_symbol_idx` ON `claude_analyses` (`symbol`,`created_at`);--> statement-breakpoint
CREATE TABLE `claude_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`trigger` text NOT NULL,
	`event_titles` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`market_note` text
);
--> statement-breakpoint
CREATE INDEX `claude_runs_created_idx` ON `claude_runs` (`created_at`);