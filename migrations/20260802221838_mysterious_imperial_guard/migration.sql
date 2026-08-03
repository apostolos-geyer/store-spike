CREATE TABLE `customer_order` (
	`id` text PRIMARY KEY,
	`order_number` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ship_name` text,
	`ship_line1` text,
	`ship_line2` text,
	`ship_city` text,
	`ship_region` text,
	`ship_postal` text,
	`ship_country` text DEFAULT 'CA' NOT NULL,
	`ship_phone` text,
	`subtotal_cents` integer NOT NULL,
	`shipping_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`session_id` text UNIQUE,
	`session_expires_at` integer,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`fulfillment_note` text,
	`shipped_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ship_address_atomic" CHECK((ship_name IS NULL) = (ship_line1 IS NULL) AND (ship_name IS NULL) = (ship_city IS NULL) AND (ship_name IS NULL) = (ship_region IS NULL) AND (ship_name IS NULL) = (ship_postal IS NULL))
);
--> statement-breakpoint
CREATE TABLE `store_operator_deletion_intent` (
	`token_hash` text PRIMARY KEY,
	`operator_sub` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`impact_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE TABLE `fake_session` (
	`id` text PRIMARY KEY,
	`status` text NOT NULL,
	`payment_status` text NOT NULL,
	`order_id` text,
	`amount_total_cents` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`email` text,
	`ship_name` text,
	`ship_line1` text,
	`ship_city` text,
	`ship_region` text,
	`ship_postal` text
);
--> statement-breakpoint
CREATE TABLE `store_operator_event` (
	`id` text PRIMARY KEY,
	`operator_sub` text NOT NULL,
	`operator_email` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`request_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`outcome` text NOT NULL,
	`detail_json` text,
	`response_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_item` (
	`id` text PRIMARY KEY,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`title_snapshot` text NOT NULL,
	`size_snapshot` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`quantity` integer NOT NULL,
	CONSTRAINT `fk_order_item_order_id_customer_order_id_fk` FOREIGN KEY (`order_id`) REFERENCES `customer_order`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `payment_event` (
	`event_id` text PRIMARY KEY,
	`event_type` text NOT NULL,
	`session_id` text,
	`order_id` text,
	`outcome` text NOT NULL,
	`attempts` integer,
	`payload` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`status` text DEFAULT 'draft' NOT NULL,
	`active_release_id` text,
	`created_by_sub` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_product_active_release_id_product_release_id_fk` FOREIGN KEY (`active_release_id`) REFERENCES `product_release`(`id`) ON DELETE SET NULL,
	CONSTRAINT "product_status_valid" CHECK(status IN ('draft', 'active', 'unavailable', 'archived'))
);
--> statement-breakpoint
CREATE TABLE `product_draft` (
	`product_id` text PRIMARY KEY,
	`revision` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`description_markdown` text,
	`price_cents` integer NOT NULL,
	`updated_by_sub` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_product_draft_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE CASCADE,
	CONSTRAINT "product_draft_revision_min" CHECK(revision >= 1),
	CONSTRAINT "product_draft_price_non_negative" CHECK(price_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE `product_image` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`storage_key` text NOT NULL UNIQUE,
	`content_sha256` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`alt` text NOT NULL,
	`role` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_product_image_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE CASCADE,
	CONSTRAINT "product_image_role_valid" CHECK(role IN ('cover', 'gallery', 'evidence')),
	CONSTRAINT "product_image_size_non_negative" CHECK(size_bytes >= 0)
);
--> statement-breakpoint
CREATE TABLE `product_release` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`version` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description_markdown` text,
	`price_cents` integer NOT NULL,
	`published_by_sub` text NOT NULL,
	`published_at` integer NOT NULL,
	CONSTRAINT `fk_product_release_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE CASCADE,
	CONSTRAINT "product_release_price_non_negative" CHECK(price_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE `product_release_image` (
	`release_id` text NOT NULL,
	`image_id` text NOT NULL,
	`alt` text NOT NULL,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `product_release_image_pk` PRIMARY KEY(`release_id`, `image_id`),
	CONSTRAINT `fk_product_release_image_release_id_product_release_id_fk` FOREIGN KEY (`release_id`) REFERENCES `product_release`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_product_release_image_image_id_product_image_id_fk` FOREIGN KEY (`image_id`) REFERENCES `product_image`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `product_variant` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`size` text NOT NULL,
	`sku` text NOT NULL UNIQUE,
	`stock` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_product_variant_product_id_product_id_fk` FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON DELETE CASCADE,
	CONSTRAINT "stock_non_negative" CHECK(stock >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_order_user` ON `customer_order` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_order_status` ON `customer_order` (`status`);--> statement-breakpoint
CREATE INDEX `idx_order_created` ON `customer_order` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_operator_event_idempotency_action_unique` ON `store_operator_event` (`idempotency_key`,`action`);--> statement-breakpoint
CREATE INDEX `idx_item_order` ON `order_item` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_product_status_updated` ON `product` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_product_image_product` ON `product_image` (`product_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_release_product_version_unique` ON `product_release` (`product_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_variant_product` ON `product_variant` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_variant_product_size` ON `product_variant` (`product_id`,`size`);