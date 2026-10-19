-- Typ kanału: webhook Teams Workflows albo Incoming Webhook Google Chat.
ALTER TABLE subscriptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'teams' CHECK (channel IN ('teams', 'google-chat'));
