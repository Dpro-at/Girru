-- STORE-MAP-01 P6 (GIRRU_STORE_P6): session capabilities for every project.
--
-- company_facts: the owner allows the company's pinned facts to reach coding
-- tools in this project (SEC2-1). Off by default: a session Girru starts in
-- the project gets the project's own facts only. Read only while P6 is on.
ALTER TABLE memory_bridge_folders ADD COLUMN company_facts INTEGER NOT NULL DEFAULT 0;
