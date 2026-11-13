CREATE TABLE "reference_library" (
	"user_id" text PRIMARY KEY NOT NULL,
	"canvas_ids" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
