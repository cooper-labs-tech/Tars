-- A request's side mark (the owner's decision of 26/11): true for a harness's side request (a title
-- request with no tools, a memory request with another system prompt), false for the agent's own
-- loop, NULL when the uploading Tars did not say (one before the mark). NULL is read as unknown,
-- never as false, so a side request is never passed off as a main one.
ALTER TABLE requests ADD COLUMN side boolean;
