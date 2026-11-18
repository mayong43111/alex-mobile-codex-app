SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID('users') IS NULL CREATE TABLE users (id VARCHAR(36) PRIMARY KEY, username NVARCHAR(64) UNIQUE NOT NULL, password NVARCHAR(1024) NOT NULL);
IF OBJECT_ID('logins') IS NULL CREATE TABLE logins (token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id), csrf VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL);
IF OBJECT_ID('settings') IS NULL CREATE TABLE settings (user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id), data NVARCHAR(MAX) NOT NULL);
IF OBJECT_ID('conversations') IS NULL BEGIN
  CREATE TABLE conversations (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id), data NVARCHAR(MAX) NOT NULL);
  CREATE INDEX conversations_owner ON conversations(user_id);
END;
IF OBJECT_ID('commands') IS NULL CREATE TABLE commands (user_id VARCHAR(36) NOT NULL REFERENCES users(id), client_id VARCHAR(100) COLLATE Latin1_General_100_BIN2 NOT NULL, client_seq BIGINT NOT NULL, input_hash VARCHAR(64) NOT NULL, envelope NVARCHAR(MAX) NOT NULL, PRIMARY KEY(user_id, client_id, client_seq));
IF OBJECT_ID('sequence') IS NULL BEGIN
  CREATE TABLE [sequence] (id INT PRIMARY KEY CHECK(id=1), value BIGINT NOT NULL);
  INSERT INTO [sequence] VALUES (1, 0);
END;
IF OBJECT_ID('attachments') IS NULL BEGIN
  CREATE TABLE attachments (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id), data NVARCHAR(MAX) NOT NULL);
  CREATE INDEX attachments_owner ON attachments(user_id);
END;
IF OBJECT_ID('image_jobs') IS NULL CREATE TABLE image_jobs (user_id VARCHAR(36) NOT NULL REFERENCES users(id), call_id NVARCHAR(400) COLLATE Latin1_General_100_BIN2 NOT NULL, data NVARCHAR(MAX) NOT NULL, PRIMARY KEY(user_id, call_id));
IF OBJECT_ID('image_preferences') IS NULL CREATE TABLE image_preferences (user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id), model NVARCHAR(200) NOT NULL);
IF OBJECT_ID('runtime_files') IS NULL CREATE TABLE runtime_files (user_id VARCHAR(36) NOT NULL REFERENCES users(id), session_id VARCHAR(36) NOT NULL, path NVARCHAR(400) COLLATE Latin1_General_100_BIN2 NOT NULL, kind VARCHAR(10) NOT NULL, content VARBINARY(MAX) NOT NULL, mode INT NOT NULL, created_at BIGINT NOT NULL, modified_at BIGINT NOT NULL, PRIMARY KEY(user_id, session_id, path));
IF OBJECT_ID('instance_lease') IS NULL BEGIN
  CREATE TABLE instance_lease (id INT PRIMARY KEY CHECK(id=1), holder VARCHAR(36) NOT NULL, expires_at BIGINT NOT NULL);
  INSERT INTO instance_lease VALUES (1, '', 0);
END;
COMMIT;
