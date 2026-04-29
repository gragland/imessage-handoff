-- Remote replies now live only in the relay Durable Object's memory.
-- Drop the old fallback table so D1 contains only routing metadata.
DROP TABLE IF EXISTS remote_replies;
