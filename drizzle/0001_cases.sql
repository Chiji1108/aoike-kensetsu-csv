CREATE TABLE `csv_case_ai_caches` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `csv_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `csv_case_ai_caches_case_id_idx` ON `csv_case_ai_caches` (`case_id`);--> statement-breakpoint
CREATE TABLE `csv_case_files` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `csv_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `csv_case_files_r2_key_unique` ON `csv_case_files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `csv_case_files_case_id_idx` ON `csv_case_files` (`case_id`);--> statement-breakpoint
CREATE TABLE `csv_case_states` (
	`case_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`json` text NOT NULL,
	`ai_cache_id` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `csv_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_cache_id`) REFERENCES `csv_case_ai_caches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `csv_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`status` text DEFAULT 'converting' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`deleting` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `csv_customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `csv_cases_customer_id_idx` ON `csv_cases` (`customer_id`);--> statement-breakpoint
CREATE TABLE `csv_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`format_note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `csv_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
