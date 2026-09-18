ALTER TABLE `messages` ADD `actor` text DEFAULT 'USER' NOT NULL;
UPDATE messages SET actor = 'AI' WHERE direction = 'OUTBOUND';
