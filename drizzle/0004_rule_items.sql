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
-- 全体ルールを保存したことが無ければ（新しい D1 も）、全体ルールの初期値の項目を入れる（src/lib/chat/rules.ts の DEFAULT_GLOBAL_RULE_ITEMS と同じ。テストで確かめる）
INSERT INTO `csv_rule_items` (`id`, `scope`, `customer_id`, `text`, `position`, `source`)
SELECT * FROM (VALUES
	(lower(hex(randomblob(16))), 'global', NULL, '字数を超えたときの縮め方の順: 空白を取る → 株式会社を㈱・有限会社を㈲ → 法人格を省く → それでも長ければ職員に聞く。', 1, 'staff'),
	(lower(hex(randomblob(16))), 'global', NULL, '完成年月は顧客の指定に従う（引渡日が多い）。', 2, 'staff'),
	(lower(hex(randomblob(16))), 'global', NULL, '工事名は場所と内容が分かるようにする。工事名で業種が分からず、その行の業種コードが決まっているときは、その業種の言葉を補う（例「〜に伴う内装工事」）。会社の主な業種から推し量らない。業種コードが決まっていなければ補わない。', 3, 'staff'),
	(lower(hex(randomblob(16))), 'global', NULL, '工事名の「(仮称)」と、丁寧の「ご」（「ご自宅改修」の「ご」。「ごみ処理施設」のように語の一部なら取らない）を取る。途中や末尾にある【支店名】のような補足は先頭に移す（括弧を外すかは顧客の指定に従う）。', 4, 'staff'),
	(lower(hex(randomblob(16))), 'global', NULL, '配置技術者は氏名だけにする（社員番号などの接頭辞「83：」は取る）。', 5, 'staff')
) WHERE NOT EXISTS (SELECT 1 FROM `csv_rules` WHERE `id` = 'global');
--> statement-breakpoint
-- 事務所の設定の行（7割の計算は税抜。前はいつも税抜で計算していた）
INSERT INTO `csv_settings` (`id`) VALUES ('global');
