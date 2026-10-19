-- Subskrypcje: co sprawdzamy (produkt + wersje) i gdzie wysyłamy (webhook Teams).
CREATE TABLE subscriptions (
  name              TEXT    PRIMARY KEY,
  product           TEXT    NOT NULL DEFAULT 'open-source' CHECK (product IN ('open-source', 'commerce', 'b2b')),
  versions          TEXT    NOT NULL, -- lista po przecinku: "2.4.8-p5, 2.4.7-*" albo "*"
  webhook_url       TEXT    NOT NULL, -- https://... albo secret:NAZWA
  unsupported_lines INTEGER NOT NULL DEFAULT 1 CHECK (unsupported_lines IN (0, 1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
