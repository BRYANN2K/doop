CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"thread_id" text,
	"from_name" text NOT NULL,
	"from_user_id" text,
	"agent" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"plan" jsonb,
	"at" bigint NOT NULL,
	"for_agent" boolean DEFAULT false NOT NULL,
	"target_agent" text,
	"claimed_by" text,
	"claimed_at" bigint,
	"answered_at" bigint,
	"failed_at" bigint,
	"failure_reason" text
);
--> statement-breakpoint
CREATE INDEX "chat_messages_canvas_idx" ON "chat_messages" USING btree ("canvas_id");