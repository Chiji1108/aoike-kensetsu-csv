CREATE TABLE `csv_rule_items` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`customer_id` text,
	`text` text NOT NULL,
	`position` integer NOT NULL,
	`source` text NOT NULL,
	`case_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `csv_customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `csv_rule_items_list_idx` ON `csv_rule_items` (`scope`,`customer_id`,`position`);--> statement-breakpoint
CREATE INDEX `csv_rule_items_case_id_idx` ON `csv_rule_items` (`case_id`);--> statement-breakpoint
CREATE TABLE `csv_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`rule7_tax` text DEFAULT 'excluded' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `csv_rule_appends` ADD `item_id` text;--> statement-breakpoint
-- 前の形（全体ルールの文章・顧客ルールの文章）を行ごとに項目にする。空行は飛ばし、前後の空白と先頭の箇条書きの記号（「- 」「・」など）を取る。並びは元の行の順
WITH RECURSIVE `lines`(`scope`, `customer_id`, `rest`, `line`, `n`) AS (
	SELECT 'global', NULL, replace(`rules`, char(13), '') || char(10), NULL, 0 FROM `csv_rules` WHERE `id` = 'global'
	UNION ALL
	SELECT 'customer', `id`, replace(`rules`, char(13), '') || char(10), NULL, 0 FROM `csv_customers`
	UNION ALL
	SELECT `scope`, `customer_id`, substr(`rest`, instr(`rest`, char(10)) + 1), substr(`rest`, 1, instr(`rest`, char(10)) - 1), `n` + 1 FROM `lines` WHERE `rest` <> ''
),
`trimmed` AS (
	SELECT `scope`, `customer_id`, `n`, trim(`line`, ' ' || char(9) || '　') AS `t` FROM `lines` WHERE `line` IS NOT NULL
),
`unmarked` AS (
	SELECT `scope`, `customer_id`, `n`, CASE WHEN substr(`t`, 1, 1) IN ('-', '・', '*', '•', '●', '○', '■', '□', '◆', '◇') THEN trim(substr(`t`, 2), ' ' || char(9) || '　') ELSE `t` END AS `t` FROM `trimmed`
)
INSERT INTO `csv_rule_items` (`id`, `scope`, `customer_id`, `text`, `position`, `source`)
SELECT lower(hex(randomblob(16))), `scope`, `customer_id`, `t`, row_number() OVER (PARTITION BY `scope`, `customer_id` ORDER BY `n`), 'staff' FROM `unmarked` WHERE `t` <> '';
--> statement-breakpoint
-- 全体ルールを保存したことがあれば、設定の行を作る（行があると初期値の項目を入れない。保存したことが無ければ、はじめて読むときに初期値の項目を入れる）
INSERT INTO `csv_settings` (`id`) SELECT 'global' FROM `csv_rules` WHERE `id` = 'global';
