DROP INDEX IF EXISTS `idx_order_status`;--> statement-breakpoint
CREATE INDEX `idx_order_sweep` ON `customer_order` (`status`,`payment_status`,`session_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_order_payment_intent` ON `customer_order` (`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `idx_operator_event_target` ON `store_operator_event` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_payment_event_order` ON `payment_event` (`order_id`,`created_at`);